import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable } from '@/components/ui/ScaledSurface';
import { withAlpha } from '@/constants/colors';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

/**
 * Home "Connect with meYou" card. While unpaired, its action opens the server invite/join flow.
 */
export function ConnectCardShell() {
  const router = useRouter();
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <LinearGradient colors={[colors.raised, colors.card]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.card, { borderColor: colors.border }]}>
      <View style={[styles.icon, { backgroundColor: withAlpha(colors.foreground, 0.08) }]}>
        <Feather name="share-2" size={30} color={colors.foreground} />
      </View>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 26, textAlign: 'center' }}>
        {t('homeConnectTitle')}
      </Text>
      <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 15.5, lineHeight: language === 'fa' ? 27 : 23, textAlign: 'center', marginTop: 10 }}>
        {t('homeConnectBody')}
      </Text>
      <Pressable
        onPress={() => router.push('/settings/pair')}
        accessible
        accessibilityRole="button"
        accessibilityLabel={t('pairPartner')}
        accessibilityHint={t('pairInviteHint')}
        style={({ pressed }) => [styles.pill, { flexDirection: rowOf(isRTL), backgroundColor: colors.primary, opacity: pressed ? 0.82 : 1 }]}
      >
        <Feather name="user-plus" size={20} color={colors.primaryForeground} />
        <Text style={{ color: colors.primaryForeground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 17 }}>{t('pairPartner')}</Text>
      </Pressable>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.cardLarge, borderWidth: 1, paddingHorizontal: 22, paddingVertical: 22, alignItems: 'stretch', marginBottom: 14 },
  icon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 14 },
  pill: { minHeight: 54, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20 },
});
