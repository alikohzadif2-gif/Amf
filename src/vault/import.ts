/**
 * Adds files to the private vault, from the file manager. Two modes the person picks BEFORE it starts:
 *  - `copy`: the originals stay.
 *  - `move`: each original is deleted only after its copy was verified (same size AND same MD5). Whatever cannot be verified or deleted is
 *    KEPT where it is and reported. The copy always comes first, so an interrupted move never loses a file.
 * Progress is a journal in SQLite (`vault_jobs` / `vault_queue`), so a transfer can be paused, or survive the app being closed, and continue.
 * It runs while the app is open and stops when the app is closed.
 */
import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { create } from 'zustand';
import { openFileReader } from '@/src/server/file-reader';
import { compareSources } from '@/src/sync/sha256';
import { createJob, discardJob, enqueue, finishedJob, jobInfo, markRow, nextRows, putItem, takenPaths, type JobInfo } from './db';
import { ensureParents, freeDiskBytes, statOf, vaultFile } from './files';
import { SPACE_MARGIN_BYTES, cleanSegment, deleteVerdict, enoughSpace, spaceNeeded, totalsOf, uniqueRelPath, type ImportMode, type Totals } from './logic';
import { pruneEmptyFolders, type Picked } from './saf';

export type PlanResult =
  | { ok: true; job: string; totals: Totals }
  | { ok: false; reason: 'empty' | 'no-space'; totals: Totals; needed: number; free: number | null };

type Db = SQLiteDatabase;

/** Turns the picked folders/files into queue rows with unique vault paths. Writes nothing when there is not enough space. */
export async function planJob(db: Db, picked: Picked[], mode: ImportMode): Promise<PlanResult> {
  const taken = await takenPaths(db);
  const rows: { src: string; rel: string; size: number }[] = [];
  const roots: string[] = [];
  for (const item of picked) {
    if (item.kind === 'folder') {
      roots.push(item.uri);
      // a folder keeps its structure under its own (unique) top-level name
      const top = uniqueRelPath(item.name, new Set([...taken].map((p) => p.split('/')[0])));
      taken.add(top);
      for (const file of item.files) {
        const rel = uniqueRelPath(`${top}/${file.rel}`, taken);
        taken.add(rel);
        rows.push({ src: file.uri, rel, size: file.size });
      }
    } else {
      for (const file of item.files) {
        const rel = uniqueRelPath(cleanSegment(file.name), taken);
        taken.add(rel);
        rows.push({ src: file.uri, rel, size: file.size });
      }
    }
  }
  const totals = totalsOf(rows.map((r) => r.size));
  const free = freeDiskBytes();
  if (rows.length === 0) return { ok: false, reason: 'empty', totals, needed: 0, free };
  if (free !== null && !enoughSpace(mode, totals, free)) return { ok: false, reason: 'no-space', totals, needed: spaceNeeded(mode, totals), free };
  const job = Crypto.randomUUID();
  await createJob(db, job, mode, roots);
  await enqueue(db, job, mode, rows);
  return { ok: true, job, totals };
}

export type JobProgress = {
  job: string | null;
  running: boolean;
  total: number;
  done: number;
  kept: number;
  failed: number;
  bytesTotal: number;
  bytesDone: number;
  paused: boolean;
  finished: boolean;
  /** The phone ran short of space for the rest of a copy: free some space, then continue. */
  noSpace: boolean;
};
const IDLE: JobProgress = { job: null, running: false, total: 0, done: 0, kept: 0, failed: 0, bytesTotal: 0, bytesDone: 0, paused: false, finished: false, noSpace: false };
export const useVaultJob = create<JobProgress & { reset: () => void }>((set) => ({ ...IDLE, reset: () => set(IDLE) }));

let cancel = false;
/** Asks the running transfer to stop after the file it is on. Nothing is lost: the rest stays in the journal. */
export const pauseJob = (): void => {
  cancel = true;
};

/** Verified copy of one queue row. Returns the status to store. */
async function transferOne(db: Db, row: { src: string; rel: string; size: number; mode: ImportMode; status: string }): Promise<{ status: 'done' | 'kept' | 'failed'; error?: string }> {
  const source = new File(row.src);
  const target = vaultFile(row.rel);
  const srcStat = statOf(source);
  let srcSize = srcStat.size ?? row.size;
  if (row.status === 'pending') {
    if (!source.exists) return { status: 'failed', error: 'source-missing' };
    try {
      ensureParents(row.rel);
      if (target.exists) target.delete(); // a half-written copy from an interrupted run
      await source.copy(target);
    } catch {
      try {
        if (target.exists) target.delete();
      } catch {
        // ignore
      }
      return { status: 'failed', error: 'copy-failed' };
    }
  } else if (!target.exists) {
    return { status: 'failed', error: 'copy-missing' };
  }
  const tgt = statOf(target);
  srcSize = srcStat.size ?? srcSize;
  const targetSize = tgt.size ?? -1;
  // a copy whose size or checksum differs from the source is never kept
  if (srcStat.size !== undefined && targetSize !== srcStat.size) {
    try {
      target.delete();
    } catch {
      // ignore
    }
    return { status: 'failed', error: 'size-mismatch' };
  }
  if (srcStat.md5 && tgt.md5 && srcStat.md5.toLowerCase() !== tgt.md5.toLowerCase()) {
    try {
      target.delete();
    } catch {
      // ignore
    }
    return { status: 'failed', error: 'hash-mismatch' };
  }
  // Before an ORIGINAL may be deleted (move mode only) both files are also compared byte for byte with SHA-256, on top of size and MD5.
  // 'different' discards the copy; 'unknown' (a file could not be read completely) keeps the original.
  let sha: 'same' | 'different' | 'unknown' = 'unknown';
  if (row.mode === 'move') {
    try {
      sha = await compareSources(await openFileReader(row.src), await openFileReader(target.uri));
    } catch {
      sha = 'unknown';
    }
    if (sha === 'different') {
      try {
        target.delete();
      } catch {
        // ignore
      }
      return { status: 'failed', error: 'hash-mismatch' };
    }
  }
  await putItem(db, { id: Crypto.randomUUID(), rel: row.rel, size: targetSize >= 0 ? targetSize : srcSize, md5: tgt.md5 ?? null });
  let verdict = deleteVerdict({ mode: row.mode, sourceSize: srcSize, targetSize, sourceMd5: srcStat.md5, targetMd5: tgt.md5 });
  if (verdict === 'delete' && sha !== 'same') verdict = 'unverified';
  if (verdict === 'copy-mode') return { status: 'done' };
  if (verdict !== 'delete') return { status: 'kept', error: verdict };
  try {
    source.delete();
    return { status: 'done' };
  } catch {
    return { status: 'kept', error: 'delete-failed' }; // e.g. a file picked with the file chooser cannot be deleted by the app
  }
}

/** Runs (or continues) a job until it is finished or paused (`pauseJob`). Safe to call again after the app restarts. */
export async function runJob(db: Db, job: string): Promise<JobInfo | null> {
  const store = useVaultJob;
  cancel = false;
  const start = await jobInfo(db, job);
  if (!start) return null;
  const free = freeDiskBytes();
  // a copy needs room for everything that is left; a move frees space file by file, so it is only checked by the plan
  if (start.mode === 'copy' && free !== null && free < start.leftBytes + SPACE_MARGIN_BYTES) {
    store.setState({ ...IDLE, job, paused: true, noSpace: true, total: start.left, bytesTotal: start.leftBytes });
    return start;
  }
  store.setState({ job, running: true, paused: false, finished: false, noSpace: false, total: start.left + start.done + start.kept + start.failed, done: start.done, kept: start.kept, failed: start.failed, bytesTotal: start.leftBytes, bytesDone: 0 });
  for (;;) {
    if (cancel) break;
    const rows = await nextRows(db, job, 10);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (cancel) break;
      const result = await transferOne(db, row);
      await markRow(db, row.id, result.status, result.error);
      store.setState((s) => ({
        done: s.done + (result.status === 'done' ? 1 : 0),
        kept: s.kept + (result.status === 'kept' ? 1 : 0),
        failed: s.failed + (result.status === 'failed' ? 1 : 0),
        bytesDone: s.bytesDone + row.size,
      }));
    }
  }
  const end = await jobInfo(db, job);
  if (end && end.left === 0) {
    // move mode: remove the emptied source folders (only folders that are truly empty)
    if (end.mode === 'move') for (const uri of end.roots) pruneEmptyFolders(new Directory(uri));
    await finishedJob(db, job); // the journal is no longer needed; the numbers stay in the store for the summary
    store.setState({ running: false, paused: false, finished: true });
  } else {
    store.setState({ running: false, paused: true, finished: false });
  }
  return end;
}

/** Forgets what is left of a job. Files already in the vault stay; originals are untouched. */
export async function dropJob(db: Db, job: string): Promise<void> {
  await discardJob(db, job);
  useVaultJob.getState().reset();
}

/** Call when the summary of a finished job has been shown. */
export function closeJob(): void {
  useVaultJob.getState().reset();
}
