import { decodeBatch, type GalleryEntry } from './manifest';

/** Ids asked for in one thumbnail request. */
export const THUMB_REQ_MAX_IDS = 8;
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ID_RE = ID_PATTERN;

/**
 * Shared gallery messages, data only (silent, never a notification).
 *  - `gallery-manifest`: the partner's file list, see `manifest.ts` (decoded form: the inflated, validated entries and removed ids).
 *  - `gallery-thumb-req` (stage 3): "send me the small pictures of these files" (<= 8 ids). The answer is an ordinary `media` message
 *    (kind `thumb`) per file, named `Shared/<id>/<name>`; a file that cannot be served is simply not answered.
 */
export type GalleryManifestMessage = { from: string; ts: string; silent: true; t: 'gallery-manifest'; entries: GalleryEntry[]; gone: string[] };
export type GalleryThumbRequest = { from: string; ts: string; silent: true; t: 'gallery-thumb-req'; ids: string[] };
export type GalleryMessage = GalleryManifestMessage | GalleryThumbRequest;

/** Undefined when `d.t` is not a gallery message, null when it is one but invalid. */
export function decodeGallery(d: Record<string, unknown>, base: { from: string; ts: string }): GalleryMessage | null | undefined {
  if (d.t === 'gallery-manifest') {
    const batch = decodeBatch(d.z, d.n);
    return batch ? { ...base, silent: true, t: 'gallery-manifest', entries: batch.entries, gone: batch.gone } : null;
  }
  if (d.t === 'gallery-thumb-req') {
    if (!Array.isArray(d.ids) || d.ids.length < 1 || d.ids.length > THUMB_REQ_MAX_IDS) return null;
    const ids: string[] = [];
    for (const id of d.ids) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      if (!ids.includes(id)) ids.push(id);
    }
    return { ...base, silent: true, t: 'gallery-thumb-req', ids };
  }
  return undefined;
}
