import { Pressable, StyleSheet } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { useEffect } from 'react';
import { radii } from '@/constants/theme';
import { scaleTextStyle } from '@/components/ui/scaling';
import { textScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';
import { useColors } from '@/hooks/useColors';
import { SOFT_SPRING, TILE_SPRING } from '@/src/lib/motion';

export const MOOD_TILE = 52;
export const MOOD_TILE_GAP = 10;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const REST_SHADOW = '#000000';
const REST_OPACITY = 0.07;

/**
 * Rounded-square emoji tile; selected = filled with the mood's own colour (`accent`, default `moodSelected`) and a soft glow (reference 13).
 * Motion: the fill / glow fade in, the emoji bounces, and the tile presses in like a soft button.
 */
export function MoodTile({
  emoji,
  label,
  selected,
  onPress,
  onLongPress,
  shape = 'tile',
  accent,
}: {
  emoji: string;
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Q4: press and hold opens the rename sheet. */
  onLongPress?: () => void;
  shape?: 'tile' | 'circle';
  /** Colour of the selected fill + glow (the mood's palette); falls back to `moodSelected`. */
  accent?: string;
}) {
  const colors = useColors();
  const textScale = textScaleForDisplay(useSettingsStore((st) => st.displaySize));
  const fill = accent ?? colors.moodSelected;
  const progress = useSharedValue(selected ? 1 : 0);
  const press = useSharedValue(1);
  const bounce = useSharedValue(1);

  useEffect(() => {
    progress.value = withTiming(selected ? 1 : 0, { duration: 260 });
    if (selected) bounce.value = withSequence(withTiming(0.7, { duration: 80 }), withSpring(1, SOFT_SPRING));
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const colorFrom = colors.raised;
  const bg = useDerivedValue(() => interpolateColor(progress.value, [0, 1], [colorFrom, fill]));
  // Resting tiles float on a soft neutral shadow; selecting fades it into the mood-coloured glow.
  const tileStyle = useAnimatedStyle(() => ({
    backgroundColor: bg.value,
    transform: [{ scale: press.value * (1 + 0.06 * progress.value) }],
    shadowColor: interpolateColor(progress.value, [0, 1], [REST_SHADOW, fill]),
    shadowOpacity: REST_OPACITY + (0.6 - REST_OPACITY) * progress.value,
    shadowRadius: 8 + 6 * progress.value,
    shadowOffset: { width: 0, height: 2 * (1 - progress.value) },
    elevation: 2 + 6 * progress.value,
  }));
  const emojiStyle = useAnimatedStyle(() => ({ transform: [{ scale: bounce.value }] }));

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => (press.value = withSpring(0.88, TILE_SPRING))}
      onPressOut={() => (press.value = withSpring(1, SOFT_SPRING))}
      style={[styles.tile, shape === 'circle' ? styles.circle : null, tileStyle]}
    >
      <Animated.Text style={[scaleTextStyle({ fontSize: 27 }, textScale), emojiStyle]}>{emoji}</Animated.Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  tile: { width: MOOD_TILE, height: MOOD_TILE, borderRadius: radii.tile, alignItems: 'center', justifyContent: 'center' },
  circle: { borderRadius: MOOD_TILE / 2 },
});
