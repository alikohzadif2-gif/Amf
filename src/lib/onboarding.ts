/** Pure helpers of the onboarding steps (no React Native imports; tested in scripts/test-onboarding.mjs). */
import { jalaaliMonthLength } from 'jalaali-js';
import type { CalendarKind } from '@/src/lib/calendar';
import { isoToParts, partsToIso, type DateParts } from '@/src/partner/birthday';

export type OnboardingStep = 'name' | 'gender' | 'birthday' | 'photo';

/** Order of the steps; each one is a screen under `app/onboarding/`. */
export const ONBOARDING_STEPS: OnboardingStep[] = ['name', 'gender', 'birthday', 'photo'];

/**
 * Progress bar value while a step is open: name 20 %, gender 40 %, birthday 60 %, photo 80 % (the references show about 15 / 43 / 72 %;
 * the bar never starts empty and never looks finished before the last tap).
 */
export function stepProgress(step: OnboardingStep): number {
  return (ONBOARDING_STEPS.indexOf(step) + 1) / (ONBOARDING_STEPS.length + 1);
}

/** The step before `step`, or null for the first one (then Back returns to the welcome screen). */
export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const i = ONBOARDING_STEPS.indexOf(step);
  return i > 0 ? ONBOARDING_STEPS[i - 1] : null;
}

export const NAME_MAX = 40;

/** Name as it will be saved: trimmed, inner whitespace collapsed, capped. Empty string = not valid. */
export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
export const isValidName = (raw: string): boolean => cleanName(raw).length > 0;

/** Days in a month of the chosen calendar (Jalali months 1–6 = 31, 7–11 = 30, 12 = 29 or 30). */
export function daysInMonth(kind: CalendarKind, year: number, month: number): number {
  if (kind === 'jalali') return jalaaliMonthLength(year, month);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Year list of the birthday wheel, oldest first (110 years back, the current year last). */
export function birthdayYears(kind: CalendarKind, now: Date): number[] {
  const current = isoToParts(kind, now.toISOString())?.year ?? now.getUTCFullYear();
  return Array.from({ length: 111 }, (_, i) => current - 110 + i);
}

/** Keeps a day inside the month (31 Esfand 1399 -> 30, 31 Feb -> 28/29). */
export function clampDay(kind: CalendarKind, p: DateParts): DateParts {
  return { ...p, day: Math.min(Math.max(1, p.day), daysInMonth(kind, p.year, p.month)) };
}

/** Where the wheel starts when there is no saved birthday: 25 years ago, first day of the first month. */
export function defaultBirthdayParts(kind: CalendarKind, now: Date): DateParts {
  const current = isoToParts(kind, now.toISOString())?.year ?? now.getUTCFullYear();
  return { year: current - 25, month: 1, day: 1 };
}

/** Same day shown in the other calendar (Gregorian <-> Jalali) when the segmented control is switched. */
export function convertParts(from: CalendarKind, to: CalendarKind, p: DateParts): DateParts {
  if (from === to) return p;
  const iso = partsToIso(from, p);
  return (iso && isoToParts(to, iso)) || p;
}

/** Wheel selection -> UTC ISO birthday (brief rule 4), or null when it is invalid or lies in the future. */
export function birthdayToIso(kind: CalendarKind, p: DateParts, now: Date): string | null {
  const iso = partsToIso(kind, p);
  if (!iso) return null;
  return new Date(iso).getTime() > now.getTime() ? null : iso;
}

/** Whole years between a UTC ISO birthday and `now` (age), never negative. */
export function ageOn(iso: string, now: Date): number {
  const b = new Date(iso);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return Math.max(0, age);
}
