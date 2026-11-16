import type { SQLiteDatabase } from 'expo-sqlite';
import { create } from 'zustand';
import type { StorageItem } from '@/src/storage/types';
import { listCustomCategories, isKnownCategory } from '@/src/diary/category-db';
import type { LibraryEntry, SourceRef } from './merge';
import { providerFor } from './providers';
import { shareExcludedKeys } from './indexer';

export type Album = { id: number; name: string; offline: boolean };
export type ArchiveMeta = { date: string | null; category: string };
type MetaRow = { key: string; date_iso: string | null; category: string };
type CustomCategory = { id: string; name: string };
export type OfflineRecord = {
  uri: string;
  size: number;
  simulated: boolean;
  sourceId: string;
  itemId: string;
};

type UserData = {
  loaded: boolean;
  favorites: Set<string>;
  tagsByKey: Record<string, string[]>;
  allTags: string[];
  albums: Album[];
  albumKeys: Record<number, string[]>;
  offline: Record<string, OfflineRecord>;
  archiveMeta: Record<string, ArchiveMeta>;
  customCategories: CustomCategory[];
};

export const useUserData = create<UserData>()(() => ({
  loaded: false,
  favorites: new Set<string>(),
  tagsByKey: {},
  allTags: [],
  albums: [],
  albumKeys: {},
  offline: {},
  archiveMeta: {},
  customCategories: [],
}));

let db: SQLiteDatabase | null = null;
const now = () => new Date().toISOString();

function database(): SQLiteDatabase {
  if (!db) throw new Error('Library database is not ready');
  return db;
}

export async function loadUserData(database_: SQLiteDatabase) {
  db = database_;
  const d = database();
  await d.runAsync(
    `CREATE TABLE IF NOT EXISTS archive_item_meta (
      key TEXT PRIMARY KEY NOT NULL,
      date_iso TEXT,
      category TEXT NOT NULL DEFAULT 'none'
    )`,
  );
  const [favs, tagRows, albumRows, albumItemRows, offlineRows, allTags, metaRows, customCategories] = await Promise.all([
    d.getAllAsync<{ key: string }>('SELECT key FROM favorites'),
    d.getAllAsync<{ key: string; name: string }>(
      'SELECT it.key AS key, t.name AS name FROM item_tags it JOIN tags t ON t.id = it.tag_id ORDER BY t.name',
    ),
    d.getAllAsync<{ id: number; name: string; offline: number }>(
      'SELECT id, name, offline FROM albums ORDER BY created_at DESC',
    ),
    d.getAllAsync<{ album_id: number; key: string }>(
      'SELECT album_id, key FROM album_items ORDER BY added_at DESC',
    ),
    d.getAllAsync<{ key: string; source_id: string; item_id: string; uri: string; size: number; simulated: number }>(
      'SELECT key, source_id, item_id, uri, size, simulated FROM offline_items',
    ),
    d.getAllAsync<{ name: string }>('SELECT name FROM tags ORDER BY name'),
    d.getAllAsync<MetaRow>('SELECT key, date_iso, category FROM archive_item_meta'),
    listCustomCategories(d),
  ]);
  const tagsByKey: Record<string, string[]> = {};
  for (const row of tagRows) (tagsByKey[row.key] ??= []).push(row.name);
  const albumKeys: Record<number, string[]> = {};
  for (const row of albumItemRows) (albumKeys[row.album_id] ??= []).push(row.key);
  const offline: Record<string, OfflineRecord> = {};
  for (const row of offlineRows) {
    offline[row.key] = {
      uri: row.uri,
      size: row.size,
      simulated: row.simulated === 1,
      sourceId: row.source_id,
      itemId: row.item_id,
    };
  }
  const archiveMeta: Record<string, ArchiveMeta> = {};
  for (const row of metaRows) archiveMeta[row.key] = { date: row.date_iso, category: row.category || 'none' };
  useUserData.setState({
    loaded: true,
    favorites: new Set(favs.map((f) => f.key)),
    tagsByKey,
    allTags: allTags.map((t) => t.name),
    albums: albumRows.map((a) => ({ id: a.id, name: a.name, offline: a.offline === 1 })),
    albumKeys,
    offline,
    archiveMeta,
    customCategories,
  });
}

/** Parses a strict Gregorian day, stored at midnight UTC. Invalid or partial dates return null. */
export function parseArchiveDate(value: string): string | null {
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? date.toISOString() : null;
}

/** Apply a date/category override to a single item or a selection; undefined leaves that field unchanged, null restores source date. */
export async function setArchiveMetadata(
  entries: readonly Pick<LibraryEntry, 'key'>[],
  changes: { date?: string | null; category?: string },
): Promise<void> {
  if (entries.length === 0 || (changes.date === undefined && changes.category === undefined)) return;
  if (changes.date !== undefined && changes.date !== null && !parseArchiveDate(changes.date)) {
    throw new TypeError('Archive date must be a valid YYYY-MM-DD day.');
  }
  if (changes.category !== undefined && !(await isKnownCategory(database(), changes.category))) {
    throw new TypeError('Unknown archive category.');
  }
  const d = database();
  const current = useUserData.getState().archiveMeta;
  const updates = entries.map(({ key }) => {
    const old = current[key] ?? { date: null, category: 'none' };
    return {
      key,
      date: changes.date === undefined ? old.date : changes.date,
      category: changes.category === undefined ? old.category : changes.category,
    };
  });
  await d.withTransactionAsync(async () => {
    for (const row of updates) {
      await d.runAsync(
        'INSERT INTO archive_item_meta (key, date_iso, category) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET date_iso = excluded.date_iso, category = excluded.category',
        [row.key, row.date, row.category],
      );
    }
  });
  useUserData.setState((state) => ({
    archiveMeta: { ...state.archiveMeta, ...Object.fromEntries(updates.map((row) => [row.key, { date: row.date, category: row.category }])) },
  }));
}

/** Keeps a copy of the item's metadata so favourites/albums can be shown later. */
export async function snapshot(entries: LibraryEntry[]) {
  const d = database();
  await d.withTransactionAsync(async () => {
    for (const { key, item, refs } of entries) {
      await d.runAsync(
        `INSERT INTO media_items (key, name, type, size, mtime, md5, mime, width, height, duration, refs, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET refs = excluded.refs, updated_at = excluded.updated_at`,
        [key, item.name, item.type, item.size, item.mtime, item.md5 ?? null, item.mime ?? null,
          item.width ?? null, item.height ?? null, item.duration ?? null, JSON.stringify(refs), now()],
      );
    }
  });
}

type SnapshotRow = {
  key: string; name: string; type: StorageItem['type']; size: number; mtime: string;
  md5: string | null; mime: string | null; width: number | null; height: number | null;
  duration: number | null; refs: string;
};

/** Rebuilds entries from saved snapshots (order of `keys` is kept). */
export async function entriesFromSnapshots(keys: string[]): Promise<LibraryEntry[]> {
  if (keys.length === 0) return [];
  const d = database();
  const rows: SnapshotRow[] = [];
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    rows.push(
      ...(await d.getAllAsync<SnapshotRow>(
        `SELECT * FROM media_items WHERE key IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      )),
    );
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: LibraryEntry[] = [];
  for (const key of keys) {
    if (shareExcludedKeys.has(key)) continue;
    const r = byKey.get(key);
    if (!r) continue;
    const refs = JSON.parse(r.refs) as SourceRef[];
    out.push({
      key,
      refs,
      item: {
        id: refs[0]?.itemId ?? key, parentId: null, name: r.name, type: r.type, size: r.size,
        mtime: r.mtime, md5: r.md5 ?? undefined, mime: r.mime ?? undefined,
        width: r.width ?? undefined, height: r.height ?? undefined, duration: r.duration ?? undefined,
      },
    });
  }
  return out;
}

export async function setFavorite(entries: LibraryEntry[], on: boolean) {
  const d = database();
  if (on) await snapshot(entries);
  await d.withTransactionAsync(async () => {
    for (const { key } of entries) {
      if (on) await d.runAsync('INSERT OR IGNORE INTO favorites (key, created_at) VALUES (?, ?)', [key, now()]);
      else await d.runAsync('DELETE FROM favorites WHERE key = ?', [key]);
    }
  });
  useUserData.setState((s) => {
    const favorites = new Set(s.favorites);
    for (const { key } of entries) (on ? favorites.add(key) : favorites.delete(key));
    return { favorites };
  });
}

import { tagKeyOf } from './type-tags';

export async function setTag(entries: LibraryEntry[], name: string, on: boolean) {
  const tag = name.trim();
  if (!tag) return;
  const d = database();
  if (on) await snapshot(entries);
  await d.runAsync('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tag]);
  const row = await d.getFirstAsync<{ id: number }>('SELECT id FROM tags WHERE name = ?', [tag]);
  if (!row) return;
  const tagged = entries.map((e) => ({ key: tagKeyOf(e) }));
  await d.withTransactionAsync(async () => {
    for (const { key } of tagged) {
      if (on) await d.runAsync('INSERT OR IGNORE INTO item_tags (key, tag_id) VALUES (?, ?)', [key, row.id]);
      else await d.runAsync('DELETE FROM item_tags WHERE key = ? AND tag_id = ?', [key, row.id]);
    }
  });
  useUserData.setState((s) => {
    const tagsByKey = { ...s.tagsByKey };
    for (const { key } of tagged) {
      const current = new Set(tagsByKey[key] ?? []);
      if (on) current.add(tag);
      else current.delete(tag);
      tagsByKey[key] = [...current].sort();
    }
    const allTags = s.allTags.includes(tag) ? s.allTags : [...s.allTags, tag].sort();
    return { tagsByKey, allTags };
  });
}

export async function createAlbum(name: string): Promise<number | null> {
  const clean = name.trim();
  if (!clean) return null;
  const result = await database().runAsync(
    'INSERT INTO albums (name, offline, created_at) VALUES (?, 0, ?)',
    [clean, now()],
  );
  const id = result.lastInsertRowId;
  useUserData.setState((s) => ({ albums: [{ id, name: clean, offline: false }, ...s.albums] }));
  return id;
}

export async function deleteAlbum(id: number) {
  const d = database();
  await d.runAsync('DELETE FROM album_items WHERE album_id = ?', [id]);
  await d.runAsync('DELETE FROM albums WHERE id = ?', [id]);
  useUserData.setState((s) => {
    const albumKeys = { ...s.albumKeys };
    delete albumKeys[id];
    return { albums: s.albums.filter((a) => a.id !== id), albumKeys };
  });
}

/** Deletes only copies stored in this app's local library. Server/provider originals are never deleted here. */
export async function deleteLocalCopies(entries: LibraryEntry[]): Promise<number> {
  const provider = providerFor('local');
  if (!provider) return 0;
  let deleted = 0;
  for (const entry of entries) {
    const localRefs = entry.refs.filter((ref) => ref.sourceId === 'local');
    for (const ref of localRefs) {
      await provider.delete(ref.itemId);
      deleted += 1;
    }
    if (localRefs.length > 0 && entry.refs.length === localRefs.length) {
      const d = database();
      await d.withTransactionAsync(async () => {
        await d.runAsync('DELETE FROM favorites WHERE key = ?', [entry.key]);
        await d.runAsync('DELETE FROM item_tags WHERE key = ?', [entry.key]);
        await d.runAsync('DELETE FROM album_items WHERE key = ?', [entry.key]);
        await d.runAsync('DELETE FROM media_items WHERE key = ?', [entry.key]);
        await d.runAsync('DELETE FROM archive_item_meta WHERE key = ?', [entry.key]);
      });
    }
  }
  if (deleted > 0) {
    const deletedKeys = new Set(entries.filter((entry) => entry.refs.every((ref) => ref.sourceId === 'local')).map((entry) => entry.key));
    useUserData.setState((state) => {
      const favorites = new Set(state.favorites);
      const tagsByKey = { ...state.tagsByKey };
      const archiveMeta = { ...state.archiveMeta };
      const albumKeys = { ...state.albumKeys };
      for (const key of deletedKeys) {
        favorites.delete(key);
        delete tagsByKey[key];
        delete archiveMeta[key];
        for (const [id, keys] of Object.entries(albumKeys)) albumKeys[Number(id)] = keys.filter((itemKey) => itemKey !== key);
      }
      return { favorites, tagsByKey, archiveMeta, albumKeys };
    });
  }
  return deleted;
}

export async function setAlbumItems(id: number, entries: LibraryEntry[], on: boolean) {
  const d = database();
  if (on) await snapshot(entries);
  await d.withTransactionAsync(async () => {
    for (const { key } of entries) {
      if (on) await d.runAsync('INSERT OR IGNORE INTO album_items (album_id, key, added_at) VALUES (?, ?, ?)', [id, key, now()]);
      else await d.runAsync('DELETE FROM album_items WHERE album_id = ? AND key = ?', [id, key]);
    }
  });
  useUserData.setState((s) => {
    const keys = new Set(s.albumKeys[id] ?? []);
    for (const { key } of entries) (on ? keys.add(key) : keys.delete(key));
    return { albumKeys: { ...s.albumKeys, [id]: [...keys] } };
  });
}

export async function setAlbumOfflineFlag(id: number, offline: boolean) {
  await database().runAsync('UPDATE albums SET offline = ? WHERE id = ?', [offline ? 1 : 0, id]);
  useUserData.setState((s) => ({
    albums: s.albums.map((a) => (a.id === id ? { ...a, offline } : a)),
  }));
}

export async function putOffline(key: string, record: OfflineRecord) {
  await database().runAsync(
    `INSERT OR REPLACE INTO offline_items (key, source_id, item_id, uri, size, simulated, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [key, record.sourceId, record.itemId, record.uri, record.size, record.simulated ? 1 : 0, now()],
  );
  useUserData.setState((s) => ({ offline: { ...s.offline, [key]: record } }));
}

export async function dropOffline(key: string) {
  await database().runAsync('DELETE FROM offline_items WHERE key = ?', [key]);
  useUserData.setState((s) => {
    const offline = { ...s.offline };
    delete offline[key];
    return { offline };
  });
}

export function isDatabaseReady(): boolean {
  return db !== null;
}
