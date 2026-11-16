// Run as a separate process by push.test.ts: a retry wait must keep the process alive.
// (The CLI has no open server socket, so an unref'd timer would let Node exit in the middle of the wait.)
import type { FastifyBaseLogger } from 'fastify';
import { openDb } from '../src/db.js';
import { Push } from '../src/push/service.js';

const noop = () => {};
const log = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, silent: noop, child: () => log } as unknown as FastifyBaseLogger;
const db = openDb(':memory:');
let calls = 0;
const transport = {
  send: async () => {
    calls += 1;
    if (calls < 2) throw Object.assign(new Error('x'), { code: 'messaging/server-unavailable' });
  },
};
const push = new Push(db, log, transport, { retryDelaysMs: [300] });
const device = { id: 'd', fcm_token: 'T'.repeat(40), lang: 'en' } as never;
const r = await push.sendTest(device);
console.log(JSON.stringify({ r, calls }));
