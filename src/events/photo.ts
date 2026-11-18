/**
 * Event photo (R2). Picked with expo-image-picker (gallery or camera), re-encoded once with expo-image-manipulator (smaller, and the
 * EXIF/GPS data is gone) and kept as a private copy in the app's documents folder. It is NOT added to the Library. The partner gets
 * it through the `Shared/<id>/` upload (src/partner/manage.ts `shareFile`).
 */
import { Directory, File, Paths } from 'expo-file-system';

export const EVENT_PHOTO_MAX_WIDTH = 1600;
export const EVENT_PHOTO_FOLDER = 'event-photos';

export type EventPhotoResult = { uri: string; name: string } | { cancelled: true } | { error: 'permission-camera' | 'failed' };

/** `ev1234-k3j9x.jpg`: the event id plus a stamp, so a replaced photo gets a new server path (and a stale cache is never shown). */
export function eventPhotoName(eventId: string, stamp: number = Date.now()): string {
  return `${eventId.replace(/[^A-Za-z0-9_-]/g, '')}-${stamp.toString(36)}.jpg`;
}

export async function pickEventPhoto(source: 'camera' | 'gallery', eventId: string): Promise<EventPhotoResult> {
  try {
    const picker = await import('expo-image-picker');
    let asset: { uri: string; width?: number } | undefined;
    if (source === 'camera') {
      const perm = await picker.requestCameraPermissionsAsync();
      if (!perm.granted) return { error: 'permission-camera' };
      const res = await picker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled) return { cancelled: true };
      asset = res.assets[0];
    } else {
      const res = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 1 });
      if (res.canceled) return { cancelled: true };
      asset = res.assets[0];
    }
    if (!asset) return { cancelled: true };
    const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
    let context = ImageManipulator.manipulate(asset.uri);
    if ((asset.width ?? EVENT_PHOTO_MAX_WIDTH + 1) > EVENT_PHOTO_MAX_WIDTH) context = context.resize({ width: EVENT_PHOTO_MAX_WIDTH }); // never enlarge a small photo
    const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    const dir = new Directory(Paths.document, EVENT_PHOTO_FOLDER);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const name = eventPhotoName(eventId);
    new File(saved.uri).copy(new File(dir, name));
    return { uri: new File(dir, name).uri, name };
  } catch {
    return { error: 'failed' };
  }
}

/** Deletes a private copy that is no longer used (a replaced or removed photo). Never throws. */
export function discardEventPhoto(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // a leftover file is harmless
  }
}
