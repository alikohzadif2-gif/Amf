import { Feather, Ionicons } from '@expo/vector-icons';
import { getRandomBytes } from 'expo-crypto';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable as RNPressable,
  ScrollView,
  Share,
  StyleSheet,
  View as RNView,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from '@/components/ui/ScaledText';
import { MediaSourceSheet } from '@/components/media/MediaSourceSheet';
import { Avatar } from '@/components/partner/Avatar';
import { SharedThumb, SharedViewer } from '@/components/diary/SharedThumb';
import { splitSharedPath } from '@/src/partner/shared-media';
import { ScreenFrame } from '@/components/ScreenFrame';
import { EmptyState, ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/constants/colors';
import { diaryCategoryLabel } from '@/src/diary/categories';
import { useCustomCategories } from '@/src/diary/use-categories';
import { deleteDiaryEntry, getDiaryEntry, saveDiaryEntry, type DiaryRow } from '@/src/diary/diary-db';
import { addReply, deleteReply, DIARY_REPLY_MAX, listReplies, type DiaryReply } from '@/src/diary/reply-db';
import { syncMemoryCategoryToArchive } from '@/src/diary/diary-media';
import { logEvent } from '@/src/diagnostics/log';
import { sendDiary, sendDiaryReply } from '@/src/partner/manage';
import { useLibraryIndex } from '@/src/library/index-store';
import { type LibraryEntry } from '@/src/library/merge';
import { Thumb } from '@/src/library/ui/Thumb';
import { useViewerStore } from '@/src/library/viewer-store';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { pickFromSource } from '@/src/media/pick';
import { pickErrorKey } from '@/src/media/pick-logic';
import { alignOf, rowOf } from '@/src/lib/layout';
import { moodByEmoji } from '@/src/partner/moods';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

function isMediaEntry(entry: LibraryEntry | undefined): entry is LibraryEntry {
  return !!entry && (entry.item.type === 'image' || entry.item.type === 'video');
}

/** Q2: a render error on this screen shows the error message instead of closing the app. */
export { RouteErrorBoundary as ErrorBoundary } from '@/components/RouteErrorBoundary';

export default function DiaryEntryScreen() {
  const colors = useColors();
  const db = useSQLiteContext();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const { calendarMode, digits } = useSettingsStore();
  const libraryByKey = useLibraryIndex((state) => state.byKey);
  const libraryStatus = useLibraryIndex((state) => state.status);
  const { width: windowWidth } = useWindowDimensions();
  const mediaScroll = useRef<ScrollView>(null);
  const [entry, setEntry] = useState<DiaryRow | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not-found' | 'failed'>('loading');
  const { customs } = useCustomCategories();
  const [action, setAction] = useState<'idle' | 'saving' | 'deleting' | 'media'>('idle');
  const [sheetVisible, setSheetVisible] = useState(false);
  const [sharedOpen, setSharedOpen] = useState<string | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const me = usePartnerStore((st) => st.me);
  const partner = usePartnerStore((st) => st.partner);
  const paired = usePartnerStore((st) => st.paired);
  const diaryTick = usePartnerStore((st) => st.diaryTick); // a reply from the partner arrives while this screen is open
  const pageScroll = useRef<ScrollView>(null);
  const [replies, setReplies] = useState<DiaryReply[]>([]);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [heroPage, setHeroPage] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => setKeyboardHeight(Math.max(0, Math.round(event.endCoordinates?.height ?? 0))));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useFocusEffect(useCallback(() => {
    let active = true;
    setEntry(null);
    setError(null);
    setAction('idle');
    setLoadState('loading');
    if (!id) {
      setLoadState('not-found');
      return () => { active = false; };
    }
    void listReplies(db, id).then((rows) => { if (active) setReplies(rows); }).catch(() => undefined);
    void getDiaryEntry(db, id).then((row) => {
      if (!active) return;
      setEntry(row);
      setLoadState(row ? 'ready' : 'not-found');
      if (row?.mediaKeys.length && useLibraryIndex.getState().status === 'idle') {
        void useLibraryIndex.getState().build().catch(() => undefined);
      }
    }).catch(() => {
      if (active) setLoadState('failed');
    });
    return () => { active = false; };
  }, [db, id]));

  // A reply that arrives while the screen is open: only the thread reloads (the memory and the typed text stay as they are).
  useEffect(() => {
    if (!id) return;
    let active = true;
    void listReplies(db, id).then((rows) => { if (active) setReplies(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, [db, id, diaryTick]);

  const media = useMemo(
    () => entry?.mediaKeys.map((key) => libraryByKey.get(key)).filter(isMediaEntry) ?? [],
    [entry, libraryByKey],
  );
  const sharedKeys = useMemo(() => (entry && entry.fromMe === false ? entry.mediaKeys.filter((key) => splitSharedPath(key) !== null) : []), [entry]);
  const mine = entry?.fromMe !== false;
  // One list for the hero pager: my library media, or the files the partner shared. Pages are laid out left to right, so RTL reverses them.
  const heroItems = useMemo(() => {
    const list: { key: string; lib?: LibraryEntry; shared?: string }[] = media.length > 0
      ? media.map((item) => ({ key: item.key, lib: item }))
      : sharedKeys.map((key) => ({ key, shared: key }));
    return isRTL ? list.reverse() : list;
  }, [media, sharedKeys, isRTL]);
  const heroHeight = heroItems.length > 0 ? Math.round(Math.min(380, Math.max(260, windowHeight * 0.38))) : 190;
  const currentHero = heroItems[Math.min(heroPage, Math.max(0, heroItems.length - 1))];
  const partnerName = partner?.name || t('partnerDefaultName');
  const authorName = mine ? (me.name || t('diaryYou')) : partnerName;
  const categoryLabel = entry ? diaryCategoryLabel(entry.category, customs, t) : '';
  const mood = entry?.mood ? moodByEmoji(entry.mood) : undefined;

  const openMedia = (item: LibraryEntry) => {
    const index = media.findIndex((mediaItem) => mediaItem.key === item.key);
    if (index < 0) return;
    useViewerStore.getState().open(media, index, { grid: true });
    router.push('/viewer' as never);
  };

  const toggleSaved = async () => {
    if (!entry || action !== 'idle') return;
    setAction('saving');
    setError(null);
    try {
      const updated = { ...entry, saved: !entry.saved, updatedAt: new Date().toISOString() };
      await saveDiaryEntry(db, updated);
      setEntry(updated);
    } catch {
      setError('diarySaveFailed');
    } finally {
      setAction('idle');
    }
  };

  /** Saves a new media list for this memory (add or remove). Library files are never deleted, only the link to this memory. */
  const saveMedia = async (mediaKeys: string[]) => {
    if (!entry) return;
    const updated = { ...entry, mediaKeys, updatedAt: new Date().toISOString() };
    await saveDiaryEntry(db, updated);
    setEntry(updated);
    await syncMemoryCategoryToArchive(mediaKeys, updated.category, undefined, db); // Q2: new media follows the memory's Archive category
    void sendDiary(db, updated, { silent: true })
      .then((result) => {
        if (result === 'failed') Alert.alert(t('diarySavedNotShared')); // R8a: only the attachment count changes, no notification
      })
      .catch((sendError: unknown) => {
        logEvent('error', `diary send: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
        Alert.alert(t('diarySavedNotShared'));
      });
    if (mediaKeys.length > 0 && useLibraryIndex.getState().status === 'idle') {
      void useLibraryIndex.getState().build().catch(() => undefined);
    }
  };

  const addMedia = async (source: 'camera' | 'gallery') => {
    if (!entry || action !== 'idle') return;
    setAction('media');
    setError(null);
    try {
      const result = await pickFromSource(source, { multiple: true });
      const keys = result.keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
      if (keys.length > 0) await saveMedia([...new Set([...entry.mediaKeys, ...keys])]);
      if (result.error) setError(pickErrorKey(result.error));
      else if (!result.cancelled && (result.failed > 0 || result.added > keys.length)) setError('mediaPickFailed');
    } catch {
      setError('diarySaveFailed');
    } finally {
      setAction('idle');
    }
  };

  const confirmRemoveMedia = (key: string) => {
    if (!entry || action !== 'idle') return;
    Alert.alert(t('diaryRemoveMediaTitle'), t('diaryRemoveMediaBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('diaryRemoveMediaAction'),
        style: 'destructive',
        onPress: () => {
          setAction('media');
          setError(null);
          void saveMedia(entry.mediaKeys.filter((k) => k !== key))
            .catch(() => setError('diarySaveFailed'))
            .finally(() => setAction('idle'));
        },
      },
    ]);
  };

  const removeEntry = async () => {
    if (!id || action !== 'idle') return;
    setAction('deleting');
    setError(null);
    try {
      const mine = entry?.fromMe !== false;
      await deleteDiaryEntry(db, id);
      if (mine) void sendDiary(db, { id, deleted: true }); // R8a: a copy received from the partner is only removed here
      router.back();
    } catch {
      setError('diaryDeleteFailed');
      setAction('idle');
    }
  };

  const confirmDelete = () => {
    Alert.alert(t('diaryDeleteConfirmTitle'), t('diaryDeleteConfirmBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('diaryDeleteConfirmAction'), style: 'destructive', onPress: () => void removeEntry() },
    ]);
  };

  const editEntry = () => {
    if (!entry || action !== 'idle') return;
    router.push({ pathname: '/diary/new', params: { id: entry.id } } as never);
  };

  const shareEntry = async () => {
    if (!entry) return;
    try {
      await Share.share({ message: [entry.mood ? `${entry.mood} ${entry.title}` : entry.title, entry.body].filter(Boolean).join('\n\n') });
    } catch {
      // closing the share sheet is not an error
    }
  };

  const submitReply = async () => {
    const body = replyText.trim().slice(0, DIARY_REPLY_MAX);
    if (!entry || !body || replyBusy) return;
    setReplyBusy(true);
    setError(null);
    const reply: DiaryReply = {
      id: `rp${Array.from(getRandomBytes(8), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      memoryId: entry.id,
      fromMe: true,
      body,
      createdAt: new Date().toISOString(),
    };
    try {
      if (!(await addReply(db, reply))) throw new Error('reply not stored');
      setReplies((list) => [...list, reply]);
      setReplyText('');
      Keyboard.dismiss();
    } catch {
      setError('diaryReplyFailed');
      setReplyBusy(false);
      return;
    }
    setReplyBusy(false);
    void sendDiaryReply({ id: reply.id, memoryId: reply.memoryId, body: reply.body, createdAt: reply.createdAt })
      .then((result) => { if (result === 'failed') setError('diaryReplyNotSent'); })
      .catch(() => setError('diaryReplyNotSent'));
  };

  const confirmDeleteReply = (reply: DiaryReply) => {
    Alert.alert(t('diaryReplyDeleteTitle'), t('diaryReplyDeleteBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('diaryDeleteConfirmAction'),
        style: 'destructive',
        onPress: () => {
          void deleteReply(db, reply.id, true)
            .then(() => {
              setReplies((list) => list.filter((item) => item.id !== reply.id));
              void sendDiaryReply({ id: reply.id, memoryId: reply.memoryId, deleted: true }).catch(() => undefined);
            })
            .catch(() => setError('diaryReplyFailed'));
        },
      },
    ]);
  };

  if (loadState !== 'ready' || !entry) {
    return (
      <ScreenFrame scroll contentStyle={{ paddingTop: 10, gap: 16, paddingBottom: 36 }}>
        <ScreenHeader title={t('diaryEntryDetails')} />
        {loadState === 'loading' ? (
          <RNView style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </RNView>
        ) : loadState === 'failed' ? (
          <EmptyState message={t('diaryEntryLoadFailed')} />
        ) : (
          <EmptyState message={t('diaryEntryNotFound')} />
        )}
      </ScreenFrame>
    );
  }

  const align = alignOf(isRTL);
  const busy = action !== 'idle';
  const barHeight = 66 + insets.bottom;
  const answeredByPartner = replies.some((reply) => reply.fromMe !== mine);
  const barItems = [
    { key: 'share', icon: 'share-social-outline' as const, label: t('diaryShare'), a11y: t('diaryShare'), onPress: () => void shareEntry(), busy: false },
    ...(mine ? [{ key: 'edit', icon: 'pencil-outline' as const, label: t('diaryEditShort'), a11y: t('diaryEditEntry'), onPress: editEntry, busy: false }] : []),
    {
      key: 'save',
      icon: (entry.saved ? 'bookmark' : 'bookmark-outline') as 'bookmark' | 'bookmark-outline',
      label: t(entry.saved ? 'diarySavedShort' : 'diaryBookmarkSave'),
      a11y: t(entry.saved ? 'diaryBookmarkRemove' : 'diaryBookmarkSave'),
      onPress: () => void toggleSaved(),
      busy: action === 'saving',
    },
  ];
  const menuItems = [
    ...(mine ? [{ key: 'add', icon: 'plus' as const, label: t('diaryAddPhotos'), destructive: false, onPress: () => setSheetVisible(true) }] : []),
    ...(mine && currentHero?.lib ? [{ key: 'remove', icon: 'x-circle' as const, label: t('diaryPhotoRemove'), destructive: false, onPress: () => confirmRemoveMedia(currentHero.lib!.key) }] : []),
    { key: 'delete', icon: 'trash-2' as const, label: t('diaryDeleteEntry'), destructive: true, onPress: confirmDelete },
  ];
  const heroMessage = entry.mediaKeys.length === 0
    ? ((entry.sharedMedia ?? 0) > 0 ? t('diarySharedMedia').replace('{n}', toDigits(entry.sharedMedia ?? 0, digits)) : null)
    : libraryStatus === 'indexing' ? 'loading' : t('diaryPhotosUnavailable');

  return (
    <RNView style={{ flex: 1, backgroundColor: colors.background, direction: isRTL ? 'rtl' : 'ltr', paddingBottom: keyboardHeight }}>
      <ScrollView
        ref={pageScroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: keyboardHeight > 0 ? 24 : barHeight + 12 }}
      >
        {/* Hero: the memory's photos/videos edge to edge (swipe), a tap opens the viewer. */}
        <RNView style={{ height: heroHeight, backgroundColor: colors.raised }}>
          {heroItems.length > 0 ? (
            <ScrollView
              ref={mediaScroll}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              style={{ direction: 'ltr' }}
              contentContainerStyle={{ direction: 'ltr' }}
              onContentSizeChange={() => {
                if (isRTL) mediaScroll.current?.scrollToEnd({ animated: false });
                else mediaScroll.current?.scrollTo({ x: 0, animated: false });
                setHeroPage(isRTL ? Math.max(0, heroItems.length - 1) : 0);
              }}
              onMomentumScrollEnd={(event) => setHeroPage(Math.round(event.nativeEvent.contentOffset.x / windowWidth))}
            >
              {heroItems.map((item) => (
                <RNPressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={t('diaryOpenPhoto')}
                  onPress={() => (item.lib ? openMedia(item.lib) : setSharedOpen(item.shared ?? null))}
                  style={{ width: windowWidth, height: heroHeight }}
                >
                  {item.lib ? (
                    <Thumb entry={item.lib} style={{ width: windowWidth, height: heroHeight }} />
                  ) : (
                    <SharedThumb path={item.shared ?? ''} size="preview" style={{ width: windowWidth, height: heroHeight, borderRadius: 0 }} />
                  )}
                  {item.lib && item.lib.item.type === 'video' ? (
                    <RNView pointerEvents="none" style={styles.videoBadge}>
                      <RNView style={styles.playCircle}>
                        <Feather name="play" size={26} color="#fff" />
                      </RNView>
                    </RNView>
                  ) : null}
                </RNPressable>
              ))}
            </ScrollView>
          ) : (
            <RNView style={styles.heroEmpty}>
              {heroMessage === 'loading' ? (
                <ActivityIndicator color={colors.primary} />
              ) : heroMessage ? (
                <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: 'center', paddingHorizontal: 32 }}>{heroMessage}</Text>
              ) : (
                <Feather name="book-open" size={40} color={colors.mutedForeground} />
              )}
            </RNView>
          )}
          {heroItems.length > 1 ? (
            <RNView pointerEvents="none" style={styles.dots}>
              {heroItems.map((item, index) => (
                <RNView key={item.key} style={[styles.dot, { width: index === heroPage ? 18 : 7, backgroundColor: index === heroPage ? '#FFFFFF' : 'rgba(255,255,255,0.6)' }]} />
              ))}
            </RNView>
          ) : null}
        </RNView>

        {/* Sheet: rounded white page that overlaps the hero. */}
        <RNView style={[styles.sheet, { backgroundColor: colors.card, minHeight: Math.max(320, windowHeight - heroHeight + 34 - barHeight) }]}>
          <RNView style={[styles.handle, { backgroundColor: colors.border }]} />

          <RNView style={[styles.row, { flexDirection: rowOf(isRTL), gap: 10 }]}>
            {entry.mood ? (
              <Text accessibilityLabel={mood ? t(mood.name) : undefined} style={{ fontSize: 32, lineHeight: 42 }}>{entry.mood}</Text>
            ) : null}
            <Text selectable style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 26, lineHeight: language === 'fa' ? 40 : 34, textAlign: align }}>
              {entry.title}
            </Text>
          </RNView>

          <RNView style={[styles.row, styles.meta, { flexDirection: rowOf(isRTL) }]}>
            <RNView style={[styles.row, { flexDirection: rowOf(isRTL), gap: 8, flexShrink: 1 }]}>
              {mine ? (
                <Avatar b64={me.avatarB64} uri={me.avatarUri} name={authorName} size={26} />
              ) : (
                <Avatar b64={partner?.avatarB64} photo={partner?.avatarPhoto} name={authorName} size={26} />
              )}
              <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13.5 }}>
                {t('diaryBy').replace('{name}', authorName)}
              </Text>
            </RNView>
            <RNView style={[styles.row, { flexDirection: rowOf(isRTL), gap: 8 }]}>
              <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 14 }}>
                {formatDate(entry.createdAt, calendarMode, language, digits)}
              </Text>
              <RNView style={[styles.chip, { backgroundColor: withAlpha(colors.primary, 0.12) }]}>
                <Text numberOfLines={1} style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 13 }}>{categoryLabel}</Text>
              </RNView>
            </RNView>
          </RNView>

          {entry.body ? (
            <Text selectable style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 16, lineHeight: language === 'fa' ? 30 : 25, textAlign: align }}>
              {entry.body}
            </Text>
          ) : null}

          {/* Replies: a thread under the memory; both partners can write. */}
          <RNView style={{ gap: 14, marginTop: 8 }}>
            <RNView style={[styles.row, { flexDirection: rowOf(isRTL), gap: 12 }]}>
              <RNView style={[styles.heartCircle, { backgroundColor: withAlpha(colors.primary, 0.14) }]}>
                <Ionicons name="heart" size={20} color={colors.primary} />
              </RNView>
              <Text accessibilityRole="header" style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 20, textAlign: align }}>
                {t('diaryRepliesTitle')}
              </Text>
              {replies.length > 0 ? (
                <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 14 }}>{toDigits(replies.length, digits)}</Text>
              ) : null}
            </RNView>

            {replies.length === 0 ? (
              mine && !answeredByPartner && paired ? (
                <RNView style={styles.waiting}>
                  <Ionicons name="hourglass-outline" size={30} color={colors.mutedForeground} />
                  <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 14.5, textAlign: 'center' }}>
                    {t('diaryReplyWaiting').replace('{name}', partnerName)}
                  </Text>
                </RNView>
              ) : !mine ? (
                <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 14.5, textAlign: align }}>{t('diaryReplyFirst')}</Text>
              ) : null
            ) : (
              replies.map((reply) => (
                <RNView key={reply.id} style={[styles.replyCard, { borderColor: withAlpha(colors.primary, 0.18), backgroundColor: colors.card, shadowColor: colors.primary }]}>
                  <Text selectable style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 16, lineHeight: language === 'fa' ? 28 : 23, textAlign: align }}>{reply.body}</Text>
                  <RNView style={[styles.row, { flexDirection: rowOf(isRTL), gap: 8 }]}>
                    <Text numberOfLines={1} style={{ flex: 1, color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12.5, textAlign: align }}>
                      {`${reply.fromMe ? (me.name || t('diaryYou')) : partnerName} · ${formatDate(reply.createdAt, calendarMode, language, digits)}`}
                    </Text>
                    {reply.fromMe ? (
                      <RNPressable accessibilityRole="button" accessibilityLabel={t('diaryReplyDelete')} hitSlop={10} onPress={() => confirmDeleteReply(reply)}>
                        <Feather name="trash-2" size={16} color={colors.mutedForeground} />
                      </RNPressable>
                    ) : null}
                  </RNView>
                </RNView>
              ))
            )}

            <RNView style={[styles.composer, { flexDirection: rowOf(isRTL) }]}>
              <TextInput
                accessibilityLabel={t('diaryReplyPlaceholder')}
                value={replyText}
                onChangeText={setReplyText}
                placeholder={t('diaryReplyPlaceholder')}
                placeholderTextColor={colors.mutedForeground}
                multiline
                maxLength={DIARY_REPLY_MAX}
                onFocus={() => setTimeout(() => pageScroll.current?.scrollToEnd({ animated: true }), 300)}
                style={[styles.replyInput, { backgroundColor: colors.input, color: colors.foreground, fontFamily: fontFamilyFor(language), textAlign: align }]}
              />
              <RNPressable
                accessibilityRole="button"
                accessibilityLabel={t('diaryReplySend')}
                disabled={!replyText.trim() || replyBusy}
                onPress={() => void submitReply()}
                style={[styles.sendButton, { backgroundColor: colors.primary, opacity: !replyText.trim() || replyBusy ? 0.4 : 1 }]}
              >
                {replyBusy ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : (
                  <Feather name="send" size={18} color={colors.primaryForeground} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
                )}
              </RNPressable>
            </RNView>
          </RNView>

          {error ? (
            <Text accessibilityRole="alert" style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), textAlign: align }}>
              {t(error)}
            </Text>
          ) : null}
          {action === 'deleting' ? <ActivityIndicator color={colors.destructive} /> : null}
        </RNView>
      </ScrollView>

      {/* Floating buttons over the hero. */}
      <RNPressable
        accessibilityRole="button"
        accessibilityLabel={t('back')}
        hitSlop={8}
        onPress={() => router.back()}
        style={[styles.roundButton, { top: insets.top + 8, start: 14 }]}
      >
        <Feather name={isRTL ? 'chevron-right' : 'chevron-left'} size={24} color="#FFFFFF" />
      </RNPressable>
      <RNPressable
        accessibilityRole="button"
        accessibilityLabel={t('diaryMenu')}
        hitSlop={8}
        onPress={() => setMenuOpen((open) => !open)}
        style={[styles.roundButton, { top: insets.top + 8, end: 14 }]}
      >
        <Feather name="more-vertical" size={22} color="#FFFFFF" />
      </RNPressable>
      {menuOpen ? (
        <>
          <RNPressable accessibilityLabel={t('cancel')} onPress={() => setMenuOpen(false)} style={StyleSheet.absoluteFill} />
          <RNView style={[styles.menu, { top: insets.top + 58, end: 14, backgroundColor: colors.card, shadowColor: '#000000' }]}>
            {menuItems.map((item) => (
              <RNPressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                disabled={busy}
                onPress={() => { setMenuOpen(false); item.onPress(); }}
                style={({ pressed }) => [styles.menuItem, { flexDirection: rowOf(isRTL), opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
              >
                <Feather name={item.icon} size={18} color={item.destructive ? colors.destructive : colors.foreground} />
                <Text numberOfLines={1} style={{ color: item.destructive ? colors.destructive : colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14.5 }}>{item.label}</Text>
              </RNPressable>
            ))}
          </RNView>
        </>
      ) : null}

      {/* Bottom bar: Share / Edit (my memories) / Save. */}
      {keyboardHeight === 0 ? (
        <RNView style={[styles.bar, { height: barHeight, paddingBottom: insets.bottom + 6, backgroundColor: colors.card, flexDirection: rowOf(isRTL) }]}>
          {barItems.map((item) => (
            <RNPressable
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={item.a11y}
              disabled={busy}
              onPress={item.onPress}
              style={({ pressed }) => [styles.barItem, { opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
            >
              {item.busy ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name={item.icon} size={22} color={item.key === 'save' && entry.saved ? colors.primary : colors.foreground} />}
              <Text numberOfLines={1} style={{ color: item.key === 'save' && entry.saved ? colors.primary : colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 12.5 }}>{item.label}</Text>
            </RNPressable>
          ))}
        </RNView>
      ) : null}

      <SharedViewer path={sharedOpen} onClose={() => setSharedOpen(null)} />
      <MediaSourceSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        onSelect={(source) => { if (source !== 'files') void addMedia(source); }}
        title={t('diaryAddPhotos')}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  loading: { minHeight: 260, alignItems: 'center', justifyContent: 'center' },
  heroEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  videoBadge: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' },
  playCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  dots: { position: 'absolute', bottom: 46, left: 0, right: 0, direction: 'ltr', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  dot: { height: 7, borderRadius: 4 },
  sheet: {
    marginTop: -34,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 24,
    gap: 16,
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 6,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, marginBottom: 6 },
  row: { alignItems: 'center' },
  meta: { flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, maxWidth: 160 },
  heartCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  waiting: { alignItems: 'center', gap: 8, paddingVertical: 14 },
  replyCard: { borderWidth: 1, borderRadius: 22, padding: 16, gap: 10, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  composer: { alignItems: 'flex-end', gap: 10 },
  replyInput: { flex: 1, minHeight: 46, maxHeight: 130, borderRadius: 23, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, fontSize: 15.5 },
  sendButton: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  roundButton: { position: 'absolute', width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' },
  menu: { position: 'absolute', minWidth: 190, borderRadius: 18, paddingVertical: 6, shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  menuItem: { alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  bar: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  barItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 48 },
});
