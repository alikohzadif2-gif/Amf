import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/ui/ScaledText';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { useTabBarHeight } from './useTabBarHeight';
import { GENTLE_SPRING } from '@/src/lib/motion';

/**
 * Small transient message pill (fades in, stays ~2 s, fades out). Controlled by `message`: pass a new `{ text, id }` object to show it again;
 * `null` shows nothing. Sits above the floating tab bar (and above the Save pill via `bottomOffset`). It never takes touches.
 */
export function Toast({ message, bottomOffset = 0, position = 'bottom', emoji }: { message: { text: string; id: number } | null; bottomOffset?: number; /** 'top' = dark pill under the status bar (Status screen). */ position?: 'bottom' | 'top'; /** Shown after the text (e.g. the mood just sent). */ emoji?: string }) {
  const colors = useColors();
  const { language } = useI18n();
  const insets = useSafeAreaInsets();
  const tabBar = useTabBarHeight();
  const opacity = useSharedValue(0);
  const dir = position === 'top' ? -1 : 1;
  const lift = useSharedValue(24 * dir);
  const scale = useSharedValue(0.92);

  useEffect(() => {
    if (!message) return;
    // Rises and fades in with a soft spring, stays ~2 s, then sinks and fades out.
    opacity.value = 0;
    lift.value = 24 * dir;
    scale.value = 0.92;
    opacity.value = withSequence(withTiming(1, { duration: 200 }), withDelay(1900, withTiming(0, { duration: 300, easing: Easing.in(Easing.quad) })));
    lift.value = withSequence(withSpring(0, GENTLE_SPRING), withDelay(1750, withTiming(14 * dir, { duration: 300 })));
    scale.value = withSequence(withSpring(1, GENTLE_SPRING), withDelay(1750, withTiming(0.96, { duration: 300 })));
  }, [message]); // eslint-disable-line react-hooks/exhaustive-deps
  const anim = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: lift.value }, { scale: scale.value }] }));

  if (!message) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.wrap, anim, position === 'top' ? { top: insets.top + 8, backgroundColor: '#17181C', borderColor: '#17181C', flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 20 } : { bottom: Math.max(insets.bottom, 0) + tabBar + bottomOffset, backgroundColor: colors.raised, borderColor: colors.border }]}
    >
      <Text style={{ color: position === 'top' ? '#FFFFFF' : colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14.5, textAlign: 'center' }}>{message.text}</Text>
      {position === 'top' && emoji ? <Text style={{ fontSize: 17 }}>{emoji}</Text> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', alignSelf: 'center', maxWidth: '86%', paddingHorizontal: 20, paddingVertical: 12, borderRadius: radii.pill, borderWidth: 1, elevation: 6 },
});
