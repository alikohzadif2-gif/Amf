import { isValidJalaaliDate, toGregorian, toJalaali } from 'jalaali-js';
import type { CalendarKind } from '@/src/lib/calendar';

export type DateParts = { year: number; month: number; day: number };

/** Year/month/day typed in the chosen calendar -> UTC ISO Gregorian date, or null when invalid (brief rule 4). */
export function partsToIso(kind: CalendarKind, p: DateParts): string | null {
  const { year, month, day } = p;
  if (![year, month, day].every(Number.isInteger)) return null;
  let g = { gy: year, gm: month, gd: day };
  if (kind === 'jalali') {
    if (!isValidJalaaliDate(year, month, day)) return null;
    g = toGregorian(year, month, day);
  } else {
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (year < 1000 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(g.gy).padStart(4, '0')}-${pad(g.gm)}-${pad(g.gd)}T00:00:00.000Z`;
}

export function isoToParts(kind: CalendarKind, iso: string): DateParts | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  if (kind === 'gregorian') return { year: y, month: m, day };
  const j = toJalaali(y, m, day);
  return { year: j.jy, month: j.jm, day: j.jd };
}

/** Reads a typed number that may use Persian or Arabic-Indic digits. Empty/invalid -> NaN. */
export function parseTypedInt(text: string): number {
  const latin = text.trim().replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  return /^\d+$/.test(latin) ? Number(latin) : Number.NaN;
}
