import { Alert } from 'react-native';
import {
  SelectRow,
  SettingGroup,
  SwitchRow,
} from '@/components/settings/SettingRows';
import { useI18n } from '@/src/i18n';
import { authenticate, deviceHasLock } from '@/src/security/auth';
import { useSettingsStore } from '@/src/state/settings-store';

export default function SecuritySection() {
  const { t } = useI18n();
  const s = useSettingsStore();
  const set = s.setSetting;

  // Turning the lock on or off needs the person to prove who they are first.
  const toggleLock = async (on: boolean) => {
    if (on && !(await deviceHasLock())) {
      Alert.alert(t('appLock'), t('lockNeedDevice'));
      return;
    }
    const result = await authenticate(t(on ? 'lockPromptEnable' : 'lockPromptDisable'), t('cancel'));
    if (result === 'ok' || (!on && result === 'unavailable')) set('appLock', on);
    else if (result === 'failed') Alert.alert(t('appLock'), t('lockAuthFailed'));
  };

  return (
    <>
      <SettingGroup>
        <SwitchRow
          title="appLock"
          description="appLockDesc"
          value={s.appLock}
          onChange={(v) => void toggleLock(v)}
        />
        <SelectRow
          title="autoLock"
          value={s.autoLock}
          onChange={(v) => set('autoLock', v)}
          options={[
            { value: 'immediate', label: 'lockImmediate' },
            { value: '1m', label: 'lock1m' },
            { value: '5m', label: 'lock5m' },
            { value: '15m', label: 'lock15m' },
          ]}
        />
      </SettingGroup>
      <SettingGroup>
        <SwitchRow
          title="blockScreenshots"
          description="blockScreenshotsDesc"
          value={s.blockScreenshots}
          onChange={(v) => set('blockScreenshots', v)}
        />
      </SettingGroup>
    </>
  );
}
