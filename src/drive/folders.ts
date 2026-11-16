import type { StorageProvider } from '../storage/types';

/**
 * The Drive folder for a path such as `Photos/2026/10` under the Archive's folder (each folder is found, or made once).
 * `cache` remembers ids per path for the length of one scan, so a thousand photos of one month ask Drive once.
 */
export async function ensureDrivePath(
  target: Pick<StorageProvider, 'createFolder'>,
  segments: string[],
  cache: Map<string, string | null> = new Map(),
): Promise<string | null> {
  if (!target.createFolder) return null;
  let parent: string | null = null;
  let path = '';
  for (const segment of segments) {
    path += `/${segment}`;
    let id = cache.get(path);
    if (id === undefined) {
      id = (await target.createFolder(segment, parent)).id;
      cache.set(path, id);
    }
    parent = id;
  }
  return parent;
}
