import { toJalaali } from 'jalaali-js';

/** Pure helpers for the server folder of a backed-up entry: `<Jalali year>/<MM>/<DD>` (for example `1405/07/29`). */

const pad = (n: number) => String(n).padStart(2, '0');

export const UNDATED_FOLDER = 'undated';

function fromGregorian(y: number, m: number, d: number): string {
  const j = toJalaali(y, m, d);
  return `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`;
}

/** Day folder of a moment as the phone's calendar shows it (the phone's time zone). Memories and files. */
export function dayFolderLocal(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return UNDATED_FOLDER;
  return fromGregorian(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Day folder of a stored calendar day (a UTC ISO date such as an event's date or a picked day). */
export function dayFolderUtc(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return UNDATED_FOLDER;
  return fromGregorian(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `20261019-141530` (UTC) from an ISO time: makes every version of a record a new file name (the server never overwrites). */
export function versionStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '00000000-000000';
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** The date a memory is created on when the person picks a day: that day at local noon (so no time zone moves it to another day). */
export function memoryDateFromDay(day: string, now: Date = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() <= now.getTime()) return at.toISOString();
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? now.toISOString() : null; // today keeps the real time; a later day is refused
}

/** `YYYY-MM-DD` of a moment as the phone's calendar shows it (the day a date picker should start on). */
export function localDayString(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
