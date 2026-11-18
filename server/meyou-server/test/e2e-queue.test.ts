import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { bearer, makeEnv, type Env } from './helpers.js';
import { ACK_MAX, LIST_MAX_BYTES } from '../src/e2e/queue.js';
import type { PushTransport } from '../src/push/transport.js';
import type { FcmMessage } from '../src/push/messages.js';

// Encrypted queue (sharing track, stage 2). The "blobs" here are random bytes: the server must treat them as opaque.

interface Pair {
  env: Env;
  ownerToken: string;
  ownerId: string;
  memberToken: string;
  memberId: string;
}

class FakeFcm implements PushTransport {
  projectId = 'fake-project';
  sent: FcmMessage[] = [];
  async send(m: FcmMessage): Promise<void> {
    this.sent.push(m);
  }
  async close(): Promise<void> {}
}

async function pair(extra: Record<string, string> = {}, build: Parameters<typeof makeEnv>[1] = {}): Promise<Pair> {
  const env = await makeEnv(extra, build);
  const owner = (await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(env.token) })).json() as { deviceId: string };
  const inv = (await env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(env.token) })).json() as { code: string };
  const j = (await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code: inv.code, deviceName: 'Her phone' } })).json() as { deviceId: string; token: string };
  return { env, ownerToken: env.token, ownerId: owner.deviceId, memberToken: j.token, memberId: j.deviceId };
}

const blob = (n = 64) => randomBytes(n).toString('base64url');
const post = (env: Env, token: string, id: string, b: unknown) =>
  env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(token), payload: { id, blob: b } as object });
const list = async (env: Env, token: string, qs = '') => {
  const r = await env.app.inject({ method: 'GET', url: `/api/v1/e2e/queue${qs}`, headers: bearer(token) });
  return { status: r.statusCode, body: r.json() as { messages: { seq: number; time: string; id: string; blob: string }[]; cursor: string; more: boolean } };
};
const ack = (env: Env, token: string, seqs: unknown) => env.app.inject({ method: 'POST', url: '/api/v1/e2e/ack', headers: bearer(token), payload: { seqs } as object });
const rows = (env: Env) => (env.db.prepare('SELECT COUNT(*) AS n FROM e2e_queue').get() as { n: number }).n;

test('post -> list -> ACK -> gone; the sender never sees its own blob; bytes are stored untouched', async () => {
  const p = await pair();
  try {
    const { env } = p;
    const b = blob(300);
    const r = await post(env, p.ownerToken, 'm1', b);
    assert.equal(r.statusCode, 200);
    const { seq, time } = r.json() as { seq: number; time: string };
    assert.ok(seq > 0 && !Number.isNaN(Date.parse(time)));

    assert.deepEqual((await list(env, p.ownerToken)).body.messages, [], 'no echo to the sender');
    const got = await list(env, p.memberToken);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.messages, [{ seq, time, id: 'm1', blob: b }]);
    assert.equal(got.body.cursor, String(seq));
    assert.equal(got.body.more, false);

    // fetching does not delete: the phone may crash before it stored the blob
    assert.equal((await list(env, p.memberToken)).body.messages.length, 1);
    const stored = env.db.prepare('SELECT blob, size, from_device, to_device FROM e2e_queue').get() as { blob: Uint8Array; size: number; from_device: string; to_device: string };
    assert.equal(Buffer.from(stored.blob).toString('base64url'), b);
    assert.equal(stored.size, 300);
    assert.equal(stored.from_device, p.ownerId);
    assert.equal(stored.to_device, p.memberId);

    assert.deepEqual((await ack(env, p.memberToken, [seq])).json(), { deleted: 1 });
    assert.equal(rows(env), 0, 'deleted after ACK');
    assert.deepEqual((await list(env, p.memberToken)).body.messages, []);
    assert.deepEqual((await ack(env, p.memberToken, [seq])).json(), { deleted: 0 }, 'ACK twice is harmless');

    // the other direction
    assert.equal((await post(env, p.memberToken, 'back', blob())).statusCode, 200);
    assert.equal((await list(env, p.ownerToken)).body.messages[0]?.id, 'back');
  } finally {
    await p.env.cleanup();
  }
});

test('a repeated id from the same phone is one blob; another phone may use the same id', async () => {
  const p = await pair();
  try {
    const { env } = p;
    const first = (await post(env, p.ownerToken, 'same', blob())).json() as { seq: number };
    const again = (await post(env, p.ownerToken, 'same', blob())).json() as { seq: number; duplicate?: boolean };
    assert.equal(again.seq, first.seq);
    assert.equal(again.duplicate, true);
    assert.equal(rows(env), 1);
    assert.equal((await post(env, p.memberToken, 'same', blob())).statusCode, 200);
    assert.equal(rows(env), 2);
  } finally {
    await p.env.cleanup();
  }
});

test('bad input, size limit, no partner and no token', async () => {
  const p = await pair({ E2E_MAX_BLOB_KB: '1' });
  try {
    const { env } = p;
    for (const [id, b] of [['', blob()], ['a b', blob()], ['x'.repeat(65), blob()], ['ok', ''], ['ok', 'not base64!'], ['ok', 'a'], ['ok', 123], ['ok', 'ab+/']] as const) {
      assert.equal((await post(env, p.ownerToken, id, b)).statusCode, 400, `${id}/${String(b).slice(0, 8)}`);
    }
    for (const payload of [null, [], 'text', { id: 'x' }, { blob: blob() }]) {
      const r = await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: { ...bearer(p.ownerToken), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
      assert.equal(r.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal((await post(env, p.ownerToken, 'full', blob(1024))).statusCode, 200, 'exactly the limit');
    assert.equal((await post(env, p.ownerToken, 'big', blob(1025))).statusCode, 413);
    const huge = await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(p.ownerToken), payload: { id: 'huge', blob: blob(100_000) } });
    assert.equal(huge.statusCode, 413, 'body limit');
    assert.equal(rows(env), 1);

    assert.equal((await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', payload: { id: 'a', blob: blob() } })).statusCode, 401);
    assert.equal((await env.app.inject({ method: 'GET', url: '/api/v1/e2e/queue' })).statusCode, 401);
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/v1/e2e/ack', payload: { seqs: [1] } })).statusCode, 401);
  } finally {
    await p.env.cleanup();
  }
  const solo = await makeEnv();
  try {
    assert.equal((await post(solo, solo.token, 'a', blob())).statusCode, 409, 'no partner yet');
  } finally {
    await solo.cleanup();
  }
});

test('list: since, limit, more, and the byte cap', async () => {
  const p = await pair({ E2E_MAX_BLOB_KB: '1024' });
  try {
    const { env } = p;
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) seqs.push(((await post(env, p.ownerToken, `m${i}`, blob(10))).json() as { seq: number }).seq);
    const page1 = await list(env, p.memberToken, '?limit=2');
    assert.deepEqual(page1.body.messages.map((m) => m.id), ['m0', 'm1']);
    assert.equal(page1.body.more, true);
    const page2 = await list(env, p.memberToken, `?since=${page1.body.cursor}&limit=2`);
    assert.deepEqual(page2.body.messages.map((m) => m.id), ['m2', 'm3']);
    const page3 = await list(env, p.memberToken, `?since=${page2.body.cursor}&limit=2`);
    assert.deepEqual(page3.body.messages.map((m) => m.id), ['m4']);
    assert.equal(page3.body.more, false);
    assert.equal((await list(env, p.memberToken, `?since=${seqs[4]}`)).body.cursor, String(seqs[4]), 'cursor stays when nothing is new');
    assert.equal((await list(env, p.memberToken, '?limit=999')).status, 200, 'limit is clamped');
    for (const qs of ['?since=-1', '?since=x', '?limit=0', '?limit=1.5']) assert.equal((await list(env, p.memberToken, qs)).status, 400, qs);
    await ack(env, p.memberToken, seqs);

    // byte cap: five 1 MiB blobs do not come in one answer
    for (let i = 0; i < 5; i++) assert.equal((await post(env, p.ownerToken, `big${i}`, blob(1024 * 1024))).statusCode, 200);
    const big = await list(env, p.memberToken, '?limit=50');
    assert.equal(big.body.messages.length, LIST_MAX_BYTES / (1024 * 1024));
    assert.equal(big.body.more, true);
    const rest = await list(env, p.memberToken, `?since=${big.body.cursor}&limit=50`);
    assert.equal(rest.body.messages.length, 1);
    assert.equal(rest.body.more, false);
  } finally {
    await p.env.cleanup();
  }
});

test('ACK: only your own blobs, input checks', async () => {
  const p = await pair();
  try {
    const { env } = p;
    const s1 = ((await post(env, p.ownerToken, 'a', blob())).json() as { seq: number }).seq;
    const s2 = ((await post(env, p.ownerToken, 'b', blob())).json() as { seq: number }).seq;
    assert.deepEqual((await ack(env, p.ownerToken, [s1, s2])).json(), { deleted: 0 }, 'the sender cannot delete what waits for the partner');
    assert.equal(rows(env), 2);
    assert.deepEqual((await ack(env, p.memberToken, [s1, s1, 99999])).json(), { deleted: 1 }, 'duplicates and unknown numbers are ignored');
    assert.equal(rows(env), 1);
    for (const bad of [[], 'x', null, [0], [-1], [1.5], ['1'], Array.from({ length: ACK_MAX + 1 }, (_, i) => i + 1)]) {
      assert.equal((await ack(env, p.memberToken, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 30));
    }
    assert.equal((await ack(env, p.memberToken, Array.from({ length: ACK_MAX }, (_, i) => i + 1))).statusCode, 200);
    assert.equal(rows(env), 0);
  } finally {
    await p.env.cleanup();
  }
});

test('TTL: an unacknowledged blob expires; ACKed ones are already gone', async () => {
  let now = Date.UTC(2026, 10, 1);
  const p = await pair({ E2E_TTL_DAYS: '2' }, { partner: { now: () => now } });
  try {
    const { env } = p;
    await post(env, p.ownerToken, 'old', blob());
    now += 1 * 86_400_000;
    await post(env, p.ownerToken, 'newer', blob());
    assert.equal((await list(env, p.memberToken)).body.messages.length, 2);
    now += 1.5 * 86_400_000; // 'old' is 2.5 days, 'newer' is 1.5 days
    assert.deepEqual((await list(env, p.memberToken)).body.messages.map((m) => m.id), ['newer'], 'expired blobs are never delivered, even before the cleanup runs');
    assert.equal(rows(env), 2);
    assert.equal(env.app.e2e.prune(), 1);
    assert.equal(rows(env), 1);
    assert.deepEqual(env.app.e2e.stats({ id: p.memberId } as never), { count: 1, bytes: 64 });
    now += 5 * 86_400_000;
    await post(env, p.ownerToken, 'fresh', blob()); // a post also clears what expired for that recipient
    assert.equal(rows(env), 1);
  } finally {
    await p.env.cleanup();
  }
});

test('a full queue refuses with 507 until the partner fetches and ACKs', async () => {
  const p = await pair({ E2E_MAX_QUEUE_MB: '1', E2E_MAX_BLOB_KB: '1024' });
  try {
    const { env } = p;
    const a = await post(env, p.ownerToken, 'a', blob(600 * 1024));
    assert.equal(a.statusCode, 200);
    const b = await post(env, p.ownerToken, 'b', blob(600 * 1024));
    assert.equal(b.statusCode, 507);
    assert.deepEqual(b.json(), { error: 'queue_full' });
    assert.equal((await post(env, p.memberToken, 'other-direction', blob(600 * 1024))).statusCode, 200, 'the limit is per recipient');
    await ack(env, p.memberToken, [(a.json() as { seq: number }).seq]);
    assert.equal((await post(env, p.ownerToken, 'b', blob(600 * 1024))).statusCode, 200);
  } finally {
    await p.env.cleanup();
  }
});

test('revoking a device drops what waits for it', async () => {
  const p = await pair();
  try {
    const { env } = p;
    await post(env, p.ownerToken, 'to-member', blob());
    await post(env, p.memberToken, 'to-owner', blob());
    const r = await env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.ownerToken) });
    assert.equal(r.statusCode, 200);
    assert.equal(rows(env), 1);
    assert.equal((await list(env, p.ownerToken)).body.messages[0]?.id, 'to-owner', 'what the revoked phone sent still reaches the partner');
    assert.equal((await list(env, p.memberToken)).status, 401);
  } finally {
    await p.env.cleanup();
  }
});

test('push: data only, no type and no content; the blob and its id never reach the logs', async () => {
  const fcm = new FakeFcm();
  const p = await pair({}, { push: { transport: fcm, sleep: async () => {} } });
  try {
    const { env } = p;
    const put = await env.app.inject({ method: 'PUT', url: '/api/v1/push/token', headers: bearer(p.memberToken), payload: { fcmToken: `fcm:${'A'.repeat(100)}`, lang: 'fa' } });
    assert.equal(put.statusCode, 200);
    const secret = blob(200);
    const r = await post(env, p.ownerToken, 'secret-id-123', secret);
    await env.app.push.idle();
    assert.equal(fcm.sent.length, 1);
    const m = fcm.sent[0]!;
    assert.equal(m.notification, undefined, 'nothing is shown');
    assert.deepEqual(m.data, { type: 'e2e', seq: String((r.json() as { seq: number }).seq) });
    assert.ok(!JSON.stringify(m).includes(secret));
    await list(env, p.memberToken);
    const logs = env.logs.join('');
    assert.ok(!logs.includes(secret) && !logs.includes('secret-id-123'), 'logs hold no blob and no id');
  } finally {
    await p.env.cleanup();
  }
});

test('wake: the sender\'s one bit makes a generic visible push; still no type and no content', async () => {
  const fcm = new FakeFcm();
  const p = await pair({}, { push: { transport: fcm, sleep: async () => {} } });
  try {
    const { env } = p;
    await env.app.inject({ method: 'PUT', url: '/api/v1/push/token', headers: bearer(p.memberToken), payload: { fcmToken: `fcm:${'A'.repeat(100)}`, lang: 'en' } });
    const secret = blob(120);
    const r = await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(p.ownerToken), payload: { id: 'wake-1', blob: secret, wake: true } });
    assert.equal(r.statusCode, 200);
    await env.app.push.idle();
    assert.equal(fcm.sent.length, 1);
    const m = fcm.sent[0]!;
    assert.deepEqual(m.notification, { title: 'meYou', body: 'New update from your partner' });
    assert.deepEqual(m.data, { type: 'e2e', seq: String((r.json() as { seq: number }).seq) });
    assert.ok(!JSON.stringify(m).includes(secret));
    // wake:false is the data-only push of stage 2
    await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(p.ownerToken), payload: { id: 'wake-2', blob: blob(), wake: false } });
    await env.app.push.idle();
    assert.equal(fcm.sent.length, 2);
    assert.equal(fcm.sent[1]!.notification, undefined);
    // wake must be a boolean
    for (const wake of ['yes', 1, null, {}]) {
      assert.equal((await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(p.ownerToken), payload: { id: 'w3', blob: blob(), wake } as object })).statusCode, 400);
    }
  } finally {
    await p.env.cleanup();
  }
});

test('wake: no generic push when the recipient switched all four notification types off', async () => {
  const fcm = new FakeFcm();
  const p = await pair({}, { push: { transport: fcm, sleep: async () => {} } });
  try {
    const { env } = p;
    await env.app.inject({ method: 'PUT', url: '/api/v1/push/token', headers: bearer(p.memberToken), payload: { fcmToken: `fcm:${'A'.repeat(100)}`, lang: 'en', notify: { mood: false, event: false, diary: false, period: false } } });
    await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(p.ownerToken), payload: { id: 'off-1', blob: blob(), wake: true } });
    await env.app.push.idle();
    assert.equal(fcm.sent.length, 0);
    await env.app.inject({ method: 'PUT', url: '/api/v1/push/token', headers: bearer(p.memberToken), payload: { fcmToken: `fcm:${'A'.repeat(100)}`, lang: 'en', notify: { diary: true } } });
    await env.app.inject({ method: 'POST', url: '/api/v1/e2e/queue', headers: bearer(p.ownerToken), payload: { id: 'off-2', blob: blob(), wake: true } });
    await env.app.push.idle();
    assert.equal(fcm.sent.length, 1);
  } finally {
    await p.env.cleanup();
  }
});

test('features announce e2e', async () => {
  const env = await makeEnv();
  try {
    assert.ok(((await env.app.inject({ method: 'GET', url: '/api/v1/ping' })).json() as { features: string[] }).features.includes('e2e'));
  } finally {
    await env.cleanup();
  }
});

// ---- WebSocket ------------------------------------------------------------------------------

class Client {
  frames: Record<string, unknown>[] = [];
  closed: { code: number } | null = null;
  readonly ws: WebSocket;
  constructor(url: string, token: string) {
    this.ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on('message', (d) => this.frames.push(JSON.parse(String(d)) as Record<string, unknown>));
    this.ws.on('close', (code) => (this.closed = { code }));
    this.ws.on('error', () => undefined);
  }
  async until(cond: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  messages() {
    return this.frames.filter((f) => f.type === 'message') as unknown as { seq: number; body: { id: string; blob: string } }[];
  }
}

test('WebSocket: replay of what waits, then live blobs; never an echo; nothing is deleted by listening', async () => {
  const p = await pair({}, { partner: { pingEveryMs: 0 } });
  try {
    const { env } = p;
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(env.app.server.address() as { port: number }).port}/api/v1/e2e/ws`;
    const waiting = blob(50);
    await post(env, p.ownerToken, 'before', waiting);

    const member = new Client(url, p.memberToken);
    await member.until(() => member.frames.some((f) => f.type === 'ready'));
    assert.deepEqual(member.messages().map((m) => m.body), [{ id: 'before', blob: waiting }]);

    const owner = new Client(url, p.ownerToken);
    await owner.until(() => owner.frames.some((f) => f.type === 'ready'));
    const live = blob(70);
    await post(env, p.ownerToken, 'live', live);
    await member.until(() => member.messages().length === 2);
    assert.deepEqual(member.messages()[1]!.body, { id: 'live', blob: live });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(owner.messages().length, 0, 'no echo to the sender');
    assert.equal(rows(env), 2, 'still queued until ACK');

    // reconnect with a cursor: only newer blobs
    member.ws.terminate();
    const again = new Client(`${url}?since=${member.messages()[0]!.seq}`, p.memberToken);
    await again.until(() => again.frames.some((f) => f.type === 'ready'));
    assert.deepEqual(again.messages().map((m) => m.body.id), ['live']);
    again.ws.terminate();
    owner.ws.terminate();

    const bad = new Client(`${url}?since=abc`, p.memberToken);
    await bad.until(() => bad.closed !== null);
    assert.equal(bad.closed!.code, 4400);
    const noToken = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => undefined);
    });
    assert.equal(noToken, 401);
  } finally {
    await p.env.cleanup();
  }
});

test('WebSocket presence: the partner is told when a phone connects / leaves; a quick reconnect does not flicker', async () => {
  const p = await pair({}, { partner: { pingEveryMs: 0, presenceGraceMs: 250 } });
  try {
    const { env } = p;
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(env.app.server.address() as { port: number }).port}/api/v1/e2e/ws`;
    const presence = (c: Client) => c.frames.filter((f) => f.type === 'presence').map((f) => f.online);

    const owner = new Client(url, p.ownerToken);
    await owner.until(() => presence(owner).length === 1);
    assert.deepEqual(presence(owner), [false], 'partner not connected yet');

    const member = new Client(url, p.memberToken);
    await member.until(() => presence(member).length === 1);
    assert.deepEqual(presence(member), [true], 'the owner is already here');
    await owner.until(() => presence(owner).length === 2);
    assert.deepEqual(presence(owner), [false, true], 'owner is told the partner came online');

    // quick reconnect (inside the grace period): no offline frame
    member.ws.terminate();
    const member2 = new Client(url, p.memberToken);
    await member2.until(() => presence(member2).length === 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(presence(owner), [false, true], 'no flicker');

    // really leaving: offline after the grace period
    member2.ws.terminate();
    await owner.until(() => presence(owner).length === 3);
    assert.deepEqual(presence(owner), [false, true, false]);

    owner.ws.terminate();
  } finally {
    await p.env.cleanup();
  }
});
