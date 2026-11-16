import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { OnboardingFrame } from '@/components/onboarding/OnboardingFrame';
import { SegmentedControl, WheelPicker } from '@/components/ui';
import { useI18n } from '@/src/i18n';
import { calendarMonthName, toDigits, type CalendarKind } from '@/src/lib/calendar';
import {
  birthdayToIso,
  birthdayYears,
  clampDay,
  convertParts,
  daysInMonth,
  defaultBirthdayParts,
} from '@/src/lib/onboarding';
import { isoToParts, type DateParts } from '@/src/partner/birthday';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * Step 3 of 4 — birthday (reference 06): Gregorian/Jalali segmented control + a year · month · day wheel.
 * Stored as a UTC ISO date (brief rule 4) through `src/partner/birthday.ts`; shown with the chosen digits.
 * "Next step" stays disabled until the person has chosen a date (touching the wheel or the calendar switch), unless one is already saved.
 */
export default function OnboardingBirthdayScreen() {
  const router = useRouter();
  const { language, t } = useI18n();
  const calendarMode = useSettingsStore((s) => s.calendarMode);
  const digits = useSettingsStore((s) => s.digits);
  const me = usePartnerStore((s) => s.me);
  const setMe = usePartnerStore((s) => s.setMe);
  const now = useMemo(() => new Date(), []);

  const [kind, setKind] = useState<CalendarKind>(calendarMode === 'gregorian' ? 'gregorian' : 'jalali');
  const saved = me.birthday ? isoToParts(kind, me.birthday) : null;
  const [parts, setParts] = useState<DateParts>(saved ?? defaultBirthdayParts(kind, now));
  const [touched, setTouched] = useState(!!saved);

  const years = useMemo(() => birthdayYears(kind, now), [kind, now]);
  const dayCount = daysInMonth(kind, parts.year, parts.month);
  const iso = birthdayToIso(kind, parts, now);
  const valid = touched && !!iso;

  const update = (p: DateParts) => {
    setParts(clampDay(kind, p));
    setTouched(true);
  };
  const switchKind = (to: CalendarKind) => {
    if (to === kind) return;
    setParts(clampDay(to, convertParts(kind, to, parts)));
    setKind(to);
  };
  const next = () => {
    if (!valid || !iso) return;
    setMe({ ...me, birthday: iso });
    router.push('/onboarding/photo');
  };

  const yearIndex = Math.max(0, years.indexOf(parts.year));
  return (
    <OnboardingFrame step="birthday" title={t('onboardingBirthdayTitle')} emoji="🎂" subtitle={t('onboardingBirthdaySubtitle')} nextDisabled={!valid} onNext={next}>
      <View style={{ alignItems: 'center', marginBottom: 20 }}>
        <SegmentedControl<CalendarKind>
          options={[
            { value: 'gregorian', label: t('gregorian') },
            { value: 'jalali', label: t('jalali') },
          ]}
          value={kind}
          onChange={switchKind}
        />
      </View>
      <WheelPicker
        columns={[
          {
            key: `year-${kind}`,
            label: t('profileYear'),
            flex: 1.2,
            items: years.map((y) => toDigits(y, digits)),
            index: yearIndex,
            onIndexChange: (i) => update({ ...parts, year: years[i] }),
          },
          {
            key: `month-${kind}`,
            label: t('profileMonth'),
            flex: 1.4,
            items: Array.from({ length: 12 }, (_, i) => calendarMonthName(kind, i + 1, language)),
            index: parts.month - 1,
            onIndexChange: (i) => update({ ...parts, month: i + 1 }),
          },
          {
            key: `day-${kind}-${dayCount}`,
            label: t('profileDay'),
            flex: 0.8,
            items: Array.from({ length: dayCount }, (_, i) => toDigits(i + 1, digits)),
            index: parts.day - 1,
            onIndexChange: (i) => update({ ...parts, day: i + 1 }),
          },
        ]}
      />
    </OnboardingFrame>
  );
}
