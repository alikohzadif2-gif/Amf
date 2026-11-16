import { b64urlDecode, b64urlEncode } from './base64';
import type { Sodium } from './crypto';

/**
 * One encrypted queue message (sharing track, stage 3). Only libsodium's XChaCha20-Poly1305 is used.
 *
 *   blob      = version(1 byte = 1) | nonce(24 random bytes) | AEAD(padded plaintext)
 *   plaintext = JSON {"v":1,"id":"<16 chars>","m":<the app's PartnerMessage>}
 *   AEAD      = key of the sender's direction (crypto.ts deriveDirectionKeys), associated data "meyou-e2e1:q"
 *
 * The plaintext is padded to a multiple of PAD_BLOCK bytes (0x80 then zeros) so the server sees a size bucket,
 * not the exact length of a mood or a text. A random 24-byte nonce is safe for XChaCha20 (no counter to keep).
 * `id` is the de-duplication key on the receiver and the idempotency id of the POST.
 */
export const ENVELOPE_VERSION = 1;
export const NONCE_BYTES = 24;
const TAG_BYTES = 16;
export const PAD_BLOCK = 256;
const AD = new TextEncoder().encode('meyou-e2e1:q');
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const newEnvelopeId = (s: Sodium): string => b64urlEncode(s.randombytes_buf(12));

function pad(plain: Uint8Array): Uint8Array {
  const total = Math.ceil((plain.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total); // zeros
  out.set(plain);
  out[plain.length] = 0x80;
  return out;
}

function unpad(padded: Uint8Array): Uint8Array | null {
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0) i -= 1;
  return i >= 0 && padded[i] === 0x80 ? padded.slice(0, i) : null;
}

/** Encrypts one message with this phone's SEND key. Returns the blob and the id to post it with. */
export function sealEnvelope(s: Sodium, sendKey: Uint8Array, message: unknown, id: string = newEnvelopeId(s)): { id: string; blob: Uint8Array } {
  const plain = new TextEncoder().encode(JSON.stringify({ v: ENVELOPE_VERSION, id, m: message }));
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const sealed = s.crypto_aead_xchacha20poly1305_ietf_encrypt(pad(plain), AD, null, nonce, sendKey);
  const blob = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  blob[0] = ENVELOPE_VERSION;
  blob.set(nonce, 1);
  blob.set(sealed, 1 + NONCE_BYTES);
  return { id, blob };
}

/** Decrypts with this phone's RECEIVE key. Null for anything that is not a valid message of the partner (wrong key, changed, truncated, other version). */
export function openEnvelope(s: Sodium, recvKey: Uint8Array, blob: Uint8Array): { id: string; message: Record<string, unknown> } | null {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES + 1 || blob[0] !== ENVELOPE_VERSION) return null;
  let padded: Uint8Array;
  try {
    padded = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, blob.slice(1 + NONCE_BYTES), AD, blob.slice(1, 1 + NONCE_BYTES), recvKey);
  } catch {
    return null;
  }
  const plain = padded ? unpad(padded) : null;
  if (!plain) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(plain)) as { v?: unknown; id?: unknown; m?: unknown };
    if (d.v !== ENVELOPE_VERSION || typeof d.id !== 'string' || !ID_RE.test(d.id)) return null;
    if (!d.m || typeof d.m !== 'object' || Array.isArray(d.m)) return null;
    return { id: d.id, message: d.m as Record<string, unknown> };
  } catch {
    return null;
  }
}

export const blobToText = (blob: Uint8Array): string => b64urlEncode(blob);
export const textToBlob = (text: string): Uint8Array | null => b64urlDecode(text);
