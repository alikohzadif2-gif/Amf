import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { OnboardingFrame } from '@/components/onboarding/OnboardingFrame';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { useSettingsStore, type Gender } from '@/src/state/settings-store';

const OPTIONS: { value: Gender; emoji: string; label: TranslationKey }[] = [
  { value: 'female', emoji: '👩', label: 'onboardingGenderFemale' },
  { value: 'male', emoji: '👨', label: 'onboardingGenderMale' },
];

/**
 * Step 2 of 4 — gender (required: "Next step" stays disabled until one is picked, there is no skip).
 * It only decides what the Period screen shows: women see their own cycle, men see only their partner's. Saved on this phone, nothing is published.
 */
export default function OnboardingGenderScreen() {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const gender = useSettingsStore((s) => s.gender);
  const setSetting = useSettingsStore((s) => s.setSetting);
  return (
    <OnboardingFrame step="gender" title={t('onboardingGenderTitle')} subtitle={t('onboardingGenderSubtitle')} nextDisabled={!gender} onNext={() => gender && router.push('/onboarding/birthday')}>
      <View style={{ flexDirection: rowOf(isRTL), gap: 14 }}>
        {OPTIONS.map((o) => {
          const selected = gender === o.value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={t(o.label)}
              onPress={() => setSetting('gender', o.value)}
              style={({ pressed }) => ({
                flex: 1,
                alignItems: 'center',
                gap: 10,
                paddingVertical: 30,
                borderRadius: 24,
                borderWidth: 2,
                borderColor: selected ? colors.primary : colors.border,
                backgroundColor: selected ? withAlpha(colors.primary, 0.12) : colors.card,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontSize: 52, lineHeight: 64 }}>{o.emoji}</Text>
              <Text style={{ color: selected ? colors.primary : colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 18 }}>{t(o.label)}</Text>
            </Pressable>
          );
        })}
      </View>
    </OnboardingFrame>
  );
}
