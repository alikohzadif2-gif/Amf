// Sharing track, stage 1: keys + QR pairing. Real libsodium (libsodium-wrappers) is injected; the native module is not run here.
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { b64urlDecode, b64urlEncode } from '../src/e2e/base64.ts';
import { SEALED_LEN, openPairingKey, sealPairingKey, buildKeyQr, buildRequestQr, deriveDirectionKeys, newKeyPair, newNonce, parseKeyQr, parseRequestQr, safetyCode } from '../src/e2e/crypto.ts';
import { memoryKvStore } from '../src/e2e/key-store.ts';
import { REQUEST_TTL_MS, createE2ePairing } from '../src/e2e/pairing-flow.ts';

await sodium.ready;
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// ---- base64url
for (const n of [0, 1, 2, 3, 4, 31, 32, 124]) {
  const bytes = sodium.randombytes_buf(n);
  const text = b64urlEncode(bytes);
  assert.ok(/^[A-Za-z0-9_-]*$/.test(text), 'url-safe, no padding');
  assert.ok(eq(b64urlDecode(text), bytes), `round trip ${n}`);
  assert.equal(text, Buffer.from(bytes).toString('base64url'), `same as Node base64url (${n})`);
}
assert.equal(b64urlDecode('a'), null, 'impossible length');
assert.equal(b64urlDecode('ab+/'), null, 'not url-safe');

// ---- QR text
const kp = newKeyPair(sodium);
const nonce = newNonce(sodium);
const req = buildRequestQr(kp.publicKey, nonce);
assert.ok(req.startsWith('meyou-e2e1:req:'));
const parsed = parseRequestQr(`  ${req}\n`);
assert.ok(parsed && eq(parsed.publicKey, kp.publicKey) && eq(parsed.nonce, nonce));
for (const bad of ['', 'meyou://join?x=1', req.replace('req', 'key'), req.slice(0, -4), `${req}!`, 'meyou-e2e1:req:AAAA.BBBB', 'meyou-e2e1:key:AAAA']) {
  assert.equal(parseRequestQr(bad), null, `request rejects ${bad.slice(0, 30)}`);
  assert.equal(parseKeyQr(bad), null, `key rejects ${bad.slice(0, 30)}`);
}

// ---- full pairing between two phones
const make = (clock) => createE2ePairing({ sodium, store: memoryKvStore(), now: () => clock.t });
const clock = { t: 1_000_000 };
const phoneB = make(clock);
const phoneA = make(clock);

assert.deepEqual(await phoneA.status(), { state: 'none' });
assert.equal(await phoneA.getKeys(), null);

const start = await phoneB.startRequest();
assert.ok(start.ok);
assert.deepEqual(await phoneB.status(), { state: 'waiting-key' });

const a = await phoneA.acceptRequest(start.qr);
assert.ok(a.ok, 'A reads QR 1');
assert.ok(parseKeyQr(a.qr), 'QR 2 is well formed');
assert.equal(parseKeyQr(a.qr).length, SEALED_LEN);
assert.ok(a.qr.length < 200, `QR 2 is short (${a.qr.length} chars)`);
assert.equal((await phoneA.status()).state, 'unconfirmed');
assert.equal(await phoneA.getKeys(), null, 'no keys before confirm');

const b = await phoneB.acceptKey(a.qr);
assert.ok(b.ok, 'B opens QR 2');
assert.match(b.code, /^\d{4} \d{4} \d{4}$/);
assert.equal(b.code, a.code, 'same safety code on both phones');

assert.ok(await phoneA.confirm());
assert.ok(await phoneB.confirm());
const keysA = await phoneA.getKeys();
const keysB = await phoneB.getKeys();
assert.ok(keysA && keysB);
assert.ok(eq(keysA.send, keysB.recv) && eq(keysA.recv, keysB.send), 'directions mirror each other');
assert.ok(!eq(keysA.send, keysA.recv), 'two different directions');
assert.equal(keysA.send.length, 32);
assert.equal(keysA.partnerPublicKey.length, 32);
assert.ok(!eq(keysA.partnerPublicKey, keysB.partnerPublicKey), 'each phone holds the other phone public key');

// the derived keys really work with XChaCha20-Poly1305 in both directions
for (const [from, to] of [[keysA, keysB], [keysB, keysA]]) {
  const n = sodium.randombytes_buf(24);
  const box = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt('hello', null, null, n, from.send);
  assert.equal(sodium.to_string(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, box, null, n, to.recv)), 'hello');
  assert.throws(() => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, box, null, n, to.send), 'wrong direction key fails');
}
assert.deepEqual((await phoneA.status()).state, 'paired');
assert.equal((await phoneA.status()).code, a.code);

// a confirmed pairing is never replaced silently
assert.deepEqual(await phoneA.startRequest(), { ok: false, reason: 'already' });
assert.deepEqual(await phoneA.acceptRequest(start.qr), { ok: false, reason: 'already' });
assert.deepEqual(await phoneB.acceptKey(a.qr), { ok: false, reason: 'already' });
await phoneA.cancel();
assert.equal((await phoneA.status()).state, 'paired', 'cancel does not touch a confirmed pairing');
await phoneA.reset();
assert.deepEqual(await phoneA.status(), { state: 'none' });
assert.equal(await phoneA.getKeys(), null);

// ---- attacks and mistakes
{
  const c = { t: 5 };
  const B = make(c);
  const A = make(c);
  const C = make(c); // a third phone
  const r1 = await B.startRequest();
  const resp = await A.acceptRequest(r1.qr);
  assert.deepEqual(await C.acceptKey(resp.qr), { ok: false, reason: 'no-pending' }, 'a phone with no request cannot open it');

  const other = await C.startRequest();
  assert.deepEqual(await C.acceptKey(resp.qr), { ok: false, reason: 'wrong' }, 'a blob sealed for B does not open for C');
  assert.equal((await C.status()).state, 'waiting-key', 'failed attempt keeps the request');

  // a QR 2 from an old request (different nonce) is refused even with the right key pair... new request on B
  const r2 = await B.startRequest();
  assert.deepEqual(await B.acceptKey(resp.qr), { ok: false, reason: 'wrong' }, 'old QR 2 does not answer a new request');

  // flipped byte
  const resp2 = await A.acceptRequest(r2.qr);
  const bytes = parseKeyQr(resp2.qr);
  bytes[70] ^= 1;
  assert.deepEqual(await B.acceptKey(buildKeyQr(bytes)), { ok: false, reason: 'wrong' }, 'changed blob');
  assert.deepEqual(await B.acceptKey('hello'), { ok: false, reason: 'invalid' });
  assert.ok((await B.acceptKey(resp2.qr)).ok, 'the right blob still works afterwards');

  // cancel when the codes differ
  await B.cancel();
  await A.cancel();
  assert.deepEqual(await B.status(), { state: 'none' });
  assert.deepEqual(await A.status(), { state: 'none' });
  assert.equal(await B.confirm(), false, 'nothing to confirm');
}
{
  // QR 1 expires
  const c = { t: 0 };
  const B = make(c);
  const A = make(c);
  const r = await B.startRequest();
  const resp = await A.acceptRequest(r.qr);
  c.t = REQUEST_TTL_MS + 1;
  assert.deepEqual(await B.status(), { state: 'none' }, 'expired request is not shown as waiting');
  assert.deepEqual(await B.acceptKey(resp.qr), { ok: false, reason: 'expired' });
}
{
  // the safety code depends on every input
  const m = sodium.randombytes_buf(32);
  const k1 = newKeyPair(sodium).publicKey;
  const k2 = newKeyPair(sodium).publicKey;
  const base = safetyCode(sodium, m, k1, k2);
  assert.equal(base, safetyCode(sodium, m, k1, k2), 'stable');
  assert.notEqual(base, safetyCode(sodium, sodium.randombytes_buf(32), k1, k2));
  assert.notEqual(base, safetyCode(sodium, m, k2, k1));
  const keys = deriveDirectionKeys(sodium, m, 'a');
  assert.ok(eq(keys.send, deriveDirectionKeys(sodium, m, 'b').recv));
}
{
  // keys are only written to the injected store; no key text leaks into the status
  const store = memoryKvStore();
  const P = createE2ePairing({ sodium, store });
  const Q = createE2ePairing({ sodium, store: memoryKvStore() });
  const r = await Q.startRequest();
  const resp = await P.acceptRequest(r.qr);
  const st = JSON.stringify(await P.status());
  assert.ok(!/master|sk|privateKey/.test(st), 'status holds only the code');
  assert.ok(resp.ok);
}
{
  // nonce binding, same key pair: a blob made for another nonce is refused
  const me = newKeyPair(sodium);
  const n1 = newNonce(sodium);
  const blob = sealPairingKey(sodium, { master: sodium.randombytes_buf(32), ownPublicKey: newKeyPair(sodium).publicKey, nonce: n1 }, me.publicKey);
  assert.ok(openPairingKey(sodium, blob, me, n1), 'right nonce opens');
  assert.equal(openPairingKey(sodium, blob, me, newNonce(sodium)), null, 'other nonce refused');
}
console.log('e2e pairing ok');
