/** Pure helpers of the Home screen (no React Native imports; tested in scripts/test-home.mjs). */
import { addDays, daysBetween, isoIn, monthLengthIn, occurrencesBetween, partsIn, weekRange, type EventCal, type EventLike } from '@/src/events/recurrence';
import type { TranslationKey } from '@/src/i18n';
import type { WeekStart } from '@/src/state/settings-store';

export type WeekItem<T extends EventLike> = { event: T; date: string; days: number };

/**
 * Every occurrence of every event inside the week that contains `today` (first weekday from Settings), oldest first.
 * A yearly event gives one row in its week; a one-off event gives one row on its date. `days` = days from today (negative = already passed this week).
 */
export function weekItems<T extends EventLike>(events: T[], today: string, weekStart: WeekStart): WeekItem<T>[] {
  const { start, end } = weekRange(today, weekStart);
  return events
    .flatMap((event) => occurrencesBetween(event, start, end).map((date) => ({ event, date, days: daysBetween(today, date) })))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The seven day strings of the current week (used by tests and for the range label). */
export function weekDays(today: string, weekStart: WeekStart): string[] {
  const { start } = weekRange(today, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Whole days together (0 on the day itself, never negative). One formula for the Home card and the widget. */
export function daysTogether(since: string, today: string): number {
  return Math.max(daysBetween(since, today), 0);
}

export type TogetherParts = { years: number; months: number; days: number };

/**
 * "5 years 3 months 2 days": the time between `since` and `today` counted in the calendar the person uses (Jalali months are
 * not Gregorian ones). Whole months are counted first (a start day that the month lacks, such as the 31st, becomes the
 * month's last day), then the days left; a future date gives zeros.
 */
export function togetherParts(since: string, today: string, cal: EventCal): TogetherParts {
  if (daysBetween(since, today) <= 0) return { years: 0, months: 0, days: 0 };
  const a = partsIn(cal, since);
  const b = partsIn(cal, today);
  const anchor = (n: number) => {
    const index = a.m - 1 + n;
    const y = a.y + Math.floor(index / 12);
    const m = (index % 12) + 1;
    return isoIn(cal, y, m, Math.min(a.d, monthLengthIn(cal, y, m)));
  };
  let total = (b.y - a.y) * 12 + (b.m - a.m);
  if (daysBetween(anchor(total), today) < 0) total -= 1;
  return { years: Math.floor(total / 12), months: total % 12, days: daysBetween(anchor(total), today) };
}

/** Pure text of the together card: `2 years 1 month 5 days` / `۲ سال و ۱ ماه و ۵ روز` (parts at zero are omitted; all zero = `0 days`). */
export function togetherLabel(parts: TogetherParts, t: (key: TranslationKey) => string, num: (n: number) => string, join = ' '): string {
  const unit = (n: number, one: TranslationKey, many: TranslationKey) => `${num(n)} ${t(n === 1 ? one : many)}`;
  const out = [
    parts.years > 0 ? unit(parts.years, 'unitYear', 'unitYears') : '',
    parts.months > 0 ? unit(parts.months, 'unitMonth', 'unitMonths') : '',
    parts.days > 0 || (parts.years === 0 && parts.months === 0) ? unit(parts.days, 'unitDay', 'unitDays') : '',
  ].filter(Boolean);
  return out.join(join);
}

/** Greeting-like plain title (Q1: no dropdown) is a translation key; the Connect card is shown only while nobody is paired. */
export function showConnectCard(partnerFeature: boolean, paired: boolean): 'shell' | 'pair' | 'hidden' {
  if (partnerFeature && paired) return 'hidden';
  return partnerFeature ? 'pair' : 'shell';
}

export type AgoUnit = 'now' | 'minutes' | 'hours' | 'days' | 'date';

/** How long ago `ts` was, for the partner's mood card: under a minute = now, then minutes, hours, days (up to 6), then a plain date. A future `ts` counts as now. */
export function timeAgo(ts: string, nowMs: number): { unit: AgoUnit; n: number } {
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return { unit: 'date', n: 0 };
  const minutes = Math.floor((nowMs - then) / 60000);
  if (minutes < 1) return { unit: 'now', n: 0 };
  if (minutes < 60) return { unit: 'minutes', n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', n: hours };
  const days = Math.floor(hours / 24);
  return days < 7 ? { unit: 'days', n: days } : { unit: 'date', n: 0 };
}

/**
 * Milliseconds until the label of `timeAgo(ts, ...)` can change next: the minute, hour and day boundaries all fall on the
 * minute marks of `ts`, so the label is refreshed exactly when it becomes "6 minutes ago" (never later than 60 s, never under 1 s).
 */
export function msUntilAgoChanges(ts: string, nowMs: number): number {
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return 60000;
  const into = (((nowMs - then) % 60000) + 60000) % 60000;
  return Math.max(1000, 60000 - into);
}
