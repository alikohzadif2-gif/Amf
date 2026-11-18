import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { ToolButton, ToolNote, ToolScreen } from '@/components/settings/ToolScreen';
import { InfoRow, SettingGroup } from '@/components/settings/SettingRows';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf } from '@/src/lib/layout';
import { useLibraryIndex } from '@/src/library/index-store';
import { sourceKinds } from '@/src/library/providers';
import { formatBytes } from '@/src/library/ui/format';
import { loadUserData } from '@/src/library/user-data';
import { useSettingsStore } from '@/src/state/settings-store';
import { findDuplicates, type DuplicateReport } from '@/src/tools/duplicates';

const MAX_GROUPS_SHOWN = 100;
const KIND_LABEL: Record<string, TranslationKey> = { local: 'libSrcLocal', vault: 'libSrcVault', partner: 'galleryPartnerTitle' };

export default function DuplicatesScreen() {
  const colors = useColors();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const [report, setReport] = useState<DuplicateReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadUserData(db); }, [db]);

  const scan = async () => {
    setBusy(true);
    await useLibraryIndex.getState().build();
    setReport(findDuplicates(useLibraryIndex.getState().entries));
    setBusy(false);
  };

  const kinds = sourceKinds();
  return (
    <ToolScreen title="duplicateFinder" intro="dupIntro">
      <ToolButton label={t('dupScan')} onPress={scan} busy={busy} primary={!report} />
      {report ? (
        <>
          <SettingGroup>
            <InfoRow title="dupGroups" value={toDigits(report.groups.length, digits)} />
            <InfoRow title="dupWasted" value={formatBytes(report.wasted, t, digits)} />
          </SettingGroup>
          {report.groups.length === 0 ? <ToolNote text={t('dupNone')} /> : null}
          {report.groups.slice(0, MAX_GROUPS_SHOWN).map((group) => (
            <View key={group.md5} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), textAlign: alignOf(isRTL) }]}>
                {`${toDigits(group.entries.length, digits)} × ${formatBytes(group.size, t, digits)}`}
              </Text>
              {group.entries.map((entry) => (
                <Text key={entry.key} numberOfLines={1} style={[styles.line, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>
                  {`${entry.item.name} · ${[...new Set(entry.refs.map((r) => t(KIND_LABEL[kinds[r.sourceId]] ?? 'libSrcVault')))].join(' + ')}`}
                </Text>
              ))}
            </View>
          ))}
          {report.groups.length > MAX_GROUPS_SHOWN ? <ToolNote text={t('dupMore')} /> : null}
          <ToolNote text={t('dupReadOnly')} />
        </>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 10, gap: 4 },
  cardTitle: { fontSize: 14 },
  line: { fontSize: 12.5, lineHeight: 19 },
});
