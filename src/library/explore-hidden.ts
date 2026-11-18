import { dirId, parseFileId } from '../server/ids';
import type { LibraryEntry, SourceRef } from './merge';

/** The key stored in settings for a folder hidden from Explore (`sourceId` + the folder's provider id). */
export const exploreFolderKey = (sourceId: string, folderId: string): string => `${sourceId}\u0000${folderId}`;

/** Every folder id above a file (server: `d:<root>:<path>`, phone: `fs:<uri>`), nearest first. */
function ancestorIds(itemId: string): string[] {
  const file = parseFileId(itemId);
  if (file) {
    const dirs = file.path.split('/').slice(0, -1);
    const out = [dirId(file.rootId, '')];
    let acc = '';
    for (const part of dirs) {
      acc = acc === '' ? part : `${acc}/${part}`;
      out.push(dirId(file.rootId, acc));
    }
    return out.reverse();
  }
  if (itemId.startsWith('fs:')) {
    const out: string[] = [];
    let uri = itemId.slice(3).split('?')[0];
    for (let i = 0; i < 40; i += 1) {
      const slash = uri.replace(/\/+$/, '').lastIndexOf('/');
      if (slash <= 8) break; // stop at the scheme (file:///)
      uri = uri.slice(0, slash);
      out.push(`fs:${uri}`, `fs:${uri}/`);
    }
    return out;
  }
  return [];
}

const hiddenRef = (ref: SourceRef, hidden: ReadonlySet<string>) => ancestorIds(ref.itemId).some((id) => hidden.has(exploreFolderKey(ref.sourceId, id)));

/** Explore without the files of hidden folders (and their sub-folders). A file with a copy in a shown folder stays. */
export function excludeFromExplore(entries: LibraryEntry[], hiddenFolders: readonly string[]): LibraryEntry[] {
  if (hiddenFolders.length === 0) return entries;
  const hidden = new Set(hiddenFolders);
  return entries.filter((entry) => entry.refs.some((ref) => !hiddenRef(ref, hidden)));
}

/** True when the folder entry (a `dir` of the Archive) is hidden from Explore in every source it exists in. */
export function isFolderHidden(entry: LibraryEntry, hiddenFolders: readonly string[]): boolean {
  const set = new Set(hiddenFolders);
  return entry.refs.length > 0 && entry.refs.every((ref) => set.has(exploreFolderKey(ref.sourceId, ref.itemId)));
}
