// Media read API (contract A/C): /tree, /items/:id/thumb|preview|file, /changes.
// File access ALWAYS goes through the index (id -> root + relative path) and is re-checked on
// disk: resolved real path must stay inside the library, and symlinks are refused.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { libraryDir, type Config } from '../config.js';
import type { Db } from '../db.js';
import { listRoots } from '../library.js';
import { parseRange } from './range.js';
import { changesSince, decodeCursor, getItem, getItemByPath, listChildren, toJson, type ItemRow } from './store.js';
import { getRendered, PREVIEW_SIZE, snapSize, Unsupported } from './thumbs.js';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** '' for the root folder; null for anything that is not a clean relative path. */
export function cleanRelPath(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  if (raw.includes('\0') || raw.includes('\\')) return null;
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

function validRootName(raw: unknown): raw is string {
  return typeof raw === 'string' && raw !== '' && raw !== '.' && raw !== '..' && !/[\\/\0]/.test(raw);
}

function intParam(raw: unknown, def: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  if (n < min) return null;
  return Math.min(n, max);
}

interface Resolved {
  abs: string;
  size: number;
  mtimeMs: number;
}

/** Real path of an indexed file, or null when it vanished, is a symlink or leaves the library. */
async function resolveFile(cfg: Config, item: ItemRow): Promise<Resolved | null> {
  const lib = libraryDir(cfg);
  const abs = path.join(lib, item.root, ...item.path.split('/'));
  try {
    const st = await fs.promises.lstat(abs);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const [realFile, realLib] = await Promise.all([fs.promises.realpath(abs), fs.promises.realpath(lib)]);
    if (!realFile.startsWith(realLib + path.sep)) return null;
    return { abs: realFile, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const badRequest = (reply: FastifyReply) => reply.code(400).send({ error: 'bad_request' });

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function fileEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${mtimeMs.toString(16)}"`;
}

export function registerMediaRoutes(api: FastifyInstance, cfg: Config, db: Db): void {
  const mediaLimit = { rateLimit: { max: cfg.mediaRateLimitMax, timeWindow: '1 minute' } };

  api.get('/tree', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, unknown>;
    if (!validRootName(q.root)) return badRequest(reply);
    const rel = cleanRelPath(q.path);
    if (rel === null) return badRequest(reply);
    const limit = intParam(q.limit, 100, 1, 500);
    if (limit === null) return badRequest(reply);
    let cursor = null;
    if (q.cursor !== undefined && q.cursor !== '') {
      cursor = typeof q.cursor === 'string' ? decodeCursor(q.cursor) : null;
      if (!cursor) return badRequest(reply);
    }
    if (!listRoots(cfg).some((r) => r.id === q.root)) return notFound(reply);
    if (rel !== '') {
      const dir = getItemByPath(db, q.root, rel);
      if (!dir || !dir.is_dir) return notFound(reply);
    }
    const { rows, next } = listChildren(db, q.root, rel, cursor, limit);
    return next ? { items: rows.map(toJson), nextCursor: next } : { items: rows.map(toJson) };
  });

  async function image(request: FastifyRequest, reply: FastifyReply, kind: 'thumb' | 'preview') {
    const { id } = request.params as { id: string };
    if (!ID_RE.test(id)) return notFound(reply);
    let size = PREVIEW_SIZE;
    if (kind === 'thumb') {
      const n = intParam((request.query as Record<string, unknown>).size, 256, 1, 1_000_000);
      if (n === null) return badRequest(reply);
      size = snapSize(n);
    }
    const item = getItem(db, id);
    if (!item || item.is_dir) return notFound(reply);
    if (item.type !== 'image' && item.type !== 'video') return reply.code(415).send({ error: 'unsupported_media' });
    const file = await resolveFile(cfg, item);
    if (!file) return notFound(reply);
    try {
      const out = await getRendered(cfg, kind, { ...item, size: file.size, mtime_ms: file.mtimeMs }, file.abs, size);
      reply.header('ETag', out.etag).header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff');
      if (request.headers['if-none-match'] === out.etag) return reply.code(304).send();
      const st = await fs.promises.stat(out.file);
      return reply.type('image/jpeg').header('Content-Length', st.size).send(fs.createReadStream(out.file));
    } catch (e) {
      if (e instanceof Unsupported) return reply.code(415).send({ error: 'unsupported_media' });
      throw e;
    }
  }

  api.get('/items/:id/thumb', { config: mediaLimit }, (req, reply) => image(req, reply, 'thumb'));
  api.get('/items/:id/preview', { config: mediaLimit }, (req, reply) => image(req, reply, 'preview'));

  api.get('/items/:id/file', { config: mediaLimit }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID_RE.test(id)) return notFound(reply);
    const item = getItem(db, id);
    if (!item || item.is_dir) return notFound(reply);
    const file = await resolveFile(cfg, item);
    if (!file) return notFound(reply);

    const etag = fileEtag(file.size, file.mtimeMs);
    const lastModified = new Date(file.mtimeMs).toUTCString();
    const mime = item.mime ?? 'application/octet-stream';
    const isText = mime.startsWith('text/') || mime === 'application/json';
    reply
      .header('Accept-Ranges', 'bytes')
      .header('ETag', etag)
      .header('Last-Modified', lastModified)
      .header('Cache-Control', 'private, no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', contentDisposition(item.name))
      .header('Content-Type', isText ? `${mime}; charset=utf-8` : mime);

    const range = request.headers.range;
    const ifRange = request.headers['if-range'];
    // If-Range: only honour the range when the validator still matches the file.
    const useRange = range !== undefined && (ifRange === undefined || ifRange === etag || ifRange === lastModified);
    if (!useRange && request.headers['if-none-match'] === etag) return reply.code(304).send();

    const parsed = useRange ? parseRange(range, file.size) : ({ kind: 'none' } as const);
    if (parsed.kind === 'invalid') {
      return reply.code(416).header('Content-Range', `bytes */${file.size}`).header('Content-Type', 'application/json; charset=utf-8').send({ error: 'range_not_satisfiable' });
    }
    if (parsed.kind === 'range') {
      const length = parsed.end - parsed.start + 1;
      return reply
        .code(206)
        .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${file.size}`)
        .header('Content-Length', length)
        .send(fs.createReadStream(file.abs, { start: parsed.start, end: parsed.end }));
    }
    if (file.size === 0) return reply.header('Content-Length', 0).send('');
    return reply.header('Content-Length', file.size).send(fs.createReadStream(file.abs));
  });

  api.get('/changes', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const since = intParam(q.since, 0, 0, Number.MAX_SAFE_INTEGER);
    if (since === null) return badRequest(reply);
    const limit = intParam(q.limit, 500, 1, 1000);
    if (limit === null) return badRequest(reply);
    const r = changesSince(db, since, limit);
    return { changes: r.changes, cursor: String(r.cursor) };
  });
}
