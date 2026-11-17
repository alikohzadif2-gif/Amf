import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import {
  ActionRow,
  InfoRow,
  SelectRow,
  SettingGroup,
  SliderRow,
  SwitchRow,
} from '@/components/settings/SettingRows';
import { useI18n } from '@/src/i18n';
import { formatBytes } from '@/src/library/ui/format';
import { cacheStats, clearThumbCache, enforceCap } from '@/src/media/thumb-cache';
import { clearPartnerPreviews, enforcePartnerCap, partnerMediaStats } from '@/src/partner/media-store';
import { useSettingsStore } from '@/src/state/settings-store';

export default function MediaCacheSection() {
  const { t } = useI18n();
  const router = useRouter();
  const s = useSettingsStore();
  const set = s.setSetting;
  const db = useSQLiteContext();
  const [usage, setUsage] = useState(() => cacheStats().bytes);
  const [partnerUsage, setPartnerUsage] = useState(0);
  const refreshPartner = () => void partnerMediaStats(db).then((st) => setPartnerUsage(st.thumbBytes + st.previewBytes)).catch(() => undefined);

  useEffect(() => {
    enforceCap();
    setUsage(cacheStats().bytes);
  }, [s.thumbCacheMb]);

  useEffect(() => {
    void enforcePartnerCap(db).then(refreshPartner).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.partnerCacheMb]);

  return (
    <>
      <SettingGroup>
        <SliderRow
          title="thumbCache"
          description="thumbCacheDesc"
          value={s.thumbCacheMb}
          min={100}
          max={2000}
          step={50}
          onChange={(v) => set('thumbCacheMb', v)}
          formatValue={(v) => `${v} ${t('unitMb')}`}
        />
        <SelectRow
          title="previewQuality"
          value={s.previewQuality}
          onChange={(v) => set('previewQuality', v)}
          options={[
            { value: 'low', label: 'qualityLow' },
            { value: 'medium', label: 'qualityMedium' },
            { value: 'high', label: 'qualityHigh' },
          ]}
        />
        <SelectRow
          title="videoMode"
          value={s.videoMode}
          onChange={(v) => set('videoMode', v)}
          options={[
            { value: 'stream', label: 'videoStream' },
            { value: 'download', label: 'videoDownload' },
          ]}
        />
      </SettingGroup>
      <SettingGroup>
        <SliderRow
          title="partnerCache"
          description="partnerCacheDesc"
          value={s.partnerCacheMb}
          min={50}
          max={2000}
          step={50}
          onChange={(v) => set('partnerCacheMb', v)}
          formatValue={(v) => `${v} ${t('unitMb')}`}
        />
        <SwitchRow
          title="sharePreviewWifi"
          description="sharePreviewWifiDesc"
          value={s.sharePreviewWifiOnly}
          onChange={(v) => set('sharePreviewWifiOnly', v)}
        />
        <InfoRow title="partnerCacheUsage" value={formatBytes(partnerUsage, t, s.digits)} />
        <ActionRow
          title="partnerCacheClear"
          icon="trash-2"
          onPress={() => {
            void clearPartnerPreviews(db).then(refreshPartner).catch(() => undefined);
          }}
        />
      </SettingGroup>
      <SettingGroup>
        <SwitchRow
          title="dataSaver"
          description="dataSaverDesc"
          value={s.dataSaver}
          onChange={(v) => set('dataSaver', v)}
        />
      </SettingGroup>
      <SettingGroup>
        <InfoRow title="cacheUsage" value={formatBytes(usage, t, s.digits)} />
        <ActionRow
          title="cacheClear"
          icon="trash-2"
          onPress={() => {
            clearThumbCache();
            setUsage(cacheStats().bytes);
          }}
        />
        <ActionRow title="offlineAlbums" onPress={() => router.push('/library?view=albums')} />
      </SettingGroup>
    </>
  );
}
