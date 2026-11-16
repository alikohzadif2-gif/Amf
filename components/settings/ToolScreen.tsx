import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';

/** Shared frame of the Tools screens: back button, title, intro text, content. */
export function ToolScreen({ title, intro, children }: { title: TranslationKey; intro?: TranslationKey; children: ReactNode }) {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  return (
    <ScreenFrame scroll>
      <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={() => router.back()} style={({ pressed }) => [styles.back, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: rowOf(isRTL), opacity: pressed ? 0.7 : 1 }]}>
        <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={18} color={colors.foreground} />
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{t('back')}</Text>
      </Pressable>
      <Text style={[styles.title, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: alignOf(isRTL) }]}>{t(title)}</Text>
      {intro ? <Text style={[styles.intro, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t(intro)}</Text> : null}
      {children}
    </ScreenFrame>
  );
}

export function ToolButton({ label, onPress, busy, primary = true }: { label: string; onPress: () => void; busy?: boolean; primary?: boolean }) {
  const colors = useColors();
  const { language } = useI18n();
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: primary ? colors.primary : colors.card, borderColor: primary ? colors.primary : colors.border, opacity: pressed || busy ? 0.7 : 1 }]}>
      {busy ? <ActivityIndicator color={primary ? '#fff' : colors.primary} /> : null}
      <Text style={{ color: primary ? '#fff' : colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function ToolNote({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'primary' }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return <Text style={[styles.note, { color: tone === 'primary' ? colors.primary : colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', minHeight: 40, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, alignItems: 'center', gap: 8 },
  title: { fontSize: 26, marginTop: 22 },
  intro: { fontSize: 14, lineHeight: 23, marginTop: 8, marginBottom: 14 },
  button: { minHeight: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 12 },
  note: { fontSize: 13, lineHeight: 21, marginTop: 12 },
});
