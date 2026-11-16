import { Feather } from '@expo/vector-icons';
import { StyleSheet, Switch } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { radii } from '@/constants/theme';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { IconTile } from './IconTile';

/**
 * Switch row: leading icon tile or emoji, title, optional muted subtitle, switch at the end ("Surprise event · Hidden from partner").
 * Stands alone as a card, or `embedded` inside a grouped card (no fill, no border).
 */
export function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
  icon,
  emoji,
  iconColor,
  disabled,
  embedded,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  icon?: keyof typeof Feather.glyphMap;
  emoji?: string;
  iconColor?: string;
  disabled?: boolean;
  embedded?: boolean;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <View
      style={[
        styles.row,
        { direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL), opacity: disabled ? 0.5 : 1 },
        embedded ? null : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.card },
      ]}
    >
      {icon || emoji ? <IconTile icon={icon} emoji={emoji} color={iconColor} size={42} /> : null}
      <View style={styles.text}>
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 16, textAlign: alignOf(isRTL) }}>{title}</Text>
        {subtitle ? (
          <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, marginTop: 2, textAlign: alignOf(isRTL) }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={title}
        trackColor={{ false: colors.track, true: colors.switchOn }}
        thumbColor={colors.primaryForeground}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12, minHeight: 64 },
  text: { flex: 1 },
});
