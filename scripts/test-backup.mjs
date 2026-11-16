// S6: backup rules without any network: constraints, album choice, folder naming, the queue's
// waiting / pause / backoff behaviour. (The real-server round trip is in test-live-server.mjs.)
import assert from 'node:assert/strict';
import { backupBlocker, isUnmeteredType, LOW_BATTERY_LEVEL } from '../src/backup/constraints.ts';
import { dateFolder, isCameraAlbum, pickAlbums, scanNewMedia, uploadMtime } from '../src/backup/backup-new.ts';
import { createUploadQueue, errorCode, isTransientCode } from '../src/backup/queue.ts';
import { backupMessage, uploadErrorKey, waitingKey } from '../src/backup/messages.ts';
import { ServerError } from '../src/server/errors.ts';
import { dirId, parseDirId } from '../src/server/ids.ts';
import { readFileSync } from 'node:fs';
import { baseName, eventKey, mediaMark, memoryKey, mergePlans, planArchiveBackup, planDataBackup, photoKey } from '../src/backup/data-backup.ts';
import { dayFolderLocal, dayFolderUtc, localDayString, memoryDateFromDay, versionStamp } from '../src/backup/day-folder.ts';
import { isGalleryJob } from '../src/backup/reset-logic.ts';

const noSleep = async () => {};
const ok = { connected: true, unmetered: true, batteryLevel: 0.8, charging: false };

// ---- constraints ----------------------------------------------------------------
{
  const both = { wifiOnly: true, chargingOnly: false };
  assert.equal(backupBlocker(ok, both), null);
  assert.equal(backupBlocker({ ...ok, connected: false }, both), 'no-network');
  assert.equal(backupBlocker({ ...ok, unmetered: false }, both), 'no-wifi');
  assert.equal(backupBlocker({ ...ok, unmetered: false }, { wifiOnly: false, chargingOnly: false }), null, 'mobile data allowed when the switch is off');
  assert.equal(backupBlocker(ok, { wifiOnly: true, chargingOnly: true }), 'not-charging');
  assert.equal(backupBlocker({ ...ok, charging: true }, { wifiOnly: true, chargingOnly: true }), null);
  assert.equal(backupBlocker({ ...ok, batteryLevel: LOW_BATTERY_LEVEL - 0.01 }, both), 'low-battery');
  assert.equal(backupBlocker({ ...ok, batteryLevel: 0.05, charging: true }, both), null, 'low battery on the charger is fine');
  assert.equal(backupBlocker({ ...ok, batteryLevel: null, charging: null }, both), null, 'unknown battery never blocks');
  assert.equal(backupBlocker({ ...ok, connected: false, unmetered: false }, both), 'no-network', 'no network wins');
  assert.ok(isUnmeteredType('WIFI') && isUnmeteredType('ETHERNET') && !isUnmeteredType('CELLULAR') && !isUnmeteredType(undefined));
}

// ---- folders, dates, album choice ------------------------------------------------
{
  assert.equal(dateFolder('2026-02-15T12:00:00.000Z'), '2026/02');
  assert.equal(dateFolder('1970-01-01T00:00:00.000Z'), 'undated');
  assert.equal(dateFolder('nonsense'), 'undated');
  const now = new Date('2026-10-17T10:00:00.000Z');
  assert.equal(uploadMtime('2026-02-15T12:00:00.000Z', now), '2026-02-15T12:00:00.000Z');
  assert.equal(uploadMtime('2030-01-01T00:00:00.000Z', now), now.toISOString(), 'never in the future (the server refuses that)');
  assert.equal(uploadMtime('1970-01-01T00:00:00.000Z', now), undefined);
  assert.ok(isCameraAlbum('Camera') && isCameraAlbum(' DCIM ') && isCameraAlbum('دوربین') && !isCameraAlbum('Screenshots'));

  const dir = (id, name) => ({ id, parentId: null, name, type: 'dir', size: 0, mtime: new Date(0).toISOString() });
  const roots = [dir('fs:library', 'meYou'), dir('ml:album:1', 'Camera'), dir('ml:album:2', 'WhatsApp Images'), dir('ml:album:3', 'Screenshots')];
  const choice = (scope, albums = []) => ({ photos: true, videos: true, scope, albums });
  assert.deepEqual(pickAlbums(roots, choice('camera')).map((a) => a.id), ['ml:album:1']);
  assert.deepEqual(pickAlbums(roots, choice('all')).map((a) => a.id), ['ml:album:1', 'ml:album:2', 'ml:album:3'], 'the app library is never an album');
  assert.deepEqual(pickAlbums(roots, choice('selected', ['ml:album:3', 'fs:library', 'ml:album:9'])).map((a) => a.id), ['ml:album:3']);
  assert.deepEqual(pickAlbums(roots, choice('selected')), []);
}

// ---- scan: choice, folders, mtime, unreadable --------------------------------------
{
  const dir = (id, name) => ({ id, parentId: null, name, type: 'dir', size: 0, mtime: new Date(0).toISOString() });
  const file = (id, parentId, name, type, mtime) => ({ id, parentId, name, type, size: 0, mtime });
  const pages = {
    'ml:album:1': [
      file('ml:asset:1', 'ml:album:1', 'IMG_1.jpg', 'image', '2026-02-15T12:00:00.000Z'),
      file('ml:asset:2', 'ml:album:1', 'VID_1.mp4', 'video', '2025-07-10T12:00:00.000Z'),
      file('ml:asset:3', 'ml:album:1', 'IMG_2.jpg', 'image', '1970-01-01T00:00:00.000Z'),
      file('ml:asset:4', 'ml:album:1', 'BROKEN.jpg', 'image', '2026-03-03T12:00:00.000Z'),
    ],
    'ml:album:2': [file('ml:asset:5', 'ml:album:2', 'WA_1.jpg', 'image', '2026-04-04T12:00:00.000Z')],
    'fs:library': [file('fs:secret', 'fs:library', 'private-snap.jpg', 'image', '2026-04-04T12:00:00.000Z')],
  };
  const phone = {
    id: 'local', kind: 'local', isMock: false,
    list: async (parent) => parent === null
      ? { items: [dir('fs:library', 'meYou'), dir('ml:album:1', 'Camera'), dir('ml:album:2', 'WhatsApp Images')] }
      : { items: pages[parent] ?? [] },
    getOriginalUrl: async (id) => `file:///${id}`,
  };
  const sizes = { 'file:///ml:asset:1': 1000, 'file:///ml:asset:2': 9000, 'file:///ml:asset:3': 500, 'file:///ml:asset:5': 700, 'file:///fs:secret': 5 };
  const localInfo = (uri) => (sizes[uri] ? { size: sizes[uri], md5: `md5-${sizes[uri]}` } : null);
  const targetItems = []; // the server is empty
  const root = (id, name) => ({ id: dirId(id, ''), parentId: null, name, type: 'dir', size: 0, mtime: '2026-01-01T00:00:00.000Z' });
  const target = {
    id: 'srv', kind: 'server', isMock: false,
    list: async (parent) => (parent === null ? { items: [root('Photos', 'Photos'), root('Videos', 'Videos')] } : { items: targetItems }),
  };
  const now = () => new Date('2026-10-17T10:00:00.000Z');
  const run = (choice, backedUp = {}) => scanNewMedia({ phone, target, localInfo, backedUp, choice, now });

  const camera = await run({ photos: true, videos: true, scope: 'camera', albums: [] });
  assert.equal(camera.albums, 1);
  assert.equal(camera.unreadable, 1, 'a file the phone cannot read is counted, not queued');
  assert.deepEqual(camera.jobs.map((j) => j.name).sort(), ['IMG_1.jpg', 'IMG_2.jpg', 'VID_1.mp4']);
  const by = Object.fromEntries(camera.jobs.map((j) => [j.name, j]));
  assert.deepEqual(parseDirId(by['IMG_1.jpg'].parentId), { rootId: 'Photos', path: '2026/02' }, 'Photos/<year>/<month>');
  assert.deepEqual(parseDirId(by['VID_1.mp4'].parentId), { rootId: 'Videos', path: '2025/07' }, 'videos go to Videos');
  assert.deepEqual(parseDirId(by['IMG_2.jpg'].parentId), { rootId: 'Photos', path: 'undated' });
  assert.equal(by['IMG_1.jpg'].mtime, '2026-02-15T12:00:00.000Z');
  assert.equal(by['IMG_2.jpg'].mtime, undefined, 'unknown date: no mtime is sent');
  assert.equal(by['IMG_1.jpg'].size, 1000);
  assert.equal(by['IMG_1.jpg'].md5, 'md5-1000');
  assert.ok(!camera.jobs.some((j) => j.name === 'WA_1.jpg' || j.name === 'private-snap.jpg'), 'other albums and the app library are not touched');

  const photosOnly = await run({ photos: true, videos: false, scope: 'camera', albums: [] });
  assert.deepEqual(photosOnly.jobs.map((j) => j.name).sort(), ['IMG_1.jpg', 'IMG_2.jpg']);
  const videosOnly = await run({ photos: false, videos: true, scope: 'camera', albums: [] });
  assert.deepEqual(videosOnly.jobs.map((j) => j.name), ['VID_1.mp4']);
  const none = await run({ photos: false, videos: false, scope: 'all', albums: [] });
  assert.equal(none.jobs.length, 0);
  const all = await run({ photos: true, videos: true, scope: 'all', albums: [] });
  assert.ok(all.jobs.some((j) => j.name === 'WA_1.jpg') && !all.jobs.some((j) => j.name === 'private-snap.jpg'));
  const selected = await run({ photos: true, videos: true, scope: 'selected', albums: ['ml:album:2'] });
  assert.deepEqual(selected.jobs.map((j) => j.name), ['WA_1.jpg']);
  const noMatch = await run({ photos: true, videos: true, scope: 'selected', albums: [] });
  assert.equal(noMatch.albums, 0);

  // skip what is already on the server (same name and size) and what was uploaded before
  targetItems.push({ id: dirId('Photos', '2026/02') + 'x', parentId: null, name: 'IMG_1.jpg', type: 'image', size: 1000, mtime: '2026-02-15T12:00:00.000Z' });
  const again = await run({ photos: true, videos: true, scope: 'camera', albums: [] }, { 'whatever-not-a-key': 'x' });
  assert.ok(!again.jobs.some((j) => j.name === 'IMG_1.jpg'));
  assert.equal(again.alreadyThere, 1);
  // same name, other size: a different photo, it is sent (the server adds " (1)")
  targetItems[0].size = 1;
  const diff = await run({ photos: true, videos: true, scope: 'camera', albums: [] });
  assert.ok(diff.jobs.some((j) => j.name === 'IMG_1.jpg'));
}

// ---- queue: error codes ------------------------------------------------------------
{
  assert.equal(errorCode(new ServerError('network', 0)), 'network');
  assert.equal(errorCode(new ServerError('http', 507)), 'http-507');
  assert.equal(errorCode(new Error('x')), 'error');
  for (const code of ['network', 'timeout', 'protocol', 'http-500', 'http-502', 'http-503', 'http-429']) assert.ok(isTransientCode(code), code);
  for (const code of ['unauthorized', 'http-400', 'http-413', 'http-422', 'http-507', 'prepare', 'error', undefined]) assert.ok(!isTransientCode(code), String(code));
}

const job = (n, extra = {}) => ({ sourceId: 's', parentId: null, uri: `file:///${n}.jpg`, name: `${n}.jpg`, size: 100, ...extra });
const memoryStorage = () => {
  const store = new Map();
  return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k), store };
};

// ---- queue: waits for the rules, continues on kick ----------------------------------
{
  let blocker = 'no-wifi';
  const sent = [];
  const q = createUploadQueue({
    resolveProvider: () => ({ async upload(input) { sent.push(input); } }),
    canRun: () => blocker,
    sleep: noSleep,
  });
  q.getState().enqueue([job(1), job(2)]);
  await q.getState().start();
  assert.equal(sent.length, 0, 'nothing is sent on mobile data');
  assert.equal(q.getState().waiting, 'no-wifi');
  assert.deepEqual(q.getState().jobs.map((j) => j.state), ['queued', 'queued'], 'jobs stay queued, none fails');
  assert.equal(q.getState().running, false);
  blocker = null;
  await q.getState().kick();
  assert.equal(sent.length, 2);
  assert.equal(q.getState().waiting, null);
  assert.deepEqual(q.getState().jobs.map((j) => j.state), ['done', 'done']);
  // kick never un-pauses a queue the person paused
  q.getState().enqueue([job(3)]);
  q.getState().pause();
  await q.getState().kick();
  assert.equal(sent.length, 2);
  assert.equal(q.getState().jobs.at(-1).state, 'queued');
}

// ---- queue: network trouble = retry with backoff, then continue ----------------------
{
  let failures = 2;
  const sleeps = [];
  const q = createUploadQueue({
    resolveProvider: () => ({
      async upload() {
        if (failures > 0) {
          failures -= 1;
          throw new ServerError('network', 0, 'dropped');
        }
      },
    }),
    sleep: async (ms) => void sleeps.push(ms),
    retryDelaysMs: [1000, 2000, 4000],
  });
  q.getState().enqueue([job(1), job(2)]);
  await q.getState().start();
  assert.deepEqual(q.getState().jobs.map((j) => j.state), ['done', 'done'], 'survives two dropped connections');
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 3000, 'waited 1 s then 2 s');
  assert.equal(q.getState().jobs[0].attempts, 0, 'attempts reset after success');
}
{
  // out of retries -> failed with a code; retryTransient puts only the transient ones back
  let mode = 'down';
  const q = createUploadQueue({
    resolveProvider: () => ({
      async upload(input) {
        if (input.name === 'big.jpg') throw new ServerError('http', 507);
        if (mode === 'down') throw new ServerError('timeout', 0);
      },
    }),
    sleep: noSleep,
    retryDelaysMs: [10, 10],
  });
  q.getState().enqueue([job(1), job('big'), job(2)]);
  await q.getState().start();
  assert.deepEqual(q.getState().jobs.map((j) => [j.state, j.error]), [['failed', 'timeout'], ['failed', 'http-507'], ['failed', 'timeout']]);
  mode = 'up';
  await q.getState().retryTransient();
  assert.deepEqual(q.getState().jobs.map((j) => j.state), ['done', 'failed', 'done'], 'a full server disk is not retried automatically');
  assert.equal(uploadErrorKey('http-507'), 'uploadErrServerFull');
  assert.equal(uploadErrorKey('http-413'), 'uploadErrTooBig');
  assert.equal(uploadErrorKey('http-503'), 'uploadErrServerBusy');
  assert.equal(uploadErrorKey('network'), 'uploadErrNetwork');
  assert.equal(uploadErrorKey('unauthorized'), 'testUnauthorized');
  assert.equal(uploadErrorKey('whatever'), 'uploadErrOther');
}
{
  // a wrong token is not retried at all
  let calls = 0;
  const q = createUploadQueue({ resolveProvider: () => ({ async upload() { calls += 1; throw new ServerError('unauthorized', 401); } }), sleep: noSleep });
  q.getState().enqueue([job(1)]);
  await q.getState().start();
  assert.equal(calls, 1);
  assert.equal(q.getState().jobs[0].error, 'unauthorized');
}

// ---- queue: pause stops in the middle of a file and resumes later -----------------------
{
  let paused = false;
  const attempts = [];
  const q = createUploadQueue({
    resolveProvider: () => ({
      async upload(input) {
        attempts.push(input.name);
        if (attempts.length === 1) {
          // the person taps Pause while the first file is half sent
          q.getState().pause();
          assert.equal(input.isCancelled(), true);
          const e = new Error('upload cancelled');
          e.name = 'UploadCancelled';
          throw e;
        }
        assert.equal(input.isCancelled(), false);
      },
    }),
    sleep: noSleep,
  });
  q.getState().enqueue([job(1), job(2)]);
  await q.getState().start().catch(() => {});
  // start() un-pauses, so run the explicit sequence: the cancelled job is back to queued, not failed
  assert.equal(q.getState().jobs[0].state, 'queued');
  assert.equal(q.getState().jobs[0].error, undefined);
  assert.equal(q.getState().paused, true);
  await q.getState().resume();
  assert.deepEqual(q.getState().jobs.map((j) => j.state), ['done', 'done']);
  assert.deepEqual(attempts, ['1.jpg', '1.jpg', '2.jpg'], 'the first file was resumed, not skipped');
}

// ---- queue: mtime is passed on, the summary counts, persistence ------------------------------
{
  const sent = [];
  const storage = memoryStorage();
  const q = createUploadQueue({ resolveProvider: () => ({ async upload(input) { sent.push(input); } }), storage, storageName: 'b', sleep: noSleep });
  q.getState().enqueue([job(1, { mtime: '2026-02-15T12:00:00.000Z', size: 300 }), job(2, { size: 200 })]);
  q.getState().beginRun({ scanned: 10, skipped: 7, unreadable: 1, queued: 2 });
  await q.getState().start();
  assert.equal(sent[0].mtime, '2026-02-15T12:00:00.000Z');
  assert.equal(sent[1].mtime, undefined);
  assert.deepEqual({ ...q.getState().run, at: 'x' }, { at: 'x', scanned: 10, skipped: 7, unreadable: 1, queued: 2, uploaded: 2, bytes: 500 });
  // a clean queue starts a new summary; clearing finished jobs does not lose the numbers
  q.getState().clearFinished();
  assert.equal(q.getState().run.uploaded, 2);
  q.getState().beginRun({ scanned: 3, skipped: 3, unreadable: 0, queued: 0 });
  assert.deepEqual({ ...q.getState().run, at: 'x' }, { at: 'x', scanned: 3, skipped: 3, unreadable: 0, queued: 0, uploaded: 0, bytes: 0 });
  // while jobs are still waiting, a new scan adds to the running summary
  q.getState().enqueue([job(9)]);
  q.getState().pause();
  q.getState().beginRun({ scanned: 4, skipped: 2, unreadable: 0, queued: 1 });
  assert.equal(q.getState().run.queued, 1);
  q.getState().beginRun({ scanned: 5, skipped: 3, unreadable: 0, queued: 1 });
  assert.equal(q.getState().run.queued, 2);
  // the summary and waiting list survive a restart; `waiting` does not
  const restored = createUploadQueue({ resolveProvider: () => null, storage, storageName: 'b' });
  assert.equal(restored.getState().run.scanned, 5);
  assert.equal(restored.getState().waiting, null);
}

// ---- messages and texts ---------------------------------------------------------------------
{
  const en = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'));
  const t = (key) => en[key] ?? `MISSING:${key}`;
  for (const code of ['no-server', 'no-access', 'unreachable', 'no-upload', 'nothing-selected', 'no-albums']) {
    assert.ok(!backupMessage({ code }, t, 'latin').startsWith('MISSING'), code);
  }
  assert.ok(backupMessage({ code: 'done', queued: 0, alreadyThere: 3, scanned: 3, unreadable: 0 }, t, 'latin').includes('already'));
  assert.ok(backupMessage({ code: 'done', queued: 4, alreadyThere: 0, scanned: 4, unreadable: 0 }, t, 'persian').includes('۴'));
  for (const code of ['no-network', 'no-wifi', 'low-battery', 'not-charging']) assert.ok(en[waitingKey(code)], code);
  assert.equal(waitingKey('nonsense'), null);
  assert.equal(waitingKey(null), null);
  for (const key of ['uploadErrServerFull', 'uploadErrTooBig', 'uploadErrServerBusy']) assert.ok(en[key], key);
}

// ---- new entries: what is new, once, never secret, filed by Jalali date -----------------------------
{
  const ev = (id, over = {}) => ({ id, title: `T${id}`, date: '2026-10-19T00:00:00.000Z', repeat: null, cal: 'gregorian', tags: [], mediaKey: null, fromMe: true, updatedAt: '2026-10-19T08:00:00.000Z', description: null, icon: null, surprise: false, photoUri: null, photo: null, ...over });
  const mem = (id, over = {}) => ({ id, title: `M${id}`, category: 'none', mood: null, body: 'x', mediaKeys: [], saved: false, createdAt: '2026-10-19T09:00:00.000Z', updatedAt: '2026-10-19T09:30:00.000Z', ...over });
  assert.equal(baseName('file:///data/event-photos/ev1-k3.jpg'), 'ev1-k3.jpg');
  const none = { media: {} };

  // folders: Jalali year / month / day, from the right day
  assert.equal(dayFolderUtc('2026-10-19T00:00:00.000Z'), '1405/07/27');
  assert.equal(dayFolderUtc('2026-03-21T00:00:00.000Z'), '1405/01/01');
  assert.equal(dayFolderUtc('2027-03-20T00:00:00.000Z'), '1405/12/29');
  assert.equal(dayFolderUtc('garbage'), 'undated');
  assert.equal(dayFolderUtc('1970-01-01T00:00:00.000Z'), 'undated');
  assert.equal(versionStamp('2026-10-19T14:15:30.000Z'), '20261019-141530');
  // a picked day is filed at local noon (never a different day), today keeps its time, the future is refused
  const nowD = new Date(2026, 9, 21, 9, 30, 0);
  assert.equal(localDayString(memoryDateFromDay('2026-10-10', nowD)), '2026-10-10');
  assert.equal(dayFolderLocal(memoryDateFromDay('2026-10-10', nowD)), '1405/07/18');
  assert.equal(memoryDateFromDay('2026-10-21', nowD), nowD.toISOString());
  assert.equal(memoryDateFromDay('2026-10-22', nowD), null);
  assert.equal(memoryDateFromDay('nope', nowD), null);

  assert.equal(planDataBackup({ events: [], diary: [], marks: {}, ...none }), null, 'nothing to back up');
  const first = planDataBackup({ events: [ev('a'), ev('s', { surprise: true, photoUri: 'file:///p/s.jpg' })], diary: [mem('m1')], marks: {}, ...none });
  assert.deepEqual(first.files.map((f) => f.name.split('-')[0]).sort(), ['event', 'memory']);
  assert.deepEqual(first.files.map((f) => JSON.parse(f.json).id).sort(), ['a', 'm1'], 'a surprise event never leaves the phone (the server is shared)');
  assert.equal(first.uploads.length, 0, 'no photo of a surprise event');
  assert.deepEqual(Object.keys(first.marks).sort(), [eventKey('a'), memoryKey('m1')].sort());
  const evFile = first.files.find((f) => f.name.startsWith('event-'));
  assert.equal(evFile.day, '1405/07/27');
  assert.equal(evFile.name, 'event-a-20261019-080000.json');
  assert.equal(JSON.parse(evFile.json).kind, 'event');

  // the same data again: nothing new -> no second file
  assert.equal(planDataBackup({ events: [ev('a')], diary: [mem('m1')], marks: first.marks, ...none }), null);
  // an edited memory and a new event: only those travel; the edited memory is a NEW file name (the server never overwrites)
  const second = planDataBackup({ events: [ev('a'), ev('b')], diary: [mem('m1', { updatedAt: '2026-10-19T11:00:00.000Z' }), mem('m2')], marks: first.marks, ...none });
  assert.deepEqual(second.files.map((f) => JSON.parse(f.json).id).sort(), ['b', 'm1', 'm2']);
  assert.ok(second.files.some((f) => f.name === 'memory-m1-20261019-110000.json'));
  // memory: its photos go into the memory's day folder once, with their tags in the info file; already-on-server / unreadable ones are only listed
  const media = { k1: { key: 'k1', name: 'a.jpg', tags: ['sea'], uri: 'file:///lib/a.jpg', mtime: '2026-10-01T00:00:00.000Z' }, k2: { key: 'k2', name: 'b.jpg', tags: [], uri: null } };
  const withMedia = planDataBackup({ events: [], diary: [mem('m3', { mediaKeys: ['k1', 'k2', 'gone'] })], marks: {}, media });
  assert.deepEqual(withMedia.uploads.map((u) => [u.key, u.day, u.name]), [[mediaMark('k1'), dayFolderLocal('2026-10-19T09:00:00.000Z'), 'a.jpg']]);
  const info = JSON.parse(withMedia.files[0].json);
  assert.deepEqual(info.media.map((m) => m.name), ['a.jpg', 'b.jpg']);
  assert.deepEqual(info.tags, ['sea']);
  assert.equal(planDataBackup({ events: [], diary: [mem('m3', { mediaKeys: ['k1'] })], marks: { [mediaMark('k1')]: 'queued' }, media }).uploads.length, 0, 'a photo is queued once');
  // event photo: its private copy goes into the event's day folder once; no phone path inside the file
  const withPhoto = planDataBackup({ events: [ev('p', { photoUri: 'file:///data/event-photos/p-1.jpg', photo: 'Shared/p/p-1.jpg' })], diary: [mem('r', { fromMe: false })], marks: {}, ...none });
  assert.deepEqual(withPhoto.uploads.map((p) => [p.key, p.name, p.day]), [[photoKey('p-1.jpg'), 'p-1.jpg', '1405/07/27']]);
  assert.equal(JSON.parse(withPhoto.files.find((f) => f.name.startsWith('memory-')).json).fromMe, false, 'a received copy stays marked');
  assert.equal(JSON.parse(withPhoto.files.find((f) => f.name.startsWith('event-')).json).photoUri, undefined, 'no phone-local path in the file');
  const photoOnly = planDataBackup({ events: [ev('p', { photoUri: 'file:///data/event-photos/p-1.jpg' })], diary: [], marks: { [eventKey('p')]: '2026-10-19T08:00:00.000Z' }, ...none });
  assert.equal(photoOnly.files.length, 0, 'only the photo is new');
  assert.equal(planDataBackup({ events: [ev('p', { photoUri: 'file:///data/event-photos/p-1.jpg' })], diary: [], marks: { [eventKey('p')]: '2026-10-19T08:00:00.000Z', [photoKey('p-1.jpg')]: 'queued' }, ...none }), null);
  // the three switches
  assert.equal(planDataBackup({ events: [ev('a')], diary: [mem('m1')], marks: {}, ...none, switches: { memories: false, events: false } }), null);
  assert.deepEqual(planDataBackup({ events: [ev('a')], diary: [mem('m1')], marks: {}, ...none, switches: { memories: true, events: false } }).files.map((f) => f.name.split('-')[0]), ['memory']);
  // deleted rows are simply absent: nothing is ever removed from the server
  assert.equal(planDataBackup({ events: [], diary: [], marks: first.marks, ...none }), null);

  // files added straight to the Archive: filed by their Archive date (else their modified day); an info file only when they carry tags/category/favourite/albums
  const af = (key, over = {}) => ({ key, name: `${key}.jpg`, uri: `file:///lib/${key}.jpg`, mtime: '2026-10-19T09:00:00.000Z', date: null, category: 'none', favorite: false, tags: [], albums: [], ...over });
  const arch = planArchiveBackup({ files: [af('x'), af('y', { date: '2026-03-21T00:00:00.000Z', category: 'travel', tags: ['t1'], favorite: true, albums: ['Trip'] })], marks: {} });
  assert.deepEqual(arch.uploads.map((u) => [u.name, u.day]), [['x.jpg', dayFolderLocal('2026-10-19T09:00:00.000Z')], ['y.jpg', '1405/01/01']]);
  assert.deepEqual(arch.files.map((f) => f.name), ['y.jpg.info.json']);
  assert.deepEqual(JSON.parse(arch.files[0].json).tags, ['t1']);
  assert.equal(planArchiveBackup({ files: [af('x')], marks: { [mediaMark('x')]: 'queued' } }), null, 'queued once');
  const merged = mergePlans(first, arch);
  assert.equal(merged.archive, 2); assert.equal(merged.memories, 1);
  assert.equal(mergePlans(null, null), null);
}

// ---- reset + defaults + wiring -----------------------------------------------------------------
{
  assert.equal(isGalleryJob({ backupKey: 'md5:abc', state: 'queued' }), true);
  assert.equal(isGalleryJob({ backupKey: 'media:md5:abc', state: 'queued' }), false);
  assert.equal(isGalleryJob({ backupKey: 'eventphoto:p.jpg', state: 'queued' }), false);
  assert.equal(isGalleryJob({ state: 'queued' }), false, 'a job without a key (a data file) is never a gallery job');
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const store = src('../src/state/settings-store.ts');
  assert.match(store, /backupScope: 'selected'/, 'the gallery is not backed up until albums are picked');
  assert.match(store, /backupMode: 'copy'/);
  const auto = src('../src/backup/auto.ts');
  assert.doesNotMatch(auto, /backupNewMedia/, 'the automatic round never scans the gallery');
  const section = src('../src/settings/sections/BackupRestoreSection.tsx');
  assert.match(section, /Linking\.openSettings/, 'Reset opens the phone settings for the gallery permission');
  assert.match(section, /resetGalleryBackup/);
  assert.match(section, /backupMode/);
  assert.match(src('../app/diary/new.tsx'), /memoryDateFromDay/, 'a new memory can be dated');
  assert.match(src('../src/diary/diary-db.ts'), /created_at = excluded\.created_at/, 'editing can change the date');
  assert.match(src('../src/backup/run-backup.ts'), /plan\.offlineCopies = \[\]/, 'move mode never removes offline copies');
}
const enData = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'));
const faData = JSON.parse(readFileSync(new URL('../src/i18n/locales/fa.json', import.meta.url), 'utf8'));
for (const key of ['backupDataQueued', 'backupGroupNew', 'backupMode', 'backupModeCopy', 'backupModeMove', 'backupMemories', 'backupEvents', 'backupArchive', 'backupGroupGallery', 'backupGalleryNow', 'backupReset', 'backupResetTitle', 'backupResetBody', 'backupResetConfirm', 'backupDataNothingNew', 'diaryDate', 'diaryDateConfirm', 'diaryDateFuture']) {
  assert.ok(enData[key], `en.${key}`);
  assert.ok(faData[key], `fa.${key}`);
}

console.log('backup tests passed');
