import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, FlatList, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from '@/components/ui/ScaledText';
import { Avatar } from '@/components/partner/Avatar';
import { ScreenFrame } from '@/components/ScreenFrame';
import { CircleBackButton } from '@/components/ui/BackButton';
import { EmptyState } from '@/components/ui';
import { SharedViewer } from '@/components/diary/SharedThumb';
import { useColors } from '@/hooks/useColors';
import { mediaBox } from '@/src/chat/media-box';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { usePullRefresh } from '@/hooks/usePullRefresh';
import { refreshApp } from '@/src/partner/refresh';
import { withAlpha } from '@/constants/colors';
import { CHAT_MAX, listChat, type ChatRow } from '@/src/chat/chat-db';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate, toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { findEntry } from '@/src/library/entry-link';
import { useLibraryIndex } from '@/src/library/index-store';
import { useViewerStore } from '@/src/library/viewer-store';
import { markChatSeen, retryChat, sendChat, serverItemRef, setChatScreenOpen, sharedImage } from '@/src/partner/manage';
import type { ImageRef } from '@/src/storage/types';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

/** A day heading between messages, or one message. The list is shown newest-first (inverted). */
type Item = { kind: 'day'; key: string; iso: string } | { kind: 'msg'; key: string; row: ChatRow };

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function withDays(rows: ChatRow[]): Item[] {
  const items: Item[] = [];
  let last = '';
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    if (key !== last) {
      items.push({ kind: 'day', key: `d-${key}`, iso: row.createdAt });
      last = key;
    }
    items.push({ kind: 'msg', key: row.id, row });
  }
  return items.reverse();
}

/**
 * A photo/video in the chat (sent from the viewer or as a story reply): its thumbnail in the original proportions, with no
 * coloured frame around it. A tap opens it full screen in the viewer.
 */
function ChatMedia({ row, onOpen }: { row: ChatRow; onOpen: () => void }) {
  const colors = useColors();
  const { width: screenWidth } = useWindowDimensions();
  const [ref, setRef] = useState<ImageRef | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setRef(null);
    setRatio(null);
    const job = row.item ? serverItemRef(row.item, 'thumb', 512) : row.media ? sharedImage(row.media, 'thumb') : Promise.resolve(null);
    void job.then((r) => { if (alive) setRef(r); }).catch(() => undefined);
    return () => { alive = false; };
  }, [row.item, row.media]);
  const { width, height } = mediaBox(ratio, screenWidth);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      onPress={onOpen}
      style={[styles.media, { width, height }, ratio === null ? { backgroundColor: colors.muted } : null]}
    >
      {ref ? (
        <Image
          source={ref.headers ? { uri: ref.uri, headers: ref.headers } : { uri: ref.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={120}
          onLoad={(event) => {
            const { width: w, height: h } = event.source;
            if (w > 0 && h > 0) setRatio(w / h);
          }}
        />
      ) : (
        <Feather name={row.mediaType === 'video' ? 'video' : 'image'} size={26} color={colors.mutedForeground} />
      )}
      {row.mediaType === 'video' ? <View style={styles.mediaPlay}><Feather name="play" size={16} color="#fff" /></View> : null}
    </Pressable>
  );
}

export default function ChatScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, language, isRTL } = useI18n();
  const { calendarMode, digits } = useSettingsStore();
  const paired = usePartnerStore((s) => s.paired);
  const partner = usePartnerStore((s) => s.partner);
  const chatTick = usePartnerStore((s) => s.chatTick);
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<'chatRetryFailed' | null>(null);
  const [sharedOpen, setSharedOpen] = useState<string | null>(null); // the partner's shared photo/video (encrypted path) in the viewer
  const keyboardHeight = useKeyboardHeight();
  const pull = usePullRefresh(refreshApp);
  const partnerName = partner?.name || t('partnerDefaultName');

  const load = useCallback(async () => {
    try {
      setRows(await listChat(db));
    } finally {
      setLoaded(true);
    }
  }, [db]);

  // Reload when a message arrives (chatTick) or my own send changes state.
  useEffect(() => {
    void load();
  }, [load, chatTick]);

  // While this screen is open a new text must not also pop up as a notification.
  useEffect(() => {
    setChatScreenOpen(true);
    return () => setChatScreenOpen(false);
  }, []);

  // Opening the chat (or a text arriving while it is open and the app is in front) = read: the Home badge goes away and the
  // partner gets "Seen" under their last text.
  useEffect(() => {
    if (!paired) return;
    const run = () => {
      if (AppState.currentState === 'active') void markChatSeen(db);
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => sub.remove();
  }, [db, paired, chatTick]);

  const items = useMemo(() => withDays(rows), [rows]);
  // "Seen" is shown once, under my newest text, when the partner has read it (like Instagram).
  const seenId = useMemo(() => {
    const lastMine = [...rows].reverse().find((r) => r.fromMe);
    return lastMine && lastMine.seen && !lastMine.failed ? lastMine.id : null;
  }, [rows]);
  const canSend = paired && draft.trim().length > 0;
  const font = (weight: 'regular' | 'medium' | 'semibold' = 'regular') => fontFamilyFor(language, weight);
  const lineHeight = language === 'fa' ? 26 : 22;

  const openMedia = async (row: ChatRow) => {
    // The partner's photo/video sent from their phone (no library entry here): the shared viewer, with "Full quality" / "Download video".
    if (!row.fromMe && !row.item && row.media) {
      setSharedOpen(row.media);
      return;
    }
    if (useLibraryIndex.getState().entries.length === 0) await useLibraryIndex.getState().build().catch(() => undefined);
    const entry = findEntry({ item: row.item, media: row.media });
    if (!entry) return;
    useViewerStore.getState().open([entry], 0);
    router.push('/viewer' as never);
  };

  const submit = () => {
    const body = draft.trim();
    if (!canSend || !body) return;
    setDraft('');
    setNote(null);
    void sendChat(db, body).catch(() => undefined); // a failed send is stored as `failed` and shown with a retry
  };

  const retry = (id: string) => {
    setNote(null);
    void retryChat(db, id)
      .then((result) => {
        if (result !== 'sent') setNote('chatRetryFailed');
      })
      .catch(() => setNote('chatRetryFailed'));
  };

  const timeOf = (iso: string) => {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return toDigits(`${hh}:${mm}`, digits);
  };

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === 'day') {
      return (
        <View style={styles.dayWrap}>
          <Text style={{ color: colors.mutedForeground, fontFamily: font('medium'), fontSize: 12.5 }}>
            {formatDate(item.iso, calendarMode, language, digits)}
          </Text>
        </View>
      );
    }
    const { row } = item;
    // Mine always sits on the right edge, the partner's on the left (like every messenger), also in Persian.
    const mineSide = isRTL ? 'flex-start' : 'flex-end';
    const theirSide = isRTL ? 'flex-end' : 'flex-start';
    return (
      <View style={{ alignSelf: row.fromMe ? mineSide : theirSide, maxWidth: '82%', marginVertical: 3 }}>
        {row.item || row.media ? (
          <View style={{ alignSelf: row.fromMe ? mineSide : theirSide, marginBottom: row.body ? 4 : 0, opacity: row.failed ? 0.75 : 1 }}>
            <ChatMedia row={row} onOpen={() => void openMedia(row)} />
          </View>
        ) : null}
        {row.body ? (
          <Pressable
            disabled={!row.failed}
            accessibilityRole={row.failed ? 'button' : undefined}
            accessibilityLabel={row.failed ? t('chatNotSent') : undefined}
            onPress={() => retry(row.id)}
            style={[
              styles.bubble,
              { alignSelf: row.fromMe ? mineSide : theirSide },
              row.fromMe
                ? { backgroundColor: colors.primary, borderBottomRightRadius: 6 }
                : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderBottomLeftRadius: 6 },
              row.failed ? { opacity: 0.75 } : null,
            ]}
          >
            <Text
              selectable
              style={{
                color: row.fromMe ? colors.primaryForeground : colors.foreground,
                fontFamily: font(),
                fontSize: 16,
                lineHeight,
                textAlign: isRTL ? 'right' : 'left',
              }}
            >
              {row.body}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          disabled={!row.failed}
          accessibilityRole={row.failed ? 'button' : undefined}
          accessibilityLabel={row.failed ? t('chatNotSent') : undefined}
          onPress={() => retry(row.id)}
          style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 4, alignSelf: row.fromMe ? mineSide : theirSide, marginTop: 2, paddingHorizontal: 4 }}
        >
          {row.failed ? <Feather name="alert-circle" size={13} color={colors.destructive} /> : null}
          <Text style={{ color: row.failed ? colors.destructive : colors.mutedForeground, fontFamily: font(), fontSize: 11.5 }}>
            {row.failed ? t('chatNotSent') : timeOf(row.createdAt)}
          </Text>
          {row.id === seenId ? (
            <Text accessibilityLabel={t('chatSeen')} style={{ color: colors.mutedForeground, fontFamily: font('medium'), fontSize: 11.5 }}>
              {`· ${t('chatSeen')}`}
            </Text>
          ) : null}
        </Pressable>
      </View>
    );
  };

  return (
    <ScreenFrame contentStyle={{ paddingBottom: 0, paddingHorizontal: 0 }}>
      <SharedViewer path={sharedOpen} onClose={() => setSharedOpen(null)} />
      <View style={{ flex: 1, paddingBottom: keyboardHeight }}>
        <View style={[styles.header, { flexDirection: rowOf(isRTL), borderBottomColor: colors.border }]}>
          <CircleBackButton />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chatOpenProfile')}
            onPress={() => router.push('/settings/partner-profile')}
            style={{ flex: 1, flexDirection: rowOf(isRTL), alignItems: 'center', gap: 10 }}
          >
            <Avatar b64={partner?.avatarB64} photo={partner?.avatarPhoto} name={partner?.name} size={40} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontFamily: font('semibold'), fontSize: 17, textAlign: isRTL ? 'right' : 'left' }}>
              {partnerName}
            </Text>
          </Pressable>
        </View>

        {!paired ? (
          <EmptyState message={t('chatNotPaired')} actionLabel={t('pairPartner')} actionIcon="user-plus" onAction={() => router.push('/settings/pair')} />
        ) : loaded && items.length === 0 ? (
          <EmptyState message={`${t('chatEmptyTitle')}\n${t('chatEmptyBody').replace('{name}', partnerName)}`} />
        ) : (
          <FlatList
            inverted
            refreshControl={pull.control}
            data={items}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
            style={{ flex: 1 }}
          />
        )}

        {note ? (
          <Text accessibilityRole="alert" style={{ color: colors.destructive, fontFamily: font(), fontSize: 13, textAlign: 'center', paddingBottom: 6 }}>
            {t(note)}
          </Text>
        ) : null}

        {paired ? (
          <View style={[styles.composer, { flexDirection: rowOf(isRTL), borderTopColor: colors.border, paddingBottom: keyboardHeight > 0 ? 8 : insets.bottom + 8 }]}>
            <TextInput
              accessibilityLabel={t('chatPlaceholder')}
              value={draft}
              onChangeText={setDraft}
              placeholder={t('chatPlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              multiline
              maxLength={CHAT_MAX}
              style={[styles.input, { backgroundColor: colors.input, color: colors.foreground, fontFamily: font(), textAlign: isRTL ? 'right' : 'left' }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chatSend')}
              disabled={!canSend}
              onPress={submit}
              style={[styles.send, { backgroundColor: canSend ? colors.primary : withAlpha(colors.primary, 0.4) }]}
            >
              <Feather name="send" size={19} color={colors.primaryForeground} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  dayWrap: { alignItems: 'center', marginVertical: 10 },
  bubble: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
  media: { borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  mediaPlay: { position: 'absolute', bottom: 8, start: 8, backgroundColor: '#000A', borderRadius: 14, padding: 6 },
  composer: { alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, maxHeight: 120, minHeight: 44, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
