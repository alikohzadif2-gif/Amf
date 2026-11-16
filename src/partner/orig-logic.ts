import { b64urlDecode, b64urlEncode } from '../e2e/base64';

/**
 * Sharing track, stage 6 (first half): the ORIGINAL file of a shared photo, asked for from the sender's phone ("full quality").
 * Pure rules with injected dependencies (no React Native imports), so the test suite runs it in Node.
 *
 * Nothing is stored on the server: the file travels as encrypted queue messages (the same transport as every other message),
 * each at most ~256 KB of file, and the queue deletes every one at the receiver's ACK.
 *
 *   receiver -> sender   orig-req    {rid, ref}                       "send me the original of `ref`"
 *   sender   -> receiver orig-meta   {rid, ref, size, chunks, ext}    "yes, here it comes" (or orig-nack: file missing / too big)
 *   sender   -> receiver orig-chunk  {rid, i, data}                   chunk i of `chunks`, in order, data = base64url
 *   receiver -> sender   orig-cancel {rid}                            "stop" (no space, out of order, the person cancelled)
 *
 * Stage 6 second half (video): the receiver PULLS in windows of `ORIG_WINDOW_CHUNKS` (4 MB): `orig-req` carries `start` (first chunk) and
 * `count`; when the window is applied the receiver asks for the next one. So the queue never holds more than one window per transfer,
 * and a transfer that stopped (phone closed, partner offline) is RESUMED from the first missing chunk with a new request.
 * A video is downloaded into the cache in this way and played from the file when it is complete (see docs/SHARING_ORIGINALS.md).
 *
 * The sender's phone is assumed to be online. If it is not, the request is never answered: the receiver stops waiting after
 * `ORIG_META_WAIT_MS` and tells the person so. The sender ignores a request older than `ORIG_REQUEST_MAX_AGE_MS` (it may have
 * waited in the queue for a phone that was off), so an old tap never starts a big transfer later.
 * Integrity: every chunk is authenticated by the envelope (XChaCha20-Poly1305); the receiver also checks the order, the exact
 * length of every chunk and the total size. A whole-file SHA-256 comes with the hash/sync work of stage 7.
 */
export const ORIG_CHUNK_BYTES = 256 * 1024;
/** base64url characters of one full chunk (no padding). */
export const ORIG_CHUNK_B64_CHARS = Math.ceil((ORIG_CHUNK_BYTES * 4) / 3);
/** Biggest original that is sent. Photos are far below it; a bigger file is refused with a clear reason (`too-big`). */
export const ORIG_MAX_BYTES = 40 * 1024 * 1024;
/** Biggest video that is sent (1 GiB); it must also fit the partner's cache cap, which is checked before the first chunk. */
export const ORIG_VIDEO_MAX_BYTES = 1024 * 1024 * 1024;
export const ORIG_MAX_CHUNKS = Math.ceil(ORIG_VIDEO_MAX_BYTES / ORIG_CHUNK_BYTES);
/** Chunks the sender sends per request (4 MB). */
export const ORIG_WINDOW_CHUNKS = 16;

const VIDEO_EXT = /^(mp4|m4v|mov|3gp|webm|mkv)$/;
/** True for a path or file name that is a video the app can play. */
export const isVideoName = (name: string): boolean => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name.split('?')[0]);
  return !!m && VIDEO_EXT.test(m[1].toLowerCase());
};
/** The size limit for a file with this extension. */
export const origMaxBytes = (ext: string): number => (VIDEO_EXT.test(ext) ? ORIG_VIDEO_MAX_BYTES : ORIG_MAX_BYTES);
export const ORIG_REQUEST_MAX_AGE_MS = 3 * 60 * 1000;
/** How long the person waits for the sender's phone to answer before "the other phone is not online". */
export const ORIG_META_WAIT_MS = 30 * 1000;
/** After the transfer started: no new chunk for this long = failed. */
export const ORIG_IDLE_MS = 60 * 1000;
/** An unfinished transfer record older than this is cleaned up at the next start. */
export const ORIG_STALE_MS = 24 * 3600 * 1000;
/** Free space that must stay after the file is stored. */
export const ORIG_SPACE_MARGIN_BYTES = 50 * 1024 * 1024;

type Head = { from: string; ts: string; silent: true; rid: string };
/** `start` = first chunk wanted (resume; not `from`, which is the sender's device id), `count` = how many (1..ORIG_WINDOW_CHUNKS); absent = from 0, one window. */
export type OrigRequestMessage = Head & { t: 'orig-req'; ref: string; start?: number; count?: number };
export type OrigMetaMessage = Head & { t: 'orig-meta'; ref: string; size: number; chunks: number; ext: string };
export type OrigChunkMessage = Head & { t: 'orig-chunk'; i: number; data: string };
export type OrigNackReason = 'missing' | 'too-big';
export type OrigNackMessage = Head & { t: 'orig-nack'; reason: OrigNackReason };
export type OrigCancelMessage = Head & { t: 'orig-cancel' };
export type OrigMessage = OrigRequestMessage | OrigMetaMessage | OrigChunkMessage | OrigNackMessage | OrigCancelMessage;

const RID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const EXT_RE = /^[a-z0-9]{1,5}$/;
export const isRid = (v: unknown): v is string => typeof v === 'string' && RID_RE.test(v);
export const chunkCount = (size: number): number => Math.ceil(size / ORIG_CHUNK_BYTES);
/** Exact byte length chunk `i` must have for a file of `size` bytes. */
export const chunkLength = (size: number, i: number): number => Math.min(ORIG_CHUNK_BYTES, size - i * ORIG_CHUNK_BYTES);

/** Lower-case extension of a file name when it is short and plain; `jpg` otherwise. */
export function origExt(name: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name.split('?')[0]);
  const ext = match ? match[1].toLowerCase() : 'jpg';
  return EXT_RE.test(ext) ? ext : 'jpg';
}

/**
 * Validates the stage-6 messages of a decoded body. `sharedPath` is the caller's own path check (the same one every other message
 * uses). Returns undefined when `d.t` is not one of ours, null when it is ours but invalid.
 */
export function decodeOrig(d: Record<string, unknown>, base: { from: string; ts: string }, sharedPath: (v: unknown) => string | undefined): OrigMessage | null | undefined {
  if (typeof d.t !== 'string' || !d.t.startsWith('orig-')) return undefined;
  if (!isRid(d.rid)) return null;
  const head = { ...base, silent: true as const, rid: d.rid };
  switch (d.t) {
    case 'orig-req': {
      const ref = sharedPath(d.ref);
      if (!ref) return null;
      const start = d.start;
      const count = d.count;
      if (start !== undefined && (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start >= ORIG_MAX_CHUNKS)) return null;
      if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > ORIG_WINDOW_CHUNKS)) return null;
      return { ...head, t: 'orig-req', ref, ...(start !== undefined ? { start } : {}), ...(count !== undefined ? { count } : {}) };
    }
    case 'orig-meta': {
      const ref = sharedPath(d.ref);
      const size = d.size;
      const chunks = d.chunks;
      if (!ref || typeof d.ext !== 'string' || !EXT_RE.test(d.ext)) return null;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > origMaxBytes(d.ext)) return null;
      if (typeof chunks !== 'number' || chunks !== chunkCount(size)) return null;
      return { ...head, t: 'orig-meta', ref, size, chunks, ext: d.ext };
    }
    case 'orig-chunk': {
      const i = d.i;
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= ORIG_MAX_CHUNKS) return null;
      if (typeof d.data !== 'string' || d.data.length < 2 || d.data.length > ORIG_CHUNK_B64_CHARS || !/^[A-Za-z0-9_-]+$/.test(d.data)) return null;
      return { ...head, t: 'orig-chunk', i, data: d.data };
    }
    case 'orig-nack':
      return d.reason === 'missing' || d.reason === 'too-big' ? { ...head, t: 'orig-nack', reason: d.reason } : null;
    case 'orig-cancel':
      return { ...head, t: 'orig-cancel' };
    default:
      return null;
  }
}

/** A request is served only while it is fresh (the future is tolerated up to the same span: phone clocks differ). */
export const isFreshRequest = (ts: string, nowMs: number): boolean => {
  const at = Date.parse(ts);
  return !Number.isNaN(at) && Math.abs(nowMs - at) <= ORIG_REQUEST_MAX_AGE_MS;
};

// ---------------------------------------------------------------- sender

export type OriginalSource = { size: number; ext: string; read: (offset: number, length: number) => Promise<Uint8Array> };

export type ServeDeps = {
  /** The phone file behind a shared `ref`, or null when it is not (or no longer) readable. */
  lookup: (ref: string) => Promise<OriginalSource | null>;
  /** Seals and posts one message; throws when it could not be posted. */
  send: (message: OrigMessage) => Promise<void>;
  /** The receiver sent `orig-cancel` for this request. */
  cancelled: (rid: string) => boolean;
  from: string;
  nowIso: () => string;
};

export type ServeResult = 'sent' | 'missing' | 'too-big' | 'cancelled' | 'failed';

/** Answers one request: meta, then the chunks in order, one post at a time. Stops at a cancel or a failed post. Never throws. */
export async function serveOriginal(deps: ServeDeps, req: { rid: string; ref: string; start?: number; count?: number }): Promise<ServeResult> {
  const head = () => ({ from: deps.from, ts: deps.nowIso(), silent: true as const, rid: req.rid });
  const nack = async (reason: OrigNackReason): Promise<ServeResult> => {
    try {
      await deps.send({ ...head(), t: 'orig-nack', reason });
    } catch {
      // the receiver stops waiting by itself
    }
    return reason;
  };
  let source: OriginalSource | null = null;
  try {
    source = await deps.lookup(req.ref);
  } catch {
    source = null;
  }
  if (!source || source.size < 1) return nack('missing');
  const ext = EXT_RE.test(source.ext) ? source.ext : 'jpg';
  if (source.size > origMaxBytes(ext)) return nack('too-big');
  const chunks = chunkCount(source.size);
  const first = req.start ?? 0;
  if (first >= chunks) return nack('missing');
  const last = Math.min(chunks, first + (req.count ?? ORIG_WINDOW_CHUNKS));
  try {
    await deps.send({ ...head(), t: 'orig-meta', ref: req.ref, size: source.size, chunks, ext });
    for (let i = first; i < last; i += 1) {
      if (deps.cancelled(req.rid)) return 'cancelled';
      const bytes = await source.read(i * ORIG_CHUNK_BYTES, chunkLength(source.size, i));
      if (bytes.length !== chunkLength(source.size, i)) {
        // the file changed under us: tell the receiver instead of sending a broken file
        await nack('missing');
        return 'failed';
      }
      await deps.send({ ...head(), t: 'orig-chunk', i, data: b64urlEncode(bytes) });
    }
    return 'sent';
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------- receiver

/** `next` = first chunk still missing; `until` = end (exclusive) of the window asked for; when `next` reaches it the next window is asked. */
export type Transfer = { rid: string; ref: string; state: 'asked' | 'receiving'; ext: string; size: number; chunks: number; next: number; until: number; file: string; updated: number };

export interface TransferStore {
  get(rid: string): Promise<Transfer | null>;
  put(t: Transfer): Promise<void>;
  remove(rid: string): Promise<void>;
}

export interface PartStore {
  /** Creates / empties the part file of this transfer. */
  start(t: Transfer): Promise<void>;
  append(t: Transfer, bytes: Uint8Array): Promise<void>;
  /** Verifies the total size, moves the file into the cache and registers it for `t.ref`. False = wrong size (nothing registered). */
  finish(t: Transfer): Promise<boolean>;
  discard(t: Transfer): Promise<void>;
}

export type ReceiveDeps = {
  transfers: TransferStore;
  parts: PartStore;
  /** Free bytes on this phone, or null when unknown. */
  freeBytes: () => Promise<number | null>;
  /** Best effort: tells the sender to stop. */
  sendCancel: (rid: string) => Promise<void>;
  /** Asks for the next window (`orig-req` with `start`). A failure is harmless: the idle timer ends the wait and the person can resume. */
  requestMore: (rid: string, ref: string, from: number, count: number) => Promise<void>;
  /** Cache cap in bytes (a file larger than it could not stay in the cache). */
  capBytes: () => number;
  now: () => number;
};

export type OrigFailure = 'space' | 'cache' | 'order' | 'size' | 'io';
export type OrigEvent =
  | { kind: 'ignored' }
  | { kind: 'meta'; rid: string; ref: string; size: number; chunks: number }
  | { kind: 'progress'; rid: string; ref: string; done: number; total: number }
  | { kind: 'done'; rid: string; ref: string }
  | { kind: 'failed'; rid: string; ref: string; reason: OrigFailure }
  | { kind: 'nack'; rid: string; ref: string; reason: OrigNackReason };

/**
 * Applies one `orig-meta`, `orig-chunk` or `orig-nack` from the partner. Only a transfer THIS phone asked for (a record created at
 * request time) is accepted: an unasked meta or chunk is ignored, so the partner's phone cannot fill this one with files.
 * Chunks must come in order; a repeated one (a replay) is ignored; a gap or a wrong length ends the transfer.
 */
export async function receiveOrig(deps: ReceiveDeps, msg: OrigMetaMessage | OrigChunkMessage | OrigNackMessage): Promise<OrigEvent> {
  const t = await deps.transfers.get(msg.rid);
  if (!t) return { kind: 'ignored' };
  const fail = async (reason: OrigFailure, cancel = true): Promise<OrigEvent> => {
    await deps.parts.discard(t).catch(() => undefined);
    await deps.transfers.remove(t.rid).catch(() => undefined);
    if (cancel) await deps.sendCancel(t.rid).catch(() => undefined);
    return { kind: 'failed', rid: t.rid, ref: t.ref, reason };
  };
  switch (msg.t) {
    case 'orig-nack': {
      await deps.parts.discard(t).catch(() => undefined);
      await deps.transfers.remove(t.rid);
      return { kind: 'nack', rid: t.rid, ref: t.ref, reason: msg.reason };
    }
    case 'orig-meta': {
      if (msg.ref !== t.ref) return { kind: 'ignored' };
      if (t.state === 'receiving') {
        // A resumed transfer: the meta of the new window must describe the same file; nothing is reset.
        if (msg.size !== t.size || msg.chunks !== t.chunks) return fail('size');
        await deps.transfers.put({ ...t, updated: deps.now() });
        return { kind: 'meta', rid: t.rid, ref: t.ref, size: msg.size, chunks: msg.chunks };
      }
      const cap = deps.capBytes();
      if (msg.size > cap) return fail('cache');
      const free = await deps.freeBytes();
      if (free !== null && free < msg.size + ORIG_SPACE_MARGIN_BYTES) return fail('space');
      const next: Transfer = { ...t, state: 'receiving', ext: msg.ext, size: msg.size, chunks: msg.chunks, next: 0, until: Math.min(msg.chunks, ORIG_WINDOW_CHUNKS), updated: deps.now() };
      try {
        await deps.parts.start(next);
      } catch {
        return fail('io');
      }
      await deps.transfers.put(next);
      return { kind: 'meta', rid: t.rid, ref: t.ref, size: msg.size, chunks: msg.chunks };
    }
    case 'orig-chunk': {
      if (t.state !== 'receiving') return { kind: 'ignored' };
      if (msg.i < t.next) return { kind: 'ignored' }; // a replay
      if (msg.i !== t.next) return fail('order');
      const bytes = b64urlDecode(msg.data);
      if (!bytes || bytes.length !== chunkLength(t.size, msg.i)) return fail('size');
      try {
        await deps.parts.append(t, bytes);
      } catch {
        return fail('io');
      }
      const advanced: Transfer = { ...t, next: t.next + 1, updated: deps.now() };
      if (advanced.next < advanced.chunks) {
        const more = advanced.next >= advanced.until; // this window is complete: ask for the next one
        if (more) advanced.until = Math.min(advanced.chunks, advanced.next + ORIG_WINDOW_CHUNKS);
        await deps.transfers.put(advanced);
        if (more) await deps.requestMore(t.rid, t.ref, advanced.next, advanced.until - advanced.next).catch(() => undefined);
        return { kind: 'progress', rid: t.rid, ref: t.ref, done: advanced.next, total: advanced.chunks };
      }
      let ok = false;
      try {
        ok = await deps.parts.finish(advanced);
      } catch {
        return fail('io', false);
      }
      if (!ok) return fail('size', false);
      await deps.transfers.remove(t.rid);
      return { kind: 'done', rid: t.rid, ref: t.ref };
    }
  }
}

/** Transfers that never finished (the phone was closed, the sender went away): their records and part files are removed. */
export function staleTransfers(all: Transfer[], nowMs: number): Transfer[] {
  return all.filter((t) => nowMs - t.updated > ORIG_STALE_MS);
}

// ---------------------------------------------------------------- waiting for the answer (the person's tap)

export type OriginalOutcome = 'ok' | 'hash' | 'offline' | 'missing' | 'too-big' | OrigFailure | 'cancelled' | 'no-keys' | 'send';

/**
 * One in-flight request per `ref`: a second tap on the same photo joins the first. `onEvent` is fed from the inbox;
 * `start` posts the request and returns its rid. The promise settles with what happened; it never rejects.
 */
export function createOriginalWaiter(opts: { metaWaitMs?: number; idleMs?: number } = {}) {
  const metaWait = opts.metaWaitMs ?? ORIG_META_WAIT_MS;
  const idle = opts.idleMs ?? ORIG_IDLE_MS;
  type Slot = { rid: string; ref: string; settle: (o: OriginalOutcome) => void; timer: ReturnType<typeof setTimeout> | null; promise: Promise<OriginalOutcome>; progress: (done: number, total: number) => void; listeners: Set<(done: number, total: number) => void> };
  const byRef = new Map<string, Slot>();
  const byRid = new Map<string, Slot>();

  const arm = (slot: Slot, ms: number, onTimeout: OriginalOutcome) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => slot.settle(onTimeout), ms);
  };

  return {
    active: (ref: string): boolean => byRef.has(ref),
    /** Starts (or joins) the request. `post` throws when the request could not be sent. */
    request(ref: string, rid: string, post: () => Promise<void>, onProgress?: (done: number, total: number) => void): Promise<OriginalOutcome> {
      const existing = byRef.get(ref);
      if (existing) {
        if (onProgress) existing.listeners.add(onProgress);
        return existing.promise;
      }
      let settle!: (o: OriginalOutcome) => void;
      const promise = new Promise<OriginalOutcome>((resolve) => {
        settle = resolve;
      });
      const slot: Slot = { rid, ref, promise, timer: null, listeners: new Set(onProgress ? [onProgress] : []), settle: () => undefined, progress: () => undefined };
      slot.settle = (o) => {
        if (slot.timer) clearTimeout(slot.timer);
        byRef.delete(ref);
        byRid.delete(rid);
        settle(o);
      };
      slot.progress = (done, total) => slot.listeners.forEach((fn) => fn(done, total));
      byRef.set(ref, slot);
      byRid.set(rid, slot);
      arm(slot, metaWait, 'offline');
      post().catch(() => slot.settle('send'));
      return promise;
    },
    /** Feeds an event from `receiveOrig`. */
    onEvent(event: OrigEvent) {
      if (event.kind === 'ignored') return;
      const slot = byRid.get(event.rid);
      if (!slot) return;
      switch (event.kind) {
        case 'meta':
          arm(slot, idle, 'io');
          break;
        case 'progress':
          arm(slot, idle, 'io');
          slot.progress(event.done, event.total);
          break;
        case 'done':
          slot.settle('ok');
          break;
        case 'failed':
          slot.settle(event.reason);
          break;
        case 'nack':
          slot.settle(event.reason);
          break;
      }
    },
    /** The person cancelled: settles at once (the caller sends `orig-cancel`). Returns the rid, or null when nothing was running. */
    cancel(ref: string): string | null {
      const slot = byRef.get(ref);
      if (!slot) return null;
      const rid = slot.rid;
      slot.settle('cancelled');
      return rid;
    },
  };
}

/**
 * Runs `job`, and when it throws tries again after each delay in `delaysMs` (a rate limit, a network blip). Throws the last error when
 * every try failed. The default delays (2 s, 8 s, 20 s) stay below the receiver's 60 s idle limit.
 */
export async function withRetry<T>(job: () => Promise<T>, delaysMs: number[] = [2000, 8000, 20000], sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await job();
    } catch (error) {
      if (attempt >= delaysMs.length) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}
