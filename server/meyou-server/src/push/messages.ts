// FCM message shapes (S9, decisions Q1/Q2). Texts are generic on purpose: no message content
// (emoji, note, event title, ...) ever goes through Google. The only per-message data is the
// type and the mailbox seq, so the app knows what to sync when it is opened.

export type PushType = 'mood' | 'event' | 'profile' | 'unpair' | 'diary' | 'period' | 'story' | 'story-seen' | 'chat' | 'chat-seen' | 'like' | 'comment' | 'e2e';
/** `test` is only used by the `push-test` CLI command. */
export type PushKind = PushType | 'test';

/**
 * R1a: a NEW channel id. Android never changes the importance of a channel that already exists on
 * the phone, so the old `meyou-partner` (importance default = no pop-up) cannot be fixed in place.
 * The app creates `meyou-partner-v2` (importance high, sound) in R1b; a phone without it falls back
 * to FCM's own channel (sound, no pop-up) until the new app is installed.
 */
export const CHANNEL_ID = 'meyou-partner-v2';
/** Q2: a push that cannot be delivered within 24 h is dropped by Google. */
export const TTL_MS = 24 * 60 * 60 * 1000;

export interface FcmMessage {
  token: string;
  /** FCM data values must all be strings. */
  data: Record<string, string>;
  /** Absent = data-only (silent) message. */
  notification?: { title: string; body: string };
  android: {
    priority: 'high' | 'normal';
    ttl: number;
    notification?: { channelId: string; sound: 'default'; priority: 'high' };
  };
}

export type PushLang = 'fa' | 'en';

const TITLE = 'meYou';

type BodyKey = 'mood' | 'event' | 'diary' | 'period' | 'chat' | 'e2e' | 'test';

const BODY: Record<PushLang, Record<BodyKey, string>> = {
  en: {
    mood: 'New status from your partner',
    event: 'New event from your partner',
    diary: 'New memory from your partner',
    period: 'New update from your partner',
    chat: 'New message from your partner',
    e2e: 'New update from your partner',
    test: 'Test message from your server',
  },
  fa: {
    mood: 'وضعیت جدیدی از همراهت رسید',
    event: 'رویداد جدیدی از همراهت رسید',
    diary: 'خاطره‌ی جدیدی از همراهت رسید',
    period: 'خبر تازه‌ای از همراهت رسید',
    chat: 'پیام جدیدی از همراهت رسید',
    e2e: 'خبر تازه‌ای از همراهت رسید',
    test: 'پیام آزمایشی از سرور تو',
  },
};

/**
 * The three period updates that raise a notification. Their text names the update only when the
 * server owner switched `PUSH_PERIOD_DETAIL` on (the text then passes through Google); otherwise the
 * generic `period` text is used. Any other `kind` is data only (silent).
 */
export type PeriodKind = 'started' | 'pain' | 'better';
export const PERIOD_KINDS: readonly PeriodKind[] = ['started', 'pain', 'better'];

const PERIOD_DETAIL: Record<PushLang, Record<PeriodKind, string>> = {
  en: {
    started: 'Your partner’s period started',
    pain: 'Your partner is in pain',
    better: 'Your partner is feeling better',
  },
  fa: {
    started: 'پریود همراهت شروع شد',
    pain: 'همراهت درد دارد',
    better: 'همراهت حالش بهتر شد',
  },
};

/** Per-message hints the mailbox gives the push layer (never the message content itself). */
export interface PushHint {
  /** Data only: nothing is shown (a clear, a delete, an explicit `silent`, an unknown period kind). */
  silent?: boolean;
  /** Which period update this is; only used when `periodDetail` is on. */
  periodKind?: PeriodKind;
  /** `PUSH_PERIOD_DETAIL`. */
  periodDetail?: boolean;
}

/** The app sends its UI language ("fa", "en", "fa-IR", ...). Anything but Persian gets English. */
export function pickLang(lang: string | null | undefined): PushLang {
  return typeof lang === 'string' && /^fa([-_]|$)/i.test(lang) ? 'fa' : 'en';
}

/** `profile` and `unpair` change state silently: nothing is shown, the app just syncs. `e2e` is silent only when the hint says so (the sender's `wake` bit). */
export function isSilent(type: PushKind): boolean {
  return type === 'profile' || type === 'unpair' || type === 'story' || type === 'story-seen' || type === 'chat-seen' || type === 'like' || type === 'comment';
}

export function buildMessage(
  token: string,
  type: PushKind,
  lang: string | null | undefined,
  seq: number,
  hint: PushHint = {},
): FcmMessage {
  const data = { type, seq: String(seq) };
  if (isSilent(type) || hint.silent) {
    // Nothing to show, so no need to wake the phone urgently; the mailbox is also synced on open.
    return { token, data, android: { priority: 'normal', ttl: TTL_MS } };
  }
  const l = pickLang(lang);
  const body =
    type === 'period' && hint.periodDetail && hint.periodKind ? PERIOD_DETAIL[l][hint.periodKind] : BODY[l][type as BodyKey];
  return {
    token,
    data,
    notification: { title: TITLE, body },
    android: { priority: 'high', ttl: TTL_MS, notification: { channelId: CHANNEL_ID, sound: 'default', priority: 'high' } },
  };
}
