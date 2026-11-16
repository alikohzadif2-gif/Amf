import { DIARY_NO_CATEGORY } from './categories';

/**
 * Q2: a memory's category also files its photos/videos in the Archive (the Archive's category views read
 * `archive_item_meta`, which a memory never wrote). Pure planning step so it can be tested without a phone.
 * - a real category is set on every media key of the memory;
 * - when the memory goes back to "none", only items still carrying the memory's OLD category are cleared
 *   (a category the person chose by hand in the Archive is left alone).
 */
export function planArchiveCategory(
  keys: readonly string[],
  category: string,
  previous: string | undefined,
  meta: Readonly<Record<string, { category: string } | undefined>>,
): { set: string[]; clear: string[] } {
  const unique = [...new Set(keys.filter((key) => typeof key === 'string' && key.length > 0))];
  if (category !== DIARY_NO_CATEGORY) {
    return { set: unique.filter((key) => (meta[key]?.category ?? DIARY_NO_CATEGORY) !== category), clear: [] };
  }
  if (!previous || previous === DIARY_NO_CATEGORY) return { set: [], clear: [] };
  return { set: [], clear: unique.filter((key) => meta[key]?.category === previous) };
}
