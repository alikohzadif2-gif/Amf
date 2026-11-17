import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import QRCode from 'react-native-qrcode-svg';
import { QrScanner } from '@/components/server/QrScanner';
import { TokenNotAcceptedNotice } from '@/components/server/TokenNotAcceptedNotice';
import { BackButton, Button, Card, Field, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';
import { acceptPairing, beginPairing, checkPendingPairing, type InviteFailure, type InviteProgress, type JoinFailure } from '@/src/partner/manage';
import { parseMailboxInvite } from '@/src/partner/pairing';
import { usePartnerStore } from '@/src/state/partner-store';
import { useServersStore } from '@/src/state/servers-store';

const INVITE_ERRORS: Record<InviteFailure, TranslationKey> = {
  'no-server': 'pairNoServer',
  'missing-token': 'pairMissingToken',
  feature: 'pairMailboxMissing',
  owner: 'pairOwnerRequired',
  full: 'pairHouseholdFull',
  network: 'pairInviteFailed',
  storage: 'pairStorageFail',
};
const JOIN_ERRORS: Record<JoinFailure, TranslationKey> = {
  invalid: 'pairInvalid',
  full: 'pairHouseholdFull',
  network: 'pairInviteFailed',
  storage: 'pairStorageFail',
  already: 'pairAlready',
  name: 'pairNameRequired',
};
const LINK_LABEL = {
  connected: 'linkConnected',
  connecting: 'linkConnecting',
  offline: 'linkOffline',
  stopped: 'linkStopped',
  unauthorized: 'linkUnauthorized',
} as const;

function InvitePanel({ onError }: { onError: (key: TranslationKey | null) => void }) {
  const router = useRouter();
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const servers = useServersStore((state) => state.servers);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ link: string; expiresAt: string; serverName: string } | null>(null);
  const [progress, setProgress] = useState<InviteProgress | null>(null);

  useEffect(() => {
    if (!invite || progress !== 'waiting') return;
    let active = true;
    const check = async () => {
      const result = await checkPendingPairing();
      if (!active || result === 'waiting') return;
      setProgress(result);
      if (result === 'expired') onError('pairInviteExpired');
      else if (result === 'failed') onError('pairInviteFailed');
    };
    void check();
    const timer = setInterval(() => void check(), 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [invite, progress, onError]);

  const create = async () => {
    onError(null);
    setBusy(true);
    const result = await beginPairing(selectedId || servers[0]?.id || '');
    setBusy(false);
    if (result.kind === 'error') {
      onError(INVITE_ERRORS[result.reason]);
      return;
    }
    setInvite(result);
    setProgress('waiting');
  };

  const textStyle = {
    color: colors.mutedForeground,
    fontFamily: fontFamilyFor(language),
    fontSize: 13,
    lineHeight: language === 'fa' ? 25 : 20,
    textAlign: alignOf(isRTL),
  } as const;
  const expiry = invite
    ? new Date(invite.expiresAt).toLocaleString(language === 'fa' ? 'fa-IR' : 'en')
    : '';

  return (
    <Card>
      {invite ? (
        <>
          {progress === 'paired' ? (
            <>
              <Notice tone="ok">{t('pairConnected')}</Notice>
              <Button title="pairDone" primary onPress={() => router.back()} />
            </>
          ) : (
            <>
              <Notice>{t(progress === 'expired' ? 'pairInviteExpired' : 'pairWaiting')}</Notice>
              <Text style={textStyle}>{`${t('pairInviteServer')}: ${invite.serverName}`}</Text>
              <Text style={textStyle}>{`${t('pairInviteExpires')}: ${expiry}`}</Text>
              <View style={{ alignItems: 'center', marginVertical: 12 }}>
                <View style={{ backgroundColor: '#FFFFFF', padding: 12, borderRadius: 16 }}>
                  <QRCode value={invite.link} size={220} color="#000000" backgroundColor="#FFFFFF" />
                </View>
              </View>
              <Text style={textStyle}>{t('pairCodeHint')}</Text>
              <Text selectable style={[textStyle, { color: colors.foreground, marginTop: 10 }]}>{invite.link}</Text>
            </>
          )}
        </>
      ) : servers.length === 0 ? (
        <>
          <Notice tone="warn">{t('pairNoServer')}</Notice>
          <Button title="pairAddServer" primary onPress={() => router.push('/settings/servers')} />
        </>
      ) : (
        <>
          <Text style={{ ...textStyle, fontFamily: fontFamilyFor(language, 'semibold') }}>{t('pairChooseServer')}</Text>
          <View style={{ gap: 8 }}>
            {servers.map((server) => (
              <Pressable
                key={server.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: server.id === (selectedId || servers[0]?.id) }}
                onPress={() => setSelectedId(server.id)}
                style={({ pressed }) => ({
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: server.id === (selectedId || servers[0]?.id) ? colors.primary : colors.border,
                  backgroundColor: pressed ? colors.raised : colors.card,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                })}
              >
                <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }}>
                  {server.name} · {server.url}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={textStyle}>{t('pairInviteUsesServer')}</Text>
          <Button title="pairCreate" primary busy={busy} onPress={() => void create()} />
        </>
      )}
    </Card>
  );
}

function PairedStatus() {
  const router = useRouter();
  const { t } = useI18n();
  const partner = usePartnerStore((state) => state.partner);
  const link = usePartnerStore((state) => state.link);
  return (
    <Card>
      <Notice tone="ok">{t('pairConnected')}</Notice>
      {link === 'unauthorized' ? <TokenNotAcceptedNotice /> : <Notice>{t(LINK_LABEL[link])}</Notice>}
      {partner?.name ? <Notice>{`${t('profilePartner')}: ${partner.name}`}</Notice> : null}
      <Button title="pairDone" primary onPress={() => router.back()} />
    </Card>
  );
}

export default function PairScreen() {
  const { t } = useI18n();
  const paired = usePartnerStore((state) => state.paired);
  const [mode, setMode] = useState<'menu' | 'invite' | 'scan' | 'paste' | 'join'>('menu');
  const [error, setError] = useState<TranslationKey | null>(null);
  const [pasted, setPasted] = useState('');
  const [invite, setInvite] = useState<{ url: string; code: string } | null>(null);
  const [deviceName, setDeviceName] = useState(usePartnerStore.getState().me.name ?? '');
  const [busy, setBusy] = useState(false);

  const readInvite = (raw: string) => {
    const parsed = parseMailboxInvite(raw);
    if (!parsed) {
      setError('pairInvalid');
      setMode('menu');
      return;
    }
    setError(null);
    setInvite(parsed);
    setMode('join');
  };

  const join = async () => {
    if (!invite) return;
    setError(null);
    setBusy(true);
    const result = await acceptPairing(invite, deviceName);
    setBusy(false);
    if (result !== 'ok') setError(JOIN_ERRORS[result]);
  };

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="pairTitle" intro={paired ? undefined : 'pairIntro'} />
      {error ? <Notice tone="error">{t(error)}</Notice> : null}
      {paired ? (
        <PairedStatus />
      ) : mode === 'menu' ? (
        <View style={{ gap: 10 }}>
          <Button title="pairInvitePartner" primary icon="grid" onPress={() => { setError(null); setMode('invite'); }} />
          <Button title="pairJoinPartner" icon="user-plus" onPress={() => setMode('scan')} />
          <Button title="pairPasteTheirs" icon="clipboard" onPress={() => setMode('paste')} />
        </View>
      ) : mode === 'invite' ? (
        <InvitePanel onError={setError} />
      ) : mode === 'scan' ? (
        <QrScanner hint="scanPairHint" onScanned={readInvite} onCancel={() => setMode('menu')} />
      ) : mode === 'paste' ? (
        <Card>
          <Field label="pairPasteField" value={pasted} onChange={setPasted} multiline />
          <View style={{ gap: 10 }}>
            <Button title="pairContinue" primary onPress={() => readInvite(pasted)} />
            <Button title="cancel" onPress={() => setMode('menu')} />
          </View>
        </Card>
      ) : (
        <Card>
          <Notice>{`${t('pairJoinServer')}: ${invite?.url ?? ''}`}</Notice>
          <Field label="pairDeviceName" value={deviceName} onChange={setDeviceName} />
          <View style={{ gap: 10 }}>
            <Button title="pairJoin" primary busy={busy} onPress={() => void join()} />
            <Button title="cancel" onPress={() => { setInvite(null); setMode('menu'); }} />
          </View>
        </Card>
      )}
    </ScreenFrame>
  );
}
