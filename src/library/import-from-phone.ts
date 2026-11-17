/**
 * Adds photos, videos and files from the phone to Direct (the vault), the app's one library.
 * Pickers: expo-image-picker (gallery) and expo-document-picker (files). Both hand back a cached copy;
 * it is copied into Direct (`src/vault/direct-add.ts`), with a small thumbnail made right away.
 */
import * as DocumentPicker from 'expo-document-picker';
import { VAULT_SOURCE_ID, useSourcesStore } from '@/src/state/sources-store';
import { getSharedDb } from '@/src/vault/db-ref';
import { addPickedToDirect } from '@/src/vault/direct-add';
import { vaultDirectory } from '@/src/vault/files';
import { relFromUri } from '@/src/vault/logic';
import { useLibraryIndex } from './index-store';
import { selectionLimitFor, toPickedFiles, type PickedFile } from '@/src/media/pick-logic';

export type ImportKind = 'gallery' | 'files';
export type ImportResult = {
  cancelled: boolean;
  /** Items copied into the library. */
  added: number;
  failed: number;
  /** Library keys of the added items, in pick order (null if the index could not find one). */
  keys: (string | null)[];
};

type Picked = PickedFile;

async function pick(kind: ImportKind, multiple: boolean, max?: number, imagesOnly = false): Promise<Picked[]> {
  if (kind === 'gallery') {
    const picker = await import('expo-image-picker');
    const res = await picker.launchImageLibraryAsync({
      mediaTypes: imagesOnly ? ['images'] : ['images', 'videos'],
      allowsMultipleSelection: multiple,
      selectionLimit: selectionLimitFor(multiple, max),
      allowsEditing: false,
      quality: 1,
      videoExportPreset: picker.VideoExportPreset.Passthrough,
    });
    if (res.canceled) return [];
    return toPickedFiles(res.assets, multiple ? max : 1);
  }
  const res = await DocumentPicker.getDocumentAsync({ multiple, copyToCacheDirectory: true, type: '*/*' });
  if (res.canceled) return [];
  const files = res.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size ?? 0 }));
  return max && max > 0 ? files.slice(0, max) : files;
}

/** Gallery or Files picker, then copy into the library (root folder). `max` limits how many items are taken. */
export async function importFromPhone(kind: ImportKind, multiple = true, max?: number, imagesOnly = false): Promise<ImportResult> {
  let picked: Picked[];
  try {
    picked = await pick(kind, multiple, max, imagesOnly);
  } catch {
    return { cancelled: false, added: 0, failed: 1, keys: [] };
  }
  if (picked.length === 0) return { cancelled: true, added: 0, failed: 0, keys: [] };
  return copyIntoLibrary(picked);
}

/**
 * Copies already-picked files (cache copies) into Direct (the vault), then rebuilds the index and returns the Library keys.
 * `folder` = a sub-folder of Direct (created if missing, e.g. `Snaps`). The picker's cache copy is removed afterwards.
 * Without the database (it is not open yet) nothing is copied and every file counts as failed.
 */
export async function copyIntoLibrary(picked: Picked[], folder?: string): Promise<ImportResult> {
  const db = getSharedDb();
  if (!db) return { cancelled: false, added: 0, failed: picked.length, keys: [] };
  const sources = useSourcesStore.getState();
  const direct = sources.sources.find((s) => s.id === VAULT_SOURCE_ID);
  if (direct && !direct.enabled) sources.setSourceEnabled(VAULT_SOURCE_ID, true); // else the new files would not show up

  const { rels, failed } = await addPickedToDirect(db, picked, folder);
  if (rels.length === 0) return { cancelled: false, added: 0, failed, keys: [] };

  await useLibraryIndex.getState().build(true);
  const entries = useLibraryIndex.getState().entries;
  const base = vaultDirectory().uri;
  const keyOfRel = new Map<string, string>();
  for (const entry of entries) {
    for (const ref of entry.refs) {
      if (ref.sourceId !== VAULT_SOURCE_ID || !ref.itemId.startsWith('fs:')) continue;
      const rel = relFromUri(ref.itemId.slice(3), base);
      if (rel) keyOfRel.set(rel, entry.key);
    }
  }
  return { cancelled: false, added: rels.length, failed, keys: rels.map((rel) => keyOfRel.get(rel) ?? null) };
}
