// Token and invite-code helpers. Secrets are random, long, and only their
// SHA-256 hash is ever stored. Comparison is constant-time.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 32 random bytes = 256 bits, base64url (43 chars). */
export const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time equality of two hex SHA-256 digests. */
export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Upper-case letters and digits without look-alikes (no 0/O, 1/I/L): 31 symbols, no bias. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 24;

/** Q4: 24 random characters (about 119 bits). Used by the invite endpoints in S7. */
export function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function generateId(): string {
  return randomBytes(12).toString('base64url');
}

/** Extract the token from an `Authorization: Bearer <token>` header, else null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(header.trim());
  return m ? (m[1] ?? null) : null;
}
