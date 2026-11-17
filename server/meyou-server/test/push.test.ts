import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bearer, makeEnv, type Env } from './helpers.js';
import type { FcmMessage } from '../src/push/messages.js';
import { buildMessage, pickLang } from '../src/push/messages.js';
import { errorCode } from '../src/push/service.js';
import { loadServiceAccount, type PushTransport } from '../src/push/transport.js';
import { loadConfig } from '../src/config.js';
import { runPushTest } from '../src/push/test-command.js';
import { execFile } from 'node:child_process';
import { openDb } from '../src/db.js';
import { initHousehold } from '../src/init.js';

// ---- helpers -------------------------------------------------------------------------------

class FakeFcm implements PushTransport {
  projectId = 'fake-project';
  attempts: FcmMessage[] = [];
  sent: FcmMessage[] = [];
  closed = false;
  behaviour: (m: FcmMessage, call: number) => void | Promise<void> = () => {};
  async send(m: FcmMessage): Promise<void> {
    this.attempts.push(m);
    await this.behaviour(m, this.attempts.length);
    this.sent.push(m);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const fcmError = (code: string, message = 'fcm said no') => Object.assign(new Error(message), { code });
const tok = (name: string) => `fcm:${name}:${'A'.repeat(100)}`;

interface Pair {
  env: Env;
  fcm: FakeFcm;
  sleeps: number[];
  ownerToken: string;
  ownerId: string;
  memberToken: string;
  memberId: string;
}

async function pair(build: { retryDelaysMs?: number[] } = {}): Promise<Pair> {
  const fcm = new FakeFcm();
  const sleeps: number[] = [];
  const env = await makeEnv({}, {
    push: {
      transport: fcm,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...build,
    },
  });
  const me = (await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(env.token) })).json() as { deviceId: string };
  const inv = (await env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(env.token) })).json() as { code: string };
  const j = (await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code: inv.code, deviceName: 'Her phone' } })).json() as {
    deviceId: string;
    token: string;
  };
  return { env, fcm, sleeps, ownerToken: env.token, ownerId: me.deviceId, memberToken: j.token, memberId: j.deviceId };
}

const putToken = (env: Env, token: string, body: unknown) =>
  env.app.inject({ method: 'PUT', url: '/api/v1/push/token', headers: bearer(token), payload: body as object });

// node:sqlite rows have a null prototype: copy to a plain object so deepEqual compares values.
const row = (env: Env, id: string) =>
  ({ ...env.db.prepare('SELECT fcm_token, lang FROM devices WHERE id = ?').get(id) }) as { fcm_token: string | null; lang: string | null };

// One encrypted blob to the partner. The server cannot tell what is inside, so the only knob is `wake`
// (the sender's bit for a visible generic push; default here: visible, like a chat message or a memory).
let blobCounter = 0;
const post = (env: Env, token: string, body: { wake?: boolean } = {}) =>
  env.app.inject({
    method: 'POST',
    url: '/api/v1/e2e/queue',
    headers: bearer(token),
    payload: { id: `push-${++blobCounter}`, blob: 'QUJD'.repeat(16), wake: body.wake ?? true },
  });

const features = async (env: Env) =>
  ((await env.app.inject({ method: 'GET', url: '/api/v1/ping' })).json() as { features: string[] }).features;

function serviceAccountFile(dir: string, over: Record<string, unknown> = {}): { file: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const file = path.join(dir, 'sa.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'service_account',
      project_id: 'meyou-test-proj',
      private_key_id: 'abc123',
      private_key: privateKey,
      client_email: 'push@meyou-test-proj.iam.gserviceaccount.com',
      ...over,
    }),
  );
  return { file, privateKey };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-push-'));

// ---- messages ------------------------------------------------------------------------------

test('message shape: the push is generic, high priority, channel, 24 h TTL', () => {
  const m = buildMessage('T'.repeat(40), 'e2e', 'en', 7);
  assert.deepEqual(m.notification, { title: 'meYou', body: 'New update from your partner' });
  assert.deepEqual(m.data, { type: 'e2e', seq: '7' });
  assert.equal(m.android.priority, 'high');
  assert.equal(m.android.ttl, 24 * 60 * 60 * 1000);
  assert.deepEqual(m.android.notification, { channelId: 'meyou-partner-v2', sound: 'default', priority: 'high' });
});

test('message language: Persian for fa, fa-IR and fa_IR, English for everything else', () => {
  assert.equal(pickLang('fa'), 'fa');
  assert.equal(pickLang('fa-IR'), 'fa');
  assert.equal(pickLang('fa_IR'), 'fa');
  assert.equal(pickLang('en'), 'en');
  assert.equal(pickLang('de'), 'en');
  assert.equal(pickLang('far'), 'en');
  assert.equal(pickLang(null), 'en');
  const fa = buildMessage('T'.repeat(40), 'e2e', 'fa', 1).notification!;
  assert.match(fa.body, /[\u0600-\u06ff]/);
  assert.notEqual(fa.body, buildMessage('T'.repeat(40), 'e2e', 'en', 1).notification!.body);
  assert.match(buildMessage('T'.repeat(40), 'test', 'fa', 1).notification!.body, /[\u0600-\u06ff]/);
});

test('silent hint: data only, normal priority, no notification, kind kept', () => {
  const m = buildMessage('T'.repeat(40), 'e2e', 'en', 9, { silent: true });
  assert.equal(m.notification, undefined);
  assert.equal(m.android.notification, undefined);
  assert.equal(m.android.priority, 'normal');
  assert.deepEqual(m.data, { type: 'e2e', seq: '9' });
});

test('errorCode returns only a short safe code', () => {
  assert.equal(errorCode(fcmError('messaging/server-unavailable')), 'messaging/server-unavailable');
  assert.equal(errorCode({ errorInfo: { code: 'messaging/internal-error' } }), 'messaging/internal-error');
  assert.equal(errorCode(new Error('no code')), 'unknown');
  assert.equal(errorCode('a string'), 'unknown');
  assert.equal(errorCode(null), 'unknown');
  assert.equal(errorCode({ code: 'x'.repeat(200) }), 'unknown');
  assert.equal(errorCode({ code: 'has spaces and\nnewline' }), 'unknown');
});

// ---- token routes --------------------------------------------------------------------------

test('PUT /push/token needs auth and a valid body', async () => {
  const p = await pair();
  try {
    const anon = await p.env.app.inject({ method: 'PUT', url: '/api/v1/push/token', payload: { fcmToken: tok('a'), lang: 'fa' } });
    assert.equal(anon.statusCode, 401);
    const bads: unknown[] = [
      {},
      { fcmToken: tok('a') },
      { lang: 'fa' },
      { fcmToken: 'short', lang: 'fa' },
      { fcmToken: tok('a') + ' space', lang: 'fa' },
      { fcmToken: 123, lang: 'fa' },
      { fcmToken: 'x'.repeat(5000), lang: 'fa' },
      { fcmToken: tok('a'), lang: '' },
      { fcmToken: tok('a'), lang: 'persian-language-too-long' },
      { fcmToken: tok('a'), lang: 'f' },
      { fcmToken: tok('a'), lang: 12 },
      ['fcmToken'],
    ];
    for (const b of bads) {
      const r = await putToken(p.env, p.memberToken, b);
      assert.equal(r.statusCode, 400, JSON.stringify(b));
      assert.deepEqual(r.json(), { error: 'bad_request' });
    }
    assert.equal(row(p.env, p.memberId).fcm_token, null);
  } finally {
    await p.env.cleanup();
  }
});

test('PUT stores token and language; a newer token replaces the older one; fa_IR is normalised', async () => {
  const p = await pair();
  try {
    const r = await putToken(p.env, p.memberToken, { fcmToken: tok('m1'), lang: 'fa' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { registered: true });
    assert.deepEqual(row(p.env, p.memberId), { fcm_token: tok('m1'), lang: 'fa' });
    await putToken(p.env, p.memberToken, { fcmToken: tok('m2'), lang: 'fa_IR' });
    assert.deepEqual(row(p.env, p.memberId), { fcm_token: tok('m2'), lang: 'fa-IR' });
    assert.equal(row(p.env, p.ownerId).fcm_token, null);
  } finally {
    await p.env.cleanup();
  }
});

test('a token that moves to another device is removed from the old one', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('shared'), lang: 'en' });
    await putToken(p.env, p.memberToken, { fcmToken: tok('shared'), lang: 'fa' });
    assert.equal(row(p.env, p.ownerId).fcm_token, null);
    assert.equal(row(p.env, p.memberId).fcm_token, tok('shared'));
  } finally {
    await p.env.cleanup();
  }
});

test('DELETE /push/token removes the token and is idempotent; other device is untouched', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('o'), lang: 'en' });
    await putToken(p.env, p.memberToken, { fcmToken: tok('m'), lang: 'fa' });
    for (let i = 0; i < 2; i++) {
      const r = await p.env.app.inject({ method: 'DELETE', url: '/api/v1/push/token', headers: bearer(p.memberToken) });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { removed: true });
    }
    assert.equal(row(p.env, p.memberId).fcm_token, null);
    assert.equal(row(p.env, p.ownerId).fcm_token, tok('o'));
    const anon = await p.env.app.inject({ method: 'DELETE', url: '/api/v1/push/token' });
    assert.equal(anon.statusCode, 401);
  } finally {
    await p.env.cleanup();
  }
});

test('revoking a device clears its push token, so nothing is sent to it any more', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.memberToken, { fcmToken: tok('m'), lang: 'fa' });
    const r = await p.env.app.inject({ method: 'DELETE', url: `/api/v1/devices/${p.memberId}`, headers: bearer(p.ownerToken) });
    assert.equal(r.statusCode, 200);
    assert.equal(row(p.env, p.memberId).fcm_token, null);
  } finally {
    await p.env.cleanup();
  }
});

// ---- delivery ------------------------------------------------------------------------------

test('a stored blob with wake sends a localized generic push to the recipient only', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
    await putToken(p.env, p.memberToken, { fcmToken: tok('member'), lang: 'fa' });
    // The member (Persian) sends: the owner (English) is the recipient.
    const r = await post(p.env, p.memberToken, { wake: true });
    assert.equal(r.statusCode, 200);
    const seq = (r.json() as { seq: number }).seq;
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.length, 1);
    const m = p.fcm.sent[0]!;
    assert.equal(m.token, tok('owner'));
    assert.deepEqual(m.notification, { title: 'meYou', body: 'New update from your partner' });
    assert.deepEqual(m.data, { type: 'e2e', seq: String(seq) });
    // The blob never leaves the server through Google.
    assert.ok(!JSON.stringify(m).includes('QUJD'));

    // And the other way round: the Persian phone gets Persian text.
    await post(p.env, p.ownerToken, { wake: true });
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.length, 2);
    const m2 = p.fcm.sent[1]!;
    assert.equal(m2.token, tok('member'));
    assert.match(m2.notification!.body, /[\u0600-\u06ff]/);
    assert.equal(m2.data.type, 'e2e');
  } finally {
    await p.env.cleanup();
  }
});

test('a blob without wake pushes silently (data only), once per gap (coalesced)', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'fa' });
    await post(p.env, p.memberToken, { wake: false });
    await post(p.env, p.memberToken, { wake: false }); // inside the 10 s gap: trailing push only, nothing now
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.length, 1);
    assert.equal(p.fcm.sent[0]!.notification, undefined);
    assert.equal(p.fcm.sent[0]!.data.type, 'e2e');
  } finally {
    await p.env.cleanup();
  }
});

test('no push for a recipient without a token, for the sender, or when there is no partner', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.memberToken, { fcmToken: tok('member'), lang: 'en' }); // only the sender has a token
    const r = await post(p.env, p.memberToken, {});
    assert.equal(r.statusCode, 200);
    await p.env.app.push.idle();
    assert.equal(p.fcm.attempts.length, 0);
  } finally {
    await p.env.cleanup();
  }
  const solo = await makeEnv({}, { push: { transport: new FakeFcm() } });
  try {
    const r = await post(solo, solo.token, {});
    assert.equal(r.statusCode, 409);
  } finally {
    await solo.cleanup();
  }
});

// ---- failures ------------------------------------------------------------------------------

test('a token FCM calls unregistered or invalid is deleted, the queue write still succeeds', async () => {
  for (const code of ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']) {
    const p = await pair();
    try {
      await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
      p.fcm.behaviour = () => {
        throw fcmError(code);
      };
      const r = await post(p.env, p.memberToken, {});
      assert.equal(r.statusCode, 200, code);
      await p.env.app.push.idle();
      assert.equal(p.fcm.attempts.length, 1, 'a dead token is not retried');
      assert.equal(row(p.env, p.ownerId).fcm_token, null, code);
      const stats = (await p.env.app.inject({ method: 'GET', url: '/api/v1/e2e/stats', headers: bearer(p.ownerToken) })).json() as {
        count: number;
      };
      assert.equal(stats.count, 1, 'the blob is stored');
    } finally {
      await p.env.cleanup();
    }
  }
});

test('a token the app re-registered meanwhile is not deleted by a late failure', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('old'), lang: 'en' });
    p.fcm.behaviour = async () => {
      await putToken(p.env, p.ownerToken, { fcmToken: tok('fresh'), lang: 'en' });
      throw fcmError('messaging/registration-token-not-registered');
    };
    await post(p.env, p.memberToken, {});
    await p.env.app.push.idle();
    assert.equal(row(p.env, p.ownerId).fcm_token, tok('fresh'));
  } finally {
    await p.env.cleanup();
  }
});

test('temporary errors are retried with backoff and then succeed; the token is kept', async () => {
  const p = await pair({ retryDelaysMs: [2000, 10000] });
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
    p.fcm.behaviour = (_m, call) => {
      if (call === 1) throw fcmError('messaging/server-unavailable');
      if (call === 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    };
    await post(p.env, p.memberToken, {});
    await p.env.app.push.idle();
    assert.equal(p.fcm.attempts.length, 3);
    assert.equal(p.fcm.sent.length, 1);
    assert.deepEqual(p.sleeps, [2000, 10000]);
    assert.equal(row(p.env, p.ownerId).fcm_token, tok('owner'));
  } finally {
    await p.env.cleanup();
  }
});

test('a failed OAuth token fetch (app/invalid-credential, also what a network outage looks like) is retried', async () => {
  const p = await pair({ retryDelaysMs: [1, 1] });
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
    p.fcm.behaviour = (_m, call) => {
      if (call < 3) throw fcmError('app/invalid-credential');
    };
    await post(p.env, p.memberToken, {});
    await p.env.app.push.idle();
    assert.equal(p.fcm.attempts.length, 3);
    assert.equal(p.fcm.sent.length, 1);
    assert.equal(row(p.env, p.ownerId).fcm_token, tok('owner'));
  } finally {
    await p.env.cleanup();
  }
});

test('when every attempt fails the push is given up, the token is kept, nothing throws', async () => {
  const p = await pair({ retryDelaysMs: [1, 2] });
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
    p.fcm.behaviour = () => {
      throw fcmError('messaging/internal-error');
    };
    const r = await post(p.env, p.memberToken, {});
    assert.equal(r.statusCode, 200);
    await p.env.app.push.idle();
    assert.equal(p.fcm.attempts.length, 3);
    assert.equal(row(p.env, p.ownerId).fcm_token, tok('owner'));
    assert.ok(p.env.logs.some((l) => l.includes('push not delivered')));
  } finally {
    await p.env.cleanup();
  }
});

test('errors that are not temporary (credentials, quota of the project) are not retried and keep the token', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
    p.fcm.behaviour = () => {
      throw fcmError('messaging/third-party-auth-error');
    };
    await post(p.env, p.memberToken, {});
    await p.env.app.push.idle();
    assert.equal(p.fcm.attempts.length, 1);
    assert.equal(row(p.env, p.ownerId).fcm_token, tok('owner'));
  } finally {
    await p.env.cleanup();
  }
});

test('a transport that throws synchronously or rejects with a non-Error never breaks the queue write', async () => {
  const sync: PushTransport = {
    send: () => {
      throw new Error('boom');
    },
  };
  const weird: PushTransport = { send: () => Promise.reject('just a string') };
  for (const transport of [sync, weird]) {
    const env = await makeEnv({}, { push: { transport, retryDelaysMs: [] } });
    try {
      const inv = (await env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(env.token) })).json() as { code: string };
      const j = (await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code: inv.code, deviceName: 'P' } })).json() as {
        token: string;
      };
      await putToken(env, env.token, { fcmToken: tok('owner'), lang: 'en' });
      const r = await post(env, j.token, {});
      assert.equal(r.statusCode, 200);
      await env.app.push.idle();
    } finally {
      await env.cleanup();
    }
  }
});

test('closing the server does not wait for a pending retry delay', async () => {
  const fcm = new FakeFcm();
  fcm.behaviour = () => {
    throw fcmError('messaging/server-unavailable');
  };
  // No sleep hook: the real timer is used, with a delay far longer than the test.
  const env = await makeEnv({}, { push: { transport: fcm, retryDelaysMs: [60_000] } });
  const inv = (await env.app.inject({ method: 'POST', url: '/api/v1/invites', headers: bearer(env.token) })).json() as { code: string };
  const j = (await env.app.inject({ method: 'POST', url: '/api/v1/join', payload: { code: inv.code, deviceName: 'P' } })).json() as { token: string };
  await putToken(env, env.token, { fcmToken: tok('owner'), lang: 'en' });
  await post(env, j.token, {});
  for (let i = 0; i < 100 && fcm.attempts.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fcm.attempts.length, 1);
  const t0 = Date.now();
  await env.cleanup();
  assert.ok(Date.now() - t0 < 5000, 'shutdown must not sit out the retry delay');
  assert.equal(fcm.closed, true, 'the transport is closed');
});

test('a retry wait keeps a bare process alive (the push-test CLI has no server socket)', async () => {
  const fixture = path.join(import.meta.dirname, 'push-loop-fixture.ts');
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', fixture], { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  assert.deepEqual(JSON.parse(out), { r: { ok: true }, calls: 2 });
});

test('logs never contain tokens, even when the SDK error message quotes them', async () => {
  const p = await pair({ retryDelaysMs: [1] });
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en' });
    p.fcm.behaviour = (m) => {
      throw fcmError('messaging/internal-error', `bad token ${m.token} and key -----BEGIN PRIVATE KEY-----`);
    };
    await post(p.env, p.memberToken, { note: 'SECRET-NOTE' });
    await p.env.app.push.idle();
    const all = p.env.logs.join('');
    assert.ok(all.includes('messaging/internal-error'), 'the code is logged');
    assert.ok(!all.includes(tok('owner')), 'no FCM token in logs');
    assert.ok(!all.includes('PRIVATE KEY'), 'no key text in logs');
    assert.ok(!all.includes(p.ownerToken) && !all.includes(p.memberToken), 'no bearer token in logs');
    assert.ok(!all.includes('SECRET-NOTE'), 'no message content in logs');
  } finally {
    await p.env.cleanup();
  }
});

// ---- features and credentials ---------------------------------------------------------------

test('features: push is announced only when the credentials loaded', async () => {
  const off = await makeEnv();
  try {
    assert.deepEqual(await features(off), ['e2e']);
  } finally {
    await off.cleanup();
  }
  const forcedOff = await makeEnv({}, { push: { transport: null } });
  try {
    assert.ok(!(await features(forcedOff)).includes('push'));
  } finally {
    await forcedOff.cleanup();
  }
  const on = await makeEnv({}, { push: { transport: new FakeFcm() } });
  try {
    assert.deepEqual(await features(on), ['e2e', 'push']);
    const me = (await on.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(on.token) })).json() as { features: string[] };
    assert.deepEqual(me.features, ['e2e', 'push']);
  } finally {
    await on.cleanup();
  }
});

test('FCM_SERVICE_ACCOUNT_FILE: a missing or broken file keeps push off and the server up, with a safe log line', async () => {
  const dir = tmp();
  try {
    const bad = path.join(dir, 'broken.json');
    fs.writeFileSync(bad, '{ "type": "service_account", "private_key": "SECRET-KEY-TEXT"');
    const wrongType = path.join(dir, 'wrong.json');
    fs.writeFileSync(wrongType, JSON.stringify({ type: 'authorized_user', private_key: 'SECRET-KEY-TEXT' }));
    const noKey = serviceAccountFile(dir, { private_key: 'not a pem SECRET-KEY-TEXT' });
    for (const file of [path.join(dir, 'missing.json'), bad, wrongType, noKey.file]) {
      const env = await makeEnv({ FCM_SERVICE_ACCOUNT_FILE: file });
      try {
        assert.ok(!(await features(env)).includes('push'), file);
        const logs = env.logs.join('');
        assert.ok(logs.includes('push disabled'), file);
        assert.ok(!logs.includes('SECRET-KEY-TEXT'), 'no key text in logs');
      } finally {
        await env.cleanup();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FCM_SERVICE_ACCOUNT_FILE: a valid key file loads through firebase-admin and turns push on', async () => {
  const dir = tmp();
  try {
    const { file, privateKey } = serviceAccountFile(dir);
    const env = await makeEnv({ FCM_SERVICE_ACCOUNT_FILE: file });
    try {
      assert.ok((await features(env)).includes('push'));
      assert.equal(env.app.push.projectId, 'meyou-test-proj');
      const logs = env.logs.join('');
      assert.ok(logs.includes('push enabled'));
      assert.ok(logs.includes('meyou-test-proj'));
      assert.ok(!logs.includes(privateKey.split('\n')[1]!), 'no key material in logs');
    } finally {
      await env.cleanup();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadServiceAccount reports what is wrong without quoting the file', () => {
  const dir = tmp();
  try {
    assert.throws(() => loadServiceAccount(path.join(dir, 'nope.json')), /does not exist/);
    assert.throws(() => loadServiceAccount(dir), /not a file/);
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, 'x'.repeat(70 * 1024));
    assert.throws(() => loadServiceAccount(big), /too big/);
    const json = path.join(dir, 'a.json');
    fs.writeFileSync(json, 'SECRET {{{');
    assert.throws(
      () => loadServiceAccount(json),
      (e: Error) => /not valid JSON/.test(e.message) && !e.message.includes('SECRET'),
    );
    fs.writeFileSync(json, JSON.stringify({ type: 'service_account', project_id: 'p', client_email: 'e@x' }));
    assert.throws(() => loadServiceAccount(json), /no "private_key"/);
    const ok = serviceAccountFile(dir).file;
    assert.equal(loadServiceAccount(ok).projectId, 'meyou-test-proj');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- push-test command ----------------------------------------------------------------------

async function cliEnv(extra: Record<string, string> = {}) {
  const dir = tmp();
  const cfg = loadConfig({ DATA_DIR: dir, DOMAIN: 'meyou.example.com', ...extra });
  const db = openDb(path.join(dir, 'db', 'meyou.sqlite'));
  initHousehold(cfg, db);
  return { dir, cfg, db, cleanup: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

test('push-test: not configured, unusable credentials, --check', async () => {
  const dir = tmp();
  try {
    let out = '';
    const w = (s: string) => void (out += s);
    assert.equal(await runPushTest(loadConfig({ DATA_DIR: dir }), [], w), 2);
    assert.match(out, /FCM_SERVICE_ACCOUNT_FILE is not set/);

    out = '';
    const broken = path.join(dir, 'b.json');
    fs.writeFileSync(broken, 'SECRET {{{');
    assert.equal(await runPushTest(loadConfig({ DATA_DIR: dir, FCM_SERVICE_ACCOUNT_FILE: broken }), [], w), 2);
    assert.match(out, /NOT usable: the file is not valid JSON/);
    assert.ok(!out.includes('SECRET'));

    out = '';
    const { file, privateKey } = serviceAccountFile(dir);
    assert.equal(await runPushTest(loadConfig({ DATA_DIR: dir, FCM_SERVICE_ACCOUNT_FILE: file }), ['--check'], w), 0);
    assert.match(out, /Credentials OK\. Firebase project: meyou-test-proj/);
    assert.ok(!out.includes(privateKey.split('\n')[1]!));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push-test: sends a test notification to each registered phone and reports failures', async () => {
  const e = await cliEnv({ FCM_SERVICE_ACCOUNT_FILE: '/unused/key.json' });
  try {
    const fcm = new FakeFcm();
    const make = async () => fcm;
    let out = '';
    const w = (s: string) => void (out += s);

    // No phone registered yet.
    assert.equal(await runPushTest(e.cfg, [], w, make), 1);
    assert.match(out, /No phone has registered/);

    const owner = e.db.prepare('SELECT id FROM devices LIMIT 1').get() as { id: string };
    e.db.prepare('UPDATE devices SET fcm_token = ?, lang = ? WHERE id = ?').run(tok('owner'), 'fa', owner.id);
    out = '';
    assert.equal(await runPushTest(e.cfg, [], w, make), 0);
    assert.match(out, /sent to/);
    assert.equal(fcm.sent.length, 1);
    assert.equal(fcm.sent[0]!.data.type, 'test');
    assert.match(fcm.sent[0]!.notification!.body, /[\u0600-\u06ff]/);
    assert.ok(!out.includes(tok('owner')), 'the token is never printed');
    assert.equal(fcm.closed, true);

    // A token FCM rejects is reported and removed.
    fcm.behaviour = () => {
      throw fcmError('messaging/registration-token-not-registered');
    };
    out = '';
    assert.equal(await runPushTest(e.cfg, [], w, make), 1);
    assert.match(out, /FAILED .*registration-token-not-registered.*removed/);
    assert.equal((e.db.prepare('SELECT fcm_token FROM devices WHERE id = ?').get(owner.id) as { fcm_token: string | null }).fcm_token, null);

    // Known failures come with a hint.
    e.db.prepare('UPDATE devices SET fcm_token = ? WHERE id = ?').run(tok('owner'), owner.id);
    fcm.behaviour = () => {
      throw fcmError('messaging/mismatched-credential');
    };
    out = '';
    assert.equal(await runPushTest(e.cfg, [], w, make), 1);
    assert.match(out, /mismatched-credential.*different Firebase project/);
  } finally {
    e.cleanup();
  }
});

// ---- per-type opt-out (S11) ----------------------------------------------------------------

const flags = (env: Env, id: string) =>
  ({ ...env.db.prepare('SELECT notify_mood, notify_event FROM devices WHERE id = ?').get(id) }) as {
    notify_mood: number;
    notify_event: number;
  };

test('notify on PUT /push/token: default is on, an older app that sends no notify keeps the stored choice', async () => {
  const p = await pair();
  try {
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 1, notify_event: 1 });
    let r = await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en', notify: { mood: false, event: true } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 0, notify_event: 1 });
    // No `notify` at all (an app from before S11): nothing changes.
    r = await putToken(p.env, p.ownerToken, { fcmToken: tok('owner2'), lang: 'en' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 0, notify_event: 1 });
    // A key that is left out stays as it was.
    r = await putToken(p.env, p.ownerToken, { fcmToken: tok('owner2'), lang: 'en', notify: { event: false } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 0, notify_event: 0 });
    // Back on.
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner2'), lang: 'en', notify: { mood: true, event: true } });
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 1, notify_event: 1 });
    // The partner's flags were never touched.
    assert.deepEqual(flags(p.env, p.memberId), { notify_mood: 1, notify_event: 1 });
  } finally {
    await p.env.cleanup();
  }
});

test('notify must be an object of booleans: anything else is 400 and changes nothing', async () => {
  const p = await pair();
  try {
    const good = { fcmToken: tok('owner'), lang: 'en' };
    for (const notify of ['no', 1, null, [], [true], { mood: 'yes' }, { event: 0 }, { mood: true, event: null }]) {
      const r = await putToken(p.env, p.ownerToken, { ...good, notify });
      assert.equal(r.statusCode, 400, JSON.stringify(notify));
      assert.deepEqual(r.json(), { error: 'bad_request' });
    }
    assert.equal(row(p.env, p.ownerId).fcm_token, null);
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 1, notify_event: 1 });
    // Unknown extra keys inside notify are ignored.
    const ok = await putToken(p.env, p.ownerToken, { ...good, notify: { mood: false, other: 'x' } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 0, notify_event: 1 });
  } finally {
    await p.env.cleanup();
  }
});

test('a visible push is skipped only when ALL four switches are off; silent pushes always go; the blob is stored anyway', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en', notify: { mood: false, event: true } });
    await putToken(p.env, p.memberToken, { fcmToken: tok('member'), lang: 'en' });
    // The server cannot tell the type of a blob: with one switch still on, the visible push goes out.
    await post(p.env, p.memberToken, { wake: true });
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.length, 1);
    // All four off: a visible push is skipped, the blob is still stored.
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en', notify: { mood: false, event: false, diary: false, period: false } });
    const r = await post(p.env, p.memberToken, { wake: true });
    assert.equal(r.statusCode, 200);
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.length, 1);
    const stats = (await p.env.app.inject({ method: 'GET', url: '/api/v1/e2e/stats', headers: bearer(p.ownerToken) })).json() as { count: number };
    assert.equal(stats.count, 2);
    // A silent (data-only) push shows nothing, so it is never switched off.
    await post(p.env, p.memberToken, { wake: false });
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.length, 2);
    assert.equal(p.fcm.sent[1]!.notification, undefined);
    // The opt-out does not affect the other direction.
    await post(p.env, p.ownerToken, { wake: true });
    await p.env.app.push.idle();
    assert.equal(p.fcm.sent.at(-1)!.token, tok('member'));
  } finally {
    await p.env.cleanup();
  }
});

test('the CLI test push ignores the opt-out, and DELETE /push/token keeps the choice', async () => {
  const p = await pair();
  try {
    await putToken(p.env, p.ownerToken, { fcmToken: tok('owner'), lang: 'en', notify: { mood: false, event: false } });
    const dev = p.env.db.prepare('SELECT * FROM devices WHERE id = ?').get(p.ownerId) as never;
    const out = await p.env.app.push.sendTest(dev);
    assert.equal(out.ok, true);
    assert.equal(p.fcm.sent.at(-1)!.data.type, 'test');
    await p.env.app.inject({ method: 'DELETE', url: '/api/v1/push/token', headers: bearer(p.ownerToken) });
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 0, notify_event: 0 });
  } finally {
    await p.env.cleanup();
  }
});

test('migration 5 and 6 are idempotent: an older database gets the columns once, a migrated one is left alone', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'db.sqlite');
    const db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 7);
    // Pretend it is still at version 4 although the columns are there (a manual reset): no error.
    db.exec('PRAGMA user_version = 4');
    db.close();
    const again = openDb(file);
    assert.equal(again.prepare('PRAGMA user_version').get()!.user_version, 7);
    const cols = (again.prepare('PRAGMA table_info(devices)').all() as unknown as { name: string }[]).map((c) => c.name);
    for (const c of ['notify_mood', 'notify_event', 'notify_diary', 'notify_period']) assert.equal(cols.filter((x) => x === c).length, 1, c);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R1a: channel v2, diary / period, silent hints -------------------------------------------

test('R1a notify keys diary and period: stored, default on, left-out keys stay, non-boolean is 400', async () => {
  const p = await pair();
  try {
    const f = () =>
      ({ ...p.env.db.prepare('SELECT notify_diary, notify_period FROM devices WHERE id = ?').get(p.ownerId) }) as {
        notify_diary: number;
        notify_period: number;
      };
    assert.deepEqual(f(), { notify_diary: 1, notify_period: 1 });
    let r = await putToken(p.env, p.ownerToken, { fcmToken: tok('o'), lang: 'en', notify: { diary: false } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(f(), { notify_diary: 0, notify_period: 1 });
    r = await putToken(p.env, p.ownerToken, { fcmToken: tok('o'), lang: 'en', notify: { period: false } });
    assert.deepEqual(f(), { notify_diary: 0, notify_period: 0 });
    // an older app (no notify) changes nothing; mood/event flags are independent.
    await putToken(p.env, p.ownerToken, { fcmToken: tok('o'), lang: 'en' });
    assert.deepEqual(f(), { notify_diary: 0, notify_period: 0 });
    assert.deepEqual(flags(p.env, p.ownerId), { notify_mood: 1, notify_event: 1 });
    for (const notify of [{ diary: 'no' }, { period: 1 }, { diary: null }]) {
      r = await putToken(p.env, p.ownerToken, { fcmToken: tok('o'), lang: 'en', notify });
      assert.equal(r.statusCode, 400, JSON.stringify(notify));
    }
    assert.deepEqual(f(), { notify_diary: 0, notify_period: 0 });
    await putToken(p.env, p.ownerToken, { fcmToken: tok('o'), lang: 'en', notify: { diary: true, period: true } });
    assert.deepEqual(f(), { notify_diary: 1, notify_period: 1 });
  } finally {
    await p.env.cleanup();
  }
});
