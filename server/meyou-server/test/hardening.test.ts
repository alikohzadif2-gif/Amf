// S11 (server half): auth lockout, request log without secrets, CLI admin commands, socket sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { bearer, makeEnv, type Env } from './helpers.js';
import { Lockout } from '../src/lockout.js';
import { backupDb, listDevices, purgeLegacy, revokeFromCli, rotateToken, AdminError } from '../src/admin.js';
import { generateToken } from '../src/tokens.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const get = (env: Env, headers: Record<string, string> = {}, url = '/api/v1/me') => env.app.inject({ method: 'GET', url, headers });

async function withEnv(fn: (e: Env) => Promise<void>, extra: Record<string, string> = {}, build: Parameters<typeof makeEnv>[1] = {}) {
  const e = await makeEnv(extra, build);
  try {
    await fn(e);
  } finally {
    await e.cleanup();
  }
}

async function pairUp(env: Env): Promise<{ memberToken: string; memberId: string; ownerId: string }> {
  const inv = (await env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(env.token) })).json() as { code: string };
  const j = (await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code: inv.code, deviceName: 'Her phone' } })).json() as {
    deviceId: string;
    token: string;
  };
  const ownerId = (await get(env, bearer(env.token))).json().deviceId as string;
  return { memberToken: j.token, memberId: j.deviceId, ownerId };
}

// ---- Lockout (unit) ----------------------------------------------------------------------

test('lockout: distinct bad values lock, the same one repeated does not, a lock ends, off when 0', () => {
  let t = 1_000_000;
  const lo = new Lockout({ maxFailures: 3, windowMs: 60_000, lockMs: 120_000, now: () => t });
  for (let i = 0; i < 50; i++) assert.equal(lo.fail('1.1.1.1', 'same'), false);
  assert.equal(lo.lockedFor('1.1.1.1'), 0);

  assert.equal(lo.fail('2.2.2.2', 'a'), false);
  assert.equal(lo.fail('2.2.2.2', 'b'), false);
  assert.equal(lo.fail('2.2.2.2', 'c'), true);
  assert.equal(lo.lockedFor('2.2.2.2'), 120);
  assert.equal(lo.lockedFor('3.3.3.3'), 0);
  t += 119_000;
  assert.equal(lo.lockedFor('2.2.2.2'), 1);
  t += 2_000;
  assert.equal(lo.lockedFor('2.2.2.2'), 0);
  assert.equal(lo.size(), 1); // only 1.1.1.1 is still tracked

  // Failures older than the window do not add up.
  assert.equal(lo.fail('4.4.4.4', 'a'), false);
  t += 61_000;
  assert.equal(lo.fail('4.4.4.4', 'b'), false);
  assert.equal(lo.fail('4.4.4.4', 'c'), false);
  assert.equal(lo.lockedFor('4.4.4.4'), 0);

  const off = new Lockout({ maxFailures: 0, windowMs: 1, lockMs: 1 });
  for (let i = 0; i < 20; i++) assert.equal(off.fail('9.9.9.9', String(i)), false);
  assert.equal(off.lockedFor('9.9.9.9'), 0);
});

test('lockout: memory stays bounded when many addresses fail once', () => {
  const lo = new Lockout({ maxFailures: 5, windowMs: 600_000, lockMs: 600_000 });
  for (let i = 0; i < 6000; i++) lo.fail(`10.0.${i >> 8}.${i & 255}`, 'x');
  assert.ok(lo.size() <= 5000);
});

// ---- Lockout (HTTP) ----------------------------------------------------------------------

test('http: repeated different bad tokens lock the address (even a valid token), ping stays open, lock ends', async () => {
  let t = Date.now();
  await withEnv(
    async (env) => {
      assert.equal((await get(env, bearer(generateToken()))).statusCode, 401);
      assert.equal((await get(env, bearer(generateToken()))).statusCode, 401);
      assert.equal((await get(env, bearer(generateToken()))).statusCode, 401); // this one locks
      const locked = await get(env, bearer(env.token));
      assert.equal(locked.statusCode, 429);
      const body = locked.json() as { error: string; retryAfter: number };
      assert.equal(body.error, 'locked_out');
      assert.ok(body.retryAfter > 0 && body.retryAfter <= 60);
      assert.equal(locked.headers['retry-after'], String(body.retryAfter));
      assert.equal((await get(env, {}, '/api/v1/ping')).statusCode, 200);
      t += 61_000;
      assert.equal((await get(env, bearer(env.token))).statusCode, 200);
    },
    { AUTH_FAIL_MAX: '3', AUTH_LOCKOUT_MINUTES: '1' },
    { lockoutNow: () => t },
  );
});

test('http: a revoked phone retrying with its one old token never locks the address', () =>
  withEnv(
    async (env) => {
      const { memberToken, memberId } = await pairUp(env);
      assert.equal((await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${memberId}`, headers: bearer(env.token) })).statusCode, 200);
      for (let i = 0; i < 30; i++) assert.equal((await get(env, bearer(memberToken))).statusCode, 401);
      assert.equal((await get(env, bearer(env.token))).statusCode, 200);
    },
    { AUTH_FAIL_MAX: '3' },
  ));

test('http: a good token clears earlier mistakes', () =>
  withEnv(
    async (env) => {
      for (let round = 0; round < 3; round++) {
        assert.equal((await get(env, bearer(generateToken()))).statusCode, 401);
        assert.equal((await get(env, bearer(generateToken()))).statusCode, 401);
        assert.equal((await get(env, bearer(env.token))).statusCode, 200);
      }
    },
    { AUTH_FAIL_MAX: '3' },
  ));

test('http: wrong invite codes lock /join too, and the lock also refuses a valid code', () =>
  withEnv(
    async (env) => {
      const valid = (await env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(env.token) })).json() as { code: string };
      const join = (code: string) => env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code, deviceName: 'X' } });
      assert.equal((await join('A'.repeat(24))).statusCode, 400);
      assert.equal((await join('B'.repeat(24))).statusCode, 400);
      assert.equal((await join('C'.repeat(24))).statusCode, 400); // locks
      const r = await join(valid.code);
      assert.equal(r.statusCode, 429);
      assert.equal(r.json().error, 'locked_out');
    },
    { AUTH_FAIL_MAX: '3' },
  ));

test('http: AUTH_FAIL_MAX=0 turns the lockout off', () =>
  withEnv(
    async (env) => {
      for (let i = 0; i < 25; i++) assert.equal((await get(env, bearer(generateToken()))).statusCode, 401);
      assert.equal((await get(env, bearer(env.token))).statusCode, 200);
    },
    { AUTH_FAIL_MAX: '0' },
  ));

// ---- Request log -------------------------------------------------------------------------

test('log: one line per request with the route pattern; no token, query or id in it', () =>
  withEnv(async (env) => {
    await get(env, bearer(env.token), '/api/v1/e2e/queue?since=0&limit=SECRETQUERY');
    await get(env, bearer(env.token), '/api/v1/me?x=cursor=abc');
    await get(env, { authorization: 'Bearer wrongwrongwrongwrongwrong' });
    await get(env, {}, '/api/v1/ping');
    const text = env.logs.join('');
    assert.ok(text.includes('"route":"/api/v1/e2e/queue"'));
    assert.ok(text.includes('"route":"/api/v1/me"'));
    assert.ok(text.includes('request refused')); // the 401
    for (const secret of [env.token, 'wrongwrongwrongwrongwrong', 'SECRETQUERY', 'cursor=abc', 'Bearer ']) {
      assert.ok(!text.includes(secret), `log contains ${secret}`);
    }
    // ping is debug level (the Docker healthcheck): present only because the test logs at debug.
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const ping = lines.find((l) => l.route === '/api/v1/ping');
    assert.equal(ping?.level, 20);
  }));

// ---- CLI admin commands ------------------------------------------------------------------

test('admin: devices lists without tokens or hashes', () =>
  withEnv(async (env) => {
    await pairUp(env);
    const list = listDevices(env.db);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((d) => d.role).sort(), ['member', 'owner']);
    const text = JSON.stringify(list);
    assert.ok(!text.includes(env.token) && !text.includes('token_hash') && !text.includes('tokenHash'));
  }));

test('admin: rotate-token replaces the token at once; old 401, new 200; others untouched', () =>
  withEnv(async (env) => {
    const { memberToken } = await pairUp(env);
    const r = rotateToken(env.cfg, env.db); // owner by default
    assert.equal(r.device.role, 'owner');
    assert.ok(r.link.startsWith('meyou://server?') && r.link.includes(encodeURIComponent(r.token)));
    assert.deepEqual(Object.keys(r.payload).sort(), ['name', 'token', 'url']);
    assert.equal((await get(env, bearer(env.token))).statusCode, 401);
    assert.equal((await get(env, bearer(r.token))).statusCode, 200);
    assert.equal((await get(env, bearer(memberToken))).statusCode, 200);
    // by id
    const m = rotateToken(env.cfg, env.db, listDevices(env.db).find((d) => d.role === 'member')!.id);
    assert.equal((await get(env, bearer(memberToken))).statusCode, 401);
    assert.equal((await get(env, bearer(m.token))).statusCode, 200);
    assert.throws(() => rotateToken(env.cfg, env.db, 'nope'), AdminError);
  }));

test('admin: revoke refuses the last device, revokes a member, hands ownership over when the owner goes', () =>
  withEnv(async (env) => {
    assert.throws(() => revokeFromCli(env.db, 'owner'), /only active device/);
    const { memberToken, memberId, ownerId } = await pairUp(env);
    // owner posts a blob for the member, then the member is revoked: waiting blobs are dropped
    await env.app.inject({
      method: 'POST',
      url: '/api/v1/e2e/queue',
      headers: bearer(env.token),
      payload: { id: 'for-member', blob: 'QUJDREVG' },
    });
    revokeFromCli(env.db, memberId);
    assert.equal((await get(env, bearer(memberToken))).statusCode, 401);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS n FROM e2e_queue WHERE to_device = ?').get(memberId) as { n: number }).n, 0);
    // a new partner can join again; then the owner is revoked and the partner becomes owner
    const again = await pairUp(env);
    revokeFromCli(env.db, ownerId);
    assert.equal((await get(env, bearer(env.token))).statusCode, 401);
    const m = (await get(env, bearer(again.memberToken))).json() as { role: string };
    assert.equal(m.role, 'owner');
  }));

test('admin: backup-db writes a consistent, openable copy (mode 600) and never overwrites', () =>
  withEnv(async (env) => {
    await pairUp(env);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-bk-'));
    try {
      const file = backupDb(env.db, path.join(dir, 'sub', 'meyou.sqlite'));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const copy = openDb(file);
      assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n, 2);
      copy.close();
      assert.throws(() => backupDb(env.db, file), /already exists/);
      // a quote in the name is not an injection
      const odd = backupDb(env.db, path.join(dir, "it's.sqlite"));
      assert.ok(fs.existsSync(odd));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

// ---- Sockets of a re-keyed or revoked device (CLI runs in another process) ---------------

async function openWs(env: Env, token: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  if (!env.app.server.listening) await env.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (env.app.server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/e2e/ws`, { headers: bearer(token) });
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
  await new Promise<void>((res, rej) => {
    ws.on('message', (d) => {
      if ((JSON.parse(String(d)) as { type: string }).type === 'ready') res();
    });
    ws.on('error', rej);
  });
  return { ws, closed };
}

test('sweep: rotate-token from the CLI closes the live socket of the old token (4401); a good socket stays', () =>
  withEnv(async (env) => {
    const { memberToken } = await pairUp(env);
    const a = await openWs(env, env.token);
    const b = await openWs(env, memberToken);
    assert.equal(env.app.e2e.sweepSockets(), 0);
    rotateToken(env.cfg, env.db); // owner re-keyed behind the server's back
    assert.equal(env.app.e2e.sweepSockets(), 1);
    assert.equal(await a.closed, 4401);
    assert.equal(b.ws.readyState, WebSocket.OPEN);
    b.ws.close();
  }));

test('sweep: revoke from the CLI closes that device socket', () =>
  withEnv(async (env) => {
    const { memberToken, memberId } = await pairUp(env);
    const b = await openWs(env, memberToken);
    revokeFromCli(env.db, memberId);
    assert.equal(env.app.e2e.sweepSockets(), 1);
    assert.equal(await b.closed, 4401);
  }));

test('config: lockout settings have safe defaults and validate', () => {
  const c = loadConfig({ DATA_DIR: '/tmp/x' });
  assert.deepEqual([c.authFailMax, c.authFailWindowMinutes, c.authLockoutMinutes], [10, 10, 15]);
  assert.throws(() => loadConfig({ DATA_DIR: '/tmp/x', AUTH_FAIL_MAX: 'many' }), /AUTH_FAIL_MAX/);
});

// ---- purge-legacy (opt-in clean-up after 1.x) ---------------------------------------------

test('admin: purge-legacy empties the old tables only; devices, invites and the encrypted queue stay', () =>
  withEnv(async (env) => {
    const { memberId, ownerId } = await pairUp(env);
    env.db.prepare("INSERT INTO mailbox (household_id, to_device, from_device, at_ms, body) VALUES ('h', ?, ?, 1, '{\"t\":\"chat\",\"text\":\"old plaintext\"}')").run(memberId, ownerId);
    env.db.prepare("INSERT INTO changes (id, op, root, path, at) VALUES ('i', 'add', 'Photos', 'a.jpg', 'x')").run();
    await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(env.token), payload: { id: 'keep-me', blob: 'QUJDREVG' } });
    const r = purgeLegacy(env.db);
    assert.equal(r.deleted.mailbox, 1);
    assert.equal(r.deleted.changes, 1);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get() as { n: number }).n, 0);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS n FROM e2e_queue').get() as { n: number }).n, 1);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n, 2);
    // Running it again is harmless.
    assert.equal(purgeLegacy(env.db).deleted.mailbox, 0);
  }));
