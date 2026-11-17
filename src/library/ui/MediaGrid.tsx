import { FlashList } from '@shopify/flash-list';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { ActivityIndicator, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { EmptyState } from '@/components/ui/EmptyState';
import { useColors } from '@/hooks/useColors';
import { useI18n, type TranslationKey } from '@/src/i18n';
import type { SourceKind } from '@/src/storage/types';
import { sortRefs, type LibraryEntry } from '../merge';
import { sourceKinds } from '../providers';
import { useUserData } from '../user-data';
import { EntryCell } from './EntryCell';

const COLUMNS = 3;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 5;

type Props = {
  entries: LibraryEntry[];
  header?: ReactElement | null;
  loading?: boolean;
  empty?: TranslationKey;
  selected: ReadonlyMap<string, LibraryEntry>;
  onPress: (entry: LibraryEntry) => void;
  onLongPress: (entry: LibraryEntry) => void;
  onEndReached?: () => void;
  /** Vertical scroll offset, reported while scrolling (the Archive collapses its menus with it). */
  onScrollY?: (y: number) => void;
  /** Pull-to-refresh (the Archive re-reads its sources). */
  onRefresh?: () => Promise<unknown>;
};

/** Edge-to-edge archive grid; pinch changes density from 2 to 5 columns. */
export function MediaGrid({ entries, header, loading, empty, selected, onPress, onLongPress, onEndReached, onScrollY, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const pull = useCallback(async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); } catch { /* the grid keeps what it had */ } finally { setRefreshing(false); }
  }, [onRefresh]);
  const colors = useColors();
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const [columns, setColumns] = useState(COLUMNS);
  const pinchStart = useSharedValue(3);
  const pinch = useMemo(() => Gesture.Pinch()
    .onBegin(() => { pinchStart.value = columns; })
    .onUpdate((event) => {
      const next = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(pinchStart.value / event.scale)));
      runOnJS(setColumns)(next);
    }), [columns, pinchStart]);
  const offline = useUserData((s) => s.offline);
  const favorites = useUserData((s) => s.favorites);
  const kinds = useMemo(() => sourceKinds(), []);
  const offlineKeys = useMemo(() => new Set(Object.keys(offline)), [offline]);
  const size = width / columns;
  const selecting = selected.size > 0;

  const renderItem = useCallback(
    ({ item }: { item: LibraryEntry }) => {
      const present = [...new Set(sortRefs(item.refs, kinds).map((r) => kinds[r.sourceId]))].filter(Boolean) as SourceKind[];
      return (
        <EntryCell
          entry={item}
          size={size}
          kinds={present}
          favorite={favorites.has(item.key)}
          selected={selected.has(item.key)}
          selecting={selecting}
          onPress={onPress}
          onLongPress={onLongPress}
        />
      );
    },
    [size, kinds, offlineKeys, favorites, selected, selecting, onPress, onLongPress],
  );

  return (
    <GestureDetector gesture={pinch}>
    <View style={{ flex: 1 }}>
    <FlashList
      key={`grid-${columns}`}
      data={entries}
      numColumns={columns}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      extraData={{ offlineKeys, favorites, selected, size }}
      onEndReached={onEndReached}
      refreshing={onRefresh ? refreshing : undefined}
      onRefresh={onRefresh ? pull : undefined}
      onScroll={onScrollY ? (event) => onScrollY(event.nativeEvent.contentOffset.y) : undefined}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      onEndReachedThreshold={1.5}
      drawDistance={size * 4}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingBottom: selecting ? 120 : 104, paddingHorizontal: 0 }}
      ListEmptyComponent={
        loading ? null : empty ? (
          <EmptyState message={t(empty)} />
        ) : null
      }
      ListFooterComponent={loading ? <View style={{ padding: 18 }}><ActivityIndicator color={colors.primary} /></View> : null}
    />
    </View>
    </GestureDetector>
  );
}
