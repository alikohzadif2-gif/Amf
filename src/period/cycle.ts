/**
 * R5a: cycle maths. Plain arithmetic on UTC Gregorian days ("YYYY-MM-DD"), no library.
 *
 * Model (the one every tracker app and calculator documents; Maven Clinic, Clue-style calculators, open-source trackers):
 * - cycle length = days from the first day of one period to the first day of the next; the prediction uses the average of
 *   the last cycles (default 28 with no history);
 * - next period = last start + average length;
 * - ovulation = next period - luteal phase (14 days); fertile window = 5 days before ovulation through 1 day after;
 * - PMS = the last days before the next period;
 * - cycles are "irregular" when they differ by more than 7 days or the average is under 21 / over 35 (Maven's rule).
 * Estimates only: nothing here is medical advice.
 */

export const DEFAULT_CYCLE_DAYS = 28;
export const DEFAULT_PERIOD_DAYS = 5;
export const LUTEAL_DAYS = 14;
export const FERTILE_BEFORE = 5;
export const FERTILE_AFTER = 1;
export const PMS_DAYS = 5;
/** A gap outside this range is a missed log or a typo, not a cycle: it never enters the average. */
export const MIN_CYCLE_DAYS = 15;
export const MAX_CYCLE_DAYS = 60;
/** How many of the latest cycles the average uses. */
export const AVERAGE_OF = 6;
/** Two "started" logs closer than this are one period logged twice. */
export const MIN_BETWEEN_STARTS = 8;

export type CyclePhase = 'period' | 'follicular' | 'fertile' | 'ovulation' | 'luteal' | 'pms' | 'late';

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day of any ISO timestamp or day string, or null when it is not a date. */
export function toDay(value: string): string | null {
  const t = DAY_RE.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Sorted, de-duplicated first days of periods (a start within `MIN_BETWEEN_STARTS` of the previous one is dropped). */
export function cycleStarts(days: readonly string[]): string[] {
  const sorted = [...new Set(days)].sort();
  const out: string[] = [];
  for (const d of sorted) if (out.length === 0 || dayDiff(out[out.length - 1], d) >= MIN_BETWEEN_STARTS) out.push(d);
  return out;
}

/** Lengths of the finished cycles, oldest first; implausible gaps are left out. */
export function cycleLengths(starts: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const n = dayDiff(starts[i - 1], starts[i]);
    if (n >= MIN_CYCLE_DAYS && n <= MAX_CYCLE_DAYS) out.push(n);
  }
  return out;
}

export type CycleStats = { length: number; basis: 'default' | 'history' | 'custom'; cycles: number; regular: boolean };

/** Q7: a cycle length the owner may set (15-60 whole days). */
export const validCycleDays = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= MIN_CYCLE_DAYS && n <= MAX_CYCLE_DAYS;

/** Q7: a start day may be any day up to today, never a future one (both "YYYY-MM-DD"). */
export const isValidStartDay = (day: string, today: string): boolean => DAY_RE.test(day) && toDay(day) === day && day <= today;

/** `custom` = the cycle length set by the owner (Q7); when valid it is used instead of the estimate. */
export function cycleStats(starts: readonly string[], custom?: number | null): CycleStats {
  const lengths = cycleLengths(starts).slice(-AVERAGE_OF);
  if (validCycleDays(custom)) return { length: custom, basis: 'custom', cycles: lengths.length, regular: true };
  if (lengths.length === 0) return { length: DEFAULT_CYCLE_DAYS, basis: 'default', cycles: 0, regular: true };
  const length = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const spread = Math.max(...lengths) - Math.min(...lengths);
  return { length, basis: 'history', cycles: lengths.length, regular: spread <= 7 && length >= 21 && length <= 35 };
}

export type Prediction = CycleStats & {
  lastStart: string;
  nextStart: string;
  /** Predicted ovulation day and fertile window of the cycle that starts at `lastStart`. */
  ovulation: string;
  fertileFrom: string;
  fertileTo: string;
};

/** The next period and the fertile window from the logged starts; null when no period was logged yet. */
export function predict(days: readonly string[], custom?: number | null): Prediction | null {
  const starts = cycleStarts(days);
  if (starts.length === 0) return null;
  const stats = cycleStats(starts, custom);
  const lastStart = starts[starts.length - 1];
  const ovOffset = stats.length - LUTEAL_DAYS;
  return {
    ...stats,
    lastStart,
    nextStart: addDays(lastStart, stats.length),
    ovulation: addDays(lastStart, ovOffset),
    fertileFrom: addDays(lastStart, ovOffset - FERTILE_BEFORE),
    fertileTo: addDays(lastStart, ovOffset + FERTILE_AFTER),
  };
}

export type DayInfo = {
  phase: CyclePhase;
  /** 1 = first day of the period. In a `late` cycle it keeps counting past `cycleLength`. */
  dayOfCycle: number;
  cycleLength: number;
  periodLength: number;
  start: string;
  nextStart: string;
  daysUntilNext: number;
  regular: boolean;
};

/**
 * Where a day sits in its cycle. Uses the real length when the next period was logged, the predicted one otherwise.
 * `late` = the predicted next period has not been logged yet. Null before the first logged period.
 */
export function phaseForDay(days: readonly string[], day: string, custom?: number | null): DayInfo | null {
  const starts = cycleStarts(days);
  const start = [...starts].reverse().find((s) => s <= day);
  if (!start) return null;
  const stats = cycleStats(starts, custom);
  const next = starts.find((s) => s > start);
  const cycleLength = next ? dayDiff(start, next) : stats.length;
  const nextStart = next ?? addDays(start, cycleLength);
  const offset = dayDiff(start, day); // 0-based
  const periodLength = Math.min(DEFAULT_PERIOD_DAYS, cycleLength - 1);
  const ov = cycleLength - LUTEAL_DAYS;
  let phase: CyclePhase;
  if (!next && offset >= cycleLength) phase = 'late';
  else if (offset < periodLength) phase = 'period';
  else if (offset === ov) phase = 'ovulation';
  else if (offset >= ov - FERTILE_BEFORE && offset <= ov + FERTILE_AFTER) phase = 'fertile';
  else if (offset >= cycleLength - PMS_DAYS) phase = 'pms';
  else phase = offset < ov ? 'follicular' : 'luteal';
  return { phase, dayOfCycle: offset + 1, cycleLength, periodLength, start, nextStart, daysUntilNext: dayDiff(day, nextStart), regular: stats.regular };
}
