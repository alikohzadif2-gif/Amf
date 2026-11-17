import { useEffect, useState } from 'react';
import { Alert, Share } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { QrScanner } from '@/components/server/QrScanner';
import { BackButton, Button, Card, Field, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { e2ePairing } from '@/src/e2e';
import { kindOfPayload, payloadFromText, toPairingLink } from '@/src/e2e/link';
import { syncMailbox } from '@/src/partner/manage';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';

type Mode = 'menu' | 'show-req' | 'scan-key' | 'scan-req' | 'show-key' | 'code' | 'paired';

const ERRORS: Record<string, TranslationKey> = {
  invalid: 'e2eErrInvalid',
  wrong: 'e2eErrWrong',
  expired: 'e2eErrExpired',
  'no-pending': 'e2eErrNoPending',
  already: 'e2eErrAlready',
  storage: 'e2eErrStorage',
};

function QrBox({ value }: { value: string }) {
  return (
    <View style={{ alignItems: 'center', marginVertical: 12 }}>
      <View style={{ backgroundColor: '#FFFFFF', padding: 12, borderRadius: 16 }}>
        <QRCode value={value} size={240} color="#000000" backgroundColor="#FFFFFF" ecl="M" />
      </View>
    </View>
  );
}

export default function SecurePairingScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const [mode, setMode] = useState<Mode>('menu');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [since, setSince] = useState(0);
  const [error, setError] = useState<TranslationKey | null>(null);
  const params = useLocalSearchParams<{ c?: string }>();
  const [pasted, setPasted] = useState('');

  // Open on the right step when the person comes back (the keys live in SecureStore).
  useEffect(() => {
    let alive = true;
    void e2ePairing().status().then((s) => {
      if (!alive) return;
      if (s.state === 'paired') { setCode(s.code); setSince(s.createdAt); setMode('paired'); }
      else if (s.state === 'unconfirmed') { setCode(s.code); setMode('code'); }
    });
    return () => { alive = false; };
  }, []);

  const textStyle = { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, lineHeight: language === 'fa' ? 25 : 20, textAlign: alignOf(isRTL) } as const;
  const fail = (reason: string) => { setError(ERRORS[reason] ?? 'e2eErrInvalid'); setMode('menu'); };

  const showFirst = async () => {
    setError(null);
    const r = await e2ePairing().startRequest();
    if (!r.ok) return fail(r.reason);
    setQr(r.qr);
    setMode('show-req');
  };
  const onScanReq = async (raw: string) => {
    const r = await e2ePairing().acceptRequest(raw);
    if (!r.ok) return fail(r.reason);
    setQr(r.qr);
    setCode(r.code);
    setMode('show-key');
  };
  const onScanKey = async (raw: string) => {
    const r = await e2ePairing().acceptKey(raw);
    if (!r.ok) return fail(r.reason);
    setCode(r.code);
    setMode('code');
  };
  // Pairing by link: the same two payloads as the QR codes, from a link that was opened or pasted.
  const onPayload = async (raw: string) => {
    const payload = payloadFromText(raw);
    const kind = payload ? kindOfPayload(payload) : null;
    if (!payload || !kind) return fail('invalid');
    setPasted('');
    if (kind === 'req') await onScanReq(payload);
    else await onScanKey(payload);
  };
  const shareLink = () => {
    const link = toPairingLink(qr);
    if (link) void Share.share({ message: `${t('e2eLinkMessage')}\n${link}` });
  };
  // The link opened this screen (meyou://settings/secure-pairing?c=...): continue with it once.
  useEffect(() => {
    if (typeof params.c === 'string' && params.c) void onPayload(params.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.c]);
  const confirm = async () => {
    if (!(await e2ePairing().confirm())) return fail('storage');
    const s = await e2ePairing().status();
    if (s.state === 'paired') setSince(s.createdAt);
    setMode('paired');
    void syncMailbox(); // stage 3: start following the encrypted queue now
  };
  const differ = async () => { await e2ePairing().cancel(); setMode('menu'); };
  const cancel = async () => { await e2ePairing().cancel(); setMode('menu'); };
  const reset = () =>
    Alert.alert(t('e2eResetTitle'), t('e2eResetBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('e2eResetConfirm'), style: 'destructive', onPress: () => void e2ePairing().reset().then(() => { setCode(''); setMode('menu'); void syncMailbox(); }) },
    ]);

  const pasteBox = (
    <View style={{ marginTop: 12 }}>
      <Field label="e2eLinkPasteLabel" value={pasted} onChange={setPasted} placeholder={t('e2eLinkPastePlaceholder')} multiline />
      <Button title="e2eLinkContinue" icon="link" disabled={!pasted.trim()} onPress={() => void onPayload(pasted)} />
    </View>
  );

  const codeBlock = (
    <Text selectable style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 28, letterSpacing: 2, textAlign: 'center', marginVertical: 14 }}>{code}</Text>
  );

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="e2eTitle" intro={mode === 'menu' ? 'e2eIntro' : undefined} />
      {error ? <Notice tone="error">{t(error)}</Notice> : null}
      {mode === 'menu' ? (
        <View style={{ gap: 10 }}>
          <Button title="e2eShowFirst" primary icon="grid" onPress={() => void showFirst()} />
          <Button title="scanPartnerCode" icon="user-plus" onPress={() => { setError(null); setMode('scan-req'); }} />
          <Text style={textStyle}>{t('e2eLinkHint')}</Text>
          {pasteBox}
        </View>
      ) : mode === 'show-req' ? (
        <Card>
          <QrBox value={qr} />
          <Text style={textStyle}>{t('e2eShowReqHint')}</Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            <Button title="e2eLinkShare" icon="share-2" onPress={shareLink} />
            <Button title="e2eThenScan" primary onPress={() => setMode('scan-key')} />
            <Button title="cancel" onPress={() => void cancel()} />
          </View>
          {pasteBox}
        </Card>
      ) : mode === 'scan-req' ? (
        <QrScanner hint="e2eScanReqHint" onScanned={(raw) => void onScanReq(raw)} onCancel={() => setMode('menu')} />
      ) : mode === 'scan-key' ? (
        <>
          <QrScanner hint="e2eScanKeyHint" onScanned={(raw) => void onScanKey(raw)} onCancel={() => void cancel()} />
          {pasteBox}
        </>
      ) : mode === 'show-key' ? (
        <Card>
          <QrBox value={qr} />
          <Text style={textStyle}>{t('e2eShowKeyHint')}</Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            <Button title="e2eLinkShare" icon="share-2" onPress={shareLink} />
            <Button title="e2eNext" primary onPress={() => setMode('code')} />
            <Button title="cancel" onPress={() => void cancel()} />
          </View>
        </Card>
      ) : mode === 'code' ? (
        <Card>
          <Text style={{ ...textStyle, fontFamily: fontFamilyFor(language, 'semibold') }}>{t('e2eCodeTitle')}</Text>
          {codeBlock}
          <Text style={textStyle}>{t('e2eCodeHint')}</Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            <Button title="e2eCodeMatch" primary onPress={() => void confirm()} />
            <Button title="e2eCodeDiffer" destructive onPress={() => void differ()} />
          </View>
        </Card>
      ) : (
        <Card>
          <Notice tone="ok">{t('e2ePaired')}</Notice>
          {codeBlock}
          <Text style={textStyle}>{`${t('e2ePairedSince')}: ${new Date(since).toLocaleDateString(language === 'fa' ? 'fa-IR' : 'en')}`}</Text>
          <View style={{ marginTop: 12 }}>
            <Button title="e2eReset" destructive onPress={reset} />
          </View>
        </Card>
      )}
    </ScreenFrame>
  );
}
