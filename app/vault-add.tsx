import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { ProgressBar } from '@/components/ui';
import { InfoRow, SettingGroup } from '@/components/settings/SettingRows';
import { ToolButton, ToolNote, ToolScreen } from '@/components/settings/ToolScreen';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { useLibraryIndex } from '@/src/library/index-store';
import { formatBytes } from '@/src/library/ui/format';
import { useSettingsStore } from '@/src/state/settings-store';
import { closeJob, dropJob, pauseJob, planJob, runJob, useVaultJob } from '@/src/vault/import';
import { freeDiskBytes } from '@/src/vault/files';
import { enoughSpace, spaceNeeded, totalsOf, type ImportMode } from '@/src/vault/logic';
import { pickFiles, pickFolder, type Picked } from '@/src/vault/saf';

/**
 * Add folders/files from the file manager to the private vault. This one screen is the shared logic for the Archive and the sharing
 * settings: both open it. The person picks what to add, then says Move or Copy BEFORE anything starts.
 */
export default function VaultAddScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const job = useVaultJob();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [mode, setMode] = useState<ImportMode | null>(null);
  const [busy, setBusy] = useState(false);
  const align = alignOf(isRTL);
  const font = (weight: 'regular' | 'medium' | 'semibold' = 'regular') => fontFamilyFor(language, weight);

  // leaving the screen pauses a running transfer; it can be continued from the vault screen
  useEffect(() => () => { if (useVaultJob.getState().running) pauseJob(); }, []);
  // an old finished summary is not shown again when the screen is opened later
  useEffect(() => { const s = useVaultJob.getState(); if (s.finished && !s.running) closeJob(); }, []);

  const sizes = useMemo(() => picked.flatMap(sizesOf), [picked]);
  const totals = totalsOf(sizes);
  const free = freeDiskBytes();
  const short = mode !== null && free !== null && totals.count > 0 && !enoughSpace(mode, totals, free);
  const skipped = picked.reduce((n, p) => n + (p.kind === 'folder' ? p.skipped : 0), 0);
  const fmt = (n: number) => formatBytes(n, t, digits);

  const add = async (kind: 'folder' | 'files') => {
    setBusy(true);
    const result = kind === 'folder' ? await pickFolder() : await pickFiles();
    setBusy(false);
    if (result) setPicked((list) => [...list, result]);
  };

  const begin = () => {
    if (!mode || picked.length === 0 || short) return;
    const move = mode === 'move';
    Alert.alert(t(move ? 'vaultConfirmMoveTitle' : 'vaultConfirmCopyTitle'), t(move ? 'vaultConfirmMoveBody' : 'vaultConfirmCopyBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('vaultStart'),
        style: move ? 'destructive' : 'default',
        onPress: () => void (async () => {
          setBusy(true);
          const plan = await planJob(db, picked, mode);
          setBusy(false);
          if (!plan.ok) {
            Alert.alert(t('vaultAddTitle'), plan.reason === 'empty' ? t('vaultNothingToAdd') : `${t('vaultNoSpace')} ${fmt(plan.needed)}`);
            return;
          }
          setPicked([]);
          await runJob(db, plan.job);
          void useLibraryIndex.getState().build(true);
        })(),
      },
    ]);
  };

  const resume = async () => {
    if (job.job) await runJob(db, job.job);
    void useLibraryIndex.getState().build(true);
  };
  const discard = () =>
    Alert.alert(t('vaultDiscard'), t('vaultDiscardBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('vaultDiscard'), style: 'destructive', onPress: () => void (job.job ? dropJob(db, job.job) : Promise.resolve()) },
    ]);

  const card = (selected: boolean) => [styles.card, { borderColor: selected ? colors.primary : colors.border, backgroundColor: colors.card, flexDirection: rowOf(isRTL) }];

  if (job.job !== null || job.finished) {
    const progress = job.bytesTotal > 0 ? job.bytesDone / job.bytesTotal : job.total > 0 ? (job.done + job.kept + job.failed) / job.total : 0;
    return (
      <ToolScreen title="vaultAddTitle">
        {job.finished ? null : <ProgressBar progress={progress} accessibilityLabel={t('vaultRunning')} />}
        <ToolNote text={job.finished ? t('vaultDoneTitle') : job.running ? t('vaultRunning') : job.noSpace ? t('vaultNoSpaceNow') : t('vaultPaused')} tone="primary" />
        <SettingGroup>
          <InfoRow title="vaultDoneAdded" value={`${toDigits(job.done, digits)} / ${toDigits(job.total, digits)}`} />
          {job.kept > 0 ? <InfoRow title="vaultDoneKept" value={toDigits(job.kept, digits)} /> : null}
          {job.failed > 0 ? <InfoRow title="vaultDoneFailed" value={toDigits(job.failed, digits)} /> : null}
        </SettingGroup>
        {job.running ? <ToolButton label={t('vaultPause')} onPress={pauseJob} primary={false} /> : null}
        {!job.running && !job.finished ? <ToolButton label={t('vaultContinue')} onPress={() => void resume()} /> : null}
        {!job.running && !job.finished ? <ToolButton label={t('vaultDiscard')} onPress={discard} primary={false} /> : null}
        {job.finished ? <ToolButton label={t('vaultClose')} onPress={() => { closeJob(); router.back(); }} /> : null}
      </ToolScreen>
    );
  }

  return (
    <ToolScreen title="vaultAddTitle" intro="vaultAddIntro">
      <ToolButton label={t('vaultPickFolder')} onPress={() => void add('folder')} busy={busy} primary={false} />
      <ToolButton label={t('vaultPickFiles')} onPress={() => void add('files')} busy={busy} primary={false} />

      {picked.length === 0 ? <ToolNote text={t('vaultPickedNone')} /> : null}
      {picked.map((item, index) => {
        const count = sizesOf(item).length;
        const bytes = sizesOf(item).reduce((n, size) => n + size, 0);
        const name = item.kind === 'folder' ? item.name : item.files.length === 1 ? item.files[0].name : t('vaultPickFiles');
        return (
          <View key={`${index}-${name}`} style={[styles.pickRow, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: rowOf(isRTL) }]}>
            <Feather name={item.kind === 'folder' ? 'folder' : 'file'} size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: font('medium'), fontSize: 14, textAlign: align }}>{name}</Text>
              <Text style={{ color: colors.mutedForeground, fontFamily: font(), fontSize: 12, textAlign: align }}>{`${toDigits(count, digits)} ${t('vaultPickedFiles')} · ${fmt(bytes)}`}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t('vaultRemovePicked')} hitSlop={8} onPress={() => setPicked((list) => list.filter((_, i) => i !== index))}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        );
      })}
      {skipped > 0 ? <ToolNote text={`${toDigits(skipped, digits)} ${t('vaultPickedSkipped')}`} /> : null}

      <Text style={[styles.heading, { color: colors.foreground, fontFamily: font('semibold'), textAlign: align }]}>{t('vaultModeTitle')}</Text>
      {(['move', 'copy'] as const).map((id) => (
        <Pressable key={id} accessibilityRole="radio" accessibilityState={{ selected: mode === id }} onPress={() => setMode(id)} style={card(mode === id)}>
          <Feather name={mode === id ? 'check-circle' : 'circle'} size={20} color={mode === id ? colors.primary : colors.mutedForeground} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontFamily: font('semibold'), fontSize: 15, textAlign: align }}>{t(id === 'move' ? 'vaultModeMove' : 'vaultModeCopy')}</Text>
            <Text style={{ color: colors.mutedForeground, fontFamily: font(), fontSize: 12.5, lineHeight: 20, textAlign: align }}>{t(id === 'move' ? 'vaultModeMoveDesc' : 'vaultModeCopyDesc')}</Text>
          </View>
        </Pressable>
      ))}

      {totals.count > 0 ? (
        <SettingGroup>
          <InfoRow title="vaultSumFiles" value={toDigits(totals.count, digits)} />
          <InfoRow title="vaultSumSize" value={fmt(totals.bytes)} />
          {free !== null ? <InfoRow title="vaultSumFree" value={fmt(free)} /> : null}
        </SettingGroup>
      ) : null}
      {short && mode ? <ToolNote text={`${t('vaultNoSpace')} ${fmt(spaceNeeded(mode, totals))}`} /> : null}
      <ToolNote text={t('vaultDataLoss')} />
      <ToolButton label={t('vaultStart')} onPress={begin} busy={busy} />
      {!mode && picked.length > 0 ? <ToolNote text={t('vaultModeTitle')} tone="primary" /> : null}
    </ToolScreen>
  );
}

const sizesOf = (p: Picked): number[] => (p.kind === 'folder' ? p.files.map((f) => f.size) : p.files.map((f) => f.size));

const styles = StyleSheet.create({
  pickRow: { alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  heading: { fontSize: 16, marginTop: 22, marginBottom: 4 },
  card: { alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10 },
});
