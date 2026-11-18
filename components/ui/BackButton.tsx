import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

/** Circular back button (card fill, chevron that flips in RTL). Without `onPress` it calls `router.back()`. */
export function CircleBackButton({ onPress, size = 44 }: { onPress?: () => void; size?: number }) {
  const colors = useColors();
  const router = useRouter();
  const { isRTL, t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('back')}
      hitSlop={8}
      onPress={onPress ?? (() => router.back())}
      style={({ pressed }) => [
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Feather name={isRTL ? 'chevron-right' : 'chevron-left'} size={Math.round(size * 0.55)} color={colors.foreground} />
    </Pressable>
  );
}

/** Screen header: circular back at the start, centred title, an empty slot of the same size at the end so the title stays centred. */
export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <View style={[styles.header, { direction: isRTL ? 'rtl' : 'ltr', flexDirection: rowOf(isRTL) }]}>
      <CircleBackButton onPress={onBack} />
      <Text
        accessibilityRole="header"
        style={{ flex: 1, flexShrink: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 20, textAlign: 'center' }}
      >
        {title}
      </Text>
      <View style={styles.slot} />
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', gap: 8, minHeight: 56, marginBottom: 8 },
  slot: { width: 44 },
});
