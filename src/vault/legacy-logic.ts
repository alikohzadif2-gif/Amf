/**
 * Stage 2A-3: pure rules for moving the OLD library (the `meyou-library` app folder and gallery pictures that memories, albums,
 * favourites and tags point at) into Direct. No phone APIs, so they run in Node tests. Nothing here deletes anything.
 */
import { cleanSegment } from './logic';

export const LEGACY_FOLDER = 'meyou-library';
/** Gallery pictures that user data pointed at are filed here inside Direct. */
export const GALLERY_FOLDER = 'Gallery';
/** After this many launches with something still not copyable (gallery permission, picture deleted) the job stops retrying. */
export const MAX_LEGACY_ATTEMPTS = 3;

export type LegacyRef = { sourceId: string; itemId: string };
export type LegacyTarget = { folder?: string; name: string };

export function parseRefs(json: string): LegacyRef[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is LegacyRef => !!r && typeof (r as LegacyRef).sourceId === 'string' && typeof (r as LegacyRef).itemId === 'string');
  } catch {
    return [];
  }
}

/** True for an entry that lives only on the old gallery/app-folder source (it must be copied; it has no Direct copy yet). */
export function isLegacyOnly(refs: LegacyRef[]): boolean {
  return refs.some((r) => r.sourceId === 'local') && !refs.some((r) => r.sourceId === 'vault');
}

export function firstLocalRef(refs: LegacyRef[]): LegacyRef | null {
  return refs.find((r) => r.sourceId === 'local') ?? null;
}

/** `fs:file:///…/meyou-library/Trip/a.jpg` → `{ folder: 'Trip', name: 'a.jpg' }`; a gallery asset → the `Gallery` folder. */
export function legacyTarget(itemId: string, fallbackName: string): LegacyTarget {
  const name = cleanSegment(fallbackName || 'file');
  if (itemId.startsWith('ml:asset:')) return { folder: GALLERY_FOLDER, name };
  let uri = itemId.startsWith('fs:') ? itemId.slice(3) : itemId;
  try {
    uri = decodeURIComponent(uri);
  } catch {
    // keep the raw text
  }
  const marker = `/${LEGACY_FOLDER}/`;
  const at = uri.indexOf(marker);
  if (at < 0) return { name };
  const parts = uri.slice(at + marker.length).split('/').filter((p) => p !== '');
  const file = parts.pop();
  const folder = parts.map(cleanSegment).join(' - ');
  const clean = cleanSegment(file || fallbackName || 'file');
  return folder ? { folder, name: clean } : { name: clean };
}

/** Rewrites a JSON array of Library keys (a memory's `media_keys`) with the new keys; unknown keys stay as they are. */
export function remapKeysJson(json: string, map: ReadonlyMap<string, string>): { json: string; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { json, changed: false };
  }
  if (!Array.isArray(parsed)) return { json, changed: false };
  let changed = false;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of parsed) {
    const next = typeof item === 'string' && map.has(item) ? map.get(item)! : item;
    if (next !== item) changed = true;
    if (typeof next === 'string') {
      if (seen.has(next)) {
        changed = true; // two old keys became one file: keep one
        continue;
      }
      seen.add(next);
    }
    out.push(next);
  }
  return { json: changed ? JSON.stringify(out) : json, changed };
}

/** Old key → new key pairs worth writing: both known and different. */
export function planRemap(copied: Record<string, string>, keyOfRel: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [oldKey, rel] of Object.entries(copied)) {
    const next = keyOfRel.get(rel);
    if (next && next !== oldKey) out.set(oldKey, next);
  }
  return out;
}

/** `copied`: old key → Direct path (until its key is rewritten). `src`: old app-folder file uri → Direct path (until the old file is removed after a size check). */
export type LegacyState = { done: boolean; attempts: number; copied: Record<string, string>; src: Record<string, string> };
export const EMPTY_LEGACY_STATE: LegacyState = { done: false, attempts: 0, copied: {}, src: {} };

export function parseLegacyState(raw: string | null): LegacyState {
  if (!raw) return { ...EMPTY_LEGACY_STATE, copied: {}, src: {} };
  try {
    const p = JSON.parse(raw) as Partial<LegacyState>;
    return { done: p.done === true, attempts: typeof p.attempts === 'number' ? p.attempts : 0, copied: p.copied && typeof p.copied === 'object' ? p.copied : {}, src: p.src && typeof p.src === 'object' ? p.src : {} };
  } catch {
    return { ...EMPTY_LEGACY_STATE, copied: {}, src: {} };
  }
}
