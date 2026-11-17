import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

/** Centered muted message + optional coral action link with an icon ("Create your first diary", "Set your next date"). */
export function EmptyState({
  message,
  actionLabel,
  actionIcon,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  actionIcon?: keyof typeof Feather.glyphMap;
  onAction?: () => void;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <View style={styles.wrap}>
      <Text
        style={{
          color: colors.mutedForeground,
          fontFamily: fontFamilyFor(language),
          fontSize: 16,
          lineHeight: language === 'fa' ? 28 : 24,
          textAlign: 'center',
        }}
      >
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitSlop={12}
          onPress={onAction}
          style={({ pressed }) => [styles.action, { direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL), opacity: pressed ? 0.6 : 1 }]}
        >
          {actionIcon ? <Feather name={actionIcon} size={20} color={colors.primary} /> : null}
          <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 16 }}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: 24, gap: 18 },
  action: { alignItems: 'center', gap: 8 },
});
