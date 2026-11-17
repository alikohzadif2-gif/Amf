import { create } from 'zustand';
import { calendarYearMonth, toGregorianIsoDate, type CalendarKind } from '@/src/lib/calendar';
import { archiveDate, hasRealDate, type LibraryEntry } from './merge';

/** Q8c: Archive "Date range" = first and last month in the app calendar (Jalali or Gregorian). Filtering uses UTC Gregorian instants. */
export type YearMonth = { year: number; month: number };
export type MonthRange = { start: YearMonth; end: YearMonth };

const ord = (v: YearMonth) => v.year * 12 + (v.month - 1);

/** Start before end; a reversed pick is swapped. */
export function normalizeRange(a: YearMonth, b: YearMonth): MonthRange {
  return ord(a) <= ord(b) ? { start: a, end: b } : { start: b, end: a };
}

function monthStartMs(kind: CalendarKind, v: YearMonth): number {
  const iso = kind === 'gregorian'
    ? `${v.year}-${String(v.month).padStart(2, '0')}-01T00:00:00.000Z`
    : toGregorianIsoDate(v.year, v.month, 1);
  return Date.parse(iso);
}

/** [from, to) in UTC ms: the first day of the start month up to the first day after the end month. */
export function rangeToUtc(range: MonthRange, kind: CalendarKind): { from: number; to: number } {
  const next = range.end.month === 12 ? { year: range.end.year + 1, month: 1 } : { year: range.end.year, month: range.end.month + 1 };
  return { from: monthStartMs(kind, range.start), to: monthStartMs(kind, next) };
}

/** The same range as inclusive UTC days ("YYYY-MM-DD"), for the Memories query. */
export function rangeToDays(range: MonthRange, kind: CalendarKind): { from: string; to: string } {
  const { from, to } = rangeToUtc(range, kind);
  return { from: new Date(from).toISOString().slice(0, 10), to: new Date(to - 1).toISOString().slice(0, 10) };
}

export function inDateRange(iso: string, range: MonthRange, kind: CalendarKind): boolean {
  if (!hasRealDate(iso)) return false;
  const { from, to } = rangeToUtc(range, kind);
  const ms = Date.parse(iso);
  return ms >= from && ms < to;
}

/** Folders stay; files outside the range (or without a real date) go. No range = unchanged. */
export function applyDateRange(
  entries: LibraryEntry[],
  range: MonthRange | null,
  overrides: Record<string, { date: string | null }> | undefined,
  kind: CalendarKind,
): LibraryEntry[] {
  if (!range) return entries;
  return entries.filter((e) => e.item.type === 'dir' || inDateRange(archiveDate(e, overrides), range, kind));
}

/** Years offered by the year list: from 1970 (Jalali 1348) to the current year. */
export function yearChoices(kind: CalendarKind, now: Date = new Date()): number[] {
  const first = kind === 'jalali' ? 1348 : 1970;
  const last = calendarYearMonth(now.toISOString(), kind).year;
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}

export function currentYearMonth(kind: CalendarKind, now: Date = new Date()): YearMonth {
  return calendarYearMonth(now.toISOString(), kind);
}

/** Active range of the open Archive (null = none). Reset each time the Archive opens. */
export const useDateRange = create<{ range: MonthRange | null; set: (range: MonthRange | null) => void }>((set) => ({ range: null, set: (range) => set({ range }) }));
