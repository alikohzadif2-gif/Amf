import { File, FileMode, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openFileReader } from '@/src/server/file-reader';
import { vaultSourceForRef } from '../gallery/gallery-source';
import { enforcePartnerCap, partnerMediaDirectory } from './media-store';
import { usePartnerMediaVersion } from './media-version';
import { ORIG_CHUNK_BYTES, origExt, staleTransfers, type OriginalSource, type PartStore, type Transfer, type TransferStore } from './orig-logic';

/**
 * Phone side of the stage-6 original files. Finished originals live in the same private, backup-excluded folder as the other
 * partner pictures (`meyou-partner-media/`) and are rows of `partner_media` with kind `original`, so they count towards the
 * cache cap and the oldest go first. Part files (`o-<rid>.part`) exist only while a transfer is running.
 */
type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
type TransferRow = Transfer;

export const transferStore = (db: Db): TransferStore => ({
  async get(rid) {
    return (await db.getFirstAsync<TransferRow>('SELECT * FROM partner_orig_transfers WHERE rid = ?', rid)) ?? null;
  },
  async put(t) {
    await db.runAsync(
      `INSERT INTO partner_orig_transfers (rid, ref, state, ext, size, chunks, next, until, file, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rid) DO UPDATE SET state = excluded.state, ext = excluded.ext, size = excluded.size, chunks = excluded.chunks, next = excluded.next, until = excluded.until, file = excluded.file, updated = excluded.updated`,
      t.rid, t.ref, t.state, t.ext, t.size, t.chunks, t.next, t.until, t.file, t.updated,
    );
  },
  async remove(rid) {
    await db.runAsync('DELETE FROM partner_orig_transfers WHERE rid = ?', rid);
  },
});

/** The unfinished transfer for `ref` (receiving), if any, for resuming. */
export async function findTransferByRef(db: Db, ref: string): Promise<Transfer | null> {
  return (await db.getFirstAsync<Transfer>("SELECT * FROM partner_orig_transfers WHERE ref = ? AND state = 'receiving' ORDER BY updated DESC", ref)) ?? null;
}

/** Replaces the record's request id (a resume uses a fresh id so an old `orig-cancel` cannot stop it). */
export async function rekeyTransfer(db: Db, oldRid: string, t: Transfer): Promise<void> {
  await db.runAsync('DELETE FROM partner_orig_transfers WHERE rid = ?', oldRid);
  await transferStore(db).put(t);
}

/** Bytes of the part file on disk (0 when missing). */
export const partSize = (t: Transfer): number => {
  try {
    const f = partFile(t);
    return f.exists ? (f.size ?? 0) : 0;
  } catch {
    return 0;
  }
};

const partFile = (t: Transfer) => new File(partnerMediaDirectory(), t.file);

function appendBytes(file: File, offset: number, bytes: Uint8Array): void {
  try {
    const handle = file.open(FileMode.ReadWrite);
    try {
      handle.offset = offset;
      handle.writeBytes(bytes);
    } finally {
      handle.close();
    }
  } catch {
    // A handle that cannot be opened for writing: rebuild the file (slower, fine for the sizes of photos). Chunks may arrive out of
    // order, so keep what is already there and place these bytes at `offset` (a gap stays zeros until its chunk comes).
    const current = file.exists ? file.bytesSync() : new Uint8Array(0);
    const all = new Uint8Array(Math.max(current.length, offset + bytes.length));
    all.set(current);
    all.set(bytes, offset);
    file.write(all);
  }
}

export const partStore = (db: Db): PartStore => ({
  async start(t) {
    const file = partFile(t);
    file.create({ overwrite: true });
  },
  async write(t, index, bytes) {
    appendBytes(partFile(t), index * ORIG_CHUNK_BYTES, bytes);
  },
  async finish(t) {
    const file = partFile(t);
    if ((file.size ?? -1) !== t.size) return false;
    const finalName = `orig-${t.rid}.${origExt(`x.${t.ext}`)}`;
    const target = new File(partnerMediaDirectory(), finalName);
    if (target.exists) target.delete();
    file.move(target);
    const old = await db.getFirstAsync<{ file: string }>("SELECT file FROM partner_media WHERE ref = ? AND kind = 'original'", t.ref);
    if (old && old.file !== finalName) {
      try {
        new File(partnerMediaDirectory(), old.file).delete();
      } catch {
        // already gone
      }
    }
    await db.runAsync(
      `INSERT INTO partner_media (ref, kind, file, bytes, w, h, used) VALUES (?, 'original', ?, ?, 0, 0, ?)
       ON CONFLICT(ref, kind) DO UPDATE SET file = excluded.file, bytes = excluded.bytes, used = excluded.used`,
      t.ref, finalName, t.size, Date.now(),
    );
    await enforcePartnerCap(db);
    usePartnerMediaVersion.getState().bump();
    return true;
  },
  async discard(t) {
    try {
      const file = partFile(t);
      if (file.exists) file.delete();
    } catch {
      // nothing to remove
    }
  },
});

export const freeDiskBytes = async (): Promise<number | null> => {
  try {
    const free = Paths.availableDiskSpace;
    return typeof free === 'number' && free >= 0 ? free : null;
  } catch {
    return null;
  }
};

/** Sender: remembers where the file behind a shared `ref` is, so the partner can ask for the original later. */
export async function recordSharedOriginal(db: Db, ref: string, uri: string, name: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO shared_originals (ref, uri, name, created) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET uri = excluded.uri, name = excluded.name, created = excluded.created',
    ref, uri, name, Date.now(),
  );
}

/** Sender: the readable original behind `ref`, or null (never shared from here, moved, deleted, permission gone). */
export async function lookupSharedOriginal(db: Db, ref: string): Promise<OriginalSource | null> {
  // A gallery file is not registered here: its ref names a live vault item (`src/gallery/gallery-source.ts`).
  const row = (await db.getFirstAsync<{ uri: string; name: string }>('SELECT uri, name FROM shared_originals WHERE ref = ?', ref)) ?? (await vaultSourceForRef(db, ref));
  if (!row) return null;
  try {
    const reader = await openFileReader(row.uri);
    return { size: reader.size, ext: origExt(row.name), read: reader.read };
  } catch {
    return null;
  }
}

/** Sender: the local file of a picture this phone shared (so my own sent photo shows from a file here), or null. */
export async function sharedOriginalUri(db: Db, ref: string): Promise<string | null> {
  const row = (await db.getFirstAsync<{ uri: string }>('SELECT uri FROM shared_originals WHERE ref = ?', ref)) ?? (await vaultSourceForRef(db, ref));
  return row?.uri ?? null;
}

/** Removes the records and part files of transfers that never finished. Never throws. */
export async function cleanStaleTransfers(db: Db): Promise<void> {
  try {
    const all = await db.getAllAsync<Transfer>('SELECT * FROM partner_orig_transfers');
    for (const t of staleTransfers(all, Date.now())) {
      await partStore(db).discard(t);
      await db.runAsync('DELETE FROM partner_orig_transfers WHERE rid = ?', t.rid);
    }
  } catch {
    // table missing in a very old database: nothing to clean
  }
}

/** Unpairing: nothing of the old partner stays (the media folder is deleted by `clearAllPartnerMedia`). */
export async function clearAllOriginals(db: Db | null): Promise<void> {
  if (!db) return;
  for (const table of ['partner_orig_transfers', 'shared_originals']) {
    try {
      await db.runAsync(`DELETE FROM ${table}`);
    } catch {
      // table missing: nothing to clear
    }
  }
}

/** The sender stops serving these shared paths (the share is deleted). The user's own file is never touched. */
export async function forgetSharedOriginals(db: Db, refs: string[]): Promise<void> {
  for (const ref of refs) {
    try {
      await db.runAsync('DELETE FROM shared_originals WHERE ref = ?', ref);
    } catch {
      // table missing: nothing to forget
    }
  }
}
