// Partner routes (S7): invites, join, devices, mailbox (+ WebSocket).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { MAX_MESSAGE_BYTES, type Partner, type Result } from './service.js';

function send<T>(reply: FastifyReply, r: Result<T>): unknown {
  return r.ok ? r.value : reply.code(r.status).send(r.body);
}

/** Whole number in [min, max] from a query value; undefined/'' gives the default, junk gives null. */
function intParam(v: unknown, def: number, min: number, max: number, clamp = false): number | null {
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  if (n < min) return null;
  if (n > max) return clamp ? max : null;
  return n;
}

export function registerPartnerRoutes(api: FastifyInstance, cfg: Config, partner: Partner): void {
  const mailboxLimit = { rateLimit: { max: cfg.mailboxRateLimitMax, timeWindow: '1 minute' } };
  const inviteLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  api.post('/invites', { config: inviteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const r = partner.createInvite(request.device!);
    if (!r.ok) return reply.code(r.status).send(r.body);
    const base = cfg.publicUrl ?? `${request.protocol}://${request.host}`;
    const q = new URLSearchParams({ url: base, code: r.value.code });
    return { code: r.value.code, expiresAt: r.value.expiresAt, link: `meyou://join?${q.toString()}` };
  });

  // Public: the invite code is the credential. Tight per-IP limit against guessing.
  api.post(
    '/join',
    { config: { public: true, rateLimit: { max: cfg.joinRateLimitMax, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // S11: wrong codes count towards the same lockout as wrong tokens.
      const lockout = request.server.lockout;
      const locked = lockout.lockedFor(request.ip);
      if (locked > 0) return reply.code(429).header('Retry-After', String(locked)).send({ error: 'locked_out', retryAfter: locked });
      const r = partner.join(request.body);
      if (!r.ok && r.body.error === 'invalid_code') {
        const code = (request.body as { code?: unknown } | null)?.code;
        if (lockout.fail(request.ip, `join:${typeof code === 'string' ? code : ''}`)) {
          request.log.warn({ ip: request.ip }, 'address locked after repeated bad invite codes');
        }
      }
      return send(reply, r);
    },
  );

  api.delete('/devices/:id', { config: inviteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return send(reply, partner.revokeDevice(request.device!, id));
  });

  api.post('/mailbox', { config: mailboxLimit, bodyLimit: MAX_MESSAGE_BYTES }, async (request: FastifyRequest, reply: FastifyReply) =>
    send(reply, partner.post(request.device!, request.body)),
  );

  api.get('/mailbox', { config: mailboxLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, unknown>;
    const since = intParam(q.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(q.limit, 100, 1, 200, true);
    if (since === null || limit === null) return reply.code(400).send({ error: 'bad_request' });
    return partner.list(request.device!, since, limit);
  });

  // Live delivery. The token comes in the Authorization header of the upgrade request (the global
  // auth hook already checked it, a wrong token never gets a socket). Frames from the phone are
  // ignored: sending goes through POST /mailbox.
  api.get('/mailbox/ws', { websocket: true, config: mailboxLimit }, (socket, request: FastifyRequest) => {
    const device = request.device!;
    const q = request.query as Record<string, unknown>;
    const since = intParam(q.since, 0, 0, Number.MAX_SAFE_INTEGER);
    if (since === null) {
      socket.close(4400, 'bad_request');
      return;
    }
    socket.on('message', () => {
      /* nothing is accepted from the phone on this channel */
    });
    // Register first, then replay synchronously: a message posted meanwhile cannot be missed or doubled.
    const live = partner.hub.add(device.id, socket, since, device.token_hash);
    let cursor = since;
    for (;;) {
      const page = partner.list(device, cursor, 200);
      if (page.messages.length === 0) break;
      for (const m of page.messages) {
        socket.send(JSON.stringify({ type: 'message', ...m }));
        cursor = m.seq;
      }
    }
    live.lastSeq = Math.max(live.lastSeq, cursor);
    socket.send(JSON.stringify({ type: 'ready', cursor: String(cursor) }));
  });
}
