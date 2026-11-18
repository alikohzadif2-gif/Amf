import { parseFileId } from '../server/ids';
import { useLibraryIndex } from './index-store';
import type { LibraryEntry } from './merge';

/**
 * Legacy: the server library is gone, so no library file has a server id any more. Always null; likes and comments on a
 * library file therefore ask the person to pair (they need a stable id that both phones share, which a later stage can add).
 */
export function serverIdOf(_entry: LibraryEntry): string | null {
  return null;
}

/** The library entry for a shared reference (`Shared/...`, a Direct message), when the index has it. */
export function findEntry(target: { media?: string | null }): LibraryEntry | null {
  const { entries } = useLibraryIndex.getState();
  for (const entry of entries) {
    for (const ref of entry.refs) {
      const file = parseFileId(ref.itemId);
      if (file && target.media && file.path === target.media) return entry;
    }
  }
  return null;
}
