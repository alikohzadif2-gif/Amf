/** Partner & mood types (docs/API_CONTRACT.md, section B). */
import type { MediaMessage } from './media-logic';
import type { OrigMessage } from './orig-logic';
import type { SyncMessage } from '../sync/sync-messages';
import type { GalleryManifestMessage, GalleryMessage, GalleryThumbRequest } from '../gallery/gallery-messages';

/** What one partner tells the other about themselves. Birthday is a UTC ISO date (Gregorian). */
export type Profile = {
  name?: string;
  /** Tiny (64 px) photo: always inside the profile message. */
  avatarB64?: string;
  /** R10c: reference (`Shared/avatar-<deviceId>/...`) of the sharper photo; the partner shows it instead of the tiny one when it loads. */
  avatarPhoto?: string;
  birthday?: string;
  togetherSince?: string;
};
/** What this phone keeps about me: `avatarUri` = my private copy of the sharper photo (never sent). */
export type LocalProfile = Profile & { avatarUri?: string };

export type MoodIntensity = 1 | 2 | 3 | 4 | 5;

type Base = { from: string; ts: string };
/**
 * Markers the server reads (API_CONTRACT D.11/D.13): `silent` = push with no notification text.
 * `deleted` and `cleared` are set on the messages that can be removed / reset (their push is silent too).
 */
type Silent = { silent?: true };
/** `preset` = colour (0-7, `MOOD_PRESETS`) of a custom mood of the sender, so the partner's card gets the same colour. */
export type MoodMessage = Base & Silent & { t: 'mood'; emoji: string; text?: string; intensity: MoodIntensity; preset?: number; cleared?: undefined };
/** R1b: the sender removed their current mood ("no mood"); no emoji or intensity. R3 applies it. */
export type MoodClearedMessage = Base & { t: 'mood'; cleared: true };
/**
 * Create/edit (same id = replace) or, with `deleted`, remove one event. `cal` = calendar the yearly repeat follows.
 * R1b fields (R2 fills them): `icon` = event icon id (icons.ts), `note` = what is going to happen, `photo` = server path
 * of the photo in `Shared/<id>/` (the photo itself never travels in the mailbox).
 */
export type EventMessage = Base & Silent & { t: 'event'; id: string; title: string; date: string; repeat?: 'yearly'; cal?: 'jalali' | 'gregorian'; icon?: string; note?: string; photo?: string; deleted?: true };
export type ProfileMessage = Base & Profile & { t: 'profile'; hello?: true };
export type UnpairMessage = Base & { t: 'unpair' };
/**
 * A shared diary memory. Same id = replace; `deleted` removes it. `media` holds photo/video paths under `Shared/<id>/`;
 * `mediaCount` remains as a fallback for messages from R8a clients. `mood` = a mood emoji.
 * A reply under a memory uses the same type with `replyTo` (an older app ignores it: no title, unknown id).
 */
export type DiaryMessage = Base & Silent & { t: 'diary'; id: string; title?: string; body?: string; category?: string; mood?: string; date?: string; media?: string[]; mediaCount?: number; deleted?: true;
  /** Reply under the memory `replyTo` (then `id` is the reply's own id and `text` its words; `deleted` removes that reply). */
  replyTo?: string; text?: string };
/** The kinds that give a visible notification (D.11). R5a defines the cycle data on top of this. */
export type PeriodKind = 'started' | 'pain' | 'better';
/** `cycleDays` (Q7): the sender's own cycle length, 15-60, or 0 = "no own length, estimate"; absent from an older app. */
export type PeriodMessage = Base & Silent & { t: 'period'; kind: PeriodKind; date?: string; cycleDays?: number };
/**
 * A 24-hour story. `media` = server path of the photo/video in `Shared/<id>/` (it never travels in the mailbox); `date` = when it was taken
 * (the story ends 24 h later). `deleted` removes it. Always data only (no notification text).
 */
export type StoryMessage = Base & Silent & { t: 'story'; id: string; type: 'photo' | 'video'; media?: string; overlayText?: string; overlayY?: number; caption?: string; date?: string; deleted?: true };
/** The story `id` was opened by the sender of this message; `ts` is the time it was seen. */
export type StorySeenMessage = Base & Silent & { t: 'story-seen'; id: string };
/** A plain direct-chat text. `id` is the message's own id (a replayed message with the same id is ignored). Text only. */
export type ChatMessage = Base & { t: 'chat'; id: string; text?: string;
  /** A photo/video: `media` = the shared-file reference (`Shared/<id>/<name>`); the picture itself travels encrypted. */
  media?: string; mediaType?: 'photo' | 'video' };
/** I like (`on`) or un-like the library file `item` (its server id). Data only. */
export type LikeMessage = Base & Silent & { t: 'like'; item: string; on: boolean };
/** A comment under the library file `item`; same id = replace, `deleted` removes it. Data only. */
export type CommentMessage = Base & Silent & { t: 'comment'; id: string; item: string; text?: string; deleted?: true };
/** "I read your chat messages up to `id`" (the id of the newest of the RECEIVER's messages that the sender of this has now seen). Data only. */
export type ChatSeenMessage = Base & Silent & { t: 'chat-seen'; id: string };
/** Stage 4: a small encrypted picture (thumbnail or preview) of the shared file `ref` (`Shared/<id>/<name>`). Data only; never carries a notification. */
export type { MediaMessage };
/** Stage 6: asking for / receiving the original file of a shared photo (src/partner/orig-logic.ts). Data only; never carries a notification. */
export type { OrigMessage };
export type { SyncMessage };
/** Shared gallery, stage 2: the partner's file list (src/gallery/manifest.ts). Data only; never carries a notification. */
export type { GalleryMessage, GalleryManifestMessage, GalleryThumbRequest };
export type PartnerMessage = GalleryMessage | SyncMessage | OrigMessage | MediaMessage | LikeMessage | CommentMessage | ChatSeenMessage | ChatMessage | MoodMessage | MoodClearedMessage | EventMessage | ProfileMessage | UnpairMessage | DiaryMessage | PeriodMessage | StoryMessage | StorySeenMessage;

/** A server-issued, single-use invitation in the `meyou://join` link. */
/** `key` = the master key of the one-QR pairing (`mk=`); absent in invitations made by older versions. */
export type MailboxInvitePayload = { url: string; code: string; key?: string };

export type MoodRow = {
  id: number;
  msgId: string | null;
  fromMe: boolean;
  emoji: string;
  text: string | null;
  intensity: number;
  ts: string;
  /** Activity id (see `activities.ts`), null for old rows and partner moods. */
  activity: string | null;
};
