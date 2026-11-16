import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { DEFAULT_THUMB, loadThumb } from '@/src/media/thumb-cache';
import type { ImageRef } from '@/src/storage/types';
import { sortRefs, type LibraryEntry } from '../merge';
import { providerFor, sourceKinds } from '../providers';

const ICON = { image: 'image', video: 'video', file: 'file', text: 'file-text', dir: 'folder' } as const;

/** Square thumbnail; loads through the disk cache and recycles safely in lists. */
export function Thumb({ entry, style, size = DEFAULT_THUMB }: { entry: LibraryEntry; style?: ViewStyle; size?: number }) {
  const colors = useColors();
  const [ref, setRef] = useState<ImageRef | null>(null);
  const media = entry.item.type === 'image' || entry.item.type === 'video';

  useEffect(() => {
    let alive = true;
    setRef(null);
    if (!media) return;
    const first = sortRefs(entry.refs, sourceKinds())[0];
    const provider = first ? providerFor(first.sourceId) : null;
    if (!provider) return;
    loadThumb(provider, { ...entry.item, id: first.itemId }, size).then((result) => {
      if (alive) setRef(result);
    });
    return () => {
      alive = false;
    };
  }, [entry, media, size]);

  return (
    <View style={[styles.box, { backgroundColor: colors.muted }, style]}>
      {ref ? (
        <Image
          source={ref.headers ? { uri: ref.uri, headers: ref.headers } : { uri: ref.uri }}
          recyclingKey={entry.key}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={120}
        />
      ) : (
        <Feather name={ICON[entry.item.type]} size={22} color={colors.mutedForeground} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
