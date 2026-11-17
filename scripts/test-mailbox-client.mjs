import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MailboxClient, MailboxError, MailboxListener, joinMailbox } from '../src/partner/mailbox-client.ts';
import { parseMailboxInvite } from '../src/partner/pairing.ts';

const token = 'owner-token-secret';
const calls = [];
const responses = [
  new Response(JSON.stringify({ deviceId: 'owner-1', role: 'owner', household: { partner: null }, features: ['e2e'] })),
  new Response(JSON.stringify({ seq: 7, time: '2026-10-17T10:00:00.000Z' })),
  new Response(JSON.stringify({ messages: [{ seq: 7, time: '2026-10-17T10:00:00.000Z', id: 'abc', blob: 'QUJD' }], cursor: '7', more: false })),
];
const fetcher = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return responses.shift();
};

const client = new MailboxClient({ url: 'https://maryafox.ir:18443/', token }, fetcher);
assert.deepEqual(await client.me(), { deviceId: 'owner-1', role: 'owner', household: { partner: null }, features: ['e2e'] });
assert.deepEqual(await client.e2ePost('abc', 'QUJD', false), { seq: 7, time: '2026-10-17T10:00:00.000Z' });
const page = await client.e2eList('0');
assert.equal(page.messages[0].seq, 7);
assert.equal(page.cursor, '7');
assert.equal(typeof client.publish, 'undefined', 'the plain mailbox publish is gone');
assert.equal(typeof client.poll, 'undefined', 'the plain mailbox poll is gone');
assert.ok(calls.every(({ url }) => url.startsWith('https://maryafox.ir:18443/api/v1/')));
assert.ok(calls.every(({ url }) => !url.includes(token)), 'the bearer token must never be put in a URL');
assert.equal(calls[1].init.headers.Authorization, `Bearer ${token}`);
assert.equal(calls[1].init.method, 'POST');
assert.match(calls[1].url, /\/api\/v1\/e2e\/queue$/);
assert.deepEqual(JSON.parse(calls[1].init.body), { id: 'abc', blob: 'QUJD', wake: false });
assert.match(calls[2].url, /\/api\/v1\/e2e\/queue\?since=0/);

let joinCall;
await joinMailbox('https://maryafox.ir:18443', 'ABCDEFGHJKMNPQRSTUVWXYZ2', 'Partner phone', async (url, init) => {
  joinCall = { url: String(url), init };
  return new Response(JSON.stringify({ deviceId: 'member-1', token: 'member-secret' }));
});
assert.equal(joinCall.url, 'https://maryafox.ir:18443/api/v1/join');
assert.equal(joinCall.init.headers.Authorization, undefined, 'join is intentionally unauthenticated');
assert.deepEqual(JSON.parse(joinCall.init.body), { code: 'ABCDEFGHJKMNPQRSTUVWXYZ2', deviceName: 'Partner phone' });

const invite = 'meyou://join?url=https%3A%2F%2Fmaryafox.ir%3A18443&code=ABCDEFGHJKMNPQRSTUVWXYZ2';
assert.deepEqual(parseMailboxInvite(invite), { url: 'https://maryafox.ir:18443', code: 'ABCDEFGHJKMNPQRSTUVWXYZ2' });
assert.equal(parseMailboxInvite('meyou://join?url=https%3A%2F%2Fexample.com&code=bad'), null);
assert.equal(parseMailboxInvite('{"v":1,"url":"https://example.com","topic":"abcdefghijklmnopqrstuvwxyz012345"}'), null, 'an old JSON pairing code is not accepted by the app flow');

const authFailure = new MailboxClient({ url: 'https://example.com', token }, async () => new Response('{}', { status: 401 }));
await assert.rejects(authFailure.me(), (error) => error instanceof MailboxError && error.kind === 'unauthorized');

const replay = { seq: 9, time: '2026-10-17T10:01:00.000Z', body: { id: 'r9', blob: 'UkVQTEFZ' } };
let cursor = '8';
const delivered = [];
let socketArgs;
const socket = {
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  close() {},
};
const sources = [];
const listener = new MailboxListener({
  connection: { url: 'https://maryafox.ir:18443', token },
  since: () => cursor,
  fetcher: async (url) => new Response(JSON.stringify({
    messages: String(url).includes('since=8') ? [{ seq: 9, time: replay.time, id: 'r9', blob: 'UkVQTEFZ' }] : [],
    cursor: '9',
    more: false,
  })),
  createSocket: (url, headers) => {
    socketArgs = { url, headers };
    return socket;
  },
  onMessage: async (message, source) => {
    delivered.push(message);
    sources.push(source);
    cursor = String(message.seq);
  },
});
listener.start();
for (let i = 0; i < 20 && !socketArgs; i++) await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(delivered, [replay], 'HTTP replay runs before opening the live socket');
assert.deepEqual(sources, ['replay'], 'S10: a message found by the HTTP replay is marked replay (the system push already showed it)');
assert.equal(socketArgs.headers.Authorization, `Bearer ${token}`);
assert.ok(!socketArgs.url.includes(token));
assert.match(socketArgs.url, /wss:\/\/maryafox\.ir:18443\/api\/v1\/e2e\/ws\?since=9/);
// A frame on the open socket is marked live (S10: the app shows its own notification for it).
socket.onmessage({ data: JSON.stringify({ type: 'message', seq: 10, time: '2026-10-17T00:00:00.000Z', body: { id: 'l10', blob: 'TElWRQ' } }) });
for (let i = 0; i < 20 && delivered.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(sources, ['replay', 'live'], 'S10: a socket frame is marked live');
listener.stop();

// Stage 2B: the app keeps a single listener, on the encrypted queue; the plain mailbox route is not used anywhere
const clientSource = readFileSync(new URL('../src/partner/mailbox-client.ts', import.meta.url), 'utf8');
assert.doesNotMatch(clientSource, /'\/mailbox/, 'no plain mailbox route in the client');

// S11: a 401 / socket close 4401 keeps the pairing and the saved token (the screens show the "token not accepted" notice)
const manageSource = readFileSync(new URL('../src/partner/manage.ts', import.meta.url), 'utf8');
assert.doesNotMatch(manageSource, /'unauthorized'\)\s*void clearLocal\(\)/, 'the listener no longer wipes the pairing on 401');
for (const f of ['../app/(tabs)/status.tsx', '../app/settings/pair.tsx']) {
  assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /TokenNotAcceptedNotice/, `${f} shows the token notice`);
}

console.log('mailbox client tests ok');
