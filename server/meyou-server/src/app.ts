// Fastify app factory. Everything except GET /api/v1/ping needs a Bearer token.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import type { Writable } from 'node:stream';
import type { Config } from './config.js';
import { findDeviceByTokenHash, getHousehold, partnerOf, touchDevice, type Db, type DeviceRow } from './db.js';
import { bearerToken, hashToken, hashesEqual } from './tokens.js';
import { listRoots } from './library.js';
import { Indexer } from './media/indexer.js';
import { registerMediaRoutes } from './media/routes.js';
import { Uploads, type UploadOptions } from './uploads/service.js';
import { registerUploadRoutes } from './uploads/routes.js';
import { Lockout } from './lockout.js';
import { MailboxHub } from './partner/hub.js';
import { Partner, type PartnerOptions } from './partner/service.js';
import { registerPartnerRoutes } from './partner/routes.js';
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
    indexer: Indexer;
    uploads: Uploads;
    partner: Partner;
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
 * Features this build announces in /ping. S3: media (read API), S5: upload, S7: mailbox,
 * S9: push (only when the Firebase credentials loaded, so the app never waits for a push that cannot come).
 */
export function announcedFeatures(_cfg: Config, push?: { enabled: boolean }): string[] {
  return push?.enabled ? ['media', 'upload', 'mailbox', 'push', 'e2e'] : ['media', 'upload', 'mailbox', 'e2e'];
}

const LAST_SEEN_EVERY_MS = 60_000;

export interface BuildOptions {
  logLevel?: string;
  logStream?: Writable;
  /** Test hooks for the upload module (free disk space, clock). */
  uploads?: UploadOptions;
  /** Test hooks for the partner module (clock, WebSocket ping interval in ms; 0 = no pings). */
  partner?: PartnerOptions & { pingEveryMs?: number };
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
    // The route pattern (/api/v1/items/:id/file), not the real URL: ids, names and queries stay out of logs.
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

  // Media index. It is created here but only starts scanning when `serve` calls indexer.start().
  const indexer = new Indexer(cfg, db, app.log);
  app.decorate('indexer', indexer);
  app.addHook('onClose', async () => indexer.stop());

  // Resumable uploads. Like the indexer, the periodic cleanup only starts when `serve` calls start().
  const uploads = new Uploads(cfg, db, indexer, app.log, opts.uploads);
  app.decorate('uploads', uploads);
  app.addHook('onClose', async () => uploads.stop());

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
  const push = new Push(db, app.log, transport, { periodDetail: cfg.pushPeriodDetail, ...opts.push });
  app.decorate('push', push);
  app.addHook('onClose', async () => push.stop());

  // Partner mailbox (S7): invites, join, revoke, messages, WebSocket live delivery.
  const hub = new MailboxHub(opts.partner?.pingEveryMs);
  const partner = new Partner(cfg, db, hub, app.log, { ...opts.partner, push });
  app.decorate('partner', partner);
  app.addHook('onClose', async () => {
    partner.stop();
    hub.stop();
  });

  // Encrypted queue (sharing track, stage 2): its own sockets and clock; opaque blobs only.
  const e2eHub = new MailboxHub(opts.partner?.pingEveryMs);
  const e2e = new E2eQueue(cfg, db, e2eHub, app.log, { now: opts.partner?.now, push });
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

      api.get('/roots', async () => listRoots(cfg));

      registerMediaRoutes(api, cfg, db);
      registerUploadRoutes(api, cfg, uploads);
      registerPartnerRoutes(api, cfg, partner);
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
