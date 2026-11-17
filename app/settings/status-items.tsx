import { Switch, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BackButton, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { HIDE_ALL, setNamesHidden } from '@/src/partner/status-categories';
import { resolveActivities, resolveMoods } from '@/src/partner/status-custom';
import { useSettingsStore } from '@/src/state/settings-store';

/** R3: choose which moods and activities the Status tab offers (a switch off = hidden; saved on this phone only). */
export default function StatusItemsScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const hiddenMoods = useSettingsStore((s) => s.hiddenMoods);
  const hiddenActivities = useSettingsStore((s) => s.hiddenActivities);
  const customMoods = useSettingsStore((s) => s.statusCustomMoods);
  const customActs = useSettingsStore((s) => s.statusCustomActivities);
  const labels = useSettingsStore((s) => s.statusLabels);
  const hiddenNames = useSettingsStore((s) => s.statusHiddenNames);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const toggle = (key: 'hiddenMoods' | 'hiddenActivities', list: string[], id: string, shown: boolean) =>
    setSetting(key, shown ? list.filter((x) => x !== id) : [...list, id]);

  const row = (key: string, emoji: string, label: string, shown: boolean, onChange: (v: boolean) => void) => (
    <View key={key} style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, minHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={{ fontSize: 24 }}>{emoji}</Text>
      <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 15, textAlign: isRTL ? 'right' : 'left' }}>{label}</Text>
      <Switch value={shown} onValueChange={onChange} accessibilityLabel={label} trackColor={{ false: colors.track, true: colors.switchOn }} thumbColor="#FFFFFF" />
    </View>
  );
  const heading = (text: string) => (
    <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13, marginTop: 18, marginBottom: 4, textAlign: isRTL ? 'right' : 'left' }}>{text}</Text>
  );

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="statusItems" intro="statusItemsIntro" />
      {/* Q5: one switch for every category chip and activity name (per category: press and hold its chip on the Status tab) */}
      <View style={{ marginTop: 14 }}>
        {row('names', '🔤', t('statusShowAllNames'), !hiddenNames.includes(HIDE_ALL), (v) => setSetting('statusHiddenNames', setNamesHidden(hiddenNames, HIDE_ALL, !v)))}
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, marginTop: 6, textAlign: isRTL ? 'right' : 'left' }}>{t('statusShowAllNamesDesc')}</Text>
      </View>
      {heading(t('statusMoodsTitle'))}
      {resolveMoods(customMoods, labels, t).map((m) => row(m.id, m.emoji, m.label, !hiddenMoods.includes(m.id), (v) => toggle('hiddenMoods', hiddenMoods, m.id, v)))}
      {heading(t('statusActivities'))}
      {resolveActivities(customActs, labels, t).map((a) => row(a.id, a.emoji, a.label, !hiddenActivities.includes(a.id), (v) => toggle('hiddenActivities', hiddenActivities, a.id, v)))}
    </ScreenFrame>
  );
}
