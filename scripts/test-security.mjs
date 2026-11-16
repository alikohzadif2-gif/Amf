import assert from 'node:assert/strict';
import { createUploadQueue } from '../src/backup/queue.ts';
import { buildReport } from '../src/diagnostics/report.ts';
import { reencodePlan } from '../src/security/exif.ts';
import { AUTO_LOCK_MS, shouldLock } from '../src/security/lock-logic.ts';
import { findDuplicates } from '../src/tools/duplicates.ts';
import { analyzeStorage } from '../src/tools/storage-stats.ts';

// ---- auto-lock timer -------------------------------------------------------------
const base = { enabled: true, autoLock: '1m', now: 1_000_000 };
assert.equal(shouldLock({ ...base, backgroundedAt: null }), false, 'never left the app');
assert.equal(shouldLock({ ...base, enabled: false, backgroundedAt: 0 }), false, 'lock off');
assert.equal(shouldLock({ ...base, backgroundedAt: base.now - 59_999 }), false, '59.999 s < 1 min');
assert.equal(shouldLock({ ...base, backgroundedAt: base.now - 60_000 }), true, 'exactly 1 min locks');
assert.equal(shouldLock({ ...base, autoLock: 'immediate', backgroundedAt: base.now }), true, 'immediate');
assert.equal(shouldLock({ ...base, autoLock: '5m', backgroundedAt: base.now - 299_000 }), false);
assert.equal(shouldLock({ ...base, autoLock: '15m', backgroundedAt: base.now - AUTO_LOCK_MS['15m'] }), true);
assert.equal(shouldLock({ ...base, backgroundedAt: base.now + 5_000 }), true, 'clock moved back locks');

// ---- EXIF re-encode plan -----------------------------------------------------------
assert.deepEqual(reencodePlan('a.JPG'), { format: 'jpeg', name: 'a.JPG' });
assert.deepEqual(reencodePlan('a.b.png'), { format: 'png', name: 'a.b.png' });
assert.deepEqual(reencodePlan('x.webp'), { format: 'webp', name: 'x.webp' });
assert.deepEqual(reencodePlan('IMG_1.HEIC'), { format: 'jpeg', name: 'IMG_1.jpg' });
for (const n of ['clip.mp4', 'notes.txt', 'noext', 'a.gif', 'doc.pdf']) assert.equal(reencodePlan(n), null, n);

// ---- duplicate finder --------------------------------------------------------------
const file = (id, name, md5, size, type = 'image', refs = [{ sourceId: 'phone', itemId: id }]) => ({
  key: md5 ? `md5:${md5}${id.startsWith('copy') ? `@s:${id}` : ''}` : `nsm:${name}`,
  item: { id, parentId: null, name, type, size, mtime: '2024-01-01T00:00:00.000Z', md5 },
  refs,
});
const entries = [
  file('1', 'a.jpg', 'aaa', 1000),
  file('copy1', 'a (1).jpg', 'aaa', 1000),
  file('copy2', 'a copy.jpg', 'aaa', 1000),
  file('2', 'b.jpg', 'bbb', 500),
  file('3', 'c.jpg', 'ccc', 700, 'image', [{ sourceId: 'phone', itemId: '3' }, { sourceId: 'srv', itemId: '3' }]), // backup, not a duplicate
  file('4', 'd.jpg', 'ddd', 300),
  file('copy4', 'd2.jpg', 'ddd', 300),
  file('5', 'nomd5.jpg', undefined, 10),
  file('6', 'folder', 'eee', 0, 'dir'),
  file('copy6', 'folder2', 'eee', 0, 'dir'),
];
const report = findDuplicates(entries);
assert.equal(report.groups.length, 2);
assert.equal(report.groups[0].md5, 'aaa');
assert.equal(report.groups[0].entries.length, 3);
assert.equal(report.groups[0].wasted, 2000);
assert.equal(report.groups[1].wasted, 300);
assert.equal(report.wasted, 2300);
assert.equal(findDuplicates([]).groups.length, 0);

// ---- storage analyzer ----------------------------------------------------------------
const kinds = { phone: 'local', srv: 'server' };
const stats = analyzeStorage(
  [
    file('1', 'a.jpg', 'a', 100, 'image', [{ sourceId: 'phone', itemId: '1' }, { sourceId: 'srv', itemId: '1' }]),
    file('2', 'v.mp4', 'v', 1000, 'video', [{ sourceId: 'srv', itemId: '2' }]),
    file('3', 'n.txt', 'n', 5, 'text', [{ sourceId: 'phone', itemId: '3' }]),
    file('4', 'x.bin', 'x', 20, 'file', [{ sourceId: 'phone', itemId: '4' }, { sourceId: 'phone', itemId: '4b' }]),
    file('5', 'dir', 'd', 0, 'dir'),
    file('6', 'x', 'unknown', 7, 'image', [{ sourceId: 'gone', itemId: '6' }]),
  ],
  kinds,
);
assert.deepEqual(stats.categories.photos, { count: 2, bytes: 107 });
assert.deepEqual(stats.categories.videos, { count: 1, bytes: 1000 });
assert.deepEqual(stats.categories.texts, { count: 1, bytes: 5 });
assert.deepEqual(stats.categories.files, { count: 1, bytes: 20 });
assert.deepEqual(stats.total, { count: 5, bytes: 1132 });
assert.deepEqual(stats.bySource.local, { count: 3, bytes: 125 }, 'two refs on one source count once');
assert.deepEqual(stats.bySource.server, { count: 2, bytes: 1100 });

// ---- diagnostics report has no secrets ----------------------------------------------
const text = buildReport({
  appVersion: '1.0.0', platform: 'android 15', language: 'fa', generatedAt: '2026-10-15T00:00:00.000Z',
  settings: { appLock: true, autoLock: '1m' },
  sources: [{ id: 'server-1', kind: 'server', backend: 'real', enabled: true }],
  uploads: { done: 2, failed: 1 },
  failures: [{ name: 'IMG_1.jpg', code: 'network' }],
  log: [{ t: '2026-10-15T00:00:01.000Z', level: 'warn', msg: 'upload failed: IMG_1.jpg (network)' }],
});
for (const part of ['meYou diagnostics', 'version: 1.0.0', 'appLock=true', 'server-1 server/real enabled', 'done=2 failed=1', 'failed: IMG_1.jpg (network)', 'warn upload failed']) {
  assert.ok(text.includes(part), `report should contain "${part}"`);
}

// ---- upload queue "prepare" step (EXIF strip) -----------------------------------------
function fakeProvider(log) {
  return {
    async upload(input) {
      log.push({ ...input, onProgress: undefined });
      return { id: 'x' };
    },
  };
}
const job = { sourceId: 's', parentId: null, uri: 'file:///orig.jpg', name: 'orig.jpg', size: 100, md5: 'orig-md5' };

{
  const sent = [];
  let cleaned = 0;
  const q = createUploadQueue({
    resolveProvider: () => fakeProvider(sent),
    prepare: async () => ({ uri: 'file:///clean.jpg', name: 'orig.jpg', size: 80, md5: undefined, cleanup: () => { cleaned += 1; } }),
  });
  q.getState().enqueue([job]);
  await q.getState().start();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sourceUri, 'file:///clean.jpg', 'the cleaned copy is uploaded');
  assert.equal(sent[0].size, 80);
  assert.equal(sent[0].md5, undefined, 'the original md5 must not be sent for a re-encoded file');
  assert.equal(cleaned, 1, 'temporary copy removed');
  assert.equal(q.getState().jobs[0].state, 'done');
}
{
  const sent = [];
  const q = createUploadQueue({
    resolveProvider: () => fakeProvider(sent),
    prepare: async () => { throw new Error('boom'); },
  });
  q.getState().enqueue([job]);
  await q.getState().start();
  assert.equal(sent.length, 0, 'a photo that could not be cleaned is NOT uploaded');
  assert.equal(q.getState().jobs[0].state, 'failed');
  assert.equal(q.getState().jobs[0].error, 'prepare');
}
{
  const sent = [];
  const q = createUploadQueue({ resolveProvider: () => fakeProvider(sent), prepare: async () => null });
  q.getState().enqueue([job]);
  await q.getState().start();
  assert.equal(sent[0].sourceUri, 'file:///orig.jpg', 'null = upload as queued');
  assert.equal(sent[0].md5, 'orig-md5');
}
{
  let cleaned = 0;
  const q = createUploadQueue({
    resolveProvider: () => ({ async upload() { throw new Error('net'); } }),
    prepare: async () => ({ uri: 'file:///c.jpg', name: 'orig.jpg', size: 1, cleanup: () => { cleaned += 1; } }),
  });
  q.getState().enqueue([job]);
  await q.getState().start();
  assert.equal(cleaned, 1, 'cleanup also runs when the upload fails');
  assert.equal(q.getState().jobs[0].state, 'failed');
}

console.log('security + tools ok');
