// Library indexer: startup scan + periodic rescan + a hook for a single new file (used by S5
// after an upload). It never follows symlinks, ignores dotfiles, and writes items and a change
// log to SQLite. Directory entries are read asynchronously; DB writes of one folder run in one
// synchronous transaction (no await inside), so API requests never join a half-done transaction.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { libraryDir, type Config } from '../config.js';
import type { Db } from '../db.js';
import { classify } from './mime.js';
import { imageMeta, videoMeta, type Meta } from './metadata.js';
import { getItemByPath, itemId, pruneChanges, type ItemRow } from './store.js';

export interface ScanResult {
  added: number;
  updated: number;
  deleted: number;
  durationMs: number;
}

interface Entry {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  type: ItemRow['type'];
  mime: string | null;
  meta: Meta;
}

const NO_META: Meta = { width: null, height: null, duration: null };

/** Names that are never indexed: dotfiles, and anything that cannot round-trip through UTF-8. */
export function ignoredName(name: string): boolean {
  return name.startsWith('.') || name.includes('\uFFFD') || name.includes('\0');
}

class Pool {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((res) => this.queue.push(res));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ScanResult> | null = null;
  private again = false;
  private generation = 0;
  private readonly pool = new Pool(4);
  private readonly videoPool = new Pool(2);
  lastScan: ScanResult | null = null;
  private lastScanLogged = false;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  ) {
    const row = db.prepare('SELECT COALESCE(MAX(seen), 0) AS m FROM items').get() as { m: number };
    this.generation = row.m;
  }

  /** Startup scan in the background, then every SCAN_INTERVAL_SECONDS (0 = never again). */
  start(): void {
    void this.scan().catch((e) => this.log.error({ err: { message: (e as Error).message } }, 'library scan failed'));
    if (this.cfg.scanIntervalSeconds > 0) {
      this.timer = setInterval(() => {
        if (this.running) return;
        void this.scan().catch((e) => this.log.error({ err: { message: (e as Error).message } }, 'library scan failed'));
      }, this.cfg.scanIntervalSeconds * 1000);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Full rescan. Concurrent calls are chained: the returned scan started after the call. */
  async scan(): Promise<ScanResult> {
    if (this.running) {
      this.again = true;
      await this.running.catch(() => undefined);
      if (this.running) return this.running;
    }
    const p = this.doScan().finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return p;
  }

  private async doScan(): Promise<ScanResult> {
    const t0 = Date.now();
    const lib = libraryDir(this.cfg);
    let top: fs.Dirent[];
    try {
      top = await fs.promises.readdir(lib, { withFileTypes: true });
    } catch (e) {
      // Library missing (e.g. volume not mounted): never treat that as "everything was deleted".
      throw new Error(`library folder unreadable: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    const gen = ++this.generation;
    const res: ScanResult = { added: 0, updated: 0, deleted: 0, durationMs: 0 };
    const roots = top.filter((d) => d.isDirectory() && !d.isSymbolicLink() && !ignoredName(d.name)).map((d) => d.name);

    for (const root of roots) {
      const rootAbs = path.join(lib, root);
      await this.walk(root, rootAbs, '', gen, res);
    }

    // Anything not seen in this generation is gone (or its root is gone).
    this.db.exec('BEGIN');
    try {
      const gone = this.db.prepare('SELECT id, root, path FROM items WHERE seen != ?').all(gen) as unknown as { id: string; root: string; path: string }[];
      const now = new Date().toISOString();
      const ins = this.db.prepare("INSERT INTO changes (id, op, root, path, at) VALUES (?, 'delete', ?, ?, ?)");
      for (const g of gone) ins.run(g.id, g.root, g.path, now);
      this.db.prepare('DELETE FROM items WHERE seen != ?').run(gen);
      res.deleted += gone.length;
      pruneChanges(this.db);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    res.durationMs = Date.now() - t0;
    this.lastScan = res;
    const changed = res.added + res.updated + res.deleted > 0;
    // Quiet when nothing changed (the periodic rescan runs every few minutes).
    if (changed || !this.lastScanLogged) this.log.info({ ...res }, 'library scan finished');
    this.lastScanLogged = true;
    return res;
  }

  private async walk(root: string, absDir: string, relDir: string, gen: number, res: ScanResult): Promise<void> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch {
      // Unreadable folder: keep what we know about its subtree instead of deleting it.
      this.keepSubtree(root, relDir, gen);
      return;
    }
    const subdirs: string[] = [];
    const entries = (
      await Promise.all(
        dirents.map((d) =>
          this.pool.run(async (): Promise<Entry | null> => {
            if (ignoredName(d.name) || d.isSymbolicLink()) return null;
            const rel = relDir ? `${relDir}/${d.name}` : d.name;
            const abs = path.join(absDir, d.name);
            try {
              if (d.isDirectory()) {
                const st = await fs.promises.lstat(abs);
                return { name: d.name, rel, isDir: true, size: 0, mtimeMs: Math.floor(st.mtimeMs), type: 'dir', mime: null, meta: NO_META };
              }
              if (!d.isFile()) return null; // sockets, fifos, devices
              const st = await fs.promises.lstat(abs);
              const existing = getItemByPath(this.db, root, rel);
              const unchanged = existing && existing.size === st.size && existing.mtime_ms === Math.floor(st.mtimeMs);
              if (unchanged) {
                return { name: d.name, rel, isDir: false, size: st.size, mtimeMs: existing.mtime_ms, type: existing.type, mime: existing.mime, meta: { width: existing.width, height: existing.height, duration: existing.duration } };
              }
              const kind = await classify(d.name, abs);
              let meta = NO_META;
              if (kind.type === 'image') meta = await imageMeta(abs);
              else if (kind.type === 'video') meta = await this.videoPool.run(() => videoMeta(abs));
              return { name: d.name, rel, isDir: false, size: st.size, mtimeMs: Math.floor(st.mtimeMs), type: kind.type, mime: kind.mime, meta };
            } catch {
              return null; // vanished between readdir and stat
            }
          }),
        ),
      )
    ).filter((e): e is Entry => e !== null);

    this.apply(root, relDir, entries, gen, res);
    for (const e of entries) if (e.isDir) subdirs.push(e.name);
    for (const name of subdirs) {
      await this.walk(root, path.join(absDir, name), relDir ? `${relDir}/${name}` : name, gen, res);
    }
  }

  /** Synchronous: one transaction per folder, no await inside. */
  private apply(root: string, parent: string, entries: Entry[], gen: number, res: ScanResult): void {
    this.db.exec('BEGIN');
    try {
      const now = new Date().toISOString();
      const find = this.db.prepare('SELECT size, mtime_ms, is_dir FROM items WHERE id = ?');
      const upsert = this.db.prepare(
        `INSERT INTO items (id, root, path, parent, name, name_sort, is_dir, type, size, mtime_ms, mime, width, height, duration, seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET is_dir = excluded.is_dir, type = excluded.type, size = excluded.size, mtime_ms = excluded.mtime_ms,
           mime = excluded.mime, width = excluded.width, height = excluded.height, duration = excluded.duration, seen = excluded.seen`,
      );
      const log = this.db.prepare('INSERT INTO changes (id, op, root, path, at) VALUES (?, ?, ?, ?, ?)');
      for (const e of entries) {
        const id = itemId(root, e.rel);
        const old = find.get(id) as { size: number; mtime_ms: number; is_dir: number } | undefined;
        upsert.run(id, root, e.rel, parent, e.name, e.name.toLowerCase(), e.isDir ? 1 : 0, e.type, e.size, e.mtimeMs, e.mime, e.meta.width, e.meta.height, e.meta.duration, gen);
        if (!old) {
          log.run(id, 'add', root, e.rel, now);
          res.added++;
        } else if (!e.isDir && (old.size !== e.size || old.mtime_ms !== e.mtimeMs)) {
          log.run(id, 'update', root, e.rel, now);
          res.updated++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private keepSubtree(root: string, relDir: string, gen: number): void {
    if (relDir === '') {
      this.db.prepare('UPDATE items SET seen = ? WHERE root = ?').run(gen, root);
      return;
    }
    const like = relDir.replace(/[\\%_]/g, (c) => `\\${c}`) + '/%';
    this.db.prepare("UPDATE items SET seen = ? WHERE root = ? AND (path = ? OR path LIKE ? ESCAPE '\\')").run(gen, root, relDir, like);
  }

  /**
   * Hook for S5: index one file (and its missing parent folders) right after an upload,
   * without a full scan. Returns the item row, or null when the path is not a regular file.
   */
  async indexPath(root: string, relPath: string): Promise<ItemRow | null> {
    const lib = libraryDir(this.cfg);
    const parts = relPath.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || ignoredName(p))) return null;
    const rootAbs = path.join(lib, root);
    // Make sure every parent folder is indexed.
    let cur = '';
    let curAbs = rootAbs;
    for (const part of parts.slice(0, -1)) {
      const parent = cur;
      cur = cur ? `${cur}/${part}` : part;
      curAbs = path.join(curAbs, part);
      const st = await fs.promises.lstat(curAbs).catch(() => null);
      if (!st || !st.isDirectory()) return null;
      this.apply(root, parent, [{ name: part, rel: cur, isDir: true, size: 0, mtimeMs: Math.floor(st.mtimeMs), type: 'dir', mime: null, meta: NO_META }], this.generation, { added: 0, updated: 0, deleted: 0, durationMs: 0 });
    }
    const abs = path.join(curAbs, parts[parts.length - 1]!);
    const st = await fs.promises.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) return null;
    const name = parts[parts.length - 1]!;
    const kind = await classify(name, abs);
    let meta = NO_META;
    if (kind.type === 'image') meta = await imageMeta(abs);
    else if (kind.type === 'video') meta = await this.videoPool.run(() => videoMeta(abs));
    this.apply(root, parts.slice(0, -1).join('/'), [{ name, rel: relPath, isDir: false, size: st.size, mtimeMs: Math.floor(st.mtimeMs), type: kind.type, mime: kind.mime, meta }], this.generation, { added: 0, updated: 0, deleted: 0, durationMs: 0 });
    return getItemByPath(this.db, root, relPath) ?? null;
  }
}
