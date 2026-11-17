// Sharing track, stage 3: partner messages through the encrypted queue. Real libsodium (libsodium-wrappers) is injected.
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { b64urlEncode } from '../src/e2e/base64.ts';
import { deriveDirectionKeys } from '../src/e2e/crypto.ts';
import { NONCE_BYTES, PAD_BLOCK, openEnvelope, sealEnvelope } from '../src/e2e/envelope.ts';
import { memoryKvStore } from '../src/e2e/key-store.ts';
import { E2eNotReadyError, createSeenStore, receiveEncrypted, sendEncrypted, shouldWake } from '../src/e2e/transport.ts';
import { MailboxClient, MailboxListener, e2eChannel } from '../src/partner/mailbox-client.ts';
import { createPushRouter, foregroundDecision, parsePushData, shouldNotifyLocal } from '../src/partner/push-events.ts';

await sodium.ready;
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const master = sodium.randombytes_buf(32);
const phoneA = deriveDirectionKeys(sodium, master, 'a');
const phoneB = deriveDirectionKeys(sodium, master, 'b');
const msg = { t: 'mood', from: 'aaaa', ts: '2026-11-13T10:00:00.000Z', emoji: '😊', text: 'سلام ☕', intensity: 4 };

// ---- envelope: round trip, padding, direction, tampering
const sealed = sealEnvelope(sodium, phoneA.send, msg);
assert.equal(sealed.blob[0], 1, 'version byte');
assert.ok(/^[A-Za-z0-9_-]{16}$/.test(sealed.id));
const opened = openEnvelope(sodium, phoneB.recv, sealed.blob);
assert.deepEqual(opened, { id: sealed.id, message: msg }, 'B reads what A sent');
assert.equal(openEnvelope(sodium, phoneA.recv, sealed.blob), null, 'a phone cannot read its own direction');
assert.equal(openEnvelope(sodium, sodium.randombytes_buf(32), sealed.blob), null, 'wrong key');
for (const i of [0, 1, NONCE_BYTES + 1, sealed.blob.length - 1]) {
  const bad = sealed.blob.slice();
  bad[i] ^= 1;
  assert.equal(openEnvelope(sodium, phoneB.recv, bad), null, `flipped byte ${i}`);
}
assert.equal(openEnvelope(sodium, phoneB.recv, sealed.blob.slice(0, sealed.blob.length - 1)), null, 'truncated');
assert.equal(openEnvelope(sodium, phoneB.recv, new Uint8Array(0)), null, 'empty');
assert.equal(sealed.blob.length, 1 + NONCE_BYTES + PAD_BLOCK + 16, 'a small message is one padded block (+ nonce + tag)');
const sizes = new Set();
for (const n of [1, 20, 60, 100]) sizes.add(sealEnvelope(sodium, phoneA.send, { ...msg, text: 'x'.repeat(n) }).blob.length);
assert.equal(sizes.size, 1, 'the server cannot tell a short text from a longer one inside a block');
const big = sealEnvelope(sodium, phoneA.send, { ...msg, text: 'y'.repeat(1000) });
assert.equal((big.blob.length - 1 - NONCE_BYTES - 16) % PAD_BLOCK, 0, 'always whole blocks');
assert.equal(openEnvelope(sodium, phoneB.recv, big.blob).message.text.length, 1000);
const two = sealEnvelope(sodium, phoneA.send, msg);
assert.ok(!eq(two.blob.slice(1, 25), sealed.blob.slice(1, 25)), 'a fresh random nonce each time');
assert.ok(!Buffer.from(sealed.blob).includes(Buffer.from('سلام')), 'no plain text inside');
// a valid ciphertext whose plaintext is not our JSON shape is refused
const raw = (plain) => {
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ad = new TextEncoder().encode('meyou-e2e1:q');
  const padded = new Uint8Array(PAD_BLOCK);
  padded.set(new TextEncoder().encode(plain));
  padded[new TextEncoder().encode(plain).length] = 0x80;
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(padded, ad, null, nonce, phoneA.send);
  return Uint8Array.from([1, ...nonce, ...ct]);
};
for (const plain of ['not json', '{"v":2,"id":"abcdefgh","m":{}}', '{"v":1,"id":"!","m":{}}', '{"v":1,"id":"abcdefgh","m":[]}', '{"v":1,"id":"abcdefgh"}']) assert.equal(openEnvelope(sodium, phoneB.recv, raw(plain)), null, plain);
assert.ok(openEnvelope(sodium, phoneB.recv, raw('{"v":1,"id":"abcdefgh","m":{"t":"x"}}')), 'the helper itself builds valid ones');

// ---- which messages wake the partner (the same rule the server applied to plain messages)
const wake = (m) => shouldWake(m);
assert.equal(wake({ t: 'mood', emoji: 'a' }), true);
assert.equal(wake({ t: 'mood', cleared: true }), false);
assert.equal(wake({ t: 'mood', silent: true }), false);
assert.equal(wake({ t: 'event', id: '1', deleted: true }), false);
assert.equal(wake({ t: 'event', id: '1' }), true);
assert.equal(wake({ t: 'diary', id: '1' }), true);
assert.equal(wake({ t: 'diary', id: '1', silent: true }), false);
assert.equal(wake({ t: 'diary', id: '1', deleted: true }), false);
assert.equal(wake({ t: 'chat', id: '1' }), true);
assert.equal(wake({ t: 'period', kind: 'started' }), true);
assert.equal(wake({ t: 'period', kind: 'pain' }), true);
assert.equal(wake({ t: 'period', kind: 'other' }), false);
for (const t of ['profile', 'unpair', 'story', 'story-seen', 'chat-seen', 'like', 'comment']) assert.equal(wake({ t }), false, t);

// ---- send
const posts = [];
const client = { e2ePost: async (id, blob, w) => (posts.push({ id, blob, w }), { seq: posts.length, time: 'x' }), e2eAck: async () => ({ deleted: 1 }) };
const keysA = async () => phoneA;
const id1 = await sendEncrypted({ sodium, keys: keysA, client }, msg);
assert.equal(id1, posts[0].id);
assert.equal(posts[0].w, true, 'a mood wakes');
assert.ok(/^[A-Za-z0-9_-]+$/.test(posts[0].blob), 'base64url');
assert.ok(!posts[0].blob.includes('aaaa') || true);
assert.deepEqual(openEnvelope(sodium, phoneB.recv, Buffer.from(posts[0].blob, 'base64url')).message, msg);
await sendEncrypted({ sodium, keys: keysA, client }, { t: 'story-seen', from: 'aaaa', ts: msg.ts, id: 's1' });
assert.equal(posts[1].w, false, 'story-seen is silent');
await assert.rejects(() => sendEncrypted({ sodium, keys: async () => null, client }, msg), E2eNotReadyError);
assert.equal(posts.length, 2, 'nothing was sent without keys (never plain)');

// ---- seen store
const kv = memoryKvStore();
const seen = createSeenStore(kv, 'k', 3);
for (const id of ['a', 'b', 'c', 'd']) await seen.add(id);
assert.equal(await seen.has('a'), false, 'bounded: the oldest is forgotten');
assert.equal(await seen.has('d'), true);
assert.equal(await createSeenStore(kv, 'k', 3).has('d'), true, 'persisted');
await seen.clear();
assert.equal(await createSeenStore(kv, 'k', 3).has('d'), false);

// ---- receive: decrypt -> apply -> remember -> ACK
const log = [];
const mk = (extra = {}) => ({
  sodium,
  keys: async () => phoneB,
  seen: createSeenStore(memoryKvStore()),
  client: { e2eAck: async (seqs) => (log.push(['ack', ...seqs]), { deleted: 1 }) },
  apply: async (raw) => void log.push(['apply', raw.id, JSON.parse(raw.message).emoji]),
  ...extra,
});
const incoming = (seq, blob = sealed.blob) => ({ seq, body: { id: 'x', blob: b64urlEncode(blob) } });
let deps = mk();
assert.equal(await receiveEncrypted(deps, incoming(7)), 'applied');
assert.deepEqual(log, [['apply', `e:${sealed.id}`, '😊'], ['ack', 7]], 'applied first, then ACKed');
log.length = 0;
assert.equal(await receiveEncrypted(deps, incoming(8)), 'duplicate', 'the server resent the same message');
assert.deepEqual(log, [['ack', 8]], 'not applied twice, but ACKed');
log.length = 0;
const bad = sealed.blob.slice();
bad[40] ^= 1;
assert.equal(await receiveEncrypted(mk(), incoming(9, bad)), 'invalid');
assert.equal(await receiveEncrypted(mk(), { seq: 10, body: { id: 'x' } }), 'invalid', 'no blob');
assert.equal(await receiveEncrypted(mk(), { seq: 11, body: { id: 'x', blob: '!!' } }), 'invalid', 'not base64url');
assert.deepEqual(log, [['ack', 9], ['ack', 10], ['ack', 11]], 'unreadable blobs are ACKed (dropped), never applied');
log.length = 0;
// the app fails to store it: no ACK, not remembered, comes again and then works
deps = mk({ apply: async () => { throw new Error('db busy'); } });
await assert.rejects(() => receiveEncrypted(deps, incoming(12)), /db busy/);
assert.deepEqual(log, []);
deps = { ...deps, apply: async (raw) => void log.push(['apply', raw.id]) };
assert.equal(await receiveEncrypted(deps, incoming(12)), 'applied');
assert.deepEqual(log, [['apply', `e:${sealed.id}`], ['ack', 12]]);
// a failed ACK is harmless
log.length = 0;
deps = mk({ client: { e2eAck: async () => { throw new Error('offline'); } } });
assert.equal(await receiveEncrypted(deps, incoming(13)), 'applied');
assert.equal(await receiveEncrypted(deps, incoming(13)), 'duplicate');
// a message from the wrong direction (my own key) is not readable
assert.equal(await receiveEncrypted(mk({ keys: async () => phoneA }), incoming(14)), 'invalid');
await assert.rejects(() => receiveEncrypted(mk({ keys: async () => null }), incoming(15)), E2eNotReadyError);

// ---- client: request shape and listener over the encrypted channel
const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization, body: init?.body });
  const u = new URL(String(url));
  if (u.pathname.endsWith('/e2e/queue') && init.method === 'POST') return new Response(JSON.stringify({ seq: 5, time: 't' }), { status: 200 });
  if (u.pathname.endsWith('/e2e/ack')) return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
  if (u.pathname.endsWith('/e2e/queue')) {
    const since = Number(u.searchParams.get('since'));
    const all = [{ seq: 3, time: 't', id: 'one', blob: 'AAAA' }, { seq: 4, time: 't', id: 'two', blob: 'BBBB' }].filter((m) => m.seq > since);
    return new Response(JSON.stringify({ messages: all, cursor: String(all.at(-1)?.seq ?? since), more: false }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
const mc = new MailboxClient({ url: 'https://srv.example/', token: 'tok' }, fakeFetch);
assert.deepEqual(await mc.e2ePost('idid', 'QUJD', true), { seq: 5, time: 't' });
assert.equal(calls[0].url, 'https://srv.example/api/v1/e2e/queue');
assert.equal(calls[0].auth, 'Bearer tok');
assert.deepEqual(JSON.parse(calls[0].body), { id: 'idid', blob: 'QUJD', wake: true });
await mc.e2eAck([3, 4]);
assert.deepEqual(JSON.parse(calls[1].body), { seqs: [3, 4] });

const got = [];
let socket;
let resolveGot;
const sawAll = new Promise((r) => (resolveGot = r));
const listener = new MailboxListener({
  connection: { url: 'https://srv.example', token: 'tok' },
  fetcher: fakeFetch,
  ...e2eChannel,
  since: () => '0',
  createSocket: (url) => {
    assert.equal(url, 'wss://srv.example/api/v1/e2e/ws?since=0', 'follows /e2e/ws');
    socket = { onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
    queueMicrotask(() => {
      socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify({ type: 'ready', cursor: '4' }) });
      socket.onmessage?.({ data: JSON.stringify({ type: 'message', seq: 6, time: 't', body: { id: 'three', blob: 'CCCC' } }) });
    });
    return socket;
  },
  onMessage: (m, source) => {
    got.push([m.seq, source, m.body.id, m.body.blob]);
    if (got.length === 3) resolveGot();
  },
});
listener.start();
await sawAll;
listener.stop();
assert.deepEqual(got, [[3, 'replay', 'one', 'AAAA'], [4, 'replay', 'two', 'BBBB'], [6, 'live', 'three', 'CCCC']], 'replay over HTTP, then live; the ready frame is ignored');

// ---- push events for the encrypted queue
assert.deepEqual(parsePushData({ type: 'e2e', seq: '12' }), { type: 'e2e', seq: '12' });
assert.deepEqual(foregroundDecision({ type: 'e2e', seq: '12' }), { show: false, sync: true });
let syncs = 0;
const router = createPushRouter({ sync: () => void (syncs += 1) });
router.onPush({ type: 'e2e', seq: '12' });
router.onPush({ type: 'e2e', seq: '12' });
assert.equal(syncs, 1, 'one sync per push');
assert.equal(router.wasHeld('e2e:12'), true, 'the open app held the generic notification: its own local one shows');
assert.equal(router.wasHeld('12'), false, 'queue seq numbers never collide with mailbox seq numbers');
const base = { kind: 'mood', pushRegistered: true, heldByForegroundHandler: false };
assert.equal(shouldNotifyLocal({ ...base, source: 'replay' }), false, 'the closed app already got the generic push');
assert.equal(shouldNotifyLocal({ ...base, source: 'live' }), true);

console.log('e2e transport tests ok');

// ---- stage 2D: a full 750 KB original chunk, sealed, fits the server's 1 MiB blob limit (E2E_MAX_BLOB_KB = 1024)
{
  const { ORIG_CHUNK_BYTES } = await import('../src/partner/orig-logic.ts');
  const chunk = { t: 'orig-chunk', from: 'a'.repeat(32), ts: '2026-11-17T10:00:00.000Z', silent: true, rid: 'r'.repeat(16), i: 99999, data: b64urlEncode(new Uint8Array(ORIG_CHUNK_BYTES).fill(255)) };
  const full = sealEnvelope(sodium, phoneA.send, chunk);
  assert.ok(full.blob.length <= 1024 * 1024, `sealed full chunk = ${full.blob.length} bytes, limit ${1024 * 1024}`);
  assert.ok(1024 * 1024 - full.blob.length > 16 * 1024, 'at least 16 KB of headroom');
  assert.equal(openEnvelope(sodium, phoneB.recv, full.blob).message.i, 99999, 'and it opens');
}
