import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { dbFile, libraryDir, loadConfig } from '../src/config.js';
import { openDb, schemaVersion } from '../src/db.js';
import { initHousehold, runInit } from '../src/init.js';
import { hashToken } from '../src/tokens.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-init-'));
}

test('init creates household, owner, folders; the link round-trips', async () => {
  const dir = tmp();
  try {
    const cfg = loadConfig({ DATA_DIR: dir, DOMAIN: 'meyou.example.com', SERVER_NAME: 'Our Home' });
    let text = '';
    const res = await runInit(cfg, (s) => (text += s));
    assert.equal(res.created, true);
    assert.ok(fs.statSync(path.join(libraryDir(cfg), 'Photos')).isDirectory());
    assert.ok(fs.statSync(path.join(libraryDir(cfg), 'Videos')).isDirectory());

    const url = new URL(res.link!);
    assert.equal(url.protocol, 'meyou:');
    assert.equal(url.hostname, 'server');
    assert.equal(url.searchParams.get('url'), 'https://meyou.example.com');
    assert.equal(url.searchParams.get('name'), 'Our Home');
    assert.equal(url.searchParams.get('token'), res.token);
    assert.ok(text.includes(res.link!), 'link printed');
    assert.ok(text.includes(JSON.stringify({ url: 'https://meyou.example.com', token: res.token, name: 'Our Home' })), 'json printed');
    assert.ok(/[█▀▄]/.test(text), 'ASCII QR printed');

    const db = openDb(dbFile(cfg));
    const dev = db.prepare('SELECT * FROM devices').all() as { role: string; token_hash: string }[];
    assert.equal(dev.length, 1);
    assert.equal(dev[0]!.role, 'owner');
    assert.equal(dev[0]!.token_hash, hashToken(res.token!));
    assert.notEqual(dev[0]!.token_hash, res.token);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init is idempotent: second run changes nothing and prints no secret', async () => {
  const dir = tmp();
  try {
    const cfg = loadConfig({ DATA_DIR: dir, DOMAIN: 'meyou.example.com' });
    const first = await runInit(cfg, () => {});
    // Remove a default folder: re-running recreates it, but does not touch the household.
    fs.rmSync(path.join(libraryDir(cfg), 'Videos'), { recursive: true });
    let text = '';
    const second = await runInit(cfg, (s) => (text += s));
    assert.equal(second.created, false);
    assert.equal(second.householdId, first.householdId);
    assert.ok(!text.includes(first.token!));
    assert.ok(!text.includes('meyou://'));
    assert.ok(fs.statSync(path.join(libraryDir(cfg), 'Videos')).isDirectory());

    const db = openDb(dbFile(cfg));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM household').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n, 1);
    // Reopening runs migrations again without error.
    assert.equal(schemaVersion(db), 7); // S1 schema + S3 media index + S5 uploads + S7 mailbox + S11 push opt-out + R1a diary/period opt-out + encrypted queue
    db.close();
    openDb(dbFile(cfg)).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init needs DOMAIN or PUBLIC_URL', () => {
  const dir = tmp();
  try {
    const cfg = loadConfig({ DATA_DIR: dir });
    const db = openDb(dbFile(cfg));
    assert.throws(() => initHousehold(cfg, db), /DOMAIN/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM household').get() as { n: number }).n, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: init prints the link once, then reports already initialized', () => {
  const dir = tmp();
  try {
    const env = { ...process.env, DATA_DIR: dir, DOMAIN: 'meyou.example.com', NODE_NO_WARNINGS: '1' };
    const run = () =>
      execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init'], { env, cwd: path.resolve('.'), encoding: 'utf8' });
    const a = run();
    assert.match(a, /meyou:\/\/server\?url=https%3A%2F%2Fmeyou\.example\.com&token=/);
    const b = run();
    assert.match(b, /Already initialized/);
    assert.ok(!b.includes('meyou://'));

    const bad = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init'], {
      env: { ...env, DOMAIN: 'https://nope' },
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Configuration error/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
