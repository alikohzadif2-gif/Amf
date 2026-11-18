import type { SQLiteDatabase } from 'expo-sqlite';
import { emptyState, type SyncState } from './sync-logic';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getFirstAsync'>;

/** Loads the sync state; an unreadable or missing document is an empty state (never a crash). */
export async function loadSyncState(db: Db): Promise<SyncState> {
  try {
    const row = await db.getFirstAsync<{ json: string }>('SELECT json FROM sync_state WHERE id = 1');
    if (!row) return emptyState();
    const parsed = JSON.parse(row.json) as Partial<SyncState>;
    return { ...emptyState(), ...parsed, items: Object.fromEntries(Object.entries(parsed.items ?? {}).map(([k, i]) => [k, { ...i, refs: i.refs ?? [] }])), tombstones: parsed.tombstones ?? {}, hidden: parsed.hidden ?? [], pending: parsed.pending ?? {} };
  } catch {
    return emptyState();
  }
}

export async function saveSyncState(db: Db, state: SyncState): Promise<void> {
  await db.runAsync(
    'INSERT INTO sync_state (id, json, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated',
    JSON.stringify(state), Date.now(),
  );
}

export async function clearSyncState(db: Db | null): Promise<void> {
  if (!db) return;
  try {
    await db.runAsync('DELETE FROM sync_state');
  } catch {
    // table missing: nothing to clear
  }
}
