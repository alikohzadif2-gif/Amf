import { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { cardScaleForDisplay, radii, textScaleForDisplay } from '@/constants/theme';
import { scaleCardStyle, scaleTextStyle } from '@/components/ui/scaling';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { SOFT_SPRING, TILE_SPRING } from '@/src/lib/motion';
import { rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';

export const ACTIVITY_TILE_WIDTH = 172;
export const ACTIVITY_TILE_HEIGHT = 48;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const REST_SHADOW = '#000000';
const REST_OPACITY = 0.08;

/** Activity tile: emoji + name (one line, ellipsis); selected = purple fill that fades in with a glow, the emoji bounces, press = soft squeeze. */
export function ActivityTile({ emoji, name, selected, onPress, onLongPress, hideName, accent }: { emoji: string; name: string; selected: boolean; onPress: () => void; onLongPress?: () => void; hideName?: boolean; /** Colour of the selected fill (the picked mood's colour); falls back to `moodSelected`. */ accent?: string }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const { fontScale } = useWindowDimensions();
  const displaySize = useSettingsStore((state) => state.displaySize);
  const effectiveFontScale = fontScale * textScaleForDisplay(displaySize);
  const tileWidth = hideName ? ACTIVITY_TILE_HEIGHT + 4 : Math.ceil(ACTIVITY_TILE_WIDTH + Math.max(0, effectiveFontScale - 1) * 96); // Q5: emoji only = a square tile
  const tileHeight = Math.ceil(Math.max(ACTIVITY_TILE_HEIGHT, ACTIVITY_TILE_HEIGHT * effectiveFontScale));
  const cardScale = cardScaleForDisplay(displaySize);

  const progress = useSharedValue(selected ? 1 : 0);
  const press = useSharedValue(1);
  const bounce = useSharedValue(1);
  useEffect(() => {
    progress.value = withTiming(selected ? 1 : 0, { duration: 260 });
    if (selected) bounce.value = withSequence(withTiming(0.7, { duration: 80 }), withSpring(1, SOFT_SPRING));
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const from = colors.card;
  const to = accent ?? colors.moodSelected;
  const bg = useDerivedValue(() => interpolateColor(progress.value, [0, 1], [from, to]));
  const tileStyle = useAnimatedStyle(() => ({
    backgroundColor: bg.value,
    transform: [{ scale: press.value * (1 + 0.03 * progress.value) }],
    // Resting tiles float on a soft neutral shadow; selecting fades it into the mood-coloured glow.
    shadowColor: interpolateColor(progress.value, [0, 1], [REST_SHADOW, to]),
    shadowOpacity: REST_OPACITY + (0.5 - REST_OPACITY) * progress.value,
    shadowRadius: 10 + 2 * progress.value,
    shadowOffset: { width: 0, height: 3 * (1 - progress.value) },
    elevation: 2 + 4 * progress.value,
  }));
  const emojiStyle = useAnimatedStyle(() => ({ transform: [{ scale: bounce.value }] }));
  const textStyle = useAnimatedStyle(() => ({ color: interpolateColor(progress.value, [0, 1], [colors.foreground, colors.primaryForeground]) }));

  const textScale = textScaleForDisplay(displaySize);
  const baseStyle = scaleCardStyle(
    [
      styles.tile,
      { width: tileWidth, ...(hideName ? { justifyContent: 'center' as const, paddingHorizontal: 0 } : null), minHeight: tileHeight, direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL) },
    ],
    cardScale,
  ) as ViewStyle; // same display-size scaling the old ScaledPressable applied
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => (press.value = withSpring(0.94, TILE_SPRING))}
      onPressOut={() => (press.value = withSpring(1, SOFT_SPRING))}
      style={[baseStyle, tileStyle]}
    >
      <Animated.Text style={[scaleTextStyle({ fontSize: 20 }, textScale), emojiStyle]}>{emoji}</Animated.Text>
      {hideName ? null : <Animated.Text numberOfLines={1} ellipsizeMode="tail" style={[scaleTextStyle({ flex: 1, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 14.5 }, textScale), textStyle]}>
        {name}
      </Animated.Text>}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: radii.tile, paddingHorizontal: 12, alignItems: 'center', gap: 8 },
});
