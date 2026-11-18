import type { TranslationKey } from '@/src/i18n';

/**
 * The 7 event icons of the New Event sheet (reference 15): heart, cake, party, plane, glass, briefcase, dumbbell.
 * `mci` is the glyph name in `MaterialCommunityIcons` from `@expo/vector-icons` (already a dependency; one family keeps the strokes uniform —
 * Feather has no cake/party/dumbbell and Ionicons has no cake). A saved event stores the icon `id`; the UI maps it to a glyph.
 */
export type EventIconId = 'heart' | 'cake' | 'party' | 'plane' | 'glass' | 'briefcase' | 'dumbbell';
export type EventIcon = { id: EventIconId; mci: string; label: TranslationKey };

export const EVENT_ICONS: EventIcon[] = [
  { id: 'heart', mci: 'heart', label: 'eventIcon_heart' },
  { id: 'cake', mci: 'cake-variant', label: 'eventIcon_cake' },
  { id: 'party', mci: 'party-popper', label: 'eventIcon_party' },
  { id: 'plane', mci: 'airplane', label: 'eventIcon_plane' },
  { id: 'glass', mci: 'glass-cocktail', label: 'eventIcon_glass' },
  { id: 'briefcase', mci: 'briefcase', label: 'eventIcon_briefcase' },
  { id: 'dumbbell', mci: 'dumbbell', label: 'eventIcon_dumbbell' },
];

export const DEFAULT_EVENT_ICON: EventIconId = 'heart';

/** The icon for a saved id, or undefined for null / an id this version does not know. */
export function eventIconById(id: string | null | undefined): EventIcon | undefined {
  return id ? EVENT_ICONS.find((i) => i.id === id) : undefined;
}

/** What to store: the id when it is one of the 7, else null (unknown ids never reach the database). */
export function normalizeEventIcon(id: string | null | undefined): EventIconId | null {
  return eventIconById(id)?.id ?? null;
}

/** What to draw: the saved icon, or the heart when the event has none. */
export function eventIconOrDefault(id: string | null | undefined): EventIcon {
  return eventIconById(id) ?? (EVENT_ICONS[0] as EventIcon);
}
