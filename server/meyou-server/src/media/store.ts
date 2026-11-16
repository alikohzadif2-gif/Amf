// Queries on the media index (items + changes). All reads go through SQLite.
import crypto from 'node:crypto';
import type { Db } from '../db.js';

export interface ItemRow {
  id: string;
  root: string;
  path: string;
  parent: string;
  name: string;
  name_sort: string;
  is_dir: number;
  type: 'dir' | 'image' | 'video' | 'file' | 'text';
  size: number;
  mtime_ms: number;
  mime: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  seen: number;
}

/** Contract A `Item` (optional fields are omitted when unknown). */
export interface ItemJson {
  id: string;
  name: string;
  type: ItemRow['type'];
  size: number;
  mtime: string;
  mime?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/** Stable id: the same root + path gives the same id after every restart and rescan. */
export function itemId(root: string, relPath: string): string {
  return crypto.createHash('sha256').update(`${root}\0${relPath}`).digest('base64url').slice(0, 22);
}

export function toJson(r: ItemRow): ItemJson {
  const j: ItemJson = { id: r.id, name: r.name, type: r.type, size: r.size, mtime: new Date(r.mtime_ms).toISOString() };
  if (r.mime) j.mime = r.mime;
  if (r.width != null) j.width = r.width;
  if (r.height != null) j.height = r.height;
  if (r.duration != null) j.duration = r.duration;
  return j;
}

export function getItem(db: Db, id: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
}

export function getItemByPath(db: Db, root: string, relPath: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE root = ? AND path = ?').get(root, relPath) as ItemRow | undefined;
}

interface Cursor {
  d: number;
  n: string;
  i: string;
}

export function encodeCursor(r: ItemRow): string {
  return Buffer.from(JSON.stringify({ d: r.is_dir, n: r.name_sort, i: r.id } satisfies Cursor)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if ((c.d === 0 || c.d === 1) && typeof c.n === 'string' && typeof c.i === 'string') return c;
  } catch {
    /* fall through */
  }
  return null;
}

/** Children of a folder: directories first, then by name; keyset pagination. */
export function listChildren(db: Db, root: string, parent: string, cursor: Cursor | null, limit: number): { rows: ItemRow[]; next?: string } {
  const args: (string | number)[] = [root, parent];
  let where = 'root = ? AND parent = ?';
  if (cursor) {
    where += ' AND (is_dir < ? OR (is_dir = ? AND (name_sort > ? OR (name_sort = ? AND id > ?))))';
    args.push(cursor.d, cursor.d, cursor.n, cursor.n, cursor.i);
  }
  const rows = db
    .prepare(`SELECT * FROM items WHERE ${where} ORDER BY is_dir DESC, name_sort ASC, id ASC LIMIT ?`)
    .all(...args, limit + 1) as unknown as ItemRow[];
  if (rows.length > limit) {
    rows.length = limit;
    return { rows, next: encodeCursor(rows[limit - 1]!) };
  }
  return { rows };
}

export interface ChangeJson {
  id: string;
  op: 'add' | 'update' | 'delete';
  root: string;
  path: string;
  item?: ItemJson;
}

export function latestSeq(db: Db): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM changes').get() as { m: number };
  return r.m;
}

/** Changes after `since`. An add/update whose item is already gone is skipped (a delete follows). */
export function changesSince(db: Db, since: number, limit: number): { changes: ChangeJson[]; cursor: number } {
  const rows = db
    .prepare(
      `SELECT c.seq, c.id, c.op, c.root, c.path, i.id AS i_id
         FROM changes c LEFT JOIN items i ON i.id = c.id AND i.root = c.root AND i.path = c.path
        WHERE c.seq > ? ORDER BY c.seq LIMIT ?`,
    )
    .all(since, limit) as unknown as { seq: number; id: string; op: ChangeJson['op']; root: string; path: string; i_id: string | null }[];
  const out: ChangeJson[] = [];
  for (const r of rows) {
    if (r.op === 'delete') {
      out.push({ id: r.id, op: 'delete', root: r.root, path: r.path });
      continue;
    }
    if (!r.i_id) continue;
    const item = getItem(db, r.id)!;
    out.push({ id: r.id, op: r.op, root: r.root, path: r.path, item: toJson(item) });
  }
  const cursor = rows.length > 0 ? rows[rows.length - 1]!.seq : Math.min(since, latestSeq(db));
  return { changes: out, cursor };
}

const MAX_CHANGE_ROWS = 200_000;

export function pruneChanges(db: Db): void {
  const max = latestSeq(db);
  if (max > MAX_CHANGE_ROWS) db.prepare('DELETE FROM changes WHERE seq <= ?').run(max - MAX_CHANGE_ROWS);
}
