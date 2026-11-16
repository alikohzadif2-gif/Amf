import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, PixelRatio, Pressable, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { ScreenFrame } from '@/components/ScreenFrame';
import { EmptyState } from '@/components/ui';
import { Text } from '@/components/ui/ScaledText';
import { FastScrollbar, type FastScrollbarHandle } from '@/components/ui/FastScrollbar';
import { SortDrawer, type SortOption } from '@/components/ui/SortDrawer';
import { useTabBarHeight } from '@/components/ui/useTabBarHeight';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { isMedia, shuffle, toBlocks, type Block } from '@/src/explore/layout';
import { useLibraryIndex } from '@/src/library/index-store';
import type { LibraryEntry } from '@/src/library/merge';
import { sourceKinds } from '@/src/library/providers';
import { SOURCE_MODES, applySourceMode, type SourceMode } from '@/src/library/source-mode';
import { excludeFromExplore } from '@/src/library/explore-hidden';
import { TIME_ORDERS, applyTimeOrder, type TimeOrder } from '@/src/library/time-order';
import { applyTypeFilter, typeLabel, typeOptions } from '@/src/library/type-tags';
import { loadUserData, useUserData } from '@/src/library/user-data';
import { useSettingsStore } from '@/src/state/settings-store';
import { useDriveStore } from '@/src/state/drive-store';
import { Thumb } from '@/src/library/ui/Thumb';
import { useViewerStore } from '@/src/library/viewer-store';

/** How many random items one shuffle shows (the list loads thumbnails only for what is on screen). */
const SHOWN = 300;
const GAP = 2;
/** Explore starts from the person's Google Drive (the phone or the server can be chosen in the Source tool). */
const EXPLORE_SOURCE: SourceMode = 'drive';
/** Scrolling down by this much hides the tool card; scrolling up by the same shows it again. */
const HIDE_DELTA = 14;
const COLLAPSE_MS = 180;
/** Sizes the server renders thumbnails at; a tile asks for the smallest one that is sharp at the screen's pixel density. */
const THUMB_BUCKETS = [256, 384, 512, 768, 1024];
const thumbFor = (dp: number) => {
  const px = dp * PixelRatio.get();
  return THUMB_BUCKETS.find((b) => b >= px) ?? THUMB_BUCKETS[THUMB_BUCKETS.length - 1]!;
};

type Tool = 'time' | 'type' | 'source';
// The same three tools and labels as the Archive (app/library.tsx); the choices here are kept apart from the Archive's.
const SOURCE_LABEL: Record<SourceMode, TranslationKey> = { phone: 'libSrcLocal', drive: 'libSrcDrive', server: 'libSrcServer', vault: 'libSrcVault' };
const SOURCE_ICON: Record<SourceMode, keyof typeof Feather.glyphMap> = { phone: 'smartphone', drive: 'cloud', server: 'hard-drive', vault: 'lock' };
const TIME_LABEL: Record<TimeOrder, TranslationKey> = {
  all: 'timeAll', today: 'timeToday', week: 'timeWeek', month: 'timeMonth', year: 'timeYear', newest: 'archiveSortNewest', oldest: 'archiveSortOldest',
};

/** One compact pill of the tool card. `selected` = a filter is on (filled, like the Archive chips). */
function ToolPill({ label, icon, selected, onPress, chevron = true }: { label: string; icon?: keyof typeof Feather.glyphMap; selected: boolean; onPress: () => void; chevron?: boolean }) {
  const colors = useColors();
  const { language } = useI18n();
  const fg = selected ? colors.chipSelectedForeground : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.pill, { backgroundColor: selected ? colors.chipSelected : withAlpha(colors.foreground, 0.07) }]}
    >
      {icon ? <Feather name={icon} size={14} color={fg} /> : null}
      <Text numberOfLines={1} style={{ flexShrink: 1, color: fg, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13 }}>{label}</Text>
      {chevron ? <Feather name="chevron-down" size={14} color={fg} /> : null}
    </Pressable>
  );
}

/** Explore: every photo and video of the phone and the server in a random mosaic. Pull down = a new mix. Tap = open it. */
export default function ExploreScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useI18n();
  const db = useSQLiteContext();
  const { width } = useWindowDimensions();
  const barSpace = useTabBarHeight();
  const entries = useLibraryIndex((s) => s.visible);
  const status = useLibraryIndex((s) => s.status);
  const [seed, setSeed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [order, setOrder] = useState<TimeOrder>('all');
  const [typeTag, setTypeTag] = useState<string | null>(null);
  const [source, setSource] = useState<SourceMode>(EXPLORE_SOURCE);
  const [tool, setTool] = useState<Tool | null>(null);
  const metadata = useUserData((s) => s.archiveMeta);
  const tagsByKey = useUserData((s) => s.tagsByKey);
  const allTags = useUserData((s) => s.allTags);
  const calendarMode = useSettingsStore((s) => s.calendarMode);
  const calKind = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  const hiddenFolders = useSettingsStore((x) => x.exploreHiddenFolders);
  const driveAccount = useDriveStore((s) => s.account);

  useEffect(() => {
    void useLibraryIndex.getState().build(); // does nothing when the Library is already indexed
    void loadUserData(db); // tags and dates for the Type / Time tools
  }, [db]);

  // Same order of steps as the Archive: Time, then Type, then Source. Folders hidden from Explore (Archive) are left out.
  const filtered = useMemo(() => {
    const media = excludeFromExplore(applySourceMode(isMedia(entries), source, sourceKinds()), hiddenFolders);
    return applyTypeFilter(applyTimeOrder(media, order, metadata, calKind), typeTag, tagsByKey);
  }, [entries, order, typeTag, source, metadata, tagsByKey, calKind, hiddenFolders]);

  // The random mix is made ONCE per pull-to-refresh / tool change and then kept: when the library index is rebuilt in the
  // background (or the user data loads) the tiles stay where they are; new files show up only after the next refresh.
  const mix = useRef<{ sig: string; keys: string[] }>({ sig: '', keys: [] });
  const sig = `${seed}|${order}|${typeTag ?? ''}|${source}|${hiddenFolders.length}`;
  const items = useMemo(() => {
    if (order === 'newest' || order === 'oldest') return filtered.slice(0, SHOWN);
    if (mix.current.sig === sig && mix.current.keys.length > 0) {
      const byKey = new Map(filtered.map((e) => [e.key, e]));
      return mix.current.keys.map((k) => byKey.get(k)).filter((e): e is LibraryEntry => e !== undefined);
    }
    const picked = shuffle(filtered).slice(0, SHOWN);
    mix.current = { sig, keys: picked.map((e) => e.key) };
    return picked;
  }, [filtered, sig, order]);
  const blocks = useMemo(() => toBlocks(items, (e) => e.key), [items]);
  const small = (width - GAP * 2) / 3;
  const listRef = useRef<FlatList<Block<LibraryEntry>>>(null);
  const bar = useRef<FastScrollbarHandle>(null);
  // Tool card: slides up and hides while the mosaic scrolls down, comes back when it scrolls up (or reaches the top).
  const collapse = useSharedValue(0);
  const menuHeight = useSharedValue(0);
  const collapsed = useRef(false);
  const lastY = useRef(0);
  const lockUntil = useRef(0);
  const setCollapsed = useCallback((next: boolean) => {
    if (collapsed.current === next) return;
    collapsed.current = next;
    lockUntil.current = Date.now() + COLLAPSE_MS + 120; // resizing the list moves the offset a little: ignore it meanwhile
    collapse.value = withTiming(next ? 1 : 0, { duration: COLLAPSE_MS });
  }, [collapse]);
  const onScrollY = useCallback((y: number) => {
    const delta = y - lastY.current;
    if (Date.now() < lockUntil.current) { lastY.current = y; return; }
    if (y <= 4) { lastY.current = y; setCollapsed(false); return; }
    if (delta > HIDE_DELTA) { lastY.current = y; setCollapsed(true); }
    else if (delta < -HIDE_DELTA) { lastY.current = y; setCollapsed(false); }
    else if (Math.abs(delta) > HIDE_DELTA * 4) lastY.current = y;
  }, [setCollapsed]);
  const menuStyle = useAnimatedStyle(() => (menuHeight.value > 0
    ? { height: menuHeight.value * (1 - collapse.value), opacity: 1 - collapse.value }
    : {}));
  useEffect(() => { lastY.current = 0; lockUntil.current = 0; setCollapsed(false); }, [order, typeTag, source, setCollapsed]);
  const scrollTo = useCallback((offset: number) => listRef.current?.scrollToOffset({ offset, animated: false }), []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await useLibraryIndex.getState().build(true).catch(() => undefined); // a pull picks up new files, then mixes again
    setSeed((n) => n + 1);
    setRefreshing(false);
  }, []);

  const open = (entry: LibraryEntry) => {
    useViewerStore.getState().open(items, items.indexOf(entry), { vertical: true });
    router.push('/viewer' as never);
  };

  // Reels: only videos (same tools as the mosaic), one per screen, playing by themselves; swipe up/down for the next one.
  const openReels = () => {
    const videos = shuffle(filtered.filter((e) => e.item.type === 'video')).slice(0, SHOWN);
    if (videos.length === 0) { Alert.alert(t('exploreReelsEmpty')); return; }
    useViewerStore.getState().open(videos, 0, { vertical: true });
    router.push('/viewer' as never);
  };

  const tile = (entry: LibraryEntry, size: number, tall = size) => (
    <Pressable key={entry.key} accessibilityRole="imagebutton" onPress={() => open(entry)} style={{ width: size, height: tall }}>
      <Thumb entry={entry} size={thumbFor(Math.max(size, tall))} style={{ width: size, height: tall }} />
      {entry.item.type === 'video' ? <Feather name="play" size={size > small ? 22 : 15} color="#fff" style={{ position: 'absolute', top: 7, right: 7 }} /> : null}
    </Pressable>
  );

  const renderBlock = ({ item: b }: { item: Block<LibraryEntry> }) => (
    <View style={{ gap: GAP, marginBottom: GAP }}>
      <View style={{ flexDirection: b.bigRight ? 'row-reverse' : 'row', gap: GAP }}>
        {tile(b.big, small * 2 + GAP)}
        <View style={{ gap: GAP }}>{b.side.map((e) => tile(e, small))}</View>
      </View>
      <View style={{ flexDirection: 'row', gap: GAP }}>{b.row.map((e) => tile(e, small))}</View>
    </View>
  );

  return (
    <ScreenFrame contentStyle={{ paddingHorizontal: 0, paddingTop: 0 }}>
      {/* Slim glass card: Time, Type, Reels and (at the end of the row) Source. Translucent only, no live blur (that made the app lag). */}
      <Animated.View style={[{ overflow: 'hidden' }, menuStyle]}>
        <View onLayout={(event) => { if (!collapsed.current && Date.now() >= lockUntil.current) menuHeight.value = event.nativeEvent.layout.height; }}>
          <View
            style={[
              styles.card,
              { backgroundColor: withAlpha(colors.card, colors.isDark ? 0.72 : 0.78), borderColor: withAlpha('#FFFFFF', colors.isDark ? 0.14 : 0.7) },
            ]}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cardRow}>
              <ToolPill label={`${t('sortTime')}${order !== 'all' ? `: ${t(TIME_LABEL[order])}` : ''}`} selected={order !== 'all'} onPress={() => setTool('time')} />
              <ToolPill label={`${t('sortType')}${typeTag ? `: ${typeLabel(typeTag, t)}` : ''}`} selected={typeTag !== null} onPress={() => setTool('type')} />
              <ToolPill label={t('exploreReels')} icon="film" selected={false} chevron={false} onPress={openReels} />
              <ToolPill label={t(SOURCE_LABEL[source])} icon={SOURCE_ICON[source]} selected={source !== EXPLORE_SOURCE} onPress={() => setTool('source')} />
            </ScrollView>
          </View>
        </View>
      </Animated.View>

      <View style={{ flex: 1 }}>
        {source === 'drive' && !driveAccount ? (
          <EmptyState
            message={t('driveExploreSignIn')}
            actionLabel={t('driveConnectNow')}
            actionIcon="cloud"
            onAction={() => router.push({ pathname: '/settings/[section]', params: { section: 'google-drive' } })}
          />
        ) : blocks.length === 0 ? (
          <EmptyState message={t(status === 'indexing' ? 'exploreIndexing' : 'exploreEmpty')} />
        ) : (
          <>
          <FlatList
            ref={listRef}
            data={blocks}
            keyExtractor={(b) => b.key}
            renderItem={renderBlock}
            initialNumToRender={4}
            windowSize={5}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={(e) => { bar.current?.onScroll(e); onScrollY(e.nativeEvent.contentOffset.y); }}
            onContentSizeChange={(_w, h) => bar.current?.onContentSize(h)}
            onLayout={(e) => bar.current?.onLayout(e.nativeEvent.layout.height)}
            contentContainerStyle={{ paddingBottom: barSpace + 16 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />}
          />
          <FastScrollbar ref={bar} scrollTo={scrollTo} bottomInset={barSpace + 8} />
          </>
        )}
      </View>

      <SortDrawer
        visible={tool === 'time'}
        title={t('sortTime')}
        options={TIME_ORDERS.map((id): SortOption<TimeOrder> => ({ id, label: t(TIME_LABEL[id]) }))}
        value={order}
        onSelect={setOrder}
        onClose={() => setTool(null)}
        bottomOffset={barSpace + 8}
      />
      <SortDrawer
        visible={tool === 'type'}
        title={t('sortType')}
        options={[{ id: '', label: t('timeAll') }, ...typeOptions(allTags, t).map((o) => ({ id: o.tag, label: o.label }))]}
        value={typeTag ?? ''}
        onSelect={(id) => setTypeTag(id || null)}
        onClose={() => setTool(null)}
        bottomOffset={barSpace + 8}
      />
      <SortDrawer
        visible={tool === 'source'}
        title={t('sortSource')}
        options={SOURCE_MODES.map((id): SortOption<SourceMode> => ({ id, label: t(SOURCE_LABEL[id]) }))}
        value={source}
        onSelect={setSource}
        onClose={() => setTool(null)}
        bottomOffset={barSpace + 8}
      />
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginTop: 8, marginBottom: 8, paddingVertical: 6, borderRadius: 22, borderWidth: 1, overflow: 'hidden' },
  cardRow: { alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 12, borderRadius: 17 },
});
