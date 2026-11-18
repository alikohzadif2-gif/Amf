// S11: fail2ban-style lockout for repeated bad credentials.
//
// What counts: a request that presented a credential the server does not know (an unknown or revoked
// bearer token, a wrong invite code). What does NOT count twice: the same wrong value again. A phone whose
// token was revoked keeps retrying with that one token; that must never lock the household's Wi-Fi
// out, while a guessing script (a new value every time) reaches the limit quickly.
// State is in memory only: a restart clears it (and an attacker cannot make that happen).
import { createHash } from 'node:crypto';

export interface LockoutOptions {
  /** Distinct bad credentials from one address before it is locked. 0 turns the lockout off. */
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  now?: () => number;
}

interface Entry {
  first: number;
  seen: Set<string>;
  lockedUntil: number;
}

/** Hard cap on tracked addresses so a flood of spoofed sources cannot grow memory without limit. */
const MAX_TRACKED = 5000;

export class Lockout {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly opts: LockoutOptions) {
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.maxFailures > 0;
  }

  /** Seconds the address stays locked, or 0 when it is free. */
  lockedFor(ip: string): number {
    if (!this.enabled) return 0;
    const e = this.entries.get(ip);
    if (!e) return 0;
    const left = e.lockedUntil - this.now();
    if (left > 0) return Math.ceil(left / 1000);
    if (e.lockedUntil > 0) this.entries.delete(ip); // lock is over: start clean
    return 0;
  }

  /**
   * Record one bad credential. `value` is hashed here and only the hash is kept.
   * Returns true when this failure just locked the address.
   */
  fail(ip: string, value: string): boolean {
    if (!this.enabled) return false;
    const now = this.now();
    let e = this.entries.get(ip);
    if (e && e.lockedUntil > now) return false; // already locked
    if (!e || now - e.first > this.opts.windowMs) {
      if (!e && this.entries.size >= MAX_TRACKED) this.sweep(now);
      if (!e && this.entries.size >= MAX_TRACKED) return false; // still full: skip (never throw)
      e = { first: now, seen: new Set(), lockedUntil: 0 };
      this.entries.set(ip, e);
    }
    e.seen.add(createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16));
    if (e.seen.size >= this.opts.maxFailures) {
      e.lockedUntil = now + this.opts.lockMs;
      e.seen.clear();
      return true;
    }
    return false;
  }

  /** A good credential from an unlocked address clears its earlier mistakes. */
  clear(ip: string): void {
    const e = this.entries.get(ip);
    if (e && e.lockedUntil <= this.now()) this.entries.delete(ip);
  }

  private sweep(now: number): void {
    for (const [ip, e] of this.entries) {
      if (e.lockedUntil > now) continue;
      if (now - e.first > this.opts.windowMs) this.entries.delete(ip);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
