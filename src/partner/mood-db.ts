import type { SQLiteDatabase } from 'expo-sqlite';
import type { MoodRow } from './types';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
type Raw = { id: number; msg_id: string | null; from_me: number; emoji: string; text: string | null; intensity: number; ts: string; activity: string | null };

const toRow = (r: Raw): MoodRow => ({
  id: r.id,
  msgId: r.msg_id,
  fromMe: r.from_me === 1,
  emoji: r.emoji,
  text: r.text,
  intensity: r.intensity,
  ts: r.ts,
  activity: r.activity ?? null,
});

/** Returns false when the mailbox message id (`seq`) was already stored (duplicate delivery after a reconnect). */
export async function insertMood(db: Db, m: Omit<MoodRow, 'id' | 'activity'> & { activity?: string | null }): Promise<boolean> {
  const res = await db.runAsync(
    'INSERT OR IGNORE INTO moods (msg_id, from_me, emoji, text, intensity, ts, activity) VALUES (?, ?, ?, ?, ?, ?, ?)',
    m.msgId,
    m.fromMe ? 1 : 0,
    m.emoji,
    m.text,
    m.intensity,
    m.ts,
    m.activity ?? null,
  );
  return res.changes > 0;
}

/**
 * Saves my own status on this phone only (no partner, no network). The row looks like a sent one
 * (`fromMe = true`) with a local message id, so history and the future server phase can treat it the same.
 */
export async function saveMoodLocal(
  db: Db,
  m: { emoji: string; text?: string; intensity?: MoodRow['intensity']; activity?: string | null; ts?: string },
  rand: () => number = Math.random,
): Promise<MoodRow> {
  const ts = m.ts ?? new Date().toISOString();
  const msgId = `local-${Date.parse(ts).toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')}`;
  const text = m.text?.trim() || null;
  const intensity = m.intensity ?? 3;
  const activity = m.activity || null;
  const res = await db.runAsync(
    'INSERT INTO moods (msg_id, from_me, emoji, text, intensity, ts, activity) VALUES (?, 1, ?, ?, ?, ?, ?)',
    msgId,
    m.emoji,
    text,
    intensity,
    ts,
    activity,
  );
  return { id: Number(res.lastInsertRowId), msgId, fromMe: true, emoji: m.emoji, text, intensity, ts, activity };
}

/** R3: a "cleared" mood is a row with an empty emoji. It hides the earlier mood ("no mood") but is never listed in the history. */
export async function clearMoodLocal(db: Db, fromMe: boolean, msgId: string | null, ts: string = new Date().toISOString()): Promise<boolean> {
  const id = msgId ?? `local-clear-${Date.parse(ts).toString(36)}-${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
  const res = await db.runAsync("INSERT OR IGNORE INTO moods (msg_id, from_me, emoji, text, intensity, ts, activity) VALUES (?, ?, '', NULL, 3, ?, NULL)", id, fromMe ? 1 : 0, ts);
  return res.changes > 0;
}

/** Removes one history row (this phone only; the partner's copy is not touched). */
export async function deleteMood(db: Db, id: number): Promise<void> {
  await db.runAsync('DELETE FROM moods WHERE id = ?', id);
}

/** Emojis / activity ids I used lately, most recent first (R3: shown first on the Status tab). */
export async function recentUsed(db: Db, limit = 8): Promise<{ emojis: string[]; activities: string[] }> {
  const e = await db.getAllAsync<{ v: string }>("SELECT emoji AS v FROM moods WHERE from_me = 1 AND emoji != '' GROUP BY emoji ORDER BY MAX(ts) DESC, MAX(id) DESC LIMIT ?", limit);
  const a = await db.getAllAsync<{ v: string }>("SELECT activity AS v FROM moods WHERE from_me = 1 AND emoji != '' AND activity IS NOT NULL AND activity != '' GROUP BY activity ORDER BY MAX(ts) DESC, MAX(id) DESC LIMIT ?", limit);
  return { emojis: e.map((r) => r.v), activities: a.map((r) => r.v) };
}

export async function listMoods(db: Db, limit = 100): Promise<MoodRow[]> {
  const rows = await db.getAllAsync<Raw>("SELECT * FROM moods WHERE emoji != '' ORDER BY ts DESC, id DESC LIMIT ?", limit);
  return rows.map(toRow);
}

/** My own statuses only (emoji + activity + date), newest first: the history sheet of the Status tab (U15). */
export async function listMyStatusHistory(db: Db, limit = 50): Promise<MoodRow[]> {
  const rows = await db.getAllAsync<Raw>("SELECT * FROM moods WHERE from_me = 1 AND emoji != '' ORDER BY ts DESC, id DESC LIMIT ?", limit);
  return rows.map(toRow);
}

/** Latest mood of the partner (`fromMe = false`) or of this phone's owner; null when none or the latest one was cleared. */
export async function latestMood(db: Db, fromMe: boolean): Promise<MoodRow | null> {
  const r = await db.getFirstAsync<Raw>('SELECT * FROM moods WHERE from_me = ? ORDER BY ts DESC, id DESC LIMIT 1', fromMe ? 1 : 0);
  return r && r.emoji !== '' ? toRow(r) : null;
}
