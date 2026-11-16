import { DIARY_CATEGORIES, DIARY_NO_CATEGORY } from '@/src/diary/categories';
import type { TranslationKey } from '@/src/i18n';

export type ArchiveCategoryOption = { id: string; label: string };
type Translator = (key: TranslationKey) => string;

/** The Archive uses the same built-in and user-defined categories as Diary. */
export function archiveCategoryOptions(
  custom: readonly { id: string; name: string }[],
  t: Translator,
): ArchiveCategoryOption[] {
  return [
    { id: DIARY_NO_CATEGORY, label: t('diaryCategoryNone') },
    ...DIARY_CATEGORIES.map((category) => ({ id: category.id, label: t(category.name) })),
    ...custom.map((category) => ({ id: category.id, label: category.name })),
  ];
}
