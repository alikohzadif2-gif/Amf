/** Small date helpers for the memory date picker (moved out of the removed backup code). */

const pad = (n: number) => String(n).padStart(2, '0');

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
