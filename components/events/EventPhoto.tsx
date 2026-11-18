import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { EventRow } from '@/src/events/events-db';
import { sharedImage } from '@/src/partner/manage';
import { smallCopy } from '@/src/media/small-copy';
import { usePartnerMediaVersion } from '@/src/partner/media-version';
import type { ImageRef } from '@/src/storage/types';

/**
 * The photo of an event (R2): this phone's private copy when there is one, else the shared file read from the server
 * (`Shared/<id>/...`, only while the pairing works). Nothing is added to the Library. Renders nothing while it is not available.
 */
export function EventPhoto({ event, style, size = 'preview' }: { event: Pick<EventRow, 'photoUri' | 'photo'>; style?: ViewStyle; size?: 'thumb' | 'preview' }) {
  const colors = useColors();
  const [remote, setRemote] = useState<ImageRef | null>(null);
  const [small, setSmall] = useState<string | null>(null);
  const { photoUri, photo } = event;
  const mediaVersion = usePartnerMediaVersion((s) => s.version); // a picture of the partner arrived: look again

  useEffect(() => setRemote(null), [photoUri, photo, size]);
  // Lists show a small copy of my own photo instead of decoding the 1600 px file for every row.
  useEffect(() => {
    let alive = true;
    setSmall(null);
    if (photoUri && size === 'thumb') void smallCopy(photoUri).then((uri) => alive && setSmall(uri ?? photoUri));
    return () => {
      alive = false;
    };
  }, [photoUri, size]);
  useEffect(() => {
    let alive = true;
    if (!photoUri && photo) void sharedImage(photo, size).then((ref) => alive && setRemote(ref));
    return () => {
      alive = false;
    };
  }, [photoUri, photo, size, mediaVersion]);

  const source = photoUri ? (size === 'thumb' ? (small ? { uri: small } : null) : { uri: photoUri }) : remote ? (remote.headers ? { uri: remote.uri, headers: remote.headers } : { uri: remote.uri }) : null;
  if (!source) return null;
  return (
    <View style={[styles.box, { backgroundColor: colors.muted }, style]}>
      <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
    </View>
  );
}

const styles = StyleSheet.create({ box: { overflow: 'hidden' } });
