import type { LibraryEntry } from '@/src/library/merge';

export type DuplicateGroup = {
  md5: string;
  /** Size of one copy. */
  size: number;
  entries: LibraryEntry[];
  /** Space taken by the extra copies: size * (copies - 1). */
  wasted: number;
};

export type DuplicateReport = {
  groups: DuplicateGroup[];
  /** Total of `wasted` over all groups. */
  wasted: number;
};

/**
 * Equal-md5 groups from the library index. The index already merges the same file
 * seen on several sources into ONE entry (that is a backup, not a duplicate), and
 * keeps two copies on the same source as separate entries, so two entries with the
 * same md5 are real duplicates. Folders and files without a checksum are ignored.
 * Read-only: nothing is deleted.
 */
export function findDuplicates(entries: readonly LibraryEntry[]): DuplicateReport {
  const byMd5 = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    const md5 = entry.item.md5;
    if (entry.item.type === 'dir' || !md5) continue;
    const list = byMd5.get(md5);
    if (list) list.push(entry);
    else byMd5.set(md5, [entry]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [md5, list] of byMd5) {
    if (list.length < 2) continue;
    const size = list[0].item.size;
    groups.push({ md5, size, entries: list, wasted: size * (list.length - 1) });
  }
  groups.sort((a, b) => b.wasted - a.wasted || a.md5.localeCompare(b.md5));
  return { groups, wasted: groups.reduce((sum, g) => sum + g.wasted, 0) };
}
