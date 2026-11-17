import { Feather } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { radii } from '@/constants/theme';
import { withAlpha } from '@/constants/colors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

export type SegmentOption<T extends string> = {
  value: T;
  /** Text; omit for an icon-only segment (then give `accessibilityLabel`). */
  label?: string;
  icon?: keyof typeof Feather.glyphMap;
  accessibilityLabel?: string;
};

/**
 * Pill segmented control (Gregorian/Jalali, System/Light/Dark). Selected segment = soft accent tint + accent text.
 * `fullWidth` stretches the control and shares the width equally; otherwise it hugs its content.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  fullWidth,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  fullWidth?: boolean;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.track,
        { direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL), backgroundColor: colors.isDark ? colors.background : colors.raised },
        fullWidth ? styles.full : { alignSelf: 'flex-start' },
      ]}
    >
      {options.map((o) => {
        const selected = o.value === value;
        const fg = selected ? colors.primary : colors.mutedForeground;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityLabel={o.accessibilityLabel ?? o.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={[
              styles.segment,
              { flexDirection: rowOf(isRTL), backgroundColor: selected ? withAlpha(colors.primary, 0.18) : 'transparent' },
              fullWidth ? { flex: 1 } : null,
            ]}
          >
            {o.icon ? <Feather name={o.icon} size={16} color={fg} /> : null}
            {o.label ? (
              <Text style={{ color: fg, fontFamily: fontFamilyFor(language, selected ? 'semibold' : 'medium'), fontSize: 14, flexShrink: 1, textAlign: 'center' }}>
                {o.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { borderRadius: radii.pill, padding: 4, gap: 4 },
  full: { alignSelf: 'stretch' },
  segment: { minHeight: 38, minWidth: 44, borderRadius: radii.pill, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', gap: 6 },
});
