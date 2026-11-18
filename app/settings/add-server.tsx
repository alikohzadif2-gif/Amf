import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { FingerprintConfirm } from '@/components/server/FingerprintConfirm';
import { ConnectionNotice } from '@/components/server/ConnectionStatus';
import { QrScanner } from '@/components/server/QrScanner';
import { Button, BackButton, Card, Field, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { isValidServerUrl, normalizeUrl } from '@/src/server/client';
import { takeServerPrefill } from '@/src/server/prefill';
import { parseServerQr } from '@/src/server/qr';
import { testConnection, type ConnectionTest } from '@/src/server/test-connection';
import { secureTokenStore } from '@/src/server/token-store';
import { useServersStore } from '@/src/state/servers-store';
import { useSettingsStore } from '@/src/state/settings-store';

type Step = 'form' | 'scan' | 'fingerprint' | 'place';

/**
 * Add-server wizard: manual URL + token or QR, test connection, optional
 * certificate fingerprint confirmation, then choose a new server or another
 * address (failover) of an existing one. The token goes to SecureStore.
 */
export default function AddServerScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ method?: string; sourceId?: string; prefill?: string; invalid?: string }>();
  const { language, isRTL, t } = useI18n();
  const confirmFingerprint = useSettingsStore((s) => s.confirmFingerprint);
  const addServer = useServersStore((s) => s.addServer);
  const servers = useServersStore((s) => s.servers);

  const [step, setStep] = useState<Step>(params.method === 'qr' ? 'scan' : 'form');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [link, setLink] = useState('');
  const [qrFingerprint, setQrFingerprint] = useState<string | undefined>();
  const [error, setError] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [confirmedFp, setConfirmedFp] = useState<string | undefined>();
  const [choice, setChoice] = useState<string>(params.sourceId ?? 'new');

  useEffect(() => {
    if (params.invalid === '1') setError('qrInvalid');
    if (params.prefill !== '1') return;
    const value = takeServerPrefill();
    if (!value) return;
    setUrl(value.url);
    setToken(value.token);
    if (value.name) setName(value.name);
    setQrFingerprint(value.fingerprint);
    void runTest(value.url, value.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved servers are grouped by `sourceId` (addresses of the same server, tried in order).
  const existing = [...new Map<string, { id: string; name: string }>(servers.map((e) => [e.sourceId, { id: e.sourceId, name: e.name }] as const)).values()];
  const isHttps = /^https:/i.test(normalizeUrl(url));

  const validate = (): boolean => {
    if (!isValidServerUrl(url)) {
      setError('urlInvalid');
      return false;
    }
    if (token.trim() === '') {
      setError('tokenRequired');
      return false;
    }
    setError(null);
    return true;
  };

  const runTest = async (nextUrl = url, nextToken = token): Promise<ConnectionTest> => {
    setBusy(true);
    setResult(null);
    const outcome = await testConnection({ url: nextUrl, token: nextToken.trim() });
    setResult(outcome);
    setBusy(false);
    return outcome;
  };

  /** Fills the form from a scanned / pasted / opened server code and tests it right away. */
  const applyServer = (parsed: NonNullable<ReturnType<typeof parseServerQr>>) => {
    setUrl(parsed.url);
    setToken(parsed.token);
    if (parsed.name) setName(parsed.name);
    setQrFingerprint(parsed.fingerprint);
    setError(null);
    void runTest(parsed.url, parsed.token);
  };

  const onLinkChange = (value: string) => {
    const parsed = parseServerQr(value);
    if (parsed) {
      setLink(''); // do not keep the token visible in a text field
      applyServer(parsed);
    } else {
      setLink(value);
    }
  };

  const onScanned = (raw: string) => {
    const parsed = parseServerQr(raw);
    if (!parsed) {
      setError('qrInvalid');
      setStep('form');
      return;
    }
    setStep('form');
    applyServer(parsed);
  };

  const next = async () => {
    if (!validate()) return;
    const outcome = result?.ok ? result : await runTest();
    if (!outcome.ok) return;
    const reported = outcome.ping?.certFingerprint;
    if (isHttps && confirmFingerprint && (reported || qrFingerprint)) {
      setStep('fingerprint');
      return;
    }
    setConfirmedFp(reported ?? qrFingerprint);
    if (existing.length === 0 || params.sourceId) void save(reported ?? qrFingerprint, params.sourceId ?? 'new');
    else setStep('place');
  };

  const save = async (fingerprint: string | undefined, target: string) => {
    setBusy(true);
    setError(null);
    try {
      const displayName = name.trim() || result?.ping?.name || undefined;
      const sourceId = target === 'new' ? `server-${Date.now().toString(36)}` : target;
      const id = addServer({
        sourceId,
        name: displayName ?? t('sourceKindServer'),
        url: normalizeUrl(url),
        fingerprint,
        fingerprintConfirmed: fingerprint ? true : undefined,
      });
      try {
        await secureTokenStore.set(id, token.trim());
      } catch {
        await useServersStore.getState().removeServer(id);
        setError('serverSaveFailed');
        setStep('form');
        setBusy(false);
        return;
      }
      router.replace('/settings/servers');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenFrame scroll>
      <BackButton />
      {step === 'scan' ? (
        <View>
          <Title title="scanQr" />
          <QrScanner onScanned={onScanned} onCancel={() => setStep('form')} />
        </View>
      ) : step === 'fingerprint' ? (
        <FingerprintConfirm
          fingerprint={result?.ping?.certFingerprint}
          qrFingerprint={qrFingerprint}
          onCancel={() => setStep('form')}
          onTrust={() => {
            const fp = result?.ping?.certFingerprint ?? qrFingerprint;
            setConfirmedFp(fp);
            if (existing.length === 0 || params.sourceId) void save(fp, params.sourceId ?? 'new');
            else setStep('place');
          }}
        />
      ) : step === 'place' ? (
        <View>
          <Title title="serverPlaceTitle" />
          <Card>
            {[{ id: 'new', label: t('serverPlaceNew'), sub: '' }, ...existing.map((s) => ({
              id: s.id,
              label: t('serverPlaceAddressOf'),
              sub: s.name ?? servers.find((e) => e.sourceId === s.id)?.name ?? t('sourceKindServer'),
            }))].map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: choice === option.id }}
                onPress={() => setChoice(option.id)}
                style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 10 }}
              >
                <Feather name={choice === option.id ? 'check-circle' : 'circle'} size={20} color={choice === option.id ? colors.primary : colors.mutedForeground} />
                <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 14 }}>
                  {option.label}
                  {option.sub ? ` ${option.sub}` : ''}
                </Text>
              </Pressable>
            ))}
          </Card>
          {error ? <Notice tone="error">{t(error)}</Notice> : null}
          <Button title="serverSave" primary busy={busy} onPress={() => void save(confirmedFp, choice)} />
        </View>
      ) : (
        <View>
          <Title title="addServerTitle" intro="addServerIntro" />
          <Field label="fieldLink" value={link} onChange={onLinkChange} placeholder="meyou://server?url=…" keyboardType="url" />
          {link.trim() !== '' ? <Notice tone="error">{t('linkInvalid')}</Notice> : null}
          <Field label="fieldName" value={name} onChange={setName} />
          <Field label="fieldUrl" value={url} onChange={(v) => { setUrl(v); setResult(null); }} placeholder="https://192.168.1.10:8443" keyboardType="url" />
          <Field label="fieldToken" value={token} onChange={(v) => { setToken(v); setResult(null); }} secure />
          {url !== '' && isValidServerUrl(url) && !isHttps ? <Notice tone="warn">{t('httpWarning')}</Notice> : null}
          {error ? <Notice tone="error">{t(error)}</Notice> : null}
          {result ? <ConnectionNotice test={result} /> : null}
          <View style={{ gap: 10 }}>
            <Button title="testConnection" busy={busy} onPress={() => validate() && void runTest()} />
            <Button title="scanQr" icon="camera" onPress={() => setStep('scan')} />
            <Button title="serverSave" primary busy={busy} onPress={() => void next()} />
          </View>
        </View>
      )}
    </ScreenFrame>
  );
}
