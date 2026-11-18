import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { extensionOf, thumbFailure } from '@/src/diagnostics/thumb-trace';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { galleryRef } from '@/src/gallery/gallery-ref';
import { galleryRetryThumb, useGalleryThumbs } from '@/src/gallery/thumb-client';
import { sharedImage } from '@/src/partner/manage';
import type { ImageRef } from '@/src/storage/types';

type Props = { id: string; path: string; name: string; kind: 'i' | 'v' | 'f'; onOpen: (ref: string) => void };

/**
 * One file of the partner's gallery. It shows the small picture when this phone has it and a plain square until then; it never asks for
 * anything itself (the screen tells the scheduler which tiles are visible). It redraws only when ITS picture arrived.
 */
function GalleryTileBase({ id, path, name, kind, onOpen }: Props) {
  const colors = useColors();
  const { language } = useI18n();
  const stamp = useGalleryThumbs((s) => s.stamp[id] ?? 0);
  const [image, setImage] = useState<ImageRef | null>(null);
  const ref = galleryRef(id, path);

  useEffect(() => {
    if (kind === 'f') return;
    let alive = true;
    void sharedImage(ref, 'thumb').then((found) => alive && setImage(found));
    return () => {
      alive = false;
    };
  }, [ref, kind, stamp]);

  const press = () => {
    if (kind === 'f') return;
    if (image) onOpen(ref);
    else galleryRetryThumb(id); // no picture yet (or it failed): ask again right now
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} disabled={kind === 'f'} onPress={press} style={[styles.tile, { backgroundColor: colors.muted }]}>
      {image ? <Image source={{ uri: image.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} recyclingKey={id} onError={(event) => thumbFailure('image-error', extensionOf(name), event.error)} /> : null}
      {kind === 'f' ? (
        <View style={styles.center}>
          <Feather name="file" size={26} color={colors.mutedForeground} />
          <Text numberOfLines={2} style={[styles.name, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language) }]}>{name}</Text>
        </View>
      ) : null}
      {kind === 'v' ? (
        <View style={styles.badge}>
          <Feather name="play" size={13} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
}

export const GalleryTile = memo(GalleryTileBase);

const styles = StyleSheet.create({
  tile: { flex: 1, aspectRatio: 1, borderRadius: 10, overflow: 'hidden' },
  center: { ...StyleSheet.absoluteFill as object, alignItems: 'center', justifyContent: 'center', padding: 6, gap: 4 },
  name: { fontSize: 11, textAlign: 'center' },
  badge: { position: 'absolute', left: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
});
