// Push logic (S9): device token registration and FCM delivery. A push failure never fails the
// mailbox write: notify() starts the send in the background and swallows every error.
// Tokens and key material are never logged: logs only carry the device id, the message type
// and the error CODE.
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DeviceRow } from '../db.js';
import type { Result } from '../result.js';
import { buildMessage, type FcmMessage, type PushHint, type PushKind } from './messages.js';
import type { PushTransport } from './transport.js';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (): Result<never> => ({ ok: false, status: 400, body: { error: 'bad_request' } });

/** Real FCM tokens are about 160 characters of [A-Za-z0-9_:-]; be generous but strict on shape. */
const TOKEN_RE = /^[\x21-\x7e]{32,4096}$/;
const LANG_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

/** Errors after which the stored token is useless (FCM: UNREGISTERED / INVALID_ARGUMENT). */
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);
/** Temporary trouble on Google's side or on the network: try again later. */
const RETRYABLE = new Set([
  'messaging/server-unavailable',
  'messaging/internal-error',
  'messaging/unknown-error',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'app/network-error',
  'app/network-timeout',
  // firebase-admin reports "could not fetch an OAuth token" with this code, which is also what a
  // network failure towards Google gives. A really revoked key just costs two extra attempts.
  'app/invalid-credential',
]);
const RETRYABLE_IO = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)$/;

/** Waits between attempts: 3 attempts in total (the SDK retries 503 on its own as well). */
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000];

export interface PushOptions {
  /** Delays between attempts; the number of attempts is this length + 1. */
  retryDelaysMs?: number[];
  /** Test hook: replaces the real wait. */
  sleep?: (ms: number) => Promise<void>;
}

export type SendOutcome = { ok: true } | { ok: false; code: string; tokenRemoved: boolean };

/** The error code as a short, log-safe string (never the error message). */
export function errorCode(e: unknown): string {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; errorInfo?: { code?: unknown } };
  const raw = typeof o.code === 'string' ? o.code : typeof o.errorInfo?.code === 'string' ? o.errorInfo.code : '';
  return /^[A-Za-z0-9/_-]{1,64}$/.test(raw) ? raw : 'unknown';
}

export class Push {
  private readonly delays: number[];
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly wake = new Set<() => void>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    /** null = no credentials: tokens are still stored, nothing is sent, `push` is not announced. */
    private readonly transport: PushTransport | null,
    opts: PushOptions = {},
  ) {
    this.delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleepImpl = opts.sleep ?? ((ms) => this.realSleep(ms));
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  get projectId(): string | undefined {
    return this.transport?.projectId;
  }

  // ---- token registration (PUT/DELETE /push/token) ---------------------------------------

  register(device: DeviceRow, input: unknown): Result<{ registered: true }> {
    const b = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as {
      fcmToken?: unknown;
      lang?: unknown;
      notify?: unknown;
    };
    if (typeof b.fcmToken !== 'string' || !TOKEN_RE.test(b.fcmToken)) return bad();
    if (typeof b.lang !== 'string' || b.lang.length > 16 || !LANG_RE.test(b.lang)) return bad();
    const lang = b.lang.replace('_', '-');
    // `notify` is optional (an older app does not send it: the stored choice stays). When present
    // it is an object whose `mood` / `event` / `diary` / `period` are booleans; a key that is left
    // out stays as it was.
    const flags: Record<'mood' | 'event' | 'diary' | 'period', number | null> = { mood: null, event: null, diary: null, period: null };
    if (b.notify !== undefined) {
      if (!b.notify || typeof b.notify !== 'object' || Array.isArray(b.notify)) return bad();
      const n = b.notify as Record<string, unknown>;
      for (const key of ['mood', 'event', 'diary', 'period'] as const) {
        if (n[key] !== undefined && typeof n[key] !== 'boolean') return bad();
        if (n[key] !== undefined) flags[key] = n[key] ? 1 : 0;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A token belongs to one app install: when it moves to another device row (the same phone
      // paired again), the old row must not keep it.
      this.db.prepare('UPDATE devices SET fcm_token = NULL WHERE fcm_token = ? AND id != ?').run(b.fcmToken, device.id);
      this.db
        .prepare(
          'UPDATE devices SET fcm_token = ?, lang = ?, notify_mood = COALESCE(?, notify_mood), notify_event = COALESCE(?, notify_event), notify_diary = COALESCE(?, notify_diary), notify_period = COALESCE(?, notify_period) WHERE id = ? AND revoked_at IS NULL',
        )
        .run(b.fcmToken, lang, flags.mood, flags.event, flags.diary, flags.period, device.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return ok({ registered: true });
  }

  /** Idempotent: removing a token that is not there is fine. */
  unregister(device: DeviceRow): Result<{ removed: true }> {
    this.db.prepare('UPDATE devices SET fcm_token = NULL WHERE id = ?').run(device.id);
    return ok({ removed: true });
  }

  // ---- sending ------------------------------------------------------------------------------

  /**
   * Called after a mailbox message was stored. Fire and forget: it returns at once, the send (and
   * its retries) run in the background and can never throw into the caller.
   */
  notify(to: DeviceRow, type: 'e2e', seq: number, hint: PushHint = {}): void {
    if (!this.transport || this.stopped || !to.fcm_token) return;
    // The server cannot tell what an encrypted blob is, so a visible generic push is skipped only when the recipient
    // switched ALL four notification types off in Settings. The blob stays in the queue (the app shows it when opened).
    // A silent (data-only) push is never skipped: it shows nothing.
    const allOff = to.notify_mood === 0 && to.notify_event === 0 && to.notify_diary === 0 && to.notify_period === 0;
    if (allOff && !hint.silent) {
      this.log.debug({ device: to.id, type }, 'push skipped: every type switched off by the device');
      return;
    }
    const msg = buildMessage(to.fcm_token, type, to.lang, seq, hint);
    const p = this.deliver(to.id, msg, type).catch((e: unknown) => {
      // deliver() already handles every send error; this is only a safety net.
      this.log.error({ device: to.id, type, code: errorCode(e) }, 'push failed unexpectedly');
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Test message for the CLI: waits for the result and reports it. */
  async sendTest(device: DeviceRow): Promise<SendOutcome> {
    if (!this.transport) return { ok: false, code: 'push_disabled', tokenRemoved: false };
    if (!device.fcm_token) return { ok: false, code: 'no_token', tokenRemoved: false };
    return this.deliver(device.id, buildMessage(device.fcm_token, 'test', device.lang, 0), 'test');
  }

  /** Waits until every background send (including retries) is finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stops waiting between retries (pending sends end after their current attempt) and closes FCM. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of [...this.wake]) w();
    await this.idle();
    await this.transport?.close?.().catch(() => undefined);
  }

  private async deliver(deviceId: string, msg: FcmMessage, type: PushKind): Promise<SendOutcome> {
    const transport = this.transport!;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await transport.send(msg);
        this.log.debug({ device: deviceId, type, attempt: attempt + 1 }, 'push sent');
        return { ok: true };
      } catch (e) {
        const code = errorCode(e);
        if (DEAD_TOKEN.has(code)) {
          // Only clear the token we just used: the app may have registered a fresh one meanwhile.
          this.db.prepare('UPDATE devices SET fcm_token = NULL WHERE id = ? AND fcm_token = ?').run(deviceId, msg.token);
          this.log.info({ device: deviceId, type, code }, 'push token rejected by FCM and removed');
          return { ok: false, code, tokenRemoved: true };
        }
        const retryable = RETRYABLE.has(code) || RETRYABLE_IO.test(code);
        const delay = this.delays[attempt];
        if (!retryable || delay === undefined || this.stopped) {
          this.log.warn({ device: deviceId, type, code, attempts: attempt + 1 }, 'push not delivered');
          return { ok: false, code, tokenRemoved: false };
        }
        this.log.info({ device: deviceId, type, code, attempt: attempt + 1, retryInMs: delay }, 'push failed, will retry');
        await this.sleepImpl(delay);
        if (this.stopped) return { ok: false, code, tokenRemoved: false };
      }
    }
  }

  private realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.wake.delete(done);
        resolve();
      };
      // Not unref'd on purpose: a CLI run (push-test) has no server socket, and an unref'd timer would
      // let Node exit silently in the middle of a retry wait. stop() wakes every pending wait.
      const t = setTimeout(done, ms);
      this.wake.add(done);
    });
  }
}
