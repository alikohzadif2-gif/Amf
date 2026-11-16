import { addDays, dayIso, isoIn, monthRange, partsIn, todayIso, weekRange, type EventCal } from '@/src/events/recurrence';
import type { CalendarMode, Language, WeekStart } from '@/src/state/settings-store';

export type DiaryDatePreset = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom';
export type DiaryDateFilter = { preset: DiaryDatePreset; from?: string; to?: string };
export type DayRange = { from: string; to: string };

/** The calendar a preset counts in: the chosen one, and for "both" the language's own (Jalali for fa). */
export function presetCalendar(mode: CalendarMode, language: Language): EventCal {
  if (mode === 'gregorian') return 'gregorian';
  if (mode === 'jalali') return 'jalali';
  return language === 'fa' ? 'jalali' : 'gregorian';
}

/** UTC day ("YYYY-MM-DD") of an ISO timestamp. */
export const dayKey = (iso: string): string => dayIso(iso).slice(0, 10);

/** Inclusive day range of a filter, or null for "all time". Week/month/year follow `cal` and the first weekday setting. */
export function resolveDateRange(
  filter: DiaryDateFilter,
  cal: EventCal,
  weekStart: WeekStart,
  today: string = todayIso(),
): DayRange | null {
  switch (filter.preset) {
    case 'today':
      return { from: dayKey(today), to: dayKey(today) };
    case 'week': {
      const w = weekRange(today, weekStart);
      return { from: dayKey(w.start), to: dayKey(w.end) };
    }
    case 'month': {
      const p = partsIn(cal, today);
      const m = monthRange(cal, p.y, p.m);
      return { from: dayKey(m.start), to: dayKey(m.end) };
    }
    case 'year': {
      const y = partsIn(cal, today).y;
      return { from: dayKey(isoIn(cal, y, 1, 1)), to: dayKey(isoIn(cal, y, 12, 31)) };
    }
    case 'custom': {
      if (!filter.from || !filter.to) return null;
      const a = dayKey(filter.from);
      const b = dayKey(filter.to);
      return a <= b ? { from: a, to: b } : { from: b, to: a };
    }
    default:
      return null;
  }
}

/** Default end of a custom range when the person has not picked yet: the last 7 days. */
export function defaultCustomRange(today: string = todayIso()): { from: string; to: string } {
  return { from: addDays(today, -6), to: today };
}

/** Q9: overlap of two inclusive day ranges (null = unbounded). A disjoint pair gives an empty range (`from` > `to`). */
export function intersectDayRanges(a: DayRange | null, b: DayRange | null): DayRange | null {
  if (!a) return b;
  if (!b) return a;
  return { from: a.from > b.from ? a.from : b.from, to: a.to < b.to ? a.to : b.to };
}
