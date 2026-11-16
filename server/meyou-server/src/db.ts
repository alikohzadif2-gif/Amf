// SQLite (built-in node:sqlite) schema for household / devices / invites.
// Migrations are idempotent and tracked with PRAGMA user_version.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

type Migration = string | ((db: Db) => void);

const MIGRATIONS: Migration[] = [
  // 1: household, devices, invites
  `
  CREATE TABLE household (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES household(id),
    name         TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('owner','member')),
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_seen    TEXT,
    fcm_token    TEXT,
    lang         TEXT,
    revoked_at   TEXT
  );
  CREATE INDEX devices_household ON devices(household_id);
  CREATE TABLE invites (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES household(id),
    code_hash    TEXT NOT NULL UNIQUE,
    created_by   TEXT NOT NULL REFERENCES devices(id),
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT,
    used_by      TEXT REFERENCES devices(id)
  );
  `,
  // 2: media index (S3): items of $DATA_DIR/library and the change log
  `
  CREATE TABLE items (
    id        TEXT PRIMARY KEY,
    root      TEXT NOT NULL,
    path      TEXT NOT NULL,
    parent    TEXT NOT NULL,
    name      TEXT NOT NULL,
    name_sort TEXT NOT NULL,
    is_dir    INTEGER NOT NULL,
    type      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    mtime_ms  INTEGER NOT NULL,
    mime      TEXT,
    width     INTEGER,
    height    INTEGER,
    duration  REAL,
    seen      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (root, path)
  );
  CREATE INDEX items_parent ON items(root, parent, is_dir DESC, name_sort, id);
  CREATE TABLE changes (
    seq  INTEGER PRIMARY KEY AUTOINCREMENT,
    id   TEXT NOT NULL,
    op   TEXT NOT NULL CHECK (op IN ('add','update','delete')),
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    at   TEXT NOT NULL
  );
  `,
  // 3: resumable uploads (S5). The temp file under $DATA_DIR/uploads/<id> is the source of truth
  // for the offset; this table holds the session. 'done' rows are kept for a few minutes so that
  // a repeated "complete" (answer lost on the network) returns the same item.
  `
  CREATE TABLE uploads (
    id         TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    root       TEXT NOT NULL,
    dir        TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    md5        TEXT,
    mtime_ms   INTEGER,
    state      TEXT NOT NULL CHECK (state IN ('open','done')),
    final_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX uploads_open_key ON uploads(key) WHERE state = 'open';
  CREATE INDEX uploads_state ON uploads(state, updated_at);
  `,
  // 4: partner mailbox (S7). One row per message, addressed to exactly one device ("to_device");
  // seq is AUTOINCREMENT so a number is never reused after pruning (clients de-duplicate by seq).
  `
  CREATE TABLE mailbox (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id TEXT NOT NULL,
    to_device    TEXT NOT NULL,
    from_device  TEXT NOT NULL,
    at_ms        INTEGER NOT NULL,
    body         TEXT NOT NULL
  );
  CREATE INDEX mailbox_to ON mailbox(to_device, seq);
  CREATE INDEX mailbox_household ON mailbox(household_id, seq);
  `,
  // 5: per-type push opt-out (S11). 1 = the device wants a system notification for this type
  // (the default, also for devices that never send `notify`). Written idempotently (a column
  // that already exists is skipped) so a re-run after a manual user_version reset is harmless.
  (db) => {
    const have = new Set((db.prepare('PRAGMA table_info(devices)').all() as unknown as { name: string }[]).map((c) => c.name));
    if (!have.has('notify_mood')) db.exec('ALTER TABLE devices ADD COLUMN notify_mood INTEGER NOT NULL DEFAULT 1');
    if (!have.has('notify_event')) db.exec('ALTER TABLE devices ADD COLUMN notify_event INTEGER NOT NULL DEFAULT 1');
  },
  // 6: push opt-out for the new shared types `diary` and `period` (R1a). Same rules as migration 5.
  (db) => {
    const have = new Set((db.prepare('PRAGMA table_info(devices)').all() as unknown as { name: string }[]).map((c) => c.name));
    if (!have.has('notify_diary')) db.exec('ALTER TABLE devices ADD COLUMN notify_diary INTEGER NOT NULL DEFAULT 1');
    if (!have.has('notify_period')) db.exec('ALTER TABLE devices ADD COLUMN notify_period INTEGER NOT NULL DEFAULT 1');
  },
  // 7: encrypted queue (sharing track, stage 2). The server only holds an opaque blob per row (the phones encrypt
  // everything) until the recipient ACKs it; `size` is the blob length. seq is AUTOINCREMENT (never reused).
  // (from_device, client_id) is unique: a repeated POST after a lost answer returns the same row. IF NOT EXISTS keeps a re-run harmless.
  `
  CREATE TABLE IF NOT EXISTS e2e_queue (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id TEXT NOT NULL,
    to_device    TEXT NOT NULL,
    from_device  TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    at_ms        INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    blob         BLOB NOT NULL,
    UNIQUE (from_device, client_id)
  );
  CREATE INDEX IF NOT EXISTS e2e_queue_to ON e2e_queue(to_device, seq);
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function migrate(db: Db): void {
  let v = schemaVersion(db);
  while (v < MIGRATIONS.length) {
    const step = MIGRATIONS[v]!;
    db.exec('BEGIN');
    try {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    v += 1;
  }
}

export interface DeviceRow {
  id: string;
  household_id: string;
  name: string;
  role: 'owner' | 'member';
  token_hash: string;
  created_at: string;
  last_seen: string | null;
  fcm_token: string | null;
  lang: string | null;
  /** S11: 0 = no system notification for this message type (1 = default). */
  notify_mood: number;
  notify_event: number;
  /** R1a */
  notify_diary: number;
  notify_period: number;
  revoked_at: string | null;
}

export function getHousehold(db: Db): { id: string; name: string; created_at: string } | undefined {
  return db.prepare('SELECT id, name, created_at FROM household LIMIT 1').get() as
    | { id: string; name: string; created_at: string }
    | undefined;
}

export function findDeviceByTokenHash(db: Db, hash: string): DeviceRow | undefined {
  return db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(hash) as DeviceRow | undefined;
}

export function activeDevices(db: Db, householdId: string): DeviceRow[] {
  return db
    .prepare('SELECT * FROM devices WHERE household_id = ? AND revoked_at IS NULL ORDER BY created_at, id')
    .all(householdId) as unknown as DeviceRow[];
}

export function partnerOf(db: Db, device: DeviceRow): { id: string; name: string } | null {
  const row = db
    .prepare('SELECT id, name FROM devices WHERE household_id = ? AND id != ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1')
    .get(device.household_id, device.id) as { id: string; name: string } | undefined;
  return row ?? null;
}

export function touchDevice(db: Db, id: string, whenIso: string): void {
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(whenIso, id);
}
