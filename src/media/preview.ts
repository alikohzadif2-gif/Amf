import { useUserData } from '@/src/library/user-data';
import { providerFor, sourceKinds } from '@/src/library/providers';
import { sortRefs, type LibraryEntry } from '@/src/library/merge';
import type { PreviewQuality, VideoMode } from '@/src/state/settings-store';
import { originalSource } from '@/src/storage/original';
import type { ImageRef } from '@/src/storage/types';
import { isLocalUri, saveOffline } from './originals';

/**
 * Tier 2: preview (loaded when an item is opened).
 * low = small thumbnail size, medium = preview, high = original when it is a
 * real file/URL. Data saver forces low. An offline copy always wins.
 */
export async function loadPreview(
  entry: LibraryEntry,
  quality: PreviewQuality,
  dataSaver: boolean,
): Promise<ImageRef | null> {
  const offline = useUserData.getState().offline[entry.key];
  if (offline && !offline.simulated) return { uri: offline.uri };
  const effective: PreviewQuality = dataSaver ? 'low' : quality;
  for (const ref of sortRefs(entry.refs, sourceKinds())) {
    const provider = providerFor(ref.sourceId);
    if (!provider) continue;
    try {
      if (effective === 'high' && entry.item.type === 'image') {
        const source = await originalSource(provider, ref.itemId);
        if (source && !source.uri.startsWith('mock://')) return source;
      }
      const image =
        effective === 'low'
          ? await provider.getThumb(ref.itemId, 640)
          : await provider.getPreview(ref.itemId);
      if (image) return image;
    } catch {
      // try the next source
    }
  }
  return null;
}

export type VideoSource =
  | { kind: 'play'; uri: string; headers?: Record<string, string> }
  | { kind: 'demo' }
  | { kind: 'none' };

/** Streams (HTTP Range through the player) or downloads first, per Settings. */
export async function resolveVideo(entry: LibraryEntry, mode: VideoMode): Promise<VideoSource> {
  const offline = useUserData.getState().offline[entry.key];
  if (offline && !offline.simulated) return { kind: 'play', uri: offline.uri };
  let sawDemo = false;
  let lastError: unknown = null;
  for (const ref of sortRefs(entry.refs, sourceKinds())) {
    const provider = providerFor(ref.sourceId);
    if (!provider) continue;
    let source: ImageRef | null = null;
    try {
      source = await originalSource(provider, ref.itemId);
    } catch (error) {
      // an unreachable server must not hide another source that has the file
      lastError = error;
      continue;
    }
    if (!source) continue;
    const url = source.uri;
    if (url.startsWith('mock://')) {
      sawDemo = true;
      continue;
    }
    if (isLocalUri(url)) return { kind: 'play', uri: url };
    if (mode === 'download' && (await saveOffline(entry))) {
      const saved = useUserData.getState().offline[entry.key];
      if (saved && !saved.simulated) return { kind: 'play', uri: saved.uri };
    }
    // Streaming: the player sends the Authorization header on every Range request.
    return source.headers ? { kind: 'play', uri: url, headers: source.headers } : { kind: 'play', uri: url };
  }
  if (lastError && !sawDemo) throw lastError; // every source failed: the viewer explains why
  return sawDemo ? { kind: 'demo' } : { kind: 'none' };
}
