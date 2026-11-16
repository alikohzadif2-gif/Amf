import { Feather } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { radii } from '@/constants/theme';
import { IconTile, SectionLabel } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import type { EventRow } from '@/src/events/events-db';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { togetherLabel, type TogetherParts } from '@/src/lib/home';
import type { LibraryEntry } from '@/src/library/merge';
import { Thumb } from '@/src/library/ui/Thumb';
import { useSettingsStore } from '@/src/state/settings-store';

/** Rounded surface used by every Home card (replaces the old `HomeCard`): `card` fill, radius 24, hairline border. */
export function SurfaceCard({ children, tint, onPress, label }: { children: ReactNode; tint?: string; onPress?: () => void; label?: string }) {
  const colors = useColors();
  const style = [styles.card, { backgroundColor: tint ?? colors.card, borderColor: colors.border }];
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [style, { opacity: pressed ? 0.8 : 1 }]}>
      {children}
    </Pressable>
  );
}

function useText() {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (color: string, size: number, weight: 'regular' | 'medium' | 'semibold' | 'bold' = 'regular') =>
    ({ color, fontFamily: fontFamilyFor(language, weight), fontSize: size, textAlign: alignOf(isRTL) }) as const;
}

/**
 * "Days together" (R2): one slim card in the header row, next to the profile circle. It shows `5 years 3 months 2 days`
 * (zero parts are left out; digits and calendar follow Settings); without a date it is a link to set it. Tap opens the profile.
 */
export function DaysTogetherCard({ parts, onSet }: { parts: TogetherParts | null; onSet: () => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const { digits } = useSettingsStore();
  const text = useText();
  const label = parts ? togetherLabel(parts, t, (n) => toDigits(n, digits), language === 'fa' ? ' و ' : ' ') : t('homeSetTogether');
  const lines = parts ? [
    parts.years > 0 ? `${toDigits(parts.years, digits)} ${t(parts.years === 1 ? 'unitYear' : 'unitYears')}` : null,
    parts.months > 0 ? `${toDigits(parts.months, digits)} ${t(parts.months === 1 ? 'unitMonth' : 'unitMonths')}` : null,
    (parts.days > 0 || (parts.years === 0 && parts.months === 0)) ? `${toDigits(parts.days, digits)} ${t(parts.days === 1 ? 'unitDay' : 'unitDays')}` : null,
  ].filter(Boolean) as string[] : [label];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('homeDaysTogether')}: ${label}`}
      onPress={onSet}
      style={({ pressed }) => [styles.slim, { backgroundColor: 'transparent', borderColor: 'transparent', borderWidth: 0, opacity: pressed ? 0.8 : 1, flexDirection: 'column', flex: 0, alignItems: 'center', justifyContent: 'center', maxWidth: 78, minWidth: 54, minHeight: 42, paddingHorizontal: 4, paddingVertical: 2, gap: 0 }]}
    >
      {lines.map((line, index) => <Text key={`${index}-${line}`} numberOfLines={1} style={[text(parts ? colors.foreground : colors.primary, 11, 'semibold'), { lineHeight: language === 'fa' ? 16 : 14, textAlign: 'center' }]}>{line}</Text>)}
    </Pressable>
  );
}

/** "On this day": earlier-year events (with "N years ago") and up to six already-indexed Library photos; muted text when empty. */
export function OnThisDayCard({ events, years, media }: { events: EventRow[]; years: (e: EventRow) => number; media: LibraryEntry[] }) {
  const colors = useColors();
  const { isRTL, t } = useI18n();
  const { digits } = useSettingsStore();
  const text = useText();
  const empty = events.length === 0 && media.length === 0;
  return (
    <>
      <SectionLabel label={t('homeOnThisDay')} />
      <SurfaceCard>
        {empty ? <Text style={[text(colors.mutedForeground, 15), { textAlign: 'center', paddingVertical: 6 }]}>{t('homeNothingThisDay')}</Text> : null}
        {events.map((e) => (
          <View key={e.id} style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 6 }}>
            <IconTile icon="calendar" size={40} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={text(colors.foreground, 15, 'medium')} numberOfLines={1}>{e.title}</Text>
              <Text style={text(colors.mutedForeground, 12.5)}>
                {toDigits(years(e), digits)} {t('eventYearsAgo')}
              </Text>
            </View>
          </View>
        ))}
        {media.length > 0 ? (
          <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 8, marginTop: events.length ? 8 : 0 }}>
            {media.map((entry) => (
              <Thumb key={entry.key} entry={entry} style={{ width: 72, height: 72, borderRadius: radii.control + 4 }} />
            ))}
          </View>
        ) : null}
      </SurfaceCard>
    </>
  );
}

/** Library shortcut row (replaces the old quick-action buttons; Zeydi's "Znap archive" position). */
export function LibraryShortcut({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const { isRTL, t } = useI18n();
  const text = useText();
  return (
    <SurfaceCard onPress={onPress} label={t('homeLibrary')}>
      <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 14 }}>
        <IconTile icon="image" size={48} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={text(colors.foreground, 16, 'semibold')}>{t('homeLibrary')}</Text>
          <Text style={text(colors.mutedForeground, 12.5)}>{t('homeLibraryHint')}</Text>
        </View>
        <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={20} color={colors.mutedForeground} />
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.card, borderWidth: 1, padding: 16, marginBottom: 14 },
  slim: { flex: 1, alignItems: 'center', gap: 10, borderRadius: radii.card, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9, minHeight: 44 },
});
