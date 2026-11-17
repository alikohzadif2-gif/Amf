import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { clampProgress } from '@/src/lib/ui-text';

/** Thin coral progress bar on a `track` (onboarding steps). `progress` is 0..1; it fills from the start side (right in RTL). */
export function ProgressBar({ progress, accessibilityLabel }: { progress: number; accessibilityLabel?: string }) {
  const colors = useColors();
  const { isRTL } = useI18n();
  const p = clampProgress(progress);
  const anim = useRef(new Animated.Value(p)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: p, duration: 260, useNativeDriver: false }).start();
  }, [p, anim]);
  const width = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p * 100) }}
      style={[styles.track, { flexDirection: rowOf(isRTL), backgroundColor: colors.track }]}
    >
      <Animated.View style={[styles.fill, { width, backgroundColor: colors.primary }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
