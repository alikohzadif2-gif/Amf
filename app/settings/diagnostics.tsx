import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Platform, Share, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { ToolButton, ToolNote, ToolScreen } from '@/components/settings/ToolScreen';
import { useColors } from '@/hooks/useColors';
import { clearLog, getLog, logEvent } from '@/src/diagnostics/log';
import { buildReport } from '@/src/diagnostics/report';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { uploadQueue } from '@/src/state/upload-queue-store';
import { useSettingsStore, type SettingsValues } from '@/src/state/settings-store';
import { useSourcesStore } from '@/src/state/sources-store';

function currentReport(): string {
  const values = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const settings: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'function') continue;
    settings[key as keyof SettingsValues] = value as string | number | boolean;
  }
  const jobs = uploadQueue.getState().jobs;
  const uploads: Record<string, number> = {};
  for (const job of jobs) uploads[job.state] = (uploads[job.state] ?? 0) + 1;
  return buildReport({
    appVersion: Constants.expoConfig?.version ?? '—',
    platform: `${Platform.OS} ${String(Platform.Version)}`,
    language: useSettingsStore.getState().language,
    generatedAt: new Date().toISOString(),
    settings,
    sources: useSourcesStore.getState().sources.map((s) => ({ id: s.id, kind: s.kind, backend: s.backend, enabled: s.enabled })),
    uploads,
    failures: jobs.filter((j) => j.state === 'failed').map((j) => ({ name: j.name, code: j.error ?? 'error' })),
    log: getLog(),
  });
}

export default function DiagnosticsScreen() {
  const colors = useColors();
  const { language, t } = useI18n();
  const [, refresh] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const lines = [...getLog()].reverse();

  const share = async () => {
    setStatus(null);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setStatus(t('dgNoShare'));
        return;
      }
      const file = new File(Paths.cache, 'meyou-diagnostics.txt');
      file.create({ overwrite: true });
      file.write(currentReport());
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: t('diagnostics') });
    } catch {
      setStatus(t('dgNoShare'));
    }
  };

  // Opens the system share sheet with the whole log as text: pick "Copy" there (or any chat app).
  const copy = async () => {
    setStatus(null);
    try {
      await Share.share({ message: currentReport() });
    } catch {
      setStatus(t('dgNoShare'));
    }
  };

  return (
    <ToolScreen title="diagnostics" intro="dgIntro">
      <ToolButton label={t('dgCopy')} onPress={() => void copy()} />
      <ToolButton label={t('dgShare')} primary={false} onPress={() => void share()} />
      <ToolButton label={t('dgRefresh')} primary={false} onPress={() => refresh((n) => n + 1)} />
      <ToolButton
        label={t('dgClear')}
        primary={false}
        onPress={() => {
          clearLog();
          logEvent('info', 'log cleared');
          refresh((n) => n + 1);
        }}
      />
      {status ? <ToolNote text={status} /> : null}
      {lines.length === 0 ? <ToolNote text={t('dgEmpty')} /> : null}
      <View style={[styles.box, { backgroundColor: colors.card, borderColor: colors.border, display: lines.length ? 'flex' : 'none' }]}>
        {lines.map((line, i) => (
          <Text key={`${line.t}-${i}`} selectable style={[styles.line, { color: line.level === 'error' ? colors.destructive : colors.mutedForeground, fontFamily: fontFamilyFor('en'), textAlign: 'left', writingDirection: 'ltr' }]}>
            {`${line.t.slice(0, 19).replace('T', ' ')} ${line.msg}`}
          </Text>
        ))}
      </View>
      <ToolNote text={t('dgPrivacy')} />
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 14, gap: 4 },
  line: { fontSize: 11.5, lineHeight: 17 },
});
