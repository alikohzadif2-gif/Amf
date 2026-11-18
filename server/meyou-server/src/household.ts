// Household logic: invites, join, revoke (= unpair). Pure functions over SQLite; the routes only translate HTTP.
// Secrets (tokens, invite codes) are stored as SHA-256 hashes. Nothing about messages lives here: all
// phone-to-phone data goes through the encrypted queue (src/e2e).
import type { FastifyBaseLogger } from 'fastify';
import { activeDevices, type Db, type DeviceRow } from './db.js';
import type { SocketHub } from './e2e/hub.js';
import { fail, ok, type Result } from './result.js';
import { generateId, generateInviteCode, generateToken, hashToken, CODE_ALPHABET, INVITE_CODE_LENGTH } from './tokens.js';

export const MAX_DEVICES = 2;
export const INVITE_TTL_MS = 30 * 60 * 1000;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

export interface HouseholdOptions {
  now?: () => number;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  if (s.length === 0 || s.length > 64 || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export class Household {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    /** The encrypted queue's sockets: a revoked device's sockets are closed at once. */
    private readonly hub: SocketHub,
    private readonly log: FastifyBaseLogger,
    opts: HouseholdOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

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
      // Blobs still waiting for the revoked device are dropped; what it sent stays for the partner
      // (this is how an "unpair" blob reaches the other phone after the sender left).
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

  /** Used and expired invites are of no use any more. Called hourly by the queue's timer and once at start. */
  pruneInvites(): void {
    this.db.prepare('DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at < ?').run(new Date(this.now() - 86_400_000).toISOString());
  }
}
