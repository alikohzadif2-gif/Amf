import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_EVENT_ICON, normalizeEventIcon } from './icons';
import { MAX_EVENT_NOTE } from '@/src/partner/messages';
import type { EventCal } from './recurrence';
import type { EventMessage } from '@/src/partner/types';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

export type EventRow = {
  id: string;
  title: string;
  /** UTC ISO date (Gregorian) of the first occurrence. */
  date: string;
  repeat: 'yearly' | null;
  /** Calendar the event was typed in and repeats in. */
  cal: EventCal;
  tags: string[];
  /** Library key (md5 or name+size+mtime) of an attached photo/video. */
  mediaKey: string | null;
  fromMe: boolean;
  updatedAt: string;
  /** "What's gonna happen" lines (U16); null when empty. Travels as `note` (R2). */
  description: string | null;
  /** Icon id from `icons.ts` (null = none, shown as the default heart). Travels in the event message (R2). */
  icon: string | null;
  /** Surprise event: kept on this phone and NEVER published to the partner (see `eventSyncAction`, `buildEventMessage`). */
  surprise: boolean;
  /** R2: this phone's private copy of the event photo (not in the Library); null when none. */
  photoUri: string | null;
  /** R2: server path `Shared/<id>/<name>` of the shared photo (both phones read it); null when none or not uploaded yet. */
  photo: string | null;
};
type Raw = { id: string; title: string; date: string; repeat: string | null; cal: string; tags: string; media_key: string | null; from_me: number; updated_at: string; description?: string | null; icon?: string | null; surprise?: number | null; photo_uri?: string | null; photo?: string | null };

function toRow(r: Raw): EventRow {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(r.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // keep []
  }
  return { id: r.id, title: r.title, date: r.date, repeat: r.repeat === 'yearly' ? 'yearly' : null, cal: r.cal === 'gregorian' ? 'gregorian' : 'jalali', tags, mediaKey: r.media_key, fromMe: r.from_me === 1, updatedAt: r.updated_at, description: r.description?.trim() ? r.description : null, icon: normalizeEventIcon(r.icon), surprise: r.surprise === 1, photoUri: r.photo_uri || null, photo: r.photo || null };
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,،]/).map((t) => t.trim()).filter((t) => t !== ''))].slice(0, 8);
}

export function newEventId(randomBytes: (n: number) => Uint8Array): string {
  return `ev${Array.from(randomBytes(8), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Save from this phone (create or edit): last write wins. */
export async function saveEvent(db: Db, e: EventRow): Promise<void> {
  await db.runAsync(
    `INSERT INTO events (id, title, date, repeat, cal, tags, media_key, from_me, updated_at, description, icon, surprise, photo_uri, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, repeat = excluded.repeat, cal = excluded.cal,
       tags = excluded.tags, media_key = excluded.media_key, updated_at = excluded.updated_at,
       description = excluded.description, icon = excluded.icon, surprise = excluded.surprise,
       photo_uri = excluded.photo_uri, photo = excluded.photo`,
    e.id, e.title, e.date, e.repeat, e.cal, JSON.stringify(e.tags), e.mediaKey, e.fromMe ? 1 : 0, e.updatedAt,
    e.description?.trim() ? e.description.trim() : null, normalizeEventIcon(e.icon), e.surprise ? 1 : 0, e.photoUri ?? null, e.photo ?? null,
  );
}

export async function deleteEvent(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM events WHERE id = ?', id);
}

export async function listEvents(db: Db): Promise<EventRow[]> {
  return (await db.getAllAsync<Raw>('SELECT * FROM events ORDER BY date, id')).map(toRow);
}

export async function getEvent(db: Db, id: string): Promise<EventRow | null> {
  const r = await db.getFirstAsync<Raw>('SELECT * FROM events WHERE id = ?', id);
  return r ? toRow(r) : null;
}

/**
 * Applies an `event` message from the partner. Tags and the legacy attachment never travel, so an update keeps ours; an older
 * message never overwrites a newer local edit. A message from R2 on always carries `icon`, and then icon, note and photo are
 * replaced as sent (no note / no photo = removed); a message without `icon` (older app) leaves them as they are.
 */
export async function applyEventMessage(db: Db, msg: EventMessage, defaultCal: EventCal): Promise<void> {
  if (msg.deleted) return deleteEvent(db, msg.id);
  const before = await getEvent(db, msg.id);
  // no `cal` in the message (older client): keep the calendar we already have, else the receiver's own
  const cal = msg.cal ?? before?.cal ?? defaultCal;
  const full = msg.icon !== undefined;
  const icon = full ? normalizeEventIcon(msg.icon) : before?.icon ?? null;
  const note = full ? msg.note ?? null : before?.description ?? null;
  const photo = full ? msg.photo ?? null : before?.photo ?? null;
  // our private copy belongs to the photo we uploaded: a different shared photo makes it stale
  const keepCopy = !!before?.photoUri && photo !== null && photo === before.photo;
  await db.runAsync(
    `INSERT INTO events (id, title, date, repeat, cal, tags, media_key, from_me, updated_at, description, icon, photo_uri, photo) VALUES (?, ?, ?, ?, ?, '[]', NULL, 0, ?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, repeat = excluded.repeat, cal = excluded.cal, updated_at = excluded.updated_at,
       description = excluded.description, icon = excluded.icon, photo = excluded.photo,
       photo_uri = ${keepCopy ? 'events.photo_uri' : 'NULL'}
       WHERE excluded.updated_at >= events.updated_at`,
    msg.id, msg.title, msg.date, msg.repeat ?? null, cal, msg.ts, note, icon, photo,
  );
}

/**
 * What the partner protocol may do after a local save/delete. A surprise event is never published: `'none'`.
 * Turning an already-shared event into a surprise (`prev` was not a surprise) asks to retract it: `'delete'`.
 * Pure; used by the callers of `sendEvent` once the partner feature is on.
 */
export function eventSyncAction(prev: Pick<EventRow, 'surprise'> | null, next: Pick<EventRow, 'surprise'> | null): 'send' | 'delete' | 'none' {
  if (next === null) return prev?.surprise ? 'none' : 'delete';
  if (next.surprise) return prev && !prev.surprise ? 'delete' : 'none';
  return 'send';
}

/**
 * The wire message for an event, or null for a surprise event (never published). R2: icon, note (the description) and the shared
 * photo path travel too; tags, the legacy attachment and the private photo copy stay local.
 */
export function buildEventMessage(e: EventRow | { id: string; deleted: true }, from: string, ts: string): EventMessage | null {
  if ('deleted' in e) return { t: 'event', from, ts, id: e.id, title: '', date: ts, deleted: true };
  if (e.surprise) return null;
  return { t: 'event', from, ts, id: e.id, title: e.title, date: e.date, repeat: e.repeat ?? undefined, cal: e.cal, icon: e.icon ?? DEFAULT_EVENT_ICON, ...(e.description ? { note: e.description.slice(0, MAX_EVENT_NOTE) } : {}), ...(e.photo ? { photo: e.photo } : {}) };
}
