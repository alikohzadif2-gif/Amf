import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, useWindowDimensions, type ViewToken } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { SharedViewer } from '@/components/diary/SharedThumb';
import { GalleryTile } from '@/components/gallery/GalleryTile';
import { useColors } from '@/hooks/useColors';
import { galleryFolderCount, listGalleryPage, type GalleryRow } from '@/src/gallery/gallery-db';
import { GALLERY_COLUMNS, GALLERY_GAP, GALLERY_PAGE, galleryTileWidth } from '@/src/gallery/gallery-logic';
import { galleryThumbReset, galleryThumbTick, galleryWant } from '@/src/gallery/thumb-client';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';
import { usePartnerStore } from '@/src/state/partner-store';

const VIEWABILITY = { itemVisiblePercentThreshold: 30, minimumViewTime: 120 };

/**
 * The partner's Shared gallery. Top level = folders (and loose files); a tap on a folder opens it (same screen, `folder` = its path).
 * Rows come from the manifest stored on this phone, one page at a time; a picture is asked for only while its tile is on screen (at most a few
 * at once, see src/gallery/thumb-scheduler.ts). The original file is asked for only from the viewer ("Full quality").
 */
export default function PartnerGalleryScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const paired = usePartnerStore((s) => s.paired);
  const galleryTick = usePartnerStore((s) => s.galleryTick);
  const { folder: folderParam } = useLocalSearchParams<{ folder?: string }>();
  const folder = typeof folderParam === 'string' ? folderParam : '';
  const { width } = useWindowDimensions();
  const tileWidth = galleryTileWidth(width, 32);

  const [rows, setRows] = useState<GalleryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const loadingMore = useRef(false);
  const rowsRef = useRef<GalleryRow[]>([]);
  rowsRef.current = rows;

  const load = useCallback(
    async (offset: number, limit: number) => {
      const page = await listGalleryPage(db, folder, offset, limit);
      const folders = page.rows.filter((r): r is Extract<GalleryRow, { type: 'folder' }> => r.type === 'folder');
      const found = await Promise.all(folders.map(async (f) => [f.path, await galleryFolderCount(db, f.path)] as const));
      setCounts((old) => ({ ...old, ...Object.fromEntries(found) }));
      setTotal(page.total);
      return page.rows;
    },
    [db, folder],
  );

  // First page, and again (as many rows as are shown) when the partner's list changed.
  useEffect(() => {
    let alive = true;
    void load(0, Math.max(GALLERY_PAGE, rowsRef.current.length)).then((first) => {
      if (!alive) return;
      setRows(first);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [load, galleryTick]);

  const loadMore = useCallback(() => {
    if (loadingMore.current || rowsRef.current.length >= total) return;
    loadingMore.current = true;
    void load(rowsRef.current.length, GALLERY_PAGE)
      .then((more) => setRows((old) => (old.length === rowsRef.current.length ? [...old, ...more] : old)))
      .finally(() => {
        loadingMore.current = false;
      });
  }, [load, total]);

  // Only the tiles on screen are asked for, top to bottom; a timer lets silent requests time out and the next ones go.
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const visible = viewableItems
      .filter((v) => v.isViewable && v.item && (v.item as GalleryRow).type === 'file' && (v.item as { kind: string }).kind !== 'f')
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((v) => ({ id: (v.item as { id: string }).id, path: (v.item as { path: string }).path }));
    void galleryWant(visible);
  });
  useEffect(() => {
    const timer = setInterval(galleryThumbTick, 3000);
    return () => {
      clearInterval(timer);
      void galleryWant([]);
    };
  }, []);

  const title = folder === '' ? t('galleryPartnerTitle') : folder.slice(folder.lastIndexOf('/') + 1);
  const font = fontFamilyFor(language, 'semibold');
  const header = (
    <View style={{ gap: 6, paddingBottom: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={() => router.back()} style={[styles.back, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={18} color={colors.foreground} />
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{t('back')}</Text>
      </Pressable>
      <Text numberOfLines={1} style={[styles.title, { color: colors.foreground, fontFamily: font, textAlign: alignOf(isRTL) }]}>{title}</Text>
      {folder === '' ? <Text style={[styles.intro, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('galleryPartnerIntro')}</Text> : null}
    </View>
  );

  const renderItem = ({ item }: { item: GalleryRow }) => (
    <View style={{ width: tileWidth }}>
      {item.type === 'folder' ? (
        <Pressable accessibilityRole="button" accessibilityLabel={item.name} onPress={() => router.push({ pathname: '/gallery', params: { folder: item.path } })} style={[styles.folder, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="folder" size={30} color={colors.primary} />
          <Text numberOfLines={2} style={[styles.folderName, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium') }]}>{item.name}</Text>
          <Text numberOfLines={1} style={[styles.folderCount, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language) }]}>{`${toDigits(counts[item.path] ?? 0, digits)} ${t('vaultFilesSuffix')}`}</Text>
        </Pressable>
      ) : (
        <GalleryTile id={item.id} path={item.path} name={item.name} kind={item.kind} onOpen={setViewing} />
      )}
    </View>
  );

  return (
    <ScreenFrame>
      {!paired ? (
        <>
          {header}
          <Text style={[styles.note, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('galleryPartnerNotPaired')}</Text>
        </>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => (row.type === 'folder' ? `d:${row.path}` : `f:${row.id}`)}
          numColumns={GALLERY_COLUMNS}
          columnWrapperStyle={{ gap: GALLERY_GAP, marginBottom: GALLERY_GAP }}
          ListHeaderComponent={header}
          ListEmptyComponent={loaded ? <Text style={[styles.note, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('galleryPartnerEmpty')}</Text> : null}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          onViewableItemsChanged={onViewable.current}
          viewabilityConfig={VIEWABILITY}
          initialNumToRender={18}
          maxToRenderPerBatch={12}
          windowSize={5}
          removeClippedSubviews
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
      <SharedViewer path={viewing} onClose={() => setViewing(null)} hideDelete autoOriginal />
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', minHeight: 40, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, alignItems: 'center', gap: 8, flexDirection: 'row' },
  title: { fontSize: 24, marginTop: 14 },
  intro: { fontSize: 13, lineHeight: 21 },
  note: { fontSize: 14, lineHeight: 22, marginTop: 16 },
  folder: { aspectRatio: 1, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', padding: 8, gap: 4 },
  folderName: { fontSize: 13, textAlign: 'center' },
  folderCount: { fontSize: 11 },
});
