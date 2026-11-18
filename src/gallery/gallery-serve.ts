import type { SQLiteDatabase } from 'expo-sqlite';
import { makeVariant, makeVideoPoster } from '../partner/media-make';
import { isImageName, type Rendered } from '../partner/media-logic';
import { isVideoName } from '../partner/orig-logic';
import { itemById } from '../vault/db';
import { vaultFile } from '../vault/files';
import { ensureThumb } from '../vault/thumbs';
import { galleryRef } from './gallery-ref';
import { ID_PATTERN } from './gallery-messages';

/**
 * Shared gallery, stage 3 (sender): the small picture (<= 30 KB JPEG, 320 px, re-encoded so no EXIF/GPS) of one gallery file, for the partner's
 * request. It starts from the vault's own cached thumbnail (a small file, cheap to decode), falls back to the file itself when that thumbnail
 * cannot be made, and for a video to a frame. Null when the file is not in the gallery any more or no picture could be made.
 */
export async function renderGalleryThumb(db: SQLiteDatabase, id: string): Promise<{ ref: string; rendered: Rendered } | null> {
  if (!ID_PATTERN.test(id)) return null;
  const item = await itemById(db, id);
  if (!item || item.state !== 'hidden') return null;
  const video = isVideoName(item.rel);
  if (!video && !isImageName(item.rel)) return null;
  const cached = await ensureThumb(item.rel, video ? 'video' : 'image', 320);
  let rendered = cached ? await makeVariant(cached, 'thumb') : null;
  if (!rendered) {
    const uri = vaultFile(item.rel).uri;
    rendered = video ? await makeVideoPoster(uri) : await makeVariant(uri, 'thumb');
  }
  return rendered ? { ref: galleryRef(id, item.rel), rendered } : null;
}
