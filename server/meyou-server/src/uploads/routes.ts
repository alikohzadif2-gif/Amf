// Resumable upload routes (contract C.2). There is deliberately NO delete route.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Result, Uploads } from './service.js';

function send<T>(reply: FastifyReply, r: Result<T>): unknown {
  return r.ok ? r.value : reply.code(r.status).send(r.body);
}

export function registerUploadRoutes(api: FastifyInstance, cfg: Config, uploads: Uploads): void {
  const limit = { rateLimit: { max: cfg.uploadRateLimitMax, timeWindow: '1 minute' } };

  // The chunk body is streamed to disk, never buffered. Fastify's own bodyLimit (set per route
  // below) already rejects a bigger Content-Length; the service counts bytes for chunked bodies.
  api.addContentTypeParser(['application/offset+octet-stream', 'application/octet-stream'], (_req, payload, done) => done(null, payload));

  api.post('/uploads', { config: limit }, async (request: FastifyRequest, reply: FastifyReply) => {
    return send(reply, await uploads.create(request.device!.id, request.body));
  });

  api.patch(
    '/uploads/:id',
    { config: limit, bodyLimit: cfg.uploadMaxChunkBytes },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const ct = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (ct !== 'application/offset+octet-stream' && ct !== 'application/octet-stream') return reply.code(400).send({ error: 'bad_request' });
      const rawLen = request.headers['content-length'];
      const len = rawLen === undefined ? null : /^\d{1,16}$/.test(rawLen) ? Number(rawLen) : NaN;
      if (Number.isNaN(len)) return reply.code(400).send({ error: 'bad_request' });
      return send(reply, await uploads.patch(id, request.headers['upload-offset'], request.body as NodeJS.ReadableStream as never, len));
    },
  );

  api.post('/uploads/:id/complete', { config: limit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return send(reply, await uploads.complete(id));
  });
}
