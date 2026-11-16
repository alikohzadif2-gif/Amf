import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { OnboardingFrame } from '@/components/onboarding/OnboardingFrame';
import { Input } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';
import { NAME_MAX, cleanName, isValidName } from '@/src/lib/onboarding';
import { sectionLabelSpacing, sectionLabelText } from '@/src/lib/ui-text';
import { usePartnerStore } from '@/src/state/partner-store';

/** Step 1 of 4 — name (reference 05). Saved into my local profile; nothing is published. */
export default function OnboardingNameScreen() {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const me = usePartnerStore((s) => s.me);
  const setMe = usePartnerStore((s) => s.setMe);
  const [name, setName] = useState(me.name ?? '');
  const valid = isValidName(name);
  const next = () => {
    if (!valid) return;
    setMe({ ...me, name: cleanName(name) });
    router.push('/onboarding/gender');
  };
  return (
    <OnboardingFrame step="name" title={t('onboardingNameTitle')} emoji="👋" subtitle={t('onboardingNameSubtitle')} nextDisabled={!valid} onNext={next}>
      <Text
        style={{
          color: colors.mutedForeground,
          fontFamily: fontFamilyFor(language, 'semibold'),
          fontSize: 13,
          letterSpacing: sectionLabelSpacing(language, 1.1),
          marginBottom: 10,
          textAlign: alignOf(isRTL),
        }}
      >
        {sectionLabelText(t('onboardingNameLabel'), language)}
      </Text>
      <View>
        <Input
          value={name}
          onChangeText={setName}
          placeholder={t('onboardingNamePlaceholder')}
          accessibilityLabel={t('onboardingNameLabel')}
          autoCapitalize="words"
          autoFocus
          maxLength={NAME_MAX}
          returnKeyType="next"
          onSubmitEditing={next}
        />
      </View>
    </OnboardingFrame>
  );
}
