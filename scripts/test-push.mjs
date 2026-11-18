import assert from 'node:assert/strict';
import { MailboxClient } from '../src/partner/mailbox-client.ts';
import { OLD_CHANNELS, PUSH_CHANNEL, isUsableToken, registerPush, unregisterPush } from '../src/partner/push.ts';

const TOKEN = `fcm:${'A'.repeat(100)}`;

function deps(over = {}) {
  const calls = { me: 0, register: [] };
  const d = {
    client: {
      me: async () => {
        calls.me += 1;
        return { deviceId: 'd', role: 'owner', household: { partner: null }, features: ['media', 'upload', 'mailbox', 'push'] };
      },
      registerPushToken: async (token, lang, notify) => {
        calls.register.push({ token, lang, notify });
        return { registered: true };
      },
    },
    language: 'fa',
    notify: { mood: true, event: true, diary: true, period: true },
    permission: async () => 'granted',
    getToken: async () => TOKEN,
    ...over,
  };
  return { d, calls };
}

assert.equal(PUSH_CHANNEL, 'meyou-partner-v2', 'the channel id must match what the server sends (API_CONTRACT D.11, R1a)');
assert.deepEqual([...OLD_CHANNELS], ['meyou-partner', 'partner'], 'the channels of earlier versions are deleted');
assert.ok(!OLD_CHANNELS.includes(PUSH_CHANNEL));

// Token shape = what the server accepts.
assert.equal(isUsableToken(TOKEN), true);
for (const bad of ['', 'short', `${TOKEN} space`, 'x'.repeat(5000), null, undefined, 12, `${TOKEN}\n`]) assert.equal(isUsableToken(bad), false, String(bad));

// Success: token and language reach the server.
{
  const { d, calls } = deps();
  assert.equal(await registerPush(d), 'registered');
  assert.deepEqual(calls.register, [{ token: TOKEN, lang: 'fa', notify: { mood: true, event: true, diary: true, period: true } }]);
  assert.equal(await registerPush({ ...d, language: 'en' }), 'registered');
  assert.equal(calls.register.at(-1).lang, 'en');
}

// S11: the Settings switches travel with the registration (a switched-off type is skipped by the server).
{
  const { d, calls } = deps({ notify: { mood: false, event: true, diary: false, period: true } });
  assert.equal(await registerPush(d), 'registered');
  assert.deepEqual(calls.register[0].notify, { mood: false, event: true, diary: false, period: true });
}

// Local problems never touch the network.
for (const [permission, expected] of [['denied', 'no-permission'], ['unavailable', 'unavailable']]) {
  const { d, calls } = deps({ permission: async () => permission });
  assert.equal(await registerPush(d), expected);
  assert.equal(calls.me, 0);
  assert.equal(calls.register.length, 0);
}
for (const getToken of [async () => null, async () => 'short', async () => { throw new Error('no google services'); }]) {
  const { d, calls } = deps({ getToken });
  assert.equal(await registerPush(d), 'unavailable');
  assert.equal(calls.me, 0);
}
{
  const { d } = deps({ permission: async () => { throw new Error('boom'); } });
  assert.equal(await registerPush(d), 'unavailable', 'a throwing permission check is "unavailable", never an exception');
}

// The server without a Firebase key does not announce push: nothing is registered.
{
  const { d, calls } = deps();
  d.client.me = async () => ({ deviceId: 'd', role: 'owner', household: { partner: null }, features: ['media', 'upload', 'mailbox'] });
  assert.equal(await registerPush(d), 'server-no-push');
  assert.equal(calls.register.length, 0);
}

// Network / server errors end as "failed" (never thrown), for both calls.
{
  const { d } = deps();
  d.client.me = async () => { throw new Error('offline'); };
  assert.equal(await registerPush(d), 'failed');
}
{
  const { d } = deps();
  d.client.registerPushToken = async () => { throw new Error('HTTP 400'); };
  assert.equal(await registerPush(d), 'failed');
}

// unregisterPush is best effort.
assert.equal(await unregisterPush({ removePushToken: async () => ({ removed: true }) }), true);
assert.equal(await unregisterPush({ removePushToken: async () => { throw new Error('offline'); } }), false);

// The real client sends what the server expects (API_CONTRACT D.11).
{
  const seen = [];
  const secret = 'member-token-secret';
  const client = new MailboxClient({ url: 'https://maryafox.ir:18443/', token: secret }, async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(init.method === 'PUT' ? { registered: true } : { removed: true }));
  });
  assert.deepEqual(await client.registerPushToken(TOKEN, 'fa'), { registered: true });
  assert.deepEqual(await client.removePushToken(), { removed: true });
  assert.equal(seen[0].url, 'https://maryafox.ir:18443/api/v1/push/token');
  assert.equal(seen[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[0].init.body), { fcmToken: TOKEN, lang: 'fa' }, 'no notify argument = body as before S11');
  await client.registerPushToken(TOKEN, 'en', { mood: false, event: true, diary: true, period: false });
  assert.deepEqual(JSON.parse(seen[2].init.body), { fcmToken: TOKEN, lang: 'en', notify: { mood: false, event: true, diary: true, period: false } });
  assert.equal(seen[2].init.method, 'PUT');
  seen.length = 2;
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
  assert.equal(seen[1].url, 'https://maryafox.ir:18443/api/v1/push/token');
  assert.equal(seen[1].init.method, 'DELETE');
  assert.equal(seen[1].init.body, undefined);
  assert.ok(seen.every(({ url }) => !url.includes(secret) && !url.includes(TOKEN)), 'neither secret goes into a URL');
}

// S11 wiring (source level): the saved switches are read when registering, and a later change re-registers.
{
  const { readFileSync } = await import('node:fs');
  const manage = readFileSync('src/partner/manage.ts', 'utf8');
  assert.match(manage, /notify:\s*\{\s*mood:\s*settings\.notifyMood,\s*event:\s*settings\.notifyEvent,\s*diary:\s*settings\.notifyDiary,\s*period:\s*settings\.notifyPeriod\s*\}/);
  const listener = readFileSync('components/partner/PartnerListener.tsx', 'utf8');
  assert.match(listener, /useSettingsStore\(\(s\) => s\.notifyMood\)/);
  assert.match(listener, /useSettingsStore\(\(s\) => s\.notifyEvent\)/);
  assert.match(listener, /useSettingsStore\(\(s\) => s\.notifyDiary\)/);
  assert.match(listener, /useSettingsStore\(\(s\) => s\.notifyPeriod\)/);
  assert.match(listener, /\[paired, notifyMood, notifyEvent, notifyDiary, notifyPeriod\]/);
}

// R1b: channel v2 everywhere (app code, app.json default channel, server) and it is created with importance HIGH + sound.
{
  const { readFileSync } = await import('node:fs');
  const appJson = JSON.parse(readFileSync('app.json', 'utf8'));
  const plugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-notifications');
  assert.equal(plugin[1].defaultChannel, PUSH_CHANNEL, 'app.json default channel = the v2 channel');
  const server = readFileSync('server/meyou-server/src/push/messages.ts', 'utf8');
  assert.ok(server.includes(`'${PUSH_CHANNEL}'`), 'the server sends the same channel id');
  const native = readFileSync('src/partner/push-native.ts', 'utf8');
  assert.match(native, /setNotificationChannelAsync\(PUSH_CHANNEL,[^)]*AndroidImportance\.HIGH[^)]*sound: 'default'/);
  assert.match(native, /deleteNotificationChannelAsync\(old\)/);
  const notify = readFileSync('src/partner/notify.ts', 'utf8');
  assert.match(notify, /channelId: PUSH_CHANNEL/);
  assert.ok(!/setNotificationChannelAsync/.test(notify), 'one place creates the channel');
}

console.log('push tests ok');
