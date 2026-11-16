// S10 part 2: the foreground service is gone for good. Static checks over the source tree.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');

assert.equal(existsSync(join(root, 'src/partner/background-service.ts')), false, 'background-service.ts is deleted');

const pkg = JSON.parse(read('package.json'));
for (const field of ['dependencies', 'devDependencies']) assert.equal(pkg[field]['react-native-notify-kit'], undefined, `no notify-kit in ${field}`);
for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'app.json']) assert.ok(!/notify-?kit|notifee/i.test(read(file)), `${file} does not mention notify-kit`);

assert.ok(!/registerBackgroundRunner|background-service/.test(read('index.ts')), 'index.ts registers no background runner');

const SKIP = new Set(['node_modules', '.git', '.expo', 'dist', 'android', 'docs', 'server']);
const hits = [];
function walk(dir) {
  for (const name of readdirSync(join(root, dir))) {
    if (SKIP.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) walk(rel);
    else if (/\.(ts|tsx|json|mjs|js)$/.test(name) && rel !== 'scripts/test-no-foreground-service.mjs' && rel !== 'pnpm-lock.yaml') {
      const text = readFileSync(full, 'utf8');
      if (/notifyBackground|bgService|batteryOptimization|react-native-notify-kit|startBackgroundService|stopBackgroundService|openBatterySettings|asForegroundService|FOREGROUND_SERVICE/.test(text)) hits.push(rel);
    }
  }
}
walk('');
assert.deepEqual(hits, [], 'no leftovers of the foreground service, its setting or its strings');

// fa and en stay in sync (the i18n suite also checks parity); the new push-state strings exist in both.
for (const lang of ['fa', 'en']) {
  const dict = JSON.parse(read(`src/i18n/locales/${lang}.json`));
  for (const key of ['pushStateTitle', 'pushStateRegistered', 'pushStateNoPermission', 'pushStateUnavailable', 'pushStateServerNoPush', 'pushStateFailed', 'pushStateUnknown', 'pushRetry', 'pushRetryDesc', 'pushBatteryHint']) {
    assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${lang}.${key}`);
  }
}

// The tap/foreground wiring exists (cold start + warm tap + foreground handler), without a test-push action.
const native = read('src/partner/push-native.ts');
for (const api of ['getLastNotificationResponseAsync', 'addNotificationResponseReceivedListener', 'setNotificationHandler', 'addNotificationReceivedListener']) assert.ok(native.includes(api), api);
assert.ok(!/testPush|sendTestPush|push\/test/i.test(read('src/settings/sections/PartnerNotificationsSection.tsx')), 'no server test-push action (the server has none)');

console.log('no foreground service tests ok');
