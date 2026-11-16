import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert, Linking } from 'react-native';
import {
  ActionRow,
  NavRow,
  SelectRow,
  SettingGroup,
  SwitchRow,
} from '@/components/settings/SettingRows';
import { Notice } from '@/components/server/ui';
import { backupNewData, backupNewMedia } from '@/src/backup/run-backup';
import { backupMessage } from '@/src/backup/messages';
import { resetGalleryBackup } from '@/src/backup/reset';
import { useI18n } from '@/src/i18n';
import { useSettingsStore } from '@/src/state/settings-store';

/** Settings > Backup & restore (S6): what to back up, when, and "Back up now". */
export default function BackupRestoreSection() {
  const s = useSettingsStore();
  const set = s.setSetting;
  const router = useRouter();
  const db = useSQLiteContext();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  /** New memories, events and Archive files (not the gallery). */
  const backupNow = async () => {
    setBusy(true);
    try {
      const data = await backupNewData(db);
      Alert.alert(t('backupNow'), t(data.code === 'queued' ? 'backupDataQueued' : data.code === 'nothing-new' ? 'backupDataNothingNew' : data.code === 'off' ? 'backupAllOff' : 'uploadErrOther'));
      if (data.code === 'queued') router.push('/settings/uploads');
    } catch {
      Alert.alert(t('backupNow'), t('uploadErrOther'));
    } finally {
      setBusy(false);
    }
  };

  /** The phone gallery, by hand, from the chosen albums. */
  const backupGallery = async () => {
    setBusy(true);
    try {
      const outcome = await backupNewMedia();
      Alert.alert(t('backupGalleryNow'), backupMessage(outcome, t, s.digits));
      if (outcome.code === 'done' && outcome.queued > 0) router.push('/settings/uploads');
    } catch {
      Alert.alert(t('backupGalleryNow'), t('uploadErrOther'));
    } finally {
      setBusy(false);
    }
  };

  const reset = () =>
    Alert.alert(t('backupResetTitle'), t('backupResetBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('backupResetConfirm'),
        style: 'destructive',
        onPress: () => {
          resetGalleryBackup();
          void Linking.openSettings().catch(() => undefined);
        },
      },
    ]);

  return (
    <>
      <SettingGroup>
        <ActionRow title="backupNow" icon="upload-cloud" busy={busy} onPress={() => void backupNow()} />
        <NavRow title="uploadsOpen" description="uploadsOpenDesc" onPress={() => router.push('/settings/uploads')} />
      </SettingGroup>

      <SettingGroup title="backupGroupNew">
        <SwitchRow title="backupAuto" description="backupAutoDesc" value={s.backupAuto} onChange={(v) => set('backupAuto', v)} />
        <SelectRow
          title="backupMode"
          value={s.backupMode}
          onChange={(v) => set('backupMode', v)}
          options={[
            { value: 'copy', label: 'backupModeCopy' },
            { value: 'move', label: 'backupModeMove' },
          ]}
        />
        <SwitchRow title="backupMemories" description="backupMemoriesDesc" value={s.backupMemories} onChange={(v) => set('backupMemories', v)} />
        <SwitchRow title="backupEvents" description="backupEventsDesc" value={s.backupEvents} onChange={(v) => set('backupEvents', v)} />
        <SwitchRow title="backupArchive" description="backupArchiveDesc" value={s.backupArchive} onChange={(v) => set('backupArchive', v)} />
      </SettingGroup>
      <Notice>{t(s.backupMode === 'move' ? 'backupModeMoveNote' : 'backupModeCopyNote')}</Notice>

      <SettingGroup title="backupGroupWhen">
        <SwitchRow title="backupWifiOnly" description="backupWifiOnlyDesc" value={s.backupWifiOnly} onChange={(v) => set('backupWifiOnly', v)} />
        <SwitchRow title="backupChargingOnly" description="backupChargingOnlyDesc" value={s.backupChargingOnly} onChange={(v) => set('backupChargingOnly', v)} />
      </SettingGroup>

      <SettingGroup title="backupGroupGallery">
        <ActionRow title="backupGalleryNow" icon="image" busy={busy} onPress={() => void backupGallery()} />
        <SwitchRow title="backupPhotos" description="backupPhotosDesc" value={s.backupPhotos} onChange={(v) => set('backupPhotos', v)} />
        <SwitchRow title="backupVideos" description="backupVideosDesc" value={s.backupVideos} onChange={(v) => set('backupVideos', v)} />
        <SelectRow
          title="backupScope"
          value={s.backupScope}
          onChange={(v) => set('backupScope', v)}
          options={[
            { value: 'camera', label: 'backupScopeCamera' },
            { value: 'all', label: 'backupScopeAll' },
            { value: 'selected', label: 'backupScopeSelected' },
          ]}
        />
        {s.backupScope === 'selected' ? (
          <NavRow title="backupAlbumsPick" description="backupAlbumsPickDesc" onPress={() => router.push('/settings/backup-albums')} />
        ) : null}
        <ActionRow title="backupReset" icon="rotate-ccw" onPress={reset} />
      </SettingGroup>
      <Notice>{t('backupResetNote')}</Notice>
      <Notice>{t('backupNote')}</Notice>
    </>
  );
}
