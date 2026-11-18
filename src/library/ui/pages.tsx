import { Feather } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Button, Card, Notice } from '@/components/server/ui';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconTile } from '@/components/ui/IconTile';
import { Input } from '@/components/ui/Input';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { calendarYearMonth, toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { removeOffline, saveOfflineMany } from '@/src/media/originals';
import { useSettingsStore } from '@/src/state/settings-store';
import { DIARY_NO_CATEGORY } from '@/src/diary/categories';
import { FolderLoader } from '../folder-loader';
import { useLibraryIndex } from '../index-store';
import { shareExcludedKeys } from '../indexer';
import {
  CATEGORIES, compareEntries, groupByPeriod, matchesQuery, type Category, type LibraryEntry, type SourceRef,
} from '../merge';
import { applyTimeOrder, type TimeOrder } from '../time-order';
import { applyTypeFilter, useTypeFilter } from '../type-tags';
import { applyDateRange, useDateRange } from '../date-range';
import type { CalendarKind } from '@/src/lib/calendar';
import { ISSUE_TEXT, type LoadIssue } from '../load-issue';
import { enabledProviders, enabledSignature, sourceKinds } from '../providers';
import { applySourceMode, sourceKindsOf, useSourceMode } from '../source-mode';
import {
  deleteAlbum, entriesFromSnapshots, setAlbumOfflineFlag, createAlbum, useUserData,
} from '../user-data';
import { FolderRow } from './FolderRow';
import { MediaGrid } from './MediaGrid';

export type Ctl = {
  selected: ReadonlyMap<string, LibraryEntry>;
  onPress: (entries: LibraryEntry[], entry: LibraryEntry) => void;
  onLongPress: (entry: LibraryEntry) => void;
  register: (entries: LibraryEntry[]) => void;
  /** Vertical scroll offset of the open grid (the Archive hides its menus while scrolling down). */
  onScrollY?: (y: number) => void;
  /** Pull-to-refresh of the open grid. */
  onRefresh?: () => Promise<unknown>;
};

/** Time order + the active Type filter in one step (the Archive tool bar). */
function useApplyView(order: TimeOrder) {
  const metadata = useUserData((s) => s.archiveMeta);
  const tagsByKey = useUserData((s) => s.tagsByKey);
  const calendarMode = useSettingsStore((s) => s.calendarMode);
  const type = useTypeFilter((s) => s.tag);
  const range = useDateRange((s) => s.range);
  const source = useSourceMode((s) => s.mode);
  const kind: CalendarKind = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  return useMemo(
    () => (entries: readonly LibraryEntry[]) => applySourceMode(
      applyDateRange(applyTypeFilter(applyTimeOrder(entries, order, metadata, kind), type, tagsByKey), range, metadata, kind),
      source,
      sourceKinds(),
    ),
    [order, metadata, kind, type, tagsByKey, range, source],
  );
}

const files = (entries: LibraryEntry[]) => entries.filter((e) => e.item.type !== 'dir');

function Muted({ text, style }: { text: string; style?: object }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <Text style={[{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, textAlign: isRTL ? 'right' : 'left', lineHeight: 20 }, style]}>
      {text}
    </Text>
  );
}

/** One friendly line when a server source could not be listed (wrong token, offline, folder gone). */
function IssueNotice({ issue }: { issue: LoadIssue }) {
  const { t } = useI18n();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
      <Notice tone={issue === 'unauthorized' ? 'error' : 'warn'}>{t(ISSUE_TEXT[issue])}</Notice>
    </View>
  );
}

/** One merged folder, paged. Sub-folders are rows above the grid. */
export function FolderPage({ refs, ctl, onOpenFolder, reloadKey, order }: {
  refs: SourceRef[] | null; ctl: Ctl; onOpenFolder: (entry: LibraryEntry) => void; reloadKey: number; order: TimeOrder;
}) {
  const applyView = useApplyView(order);
  const signature = enabledSignature();
  const source = useSourceMode((s) => s.mode);
  const loader = useMemo(
    () => new FolderLoader(enabledProviders().filter((provider) => sourceKindsOf(source).includes(provider.kind)), refs),
    [refs, signature, reloadKey, source],
  );
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const metadata = useUserData((s) => s.archiveMeta);

  const loadMore = useCallback(async () => {
    if (!loader.hasMore) return;
    setLoading(true);
    await loader.loadMore();
    setLoading(false);
    setTick((n) => n + 1);
  }, [loader]);

  const all = applyView(loader.entries('name'));
  const dirs = all.filter((e) => e.item.type === 'dir');
  const items = files(all);

  useEffect(() => {
    setLoading(true);
    loadMore();
  }, [loadMore]);
  useEffect(() => {
    if (!loading && loader.hasMore && items.length < 90) loadMore();
  });
  useEffect(() => ctl.register(items));

  const issue = loader.issue;
  const header: ReactElement = (
    <View>
      {issue ? <IssueNotice issue={issue} /> : null}
      {dirs.map((d) => <FolderRow key={d.key} entry={d} onPress={onOpenFolder} onLongPress={ctl.onLongPress} />)}
    </View>
  );

  return (
    <MediaGrid
      entries={items}
      header={header}
      loading={loading || loader.hasMore}
      empty={dirs.length === 0 && !issue ? 'libEmptyFolder' : undefined}
      selected={ctl.selected}
      onPress={(entry) => ctl.onPress(items, entry)}
      onLongPress={ctl.onLongPress}
      onEndReached={loadMore}
      onScrollY={ctl.onScrollY}
      onRefresh={ctl.onRefresh}
    />
  );
}

/** Entries by key: the live index first, saved snapshots as fallback. */
function useEntriesForKeys(keys: string[], order: TimeOrder = 'newest'): LibraryEntry[] {
  const applyView = useApplyView(order);
  const byKey = useLibraryIndex((s) => s.byKey);
  const visibleByKey = useLibraryIndex((s) => s.visibleByKey);
  const [snap, setSnap] = useState<Map<string, LibraryEntry>>(new Map());
  const missing = keys.filter((k) => !byKey.has(k) && !snap.has(k));
  const missingId = missing.join('|');
  useEffect(() => {
    if (!missingId) return;
    let alive = true;
    entriesFromSnapshots(missingId.split('|')).then((found) => {
      if (alive) setSnap((prev) => new Map([...prev, ...found.map((e) => [e.key, e] as const)]));
    });
    return () => { alive = false; };
  }, [missingId]);
  return useMemo(
    () =>
      // a key the index knows but `visibleByKey` does not lives only in Shared/Snaps: never listed here
      applyView(keys.filter((key) => !shareExcludedKeys.has(key)).map((k) => (byKey.has(k) ? visibleByKey.get(k) : snap.get(k))).filter((e): e is LibraryEntry => !!e)),
    [keys, byKey, visibleByKey, snap, applyView],
  );
}

function IndexNote() {
  const status = useLibraryIndex((s) => s.status);
  const count = useLibraryIndex((s) => s.count);
  const issue = useLibraryIndex((s) => s.issue);
  const digits = useSettingsStore((s) => s.digits);
  const { t } = useI18n();
  if (status === 'ready') return issue ? <IssueNotice issue={issue} /> : null;
  return <Muted style={{ paddingHorizontal: 18, paddingVertical: 8 }} text={`${t('libIndexing')} ${toDigits(count, digits)}`} />;
}

export function GridOfEntries({ entries, ctl, empty, header }: {
  entries: LibraryEntry[]; ctl: Ctl; empty: TranslationKey; header?: ReactElement | null;
}) {
  const status = useLibraryIndex((s) => s.status);
  useEffect(() => ctl.register(files(entries)));
  return (
    <MediaGrid
      entries={entries}
      header={<>{header}<IndexNote /></>}
      loading={status === 'indexing' && entries.length === 0}
      empty={empty}
      selected={ctl.selected}
      onPress={(entry) => ctl.onPress(files(entries), entry)}
      onLongPress={ctl.onLongPress}
      onScrollY={ctl.onScrollY}
      onRefresh={ctl.onRefresh}
    />
  );
}

export function CategoryPage({ categoryId, ctl, order }: { categoryId: string; ctl: Ctl; order: TimeOrder }) {
  const index = useLibraryIndex((s) => s.visible);
  const metadata = useUserData((s) => s.archiveMeta);
  const applyView = useApplyView(order);
  const entries = useMemo(
    () => applyView(index.filter((entry) => (entry.item.type === 'image' || entry.item.type === 'video')
      && (metadata[entry.key]?.category ?? DIARY_NO_CATEGORY) === categoryId)),
    [index, categoryId, metadata, applyView],
  );
  return <GridOfEntries entries={entries} ctl={ctl} empty="libNoCategoryItems" />;
}

export function TagPage({ tag, ctl, order }: { tag: string; ctl: Ctl; order: TimeOrder }) {
  const tagsByKey = useUserData((s) => s.tagsByKey);
  const keys = useMemo(() => Object.keys(tagsByKey).filter((k) => tagsByKey[k].includes(tag)), [tagsByKey, tag]);
  return <GridOfEntries entries={useEntriesForKeys(keys, order)} ctl={ctl} empty="libNoResults" />;
}

export function PeriodPage({ by, id, ctl, order }: { by: 'month' | 'year'; id: string; ctl: Ctl; order: TimeOrder }) {
  const index = useLibraryIndex((s) => s.visible);
  const metadata = useUserData((s) => s.archiveMeta);
  const calendarMode = useSettingsStore((s) => s.calendarMode);
  const kind = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  const applyView = useApplyView(order);
  const entries = useMemo(() => {
    const group = groupByPeriod(index, (iso) => calendarYearMonth(iso, kind), by, metadata).find((g) => g.id === id);
    return applyView(group?.entries ?? []);
  }, [index, kind, by, id, metadata, applyView]);
  return <GridOfEntries entries={entries} ctl={ctl} empty="libNoResults" />;
}

export function AlbumPage({ id, ctl, onDeleted, order }: { id: number; ctl: Ctl; onDeleted: () => void; order: TimeOrder }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const album = useUserData((s) => s.albums.find((a) => a.id === id));
  const albumKeys = useUserData((s) => s.albumKeys[id]);
  const keys = useMemo(() => albumKeys ?? [], [albumKeys]);
  const entries = useEntriesForKeys(keys, order);
  const [busy, setBusy] = useState(false);

  if (!album) return null;
  const toggleOffline = async (on: boolean) => {
    setBusy(true);
    await setAlbumOfflineFlag(id, on);
    if (on) await saveOfflineMany(entries);
    else for (const e of entries) await removeOffline(e.key);
    setBusy(false);
  };
  const header = (
    <Card>
      <View style={[styles.line, { flexDirection: rowOf(isRTL) }]}>
        <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 14, textAlign: isRTL ? 'right' : 'left' }}>{t('albumOffline')}</Text>
        <Switch value={album.offline} disabled={busy} onValueChange={toggleOffline} trackColor={{ true: colors.switchOn, false: colors.track }} />
      </View>
      <Pressable accessibilityRole="button" onPress={async () => { await deleteAlbum(id); onDeleted(); }} style={[styles.deleteAlbum, { flexDirection: rowOf(isRTL), borderTopColor: colors.border }]}>
        <Feather name="trash-2" size={16} color={colors.destructive} />
        <Text style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), fontSize: 14 }}>{t('albumDelete')}</Text>
      </Pressable>
    </Card>
  );
  return <GridOfEntries entries={entries} ctl={ctl} empty="libEmptyAlbum" header={header} />;
}

function ListRow({ icon, label, count, onPress }: { icon: keyof typeof Feather.glyphMap; label: string; count?: string; onPress: () => void }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.listRow, { flexDirection: rowOf(isRTL), backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.76 : 1 }]}>
      <IconTile icon={icon} size={44} color={colors.primary} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 15, textAlign: isRTL ? 'right' : 'left' }}>{label}</Text>
      {count ? <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{count}</Text> : null}
      <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={17} color={colors.mutedForeground} />
    </Pressable>
  );
}

function SectionTitle({ k }: { k: TranslationKey }) {
  const { t } = useI18n();
  return <View style={styles.sectionTitle}><SectionLabel label={t(k)} /></View>;
}

export function AlbumsRoot({ onAlbum, ctl, order }: {
  order: TimeOrder; ctl: Ctl; onAlbum: (id: number) => void;
}) {
  const { isRTL, t } = useI18n();
  const albums = useUserData((s) => s.albums);
  const albumKeys = useUserData((s) => s.albumKeys);
  const allIndex = useLibraryIndex((s) => s.visible);
  const digits = useSettingsStore((s) => s.digits);
  const applyView = useApplyView(order);
  const entries = useMemo(() => applyView(allIndex.filter((entry) => entry.item.type === 'image' || entry.item.type === 'video')), [allIndex, applyView]);
  const [name, setName] = useState('');
  const create = async () => {
    const id = await createAlbum(name);
    setName('');
    if (id !== null) onAlbum(id);
  };
  // The manual-albums block is the HEADER of the grid, so it scrolls away with the photos (nothing stays pinned above them).
  const header = (
    <View>
      <SectionTitle k="albumsManual" />
      <View style={[styles.newRow, { flexDirection: rowOf(isRTL) }]}>
        <View style={{ flex: 1 }}>
          <Input value={name} onChangeText={setName} onSubmitEditing={create} returnKeyType="done" placeholder={t('albumName')} accessibilityLabel={t('albumName')} />
        </View>
        <Button title="albumNew" onPress={() => void create()} primary compact icon="plus" />
      </View>
      {albums.length === 0 ? <EmptyState message={t('albumEmpty')} /> : (
        <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }}>
          {albums.map((a) => (
            <ListRow key={a.id} icon={a.offline ? 'download-cloud' : 'folder'} label={a.name} count={toDigits(albumKeys[a.id]?.length ?? 0, digits)} onPress={() => onAlbum(a.id)} />
          ))}
        </ScrollView>
      )}
    </View>
  );
  return <GridOfEntries entries={entries} ctl={ctl} empty="libEmptyFolder" header={header} />;
}

const CATEGORY_LABEL: Record<Category, TranslationKey> = { image: 'catPhotos', video: 'catVideos', file: 'catFiles', text: 'catTexts' };

export function SearchView({ ctl }: { ctl: Ctl }) {
  const { isRTL, t } = useI18n();
  const index = useLibraryIndex((s) => s.visible);
  const allTags = useUserData((s) => s.allTags);
  const tagsByKey = useUserData((s) => s.tagsByKey);
  const metadata = useUserData((s) => s.archiveMeta);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<Category | 'all'>('all');
  const [tag, setTag] = useState<string | null>(null);
  const results = useMemo(() => {
    if (!query.trim() && type === 'all' && !tag) return [];
    return index
      .filter((e) => (type === 'all' || e.item.type === type) && (!tag || tagsByKey[e.key]?.includes(tag)) && matchesQuery(e, query, tagsByKey[e.key]))
      .sort((a, b) => compareEntries(a, b, 'newest', metadata));
  }, [index, query, type, tag, tagsByKey, metadata]);
  const chip = (label: string, on: boolean, press: () => void, key: string) => (
    <Chip key={key} label={label} selected={on} onPress={press} />
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchInput}>
        <Input
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={t('libSearchHint')}
          accessibilityLabel={t('libSearchHint')}
          icon="search"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexDirection: rowOf(isRTL) }]} style={{ flexGrow: 0 }}>
        {chip(t('libFilterAll'), type === 'all', () => setType('all'), 'all')}
        {CATEGORIES.map((c) => chip(t(CATEGORY_LABEL[c]), type === c, () => setType(c), c))}
        {allTags.map((name) => chip(`# ${name}`, tag === name, () => setTag(tag === name ? null : name), `t-${name}`))}
      </ScrollView>
      <GridOfEntries entries={results} ctl={ctl} empty={query.trim() || tag || type !== 'all' ? 'libNoResults' : 'libSearchHint'} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { alignItems: 'center', gap: 10 },
  deleteAlbum: { alignItems: 'center', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  listRow: { minHeight: 68, alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderRadius: radii.card, marginHorizontal: 16, marginBottom: 8 },
  sectionTitle: { paddingHorizontal: 18 },
  newRow: { gap: 10, paddingHorizontal: 18, paddingBottom: 6, alignItems: 'center' },
  searchInput: { marginHorizontal: 16, marginTop: 8 },
  chips: { gap: 8, paddingHorizontal: 18, paddingVertical: 10 },
});
