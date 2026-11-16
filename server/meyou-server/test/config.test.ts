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

test('R1a PUSH_PERIOD_DETAIL: off by default, true/false accepted, anything else is refused', () => {
  assert.equal(loadConfig({}).pushPeriodDetail, false);
  assert.equal(loadConfig({ PUSH_PERIOD_DETAIL: 'true' }).pushPeriodDetail, true);
  assert.equal(loadConfig({ PUSH_PERIOD_DETAIL: 'false' }).pushPeriodDetail, false);
  assert.throws(() => loadConfig({ PUSH_PERIOD_DETAIL: 'maybe' }), ConfigError);
});
