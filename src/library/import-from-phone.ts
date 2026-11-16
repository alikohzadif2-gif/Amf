/**
 * Adds photos, videos and files from the phone to the meYou library.
 * Pickers: expo-image-picker (gallery) and expo-document-picker (files). Both hand back a cached copy;
 * it is copied into the app's own library folder through the existing local provider (`upload`).
 */
import * as DocumentPicker from 'expo-document-picker';
import { useSourcesStore } from '@/src/state/sources-store';
import { getProvider } from '@/src/storage/registry';
import { useLibraryIndex } from './index-store';
import { selectionLimitFor, toPickedFiles, uniqueName, type PickedFile } from '@/src/media/pick-logic';

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

/** Gallery or Files picker only (no copy into the library): the cache copies the pickers hand back. */
export async function pickPhoneFiles(kind: ImportKind, multiple = true, max?: number, imagesOnly = false): Promise<Picked[]> {
  return pick(kind, multiple, max, imagesOnly);
}

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
 * Copies already-picked files (cache copies) into the app's library folder through the local provider, then
 * rebuilds the index and returns the Library keys. `folder` = a sub-folder of the library (created if missing,
 * e.g. `Snaps`); if it cannot be created the files go to the library root with a `snap-` style name kept.
 */
export async function copyIntoLibrary(picked: Picked[], folder?: string): Promise<ImportResult> {
  const sources = useSourcesStore.getState();
  const local = sources.sources.find((s) => s.id === 'local');
  if (local && !local.enabled) sources.setSourceEnabled('local', true); // else the new files would not show up
  const provider = getProvider(local ?? { id: 'local', kind: 'local', backend: 'real', enabled: true, builtIn: true });

  let parentId: string | null = null;
  if (folder && provider.createFolder) {
    try {
      parentId = (await provider.createFolder(folder, null)).id;
    } catch {
      parentId = null; // fallback: library root
    }
  }

  const itemIds: string[] = [];
  let failed = 0;
  for (const [i, p] of picked.entries()) {
    try {
      const item = await provider.upload({ name: parentId ? p.name : uniqueName(p.name, i), size: p.size, parentId, sourceUri: p.uri });
      itemIds.push(item.id);
    } catch {
      failed += 1;
    }
  }

  await useLibraryIndex.getState().build(true);
  const entries = useLibraryIndex.getState().entries;
  const keys = itemIds.map((id) => entries.find((e) => e.refs.some((r) => r.sourceId === 'local' && r.itemId === id))?.key ?? null);
  return { cancelled: false, added: itemIds.length, failed, keys };
}
