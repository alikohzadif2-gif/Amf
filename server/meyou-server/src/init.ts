// `meyou-server init`: create the household, the owner device and its token,
// the default library folders; print the pairing link, an ASCII QR and JSON.
// Idempotent: a second run changes nothing and prints no secret (only the hash is stored).
import fs from 'node:fs';
import QRCode from 'qrcode';
import { cacheDir, dbFile, type Config } from './config.js';
import { getHousehold, openDb, type Db } from './db.js';
import { ensureLibrary } from './library.js';
import { generateId, generateToken, hashToken } from './tokens.js';

export interface InitResult {
  created: boolean;
  householdId: string;
  /** Only set when created = true. Shown once, never stored in clear. */
  token?: string;
  link?: string;
  payload?: { url: string; token: string; name: string };
}

export function pairingLink(url: string, token: string, name: string): string {
  const q = new URLSearchParams({ url, token, name });
  return `meyou://server?${q.toString()}`;
}

export function initHousehold(cfg: Config, db: Db, deviceName = 'Owner'): InitResult {
  ensureLibrary(cfg);
  fs.mkdirSync(cacheDir(cfg), { recursive: true });

  const existing = getHousehold(db);
  if (existing) return { created: false, householdId: existing.id };

  if (!cfg.publicUrl) throw new Error('DOMAIN (or PUBLIC_URL) must be set to create the pairing link');

  const now = new Date().toISOString();
  const householdId = generateId();
  const deviceId = generateId();
  const token = generateToken();

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check inside the write transaction so two concurrent inits cannot both create.
    if (getHousehold(db)) {
      db.exec('ROLLBACK');
      return { created: false, householdId: getHousehold(db)!.id };
    }
    db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, cfg.serverName, now);
    db.prepare(
      "INSERT INTO devices (id, household_id, name, role, token_hash, created_at) VALUES (?, ?, ?, 'owner', ?, ?)",
    ).run(deviceId, householdId, deviceName, hashToken(token), now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const payload = { url: cfg.publicUrl, token, name: cfg.serverName };
  return { created: true, householdId, token, link: pairingLink(cfg.publicUrl, token, cfg.serverName), payload };
}

export async function runInit(cfg: Config, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<InitResult> {
  const db = openDb(dbFile(cfg));
  try {
    const res = initHousehold(cfg, db);
    if (!res.created) {
      out('Already initialized. Nothing changed.\n');
      out('The owner token is stored only as a hash and cannot be shown again.\n');
      return res;
    }
    out('meYou server initialized.\n\n');
    out('Open this link on the owner phone, or scan the QR code in the app (Settings > Server connection).\n');
    out('Keep it private: it contains the owner token and is shown only once.\n\n');
    out(`${res.link}\n\n`);
    out(await QRCode.toString(res.link!, { type: 'terminal', small: true }));
    out('\nJSON (same payload as API contract C.6):\n');
    out(`${JSON.stringify(res.payload)}\n`);
    return res;
  } finally {
    db.close();
  }
}
