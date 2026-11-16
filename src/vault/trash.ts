/**
 * Deleting inside the app never removes a vault file at once: it moves to `.trash/` for 30 days (the way back), then it is deleted for good.
 * Only files the vault knows about (a `vault_items` row) are ever touched.
 */
import { File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { deleteItem, itemById, itemsAt, listTrashed, setItemState, takenPaths } from './db';
import { ensureParents, pruneEmptyParents, trashDirectory, vaultDirectory, vaultFile } from './files';
import { relFromUri, trashExpired, uniqueRelPath } from './logic';


const trashFile = (id: string): File => new File(trashDirectory(), id);

/** Moves a vault file, or a folder with everything below it, to the trash. Returns how many files moved. */
export async function trashRel(db: SQLiteDatabase, rel: string): Promise<number> {
  const items = await itemsAt(db, rel, 'hidden');
  let moved = 0;
  for (const item of items) {
    try {
      const file = vaultFile(item.rel);
      if (file.exists) file.move(trashFile(item.id));
      else if (trashFile(item.id).exists === false) {
        await deleteItem(db, item.id); // the row had no file any more
        continue;
      }
      await setItemState(db, item.id, 'trashed');
      pruneEmptyParents(item.rel);
      moved += 1;
    } catch {
      // this file stays where it is
    }
  }
  return moved;
}

/** Archive entries (provider ids `fs:<uri>`) -> trash. */
export async function trashProviderIds(db: SQLiteDatabase, ids: string[]): Promise<number> {
  const base = vaultDirectory().uri;
  let moved = 0;
  for (const id of ids) {
    const rel = id.startsWith('fs:') ? relFromUri(id.slice(3), base) : null;
    if (rel) moved += await trashRel(db, rel);
  }
  return moved;
}

export async function restoreItem(db: SQLiteDatabase, id: string): Promise<boolean> {
  const item = await itemById(db, id);
  if (!item || item.state !== 'trashed') return false;
  const file = trashFile(id);
  if (!file.exists) return false;
  try {
    const rel = uniqueRelPath(item.rel, await takenPaths(db));
    ensureParents(rel);
    file.move(vaultFile(rel));
    await setItemState(db, id, 'hidden', { rel });
    return true;
  } catch {
    return false;
  }
}

/** Deletes a trashed file for good. */
export async function purgeItem(db: SQLiteDatabase, id: string): Promise<void> {
  const item = await itemById(db, id);
  if (!item || item.state !== 'trashed') return;
  try {
    const file = trashFile(id);
    if (file.exists) file.delete();
  } catch {
    return; // still there: keep the row
  }
  await deleteItem(db, id);
}

/** Removes what has been in the trash for 30 days. Runs when the vault screen opens. */
export async function purgeExpired(db: SQLiteDatabase, now = Date.now()): Promise<number> {
  let n = 0;
  for (const item of await listTrashed(db)) {
    if (!trashExpired(item.stateAt, now)) continue;
    await purgeItem(db, item.id);
    n += 1;
  }
  return n;
}
