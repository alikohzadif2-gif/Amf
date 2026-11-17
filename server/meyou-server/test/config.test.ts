import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.serverName, 'meYou');
  assert.equal(c.port, 8080);
  assert.equal(c.trustProxy, false);
  assert.equal(c.domain, null);
  assert.equal(c.publicUrl, null);
});

test('domain builds the https public URL; PUBLIC_URL overrides it', () => {
  assert.equal(loadConfig({ DOMAIN: 'Meyou.Example.com' }).publicUrl, 'https://meyou.example.com');
  assert.equal(loadConfig({ DOMAIN: 'a.b', PUBLIC_URL: 'http://10.0.0.5:8080/' }).publicUrl, 'http://10.0.0.5:8080');
});

test('a domain with a custom HTTPS port and an empty PUBLIC_URL (as docker-compose passes it)', () => {
  assert.equal(loadConfig({ DOMAIN: 'maryafox.ir', PUBLIC_URL: 'https://maryafox.ir:8443' }).publicUrl, 'https://maryafox.ir:8443');
  assert.equal(loadConfig({ DOMAIN: 'maryafox.ir:8443' }).publicUrl, 'https://maryafox.ir:8443');
  assert.equal(loadConfig({ DOMAIN: 'maryafox.ir', PUBLIC_URL: '' }).publicUrl, 'https://maryafox.ir');
});

test('bad values are rejected with a clear error', () => {
  assert.throws(() => loadConfig({ DOMAIN: 'https://x.com' }), ConfigError);
  assert.throws(() => loadConfig({ DOMAIN: 'x.com/path' }), ConfigError);
  assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), ConfigError);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'ftp://x.com' }), ConfigError);
});

test('2.0: queue rate limit default is 1200/min (env name MAILBOX_RATE_LIMIT_MAX kept), blob cap stays under 1 MB + 1 KB, 1.x media/upload settings are gone', () => {
  const c = loadConfig({});
  assert.equal(c.queueRateLimitMax, 1200);
  assert.equal(loadConfig({ MAILBOX_RATE_LIMIT_MAX: '3000' }).queueRateLimitMax, 3000);
  assert.equal(c.e2eMaxBlobBytes, 1024 * 1024);
  assert.equal(c.e2eMaxQueueBytes, 256 * 1024 * 1024);
  // Old .env files still carry these names: they are simply ignored (no error).
  const old = loadConfig({ SCAN_INTERVAL_SECONDS: '300', UPLOAD_MAX_FILE_MB: '20480', MEDIA_RATE_LIMIT_MAX: '6000', MAILBOX_RETENTION_DAYS: '30' });
  for (const gone of ['scanIntervalSeconds', 'uploadMaxFileBytes', 'mediaRateLimitMax', 'mailboxRetentionDays', 'mailboxMaxMessages', 'uploadRateLimitMax']) {
    assert.equal(gone in old, false, gone);
  }
});
