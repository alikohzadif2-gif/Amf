import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { Directory } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { InfoRow, SettingGroup } from '@/components/settings/SettingRows';
import { ToolButton, ToolNote, ToolScreen } from '@/components/settings/ToolScreen';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { useLibraryIndex } from '@/src/library/index-store';
import { formatBytes } from '@/src/library/ui/format';
import { useSettingsStore } from '@/src/state/settings-store';
import { discardJob, listTops, listTrashed, openJobs, vaultTotals, type JobInfo, type TopRow, type VaultItem } from '@/src/vault/db';
import { rehideSource, unhideTop } from '@/src/vault/export';
import { pickFolder, type Picked } from '@/src/vault/saf';
import { planJob, runJob, useVaultJob } from '@/src/vault/import';
import { trashDaysLeft } from '@/src/vault/logic';
import { useSourceMode } from '@/src/library/source-mode';
import { purgeExpired, purgeItem, restoreItem, trashRel } from '@/src/vault/trash';

type Action = { icon: keyof typeof Feather.glyphMap; label: TranslationKey; onPress: () => void; destructive?: boolean };

/** The private vault: what is hidden, what was unhidden (and can be hidden again), the 30-day trash, unfinished transfers. */
export default function VaultScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const align = alignOf(isRTL);
  const running = useVaultJob((s) => s.running);
  const [hidden, setHidden] = useState<TopRow[]>([]);
  const [exported, setExported] = useState<TopRow[]>([]);
  const [trash, setTrash] = useState<VaultItem[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [totals, setTotals] = useState({ count: 0, bytes: 0 });
  const [busy, setBusy] = useState(false);
  const fmt = (n: number) => formatBytes(n, t, digits);

  const refresh = useCallback(async () => {
    await purgeExpired(db).catch(() => 0);
    const [h, e, tr, j, tot] = await Promise.all([listTops(db, 'hidden'), listTops(db, 'exported'), listTrashed(db), openJobs(db), vaultTotals(db)]);
    setHidden(h);
    setExported(e);
    setTrash(tr);
    setJobs(j);
    setTotals(tot);
  }, [db]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const done = async () => {
    await refresh();
    void useLibraryIndex.getState().build(true);
  };

  const unhide = (top: string) =>
    Alert.alert(t('vaultUnhideTitle'), t('vaultUnhideBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('vaultUnhide'),
        onPress: () => void (async () => {
          let dest: Directory;
          try {
            dest = await Directory.pickDirectoryAsync();
          } catch {
            return; // the person backed out of the folder chooser
          }
          setBusy(true);
          const r = await unhideTop(db, top, dest);
          setBusy(false);
          await done();
          Alert.alert(t('vaultUnhide'), [
            `${t('vaultUnhideDone')}: ${toDigits(r.moved, digits)}`,
            r.kept > 0 ? `${t('vaultUnhideKept')}: ${toDigits(r.kept, digits)}` : '',
            r.failed > 0 ? `${t('vaultUnhideFailed')}: ${toDigits(r.failed, digits)}` : '',
          ].filter(Boolean).join('\n'));
        })(),
      },
    ]);

  const startHide = async (source: Picked) => {
    setBusy(true);
    const plan = await planJob(db, [source], 'move');
    setBusy(false);
    if (!plan.ok) return void Alert.alert(t('vaultHideAgain'), plan.reason === 'empty' ? t('vaultNothingToAdd') : `${t('vaultNoSpace')} ${fmt(plan.needed)}`);
    void runJob(db, plan.job).then(done);
    router.push('/vault-add'); // shows the progress
  };

  const hideAgain = (row: TopRow) =>
    Alert.alert(t('vaultHideAgainTitle'), t('vaultHideAgainBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('vaultHideAgain'),
        onPress: () => void (async () => {
          setBusy(true);
          const source = row.exportUri ? rehideSource(row.top, row.exportUri) : null;
          setBusy(false);
          if (source) return void startHide(source);
          // the folder cannot be found or read any more: the person shows where it is now
          Alert.alert(t('vaultHideAgain'), t('vaultHideAgainNotFound'), [
            { text: t('cancel'), style: 'cancel' },
            { text: t('vaultPickFolder'), onPress: () => void pickFolder().then((picked) => { if (picked) void startHide(picked); }) },
          ]);
        })(),
      },
    ]);

  const trashTop = (top: string) =>
    Alert.alert(t('vaultTrashTitle'), t('vaultTrashBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('vaultTrashAction'), style: 'destructive', onPress: () => void (async () => { setBusy(true); await trashRel(db, top); setBusy(false); await done(); })() },
    ]);

  const forever = (item: VaultItem) =>
    Alert.alert(t('vaultDeleteForeverTitle'), t('vaultDeleteForeverBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('vaultDeleteForever'), style: 'destructive', onPress: () => void purgeItem(db, item.id).then(done) },
    ]);

  const openArchive = () => {
    useSourceMode.getState().set('vault');
    router.push({ pathname: '/library', params: { source: 'vault' } });
  };

  const row = (key: string, title: string, subtitle: string, actions: Action[]) => (
    <View key={key} style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: rowOf(isRTL) }]}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14, textAlign: align }}>{title}</Text>
        <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, textAlign: align }}>{subtitle}</Text>
      </View>
      {actions.map((a) => (
        <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={t(a.label)} disabled={busy || running} hitSlop={8} onPress={a.onPress} style={styles.act}>
          <Feather name={a.icon} size={19} color={a.destructive ? colors.destructive : colors.primary} />
        </Pressable>
      ))}
    </View>
  );
  const heading = (key: TranslationKey) => (
    <Text style={[styles.heading, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: align }]}>{t(key)}</Text>
  );

  return (
    <ToolScreen title="vaultTitle" intro="vaultIntro">
      <SettingGroup>
        <InfoRow title="vaultTotalHidden" value={`${toDigits(totals.count, digits)} · ${fmt(totals.bytes)}`} />
      </SettingGroup>
      <ToolNote text={t('vaultDataLoss')} />

      {jobs.map((job) => (
        <View key={job.job} style={[styles.row, { backgroundColor: colors.card, borderColor: colors.primary, flexDirection: rowOf(isRTL) }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14, textAlign: align }}>{t('vaultResumeTitle')}</Text>
            <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, textAlign: align }}>{`${toDigits(job.left, digits)} ${t('vaultResumeLeft')}`}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t('vaultContinue')} disabled={running} hitSlop={8} onPress={() => { void runJob(db, job.job).then(done); router.push('/vault-add'); }} style={styles.act}>
            <Feather name="play" size={19} color={colors.primary} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('vaultDiscard')} disabled={running} hitSlop={8} onPress={() => Alert.alert(t('vaultDiscard'), t('vaultDiscardBody'), [{ text: t('cancel'), style: 'cancel' }, { text: t('vaultDiscard'), style: 'destructive', onPress: () => void discardJob(db, job.job).then(done) }])} style={styles.act}>
            <Feather name="x" size={19} color={colors.destructive} />
          </Pressable>
        </View>
      ))}

      <ToolButton label={t('vaultAddFolder')} onPress={() => router.push('/vault-add')} busy={busy} />
      <ToolButton label={t('vaultOpenArchive')} onPress={openArchive} primary={false} />

      {heading('vaultHiddenSection')}
      {hidden.length === 0 ? <ToolNote text={t('vaultEmpty')} /> : null}
      {hidden.map((r) => row(`h-${r.top}`, r.top, `${toDigits(r.count, digits)} ${t('vaultFilesSuffix')} · ${fmt(r.bytes)}`, [
        { icon: 'unlock', label: 'vaultUnhide', onPress: () => unhide(r.top) },
        { icon: 'trash-2', label: 'vaultTrashAction', onPress: () => trashTop(r.top), destructive: true },
      ]))}

      {exported.length > 0 ? heading('vaultExportedSection') : null}
      {exported.map((r) => row(`e-${r.top}`, r.top, `${toDigits(r.count, digits)} ${t('vaultFilesSuffix')} · ${fmt(r.bytes)}`, [
        { icon: 'lock', label: 'vaultHideAgain', onPress: () => hideAgain(r) },
      ]))}
      {exported.length > 0 ? <ToolNote text={t('vaultSyncNote')} /> : null}

      {trash.length > 0 ? heading('vaultTrashSection') : null}
      {trash.map((item) => row(`t-${item.id}`, item.rel, `${fmt(item.size)} · ${toDigits(trashDaysLeft(item.stateAt, Date.now()), digits)} ${t('vaultDaysLeft')}`, [
        { icon: 'rotate-ccw', label: 'vaultRestore', onPress: () => void restoreItem(db, item.id).then(done) },
        { icon: 'x-circle', label: 'vaultDeleteForever', onPress: () => forever(item), destructive: true },
      ]))}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 16, marginTop: 24, marginBottom: 2 },
  row: { alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  act: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
});
