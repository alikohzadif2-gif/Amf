import type { TranslationKey } from '@/src/i18n';

/**
 * Status activities (U13): 42 neutral activities with an emoji, six categories. Names and category labels are i18n keys
 * (`actName_<id>`, `actCat_<category>`), fa + en. A saved status stores the activity `id`.
 */
export type ActivityCategoryId = 'entertainment' | 'hobbies' | 'health' | 'social' | 'home' | 'travel';
export type Activity = { id: string; emoji: string; category: ActivityCategoryId; name: TranslationKey };

export const ACTIVITY_CATEGORY_IDS: ActivityCategoryId[] = ['entertainment', 'hobbies', 'health', 'social', 'home', 'travel'];

export const ACTIVITY_CATEGORY_LABEL: Record<ActivityCategoryId, TranslationKey> = {
  entertainment: 'actCat_entertainment',
  hobbies: 'actCat_hobbies',
  health: 'actCat_health',
  social: 'actCat_social',
  home: 'actCat_home',
  travel: 'actCat_travel',
};

const RAW: [string, string, ActivityCategoryId][] = [
  ['movie', '🎬', 'entertainment'],
  ['tv', '📺', 'entertainment'],
  ['gaming', '🎮', 'entertainment'],
  ['music', '🎵', 'entertainment'],
  ['karaoke', '🎤', 'entertainment'],
  ['theater', '🎭', 'entertainment'],
  ['boardgames', '🎲', 'entertainment'],
  ['reading', '📖', 'hobbies'],
  ['painting', '🎨', 'hobbies'],
  ['photography', '📷', 'hobbies'],
  ['cooking', '🍳', 'hobbies'],
  ['gardening', '🪴', 'hobbies'],
  ['instrument', '🎸', 'hobbies'],
  ['writing', '✍️', 'hobbies'],
  ['running', '🏃', 'health'],
  ['gym', '🏋️', 'health'],
  ['yoga', '🧘', 'health'],
  ['cycling', '🚴', 'health'],
  ['swimming', '🏊', 'health'],
  ['walking', '🚶', 'health'],
  ['rest', '🛌', 'health'],
  ['coffee', '☕', 'social'],
  ['dinnerout', '🍽️', 'social'],
  ['party', '🎉', 'social'],
  ['call', '📞', 'social'],
  ['family', '👪', 'social'],
  ['meeting', '🤝', 'social'],
  ['celebration', '🎂', 'social'],
  ['cleaning', '🧹', 'home'],
  ['homechill', '🏠', 'home'],
  ['laundry', '🧺', 'home'],
  ['shopping', '🛒', 'home'],
  ['mealprep', '🍲', 'home'],
  ['working', '💻', 'home'],
  ['bath', '🛁', 'home'],
  ['flight', '✈️', 'travel'],
  ['roadtrip', '🚗', 'travel'],
  ['beach', '🏖️', 'travel'],
  ['hiking', '⛰️', 'travel'],
  ['camping', '🏕️', 'travel'],
  ['train', '🚆', 'travel'],
  ['sightseeing', '🗺️', 'travel'],
];

export const ACTIVITIES: Activity[] = RAW.map(([id, emoji, category]) => ({ id, emoji, category, name: `actName_${id}` as TranslationKey }));

export function activityById(id: string | null | undefined): Activity | undefined {
  return id ? ACTIVITIES.find((a) => a.id === id) : undefined;
}
