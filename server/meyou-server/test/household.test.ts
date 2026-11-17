import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { bearer, makeEnv, type Env } from './helpers.js';
import { hashToken } from '../src/tokens.js';

interface Pair {
  env: Env;
  ownerToken: string;
  ownerId: string;
  memberToken: string;
  memberId: string;
}

async function me(env: Env, token: string) {
  const r = await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
  return { status: r.statusCode, body: r.json() as { deviceId: string; role: string; household: { partner: { deviceId: string; name: string } | null } } };
}

async function invite(env: Env, token: string) {
  return env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(token) });
}

async function join(env: Env, code: string, deviceName = 'Her phone') {
  return env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code, deviceName } });
}

async function pair(extra: Record<string, string> = {}, build: Parameters<typeof makeEnv>[1] = {}): Promise<Pair> {
  const env = await makeEnv(extra, build);
  const ownerToken = env.token;
  const ownerId = (await me(env, ownerToken)).body.deviceId;
  const inv = (await invite(env, ownerToken)).json() as { code: string };
  const j = (await join(env, inv.code)).json() as { deviceId: string; token: string };
  return { env, ownerToken, ownerId, memberToken: j.token, memberId: j.deviceId };
}

// Opaque encrypted blobs (the server never looks inside): any base64url text will do.
let counter = 0;
const blob = (text = 'hello') => ({ id: `t-${++counter}`, blob: Buffer.from(text).toString('base64url') });

async function post(env: Env, token: string, body: unknown = blob()) {
  return env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(token), payload: body as object });
}

async function list(env: Env, token: string, qs = '') {
  const r = await env.app.inject({ method: 'GET', url: `/api/v1/e2e/queue${qs}`, headers: bearer(token) });
  return { status: r.statusCode, body: r.json() as { messages: { seq: number; time: string; id: string; blob: string }[]; cursor: string } };
}

async function listen(env: Env): Promise<string> {
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = env.app.server.address() as { port: number };
  return `ws://127.0.0.1:${addr.port}/api/v1/e2e/ws`;
}

/** Test WebSocket client that records every frame and the close event. */
class Client {
  frames: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];
  readonly ws: WebSocket;
  constructor(url: string, token: string | null) {
    this.ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    this.ws.on('message', (d) => {
      this.frames.push(JSON.parse(String(d)) as Record<string, unknown>);
      this.wake();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
      this.wake();
    });
    this.ws.on('error', () => this.wake());
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  async until(cond: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(this.frames)} closed=${JSON.stringify(this.closed)}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 50);
      });
    }
  }
  async ready(): Promise<void> {
    await this.until(() => this.frames.some((f) => f.type === 'ready'));
  }
  messages() {
    return this.frames.filter((f) => f.type === 'message') as unknown as { seq: number; body: { id: string; blob: string } }[];
  }
  close() {
    this.ws.terminate();
  }
}

/** Opens a WebSocket and resolves with the HTTP status when the upgrade is refused. */
function refused(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      ws.terminate();
      reject(new Error('upgrade was accepted'));
    });
    ws.on('error', () => undefined);
  });
}

test('invite -> join -> blobs both ways -> revoke -> old token rejected -> third device refused', async () => {
  const p = await pair();
  try {
    const { env } = p;
    // Both devices see each other.
    const a = await me(env, p.ownerToken);
    const b = await me(env, p.memberToken);
    assert.equal(a.body.role, 'owner');
    assert.equal(b.body.role, 'member');
    assert.deepEqual(a.body.household.partner, { deviceId: p.memberId, name: 'Her phone' });
    assert.equal(b.body.household.partner?.deviceId, p.ownerId);

    // A -> B, B -> A, A -> B through the encrypted queue: no echo, per-device addressing.
    assert.equal((await post(env, p.ownerToken, blob('one'))).statusCode, 200);
    assert.equal((await post(env, p.memberToken, blob('two'))).statusCode, 200);
    assert.equal((await post(env, p.ownerToken, blob('three'))).statusCode, 200);
    const forB = await list(env, p.memberToken);
    assert.deepEqual(forB.body.messages.map((m) => Buffer.from(m.blob, 'base64url').toString()), ['one', 'three']);
    const forA = await list(env, p.ownerToken);
    assert.deepEqual(forA.body.messages.map((m) => Buffer.from(m.blob, 'base64url').toString()), ['two']);

    // Revoke (owner removes the member): old token rejected everywhere.
    const rev = await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.ownerToken) });
    assert.equal(rev.statusCode, 200);
    assert.equal((await me(env, p.memberToken)).status, 401);
    assert.equal((await list(env, p.memberToken)).status, 401);
    assert.equal((await post(env, p.memberToken)).statusCode, 401);
    assert.equal((await me(env, p.ownerToken)).body.household.partner, null);
    // Without a partner there is nobody to send to.
    assert.equal((await post(env, p.ownerToken)).statusCode, 409);

    // Household is back to one device: a new partner may join; then the household is full again.
    const inv2 = (await invite(env, p.ownerToken)).json() as { code: string };
    const j2 = await join(env, inv2.code, 'New phone');
    assert.equal(j2.statusCode, 200);
    const third = await invite(env, p.ownerToken);
    assert.equal(third.statusCode, 409);
    assert.deepEqual(third.json(), { error: 'household_full' });
    // The new partner sees none of the old traffic.
    const newTok = (j2.json() as { token: string }).token;
    assert.deepEqual((await list(env, newTok)).body.messages, []);
  } finally {
    await p.env.cleanup();
  }
});

test('third device is refused even with a valid code created before the second one joined', async () => {
  const env = await makeEnv();
  try {
    const code = ((await invite(env, env.token)).json() as { code: string }).code;
    assert.equal((await join(env, code, 'B')).statusCode, 200);
    // The code is single use ...
    const again = await join(env, code, 'C');
    assert.equal(again.statusCode, 400);
    assert.deepEqual(again.json(), { error: 'invalid_code' });
    // ... and a code stored before the household filled up still cannot add a third device.
    env.db
      .prepare('INSERT INTO invites (id, household_id, code_hash, created_by, created_at, expires_at) SELECT ?, household_id, ?, id, ?, ? FROM devices LIMIT 1')
      .run('manual', hashToken('ABCDEFGHJKMNPQRSTUVWXYZ2'), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    const r = await join(env, 'ABCDEFGHJKMNPQRSTUVWXYZ2', 'C');
    assert.equal(r.statusCode, 409);
    assert.deepEqual(r.json(), { error: 'household_full' });
    const count = env.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get() as { n: number };
    assert.equal(count.n, 2);
  } finally {
    await env.cleanup();
  }
});

test('invites: owner only, link and expiry, only the newest code works, code stored hashed', async () => {
  let now = Date.parse('2026-10-17T10:00:00Z');
  const p = await pair({}, { partner: { now: () => now } });
  try {
    const { env } = p;
    // Free the second seat first, then check the rules on a household with room.
    await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.ownerToken) });
    const r = await invite(env, p.ownerToken);
    assert.equal(r.statusCode, 200);
    const inv = r.json() as { code: string; expiresAt: string; link: string };
    assert.match(inv.code, /^[A-Z2-9]{24}$/);
    assert.equal(inv.expiresAt, new Date(now + 30 * 60 * 1000).toISOString());
    const u = new URL(inv.link);
    assert.equal(u.protocol, 'meyou:');
    assert.equal(u.host, 'join');
    assert.equal(u.searchParams.get('url'), 'https://meyou.example.com');
    assert.equal(u.searchParams.get('code'), inv.code);
    // The code itself is not in the database, only its hash.
    const rows = env.db.prepare('SELECT code_hash FROM invites').all() as { code_hash: string }[];
    assert.ok(rows.every((x) => x.code_hash !== inv.code));
    assert.ok(rows.some((x) => x.code_hash === hashToken(inv.code)));

    // A newer invite replaces the old code.
    const inv2 = (await invite(env, p.ownerToken)).json() as { code: string };
    assert.notEqual(inv2.code, inv.code);
    assert.equal((await join(env, inv.code)).statusCode, 400);

    // Expired code: same answer as an unknown one.
    now += 30 * 60 * 1000 + 1;
    const expired = await join(env, inv2.code);
    assert.equal(expired.statusCode, 400);
    assert.deepEqual(expired.json(), { error: 'invalid_code' });

    // Typed with lower case, spaces and dashes it still works (fresh code).
    now += 1000;
    const inv3 = (await invite(env, p.ownerToken)).json() as { code: string };
    const typed = inv3.code.toLowerCase().replace(/(.{6})/g, '$1 - ').slice(0, -3);
    assert.equal((await join(env, typed, 'Typed')).statusCode, 200);
  } finally {
    await p.env.cleanup();
  }
});

test('invites: a member cannot invite, no token = 401', async () => {
  const p = await pair();
  try {
    const r = await invite(p.env, p.memberToken);
    assert.equal(r.statusCode, 403);
    assert.deepEqual(r.json(), { error: 'forbidden' });
    const anon = await p.env.app.inject({ method: 'POST', url: '/api/v1/invites' });
    assert.equal(anon.statusCode, 401);
  } finally {
    await p.env.cleanup();
  }
});

test('join: public, validates input, bad names do not burn the code', async () => {
  const env = await makeEnv({ JOIN_RATE_LIMIT_MAX: '100' });
  try {
    const code = ((await invite(env, env.token)).json() as { code: string }).code;
    // Bad device names are rejected before the code is used.
    for (const deviceName of ['', '   ', 'x'.repeat(65), 'a\nb', 5, null]) {
      const r = await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code, deviceName } });
      assert.equal(r.statusCode, 400, JSON.stringify(deviceName));
    }
    const bad = await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code: 'short', deviceName: 'x' } });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json(), { error: 'invalid_code' });
    // The code was not used up by the rejected attempts.
    assert.equal((await join(env, code, 'Phone')).statusCode, 200);
  } finally {
    await env.cleanup();
  }
});

test('join: rate limited per IP (guessing codes is useless)', async () => {
  const env = await makeEnv({ JOIN_RATE_LIMIT_MAX: '4' });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await join(env, 'ABCDEFGHJKMNPQRSTUVWXYZ2', 'x')).statusCode);
    assert.deepEqual(codes, [400, 400, 400, 400, 429, 429]);
  } finally {
    await env.cleanup();
  }
});

test('join: success returns deviceId + token, token stored only as hash, not in the log', async () => {
  const env = await makeEnv();
  try {
    const code = ((await invite(env, env.token)).json() as { code: string }).code;
    const r = await join(env, code, '  Her phone  ');
    assert.equal(r.statusCode, 200);
    const j = r.json() as { deviceId: string; token: string };
    assert.deepEqual(Object.keys(j).sort(), ['deviceId', 'token']);
    assert.match(j.token, /^[A-Za-z0-9_-]{43}$/);
    const row = env.db.prepare('SELECT name, role, token_hash FROM devices WHERE id = ?').get(j.deviceId) as { name: string; role: string; token_hash: string };
    assert.equal(row.name, 'Her phone');
    assert.equal(row.role, 'member');
    assert.equal(row.token_hash, hashToken(j.token));
    await post(env, j.token);
    const all = env.logs.join('');
    assert.ok(!all.includes(j.token), 'member token leaked into the log');
    assert.ok(!all.includes(code), 'invite code leaked into the log');
    assert.ok(!all.includes(env.token), 'owner token leaked into the log');
  } finally {
    await env.cleanup();
  }
});

test('revoke: rules (self, owner, member, unknown, other household, last device) and owner hand-over', async () => {
  const p = await pair();
  try {
    const { env } = p;
    const del = (token: string, id: string) => env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${id}`, headers: bearer(token) });
    // A member may not revoke the owner; unknown id = 404; no token = 401.
    const f = await del(p.memberToken, p.ownerId);
    assert.equal(f.statusCode, 403);
    assert.deepEqual(f.json(), { error: 'forbidden' });
    assert.equal((await del(p.ownerToken, 'nope')).statusCode, 404);
    assert.equal((await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}` })).statusCode, 401);
    // A device from another household looks unknown.
    env.db.prepare("INSERT INTO household (id, name, created_at) VALUES ('h2','Other','x')").run();
    env.db.prepare("INSERT INTO devices (id, household_id, name, role, token_hash, created_at) VALUES ('foreign','h2','F','owner','deadbeef','x')").run();
    assert.equal((await del(p.ownerToken, 'foreign')).statusCode, 404);

    // The owner leaves: the member becomes the owner and can invite a new partner.
    await post(env, p.ownerToken, blob('unpair'));
    const leave = await del(p.ownerToken, p.ownerId);
    assert.equal(leave.statusCode, 200);
    assert.equal((await me(env, p.ownerToken)).status, 401);
    const now = await me(env, p.memberToken);
    assert.equal(now.body.role, 'owner');
    assert.equal(now.body.household.partner, null);
    // What the leaver sent before is still waiting for the remaining phone.
    assert.deepEqual((await list(env, p.memberToken)).body.messages.map((m) => Buffer.from(m.blob, 'base64url').toString()), ['unpair']);
    assert.equal((await invite(env, p.memberToken)).statusCode, 200);

    // The last active device cannot remove itself (nobody could sign in again).
    const last = await del(p.memberToken, p.memberId);
    assert.equal(last.statusCode, 409);
    assert.deepEqual(last.json(), { error: 'last_device' });
    assert.equal((await me(env, p.memberToken)).status, 200);
    // A revoked device cannot be revoked again.
    assert.equal((await del(p.memberToken, p.ownerId)).statusCode, 404);
  } finally {
    await p.env.cleanup();
  }
});

test('revoke: a member can leave on its own and blobs waiting for it are dropped', async () => {
  const p = await pair();
  try {
    const { env } = p;
    await post(env, p.ownerToken, blob('for the member'));
    await post(env, p.memberToken, blob('unpair'));
    const r = await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.memberToken) });
    assert.equal(r.statusCode, 200);
    assert.equal((await me(env, p.memberToken)).status, 401);
    const left = env.db.prepare('SELECT to_device FROM e2e_queue').all() as { to_device: string }[];
    assert.deepEqual(left.map((x) => x.to_device), [p.ownerId]); // only what the member sent for the owner is left
    assert.equal((await list(env, p.ownerToken)).body.messages.length, 1);
    const dev = env.db.prepare('SELECT revoked_at, fcm_token FROM devices WHERE id = ?').get(p.memberId) as { revoked_at: string | null; fcm_token: string | null };
    assert.ok(dev.revoked_at);
    assert.equal(dev.fcm_token, null);
  } finally {
    await p.env.cleanup();
  }
});

// ---- WebSocket (/e2e/ws) -------------------------------------------------------------

test('ws: wrong, missing or URL-only token never gets a socket (401)', async () => {
  const p = await pair();
  try {
    const url = await listen(p.env);
    assert.equal(await refused(url, {}), 401);
    assert.equal(await refused(url, bearer('x'.repeat(43))), 401);
    // The token in the URL is not accepted.
    assert.equal(await refused(`${url}?token=${p.ownerToken}`, {}), 401);
    assert.equal(await refused(`${url}?access_token=${p.ownerToken}`, {}), 401);
    // A revoked token is refused too.
    await p.env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.ownerToken) });
    assert.equal(await refused(url, bearer(p.memberToken)), 401);
    assert.equal(p.env.app.e2e.hub.openCount(), 0);
  } finally {
    await p.env.cleanup();
  }
});

test('ws: bad since closes with 4400', async () => {
  const p = await pair();
  try {
    const url = await listen(p.env);
    const c = new Client(`${url}?since=abc`, p.ownerToken);
    await c.until(() => c.closed !== null);
    assert.equal(c.closed!.code, 4400);
  } finally {
    await p.env.cleanup();
  }
});

test('ws: revoke closes the sockets of that device (4401) and only that device', async () => {
  const p = await pair();
  const clients: Client[] = [];
  try {
    const { env } = p;
    const url = await listen(env);
    const a = new Client(url, p.ownerToken);
    const b1 = new Client(url, p.memberToken);
    const b2 = new Client(url, p.memberToken);
    clients.push(a, b1, b2);
    await Promise.all([a.ready(), b1.ready(), b2.ready()]);
    assert.equal(env.app.e2e.hub.openCount(p.memberId), 2);

    const r = await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.ownerToken) });
    assert.equal(r.statusCode, 200);
    await b1.until(() => b1.closed !== null);
    await b2.until(() => b2.closed !== null);
    assert.equal(b1.closed!.code, 4401);
    assert.equal(b2.closed!.code, 4401);
    assert.equal(a.closed, null);
    assert.equal(env.app.e2e.hub.openCount(p.memberId), 0);
    assert.equal(env.app.e2e.hub.openCount(p.ownerId), 1);
    // The revoked token cannot open a new one.
    assert.equal(await refused(url, bearer(p.memberToken)), 401);
  } finally {
    for (const c of clients) c.close();
    await p.env.cleanup();
  }
});

test('ws: a device that revokes itself is disconnected too, and the partner gets the last blob live', async () => {
  const p = await pair();
  const clients: Client[] = [];
  try {
    const { env } = p;
    const url = await listen(env);
    const a = new Client(url, p.ownerToken);
    const b = new Client(url, p.memberToken);
    clients.push(a, b);
    await Promise.all([a.ready(), b.ready()]);
    await post(env, p.memberToken, blob('unpair'));
    await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.memberToken) });
    await a.until(() => a.messages().length === 1);
    assert.equal(Buffer.from(a.messages()[0]!.body.blob, 'base64url').toString(), 'unpair');
    await b.until(() => b.closed !== null);
    assert.equal(b.closed!.code, 4401);
  } finally {
    for (const c of clients) c.close();
    await p.env.cleanup();
  }
});

test('ws: at most 4 sockets per device, the oldest is replaced', async () => {
  const p = await pair();
  const clients: Client[] = [];
  try {
    const url = await listen(p.env);
    for (let i = 0; i < 5; i++) {
      const c = new Client(url, p.ownerToken);
      clients.push(c);
      await c.ready();
    }
    await clients[0]!.until(() => clients[0]!.closed !== null);
    assert.equal(clients[0]!.closed!.code, 4000);
    assert.equal(p.env.app.e2e.hub.openCount(p.ownerId), 4);
  } finally {
    for (const c of clients) c.close();
    await p.env.cleanup();
  }
});

test('ws: server pings a live client; a socket that never answers is terminated', async () => {
  const p = await pair({}, { partner: { pingEveryMs: 60 } });
  try {
    p.env.app.e2e.start(); // starts the hub heartbeat (serve does this in production)
    const url = await listen(p.env);
    const c = new Client(url, p.ownerToken);
    await c.ready();
    let pings = 0;
    c.ws.on('ping', () => pings++);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(pings >= 2, `pings=${pings}`);
    assert.equal(c.closed, null);
    assert.equal(p.env.app.e2e.hub.openCount(p.ownerId), 1, 'answering client stays connected');
    c.close();

    // A dead peer: a fake socket that never emits "pong".
    const dead = Object.assign(new EventEmitter(), {
      readyState: 1,
      pings: 0,
      terminated: false,
      ping() {
        this.pings++;
      },
      terminate() {
        this.terminated = true;
      },
      close() {
        this.terminated = true;
      },
      send() {},
    });
    p.env.app.e2e.hub.add('ghost', dead as never, 0);
    assert.equal(p.env.app.e2e.hub.openCount('ghost'), 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(dead.pings, 1, 'pinged once, then dropped');
    assert.equal(dead.terminated, true);
    assert.equal(p.env.app.e2e.hub.openCount('ghost'), 0);
  } finally {
    await p.env.cleanup();
  }
});

