// One-QR pairing: the invitation link carries the master key, so one scan connects the server and gives the keys.
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { memoryKvStore } from '../src/e2e/key-store.ts';
import { createE2ePairing } from '../src/e2e/pairing-flow.ts';
import { parseDirectKey } from '../src/e2e/crypto.ts';
import { parseMailboxInvite } from '../src/partner/pairing.ts';

await sodium.ready;
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const make = () => createE2ePairing({ sodium, store: memoryKvStore(), now: () => 1_000_000 });

const owner = make();
const partner = make();

// Owner makes the key; asking again (a second invitation) returns the SAME key.
const made = await owner.createDirect();
assert.ok(made.ok && /^[A-Za-z0-9_-]{43}$/.test(made.key), 'a 43-character url-safe key');
const again = await owner.createDirect();
assert.ok(again.ok && again.key === made.key, 'every invitation of the same owner carries the same key');

// The invitation link: the server's link plus mk=. The app reads url, code and key.
const code = 'ABCDEFGHJKMNPQRSTUVWXYZ2'.slice(0, 24);
const serverLink = `meyou://join?url=${encodeURIComponent('https://example.com:18443')}&code=${code}`;
const link = `${serverLink}&mk=${made.key}`;
const parsed = parseMailboxInvite(link);
assert.ok(parsed && parsed.key === made.key && parsed.code === code && parsed.url === 'https://example.com:18443');
const old = parseMailboxInvite(serverLink);
assert.ok(old && old.key === undefined, 'an invitation from an older version still parses, without a key');
assert.equal(parseMailboxInvite(`${serverLink}&mk=short`), null, 'a damaged key is refused');
assert.equal(parseMailboxInvite(`${serverLink}&mk=${made.key.slice(0, 42)}`), null, 'a cut key is refused');

// Partner stores it. Both phones are paired at once and derive matching direction keys.
assert.deepEqual(await partner.acceptDirect('nope'), { ok: false, reason: 'invalid' });
assert.deepEqual(await partner.acceptDirect(parsed.key), { ok: true });
const o = await owner.getKeys();
const p = await partner.getKeys();
assert.ok(o && p, 'keys are usable without any confirm step');
assert.ok(eq(o.send, p.recv) && eq(o.recv, p.send), 'what one phone sends, the other can open');
assert.ok(!eq(o.send, o.recv), 'one key per direction');
assert.equal((await owner.status()).state, 'paired');
assert.equal((await partner.status()).state, 'paired');
assert.equal((await owner.status()).code, (await partner.status()).code, 'both phones would show the same safety code');

// A real message in both directions with the derived keys.
const nonce = sodium.randombytes_buf(24);
const msg = new TextEncoder().encode('salam');
const boxed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, o.send);
assert.equal(new TextDecoder().decode(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, boxed, null, nonce, p.recv)), 'salam');

// After an unpair both phones start clean; a new owner key is a different key.
await owner.reset();
await partner.reset();
assert.equal(await owner.getKeys(), null);
const fresh = await owner.createDirect();
assert.ok(fresh.ok && fresh.key !== made.key, 'a new pairing gets a new key');

// The two-QR way for pairing from a distance still works next to it, and a direct key does not break it.
const a = make();
const b = make();
const r = await b.startRequest();
assert.ok(r.ok);
const acc = await a.acceptRequest(r.qr);
assert.ok(acc.ok);
const got = await b.acceptKey(acc.qr);
assert.ok(got.ok && got.code === acc.code, 'safety codes match on both phones');

console.log('e2e direct pairing ok');
