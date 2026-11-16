// S11: owner/admin commands for the VPS (run through `docker compose exec`, no HTTP involved):
//   devices | rotate-token [<deviceId>|owner] | revoke <deviceId> | backup-db <file>
// The running server notices a changed token within SWEEP_EVERY_MS and closes that device's sockets.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { activeDevices, getHousehold, type Db, type DeviceRow } from './db.js';
import { pairingLink } from './init.js';
import { generateToken, hashToken } from './tokens.js';

export class AdminError extends Error {}

export interface DeviceInfo {
  id: string;
  name: string;
  role: 'owner' | 'member';
  createdAt: string;
  lastSeen: string | null;
  revokedAt: string | null;
  push: boolean;
}

function info(d: DeviceRow): DeviceInfo {
  return {
    id: d.id,
    name: d.name,
    role: d.role,
    createdAt: d.created_at,
    lastSeen: d.last_seen,
    revokedAt: d.revoked_at,
    push: d.fcm_token !== null,
  };
}

/** Every device, active ones first. Never contains a token or a hash. */
export function listDevices(db: Db): DeviceInfo[] {
  const rows = db.prepare('SELECT * FROM devices ORDER BY (revoked_at IS NOT NULL), created_at, id').all() as unknown as DeviceRow[];
  return rows.map(info);
}

function pick(db: Db, selector: string): DeviceRow {
  const hh = getHousehold(db);
  if (!hh) throw new AdminError('Not initialized yet: run "meyou-server init" first.');
  const active = activeDevices(db, hh.id);
  const sel = selector.trim();
  const found = sel === 'owner' ? active.find((d) => d.role === 'owner') : active.find((d) => d.id === sel);
  if (!found) throw new AdminError(`No active device "${sel}". List them with: meyou-server devices`);
  return found;
}

export interface RotateResult {
  device: DeviceInfo;
  token: string;
  link: string;
  payload: { url: string; token: string; name: string };
}

/**
 * New token for one device (default: the owner). The old token stops working at once; the phone must
 * be given the new link (Settings > Server connection > paste). Shown once, only its hash is stored.
 */
export function rotateToken(cfg: Config, db: Db, selector = 'owner'): RotateResult {
  if (!cfg.publicUrl) throw new AdminError('DOMAIN (or PUBLIC_URL) must be set to create the pairing link');
  const device = pick(db, selector);
  const token = generateToken();
  db.prepare('UPDATE devices SET token_hash = ? WHERE id = ?').run(hashToken(token), device.id);
  const payload = { url: cfg.publicUrl, token, name: cfg.serverName };
  return { device: info(device), token, link: pairingLink(cfg.publicUrl, token, cfg.serverName), payload };
}

/**
 * Revoke a device from the server side (a lost phone). Same rules as DELETE /devices/{id}: the last
 * active device is refused; when the owner goes, the remaining device becomes the owner.
 */
export function revokeFromCli(db: Db, selector: string, now = Date.now()): DeviceInfo {
  const target = pick(db, selector);
  const active = activeDevices(db, target.household_id);
  if (active.length <= 1) throw new AdminError('This is the only active device: revoking it would lock everyone out.');
  const at = new Date(now).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE devices SET revoked_at = ?, fcm_token = NULL WHERE id = ?').run(at, target.id);
    db.prepare('DELETE FROM mailbox WHERE to_device = ?').run(target.id);
    if (target.role === 'owner') {
      const rest = active.find((d) => d.id !== target.id);
      if (rest) db.prepare("UPDATE devices SET role = 'owner' WHERE id = ?").run(rest.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return info({ ...target, revoked_at: at });
}

/**
 * Consistent copy of the database (safe while the server runs: SQLite `VACUUM INTO` reads one snapshot).
 * The file holds token HASHES and mailbox text: keep it private (mode 600). Never overwrites.
 */
export function backupDb(db: Db, dest: string): string {
  const file = path.resolve(dest);
  if (fs.existsSync(file)) throw new AdminError(`${file} already exists: choose a new file name.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  return file;
}
