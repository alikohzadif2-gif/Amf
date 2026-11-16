import { pickPhoneFiles } from '@/src/library/import-from-phone';
import { useLibraryIndex } from '@/src/library/index-store';
import { assetExtension, snapFileName, type PickedFile } from '@/src/media/pick-logic';
import type { MediaSource } from '@/src/media/pick';
import { DRIVE_SOURCE_ID } from '@/src/state/sources-store';
import { isDriveError, type DriveErrorKind } from './errors';
import { driveProvider } from './manage';

export type DriveAddResult = {
  cancelled: boolean;
  added: number;
  failed: number;
  /** Archive keys of the files that were uploaded (after the index was rebuilt): a memory attaches them. */
  keys: string[];
  /** The most useful reason when something failed (quota, signed out, offline ...). */
  error?: DriveErrorKind | 'camera-permission' | 'picker';
};

/** Gallery / Files / camera: what the person picked. Camera shots are named like the Snaps ones. */
async function pickFor(source: MediaSource): Promise<PickedFile[] | 'camera-permission'> {
  if (source !== 'camera') return pickPhoneFiles(source === 'files' ? 'files' : 'gallery', true);
  const picker = await import('expo-image-picker');
  const permission = await picker.requestCameraPermissionsAsync();
  if (!permission.granted) return 'camera-permission';
  const shot = await picker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = shot.canceled ? null : shot.assets[0];
  if (!asset) return [];
  return [{ uri: asset.uri, name: snapFileName(new Date(), assetExtension(asset)), size: asset.fileSize ?? 0 }];
}

/** Uploads files from the phone straight into a Google Drive folder (`parentId` null = the Archive's top folder). */
export async function addToDrive(source: MediaSource, parentId: string | null): Promise<DriveAddResult> {
  const provider = driveProvider();
  if (!provider) return { cancelled: false, added: 0, failed: 1, keys: [], error: 'unauthorized' };
  let picked: PickedFile[] | 'camera-permission';
  try {
    picked = await pickFor(source);
  } catch {
    return { cancelled: false, added: 0, failed: 1, keys: [], error: 'picker' };
  }
  if (picked === 'camera-permission') return { cancelled: false, added: 0, failed: 1, keys: [], error: 'camera-permission' };
  if (picked.length === 0) return { cancelled: true, added: 0, failed: 0, keys: [] };
  let added = 0;
  let failed = 0;
  const uploaded = new Set<string>();
  let error: DriveAddResult['error'];
  for (const file of picked) {
    try {
      const item = await provider.upload({ name: file.name, size: file.size, parentId, sourceUri: file.uri });
      uploaded.add(item.id);
      added += 1;
    } catch (e) {
      failed += 1;
      error = isDriveError(e) ? e.kind : 'http';
      if (isDriveError(e) && (e.kind === 'unauthorized' || e.kind === 'quota')) break; // the rest would fail the same way
    }
  }
  await useLibraryIndex.getState().build(true);
  const keys = uploaded.size === 0
    ? []
    : [...useLibraryIndex.getState().byKey.values()]
        .filter((entry) => entry.refs.some((ref) => ref.sourceId === DRIVE_SOURCE_ID && uploaded.has(ref.itemId)))
        .map((entry) => entry.key);
  return { cancelled: false, added, failed, keys, ...(failed > 0 ? { error } : {}) };
}

/** Makes a sub-folder in the open Drive folder and re-indexes. */
export async function createDriveFolder(name: string, parentId: string | null): Promise<boolean> {
  try {
    await driveProvider()?.createFolder(name, parentId);
    await useLibraryIndex.getState().build(true);
    return true;
  } catch {
    return false;
  }
}

/** Moves files/folders (by Drive id) to the Drive bin. Returns how many moved. */
export async function trashDriveItems(ids: string[]): Promise<number> {
  const provider = driveProvider();
  if (!provider) return 0;
  let moved = 0;
  for (const id of ids) {
    try {
      await provider.delete(id);
      moved += 1;
    } catch {
      // keep going: the count tells the rest
    }
  }
  await useLibraryIndex.getState().build(true);
  return moved;
}
