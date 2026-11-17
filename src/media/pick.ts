/**
 * Media pick kit (U7): gallery + camera → Direct (the vault) → Library keys.
 * Ready-made: expo-image-picker (system photo picker / camera). Our code is glue:
 * the picked cache copy is copied into Direct (`copyIntoLibrary` → `src/vault/direct-add.ts`), camera shots into the visible `Camera` folder.
 * Not built: saving to the phone gallery.
 */
import { copyIntoLibrary, importFromPhone, type ImportKind, type ImportResult } from '@/src/library/import-from-phone';
import { CAMERA_FOLDER, SNAPS_FOLDER, assetExtension, pickErrorCode, snapFileName, type PickErrorCode } from './pick-logic';

export type { PickErrorCode } from './pick-logic';
export { CAMERA_FOLDER, SNAPS_FOLDER } from './pick-logic';

export type MediaSource = 'camera' | 'gallery' | 'files';

/** Same shape as an import result, plus a code when something went wrong (cancelled and error never both). */
export type PickResult = ImportResult & { error?: PickErrorCode };

const EMPTY: PickResult = { cancelled: false, added: 0, failed: 0, keys: [] };
const cancelled = (): PickResult => ({ ...EMPTY, cancelled: true });
const failedWith = (error: PickErrorCode): PickResult => ({ ...EMPTY, failed: 1, error });

/** Photos/videos from the gallery (system picker, no storage permission needed on Android 13+). `max` caps the count. */
export async function pickFromGallery(options: { multiple?: boolean; max?: number; imagesOnly?: boolean } = {}): Promise<PickResult> {
  const { multiple = true, max, imagesOnly = false } = options;
  const res = await importFromPhone('gallery', multiple, max, imagesOnly);
  if (!res.cancelled && res.added === 0 && res.failed > 0) return { ...res, error: 'failed' };
  return res;
}

/** Takes one photo with the camera and stores it in the visible `Camera` folder of Direct. */
export async function captureFromCamera(): Promise<PickResult> {
  try {
    const picker = await import('expo-image-picker');
    const perm = await picker.requestCameraPermissionsAsync();
    if (!perm.granted) return failedWith('permission-camera');
    const res = await picker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled || !res.assets[0]) return cancelled();
    const asset = res.assets[0];
    const out = await copyIntoLibrary(
      [{ uri: asset.uri, name: snapFileName(new Date(), assetExtension(asset)), size: asset.fileSize ?? 0 }],
      CAMERA_FOLDER,
    );
    return out.added === 0 ? { ...out, error: 'failed' } : out;
  } catch (e) {
    return failedWith(pickErrorCode(e));
  }
}

/** One entry point for the source sheet: camera, gallery or (where relevant) files. */
export async function pickFromSource(
  source: MediaSource,
  options: { multiple?: boolean; max?: number; imagesOnly?: boolean } = {},
): Promise<PickResult> {
  if (source === 'camera') return captureFromCamera();
  const kind: ImportKind = source === 'files' ? 'files' : 'gallery';
  if (kind === 'gallery') return pickFromGallery(options);
  const res = await importFromPhone('files', options.multiple ?? true, options.max);
  return !res.cancelled && res.added === 0 && res.failed > 0 ? { ...res, error: 'failed' } : res;
}
