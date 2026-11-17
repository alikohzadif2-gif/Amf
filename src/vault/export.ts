/**
 * "Unhide": gives vault files back to a public folder the person chooses (so the gallery and the file manager see them), and
 * "Hide again": takes them back into the vault.
 *
 * Unhide is a verified move: each file is copied out, size AND MD5 are compared, and only then the vault copy is removed. If the
 * checksum cannot be read on one side, the vault copy STAYS. The vault row is kept as `exported` (same id), so hiding the same file
 * again is the same file for sync, and nothing is reported as deleted to the partner while it is outside (docs/SHARING_VAULT.md).
 */
import { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { itemsOfTop, setItemState, type VaultItem } from './db';
import { pruneEmptyParents, statOf, vaultFile } from './files';
import { displayName } from './logic';
import { describeFolder, findChild, type Picked } from './saf';

export type UnhideResult = { moved: number; kept: number; failed: number };

function childFolder(parent: Directory, name: string, cache: Map<string, Directory>, key: string): Directory {
  const hit = cache.get(key);
  if (hit) return hit;
  const found = findChild(parent, name);
  const dir = found instanceof Directory ? found : parent.createDirectory(name);
  cache.set(key, dir);
  return dir;
}

async function unhideOne(db: SQLiteDatabase, item: VaultItem, dest: Directory, cache: Map<string, Directory>): Promise<'moved' | 'kept' | 'failed'> {
  const source = vaultFile(item.rel);
  if (!source.exists) return 'failed';
  const parts = item.rel.split('/');
  const name = parts[parts.length - 1];
  let dir = dest;
  let path = '';
  try {
    for (const part of parts.slice(0, -1)) {
      path = `${path}/${part}`;
      dir = childFolder(dir, part, cache, path);
    }
  } catch {
    return 'failed';
  }
  const srcStat = statOf(source);
  let copied = findChild(dir, name);
  if (copied === null) {
    try {
      await source.copy(dir);
    } catch {
      return 'failed';
    }
    copied = findChild(dir, name);
  }
  if (!(copied instanceof File)) return 'failed';
  const out = statOf(copied);
  const sameSize = srcStat.size !== undefined && out.size === srcStat.size;
  const sameHash = !!srcStat.md5 && !!out.md5 && srcStat.md5.toLowerCase() === out.md5.toLowerCase();
  if (!sameSize) {
    // not the same file as ours (e.g. a different file with that name already there): leave both alone
    return 'kept';
  }
  if (!sameHash) return 'kept'; // checksum unavailable or different: the vault copy stays
  try {
    source.delete();
  } catch {
    return 'kept';
  }
  await setItemState(db, item.id, 'exported', { exportUri: dest.uri });
  pruneEmptyParents(item.rel);
  return 'moved';
}

/** Unhides everything under a top-level vault folder/file into `dest`. `isCancelled` stops between files. */
export async function unhideTop(db: SQLiteDatabase, top: string, dest: Directory, isCancelled: () => boolean = () => false): Promise<UnhideResult> {
  const items = await itemsOfTop(db, top, 'hidden');
  const cache = new Map<string, Directory>();
  const out: UnhideResult = { moved: 0, kept: 0, failed: 0 };
  for (const item of items) {
    if (isCancelled()) break;
    const result = await unhideOne(db, item, dest, cache);
    out[result === 'moved' ? 'moved' : result === 'kept' ? 'kept' : 'failed'] += 1;
  }
  return out;
}

/** What to add back to the vault for an unhidden top: the folder (or the single file) in the place it was exported to. Null if it cannot be found/read. */
export function rehideSource(top: string, exportUri: string): Picked | null {
  try {
    const found = findChild(new Directory(exportUri), top);
    if (found instanceof Directory) return describeFolder(found);
    if (found instanceof File) {
      const size = statOf(found).size ?? 0;
      return { kind: 'files', uris: [found.uri], files: [{ uri: found.uri, name: displayName(found.name || found.uri), size }] };
    }
  } catch {
    // permission to that folder is gone: the person picks the folder again
  }
  return null;
}
