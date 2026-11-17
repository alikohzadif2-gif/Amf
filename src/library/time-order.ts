import { calendarYearMonth, type CalendarKind } from '@/src/lib/calendar';
import { archiveDate, compareEntries, hasRealDate, type LibraryEntry, type SortMode } from './merge';

/** Q8a: the Archive "Time" tool. Filters (today … year) show newest first; newest/oldest only sort; all = by name. */
export type TimeOrder = 'all' | 'today' | 'week' | 'month' | 'year' | 'newest' | 'oldest';

export const TIME_ORDERS: readonly TimeOrder[] = ['all', 'today', 'week', 'month', 'year', 'newest', 'oldest'];
export const DEFAULT_TIME_ORDER: TimeOrder = 'all';

export function isTimeOrder(value: unknown): value is TimeOrder {
  return typeof value === 'string' && (TIME_ORDERS as readonly string[]).includes(value);
}

const DAY_MS = 86_400_000;

export function timeSortMode(order: TimeOrder): SortMode {
  return order === 'all' ? 'name' : order === 'oldest' ? 'oldest' : 'newest';
}

/**
 * Does this ISO date fall in the period? Days are the phone's local days (not UTC), so a photo taken at 01:00 in Iran
 * is "today". today = this local day; week = the last 7 days; month = the last 31 days (so it is never empty on the first
 * day of a calendar month); year follows the app calendar. `offsetMinutes` = local time minus UTC (tests pass it).
 */
export function inTimeOrder(
  iso: string,
  order: TimeOrder,
  now: Date,
  kind: CalendarKind,
  offsetMinutes: number = -now.getTimezoneOffset(),
): boolean {
  if (order === 'all' || order === 'newest' || order === 'oldest') return true;
  if (!hasRealDate(iso)) return false;
  const ms = Date.parse(iso);
  const shift = offsetMinutes * 60_000;
  const localNow = now.getTime() + shift;
  const dayStart = localNow - (((localNow % DAY_MS) + DAY_MS) % DAY_MS) - shift; // local midnight as a UTC instant
  if (order === 'today') return ms >= dayStart && ms < dayStart + DAY_MS;
  if (order === 'week') return ms >= dayStart - 6 * DAY_MS && ms < dayStart + DAY_MS;
  if (order === 'month') return ms >= dayStart - 30 * DAY_MS && ms < dayStart + DAY_MS;
  const a = calendarYearMonth(new Date(ms + shift).toISOString(), kind);
  const b = calendarYearMonth(new Date(localNow).toISOString(), kind);
  return a.year === b.year;
}

/** Folders are never filtered; files are filtered by their archive date and sorted. */
export function applyTimeOrder(
  entries: readonly LibraryEntry[],
  order: TimeOrder,
  overrides: Record<string, { date: string | null }> | undefined,
  kind: CalendarKind,
  now: Date = new Date(),
  offsetMinutes: number = -now.getTimezoneOffset(),
): LibraryEntry[] {
  const mode = timeSortMode(order);
  return entries
    .filter((e) => e.item.type === 'dir' || inTimeOrder(archiveDate(e, overrides), order, now, kind, offsetMinutes))
    .sort((a, b) => compareEntries(a, b, mode, overrides));
}
