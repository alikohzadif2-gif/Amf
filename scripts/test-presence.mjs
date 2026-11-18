// Stage 2D (part 3): partner online state. Pure logic + the listener's handling of the server's `presence` frame; no phone, no server.
import assert from 'node:assert/strict';
import { MailboxListener } from '../src/partner/mailbox-client.ts';
import { parsePresenceFrame, presenceView } from '../src/partner/presence-logic.ts';

// ---- frame parsing: only the exact shape counts
assert.equal(parsePresenceFrame({ type: 'presence', online: true }), true);
assert.equal(parsePresenceFrame({ type: 'presence', online: false }), false);
assert.equal(parsePresenceFrame({ type: 'presence', online: 'yes' }), null);
assert.equal(parsePresenceFrame({ type: 'presence' }), null);
assert.equal(parsePresenceFrame({ type: 'message', online: true }), null);
assert.equal(parsePresenceFrame({}), null);

// ---- what the screens show
const v = (o) => presenceView({ paired: true, link: 'connected', partnerOnline: null, ...o });
assert.equal(v({ partnerOnline: true }), 'online');
assert.equal(v({ partnerOnline: false }), 'offline');
assert.equal(v({}), 'unknown', 'not announced yet (e.g. an older server): nothing shown');
assert.equal(v({ partnerOnline: true, link: 'offline' }), 'unknown', 'this phone has no socket: never guess');
assert.equal(v({ partnerOnline: false, link: 'connecting' }), 'unknown');
assert.equal(v({ partnerOnline: true, paired: false }), 'unknown');

// ---- listener: presence frames reach onPresence, are not mistaken for messages, and do not disturb the cursor
const sockets = [];
const createSocket = (url) => {
  const s = { url, onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
  sockets.push(s);
  return s;
};
const presence = [];
const got = [];
const listener = new MailboxListener({
  connection: { url: 'https://x.test', token: 't' },
  since: () => '0',
  poll: async () => ({ cursor: '0', messages: [] }),
  wsPath: '/e2e/ws',
  createSocket,
  onPresence: (o) => presence.push(o),
  onMessage: async (m) => got.push(m.seq),
});
listener.start();
for (let i = 0; i < 50 && sockets.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
sockets[0].onopen?.({});
const send = (f) => sockets[0].onmessage({ data: JSON.stringify(f) });
send({ type: 'ready', cursor: '0' });
send({ type: 'presence', online: false });
send({ type: 'presence', online: true });
send({ type: 'presence', online: 'junk' });
send({ type: 'message', seq: 1, time: 't', body: { id: 'a', blob: 'x' } });
send({ type: 'presence', online: false });
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(presence, [false, true, false], 'only valid presence frames, in order');
assert.deepEqual(got, [1], 'a real message still arrives; presence is not a message');
listener.stop();

// ---- a listener without onPresence (older callers / tests) ignores the frame
const quiet = new MailboxListener({ connection: { url: 'https://x.test', token: 't' }, since: () => '0', poll: async () => ({ cursor: '0', messages: [] }), wsPath: '/e2e/ws', createSocket, onMessage: async () => {} });
quiet.start();
for (let i = 0; i < 50 && sockets.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
sockets[1].onmessage({ data: JSON.stringify({ type: 'presence', online: true }) });
quiet.stop();

console.log('presence tests passed');
