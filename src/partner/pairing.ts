import type { MailboxInvitePayload } from './types';

/** 8 random bytes as hex: this device's id inside messages. */
export function randomDeviceId(randomBytes: (n: number) => Uint8Array): string {
  return Array.from(randomBytes(8), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Parse the server's expiring `meyou://join` invite link. Anything else (including old pairing codes) returns null. */
export function parseMailboxInvite(raw: string): MailboxInvitePayload | null {
  try {
    const link = new URL(raw.trim());
    if (link.protocol !== 'meyou:' || link.hostname !== 'join') return null;
    const url = link.searchParams.get('url')?.trim() ?? '';
    const code = link.searchParams.get('code')?.trim() ?? '';
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    if (!/^[A-HJKMNP-Z2-9]{24}$/.test(code.toUpperCase())) return null;
    return { url: target.toString().replace(/\/+$/, ''), code: code.toUpperCase() };
  } catch {
    return null;
  }
}
