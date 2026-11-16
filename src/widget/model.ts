import { todayIso } from '@/src/events/recurrence';
import { daysTogether } from '@/src/lib/home';
import { getDictionary } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { settingsDefaults, type SettingsValues } from '@/src/state/settings-store';

/** What the "days together" widget shows. Pure: the same number as the Home card. */
export type WidgetModel = {
  title: string;
  /** Already in the chosen digits; null until the "together since" date is set. */
  days: string | null;
  /** "Since <date>" when set, else the hint to set the date. */
  line: string;
  accent: SettingsValues['accent'];
};

export function buildModel(
  partner: { togetherSince?: string } | null,
  settings: Partial<SettingsValues> | null,
  now: Date = new Date(),
): WidgetModel {
  const s = { ...settingsDefaults, ...settings };
  const dict = getDictionary(s.language);
  const since = partner?.togetherSince;
  if (!since || Number.isNaN(Date.parse(since))) {
    return { title: dict.homeDaysTogether, days: null, line: dict.homeSetTogether, accent: s.accent };
  }
  const days = daysTogether(since, todayIso(now));
  return {
    title: dict.homeDaysTogether,
    days: toDigits(days, s.digits),
    line: `${dict.homeTogetherSince} ${formatDate(since, s.calendarMode, s.language, s.digits)}`,
    accent: s.accent,
  };
}
