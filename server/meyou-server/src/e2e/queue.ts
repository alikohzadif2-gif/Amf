// Encrypted queue (sharing track, stage 2): a temporary mailbox of OPAQUE blobs between the two phones.
// The phones encrypt everything (XChaCha20-Poly1305); the server never has a key and never looks inside.
// It knows: who sent a blob to whom, when, and how many bytes. A blob stays until the recipient ACKs it
// (then the row is deleted) or until the TTL passes. Blobs and their ids are never logged.
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { activeDevices, partnerOf, type Db, type DeviceRow } from '../db.js';
import type { SocketHub } from './hub.js';
import { fail, ok, type Result } from '../result.js';
import type { Push } from '../push/service.js';
import { createSilentPushCoalescer, type Coalescer } from './coalesce.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
/** The sockets are compared with the database this often (a token rotated by the CLI closes them). */
const SWEEP_EVERY_MS = 30_000;
/** One GET answers at most this many blobs / bytes (the first blob is always sent, whatever its size). */
export const LIST_MAX_MESSAGES = 50;
export const LIST_MAX_BYTES = 4 * 1024 * 1024;
export const ACK_MAX = 200;

export interface QueueMessage {
  seq: number;
  time: string;
  /** Sender's id for this blob (idempotency + de-duplication on the phone). */
  id: string;
  /** base64url of the encrypted blob. */
  blob: string;
}

export interface E2eOptions {
  now?: () => number;
  /** Wakes the recipient's phone with a data-only push (no content, no type). */
  push?: Push;
  /** Extra hourly housekeeping (the household drops used/expired invites). */
  onPrune?: () => void;
}

/** base64url (no padding) length of `n` bytes. */
export const b64Length = (n: number): number => Math.ceil((n * 4) / 3);

export class E2eQueue {
  private readonly now: () => number;
  private readonly push: Push | undefined;
  private readonly onPrune: (() => void) | undefined;
  private readonly coalescer: Coalescer = createSilentPushCoalescer(10_000);
  private timer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    readonly hub: SocketHub,
    private readonly log: FastifyBaseLogger,
    opts: E2eOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    // Presence: when a phone's socket opens / closes, the other phone's open sockets are told (one tiny frame, no polling).
    this.hub.setPresenceListener((deviceId, online) => {
      const row = this.db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(deviceId) as DeviceRow | undefined;
      const partner = row ? partnerOf(this.db, row) : null;
      if (partner) this.hub.sendPresence(partner.id, online);
    });
    this.push = opts.push;
    this.onPrune = opts.onPrune;
  }

  start(): void {
    this.hub.start();
    this.prune();
    if (this.timer) return;
    this.timer = setInterval(() => this.prune(), 60 * 60 * 1000);
    this.timer.unref();
    this.sweepTimer = setInterval(() => this.sweepSockets(), SWEEP_EVERY_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.timer = null;
    this.sweepTimer = null;
    this.coalescer.stop();
    this.hub.stop();
  }

  /** Is the partner's phone connected right now (app open)? false without a partner. */
  partnerOnline(device: DeviceRow): boolean {
    const partner = partnerOf(this.db, device);
    return partner ? this.hub.isOnline(partner.id) : false;
  }

  sweepSockets(): number {
    const stmt = this.db.prepare('SELECT token_hash FROM devices WHERE id = ? AND revoked_at IS NULL');
    return this.hub.sweep((id) => (stmt.get(id) as { token_hash: string } | undefined)?.token_hash ?? null);
  }

  /** Stores one blob for the partner. A repeated `id` from the same device returns the first row (200, no duplicate). */
  post(from: DeviceRow, body: unknown): Result<{ seq: number; time: string; duplicate?: true }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request');
    const b = body as { id?: unknown; blob?: unknown; wake?: unknown };
    // `wake` (optional, default false): the sender asks for a visible, generic push. It is the only hint about the message the server gets.
    if (b.wake !== undefined && typeof b.wake !== 'boolean') return fail(400, 'bad_request');
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return fail(400, 'bad_request');
    if (typeof b.blob !== 'string' || b.blob.length === 0 || !B64URL_RE.test(b.blob) || b.blob.length % 4 === 1) return fail(400, 'bad_request');
    // Size is checked on the text first, so an oversized body is never decoded.
    if (b.blob.length > b64Length(this.cfg.e2eMaxBlobBytes)) return fail(413, 'payload_too_large');
    const bytes = Buffer.from(b.blob, 'base64url');
    if (bytes.length === 0 || bytes.length > this.cfg.e2eMaxBlobBytes) return fail(413, 'payload_too_large');

    const partner = activeDevices(this.db, from.household_id).find((d) => d.id !== from.id);
    if (!partner) return fail(409, 'no_partner');

    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    let seq: number;
    try {
      const old = this.db.prepare('SELECT seq, at_ms FROM e2e_queue WHERE from_device = ? AND client_id = ?').get(from.id, b.id) as { seq: number; at_ms: number } | undefined;
      if (old) {
        this.db.exec('COMMIT');
        return ok({ seq: old.seq, time: new Date(old.at_ms).toISOString(), duplicate: true });
      }
      this.db.prepare('DELETE FROM e2e_queue WHERE to_device = ? AND at_ms < ?').run(partner.id, now - this.ttlMs());
      const used = (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM e2e_queue WHERE to_device = ?').get(partner.id) as { n: number }).n;
      if (used + bytes.length > this.cfg.e2eMaxQueueBytes) {
        this.db.exec('ROLLBACK');
        return fail(507, 'queue_full');
      }
      const res = this.db
        .prepare('INSERT INTO e2e_queue (household_id, to_device, from_device, client_id, at_ms, size, blob) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(from.household_id, partner.id, from.id, b.id, now, bytes.length, bytes);
      seq = Number(res.lastInsertRowid);
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    const time = new Date(now).toISOString();
    // Live delivery to the recipient's open sockets (never an echo to the sender).
    this.hub.deliver(partner.id, { seq, time, body: { id: b.id, blob: b.blob } });
    // The push carries no content and no message type. `wake` = a generic visible text ("new update from your partner"); otherwise data only.
    if (b.wake === true) this.push?.notify(partner, 'e2e', seq, { silent: false });
    else if (this.coalescer.silent(partner.id, seq, (latest) => this.push?.notify(partner, 'e2e', latest, { silent: true }))) this.push?.notify(partner, 'e2e', seq, { silent: true });
    return ok({ seq, time });
  }

  /** Blobs waiting for this device after `since`. They stay until ACKed. */
  list(device: DeviceRow, since: number, limit: number): { messages: QueueMessage[]; cursor: string; more: boolean } {
    const rows = this.db
      .prepare('SELECT seq, at_ms, client_id, size, blob FROM e2e_queue WHERE to_device = ? AND seq > ? AND at_ms >= ? ORDER BY seq LIMIT ?')
      .all(device.id, since, this.now() - this.ttlMs(), Math.min(limit, LIST_MAX_MESSAGES) + 1) as unknown as { seq: number; at_ms: number; client_id: string; size: number; blob: Uint8Array }[];
    const messages: QueueMessage[] = [];
    let bytes = 0;
    let more = false;
    for (const r of rows) {
      if (messages.length >= Math.min(limit, LIST_MAX_MESSAGES) || (messages.length > 0 && bytes + r.size > LIST_MAX_BYTES)) {
        more = true;
        break;
      }
      bytes += r.size;
      messages.push({ seq: r.seq, time: new Date(r.at_ms).toISOString(), id: r.client_id, blob: Buffer.from(r.blob).toString('base64url') });
    }
    const cursor = messages.length > 0 ? messages[messages.length - 1]!.seq : since;
    return { messages, cursor: String(cursor), more };
  }

  /** The recipient has stored these blobs: delete them. Only the caller's own rows can be deleted; unknown seqs are ignored. */
  ack(device: DeviceRow, body: unknown): Result<{ deleted: number }> {
    const seqs = (body as { seqs?: unknown } | null)?.seqs;
    if (!Array.isArray(seqs) || seqs.length === 0 || seqs.length > ACK_MAX) return fail(400, 'bad_request');
    if (!seqs.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) return fail(400, 'bad_request');
    const del = this.db.prepare('DELETE FROM e2e_queue WHERE to_device = ? AND seq = ?');
    let deleted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const seq of new Set(seqs as number[])) deleted += Number(del.run(device.id, seq).changes);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return ok({ deleted });
  }

  /** What is waiting for this device: counts only. */
  stats(device: DeviceRow): { count: number; bytes: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS n FROM e2e_queue WHERE to_device = ? AND at_ms >= ?').get(device.id, this.now() - this.ttlMs()) as { c: number; n: number };
    return { count: r.c, bytes: r.n };
  }

  /** Drops blobs nobody fetched within the TTL. Returns how many. */
  prune(): number {
    const res = this.db.prepare('DELETE FROM e2e_queue WHERE at_ms < ?').run(this.now() - this.ttlMs());
    const n = Number(res.changes);
    this.onPrune?.();
    if (n > 0) this.log.info({ dropped: n }, 'encrypted queue: expired blobs dropped');
    return n;
  }

  private ttlMs(): number {
    return this.cfg.e2eTtlDays * 86_400_000;
  }
}
