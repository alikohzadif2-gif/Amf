/**
 * Folders whose contents belong to the app itself, not to the Archive: `Shared` (what the partner and I
 * exchange) and `Snaps` / `Snap` (camera shots). Their files are visible only when that folder is opened in
 * Folders; they never appear in the album grid, search, tags, favourites-by-tag, periods or manual albums.
 * Matching is by folder NAME (any depth, any source), case-insensitive.
 */
const HIDDEN = new Set(['shared', 'snap', 'snaps']);

export function isHiddenFolderName(name: string): boolean {
  return HIDDEN.has(name.trim().toLocaleLowerCase());
}

/** Keys of library files that live ONLY in hidden folders. Rebuilt with every index build. */
export const hiddenKeys = new Set<string>();

/** Item ref id (`sourceId` + `itemId`) used to remember which concrete files sit in a hidden folder. */
export const refId = (sourceId: string, itemId: string): string => `${sourceId}\u0000${itemId}`;
