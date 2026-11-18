/**
 * Shared gallery (stages 2-3): small pure rules for the sender's batching and the partner's folder listing. No phone APIs; tested in Node.
 */
import { naturalCompare } from '../vault/logic';

/** The parent folder of a gallery path (`''` = the root) and its last segment. */
export function splitGalleryPath(path: string): { parent: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { parent: '', name: path } : { parent: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** Every folder above a file, shallowest first: `a/b/c.jpg` -> `a`, `a/b`. A file in the root has none. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** The SQL range that covers a folder's whole subtree on an indexed `path` column: `path >= low AND path < high` (`/` is followed by `0`). */
export const subtreeRange = (folder: string): { low: string; high: string } => ({ low: `${folder}/`, high: `${folder}0` });

/**
 * When the sender should push the manifest of the files copied so far: after `everyCount` new files or `everyMs` since the last push
 * (and at once for the very first file, so the partner sees the first folder while the copy is still running).
 */
export function createFlushGate(everyCount = 50, everyMs = 3000, clock: () => number = Date.now) {
  let pending = 0;
  let last = 0;
  let first = true;
  return {
    /** One more file landed. True = push now. */
    note(): boolean {
      pending += 1;
      const now = clock();
      if (first || pending >= everyCount || now - last >= everyMs) {
        first = false;
        pending = 0;
        last = now;
        return true;
      }
      return false;
    },
    /** A push was made outside the gate (job end, app start). */
    reset(): void {
      pending = 0;
      last = clock();
      first = false;
    },
  };
}

/** Sub-folders in the order a file manager lists them. */
export function sortFolderNames<T extends { name: string }>(folders: readonly T[]): T[] {
  return [...folders].sort((a, b) => naturalCompare(a.name, b.name));
}

export type PageWindow = { folderFrom: number; folderTo: number; fileFrom: number; fileTo: number };

/**
 * One page of a folder's content, `limit` rows starting at row `offset`: sub-folders first (all of them come before any file), then files.
 * Gives the slice of each list to read (`[from, to)`), so a folder with 3000 files reads only the rows of the page.
 */
export function pageWindow(folderCount: number, fileCount: number, offset: number, limit: number): PageWindow {
  const start = Math.max(0, Math.floor(offset));
  const size = Math.max(0, Math.floor(limit));
  const end = Math.min(folderCount + fileCount, start + size);
  const folderFrom = Math.min(start, folderCount);
  const folderTo = Math.min(end, folderCount);
  const fileFrom = Math.max(0, Math.min(start - folderCount, fileCount));
  const fileTo = Math.max(0, Math.min(end - folderCount, fileCount));
  return { folderFrom, folderTo, fileFrom, fileTo };
}

/** The partner's gallery grid: 3 columns, a small gap, one page of rows read at a time. */
export const GALLERY_COLUMNS = 3;
export const GALLERY_GAP = 6;
export const GALLERY_PAGE = 60;

/** Width of one tile for a screen `width` wide with `sidePadding` in total on both sides. */
export function galleryTileWidth(width: number, sidePadding: number, columns = GALLERY_COLUMNS, gap = GALLERY_GAP): number {
  return Math.max(60, Math.floor((width - sidePadding - gap * (columns - 1)) / columns));
}
