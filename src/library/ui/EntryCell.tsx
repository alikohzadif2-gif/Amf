import { Feather } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { useSettingsStore } from '@/src/state/settings-store';
import type { SourceKind } from '@/src/storage/types';
import type { LibraryEntry } from '../merge';
import { formatDuration } from './format';
import { Thumb } from './Thumb';

export const SOURCE_ICON = { local: 'smartphone', vault: 'lock' } as const;

type Props = {
  entry: LibraryEntry;
  size: number;
  kinds: SourceKind[];
  favorite: boolean;
  selected: boolean;
  selecting: boolean;
  onPress: (entry: LibraryEntry) => void;
  onLongPress: (entry: LibraryEntry) => void;
};

function EntryCellBase({ entry, size, kinds, favorite, selected, selecting, onPress, onLongPress }: Props) {
  const colors = useColors();
  const { language } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const isMedia = entry.item.type === 'image' || entry.item.type === 'video';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.item.name}
      onPress={() => onPress(entry)}
      onLongPress={() => onLongPress(entry)}
      delayLongPress={280}
      style={{ width: size, height: size, padding: 0 }}
    >
      <Thumb entry={entry} style={styles.fill} />
      {!isMedia ? (
        <Text numberOfLines={2} style={[styles.name, { color: colors.foreground, fontFamily: fontFamilyFor(language) }]}>
          {entry.item.name}
        </Text>
      ) : null}
      {entry.item.type === 'video' ? (
        <View style={[styles.chip, styles.topStart, { backgroundColor: '#000A' }]}>
          <Feather name="play" size={10} color="#fff" />
          {entry.item.duration ? (
            <Text style={[styles.chipText, { fontFamily: fontFamilyFor(language) }]}>
              {formatDuration(entry.item.duration, digits)}
            </Text>
          ) : null}
        </View>
      ) : null}
      {favorite ? (
        <View style={[styles.chip, styles.topEnd, { backgroundColor: '#000A' }]}>
          <Feather name="star" size={10} color="#fff" />
        </View>
      ) : null}
      <View style={[styles.chip, styles.bottomStart, { backgroundColor: '#000A' }]}>
        {kinds.map((kind) => (
          <Feather key={kind} name={SOURCE_ICON[kind]} size={10} color="#fff" />
        ))}
      </View>
      {selecting ? (
        <View
          style={[
            styles.check,
            { backgroundColor: selected ? colors.primary : '#0007', borderColor: '#fff' },
          ]}
        >
          {selected ? <Feather name="check" size={13} color="#fff" /> : null}
        </View>
      ) : null}
      {selected ? <View pointerEvents="none" style={[styles.fill, styles.tint, { borderColor: colors.primary }]} /> : null}
    </Pressable>
  );
}

export const EntryCell = memo(EntryCellBase);

const styles = StyleSheet.create({
  fill: { flex: 1, borderRadius: radii.tile * 0 },
  tint: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, borderWidth: 2, borderRadius: radii.tile * 0 },
  name: { position: 'absolute', start: 8, end: 8, bottom: 12, fontSize: 11, textAlign: 'center' },
  chip: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 4, borderRadius: radii.pill },
  chipText: { color: '#fff', fontSize: 10 },
  topStart: { top: 6, start: 6 },
  topEnd: { top: 6, end: 6 },
  bottomStart: { bottom: 6, start: 6 },
  check: { position: 'absolute', top: 6, end: 6, width: 24, height: 24, borderRadius: radii.pill, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
