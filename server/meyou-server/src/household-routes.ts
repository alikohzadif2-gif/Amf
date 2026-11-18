// Household routes: POST /invites, POST /join (public), DELETE /devices/:id.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Household } from './household.js';
import type { Result } from './result.js';

function send<T>(reply: FastifyReply, r: Result<T>): unknown {
  return r.ok ? r.value : reply.code(r.status).send(r.body);
}

export function registerHouseholdRoutes(api: FastifyInstance, cfg: Config, household: Household): void {
  const inviteLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  api.post('/invites', { config: inviteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const r = household.createInvite(request.device!);
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
      const r = household.join(request.body);
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
    return send(reply, household.revokeDevice(request.device!, id));
  });
}
