import { SHARED_ROOT, sharedFileName, splitSharedPath } from '../partner/media-ref';
import { splitGalleryPath } from './gallery-logic';

/**
 * Shared gallery, stage 3: a gallery file is named in the picture messages like every other shared file, `Shared/<item id>/<name>`.
 * Both phones compute it the same way (the id is the manifest's id, the name is the file name of the manifest path), so the existing
 * thumbnail cache, preview request and "Full quality" flow work for gallery files without a second naming scheme.
 */
export function galleryRef(id: string, path: string): string {
  return `${SHARED_ROOT}/${id}/${sharedFileName(splitGalleryPath(path).name)}`;
}

/** The item id inside a gallery ref, or null for anything that is not `Shared/<id>/<name>`. */
export function idOfGalleryRef(ref: string): string | null {
  const parts = splitSharedPath(ref);
  if (!parts) return null;
  const segments = parts.folder.split('/');
  return segments.length === 2 && /^[A-Za-z0-9_-]{8,64}$/.test(segments[1]) ? segments[1] : null;
}
