import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ui';
import { Button } from '@/components/server/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { previousStep, stepProgress, type OnboardingStep } from '@/src/lib/onboarding';

/**
 * Shared frame of the three onboarding steps (references 05, 06, 08): back arrow + coral progress bar on top,
 * big title (+ emoji), muted subtitle, the step's content, and ONE "Next step" pill pinned at the bottom (above the keyboard).
 * Back goes to the previous step; on the first step it returns to the welcome carousel.
 */
export function OnboardingFrame({
  step,
  title,
  emoji,
  subtitle,
  nextDisabled,
  nextTitle = 'onboardingNext',
  onNext,
  overlay,
  children,
}: {
  step: OnboardingStep;
  title: string;
  emoji?: string;
  subtitle: string;
  nextDisabled?: boolean;
  nextTitle?: TranslationKey;
  onNext: () => void;
  /** Bottom sheets: BottomSheet is an in-tree overlay and must be the last child of the screen root, not inside the scrolling content. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { language, isRTL, t } = useI18n();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else if (previousStep(step)) router.replace(`/onboarding/${previousStep(step)}` as never);
  };
  return (
    <View style={[styles.root, { direction: isRTL ? 'rtl' : 'ltr', backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
      <StatusBar barStyle={colors.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      <View style={[styles.header, { flexDirection: rowOf(isRTL) }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('back')} hitSlop={12} onPress={goBack} style={styles.back}>
          <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={26} color={colors.foreground} />
        </Pressable>
        <View style={styles.progress}>
          <ProgressBar progress={stepProgress(step)} accessibilityLabel={t('onboardingProgress')} />
        </View>
      </View>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text
            accessibilityRole="header"
            style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 32, lineHeight: language === 'fa' ? 50 : 40, textAlign: alignOf(isRTL) }}
          >
            {emoji ? `${title} ${emoji}` : title}
          </Text>
          <Text
            style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 18, lineHeight: language === 'fa' ? 30 : 26, marginTop: 8, textAlign: alignOf(isRTL) }}
          >
            {subtitle}
          </Text>
          <View style={{ marginTop: 28 }}>{children}</View>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <Button title={nextTitle} primary disabled={nextDisabled} onPress={onNext} />
        </View>
      </KeyboardAvoidingView>
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: 'center', gap: 16, paddingHorizontal: 20, minHeight: 44 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  progress: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 40, paddingBottom: 24 },
  footer: { paddingHorizontal: 20, paddingTop: 8 },
});
