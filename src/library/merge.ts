import type { SourceKind, StorageItem } from '../storage/types';

/** One merged library item: the same file seen on one or more sources. */
export type SourceRef = { sourceId: string; itemId: string };
export type LibraryEntry = {
  /** Identity used by favourites, tags and albums (md5, else name+size+mtime). */
  key: string;
  item: StorageItem;
  refs: SourceRef[];
};
export type SortMode = 'name' | 'newest' | 'oldest';

export function dedupeKey(item: StorageItem): string {
  if (item.type === 'dir') return `dir:${item.name}`;
  if (item.md5) return `md5:${item.md5}`;
  return `nsm:${item.name}|${item.size}|${item.mtime}`;
}

/**
 * Merges items from one source into the map. A file already seen on the SAME
 * source stays a separate entry (two copies in two folders), a file seen on
 * ANOTHER source gets one more ref (that is the "exists on" badge).
 */
export function mergeInto(
  map: Map<string, LibraryEntry>,
  sourceId: string,
  items: StorageItem[],
): void {
  for (const item of items) {
    let key = dedupeKey(item);
    const existing = map.get(key);
    if (existing && existing.refs.some((ref) => ref.sourceId === sourceId)) {
      if (item.type === 'dir') {
        // a folder can have several ids on one source only if listed twice
        if (!existing.refs.some((ref) => ref.itemId === item.id)) {
          existing.refs.push({ sourceId, itemId: item.id });
        }
        continue;
      }
      if (existing.refs.some((ref) => ref.itemId === item.id)) continue;
      key = `${key}@${sourceId}:${item.id}`;
    }
    const target = map.get(key);
    if (target) target.refs.push({ sourceId, itemId: item.id });
    else map.set(key, { key, item, refs: [{ sourceId, itemId: item.id }] });
  }
}

const KIND_ORDER: Record<SourceKind, number> = { local: 0, vault: 1 };

/** Preferred source first: phone, vault, then Google Drive, then the server. */
export function sortRefs(refs: SourceRef[], kinds: Record<string, SourceKind>): SourceRef[] {
  return [...refs].sort(
    (a, b) => (KIND_ORDER[kinds[a.sourceId]] ?? 9) - (KIND_ORDER[kinds[b.sourceId]] ?? 9),
  );
}

/** Q2: a missing source date is stored as the Unix epoch (1970-01-01); that is "no date", never a date to show. */
export function hasRealDate(iso: string | null | undefined): iso is string {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= 86_400_000;
}

export function archiveDate(entry: LibraryEntry, overrides?: Record<string, { date: string | null }>): string {
  return overrides?.[entry.key]?.date ?? entry.item.mtime;
}

export function compareEntries(
  a: LibraryEntry,
  b: LibraryEntry,
  mode: SortMode,
  overrides?: Record<string, { date: string | null }>,
): number {
  const aDir = a.item.type === 'dir';
  const bDir = b.item.type === 'dir';
  if (aDir !== bDir) return aDir ? -1 : 1;
  if (mode !== 'name' && !aDir) {
    const aDate = archiveDate(a, overrides);
    const bDate = archiveDate(b, overrides);
    const compared = aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
    if (compared !== 0) return mode === 'newest' ? -compared : compared;
  }
  return a.item.name.localeCompare(b.item.name, undefined, { numeric: true });
}

/** Lower-cases and unifies Persian/Arabic letters and digits for searching. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\u200f\u200e]/g, '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .trim();
}

export function matchesQuery(
  entry: LibraryEntry,
  query: string,
  tags: readonly string[] = [],
): boolean {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeText([entry.item.name, ...tags].join(' '));
  return tokens.every((token) => haystack.includes(token));
}

export type Category = 'image' | 'video' | 'file' | 'text';
export const CATEGORIES: Category[] = ['image', 'video', 'file', 'text'];

/** Groups entries by calendar period; `toYearMonth` comes from the chosen calendar. */
export function groupByPeriod(
  entries: LibraryEntry[],
  toYearMonth: (isoDate: string) => { year: number; month: number },
  by: 'month' | 'year',
  overrides?: Record<string, { date: string | null }>,
): { id: string; year: number; month: number; entries: LibraryEntry[] }[] {
  const groups = new Map<string, { id: string; year: number; month: number; entries: LibraryEntry[] }>();
  for (const entry of entries) {
    if (entry.item.type !== 'image' && entry.item.type !== 'video') continue;
    const { year, month } = toYearMonth(archiveDate(entry, overrides));
    const m = by === 'month' ? month : 0;
    const id = `${year}-${String(m).padStart(2, '0')}`;
    const group = groups.get(id) ?? { id, year, month: m, entries: [] };
    group.entries.push(entry);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
}
