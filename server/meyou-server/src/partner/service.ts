// Partner API logic (S7): invites, join, revoke, mailbox. Pure functions over SQLite; the
// routes only translate HTTP. Secrets (tokens, invite codes) are stored as SHA-256 hashes.
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { activeDevices, type Db, type DeviceRow } from '../db.js';
import { generateId, generateInviteCode, generateToken, hashToken, CODE_ALPHABET, INVITE_CODE_LENGTH } from '../tokens.js';
import { PERIOD_KINDS, type PeriodKind, type PushHint, type PushType } from '../push/messages.js';
import type { Push } from '../push/service.js';
import type { MailboxHub, MailboxMessage } from './hub.js';

/**
 * What the push layer may know about a message (R1a): only these three markers, never content.
 * Data only (nothing shown) for a clear (`cleared`), a delete (`deleted`), an explicit `silent`, and
 * for a `period` message whose `kind` is not one of the three notifying updates.
 */
function pushHint(m: Record<string, unknown>): PushHint {
  const silent = m.silent === true || m.cleared === true || m.deleted === true;
  if (m.t !== 'period') return { silent };
  const kind = PERIOD_KINDS.find((k) => k === m.kind) as PeriodKind | undefined;
  return kind ? { silent, periodKind: kind } : { silent: true };
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; body: Record<string, unknown> };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result<never> => ({
  ok: false,
  status,
  body: { error, ...extra },
});

export const MAX_DEVICES = 2;
export const INVITE_TTL_MS = 30 * 60 * 1000;
export const MAX_MESSAGE_BYTES = 32 * 1024;
/** How often open sockets are compared with the database (see sweepSockets). */
const SWEEP_EVERY_MS = 30_000;
const MESSAGE_TYPES = new Set(['mood', 'event', 'profile', 'unpair', 'diary', 'period', 'story', 'story-seen', 'chat', 'chat-seen', 'like', 'comment']);
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

export interface PartnerOptions {
  now?: () => number;
  /** S9: wakes the recipient's phone through FCM. Absent = no push. */
  push?: Push;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  if (s.length === 0 || s.length > 64 || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export class Partner {
  private readonly now: () => number;
  private readonly push: Push | undefined;
  private timer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    readonly hub: MailboxHub,
    private readonly log: FastifyBaseLogger,
    opts: PartnerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.push = opts.push;
  }

  /** Hourly cleanup of old mailbox rows, invites and a first pass at start. */
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
  }

  /** S11: closes sockets of devices revoked or re-keyed by the CLI (another process). */
  sweepSockets(): number {
    const stmt = this.db.prepare('SELECT token_hash FROM devices WHERE id = ? AND revoked_at IS NULL');
    const n = this.hub.sweep((id) => (stmt.get(id) as { token_hash: string } | undefined)?.token_hash ?? null);
    if (n > 0) this.log.info({ closed: n }, 'sockets closed after a token change');
    return n;
  }

  // ---- invites / join ------------------------------------------------------------------

  createInvite(device: DeviceRow): Result<{ code: string; expiresAt: string }> {
    if (device.role !== 'owner') return fail(403, 'forbidden');
    if (activeDevices(this.db, device.household_id).length >= MAX_DEVICES) return fail(409, 'household_full');
    const now = this.now();
    const code = generateInviteCode();
    const expiresAt = new Date(now + INVITE_TTL_MS).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Only the newest code is valid: older unused ones are dropped.
      this.db.prepare('DELETE FROM invites WHERE household_id = ? AND used_at IS NULL').run(device.household_id);
      this.db
        .prepare('INSERT INTO invites (id, household_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(generateId(), device.household_id, hashToken(code), device.id, new Date(now).toISOString(), expiresAt);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return ok({ code, expiresAt });
  }

  join(input: unknown): Result<{ deviceId: string; token: string }> {
    const b = (input && typeof input === 'object' ? input : {}) as { code?: unknown; deviceName?: unknown };
    const name = cleanName(b.deviceName);
    if (!name) return fail(400, 'bad_request');
    // People type codes: ignore case, spaces and dashes.
    const code = typeof b.code === 'string' ? b.code.replace(/[\s-]/g, '').toUpperCase() : '';
    if (!CODE_RE.test(code)) return fail(400, 'invalid_code');

    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inv = this.db
        .prepare('SELECT id, household_id, expires_at, used_at FROM invites WHERE code_hash = ?')
        .get(hashToken(code)) as { id: string; household_id: string; expires_at: string; used_at: string | null } | undefined;
      // Unknown, used and expired codes answer the same, so a guess learns nothing.
      if (!inv || inv.used_at !== null || Date.parse(inv.expires_at) <= now) {
        this.db.exec('ROLLBACK');
        return fail(400, 'invalid_code');
      }
      if (activeDevices(this.db, inv.household_id).length >= MAX_DEVICES) {
        this.db.exec('ROLLBACK');
        return fail(409, 'household_full');
      }
      const deviceId = generateId();
      const token = generateToken();
      const at = new Date(now).toISOString();
      this.db
        .prepare("INSERT INTO devices (id, household_id, name, role, token_hash, created_at) VALUES (?, ?, ?, 'member', ?, ?)")
        .run(deviceId, inv.household_id, name, hashToken(token), at);
      this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(at, deviceId, inv.id);
      this.db.exec('COMMIT');
      return ok({ deviceId, token });
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  // ---- revoke (= unpair) ---------------------------------------------------------------

  revokeDevice(caller: DeviceRow, targetId: string): Result<{ revoked: true }> {
    const target = this.db
      .prepare('SELECT * FROM devices WHERE id = ? AND household_id = ? AND revoked_at IS NULL')
      .get(targetId, caller.household_id) as DeviceRow | undefined;
    // Another household's or an already revoked device looks the same as an unknown one.
    if (!target) return fail(404, 'not_found');
    if (caller.role !== 'owner' && caller.id !== target.id) return fail(403, 'forbidden');
    const active = activeDevices(this.db, caller.household_id);
    // The last active device may not remove itself: nobody could ever sign in again.
    if (active.length <= 1) return fail(409, 'last_device');

    const at = new Date(this.now()).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE devices SET revoked_at = ?, fcm_token = NULL WHERE id = ?').run(at, target.id);
      // Messages still waiting for the revoked device are dropped; what it sent stays for the partner
      // (this is how an "unpair" message reaches the other phone after the sender left).
      this.db.prepare('DELETE FROM mailbox WHERE to_device = ?').run(target.id);
      this.db.prepare('DELETE FROM e2e_queue WHERE to_device = ?').run(target.id);
      // When the owner leaves, the remaining device becomes the owner (it can invite a new partner).
      if (target.role === 'owner') {
        const rest = active.find((d) => d.id !== target.id);
        if (rest) this.db.prepare("UPDATE devices SET role = 'owner' WHERE id = ?").run(rest.id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.hub.closeDevice(target.id);
    this.log.info({ device: target.id, by: caller.id }, 'device revoked');
    return ok({ revoked: true });
  }

  // ---- mailbox -------------------------------------------------------------------------

  post(from: DeviceRow, body: unknown): Result<{ seq: number; time: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request');
    const m = body as Record<string, unknown>;
    if (typeof m.t !== 'string' || !MESSAGE_TYPES.has(m.t)) return fail(400, 'bad_request');
    if (typeof m.from !== 'string' || m.from === '' || m.from.length > 64) return fail(400, 'bad_request');
    if (typeof m.ts !== 'string' || Number.isNaN(Date.parse(m.ts))) return fail(400, 'bad_request');
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) return fail(413, 'payload_too_large');

    const partner = activeDevices(this.db, from.household_id).find((d) => d.id !== from.id);
    if (!partner) return fail(409, 'no_partner');

    const now = this.now();
    const res = this.db
      .prepare('INSERT INTO mailbox (household_id, to_device, from_device, at_ms, body) VALUES (?, ?, ?, ?, ?)')
      .run(from.household_id, partner.id, from.id, now, text);
    const seq = Number(res.lastInsertRowid);
    const time = new Date(now).toISOString();
    this.pruneHousehold(from.household_id, now);
    // Live delivery to the recipient only (never an echo to the sender).
    this.hub.deliver(partner.id, { seq, time, body });
    // Wake the recipient's phone (S9). Runs in the background: a push problem never fails the write.
    this.push?.notify(partner, m.t as PushType, seq, pushHint(m));
    return ok({ seq, time });
  }

  list(device: DeviceRow, since: number, limit: number): { messages: MailboxMessage[]; cursor: string } {
    const rows = this.db
      .prepare('SELECT seq, at_ms, body FROM mailbox WHERE to_device = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(device.id, since, limit) as unknown as { seq: number; at_ms: number; body: string }[];
    const messages = rows.map((r) => ({ seq: r.seq, time: new Date(r.at_ms).toISOString(), body: JSON.parse(r.body) as unknown }));
    const cursor = rows.length > 0 ? rows[rows.length - 1]!.seq : since;
    return { messages, cursor: String(cursor) };
  }

  /** Q3: older than the retention window, or beyond the per-household maximum (oldest first). */
  private pruneHousehold(householdId: string, now: number): void {
    this.db.prepare('DELETE FROM mailbox WHERE household_id = ? AND at_ms < ?').run(householdId, now - this.cfg.mailboxRetentionDays * 86_400_000);
    this.db
      .prepare(
        'DELETE FROM mailbox WHERE household_id = ? AND seq <= (SELECT seq FROM mailbox WHERE household_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)',
      )
      .run(householdId, householdId, this.cfg.mailboxMaxMessages);
  }

  prune(): void {
    const now = this.now();
    const rows = this.db.prepare('SELECT DISTINCT household_id FROM mailbox').all() as unknown as { household_id: string }[];
    for (const r of rows) this.pruneHousehold(r.household_id, now);
    // Used and expired invites are of no use any more.
    this.db.prepare('DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at < ?').run(new Date(now - 86_400_000).toISOString());
  }
}
