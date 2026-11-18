import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearerToken,
  CODE_ALPHABET,
  generateInviteCode,
  generateToken,
  hashesEqual,
  hashToken,
  INVITE_CODE_LENGTH,
  TOKEN_BYTES,
} from '../src/tokens.js';

test('tokens are random, at least 32 bytes, unique', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(TOKEN_BYTES >= 32);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test('hashToken is a deterministic SHA-256 hex digest', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashToken('x'), hashToken('x'));
  assert.notEqual(hashToken('x'), hashToken('y'));
});

test('hashesEqual compares digests and rejects bad input', () => {
  const h = hashToken('x');
  assert.equal(hashesEqual(h, hashToken('x')), true);
  assert.equal(hashesEqual(h, hashToken('y')), false);
  assert.equal(hashesEqual(h, ''), false);
  assert.equal(hashesEqual('', ''), false);
  assert.equal(hashesEqual(h, h.slice(0, 10)), false);
});

test('invite codes are 24 characters from the unambiguous alphabet', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = generateInviteCode();
    assert.equal(c.length, INVITE_CODE_LENGTH);
    assert.equal(INVITE_CODE_LENGTH, 24);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
    seen.add(c);
  }
  assert.equal(seen.size, 200);
  assert.ok(!/[01OIL]/.test(CODE_ALPHABET));
});

test('bearerToken parses only a well-formed Bearer header', () => {
  const t = generateToken();
  assert.equal(bearerToken(`Bearer ${t}`), t);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(''), null);
  assert.equal(bearerToken(`Basic ${t}`), null);
  assert.equal(bearerToken(`bearer ${t}`), null);
  assert.equal(bearerToken('Bearer short'), null);
  assert.equal(bearerToken(`Bearer ${t} extra`), null);
});
