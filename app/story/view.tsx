import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { File } from 'expo-file-system';
import { ActivityIndicator, Alert, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/partner/Avatar';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { TextInput } from '@/components/ui/ScaledText';
import { Toast } from '@/components/ui/Toast';
import { useColors } from '@/hooks/useColors';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { copyIntoLibrary } from '@/src/library/import-from-phone';
import { withAlpha } from '@/constants/colors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { cancelPartnerOriginal, sendChat, sendChatMedia, sendStoryDeleted, sendStorySeen, sharedImage, sharedOriginal, partnerOriginalStatus, requestPartnerOriginal } from '@/src/partner/manage';
import { DownloadBar } from '@/components/diary/DownloadBar';
import type { OriginalOutcome } from '@/src/partner/orig-logic';
import { CHAT_MAX } from '@/src/chat/chat-db';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { deleteStory, listActiveStories, markStoryViewed } from '@/src/stories/stories-db';
import { discardStoryFiles } from '@/src/stories/story-files';
import { STORY_PHOTO_MS, clockText, firstUnseenIndex, indexAfterDelete, storyExportName, storyReplyBody, timeLeft, type StoryRow } from '@/src/stories/story-logic';

type Source = { uri: string; headers?: Record<string, string> };

/** Full-screen story viewer. `who=me` plays my stories, `who=partner` the partner's (opens at the first one not seen yet). */
export default function StoryViewScreen() {
  const { who } = useLocalSearchParams<{ who?: string }>();
  const mine = who !== 'partner';
  const db = useSQLiteContext();
  const router = useRouter();
  const [list, setList] = useState<StoryRow[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    void listActiveStories(db, mine).then((rows) => {
      if (!alive) return;
      if (rows.length === 0) {
        router.back();
        return;
      }
      setIndex(mine ? 0 : firstUnseenIndex(rows));
      setList(rows);
    });
    return () => {
      alive = false;
    };
  }, [db, mine, router]);

  // My story was deleted from the menu: show the next one, or leave when it was the last.
  const removed = (id: string) => {
    if (!list) return;
    const to = indexAfterDelete(list.length, index);
    if (to === null) {
      router.back();
      return;
    }
    setList(list.filter((x) => x.id !== id));
    setIndex(to);
  };

  if (!list) return <View style={styles.root} />;
  const story = list[Math.min(index, list.length - 1)];
  const next = () => (index + 1 >= list.length ? router.back() : setIndex(index + 1));
  const previous = () => setIndex(Math.max(0, index - 1));
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <StoryPage key={story.id} story={story} mine={mine} index={index} count={list.length} onNext={next} onPrevious={previous} onClose={() => router.back()} onRemoved={removed} />
    </View>
  );
}

const STORY_REASON: Partial<Record<OriginalOutcome, TranslationKey>> = {
  offline: 'origOffline',
  missing: 'origMissing',
  'too-big': 'origTooBig',
  space: 'origSpace',
  cache: 'origCache',
  hash: 'origHash',
  'no-keys': 'origNoKeys',
};

function VideoStage({ source, paused, onProgress, onEnd }: { source: Source; paused: boolean; onProgress: (p: number) => void; onEnd: () => void }) {
  const player = useVideoPlayer({ uri: source.uri, headers: source.headers } as VideoSource, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
    p.play();
  });
  useEffect(() => {
    const time = player.addListener('timeUpdate', ({ currentTime }) => {
      if (player.duration > 0) onProgress(Math.min(1, currentTime / player.duration));
    });
    const end = player.addListener('playToEnd', onEnd);
    return () => {
      time.remove();
      end.remove();
    };
  }, [player]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (paused) player.pause();
    else player.play();
  }, [paused, player]);
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />;
}

function StoryPage({ story, mine, index, count, onNext, onPrevious, onClose, onRemoved }: { story: StoryRow; mine: boolean; index: number; count: number; onNext: () => void; onPrevious: () => void; onClose: () => void; onRemoved: (id: string) => void }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const partner = usePartnerStore((s) => s.partner);
  const me = usePartnerStore((s) => s.me);
  const [source, setSource] = useState<Source | null>(null);
  const [failed, setFailed] = useState(false);
  const [download, setDownload] = useState<number | null>(null); // percent of the partner's video coming over the encrypted path
  const [retry, setRetry] = useState(0);
  const [reason, setReason] = useState<OriginalOutcome | null>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [reply, setReply] = useState('');
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const keyboardHeight = useKeyboardHeight();
  const halted = paused || menuOpen || typing; // the story waits while the menu is open or a reply is being typed
  const elapsed = useRef(0);
  const font = (weight: 'medium' | 'semibold' | 'bold' = 'medium') => fontFamilyFor(language, weight);

  // The picture / video: my own is a file on this phone. The partner's photo is the encrypted preview; the partner's video is
  // pulled from their phone over the encrypted queue (a progress bar shows how much arrived), cached, then played from the file.
  // A story that an older version uploaded to the server still streams from there.
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setReason(null);
    const load = async (): Promise<{ uri: string; headers?: Record<string, string> } | null> => {
      if (mine) return { uri: story.mediaUri };
      if (story.type !== 'video') return sharedImage(story.mediaUri, 'preview');
      if ((await partnerOriginalStatus(story.mediaUri)) !== 'cached') {
        const legacy = await sharedOriginal(story.mediaUri);
        if (legacy) return legacy;
        setDownload(0);
        const outcome = await requestPartnerOriginal(story.mediaUri, (done, total) => alive && setDownload(Math.round((done / total) * 100)));
        if (alive) setDownload(null);
        if (outcome !== 'ok') {
          if (alive) setReason(outcome);
          return null;
        }
      }
      return sharedImage(story.mediaUri, 'original');
    };
    void load().then((ref) => {
      if (!alive) return;
      if (ref) setSource({ uri: ref.uri, headers: ref.headers });
      else setFailed(true);
    });
    return () => {
      alive = false;
      if (!mine && story.type === 'video') cancelPartnerOriginal(story.mediaUri); // leaving the story pauses the download (what arrived is kept)
    };
  }, [story.id, story.mediaUri, story.type, mine, retry]);

  // First time the partner's story is on screen: remember when, and tell them.
  useEffect(() => {
    if (mine || !source || story.viewedAt) return;
    void markStoryViewed(db, story.id, new Date().toISOString()).then(() => usePartnerStore.getState().bumpStories());
    void sendStorySeen(story.id);
  }, [mine, source, story.id, story.viewedAt, db]);

  // Photos advance by a timer (paused while the finger holds the screen); videos report their own progress.
  useEffect(() => {
    if (story.type !== 'photo' || !source) return;
    const timer = setInterval(() => {
      if (halted) return;
      elapsed.current += 50;
      setProgress(Math.min(1, elapsed.current / STORY_PHOTO_MS));
      if (elapsed.current >= STORY_PHOTO_MS) {
        clearInterval(timer);
        onNext();
      }
    }, 50);
    return () => clearInterval(timer);
  }, [story.type, source, halted]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = (text: string) => setToast({ text, id: Date.now() });

  // A tap while the reply box is open only closes the keyboard (the story stays), so the person does not lose their place.
  const guarded = (go: () => void) => () => {
    if (typing || keyboardHeight > 0) {
      Keyboard.dismiss();
      return;
    }
    go();
  };

  // Reply to the partner's story: it is sent as a normal direct-chat message (stored first, retry lives in the chat).
  const sendReply = async () => {
    const body = storyReplyBody(t('storyReplyPrefix'), reply, CHAT_MAX);
    if (!body || sending) return;
    setSending(true);
    try {
      // the partner's story is a shared file (`Shared/...`): the chat shows it with the reply text under it
      const result = story.mediaUri.startsWith('Shared/')
        ? await sendChatMedia(db, { media: story.mediaUri, mediaType: story.type, text: body })
        : await sendChat(db, body);
      setReply('');
      Keyboard.dismiss();
      say(result === 'sent' ? t('storyReplySent') : t('storyReplyFailed'));
    } catch {
      say(t('storyReplyFailed'));
    } finally {
      setSending(false);
    }
  };

  // Menu: save a copy to the Library (folder "Stories").
  const save = async () => {
    setMenuOpen(false);
    try {
      const file = new File(story.mediaUri);
      const res = await copyIntoLibrary([{ uri: story.mediaUri, name: storyExportName(story), size: file.exists ? file.size : 0 }], 'Stories');
      say(res.added > 0 ? t('storySaved') : t('storySaveFailed'));
    } catch {
      say(t('storySaveFailed'));
    }
  };

  // Menu: delete (after a confirmation): removes the row and file here and tells the partner's phone.
  const askDelete = () => {
    setMenuOpen(false);
    Alert.alert(t('storyDeleteTitle'), t('storyDeleteBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('storyDelete'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deleteStory(db, story.id);
              discardStoryFiles([story.mediaUri]);
              void sendStoryDeleted(story.id, story.type);
              usePartnerStore.getState().bumpStories();
              onRemoved(story.id);
            } catch {
              say(t('storyDeleteFailed'));
            }
          })();
        },
      },
    ]);
  };

  const left = timeLeft(story.expiresAt, Date.now());
  const leftText = t(left.unit === 'hours' ? 'storyEndsInHours' : 'storyEndsInMinutes').replace('{n}', toDigits(left.n, digits));
  const name = mine ? t('storyYours') : partner?.name || t('partnerDefaultName');
  const seenText = story.viewedAt ? t('storySeenAt').replace('{time}', toDigits(clockText(story.viewedAt), digits)) : t('storyNotSeen');
  const hold = { onLongPress: () => setPaused(true), onPressOut: () => setPaused(false), delayLongPress: 180 } as const;

  return (
    <View style={StyleSheet.absoluteFill}>
      {source && story.type === 'video' ? <VideoStage source={source} paused={halted} onProgress={setProgress} onEnd={onNext} /> : null}
      {source && story.type === 'photo' ? <Image source={{ uri: source.uri, headers: source.headers }} style={StyleSheet.absoluteFill} contentFit="cover" onError={() => setFailed(true)} /> : null}
      {!source && !failed && download === null ? <ActivityIndicator color="#FFFFFF" style={StyleSheet.absoluteFill} /> : null}
      {!source && !failed && download !== null ? (
        <View style={[StyleSheet.absoluteFill, styles.center, { paddingHorizontal: 40 }]}>
          <DownloadBar percent={download} label={t('origLoading')} font={font()} />
        </View>
      ) : null}
      {failed ? (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Feather name="image" size={34} color={withAlpha('#FFFFFF', 0.7)} />
          <Text style={[styles.failText, { fontFamily: font() }]}>{t(reason ? STORY_REASON[reason] ?? 'storyLoadFailed' : 'storyLoadFailed')}</Text>
          {reason ? (
            <Pressable accessibilityRole="button" onPress={() => setRetry((n) => n + 1)} style={styles.retry}>
              <Text style={[styles.failText, { fontFamily: font('semibold') }]}>{t('origRetry')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.10)' }]} />

      {story.overlayText ? (
        <View pointerEvents="none" style={[styles.overlayWrap, { top: `${story.overlayY * 100}%` }]}>
          <Text style={[styles.overlayText, { fontFamily: font('bold') }]}>{story.overlayText}</Text>
        </View>
      ) : null}

      {/* Tap areas: the left third goes back, the rest goes forward; holding pauses. */}
      <View style={[StyleSheet.absoluteFill, { flexDirection: 'row' }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('storyPrevious')} style={{ flex: 1 }} onPress={guarded(onPrevious)} {...hold} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('storyNext')} style={{ flex: 2 }} onPress={guarded(onNext)} {...hold} />
      </View>

      <View pointerEvents="box-none" style={[styles.header, { top: insets.top + 8, direction: isRTL ? 'rtl' : 'ltr' }]}>
        <View style={styles.bars}>
          {Array.from({ length: count }, (_, i) => (
            <View key={i} style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${(i < index ? 1 : i === index ? progress : 0) * 100}%` }]} />
            </View>
          ))}
        </View>
        <View style={styles.headRow}>
          <Avatar b64={mine ? me.avatarB64 : partner?.avatarB64} photo={mine ? undefined : partner?.avatarPhoto} uri={mine ? me.avatarUri : undefined} name={mine ? me.name : partner?.name} size={36} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.headName, { fontFamily: font('semibold') }]}>{name}</Text>
            <Text numberOfLines={1} style={[styles.headSub, { fontFamily: font() }]}>{`${toDigits(clockText(story.createdAt), digits)} · ${leftText}`}</Text>
          </View>
          {mine ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('storyMore')} hitSlop={10} onPress={() => setMenuOpen(true)} style={styles.close}>
              <Feather name="more-vertical" size={22} color="#FFFFFF" />
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={t('storyClose')} hitSlop={10} onPress={onClose} style={styles.close}>
            <Feather name="x" size={22} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>

      <View pointerEvents="none" style={[styles.footer, { bottom: mine ? 0 : keyboardHeight, paddingBottom: mine ? insets.bottom + 16 : Math.max(insets.bottom + 24, 44) + 68, direction: isRTL ? 'rtl' : 'ltr' }]}>
        {story.caption ? <Text style={[styles.caption, { fontFamily: font() }]}>{story.caption}</Text> : null}
        {mine ? (
          <View style={styles.seenRow}>
            <Feather name="eye" size={15} color="#FFFFFF" />
            <Text style={[styles.seenText, { fontFamily: font('semibold') }]}>{seenText}</Text>
          </View>
        ) : null}
      </View>

      {!mine ? (
        <View style={[styles.replyBar, { bottom: keyboardHeight, paddingBottom: keyboardHeight > 0 ? 10 : Math.max(insets.bottom + 24, 44), flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
          <TextInput
            accessibilityLabel={t('storyReplyPlaceholder').replace('{name}', name)}
            value={reply}
            onChangeText={setReply}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            placeholder={t('storyReplyPlaceholder').replace('{name}', name)}
            placeholderTextColor="rgba(255,255,255,0.7)"
            maxLength={CHAT_MAX - 60}
            multiline
            style={[styles.replyInput, { fontFamily: font(), textAlign: isRTL ? 'right' : 'left' }]}
          />
          {reply.trim().length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('storyReplySend')}
              disabled={sending}
              onPress={() => void sendReply()}
              style={[styles.replySend, { backgroundColor: colors.primary, opacity: sending ? 0.6 : 1 }]}
            >
              <Feather name="send" size={19} color={colors.primaryForeground} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Toast message={toast} />
      {mine ? (
        <BottomSheet visible={menuOpen} onClose={() => setMenuOpen(false)} title={t('storyMenuTitle')} cancelLabel={t('cancel')}>
          {([
            { icon: 'download', label: t('storySave'), color: colors.foreground, go: () => void save() },
            { icon: 'trash-2', label: t('storyDelete'), color: colors.destructive, go: askDelete },
          ] as const).map((row) => (
            <Pressable
              key={row.icon}
              accessibilityRole="button"
              onPress={row.go}
              style={{ flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border }}
            >
              <Feather name={row.icon} size={20} color={row.color} />
              <Text style={{ color: row.color, fontFamily: font('medium'), fontSize: 16 }}>{row.label}</Text>
            </Pressable>
          ))}
        </BottomSheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
  retry: { marginTop: 6, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)' },
  failText: { color: 'rgba(255,255,255,0.8)', fontSize: 14 },
  header: { position: 'absolute', left: 10, right: 10, gap: 10 },
  bars: { flexDirection: 'row', gap: 4 },
  barTrack: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
  barFill: { height: 3, backgroundColor: '#FFFFFF' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headName: { color: '#FFFFFF', fontSize: 15, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  headSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  close: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center' },
  overlayWrap: { position: 'absolute', left: 20, right: 20, alignItems: 'center', transform: [{ translateY: -24 }] },
  overlayText: { color: '#FFFFFF', fontSize: 28, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
  footer: { position: 'absolute', left: 0, right: 0, paddingHorizontal: 18, gap: 10, alignItems: 'center' },
  caption: { color: '#FFFFFF', fontSize: 16, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 5 },
  replyBar: { position: 'absolute', left: 0, right: 0, alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  replyInput: { flex: 1, maxHeight: 110, minHeight: 44, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontSize: 15, color: '#FFFFFF', backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.55)' },
  replySend: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  seenRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.42)', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  seenText: { color: '#FFFFFF', fontSize: 12.5 },
});
