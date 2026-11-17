/**
 * The reference of a shared file. It is an opaque id that both phones agree on (`Shared/<id>/<name>`): nothing is stored on a
 * server under it any more; it only names the file in the encrypted messages, in the picture cache and in the sync state.
 * The prefix stays as it is because it is already saved in SQLite rows and in messages the partner's phone may still hold.
 */
export const SHARED_ROOT = 'Shared';

export const sharedFolder = (id: string) => `${SHARED_ROOT}/${id}`;

/** A file name that is safe as one path segment and keeps its extension (never empty). */
export function sharedFileName(name: string, fallback = 'photo.jpg'): string {
  const clean = name.replace(/[\\/:*?"<>|\0]/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return clean === '' ? fallback : clean;
}

/** Splits `Shared/<id>/<name>` into its folder and file name; null for anything else (also `..`). */
export function splitSharedPath(path: string): { folder: string; name: string } | null {
  const parts = path.split('/');
  if (parts.length < 3 || parts[0] !== SHARED_ROOT || parts.some((part) => part === '' || part === '..')) return null;
  return { folder: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
}
