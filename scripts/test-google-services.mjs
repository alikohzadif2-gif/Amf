import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_NAME, readGoogleServices } from './write-google-services.mjs';

const file = (pkg = PACKAGE_NAME) => ({
  project_info: { project_number: '123', project_id: 'meyou-test', storage_bucket: 'meyou-test.appspot.com' },
  client: [{ client_info: { mobilesdk_app_id: '1:123:android:abc', android_client_info: { package_name: pkg } }, api_key: [{ current_key: 'SECRET-API-KEY' }] }],
  configuration_version: '1',
});
const raw = JSON.stringify(file());
const b64 = Buffer.from(raw).toString('base64');

assert.equal(PACKAGE_NAME, JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo.android.package, 'the checked package is the one in app.json');

// base64 (also with line breaks), raw JSON
assert.equal(readGoogleServices(b64).ok, true);
assert.equal(readGoogleServices(`${b64.slice(0, 40)}\n${b64.slice(40)}\n`).ok, true);
assert.equal(readGoogleServices(raw).ok, true);
assert.equal(readGoogleServices(b64).json.project_info.project_id, 'meyou-test');

// Failures say what is wrong and never quote the secret.
for (const [value, pattern] of [
  [undefined, /missing or empty/],
  ['   ', /missing or empty/],
  ['not base64 or json !!!', /neither base64/],
  [Buffer.from('plain words, not json').toString('base64'), /neither base64/],
  [Buffer.from(JSON.stringify({ hello: 'world', secret: 'SECRET-API-KEY' })).toString('base64'), /does not look like google-services/],
  [Buffer.from(JSON.stringify(file('com.other.app'))).toString('base64'), /not for the package ir\.maryafox\.meyou/],
]) {
  const r = readGoogleServices(value);
  assert.equal(r.ok, false, String(value));
  assert.match(r.error, pattern);
  assert.ok(!r.error.includes('SECRET-API-KEY'));
}

// The script as the workflow runs it: writes the file, exits 1 without a usable secret, prints no content.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsj-'));
try {
  const out = path.join(dir, 'google-services.json');
  const script = new URL('./write-google-services.mjs', import.meta.url).pathname;
  const okRun = spawnSync(process.execPath, [script, out], { env: { ...process.env, GOOGLE_SERVICES_JSON: b64 }, encoding: 'utf8' });
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).client[0].client_info.android_client_info.package_name, PACKAGE_NAME);
  assert.ok(!okRun.stdout.includes('SECRET-API-KEY') && !okRun.stderr.includes('SECRET-API-KEY'));
  fs.rmSync(out);
  const bad = spawnSync(process.execPath, [script, out], { env: { ...process.env, GOOGLE_SERVICES_JSON: '' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /::error::the secret GOOGLE_SERVICES_JSON is missing/);
  assert.equal(fs.existsSync(out), false, 'nothing is written on failure');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('google-services tests ok');
