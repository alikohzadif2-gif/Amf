/**
 * Direct thumbnails (stage 2A-2): small JPEG copies kept next to the files, so a grid never decodes a full-size original.
 * Pure rules only (no phone APIs), tested in Node. The files live in `meyou-vault/.thumbs/`: a dot folder is not listed in the
 * Archive and is already outside Android backup together with the vault.
 */
export const THUMB_FOLDER = '.thumbs';
/** Two sizes only: grids (<= 320 px asked) and big tiles / the "low" preview (up to 640 px). */
export const THUMB_EDGES = [320, 640] as const;
export const THUMB_QUALITY = 0.72;

export function thumbEdge(requested: number | undefined): number {
  return requested !== undefined && requested > THUMB_EDGES[0] ? THUMB_EDGES[1] : THUMB_EDGES[0];
}

/** Two 32-bit FNV-1a hashes -> 16 hex characters. A collision would only show the wrong small picture, never touch a file. */
export function thumbHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** `<hash of the vault-relative path>.<edge>.jpg`. */
export const thumbName = (rel: string, edge: number): string => `${thumbHash(rel)}.${edge}.jpg`;

/** A thumbnail is current when it is not older than its file (a missing time on either side counts as current). */
export function isThumbFresh(thumbModifiedMs: number | null | undefined, sourceModifiedMs: number | null | undefined): boolean {
  if (typeof thumbModifiedMs !== 'number') return false;
  if (typeof sourceModifiedMs !== 'number') return true;
  return thumbModifiedMs >= sourceModifiedMs;
}

/** Size that fits `edge` on the long side. Never enlarges a small picture (`scaled` false = keep as is). */
export function fitEdge(width: number, height: number, edge: number): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (!(longest > 0) || longest <= edge) return { width, height, scaled: false };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scaled: true };
}
