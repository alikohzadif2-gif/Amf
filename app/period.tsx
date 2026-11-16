import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Text } from '@/components/ui/ScaledText';
import { PeriodRing } from '@/components/period/PeriodRing';
import { Button, Card, Notice, BackButton, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { DateWheel } from '@/components/ui/DateWheel';
import { SectionLabel, Toast } from '@/components/ui';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { FEATURES } from '@/src/constants/features';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { sendMood, sendPeriod } from '@/src/partner/manage';
import { saveMoodLocal } from '@/src/partner/mood-db';
import { isoToParts, partsToIso } from '@/src/partner/birthday';
import { isValidStartDay, MAX_CYCLE_DAYS, MIN_CYCLE_DAYS, phaseForDay, predict, type CyclePhase } from '@/src/period/cycle';
import { clearPeriodEvents, deletePeriodEvent, listPeriodEvents, type PeriodRow } from '@/src/period/period-db';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshApp } from '@/src/partner/refresh';

/** The mood emoji a "period started" log also sets (R5b); it is the `period` entry of src/partner/moods.ts. */
const PERIOD_EMOJI = '🩸';
const PHASE_KEY: Record<CyclePhase, TranslationKey> = {
  period: 'periodPhase_period',
  follicular: 'periodPhase_follicular',
  fertile: 'periodPhase_fertile',
  ovulation: 'periodPhase_ovulation',
  luteal: 'periodPhase_luteal',
  pms: 'periodPhase_pms',
  late: 'periodPhase_late',
};
const KIND_KEY = { started: 'periodKindStarted', pain: 'periodKindPain', better: 'periodKindBetter' } as const;

export default function PeriodScreen() {
  const colors = useColors();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, digits } = useSettingsStore();
  const myCycle = useSettingsStore((s) => s.periodCycleDays);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const partnerCycle = usePartnerStore((s) => s.partnerCycleDays);
  const partner = usePartnerStore((s) => s.partner);
  const gender = useSettingsStore((s) => s.gender);
  const tick = usePartnerStore((s) => s.periodTick);
  const paired = usePartnerStore((s) => s.paired);
  const [rows, setRows] = useState<PeriodRow[]>([]);
  const [pickDay, setPickDay] = useState(() => new Date().toISOString().slice(0, 10)); // the start day: today unless another past day is picked on the wheels
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  // Men have no period of their own: the screen shows only the partner's cycle. Everyone else sees their own.
  const mine = gender !== 'male';
  const today = new Date().toISOString().slice(0, 10);
  const mode = calendarMode === 'both' ? 'jalali' : calendarMode;
  const dateText = (day: string) => formatDate(day, mode, language, digits);
  const num = (n: number) => toDigits(String(n), digits);

  useEffect(() => {
    void listPeriodEvents(db, mine).then(setRows);
  }, [db, tick, mine]);

  const starts = rows.filter((r) => r.kind === 'started').map((r) => r.day);
  const custom = mine ? myCycle : partnerCycle ?? null; // Q7: the owner's own cycle length replaces the estimate
  const info = phaseForDay(starts, today, custom);
  const next = predict(starts, custom);
  const startDay = pickDay;
  const startOk = isValidStartDay(startDay, today);
  const pickParts = isoToParts(mode, `${pickDay}T00:00:00.000Z`);
  const setCycle = (n: number | null) => setSetting('periodCycleDays', n === null ? null : Math.min(MAX_CYCLE_DAYS, Math.max(MIN_CYCLE_DAYS, n)));
  const stepCycle = (d: number) => setCycle((myCycle ?? next?.length ?? 28) + d); // first tap starts from the current estimate
  const late = info?.phase === 'late';
  const name = partner?.name || t('partnerDefaultName');

  const nextLine = !info || !next
    ? mine ? t('periodNoData') : t('periodNoDataPartner')
    : late
      ? t('periodLateDays').replace('{n}', num(-info.daysUntilNext))
      : info.daysUntilNext === 0
        ? t('periodNextToday')
        : t('periodNextIn').replace('{n}', num(info.daysUntilNext)) + ` · ${dateText(next.nextStart)}`;

  const log = async () => {
    setBusy(true);
    const day = startDay;
    const res = await sendPeriod(db, 'started', day === today ? undefined : day);
    if (res !== 'failed' && res !== 'duplicate' && day === today) {
      // The "status": the mood card shows the period emoji too (partner sees it as a normal mood).
      const delivery = FEATURES.partner && paired ? await sendMood(db, { emoji: PERIOD_EMOJI, text: '', intensity: 3 }) : 'not-paired';
      if (delivery !== 'sent') {
        await saveMoodLocal(db, { emoji: PERIOD_EMOJI, activity: null }).catch(() => {});
        usePartnerStore.getState().bumpMoods();
      }
    }
    setBusy(false);
    setToast({ text: t(res === 'failed' ? 'periodFailed' : res === 'duplicate' ? 'periodDuplicate' : res === 'sent' ? 'periodSent' : 'periodSaved'), id: Date.now() });
    void Haptics.notificationAsync(res === 'failed' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success).catch(() => {});
  };

  const remove = (row: PeriodRow) =>
    Alert.alert(t('periodDeleteTitle'), t('periodDeleteBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('periodDelete'),
        style: 'destructive',
        onPress: () =>
          void deletePeriodEvent(db, row.id).then(() => {
            usePartnerStore.getState().bumpPeriod();
          }),
      },
    ]);

  const clearAll = () =>
    Alert.alert(t('periodClearTitle'), t('periodClearBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('periodClear'),
        style: 'destructive',
        onPress: () =>
          void clearPeriodEvents(db, mine).then(() => {
            usePartnerStore.getState().bumpPeriod();
          }),
      },
    ]);

  const text = (color: string, size: number, weight: 'regular' | 'medium' | 'semibold' = 'regular') => ({ color, fontFamily: fontFamilyFor(language, weight), fontSize: size, textAlign: alignOf(isRTL) }) as const;

  return (
    <View style={{ flex: 1 }}>
      <ScreenFrame scroll onRefresh={refreshApp}>
        <BackButton />
        <Title title="periodTitle" />
        <Text style={[text(colors.foreground, 17, 'semibold'), { textAlign: 'center', marginBottom: 14 }]}>{mine ? t('periodMine') : name}</Text>

        <PeriodRing
          info={info}
          dayText={info ? num(info.dayOfCycle) : '–'}
          caption={t('periodDayCaption')}
          phaseText={info ? t(PHASE_KEY[info.phase]) : t('periodNoDataShort')}
        />
        <Text style={[text(colors.foreground, 15, 'medium'), { textAlign: 'center', marginTop: 14 }]}>{nextLine}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
          {([['periodLegendPeriod', colors.primary], ['periodLegendFertile', colors.success], ['periodLegendPms', colors.moodSelected]] as const).map(([key, color]) => (
            <View key={key} style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 6 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
              <Text style={text(colors.mutedForeground, 12)}>{t(key)}</Text>
            </View>
          ))}
        </View>
        {info && next ? (
          <Text style={[text(colors.mutedForeground, 12), { textAlign: 'center', marginTop: 8 }]}>
            {next.basis === 'custom'
              ? t(mine ? 'periodBasisCustom' : 'periodBasisCustomPartner').replace('{name}', name).replace('{len}', num(next.length))
              : next.basis === 'default'
                ? t('periodBasisDefault')
                : t('periodBasisHistory').replace('{n}', num(next.cycles)).replace('{len}', num(next.length))}
            {next.regular ? '' : ` · ${t('periodIrregular')}`}
          </Text>
        ) : null}

        {mine ? (
          <Card>
            <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 10 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('periodPickDate')}
                disabled={busy}
                onPress={() => setSheet(true)}
                style={({ pressed }) => ({ flex: 1, flexDirection: rowOf(isRTL), alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 26, borderWidth: 1, borderColor: startOk ? colors.border : colors.destructive, backgroundColor: colors.card, paddingHorizontal: 12, opacity: pressed ? 0.7 : 1 })}
              >
                <Feather name="calendar" size={18} color={colors.primary} />
                <Text numberOfLines={1} style={text(startOk ? colors.foreground : colors.destructive, 14, 'semibold')}>{dateText(startDay)}</Text>
              </Pressable>
              <View style={{ flex: 1 }}>
                <Button title="periodStartedBtn" primary busy={busy} disabled={busy || !startOk} onPress={() => void log()} />
              </View>
            </View>
            {!startOk ? <Text style={text(colors.destructive, 12.5)}>{t('periodPickFuture')}</Text> : null}
            {FEATURES.partner && !paired ? <Notice>{t('periodNotPaired')}</Notice> : <Notice>{t('periodSharedNote')}</Notice>}
          </Card>
        ) : (
          <Notice>{t('periodPartnerNote').replace('{name}', name)}</Notice>
        )}

        {mine ? (
          <Card>
            <Text style={text(colors.foreground, 14, 'semibold')}>{t('periodCycleLen')}</Text>
            <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', justifyContent: 'center', gap: 22 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="-" disabled={myCycle !== null && myCycle <= MIN_CYCLE_DAYS} hitSlop={8} onPress={() => stepCycle(-1)} style={({ pressed }) => ({ padding: 10, opacity: pressed ? 0.6 : 1 })}>
                <Feather name="minus-circle" size={28} color={colors.primary} />
              </Pressable>
              <Text style={[text(colors.foreground, 18, 'semibold'), { minWidth: 110, textAlign: 'center' }]}>{myCycle === null ? t('periodCycleAuto') : t('periodCycleDays').replace('{n}', num(myCycle))}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="+" disabled={myCycle !== null && myCycle >= MAX_CYCLE_DAYS} hitSlop={8} onPress={() => stepCycle(1)} style={({ pressed }) => ({ padding: 10, opacity: pressed ? 0.6 : 1 })}>
                <Feather name="plus-circle" size={28} color={colors.primary} />
              </Pressable>
            </View>
            {myCycle !== null ? (
              <Pressable accessibilityRole="button" onPress={() => setCycle(null)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                <Text style={[text(colors.primary, 14, 'semibold'), { textAlign: 'center' }]}>{t('periodCycleUseEstimate')}</Text>
              </Pressable>
            ) : null}
            <Text style={text(colors.mutedForeground, 12)}>{t('periodCycleHint')}</Text>
          </Card>
        ) : null}

        <SectionLabel label={t('periodHistory')} />
        {rows.length === 0 ? (
          <Text style={[text(colors.mutedForeground, 14), { textAlign: 'center', paddingVertical: 16 }]}>{t('periodHistoryEmpty')}</Text>
        ) : (
          rows.map((r) => (
            <View key={r.id} style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(r.kind === 'started' ? colors.primary : colors.moodSelected, 0.15) }}>
                <Feather name={r.kind === 'started' ? 'droplet' : r.kind === 'pain' ? 'alert-circle' : 'smile'} size={18} color={r.kind === 'started' ? colors.primary : colors.moodSelected} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={text(colors.foreground, 15, 'semibold')}>{t(KIND_KEY[r.kind])}</Text>
                <Text style={text(colors.mutedForeground, 12.5)}>{dateText(r.day)}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={t('periodDelete')} hitSlop={10} onPress={() => remove(r)} style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}>
                <Feather name="trash-2" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
          ))
        )}
        {rows.length > 0 ? (
          <View style={{ marginTop: 14 }}>
            <Button title="periodClear" destructive icon="trash-2" onPress={clearAll} />
          </View>
        ) : null}
        <Text style={[text(colors.mutedForeground, 11.5), { marginTop: 18 }]}>{t('periodDisclaimer')}</Text>
      </ScreenFrame>
      <Toast message={toast} />
      <BottomSheet visible={sheet} onClose={() => setSheet(false)} title={t('periodPickDate')} cancelLabel={t('cancel')} actionLabel={t('periodPickConfirm')} onAction={() => setSheet(false)} actionDisabled={!startOk}>
        {pickParts ? (
          <DateWheel
            kind={mode}
            parts={pickParts}
            now={new Date()}
            onChange={(parts) => {
              const iso = partsToIso(mode, parts);
              if (iso) setPickDay(iso.slice(0, 10));
            }}
          />
        ) : null}
        {!startOk ? <Text style={text(colors.destructive, 12.5)}>{t('periodPickFuture')}</Text> : null}
      </BottomSheet>
    </View>
  );
}
