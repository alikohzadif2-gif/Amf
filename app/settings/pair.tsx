import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import QRCode from 'react-native-qrcode-svg';
import { ConnectionNotice } from '@/components/server/ConnectionStatus';
import { FingerprintConfirm } from '@/components/server/FingerprintConfirm';
import { QrScanner } from '@/components/server/QrScanner';
import { TokenNotAcceptedNotice } from '@/components/server/TokenNotAcceptedNotice';
import { BackButton, Button, Card, Field, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { e2ePairing } from '@/src/e2e';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';
import { acceptPairing, beginPairing, checkPendingPairing, type InviteFailure, type InviteProgress, type JoinFailure } from '@/src/partner/manage';
import { parseMailboxInvite } from '@/src/partner/pairing';
import { normalizeUrl } from '@/src/server/client';
import { parseServerQr, type QrServer } from '@/src/server/qr';
import { testConnection, type ConnectionTest } from '@/src/server/test-connection';
import { secureTokenStore } from '@/src/server/token-store';
import { usePartnerStore } from '@/src/state/partner-store';
import { useServersStore } from '@/src/state/servers-store';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * Add partner: ONE flow for what used to be three screens (add server, add partner, private pairing).
 *  - Invite: connect your server if you have not yet (paste or scan its link, once) -> ONE QR appears.
 *  - Join:   scan that QR (or paste its link) -> connected. No server to add, no code to compare.
 * The QR carries the server invitation AND the key of the private messages, so a single in-person scan does it all.
 */
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

type SetError = (key: TranslationKey | null) => void;

function useTextStyle() {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return {
    color: colors.mutedForeground,
    fontFamily: fontFamilyFor(language),
    fontSize: 13,
    lineHeight: language === 'fa' ? 25 : 20,
    textAlign: alignOf(isRTL),
  } as const;
}

/** Step 0 of an invitation, only while no server is saved: one link or QR from the server setup. Done once, ever. */
function ServerStep({ onError, onExit }: { onError: SetError; onExit: () => void }) {
  const { t } = useI18n();
  const textStyle = useTextStyle();
  const confirmFingerprint = useSettingsStore((s) => s.confirmFingerprint);
  const addServer = useServersStore((s) => s.addServer);
  const [step, setStep] = useState<'form' | 'scan' | 'fingerprint'>('form');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [parsed, setParsed] = useState<QrServer | null>(null);
  const [scanKey, setScanKey] = useState(0);
  const working = useRef(false);

  const save = async (server: QrServer, fingerprint: string | undefined, serverName?: string) => {
    const id = addServer({
      sourceId: `server-${Date.now().toString(36)}`,
      name: server.name || serverName || t('sourceKindServer'),
      url: normalizeUrl(server.url),
      fingerprint,
      fingerprintConfirmed: fingerprint ? true : undefined,
    });
    try {
      await secureTokenStore.set(id, server.token.trim());
    } catch {
      await useServersStore.getState().removeServer(id);
      onError('serverSaveFailed');
      setStep('form');
    }
    // Saved: the parent sees the new server and goes on to the QR by itself.
  };

  const connect = async (server: QrServer) => {
    if (working.current) return;
    working.current = true;
    onError(null);
    setBusy(true);
    setResult(null);
    try {
      const outcome = await testConnection({ url: server.url, token: server.token.trim() });
      setResult(outcome);
      if (!outcome.ok) return;
      const reported = outcome.ping?.certFingerprint;
      setParsed(server);
      if (/^https:/i.test(normalizeUrl(server.url)) && confirmFingerprint && (reported || server.fingerprint)) {
        setStep('fingerprint');
        return;
      }
      await save(server, reported ?? server.fingerprint, outcome.ping?.name);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const read = (raw: string) => {
    const server = parseServerQr(raw);
    if (!server) {
      onError('qrInvalid');
      setLink('');
      setStep('form');
      setScanKey((k) => k + 1);
      return;
    }
    setLink(''); // never keep the token visible in a text field
    setStep('form');
    void connect(server);
  };

  if (step === 'fingerprint' && parsed) {
    const fp = result?.ok ? result.ping?.certFingerprint : undefined;
    return (
      <FingerprintConfirm
        fingerprint={fp}
        qrFingerprint={parsed.fingerprint}
        onCancel={() => setStep('form')}
        onTrust={() => void save(parsed, fp ?? parsed.fingerprint, result?.ok ? result.ping?.name : undefined)}
      />
    );
  }
  if (step === 'scan') {
    return <QrScanner key={scanKey} hint="scanQrHint" onScanned={read} onCancel={() => setStep('form')} />;
  }
  return (
    <View style={{ gap: 10 }}>
      <Card>
        <Text style={textStyle}>{t('pairServerFirst')}</Text>
        <View style={{ marginTop: 12 }}>
          <Field
            label="fieldLink"
            value={link}
            onChange={(value) => {
              setLink(value);
              if (parseServerQr(value)) read(value);
            }}
            placeholder="meyou://server?url=…"
            keyboardType="url"
          />
        </View>
        {result ? <ConnectionNotice test={result} /> : null}
        <Button title="scanQr" icon="camera" busy={busy} onPress={() => { onError(null); setStep('scan'); }} />
      </Card>
      <Button title="cancel" onPress={onExit} />
    </View>
  );
}

/** The invitation: ONE QR (server invitation + key of the private messages), then wait for the partner. */
function InvitePanel({ onError, onExit }: { onError: SetError; onExit: () => void }) {
  const router = useRouter();
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const textStyle = useTextStyle();
  const servers = useServersStore((state) => state.servers);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ link: string; expiresAt: string; serverName: string } | null>(null);
  const [progress, setProgress] = useState<InviteProgress | null>(null);
  const creating = useRef(false);
  const autoTried = useRef(false);

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
    if (creating.current) return;
    creating.current = true;
    onError(null);
    setBusy(true);
    const result = await beginPairing(selectedId || servers[0]?.id || '');
    setBusy(false);
    creating.current = false;
    if (result.kind === 'error') {
      onError(INVITE_ERRORS[result.reason]);
      return;
    }
    setInvite(result);
    setProgress('waiting');
  };

  // One server (the normal case): no question to answer, the QR simply appears.
  useEffect(() => {
    if (autoTried.current || servers.length !== 1) return;
    autoTried.current = true;
    void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.length]);

  const expiry = invite ? new Date(invite.expiresAt).toLocaleString(language === 'fa' ? 'fa-IR' : 'en') : '';

  if (invite && progress === 'paired') {
    return (
      <Card>
        <Notice tone="ok">{t('pairConnected')}</Notice>
        <Button title="pairDone" primary onPress={() => router.back()} />
      </Card>
    );
  }
  if (invite && progress === 'waiting') {
    return (
      <View style={{ gap: 10 }}>
        <Card>
          <Notice>{t('pairWaiting')}</Notice>
          <View style={{ alignItems: 'center', marginVertical: 12 }}>
            <View style={{ backgroundColor: '#FFFFFF', padding: 12, borderRadius: 16 }}>
              <QRCode value={invite.link} size={240} color="#000000" backgroundColor="#FFFFFF" ecl="M" />
            </View>
          </View>
          <Text style={textStyle}>{t('pairQrHint')}</Text>
          <Text style={[textStyle, { marginTop: 6 }]}>{`${t('pairInviteExpires')}: ${expiry}`}</Text>
        </Card>
        <Button title="cancel" onPress={onExit} />
      </View>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      <Card>
        {servers.length > 1 ? (
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
          </>
        ) : null}
        <Button title="pairCreate" primary busy={busy} onPress={() => { setInvite(null); setProgress(null); void create(); }} />
      </Card>
      <Button title="cancel" onPress={onExit} />
    </View>
  );
}

/** Join: scan the partner's QR (or paste its link). With a profile name nothing else is asked: scan -> connected. */
function JoinPanel({ onError, onExit }: { onError: SetError; onExit: () => void }) {
  const { t } = useI18n();
  const textStyle = useTextStyle();
  const [step, setStep] = useState<'scan' | 'name'>('scan');
  const [scanKey, setScanKey] = useState(0);
  const [pasted, setPasted] = useState('');
  const [invite, setInvite] = useState<{ url: string; code: string; key?: string } | null>(null);
  const [deviceName, setDeviceName] = useState(usePartnerStore.getState().me.name ?? '');
  const [busy, setBusy] = useState(false);
  const joining = useRef(false);

  const join = async (target: { url: string; code: string; key?: string }, name: string) => {
    if (joining.current) return;
    joining.current = true;
    onError(null);
    setBusy(true);
    const result = await acceptPairing(target, name);
    setBusy(false);
    joining.current = false;
    // On success the partner store flips to "paired" and the screen shows the connected state by itself.
    if (result !== 'ok') {
      onError(JOIN_ERRORS[result]);
      setInvite(null);
      setStep('scan');
      setScanKey((k) => k + 1);
    }
  };

  const read = (raw: string) => {
    const parsed = parseMailboxInvite(raw);
    if (!parsed) {
      onError('pairInvalid');
      setPasted('');
      setScanKey((k) => k + 1);
      return;
    }
    onError(null);
    setInvite(parsed);
    if (deviceName.trim()) void join(parsed, deviceName);
    else setStep('name');
  };

  if (busy) {
    return (
      <Card>
        <Notice>{t('pairJoining')}</Notice>
      </Card>
    );
  }
  if (step === 'name' && invite) {
    return (
      <Card>
        <Field label="pairDeviceName" value={deviceName} onChange={setDeviceName} />
        <View style={{ gap: 10 }}>
          <Button title="pairJoin" primary onPress={() => void join(invite, deviceName)} />
          <Button title="cancel" onPress={() => { setInvite(null); setStep('scan'); }} />
        </View>
      </Card>
    );
  }
  return (
    <View>
      <QrScanner key={scanKey} hint="scanPairHint" onScanned={read} onCancel={onExit} />
      <Text style={[textStyle, { marginTop: 12 }]}>{t('pairJoinHint')}</Text>
      <View style={{ marginTop: 8 }}>
        <Field label="pairPasteField" value={pasted} onChange={setPasted} multiline />
        <Button title="pairContinue" disabled={!pasted.trim()} onPress={() => read(pasted)} />
      </View>
    </View>
  );
}

function PairedStatus() {
  const router = useRouter();
  const { t } = useI18n();
  const partner = usePartnerStore((state) => state.partner);
  const link = usePartnerStore((state) => state.link);
  const [keysOk, setKeysOk] = useState(true);

  // An invitation made by an older version carries no keys: say so instead of failing silently later.
  useEffect(() => {
    let alive = true;
    void e2ePairing().status().then((s) => {
      if (alive) setKeysOk(s.state === 'paired');
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card>
      <Notice tone="ok">{t('pairConnected')}</Notice>
      {link === 'unauthorized' ? <TokenNotAcceptedNotice /> : <Notice>{t(LINK_LABEL[link])}</Notice>}
      {partner?.name ? <Notice>{`${t('profilePartner')}: ${partner.name}`}</Notice> : null}
      {keysOk ? null : (
        <>
          <Notice tone="warn">{t('pairNoKeys')}</Notice>
          <Button title="e2eRow" onPress={() => router.push('/settings/secure-pairing')} />
        </>
      )}
      <Button title="pairDone" primary onPress={() => router.back()} />
    </Card>
  );
}

export default function PairScreen() {
  const { t } = useI18n();
  const paired = usePartnerStore((state) => state.paired);
  const servers = useServersStore((state) => state.servers);
  const [mode, setMode] = useState<'menu' | 'invite' | 'join'>('menu');
  const [error, setError] = useState<TranslationKey | null>(null);
  const exit = () => {
    setError(null);
    setMode('menu');
  };

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="pairTitle" intro={paired || mode !== 'menu' ? undefined : 'pairIntro'} />
      {error ? <Notice tone="error">{t(error)}</Notice> : null}
      {paired ? (
        <PairedStatus />
      ) : mode === 'menu' ? (
        <View style={{ gap: 10 }}>
          <Button title="pairInvitePartner" primary icon="grid" onPress={() => { setError(null); setMode('invite'); }} />
          <Button title="pairJoinPartner" icon="user-plus" onPress={() => { setError(null); setMode('join'); }} />
        </View>
      ) : mode === 'invite' ? (
        servers.length === 0 ? <ServerStep onError={setError} onExit={exit} /> : <InvitePanel onError={setError} onExit={exit} />
      ) : (
        <JoinPanel onError={setError} onExit={exit} />
      )}
    </ScreenFrame>
  );
}
