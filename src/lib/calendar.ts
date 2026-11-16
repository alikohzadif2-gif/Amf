import {
  isValidJalaaliDate,
  jalaaliMonthLength,
  toGregorian,
  toJalaali,
} from 'jalaali-js';
import {
  getDictionary,
  type TranslationKey,
} from '@/src/i18n';
import type {
  CalendarMode,
  DigitMode,
  Language,
  WeekStart,
} from '@/src/state/settings-store';

export type CalendarKind = Exclude<CalendarMode, 'both'>;

export type MonthCell = {
  day: number | null;
  isoDate: string | null;
  isCurrentMonth: boolean;
};

const WEEK_START_INDEX: Record<WeekStart, number> = {
  sun: 0,
  mon: 1,
  sat: 6,
};

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toDigits(value: string | number, mode: DigitMode): string {
  const text = String(value);
  if (mode === 'latin') return text;
  return text.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

export function toGregorianIsoDate(
  jalaliYear: number,
  jalaliMonth: number,
  jalaliDay: number,
): string {
  if (!isValidJalaaliDate(jalaliYear, jalaliMonth, jalaliDay)) {
    throw new RangeError('Invalid Jalali date.');
  }

  const { gy, gm, gd } = toGregorian(
    jalaliYear,
    jalaliMonth,
    jalaliDay,
  );
  return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}T00:00:00.000Z`;
}

function gregorianParts(isoDate: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid UTC ISO date.');
  }

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function monthLength(kind: CalendarKind, year: number, month: number): number {
  if (kind === 'jalali') return jalaaliMonthLength(year, month);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function firstWeekday(kind: CalendarKind, year: number, month: number): number {
  const isoDate =
    kind === 'jalali'
      ? toGregorianIsoDate(year, month, 1)
      : `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
  return new Date(isoDate).getUTCDay();
}

export function buildMonthGrid(
  kind: CalendarKind,
  year: number,
  month: number,
  weekStart: WeekStart,
): MonthCell[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('Month must be an integer from 1 through 12.');
  }

  const daysInMonth = monthLength(kind, year, month);
  const offset =
    (firstWeekday(kind, year, month) - WEEK_START_INDEX[weekStart] + 7) % 7;
  const cells: MonthCell[] = Array.from(
    { length: offset },
    () => ({ day: null, isoDate: null, isCurrentMonth: false }),
  );

  for (let day = 1; day <= daysInMonth; day += 1) {
    const isoDate =
      kind === 'jalali'
        ? toGregorianIsoDate(year, month, day)
        : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
    cells.push({ day, isoDate, isCurrentMonth: true });
  }

  while (cells.length < 42) {
    cells.push({ day: null, isoDate: null, isCurrentMonth: false });
  }

  return cells;
}

function formatOne(
  kind: CalendarKind,
  isoDate: string,
  language: Language,
  digits: DigitMode,
): string {
  const { year, month, day } = gregorianParts(isoDate);
  const calendarDate =
    kind === 'jalali'
      ? toJalaali(year, month, day)
      : { jy: year, jm: month, jd: day };
  const monthNames = getDictionary(language).monthNames;
  const monthOffset =
    language === 'fa'
      ? kind === 'jalali'
        ? 0
        : 12
      : kind === 'jalali'
        ? 12
        : 0;
  const monthName = monthNames[calendarDate.jm - 1 + monthOffset];

  return `${toDigits(calendarDate.jd, digits)} ${monthName} ${toDigits(calendarDate.jy, digits)}`;
}

export function formatDate(
  isoDate: string,
  mode: CalendarMode,
  language: Language,
  digits: DigitMode,
): string {
  if (mode === 'jalali') {
    return formatOne('jalali', isoDate, language, digits);
  }
  if (mode === 'gregorian') {
    return formatOne('gregorian', isoDate, language, digits);
  }
  return `${formatOne('jalali', isoDate, language, digits)} / ${formatOne('gregorian', isoDate, language, digits)}`;
}

export function getWeekdayLabels(
  language: Language,
  weekStart: WeekStart,
): string[] {
  const labels = getDictionary(language).weekdays;
  const start = WEEK_START_INDEX[weekStart];
  return Array.from({ length: 7 }, (_, index) => labels[(start + index) % 7]);
}

export function calendarModeLabelKey(mode: CalendarMode): TranslationKey {
  return mode;
}

/** Year and month of a UTC ISO date in the given calendar (used for auto albums). */
export function calendarYearMonth(
  isoDate: string,
  kind: CalendarKind,
): { year: number; month: number } {
  const { year, month, day } = gregorianParts(isoDate);
  if (kind === 'gregorian') return { year, month };
  const j = toJalaali(year, month, day);
  return { year: j.jy, month: j.jm };
}

/** Month name in the chosen calendar and language ("Farvardin", "March"...). */
export function calendarMonthName(
  kind: CalendarKind,
  month: number,
  language: Language,
): string {
  const names = getDictionary(language).monthNames;
  const offset = language === 'fa' ? (kind === 'jalali' ? 0 : 12) : kind === 'jalali' ? 12 : 0;
  return names[month - 1 + offset];
}
