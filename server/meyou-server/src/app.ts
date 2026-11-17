// Fastify app factory. Everything except GET /api/v1/ping needs a Bearer token.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import type { Writable } from 'node:stream';
import type { Config } from './config.js';
import { findDeviceByTokenHash, getHousehold, partnerOf, touchDevice, type Db, type DeviceRow } from './db.js';
import { bearerToken, hashToken, hashesEqual } from './tokens.js';
import { Lockout } from './lockout.js';
import { SocketHub } from './e2e/hub.js';
import { Household } from './household.js';
import { registerHouseholdRoutes } from './household-routes.js';
import { E2eQueue } from './e2e/queue.js';
import { registerE2eRoutes } from './e2e/routes.js';
import { Push, type PushOptions } from './push/service.js';
import { registerPushRoutes } from './push/routes.js';
import { createFcmTransport, PushConfigError, type PushTransport } from './push/transport.js';

declare module 'fastify' {
  interface FastifyRequest {
    device: DeviceRow | null;
  }
  interface FastifyInstance {
    household: Household;
    e2e: E2eQueue;
    push: Push;
    lockout: Lockout;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export const VERSION: string = (
  JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/**
 * Features this 2.0 build announces in /ping: `e2e` (encrypted queue + WebSocket) always, `push` only when the
 * Firebase credentials loaded (so the app never waits for a push that cannot come). The old `media`, `upload` and
 * `mailbox` features are gone: the app no longer asks for them.
 */
export function announcedFeatures(_cfg: Config, push?: { enabled: boolean }): string[] {
  return push?.enabled ? ['e2e', 'push'] : ['e2e'];
}

const LAST_SEEN_EVERY_MS = 60_000;

export interface BuildOptions {
  logLevel?: string;
  logStream?: Writable;
  /** Test hooks for the queue and household (clock, WebSocket ping interval in ms; 0 = no pings). */
  partner?: { now?: () => number; pingEveryMs?: number; presenceGraceMs?: number };
  /**
   * Test hooks for push. `transport` replaces FCM (a fake in tests); `null` forces push off even when
   * FCM_SERVICE_ACCOUNT_FILE is set. Left out, the transport is built from the config.
   */
  push?: PushOptions & { transport?: PushTransport | null };
  /** Test hook for the auth lockout clock. */
  lockoutNow?: () => number;
}

export async function buildApp(cfg: Config, db: Db, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // Defence in depth: the default request serializer never logs headers.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: cfg.trustProxy,
    bodyLimit: 64 * 1024,
    // S11: Fastify's default request lines are replaced by one line per answered request (below) that
    // never contains a query string, a header or a path parameter.
    disableRequestLogging: true,
  });

  app.addHook('onResponse', (request, reply, done) => {
    // The route pattern (/api/v1/e2e/queue), not the real URL: ids, names and queries stay out of logs.
    const route = request.routeOptions?.url ?? '(unmatched)';
    const status = reply.statusCode;
    // The Docker healthcheck calls /ping every 30 s: keep that at debug level.
    const quiet = request.routeOptions?.config?.public === true && route.endsWith('/ping') && status === 200;
    const line = {
      method: request.method,
      route,
      status,
      ms: Math.round(reply.elapsedTime),
      ip: request.ip,
      ...(request.device ? { device: request.device.id } : {}),
    };
    if (quiet) request.log.debug(line, 'request');
    else if (status === 401 || status === 403 || status === 429) request.log.warn(line, 'request refused');
    else if (status >= 500) request.log.error(line, 'request failed');
    else request.log.info(line, 'request');
    done();
  });

  const lockout = new Lockout({
    maxFailures: cfg.authFailMax,
    windowMs: cfg.authFailWindowMinutes * 60_000,
    lockMs: cfg.authLockoutMinutes * 60_000,
    ...(opts.lockoutNow ? { now: opts.lockoutNow } : {}),
  });
  app.decorate('lockout', lockout);

  // CORS is deliberately NOT registered: the app is native, browsers must not call this API.

  await app.register(rateLimit, {
    global: true,
    max: cfg.rateLimitMax,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      retryAfter: Math.max(1, Math.ceil(ctx.ttl / 1000)),
    }),
  });

  app.decorateRequest('device', null);

  // Incoming WebSocket frames are never used, so keep them tiny.
  await app.register(websocket, { options: { maxPayload: 1024 } });

  // Push (S9): FCM wake-ups for the partner's phone. Without usable credentials the server runs
  // exactly as before and does not announce `push`.
  let transport: PushTransport | null = null;
  if (opts.push && 'transport' in opts.push) {
    transport = opts.push.transport ?? null;
  } else if (cfg.fcmServiceAccountFile) {
    try {
      transport = await createFcmTransport(cfg.fcmServiceAccountFile);
      app.log.info({ project: transport.projectId }, 'push enabled (FCM)');
    } catch (e) {
      const why = e instanceof PushConfigError ? e.message : 'unexpected error while loading the credentials';
      app.log.warn({ reason: why }, 'push disabled: FCM_SERVICE_ACCOUNT_FILE could not be used');
    }
  }
  const push = new Push(db, app.log, transport, { ...opts.push });
  app.decorate('push', push);
  app.addHook('onClose', async () => push.stop());

  // Encrypted queue: the only phone-to-phone channel. Its own sockets and clock; opaque blobs only.
  const hub = new SocketHub(opts.partner?.pingEveryMs, opts.partner?.presenceGraceMs);
  const household = new Household(db, hub, app.log, { now: opts.partner?.now });
  app.decorate('household', household);
  const e2e = new E2eQueue(cfg, db, hub, app.log, { now: opts.partner?.now, push, onPrune: () => household.pruneInvites() });
  app.decorate('e2e', e2e);
  e2e.start();
  app.addHook('onClose', async () => e2e.stop());

  const lastSeenWritten = new Map<string, number>();

  // Auth hook. The rate limiter is a route-level onRequest hook, which Fastify runs AFTER
  // app-level onRequest hooks, so auth lives in preHandler: the limiter always runs first
  // and a flood of bad tokens is rate limited too. preHandler also covers the 404 handler.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.routeOptions?.config?.public === true) return;
    // S11: a locked address gets nothing, not even with a valid token (ping stays public).
    const lockedSeconds = lockout.lockedFor(request.ip);
    if (lockedSeconds > 0) {
      return reply.code(429).header('Retry-After', String(lockedSeconds)).send({ error: 'locked_out', retryAfter: lockedSeconds });
    }
    const token = bearerToken(request.headers.authorization);
    let device: DeviceRow | undefined;
    if (token) {
      const hash = hashToken(token);
      const row = findDeviceByTokenHash(db, hash);
      // Lookup is by the hash of a 256-bit secret; the final check is constant-time anyway.
      if (row && hashesEqual(row.token_hash, hash)) device = row;
    }
    if (!device) {
      // Count the wrong credential (hashed, and the same wrong value counts once: see lockout.ts).
      const tried = request.headers.authorization ?? '';
      if (lockout.fail(request.ip, tried)) request.log.warn({ ip: request.ip, minutes: cfg.authLockoutMinutes }, 'address locked after repeated bad tokens');
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    }
    request.device = device;
    lockout.clear(request.ip);
    const now = Date.now();
    if (now - (lastSeenWritten.get(device.id) ?? 0) >= LAST_SEEN_EVERY_MS) {
      lastSeenWritten.set(device.id, now);
      touchDevice(db, device.id, new Date(now).toISOString());
    }
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err: { type: err.name, message: err.message } }, 'request failed');
    if (status === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (status >= 500) return reply.code(500).send({ error: 'internal_error' });
    return reply.code(status).send({ error: 'bad_request' });
  });

  await app.register(
    async (api) => {
      // Public (Q9): only name, version and the feature list.
      api.get(
        '/ping',
        { config: { public: true, rateLimit: { max: cfg.publicRateLimitMax, timeWindow: '1 minute' } } },
        async () => ({ name: cfg.serverName, version: VERSION, features: announcedFeatures(cfg, push) }),
      );

      api.get('/me', async (request) => {
        const device = request.device!;
        const partner = partnerOf(db, device);
        return {
          deviceId: device.id,
          role: device.role,
          household: { partner: partner ? { deviceId: partner.id, name: partner.name } : null },
          features: announcedFeatures(cfg, push),
        };
      });

      registerHouseholdRoutes(api, cfg, household);
      registerE2eRoutes(api, cfg, e2e);
      registerPushRoutes(api, cfg, push);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

/** True when the database has a household (i.e. `init` has been run). */
export function isInitialized(db: Db): boolean {
  return getHousehold(db) !== undefined;
}
