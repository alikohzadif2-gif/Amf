import { moodByEmoji } from './moods';

/**
 * Q3: the colours of the big mood card (Status). One FIXED two-colour pair per built-in mood (no colour extraction from the
 * emoji): a red emoji reads red, the yellow faces read yellow + one more colour. The card draws the pair as a soft gradient
 * (`MOOD_CARD_ALPHA` over the card surface) so the text stays readable in light and dark (checked in test-status.mjs).
 * Custom moods (Q4) pick one of `MOOD_PRESETS`.
 */
export type MoodColors = readonly [string, string];

/** Opacity of both gradient stops over the card surface (lighter in dark mode). Contrast of the card text is tested at these values. */
export const MOOD_CARD_ALPHA = { light: 0.34, dark: 0.26 } as const;
/** Opacity of the card's secondary text (label and subtitle) while a mood is picked: `mutedForeground` is too faint on a tinted card. */
export const MOOD_CARD_SECONDARY_TEXT_ALPHA = 0.8;

const YELLOW: MoodColors = ['#FFC931', '#FF9A3C'];
const RED: MoodColors = ['#D62828', '#FF6B35'];
const GRAY: MoodColors = ['#7C8799', '#A9B3C2'];
const GREEN: MoodColors = ['#2FB36D', '#9BD84E'];
const BLUE: MoodColors = ['#2E6FD0', '#5BB6E8'];
const PURPLE: MoodColors = ['#8E44D1', '#C46AE8'];
const PINK: MoodColors = ['#EC4899', '#F59ABF'];
const ORANGE: MoodColors = ['#FF7A1A', '#FFB347'];

/** Built-in moods by id (see moods.ts). Every id in MOODS must be here (tested). */
export const MOOD_PALETTE: Readonly<Record<string, MoodColors>> = {
  happy: YELLOW,
  content: ['#FFC931', '#FF8FA3'],
  cheerful: ['#FFD43B', '#FF9F1C'],
  celebrating: ['#FF5DA2', '#FFC931'],
  confident: ['#2D7DD2', '#F9C74F'],
  grateful: ['#FFB347', '#F2D16B'],
  relieved: ['#6FCF97', '#4DA3FF'],
  warm: ['#FFC931', '#FF7B54'],
  excited: ['#FFC931', '#FF5DA2'],
  playful: ['#FFC931', '#FF7A1A'],
  strong: ['#E8A35C', '#B5651D'],
  motivated: ['#FF4D1C', '#FFB000'],
  energized: ['#FFD400', '#FF9F1C'],
  inspired: ['#4C6FFF', '#B04CFF'],
  active: GREEN,
  silly: ['#FFC931', '#7ED957'],
  mischievous: ['#7B2CBF', '#E5383B'],
  peaceful: ['#6C8EF5', '#9AD7C8'],
  relaxed: ['#4CAF78', '#A7D8A0'],
  cozy: ['#A0693D', '#D9A066'],
  sleepy: ['#5A6BC4', '#8E9AE6'],
  tired: ['#8E9AB0', '#B8A9D9'],
  dreamy: ['#5B4B9A', '#9B8CE0'],
  restful: ['#7E9BB5', '#B4A68E'],
  neutral: GRAY,
  thoughtful: ['#E0A526', '#8A94A6'],
  quiet: ['#4C5C80', '#7A8BB0'],
  mixed: ['#E8A33D', '#6C8EF5'],
  curious: ['#2BA6A0', '#E0B23C'],
  unsure: ['#9A8F7A', '#B8B0A0'],
  bored: ['#8A93A3', '#B0B7C3'],
  indifferent: ['#7D8794', '#A6A099'],
  sad: ['#4A6FA5', '#7C9CC9'],
  down: BLUE,
  angry: RED,
  anxious: ['#5C9BD6', '#9A8FD6'],
  overwhelmed: ['#C44569', '#8E5CD6'],
  unwell: ['#7FB069', '#C9D86B'],
  confused: ['#B08968', '#8E9AAF'],
  crying: ['#1F6FEB', '#4CC2FF'],
  disappointed: ['#5B7DB1', '#8E8FBF'],
  frustrated: ['#E5532D', '#B5338A'],
  period: ['#C1121F', '#FF5D73'],
};

/** Q4: about eight colours a custom mood can be given (same shape as the built-in pairs). */
export const MOOD_PRESETS: readonly { id: string; colors: MoodColors }[] = [
  { id: 'yellow', colors: YELLOW },
  { id: 'orange', colors: ORANGE },
  { id: 'red', colors: RED },
  { id: 'pink', colors: PINK },
  { id: 'purple', colors: PURPLE },
  { id: 'blue', colors: BLUE },
  { id: 'green', colors: GREEN },
  { id: 'gray', colors: GRAY },
];

/** The gradient pair for a mood emoji; undefined for an emoji that is not a built-in mood (the card then keeps its neutral look). */
export function moodColorsFor(emoji: string | null | undefined, custom: readonly { emoji: string; preset: number }[] = []): MoodColors | undefined {
  const mood = moodByEmoji(emoji);
  if (mood) return MOOD_PALETTE[mood.id];
  const own = emoji ? custom.find((c) => c.emoji === emoji) : undefined;
  return own ? MOOD_PRESETS[own.preset]?.colors : undefined;
}
