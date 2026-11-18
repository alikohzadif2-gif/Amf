import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Button, Notice } from '@/components/server/ui';
import { SettingGroup } from '@/components/settings/SettingRows';
import { ScreenFrame } from '@/components/ScreenFrame';
import { ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshWidget } from '@/src/widget/refresh';

const setupSteps: TranslationKey[] = ['widgetStepOne', 'widgetStepTwo', 'widgetStepThree'];

export default function WidgetSettingsScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((state) => state.digits);
  const [busy, setBusy] = useState(false);
  const [refreshAttempted, setRefreshAttempted] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setRefreshAttempted(false);
    await refreshWidget();
    setBusy(false);
    setRefreshAttempted(true);
  };

  return (
    <ScreenFrame scroll>
      <ScreenHeader title={t('widgetSetup')} />
      <Notice>{t('widgetIntro')}</Notice>
      <SettingGroup title="widgetSetupSteps">
        {setupSteps.map((step, index) => (
          <View key={step} style={[styles.step, { flexDirection: rowOf(isRTL) }]}>
            <View style={[styles.number, { backgroundColor: colors.accent + '24' }]}>
              <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold') }}>
                {toDigits(index + 1, digits)}
              </Text>
            </View>
            <Text
              style={[
                styles.stepText,
                {
                  color: colors.foreground,
                  fontFamily: fontFamilyFor(language),
                  textAlign: alignOf(isRTL),
                },
              ]}
            >
              {t(step)}
            </Text>
          </View>
        ))}
      </SettingGroup>
      <Button
        title="widgetRefreshNow"
        icon="refresh-cw"
        variant="primary"
        busy={busy}
        disabled={busy}
        onPress={() => void refresh()}
      />
      {refreshAttempted ? <Notice tone="ok">{t('widgetRefreshAttempted')}</Notice> : null}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  step: { minHeight: 64, alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  number: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1, fontSize: 14, lineHeight: 23 },
});
