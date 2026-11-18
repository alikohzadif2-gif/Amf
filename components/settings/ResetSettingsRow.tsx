import { Alert } from 'react-native';
import { ActionRow } from '@/components/settings/SettingRows';
import { logEvent } from '@/src/diagnostics/log';
import { useI18n } from '@/src/i18n';
import { authenticate } from '@/src/security/auth';
import { useSettingsStore } from '@/src/state/settings-store';

/** The existing, confirmed settings reset action, shared by the Settings account group. */
export function ResetSettingsRow() {
  const { t } = useI18n();
  const resetSettings = useSettingsStore((state) => state.resetSettings);

  const doReset = async () => {
    // With app lock on, resetting (which turns the lock off) needs the lock check first.
    if (useSettingsStore.getState().appLock) {
      const result = await authenticate(t('lockPromptReset'), t('cancel'));
      if (result !== 'ok' && result !== 'unavailable') return;
    }
    resetSettings();
    logEvent('info', 'settings reset');
  };

  const confirmReset = () =>
    Alert.alert(t('resetConfirmTitle'), t('resetConfirmBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('resetConfirm'), style: 'destructive', onPress: () => void doReset() },
    ]);

  return (
    <ActionRow
      title="resetSettings"
      description="resetSettingsDesc"
      icon="rotate-ccw"
      destructive
      onPress={confirmReset}
    />
  );
}
