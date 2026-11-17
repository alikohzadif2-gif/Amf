import type { SQLiteDatabase } from 'expo-sqlite';
import { MAX_REPLY } from '../partner/messages';
import type { CommentMessage, LikeMessage } from '../partner/types';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

/** Likes and comments under a library file. `item` = the file's server id (the same on both phones). */
export type CommentRow = { id: string; item: string; fromMe: boolean; body: string; createdAt: string };
export type Reactions = { likedByMe: boolean; likedByPartner: boolean; comments: CommentRow[] };

export const COMMENT_MAX = MAX_REPLY;
const nowIso = () => new Date().toISOString();

type RawComment = { id: string; item: string; from_me: number; body: string; created_at: string };
const toComment = (r: RawComment): CommentRow => ({ id: r.id, item: r.item, fromMe: r.from_me !== 0, body: r.body, createdAt: r.created_at });

export async function setLike(db: Db, item: string, fromMe: boolean, on: boolean, at: string = nowIso()): Promise<void> {
  if (on) await db.runAsync('INSERT OR REPLACE INTO media_likes (item, from_me, created_at) VALUES (?, ?, ?)', item, fromMe ? 1 : 0, at);
  else await db.runAsync('DELETE FROM media_likes WHERE item = ? AND from_me = ?', item, fromMe ? 1 : 0);
}

export async function addComment(db: Db, c: { id: string; item: string; fromMe: boolean; body: string; createdAt?: string }): Promise<boolean> {
  const body = c.body.trim().slice(0, COMMENT_MAX);
  if (!c.id || !c.item || !body) return false;
  const when = c.createdAt && !Number.isNaN(Date.parse(c.createdAt)) ? new Date(c.createdAt).toISOString() : nowIso();
  await db.runAsync('INSERT OR REPLACE INTO media_comments (id, item, from_me, body, created_at) VALUES (?, ?, ?, ?, ?)', c.id, c.item, c.fromMe ? 1 : 0, body, when);
  return true;
}

export async function deleteComment(db: Db, id: string, fromMe?: boolean): Promise<void> {
  if (fromMe === undefined) await db.runAsync('DELETE FROM media_comments WHERE id = ?', id);
  else await db.runAsync('DELETE FROM media_comments WHERE id = ? AND from_me = ?', id, fromMe ? 1 : 0);
}

export async function loadReactions(db: Db, item: string): Promise<Reactions> {
  const likes = await db.getAllAsync<{ from_me: number }>('SELECT from_me FROM media_likes WHERE item = ?', item);
  const rows = await db.getAllAsync<RawComment>('SELECT * FROM media_comments WHERE item = ? ORDER BY created_at ASC, id ASC', item);
  return { likedByMe: likes.some((l) => l.from_me === 1), likedByPartner: likes.some((l) => l.from_me === 0), comments: rows.map(toComment) };
}

/** The partner's like / un-like arrived. */
export async function applyLikeMessage(db: Db, msg: LikeMessage): Promise<void> {
  await setLike(db, msg.item, false, msg.on, msg.ts);
}

/** The partner's comment (or its removal) arrived. */
export async function applyCommentMessage(db: Db, msg: CommentMessage): Promise<void> {
  if (msg.deleted) await deleteComment(db, msg.id, false);
  else if (msg.text) await addComment(db, { id: msg.id, item: msg.item, fromMe: false, body: msg.text, createdAt: msg.ts });
}
