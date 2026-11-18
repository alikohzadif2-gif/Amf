// S2 + stage 2B: the app's connection code, invite/join and the ENCRYPTED queue (`/e2e/queue`, `/e2e/ws`) against the REAL server
// from server/meyou-server. Starts it on a free local port with a temporary data folder. Skipped (exit 0) when the server
// package has no node_modules (run `npm ci` in server/meyou-server first).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ServerClient } from '../src/server/client.ts';
import { parseServerQr } from '../src/server/qr.ts';
import { connectionMessageKey } from '../src/server/connection-text.ts';
import { testConnection } from '../src/server/test-connection.ts';
import { MailboxClient, MailboxListener, joinMailbox } from '../src/partner/mailbox-client.ts';

const serverDir = path.resolve(new URL('../server/meyou-server', import.meta.url).pathname);
if (!fs.existsSync(path.join(serverDir, 'node_modules', 'tsx'))) {
  console.log('live server test skipped: run "npm ci" in server/meyou-server to enable it');
  process.exit(0);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

const children = [];
const dirs = [];
const logs = [];

function cli(args, env) {
  return { cmd: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', ...args], opts: { cwd: serverDir, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } } };
}

async function startServer(extraEnv = {}, { init = true } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-live-'));
  dirs.push(dataDir);
  const url = `http://127.0.0.1:${port}`;
  const env = { DATA_DIR: dataDir, DOMAIN: 'localhost', PUBLIC_URL: url, PORT: String(port), HOST: '127.0.0.1', SERVER_NAME: 'Live Home', ...extraEnv };
  let link = null;
  if (init) {
    const c = cli(['init'], env);
    const r = spawnSync(c.cmd, c.args, { ...c.opts, encoding: 'utf8' });
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    link = /^(meyou:\/\/server\?\S+)$/m.exec(r.stdout)?.[1] ?? null;
    assert.ok(link, 'init printed a link');
  }
  const c = cli(['serve'], env);
  const child = spawn(c.cmd, c.args, c.opts);
  children.push(child);
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/api/v1/ping`);
      if (res.status === 200 || res.status === 429) return { url, link, dataDir };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
}

function startPlainServer(status, body, contentType) {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

try {
  const real = await startServer();
  const code = parseServerQr(real.link);
  assert.ok(code, 'the link printed by init is accepted by the app');
  assert.equal(code.url, real.url);
  assert.equal(code.name, 'Live Home');
  assert.ok(code.token.length >= 40);

  // 1. Connect with the token from the link
  const ok = await testConnection({ url: code.url, token: code.token });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.code, 'ok');
  assert.equal(ok.ping.name, 'Live Home');
  assert.ok(ok.ping.features.includes('e2e'), 'the encrypted queue is announced'); // the app needs only this feature
  assert.equal(ok.me.role, 'owner');
  assert.deepEqual(ok.me.household, { partner: null });
  assert.ok(ok.me.features.includes('e2e'));
  assert.equal(connectionMessageKey(ok), 'testOk');

  // 2. The client asks who it is
  const client = new ServerClient({ url: code.url, token: code.token });
  assert.equal((await client.me()).role, 'owner');

  // 3. Wrong token: ping (public) works, the token check fails with its own message
  const wrong = await testConnection({ url: code.url, token: 'x'.repeat(43) });
  assert.deepEqual([wrong.ok, wrong.issue, connectionMessageKey(wrong)], [false, 'unauthorized', 'connUnauthorized']);
  const empty = await testConnection({ url: code.url, token: 'short' });
  assert.equal(empty.issue, 'unauthorized');

  // 4. Nobody home / not a meYou server
  const closed = await testConnection({ url: `http://127.0.0.1:${await freePort()}`, token: code.token }, undefined, 3000);
  assert.deepEqual([closed.code, closed.issue, connectionMessageKey(closed)], ['unavailable', 'unreachable', 'connUnreachable']);
  const html = await startPlainServer(200, '<html>hello</html>', 'text/html');
  const notMe = await testConnection({ url: html.url, token: code.token });
  assert.deepEqual([notMe.ok, notMe.issue], [false, 'not-meyou']);
  html.close();
  const missing = await startPlainServer(404, 'nope', 'text/plain');
  assert.equal((await testConnection({ url: missing.url, token: code.token })).issue, 'not-meyou');
  missing.close();

  // 5. Trailing slash / no scheme in what the person typed
  const typed = await testConnection({ url: `${real.url.replace('http://', '')}/`, token: code.token });
  assert.equal(typed.ok, true);

  // 6. Rate limiting is reported as "busy", not as a broken server
  // The start-up readiness poll uses one of the allowed public requests, so allow 3: poll, a, b pass; c is limited.
  const limited = await startServer({ PUBLIC_RATE_LIMIT_MAX: '3' }, { init: false });
  const a = await testConnection({ url: limited.url, token: 'x'.repeat(43) });
  const b = await testConnection({ url: limited.url, token: 'x'.repeat(43) });
  const c = await testConnection({ url: limited.url, token: 'x'.repeat(43) });
  assert.ok(![a, b].some((r) => r.issue === 'busy'));
  assert.deepEqual([c.ok, c.issue, connectionMessageKey(c)], [false, 'busy', 'connBusy']);

  // 7. Two instances of the app's client and listener: invite -> join -> sealed blobs both ways (live + HTTP replay + ack) ->
  //    revoke -> third device refused. The server only ever sees opaque `{ id, blob }` pairs.
  {
    const WS = createRequire(path.join(serverDir, 'package.json'))('ws');
    const owner = code.token;
    const ownerConnection = { url: real.url, token: owner };
    const ownerClient = new MailboxClient(ownerConnection);
    const ownerMe = await ownerClient.me();
    const inv = await ownerClient.createInvite();
    const link = new URL(inv.link);
    assert.equal(link.protocol, 'meyou:');
    assert.equal(link.host, 'join');
    assert.equal(link.searchParams.get('url'), real.url);
    assert.equal(link.searchParams.get('code'), inv.code);
    const joined = await joinMailbox(real.url, link.searchParams.get('code'), 'Partner phone');
    const memberConnection = { url: real.url, token: joined.token };
    const memberClient = new MailboxClient(memberConnection);
    const memberMe = await memberClient.me();
    assert.equal(memberMe.household.partner.deviceId, ownerMe.deviceId);

    assert.equal((await assert.rejects(joinMailbox(real.url, inv.code, 'Again'), (e) => e.kind === 'http' && e.status === 400)), undefined, 'invite codes are single-use');

    const waitFor = async (condition, details) => {
      for (let i = 0; i < 120 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(condition(), details);
    };
    const ownerCursor = { value: '0' };
    const memberCursor = { value: '0' };
    const ownerMessages = [];
    const memberMessages = [];
    const ownerStates = [];
    const memberStates = [];
    const socketFactory = (url, headers) => new WS(url, { headers });
    const makeListener = (connection, cursor, messages, states) =>
      new MailboxListener({
        connection,
        since: () => cursor.value,
        createSocket: socketFactory,
        retryMs: { min: 10, max: 50 },
        onState: (state) => states.push(state),
        onMessage: async (message) => {
          messages.push(message);
          cursor.value = String(message.seq);
        },
      });
    const ownerListener = makeListener(ownerConnection, ownerCursor, ownerMessages, ownerStates);
    const memberListener = makeListener(memberConnection, memberCursor, memberMessages, memberStates);
    ownerListener.start();
    memberListener.start();
    await waitFor(() => ownerStates.includes('connected') && memberStates.includes('connected'), 'both application WebSocket listeners connected');

    const blob = (text) => Buffer.from(text).toString('base64url');
    const mood = await ownerClient.e2ePost('id-mood-0001', blob('sealed mood'), false);
    await waitFor(() => memberMessages.some((message) => message.seq === mood.seq), 'member receives the sealed message live');
    assert.deepEqual(memberMessages.find((m) => m.seq === mood.seq).body, { id: 'id-mood-0001', blob: blob('sealed mood') });
    assert.equal(ownerMessages.length, 0, 'sender does not receive its own message');
    assert.equal((await ownerClient.e2ePost('id-mood-0001', blob('sealed mood'), false)).duplicate, true, 'the same id is stored once');

    // Stop one listener while a message is stored, then reconnect: the listener must replay by seq.
    memberListener.stop();
    const profile = await ownerClient.e2ePost('id-prof-0002', blob('sealed profile'), false);
    memberListener.start();
    await waitFor(() => memberMessages.some((message) => message.seq === profile.seq), 'member listener replays a missed row after reconnect');

    const event = await memberClient.e2ePost('id-evnt-0003', blob('sealed event'), false);
    await waitFor(() => ownerMessages.some((message) => message.seq === event.seq), 'owner receives the sealed event live');
    assert.equal(memberMessages.some((message) => message.seq === event.seq), false, 'member does not receive its own message');
    const ownerPage = await ownerClient.e2eList('0');
    const memberPage = await memberClient.e2eList('0');
    assert.deepEqual(ownerPage.messages.map((message) => message.id), ['id-evnt-0003']);
    assert.deepEqual(memberPage.messages.map((message) => message.id), ['id-mood-0001', 'id-prof-0002']);
    assert.equal((await memberClient.e2eAck(memberPage.messages.map((m) => m.seq))).deleted, 2, 'an ack deletes what was applied');
    assert.equal((await memberClient.e2eList('0')).messages.length, 0);

    const unpair = await ownerClient.e2ePost('id-unpr-0004', blob('sealed unpair'), false);
    await waitFor(() => memberMessages.some((message) => message.seq === unpair.seq), 'partner receives the last message before revocation');
    await ownerClient.revoke(memberMe.deviceId);
    // The E2E queue closes the sockets of a revoked device in its 30 s sweep (server 2C may close them at once); the REST side refuses at once.
    await assert.rejects(memberClient.e2eList('0'), (error) => error.kind === 'unauthorized');
    await assert.rejects(memberClient.me(), (error) => error.kind === 'unauthorized');

    ownerListener.stop();
    memberListener.stop();
    const newInvite = await ownerClient.createInvite();
    const second = await joinMailbox(real.url, new URL(newInvite.link).searchParams.get('code'), 'Second phone');
    await assert.rejects(ownerClient.createInvite(), (error) => error.kind === 'http' && error.errorKey === 'household_full');
    assert.ok(second.token);
  }

  // 9. The token never reaches the server log
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('').includes(code.token), 'token not in server logs');

  console.log('live server tests ok');
} finally {
  for (const child of children) child.kill();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
