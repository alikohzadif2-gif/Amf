// FCM message shapes. Texts are generic on purpose: no message content ever goes through Google.
// Since 2.0 the server cannot tell what a queue blob is, so it only ever sends one kind of visible push ('e2e')
// plus the CLI's 'test'. The only per-message data is the kind and the queue seq, so the app knows what to sync.

/** `e2e` = an encrypted queue blob; `test` is only used by the `push-test` CLI command. */
export type PushKind = 'e2e' | 'test';

/**
 * An Android notification channel never changes importance once it exists on the phone, so the app creates
 * `meyou-partner-v2` (importance high, sound); a phone without it falls back to FCM's own channel.
 */
export const CHANNEL_ID = 'meyou-partner-v2';
/** A push that cannot be delivered within 24 h is dropped by Google. */
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

const BODY: Record<PushLang, Record<PushKind, string>> = {
  en: {
    e2e: 'New update from your partner',
    test: 'Test message from your server',
  },
  fa: {
    e2e: 'خبر تازه‌ای از همراهت رسید',
    test: 'پیام آزمایشی از سرور تو',
  },
};

/** Per-message hint the queue gives the push layer (never the message content itself). */
export interface PushHint {
  /** Data only: nothing is shown (the sender did not ask for a visible push). */
  silent?: boolean;
}

/** The app sends its UI language ("fa", "en", "fa-IR", ...). Anything but Persian gets English. */
export function pickLang(lang: string | null | undefined): PushLang {
  return typeof lang === 'string' && /^fa([-_]|$)/i.test(lang) ? 'fa' : 'en';
}

export function buildMessage(
  token: string,
  type: PushKind,
  lang: string | null | undefined,
  seq: number,
  hint: PushHint = {},
): FcmMessage {
  const data = { type, seq: String(seq) };
  if (hint.silent) {
    // Nothing to show, so no need to wake the phone urgently; the queue is also synced on open.
    return { token, data, android: { priority: 'normal', ttl: TTL_MS } };
  }
  return {
    token,
    data,
    notification: { title: TITLE, body: BODY[pickLang(lang)][type] },
    android: { priority: 'high', ttl: TTL_MS, notification: { channelId: CHANNEL_ID, sound: 'default', priority: 'high' } },
  };
}
