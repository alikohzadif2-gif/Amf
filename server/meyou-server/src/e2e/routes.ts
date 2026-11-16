// Encrypted queue routes: POST/GET /e2e/queue, POST /e2e/ack, GET /e2e/stats, WebSocket /e2e/ws.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Result } from '../partner/service.js';
import { b64Length, LIST_MAX_MESSAGES, type E2eQueue } from './queue.js';

function send<T>(reply: FastifyReply, r: Result<T>): unknown {
  return r.ok ? r.value : reply.code(r.status).send(r.body);
}

function intParam(v: unknown, def: number, min: number, max: number, clamp = false): number | null {
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  if (n < min) return null;
  if (n > max) return clamp ? max : null;
  return n;
}

export function registerE2eRoutes(api: FastifyInstance, cfg: Config, queue: E2eQueue): void {
  const limit = { rateLimit: { max: cfg.mailboxRateLimitMax, timeWindow: '1 minute' } };
  // Body = {"id": "...", "blob": "<base64url>"}: the blob text plus a little JSON.
  const bodyLimit = b64Length(cfg.e2eMaxBlobBytes) + 1024;

  api.post('/e2e/queue', { config: limit, bodyLimit }, async (request: FastifyRequest, reply: FastifyReply) =>
    send(reply, queue.post(request.device!, request.body)),
  );

  api.get('/e2e/queue', { config: limit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, unknown>;
    const since = intParam(q.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const n = intParam(q.limit, 20, 1, LIST_MAX_MESSAGES, true);
    if (since === null || n === null) return reply.code(400).send({ error: 'bad_request' });
    return queue.list(request.device!, since, n);
  });

  api.post('/e2e/ack', { config: limit }, async (request: FastifyRequest, reply: FastifyReply) => send(reply, queue.ack(request.device!, request.body)));

  api.get('/e2e/stats', { config: limit }, async (request: FastifyRequest) => queue.stats(request.device!));

  // Live delivery, same rules as /mailbox/ws: register first, then replay, so nothing is missed or doubled.
  // A blob stays in the queue until the phone ACKs it over POST /e2e/ack; frames from the phone are ignored.
  api.get('/e2e/ws', { websocket: true, config: limit }, (socket, request: FastifyRequest) => {
    const device = request.device!;
    const since = intParam((request.query as Record<string, unknown>).since, 0, 0, Number.MAX_SAFE_INTEGER);
    if (since === null) {
      socket.close(4400, 'bad_request');
      return;
    }
    socket.on('message', () => {
      /* nothing is accepted from the phone on this channel */
    });
    const live = queue.hub.add(device.id, socket, since, device.token_hash);
    let cursor = since;
    for (;;) {
      const page = queue.list(device, cursor, LIST_MAX_MESSAGES);
      for (const m of page.messages) {
        socket.send(JSON.stringify({ type: 'message', seq: m.seq, time: m.time, body: { id: m.id, blob: m.blob } }));
        cursor = m.seq;
      }
      if (!page.more) break;
    }
    live.lastSeq = Math.max(live.lastSeq, cursor);
    socket.send(JSON.stringify({ type: 'ready', cursor: String(cursor) }));
  });
}
