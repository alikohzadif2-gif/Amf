import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { ActionRow, InfoRow, NavRow, SettingGroup } from '@/components/settings/SettingRows';
import { Notice } from '@/components/server/ui';
import { connectDrive, disconnectDrive, driveProvider } from '@/src/drive/manage';
import type { DriveErrorKind } from '@/src/drive/errors';
import { useI18n, type TranslationKey } from '@/src/i18n';
import { formatBytes } from '@/src/library/ui/format';
import { useDriveStore } from '@/src/state/drive-store';
import { useSettingsStore } from '@/src/state/settings-store';

const ERROR_TEXT: Partial<Record<DriveErrorKind, TranslationKey>> = {
  unsupported: 'driveUnsupported',
  network: 'driveSignInFailed',
  quota: 'driveQuotaFull',
  unauthorized: 'driveSessionExpired',
  http: 'driveSignInFailed',
  forbidden: 'driveSignInFailed',
  protocol: 'driveSignInFailed',
  'not-found': 'driveSignInFailed',
};

/** Settings > Google Drive: sign in/out, the Archive folder, storage use and a connection test. */
export default function GoogleDriveSection() {
  const router = useRouter();
  const { t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const account = useDriveStore((s) => s.account);
  const rootFolder = useDriveStore((s) => s.rootFolder);
  const [busy, setBusy] = useState<'in' | 'test' | null>(null);
  const [message, setMessage] = useState<{ text: TranslationKey; tone: 'ok' | 'error' } | null>(null);
  const [usage, setUsage] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const about = await driveProvider()?.about();
      const used = Number(about?.storageQuota?.usage ?? NaN);
      const limit = Number(about?.storageQuota?.limit ?? NaN);
      if (!Number.isFinite(used)) return setUsage(null);
      setUsage(Number.isFinite(limit) && limit > 0 ? `${formatBytes(used, t, digits)} / ${formatBytes(limit, t, digits)}` : formatBytes(used, t, digits));
    } catch {
      setUsage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits, t]);

  useEffect(() => {
    if (account) void loadUsage();
    else setUsage(null);
  }, [account, loadUsage]);

  const signIn = async () => {
    setBusy('in');
    setMessage(null);
    const result = await connectDrive();
    setBusy(null);
    if (!result.ok && result.error !== 'cancelled') setMessage({ text: ERROR_TEXT[result.error] ?? 'driveSignInFailed', tone: 'error' });
  };

  const test = async () => {
    setBusy('test');
    const result = await driveProvider()?.test();
    setBusy(null);
    setMessage(result?.ok ? { text: 'driveTestOk', tone: 'ok' } : { text: result?.code === 'unauthorized' ? 'driveSessionExpired' : 'driveSignInFailed', tone: 'error' });
    if (result?.ok) void loadUsage();
  };

  const signOut = () =>
    Alert.alert(t('driveSignOutTitle'), t('driveSignOutBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('driveSignOut'), style: 'destructive', onPress: () => void disconnectDrive() },
    ]);

  if (!account) {
    return (
      <>
        <Notice>{t('driveSignInDesc')}</Notice>
        {message ? <Notice tone={message.tone}>{t(message.text)}</Notice> : null}
        <SettingGroup>
          <ActionRow title="driveSignIn" icon="log-in" busy={busy === 'in'} onPress={signIn} />
        </SettingGroup>
      </>
    );
  }

  return (
    <>
      <SettingGroup>
        <InfoRow title="driveAccount" value={account.email} />
        <InfoRow title="driveFolder" description="driveFolderDesc" value={rootFolder?.name ?? '…'} />
        <NavRow title="driveChangeFolder" onPress={() => router.push('/settings/drive-folder' as never)} />
        {usage ? <InfoRow title="driveStorage" value={usage} /> : null}
      </SettingGroup>
      {message ? <Notice tone={message.tone}>{t(message.text)}</Notice> : null}
      <SettingGroup>
        <ActionRow title="driveTest" icon="activity" busy={busy === 'test'} onPress={test} />
        <ActionRow title="driveSignOut" icon="log-out" destructive onPress={signOut} />
      </SettingGroup>
    </>
  );
}
