import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BackButton, Button, Field, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { setServerPrefill } from '@/src/server/prefill';
import { getSshInstaller, type SshInstallResult } from '@/src/server/ssh-installer';

const FAILURE: Record<Extract<SshInstallResult, { ok: false }>['code'], TranslationKey> = {
  'not-implemented': 'sshNotImplemented',
  'auth-failed': 'sshAuthFailed',
  unreachable: 'sshUnreachable',
  'install-failed': 'sshFailed',
};

/**
 * SSH quick setup. The screen only talks to the SshInstaller interface (a stub
 * in Phase 4, the real SSH client in Phase 11). Credentials stay in this
 * component's memory and are wiped when it closes; nothing is stored.
 */
export default function SshSetupScreen() {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [method, setMethod] = useState<'password' | 'key'>('password');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const install = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await getSshInstaller().install({
        host: host.trim(),
        port: Number.parseInt(port, 10) || 22,
        username: username.trim(),
        auth: method === 'password' ? { kind: 'password', password: secret } : { kind: 'key', privateKey: secret },
      });
      if (!alive.current) return;
      if (result.ok) {
        // The installer returns URL + token; hand them to the normal add-server flow.
        setServerPrefill({ url: result.url, token: result.token, name: result.name, fingerprint: result.certFingerprint });
        router.replace({ pathname: '/settings/add-server', params: { prefill: '1' } });
      } else {
        setFailure(FAILURE[result.code]);
      }
    } catch {
      if (alive.current) setFailure('sshFailed');
    } finally {
      setSecret('');
      if (alive.current) setBusy(false);
    }
  };

  const choice = (value: 'password' | 'key', label: TranslationKey) => (
    <Pressable
      key={value}
      accessibilityRole="radio"
      accessibilityState={{ selected: method === value }}
      onPress={() => setMethod(value)}
      style={{
        flex: 1,
        minHeight: 42,
        borderRadius: 14,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderColor: method === value ? colors.primary : colors.border,
        backgroundColor: method === value ? colors.primary + '1F' : 'transparent',
      }}
    >
      <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13 }}>{t(label)}</Text>
    </Pressable>
  );

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="addServerSsh" intro="addServerSshDesc" />
      <Field label="sshHost" value={host} onChange={setHost} keyboardType="url" />
      <Field label="sshPort" value={port} onChange={setPort} keyboardType="number-pad" />
      <Field label="sshUser" value={username} onChange={setUsername} />
      <View style={{ flexDirection: rowOf(isRTL), gap: 10, marginBottom: 14 }}>
        {choice('password', 'sshAuthPassword')}
        {choice('key', 'sshAuthKey')}
      </View>
      <Field label={method === 'password' ? 'sshAuthPassword' : 'sshAuthKey'} value={secret} onChange={setSecret} secure={method === 'password'} multiline={method === 'key'} />
      {!getSshInstaller().available ? <Notice tone="warn">{t('sshNotImplemented')}</Notice> : null}
      {failure && getSshInstaller().available ? <Notice tone="error">{t(failure)}</Notice> : null}
      <Button title="sshInstall" primary busy={busy} disabled={host.trim() === '' || username.trim() === '' || secret === '' || !getSshInstaller().available} onPress={() => void install()} />
    </ScreenFrame>
  );
}
