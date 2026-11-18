import { Feather } from '@expo/vector-icons';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, interpolateColor, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { scaleCardStyle, scaleTextStyle } from '@/components/ui/scaling';
import { useSettingsStore } from '@/src/state/settings-store';
import { SOFT_SPRING, TILE_SPRING } from '@/src/lib/motion';
import { withAlpha } from '@/constants/colors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { cardScaleForDisplay, glow, layout, radii, textScaleForDisplay } from '@/constants/theme';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { useTabBarHeight } from './useTabBarHeight';

/**
 * Floating action button with coral glow. Round when it has no `label`; with a `label` it becomes the extended pill ("Save status").
 * `floating` pins it above the bottom edge: round FAB at the bottom-end corner, pill centred. `bottomOffset` = height of anything below it (e.g. the tab bar).
 * Disabled = muted `track` fill and no glow.
 * Motion: the fill glides between enabled / disabled / success, it squeezes under the finger, pops when it becomes enabled, shows a spinner while `loading`
 * and turns green with a check + `successLabel` while `success`.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function Fab({
  icon,
  label,
  onPress,
  disabled,
  floating,
  bottomOffset = 0,
  aboveTabBar,
  accessibilityLabel,
  loading,
  success,
  successLabel,
}: {
  icon?: keyof typeof Feather.glyphMap;
  label?: string;
  onPress: () => void;
  disabled?: boolean;
  floating?: boolean;
  bottomOffset?: number;
  /** Sit above the floating tab bar (use on tab screens). */
  aboveTabBar?: boolean;
  accessibilityLabel?: string;
  /** Spinner instead of the icon (e.g. while sending). */
  loading?: boolean;
  /** Green "done" state with a check icon. */
  success?: boolean;
  /** Label shown while `success`. */
  successLabel?: string;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const extended = !!label;
  const displaySize = useSettingsStore((st) => st.displaySize);
  const textScale = textScaleForDisplay(displaySize);
  const showSuccess = !!success && !disabled;
  const fg = showSuccess ? '#FFFFFF' : disabled ? colors.mutedForeground : colors.primaryForeground;
  const state = useSharedValue(disabled ? 0 : 1); // 0 disabled, 1 enabled, 2 success
  const press = useSharedValue(1);
  const pop = useSharedValue(1);
  useEffect(() => {
    state.value = withTiming(showSuccess ? 2 : disabled ? 0 : 1, { duration: 280 });
    if (!disabled) pop.value = withSequence(withTiming(1.06, { duration: 120 }), withSpring(1, SOFT_SPRING));
  }, [disabled, showSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  const idle = colors.primary;
  const off = colors.track;
  const ok = colors.success;
  const anim = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(state.value, [0, 1, 2], [off, idle, ok]),
    shadowColor: interpolateColor(state.value, [0, 1, 2], [off, idle, ok]),
    shadowOpacity: glow.opacity * Math.min(1, state.value),
    elevation: 8 * Math.min(1, state.value),
    transform: [{ scale: press.value * pop.value }],
  }));
  const base = scaleCardStyle([extended ? styles.pill : styles.round, extended ? null : { borderWidth: 2, borderColor: withAlpha('#FFFFFF', disabled ? 0 : 0.35) }, { direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL), shadowRadius: glow.radius }], cardScaleForDisplay(displaySize)) as ViewStyle;
  const shownLabel = showSuccess && successLabel ? successLabel : label;
  const shownIcon = showSuccess ? 'check' : icon;
  const button = (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => (press.value = withSpring(0.94, TILE_SPRING))}
      onPressOut={() => (press.value = withSpring(1, SOFT_SPRING))}
      style={[base, anim]}
    >
      {loading ? (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)}>
          <ActivityIndicator size="small" color={fg} />
        </Animated.View>
      ) : shownIcon ? (
        <Animated.View key={shownIcon} entering={FadeIn.duration(180)}>
          <Feather name={shownIcon} size={extended ? 18 : 24} color={fg} />
        </Animated.View>
      ) : null}
      {extended ? (
        <Animated.Text key={shownLabel} entering={FadeIn.duration(200)} style={scaleTextStyle({ color: fg, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 16 }, textScale)}>{shownLabel}</Animated.Text>
      ) : null}
    </AnimatedPressable>
  );
  if (!floating) return button;
  const bottom = aboveTabBar ? tabBarHeight + layout.navBarMargin : insets.bottom + layout.navBarMargin + bottomOffset;
  // Physical left/right on purpose, chosen from isRTL: the round FAB sits in the bottom *end* corner in both directions.
  const place = extended
    ? { left: 0, right: 0, alignItems: 'center' as const }
    : isRTL
      ? { left: layout.screenPadding }
      : { right: layout.screenPadding };
  return (
    <View pointerEvents="box-none" style={[styles.floating, { bottom }, place]}>
      {button}
    </View>
  );
}

const styles = StyleSheet.create({
  floating: { position: 'absolute' },
  round: { width: layout.fabSize, height: layout.fabSize, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', shadowOffset: { width: 0, height: 4 } },
  pill: { minHeight: 52, borderRadius: radii.pill, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center', gap: 8, shadowOffset: { width: 0, height: 4 } },
});
