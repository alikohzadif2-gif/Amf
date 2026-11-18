import type { SQLiteDatabase } from 'expo-sqlite';
import { MAX_CHAT } from '../partner/messages';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

/** One direct-chat text. `fromMe` = false: written by the partner. `failed` = mine, not delivered yet (tap to retry). */
export type ChatMediaType = 'photo' | 'video';
export type ChatRow = {
  id: string; fromMe: boolean; body: string; createdAt: string; failed: boolean;
  /** Mine only: the partner has read it. */ seen: boolean;
  /** A server library item (its server id) sent from the viewer, or a shared upload path (`Shared/...`); at most one is set. */
  item: string | null; media: string | null; mediaType: ChatMediaType | null;
};

type RawChat = { id: string; from_me: number; body: string; created_at: string; state: string; seen?: number; item?: string | null; media?: string | null; media_type?: string | null };

export { MAX_CHAT as CHAT_MAX };
/** How many of the newest messages the screen loads at once. */
export const CHAT_PAGE = 200;

const toRow = (row: RawChat): ChatRow => ({ id: row.id, fromMe: row.from_me !== 0, body: row.body, createdAt: row.created_at, failed: row.state === 'failed', seen: row.seen === 1, item: row.item ?? null, media: row.media ?? null, mediaType: row.media_type === 'video' ? 'video' : row.media_type === 'photo' ? 'photo' : null });

/** The newest `limit` messages, returned oldest first (the order the screen shows them). */
export async function listChat(db: Db, limit: number = CHAT_PAGE): Promise<ChatRow[]> {
  const rows = await db.getAllAsync<RawChat>('SELECT * FROM chat_messages ORDER BY created_at DESC, id DESC LIMIT ?', limit);
  return rows.map(toRow).reverse();
}

/** The newest message (for a preview), or null. */
export async function lastChat(db: Db): Promise<ChatRow | null> {
  const row = await db.getFirstAsync<RawChat>('SELECT * FROM chat_messages ORDER BY created_at DESC, id DESC LIMIT 1');
  return row ? toRow(row) : null;
}

/** Stores a message. Returns false for an empty text or an id that already exists (a replayed message). */
export async function addChat(db: Db, msg: { id: string; fromMe: boolean; body: string; createdAt: string; failed?: boolean; read?: boolean; item?: string | null; media?: string | null; mediaType?: ChatMediaType | null }): Promise<boolean> {
  const body = msg.body.trim().slice(0, MAX_CHAT);
  const hasMedia = !!(msg.item || msg.media);
  if (!msg.id.trim() || (!body && !hasMedia)) return false;
  const before = await db.getFirstAsync<{ id: string }>('SELECT id FROM chat_messages WHERE id = ?', msg.id);
  if (before) return false;
  const when = Number.isNaN(Date.parse(msg.createdAt)) ? new Date().toISOString() : new Date(msg.createdAt).toISOString();
  await db.runAsync(
    'INSERT INTO chat_messages (id, from_me, body, created_at, state, read, item, media, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    msg.id, msg.fromMe ? 1 : 0, body, when, msg.failed ? 'failed' : 'sent', msg.fromMe || msg.read ? 1 : 0, // the partner's new text is unread until the chat is opened
    msg.item ?? null, msg.media ?? null, hasMedia ? (msg.mediaType ?? 'photo') : null,
  );
  return true;
}

/** Marks one of my messages as delivered (`failed` = false) or not delivered. */
export async function setChatFailed(db: Db, id: string, failed: boolean): Promise<void> {
  await db.runAsync('UPDATE chat_messages SET state = ? WHERE id = ? AND from_me = 1', failed ? 'failed' : 'sent', id);
}

export async function getChat(db: Db, id: string): Promise<ChatRow | null> {
  const row = await db.getFirstAsync<RawChat>('SELECT * FROM chat_messages WHERE id = ?', id);
  return row ? toRow(row) : null;
}

/** How many of the partner's texts have not been read yet (the red number on the Direct icon). */
export async function unreadChatCount(db: Db): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages WHERE from_me = 0 AND read = 0');
  return row?.n ?? 0;
}

/** Marks every partner text as read. Returns the id of the newest one that was unread (to tell the partner), or null when nothing was unread. */
export async function markChatRead(db: Db): Promise<string | null> {
  const row = await db.getFirstAsync<{ id: string }>('SELECT id FROM chat_messages WHERE from_me = 0 AND read = 0 ORDER BY created_at DESC, id DESC LIMIT 1');
  if (!row) return null;
  await db.runAsync('UPDATE chat_messages SET read = 1 WHERE from_me = 0 AND read = 0');
  return row.id;
}

/**
 * The partner has read my messages up to `id`: that one and every older message of mine is `seen`.
 * Returns false when `id` is not one of my messages or nothing changed (a repeated receipt).
 */
export async function markChatSeenUpTo(db: Db, id: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ id: string; created_at: string }>('SELECT id, created_at FROM chat_messages WHERE id = ? AND from_me = 1', id);
  if (!row) return false;
  const pending = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM chat_messages WHERE from_me = 1 AND seen = 0 AND (created_at < ? OR (created_at = ? AND id <= ?))',
    row.created_at, row.created_at, row.id,
  );
  if (!pending || pending.n === 0) return false;
  await db.runAsync(
    'UPDATE chat_messages SET seen = 1 WHERE from_me = 1 AND seen = 0 AND (created_at < ? OR (created_at = ? AND id <= ?))',
    row.created_at, row.created_at, row.id,
  );
  return true;
}
