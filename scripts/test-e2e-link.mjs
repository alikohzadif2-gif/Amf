import assert from 'node:assert/strict';
import { kindOfPayload, payloadFromText, toPairingLink } from '../src/e2e/link.ts';

const req = 'meyou-e2e1:req:AbC-_123.xYz-_789';
const key = 'meyou-e2e1:key:Q2hlY2tfdGhpcy1sb25nLXNlYWxlZC1rZXk_AA';

assert.equal(kindOfPayload(req), 'req');
assert.equal(kindOfPayload(key), 'key');
assert.equal(kindOfPayload('meyou-e2e1:other:abc'), null);
assert.equal(kindOfPayload('hello'), null);

// link round trip
for (const payload of [req, key]) {
  const link = toPairingLink(payload);
  assert.ok(link.startsWith('meyou://settings/secure-pairing?c='));
  assert.equal(payloadFromText(link), payload);
}
assert.equal(toPairingLink('hello'), null);
assert.equal(toPairingLink('meyou-e2e1:oops:abc'), null);

// a shared message with text around the link, with new lines and spaces
const link = toPairingLink(key);
assert.equal(payloadFromText(`  meYou pairing link:\n${link}\n  thanks `), key);
// the raw payload is accepted too (copied from a QR scan, for example)
assert.equal(payloadFromText(`\n${req}\n`), req);
// garbage
assert.equal(payloadFromText(''), null);
assert.equal(payloadFromText('https://example.com/?c=abc'), null);
assert.equal(payloadFromText('meyou://settings/secure-pairing?c=%E0%A4%A'), null); // broken percent-escape, no payload

console.log('e2e link tests ok');
