import { useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useSQLiteContext } from 'expo-sqlite';
import { BottomSheet } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { FEATURES } from '@/src/constants/features';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { deleteMood, listMoods, listMyStatusHistory } from '@/src/partner/mood-db';
import { findActivity, findMood, resolveActivities, resolveMoods } from '@/src/partner/status-custom';
import type { MoodRow } from '@/src/partner/types';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

/** Date in the chosen calendar ("both" uses Jalali) + the phone's local time, in the chosen digits. Stored dates stay UTC. */
function useWhen() {
  const { language } = useI18n();
  const { calendarMode, digits } = useSettingsStore();
  return (ts: string) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${formatDate(ts, calendarMode === 'both' ? 'jalali' : calendarMode, language, digits)} ${toDigits(`${pad(d.getHours())}:${pad(d.getMinutes())}`, digits)}`;
  };
}

function Row({ row, onDelete }: { row: MoodRow; onDelete: () => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const partner = usePartnerStore((s) => s.partner);
  const when = useWhen();
  const customMoods = useSettingsStore((s) => s.statusCustomMoods);
  const customActs = useSettingsStore((s) => s.statusCustomActivities);
  const labels = useSettingsStore((s) => s.statusLabels);
  // My rows use my own wording (custom/edited); the partner's rows keep the name their phone shows plus the text they sent (Q4).
  const mood = findMood(resolveMoods(row.fromMe ? customMoods : [], row.fromMe ? labels : {}, t), row.emoji);
  const activity = row.fromMe ? findActivity(resolveActivities(customActs, labels, t), row.activity) : undefined;
  const who = row.fromMe ? null : partner?.name || t('partnerDefaultName');
  const text = (color: string, size: number, weight: 'regular' | 'medium' | 'semibold' = 'regular') => ({ color, fontFamily: fontFamilyFor(language, weight), fontSize: size, textAlign: alignOf(isRTL) }) as const;
  return (
    <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 10 }}>
      <Text style={{ fontSize: 30 }}>{row.emoji}</Text>
      <View style={{ flex: 1 }}>
        <Text style={text(colors.foreground, 15, 'semibold')}>
          {who ? `${who} · ` : ''}
          {mood ? `${t('statusFeeling')} ${mood.label}` : row.emoji}
        </Text>
        {activity ? <Text style={text(colors.foreground, 13.5)}>{`${activity.emoji} ${activity.label}`}</Text> : null}
        {row.text && !(row.fromMe && mood) ? <Text style={[text(colors.foreground, 13), { lineHeight: 20 }]}>{row.text}</Text> : null}
        <Text style={text(colors.mutedForeground, 12)}>{when(row.ts)}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={t('moodDeleteItem')} hitSlop={10} onPress={onDelete} style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}>
        <Feather name="trash-2" size={18} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

/** Recent statuses (mine; with the partner flag on, both sides). Opens from the clock button of the Status tab. Render as the last child of a screen. */
export function HistorySheet({ visible, onClose, refreshKey }: { visible: boolean; onClose: () => void; refreshKey: number }) {
  const db = useSQLiteContext();
  const { t } = useI18n();
  const colors = useColors();
  const [rows, setRows] = useState<MoodRow[]>([]);
  const load = () => (FEATURES.partner ? listMoods(db, 50) : listMyStatusHistory(db, 50)).then(setRows);
  useEffect(() => {
    if (!visible) return;
    void load();
  }, [db, visible, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = (id: number) => {
    void deleteMood(db, id).then(() => {
      usePartnerStore.getState().bumpMoods(); // Status (recents, current card) and Home refresh
      return load();
    });
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('moodHistory')} cancelLabel={t('cancel')}>
      {rows.length === 0 ? (
        <Text style={{ color: colors.mutedForeground, textAlign: 'center', paddingVertical: 28, fontSize: 15 }}>{t('moodEmpty')}</Text>
      ) : (
        rows.map((r) => <Row key={r.id} row={r} onDelete={() => remove(r.id)} />)
      )}
    </BottomSheet>
  );
}
