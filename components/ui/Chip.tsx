import { Feather } from '@expo/vector-icons';
import { useEffect } from 'react';
import { Pressable, StyleSheet, type ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scaleCardStyle, scaleTextStyle } from '@/components/ui/scaling';
import { useColors } from '@/hooks/useColors';
import { cardScaleForDisplay, radii, textScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';
import { SOFT_SPRING, TILE_SPRING } from '@/src/lib/motion';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

type IconName = keyof typeof Feather.glyphMap;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Pill chip (UI_PHASES 5.2: Status / Diary filters, dropdown pills).
 * - `outline` (default): card fill + hairline border; selected (R4) = filled dark chip with light text (light theme; inverted in dark).
 * - `filled`: card fill, no border (the "Newest ⌄" / "Categories ⌄" dropdown pills); selected is filled the same way.
 */
export function Chip({
  label,
  selected = false,
  onPress,
  icon,
  trailingIcon,
  variant = 'outline',
  accessibilityLabel,
  onLongPress,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  trailingIcon?: IconName;
  variant?: 'outline' | 'filled';
  accessibilityLabel?: string;
  onLongPress?: () => void;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const displaySize = useSettingsStore((st) => st.displaySize);
  const idleBorder = variant === 'filled' ? 'transparent' : colors.border;
  const fg = selected ? colors.chipSelectedForeground : colors.foreground;
  // Selecting a chip fades its fill / border / text to the selected colours and the chip squeezes a little under the finger.
  const progress = useSharedValue(selected ? 1 : 0);
  const press = useSharedValue(1);
  useEffect(() => {
    progress.value = withTiming(selected ? 1 : 0, { duration: 220 });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const idleBg = colors.card;
  const selBg = colors.chipSelected;
  const idleFg = colors.foreground;
  const selFg = colors.chipSelectedForeground;
  const anim = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [idleBg, selBg]),
    borderColor: interpolateColor(progress.value, [0, 1], [idleBorder, selBg]),
    transform: [{ scale: press.value }],
  }));
  const textAnim = useAnimatedStyle(() => ({ color: interpolateColor(progress.value, [0, 1], [idleFg, selFg]) }));
  const base = scaleCardStyle([styles.chip, { direction: isRTL ? 'rtl' : 'ltr', maxWidth: '100%', flexDirection: rowOf(isRTL) }], cardScaleForDisplay(displaySize)) as ViewStyle;
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      disabled={!onPress}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => (press.value = withSpring(0.93, TILE_SPRING))}
      onPressOut={() => (press.value = withSpring(1, SOFT_SPRING))}
      style={[base, anim]}
    >
      {icon ? <Feather name={icon} size={16} color={fg} /> : null}
      <Animated.Text
        style={[scaleTextStyle({ fontFamily: fontFamilyFor(language, selected || variant === 'filled' ? 'semibold' : 'medium'), fontSize: 15, flexShrink: 1, textAlign: 'center' }, textScaleForDisplay(displaySize)), textAnim]}
      >
        {label}
      </Animated.Text>
      {trailingIcon ? <Feather name={trailingIcon} size={16} color={fg} /> : null}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 40,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
