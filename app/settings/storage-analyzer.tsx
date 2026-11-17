import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo } from 'react';
import { ToolButton, ToolNote, ToolScreen } from '@/components/settings/ToolScreen';
import { InfoRow, SettingGroup } from '@/components/settings/SettingRows';
import { useI18n } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { useLibraryIndex } from '@/src/library/index-store';
import { sourceKinds } from '@/src/library/providers';
import { formatBytes } from '@/src/library/ui/format';
import { loadUserData, useUserData } from '@/src/library/user-data';
import { cacheStats } from '@/src/media/thumb-cache';
import { useSettingsStore } from '@/src/state/settings-store';
import { analyzeStorage, type CategoryTotals } from '@/src/tools/storage-stats';

export default function StorageAnalyzerScreen() {
  const db = useSQLiteContext();
  const { t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const entries = useLibraryIndex((s) => s.entries);
  const status = useLibraryIndex((s) => s.status);
  const offline = useUserData((s) => s.offline);

  useEffect(() => {
    loadUserData(db);
    void useLibraryIndex.getState().build();
  }, [db]);

  const stats = useMemo(() => analyzeStorage(entries, sourceKinds()), [entries]);
  const cache = cacheStats();
  const offlineBytes = Object.values(offline).reduce((sum, r) => sum + r.size, 0);
  const line = (c: CategoryTotals) => `${toDigits(c.count, digits)} · ${formatBytes(c.bytes, t, digits)}`;

  return (
    <ToolScreen title="storageAnalyzer" intro="stIntro">
      <ToolButton label={t('stRefresh')} onPress={() => void useLibraryIndex.getState().build(true)} busy={status === 'indexing'} primary={false} />
      <SettingGroup title="stLibrary">
        <InfoRow title="catPhotos" value={line(stats.categories.photos)} />
        <InfoRow title="catVideos" value={line(stats.categories.videos)} />
        <InfoRow title="catFiles" value={line(stats.categories.files)} />
        <InfoRow title="catTexts" value={line(stats.categories.texts)} />
        <InfoRow title="stTotal" value={line(stats.total)} />
      </SettingGroup>
      <SettingGroup title="stBySource">
        <InfoRow title="libSrcVault" value={line(stats.bySource.vault)} />
      </SettingGroup>
      <SettingGroup title="stOnPhone">
        <InfoRow title="stThumbCache" value={`${formatBytes(cache.bytes, t, digits)} / ${formatBytes(cache.capBytes, t, digits)}`} />
        <InfoRow title="stOffline" value={`${toDigits(Object.keys(offline).length, digits)} · ${formatBytes(offlineBytes, t, digits)}`} />
      </SettingGroup>
      <ToolNote text={t('stNote')} />
    </ToolScreen>
  );
}
