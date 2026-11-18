import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useLibraryIndex } from '@/src/library/index-store';
import { sortRefs, type LibraryEntry } from '@/src/library/merge';
import { providerFor, sourceKinds } from '@/src/library/providers';
import { entriesFromSnapshots, loadUserData, setArchiveMetadata, useUserData } from '@/src/library/user-data';
import { isLocalUri } from '@/src/media/originals';
import { originalSource } from '@/src/storage/original';
import { DIARY_NO_CATEGORY } from './categories';
import { planArchiveCategory } from './archive-category';

/**
 * Q1: a memory's `mediaKeys` are Library keys (not file paths). To send a memory the original has to become a readable phone
 * file: an offline copy, a phone file as it is, or (server-only items) a temporary download that `release` deletes afterwards.
 * Existing pieces only: Library index/snapshots, `originalSource`, `File.downloadFileAsync`.
 */
export type MediaFile = { uri: string; name: string; release: () => void };

async function entryFor(key: string): Promise<LibraryEntry | null> {
  const indexed = useLibraryIndex.getState().byKey.get(key);
  if (indexed) return indexed;
  return (await entriesFromSnapshots([key]))[0] ?? null;
}

export async function resolveMediaFile(key: string): Promise<MediaFile | null> {
  const entry = await entryFor(key);
  const name = entry?.item.name || 'media';
  const offline = useUserData.getState().offline[key];
  if (offline) {
    try {
      if (new File(offline.uri).exists) return { uri: offline.uri, name, release: () => undefined };
    } catch {
      // the offline copy is gone: use the original
    }
  }
  if (!entry) return null;
  for (const ref of sortRefs(entry.refs, sourceKinds())) {
    const provider = providerFor(ref.sourceId);
    if (!provider) continue;
    let source: Awaited<ReturnType<typeof originalSource>> = null;
    try {
      source = await originalSource(provider, ref.itemId);
    } catch {
      continue; // this source is unreachable: try the next one
    }
    if (!source) continue;
    if (isLocalUri(source.uri)) return { uri: source.uri, name, release: () => undefined };
    try {
      const dir = new Directory(Paths.cache, 'meyou-share');
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, `${Date.now().toString(36)}-${name.replace(/[^\w.\-]+/g, '_').slice(-60)}`);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(source.uri, target, { headers: source.headers });
      return {
        uri: file.uri,
        name,
        release: () => {
          try {
            if (file.exists) file.delete();
          } catch {
            // a leftover cache file is harmless
          }
        },
      };
    } catch {
      // try the next source
    }
  }
  return null;
}

/**
 * Q2: files the memory's photos/videos under the memory's category in the Archive (see `planArchiveCategory`).
 * It never blocks or fails a save: a problem here only means the Archive keeps its old category.
 */
export async function syncMemoryCategoryToArchive(keys: readonly string[], category: string, previous?: string, db?: SQLiteDatabase): Promise<void> {
  try {
    // The Archive data is only loaded once the Library screen was opened; without it the category was silently never written.
    if (db && !useUserData.getState().loaded) await loadUserData(db);
    const plan = planArchiveCategory(keys, category, previous, useUserData.getState().archiveMeta);
    if (plan.set.length > 0) await setArchiveMetadata(plan.set.map((key) => ({ key })), { category });
    if (plan.clear.length > 0) await setArchiveMetadata(plan.clear.map((key) => ({ key })), { category: DIARY_NO_CATEGORY });
  } catch {
    // the memory itself is saved; the Archive category can still be set by hand
  }
}
