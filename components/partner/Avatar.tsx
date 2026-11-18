import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { sharedImage } from '@/src/partner/manage';
import { usePartnerMediaVersion } from '@/src/partner/media-version';
import type { ImageRef } from '@/src/storage/types';

/** Resolved server photos, so a list of avatars asks the server once per path (a failure is not cached). */
const resolved = new Map<string, ImageRef>();

/**
 * Round avatar. Best source first (R10c): my private sharper copy (`uri`), the partner's sharper photo on the server (`photo`,
 * `Shared/avatar-<deviceId>/...`), then the tiny photo (`b64`, base64 JPEG, always available), then the first letter of the name.
 * The tiny photo shows at once and is replaced when the sharper one has loaded.
 */
export function Avatar({ b64, photo, uri, name, size = 48 }: { b64?: string; photo?: string; uri?: string; name?: string; size?: number }) {
  const colors = useColors();
  const { language } = useI18n();
  const [badUri, setBadUri] = useState(false); // my private copy is gone (data cleared): fall back to the tiny photo
  const [remote, setRemote] = useState<ImageRef | null>(() => (photo ? resolved.get(photo) ?? null : null));
  const box = { width: size, height: size, borderRadius: size / 2 };
  const mediaVersion = usePartnerMediaVersion((s) => s.version); // the sharper photo may arrive after the profile message

  useEffect(() => {
    let alive = true;
    setBadUri(false);
    const cached = photo ? resolved.get(photo) : undefined;
    setRemote(cached ?? null);
    // Always look again (a local picture is cheap): a thumbnail cached earlier may have been replaced by the preview.
    if (photo) {
      void sharedImage(photo, 'preview').then((ref) => {
        if (!ref) return;
        resolved.set(photo, ref);
        if (alive) setRemote(ref);
      });
    }
    return () => {
      alive = false;
    };
  }, [photo, uri, mediaVersion]);

  const mine = uri && !badUri ? uri : undefined;
  const source = mine
    ? { uri: mine }
    : remote
      ? remote.headers
        ? { uri: remote.uri, headers: remote.headers }
        : { uri: remote.uri }
      : b64
        ? { uri: `data:image/jpeg;base64,${b64}` }
        : null;
  if (source) return <Image source={source} style={box} contentFit="cover" transition={120} onError={mine ? () => setBadUri(true) : undefined} />;
  return (
    <View style={[box, { backgroundColor: colors.accent + '24', alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: size * 0.42 }}>
        {(name?.trim()[0] ?? '·').toUpperCase()}
      </Text>
    </View>
  );
}
