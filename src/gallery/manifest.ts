/**
 * Shared gallery, stage 2: the manifest. Pure rules (no phone APIs), tested in Node (`scripts/test-gallery-manifest.mjs`).
 *
 * One `gallery-manifest` message describes up to 400 files at once instead of sending one message per file:
 *   { t: 'gallery-manifest', from, ts, silent: true, n, z }
 * `z` = url-safe base64 of the deflated JSON `{ v: 1, e: [entry...], g: [id...] }`:
 *   entry = { id, p: 'Trip/Day 1/IMG_0001.jpg', k: 'i' | 'v' | 'f', s: <bytes>, o: <order> }
 *   g     = ids the sender removed from the gallery (trash / unhide)
 * `p` is relative to the gallery root (folders are implied by the paths), `k` = image / video / other file, `o` = the sender's copy order
 * (it only grows, so the partner lists a folder in the same order the sender's file manager showed it). No picture, no hash, no path
 * outside the gallery travels here: thumbnails and originals are asked for later (stages 3 and 4).
 * Applying a message is idempotent (same id = same row), so a repeated or reordered message changes nothing.
 */
import { Inflate, deflateSync } from 'fflate';
import { b64urlDecode, b64urlEncode } from '../e2e/base64';
import { isImageName } from '../partner/media-logic';
import { isVideoName } from '../partner/orig-logic';
import { isSafeRel } from '../vault/logic';

export type GalleryKind = 'i' | 'v' | 'f';
export type GalleryEntry = { id: string; p: string; k: GalleryKind; s: number; o: number };
export type ManifestBatch = { entries: GalleryEntry[]; gone: string[] };

/** Entries per message. 400 short paths deflate to roughly 8-15 KB, far below the queue's 1 MB blob limit. */
export const MANIFEST_MAX_ENTRIES = 400;
/** Ids removed per message. */
export const MANIFEST_MAX_GONE = 400;
/** Size of the JSON before deflate that a sender builds (long folder names make fewer entries fit). */
export const MANIFEST_MAX_RAW_CHARS = 64_000;
/** What a receiver accepts: compressed text and, after inflating, bytes. The second one stops a zip bomb. */
export const MANIFEST_MAX_Z_CHARS = 160_000;
export const MANIFEST_MAX_INFLATED_BYTES = 256_000;
export const MANIFEST_PATH_MAX = 300;
export const MANIFEST_VERSION = 1;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/** Kind letter of a file name: picture, video, or any other file. */
export function kindOfName(name: string): GalleryKind {
  if (isImageName(name)) return 'i';
  if (isVideoName(name)) return 'v';
  return 'f';
}

/** A gallery path is safe when it stays inside the gallery: relative, no `..`, no dot-folders, no backslash, no control characters. */
export function isGalleryPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MANIFEST_PATH_MAX && !/[\\\u0000-\u001f]/.test(p) && isSafeRel(p);
}

export function parseEntry(raw: unknown): GalleryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || !ID_RE.test(d.id) || !isGalleryPath(d.p)) return null;
  if (d.k !== 'i' && d.k !== 'v' && d.k !== 'f') return null;
  if (!isInt(d.s, 2 ** 40) || !isInt(d.o, 2 ** 31)) return null;
  return { id: d.id, p: d.p, k: d.k, s: d.s, o: d.o };
}

/**
 * Splits entries (any order) into batches in copy order (`o`), each within the entry count and the raw-size limit, so every batch becomes
 * one message. Removed ids go into batches of their own after the entries (a removal never travels before the entry it follows).
 */
export function splitBatches(entries: readonly GalleryEntry[], gone: readonly string[] = [], limits: { maxEntries?: number; maxRaw?: number; maxGone?: number } = {}): ManifestBatch[] {
  const maxEntries = limits.maxEntries ?? MANIFEST_MAX_ENTRIES;
  const maxRaw = limits.maxRaw ?? MANIFEST_MAX_RAW_CHARS;
  const maxGone = limits.maxGone ?? MANIFEST_MAX_GONE;
  const sorted = [...entries].sort((a, b) => a.o - b.o || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: ManifestBatch[] = [];
  let current: GalleryEntry[] = [];
  let raw = 0;
  for (const entry of sorted) {
    const size = JSON.stringify(entry).length + 1;
    if (current.length > 0 && (current.length >= maxEntries || raw + size > maxRaw)) {
      out.push({ entries: current, gone: [] });
      current = [];
      raw = 0;
    }
    current.push(entry);
    raw += size;
  }
  if (current.length > 0) out.push({ entries: current, gone: [] });
  for (let i = 0; i < gone.length; i += maxGone) out.push({ entries: [], gone: gone.slice(i, i + maxGone) });
  return out;
}

export type ManifestWire = { t: 'gallery-manifest'; from: string; ts: string; silent: true; n: number; z: string };

/** Compresses one batch into the message body. */
export function encodeBatch(batch: ManifestBatch, head: { from: string; ts: string }): ManifestWire {
  const json = JSON.stringify({ v: MANIFEST_VERSION, e: batch.entries, g: batch.gone });
  const z = b64urlEncode(deflateSync(new TextEncoder().encode(json), { level: 6 }));
  return { t: 'gallery-manifest', from: head.from, ts: head.ts, silent: true, n: batch.entries.length + batch.gone.length, z };
}

/** Inflates with a hard output cap; null when the data is not valid deflate or would grow past `cap` (a zip bomb stops at the cap). */
export function inflateCapped(data: Uint8Array, cap: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) throw new RangeError('too big');
    chunks.push(chunk);
  });
  try {
    stream.push(data, true);
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Reads the body back. Any problem (size, format, version, one bad entry, a wrong count) returns null: the whole message is ignored. */
export function decodeBatch(z: unknown, n: unknown): ManifestBatch | null {
  if (typeof z !== 'string' || z.length === 0 || z.length > MANIFEST_MAX_Z_CHARS) return null;
  const bytes = b64urlDecode(z);
  if (!bytes) return null;
  const inflated = inflateCapped(bytes, MANIFEST_MAX_INFLATED_BYTES);
  if (!inflated) return null;
  let d: unknown;
  try {
    d = JSON.parse(new TextDecoder().decode(inflated));
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const body = d as Record<string, unknown>;
  if (body.v !== MANIFEST_VERSION || !Array.isArray(body.e) || !Array.isArray(body.g)) return null;
  if (body.e.length > MANIFEST_MAX_ENTRIES || body.g.length > MANIFEST_MAX_GONE || body.e.length + body.g.length < 1) return null;
  const entries: GalleryEntry[] = [];
  for (const raw of body.e) {
    const entry = parseEntry(raw);
    if (!entry) return null;
    entries.push(entry);
  }
  const gone: string[] = [];
  for (const id of body.g) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    gone.push(id);
  }
  if (n !== entries.length + gone.length) return null;
  return { entries, gone };
}
