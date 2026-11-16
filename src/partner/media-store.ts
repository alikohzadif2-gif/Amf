import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useSettingsStore } from '@/src/state/settings-store';
import type { ImageRef } from '@/src/storage/types';
import { planEviction, type CacheRow, type MediaKind, type MediaMessage, type StoredKind } from './media-logic';
import { usePartnerMediaVersion } from './media-version';
import { isVideoName } from './orig-logic';

/**
 * Partner pictures on this phone (sharing track, stage 4). Files live in the app's PRIVATE documents folder
 * (`meyou-partner-media/`): not in the gallery, not in the file manager, and excluded from Android's cloud/device backup
 * (plugins/with-backup-exclude.js). The index is the `partner_media` table. Thumbnails are kept for good (offline copy);
 * previews are a cache with a size cap (`partnerCacheMb`, least recently used first). Only the app can show them, and the
 * app lock screen covers the app like everything else in it.
 */
export const PARTNER_MEDIA_FOLDER = 'meyou-partner-media';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
type Row = { ref: string; kind: string; file: string; bytes: number; w: number; h: number; used: number };

function directory(): Directory {
  const dir = new Directory(Paths.document, PARTNER_MEDIA_FOLDER);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** A file name that cannot collide or escape the folder: derived from a counter-free hash of ref + kind. */
function fileName(ref: string, kind: MediaKind): string {
  let a = 5381;
  let b = 52711;
  const text = `${kind}|${ref}`;
  for (let i = 0; i < text.length; i += 1) {
    a = ((a << 5) + a + text.charCodeAt(i)) | 0;
    b = ((b << 5) ^ b ^ text.charCodeAt(i)) | 0;
  }
  return `${kind[0]}${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}${text.length.toString(16)}.jpg`;
}

const capBytes = () => Math.max(0, useSettingsStore.getState().partnerCacheMb) * 1024 * 1024;

/** The folder of the partner pictures (shared with the original-file store, which keeps its part files and finished originals there too). */
export const partnerMediaDirectory = directory;

/** Stores one received picture (replacing an older one of the same ref and kind), then trims the preview cache. */
export async function storePartnerMedia(db: Db, msg: MediaMessage): Promise<void> {
  const name = fileName(msg.ref, msg.kind);
  const file = new File(directory(), name);
  file.create({ overwrite: true });
  file.write(msg.data, { encoding: 'base64' });
  const bytes = file.size ?? Math.floor((msg.data.length * 3) / 4);
  await db.runAsync(
    `INSERT INTO partner_media (ref, kind, file, bytes, w, h, used) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref, kind) DO UPDATE SET file = excluded.file, bytes = excluded.bytes, w = excluded.w, h = excluded.h, used = excluded.used`,
    msg.ref, msg.kind, name, bytes, msg.w, msg.h, Date.now(),
  );
  await enforcePartnerCap(db);
  usePartnerMediaVersion.getState().bump();
}

/** Which stored kind to try first, then next, for an asked kind (the original, when cached, is the sharpest stand-in for a preview). */
const PREFERENCE: Record<StoredKind, StoredKind[]> = {
  thumb: ['thumb', 'preview', 'original'],
  preview: ['preview', 'original', 'thumb'],
  original: ['original', 'preview', 'thumb'],
};

/**
 * The best local picture for `ref`: the asked kind, else the nearest other one (a thumbnail stands in for a preview not yet
 * received or trimmed from the cache; a cached original stands in for a missing preview). Null when nothing is stored for it.
 */
export async function getPartnerMedia(db: Db, ref: string, kind: StoredKind): Promise<{ image: ImageRef; kind: StoredKind } | null> {
  const rows = await db.getAllAsync<Row>('SELECT * FROM partner_media WHERE ref = ?', ref);
  const order = PREFERENCE[kind];
  const row = [...rows].sort((a, b) => order.indexOf(a.kind as StoredKind) - order.indexOf(b.kind as StoredKind))[0];
  if (!row) return null;
  const file = new File(directory(), row.file);
  if (!file.exists) {
    await db.runAsync('DELETE FROM partner_media WHERE ref = ? AND kind = ?', row.ref, row.kind);
    return rows.length > 1 ? getPartnerMedia(db, ref, kind) : null;
  }
  if (row.kind !== 'thumb') await db.runAsync('UPDATE partner_media SET used = ? WHERE ref = ? AND kind = ?', Date.now(), row.ref, row.kind);
  return { image: { uri: file.uri }, kind: row.kind as StoredKind };
}

/** Is the ORIGINAL of `ref` cached on this phone, and is there any partner picture of it at all (so "full quality" can be asked)? */
export async function partnerOriginalState(db: Db, ref: string): Promise<'cached' | 'available' | 'none'> {
  const rows = await db.getAllAsync<Row>('SELECT kind, file FROM partner_media WHERE ref = ?', ref);
  // A video may have no poster at all (nothing stored) yet can still be downloaded from the sender.
  if (rows.length === 0) return isVideoName(ref) ? 'available' : 'none';
  const original = rows.find((r) => r.kind === 'original');
  if (original && new File(directory(), original.file).exists) return 'cached';
  return 'available';
}

export async function enforcePartnerCap(db: Db): Promise<number> {
  const rows = await db.getAllAsync<Row>('SELECT * FROM partner_media');
  const plan = planEviction(rows.map((r): CacheRow => ({ ref: r.ref, kind: r.kind as StoredKind, bytes: r.bytes, used: r.used })), capBytes());
  for (const gone of plan) {
    const row = rows.find((r) => r.ref === gone.ref && r.kind === gone.kind);
    if (row) {
      try {
        new File(directory(), row.file).delete();
      } catch {
        // already gone
      }
    }
    await db.runAsync('DELETE FROM partner_media WHERE ref = ? AND kind = ?', gone.ref, gone.kind);
  }
  return plan.length;
}

export async function partnerMediaStats(db: Db): Promise<{ thumbBytes: number; previewBytes: number; count: number }> {
  const rows = await db.getAllAsync<Row>('SELECT kind, bytes FROM partner_media');
  let thumbBytes = 0;
  let previewBytes = 0;
  for (const r of rows) {
    if (r.kind === 'thumb') thumbBytes += r.bytes;
    else previewBytes += r.bytes;
  }
  return { thumbBytes, previewBytes, count: rows.length };
}

/** Deletes the cached previews and originals (thumbnails stay: they are the offline copy). */
export async function clearPartnerPreviews(db: Db): Promise<void> {
  const rows = await db.getAllAsync<Row>("SELECT * FROM partner_media WHERE kind != 'thumb'");
  for (const r of rows) {
    try {
      new File(directory(), r.file).delete();
    } catch {
      // already gone
    }
  }
  await db.runAsync("DELETE FROM partner_media WHERE kind != 'thumb'");
  usePartnerMediaVersion.getState().bump();
}

/** Deletes every stored partner picture and the folder (unpairing: nothing of the old partner stays). */
export async function clearAllPartnerMedia(db: Db | null): Promise<void> {
  try {
    const dir = new Directory(Paths.document, PARTNER_MEDIA_FOLDER);
    if (dir.exists) dir.delete();
  } catch {
    // a leftover file is harmless; the rows below are what the app trusts
  }
  if (db) {
    try {
      await db.runAsync('DELETE FROM partner_media');
    } catch {
      // table missing in a very old database: nothing to clear
    }
  }
  usePartnerMediaVersion.getState().bump();
}

/** Deletes the pictures of one shared file (used when the item is removed). */
export async function removePartnerMedia(db: Db, ref: string): Promise<void> {
  const rows = await db.getAllAsync<Row>('SELECT * FROM partner_media WHERE ref = ?', ref);
  for (const r of rows) {
    try {
      new File(directory(), r.file).delete();
    } catch {
      // already gone
    }
  }
  await db.runAsync('DELETE FROM partner_media WHERE ref = ?', ref);
  usePartnerMediaVersion.getState().bump();
}

/** Deletes only the cached ORIGINAL of `ref` (e.g. it did not match its SHA-256); the small pictures stay. */
export async function removePartnerOriginal(db: Db, ref: string): Promise<void> {
  const row = await db.getFirstAsync<Row>("SELECT * FROM partner_media WHERE ref = ? AND kind = 'original'", ref);
  if (!row) return;
  try {
    new File(directory(), row.file).delete();
  } catch {
    // already gone
  }
  await db.runAsync("DELETE FROM partner_media WHERE ref = ? AND kind = 'original'", ref);
  usePartnerMediaVersion.getState().bump();
}
