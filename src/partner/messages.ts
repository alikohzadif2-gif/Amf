import { validCycleDays } from '../period/cycle';
import { MEDIA_MAX_DATA_CHARS } from './media-logic';
import { decodeOrig } from './orig-logic';
import { decodeSync } from '../sync/sync-messages';
import type { MoodIntensity, PartnerMessage } from './types';

/** Message bodies stay small (the server accepts up to 32 KB); a longer one is refused, never truncated. */
export const MAX_BODY = 4000;
export const MAX_NOTE = 200;
/** Event note ("what is going to happen?"): the event screen allows 1000 characters. */
export const MAX_EVENT_NOTE = 1000;
/** A reply under a memory (`DIARY_REPLY_MAX` in `src/diary/reply-db.ts`). */
export const MAX_REPLY = 1000;

/** Longest direct-chat text (the message body limit is 4000, so the JSON always fits). */
export const MAX_CHAT = 2000;

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const opt = (v: unknown, max: number) => (isStr(v, max) && v !== '' ? v : undefined);
/** A shared-file reference (`Shared/<id>/...`), never absolute and never with `..`. */
const sharedPath = (v: unknown): string | undefined =>
  isStr(v, 300) && /^Shared\/[^\0\\]+$/.test(v) && !v.split('/').some((part) => part === '..' || part === '') ? v : undefined;
const sharedPaths = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v) || v.length > 99) return undefined;
  return v.map(sharedPath).filter((path): path is string => path !== undefined);
};
/** Optional fields are added only when valid, so a message without them decodes exactly as before R1b. */
const maybe = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));
const silent = (d: Record<string, unknown>) => maybe('silent', d.silent === true ? (true as const) : undefined);

/** JSON body for a message, or null when it is longer than `MAX_BODY`. */
export function encodeMessage(msg: PartnerMessage): string | null {
  const body = JSON.stringify(msg);
  return body.length <= MAX_BODY ? body : null;
}

/** Validates an incoming body. Anything unexpected returns null (it is just ignored). */
export function decodeMessage(body: string | undefined): PartnerMessage | null {
  if (typeof body !== 'string') return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || !isStr(d.from, 32) || d.from === '' || !isIso(d.ts)) return null;
  const base = { from: d.from, ts: d.ts };
  const orig = decodeOrig(d, base, sharedPath); // stage 6: orig-req / orig-meta / orig-chunk / orig-nack / orig-cancel
  if (orig !== undefined) return orig;
  const sync = decodeSync(d, base); // stage 7: sync-ev / sync-digest
  if (sync !== undefined) return sync;
  switch (d.t) {
    case 'mood': {
      if (d.cleared === true) return { ...base, t: 'mood', cleared: true };
      const i = d.intensity;
      if (!isStr(d.emoji, 16) || d.emoji === '' || typeof i !== 'number' || !Number.isInteger(i) || i < 1 || i > 5) return null;
      const preset = typeof d.preset === 'number' && Number.isInteger(d.preset) && d.preset >= 0 && d.preset <= 7 ? d.preset : undefined;
      return { ...base, t: 'mood', emoji: d.emoji, text: opt(d.text, MAX_NOTE), intensity: i as MoodIntensity, ...maybe('preset', preset), ...silent(d) };
    }
    case 'event': {
      if (!isStr(d.id, 64) || d.id === '') return null;
      if (d.deleted === true) return { ...base, t: 'event', id: d.id, title: '', date: d.ts, deleted: true };
      if (!isStr(d.title, 200) || d.title === '' || !isIso(d.date)) return null;
      return {
        ...base,
        t: 'event',
        id: d.id,
        title: d.title,
        date: d.date,
        repeat: d.repeat === 'yearly' ? 'yearly' : undefined,
        cal: d.cal === 'jalali' || d.cal === 'gregorian' ? d.cal : undefined,
        ...maybe('icon', opt(d.icon, 32)),
        ...maybe('note', opt(d.note, MAX_EVENT_NOTE)),
        ...maybe('photo', sharedPath(d.photo)),
        ...silent(d),
      };
    }
    case 'profile': {
      const birthday = isIso(d.birthday) ? d.birthday : undefined;
      return { ...base, t: 'profile', name: opt(d.name, 60), avatarB64: opt(d.avatarB64, 3000), ...maybe('avatarPhoto', sharedPath(d.avatarPhoto)), birthday, ...maybe('togetherSince', isIso(d.togetherSince) ? d.togetherSince : undefined), hello: d.hello === true ? true : undefined };
    }
    case 'unpair':
      return { ...base, t: 'unpair' };
    case 'diary': {
      if (!isStr(d.id, 64) || d.id === '') return null;
      if (isStr(d.replyTo, 64) && d.replyTo !== '') {
        // A reply under a memory: its own id, the memory's id and the words (or the delete marker).
        if (d.deleted === true) return { ...base, t: 'diary', id: d.id, replyTo: d.replyTo, deleted: true };
        const text = opt(d.text, MAX_REPLY);
        if (!text || text.trim() === '') return null;
        return { ...base, t: 'diary', id: d.id, replyTo: d.replyTo, text, ...maybe('date', isIso(d.date) ? d.date : undefined) };
      }
      if (d.deleted === true) return { ...base, t: 'diary', id: d.id, deleted: true };
      const count = d.mediaCount;
      return {
        ...base,
        t: 'diary',
        id: d.id,
        ...maybe('title', opt(d.title, 200)),
        ...maybe('body', opt(d.body, 3000)),
        ...maybe('category', opt(d.category, 32)),
        ...maybe('mood', opt(d.mood, 16)),
        ...maybe('date', isIso(d.date) ? d.date : undefined),
        ...maybe('media', sharedPaths(d.media)),
        ...maybe('mediaCount', typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 99 ? count : undefined),
        ...silent(d),
      };
    }
    case 'period': {
      if (d.kind !== 'started' && d.kind !== 'pain' && d.kind !== 'better') return null;
      return { ...base, t: 'period', kind: d.kind, ...maybe('date', isIso(d.date) ? d.date : undefined), ...maybe('cycleDays', d.cycleDays === 0 || validCycleDays(d.cycleDays) ? (d.cycleDays as number) : undefined), ...silent(d) };
    }
    case 'story': {
      if (!isStr(d.id, 64) || d.id === '') return null;
      const type = d.type === 'video' ? 'video' : 'photo';
      if (d.deleted === true) return { ...base, t: 'story', id: d.id, type, deleted: true, ...silent(d) };
      const media = sharedPath(d.media);
      if (!media) return null;
      const y = d.overlayY;
      return {
        ...base,
        t: 'story',
        id: d.id,
        type,
        media,
        ...maybe('overlayText', opt(d.overlayText, 120)),
        ...maybe('overlayY', typeof y === 'number' && y >= 0 && y <= 1 ? y : undefined),
        ...maybe('caption', opt(d.caption, 200)),
        ...maybe('date', isIso(d.date) ? d.date : undefined),
        ...silent(d),
      };
    }
    case 'story-seen':
      if (!isStr(d.id, 64) || d.id === '') return null;
      return { ...base, t: 'story-seen', id: d.id, ...silent(d) };
    case 'chat-seen':
      if (!isStr(d.id, 64) || d.id === '') return null;
      return { ...base, t: 'chat-seen', id: d.id, ...silent(d) };
    case 'chat': {
      if (!isStr(d.id, 64) || d.id === '') return null;
      const text = opt(d.text, MAX_CHAT);
      const media = sharedPath(d.media);
      const hasText = !!text && text.trim() !== '';
      if (!hasText && !media) return null;
      return {
        ...base, t: 'chat', id: d.id,
        ...maybe('text', hasText ? text : undefined),
        ...maybe('media', media),
        ...(media ? { mediaType: d.mediaType === 'video' ? ('video' as const) : ('photo' as const) } : {}),
      };
    }
    case 'media': {
      // Stage 4: the only message that is big (up to ~450 KB of picture). It never goes through `encodeMessage` (MAX_BODY).
      const ref = sharedPath(d.ref);
      const kind = d.kind === 'thumb' || d.kind === 'preview' ? d.kind : null;
      const w = d.w;
      const h = d.h;
      if (!ref || !kind || d.mime !== 'image/jpeg' || typeof d.data !== 'string' || d.data.length < 16 || d.data.length > MEDIA_MAX_DATA_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.data)) return null;
      if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) return null;
      return { ...base, t: 'media', silent: true, ref, kind, mime: 'image/jpeg', w, h, data: d.data };
    }
    case 'like': {
      const item = opt(d.item, 160);
      if (!item || typeof d.on !== 'boolean') return null;
      return { ...base, t: 'like', item, on: d.on, ...silent(d) };
    }
    case 'comment': {
      const item = opt(d.item, 160);
      if (!isStr(d.id, 64) || d.id === '' || !item) return null;
      if (d.deleted === true) return { ...base, t: 'comment', id: d.id, item, deleted: true, ...silent(d) };
      const text = opt(d.text, MAX_REPLY);
      if (!text || text.trim() === '') return null;
      return { ...base, t: 'comment', id: d.id, item, text, ...silent(d) };
    }
    default:
      return null; // an unknown type from a newer app is ignored, never an error
  }
}

