import { Feather } from '@expo/vector-icons';
import { getRandomBytes } from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  InteractionManager,
  Keyboard,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CategorySheet } from '@/components/diary/CategorySheet';
import { DriveFolderBrowser } from '@/components/drive/DriveFolderBrowser';
import { MediaSourceSheet } from '@/components/media/MediaSourceSheet';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { DateWheel } from '@/components/ui/DateWheel';
import { ScreenFrame } from '@/components/ScreenFrame';
import { MoodTile } from '@/components/status/MoodTile';
import { Button } from '@/components/server/ui';
import { Chip, EmptyState, Input, ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { Thumb } from '@/src/library/ui/Thumb';
import type { LibraryEntry } from '@/src/library/merge';
import { useLibraryIndex } from '@/src/library/index-store';
import { useViewerStore } from '@/src/library/viewer-store';
import { DIARY_CATEGORIES, DIARY_NO_CATEGORY } from '@/src/diary/categories';
import { useCustomCategories } from '@/src/diary/use-categories';
import { getDiaryEntry, saveDiaryEntry, type DiaryRow } from '@/src/diary/diary-db';
import { syncMemoryCategoryToArchive } from '@/src/diary/diary-media';
import { logEvent, traceAlive, traceEvent } from '@/src/diagnostics/log';
import { sendDiary } from '@/src/partner/manage';
import { MOODS } from '@/src/partner/moods';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { formatDate } from '@/src/lib/calendar';
import { localDayString, memoryDateFromDay } from '@/src/backup/day-folder';
import { isoToParts, partsToIso } from '@/src/partner/birthday';
import { useSettingsStore } from '@/src/state/settings-store';
import { pickFromSource } from '@/src/media/pick';
import { pickErrorKey } from '@/src/media/pick-logic';
import { addToDrive } from '@/src/drive/add-files';
import { driveProvider } from '@/src/drive/manage';
import { useDriveStore } from '@/src/state/drive-store';

function newDiaryId(): string {
  return `di${Array.from(getRandomBytes(10), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function isMediaEntry(entry: LibraryEntry | undefined): entry is LibraryEntry {
  return !!entry && (entry.item.type === 'image' || entry.item.type === 'video');
}

/** Q2: a render error on this screen shows the error message instead of closing the app. */
export { RouteErrorBoundary as ErrorBoundary } from '@/components/RouteErrorBoundary';

export default function NewDiaryEntryScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const entryId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { language, isRTL, t } = useI18n();
  const insets = useSafeAreaInsets();
  const libraryByKey = useLibraryIndex((state) => state.byKey);
  const moodScroll = useRef<ScrollView>(null);
  const thumbnailScroll = useRef<ScrollView>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const { customs, reload: reloadCustoms } = useCustomCategories();
  const [category, setCategory] = useState<string>(DIARY_NO_CATEGORY);
  const [manageOpen, setManageOpen] = useState(false);
  const [mood, setMood] = useState<string | null>(null);
  const [mediaKeys, setMediaKeys] = useState<string[]>([]);
  // The memory's date: today unless another day (today or the past) is picked. It files the memory in the Archive and on the server (Backup/year/month/day).
  const { calendarMode, digits } = useSettingsStore();
  const dateMode = calendarMode === 'both' ? 'jalali' : calendarMode;
  const [dayPick, setDayPick] = useState(() => localDayString(new Date()));
  const [dayChanged, setDayChanged] = useState(false);
  const [dateSheet, setDateSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  // Where the photos/videos of this memory are stored: Google Drive (default) or this phone, and the Drive folder.
  const driveAccount = useDriveStore((s) => s.account);
  const archiveRoot = useDriveStore((s) => s.rootFolder);
  const diarySource = useDriveStore((s) => s.diarySource);
  const diaryFolder = useDriveStore((s) => s.diaryFolder);
  const [folderSheet, setFolderSheet] = useState(false);
  const toDrive = diarySource === 'drive' && driveAccount !== null;
  // The folders offered start at the Archive's own folder, so a memory's files stay inside the Archive.
  const openFolderSheet = async () => {
    try { await driveProvider()?.ensureRoot(); } catch { /* shown as a load error inside the sheet */ }
    setFolderSheet(true);
  };
  const [sheetVisible, setSheetVisible] = useState(false);
  const [record, setRecord] = useState<DiaryRow | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not-found' | 'failed'>(entryId ? 'loading' : 'ready');
  const [error, setError] = useState<TranslationKey | null>(null);
  // Plain React Native keyboard padding. The keyboard-controller KeyboardAvoidingView (reanimated worklets on the UI thread)
  // is the only thing this popped screen has that Events/detail screens do not, and the app died right after router.back().
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => setKeyboardHeight(Math.max(0, Math.round(event.endCoordinates?.height ?? 0))));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    traceEvent(`diary form: mounted (${entryId ? 'edit' : 'new'})`);
    const show = Keyboard.addListener('keyboardDidShow', () => traceEvent('diary form: keyboard shown'));
    const hide = Keyboard.addListener('keyboardDidHide', () => traceEvent('diary form: keyboard hidden'));
    return () => {
      show.remove();
      hide.remove();
      traceEvent('diary form: unmounted');
    };
  }, [entryId]);

  useEffect(() => {
    if (!entryId) {
      setRecord(null);
      setTitle('');
      setBody('');
      setCategory(DIARY_NO_CATEGORY);
      setMood(null);
      setMediaKeys([]);
      setDayPick(localDayString(new Date()));
      setDayChanged(false);
      setLoadState('ready');
      return undefined;
    }
    let active = true;
    setLoadState('loading');
    setError(null);
    void getDiaryEntry(db, entryId).then((row) => {
      if (!active) return;
      if (!row) {
        setRecord(null);
        setLoadState('not-found');
        return;
      }
      setRecord(row);
      setTitle(row.title);
      setBody(row.body);
      setCategory(row.category);
      setMood(row.mood);
      setMediaKeys(row.mediaKeys);
      setDayPick(localDayString(row.createdAt));
      setDayChanged(false);
      setLoadState('ready');
      if (row.mediaKeys.length > 0 && useLibraryIndex.getState().status === 'idle') {
        void useLibraryIndex.getState().build().catch(() => undefined);
      }
    }).catch(() => {
      if (active) setLoadState('failed');
    });
    return () => { active = false; };
  }, [db, entryId]);

  const save = async () => {
    const cleanTitle = title.trim();
    traceEvent(`diary save: tap (titleLen=${cleanTitle.length} bodyLen=${body.length} media=${mediaKeys.length} cat=${category} mood=${mood ? 'yes' : 'no'} keyboard=${Keyboard.isVisible() ? 'open' : 'closed'})`);
    if (!cleanTitle || saving || picking || loadState !== 'ready' || (entryId && !record)) return;
    setSaving(true);
    setError(null);
    let saved = false;
    const now = new Date().toISOString();
    // A picked day files the memory at that day (local noon); an unchanged date keeps the memory's own time.
    const picked = dayChanged ? memoryDateFromDay(dayPick) : null;
    if (dayChanged && !picked) {
      setError('diaryDateFuture');
      setSaving(false);
      return;
    }
    const createdAt = picked ?? record?.createdAt ?? now;
    try {
      const next: DiaryRow = record
        ? { ...record, title: cleanTitle, category, mood, body: body.trim(), mediaKeys, createdAt, updatedAt: now }
        : {
            id: newDiaryId(),
            title: cleanTitle,
            category,
            mood,
            body: body.trim(),
            mediaKeys,
            saved: false,
            fromMe: true,
            createdAt,
            updatedAt: now,
          };
      traceEvent('diary save: before db write');
      await saveDiaryEntry(db, next);
      traceEvent('diary save: db write done');
      // Q2: the memory's media is filed under its category in the Archive (never blocks or fails the save).
      await syncMemoryCategoryToArchive(next.mediaKeys, next.category, record?.category, db);
      traceEvent('diary save: archive sync done');
      traceEvent('diary save: before router.back');
      saved = true;
      router.back();
      traceEvent('diary save: router.back returned');
      traceAlive('diary save');
      // R8a: the partner gets the memory (and a notification). Q2: this runs AFTER the screen has closed and the transition
      // has finished (the upload reads and hashes big files), and nothing in it can escape as an unhandled error.
      InteractionManager.runAfterInteractions(() => {
        traceEvent('diary send: start');
        void sendDiary(db, next)
          .then((result) => {
            traceEvent(`diary send: result ${result}`);
            if (result === 'failed') Alert.alert(t('diarySavedNotShared'));
          })
          .catch((sendError: unknown) => {
            logEvent('error', `diary send: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
            Alert.alert(t('diarySavedNotShared'));
          });
      });
    } catch (saveError) {
      logEvent('error', `diary save: ${saveError instanceof Error ? `${saveError.name}: ${saveError.message}` : String(saveError)}`);
      setError('diarySaveFailed');
    } finally {
      // After a successful save the screen is closing: no more state changes on it (a re-render of the form's TextInputs
      // during the pop animation is what crashed Fabric: "addViewAt ... View already has a parent ... ReactEditText").
      if (!saved) setSaving(false);
      traceEvent('diary save: finished');
    }
  };

  const addMedia = async (source: 'camera' | 'gallery') => {
    if (picking || saving) return;
    setError(null);
    setPicking(true);
    try {
      if (toDrive) {
        // The memory's files go into the chosen Drive folder (a `Diary` folder in the Archive's folder until one is chosen).
        const provider = driveProvider();
        const folderId = diaryFolder?.id ?? (await provider?.createFolder('Diary', null))?.id ?? null;
        const uploaded = await addToDrive(source, folderId);
        if (uploaded.keys.length > 0) setMediaKeys((current) => [...new Set([...current, ...uploaded.keys])]);
        if (!uploaded.cancelled && uploaded.failed > 0) {
          setError(uploaded.error === 'quota' ? 'driveQuotaFull' : uploaded.error === 'unauthorized' ? 'driveSessionExpired' : uploaded.error === 'camera-permission' ? 'mediaCameraDenied' : 'mediaPickFailed');
        }
        return;
      }
      const result = await pickFromSource(source, { multiple: true });
      const keys = result.keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
      if (keys.length > 0) {
        setMediaKeys((current) => [...new Set([...current, ...keys])]);
      }
      if (result.error) setError(pickErrorKey(result.error));
      else if (!result.cancelled && (result.failed > 0 || result.added > keys.length)) setError('mediaPickFailed');
    } catch {
      setError('mediaPickFailed');
    } finally {
      setPicking(false);
    }
  };

  const openMedia = (key: string) => {
    const media = mediaKeys.map((itemKey) => libraryByKey.get(itemKey)).filter(isMediaEntry);
    const index = media.findIndex((item) => item.key === key);
    if (index < 0) return;
    useViewerStore.getState().open(media, index, { grid: true });
    router.push('/viewer' as never);
  };

  const dayOk = !dayChanged || memoryDateFromDay(dayPick) !== null;
  const dayParts = isoToParts(dateMode, `${dayPick}T00:00:00.000Z`);
  const formReady = loadState === 'ready' && (!entryId || !!record);
  const moodItems = isRTL ? [...MOODS].reverse() : MOODS;
  const thumbnailItems = isRTL ? [...mediaKeys].reverse() : mediaKeys;

  return (
    <ScreenFrame contentStyle={{ paddingTop: 8, paddingBottom: 0 }}>
      <View style={{ flex: 1, paddingBottom: keyboardHeight }}>
        <ScreenHeader title={t(entryId ? 'diaryEditEntry' : 'diaryNewEntry')} />
        {loadState === 'loading' ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : !formReady ? (
          <View style={styles.loading}>
            <EmptyState message={t(loadState === 'failed' ? 'diaryEntryLoadFailed' : 'diaryEntryNotFound')} />
          </View>
        ) : (
          <>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={styles.form}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={{ gap: 12 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('diaryAddPhotos')}
                  accessibilityState={{ disabled: picking }}
                  disabled={picking || saving}
                  onPress={() => setSheetVisible(true)}
                  style={({ pressed }) => [
                    styles.addPhotos,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.primary,
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  {picking ? <ActivityIndicator color={colors.primary} /> : <Feather name="film" size={28} color={colors.primary} />}
                  <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15 }}>
                    {t('diaryAddPhotos')}
                  </Text>
                </Pressable>
                {mediaKeys.length > 0 ? (
                  <ScrollView
                    ref={thumbnailScroll}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ direction: 'ltr' }}
                    contentContainerStyle={{ direction: 'ltr', gap: 10 }}
                    onContentSizeChange={() => (isRTL ? thumbnailScroll.current?.scrollToEnd({ animated: false }) : thumbnailScroll.current?.scrollTo({ x: 0, animated: false }))}
                  >
                    {thumbnailItems.map((key) => {
                      const media = libraryByKey.get(key);
                      return (
                        <View key={key} style={styles.thumbnailBox}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('diaryOpenPhoto')}
                            disabled={!isMediaEntry(media)}
                            onPress={() => openMedia(key)}
                            style={StyleSheet.absoluteFill}
                          >
                            {isMediaEntry(media) ? (
                              <Thumb entry={media} style={styles.thumbnail} />
                            ) : (
                              <View style={[styles.thumbnail, styles.thumbnailFallback, { backgroundColor: colors.raised }]}>
                                <Feather name="image" size={22} color={colors.mutedForeground} />
                              </View>
                            )}
                          </Pressable>
                          {media?.item.type === 'video' ? (
                            <View pointerEvents="none" style={styles.videoBadge}>
                              <Feather name="play" size={13} color="#fff" />
                            </View>
                          ) : null}
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('diaryPhotoRemove')}
                            hitSlop={6}
                            onPress={() => setMediaKeys((current) => current.filter((currentKey) => currentKey !== key))}
                            style={[styles.removePhoto, { backgroundColor: colors.background }]}
                          >
                            <Feather name="x" size={15} color={colors.foreground} />
                          </Pressable>
                        </View>
                      );
                    })}
                  </ScrollView>
                ) : null}
              </View>

              <Input
                value={title}
                onChangeText={(value) => { setTitle(value); setError(null); }}
                placeholder={t('diaryTitlePlaceholder')}
                autoCapitalize="sentences"
                maxLength={120}
                fontSize={24}
                editable
              />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('diaryDate')}
                disabled={saving}
                onPress={() => setDateSheet(true)}
                style={({ pressed }) => ({ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 10, minHeight: 52, borderRadius: 26, borderWidth: 1, borderColor: dayOk ? colors.border : colors.destructive, backgroundColor: colors.card, paddingHorizontal: 16, opacity: pressed ? 0.7 : 1 })}
              >
                <Feather name="calendar" size={18} color={colors.primary} />
                <Text style={{ flex: 1, color: dayOk ? colors.foreground : colors.destructive, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: isRTL ? 'right' : 'left' }}>
                  {t('diaryDate')}: {formatDate(dayPick, dateMode, language, digits)}
                </Text>
                <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={colors.mutedForeground} />
              </Pressable>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: isRTL ? 'right' : 'left' }]}>
                  {t('diaryStorage')}
                </Text>
                <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 8 }}>
                  <Chip label={t('libSrcDrive')} icon="cloud" selected={diarySource === 'drive'} onPress={() => useDriveStore.getState().setDiarySource('drive')} />
                  <Chip label={t('libSrcLocal')} icon="smartphone" selected={diarySource === 'phone'} onPress={() => useDriveStore.getState().setDiarySource('phone')} />
                </View>
                {diarySource === 'drive' && !driveAccount ? (
                  <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, lineHeight: 22, textAlign: isRTL ? 'right' : 'left' }}>
                    {t('diaryDriveNeedsSignIn')}
                  </Text>
                ) : null}
                {toDrive ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('diaryFolderPick')}
                    onPress={() => void openFolderSheet()}
                    style={({ pressed }) => ({ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 10, minHeight: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingHorizontal: 16, opacity: pressed ? 0.7 : 1 })}
                  >
                    <Feather name="folder" size={18} color={colors.primary} />
                    <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14.5, textAlign: isRTL ? 'right' : 'left' }}>
                      {t('diaryFolder')}: {diaryFolder?.name ?? 'Diary'}
                    </Text>
                    <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={colors.mutedForeground} />
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: isRTL ? 'right' : 'left' }]}>
                  {t('diaryCategories')}
                </Text>
                <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 8 }}>
                  <Chip label={t('diaryCategoryNone')} selected={category === DIARY_NO_CATEGORY} onPress={() => setCategory(DIARY_NO_CATEGORY)} />
                  {DIARY_CATEGORIES.map((item) => (
                    <Chip key={item.id} label={t(item.name)} selected={category === item.id} onPress={() => setCategory(item.id)} />
                  ))}
                  {customs.map((item) => (
                    <Chip key={item.id} label={item.name} selected={category === item.id} onPress={() => setCategory(item.id)} />
                  ))}
                  <Chip label={t('diaryCategoryManage')} icon="plus" onPress={() => setManageOpen(true)} />
                </View>
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: isRTL ? 'right' : 'left' }]}>
                  {t('diaryHowFeel')}
                </Text>
                <ScrollView
                  ref={moodScroll}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ direction: 'ltr' }}
                  contentContainerStyle={{ direction: 'ltr', gap: 10, paddingHorizontal: 2 }}
                  onContentSizeChange={() => (isRTL ? moodScroll.current?.scrollToEnd({ animated: false }) : moodScroll.current?.scrollTo({ x: 0, animated: false }))}
                >
                  {moodItems.map((item) => (
                    <MoodTile
                      key={item.id}
                      emoji={item.emoji}
                      label={t(item.name)}
                      selected={mood === item.emoji}
                      shape="circle"
                      onPress={() => setMood((current) => current === item.emoji ? null : item.emoji)}
                    />
                  ))}
                </ScrollView>
              </View>

              <Input
                value={body}
                onChangeText={setBody}
                placeholder={t('diaryBodyPlaceholder')}
                multiline
                minHeight={220}
                autoCapitalize="sentences"
                maxLength={5000}
                editable
              />
              {error ? (
                <Text accessibilityRole="alert" style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }}>
                  {t(error)}
                </Text>
              ) : null}
            </ScrollView>
            <View style={{ paddingTop: 10, paddingBottom: keyboardHeight > 0 ? 8 : insets.bottom + 8 }}>
              <Button
                title="diarySave"
                onPress={() => void save()}
                primary
                disabled={!title.trim() || saving || picking || !formReady}
                busy={saving}
                icon="check"
              />
            </View>
          </>
        )}
      </View>
      <CategorySheet
        visible={manageOpen}
        onClose={() => setManageOpen(false)}
        customs={customs}
        onChanged={(added) => {
          void reloadCustoms().then((list) => {
            if (added) setCategory(added.id);
            else if (category !== DIARY_NO_CATEGORY && !DIARY_CATEGORIES.some((c) => c.id === category) && !list.some((c) => c.id === category)) setCategory(DIARY_NO_CATEGORY);
          });
        }}
      />
      <MediaSourceSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        onSelect={(source) => { if (source !== 'files') void addMedia(source); }}
        title={t('diaryAddPhotos')}
      />
      <BottomSheet visible={dateSheet} onClose={() => setDateSheet(false)} title={t('diaryDate')} cancelLabel={t('cancel')} actionLabel={t('diaryDateConfirm')} onAction={() => setDateSheet(false)} actionDisabled={!dayOk}>
        {dayParts ? (
          <DateWheel
            kind={dateMode}
            parts={dayParts}
            now={new Date()}
            onChange={(parts) => {
              const iso = partsToIso(dateMode, parts);
              if (iso) {
                setDayPick(iso.slice(0, 10));
                setDayChanged(true);
                setError(null);
              }
            }}
          />
        ) : null}
        {!dayOk ? <Text style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), fontSize: 12.5, textAlign: isRTL ? 'right' : 'left' }}>{t('diaryDateFuture')}</Text> : null}
      </BottomSheet>
      <BottomSheet visible={folderSheet && archiveRoot !== null} onClose={() => setFolderSheet(false)} title={t('diaryFolderPick')} cancelLabel={t('cancel')}>
        {archiveRoot ? (
          <DriveFolderBrowser
            start={archiveRoot}
            allowStart
            onUse={(folder) => { useDriveStore.getState().setDiaryFolder(folder); setFolderSheet(false); }}
          />
        ) : null}
      </BottomSheet>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center' },
  form: { gap: 18, paddingBottom: 18 },
  addPhotos: {
    minHeight: 108,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  section: { gap: 12 },
  sectionTitle: { fontSize: 16 },
  thumbnailBox: { width: 78, height: 78, borderRadius: 18, overflow: 'hidden' },
  thumbnail: { width: 78, height: 78, borderRadius: 18 },
  thumbnailFallback: { alignItems: 'center', justifyContent: 'center' },
  videoBadge: { position: 'absolute', bottom: 5, start: 5, width: 24, height: 24, borderRadius: 12, backgroundColor: '#000A', alignItems: 'center', justifyContent: 'center' },
  removePhoto: { position: 'absolute', top: 4, end: 4, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
