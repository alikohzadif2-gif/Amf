import type { SQLiteDatabase } from 'expo-sqlite';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

/** One reply under a memory. `fromMe` = false: written by the partner. */
export type DiaryReply = { id: string; memoryId: string; fromMe: boolean; body: string; createdAt: string };

type RawReply = { id: string; memory_id: string; from_me: number; body: string; created_at: string };

/** Longest reply (the message parser, `messages.ts`, drops anything longer, so the editor stops here). */
export const DIARY_REPLY_MAX = 1000;

const toReply = (row: RawReply): DiaryReply => ({ id: row.id, memoryId: row.memory_id, fromMe: row.from_me !== 0, body: row.body, createdAt: row.created_at });

/** Replies of one memory, oldest first. */
export async function listReplies(db: Db, memoryId: string): Promise<DiaryReply[]> {
  const rows = await db.getAllAsync<RawReply>('SELECT * FROM diary_replies WHERE memory_id = ? ORDER BY created_at ASC, id ASC', memoryId);
  return rows.map(toReply);
}

/** Stores a reply. Returns false for an empty text or an id that already exists (a replayed message). */
export async function addReply(db: Db, reply: DiaryReply): Promise<boolean> {
  const body = reply.body.trim().slice(0, DIARY_REPLY_MAX);
  if (!reply.id.trim() || !reply.memoryId.trim() || !body) return false;
  const before = await db.getFirstAsync<{ id: string }>('SELECT id FROM diary_replies WHERE id = ?', reply.id);
  if (before) return false;
  await db.runAsync(
    'INSERT INTO diary_replies (id, memory_id, from_me, body, created_at) VALUES (?, ?, ?, ?, ?)',
    reply.id, reply.memoryId, reply.fromMe ? 1 : 0, body, new Date(reply.createdAt).toISOString(),
  );
  return true;
}

/** Removes one reply. `fromMe` limits it to my own (or the partner's) replies. */
export async function deleteReply(db: Db, id: string, fromMe: boolean): Promise<boolean> {
  const before = await db.getFirstAsync<{ id: string }>('SELECT id FROM diary_replies WHERE id = ? AND from_me = ?', id, fromMe ? 1 : 0);
  if (!before) return false;
  await db.runAsync('DELETE FROM diary_replies WHERE id = ?', id);
  return true;
}

/**
 * For the list: per memory, `answered` = somebody other than the memory's author replied (the "Replied" heart on the card),
 * `count` = all replies.
 */
export async function replySummary(db: Db): Promise<Map<string, { count: number; answered: boolean }>> {
  const rows = await db.getAllAsync<{ memory_id: string; total: number; answered: number }>(
    `SELECT r.memory_id AS memory_id, COUNT(*) AS total,
       SUM(CASE WHEN r.from_me != COALESCE(d.from_me, 1) THEN 1 ELSE 0 END) AS answered
     FROM diary_replies r LEFT JOIN diary d ON d.id = r.memory_id GROUP BY r.memory_id`,
  );
  return new Map(rows.map((row) => [row.memory_id, { count: row.total, answered: (row.answered ?? 0) > 0 }]));
}
