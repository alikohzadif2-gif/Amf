import type { LibraryEntry } from '@/src/library/merge';
import type { SourceKind } from '@/src/storage/types';

export type CategoryTotals = { count: number; bytes: number };

export type StorageStats = {
  /** Files in the library index by category (a file on two sources counts once). */
  categories: { photos: CategoryTotals; videos: CategoryTotals; files: CategoryTotals; texts: CategoryTotals };
  total: CategoryTotals;
  /** Per source kind: how many index entries exist there and their size. */
  bySource: Record<SourceKind, CategoryTotals>;
};

const empty = (): CategoryTotals => ({ count: 0, bytes: 0 });

/** Sums what the library index already knows (no scan, no network). */
export function analyzeStorage(
  entries: readonly LibraryEntry[],
  kinds: Readonly<Record<string, SourceKind>>,
): StorageStats {
  const stats: StorageStats = {
    categories: { photos: empty(), videos: empty(), files: empty(), texts: empty() },
    total: empty(),
    bySource: { local: empty(), vault: empty(), partner: empty() },
  };
  for (const entry of entries) {
    const { type, size } = entry.item;
    if (type === 'dir') continue;
    if (entry.refs.length > 0 && entry.refs.every((ref) => kinds[ref.sourceId] === 'partner')) continue; // the partner's file is not stored here at this size
    const bucket =
      type === 'image' ? stats.categories.photos
      : type === 'video' ? stats.categories.videos
      : type === 'text' ? stats.categories.texts
      : stats.categories.files;
    bucket.count += 1;
    bucket.bytes += size;
    stats.total.count += 1;
    stats.total.bytes += size;
    const seen = new Set<SourceKind>();
    for (const ref of entry.refs) {
      const kind = kinds[ref.sourceId];
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      stats.bySource[kind].count += 1;
      stats.bySource[kind].bytes += size;
    }
  }
  return stats;
}
