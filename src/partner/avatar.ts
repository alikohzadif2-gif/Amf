import { Directory, File, Paths } from 'expo-file-system';

export type AvatarSource = 'camera' | 'gallery';
/** `b64` = the tiny 64 px photo that travels in the profile message; `fullUri` (R10c) = this phone's private copy of the sharper one. */
export type AvatarResult = { b64?: string; fullUri?: string; /** The picker's own full-quality (cropped) image: only for showing a sharp preview right after picking; never stored or sent. */ previewUri?: string; cancelled?: boolean; error?: 'permission-camera' | 'failed' };

/** R10c: the sharper profile photo is a 512 px JPEG (about 30-60 KB) uploaded to `Shared/avatar-<deviceId>/`. */
export const AVATAR_FULL_WIDTH = 512;
export const AVATAR_FOLDER = 'avatars';

/** `avatar-k3j9x.jpg`: a stamp in the name gives a replaced photo a new server path, so a stale cache is never shown. */
export function avatarFileName(stamp: number = Date.now()): string {
  return `avatar-${stamp.toString(36)}.jpg`;
}

/** Shrinks a picked image to a 64 px JPEG (base64) so it fits in one mailbox message. */
async function shrink(uri: string): Promise<string | null> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const ref = await ImageManipulator.manipulate(uri).resize({ width: 64, height: 64 }).renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.4, base64: true });
  return out.base64 ?? null;
}

/** The sharper copy: 512 px (never enlarged), re-encoded (EXIF/GPS gone), kept in the app's documents folder. Null when it fails. */
async function keepFull(uri: string, width?: number): Promise<string | null> {
  try {
    const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
    let context = ImageManipulator.manipulate(uri);
    if ((width ?? AVATAR_FULL_WIDTH + 1) > AVATAR_FULL_WIDTH) context = context.resize({ width: AVATAR_FULL_WIDTH });
    const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    const dir = new Directory(Paths.document, AVATAR_FOLDER);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const name = avatarFileName();
    new File(saved.uri).copy(new File(dir, name));
    return new File(dir, name).uri;
  } catch {
    return null; // the tiny photo still works
  }
}

/** Deletes a private copy that is no longer used (a replaced or removed photo). Never throws. */
export function discardAvatar(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // a leftover file is harmless
  }
}

/** Picks a photo and shrinks it to a ~64 px JPEG (base64) so it fits in one mailbox message. */
export async function pickAvatar(): Promise<string | null> {
  try {
    const picker = await import('expo-image-picker');
    const res = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
    if (res.canceled || !res.assets[0]) return null;
    return await shrink(res.assets[0].uri);
  } catch {
    return null;
  }
}

/**
 * Profile photo from the camera or the gallery (onboarding, U9; profile screen). The picked image is NOT copied into the library
 * (a profile photo is not a snap). It gives the tiny 64 px photo for the message and, since R10c, a sharper private copy.
 * Reports why it failed instead of failing silently.
 */
export async function pickAvatarFrom(source: AvatarSource): Promise<AvatarResult> {
  try {
    const picker = await import('expo-image-picker');
    const options = { mediaTypes: ['images'] as ['images'], allowsEditing: true, aspect: [1, 1] as [number, number], quality: 1 };
    if (source === 'camera') {
      const perm = await picker.requestCameraPermissionsAsync();
      if (!perm.granted) return { error: 'permission-camera' };
    }
    const res = source === 'camera' ? await picker.launchCameraAsync(options) : await picker.launchImageLibraryAsync(options);
    if (res.canceled || !res.assets[0]) return { cancelled: true };
    const asset = res.assets[0];
    const b64 = await shrink(asset.uri);
    if (!b64) return { error: 'failed' };
    const fullUri = await keepFull(asset.uri, asset.width);
    return fullUri ? { b64, fullUri, previewUri: asset.uri } : { b64, previewUri: asset.uri };
  } catch {
    return { error: 'failed' };
  }
}
