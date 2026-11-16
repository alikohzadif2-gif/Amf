import type { ServerClient } from '@/src/server/client';
import type { ImageRef } from '@/src/storage/types';
import type { ChunkReader, ServerItem } from '@/src/server/types';
import { uploadResumable } from '@/src/server/upload';

/**
 * Attachments of shared things (event photo now, memory media in R8b) never travel in the mailbox (32 KB limit): the sender
 * uploads them with the S5 upload into the library folder `Shared/<id>/` and the message carries the path; the partner reads
 * them with the media API (docs/API_CONTRACT.md D.13). Thin glue over `ServerClient` and `uploadResumable`: no new engine.
 */
export const SHARED_ROOT = 'Shared';

type Client = Pick<ServerClient, 'roots' | 'tree' | 'thumbUrl' | 'previewUrl' | 'fileUrl' | 'authHeaders' | 'createUpload' | 'patchUpload' | 'completeUpload'>;

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

async function firstRoot(client: Pick<ServerClient, 'roots'>): Promise<string> {
  const roots = await client.roots();
  if (roots.length === 0) throw new Error('server has no library root');
  return roots[0].id;
}

/** Uploads one phone file to `Shared/<id>/<name>` and returns the server path to put in the message. */
export async function uploadShared(
  client: Client,
  reader: ChunkReader,
  input: { id: string; name: string; md5?: string; mtime?: string },
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const rootId = await firstRoot(client);
  const folder = sharedFolder(input.id);
  const name = sharedFileName(input.name);
  const item: ServerItem = await uploadResumable(client as ServerClient, reader, { name, size: reader.size, rootId, path: folder, md5: input.md5, mtime: input.mtime }, options);
  return `${folder}/${item.name || name}`;
}

const idCache = new Map<string, string>();

async function findSharedId(client: Client, path: string): Promise<string | null> {
  const split = splitSharedPath(path);
  if (!split) return null;
  const cacheKey = `${client.thumbUrl('', 0)}|${path}`;
  let serverId = idCache.get(cacheKey);
  if (!serverId) {
    const rootId = await firstRoot(client);
    let cursor: string | undefined;
    do {
      const page = await client.tree(rootId, split.folder, cursor, 200);
      const found = page.items.find((item) => item.type !== 'dir' && item.name === split.name);
      if (found) serverId = found.id;
      cursor = serverId ? undefined : page.nextCursor;
    } while (cursor);
    if (!serverId) return null;
    idCache.set(cacheKey, serverId);
  }
  return serverId;
}

/** The thumbnail/preview reference (with the Authorization header) of a shared file, or null when it is not on the server (yet). */
export async function resolveShared(client: Client, path: string, kind: 'thumb' | 'preview' = 'preview', size = 720): Promise<ImageRef | null> {
  const serverId = await findSharedId(client, path);
  if (!serverId) return null;
  return { uri: kind === 'thumb' ? client.thumbUrl(serverId, size) : client.previewUrl(serverId), headers: client.authHeaders() };
}

/** The original file of a shared path (for streaming a story video), with the Authorization header; null when it is not there. */
export async function resolveSharedOriginal(client: Client, path: string): Promise<ImageRef | null> {
  const serverId = await findSharedId(client, path);
  if (!serverId) return null;
  return { uri: client.fileUrl(serverId), headers: client.authHeaders() };
}
