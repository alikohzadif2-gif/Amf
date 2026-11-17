import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { ActionRow, InfoRow, NavRow, SettingGroup, SwitchRow } from '@/components/settings/SettingRows';
import { useI18n, type TranslationKey } from '@/src/i18n';
import { sendTestNotification, syncPushRegistration, unpair } from '@/src/partner/manage';
import { ensureNotificationPermission, type ShowResult } from '@/src/partner/notify';
import type { PushState } from '@/src/partner/push';
import { usePartnerStore } from '@/src/state/partner-store';
import { usePushStore } from '@/src/state/push-store';
import { useSettingsStore } from '@/src/state/settings-store';

const TEST_RESULT: Record<ShowResult, TranslationKey> = {
  shown: 'notifTestSent',
  denied: 'notifTestDenied',
  unavailable: 'notifTestUnavailable',
};

const PUSH_STATE_TEXT: Record<PushState, TranslationKey> = {
  unknown: 'pushStateUnknown',
  registered: 'pushStateRegistered',
  'no-permission': 'pushStateNoPermission',
  unavailable: 'pushStateUnavailable',
  'server-no-push': 'pushStateServerNoPush',
  failed: 'pushStateFailed',
};

export default function PartnerNotificationsSection() {
  const router = useRouter();
  const { t } = useI18n();
  const s = useSettingsStore();
  const paired = usePartnerStore((p) => p.paired);
  const pushState = usePushStore((p) => p.state);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const confirmUnpair = () =>
    Alert.alert(t('unpairTitle'), t('unpairBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('unpairConfirm'),
        style: 'destructive',
        onPress: () => void unpair().then((result) => {
          if (result === 'failed') Alert.alert(t('unpairFailed'));
        }),
      },
    ]);

  const test = async () => {
    setBusy(true);
    const result = await sendTestNotification();
    setBusy(false);
    Alert.alert(t('testNotification'), t(TEST_RESULT[result]));
  };

  // There is no server route for a test push (only the CLI `push-test`), so no test-push action is offered here.
  const retry = async () => {
    setRetrying(true);
    await ensureNotificationPermission(); // asks again only when Android still allows the prompt
    const state = await syncPushRegistration();
    setRetrying(false);
    if (state === 'no-permission') Alert.alert(t('pushStateTitle'), t('notifTestDenied'));
  };

  return (
    <>
      <SettingGroup>
        <InfoRow title="profilePartner" value={t(paired ? 'partnerStatusPaired' : 'partnerStatusNone')} />
        <NavRow title={paired ? 'pairShowMine' : 'pairPartner'} onPress={() => router.push('/settings/pair')} />
        <NavRow title="partnerProfile" onPress={() => router.push('/settings/partner-profile')} />
        {paired ? <ActionRow title="unpairPartner" destructive onPress={confirmUnpair} /> : null}
      </SettingGroup>
      <SettingGroup>
        <NavRow title="statusItems" description="statusItemsDesc" onPress={() => router.push('/settings/status-items')} />
      </SettingGroup>
      <SettingGroup>
        <NavRow title="vaultOpen" description="vaultOpenDesc" onPress={() => router.push('/vault')} />
        <NavRow title="vaultAddFolder" onPress={() => router.push('/vault-add')} />
      </SettingGroup>
      <SettingGroup title="notificationTypes">
        <SwitchRow title="notifyMood" value={s.notifyMood} onChange={(v) => s.setSetting('notifyMood', v)} />
        <SwitchRow title="notifyEvent" value={s.notifyEvent} onChange={(v) => s.setSetting('notifyEvent', v)} />
        <SwitchRow title="notifyDiary" value={s.notifyDiary} onChange={(v) => s.setSetting('notifyDiary', v)} />
        <SwitchRow title="notifyPeriod" value={s.notifyPeriod} onChange={(v) => s.setSetting('notifyPeriod', v)} />
      </SettingGroup>
      {paired ? (
        <SettingGroup>
          <InfoRow title="pushStateTitle" description="pushBatteryHint" value={t(PUSH_STATE_TEXT[pushState])} />
          <ActionRow title="pushRetry" description="pushRetryDesc" busy={retrying} onPress={() => void retry()} />
        </SettingGroup>
      ) : null}
      <SettingGroup>
        <ActionRow title="testNotification" busy={busy} onPress={() => void test()} />
      </SettingGroup>
    </>
  );
}
