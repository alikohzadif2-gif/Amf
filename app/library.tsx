import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, ScrollView, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { Chip, EmptyState, Fab } from '@/components/ui';
import { SortDrawer, SortToolbar, type SortOption } from '@/components/ui/SortDrawer';
import { TIME_ORDERS, type TimeOrder } from '@/src/library/time-order';
import { DEFAULT_SOURCE_MODE, useSourceMode } from '@/src/library/source-mode';
import { currentYearMonth, normalizeRange, useDateRange, type YearMonth } from '@/src/library/date-range';
import { MonthRangePicker } from '@/components/ui/MonthRangePicker';
import { calendarMonthName } from '@/src/lib/calendar';
import { typeLabel, typeOptions, useTypeFilter } from '@/src/library/type-tags';
import { useColors } from '@/hooks/useColors';
import { MediaSourceSheet } from '@/components/media/MediaSourceSheet';
import { pickFromSource, type MediaSource } from '@/src/media/pick';
import { pickErrorKey } from '@/src/media/pick-logic';
import { useLibraryIndex } from '@/src/library/index-store';
import { exploreFolderKey, isFolderHidden } from '@/src/library/explore-hidden';
import type { LibraryEntry, SourceRef } from '@/src/library/merge';
import { archiveCategoryOptions } from '@/src/library/archive-model';
import { ArchiveEditSheet } from '@/src/library/ui/ArchiveEditSheet';
import {
  AlbumPage, AlbumsRoot, FolderPage, PeriodPage, SearchView, TagPage, type Ctl,
} from '@/src/library/ui/pages';
import { AlbumSheet, TagSheet } from '@/src/library/ui/Sheets';
import { loadUserData, setAlbumItems, setArchiveMetadata, setFavorite, useUserData } from '@/src/library/user-data';
import { useViewerStore } from '@/src/library/viewer-store';
import { removeOffline, saveOfflineMany } from '@/src/media/originals';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { radii } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettingsStore } from '@/src/state/settings-store';
import { VAULT_SOURCE_ID, useSourcesStore } from '@/src/state/sources-store';
import { isSourceActive } from '@/src/storage/active';
import { trashProviderIds } from '@/src/vault/trash';

type Tab = 'folders' | 'albums';
type Tool = 'time' | 'type' | 'range';
/** Scrolling down by this much hides the menus; scrolling up by the same shows them again. */
const HIDE_DELTA = 14;
const COLLAPSE_MS = 180;
const TIME_LABEL: Record<TimeOrder, TranslationKey> = {
  all: 'timeAll', today: 'timeToday', week: 'timeWeek', month: 'timeMonth', year: 'timeYear', newest: 'archiveSortNewest', oldest: 'archiveSortOldest',
};
type Page =
  | { kind: 'folder'; refs: SourceRef[] | null; title: string | null }
  | { kind: 'album'; id: number }
  | { kind: 'period'; by: 'month' | 'year'; id: string; title: string }
  | { kind: 'tag'; tag: string };

const TABS: { id: Tab; label: TranslationKey; icon: keyof typeof Feather.glyphMap }[] = [
  { id: 'folders', label: 'libTabFolders', icon: 'folder' },
  { id: 'albums', label: 'libTabAlbums', icon: 'layers' },
];

export default function LibraryScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const params = useLocalSearchParams<{ view?: string; source?: string }>();
  const { language, isRTL, t } = useI18n();
  const insets = useSafeAreaInsets();
  const digits = useSettingsStore((s) => s.digits);
  const signature = useSourcesStore((s) => s.sources.filter(isSourceActive).map((x) => x.id).join('|'));
  const status = useLibraryIndex((s) => s.status);
  const offline = useUserData((s) => s.offline);

  const defaultOrder = useSettingsStore((s) => s.archiveTimeOrder);
  const [order, setOrder] = useState<TimeOrder>(defaultOrder);
  const [tool, setTool] = useState<Tool | null>(null);
  const typeTag = useTypeFilter((x) => x.tag);
  const allTags = useUserData((x) => x.allTags);
  const range = useDateRange((x) => x.range);
  const calendarMode = useSettingsStore((x) => x.calendarMode);
  const calKind = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  const [draftStart, setDraftStart] = useState<YearMonth | null>(null);
  const [draftEnd, setDraftEnd] = useState<YearMonth | null>(null);
  const source = useSourceMode((x) => x.mode);
  useEffect(() => { useTypeFilter.getState().set(null); useDateRange.getState().set(null); useSourceMode.getState().set(DEFAULT_SOURCE_MODE); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openTool = (id: Tool) => {
    if (id === 'range') { setDraftStart(range?.start ?? null); setDraftEnd(range?.end ?? null); }
    setTool(id);
  };
  const monthText = (v: YearMonth) => `${calendarMonthName(calKind, v.month, language)} ${toDigits(v.year, digits)}`;
  const [tab, setTab] = useState<Tab>(params.view === 'albums' ? 'albums' : 'folders');
  const [trail, setTrail] = useState<Page[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Map<string, LibraryEntry>>(new Map());
  const [sheet, setSheet] = useState<'tag' | 'album' | 'edit' | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [addSheet, setAddSheet] = useState(false);
  const visible = useRef<LibraryEntry[]>([]);

  // Tabs + tool bar slide up and hide while the grid scrolls down, and come back when it scrolls up (or reaches the top).
  const collapse = useSharedValue(0);
  const menuHeight = useSharedValue(0);
  const collapsed = useRef(false);
  const lastY = useRef(0);
  const lockUntil = useRef(0);
  const setCollapsed = useCallback((next: boolean) => {
    if (collapsed.current === next) return;
    collapsed.current = next;
    lockUntil.current = Date.now() + COLLAPSE_MS + 120; // resizing the grid moves the offset a little: ignore it meanwhile
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

  useEffect(() => { loadUserData(db); }, [db]);
  useEffect(() => { useLibraryIndex.getState().build(); }, [signature]);

  const selectedList = useMemo(() => [...selected.values()], [selected]);
  const selectedFiles = selectedList.filter((entry) => entry.item.type !== 'dir');
  const page = trail[trail.length - 1];

  const goBack = useCallback(() => {
    if (selected.size > 0) setSelected(new Map());
    else if (searching) setSearching(false);
    else if (trail.length > 0) setTrail((x) => x.slice(0, -1));
    else router.back();
  }, [selected.size, searching, trail.length, router]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selected.size > 0 || searching || trail.length > 0) { goBack(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [goBack, selected.size, searching, trail.length]);

  useEffect(() => { lastY.current = 0; lockUntil.current = 0; setCollapsed(false); }, [tab, trail.length, searching, selected.size, source, setCollapsed]);
  const push = (p: Page) => setTrail((x) => [...x, p]);
  const switchTab = (next: Tab) => { setTab(next); setTrail([]); setSelected(new Map()); setSearching(false); };

  const ctl: Ctl = useMemo(() => ({
    selected,
    onScrollY,
    onRefresh: async () => { setReloadKey((n) => n + 1); await useLibraryIndex.getState().build(true).catch(() => undefined); },
    register: (entries) => { visible.current = entries; },
    onLongPress: (entry) => {
      Haptics.selectionAsync().catch(() => {});
      setSelected((prev) => (prev.has(entry.key) ? prev : new Map(prev).set(entry.key, entry)));
    },
    onPress: (entries, entry) => {
      if (selected.size > 0) {
        setSelected((prev) => {
          const next = new Map(prev);
          if (next.has(entry.key)) next.delete(entry.key); else next.set(entry.key, entry);
          return next;
        });
        return;
      }
      useViewerStore.getState().open(entries, Math.max(0, entries.findIndex((e) => e.key === entry.key)));
      router.push('/viewer');
    },
  }), [selected, router, onScrollY]);

  const favorites = useUserData((s) => s.favorites);
  const customCategories = useUserData((s) => s.customCategories);
  const categoryOptions = archiveCategoryOptions(customCategories, t);
  const editableSelected = selectedList.filter((entry) =>
    entry.item.type === 'image' || entry.item.type === 'video' || entry.item.type === 'dir',
  );
  const deletableSelected = selectedList.filter((entry) =>
    (entry.item.type === 'image' || entry.item.type === 'video')
      && Boolean(offline[entry.key]),
  );
  // Folders can be kept out of Explore (their files, and those of their sub-folders, never show there).
  const exploreHidden = useSettingsStore((x) => x.exploreHiddenFolders);
  const selectedDirs = selectedList.filter((entry) => entry.item.type === 'dir');
  const allExploreHidden = selectedDirs.length > 0 && selectedDirs.every((entry) => isFolderHidden(entry, exploreHidden));
  const toggleExploreHidden = () => {
    const keys = selectedDirs.flatMap((entry) => entry.refs.map((ref) => exploreFolderKey(ref.sourceId, ref.itemId)));
    const next = new Set(exploreHidden);
    for (const key of keys) { if (allExploreHidden) next.delete(key); else next.add(key); }
    useSettingsStore.getState().setSetting('exploreHiddenFolders', [...next]);
    setSelected(new Map());
  };
  const allFav = selectedFiles.length > 0 && selectedFiles.every((e) => favorites.has(e.key));
  const allOffline = selectedFiles.length > 0 && selectedFiles.every((e) => offline[e.key]);

  const toggleOffline = async () => {
    setBusy(true);
    if (allOffline) for (const e of selectedFiles) await removeOffline(e.key);
    else await saveOfflineMany(selectedFiles);
    setBusy(false);
    setSelected(new Map());
  };

  const addFrom = async (from: MediaSource) => {
    setImporting(true);
    const result = await pickFromSource(from);
    setImporting(false);
    if (result.cancelled) return;
    setReloadKey((n) => n + 1);
    Alert.alert(
      t('libAddTitle'),
      result.added > 0 ? `${toDigits(result.added, digits)} ${t('libAddDone')}` : t(result.error ? pickErrorKey(result.error) : 'libAddFailed'),
    );
  };
  // One plus sheet: Camera / Gallery / Files are copied into Direct; the extra row opens the folder/file-manager flow.
  const openAddMenu = () => setAddSheet(true);
  const vaultSelected = source === 'vault'
    ? selectedList.filter((entry) => entry.refs.some((ref) => ref.sourceId === VAULT_SOURCE_ID))
    : [];
  const trashFromVault = () => {
    const ids = vaultSelected.flatMap((entry) => entry.refs.filter((ref) => ref.sourceId === VAULT_SOURCE_ID).map((ref) => ref.itemId));
    if (ids.length === 0) return;
    Alert.alert(t('vaultTrashTitle'), t('vaultTrashBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('vaultTrashAction'),
        style: 'destructive',
        onPress: () => void (async () => {
          setBusy(true);
          const moved = await trashProviderIds(db, ids).catch(() => 0);
          await useLibraryIndex.getState().build(true).catch(() => undefined);
          setBusy(false);
          setSelected(new Map());
          setReloadKey((n) => n + 1);
          if (moved === 0) Alert.alert(t('archiveDeleteFailed'));
        })(),
      },
    ]);
  };
  const deleteSelected = () => {
    const entries = deletableSelected;
    if (entries.length === 0) return;
    Alert.alert(t('archiveDeleteTitle'), t('archiveDeleteConfirmBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('archiveDelete'),
        style: 'destructive',
        onPress: () => void (async () => {
          setBusy(true);
          try {
            for (const entry of entries) if (offline[entry.key]) await removeOffline(entry.key);
            await useLibraryIndex.getState().build(true);
            setSelected(new Map());
          } catch {
            Alert.alert(t('archiveDeleteFailed'));
          } finally {
            setBusy(false);
          }
        })(),
      },
    ]);
  };

  const title =
    selected.size > 0 ? toDigits(selected.size, digits)
    : searching ? t('libSearch')
    : page?.kind === 'folder' ? page.title ?? t('libRoot')
    : page?.kind === 'period' ? page.title
    : page?.kind === 'tag' ? `# ${page.tag}`
    : page?.kind === 'album' ? useUserData.getState().albums.find((a) => a.id === page.id)?.name ?? t('libTabAlbums')
    : t('libraryTitle');

  const iconButton = (name: keyof typeof Feather.glyphMap, label: TranslationKey, onPress: () => void) => (
    <Pressable
      key={name}
      accessibilityRole="button"
      accessibilityLabel={t(label)}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <Feather name={name} size={18} color={colors.foreground} />
    </Pressable>
  );

  const folderRoot: Page = { kind: 'folder', refs: null, title: null };
  const current: Page | undefined = page ?? (tab === 'folders' ? folderRoot : undefined);

  let body;
  if (searching) body = <SearchView ctl={ctl} />;
  else if (current?.kind === 'folder') {
    body = (
      <FolderPage
        key={`${current.refs?.map((r) => r.sourceId + r.itemId).join(',') ?? 'root'}-${reloadKey}`}
        refs={current.refs}
        ctl={ctl}
        reloadKey={reloadKey}
        order={order}
        onOpenFolder={(entry) => push({ kind: 'folder', refs: entry.refs, title: entry.item.name })}
      />
    );
  } else if (current?.kind === 'period') body = <PeriodPage by={current.by} id={current.id} ctl={ctl} order={order} />;
  else if (current?.kind === 'tag') body = <TagPage tag={current.tag} ctl={ctl} order={order} />;
  else if (current?.kind === 'album') body = <AlbumPage id={current.id} ctl={ctl} order={order} onDeleted={() => setTrail((x) => x.slice(0, -1))} />;
  else body = <AlbumsRoot order={order} ctl={ctl} onAlbum={(id) => push({ kind: 'album', id })} />;

  const action = (icon: keyof typeof Feather.glyphMap, label: TranslationKey, on: boolean, press: () => void) => (
    <Pressable key={icon} accessibilityRole="button" accessibilityLabel={t(label)} onPress={press} disabled={busy} style={styles.action}>
      <Feather name={icon} size={20} color={on ? colors.primary : colors.foreground} />
      <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 11 }} numberOfLines={1}>{t(label)}</Text>
    </Pressable>
  );

  return (
    <ScreenFrame contentStyle={{ paddingHorizontal: 0, paddingTop: 12, paddingBottom: 0 }}>
      <View style={[styles.header, { flexDirection: rowOf(isRTL) }]}>
        {iconButton(selected.size > 0 ? 'x' : isRTL ? 'arrow-right' : 'arrow-left', selected.size > 0 ? 'selClear' : 'back', goBack)}
        <Text numberOfLines={1} style={[styles.title, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: 'center' }]}>{title}</Text>
        {selected.size > 0 ? (
          iconButton('check-square', 'selAll', () => setSelected(new Map(visible.current.map((e) => [e.key, e]))))
        ) : (
          <>
            {status === 'indexing' || importing ? <ActivityIndicator color={colors.primary} /> : null}
            {!searching ? (
              <>
                {iconButton('refresh-cw', 'libRefresh', () => { setReloadKey((n) => n + 1); useLibraryIndex.getState().build(true); })}
                {iconButton('search', 'libSearch', () => setSearching(true))}
              </>
            ) : null}
          </>
        )}
      </View>
      {!searching && selected.size === 0 ? (
        <Animated.View style={[{ overflow: 'hidden' }, menuStyle]}>
          <View onLayout={(event) => { if (!collapsed.current && Date.now() >= lockUntil.current) menuHeight.value = event.nativeEvent.layout.height; }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tabsScroll}
              contentContainerStyle={[styles.tabs, { flexDirection: rowOf(isRTL) }]}
            >
              {TABS.map((item) => (
                <Chip
                  key={item.id}
                  label={t(item.label)}
                  icon={item.icon}
                  selected={tab === item.id}
                  onPress={() => switchTab(item.id)}
                />
              ))}
            </ScrollView>
            <SortToolbar
              tools={[
                { id: 'time', label: t('sortTime'), value: t(TIME_LABEL[order]), active: order !== 'all' },
                { id: 'type', label: t('sortType'), value: typeTag ? typeLabel(typeTag, t) : undefined, active: typeTag !== null },
                { id: 'range', label: t('sortRange'), value: range ? `${monthText(range.start)} – ${monthText(range.end)}` : undefined, active: range !== null },
              ]}
              onOpen={openTool}
            />
          </View>
        </Animated.View>
      ) : null}
      <View style={{ flex: 1 }}>{body}</View>

      {selected.size > 0 ? (
        <View style={[styles.bar, { backgroundColor: colors.navBar, borderColor: colors.border, flexDirection: rowOf(isRTL), bottom: insets.bottom + 14 }]}>
          {busy ? <ActivityIndicator color={colors.primary} style={{ flex: 1 }} /> : (
            <>
              {selectedFiles.length > 0 ? action('star', allFav ? 'favRemove' : 'favAdd', allFav, async () => { await setFavorite(selectedFiles, !allFav); setSelected(new Map()); }) : null}
              {selectedList.length > 0 ? action('tag', 'tagAdd', false, () => setSheet('tag')) : null}
              {selectedFiles.length > 0 ? action('folder-plus', 'albumAddTo', false, () => setSheet('album')) : null}
              {selectedDirs.length > 0 ? action(allExploreHidden ? 'eye' : 'eye-off', allExploreHidden ? 'exploreShowFolder' : 'exploreHideFolder', allExploreHidden, toggleExploreHidden) : null}
              {editableSelected.length > 0 ? action('edit-3', 'archiveEdit', false, () => setSheet('edit')) : null}
              {source === 'vault'
                ? (vaultSelected.length > 0 ? action('trash-2', 'vaultTrashAction', false, trashFromVault) : null)
                : (deletableSelected.length > 0 ? action('trash-2', 'archiveDelete', false, deleteSelected) : null)}
              {selectedFiles.length > 0 ? action(allOffline ? 'trash' : 'download-cloud', allOffline ? 'viewerRemoveOffline' : 'viewerMakeOffline', allOffline, toggleOffline) : null}
              {page?.kind === 'album' && selectedFiles.length > 0 ? action('minus-circle', 'albumRemove', false, async () => { await setAlbumItems(page.id, selectedFiles, false); setSelected(new Map()); }) : null}
            </>
          )}
        </View>
      ) : null}
      {!searching && selected.size === 0 ? (
        <Fab icon="plus" onPress={openAddMenu} floating accessibilityLabel={t('libAdd')} />
      ) : null}
      <SortDrawer
        visible={tool === 'time'}
        title={t('sortTime')}
        options={TIME_ORDERS.map((id): SortOption<TimeOrder> => ({ id, label: t(TIME_LABEL[id]) }))}
        value={order}
        onSelect={setOrder}
        onClose={() => setTool(null)}
      />
      <SortDrawer
        visible={tool === 'type'}
        title={t('sortType')}
        options={[{ id: '', label: t('timeAll') }, ...typeOptions(allTags, t).map((o) => ({ id: o.tag, label: o.label }))]}
        value={typeTag ?? ''}
        onSelect={(id) => useTypeFilter.getState().set(id || null)}
        onClose={() => setTool(null)}
      />
      <SortDrawer
        visible={tool === 'range'}
        title={t('sortRange')}
        onClose={() => setTool(null)}
        actionLabel={t('rangeApply')}
        actionDisabled={!draftStart || !draftEnd}
        onAction={() => {
          if (draftStart && draftEnd) useDateRange.getState().set(normalizeRange(draftStart, draftEnd));
          setTool(null);
        }}
      >
        <MonthRangePicker kind={calKind} start={draftStart} end={draftEnd} onStart={setDraftStart} onEnd={setDraftEnd} initialYear={currentYearMonth(calKind).year} />
        {range ? (
          <Pressable accessibilityRole="button" onPress={() => { useDateRange.getState().set(null); setTool(null); }} style={{ paddingVertical: 16, alignItems: 'center' }}>
            <Text style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), fontSize: 15 }}>{t('rangeClear')}</Text>
          </Pressable>
        ) : null}
      </SortDrawer>
      <TagSheet entries={selectedList} visible={sheet === 'tag'} onClose={() => setSheet(null)} />
      <AlbumSheet entries={selectedFiles} visible={sheet === 'album'} onClose={() => setSheet(null)} />
      <ArchiveEditSheet
        entries={editableSelected}
        categories={categoryOptions}
        visible={sheet === 'edit'}
        onClose={() => setSheet(null)}
        onSave={async (changes) => {
          await setArchiveMetadata(editableSelected, changes);
          setSelected(new Map());
        }}
      />
      <MediaSourceSheet
        visible={addSheet}
        onClose={() => setAddSheet(false)}
        onSelect={(from) => void addFrom(from)}
        allowFiles
        title={t('libAddTitle')}
        extraRows={[
          { id: 'vault-add', icon: 'folder-plus' as const, label: t('vaultAddFolder'), onPress: () => router.push('/vault-add') },
        ]}
      />
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
  iconButton: { width: 44, height: 44, borderRadius: radii.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 20 },
  tabsScroll: { flexGrow: 0 },
  tabs: { gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  bar: {
    position: 'absolute',
    start: 12,
    end: 12,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: 6,
    paddingVertical: 6,
    justifyContent: 'space-around',
    minHeight: 68,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 10,
  },
  action: { flex: 1, minWidth: 0, alignItems: 'center', gap: 4, justifyContent: 'center', paddingVertical: 2 },
});
