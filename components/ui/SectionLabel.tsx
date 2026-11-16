import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { typography } from '@/constants/theme';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { sectionLabelSpacing, sectionLabelText } from '@/src/lib/ui-text';

/**
 * Small muted section heading ("THIS WEEK", "MOODS", "GENERAL"): uppercase + letter spacing for English only.
 * `trailing` is the text at the far end (e.g. "0 Events"), coral by default. `icon` is an optional leading icon (e.g. the search magnifier).
 */
export function SectionLabel({
  label,
  trailing,
  icon,
  onTrailingPress,
}: {
  label: string;
  trailing?: string;
  icon?: keyof typeof Feather.glyphMap;
  /** Q4: makes `trailing` a button (e.g. "+ Add"). */
  onTrailingPress?: () => void;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const t = typography.sectionLabel;
  return (
    <View style={[styles.row, { flexDirection: rowOf(isRTL) }]}>
      <View style={[styles.start, { flexDirection: rowOf(isRTL) }]}>
        {icon ? <Feather name={icon} size={16} color={colors.mutedForeground} /> : null}
        <Text
          accessibilityRole="header"
          style={{
            color: colors.mutedForeground,
            fontFamily: fontFamilyFor(language, t.weight),
            fontSize: t.fontSize,
            letterSpacing: sectionLabelSpacing(language, t.letterSpacing),
            textAlign: alignOf(isRTL),
          }}
        >
          {sectionLabelText(label, language)}
        </Text>
      </View>
      {trailing && onTrailingPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={trailing} hitSlop={10} onPress={onTrailingPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 14 }}>{trailing}</Text>
        </Pressable>
      ) : trailing ? (
        <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 14 }}>{trailing}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 12 },
  start: { alignItems: 'center', gap: 8, flexShrink: 1 },
});
