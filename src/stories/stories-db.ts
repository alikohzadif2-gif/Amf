import type { SQLiteDatabase } from 'expo-sqlite';
import type { StoryMessage, StorySeenMessage } from '@/src/partner/types';
import { activeStories, expiresAtOf, isActive, type StoryRow, type StoryType } from './story-logic';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
type Raw = {
  id: string;
  from_me: number;
  type: string;
  media_uri: string;
  overlay_text: string | null;
  overlay_y: number;
  caption: string | null;
  created_at: string;
  expires_at: string;
  viewed_at: string | null;
};

const toRow = (r: Raw): StoryRow => ({
  id: r.id,
  fromMe: r.from_me === 1,
  type: (r.type === 'video' ? 'video' : 'photo') as StoryType,
  mediaUri: r.media_uri,
  overlayText: r.overlay_text,
  overlayY: r.overlay_y,
  caption: r.caption,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  viewedAt: r.viewed_at,
});

export async function insertStory(db: Db, s: StoryRow): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO stories (id, from_me, type, media_uri, overlay_text, overlay_y, caption, created_at, expires_at, viewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    s.id,
    s.fromMe ? 1 : 0,
    s.type,
    s.mediaUri,
    s.overlayText,
    s.overlayY,
    s.caption,
    s.createdAt,
    s.expiresAt,
    s.viewedAt,
  );
}

/** Stories that are still inside their 24 hours, oldest first. `fromMe` filters mine / the partner's. */
export async function listActiveStories(db: Db, fromMe: boolean, nowMs: number = Date.now()): Promise<StoryRow[]> {
  const rows = await db.getAllAsync<Raw>('SELECT * FROM stories WHERE from_me = ? AND expires_at > ? ORDER BY created_at ASC', fromMe ? 1 : 0, new Date(nowMs).toISOString());
  return activeStories(rows.map(toRow), nowMs);
}

export async function getStory(db: Db, id: string): Promise<StoryRow | null> {
  const row = await db.getFirstAsync<Raw>('SELECT * FROM stories WHERE id = ?', id);
  return row ? toRow(row) : null;
}

export async function deleteStory(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM stories WHERE id = ?', id);
}

/** Stores the time the partner opened one of my stories (first time only). */
export async function markStoryViewed(db: Db, id: string, viewedAt: string): Promise<void> {
  await db.runAsync('UPDATE stories SET viewed_at = ? WHERE id = ? AND viewed_at IS NULL', viewedAt, id);
}

/** Removes expired rows and returns their media uris so the caller can delete the files. */
export async function purgeExpiredStories(db: Db, nowMs: number = Date.now()): Promise<string[]> {
  const iso = new Date(nowMs).toISOString();
  const old = await db.getAllAsync<{ media_uri: string }>('SELECT media_uri FROM stories WHERE expires_at <= ?', iso);
  if (old.length === 0) return [];
  await db.runAsync('DELETE FROM stories WHERE expires_at <= ?', iso);
  return old.map((r) => r.media_uri);
}

/**
 * The partner's story (or its removal) arrived. Only copies that came from the partner are touched: my own stories are never changed by a message.
 * `media` stays a server path (`Shared/...`); the viewer streams it. An already expired or already stored story is ignored.
 */
export async function applyStoryMessage(db: Db, msg: StoryMessage, nowMs: number = Date.now()): Promise<'stored' | 'deleted' | 'ignored'> {
  const before = await db.getFirstAsync<{ from_me: number }>('SELECT from_me FROM stories WHERE id = ?', msg.id);
  if (before && before.from_me !== 0) return 'ignored';
  if (msg.deleted) {
    if (!before) return 'ignored';
    await db.runAsync('DELETE FROM stories WHERE id = ? AND from_me = 0', msg.id);
    return 'deleted';
  }
  if (before || !msg.media) return 'ignored';
  const createdAt = new Date(msg.date ?? msg.ts).toISOString();
  const expiresAt = expiresAtOf(createdAt);
  if (!isActive(expiresAt, nowMs)) return 'ignored';
  await insertStory(db, {
    id: msg.id,
    fromMe: false,
    type: msg.type,
    mediaUri: msg.media,
    overlayText: msg.overlayText ?? null,
    overlayY: msg.overlayY ?? 0.5,
    caption: msg.caption ?? null,
    createdAt,
    expiresAt,
    viewedAt: null,
  });
  return 'stored';
}

/** The partner opened my story: remember the time of the first view. True when something changed. */
export async function applyStorySeen(db: Db, msg: StorySeenMessage): Promise<boolean> {
  const res = await db.runAsync('UPDATE stories SET viewed_at = ? WHERE id = ? AND from_me = 1 AND viewed_at IS NULL', new Date(msg.ts).toISOString(), msg.id);
  return res.changes > 0;
}
