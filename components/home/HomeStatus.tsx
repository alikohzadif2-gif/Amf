import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, Pressable as RNPressable, View as RNView } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/ui/ScaledText';
import { Avatar } from '@/components/partner/Avatar';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { msUntilAgoChanges, timeAgo } from '@/src/lib/home';
import { FLOAT_DISTANCE, FLOAT_HALF_MS } from '@/src/lib/motion';
import { alignOf, rowOf } from '@/src/lib/layout';
import { activityById } from '@/src/partner/activities';
import { MOOD_CARD_ALPHA, moodColorsFor } from '@/src/partner/mood-colors';
import { moodByEmoji } from '@/src/partner/moods';
import type { MoodRow, Profile } from '@/src/partner/types';
import { useSettingsStore } from '@/src/state/settings-store';

/** Home header (reference clip): my avatar (opens Settings), the "What's up?" title with a coral underline, and the bell (notification settings). */
export function HomeHeader({ me, onAvatar, onBell }: { me: Profile & { avatarUri?: string }; onAvatar: () => void; onBell: () => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <RNView style={[styles.header, { flexDirection: rowOf(isRTL) }]}>
      <RNPressable accessibilityRole="button" accessibilityLabel={t('settings')} hitSlop={8} onPress={onAvatar} style={styles.side}>
        <Avatar b64={me.avatarB64} uri={me.avatarUri} name={me.name} size={44} />
      </RNPressable>
      <RNView style={styles.titleWrap}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 19 }}>{t('homeWhatsUp')}</Text>
        <RNView style={[styles.underline, { backgroundColor: colors.primary }]} />
      </RNView>
      <RNPressable accessibilityRole="button" accessibilityLabel={t('homeNotifications')} hitSlop={8} onPress={onBell} style={[styles.side, { alignItems: 'center' }]}>
        <Feather name="bell" size={24} color={colors.foreground} />
      </RNPressable>
    </RNView>
  );
}

const STRIP_CELL = 40;
const STRIP_LABEL_W = 80;
const STRIP_LINE_W = 36;

/**
 * "Recent moods": the partner's last statuses as a line, Oldest on the first side and Current on the other, all at the same size.
 * Needs two or more statuses, otherwise nothing is drawn.
 */
export function RecentMoodsStrip({ moods }: { moods: MoodRow[] }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  if (moods.length < 2) return null;
  const last = moods.length - 1;
  const edge = isRTL ? 'flex-end' : 'flex-start';
  const label = { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12.5, width: STRIP_LABEL_W, marginHorizontal: -(STRIP_LABEL_W - STRIP_CELL) / 2, textAlign: 'center' } as const;
  return (
    <RNView style={{ marginBottom: 18 }}>
      <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: alignOf(isRTL), marginBottom: 12 }}>{t('homeRecentMoods')}</Text>
      {/* Fixed-size cells + short fixed lines (like the reference), all emojis equal and fully opaque; the strip hugs the start side. */}
      <RNView style={{ alignSelf: edge }}>
        <RNView style={[styles.strip, { flexDirection: rowOf(isRTL) }]}>
          {moods.map((mood, index) => (
            <RNView key={mood.id} style={{ flexDirection: rowOf(isRTL), alignItems: 'center' }}>
              {index === 0 ? null : <RNView style={[styles.stripLine, { backgroundColor: colors.border }]} />}
              <RNView style={styles.stripCell}>
                <Text style={{ fontSize: 24, lineHeight: 32 }}>{mood.emoji}</Text>
              </RNView>
            </RNView>
          ))}
        </RNView>
        <RNView style={[styles.stripLabels, { flexDirection: rowOf(isRTL) }]}>
          <RNView style={{ width: STRIP_CELL }}><Text numberOfLines={1} style={label}>{t('homeOldest')}</Text></RNView>
          <RNView style={{ width: STRIP_CELL }}><Text numberOfLines={1} style={label}>{t('homeCurrent')}</Text></RNView>
        </RNView>
      </RNView>
    </RNView>
  );
}

/**
 * The current time for "N minutes ago", counted from the moment the status was set: it is refreshed exactly when the label
 * changes (and again when the app comes back to the foreground), so an open Home never shows a stale "5 minutes ago".
 */
function useNowFrom(ts: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ts) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, msUntilAgoChanges(ts, Date.now()));
    };
    schedule();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (timer) clearTimeout(timer);
      setNow(Date.now());
      schedule();
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [ts]);
  return now;
}

/** The big mood emoji drifts up and down on a slow sine loop (nothing else moves: no scale, no sideways). Stays still when the phone asks for reduced motion. */
function FloatingEmoji({ emoji }: { emoji: string }) {
  const reduce = useReducedMotion();
  const lift = useSharedValue(0);
  useEffect(() => {
    if (reduce) {
      cancelAnimation(lift);
      lift.value = 0;
      return;
    }
    lift.value = 0;
    lift.value = withRepeat(withTiming(-FLOAT_DISTANCE, { duration: FLOAT_HALF_MS, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(lift);
  }, [reduce, lift]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
  return (
    <Animated.View style={style}>
      <Text style={{ fontSize: 58, lineHeight: 72 }}>{emoji}</Text>
    </Animated.View>
  );
}

/**
 * The partner's current status as one tinted card: avatar, "{name} is", the mood name big, the activity chip, the big emoji and
 * how long ago it was set. The tint is the mood's own colour (same palette as the Status tab); no mood yet = a short hint.
 */
export function PartnerMoodCard({ partner, mood, onPress, avatarWrap }: { partner: Profile | null; mood: MoodRow | null; onPress: () => void; avatarWrap?: (avatar: ReactNode) => ReactNode }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const { digits, calendarMode } = useSettingsStore();
  const customMoods = useSettingsStore((s) => s.statusCustomMoods);
  const partnerPresets = useSettingsStore((s) => s.partnerMoodPresets);
  const name = partner?.name || t('partnerDefaultName');
  const known = mood ? moodByEmoji(mood.emoji) : undefined;
  const activity = mood ? activityById(mood.activity) : undefined;
  // Same palette, gradient and opacity as the Status tab's mood card, so the two cards always match.
  // A custom mood of the partner: its colour comes from the partner's message (`partnerMoodPresets`); my own custom moods
  // are only a fallback. A mood with no known colour never leaves the card white: it gets the Status tab's neutral tint.
  const palette = mood
    ? moodColorsFor(mood.emoji, [...Object.entries(partnerPresets).map(([emoji, preset]) => ({ emoji, preset })), ...customMoods])
      ?? (mood.emoji ? ([colors.moodSelected, colors.moodSelected] as const) : undefined)
    : undefined;
  const tint = palette?.[0];
  const alpha = colors.isDark ? MOOD_CARD_ALPHA.dark : MOOD_CARD_ALPHA.light;
  const align = alignOf(isRTL);
  const moodName = known ? t(known.name) : mood?.text ?? '';
  const now = useNowFrom(mood?.ts);
  const ago = mood ? timeAgo(mood.ts, now) : null;
  const agoText = !mood || !ago ? '' : ago.unit === 'now' ? t('agoNow')
    : ago.unit === 'date' ? formatDate(mood.ts, calendarMode === 'both' ? 'jalali' : calendarMode, language, digits)
    : t(ago.unit === 'minutes' ? 'agoMinutes' : ago.unit === 'hours' ? 'agoHours' : 'agoDays').replace('{n}', toDigits(ago.n, digits));
  return (
    <RNPressable
      accessibilityRole="button"
      accessibilityLabel={`${name} ${moodName}`.trim()}
      onPress={onPress}
      style={({ pressed }) => [styles.moodCard, { backgroundColor: colors.card, borderColor: tint ? withAlpha(tint, 0.3) : colors.border, opacity: pressed ? 0.85 : 1 }]}
    >
      {palette ? <LinearGradient pointerEvents="none" colors={[withAlpha(palette[0], alpha), withAlpha(palette[1], alpha)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} /> : null}
      <RNView style={[styles.moodRow, { flexDirection: rowOf(isRTL) }]}>
        {(() => {
          const avatar = <Avatar b64={partner?.avatarB64} photo={partner?.avatarPhoto} name={partner?.name} size={58} />;
          return avatarWrap ? avatarWrap(avatar) : avatar;
        })()}
        <RNView style={{ flex: 1, gap: 6 }}>
          {mood ? (
            <>
              <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14, textAlign: align }}>{t('homePartnerIs').replace('{name}', name)}</Text>
              <Text numberOfLines={2} style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 27, lineHeight: language === 'fa' ? 40 : 32, textAlign: align }}>{language === 'en' ? moodName.toUpperCase() : moodName}</Text>
              {activity ? (
                <RNView style={[styles.activity, { backgroundColor: withAlpha(colors.foreground, 0.06), borderColor: withAlpha(colors.foreground, 0.1), flexDirection: rowOf(isRTL), alignSelf: isRTL ? 'flex-end' : 'flex-start' }]}>
                  <Text style={{ fontSize: 16 }}>{activity.emoji}</Text>
                  <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14 }}>{t(activity.name)}</Text>
                </RNView>
              ) : null}
            </>
          ) : (
            <>
              <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 17, textAlign: align }}>{name}</Text>
              <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, textAlign: align }}>{t('homeNoMoodYet')}</Text>
            </>
          )}
        </RNView>
        {mood ? (
          <RNView style={{ alignItems: 'center', gap: 6 }}>
            <FloatingEmoji emoji={mood.emoji} />
            <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12.5 }}>{agoText}</Text>
          </RNView>
        ) : null}
      </RNView>
    </RNPressable>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', marginBottom: 20 },
  side: { width: 44, height: 44, justifyContent: 'center' },
  titleWrap: { flex: 1, alignItems: 'center', gap: 6 },
  underline: { width: 40, height: 3, borderRadius: 2 },
  strip: { alignItems: 'center' },
  stripCell: { width: STRIP_CELL, alignItems: 'center', justifyContent: 'center' },
  stripLine: { width: STRIP_LINE_W, height: 3, borderRadius: 2 },
  stripLabels: { justifyContent: 'space-between', marginTop: 6 },
  moodCard: { overflow: 'hidden', borderWidth: 1, borderRadius: 28, padding: 16, marginBottom: 18, shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  moodRow: { alignItems: 'center', gap: 14 },
  activity: { alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, maxWidth: '100%' },
});
