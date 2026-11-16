import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { InfoRow, SelectRow, SettingGroup } from '@/components/settings/SettingRows';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { useLibraryIndex } from '@/src/library/index-store';
import { formatBytes } from '@/src/library/ui/format';
import { loadUserData } from '@/src/library/user-data';
import { runFreeUp, scanFreeUp, type FreeUpPlan } from '@/src/media/free-up';
import { useSettingsStore } from '@/src/state/settings-store';

type Cutoff = '30' | '90' | '365' | 'all';
const DAY = 86_400_000;

function cutoffIso(cutoff: Cutoff): string {
  const days = cutoff === 'all' ? 0 : Number(cutoff);
  return new Date(Date.now() - days * DAY).toISOString();
}

export default function FreeUpSpaceScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const calendarMode = useSettingsStore((s) => s.calendarMode);
  const digits = useSettingsStore((s) => s.digits);
  const [cutoff, setCutoff] = useState<Cutoff>('90');
  const [plan, setPlan] = useState<FreeUpPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);

  useEffect(() => { loadUserData(db); useLibraryIndex.getState().build(); }, [db]);
  useEffect(() => { setPlan(null); setFreed(null); }, [cutoff]);

  const scan = async () => {
    setBusy(true);
    await useLibraryIndex.getState().build();
    setPlan(await scanFreeUp(useLibraryIndex.getState().entries, cutoffIso(cutoff)));
    setBusy(false);
  };
  const run = async () => {
    if (!plan) return;
    setBusy(true);
    setFreed(await runFreeUp(plan));
    setPlan(null);
    useLibraryIndex.getState().build(true);
    setBusy(false);
  };
  const total = plan ? plan.localFiles.length + plan.offlineCopies.length : 0;
  const button = (label: string, onPress: () => void, primary: boolean) => (
    <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: primary ? colors.primary : colors.card, borderColor: primary ? colors.primary : colors.border, opacity: pressed || busy ? 0.7 : 1 }]}>
      {busy ? <ActivityIndicator color={primary ? '#fff' : colors.primary} /> : null}
      <Text style={{ color: primary ? '#fff' : colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14 }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScreenFrame scroll>
      <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={() => router.back()} style={({ pressed }) => [styles.back, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: rowOf(isRTL), opacity: pressed ? 0.7 : 1 }]}>
        <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={18} color={colors.foreground} />
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{t('back')}</Text>
      </Pressable>
      <Text style={[styles.title, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: alignOf(isRTL) }]}>{t('freeUpTitle')}</Text>
      <Text style={[styles.intro, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('freeUpIntro')}</Text>
      <SettingGroup>
        <SelectRow
          title="freeUpCutoff"
          value={cutoff}
          onChange={(v) => setCutoff(v as Cutoff)}
          options={[
            { value: '30', label: 'cutoff30' },
            { value: '90', label: 'cutoff90' },
            { value: '365', label: 'cutoff365' },
            { value: 'all', label: 'cutoffAll' },
          ]}
        />
        <InfoRow title="freeUpCutoffDate" value={formatDate(cutoffIso(cutoff), calendarMode, language, digits)} />
      </SettingGroup>
      {plan ? (
        <SettingGroup>
          <InfoRow title="freeUpLocalCopies" value={toDigits(plan.localFiles.length, digits)} />
          <InfoRow title="freeUpOfflineCopies" value={toDigits(plan.offlineCopies.length, digits)} />
          <InfoRow title="freeUpSize" value={formatBytes(plan.bytes, t, digits)} />
        </SettingGroup>
      ) : null}
      {plan && total === 0 ? <Text style={[styles.note, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('freeUpNothing')}</Text> : null}
      {freed !== null ? <Text style={[styles.note, { color: colors.primary, fontFamily: fontFamilyFor(language, 'medium'), textAlign: alignOf(isRTL) }]}>{`${t('freeUpDone')}: ${formatBytes(freed, t, digits)}`}</Text> : null}
      <View style={styles.actions}>
        {button(t('freeUpScan'), scan, !plan)}
        {plan && total > 0 ? button(t('freeUpRun'), run, true) : null}
      </View>
      <Text style={[styles.note, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('freeUpGalleryNote')}</Text>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', minHeight: 40, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, alignItems: 'center', gap: 8 },
  title: { fontSize: 26, marginTop: 22 },
  intro: { fontSize: 14, lineHeight: 23, marginTop: 8, marginBottom: 14 },
  note: { fontSize: 13, lineHeight: 21, marginTop: 12 },
  actions: { gap: 10, marginTop: 16 },
  button: { minHeight: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
});
