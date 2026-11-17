import { Feather } from '@expo/vector-icons';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { calendarMonthName, toDigits, type CalendarKind } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';
import { yearChoices, type YearMonth } from '@/src/library/date-range';

/** One square month grid: a year header (tap = year list) over 12 months. */
function MonthGrid({ title, kind, value, onChange, initialYear }: {
  title: string; kind: CalendarKind; value: YearMonth | null; onChange: (v: YearMonth) => void; initialYear: number;
}) {
  const colors = useColors();
  const { language, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const [year, setYear] = useState(value?.year ?? initialYear);
  const [picking, setPicking] = useState(false);
  const font = fontFamilyFor(language);
  const years = yearChoices(kind);
  const cell = (label: string, on: boolean, press: () => void, key: string | number) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={press}
      style={[styles.cell, { backgroundColor: on ? colors.primary : colors.card, borderColor: on ? colors.primary : colors.border }]}
    >
      <Text numberOfLines={1} style={{ color: on ? colors.chipSelectedForeground : colors.foreground, fontFamily: font, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.grid}>
      <Text style={{ color: colors.mutedForeground, fontFamily: font, fontSize: 12, textAlign: 'center' }}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('rangeYear')}
        onPress={() => setPicking((x) => !x)}
        style={[styles.year, { borderColor: colors.border, backgroundColor: colors.card }]}
      >
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 16 }}>{toDigits(year, digits)}</Text>
        <Feather name={picking ? 'chevron-up' : 'chevron-down'} size={16} color={colors.foreground} />
      </Pressable>
      {picking ? (
        <ScrollView style={styles.yearList} nestedScrollEnabled contentContainerStyle={styles.cells}>
          {years.map((y) => cell(toDigits(y, digits), y === year, () => { setYear(y); setPicking(false); }, y))}
        </ScrollView>
      ) : (
        <View style={styles.cells}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) =>
            cell(calendarMonthName(kind, m, language), value?.year === year && value.month === m, () => onChange({ year, month: m }), m))}
        </View>
      )}
    </View>
  );
}

/** Two month grids side by side: first month and last month. */
export function MonthRangePicker({ kind, start, end, onStart, onEnd, initialYear }: {
  kind: CalendarKind; start: YearMonth | null; end: YearMonth | null; onStart: (v: YearMonth) => void; onEnd: (v: YearMonth) => void; initialYear: number;
}) {
  const { isRTL, t } = useI18n();
  return (
    <View style={[styles.row, { flexDirection: rowOf(isRTL) }]}>
      <MonthGrid title={t('rangeFrom')} kind={kind} value={start} onChange={onStart} initialYear={initialYear} />
      <MonthGrid title={t('rangeTo')} kind={kind} value={end} onChange={onEnd} initialYear={initialYear} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 10, alignItems: 'flex-start' },
  grid: { flex: 1, gap: 8 },
  year: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: radii.pill, paddingVertical: 8 },
  cells: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  yearList: { maxHeight: 230 },
  cell: { width: '47%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 12, paddingVertical: 11, minHeight: 44 },
});
