import type { SQLiteDatabase } from 'expo-sqlite';
import { likeBelow, topOf, type ImportMode, type ItemState, type QueueStatus } from './logic';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'withTransactionAsync'>;

export type VaultItem = { id: string; rel: string; top: string; size: number; md5: string | null; state: ItemState; addedAt: number; stateAt: number; exportUri: string | null };
export type QueueRow = { id: number; job: string; src: string; rel: string; size: number; mode: ImportMode; status: QueueStatus; error: string | null };
export type TopRow = { top: string; count: number; bytes: number; exportUri: string | null; stateAt: number };

type ItemRaw = { id: string; rel_path: string; top: string; size: number; md5: string | null; state: string; added_at: number; state_at: number; export_uri: string | null };
const toItem = (r: ItemRaw): VaultItem => ({ id: r.id, rel: r.rel_path, top: r.top, size: r.size, md5: r.md5, state: r.state as ItemState, addedAt: r.added_at, stateAt: r.state_at, exportUri: r.export_uri });

/** Paths that are taken inside the vault right now (hidden files + files a running job is about to write). */
export async function takenPaths(db: Db): Promise<Set<string>> {
  const items = await db.getAllAsync<{ rel_path: string }>(`SELECT rel_path FROM vault_items WHERE state = 'hidden'`);
  const queued = await db.getAllAsync<{ rel_path: string }>(`SELECT rel_path FROM vault_queue WHERE status IN ('pending', 'copied')`);
  return new Set([...items.map((r) => r.rel_path), ...queued.map((r) => r.rel_path)]);
}

/**
 * Records a verified file in the vault. If the same path was unhidden before, that row comes back (same id), so the file keeps its identity
 * for later sync; any stale hidden row at this path is replaced.
 */
export async function putItem(db: Db, input: { id: string; rel: string; size: number; md5?: string | null }): Promise<string> {
  const now = Date.now();
  let id = input.id;
  await db.withTransactionAsync(async () => {
    const back = await db.getFirstAsync<{ id: string }>(`SELECT id FROM vault_items WHERE rel_path = ? AND state = 'exported' LIMIT 1`, input.rel);
    await db.runAsync(`DELETE FROM vault_items WHERE rel_path = ? AND state = 'hidden'`, input.rel);
    if (back) {
      id = back.id;
      await db.runAsync(`UPDATE vault_items SET state = 'hidden', size = ?, md5 = ?, state_at = ?, export_uri = NULL WHERE id = ?`, input.size, input.md5 ?? null, now, id);
    } else {
      await db.runAsync(
        `INSERT INTO vault_items (id, rel_path, top, size, md5, state, added_at, state_at, export_uri) VALUES (?, ?, ?, ?, ?, 'hidden', ?, ?, NULL)`,
        id, input.rel, topOf(input.rel), input.size, input.md5 ?? null, now, now,
      );
    }
  });
  return id;
}

export async function setItemState(db: Db, id: string, state: ItemState, extra: { exportUri?: string | null; rel?: string } = {}): Promise<void> {
  const rel = extra.rel;
  await db.runAsync(
    `UPDATE vault_items SET state = ?, state_at = ?, export_uri = ?${rel ? ', rel_path = ?, top = ?' : ''} WHERE id = ?`,
    ...([state, Date.now(), extra.exportUri ?? null, ...(rel ? [rel, topOf(rel)] : []), id] as (string | number | null)[]),
  );
}

export async function deleteItem(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM vault_items WHERE id = ?', id);
}

export async function itemsOfTop(db: Db, top: string, state: ItemState): Promise<VaultItem[]> {
  return (await db.getAllAsync<ItemRaw>(`SELECT * FROM vault_items WHERE top = ? AND state = ? ORDER BY rel_path`, top, state)).map(toItem);
}

/** A file, or a folder and everything below it, by vault-relative path. */
export async function itemsAt(db: Db, rel: string, state: ItemState): Promise<VaultItem[]> {
  return (await db.getAllAsync<ItemRaw>(`SELECT * FROM vault_items WHERE state = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\') ORDER BY rel_path`, state, rel, likeBelow(rel))).map(toItem);
}

export async function itemById(db: Db, id: string): Promise<VaultItem | null> {
  const row = await db.getFirstAsync<ItemRaw>('SELECT * FROM vault_items WHERE id = ?', id);
  return row ? toItem(row) : null;
}

/** The top-level folders/files in a state, newest first. */
export async function listTops(db: Db, state: ItemState): Promise<TopRow[]> {
  const rows = await db.getAllAsync<{ top: string; n: number; bytes: number; export_uri: string | null; at: number }>(
    `SELECT top, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, MAX(export_uri) AS export_uri, MAX(state_at) AS at FROM vault_items WHERE state = ? GROUP BY top ORDER BY at DESC`, state,
  );
  return rows.map((r) => ({ top: r.top, count: r.n, bytes: r.bytes, exportUri: r.export_uri, stateAt: r.at }));
}

export async function listTrashed(db: Db): Promise<VaultItem[]> {
  return (await db.getAllAsync<ItemRaw>(`SELECT * FROM vault_items WHERE state = 'trashed' ORDER BY state_at DESC`)).map(toItem);
}

export async function vaultTotals(db: Db): Promise<{ count: number; bytes: number }> {
  const row = await db.getFirstAsync<{ n: number; bytes: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM vault_items WHERE state = 'hidden'`);
  return { count: row?.n ?? 0, bytes: row?.bytes ?? 0 };
}

// ---- transfer journal (resumable): jobs + their queue rows

export async function createJob(db: Db, job: string, mode: ImportMode, roots: string[]): Promise<void> {
  await db.runAsync('INSERT INTO vault_jobs (job, mode, roots, created_at) VALUES (?, ?, ?, ?)', job, mode, JSON.stringify(roots), Date.now());
}

export async function enqueue(db: Db, job: string, mode: ImportMode, rows: { src: string; rel: string; size: number }[]): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const r of rows) {
      await db.runAsync(`INSERT INTO vault_queue (job, src_uri, rel_path, size, mode, status, error) VALUES (?, ?, ?, ?, ?, 'pending', NULL)`, job, r.src, r.rel, r.size, mode);
    }
  });
}

type QueueRaw = { id: number; job: string; src_uri: string; rel_path: string; size: number; mode: string; status: string; error: string | null };
export async function nextRows(db: Db, job: string, limit = 10): Promise<QueueRow[]> {
  const rows = await db.getAllAsync<QueueRaw>(`SELECT * FROM vault_queue WHERE job = ? AND status IN ('pending', 'copied') ORDER BY id LIMIT ?`, job, limit);
  return rows.map((r) => ({ id: r.id, job: r.job, src: r.src_uri, rel: r.rel_path, size: r.size, mode: r.mode as ImportMode, status: r.status as QueueStatus, error: r.error }));
}

export async function markRow(db: Db, id: number, status: QueueStatus, error?: string | null): Promise<void> {
  await db.runAsync('UPDATE vault_queue SET status = ?, error = ? WHERE id = ?', status, error ?? null, id);
}

export type JobInfo = { job: string; mode: ImportMode; roots: string[]; left: number; leftBytes: number; done: number; kept: number; failed: number };
export async function jobInfo(db: Db, job: string): Promise<JobInfo | null> {
  const head = await db.getFirstAsync<{ mode: string; roots: string }>('SELECT mode, roots FROM vault_jobs WHERE job = ?', job);
  if (!head) return null;
  const counts = await db.getAllAsync<{ status: string; n: number; bytes: number }>(`SELECT status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM vault_queue WHERE job = ? GROUP BY status`, job);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  let roots: string[] = [];
  try {
    roots = JSON.parse(head.roots) as string[];
  } catch {
    roots = [];
  }
  const left = n('pending') + n('copied');
  const leftBytes = counts.filter((c) => c.status === 'pending' || c.status === 'copied').reduce((a, c) => a + c.bytes, 0);
  return { job, mode: head.mode as ImportMode, roots, left, leftBytes, done: n('done'), kept: n('kept'), failed: n('failed') };
}

/** Jobs that still have files to do (after the app was closed or the person paused). */
export async function openJobs(db: Db): Promise<JobInfo[]> {
  const jobs = await db.getAllAsync<{ job: string }>(`SELECT DISTINCT job FROM vault_queue WHERE status IN ('pending', 'copied')`);
  const out: JobInfo[] = [];
  for (const { job } of jobs) {
    const info = await jobInfo(db, job);
    if (info) out.push(info);
  }
  return out;
}

/** Drops the rest of a job (nothing is deleted: copies already made stay in the vault, originals stay where they are). */
export async function discardJob(db: Db, job: string): Promise<void> {
  await db.runAsync('DELETE FROM vault_queue WHERE job = ?', job);
  await db.runAsync('DELETE FROM vault_jobs WHERE job = ?', job);
}

export async function finishedJob(db: Db, job: string): Promise<void> {
  await discardJob(db, job);
}
