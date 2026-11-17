import en from './locales/en.json';
import fa from './locales/fa.json';
import { useSettingsStore, type Language } from '@/src/state/settings-store';

const dictionaries = { en, fa };

type Dictionary = typeof en;
export type TranslationKey = Exclude<
  keyof Dictionary,
  'monthNames' | 'weekdays'
>;

export function getDictionary(language: Language): Dictionary {
  return dictionaries[language];
}

export function useI18n() {
  const language = useSettingsStore((state) => state.language);
  const dictionary = getDictionary(language);

  return {
    language,
    isRTL: language === 'fa',
    t: (key: TranslationKey) => dictionary[key] as string,
  };
}

export function fontFamilyFor(
  language: Language,
  weight: 'regular' | 'medium' | 'semibold' | 'bold' = 'regular',
): string {
  const weights = {
    regular: '400Regular',
    medium: '500Medium',
    semibold: '600SemiBold',
    bold: '700Bold',
  } as const;

  return language === 'fa'
    ? `Vazirmatn_${weights[weight]}`
    : `Inter_${weights[weight]}`;
}
