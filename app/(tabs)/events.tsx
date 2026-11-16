import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { Text } from '@/components/ui/ScaledText';
import { EventItem, type EventListItem as Item } from '@/components/events/EventItem';
import { ScreenFrame } from '@/components/ScreenFrame';
import { EmptyState, Fab } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { listEvents, type EventRow } from '@/src/events/events-db';
import { countdown, dayIso, daysBetween, isoIn, monthRange, occurrencesBetween, partsIn, todayIso, type EventCal } from '@/src/events/recurrence';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { buildMonthGrid, calendarMonthName, getWeekdayLabels, toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshApp } from '@/src/partner/refresh';

export default function EventsScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, weekStart, digits } = useSettingsStore();
  const tick = usePartnerStore((s) => s.eventTick);
  const kind: EventCal = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  const today = todayIso();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [view, setView] = useState<'list' | 'month'>('list');
  const [period, setPeriod] = useState<'upcoming' | 'past'>('upcoming');
  const start = partsIn(kind, today);
  const [ym, setYm] = useState({ y: start.y, m: start.m });
  const [selected, setSelected] = useState(today);

  useEffect(() => { void listEvents(db).then(setEvents); }, [db, tick]);
  useEffect(() => {
    setYm(start);
    setSelected(today);
  }, [kind, today]);

  const listItems = useMemo<Item[]>(() => events.flatMap((event) => {
    const c = countdown(event, today);
    if (period === 'upcoming') return c ? [{ event, date: c.date, days: c.days }] : [];
    return c ? [] : [{ event, date: dayIso(event.date), days: daysBetween(today, event.date) }];
  }).sort((a, b) => period === 'upcoming' ? a.days - b.days : b.days - a.days), [events, period, today]);

  const monthMarks = useMemo(() => {
    const range = monthRange(kind, ym.y, ym.m);
    const marks = new Map<string, Item[]>();
    for (const event of events) {
      for (const date of occurrencesBetween(event, range.start, range.end)) {
        marks.set(date, [...(marks.get(date) ?? []), { event, date, days: daysBetween(today, date) }]);
      }
    }
    return marks;
  }, [events, kind, ym, today]);
  const grid = useMemo(() => buildMonthGrid(kind, ym.y, ym.m, weekStart), [kind, ym, weekStart]);
  const moveMonth = (delta: number) => {
    const n = ym.m - 1 + delta;
    const next = { y: ym.y + Math.floor(n / 12), m: (((n % 12) + 12) % 12) + 1 };
    const selectedDay = partsIn(kind, selected).d;
    const lastDay = partsIn(kind, monthRange(kind, next.y, next.m).end).d;
    setYm(next);
    setSelected(isoIn(kind, next.y, next.m, Math.min(selectedDay, lastDay)));
  };
  const onDay = monthMarks.get(selected) ?? [];
  const viewToggle = (
    <Pressable accessibilityRole="button" accessibilityLabel={view === 'month' ? t('eventViewList') : t('eventViewMonth')} accessibilityState={{ selected: view === 'month' }} onPress={() => setView((v) => v === 'list' ? 'month' : 'list')} hitSlop={10} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: view === 'month' ? `${colors.primary}24` : colors.card, borderWidth: 1, borderColor: view === 'month' ? colors.primary : colors.border }}>
      <Feather name={view === 'month' ? 'list' : 'calendar'} size={20} color={view === 'month' ? colors.primary : colors.foreground} />
    </Pressable>
  );

  return (
    <ScreenFrame scroll tabBar onRefresh={refreshApp}>
      {view === 'list' ? (
        <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', marginTop: 8, marginBottom: 22, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flex: 1, flexDirection: rowOf(isRTL) }}>
            {(['upcoming', 'past'] as const).map((p) => {
              const active = period === p;
              const key = p === 'upcoming' ? 'eventUpcoming' : 'eventPast';
              return <Pressable key={p} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => setPeriod(p)} style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderBottomWidth: active ? 3 : 0, borderBottomColor: colors.primary, marginBottom: -1 }}>
                <Text style={{ color: active ? colors.foreground : colors.mutedForeground, fontFamily: fontFamilyFor(language, active ? 'semibold' : 'medium'), fontSize: 16 }}>{t(key)}</Text>
              </Pressable>;
            })}
          </View>
          {viewToggle}
        </View>
      ) : <View style={{ flexDirection: rowOf(isRTL), justifyContent: 'flex-end', marginTop: 8, marginBottom: 14 }}>{viewToggle}</View>}

      {view === 'list' ? (
        <>
          {listItems.length === 0 ? (
            <View style={{ flex: 1, minHeight: 320, justifyContent: 'center' }}>
              <EmptyState message={t(period === 'upcoming' ? 'eventUpcomingEmpty' : 'eventPastEmpty')} actionLabel={t('eventSetNextDate')} actionIcon="heart" onAction={() => router.push('/event')} />
            </View>
          ) : listItems.map((item) => <EventItem key={`${item.event.id}:${item.date}`} item={item} />)}
        </>
      ) : (
        <>
          <View style={{ borderRadius: 24, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 14 }}>
            <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <Pressable accessibilityRole="button" accessibilityLabel={t('prevMonth')} onPress={() => moveMonth(-1)} hitSlop={10}>
                <Feather name={isRTL ? 'chevron-right' : 'chevron-left'} size={22} color={colors.foreground} />
              </Pressable>
              <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 16 }}>{calendarMonthName(kind, ym.m, language)} {toDigits(ym.y, digits)}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('nextMonth')} onPress={() => moveMonth(1)} hitSlop={10}>
                <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={22} color={colors.foreground} />
              </Pressable>
            </View>
            <View style={{ flexDirection: rowOf(isRTL), marginBottom: 6 }}>
              {getWeekdayLabels(language, weekStart).map((w, i) => <Text key={i} style={{ flex: 1, textAlign: 'center', color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 11 }}>{w}</Text>)}
            </View>
            {Array.from({ length: 6 }, (_, row) => <View key={row} style={{ flexDirection: rowOf(isRTL) }}>
              {grid.slice(row * 7, row * 7 + 7).map((cell, i) => {
                const isSel = cell.isoDate === selected;
                const has = cell.isoDate ? monthMarks.has(cell.isoDate) : false;
                return <Pressable key={i} disabled={!cell.isoDate} accessibilityRole="button" accessibilityState={{ selected: isSel }} onPress={() => cell.isoDate && setSelected(cell.isoDate)} style={{ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                  {cell.day ? <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: isSel ? colors.primary : 'transparent', borderWidth: cell.isoDate === today && !isSel ? 1 : 0, borderColor: colors.primary }}>
                    <Text style={{ color: isSel ? colors.primaryForeground : colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{toDigits(cell.day, digits)}</Text>
                    {has ? <View style={{ position: 'absolute', bottom: 2, width: 5, height: 5, borderRadius: 3, backgroundColor: isSel ? colors.primaryForeground : colors.primary }} /> : null}
                  </View> : null}
                </Pressable>;
              })}
            </View>)}
          </View>
          {onDay.length === 0 ? <View style={{ paddingVertical: 14 }}><Text style={{ color: colors.mutedForeground, textAlign: 'center', fontFamily: fontFamilyFor(language), fontSize: 14 }}>{t('eventNoneOnDay')}</Text></View> : onDay.map((item) => <EventItem key={item.event.id} item={item} />)}
        </>
      )}
      <Fab icon="calendar" floating aboveTabBar accessibilityLabel={t('eventAdd')} onPress={() => router.push({ pathname: '/event', params: view === 'month' ? { date: selected } : {} })} />
    </ScreenFrame>
  );
}
