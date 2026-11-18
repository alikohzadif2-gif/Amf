/**
 * Shared gallery, stage 2: the two small stores behind the manifest.
 *  - Sender (`gallery_out`): one row per file added to the gallery from now on, so a crash, a closed app or a missing connection never loses
 *    the "tell the partner" step. Rows stay (they are what the partner was told) until unpairing.
 *  - Receiver (`gallery_items`, `gallery_folders`): the partner's list, read by folder in pages.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { LoadedGalleryItem } from './archive-source-logic';
import { idOfGalleryRef } from './gallery-ref';
import { ancestorsOf, pageWindow, sortFolderNames, splitGalleryPath, subtreeRange } from './gallery-logic';
import { kindOfName, type GalleryEntry } from './manifest';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'withTransactionAsync'>;

// ---- sender

/** A file landed in the gallery (or came back: same id). It is to be told to the partner. `o` = copy order (the queue row id, which only grows). */
export async function recordGalleryAdd(db: Db, input: { id: string; o: number; rel: string; size: number }): Promise<void> {
  await db.runAsync(
    `INSERT INTO gallery_out (item_id, o, rel, kind, size, sent, gone) VALUES (?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(item_id) DO UPDATE SET rel = excluded.rel, kind = excluded.kind, size = excluded.size, sent = 0, gone = 0`,
    input.id, input.o, input.rel, kindOfName(input.rel), input.size,
  );
}

/** A file left the gallery (trash, unhide). A file the partner never heard of needs no message. */
export async function recordGalleryGone(db: Db, id: string): Promise<void> {
  await db.runAsync(`UPDATE gallery_out SET gone = 1, sent = CASE WHEN sent = 0 THEN 1 ELSE 0 END WHERE item_id = ? AND gone = 0`, id);
}

/** A file came back from the trash: the partner hears about it again, in its old place in the order. */
export async function recordGalleryRestored(db: Db, id: string, rel: string): Promise<void> {
  await db.runAsync(`UPDATE gallery_out SET gone = 0, sent = 0, rel = ?, kind = ? WHERE item_id = ?`, rel, kindOfName(rel), id);
}

export type PendingGallery = { entries: GalleryEntry[]; gone: string[]; ids: string[] };

/** The next rows to tell (copy order), at most `limit`. */
export async function pendingGallery(db: Db, limit: number): Promise<PendingGallery> {
  const rows = await db.getAllAsync<{ item_id: string; o: number; rel: string; kind: string; size: number; gone: number }>(
    `SELECT item_id, o, rel, kind, size, gone FROM gallery_out WHERE sent = 0 ORDER BY o LIMIT ?`, limit,
  );
  const entries: GalleryEntry[] = [];
  const gone: string[] = [];
  for (const r of rows) {
    if (r.gone === 1) gone.push(r.item_id);
    else entries.push({ id: r.item_id, p: r.rel, k: r.kind as GalleryEntry['k'], s: r.size, o: r.o });
  }
  return { entries, gone, ids: rows.map((r) => r.item_id) };
}

export async function markGallerySent(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.withTransactionAsync(async () => {
    for (const id of ids) await db.runAsync('UPDATE gallery_out SET sent = 1 WHERE item_id = ?', id);
  });
}

/** How many files this phone has still to tell (for a progress line). */
export async function galleryPendingCount(db: Db): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM gallery_out WHERE sent = 0'))?.n ?? 0;
}

/** Unpairing: a new partner never gets what was told to the old one. */
export async function clearGalleryState(db: Pick<SQLiteDatabase, 'runAsync'> | null): Promise<void> {
  if (!db) return;
  await db.runAsync('DELETE FROM gallery_out');
  await db.runAsync('DELETE FROM gallery_items');
  await db.runAsync('DELETE FROM gallery_folders');
}

// ---- receiver

/** Stores one manifest: upsert by id (a repeat changes nothing), a path taken by an older id goes to the new one, removed ids go, empty folders go. */
export async function applyGalleryManifest(db: Db, entries: readonly GalleryEntry[], gone: readonly string[]): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const e of entries) {
      const { parent, name } = splitGalleryPath(e.p);
      await db.runAsync('DELETE FROM gallery_items WHERE path = ? AND id <> ?', e.p, e.id);
      await db.runAsync(
        `INSERT INTO gallery_items (id, path, parent, name, kind, size, ord) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, parent = excluded.parent, name = excluded.name, kind = excluded.kind, size = excluded.size, ord = excluded.ord`,
        e.id, e.p, parent, name, e.k, e.s, e.o,
      );
      for (const folder of ancestorsOf(e.p)) {
        const f = splitGalleryPath(folder);
        await db.runAsync('INSERT OR IGNORE INTO gallery_folders (path, parent, name) VALUES (?, ?, ?)', folder, f.parent, f.name);
      }
    }
    const touched = new Set<string>();
    for (const id of gone) {
      const row = await db.getFirstAsync<{ path: string }>('SELECT path FROM gallery_items WHERE id = ?', id);
      if (!row) continue;
      await db.runAsync('DELETE FROM gallery_items WHERE id = ?', id);
      for (const folder of ancestorsOf(row.path)) touched.add(folder);
    }
    for (const folder of [...touched].sort((a, b) => b.length - a.length)) {
      const { low, high } = subtreeRange(folder);
      await db.runAsync(
        `DELETE FROM gallery_folders WHERE path = ? AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE path >= ? AND path < ?)`,
        folder, low, high,
      );
    }
  });
}

export type GalleryItemRow = { id: string; path: string; name: string; kind: 'i' | 'v' | 'f'; size: number; ord: number };
export type GalleryFolderRow = { path: string; name: string };
export type GalleryRow = ({ type: 'folder' } & GalleryFolderRow) | ({ type: 'file' } & GalleryItemRow);

/** One page of a folder (`''` = the root): sub-folders first in file-manager order, then files in copy order. Reads only the page's rows. */
export async function listGalleryPage(db: Db, parent: string, offset: number, limit: number): Promise<{ rows: GalleryRow[]; total: number }> {
  const folders = sortFolderNames(await db.getAllAsync<GalleryFolderRow>('SELECT path, name FROM gallery_folders WHERE parent = ?', parent));
  const fileCount = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM gallery_items WHERE parent = ?', parent))?.n ?? 0;
  const w = pageWindow(folders.length, fileCount, offset, limit);
  const rows: GalleryRow[] = folders.slice(w.folderFrom, w.folderTo).map((f) => ({ type: 'folder', ...f }));
  if (w.fileTo > w.fileFrom) {
    const files = await db.getAllAsync<GalleryItemRow>(
      'SELECT id, path, name, kind, size, ord FROM gallery_items WHERE parent = ? ORDER BY ord, id LIMIT ? OFFSET ?', parent, w.fileTo - w.fileFrom, w.fileFrom,
    );
    for (const f of files) rows.push({ type: 'file', ...f });
  }
  return { rows, total: folders.length + fileCount };
}

/** Number of files anywhere below a folder (for the folder tile). */
export async function galleryFolderCount(db: Db, folder: string): Promise<number> {
  const { low, high } = subtreeRange(folder);
  return (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM gallery_items WHERE path >= ? AND path < ?', low, high))?.n ?? 0;
}

/**
 * Stage 5 (Archive/Explore source): the gallery files of the partner of which THIS phone holds a picture (thumbnail, preview or original in
 * `partner_media`). Reads one indexed range of `partner_media` (every shared ref), keeps the ids that are gallery files, then reads their
 * list rows in chunks. `used` = when the thumbnail arrived (0 = none stored: a video with no poster that was downloaded).
 */
export async function loadedGalleryItems(db: Pick<SQLiteDatabase, 'getAllAsync'>): Promise<LoadedGalleryItem[]> {
  const rows = await db.getAllAsync<{ ref: string; kind: string; used: number }>(
    'SELECT ref, kind, used FROM partner_media WHERE ref >= ? AND ref < ?', 'Shared/', 'Shared0',
  );
  const thumbAt = new Map<string, number>();
  for (const r of rows) {
    const id = idOfGalleryRef(r.ref);
    if (!id) continue;
    const old = thumbAt.get(id) ?? 0;
    thumbAt.set(id, r.kind === 'thumb' ? r.used || 1 : old);
  }
  const ids = [...thumbAt.keys()];
  const out: LoadedGalleryItem[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const found = await db.getAllAsync<{ id: string; path: string; name: string; kind: string; size: number; ord: number }>(
      `SELECT id, path, name, kind, size, ord FROM gallery_items WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk,
    );
    for (const f of found) out.push({ id: f.id, path: f.path, name: f.name, kind: f.kind as 'i' | 'v' | 'f', size: f.size, ord: f.ord, used: thumbAt.get(f.id) ?? 0 });
  }
  return out;
}
