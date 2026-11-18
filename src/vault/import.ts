/**
 * Adds files to the shared gallery (the private vault), from the file manager. Two modes the person picks BEFORE it starts:
 *  - `copy`: the originals stay.
 *  - `move`: each original is deleted only after its copy has exactly the same size. Whatever cannot be verified or deleted is
 *    KEPT where it is and reported. The copy always comes first, so an interrupted move never loses a file.
 * FAST PATH (shared gallery, stage 1): no MD5 and no SHA-256 anywhere (not while scanning, not while copying): the cost of a transfer is one
 * read and one write of each file, done by the system. A real "rename" move is not possible here: the source is shared storage / a document
 * provider and the vault is app-private storage (another volume), so a move is always copy + delete.
 * Progress is a journal in SQLite (`vault_jobs` / `vault_queue`), so a transfer can be paused, or survive the app being closed, and continue.
 * It runs app-wide while the app is open (leaving the screen does not stop it), one job at a time, and open jobs are resumed at start-up
 * (`resumeOpenJobs`). There is no always-on background service (removed in S10, decision kept), so it stops when Android ends the app.
 */
import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { create } from 'zustand';
import { galleryFileAdded, galleryFlushNow } from '../gallery/outbox';
import { recordGalleryAdd } from '../gallery/gallery-db';
import { createJob, discardJob, enqueue, finishedJob, jobInfo, markRow, nextRows, openJobs, putItem, takenPaths, type JobInfo } from './db';
import { ensureParents, freeDiskBytes, sizeOf, vaultFile } from './files';
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

/** Copy of one queue row, checked by size. Returns the status to store. */
async function transferOne(db: Db, row: { id: number; src: string; rel: string; size: number; mode: ImportMode; status: string }): Promise<{ status: 'done' | 'kept' | 'failed'; error?: string }> {
  const source = new File(row.src);
  const target = vaultFile(row.rel);
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
  // size of the source NOW (null = the phone does not say: the copy is kept, the original too); the scan size is only the fallback for the copy check
  const sourceNow = source.exists ? sizeOf(source) ?? null : null;
  const targetSize = sizeOf(target) ?? -1;
  const expected = sourceNow ?? (row.size > 0 ? row.size : null);
  if (expected !== null && targetSize !== expected) {
    try {
      target.delete();
    } catch {
      // ignore
    }
    return { status: 'failed', error: 'size-mismatch' };
  }
  const itemSize = targetSize >= 0 ? targetSize : row.size;
  const itemId = await putItem(db, { id: Crypto.randomUUID(), rel: row.rel, size: itemSize, md5: null });
  // Gallery list: the partner is told about this file (a list entry only; nothing else is sent now). `row.id` only grows = the copy order.
  await recordGalleryAdd(db, { id: itemId, o: row.id, rel: row.rel, size: itemSize }).catch(() => undefined);
  galleryFileAdded(db);
  const verdict = deleteVerdict({ mode: row.mode, sourceSize: sourceNow, targetSize });
  if (verdict === 'copy-mode') return { status: 'done' };
  if (verdict !== 'delete') return { status: 'kept', error: verdict };
  try {
    source.delete();
    return { status: 'done' };
  } catch {
    return { status: 'kept', error: 'delete-failed' }; // e.g. a file picked with the file chooser cannot be deleted by the app
  }
}

let busy = false;

/**
 * Runs (or continues) a job until it is finished or paused (`pauseJob`). Safe to call again after the app restarts. Only one transfer runs
 * at a time: a call made while another job runs returns at once and that job waits in the journal; it starts when the running one ends.
 */
export async function runJob(db: Db, job: string): Promise<JobInfo | null> {
  if (busy) return jobInfo(db, job);
  busy = true;
  try {
    const tried = new Set<string>([job]);
    let result = await runOne(db, job);
    // other open jobs (planned while this one ran, or left from an earlier run) follow, unless the person paused
    while (!cancel) {
      const next = (await openJobs(db)).find((j) => !tried.has(j.job));
      if (!next) break;
      tried.add(next.job);
      result = await runOne(db, next.job);
    }
    return result;
  } finally {
    busy = false;
  }
}

/** Continues every unfinished transfer (called once when the app starts). Does nothing when a transfer is already running. */
export async function resumeOpenJobs(db: Db): Promise<boolean> {
  if (busy) return false;
  const jobs = await openJobs(db);
  if (jobs.length === 0) return false;
  await runJob(db, jobs[0].job);
  return true;
}

async function runOne(db: Db, job: string): Promise<JobInfo | null> {
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
    await galleryFlushNow(db);
    await finishedJob(db, job); // the journal is no longer needed; the numbers stay in the store for the summary
    store.setState({ running: false, paused: false, finished: true });
  } else {
    await galleryFlushNow(db);
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
