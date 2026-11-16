import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { EventItem } from '@/components/events/EventItem';
import { ConnectCardShell } from '@/components/home/ConnectCard';
import { LatestDiaryCard } from '@/components/home/LatestDiaryCard';
import { PartnerMoodCard, RecentMoodsStrip } from '@/components/home/HomeStatus';
import { DaysTogetherCard, LibraryShortcut, OnThisDayCard, SurfaceCard } from '@/components/home/HomeCards';
import { StoryRing } from '@/components/story/StoryRing';
import { useStories } from '@/src/stories/use-stories';
import { ringState } from '@/src/stories/story-logic';
import { Avatar } from '@/components/partner/Avatar';
import { Button } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { EmptyState, Fab, SectionLabel } from '@/components/ui';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useTabBarHeight } from '@/components/ui/useTabBarHeight';
import { useColors } from '@/hooks/useColors';
import { FEATURES } from '@/src/constants/features';
import { unreadChatCount } from '@/src/chat/chat-db';
import { listDiaryEntries, type DiaryRow } from '@/src/diary/diary-db';
import { listEvents, type EventRow } from '@/src/events/events-db';
import { isOnThisDay, todayIso, yearsAgo, type EventCal } from '@/src/events/recurrence';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { showConnectCard, togetherParts, weekItems } from '@/src/lib/home';
import { useLibraryIndex } from '@/src/library/index-store';
import { latestMood, listMoods } from '@/src/partner/mood-db';
import type { MoodRow } from '@/src/partner/types';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshApp } from '@/src/partner/refresh';

/** Home: profile + together counter + heading/direct icon, Connect shell, This week, On this day, Library shortcut, camera FAB. */
export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, digits, weekStart } = useSettingsStore();
  const { paired, partner, me, togetherSince, moodTick, eventTick, diaryTick, chatTick } = usePartnerStore();
  // Unread direct messages: the red number on the Direct icon (counted again whenever a message arrives or the chat marks them read).
  const [unreadChat, setUnreadChat] = useState(0);
  useEffect(() => {
    let active = true;
    unreadChatCount(db).then((n) => { if (active) setUnreadChat(n); }).catch(() => undefined);
    return () => { active = false; };
  }, [db, chatTick]);
  const kind: EventCal = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  const today = todayIso();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [mood, setMood] = useState<MoodRow | null>(null);
  const [diary, setDiary] = useState<DiaryRow[]>([]); // my latest memories, newest first
  const [recentMoods, setRecentMoods] = useState<MoodRow[]>([]); // partner's last 4 statuses, oldest first
  // "On this day" uses the Library only if it is already indexed: Home never starts a big scan by itself.
  const library = useLibraryIndex((s) => s.entries);
  const stories = useStories();
  const myRing = ringState(stories.mine, true);
  const partnerRing = ringState(stories.partner, false);
  const [avatarMenu, setAvatarMenu] = useState(false);
  const sheetOffset = useTabBarHeight() + 8;

  useEffect(() => {
    void listEvents(db).then(setEvents);
  }, [db, eventTick]);
  useEffect(() => {
    void listDiaryEntries(db).then((rows) => setDiary(rows.slice(0, 5)));
  }, [db, diaryTick]);
  useEffect(() => {
    void latestMood(db, false).then(setMood);
    void listMoods(db, 60).then((rows) => setRecentMoods(rows.filter((m) => !m.fromMe).slice(0, 4).reverse()));
  }, [db, moodTick]);

  const week = useMemo(() => weekItems(events, today, weekStart), [events, today, weekStart]);
  const earlierEvents = useMemo(() => events.filter((e) => isOnThisDay(e.date, today, e.cal)), [events, today]);
  const earlierMedia = useMemo(
    () => library.filter((e) => (e.item.type === 'image' || e.item.type === 'video') && isOnThisDay(e.item.mtime, today, kind)).slice(0, 6),
    [library, today, kind],
  );

  const text = (color: string, size: number, weight: 'regular' | 'medium' | 'semibold' = 'regular') => ({ color, fontFamily: fontFamilyFor(language, weight), fontSize: size, textAlign: alignOf(isRTL) } as const);
  const together = togetherSince ? togetherParts(togetherSince, today, kind) : null;

  const connect = showConnectCard(FEATURES.partner, paired);

  return (
    <View style={{ flex: 1 }}>
    <ScreenFrame scroll tabBar onRefresh={refreshApp}>
      {/* Home header: profile + compact together counter, centered title, and the Direct chat entry point. */}
      <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, minHeight: 52, position: 'relative' }}>
        <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 6, flexShrink: 1, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: 28, paddingHorizontal: 5, paddingVertical: 4, zIndex: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={myRing === 'none' ? t('settings') : t('storyMenuTitle')}
            hitSlop={8}
            onPress={() => (myRing === 'none' ? router.push('/settings') : setAvatarMenu(true))}
          >
            <StoryRing state={myRing} size={44}>
              <Avatar b64={me.avatarB64} uri={me.avatarUri} name={me.name} size={44} />
            </StoryRing>
          </Pressable>
          <DaysTogetherCard parts={together} onSet={() => router.push('/settings/profile')} />
        </View>
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 48 }}>
          <Text numberOfLines={1} style={text(colors.foreground, 17, 'semibold')}>{t('homeWhatsUp')}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={unreadChat > 0 ? `${t('chatTitle')} (${toDigits(unreadChat, digits)})` : t('chatTitle')}
          hitSlop={10}
          onPress={() => router.push('/chat')}
          style={{ width: 34, height: 40, alignItems: 'center', justifyContent: 'center', zIndex: 1 }}
        >
          <Feather name="send" size={23} color={colors.foreground} />
          {unreadChat > 0 ? (
            // Instagram-style badge: red circle with the number of unread messages on the icon's top corner.
            <View pointerEvents="none" style={{ position: 'absolute', top: 1, right: -5, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#FF3040', alignItems: 'center', justifyContent: 'center' }}>
              <Text allowFontScaling={false} style={{ color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontFamily: fontFamilyFor(language, 'bold') }}>{unreadChat > 99 ? `${toDigits(99, digits)}+` : toDigits(unreadChat, digits)}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <RecentMoodsStrip moods={recentMoods} />

      {connect === 'shell' ? (
        <ConnectCardShell />
      ) : connect === 'pair' ? (
        <SurfaceCard>
          <Text style={text(colors.foreground, 17, 'semibold')}>{t('homeAddPartnerTitle')}</Text>
          <Text style={[text(colors.mutedForeground, 13), { marginVertical: 8, lineHeight: 21 }]}>{t('homeAddPartnerBody')}</Text>
          <Button title="pairPartner" primary icon="user-plus" onPress={() => router.push('/settings/pair')} />
        </SurfaceCard>
      ) : (
        <PartnerMoodCard
          partner={partner}
          mood={mood}
          onPress={() => router.push('/status')}
          avatarWrap={(avatar) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('storyViewPartner')}
              disabled={partnerRing === 'none'}
              onPress={() => router.push({ pathname: '/story/view', params: { who: 'partner' } })}
            >
              <StoryRing state={partnerRing} size={58}>{avatar}</StoryRing>
            </Pressable>
          )}
        />
      )}

      {diary.length > 0 ? <SectionLabel label={t('homeLatestDiary')} /> : null}
      <LatestDiaryCard entries={diary} onOpen={(id) => router.push(`/diary/${encodeURIComponent(id)}` as never)} />

      <SectionLabel label={t('homeThisWeek')} trailing={`${toDigits(week.length, digits)} ${t('homeEventsCount')}`} />
      {week.length === 0 ? (
        <View style={{ marginBottom: 18 }}>
          <EmptyState message={t('homeNoEventsWeek')} />
        </View>
      ) : (
        <View style={{ marginBottom: 8 }}>{/* Q6: each EventItem is already a card (same as the Events tab): no extra frame around the list */}
          {week.map((it) => (
            <EventItem key={`${it.event.id}-${it.date}`} item={it} />
          ))}
        </View>
      )}

      <OnThisDayCard events={earlierEvents} years={(e) => yearsAgo(e.date, today, e.cal)} media={earlierMedia} />
      <LibraryShortcut onPress={() => router.push('/library')} />
    </ScreenFrame>
    <Fab floating aboveTabBar icon="camera" onPress={() => router.push('/story/new')} accessibilityLabel={t('storyNew')} />
    <BottomSheet visible={avatarMenu} onClose={() => setAvatarMenu(false)} title={t('storyMenuTitle')} cancelLabel={t('cancel')} bottomOffset={sheetOffset}>
      {([
        { icon: 'eye', label: t('storyMenuView'), go: () => router.push({ pathname: '/story/view', params: { who: 'me' } }) },
        { icon: 'settings', label: t('settings'), go: () => router.push('/settings') },
      ] as const).map((row) => (
        <Pressable
          key={row.icon}
          accessibilityRole="button"
          onPress={() => {
            setAvatarMenu(false);
            row.go();
          }}
          style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border }}
        >
          <Feather name={row.icon} size={20} color={colors.foreground} />
          <Text style={text(colors.foreground, 16, 'medium')}>{row.label}</Text>
        </Pressable>
      ))}
    </BottomSheet>
    </View>
  );
}
