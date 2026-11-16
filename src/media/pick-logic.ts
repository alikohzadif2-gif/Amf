/** Pure helpers of the media pick kit (no React Native imports, so they are unit-tested in scripts/test-media.mjs). */

/** Camera shots go into this folder of the app library (UI_PHASES Q7). */
export const SNAPS_FOLDER = 'Snaps';

export type PickErrorCode = 'permission-camera' | 'unavailable' | 'failed';

export type PickedFile = { uri: string; name: string; size: number };

type AssetLike = { uri: string; fileName?: string | null; fileSize?: number | null; mimeType?: string | null };

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** `snap-20261016-134502.jpg` (UTC, so the name does not depend on the phone's time zone). */
export function snapFileName(now: Date, ext = 'jpg'): string {
  const cleanExt = ext.replace(/^\./, '').toLowerCase() || 'jpg';
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `snap-${d}-${t}.${cleanExt}`;
}

/** A unique name so two picks with the same file name never overwrite each other. */
export function uniqueName(name: string, n: number, stamp: number = Date.now()): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem}-${stamp.toString(36)}${n}${ext}`;
}

/** File extension of a picked asset: from its name, else its mime type, else its uri; `fallback` if nothing is known. */
export function assetExtension(asset: AssetLike, fallback = 'jpg'): string {
  const fromName = (s: string | null | undefined) => {
    const base = (s ?? '').split('?')[0].split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : null;
  };
  const byName = fromName(asset.fileName) ?? fromName(asset.uri);
  if (byName && /^[a-z0-9]{2,5}$/.test(byName)) return byName;
  const mime = (asset.mimeType ?? '').toLowerCase();
  if (mime === 'image/jpeg') return 'jpg';
  if (mime.startsWith('image/') || mime.startsWith('video/')) return mime.split('/')[1].replace(/[^a-z0-9]/g, '') || fallback;
  return fallback;
}

/** Turns picker assets into files to import; `max` (> 0) keeps only the first `max`. */
export function toPickedFiles(assets: AssetLike[], max = 0): PickedFile[] {
  const list = max > 0 ? assets.slice(0, max) : assets;
  return list.map((a) => {
    const name = a.fileName ?? a.uri.split('/').pop() ?? 'media';
    const hasExtension = /\.[a-z0-9]{2,5}$/i.test(name);
    return {
      uri: a.uri,
      name: hasExtension ? name : `${name}.${assetExtension(a)}`,
      size: a.fileSize ?? 0,
    };
  });
}

/** `selectionLimit` for expo-image-picker: 1 for single pick, else `max` (0 = no limit). */
export function selectionLimitFor(multiple: boolean, max?: number): number {
  if (!multiple) return 1;
  return max && max > 0 ? Math.floor(max) : 0;
}

/** Maps an error thrown by a picker/permission call to a code the UI shows as text. */
export function pickErrorCode(e: unknown): PickErrorCode {
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? '').toLowerCase();
  if (msg.includes('cannot find module') || msg.includes('native module') || msg.includes('not available') || msg.includes('unavailable')) {
    return 'unavailable';
  }
  return 'failed';
}

/** i18n key of the friendly message for each error code. */
export function pickErrorKey(code: PickErrorCode): 'mediaCameraDenied' | 'mediaUnavailable' | 'mediaPickFailed' {
  if (code === 'permission-camera') return 'mediaCameraDenied';
  if (code === 'unavailable') return 'mediaUnavailable';
  return 'mediaPickFailed';
}
