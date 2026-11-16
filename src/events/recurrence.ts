import { jalaaliMonthLength, toGregorian, toJalaali } from 'jalaali-js';
import type { WeekStart } from '@/src/state/settings-store';

/** Event dates are UTC ISO strings at 00:00 (Gregorian). The calendar only decides how a yearly repeat is computed. */
export type EventCal = 'jalali' | 'gregorian';
export type EventLike = { date: string; repeat: 'yearly' | null; cal: EventCal };

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}T00:00:00.000Z`;

/** Normalises any ISO string to its UTC day (midnight). */
export function dayIso(iso: string): string {
  const d = new Date(iso);
  return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Today (phone's local calendar day) as a UTC-midnight ISO date. */
export function todayIso(now: Date = new Date()): string {
  return isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(dayIso(toIso)) - Date.parse(dayIso(fromIso))) / DAY);
}

export function addDays(iso: string, n: number): string {
  return dayIso(new Date(Date.parse(dayIso(iso)) + n * DAY).toISOString());
}

type Parts = { y: number; m: number; d: number };

export function partsIn(cal: EventCal, iso: string): Parts {
  const g = new Date(iso);
  const y = g.getUTCFullYear();
  const m = g.getUTCMonth() + 1;
  const d = g.getUTCDate();
  if (cal === 'gregorian') return { y, m, d };
  const j = toJalaali(y, m, d);
  return { y: j.jy, m: j.jm, d: j.jd };
}

export function monthLengthIn(cal: EventCal, y: number, m: number): number {
  return cal === 'jalali' ? jalaaliMonthLength(y, m) : new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Calendar date -> UTC ISO. A day past the end of the month becomes the last day of that month. */
export function isoIn(cal: EventCal, y: number, m: number, d: number): string {
  const day = Math.min(d, monthLengthIn(cal, y, m));
  if (cal === 'gregorian') return isoOf(y, m, day);
  const g = toGregorian(y, m, day);
  return isoOf(g.gy, g.gm, g.gd);
}

/** Where a yearly event falls in a given calendar year (30 Esfand -> 29 Esfand in a common year). */
export function occurrenceInYear(e: EventLike, year: number): string {
  const p = partsIn(e.cal, e.date);
  return isoIn(e.cal, year, p.m, p.d);
}

/** First occurrence on or after `today`; null for a one-off event that is already past. */
export function nextOccurrence(e: EventLike, today: string): string | null {
  const t = dayIso(today);
  const date = dayIso(e.date);
  if (e.repeat !== 'yearly') return date >= t ? date : null;
  if (date >= t) return date;
  const year = partsIn(e.cal, t).y;
  const this_ = occurrenceInYear(e, year);
  return this_ >= t ? this_ : occurrenceInYear(e, year + 1);
}

/** Every occurrence inside [start, end] (inclusive). A yearly event never occurs before its first date. */
export function occurrencesBetween(e: EventLike, start: string, end: string): string[] {
  const s = dayIso(start);
  const en = dayIso(end);
  const first = dayIso(e.date);
  if (e.repeat !== 'yearly') return first >= s && first <= en ? [first] : [];
  const out: string[] = [];
  for (let y = partsIn(e.cal, s).y; y <= partsIn(e.cal, en).y; y += 1) {
    const o = occurrenceInYear(e, y);
    if (o >= first && o >= s && o <= en) out.push(o);
  }
  return out;
}

export type Countdown = { date: string; days: number };
export function countdown(e: EventLike, today: string): Countdown | null {
  const date = nextOccurrence(e, today);
  return date ? { date, days: daysBetween(today, date) } : null;
}

export function monthRange(cal: EventCal, year: number, month: number): { start: string; end: string } {
  return { start: isoIn(cal, year, month, 1), end: isoIn(cal, year, month, 31) };
}

const WEEK_START: Record<WeekStart, number> = { sun: 0, mon: 1, sat: 6 };
/** The 7-day week containing `today`, starting on the chosen first weekday. */
export function weekRange(today: string, weekStart: WeekStart): { start: string; end: string } {
  const wd = new Date(dayIso(today)).getUTCDay();
  const back = (wd - WEEK_START[weekStart] + 7) % 7;
  const start = addDays(today, -back);
  return { start, end: addDays(start, 6) };
}

/** Same month and day as `today` in the calendar, in an earlier year ("on this day"). */
export function isOnThisDay(iso: string, today: string, cal: EventCal): boolean {
  const a = partsIn(cal, iso);
  const b = partsIn(cal, today);
  return a.m === b.m && a.d === b.d && a.y < b.y;
}

/** Whole years between an earlier date and today in the calendar (for "3 years ago"). */
export function yearsAgo(iso: string, today: string, cal: EventCal): number {
  return partsIn(cal, today).y - partsIn(cal, iso).y;
}
