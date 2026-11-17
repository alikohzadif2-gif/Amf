/** Built-in categories (ids are stored in SQLite and must not change). Custom ones live in `diary_categories` (category-db.ts). */
export const DIARY_CATEGORIES = [
  { id: 'date-night', name: 'diaryCategoryDateNight' },
  { id: 'travel', name: 'diaryCategoryTravel' },
  { id: 'milestone', name: 'diaryCategoryMilestone' },
  { id: 'random', name: 'diaryCategoryRandom' },
  { id: 'gift', name: 'diaryCategoryGift' },
  { id: 'fight-makeup', name: 'diaryCategoryFightMakeup' },
] as const;

/** "No category": the default for a new memory and the fallback when a custom category is deleted. */
export const DIARY_NO_CATEGORY = 'none';

export type DiaryCategoryId = (typeof DIARY_CATEGORIES)[number]['id'];
/** A category id as stored: built-in id, `none`, or a custom id (`c…`). */
export type DiaryCategoryValue = string;
export type CustomCategory = { id: string; name: string };

export const CUSTOM_CATEGORY_MAX = 30;
export const CUSTOM_CATEGORY_NAME_MAX = 30;

export function isDiaryCategory(value: unknown): value is DiaryCategoryId {
  return typeof value === 'string' && DIARY_CATEGORIES.some((category) => category.id === value);
}

export function diaryCategoryName(id: string): (typeof DIARY_CATEGORIES)[number]['name'] | undefined {
  return DIARY_CATEGORIES.find((category) => category.id === id)?.name;
}

/** Text shown for a stored category id. An unknown id (for example a deleted custom category) reads as "No category". */
export function diaryCategoryLabel(
  id: string,
  customs: readonly CustomCategory[],
  t: (key: 'diaryCategoryNone' | (typeof DIARY_CATEGORIES)[number]['name']) => string,
): string {
  const builtIn = diaryCategoryName(id);
  if (builtIn) return t(builtIn);
  const custom = customs.find((category) => category.id === id);
  return custom ? custom.name : t('diaryCategoryNone');
}
