import { Feather } from '@expo/vector-icons';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';

/** Row on the Status tab that opens the period screen (R5b). */
export function PeriodEntry({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('periodTitle')}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: 20, padding: 12, marginBottom: 14, opacity: pressed ? 0.8 : 1 })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.primary, 0.15) }}>
        <Feather name="droplet" size={19} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: alignOf(isRTL) }}>{t('periodTitle')}</Text>
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12.5, textAlign: alignOf(isRTL) }}>{t('periodCardDesc')}</Text>
      </View>
      <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}
