/** Pure search/filter helpers for the Status screen (moods + activities). No React Native imports; tested in scripts/test-status.mjs. */

/** Lower-case, unify Arabic/Persian letter variants, drop diacritics, kashida, zero-width marks, Persian/Arabic digits -> Latin, trim. */
export function normalizeQuery(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ‌‍‎‏]/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

type Named = { emoji: string };

function matches<T extends Named>(item: T, label: string, q: string): boolean {
  if (!q) return true;
  return normalizeQuery(label).includes(q) || item.emoji.includes(q);
}

/** Moods filtered by category (`'all'` = every category) and a search text matched against the shown name or the emoji. */
export function filterMoods<M extends { emoji: string; category: string }>(moods: M[], opts: { category?: string; query?: string }, nameOf: (m: M) => string): M[] {
  const q = normalizeQuery(opts.query ?? '');
  return moods.filter((m) => (!opts.category || opts.category === 'all' || m.category === opts.category) && matches(m, nameOf(m), q));
}

export function filterActivities<A extends { emoji: string; category: string }>(
  activities: A[],
  opts: { category?: string; query?: string },
  nameOf: (a: A) => string,
): A[] {
  const q = normalizeQuery(opts.query ?? '');
  return activities.filter((a) => (!opts.category || opts.category === 'all' || a.category === opts.category) && matches(a, nameOf(a), q));
}

/**
 * Splits items into columns of `rows` items for a horizontally scrolling tile grid (items fill a column top to bottom, then the next column).
 * `rtl` reverses the column order so the first column sits at the right edge; the grid is always laid out physically left-to-right.
 */
export function toColumns<T>(items: T[], rows: number, rtl = false): T[][] {
  const n = Math.max(1, Math.floor(rows));
  const cols: T[][] = [];
  for (let i = 0; i < items.length; i += n) cols.push(items.slice(i, i + n));
  return rtl ? cols.reverse() : cols;
}

/** R3: items whose key is in `recent` come first (in that order); the rest keep their catalogue order. */
export function recentFirst<T>(items: T[], recent: string[], keyOf: (item: T) => string): T[] {
  const rank = new Map(recent.map((k, i) => [k, i]));
  const used = items.filter((i) => rank.has(keyOf(i))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...used, ...items.filter((i) => !rank.has(keyOf(i)))];
}
