/**
 * Q5: rename the Status category chips and hide their text (emoji only). Pure (no React Native); tested in scripts/test-status.mjs.
 * Names reuse the Q4 `statusLabels` map (keys `mc:<id>` / `ac:<id>`, same override/reset rules); the hidden list is `statusHiddenNames`
 * (`mc:<id>`, `ac:<id>`, or `all` = emoji only everywhere). Local to this phone.
 */
import type { TranslationKey } from '@/src/i18n';
import { ACTIVITIES, ACTIVITY_CATEGORY_IDS, ACTIVITY_CATEGORY_LABEL } from './activities';
import { MOODS, MOOD_CATEGORY_IDS, MOOD_CATEGORY_LABEL } from './moods';
import { setLabelOverride, type StatusLabels } from './status-custom';

export const HIDE_ALL = 'all';
export type CategoryKind = 'mood' | 'activity';
export type ChipItem<T extends string> = { id: T; label: string; a11y?: string };

type Translate = (key: TranslationKey) => string;

export const categoryKey = (kind: CategoryKind, id: string) => `${kind === 'mood' ? 'mc' : 'ac'}:${id}`;

const defaultKey = (kind: CategoryKind, id: string): TranslationKey =>
  (kind === 'mood' ? MOOD_CATEGORY_LABEL[id as keyof typeof MOOD_CATEGORY_LABEL] : ACTIVITY_CATEGORY_LABEL[id as keyof typeof ACTIVITY_CATEGORY_LABEL]);

/** The name shown for a category: my edited name, else the built-in one. */
export const categoryName = (kind: CategoryKind, id: string, labels: StatusLabels, t: Translate): string => labels[categoryKey(kind, id)] || t(defaultKey(kind, id));
export const categoryDefaultName = (kind: CategoryKind, id: string, t: Translate): string => t(defaultKey(kind, id));

/** Saves a category name; empty or the original name = back to the default. */
export const setCategoryName = (labels: StatusLabels, kind: CategoryKind, id: string, text: string, t: Translate): StatusLabels =>
  setLabelOverride(labels, categoryKey(kind, id), text, categoryDefaultName(kind, id, t));

/** The emoji that stands for a category when its text is hidden: the category's first emoji. */
export const categoryEmoji = (kind: CategoryKind, id: string): string => (kind === 'mood' ? MOODS.find((m) => m.category === id) : ACTIVITIES.find((a) => a.category === id))?.emoji ?? '•';

/** Is the text of this category (its chip, and for activities its tiles) hidden? `all` hides every category. */
export const namesHidden = (hidden: string[], kind: CategoryKind, id: string): boolean => hidden.includes(HIDE_ALL) || hidden.includes(categoryKey(kind, id));

/** Turns the hidden state of one key (a category key or `all`) on or off. */
export const setNamesHidden = (hidden: string[], key: string, hide: boolean): string[] => {
  const rest = hidden.filter((k) => k !== key);
  return hide ? [...rest, key] : rest;
};

/** Chips of one Status row: "All" (+ "Mine"), then the categories with my names, or just their emoji when hidden. */
export function categoryChips<T extends string>(kind: CategoryKind, labels: StatusLabels, hidden: string[], t: Translate, hasCustom: boolean): ChipItem<T | 'all' | 'custom'>[] {
  const ids = (kind === 'mood' ? MOOD_CATEGORY_IDS : ACTIVITY_CATEGORY_IDS) as string[];
  return [
    { id: 'all', label: t('statusCatAll') },
    ...(hasCustom ? [{ id: 'custom' as const, label: t('statusCatCustom') }] : []),
    ...ids.map((id) => {
      const name = categoryName(kind, id, labels, t);
      return namesHidden(hidden, kind, id) ? { id: id as T, label: categoryEmoji(kind, id), a11y: name } : { id: id as T, label: name };
    }),
  ];
}
