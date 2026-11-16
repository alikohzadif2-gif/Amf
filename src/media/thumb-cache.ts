import { Directory, File, Paths } from 'expo-file-system';
import { hashString } from '@/src/storage/mock-tree';
import type { ImageRef, StorageItem, StorageProvider } from '@/src/storage/types';
import { useSettingsStore } from '@/src/state/settings-store';
import { createLimiter } from './limiter';
import { LruIndex } from './lru';

/**
 * Tier 1: thumbnails. Remote/mock thumbnails are written to a disk cache with
 * LRU eviction under the user's cap (Settings > Media & cache). Thumbnails of
 * phone files are used in place (they already live on the device).
 */
const run = createLimiter(4);
const lru = new LruIndex();
const memory = new Map<string, ImageRef>();
const inflight = new Map<string, Promise<ImageRef | null>>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function directory(): Directory {
  const dir = new Directory(Paths.cache, 'meyou-thumbs');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const index = new File(directory(), 'index.json');
    if (index.exists) lru.load(JSON.parse(index.textSync()));
  } catch {
    // a broken index just means an empty cache
  }
}

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const index = new File(directory(), 'index.json');
      index.create({ overwrite: true });
      index.write(JSON.stringify(lru.toJSON()));
    } catch {
      // cache index is best-effort
    }
  }, 800);
}

function capBytes(): number {
  return useSettingsStore.getState().thumbCacheMb * 1024 * 1024;
}

export function enforceCap() {
  ensureLoaded();
  const dir = directory();
  for (const record of lru.evictTo(capBytes())) {
    try {
      new File(dir, record.name).delete();
    } catch {
      // already gone
    }
  }
  for (const [key] of memory) if (!lru.has(key)) memory.delete(key);
  persistSoon();
}

export function cacheStats(): { bytes: number; count: number; capBytes: number } {
  ensureLoaded();
  return { bytes: lru.totalBytes, count: lru.count, capBytes: capBytes() };
}

export function clearThumbCache() {
  ensureLoaded();
  const dir = directory();
  for (const key of lru.keys()) {
    try {
      new File(dir, lru.get(key)?.name ?? '').delete();
    } catch {
      // ignore
    }
    lru.remove(key);
  }
  memory.clear();
  persistSoon();
}

/** Default thumbnail edge in px; other sizes (big Explore tiles) get their own cache entries. */
export const DEFAULT_THUMB = 256;

function cacheKey(sourceId: string, item: StorageItem, size: number): string {
  const base = `${sourceId}|${item.id}|${item.mtime}|${item.size}${size === DEFAULT_THUMB ? '' : `|s${size}`}`;
  return hashString(base).toString(16) + hashString(`x${base}`).toString(16);
}

export function writeInto(dir: Directory, name: string, ref: ImageRef): Promise<File | null> | File | null {
  const file = new File(dir, name);
  if (ref.uri.startsWith('data:')) {
    const comma = ref.uri.indexOf(',');
    const head = ref.uri.slice(5, comma);
    const body = ref.uri.slice(comma + 1);
    file.create({ overwrite: true });
    if (head.includes('base64')) file.write(body, { encoding: 'base64' });
    else file.write(decodeURIComponent(body));
    return file;
  }
  if (/^https?:/.test(ref.uri)) {
    if (file.exists) file.delete();
    return File.downloadFileAsync(ref.uri, file, { headers: ref.headers });
  }
  return null;
}

function extensionFor(ref: ImageRef): string {
  if (ref.uri.startsWith('data:image/svg')) return 'svg';
  if (ref.uri.startsWith('data:image/png')) return 'png';
  return 'jpg';
}

/** Returns a displayable thumbnail for one item (cached, deduplicated, rate-limited). */
export function loadThumb(provider: StorageProvider, item: StorageItem, size: number = DEFAULT_THUMB): Promise<ImageRef | null> {
  ensureLoaded();
  const key = cacheKey(provider.id, item, size);
  const hit = memory.get(key);
  if (hit) {
    lru.touch(key);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = run(async () => {
    const dir = directory();
    const record = lru.get(key);
    if (record) {
      const file = new File(dir, record.name);
      if (file.exists) {
        lru.touch(key);
        const ref = { uri: file.uri };
        memory.set(key, ref);
        return ref;
      }
      lru.remove(key);
    }
    const ref = await provider.getThumb(item.id, size);
    if (!ref) return null;
    const name = `${key}.${extensionFor(ref)}`;
    const written = await writeInto(dir, name, ref);
    if (!written) return ref; // phone file: used in place
    lru.put(key, name, written.size ?? 0);
    const result = { uri: written.uri };
    memory.set(key, result);
    if (memory.size > 1500) memory.delete(memory.keys().next().value as string);
    enforceCap();
    return result;
  })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
