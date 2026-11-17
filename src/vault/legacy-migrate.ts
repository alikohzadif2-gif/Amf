/**
 * Stage 2A-3: one-time, non-destructive move of the OLD library into Direct (the vault).
 *  1. every file of the old app folder `meyou-library` and every gallery picture that memories/albums/favourites/tags point at is COPIED
 *     into Direct (verified by size, thumbnail started; `addPickedToDirect`). Nothing is deleted or overwritten, originals stay.
 *  2. the Library index is rebuilt, and each old key (md5, else name+size+mtime) is replaced by the key of its Direct copy in
 *     favourites, tags, albums, Archive dates/categories, memories (`diary.media_keys`) and events, so no user data is lost.
 * Progress is saved after every file, so a kill in the middle only repeats what is left. Runs in the background at app start.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useLibraryIndex } from '@/src/library/index-store';
import { loadUserData } from '@/src/library/user-data';
import { VAULT_SOURCE_ID, useSourcesStore } from '@/src/state/sources-store';
import { addPickedToDirect } from './direct-add';
import { vaultDirectory, vaultFile } from './files';
import {
  LEGACY_FOLDER, MAX_LEGACY_ATTEMPTS, firstLocalRef, isLegacyOnly, legacyTarget, parseLegacyState, parseRefs, planRemap, remapKeysJson,
  type LegacyState,
} from './legacy-logic';
import { relFromUri } from './logic';

const STATE_KEY = 'meyou-legacy-direct-v1';
export type LegacyReport = { copied: number; skipped: number; remapped: number; done: boolean };

let running = false;
const save = (state: LegacyState) => AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));

async function galleryUri(assetId: string): Promise<string | null> {
  try {
    const lib = await import('expo-media-library');
    const perm = await lib.getPermissionsAsync(false, ['photo', 'video']);
    if (!perm.granted) return null; // never ask here: this runs silently at start-up
    return await new lib.Asset(assetId).getUri();
  } catch {
    return null;
  }
}

/** Every file below the old app folder, as `{ uri, name, folder }` (folder = its sub-folders joined, or none). */
function legacyFolderFiles(): { itemId: string; name: string }[] {
  const out: { itemId: string; name: string }[] = [];
  try {
    const root = new Directory(Paths.document, LEGACY_FOLDER);
    if (!root.exists) return out;
    const walk = (dir: Directory) => {
      for (const entry of dir.list()) {
        if (entry instanceof Directory) walk(entry);
        else if (!entry.name.startsWith('.')) out.push({ itemId: `fs:${entry.uri}`, name: entry.name });
      }
    };
    walk(root);
  } catch {
    // an unreadable folder: nothing to copy from it
  }
  return out;
}

async function keysByRel(): Promise<Map<string, string>> {
  await useLibraryIndex.getState().build(true);
  const base = vaultDirectory().uri;
  const map = new Map<string, string>();
  for (const entry of useLibraryIndex.getState().entries) {
    for (const ref of entry.refs) {
      if (ref.sourceId !== VAULT_SOURCE_ID || !ref.itemId.startsWith('fs:')) continue;
      const rel = relFromUri(ref.itemId.slice(3), base);
      if (rel) map.set(rel, entry.key);
    }
  }
  return map;
}

/** Replaces old keys in every table that stores a Library key. Only updates; a clash keeps the existing row. */
async function applyRemap(db: SQLiteDatabase, map: ReadonlyMap<string, string>): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const [oldKey, newKey] of map) {
      for (const table of ['favorites', 'item_tags', 'album_items', 'archive_item_meta']) {
        try {
          await db.runAsync(`UPDATE OR IGNORE ${table} SET key = ? WHERE key = ?`, [newKey, oldKey]);
          await db.runAsync(`DELETE FROM ${table} WHERE key = ?`, [oldKey]); // only a row that clashed with an existing one is left
        } catch {
          // the table may not exist yet on a fresh install
        }
      }
      await db.runAsync('UPDATE events SET media_key = ? WHERE media_key = ?', [newKey, oldKey]);
      await db.runAsync('DELETE FROM media_items WHERE key = ?', [oldKey]); // its snapshot pointed at the old gallery source
    }
    const rows = await db.getAllAsync<{ id: string; media_keys: string }>(`SELECT id, media_keys FROM diary WHERE media_keys != '[]'`);
    for (const row of rows) {
      const next = remapKeysJson(row.media_keys, map);
      if (next.changed) await db.runAsync('UPDATE diary SET media_keys = ? WHERE id = ?', [next.json, row.id]);
    }
  });
}

function removeVerifiedLegacyFiles(state: LegacyState): void {
  for (const [uri, rel] of Object.entries(state.src)) {
    try {
      const old = new File(uri);
      const copy = vaultFile(rel);
      if (!old.exists) {
        delete state.src[uri];
      } else if (copy.exists && (copy.size ?? -1) === old.size && old.size > 0) {
        old.delete();
        delete state.src[uri];
      }
    } catch {
      // leave it: the next launch checks again
    }
  }
  try {
    const root = new Directory(Paths.document, LEGACY_FOLDER);
    if (root.exists && Object.keys(state.src).length === 0) {
      const hasFile = (dir: Directory): boolean => dir.list().some((e) => (e instanceof Directory ? hasFile(e) : true));
      if (!hasFile(root)) root.delete(); // only empty folders are left
    }
  } catch {
    // ignore
  }
}

export async function runLegacyMigration(db: SQLiteDatabase): Promise<LegacyReport | null> {
  if (running) return null;
  const state = parseLegacyState(await AsyncStorage.getItem(STATE_KEY));
  if (state.done) return null;
  running = true;
  try {
    const sources = useSourcesStore.getState();
    if (sources.sources.some((s) => s.id === VAULT_SOURCE_ID && !s.enabled)) sources.setSourceEnabled(VAULT_SOURCE_ID, true);

    // what must be copied: user-data snapshots that live only on the old source, then loose files in the old app folder
    const rows = await db.getAllAsync<{ key: string; name: string; refs: string }>('SELECT key, name, refs FROM media_items');
    const jobs: { oldKey: string | null; itemId: string; name: string }[] = [];
    for (const row of rows) {
      const refs = parseRefs(row.refs);
      const local = firstLocalRef(refs);
      if (local && isLegacyOnly(refs) && !state.copied[row.key]) jobs.push({ oldKey: row.key, itemId: local.itemId, name: row.name });
    }
    // loose files of the old folder are copied once; those a snapshot already covers are not copied a second time
    const covered = new Set(rows.flatMap((row) => parseRefs(row.refs).map((r) => r.itemId)));
    const loose = state.copied['*loose*'] ? [] : legacyFolderFiles().filter((f) => !covered.has(f.itemId));
    for (const f of loose) jobs.push({ oldKey: null, itemId: f.itemId, name: f.name });

    let copied = 0;
    let skipped = 0;
    for (const job of jobs) {
      const uri = job.itemId.startsWith('fs:') ? job.itemId.slice(3) : job.itemId.startsWith('ml:asset:') ? await galleryUri(job.itemId.slice('ml:asset:'.length)) : null;
      let ok = false;
      try {
        if (uri && new File(uri).exists) {
          const target = legacyTarget(job.itemId, job.name);
          const res = await addPickedToDirect(db, [{ uri, name: target.name, size: new File(uri).size ?? 0 }], target.folder);
          if (res.rels[0]) {
            ok = true;
            if (job.oldKey) state.copied[job.oldKey] = res.rels[0];
            if (job.itemId.startsWith('fs:') && uri.includes(`/${LEGACY_FOLDER}/`)) state.src[uri] = res.rels[0];
          }
        }
      } catch {
        ok = false;
      }
      if (ok) copied += 1;
      else skipped += 1;
      if (ok) await save(state);
    }
    state.copied['*loose*'] = '1'; // one pass over the loose files only, a retry never copies them again

    let remapped = 0;
    const realCopies = Object.fromEntries(Object.entries(state.copied).filter(([k]) => k !== '*loose*'));
    if (Object.keys(realCopies).length > 0) {
      const keyOfRel = await keysByRel();
      const plan = planRemap(realCopies, keyOfRel);
      if (plan.size > 0) {
        await applyRemap(db, plan);
        remapped = plan.size;
        await loadUserData(db);
      }
      // finished = the copy was found in the index (its key changed and was rewritten, or it stayed the same)
      for (const [oldKey, rel] of Object.entries(realCopies)) if (keyOfRel.has(rel)) delete state.copied[oldKey];
    }

    const left = Object.keys(state.copied).length; // keys copied but not yet remapped (the index could not find them) also count as unfinished
    state.attempts += 1;
    state.done = (skipped === 0 && left <= 1) || state.attempts >= MAX_LEGACY_ATTEMPTS;
    // The old app-folder copies are removed only when everything is copied and every key is rewritten, and each one only after
    // its Direct copy exists with the same size. Gallery pictures are never touched.
    if (state.done && skipped === 0 && left <= 1) removeVerifiedLegacyFiles(state);
    await save(state);
    return { copied, skipped, remapped, done: state.done };
  } catch {
    return null; // never block the app; the next launch continues
  } finally {
    running = false;
  }
}

