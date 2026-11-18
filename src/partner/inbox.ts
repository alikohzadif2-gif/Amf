import type { SQLiteDatabase } from 'expo-sqlite';
import { decodeMessage } from './messages';
import { clearMoodLocal, insertMood } from './mood-db';
import type { GalleryMessage, SyncMessage, OrigMessage, MediaMessage, ChatMessage, ChatSeenMessage, CommentMessage, LikeMessage, DiaryMessage, EventMessage, MoodMessage, PartnerMessage, PeriodMessage, Profile, StoryMessage, StorySeenMessage } from './types';

export type PartnerRawMessage = { id: string; message?: string };
export type InboxDeps = {
  db: Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
  deviceId: string;
  setPartner: (p: Profile) => void;
  /** R2: the partner's `togetherSince` (UTC ISO). Applied only when it differs from ours; never sent back by the caller. */
  setTogetherSince?: (iso: string) => void;
  /** The partner removed the pairing: clean up locally (do NOT publish anything back). Return `false` when the message is stale (the pairing is still valid): nothing is cleared and no notice is shown. */
  onUnpaired: () => void | boolean | Promise<void | boolean>;
  /** Answer a `hello` with our own profile. */
  replyProfile: () => void | Promise<void>;
  /** The partner's colour for one of their custom moods (kept so the Home card matches theirs). */
  setMoodPreset?: (emoji: string, preset: number) => void;
  prefs: () => { mood: boolean; event: boolean; diary: boolean; period: boolean };
  /** Show a local notification. */
  notify: (n: { kind: 'mood'; msg: MoodMessage } | { kind: 'event'; msg: EventMessage } | { kind: 'diary'; msg: DiaryMessage; updated: boolean } | { kind: 'period'; msg: PeriodMessage } | { kind: 'chat'; msg: ChatMessage } | { kind: 'unpair' }) => void | Promise<void>;
  /** Called after a mood was stored (screens refresh on it). */
  onMoodStored?: () => void;
  /** Stores/removes the event (src/events/events-db.ts `applyEventMessage`). */
  onEvent?: (msg: EventMessage) => void | Promise<void>;
  /** R8a: stores/removes the partner's memory (`src/diary/diary-share.ts` `applyDiaryMessage`); `ignored` = nothing changed (old, mine, incomplete). */
  onDiary?: (msg: DiaryMessage) => ('created' | 'updated' | 'deleted' | 'ignored') | Promise<'created' | 'updated' | 'deleted' | 'ignored'>;
  /** R5a: stores a partner's period update (`src/period/period-db.ts` `applyPeriodMessage`); false = already stored. R5b: a new one refreshes the screens and notifies. */
  onPeriod?: (msg: PeriodMessage, id: string) => boolean | Promise<boolean>;
  /** Stories: stores / removes the partner's story, and records that the partner opened one of mine. Never notifies. */
  onStory?: (msg: StoryMessage) => void | Promise<void>;
  onStorySeen?: (msg: StorySeenMessage) => void | Promise<void>;
  /** Direct chat: stores the partner's text (`src/chat/chat-db.ts`); false = already stored (a replay). */
  onChat?: (msg: ChatMessage, id: string) => boolean | Promise<boolean>;
  /** The partner read my chat messages up to `msg.id`: they get the "Seen" mark. Never notifies. */
  onChatSeen?: (msg: ChatSeenMessage) => void | Promise<void>;
  /** The partner liked / un-liked a library file, or wrote / removed a comment under one. Never notifies. */
  onLike?: (msg: LikeMessage) => void | Promise<void>;
  onComment?: (msg: CommentMessage) => void | Promise<void>;
  /** Stage 4: stores a thumbnail / preview of a shared photo on this phone. Never notifies. */
  onMedia?: (msg: MediaMessage) => void | Promise<void>;
  /** Stage 6: a request for, or a part of, an original file. Never notifies. */
  onOriginal?: (msg: OrigMessage) => void | Promise<void>;
  /** Stage 7: sync events / a digest page from the partner. Never notifies. */
  onSync?: (msg: SyncMessage) => void | Promise<void>;
  /** Shared gallery, stage 2: the partner's file list (manifest). Never notifies. */
  onGallery?: (msg: GalleryMessage) => void | Promise<void>;
};

/** `mood-cleared` is stored since R3; `period` is stored since R5a (`onPeriod`), `diary` is stored since R8a (`onDiary`). */
export type InboxResult = 'invalid' | 'mine' | 'mood' | 'mood-cleared' | 'duplicate' | 'event' | 'profile' | 'unpair' | 'diary' | 'period' | 'story' | 'story-seen' | 'chat' | 'chat-seen' | 'like' | 'comment' | 'media' | 'original' | 'sync' | 'gallery';

/** Applies one validated-by-client transport envelope to the app: store, update, notify. */
export async function handleIncoming(d: InboxDeps, raw: PartnerRawMessage): Promise<InboxResult> {
  const msg: PartnerMessage | null = decodeMessage(raw.message);
  if (!msg) return 'invalid';
  if (msg.from === d.deviceId) return 'mine'; // our own message comes back on the same topic
  // Files (orig-*), sync (sync-*) and pictures (media) are accepted only from the end-to-end encrypted queue (`e:<envelope id>`), never from the old plain
  // mailbox, which anyone holding the household token could write to.
  if ((msg.t === 'media' || msg.t.startsWith('orig-') || msg.t.startsWith('sync-') || msg.t.startsWith('gallery-')) && !raw.id.startsWith('e:')) return 'invalid';
  switch (msg.t) {
    case 'mood': {
      if (msg.cleared) {
        if (!(await clearMoodLocal(d.db, false, raw.id, msg.ts))) return 'duplicate';
        d.onMoodStored?.();
        return 'mood-cleared';
      }
      const stored = await insertMood(d.db, { msgId: raw.id, fromMe: false, emoji: msg.emoji, text: msg.text ?? null, intensity: msg.intensity, ts: msg.ts });
      if (!stored) return 'duplicate';
      if (msg.preset !== undefined) d.setMoodPreset?.(msg.emoji, msg.preset);
      d.onMoodStored?.();
      if (d.prefs().mood) await d.notify({ kind: 'mood', msg });
      return 'mood';
    }
    case 'event':
      await d.onEvent?.(msg);
      if (!msg.deleted && d.prefs().event) await d.notify({ kind: 'event', msg });
      return 'event';
    case 'profile':
      d.setPartner({ name: msg.name, avatarB64: msg.avatarB64, avatarPhoto: msg.avatarPhoto, birthday: msg.birthday });
      if (msg.togetherSince) d.setTogetherSince?.(msg.togetherSince);
      if (msg.hello) await d.replyProfile();
      return 'profile';
    case 'unpair':
      if ((await d.onUnpaired()) === false) return 'duplicate';
      await d.notify({ kind: 'unpair' });
      return 'unpair';
    case 'diary': {
      if (!d.onDiary) return 'diary'; // recognised only
      const done = await d.onDiary(msg);
      if (done === 'ignored') return 'duplicate';
      if ((done === 'created' || done === 'updated') && !msg.silent && d.prefs().diary) await d.notify({ kind: 'diary', msg, updated: done === 'updated' });
      return 'diary';
    }
    case 'period':
      if (d.onPeriod && !(await d.onPeriod(msg, raw.id))) return 'duplicate';
      if (d.onPeriod && !msg.silent && d.prefs().period) await d.notify({ kind: 'period', msg });
      return 'period';
    case 'story':
      await d.onStory?.(msg);
      return 'story';
    case 'story-seen':
      await d.onStorySeen?.(msg);
      return 'story-seen';
    case 'chat-seen':
      await d.onChatSeen?.(msg);
      return 'chat-seen';
    case 'like':
      await d.onLike?.(msg);
      return 'like';
    case 'comment':
      await d.onComment?.(msg);
      return 'comment';
    case 'media':
      await d.onMedia?.(msg);
      return 'media';
    case 'orig-req':
    case 'orig-meta':
    case 'orig-chunk':
    case 'orig-nack':
    case 'orig-cancel':
    case 'orig-preview-req':
      await d.onOriginal?.(msg);
      return 'original';
    case 'sync-ev':
    case 'sync-digest':
      await d.onSync?.(msg);
      return 'sync';
    case 'gallery-manifest':
    case 'gallery-thumb-req':
      await d.onGallery?.(msg);
      return 'gallery';
    case 'chat':
      if (d.onChat && !(await d.onChat(msg, raw.id))) return 'duplicate';
      if (d.onChat) await d.notify({ kind: 'chat', msg });
      return 'chat';
  }
}
