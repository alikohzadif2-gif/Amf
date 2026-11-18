// Push routes (S9): the app registers its FCM token (and UI language) after pairing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Push } from './service.js';

export function registerPushRoutes(api: FastifyInstance, cfg: Config, push: Push): void {
  const limit = { rateLimit: { max: cfg.pushRateLimitMax, timeWindow: '1 minute' } };

  api.put('/push/token', { config: limit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const r = push.register(request.device!, request.body);
    return r.ok ? r.value : reply.code(r.status).send(r.body);
  });

  api.delete('/push/token', { config: limit }, async (request: FastifyRequest) => {
    const r = push.unregister(request.device!);
    return r.ok ? r.value : { removed: true };
  });
}
