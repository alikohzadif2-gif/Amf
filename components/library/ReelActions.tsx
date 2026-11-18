import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from '@/components/ui/ScaledText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { serverIdOf } from '@/src/library/entry-link';
import type { LibraryEntry } from '@/src/library/merge';
import { COMMENT_MAX, loadReactions, type Reactions } from '@/src/library/reactions-db';
import { sendEntryToDirect } from '@/src/library/send-direct';
import { sendComment, sendLike } from '@/src/partner/manage';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

const WHITE = '#fff';
const EMPTY: Reactions = { likedByMe: false, likedByPartner: false, comments: [] };

/**
 * The three buttons under a photo/video in Explore (like Instagram): Like and Comment (both visible to the partner,
 * kept under the file's server id) and Send to Direct. Likes/comments need a file on the server and a paired partner.
 */
export function ReelActions({ entry }: { entry: LibraryEntry }) {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const { t, language, isRTL } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const paired = usePartnerStore((s) => s.paired);
  const reactTick = usePartnerStore((s) => s.reactTick);
  const item = serverIdOf(entry);
  const [data, setData] = useState<Reactions>(EMPTY);
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ text: string; chat?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setData(EMPTY);
    if (item) void loadReactions(db, item).then((r) => { if (alive) setData(r); });
    return () => { alive = false; };
  }, [db, item, reactTick]);

  const say = useCallback((text: string, chat = false) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ text, chat });
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { setSheet(false); setDraft(''); setToast(null); }, [entry.key]);

  const guard = (): string | null => {
    if (!paired) return t('reactNeedPair');
    if (!item) return t('reactNeedServer');
    return null;
  };

  const like = () => {
    const problem = guard();
    if (problem || !item) { say(problem ?? t('reactNeedServer')); return; }
    void sendLike(db, item, !data.likedByMe);
  };
  const openComments = () => {
    const problem = guard();
    if (problem) { say(problem); return; }
    setSheet(true);
  };
  const submitComment = () => {
    if (!item || !draft.trim()) return;
    const text = draft;
    setDraft('');
    void sendComment(db, { item, text });
  };
  const toDirect = async () => {
    if (!paired) { say(t('reactNeedPair')); return; }
    setSending(true);
    const result = await sendEntryToDirect(db, entry).catch(() => 'failed' as const);
    setSending(false);
    if (result === 'sent') say(t('directSent'), true);
    else if (result === 'not-paired') say(t('reactNeedPair'));
    else if (result === 'no-keys') say(t('needSecurePairing'));
    else say(t('directFailed'));
  };

  const font = (w: 'regular' | 'medium' = 'regular') => fontFamilyFor(language, w);
  const likeCount = (data.likedByMe ? 1 : 0) + (data.likedByPartner ? 1 : 0);
  const button = (icon: keyof typeof Feather.glyphMap, label: string, onPress: () => void, opts: { active?: boolean; count?: number; busy?: boolean; badge?: boolean } = {}) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.7 : 1 }]}>
      <View style={[styles.round, { backgroundColor: colors.scrim }]}>
        {opts.busy ? <ActivityIndicator color={WHITE} /> : <Feather name={icon} size={24} color={opts.active ? '#FF4D6D' : WHITE} />}
        {opts.badge ? <View style={[styles.badge, { backgroundColor: '#FF4D6D', borderColor: colors.scrim }]} /> : null}
      </View>
      <Text numberOfLines={1} style={[styles.count, { fontFamily: font('medium') }]}>{opts.count ? toDigits(opts.count, digits) : ' '}</Text>
    </Pressable>
  );

  return (
    <>
      <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 14 }]}>
        {toast ? (
          <Pressable disabled={!toast.chat} onPress={() => router.push('/chat')} style={[styles.toast, { backgroundColor: colors.scrim }]}>
            <Text style={{ color: WHITE, fontFamily: font('medium'), fontSize: 13 }}>{toast.text}</Text>
            {toast.chat ? <Text style={{ color: colors.primary, fontFamily: font('medium'), fontSize: 13 }}>{t('directOpenChat')}</Text> : null}
          </Pressable>
        ) : null}
        <View pointerEvents="box-none" style={[styles.row, { flexDirection: rowOf(isRTL) }]}>
          {button('heart', t(data.likedByMe ? 'viewerUnlike' : 'viewerLike'), like, { active: data.likedByMe, count: likeCount, badge: data.likedByPartner && !data.likedByMe })}
          {button('message-circle', t('viewerComment'), openComments, { count: data.comments.length })}
          {button('send', t('viewerSendDirect'), () => void toDirect(), { busy: sending })}
        </View>
      </View>
      <BottomSheet visible={sheet} onClose={() => setSheet(false)} title={t('commentsTitle')} cancelLabel={t('cancel')}>
        <View style={{ gap: 10 }}>
          {data.likedByPartner ? (
            <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 6 }}>
              <Feather name="heart" size={14} color="#FF4D6D" />
              <Text style={{ color: colors.mutedForeground, fontFamily: font(), fontSize: 13 }}>{t('partnerLikedThis')}</Text>
            </View>
          ) : null}
          {data.comments.length === 0 ? (
            <Text style={{ color: colors.mutedForeground, fontFamily: font(), fontSize: 14, textAlign: 'center', paddingVertical: 14 }}>{t('commentEmpty')}</Text>
          ) : data.comments.map((c) => (
            <View key={c.id} style={{ flexDirection: rowOf(isRTL), alignItems: 'flex-start', gap: 8 }}>
              <View style={[styles.bubble, { backgroundColor: c.fromMe ? colors.primary : colors.card, borderColor: colors.border, borderWidth: c.fromMe ? 0 : 1 }]}>
                <Text selectable style={{ color: c.fromMe ? colors.primaryForeground : colors.foreground, fontFamily: font(), fontSize: 15, lineHeight: language === 'fa' ? 24 : 21, textAlign: isRTL ? 'right' : 'left' }}>{c.body}</Text>
              </View>
              {c.fromMe && item ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t('commentDelete')} hitSlop={8} onPress={() => void sendComment(db, { item, id: c.id, remove: true })}>
                  <Feather name="trash-2" size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
          ))}
          <View style={{ flexDirection: rowOf(isRTL), alignItems: 'flex-end', gap: 8, marginTop: 4 }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t('commentPlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              multiline
              maxLength={COMMENT_MAX}
              style={[styles.input, { backgroundColor: colors.input, color: colors.foreground, fontFamily: font(), textAlign: isRTL ? 'right' : 'left' }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('commentSend')}
              disabled={!draft.trim()}
              onPress={submitComment}
              style={[styles.send, { backgroundColor: draft.trim() ? colors.primary : colors.muted }]}
            >
              <Feather name="send" size={18} color={colors.primaryForeground} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
            </Pressable>
          </View>
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', start: 0, end: 0, alignItems: 'center', gap: 10 },
  row: { justifyContent: 'center', gap: 34 },
  btn: { alignItems: 'center', gap: 3, minWidth: 56 },
  round: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 6, end: 6, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  count: { color: '#fff', fontSize: 12, textShadowColor: '#0008', textShadowRadius: 3 },
  toast: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 16 },
  bubble: { flexShrink: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  input: { flex: 1, maxHeight: 110, minHeight: 42, borderRadius: 21, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 15 },
  send: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
});
