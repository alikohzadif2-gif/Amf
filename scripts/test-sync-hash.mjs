// SHA-256 (incremental, plain TS) against Node's crypto, including odd split points and the padding edge cases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sha256, compareSources, hashSource, sha256Hex } from '../src/sync/sha256.ts';

const ref = (bytes) => createHash('sha256').update(bytes).digest('hex');
const data = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + 17) & 255);

assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65536, 262144 + 3]) {
  assert.equal(sha256Hex(data(n)), ref(data(n)), `size ${n}`);
}
// the same result however the bytes are split
const big = data(100_000);
for (const cut of [1, 7, 63, 64, 65, 4096, 99_999]) {
  const h = new Sha256();
  for (let i = 0; i < big.length; i += cut) h.update(big.subarray(i, i + cut));
  assert.equal(h.digestHex(), ref(big), `cut ${cut}`);
}
// streamed file source with progress; a short read is an error
const seen = [];
const source = { size: big.length, read: async (o, l) => big.slice(o, o + l) };
assert.equal(await hashSource(source, { piece: 30_000, onProgress: (f) => seen.push(f) }), ref(big));
assert.equal(seen.at(-1), 1);
await assert.rejects(hashSource({ size: 10, read: async () => new Uint8Array(3) }), /short read/);
// compareSources: the check before an original is deleted
const mk = (bytes) => ({ size: bytes.length, read: async (o, l) => bytes.slice(o, o + l) });
const same = data(70_000);
const flipped = same.slice();
flipped[69_999] ^= 1;
assert.equal(await compareSources(mk(same), mk(same.slice()), { piece: 8192 }), 'same');
assert.equal(await compareSources(mk(same), mk(flipped), { piece: 8192 }), 'different', 'one changed bit in the last byte');
assert.equal(await compareSources(mk(same), mk(same.slice(0, 100))), 'different', 'different sizes');
assert.equal(await compareSources(mk(same), { size: same.length, read: async () => { throw new Error('io'); } }), 'unknown');
assert.equal(await compareSources(mk(same), { size: same.length, read: async (o, l) => same.slice(o, o + l - 1) }), 'unknown', 'a short read is unknown, never same');

console.log('sync hash: ok');
