/**
 * Private vault (sharing track, stage 5): the rules that need no phone APIs, so they can be tested in Node.
 * The vault is a folder inside the app's PRIVATE storage (`files/meyou-vault/`): not in the gallery, not in the file
 * manager, outside Android's cloud backup, and only the app can delete from it.
 */
export const VAULT_FOLDER = 'meyou-vault';
/** Deleted vault files wait here (inside the vault folder, hidden from the Archive) before they are really removed. */
export const TRASH_FOLDER = '.trash';
export const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;
/** Free space kept on top of what a transfer needs. */
export const SPACE_MARGIN_BYTES = 200 * 1024 * 1024;

export type ImportMode = 'move' | 'copy';
export type QueueStatus = 'pending' | 'copied' | 'done' | 'kept' | 'failed';
export type ItemState = 'hidden' | 'exported' | 'trashed';

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** One folder/file name made safe for the vault: no separators, no control characters, never starts with a dot. */
export function cleanSegment(name: string): string {
  let out = name.replace(BAD_CHARS, '_').trim().replace(/^\.+/, '').trim();
  if (out.length > 120) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : '';
    out = out.slice(0, 120 - ext.length) + ext;
  }
  return out || '_';
}

export function joinRel(...parts: string[]): string {
  return parts.filter((p) => p !== '').map(cleanSegment).join('/');
}

/** A relative vault path is safe when it stays inside the vault folder and is not in the trash. */
export function isSafeRel(rel: string): boolean {
  if (rel === '' || rel.startsWith('/')) return false;
  const parts = rel.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('.'));
}

export const topOf = (rel: string): string => rel.split('/')[0] ?? rel;

/** `a/b.jpg` -> `a/b (2).jpg` until the path is free. */
export function uniqueRelPath(rel: string, taken: ReadonlySet<string>): string {
  if (!taken.has(rel)) return rel;
  const slash = rel.lastIndexOf('/');
  const dir = slash < 0 ? '' : rel.slice(0, slash + 1);
  const file = slash < 0 ? rel : rel.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  for (let n = 2; n < 10_000; n += 1) {
    const next = `${dir}${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
  return `${dir}${stem}-${Date.now()}${ext}`;
}

export type Totals = { count: number; bytes: number; largest: number };
export function totalsOf(sizes: readonly number[]): Totals {
  let bytes = 0;
  let largest = 0;
  for (const s of sizes) {
    bytes += s;
    if (s > largest) largest = s;
  }
  return { count: sizes.length, bytes, largest };
}

/**
 * Free space a transfer needs. A copy needs room for everything. A move deletes each original right after it is verified,
 * so it needs room for the largest file; the margin stays on top in both cases.
 */
export function spaceNeeded(mode: ImportMode, totals: Totals): number {
  return (mode === 'copy' ? totals.bytes : totals.largest) + SPACE_MARGIN_BYTES;
}
export function enoughSpace(mode: ImportMode, totals: Totals, freeBytes: number): boolean {
  return freeBytes >= spaceNeeded(mode, totals);
}

export type DeleteVerdict = 'delete' | 'copy-mode' | 'mismatch' | 'unverified';

/**
 * May the ORIGINAL be deleted after its copy was made? Only in move mode, and only when the sizes AND the checksums match.
 * Without a checksum on both sides the original stays (`unverified`).
 */
export function deleteVerdict(input: { mode: ImportMode; sourceSize: number; targetSize: number; sourceMd5?: string | null; targetMd5?: string | null }): DeleteVerdict {
  if (input.mode !== 'move') return 'copy-mode';
  if (input.sourceSize !== input.targetSize) return 'mismatch';
  if (!input.sourceMd5 || !input.targetMd5) return 'unverified';
  return input.sourceMd5.toLowerCase() === input.targetMd5.toLowerCase() ? 'delete' : 'mismatch';
}

export const trashExpired = (trashedAt: number, now: number): boolean => now - trashedAt >= TRASH_DAYS * DAY_MS;
export const trashDaysLeft = (trashedAt: number, now: number): number => Math.max(0, Math.ceil((trashedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS));

/** The part of `uri` after the vault folder's uri (null when `uri` is not inside it). */
export function relFromUri(uri: string, vaultUri: string): string | null {
  const base = vaultUri.replace(/\/+$/, '');
  const clean = safeDecode(uri.split('?')[0]);
  const root = safeDecode(base);
  if (!clean.startsWith(`${root}/`)) return null;
  const rel = clean.slice(root.length + 1).replace(/\/+$/, '');
  return isSafeRel(rel) ? rel : null;
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/** The last readable part of a file/folder name a document provider (Storage Access Framework) hands back, e.g. `primary:DCIM/a.jpg` -> `a.jpg`. */
export function displayName(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // keep the raw text
  }
  const last = name.split(/[/:]/).filter((p) => p !== '').pop();
  return last ?? name;
}

/** LIKE pattern matching a vault folder and everything below it (`%` and `_` in the name are escaped; use `ESCAPE '\\'`). */
export function likeBelow(rel: string): string {
  return `${rel.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}
