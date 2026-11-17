import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { scaleCardStyle, scaleTextStyle } from '@/components/ui/scaling';
import { cardScaleForDisplay, radii, textScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';
import { CARD_COLOR_MS } from '@/src/lib/motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { MOOD_CARD_ALPHA, MOOD_CARD_SECONDARY_TEXT_ALPHA, moodColorsFor } from '@/src/partner/mood-colors';
import { alignOf, rowOf } from '@/src/lib/layout';

const FADE = 30;

/** Two-colour gradient that cross-fades to the new pair whenever the mood changes (instead of snapping). */
function FadingGradient({ colors }: { colors: readonly [string, string] }) {
  const key = colors.join('|');
  const [layers, setLayers] = useState({ prev: colors, cur: colors });
  const opacity = useSharedValue(1);
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    setLayers((l) => ({ prev: l.cur, cur: colors }));
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: CARD_COLOR_MS });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const topStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <>
      <LinearGradient pointerEvents="none" colors={layers.prev} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, topStyle]}>
        <LinearGradient colors={layers.cur} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </>
  );
}

/** Fixed header of the Status tab (R4). Lays itself over the top of the screen; `onHeight` tells the scroll content how much room to leave. */
export function StickyHeader({ children, onHeight }: { children: ReactNode; onHeight: (h: number) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [h, setH] = useState(0);
  // The page colour fades in under the card (dim) so the grid slides beneath it and stays readable.
  return (
    <View pointerEvents="box-none" style={[styles.sticky, { top: 0 }]}>
      <LinearGradient
        pointerEvents="none"
        colors={[colors.background, colors.background, withAlpha(colors.background, 0)]}
        locations={[0, 0.7, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + h + FADE }}
      />
      <View
        style={{ paddingTop: insets.top + 8, paddingHorizontal: 22 }}
        onLayout={(e) => {
          const next = Math.ceil(e.nativeEvent.layout.height);
          setH(next - insets.top);
          onHeight(next - insets.top);
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** "My mood" card: soft two-colour gradient that follows the picked mood (Q3, `mood-colors.ts`; purple for an emoji without a palette), shadow, big emoji + "Feeling <name>". */
export function MoodCard({
  emoji,
  title,
  subtitle,
  historyLabel,
  clearLabel,
  onHistory,
  onClear,
  clearDisabled,
  customMoods,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  historyLabel: string;
  clearLabel: string;
  onHistory: () => void;
  onClear?: () => void;
  clearDisabled?: boolean;
  /** Q4: my own moods, so the card takes the colour preset of the one picked. */
  customMoods?: readonly { emoji: string; preset: number }[];
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const picked = emoji !== '';
  const palette = picked ? moodColorsFor(emoji, customMoods) : undefined;
  const alpha = colors.isDark ? MOOD_CARD_ALPHA.dark : MOOD_CARD_ALPHA.light;
  const accent = palette ? palette[0] : colors.moodSelected;
  const gradient: readonly [string, string] = palette
    ? [withAlpha(palette[0], alpha), withAlpha(palette[1], alpha)]
    : picked ? [withAlpha(colors.moodSelected, 0.38), colors.statusCardTint] : [colors.raised, colors.card];
  const secondary = picked ? withAlpha(colors.foreground, MOOD_CARD_SECONDARY_TEXT_ALPHA) : colors.mutedForeground;
  const displaySize = useSettingsStore((st) => st.displaySize);
  const textScale = textScaleForDisplay(displaySize);
  const cardScale = cardScaleForDisplay(displaySize);
  const round = (onPress: () => void, label: string, icon: 'clock' | 'x', disabled?: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.foreground, 0.1), opacity: pressed ? 0.7 : 1, transform: [{ scale: pressed ? 0.9 : 1 }] })}
    >
      <Feather name={icon} size={19} color={colors.foreground} />
    </Pressable>
  );
  // No movement on this card: only the border / glow colour glide to the new mood.
  const borderTarget = picked ? withAlpha(accent, 0.45) : colors.border;
  const shadowTarget = picked ? accent : '#000000';
  const cardAnim = useAnimatedStyle(() => ({
    borderColor: withTiming(borderTarget, { duration: CARD_COLOR_MS }),
    shadowColor: withTiming(shadowTarget, { duration: CARD_COLOR_MS }),
  }));
  const cardStyle = scaleCardStyle([styles.card, { backgroundColor: colors.card }], cardScale) as ViewStyle;
  return (
    <Animated.View style={[cardStyle, cardAnim]}>
      <FadingGradient colors={gradient} />
      <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12 }}>
        <Text style={scaleTextStyle({ fontSize: 46 }, textScale)}>
          {picked ? emoji : '🙂'}
        </Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: secondary, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 12.5, textAlign: alignOf(isRTL) }}>{t('statusMyMood')}</Text>
          <Text
            numberOfLines={2}
            style={scaleTextStyle({ color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 22, lineHeight: language === 'fa' ? 36 : 28, textAlign: alignOf(isRTL) }, textScale)}
          >
            {title}
          </Text>
          <Text
            numberOfLines={1}
            style={scaleTextStyle({ color: secondary, fontFamily: fontFamilyFor(language), fontSize: 14, textAlign: alignOf(isRTL) }, textScale)}
          >
            {subtitle}
          </Text>
        </View>
        {round(onHistory, historyLabel, 'clock')}
        {onClear ? round(onClear, clearLabel, 'x', clearDisabled) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sticky: { position: 'absolute', left: 0, right: 0, zIndex: 5 },
  card: {
    borderRadius: radii.cardLarge,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 14,
    overflow: 'hidden',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
});
