import type { SQLiteDatabase } from 'expo-sqlite';
import type { DiaryMessage } from '@/src/partner/types';
import { DIARY_NO_CATEGORY, isDiaryCategory } from './categories';
import { addCustomCategory, cleanCategoryName, listCustomCategories, newCategoryId } from './category-db';
import type { DiaryRow } from './diary-db';
import { addReply, deleteReply, DIARY_REPLY_MAX } from './reply-db';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

/** Limits of the message parser (messages.ts): a longer text would be dropped by the receiver, so the sender cuts it. */
export const DIARY_SEND_TITLE_MAX = 200;
export const DIARY_SEND_BODY_MAX = 3000;

const nameKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/**
 * What the partner is told about a memory's category: a built-in id or `none` as they are; a custom category travels by
 * its NAME (custom ids are local, R6). A name that looks like a built-in id (or `none`) is sent as `none`.
 */
export async function categoryForMessage(db: Db, category: string): Promise<string> {
  if (category === DIARY_NO_CATEGORY || isDiaryCategory(category)) return category;
  const custom = (await listCustomCategories(db)).find((c) => c.id === category);
  if (!custom) return DIARY_NO_CATEGORY;
  const name = cleanCategoryName(custom.name);
  return !name || name === DIARY_NO_CATEGORY || isDiaryCategory(name) ? DIARY_NO_CATEGORY : name;
}

/** The `diary` message for a saved memory, or a delete marker. `silent` = no notification (media-only change). Null for a copy that came from the partner. */
export async function buildDiaryMessage(
  db: Db,
  entry: DiaryRow | { id: string; deleted: true },
  from: string,
  ts: string,
  options: { silent?: boolean; media?: string[] } = {},
): Promise<DiaryMessage | null> {
  if ('deleted' in entry) return { t: 'diary', from, ts, id: entry.id, deleted: true };
  if (entry.fromMe === false) return null;
  return {
    t: 'diary',
    from,
    ts,
    id: entry.id,
    title: entry.title.slice(0, DIARY_SEND_TITLE_MAX),
    ...(entry.body ? { body: entry.body.slice(0, DIARY_SEND_BODY_MAX) } : {}),
    category: await categoryForMessage(db, entry.category),
    ...(entry.mood ? { mood: entry.mood } : {}),
    date: entry.createdAt,
    ...(options.media ? { media: options.media } : {}),
    mediaCount: Math.min(options.media?.length ?? entry.mediaKeys.length, 99),
    ...(options.silent ? { silent: true as const } : {}),
  };
}

/** The `diary` message for a reply under memory `memoryId` (`id` = the reply's own id), or the marker that removes it. */
export function buildReplyMessage(reply: { id: string; memoryId: string; body?: string; createdAt?: string; deleted?: true }, from: string, ts: string): DiaryMessage {
  if (reply.deleted) return { t: 'diary', from, ts, id: reply.id, replyTo: reply.memoryId, deleted: true };
  return { t: 'diary', from, ts, id: reply.id, replyTo: reply.memoryId, text: (reply.body ?? '').trim().slice(0, DIARY_REPLY_MAX), date: reply.createdAt ?? ts };
}

/** A reply from the partner: kept only for a memory this phone has; a replayed message and an unknown memory are ignored. */
async function applyReplyMessage(db: Db, msg: DiaryMessage): Promise<'created' | 'deleted' | 'ignored'> {
  if (!msg.replyTo) return 'ignored';
  if (msg.deleted) return (await deleteReply(db, msg.id, false)) ? 'deleted' : 'ignored'; // only the partner's own reply can be removed by their message
  const memory = await db.getFirstAsync<{ id: string }>('SELECT id FROM diary WHERE id = ?', msg.replyTo);
  if (!memory || !msg.text) return 'ignored';
  const added = await addReply(db, { id: msg.id, memoryId: msg.replyTo, fromMe: false, body: msg.text, createdAt: msg.date ?? msg.ts });
  return added ? 'created' : 'ignored';
}

/** The local category id for a category received by name/id. Unknown names become a custom category here (or `none` at the limit). */
async function categoryFromMessage(db: Db, value: string | undefined, newId: () => string): Promise<string> {
  if (!value || value === DIARY_NO_CATEGORY) return DIARY_NO_CATEGORY;
  if (isDiaryCategory(value)) return value;
  const name = cleanCategoryName(value);
  if (!name) return DIARY_NO_CATEGORY;
  const found = (await listCustomCategories(db)).find((c) => nameKey(c.name) === nameKey(name));
  if (found) return found.id;
  const added = await addCustomCategory(db, name, newCategoryId(newId()));
  return added.ok ? added.category.id : DIARY_NO_CATEGORY;
}

/**
 * Stores a received memory (same id = replace; the partner's later edit wins, an older message is ignored) or removes it.
 * Only copies that came from the partner are touched: my own memories are never changed or deleted by a message.
 * Returns what happened so the caller can notify: `created`, `updated`, `deleted` or `ignored`.
 */
export async function applyDiaryMessage(db: Db, msg: DiaryMessage, newId: () => string): Promise<'created' | 'updated' | 'deleted' | 'ignored'> {
  if (msg.replyTo) return applyReplyMessage(db, msg);
  const before = await db.getFirstAsync<{ from_me: number; updated_at: string; created_at: string; title: string }>('SELECT from_me, updated_at, created_at, title FROM diary WHERE id = ?', msg.id);
  if (before && before.from_me !== 0) return 'ignored';
  if (msg.deleted) {
    if (!before) return 'ignored';
    await db.runAsync('DELETE FROM diary WHERE id = ? AND from_me = 0', msg.id);
    await db.runAsync('DELETE FROM diary_replies WHERE memory_id = ?', msg.id);
    return 'deleted';
  }
  const title = (msg.title ?? before?.title ?? '').trim();
  if (!title) return 'ignored';
  const updatedAt = new Date(msg.ts).toISOString();
  if (before && updatedAt < before.updated_at) return 'ignored';
  const createdAt = new Date(msg.date ?? before?.created_at ?? msg.ts).toISOString();
  const category = await categoryFromMessage(db, msg.category, newId);
  await db.runAsync(
    `INSERT INTO diary (id, title, category, mood, body, media_keys, saved, created_at, updated_at, from_me, shared_media)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category, mood = excluded.mood, body = excluded.body,
       media_keys = excluded.media_keys, created_at = excluded.created_at, updated_at = excluded.updated_at, shared_media = excluded.shared_media
     WHERE diary.from_me = 0`,
    msg.id, title, category, msg.mood ?? null, msg.body ?? '', JSON.stringify(msg.media ?? []), createdAt, updatedAt, msg.media?.length ?? msg.mediaCount ?? 0,
  );
  return before ? 'updated' : 'created';
}
