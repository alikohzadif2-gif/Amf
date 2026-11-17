import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/server/ui';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { IconTile } from '@/components/ui/IconTile';
import { ReelActions } from '@/components/library/ReelActions';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { diagnoseSource, ITEM_ISSUE_TEXT, type LoadIssue } from '@/src/library/load-issue';
import { sortRefs, type LibraryEntry } from '@/src/library/merge';
import { providerFor, sourceKinds } from '@/src/library/providers';
import { setFavorite, useUserData } from '@/src/library/user-data';
import { SOURCE_ICON } from '@/src/library/ui/EntryCell';
import { Thumb } from '@/src/library/ui/Thumb';
import { formatBytes, formatDuration } from '@/src/library/ui/format';
import { useViewerStore } from '@/src/library/viewer-store';
import { removeOffline, saveOffline } from '@/src/media/originals';
import { loadPreview, resolveVideo, type VideoSource } from '@/src/media/preview';
import { loadThumb } from '@/src/media/thumb-cache';
import { useSettingsStore } from '@/src/state/settings-store';
import type { ImageRef } from '@/src/storage/types';

const WHITE = '#fff';

const MAX_ZOOM = 6;

/**
 * Photo zoom: two-finger pinch around the fingers (1x to 6x), one-finger drag to move around while zoomed,
 * double tap toggles 1x / 2.5x at the tapped point, single tap shows or hides the icons.
 * All gestures run together; the drag only starts while zoomed, so at 1x the pager swipe still works.
 */
function ZoomView({ width, height, onZoom, onTap, children }: { width: number; height: number; onZoom: (z: boolean) => void; onTap: () => void; children: React.ReactNode }) {
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  // values at the start of a pinch / drag
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startFocalX = useSharedValue(0);
  const startFocalY = useSharedValue(0);

  const gesture = useMemo(() => {
    const clamp = () => {
      'worklet';
      const maxX = Math.max(0, ((scale.value - 1) * width) / 2);
      const maxY = Math.max(0, ((scale.value - 1) * height) / 2);
      tx.value = Math.max(-maxX, Math.min(maxX, tx.value));
      ty.value = Math.max(-maxY, Math.min(maxY, ty.value));
    };
    const finish = () => {
      'worklet';
      if (scale.value < 1.03) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        scheduleOnRN(onZoom, false);
      } else {
        scheduleOnRN(onZoom, true);
      }
    };
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        startScale.value = scale.value;
        startX.value = tx.value;
        startY.value = ty.value;
        startFocalX.value = e.focalX - width / 2;
        startFocalY.value = e.focalY - height / 2;
        scheduleOnRN(onZoom, true);
      })
      .onUpdate((e) => {
        const next = Math.max(1, Math.min(MAX_ZOOM, startScale.value * e.scale));
        const ratio = next / startScale.value;
        const fx = e.focalX - width / 2;
        const fy = e.focalY - height / 2;
        // the point that was under the fingers stays under the fingers (also while they move)
        tx.value = fx - ratio * (startFocalX.value - startX.value);
        ty.value = fy - ratio * (startFocalY.value - startY.value);
        scale.value = next;
        clamp();
      })
      .onEnd(() => { finish(); });
    const pan = Gesture.Pan()
      .minPointers(1)
      .maxPointers(2)
      .manualActivation(true)
      .onTouchesMove((_e, state) => {
        if (scale.value > 1.03) state.activate();
        else state.fail();
      })
      .onStart(() => { startX.value = tx.value; startY.value = ty.value; })
      .onUpdate((e) => {
        tx.value = startX.value + e.translationX;
        ty.value = startY.value + e.translationY;
        clamp();
      });
    const double = Gesture.Tap().numberOfTaps(2).maxDuration(260).onEnd((e, success) => {
      if (!success) return;
      if (scale.value > 1.03) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        scheduleOnRN(onZoom, false);
        return;
      }
      const target = 2.5;
      const fx = e.x - width / 2;
      const fy = e.y - height / 2;
      const maxX = ((target - 1) * width) / 2;
      const maxY = ((target - 1) * height) / 2;
      scale.value = withTiming(target);
      tx.value = withTiming(Math.max(-maxX, Math.min(maxX, -fx * (target - 1))));
      ty.value = withTiming(Math.max(-maxY, Math.min(maxY, -fy * (target - 1))));
      scheduleOnRN(onZoom, true);
    });
    // One tap shows/hides the icons; it waits for the double tap to fail first.
    const single = Gesture.Tap().numberOfTaps(1).maxDuration(260).onEnd((_e, success) => { if (success) scheduleOnRN(onTap); });
    return Gesture.Simultaneous(Gesture.Exclusive(double, single), pinch, pan);
  }, [width, height, onZoom, onTap, scale, tx, ty, startScale, startX, startY, startFocalX, startFocalY]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height }, style]}>{children}</Animated.View>
    </GestureDetector>
  );
}

function VideoBox({ uri, headers, poster, loop, reel, onError }: { uri: string; headers?: Record<string, string>; poster: ImageRef | null; loop: boolean; reel: boolean; onError: () => void }) {
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const player = useVideoPlayer(headers ? { uri, headers } : uri, (p) => { p.loop = loop; p.play(); });
  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay') setReady(true);
      else if (status === 'error') onError();
    });
    return () => sub.remove();
  }, [player, onError]);
  const toggle = () => {
    if (player.playing) { player.pause(); setPaused(true); } else { player.play(); setPaused(false); }
  };
  return (
    <View style={StyleSheet.absoluteFill}>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={!reel} contentFit="contain" />
      {reel ? <Pressable accessibilityRole="button" onPress={toggle} style={StyleSheet.absoluteFill} /> : null}
      {reel && paused ? <View pointerEvents="none" style={styles.playWrap}><View style={styles.playButton}><Feather name="play" size={30} color={WHITE} /></View></View> : null}
      {!ready && poster ? <Image source={poster.headers ? { uri: poster.uri, headers: poster.headers } : { uri: poster.uri }} style={StyleSheet.absoluteFill} contentFit="contain" pointerEvents="none" /> : null}
      {!ready ? <ActivityIndicator color={WHITE} style={StyleSheet.absoluteFill} /> : null}
    </View>
  );
}

function Page({ entry, active, width, height, vertical, onZoom, onTap }: { entry: LibraryEntry; active: boolean; width: number; height: number; vertical: boolean; onZoom: (z: boolean) => void; onTap: () => void }) {
  const colors = useColors();
  const { language, t } = useI18n();
  const previewQuality = useSettingsStore((s) => s.previewQuality);
  const dataSaver = useSettingsStore((s) => s.dataSaver);
  const videoMode = useSettingsStore((s) => s.videoMode);
  const [image, setImage] = useState<ImageRef | null>(null);
  const [failed, setFailed] = useState(false);
  const [issue, setIssue] = useState<LoadIssue | null>(null);
  const [video, setVideo] = useState<VideoSource | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const type = entry.item.type;

  // Image/video views do not tell why a load failed, so ask the server (wrong token / offline / gone).
  const diagnose = useCallback(() => {
    const first = sortRefs(entry.refs, sourceKinds())[0];
    void diagnoseSource(first ? providerFor(first.sourceId) : null).then(setIssue);
  }, [entry]);
  const fail = useCallback(() => { setFailed(true); diagnose(); }, [diagnose]);

  useEffect(() => {
    if (!active || (type !== 'image' && type !== 'video')) return;
    let alive = true;
    setFailed(false);
    setIssue(null);
    if (type === 'image') {
      loadPreview(entry, previewQuality, dataSaver).then((ref) => { if (alive) { setImage(ref); if (ref) setFailed(false); else fail(); } });
    } else {
      const first = sortRefs(entry.refs, sourceKinds())[0];
      const provider = first ? providerFor(first.sourceId) : null;
      if (provider) loadThumb(provider, { ...entry.item, id: first.itemId }, 768).then((ref) => { if (alive) setImage(ref); });
    }
    return () => { alive = false; };
  }, [active, entry, type, previewQuality, dataSaver, fail]);

  useEffect(() => { if (!active) { setPlaying(false); setVideo(null); } }, [active]);

  const play = async () => {
    setLoadingVideo(true);
    setFailed(false);
    setIssue(null);
    try {
      const source = await resolveVideo(entry, videoMode);
      setVideo(source);
      setPlaying(source.kind === 'play');
    } catch {
      fail();
    }
    setLoadingVideo(false);
  };

  // Reel mode (Explore): a video starts by itself when it scrolls into view, and stops when it leaves.
  useEffect(() => {
    if (vertical && active && type === 'video') void play();
  }, [vertical, active, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const center = { width, height, alignItems: 'center', justifyContent: 'center' } as const;
  if (type === 'file' || type === 'text') {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={entry.item.name} onPress={onTap} style={[center, { backgroundColor: colors.background }]}>
        <View style={styles.filePreview}>
          <IconTile icon={type === 'text' ? 'file-text' : 'file'} size={72} color={colors.primary} />
          <Text style={[styles.pageName, { color: colors.foreground, fontFamily: fontFamilyFor(language) }]}>{entry.item.name}</Text>
        </View>
      </Pressable>
    );
  }
  return (
    <View style={center}>
      {type === 'image' ? (
        <ZoomView width={width} height={height} onZoom={onZoom} onTap={onTap}>
          {image ? <Image source={image.headers ? { uri: image.uri, headers: image.headers } : { uri: image.uri }} style={{ width, height }} contentFit="contain" cachePolicy="memory-disk" onError={fail} /> : failed ? null : <ActivityIndicator color={WHITE} style={{ flex: 1 }} />}
        </ZoomView>
      ) : (
        <View style={{ width, height }}>
          {playing && video?.kind === 'play' ? <VideoBox uri={video.uri} headers={video.headers} poster={image} loop={vertical} reel={vertical} onError={() => { setPlaying(false); fail(); }} /> : (
            <>
              <Pressable accessibilityRole="button" accessibilityLabel={entry.item.name} onPress={onTap} style={StyleSheet.absoluteFill} />
              {image ? <Image source={image.headers ? { uri: image.uri, headers: image.headers } : { uri: image.uri }} style={StyleSheet.absoluteFill} contentFit="contain" pointerEvents="none" /> : null}
              <View pointerEvents="box-none" style={styles.playWrap}>
                <Pressable accessibilityRole="button" accessibilityLabel={t('viewerPlay')} onPress={play}>
                  {loadingVideo ? <ActivityIndicator color={WHITE} /> : <View style={styles.playButton}><Feather name="play" size={30} color={WHITE} /></View>}
                </Pressable>
              </View>
            </>
          )}
        </View>
      )}
      {failed ? <Text style={[styles.pageName, { position: 'absolute', fontFamily: fontFamilyFor(language) }]}>{t(ITEM_ISSUE_TEXT[issue ?? 'error'])}</Text> : null}
      {video && video.kind !== 'play' ? <Text style={[styles.note, { fontFamily: fontFamilyFor(language) }]}>{t(video.kind === 'demo' ? 'viewerDemoVideo' : 'viewerNoVideo')}</Text> : null}
    </View>
  );
}

function Detail({ label, value }: { label: TranslationKey; value: string }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <View style={[styles.detail, { flexDirection: rowOf(isRTL), borderBottomColor: colors.border }]}>
      <Text style={[styles.detailLabel, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }]}>{t(label)}</Text>
      <Text selectable style={[styles.detailValue, { color: colors.foreground, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }]}>{value}</Text>
    </View>
  );
}

export default function ViewerScreen() {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const { entries, index: start, grid, vertical } = useViewerStore();
  const calendarMode = useSettingsStore((s) => s.calendarMode);
  const digits = useSettingsStore((s) => s.digits);
  const favorites = useUserData((s) => s.favorites);
  const offline = useUserData((s) => s.offline);
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [showGrid, setShowGrid] = useState(grid);
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(false);
  const [saving, setSaving] = useState(false);
  const list = useRef<FlatList<LibraryEntry>>(null);
  // Vertical paging snaps to the list's own height, so measure it instead of trusting the window height.
  const [listH, setListH] = useState(height);
  const pageH = vertical ? listH : height;

  const onTap = useCallback(() => setChrome((v) => !v), []);
  // Opened from the grid: back (button or system) returns to the grid first.
  const backToGrid = grid && !showGrid;
  useEffect(() => {
    if (!backToGrid) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setShowGrid(true); setChrome(true); setZoomed(false); return true; });
    return () => sub.remove();
  }, [backToGrid]);
  const goBack = () => { if (backToGrid) { setShowGrid(true); setChrome(true); setZoomed(false); } else router.back(); };

  const entry = entries[index];
  const kinds = sourceKinds();
  if (!entry) {
    return (
      <SafeAreaView edges={['top']} style={[styles.emptyViewer, { backgroundColor: colors.background }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('back')}
          onPress={() => router.back()}
          style={[styles.round, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={20} color={colors.foreground} />
        </Pressable>
      </SafeAreaView>
    );
  }
  const isOffline = !!offline[entry.key];
  const toggleOffline = async () => {
    setSaving(true);
    if (isOffline) await removeOffline(entry.key); else await saveOffline(entry);
    setSaving(false);
  };
  const sourceLabel = { local: 'libSrcLocal', vault: 'libSrcVault' } as const;
  const it = entry.item;

  if (showGrid) {
    const tile = Math.floor(width / 3);
    return (
      <View style={[styles.root, { direction: 'ltr' }]}>
        <SafeAreaView edges={['top']}>
          <View style={[styles.topBar, { flexDirection: rowOf(isRTL), direction: isRTL ? 'rtl' : 'ltr', paddingBottom: 8 }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={() => router.back()} style={[styles.round, { backgroundColor: colors.scrim, borderColor: colors.border }]}>
              <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={20} color={WHITE} />
            </Pressable>
            <Text style={[styles.counter, { backgroundColor: colors.scrim, fontFamily: fontFamilyFor(language) }]}>{toDigits(entries.length, digits)}</Text>
          </View>
        </SafeAreaView>
        <FlatList
          data={entries}
          numColumns={3}
          keyExtractor={(e) => e.key}
          contentContainerStyle={styles.gridContent}
          renderItem={({ item, index: i }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.item.name}
              onPress={() => { setIndex(i); setChrome(true); setShowGrid(false); }}
              style={{ width: tile, height: tile, padding: 2 }}
            >
              <Thumb entry={item} style={styles.gridThumb} />
              {item.item.type === 'video' ? (
                <View style={styles.gridPlay}><Feather name="play" size={12} color={WHITE} /></View>
              ) : null}
            </Pressable>
          )}
        />
      </View>
    );
  }

  return (
    <View style={[styles.root, { direction: 'ltr' }]}>
      <FlatList
        ref={list}
        data={entries}
        horizontal={!vertical}
        pagingEnabled
        scrollEnabled={!zoomed}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        keyExtractor={(e) => e.key}
        initialScrollIndex={index}
        onLayout={vertical ? (e) => setListH(e.nativeEvent.layout.height) : undefined}
        getItemLayout={(_, i) => (vertical ? { length: pageH, offset: pageH * i, index: i } : { length: width, offset: width * i, index: i })}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        onMomentumScrollEnd={(e) => {
          const { x, y } = e.nativeEvent.contentOffset;
          setIndex(Math.round(vertical ? y / pageH : x / width));
          setZoomed(false);
        }}
        renderItem={({ item, index: i }) => <Page entry={item} active={i === index} width={width} height={pageH} vertical={vertical} onZoom={setZoomed} onTap={onTap} />}
      />
      {chrome && !vertical ? <SafeAreaView edges={['top']} pointerEvents="box-none" style={styles.top}>
        <View style={[styles.topBar, { flexDirection: rowOf(isRTL), direction: isRTL ? 'rtl' : 'ltr' }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={goBack} style={[styles.round, { backgroundColor: colors.scrim, borderColor: colors.border }]}>
            <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={20} color={WHITE} />
          </Pressable>
          <Text numberOfLines={1} style={[styles.counter, { backgroundColor: colors.scrim, fontFamily: fontFamilyFor(language) }]}>{`${toDigits(index + 1, digits)} / ${toDigits(entries.length, digits)}`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t(favorites.has(entry.key) ? 'favRemove' : 'favAdd')} onPress={() => setFavorite([entry], !favorites.has(entry.key))} style={[styles.round, { backgroundColor: colors.scrim, borderColor: colors.border }]}>
            <Feather name="star" size={20} color={favorites.has(entry.key) ? '#FFD66B' : WHITE} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('viewerInfo')} onPress={() => setInfo((v) => !v)} style={[styles.round, { backgroundColor: colors.scrim, borderColor: colors.border }]}>
            <Feather name="info" size={20} color={info ? colors.primary : WHITE} />
          </Pressable>
        </View>
      </SafeAreaView> : null}
      {vertical && (entry.item.type === 'image' || entry.item.type === 'video') ? <ReelActions entry={entry} /> : null}
      <BottomSheet
        visible={info}
        onClose={() => setInfo(false)}
        title={t('viewerInfo')}
        cancelLabel={t('cancel')}
      >
        <View style={styles.details}>
          <Detail label="viewerName" value={it.name} />
          <Detail label="viewerSize" value={formatBytes(it.size, t, digits)} />
          <Detail label="viewerDate" value={formatDate(it.mtime, calendarMode, language, digits)} />
          {it.width && it.height ? <Detail label="viewerDimensions" value={`${toDigits(it.width, digits)} × ${toDigits(it.height, digits)}`} /> : null}
          {it.duration ? <Detail label="viewerDuration" value={formatDuration(it.duration, digits)} /> : null}
          <View style={[styles.detail, { flexDirection: rowOf(isRTL), borderBottomColor: colors.border }]}>
            <Text style={[styles.detailLabel, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }]}>{t('viewerSources')}</Text>
            <View style={[styles.sourceList, { flexDirection: rowOf(isRTL) }]}>
              {[...new Set(sortRefs(entry.refs, kinds).map((r) => kinds[r.sourceId]))].filter(Boolean).map((k) => (
                <View key={k} style={[styles.sourceItem, { flexDirection: rowOf(isRTL) }]}>
                  <Feather name={SOURCE_ICON[k]} size={14} color={colors.primary} />
                  <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: fontFamilyFor(language) }}>{t(sourceLabel[k])}</Text>
                </View>
              ))}
            </View>
          </View>
          {it.md5 ? <Detail label="viewerMd5" value={it.md5} /> : null}
          <Button
            title={isOffline ? 'viewerRemoveOffline' : 'viewerMakeOffline'}
            onPress={() => void toggleOffline()}
            busy={saving}
            variant="outline"
            compact
            icon={isOffline ? 'trash-2' : 'download-cloud'}
          />
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  emptyViewer: { flex: 1, paddingHorizontal: 16, paddingTop: 10 },
  top: { position: 'absolute', top: 0, start: 0, end: 0 },
  topBar: { alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 8 },
  round: { width: 44, height: 44, borderRadius: radii.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  counter: { flex: 1, overflow: 'hidden', color: WHITE, fontSize: 14, textAlign: 'center', borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 12 },
  filePreview: { alignItems: 'center', gap: 18, paddingHorizontal: 24 },
  pageName: { fontSize: 15, textAlign: 'center', lineHeight: 24 },
  note: { position: 'absolute', bottom: 120, color: WHITE, fontSize: 13, backgroundColor: '#000A', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12 },
  playWrap: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' },
  gridContent: { paddingBottom: 24 },
  gridThumb: { flex: 1, borderRadius: 6 },
  gridPlay: { position: 'absolute', bottom: 8, start: 8, backgroundColor: '#000A', borderRadius: radii.pill, padding: 5 },
  playButton: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#000A', alignItems: 'center', justifyContent: 'center' },
  details: { gap: 2 },
  detail: { gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  detailLabel: { width: 100, flexShrink: 0, fontSize: 13 },
  detailValue: { flex: 1, fontSize: 13, lineHeight: 21 },
  sourceList: { flex: 1, alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  sourceItem: { alignItems: 'center', gap: 5 },
});
