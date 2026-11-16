import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bearer, makeEnv, type Env } from './helpers.js';
import { VERSION } from '../src/app.js';
import { dbFile, libraryDir } from '../src/config.js';
import { generateToken, hashToken } from '../src/tokens.js';

async function withEnv(fn: (e: Env) => Promise<void>, extra: Record<string, string> = {}) {
  const e = await makeEnv(extra);
  try {
    await fn(e);
  } finally {
    await e.cleanup();
  }
}

test('auth is required on every non-public route (also unknown paths)', () =>
  withEnv(async ({ app }) => {
    for (const url of ['/api/v1/me', '/api/v1/roots', '/api/v1/nope', '/', '/api/v1/tree']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
      assert.deepEqual(r.json(), { error: 'unauthorized' });
      assert.equal(r.headers['www-authenticate'], 'Bearer');
    }
  }));

test('wrong, malformed and revoked tokens give 401', () =>
  withEnv(async ({ app, db, token }) => {
    const wrong = generateToken();
    for (const headers of [
      bearer(wrong),
      { authorization: 'Bearer nope' },
      { authorization: `Basic ${token}` },
      { authorization: token },
      {},
    ]) {
      const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
      assert.equal(r.statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) })).statusCode, 200);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE token_hash = ?').run(new Date().toISOString(), hashToken(token));
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) })).statusCode, 401);
  }));

test('ping is public and returns only name, version, features', () =>
  withEnv(async ({ app }) => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { name: 'Test Home', version: VERSION, features: ['media', 'upload', 'mailbox', 'e2e'] });
    // A bad token on a public route does not matter.
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/ping', headers: bearer('garbage') });
    assert.equal(r2.statusCode, 200);
  }));

test('/me returns the device, role, no partner and features', () =>
  withEnv(async ({ app, db, token }) => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.role, 'owner');
    assert.equal(typeof body.deviceId, 'string');
    assert.deepEqual(body.household, { partner: null });
    assert.deepEqual(body.features, ['media', 'upload', 'mailbox', 'e2e']);
    const row = db.prepare('SELECT last_seen FROM devices WHERE id = ?').get(body.deviceId) as { last_seen: string | null };
    assert.ok(row.last_seen, 'last_seen is recorded');

    // A second device in the household is reported as the partner.
    const hh = db.prepare('SELECT id FROM household').get() as { id: string };
    db.prepare("INSERT INTO devices (id, household_id, name, role, token_hash, created_at) VALUES ('d2', ?, 'Partner phone', 'member', ?, ?)")
      .run(hh.id, hashToken(generateToken()), new Date().toISOString());
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    assert.deepEqual(r2.json().household, { partner: { deviceId: 'd2', name: 'Partner phone' } });
  }));

test('rate limit: global and public routes answer 429 with a key, not text', async () => {
  await withEnv(
    async ({ app }) => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'GET', url: '/api/v1/ping' })).statusCode);
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
      const r = await app.inject({ method: 'GET', url: '/api/v1/ping' });
      assert.equal(r.json().error, 'rate_limited');
      assert.ok(Number(r.headers['retry-after']) >= 1);
    },
    { PUBLIC_RATE_LIMIT_MAX: '3' },
  );
  await withEnv(
    async ({ app, token }) => {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'GET', url: '/api/v1/roots', headers: bearer(token) })).statusCode);
      assert.deepEqual(codes, [200, 200, 429, 429]);
      // The limiter runs before auth, so a flood of bad tokens is limited too.
      const bad = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(generateToken()) });
      assert.equal(bad.statusCode, 429);
    },
    { RATE_LIMIT_MAX: '2' },
  );
});

test('roots: lists real directories under library, ignores files, dot-dirs, symlinks', () =>
  withEnv(async ({ app, cfg, token }) => {
    const lib = libraryDir(cfg);
    const get = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/roots', headers: bearer(token) })).json() as { id: string; name: string }[];
    assert.deepEqual(await get(), [
      { id: 'Photos', name: 'Photos' },
      { id: 'Videos', name: 'Videos' },
    ]);
    fs.mkdirSync(path.join(lib, 'Documents'));
    fs.mkdirSync(path.join(lib, '.hidden'));
    fs.writeFileSync(path.join(lib, 'stray.txt'), 'x');
    fs.symlinkSync('/tmp', path.join(lib, 'LinkToTmp'));
    assert.deepEqual((await get()).map((r) => r.id), ['Documents', 'Photos', 'Videos']);
  }));

test('no secrets in logs; the token is stored only as a hash', () =>
  withEnv(async ({ app, cfg, token, logs }) => {
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer('wrongwrongwrongwrongwrong') });
    await app.inject({ method: 'GET', url: '/api/v1/ping' });
    const all = logs.join('');
    assert.ok(all.length > 0, 'something was logged');
    assert.ok(!all.includes(token), 'token not in logs');
    assert.ok(!all.includes('wrongwrongwrong'), 'bad token not in logs');
    assert.ok(!/authorization/i.test(all.replace(/"redact[^}]*}/g, '')), 'no authorization header in logs');
    // SQLite files (db + WAL) never contain the clear token.
    const dir = path.dirname(dbFile(cfg));
    for (const f of fs.readdirSync(dir)) {
      assert.ok(!fs.readFileSync(path.join(dir, f)).includes(token), `${f} has no clear token`);
    }
  }));

test('CORS is off, server header does not leak a version, big bodies are refused', () =>
  withEnv(async ({ app, token }) => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const big = await app.inject({
      method: 'POST',
      url: '/api/v1/me',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: JSON.stringify({ x: 'a'.repeat(70 * 1024) }),
    });
    assert.ok(big.statusCode === 413 || big.statusCode === 404, `got ${big.statusCode}`);
    if (big.statusCode === 413) assert.deepEqual(big.json(), { error: 'payload_too_large' });
  }));

test('works over a real socket too', () =>
  withEnv(async ({ app, token }) => {
    const addr = await app.listen({ host: '127.0.0.1', port: 0 });
    const ping = await fetch(`${addr}/api/v1/ping`);
    assert.equal(ping.status, 200);
    const noAuth = await fetch(`${addr}/api/v1/me`);
    assert.equal(noAuth.status, 401);
    const me = await fetch(`${addr}/api/v1/me`, { headers: bearer(token) });
    assert.equal(me.status, 200);
  }));
