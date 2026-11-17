import type { TranslationKey } from '@/src/i18n';

/**
 * Status moods (U13): 41 neutral emojis in five categories. No hearts or romantic/explicit items (brief rule 8, Q8).
 * Names and category labels are i18n keys (`moodName_<id>`, `moodCat…`), fa + en.
 */
export type MoodCategoryId = 'positive' | 'energetic' | 'calm' | 'neutral' | 'hard';
export type Mood = { id: string; emoji: string; category: MoodCategoryId; name: TranslationKey };

export const MOOD_CATEGORY_IDS: MoodCategoryId[] = ['positive', 'energetic', 'calm', 'neutral', 'hard'];

export const MOOD_CATEGORY_LABEL: Record<MoodCategoryId, TranslationKey> = {
  positive: 'moodCatPositive',
  energetic: 'moodCatEnergetic',
  calm: 'moodCatCalm',
  neutral: 'moodCatNeutral',
  hard: 'moodCatHard',
};

const RAW: [string, string, MoodCategoryId][] = [
  ['happy', '😀', 'positive'],
  ['content', '😊', 'positive'],
  ['cheerful', '😄', 'positive'],
  ['celebrating', '🥳', 'positive'],
  ['confident', '😎', 'positive'],
  ['grateful', '🙏', 'positive'],
  ['relieved', '😌', 'positive'],
  ['warm', '🤗', 'positive'],
  ['excited', '🤩', 'energetic'],
  ['playful', '😆', 'energetic'],
  ['strong', '💪', 'energetic'],
  ['motivated', '🔥', 'energetic'],
  ['energized', '⚡', 'energetic'],
  ['inspired', '🚀', 'energetic'],
  ['active', '🏃', 'energetic'],
  ['silly', '😝', 'energetic'],
  ['mischievous', '😈', 'energetic'],
  ['peaceful', '🧘', 'calm'],
  ['relaxed', '🌿', 'calm'],
  ['cozy', '☕', 'calm'],
  ['sleepy', '😴', 'calm'],
  ['tired', '🥱', 'calm'],
  ['dreamy', '🌙', 'calm'],
  ['restful', '🛋️', 'calm'],
  ['neutral', '😐', 'neutral'],
  ['thoughtful', '🤔', 'neutral'],
  ['quiet', '😶', 'neutral'],
  ['mixed', '🙃', 'neutral'],
  ['curious', '🧐', 'neutral'],
  ['unsure', '🤨', 'neutral'],
  ['bored', '😑', 'neutral'],
  ['indifferent', '😒', 'neutral'],
  ['sad', '😔', 'hard'],
  ['down', '😢', 'hard'],
  ['angry', '😠', 'hard'],
  ['anxious', '😰', 'hard'],
  ['overwhelmed', '😩', 'hard'],
  ['unwell', '🤒', 'hard'],
  ['confused', '😕', 'hard'],
  ['crying', '😭', 'hard'],
  ['disappointed', '😞', 'hard'],
  ['frustrated', '😤', 'hard'],
  ['period', '🩸', 'hard'],
];

export const MOODS: Mood[] = RAW.map(([id, emoji, category]) => ({ id, emoji, category, name: `moodName_${id}` as TranslationKey }));

export function moodByEmoji(emoji: string | null | undefined): Mood | undefined {
  return emoji ? MOODS.find((m) => m.emoji === emoji) : undefined;
}

export function moodById(id: string | null | undefined): Mood | undefined {
  return id ? MOODS.find((m) => m.id === id) : undefined;
}

/** Category view used by the current Status screen (until U14 rebuilds it): one entry per category with its emojis. */
export const MOOD_CATEGORIES: { id: MoodCategoryId; label: TranslationKey; emojis: string[] }[] = MOOD_CATEGORY_IDS.map((id) => ({
  id,
  label: MOOD_CATEGORY_LABEL[id],
  emojis: MOODS.filter((m) => m.category === id).map((m) => m.emoji),
}));
