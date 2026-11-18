/**
 * Adds picked files (gallery, camera, file chooser, saved stories) to Direct (the vault): a verified copy by size, a row in
 * `vault_items`, and a small thumbnail started in the background. The picker's cache copy is removed afterwards, so one photo
 * is not stored twice. Originals in the gallery are never touched.
 */
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { PickedFile } from '@/src/media/pick-logic';
import { typeFromName } from '@/src/storage/item-type';
import { putItem, takenPaths } from './db';
import { ensureParents, vaultFile } from './files';
import { cleanSegment, joinRel, uniqueRelPath } from './logic';
import { THUMB_EDGES } from './thumb-logic';
import { ensureThumb } from './thumbs';

export type DirectAddResult = { rels: string[]; failed: number };

const isCacheCopy = (uri: string): boolean => uri.startsWith(Paths.cache.uri.replace(/\/+$/, '') + '/');

/** `folder` = a sub-folder of Direct (`Snaps`, `Stories`), created when missing. */
export async function addPickedToDirect(db: SQLiteDatabase, picked: PickedFile[], folder?: string): Promise<DirectAddResult> {
  const taken = await takenPaths(db);
  const rels: string[] = [];
  let failed = 0;
  for (const p of picked) {
    const wanted = folder ? joinRel(folder, p.name) : cleanSegment(p.name);
    let rel = uniqueRelPath(wanted, taken);
    while (vaultFile(rel).exists) {
      taken.add(rel); // a file on disk the database does not know: never overwrite it
      rel = uniqueRelPath(wanted, taken);
    }
    const source = new File(p.uri);
    const target = vaultFile(rel);
    try {
      if (!source.exists) throw new Error('source-missing');
      ensureParents(rel);
      await source.copy(target);
      const size = target.size ?? -1;
      if (size < 0 || size !== source.size) {
        try {
          target.delete();
        } catch {
          // ignore
        }
        throw new Error('size-mismatch');
      }
      await putItem(db, { id: Crypto.randomUUID(), rel, size });
      taken.add(rel);
      rels.push(rel);
      const type = typeFromName(p.name);
      if (type === 'image' || type === 'video') void ensureThumb(rel, type, THUMB_EDGES[0]); // background; a grid asks again if it is not ready
      if (isCacheCopy(p.uri)) {
        try {
          source.delete();
        } catch {
          // the system clears its cache itself
        }
      }
    } catch {
      failed += 1;
    }
  }
  return { rels, failed };
}
