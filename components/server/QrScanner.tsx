import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';
import { Button, Notice } from './ui';

/** Camera view that reports the first QR code it sees (expo-camera, works in Expo Go). */
export function QrScanner({ onScanned, onCancel, hint = 'scanQrHint' }: { onScanned: (raw: string) => void; onCancel: () => void; hint?: TranslationKey }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View>
        <Notice tone="warn">{t('cameraNeeded')}</Notice>
        <View style={styles.row}>
          {permission.canAskAgain ? (
            <Button title="cameraAllow" primary onPress={() => void requestPermission()} />
          ) : (
            <Button title="openAppSettings" primary onPress={() => void Linking.openSettings()} />
          )}
          <Button title="cancel" onPress={onCancel} />
        </View>
      </View>
    );
  }

  return (
    <View>
      <View style={[styles.frame, { borderColor: colors.border }]}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            handled.current = true;
            onScanned(data);
          }}
        />
      </View>
      <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12.5, textAlign: alignOf(isRTL), marginVertical: 12 }}>
        {t(hint)}
      </Text>
      <Button title="cancel" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 320, borderRadius: 21, borderWidth: 1, overflow: 'hidden', backgroundColor: '#000' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
