import { Directory, File, Paths } from 'expo-file-system';
import { dropOffline, putOffline, useUserData } from '@/src/library/user-data';
import { providerFor, sourceKinds } from '@/src/library/providers';
import { sortRefs, type LibraryEntry } from '@/src/library/merge';
import { extensionOf } from '@/src/storage/item-type';
import { originalSource } from '@/src/storage/original';
import { hashString } from '@/src/storage/mock-tree';
import { writeInto } from './thumb-cache';

/** Tier 3: originals. Fetched only on demand, "make available offline" or download. */
export function offlineDirectory(): Directory {
  const dir = new Directory(Paths.document, 'meyou-offline');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function isLocalUri(uri: string): boolean {
  return uri.startsWith('file:') || uri.startsWith('content:') || uri.startsWith('/');
}

function fileNameFor(entry: LibraryEntry, simulated: boolean): string {
  const ext = simulated ? 'svg' : extensionOf(entry.item.name) || 'bin';
  return `${hashString(entry.key).toString(16)}${hashString(`o${entry.key}`).toString(16)}.${ext}`;
}

/**
 * Makes one item available on this phone. Phone files need nothing; demo
 * (mock) sources get a small stand-in file so the whole flow can be tested.
 */
export async function saveOffline(entry: LibraryEntry): Promise<boolean> {
  const refs = sortRefs(entry.refs, sourceKinds());
  for (const ref of refs) {
    const provider = providerFor(ref.sourceId);
    if (!provider) continue;
    let source: Awaited<ReturnType<typeof originalSource>> = null;
    try {
      source = await originalSource(provider, ref.itemId);
    } catch {
      continue; // server unreachable: try the next source
    }
    if (!source) continue;
    const url = source.uri;
    if (isLocalUri(url)) return true; // already on the phone
    const dir = offlineDirectory();
    try {
      if (url.startsWith('mock://')) {
        const preview = await provider.getPreview(ref.itemId);
        if (!preview) continue;
        const name = fileNameFor(entry, true);
        const file = (await writeInto(dir, name, preview)) as File | null;
        if (!file) continue;
        await putOffline(entry.key, {
          uri: file.uri, size: file.size ?? 0, simulated: true, sourceId: ref.sourceId, itemId: ref.itemId,
        });
        return true;
      }
      const name = fileNameFor(entry, false);
      const target = new File(dir, name);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(url, target, { headers: source.headers });
      await putOffline(entry.key, {
        uri: file.uri, size: file.size ?? entry.item.size, simulated: false,
        sourceId: ref.sourceId, itemId: ref.itemId,
      });
      return true;
    } catch {
      // try the next source
    }
  }
  return false;
}

export async function removeOffline(key: string) {
  const record = useUserData.getState().offline[key];
  if (record) {
    try {
      new File(record.uri).delete();
    } catch {
      // file already gone
    }
  }
  await dropOffline(key);
}

export async function saveOfflineMany(
  entries: LibraryEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let ok = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (await saveOffline(entries[i])) ok += 1;
    onProgress?.(i + 1, entries.length);
  }
  return ok;
}
