import type { SQLiteDatabase } from 'expo-sqlite';
import type { PeriodKind, PeriodMessage } from '../partner/types';
import { phaseForDay, predict, toDay, type DayInfo, type Prediction } from './cycle';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
type Raw = { id: number; msg_id: string | null; from_me: number; kind: string; day: string; ts: string };

export type PeriodRow = { id: number; msgId: string | null; fromMe: boolean; kind: PeriodKind; day: string; ts: string };

const toRow = (r: Raw): PeriodRow => ({ id: r.id, msgId: r.msg_id, fromMe: r.from_me === 1, kind: r.kind as PeriodKind, day: r.day, ts: r.ts });

/** The day a `period` message is about: its `date`, else the day it was sent; never later than the day after it was sent. */
export function periodDay(msg: Pick<PeriodMessage, 'date' | 'ts'>): string {
  const sent = toDay(msg.ts) ?? new Date().toISOString().slice(0, 10);
  const asked = msg.date ? toDay(msg.date) : null;
  return asked && asked <= sent ? asked : sent;
}

/** Message for the mailbox (`date` is midnight UTC of the day). */
export function buildPeriodMessage(kind: PeriodKind, day: string, from: string, ts: string, cycleDays?: number): PeriodMessage {
  return { t: 'period', from, ts, kind, date: `${day}T00:00:00.000Z`, ...(cycleDays !== undefined ? { cycleDays } : {}) };
}

/** False when that owner already has that kind on that day, or the mailbox id was already stored. */
export async function insertPeriodEvent(db: Db, e: { msgId: string | null; fromMe: boolean; kind: PeriodKind; day: string; ts: string }): Promise<boolean> {
  const res = await db.runAsync('INSERT OR IGNORE INTO period_events (msg_id, from_me, kind, day, ts) VALUES (?, ?, ?, ?, ?)', e.msgId, e.fromMe ? 1 : 0, e.kind, e.day, e.ts);
  return res.changes > 0;
}

/** Stores a message from the partner (R5b adds the notification). */
export function applyPeriodMessage(db: Db, msgId: string, msg: PeriodMessage): Promise<boolean> {
  return insertPeriodEvent(db, { msgId, fromMe: false, kind: msg.kind, day: periodDay(msg), ts: msg.ts });
}

/** My own log on this phone only (no network). */
export async function logPeriodLocal(db: Db, e: { kind: PeriodKind; day?: string; ts?: string }, rand: () => number = Math.random): Promise<PeriodRow | null> {
  const ts = e.ts ?? new Date().toISOString();
  const day = e.day ?? toDay(ts)!;
  const msgId = `local-${Date.parse(ts).toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')}`;
  if (!(await insertPeriodEvent(db, { msgId, fromMe: true, kind: e.kind, day, ts }))) return null;
  const row = await db.getFirstAsync<Raw>('SELECT * FROM period_events WHERE msg_id = ?', msgId);
  return row ? toRow(row) : null;
}

/** Newest day first; `fromMe` picks whose log. */
export async function listPeriodEvents(db: Db, fromMe: boolean): Promise<PeriodRow[]> {
  return (await db.getAllAsync<Raw>('SELECT * FROM period_events WHERE from_me = ? ORDER BY day DESC, id DESC', fromMe ? 1 : 0)).map(toRow);
}

/** Removes one entry on this phone only (a wrong day). */
export async function deletePeriodEvent(db: Db, id: number): Promise<boolean> {
  return (await db.runAsync('DELETE FROM period_events WHERE id = ?', id)).changes > 0;
}

/** Removes the whole log shown on this screen (`fromMe`: mine, else the partner's) on this phone only. Returns how many entries went. */
export async function clearPeriodEvents(db: Db, fromMe: boolean): Promise<number> {
  return (await db.runAsync('DELETE FROM period_events WHERE from_me = ?', fromMe ? 1 : 0)).changes;
}

const startDays = (rows: readonly PeriodRow[]) => rows.filter((r) => r.kind === 'started').map((r) => r.day);

export async function predictNext(db: Db, fromMe: boolean, custom?: number | null): Promise<Prediction | null> {
  return predict(startDays(await listPeriodEvents(db, fromMe)), custom);
}

export async function dayInfo(db: Db, fromMe: boolean, day: string, custom?: number | null): Promise<DayInfo | null> {
  return phaseForDay(startDays(await listPeriodEvents(db, fromMe)), day, custom);
}
