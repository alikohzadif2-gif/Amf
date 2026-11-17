// S2: connection test, error classification, server-code parsing and the S2 feature gating.
// Pure logic with stub fetchers; the real server is covered by test-live-server.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ServerClient } from '../src/server/client.ts';
import { ServerError } from '../src/server/errors.ts';
import { classifyFailure, testConnection } from '../src/server/test-connection.ts';
import { connectionMessageKey, featureLabelKey } from '../src/server/connection-text.ts';
import { buildQrServer, parseServerQr } from '../src/server/qr.ts';
import { isSourceActive } from '../src/storage/active.ts';
import { FEATURES } from '../src/constants/features.ts';
import { settingsSections } from '../src/constants/settings-sections.ts';

const json = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
const text = (status) => async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token <'); } });
const PING = { name: 'Home', version: '0.1.0', features: [] };
const ME = { deviceId: 'd1', role: 'owner', household: { partner: null }, features: [] };

/** Routes by path: { '/ping': fn, ... } where fn is a fetcher result factory. */
const routes = (map) => (input, init) => {
  const path = new URL(input).pathname.replace('/api/v1', '');
  const handler = map[path];
  if (!handler) return json(404, { error: 'not_found' })(input, init);
  return handler(input, init);
};
const ep = { url: 'https://meyou.example.com', token: 'tok' };

// ---- classification -----------------------------------------------------------
{
  const k = (kind, status = 0, message) => classifyFailure(new ServerError(kind, status, message));
  assert.equal(k('unauthorized', 401), 'unauthorized');
  assert.equal(k('timeout'), 'timeout');
  assert.equal(k('protocol', 200), 'not-meyou');
  assert.equal(k('network', 0, 'Network request failed'), 'unreachable');
  assert.equal(k('network', 0, 'javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found'), 'certificate');
  assert.equal(k('http', 429), 'busy');
  assert.equal(k('http', 404), 'not-meyou');
  assert.equal(k('http', 502), 'unreachable');
  assert.equal(k('http', 503), 'unreachable');
  assert.equal(k('http', 500), 'server-error');
  assert.equal(classifyFailure(new Error('x')), 'unreachable');
}

// ---- a healthy S1 server ------------------------------------------------------
{
  const ok = await testConnection(ep, routes({ '/ping': json(200, PING), '/me': json(200, ME) }));
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'ok');
  assert.equal(ok.issue, undefined);
  assert.equal('rootCount' in ok, false);
  assert.deepEqual(ok.ping, PING);
  assert.equal(ok.me.role, 'owner');
  assert.equal(connectionMessageKey(ok), 'testOk');

  // /me proves the token: a server that does not answer it is not a working connection.
  const noMe = await testConnection(ep, routes({ '/ping': json(200, PING) }));
  assert.equal(noMe.ok, false);
}

// ---- every failure has its own message ----------------------------------------
{
  const cases = [
    ['wrong token (me 401)', { '/ping': json(200, PING), '/me': json(401, { error: 'unauthorized' }) }, 'unauthorized', 'unauthorized', 'connUnauthorized'],
    ['html page instead of JSON', { '/ping': text(200) }, 'error', 'not-meyou', 'connNotMeyou'],
    ['json of another service', { '/ping': json(200, { hello: 'world' }) }, 'error', 'not-meyou', 'connNotMeyou'],
    ['features not an array', { '/ping': json(200, { name: 'x', version: '1', features: 'media' }) }, 'error', 'not-meyou', 'connNotMeyou'],
    ['ping 404 (some other web server)', {}, 'error', 'not-meyou', 'connNotMeyou'],
    ['rate limited', { '/ping': json(429, { error: 'rate_limited' }) }, 'error', 'busy', 'connBusy'],
    ['server error', { '/ping': json(200, PING), '/me': json(500, {}) }, 'error', 'server-error', 'connServerError'],
    ['bad gateway (caddy up, server down)', { '/ping': json(502, {}) }, 'unavailable', 'unreachable', 'connUnreachable'],
    ['me times out as a real failure', { '/ping': json(200, PING), '/me': json(500, {}) }, 'error', 'server-error', 'connServerError'],
  ];
  for (const [label, map, code, issue, key] of cases) {
    const r = await testConnection(ep, routes(map));
    assert.deepEqual([r.ok, r.code, r.issue, connectionMessageKey(r)], [false, code, issue, key], label);
  }

  // S11: `rate_limited` and `locked_out` are both 429 -> the same "busy" text + the retry-after seconds
  {
    const limited = (headers, body) => async () => ({ ok: false, status: 429, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body });
    const run = (handlers) => testConnection(ep, routes(handlers));
    const head = await run({ '/ping': limited({ 'retry-after': '90' }, { error: 'locked_out', retryAfter: 90 }) });
    assert.deepEqual([head.ok, head.code, head.issue, head.retryAfter, connectionMessageKey(head)], [false, 'error', 'busy', 90, 'connBusy'], 'locked_out with header');
    const body = await run({ '/ping': limited({}, { error: 'locked_out', retryAfter: 30 }) });
    assert.deepEqual([body.issue, body.retryAfter], ['busy', 30], 'seconds from the body when there is no header');
    const plain = await run({ '/ping': limited({}, { error: 'rate_limited' }) });
    assert.deepEqual([plain.issue, plain.retryAfter, connectionMessageKey(plain)], ['busy', undefined, 'connBusy'], 'rate_limited without seconds');
    const later = await run({ '/ping': json(200, PING), '/me': limited({ 'retry-after': '5' }, {}) });
    assert.deepEqual([later.issue, later.retryAfter], ['busy', 5], 'locked after ping');
    const bad = await run({ '/ping': limited({ 'retry-after': 'abc' }, { retryAfter: 'x' }) });
    assert.equal(bad.retryAfter, undefined, 'unusable seconds are dropped');
    const zero = await run({ '/ping': limited({ 'retry-after': '0' }, {}) });
    assert.equal(zero.retryAfter, undefined);
    const huge = await run({ '/ping': limited({ 'retry-after': '999999' }, {}) });
    assert.equal(huge.retryAfter, 86_400, 'clamped to one day');
    for (const lang of ['en', 'fa']) {
      const dict = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
      assert.match(dict.connBusyRetry, /\{seconds\}/, `${lang} connBusyRetry has the placeholder`);
      for (const key of ['connBusy', 'mailboxTokenNotAccepted', 'tokenNoticeOpen', 'serverRemoveBody', 'serverRemoveSourceBody']) assert.ok(dict[key]?.length > 10, `${lang} ${key}`);
      assert.match(dict.serverRemoveBody, lang === 'en' ? /never deletes/ : /هرگز/, `${lang}: remove text says photos on the server stay`);
      assert.match(dict.serverRemoveBody, lang === 'en' ? /new link/ : /لینک جدید/, `${lang}: remove text says a revoked token needs a new link`);
    }
  }

  const offline = await testConnection(ep, async () => { throw new TypeError('Network request failed'); });
  assert.deepEqual([offline.ok, offline.code, offline.issue], [false, 'unavailable', 'unreachable']);
  const cert = await testConnection(ep, async () => { throw new Error('java.security.cert.CertPathValidatorException'); });
  assert.equal(cert.issue, 'certificate');
  assert.equal(connectionMessageKey(cert), 'connCertificate');
  const slow = await testConnection(ep, () => new Promise(() => {}), 40);
  assert.deepEqual([slow.code, slow.issue, connectionMessageKey(slow)], ['unavailable', 'timeout', 'connTimeout']);
}

// ---- client details ------------------------------------------------------------
{
  const seen = [];
  const client = new ServerClient({ url: 'meyou.example.com/', token: 'tok' }, async (url, init) => {
    seen.push([url, init?.headers?.Authorization]);
    return json(200, PING)();
  });
  await client.ping();
  assert.equal(seen[0][0], 'http://meyou.example.com/api/v1/ping');
  assert.equal(seen[0][1], 'Bearer tok');
  assert.ok(!seen[0][0].includes('tok'), 'token never in the URL');
}

// ---- server codes (the link `meyou-server init` prints) -----------------------
{
  const link = 'meyou://server?url=https%3A%2F%2Fmeyou.example.com&token=AbC_-123&name=Our+Home';
  assert.deepEqual(parseServerQr(link), { url: 'https://meyou.example.com', token: 'AbC_-123', name: 'Our Home', fingerprint: undefined });
  assert.deepEqual(parseServerQr(`  ${link}\n`)?.url, 'https://meyou.example.com');
  assert.deepEqual(
    parseServerQr('{"url":"https://meyou.example.com","token":"AbC_-123","name":"Our Home"}'),
    { url: 'https://meyou.example.com', token: 'AbC_-123', name: 'Our Home', fingerprint: undefined },
  );
  assert.equal(parseServerQr('meyou://join?code=ABC'), null);
  assert.equal(parseServerQr('meyou://server?url=&token=x'), null);
  assert.equal(parseServerQr('https://meyou.example.com'), null);
  // Deep-link route builds the same value from route params.
  assert.deepEqual(buildQrServer('https://h.example', ' t ', 'N', undefined), { url: 'https://h.example', token: 't', name: 'N', fingerprint: undefined });
  assert.equal(buildQrServer(undefined, 't'), null);
  assert.equal(buildQrServer('https://h.example', ''), null);
}

// ---- features text -------------------------------------------------------------
{
  assert.equal(featureLabelKey('e2e'), 'featureE2e');
  assert.equal(featureLabelKey('mailbox'), null);
  assert.equal(featureLabelKey('push'), 'featurePush');
  assert.equal(featureLabelKey('something-new'), null);
}

// ---- gating: connect + partner yes; Drive, server Library and backup are gone -----
{
  assert.equal(FEATURES.server, true);
  assert.equal(FEATURES.partner, true);
  assert.equal('serverLibrary' in FEATURES || 'serverBackup' in FEATURES, false, 'the old library and backup flags are removed');
  assert.equal(isSourceActive({ id: 'local', kind: 'local', backend: 'real', enabled: true, builtIn: true }), true);
  assert.equal(isSourceActive({ id: 'l', kind: 'local', backend: 'real', enabled: false, builtIn: true }), false);

  const ids = settingsSections.map((s) => s.id);
  for (const shown of ['server-connection', 'sources-sync']) assert.ok(ids.includes(shown), `${shown} shown`);
  for (const gone of ['backup-restore', 'google-drive']) assert.ok(!ids.includes(gone), `${gone} is gone`);
  assert.ok(ids.includes('partner-notifications'), 'S8 partner-notifications is enabled');
}

console.log('server connection tests ok');
