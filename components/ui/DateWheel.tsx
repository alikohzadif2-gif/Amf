import { useMemo } from 'react';
import { WheelPicker } from '@/components/ui/WheelPicker';
import { useI18n } from '@/src/i18n';
import { calendarMonthName, toDigits, type CalendarKind } from '@/src/lib/calendar';
import { birthdayYears, clampDay, daysInMonth } from '@/src/lib/onboarding';
import type { DateParts } from '@/src/partner/birthday';
import { useSettingsStore } from '@/src/state/settings-store';

/** Year / month / day wheels in the chosen calendar (Jalali or Gregorian). Shared by the profile dates and the Period start date (Q7). Years end at the current year. */
export function DateWheel({
  kind,
  parts,
  now,
  onChange,
}: {
  kind: CalendarKind;
  parts: DateParts;
  now: Date;
  onChange: (parts: DateParts) => void;
}) {
  const { language, t } = useI18n();
  const digits = useSettingsStore((state) => state.digits);
  const years = useMemo(() => {
    const options = birthdayYears(kind, now);
    return options.includes(parts.year) ? options : [...options, parts.year].sort((a, b) => a - b);
  }, [kind, now, parts.year]);
  const dayCount = daysInMonth(kind, parts.year, parts.month);

  return (
    <WheelPicker
      columns={[
        {
          key: `year-${kind}`,
          label: t('profileYear'),
          flex: 1.2,
          items: years.map((year) => toDigits(year, digits)),
          index: Math.max(0, years.indexOf(parts.year)),
          onIndexChange: (index) => onChange(clampDay(kind, { ...parts, year: years[index] })),
        },
        {
          key: `month-${kind}`,
          label: t('profileMonth'),
          flex: 1.4,
          items: Array.from({ length: 12 }, (_, index) => calendarMonthName(kind, index + 1, language)),
          index: parts.month - 1,
          onIndexChange: (index) => onChange(clampDay(kind, { ...parts, month: index + 1 })),
        },
        {
          key: `day-${kind}-${dayCount}`,
          label: t('profileDay'),
          flex: 0.8,
          items: Array.from({ length: dayCount }, (_, index) => toDigits(index + 1, digits)),
          index: parts.day - 1,
          onIndexChange: (index) => onChange({ ...parts, day: index + 1 }),
        },
      ]}
    />
  );
}
