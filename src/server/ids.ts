/**
 * Provider ids for the file server. The server addresses thumbnails/files by
 * its own item id but lists folders by (root, path), so our ids carry both and
 * stay valid after an app restart:
 *   dir  -> d:<root>:<path>            (roots are dirs with an empty path)
 *   file -> f:<root>:<serverId>:<path> (path includes the file name)
 * Every part is URI-encoded, so ':' never appears inside a part.
 */
export type DirRef = { rootId: string; path: string };
export type FileRef = { rootId: string; serverId: string; path: string };

const enc = encodeURIComponent;
const dec = decodeURIComponent;

export function dirId(rootId: string, path: string): string {
  return `d:${enc(rootId)}:${enc(path)}`;
}

export function fileId(rootId: string, serverId: string, path: string): string {
  return `f:${enc(rootId)}:${enc(serverId)}:${enc(path)}`;
}

export function parseDirId(id: string): DirRef | null {
  const parts = id.split(':');
  if (parts[0] !== 'd' || parts.length !== 3) return null;
  return { rootId: dec(parts[1]), path: dec(parts[2]) };
}

export function parseFileId(id: string): FileRef | null {
  const parts = id.split(':');
  if (parts[0] !== 'f' || parts.length !== 4) return null;
  return { rootId: dec(parts[1]), serverId: dec(parts[2]), path: dec(parts[3]) };
}

export function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

