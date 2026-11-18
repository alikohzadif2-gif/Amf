// Stage 2D (part 1): saved queue cursor + full-list repair only when owed. Pure logic and the listener's replay; no phone, no server.
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { deriveDirectionKeys } from '../src/e2e/crypto.ts';
import { sealEnvelope } from '../src/e2e/envelope.ts';
import { b64urlEncode } from '../src/e2e/base64.ts';
import { memoryKvStore } from '../src/e2e/key-store.ts';
import { createSeenStore, receiveEncrypted } from '../src/e2e/transport.ts';
import { MailboxListener } from '../src/partner/mailbox-client.ts';
import { CONTACT_THROTTLE_MS, STALE_MS, repairReason, shouldRecordContact } from '../src/sync/cursor-logic.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const base = { paired: true, repairPending: false, lastContactAt: NOW - DAY };

// ---- repair decision
assert.equal(STALE_MS, 30 * DAY);
assert.equal(repairReason(base, NOW), null, 'normal start: no digest');
assert.equal(repairReason({ ...base, lastContactAt: NOW - 29 * DAY }, NOW), null, '29 days offline: cursor is enough');
assert.equal(repairReason({ ...base, lastContactAt: NOW - 30 * DAY }, NOW), null, 'exactly 30 days is not over the limit');
assert.equal(repairReason({ ...base, lastContactAt: NOW - 30 * DAY - 1 }, NOW), 'stale', 'more than 30 days offline');
assert.equal(repairReason({ ...base, repairPending: true }, NOW), 'first-pair', 'first pairing / unfinished repair');
assert.equal(repairReason({ ...base, lastContactAt: 0 }, NOW), 'lost-state', 'no record of contact (wiped state, first start after update)');
assert.equal(repairReason({ ...base, lastContactAt: Number.NaN }, NOW), 'lost-state', 'garbage value counts as lost');
assert.equal(repairReason({ ...base, lastContactAt: NOW + 5 * DAY }, NOW), null, 'clock set back is not stale');
assert.equal(repairReason({ paired: false, repairPending: true, lastContactAt: 0 }, NOW), null, 'unpaired: never');

// ---- contact writes are throttled
assert.ok(shouldRecordContact(0, NOW));
assert.ok(!shouldRecordContact(NOW - 1000, NOW), 'a burst of messages is one write');
assert.ok(!shouldRecordContact(NOW - CONTACT_THROTTLE_MS + 1, NOW));
assert.ok(shouldRecordContact(NOW - CONTACT_THROTTLE_MS, NOW));
assert.ok(shouldRecordContact(NOW + DAY, NOW), 'clock moved back: rewrite');
assert.ok(CONTACT_THROTTLE_MS < STALE_MS / 100, 'throttle is far below the stale limit');

// ---- listener: after opening, only what is newer than the saved cursor is fetched and applied (no polling, no full replay)
await sodium.ready;
const queue = [1, 2, 3, 4, 5, 6, 7].map((seq) => ({ seq, time: 't', body: { id: `id${seq}`, blob: 'x' } }));
const polls = [];
const poll = async (_client, cursor) => {
  polls.push(cursor);
  const messages = queue.filter((m) => m.seq > Number(cursor)).slice(0, 3);
  return { cursor: messages.length ? String(messages[messages.length - 1].seq) : cursor, messages };
};
const sockets = [];
const createSocket = (url) => {
  const sock = { url, onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
  sockets.push(sock);
  return sock;
};
let saved = '4'; // persisted by an earlier run
const got = [];
const states = [];
const listener = new MailboxListener({
  connection: { url: 'https://x.test', token: 't' },
  since: () => saved,
  poll,
  wsPath: '/e2e/ws',
  createSocket,
  onState: (s) => states.push(s),
  onMessage: async (m, source) => {
    got.push([m.seq, source]);
    saved = String(m.seq);
  },
});
listener.start();
for (let i = 0; i < 50 && sockets.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
assert.deepEqual(got, [[5, 'replay'], [6, 'replay'], [7, 'replay']], 'only seq > saved cursor (4), nothing older');
assert.equal(polls[0], '4', 'the first request carries the saved cursor');
assert.match(sockets[0].url, /since=7/, 'the socket opens from the newest confirmed cursor');
sockets[0].onopen?.({});
assert.ok(states.includes('connected'));
// a live message arrives on the open socket
sockets[0].onmessage({ data: JSON.stringify({ type: 'message', seq: 8, time: 't', body: { id: 'id8', blob: 'x' } }) });
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(got[got.length - 1], [8, 'live']);
listener.stop();

// ---- the cursor is "confirmed": a message whose apply fails is not ACKed, so the caller never advances past it
const master = sodium.randombytes_buf(32);
const A = deriveDirectionKeys(sodium, master, 'a');
const B = deriveDirectionKeys(sodium, master, 'b');
const sealed = sealEnvelope(sodium, A.send, { t: 'mood', from: 'a', ts: 'x', emoji: '😊' });
const incoming = { seq: 9, body: { id: sealed.id, blob: b64urlEncode(sealed.blob) } };
const acked = [];
const client = { e2eAck: async (s) => (acked.push(...s), { deleted: s.length }) };
const seen = createSeenStore(memoryKvStore());
const keys = async () => B;
await assert.rejects(receiveEncrypted({ sodium, keys, seen, client, apply: async () => { throw new Error('db busy'); } }, incoming));
assert.deepEqual(acked, [], 'failed apply: no ACK, blob comes again');
assert.equal(await receiveEncrypted({ sodium, keys, seen, client, apply: async () => undefined }, incoming), 'applied');
assert.deepEqual(acked, [9]);
assert.equal(await receiveEncrypted({ sodium, keys, seen, client, apply: async () => { throw new Error('must not run'); } }, incoming), 'duplicate', 'a replay after a lost cursor write is not applied twice');

console.log('cursor tests passed');
