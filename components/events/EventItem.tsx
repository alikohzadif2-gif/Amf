import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { EventPhoto } from '@/components/events/EventPhoto';
import { useColors } from '@/hooks/useColors';
import { eventIconOrDefault } from '@/src/events/icons';
import type { EventRow } from '@/src/events/events-db';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';

export type EventListItem = { event: EventRow; date: string; days: number };

/** Localised countdown label, using the selected digit style. */
export function useCountdownLabel() {
  const { t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  return (days: number) =>
    days === 0 ? t('eventToday') : days === 1 ? t('eventTomorrow') : days > 0 ? `${toDigits(days, digits)} ${t('eventDaysLeft')}` : `${toDigits(-days, digits)} ${t('eventDaysAgo')}`;
}

export function EventItem({ item }: { item: EventListItem }) {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, digits } = useSettingsStore();
  const label = useCountdownLabel();
  const { event } = item;
  const icon = eventIconOrDefault(event.icon);
  const text = (color: string, size: number, weight: 'regular' | 'medium' | 'semibold' = 'regular') => ({ color, fontFamily: fontFamilyFor(language, weight), fontSize: size, textAlign: alignOf(isRTL) } as const);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${formatDate(item.date, calendarMode, language, digits)}`}
      onPress={() => router.push({ pathname: '/event', params: { id: event.id } })}
      style={({ pressed }) => ({ direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL), alignItems: 'center', gap: 13, padding: 14, marginBottom: 10, borderRadius: 22, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.75 : 1 })}
    >
      <View style={{ width: 52, height: 52 }}>
        <View style={{ width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised }}>
          <MaterialCommunityIcons name={icon.mci as keyof typeof MaterialCommunityIcons.glyphMap} size={25} color={colors.primary} />
        </View>
        {/* R2: the event photo covers the tile on this card (past events too); the icon stays as a small badge */}
        {event.photoUri || event.photo ? (
          <>
            <EventPhoto event={event} size="thumb" style={{ position: 'absolute', width: 52, height: 52, borderRadius: 17 }} />
            <View style={{ position: 'absolute', bottom: -4, end: -4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
              <MaterialCommunityIcons name={icon.mci as keyof typeof MaterialCommunityIcons.glyphMap} size={13} color={colors.primary} />
            </View>
          </>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text numberOfLines={1} style={[text(colors.foreground, 15, 'semibold'), { flexShrink: 1 }]}>{event.title}</Text>
          {event.surprise ? <Text accessibilityLabel={t('eventSurprise')} style={{ fontSize: 14 }}>🤫</Text> : null}
        </View>
        <Text style={text(colors.mutedForeground, 12)}>{formatDate(item.date, calendarMode, language, digits)}{event.repeat ? ` · ${t('eventYearly')}` : ''}</Text>
        {event.description ? <Text numberOfLines={1} style={text(colors.mutedForeground, 12)}>{event.description}</Text> : null}
      </View>
      <View style={{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: 99, backgroundColor: item.days < 0 ? colors.raised : `${colors.primary}20`, maxWidth: 112 }}>
        <Text style={{ color: item.days < 0 ? colors.mutedForeground : colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 11, textAlign: 'center', flexShrink: 1 }}>{label(item.days)}</Text>
      </View>
    </Pressable>
  );
}
