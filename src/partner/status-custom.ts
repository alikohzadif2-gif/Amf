/**
 * Q4: own moods/activities, edited labels, and the text the partner receives. Pure (no React Native); tested in scripts/test-status.mjs.
 * Stored in the settings store (`statusCustomMoods`, `statusCustomActivities`, `statusLabels`), on this phone only.
 */
import type { TranslationKey } from '@/src/i18n';
import { ACTIVITIES, type ActivityCategoryId } from './activities';
import { MOODS, type MoodCategoryId } from './moods';

export const LABEL_MAX = 40;
export const CUSTOM_MAX = 60;
export const MOOD_PRESET_COUNT = 8;

export type CustomMood = { id: string; emoji: string; label: string; preset: number };
export type CustomActivity = { id: string; emoji: string; label: string };
/** `m:<mood id>` / `a:<activity id>` -> label typed by the owner (built-in items only). */
export type StatusLabels = Record<string, string>;

/** What the Status screen shows for one mood / activity: the shown label and where it came from. */
export type MoodItem = { id: string; emoji: string; category: MoodCategoryId | 'custom'; label: string; custom: boolean; edited: boolean; preset?: number };
export type ActivityItem = { id: string; emoji: string; category: ActivityCategoryId | 'custom'; label: string; custom: boolean; edited: boolean };

type Translate = (key: TranslationKey) => string;

export const normalizeLabel = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
const bare = (emoji: string): string => emoji.replace(/\uFE0F/g, '');

/**
 * An emoji for a custom item: 1-16 characters (the mailbox limit), no spaces, nothing that is plain ASCII or a letter/digit.
 * Emoji symbols all sit above U+203C (plus the joiner and variation selector); no emoji engine.
 */
export function isValidStatusEmoji(input: string): boolean {
  const s = input.trim();
  if (s === '' || s.length > 16 || /\s/.test(s)) return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x203c && cp !== 0x200d && cp !== 0xfe0f) return false; // ZWJ and the emoji variation selector join emoji
  }
  return /[^\u200d\ufe0f]/.test(s);
}

export type AddFailure = 'emoji' | 'label' | 'duplicate' | 'limit';
export type AddResult<T> = { ok: true; list: T[]; item: T } | { ok: false; reason: AddFailure };

const newId = (rand: () => number, now: () => number) => `c${now().toString(36)}${Math.floor(rand() * 36 ** 4).toString(36)}`;

/** A custom mood needs its own emoji: the partner's phone recognises a mood by its emoji. */
export function addCustomMood(
  list: CustomMood[],
  input: { emoji: string; label: string; preset: number },
  rand: () => number = Math.random,
  now: () => number = Date.now,
): AddResult<CustomMood> {
  const emoji = input.emoji.trim();
  const label = normalizeLabel(input.label);
  if (!isValidStatusEmoji(emoji)) return { ok: false, reason: 'emoji' };
  if (label === '') return { ok: false, reason: 'label' };
  if (list.length >= CUSTOM_MAX) return { ok: false, reason: 'limit' };
  const taken = new Set([...MOODS.map((m) => bare(m.emoji)), ...list.map((m) => bare(m.emoji))]);
  if (taken.has(bare(emoji))) return { ok: false, reason: 'duplicate' };
  const preset = Number.isInteger(input.preset) && input.preset >= 0 && input.preset < MOOD_PRESET_COUNT ? input.preset : 0;
  const item = { id: newId(rand, now), emoji, label, preset };
  return { ok: true, list: [...list, item], item };
}

export function addCustomActivity(
  list: CustomActivity[],
  input: { emoji: string; label: string },
  rand: () => number = Math.random,
  now: () => number = Date.now,
): AddResult<CustomActivity> {
  const emoji = input.emoji.trim();
  const label = normalizeLabel(input.label);
  if (!isValidStatusEmoji(emoji)) return { ok: false, reason: 'emoji' };
  if (label === '') return { ok: false, reason: 'label' };
  if (list.length >= CUSTOM_MAX) return { ok: false, reason: 'limit' };
  const item = { id: newId(rand, now), emoji, label };
  return { ok: true, list: [...list, item], item };
}

/** Edits a custom item's text (and, for a mood, its colour). An empty label is refused. */
export function editCustom<T extends { id: string; label: string }>(list: T[], id: string, patch: Partial<Omit<T, 'id'>>): T[] | null {
  const label = typeof patch.label === 'string' ? normalizeLabel(patch.label) : undefined;
  if (label === '') return null;
  return list.map((x) => (x.id === id ? { ...x, ...patch, ...(label !== undefined ? { label } : {}) } : x));
}

export const removeCustom = <T extends { id: string }>(list: T[], id: string): T[] => list.filter((x) => x.id !== id);

/** Saves an edited built-in label; an empty or unchanged text removes the override (= the default again). */
export function setLabelOverride(labels: StatusLabels, key: string, text: string, defaultLabel: string): StatusLabels {
  const next = { ...labels };
  const value = normalizeLabel(text);
  if (value === '' || value === defaultLabel) delete next[key];
  else next[key] = value;
  return next;
}

export const moodKey = (id: string) => `m:${id}`;
export const activityKey = (id: string) => `a:${id}`;

export function resolveMoods(custom: CustomMood[], labels: StatusLabels, t: Translate): MoodItem[] {
  const built = MOODS.map((m): MoodItem => {
    const edited = labels[moodKey(m.id)];
    return { id: m.id, emoji: m.emoji, category: m.category, label: edited || t(m.name), custom: false, edited: !!edited };
  });
  return [...built, ...custom.map((c): MoodItem => ({ id: c.id, emoji: c.emoji, category: 'custom', label: c.label, custom: true, edited: false, preset: c.preset }))];
}

export function resolveActivities(custom: CustomActivity[], labels: StatusLabels, t: Translate): ActivityItem[] {
  const built = ACTIVITIES.map((a): ActivityItem => {
    const edited = labels[activityKey(a.id)];
    return { id: a.id, emoji: a.emoji, category: a.category, label: edited || t(a.name), custom: false, edited: !!edited };
  });
  return [...built, ...custom.map((c): ActivityItem => ({ id: c.id, emoji: c.emoji, category: 'custom', label: c.label, custom: true, edited: false }))];
}

export const findMood = (items: MoodItem[], emoji: string | null | undefined): MoodItem | undefined => (emoji ? items.find((m) => m.emoji === emoji) : undefined);
export const findActivity = (items: ActivityItem[], id: string | null | undefined): ActivityItem | undefined => (id ? items.find((a) => a.id === id) : undefined);

/**
 * The text of the mood message, i.e. what the partner reads as sent: my wording of the mood when it is my own or an edited one
 * (otherwise their phone shows its own name for the emoji), then the activity as "emoji label". Empty = nothing extra.
 */
export function statusText(mood: MoodItem | undefined, activity: ActivityItem | undefined): string {
  const parts: string[] = [];
  if (mood && (mood.custom || mood.edited)) parts.push(mood.label);
  if (activity) parts.push(`${activity.emoji} ${activity.label}`);
  return parts.join(' · ');
}
