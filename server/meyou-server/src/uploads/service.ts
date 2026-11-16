// Resumable uploads (contract C.2). The temp file $DATA_DIR/uploads/<id> is the source of truth
// for the offset (its size); SQLite keeps the session. Finished files are moved into the library
// with link(), which fails if the name exists, so an upload can never overwrite anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { libraryDir, uploadsDir, type Config } from '../config.js';
import type { Db } from '../db.js';
import { listRoots } from '../library.js';
import type { Indexer } from '../media/indexer.js';
import { toJson, type ItemJson } from '../media/store.js';

export const DONE_RETENTION_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

export type Fail = { ok: false; status: number; body: Record<string, unknown> };
export type Ok<T> = { ok: true; value: T };
export type Result<T> = Ok<T> | Fail;

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Fail => ({ ok: false, status, body: { error, ...extra } });
const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export interface UploadOptions {
  /** Free bytes on the volume of `dir`. Injectable so tests can simulate a full disk. */
  diskFree?: (dir: string) => Promise<number>;
  now?: () => number;
}

interface Row {
  id: string;
  device_id: string;
  key: string;
  root: string;
  dir: string;
  name: string;
  size: number;
  md5: string | null;
  mtime_ms: number | null;
  state: 'open' | 'done';
  final_path: string | null;
  created_at: number;
  updated_at: number;
}

async function defaultDiskFree(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** A folder or file name segment we are willing to create (the indexer ignores dotfiles). */
function validSegment(s: string): boolean {
  if (s === '' || s === '.' || s === '..' || s.startsWith('.')) return false;
  if (/[\\/\0-\x1f\x7f�]/.test(s)) return false;
  return Buffer.byteLength(s, 'utf8') <= 255;
}

/** Folder path inside a root as clean segments, or null. '' and '/' are the root itself. */
export function folderSegments(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return [];
  const parts = trimmed.split('/');
  return parts.every(validSegment) ? parts : null;
}

/** "photo.jpg" + 2 -> "photo (2).jpg". Dot-less names get the suffix at the end. */
export function suffixedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

export class Uploads {
  private readonly diskFree: (dir: string) => Promise<number>;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly indexer: Indexer,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
    opts: UploadOptions = {},
  ) {
    this.diskFree = opts.diskFree ?? defaultDiskFree;
    this.now = opts.now ?? Date.now;
  }

  private tmpPath(id: string): string {
    return path.join(uploadsDir(this.cfg), id);
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Row | undefined;
  }

  /** One request at a time per session (a second PATCH waits, then sees the new offset). */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  /** Bytes still expected by all open sessions (so two big uploads cannot both "fit"). */
  private async reserved(exceptId?: string): Promise<number> {
    const rows = this.db.prepare("SELECT id, size FROM uploads WHERE state = 'open'").all() as unknown as { id: string; size: number }[];
    let sum = 0;
    for (const r of rows) {
      if (r.id === exceptId) continue;
      const have = await fs.promises.stat(this.tmpPath(r.id)).then((s) => s.size, () => 0);
      sum += Math.max(0, r.size - have);
    }
    return sum;
  }

  /** Existing folders on the way must be real folders (no symlink, no file in the way). */
  private async checkFolder(root: string, segs: string[]): Promise<boolean> {
    let cur = path.join(libraryDir(this.cfg), root);
    for (const s of segs) {
      cur = path.join(cur, s);
      const st = await fs.promises.lstat(cur).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined));
      if (st === undefined) return false;
      if (st === null) return true; // the rest does not exist yet and will be created
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
    }
    return true;
  }

  private async makeFolders(root: string, segs: string[]): Promise<string | null> {
    let cur = path.join(libraryDir(this.cfg), root);
    for (const s of segs) {
      cur = path.join(cur, s);
      try {
        await fs.promises.mkdir(cur);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const st = await fs.promises.lstat(cur);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
    }
    return cur;
  }

  // ---- POST /uploads -------------------------------------------------------------------

  async create(deviceId: string, body: unknown): Promise<Result<{ uploadId: string; offset: number }>> {
    if (typeof body !== 'object' || body === null) return fail(400, 'bad_request');
    const b = body as Record<string, unknown>;
    const { name, size, rootId } = b;
    if (typeof name !== 'string' || !validSegment(name)) return fail(400, 'bad_request');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return fail(400, 'bad_request');
    if (typeof rootId !== 'string' || !validSegment(rootId)) return fail(400, 'bad_request');
    const segs = folderSegments(b.path);
    if (!segs) return fail(400, 'bad_request');
    let md5: string | null = null;
    if (b.md5 !== undefined && b.md5 !== null && b.md5 !== '') {
      if (typeof b.md5 !== 'string' || !/^[0-9a-fA-F]{32}$/.test(b.md5)) return fail(400, 'bad_request');
      md5 = b.md5.toLowerCase();
    }
    // Optional modification time of the original (ms since epoch or ISO text), so a backed-up file
    // keeps its date and matches the phone's copy in the Library.
    let mtimeMs: number | null = null;
    if (b.mtime !== undefined && b.mtime !== null && b.mtime !== '') {
      const v = typeof b.mtime === 'number' ? b.mtime : typeof b.mtime === 'string' ? Date.parse(b.mtime) : NaN;
      if (!Number.isFinite(v) || v < 0 || v > this.now() + 86_400_000) return fail(400, 'bad_request');
      mtimeMs = Math.floor(v);
    }
    if (size > this.cfg.uploadMaxFileBytes) return fail(413, 'payload_too_large');
    if (!listRoots(this.cfg).some((r) => r.id === rootId)) return fail(404, 'not_found');
    if (!(await this.checkFolder(rootId, segs))) return fail(400, 'bad_request');

    const dir = segs.join('/');
    const key = crypto.createHash('sha256').update([deviceId, rootId, dir, name, String(size), md5 ?? ''].join('\0')).digest('hex');

    // Same file again: resume the open session (or hand back a just-finished one).
    const resumed = await this.resume(key, size);
    if (resumed) return ok(resumed);

    // Disk check: this file + what other open sessions still expect + the reserve.
    let free: number;
    try {
      free = await this.diskFree(this.cfg.dataDir);
    } catch {
      free = Number.MAX_SAFE_INTEGER; // cannot tell: the write itself will fail with ENOSPC if needed
    }
    if (size + (await this.reserved()) + this.cfg.uploadMinFreeBytes > free) return fail(507, 'insufficient_storage');

    const id = crypto.randomBytes(16).toString('base64url');
    const t = this.now();
    await fs.promises.mkdir(uploadsDir(this.cfg), { recursive: true, mode: 0o700 });
    const fh = await fs.promises.open(this.tmpPath(id), 'wx', 0o600);
    await fh.close();
    try {
      this.db
        .prepare("INSERT INTO uploads (id, device_id, key, root, dir, name, size, md5, mtime_ms, state, final_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)")
        .run(id, deviceId, key, rootId, dir, name, size, md5, mtimeMs, t, t);
    } catch (e) {
      await fs.promises.rm(this.tmpPath(id), { force: true });
      // A parallel identical request won the race: use its session.
      const again = await this.resume(key, size);
      if (again) return ok(again);
      throw e;
    }
    return ok({ uploadId: id, offset: 0 });
  }

  private async resume(key: string, size: number): Promise<{ uploadId: string; offset: number } | null> {
    const open = this.db.prepare("SELECT * FROM uploads WHERE key = ? AND state = 'open'").get(key) as Row | undefined;
    if (open) {
      const st = await fs.promises.stat(this.tmpPath(open.id)).catch(() => null);
      if (st) {
        this.db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(this.now(), open.id);
        return { uploadId: open.id, offset: st.size };
      }
      this.db.prepare('DELETE FROM uploads WHERE id = ?').run(open.id); // temp file vanished: start over
    }
    // Only a finished upload whose content was verified (md5 given) may be handed back: without a
    // checksum, two different files with the same name and size must both be kept, never merged.
    const done = this.db
      .prepare("SELECT * FROM uploads WHERE key = ? AND state = 'done' AND md5 IS NOT NULL AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1")
      .get(key, this.now() - DONE_RETENTION_MS) as Row | undefined;
    if (done?.final_path) {
      const st = await fs.promises.lstat(path.join(libraryDir(this.cfg), done.root, ...done.final_path.split('/'))).catch(() => null);
      // The file is there: tell the client it is all sent, its "complete" returns the item again.
      if (st?.isFile() && st.size === size) return { uploadId: done.id, offset: size };
    }
    return null;
  }

  // ---- PATCH /uploads/:id --------------------------------------------------------------

  async patch(
    id: string,
    offsetHeader: unknown,
    payload: Readable,
    contentLength: number | null,
  ): Promise<Result<{ offset: number }>> {
    if (!ID_RE.test(id)) return fail(404, 'not_found');
    if (typeof offsetHeader !== 'string' || !/^\d{1,16}$/.test(offsetHeader)) return fail(400, 'bad_request');
    const claimed = Number(offsetHeader);
    return this.locked(id, async () => {
      const row = this.row(id);
      if (!row || row.state !== 'open') return fail(404, 'not_found');
      const tmp = this.tmpPath(id);
      const st = await fs.promises.stat(tmp).catch(() => null);
      if (!st) {
        this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
        return fail(404, 'not_found');
      }
      const current = st.size;
      if (claimed !== current) return fail(409, 'offset_mismatch', { offset: current });
      const remaining = row.size - current;
      const limit = Math.min(this.cfg.uploadMaxChunkBytes, remaining);
      if (contentLength !== null) {
        if (contentLength > this.cfg.uploadMaxChunkBytes) return fail(413, 'payload_too_large');
        if (contentLength > remaining) return fail(400, 'bad_request');
      }
      if (remaining === 0) {
        payload.resume();
        return ok({ offset: current });
      }
      let free = Number.MAX_SAFE_INTEGER;
      try {
        free = await this.diskFree(this.cfg.dataDir);
      } catch {
        // cannot tell; ENOSPC below still protects us
      }
      if ((contentLength ?? 1) + this.cfg.uploadMinFreeBytes > free) {
        payload.resume();
        return fail(507, 'insufficient_storage');
      }

      const fh = await fs.promises.open(tmp, 'r+');
      let pos = current;
      let overflow = false;
      let aborted = false;
      let noSpace = false;
      try {
        for await (const chunk of payload as AsyncIterable<Buffer>) {
          if (pos + chunk.length - current > limit) {
            overflow = true;
            break;
          }
          await fh.write(chunk, 0, chunk.length, pos);
          pos += chunk.length;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOSPC') noSpace = true;
        else aborted = true; // the connection dropped: keep the bytes already written
      }
      try {
        if (overflow || noSpace) await fh.truncate(current); // refuse the whole chunk
      } finally {
        await fh.close();
      }
      if (overflow) {
        payload.destroy();
        return contentLength === null || contentLength <= this.cfg.uploadMaxChunkBytes ? fail(400, 'bad_request') : fail(413, 'payload_too_large');
      }
      if (noSpace) return fail(507, 'insufficient_storage');
      this.db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(this.now(), id);
      if (aborted) return fail(400, 'bad_request', { offset: pos });
      return ok({ offset: pos });
    });
  }

  // ---- POST /uploads/:id/complete ------------------------------------------------------

  async complete(id: string): Promise<Result<ItemJson>> {
    if (!ID_RE.test(id)) return fail(404, 'not_found');
    return this.locked(id, async () => {
      const row = this.row(id);
      if (!row) return fail(404, 'not_found');
      if (row.state === 'done') {
        const item = row.final_path ? await this.indexer.indexPath(row.root, row.final_path) : null;
        return item ? ok(toJson(item)) : fail(404, 'not_found');
      }
      const tmp = this.tmpPath(id);
      const st = await fs.promises.stat(tmp).catch(() => null);
      if (!st) {
        this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
        return fail(404, 'not_found');
      }
      if (st.size !== row.size) return fail(400, 'upload_incomplete', { offset: st.size });

      if (row.md5) {
        const actual = await md5OfFile(tmp);
        if (actual !== row.md5) {
          // The bytes are wrong: resuming would never fix it. Drop the session so the client starts clean.
          await fs.promises.rm(tmp, { force: true });
          this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
          return fail(422, 'md5_mismatch');
        }
      }

      const segs = row.dir === '' ? [] : row.dir.split('/');
      const folder = await this.makeFolders(row.root, segs);
      if (!folder) return fail(400, 'bad_request');

      const sync = await fs.promises.open(tmp, 'r');
      try {
        await sync.sync();
      } finally {
        await sync.close();
      }

      if (row.mtime_ms !== null) {
        const when = new Date(row.mtime_ms);
        await fs.promises.utimes(tmp, when, when); // the hard link shares this inode
      }

      let finalName = row.name;
      for (let n = 0; ; n++) {
        finalName = n === 0 ? row.name : suffixedName(row.name, n);
        const target = path.join(folder, finalName);
        try {
          await place(tmp, target);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' && n < 10_000) continue;
          if (code === 'ENOSPC') return fail(507, 'insufficient_storage');
          if (code === 'ENAMETOOLONG') return fail(400, 'bad_request');
          throw e;
        }
      }
      await fs.promises.rm(tmp, { force: true });
      const rel = [...segs, finalName].join('/');
      this.db.prepare("UPDATE uploads SET state = 'done', final_path = ?, updated_at = ? WHERE id = ?").run(rel, this.now(), id);
      const item = await this.indexer.indexPath(row.root, rel);
      if (!item) {
        this.log.error({ uploadId: id }, 'uploaded file could not be indexed');
        return fail(500, 'internal_error');
      }
      this.log.info({ uploadId: id, root: row.root, size: row.size, renamed: finalName !== row.name }, 'upload completed');
      return ok(toJson(item));
    });
  }

  // ---- cleanup -------------------------------------------------------------------------

  /** Drops idle sessions, old "done" rows and orphaned temp files. Returns what it removed. */
  async cleanup(): Promise<{ sessions: number; orphans: number }> {
    const t = this.now();
    const ttl = this.cfg.uploadSessionTtlHours * 3_600_000;
    const stale = this.db.prepare("SELECT id FROM uploads WHERE state = 'open' AND updated_at < ?").all(t - ttl) as unknown as { id: string }[];
    for (const s of stale) {
      await this.locked(s.id, async () => {
        await fs.promises.rm(this.tmpPath(s.id), { force: true });
        this.db.prepare("DELETE FROM uploads WHERE id = ? AND state = 'open'").run(s.id);
      });
    }
    this.db.prepare("DELETE FROM uploads WHERE state = 'done' AND updated_at < ?").run(t - DONE_RETENTION_MS);

    let orphans = 0;
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(uploadsDir(this.cfg));
    } catch {
      return { sessions: stale.length, orphans };
    }
    const known = new Set((this.db.prepare("SELECT id FROM uploads WHERE state = 'open'").all() as unknown as { id: string }[]).map((r) => r.id));
    for (const n of names) {
      if (known.has(n)) continue;
      const file = path.join(uploadsDir(this.cfg), n);
      const st = await fs.promises.lstat(file).catch(() => null);
      // A file younger than an hour may belong to a request that is being created right now.
      if (st && t - st.mtimeMs > 3_600_000) {
        await fs.promises.rm(file, { force: true, recursive: true });
        orphans++;
      }
    }
    return { sessions: stale.length, orphans };
  }

  /** Startup cleanup, then hourly. */
  start(): void {
    const run = () => void this.cleanup().catch((e) => this.log.error({ err: { message: (e as Error).message } }, 'upload cleanup failed'));
    run();
    this.timer = setInterval(run, 3_600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Atomic "move without overwrite": a hard link fails when the name exists. */
async function place(tmp: string, target: string): Promise<void> {
  try {
    await fs.promises.link(tmp, target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw e;
    // Filesystem without hard links: exclusive copy (still never overwrites).
    try {
      await fs.promises.copyFile(tmp, target, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      // Never remove a file that was already there (EEXIST); only our own half-written copy.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await fs.promises.rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

function md5OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
