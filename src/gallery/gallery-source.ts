import type { SQLiteDatabase } from 'expo-sqlite';
import { itemById } from '../vault/db';
import { vaultFile } from '../vault/files';
import { idOfGalleryRef } from './gallery-ref';

type Db = Pick<SQLiteDatabase, 'getFirstAsync'>;

/**
 * Shared gallery, stage 3 (sender): the file of a gallery ref `Shared/<item id>/<name>`, found in the vault by the item id. Only a file that is
 * still in the gallery (state hidden) is served: trashed or unhidden files answer nothing. Null for any ref that is not a live vault file.
 */
export async function vaultSourceForRef(db: Db, ref: string): Promise<{ uri: string; name: string; rel: string } | null> {
  const id = idOfGalleryRef(ref);
  if (!id) return null;
  try {
    const item = await itemById(db as SQLiteDatabase, id);
    if (!item || item.state !== 'hidden') return null;
    return { uri: vaultFile(item.rel).uri, name: item.rel.slice(item.rel.lastIndexOf('/') + 1), rel: item.rel };
  } catch {
    return null;
  }
}
