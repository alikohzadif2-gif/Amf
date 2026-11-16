import assert from 'node:assert/strict';
import {
  createPushRouter,
  foregroundDecision,
  parsePushData,
  settleWithin,
  shouldNotifyLocal,
} from '../src/partner/push-events.ts';

// --- parsePushData: only the server's shape { type, seq } (API_CONTRACT D.11) ---
assert.deepEqual(parsePushData({ type: 'mood', seq: '12' }), { type: 'mood', seq: '12' });
assert.deepEqual(parsePushData({ type: 'event', seq: '1' }), { type: 'event', seq: '1' });
assert.deepEqual(parsePushData({ type: 'profile', seq: '7' }), { type: 'profile', seq: '7' });
assert.deepEqual(parsePushData({ type: 'unpair', seq: '7' }), { type: 'unpair', seq: '7' });
assert.deepEqual(parsePushData({ type: 'test', seq: '0' }), { type: 'test', seq: '0' });
assert.deepEqual(parsePushData({ type: 'diary', seq: '9' }), { type: 'diary', seq: '9' }, 'R1b: diary pushes (API_CONTRACT D.11)');
assert.deepEqual(parsePushData({ type: 'period', seq: '10' }), { type: 'period', seq: '10' }, 'R1b: period pushes');
assert.deepEqual(parsePushData({ type: 'mood', seq: 5 }), { type: 'mood', seq: '5' }, 'a number seq is tolerated');
for (const bad of [null, undefined, 'x', 5, [], {}, { type: 'mood' }, { seq: '1' }, { type: 'other', seq: '1' }, { type: 'mood', seq: 'abc' }, { type: 'mood', seq: '-1' }, { type: 'mood', seq: '' }, { type: 'mood', seq: '1'.repeat(30) }, { type: 7, seq: '1' }, { type: 'mood', seq: 1.5 }]) {
  assert.equal(parsePushData(bad), null, JSON.stringify(bad));
}
assert.deepEqual(parsePushData({ type: 'mood', seq: '3', title: 'x', extra: 1 }), { type: 'mood', seq: '3' }, 'extra keys are ignored, never trusted');

// --- foreground behaviour ---
assert.deepEqual(foregroundDecision(null), { show: true, sync: false }, 'the app\'s own local notification shows');
assert.deepEqual(foregroundDecision({ type: 'test', seq: '0' }), { show: true, sync: false }, 'the CLI test push shows as it is');
for (const type of ['mood', 'event', 'diary', 'period']) assert.deepEqual(foregroundDecision({ type, seq: '1' }), { show: false, sync: true }, `${type}: sync, app shows its own single notification`);
for (const type of ['profile', 'unpair']) assert.deepEqual(foregroundDecision({ type, seq: '1' }), { show: false, sync: true }, `${type}: data-only, sync, show nothing`);

// --- no double notifications ---
const base = { kind: 'mood', source: 'replay', pushRegistered: true, heldByForegroundHandler: false };
assert.equal(shouldNotifyLocal(base), false, 'replayed after a push: the system already showed it');
assert.equal(shouldNotifyLocal({ ...base, kind: 'event' }), false, 'same for events');
assert.equal(shouldNotifyLocal({ ...base, source: 'live' }), true, 'live on the open socket: the push was held back, show the app\'s one');
assert.equal(shouldNotifyLocal({ ...base, pushRegistered: false }), true, 'no working push: the app must notify itself');
assert.equal(shouldNotifyLocal({ ...base, heldByForegroundHandler: true }), true, 'push held back while the app was open: show the app\'s one');
assert.equal(shouldNotifyLocal({ ...base, kind: 'unpair' }), true, 'unpair is data-only: the system never shows it');
assert.equal(shouldNotifyLocal({ ...base, kind: 'unpair', source: 'live' }), true);

// --- router: every event runs one sync ---
{
  let syncs = 0;
  const router = createPushRouter({ sync: () => { syncs += 1; } });
  router.onPush({ type: 'mood', seq: '5' });
  router.onPush({ type: 'mood', seq: '5' }); // the handler and the received listener both report it
  assert.equal(syncs, 1, 'the same push syncs once');
  assert.equal(router.wasHeld('5'), true, 'mood is remembered as held back');
  assert.equal(router.wasHeld('6'), false);
  router.onPush({ type: 'event', seq: '6' });
  assert.equal(syncs, 2);
  assert.equal(router.wasHeld('6'), true);
  router.onPush({ type: 'diary', seq: '20' });
  router.onPush({ type: 'period', seq: '21' });
  assert.equal(syncs, 4);
  assert.equal(router.wasHeld('20') && router.wasHeld('21'), true, 'diary/period are visible pushes: held back like mood/event');
  syncs -= 2;
  router.onPush({ type: 'profile', seq: '7' });
  router.onPush({ type: 'unpair', seq: '8' });
  assert.equal(syncs, 4, 'profile/unpair trigger a sync');
  assert.equal(router.wasHeld('7'), false, 'profile/unpair are never held: they show nothing anyway');
  assert.equal(router.wasHeld('8'), false);
  router.onPush({ type: 'test', seq: '0' });
  assert.equal(syncs, 4, 'a test push only shows, nothing to sync');
  // A mood and an event may carry the same seq text in different types: both count.
  router.onPush({ type: 'event', seq: '5' });
  assert.equal(syncs, 5);
  // Taps: a notification tap syncs once, also when the cold-start response is read again after a remount.
  router.onTap('notif-a');
  router.onTap('notif-a');
  assert.equal(syncs, 6);
  router.onTap('notif-b');
  assert.equal(syncs, 7);
}
{
  // Memory stays bounded for a long-running app.
  let syncs = 0;
  const router = createPushRouter({ sync: () => { syncs += 1; } });
  for (let i = 1; i <= 500; i += 1) router.onPush({ type: 'mood', seq: String(i) });
  assert.equal(syncs, 500);
  assert.equal(router.wasHeld('1'), false, 'the oldest entries were forgotten');
  assert.equal(router.wasHeld('500'), true);
}

// --- settleWithin ---
assert.equal(await settleWithin(Promise.resolve('a'), 50, 'x'), 'a');
assert.equal(await settleWithin(new Promise(() => {}), 20, 'timeout'), 'timeout', 'a hung registration cannot block the listener');
assert.equal(await settleWithin(Promise.reject(new Error('boom')), 50, 'fallback'), 'fallback', 'never rejects');

console.log('push events tests ok');
