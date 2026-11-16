import { View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';
import { Button, Card, Notice, Title } from './ui';

/** Groups a hex fingerprint as AA:BB:CC so it is easy to compare by eye. */
export function formatFingerprint(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length === 0 || hex.length % 2 !== 0) return raw.trim();
  return hex.match(/.{2}/g)!.join(':');
}

/**
 * Fingerprint confirm screen (UI only in Phase 4). The server reports its
 * certificate fingerprint in /ping; the user confirms it matches what the
 * server shows. Real pinning (checking the TLS certificate on every
 * connection) arrives in Phase 11.
 */
export function FingerprintConfirm({
  fingerprint,
  qrFingerprint,
  onTrust,
  onCancel,
}: {
  fingerprint?: string;
  qrFingerprint?: string;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const mismatch =
    !!fingerprint && !!qrFingerprint && formatFingerprint(fingerprint) !== formatFingerprint(qrFingerprint);
  const shown = fingerprint ?? qrFingerprint;
  return (
    <View>
      <Title title="fpTitle" intro="fpBody" />
      <Card>
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 12, textAlign: alignOf(isRTL) }}>
          {t('fpLabel')}
        </Text>
        <Text
          selectable
          style={{ color: colors.foreground, fontFamily: 'monospace', fontSize: 13, lineHeight: 22, marginTop: 8, textAlign: 'left', writingDirection: 'ltr' }}
        >
          {shown ? formatFingerprint(shown) : t('fpNone')}
        </Text>
      </Card>
      {mismatch ? <Notice tone="error">{t('fpMismatch')}</Notice> : null}
      <Notice>{t('fpLater')}</Notice>
      <View style={{ gap: 10 }}>
        <Button title="fpTrust" primary disabled={mismatch} onPress={onTrust} />
        <Button title="cancel" onPress={onCancel} />
      </View>
    </View>
  );
}
