import { parseFileId } from '../server/ids';
import { useLibraryIndex } from './index-store';
import type { LibraryEntry } from './merge';
import { sourceKinds } from './providers';

/**
 * The server id of a library file: the same on both phones of a household (they read one server), so likes, comments and
 * "send to Direct" use it to point at the file. Null when the file has no copy on a server (phone only).
 */
export function serverIdOf(entry: LibraryEntry): string | null {
  const kinds = sourceKinds();
  for (const ref of entry.refs) {
    if (kinds[ref.sourceId] !== 'server') continue;
    const file = parseFileId(ref.itemId);
    if (file) return file.serverId;
  }
  return null;
}

/** The library entry for a server id or a `Shared/...` path (a Direct message), when the index has it. */
export function findEntry(target: { item?: string | null; media?: string | null }): LibraryEntry | null {
  const { entries } = useLibraryIndex.getState();
  for (const entry of entries) {
    for (const ref of entry.refs) {
      const file = parseFileId(ref.itemId);
      if (!file) continue;
      if ((target.item && file.serverId === target.item) || (target.media && file.path === target.media)) return entry;
    }
  }
  return null;
}
