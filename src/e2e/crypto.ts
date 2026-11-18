import { b64urlDecode, b64urlEncode } from './base64';

/**
 * E2E key material for the two phones (sharing track, stage 1).
 * Only libsodium primitives are used (no home-made crypto):
 *  - crypto_box_keypair       X25519 key pair of one pairing
 *  - crypto_box_seal          the master key travels sealed to the partner's public key (shown as a QR in person)
 *  - crypto_kdf_derive_from_key  one XChaCha20-Poly1305 key per direction, derived from the master key
 *  - crypto_generichash       the short "safety code" both screens show
 *  - crypto_aead_xchacha20poly1305_ietf_*  every queue message (stage 3, see envelope.ts)
 * `react-native-libsodium` does not expose crypto_scalarmult / crypto_kx, so the shared secret is a random master key
 * sealed to the partner instead of an X25519 agreement; the security result for a QR exchanged in person is the same.
 */
export type Sodium = {
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_kdf_derive_from_key(subkeyLength: number, subkeyId: number, context: string, key: Uint8Array): Uint8Array;
  crypto_generichash(hashLength: number, message: Uint8Array): Uint8Array;
  randombytes_buf(length: number): Uint8Array;
  /** Stage 3 (encrypted queue): same names and argument order as libsodium-wrappers and react-native-libsodium. */
  crypto_aead_xchacha20poly1305_ietf_encrypt(message: Uint8Array, additionalData: Uint8Array | null, secretNonce: null, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(secretNonce: null, ciphertext: Uint8Array, additionalData: Uint8Array | null, nonce: Uint8Array, key: Uint8Array): Uint8Array;
};

export const KEY_LEN = 32;
export const NONCE_LEN = 12;
/** crypto_box_SEALBYTES */
const SEAL_OVERHEAD = 48;
export const SEALED_LEN = KEY_LEN + KEY_LEN + NONCE_LEN + SEAL_OVERHEAD;
const KDF_CONTEXT = 'meyou-e2'; // exactly 8 characters (libsodium rule)

/** 'a' = the phone that scanned first and created the master key, 'b' = the phone that showed the request. */
export type Role = 'a' | 'b';
export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };
export type DirectionKeys = { send: Uint8Array; recv: Uint8Array };

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Compares without stopping at the first difference. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function newKeyPair(s: Sodium): KeyPair {
  const k = s.crypto_box_keypair();
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}
export const newMasterKey = (s: Sodium): Uint8Array => s.randombytes_buf(KEY_LEN);
export const newNonce = (s: Sodium): Uint8Array => s.randombytes_buf(NONCE_LEN);

/** Phone A: master key + A's public key + the request nonce, sealed so only phone B can open it. */
export function sealPairingKey(s: Sodium, input: { master: Uint8Array; ownPublicKey: Uint8Array; nonce: Uint8Array }, partnerPublicKey: Uint8Array): Uint8Array {
  return s.crypto_box_seal(concat(input.master, input.ownPublicKey, input.nonce), partnerPublicKey);
}

/** Phone B: opens the sealed blob. Null when it is not for this key pair, was changed, or answers another request. */
export function openPairingKey(s: Sodium, sealed: Uint8Array, own: KeyPair, expectedNonce: Uint8Array): { master: Uint8Array; partnerPublicKey: Uint8Array } | null {
  if (sealed.length !== SEALED_LEN) return null;
  let plain: Uint8Array;
  try {
    plain = s.crypto_box_seal_open(sealed, own.publicKey, own.privateKey);
  } catch {
    return null;
  }
  if (!plain || plain.length !== KEY_LEN + KEY_LEN + NONCE_LEN) return null;
  if (!bytesEqual(plain.slice(KEY_LEN + KEY_LEN), expectedNonce)) return null;
  return { master: plain.slice(0, KEY_LEN), partnerPublicKey: plain.slice(KEY_LEN, KEY_LEN + KEY_LEN) };
}

/** One key per direction, so the two phones never encrypt with the same key and counter. */
export function deriveDirectionKeys(s: Sodium, master: Uint8Array, role: Role): DirectionKeys {
  const aToB = s.crypto_kdf_derive_from_key(KEY_LEN, 1, KDF_CONTEXT, master);
  const bToA = s.crypto_kdf_derive_from_key(KEY_LEN, 2, KDF_CONTEXT, master);
  return role === 'a' ? { send: aToB, recv: bToA } : { send: bToA, recv: aToB };
}

/** 12 digits in three groups of four; both phones show it and the two people compare it. */
export function safetyCode(s: Sodium, master: Uint8Array, publicKeyA: Uint8Array, publicKeyB: Uint8Array): string {
  const h = s.crypto_generichash(16, concat(master, publicKeyA, publicKeyB));
  let n = 0;
  for (let i = 0; i < 5; i++) n = n * 256 + h[i]; // 40 bits, exact in a double
  const digits = String(n % 1_000_000_000_000).padStart(12, '0');
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
}

// ---- QR text. Plain text (not a link), so a camera app shows text and the router never sees it.
const REQ = /^meyou-e2e1:req:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const KEY = /^meyou-e2e1:key:([A-Za-z0-9_-]+)$/;

export const buildRequestQr = (publicKey: Uint8Array, nonce: Uint8Array): string => `meyou-e2e1:req:${b64urlEncode(publicKey)}.${b64urlEncode(nonce)}`;
export const buildKeyQr = (sealed: Uint8Array): string => `meyou-e2e1:key:${b64urlEncode(sealed)}`;

export function parseRequestQr(raw: string): { publicKey: Uint8Array; nonce: Uint8Array } | null {
  const m = REQ.exec(raw.trim());
  if (!m) return null;
  const publicKey = b64urlDecode(m[1]);
  const nonce = b64urlDecode(m[2]);
  return publicKey?.length === KEY_LEN && nonce?.length === NONCE_LEN ? { publicKey, nonce } : null;
}

export function parseKeyQr(raw: string): Uint8Array | null {
  const m = KEY.exec(raw.trim());
  const sealed = m ? b64urlDecode(m[1]) : null;
  return sealed?.length === SEALED_LEN ? sealed : null;
}

/** One-QR pairing: the master key as it appears in the invitation link (`mk=`): 32 bytes, base64url, 43 characters. */
export function parseDirectKey(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const key = b64urlDecode(text);
  return key?.length === KEY_LEN ? key : null;
}
