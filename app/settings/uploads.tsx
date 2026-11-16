import { FlashList } from '@shopify/flash-list';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BackButton, Button, Card, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { backupMessage, uploadErrorKey, waitingKey } from '@/src/backup/messages';
import { formatBytes } from '@/src/library/ui/format';
import { backupNewMedia } from '@/src/backup/run-backup';
import type { UploadJob, UploadState } from '@/src/backup/queue';
import { useSettingsStore } from '@/src/state/settings-store';
import { uploadQueue, useUploadQueue } from '@/src/state/upload-queue-store';

const STATE_LABEL: Record<UploadState, TranslationKey> = {
  queued: 'uploadStateQueued',
  uploading: 'uploadStateUploading',
  done: 'uploadStateDone',
  failed: 'uploadStateFailed',
};

function JobRow({ job }: { job: UploadJob }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const percent = job.size > 0 ? Math.min(100, Math.round((job.sent / job.size) * 100)) : job.state === 'done' ? 100 : 0;
  const color = job.state === 'failed' ? colors.destructive : job.state === 'done' ? colors.primary : colors.mutedForeground;
  return (
    <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 13.5, textAlign: alignOf(isRTL) }}>
        {job.name}
      </Text>
      <View style={{ flexDirection: rowOf(isRTL), gap: 8, marginTop: 4 }}>
        <Text style={{ color, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 12 }}>
          {t(STATE_LABEL[job.state])}
          {job.state === 'uploading' ? ` · ${toDigits(percent, digits)}${digits === 'persian' ? '٪' : '%'}` : ''}
          {job.state === 'failed' ? ` · ${t(uploadErrorKey(job.error))}` : ''}
        </Text>
      </View>
      {job.state === 'uploading' ? (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: 6, overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${percent}%`, backgroundColor: colors.primary }} />
        </View>
      ) : null}
    </View>
  );
}

function SummaryCard() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const run = useUploadQueue((s) => s.run);
  const jobs = useUploadQueue((s) => s.jobs);
  const waiting = useUploadQueue((s) => s.waiting);
  const paused = useUploadQueue((s) => s.paused);
  const pending = jobs.filter((j) => j.state === 'queued' || j.state === 'uploading').length;
  const failed = jobs.filter((j) => j.state === 'failed').length;
  const wait = waitingKey(waiting);
  const n = (value: number) => toDigits(value, digits);
  const lines: [string, string][] = run
    ? [
        [t('backupSummaryChecked'), n(run.scanned)],
        [t('backupSummarySkipped'), n(run.skipped)],
        [t('backupSummaryUploaded'), `${n(run.uploaded)} · ${formatBytes(run.bytes, t, digits)}`],
        [t('backupSummaryWaiting'), n(pending)],
        [t('backupSummaryFailed'), n(failed)],
        ...(run.unreadable > 0 ? ([[t('backupSummaryUnreadable'), n(run.unreadable)]] as [string, string][]) : []),
      ]
    : [];
  return (
    <Card>
      <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: alignOf(isRTL), marginBottom: 8 }}>
        {t('backupSummaryTitle')}
      </Text>
      {wait && pending > 0 && !paused ? <Notice tone="warn">{t(wait)}</Notice> : null}
      {run ? (
        lines.map(([label, value]) => (
          <View key={label} style={{ flexDirection: rowOf(isRTL), justifyContent: 'space-between', paddingVertical: 3 }}>
            <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{label}</Text>
            <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13 }}>{value}</Text>
          </View>
        ))
      ) : (
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, textAlign: alignOf(isRTL) }}>
          {t('backupSummaryNone')}
        </Text>
      )}
    </Card>
  );
}

export default function UploadsScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const jobs = useUploadQueue((s) => s.jobs);
  const paused = useUploadQueue((s) => s.paused);
  const running = useUploadQueue((s) => s.running);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState(0);

  const count = (state: UploadState) => jobs.filter((j) => j.state === state).length;
  const waiting = count('queued') + count('uploading');
  const failed = count('failed');
  const done = count('done');

  const backup = async () => {
    setScanning(true);
    setFound(0);
    try {
      const outcome = await backupNewMedia(setFound);
      Alert.alert(t('backupNewMedia'), backupMessage(outcome, t, digits));
    } catch {
      Alert.alert(t('backupNewMedia'), t('uploadErrOther'));
    } finally {
      setScanning(false);
    }
  };

  const header = (
    <View>
      <BackButton />
      <Title title="uploadsTitle" intro="uploadsIntro" />
      <SummaryCard />
      <View style={{ gap: 10, marginBottom: 14 }}>
        <Button title="backupNewMedia" icon="upload-cloud" primary busy={scanning} onPress={() => void backup()} />
        {scanning ? <Notice>{`${t('backupScanning')} ${toDigits(found, digits)}`}</Notice> : null}
        <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 10 }}>
          {running && !paused ? (
            <Button title="uploadPause" icon="pause" onPress={() => uploadQueue.getState().pause()} />
          ) : waiting > 0 ? (
            <Button title="uploadResume" icon="play" onPress={() => void uploadQueue.getState().resume()} />
          ) : null}
          {failed > 0 ? <Button title="uploadRetry" icon="refresh-cw" onPress={() => void uploadQueue.getState().retryFailed()} /> : null}
          {done > 0 ? <Button title="uploadClear" icon="check" onPress={() => uploadQueue.getState().clearFinished()} /> : null}
        </View>
      </View>
      {jobs.length > 0 ? (
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, marginBottom: 6, textAlign: alignOf(isRTL) }}>
          {`${t('uploadStateQueued')} ${toDigits(waiting, digits)} · ${t('uploadStateDone')} ${toDigits(done, digits)} · ${t('uploadStateFailed')} ${toDigits(failed, digits)}`}
        </Text>
      ) : null}
    </View>
  );

  return (
    <ScreenFrame>
      <FlashList
        data={jobs}
        keyExtractor={(job) => job.id}
        renderItem={({ item }) => <JobRow job={item} />}
        ListHeaderComponent={header}
        ListEmptyComponent={<Notice>{t('uploadsEmpty')}</Notice>}
        showsVerticalScrollIndicator={false}
      />
    </ScreenFrame>
  );
}
