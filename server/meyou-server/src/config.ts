// Server configuration, read from environment variables only (no secrets are
// ever written to the repo; see .env.example).
import path from 'node:path';

export interface Config {
  /** Public domain served by Caddy, e.g. meyou.example.com (needed by `init`). */
  domain: string | null;
  /** Public base URL placed in the pairing link. Default https://<domain>. */
  publicUrl: string | null;
  dataDir: string;
  serverName: string;
  host: string;
  port: number;
  /** Trust X-Forwarded-* headers. Only true behind Caddy (docker-compose sets it). */
  trustProxy: boolean;
  /** Global requests per minute per client IP. */
  rateLimitMax: number;
  /** Requests per minute per client IP for public (unauthenticated) routes. */
  publicRateLimitMax: number;
  /** Requests per minute per client IP for thumb/preview/file (a library grid asks for many). */
  mediaRateLimitMax: number;
  /** Seconds between library rescans; 0 turns the periodic rescan off (startup scan stays). */
  scanIntervalSeconds: number;
  /** Largest file one upload may declare, in bytes. */
  uploadMaxFileBytes: number;
  /** Largest single PATCH body (the app sends 1 MiB). */
  uploadMaxChunkBytes: number;
  /** Free disk space that must stay free after an upload, in bytes. */
  uploadMinFreeBytes: number;
  /** Hours an unfinished upload may sit idle before it is discarded. */
  uploadSessionTtlHours: number;
  /** Requests per minute per client IP on /uploads routes (a backup sends many chunks). */
  uploadRateLimitMax: number;
  /** Requests per minute per client IP on POST /join (public, so it is kept tight). */
  joinRateLimitMax: number;
  /** Requests per minute per client IP on /mailbox routes. */
  mailboxRateLimitMax: number;
  /** Q3: a mailbox message is dropped after this many days ... */
  mailboxRetentionDays: number;
  /** ... or when the household has more than this many (the oldest go first). */
  mailboxMaxMessages: number;
  /** Encrypted queue: largest single blob (bytes, after decoding). Previews of ~400 KB must fit. */
  e2eMaxBlobBytes: number;
  /** Encrypted queue: an unacknowledged blob is dropped after this many days. */
  e2eTtlDays: number;
  /** Encrypted queue: most bytes waiting for one device; more is refused (507) until it fetches. */
  e2eMaxQueueBytes: number;
  /** S9: Firebase service-account JSON (mounted read-only). null = push stays off. */
  fcmServiceAccountFile: string | null;
  /** Requests per minute per client IP on PUT/DELETE /push/token. */
  pushRateLimitMax: number;
  /** R1a: name the period update ("started", "pain", "better") in the push text. Off = generic text. */
  pushPeriodDetail: boolean;
  /** S11: distinct bad tokens/codes from one address that lock it; 0 = lockout off. */
  authFailMax: number;
  /** S11: window in which those failures are counted, in minutes. */
  authFailWindowMinutes: number;
  /** S11: how long a locked address is refused, in minutes. */
  authLockoutMinutes: number;
}

const MIB = 1024 * 1024;

export class ConfigError extends Error {}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${key} must be a whole number`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false`);
}

function normalizeDomain(raw: string | undefined): string | null {
  const d = raw?.trim();
  if (!d) return null;
  // A bare host name (optionally with a port). No scheme, no path.
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/.test(d)) {
    throw new ConfigError('DOMAIN must be a bare host name such as meyou.example.com (no https://, no path)');
  }
  return d.toLowerCase();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const domain = normalizeDomain(env.DOMAIN);
  let publicUrl: string | null = null;
  const rawPublic = env.PUBLIC_URL?.trim();
  if (rawPublic) {
    let u: URL;
    try {
      u = new URL(rawPublic);
    } catch {
      throw new ConfigError('PUBLIC_URL must be a full URL such as https://meyou.example.com');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError('PUBLIC_URL must start with https:// or http://');
    publicUrl = u.origin;
  } else if (domain) {
    publicUrl = `https://${domain}`;
  }
  const serverName = (env.SERVER_NAME?.trim() || 'meYou').slice(0, 64);
  return {
    domain,
    publicUrl,
    dataDir: path.resolve(env.DATA_DIR?.trim() || './data'),
    serverName,
    host: env.HOST?.trim() || '0.0.0.0',
    port: int(env, 'PORT', 8080, 1, 65535),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 600, 1, 1_000_000),
    publicRateLimitMax: int(env, 'PUBLIC_RATE_LIMIT_MAX', 30, 1, 1_000_000),
    mediaRateLimitMax: int(env, 'MEDIA_RATE_LIMIT_MAX', 6000, 1, 10_000_000),
    scanIntervalSeconds: int(env, 'SCAN_INTERVAL_SECONDS', 300, 0, 86_400),
    uploadMaxFileBytes: int(env, 'UPLOAD_MAX_FILE_MB', 20_480, 1, 10_485_760) * MIB,
    uploadMaxChunkBytes: int(env, 'UPLOAD_MAX_CHUNK_MB', 8, 1, 256) * MIB,
    uploadMinFreeBytes: int(env, 'UPLOAD_MIN_FREE_MB', 512, 0, 10_485_760) * MIB,
    uploadSessionTtlHours: int(env, 'UPLOAD_SESSION_TTL_HOURS', 48, 1, 24 * 365),
    uploadRateLimitMax: int(env, 'UPLOAD_RATE_LIMIT_MAX', 6000, 1, 10_000_000),
    joinRateLimitMax: int(env, 'JOIN_RATE_LIMIT_MAX', 10, 1, 1_000_000),
    mailboxRateLimitMax: int(env, 'MAILBOX_RATE_LIMIT_MAX', 300, 1, 10_000_000),
    mailboxRetentionDays: int(env, 'MAILBOX_RETENTION_DAYS', 30, 1, 3650),
    mailboxMaxMessages: int(env, 'MAILBOX_MAX_MESSAGES', 1000, 1, 1_000_000),
    e2eMaxBlobBytes: int(env, 'E2E_MAX_BLOB_KB', 1024, 1, 65_536) * 1024,
    e2eTtlDays: int(env, 'E2E_TTL_DAYS', 30, 1, 3650),
    e2eMaxQueueBytes: int(env, 'E2E_MAX_QUEUE_MB', 256, 1, 1_048_576) * MIB,
    fcmServiceAccountFile: env.FCM_SERVICE_ACCOUNT_FILE?.trim() ? path.resolve(env.FCM_SERVICE_ACCOUNT_FILE.trim()) : null,
    pushRateLimitMax: int(env, 'PUSH_RATE_LIMIT_MAX', 60, 1, 10_000_000),
    pushPeriodDetail: bool(env, 'PUSH_PERIOD_DETAIL', false),
    authFailMax: int(env, 'AUTH_FAIL_MAX', 10, 0, 1000),
    authFailWindowMinutes: int(env, 'AUTH_FAIL_WINDOW_MINUTES', 10, 1, 1440),
    authLockoutMinutes: int(env, 'AUTH_LOCKOUT_MINUTES', 15, 1, 10_080),
  };
}

export function dbDir(cfg: Config): string {
  return path.join(cfg.dataDir, 'db');
}
export function dbFile(cfg: Config): string {
  return path.join(dbDir(cfg), 'meyou.sqlite');
}
export function libraryDir(cfg: Config): string {
  return path.join(cfg.dataDir, 'library');
}
export function cacheDir(cfg: Config): string {
  return path.join(cfg.dataDir, 'cache');
}
export function uploadsDir(cfg: Config): string {
  return path.join(cfg.dataDir, 'uploads');
}
