/**
 * Sharing track, stage 4: pure rules for the small encrypted pictures that go with a shared photo (no React Native imports,
 * so the test suite runs it in Node). Two variants travel through the encrypted queue as ordinary `media` messages:
 *   - thumb   (about 10-30 KB, 320 px): always, at once. Kept for good on the partner's phone, visible offline.
 *   - preview (about 200-400 KB, 1080 px): with the new photo; only on an unmetered network when the setting says so,
 *     otherwise it waits in a small outbox on the sender's phone. Kept in a cache with a size cap on the partner's phone.
 * The original file is NOT sent here (stage 6: "full quality" asked from the sender's phone).
 */
export type MediaKind = 'thumb' | 'preview';
/** What the partner-media table holds: the two small variants plus (stage 6) the original file, kept in the same size-capped cache. */
export type StoredKind = MediaKind | 'original';

export const THUMB_MAX_BYTES = 30_000;
export const PREVIEW_MAX_BYTES = 400_000;
/** What a received picture may weigh at most (base64 characters of `data`); the queue accepts 1 MB per blob. */
export const MEDIA_MAX_DATA_CHARS = 600_000;
export const BYTE_LIMIT: Record<MediaKind, number> = { thumb: THUMB_MAX_BYTES, preview: PREVIEW_MAX_BYTES };

/** Sizes tried in order (longest edge in px, JPEG quality) until the picture fits its byte limit. The last step is the smallest. */
export const LADDER: Record<MediaKind, { edge: number; quality: number }[]> = {
  thumb: [
    { edge: 320, quality: 0.6 },
    { edge: 320, quality: 0.45 },
    { edge: 256, quality: 0.4 },
    { edge: 192, quality: 0.3 },
  ],
  preview: [
    { edge: 1080, quality: 0.8 },
    { edge: 1080, quality: 0.65 },
    { edge: 1080, quality: 0.5 },
    { edge: 900, quality: 0.45 },
    { edge: 720, quality: 0.4 },
  ],
};

export type Rendered = { b64: string; width: number; height: number };

/** Decoded size of a base64 string. */
export const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/**
 * Renders with the first ladder step and goes down until the result fits `BYTE_LIMIT[kind]`. If even the smallest step is too big
 * but still sendable (below `hardMaxBytes`) it is used anyway; above that the variant is skipped (null). `render` is the platform's
 * image resizer (expo-image-manipulator in the app).
 */
export async function fitVariant(kind: MediaKind, render: (step: { edge: number; quality: number }) => Promise<Rendered | null>, hardMaxBytes = Math.floor((MEDIA_MAX_DATA_CHARS * 3) / 4)): Promise<Rendered | null> {
  let last: Rendered | null = null;
  for (const step of LADDER[kind]) {
    const out = await render(step);
    if (!out) return last && b64Bytes(last.b64) <= hardMaxBytes ? last : null;
    last = out;
    if (b64Bytes(out.b64) <= BYTE_LIMIT[kind]) return out;
  }
  return last && b64Bytes(last.b64) <= hardMaxBytes ? last : null;
}

/** The same key for a picture on both phones: the shared path (`Shared/<id>/<name>`) plus the kind. */
export const mediaKey = (ref: string, kind: MediaKind) => `${kind}|${ref}`;

export type MediaMessage = {
  t: 'media';
  from: string;
  ts: string;
  silent: true;
  ref: string;
  kind: MediaKind;
  mime: 'image/jpeg';
  w: number;
  h: number;
  data: string;
};

export function buildMediaMessage(input: { from: string; ts: string; ref: string; kind: MediaKind; rendered: Rendered }): MediaMessage {
  return { t: 'media', from: input.from, ts: input.ts, silent: true, ref: input.ref, kind: input.kind, mime: 'image/jpeg', w: input.rendered.width, h: input.rendered.height, data: input.rendered.b64 };
}

export type CacheRow = { ref: string; kind: StoredKind; bytes: number; used: number };

/**
 * Which previews and originals to delete so the cache fits `capBytes`: least recently used first (originals are the big ones, so an
 * old original goes before a newer preview only by age, not by kind). Thumbnails are never evicted (they are small and are the
 * offline copy); they only count towards the total. A cap of 0 or less means "nothing but thumbnails kept".
 */
export function planEviction(rows: CacheRow[], capBytes: number): CacheRow[] {
  let total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const out: CacheRow[] = [];
  if (total <= capBytes) return out;
  const evictable = rows.filter((row) => row.kind !== 'thumb').sort((a, b) => a.used - b.used);
  for (const row of evictable) {
    if (total <= capBytes) break;
    out.push(row);
    total -= row.bytes;
  }
  return out;
}

/** True for a path or file name that is a still image the app can shrink (videos keep the old path until stage 6). */
export const isImageName = (name: string): boolean => /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(name.split('?')[0]);
