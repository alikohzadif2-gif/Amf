// Sharing track, stage 4: encrypted thumbnail / preview of shared photos, outbox, cache rules, backup-exclusion plugin.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import sodium from 'libsodium-wrappers';
import { deriveDirectionKeys } from '../src/e2e/crypto.ts';
import { openEnvelope, sealEnvelope } from '../src/e2e/envelope.ts';
import { shouldWake } from '../src/e2e/transport.ts';
import { BYTE_LIMIT, LADDER, MEDIA_MAX_DATA_CHARS, PREVIEW_MAX_BYTES, THUMB_MAX_BYTES, b64Bytes, buildMediaMessage, fitVariant, isImageName, mediaKey, planEviction } from '../src/partner/media-logic.ts';
import { OUTBOX_MAX_AGE_MS, flushOutbox, sendVariants } from '../src/partner/media-send.ts';
import { decodeMessage } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';

const require = createRequire(import.meta.url);
await sodium.ready;

const b64OfSize = (bytes) => Buffer.alloc(bytes, 7).toString('base64');
const render = (sizes) => {
  const calls = [];
  const fn = async (step) => {
    calls.push(step);
    const bytes = sizes[Math.min(calls.length - 1, sizes.length - 1)];
    return { b64: b64OfSize(bytes), width: step.edge, height: Math.round(step.edge * 0.75) };
  };
  return { fn, calls };
};

// ---- ladder
assert.equal(THUMB_MAX_BYTES, 30_000);
assert.equal(PREVIEW_MAX_BYTES, 400_000);
for (const kind of ['thumb', 'preview']) {
  const steps = LADDER[kind];
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].edge <= steps[i - 1].edge && steps[i].quality <= steps[i - 1].quality, `${kind} ladder only goes down`);
}
assert.equal(LADDER.preview[0].edge, 1080);
{
  const r = render([90_000, 50_000, 20_000]);
  const out = await fitVariant('thumb', r.fn);
  assert.equal(r.calls.length, 3, 'goes down until it fits');
  assert.ok(b64Bytes(out.b64) <= BYTE_LIMIT.thumb);
}
{
  const r = render([500_000, 450_000, 300_000]);
  assert.ok(b64Bytes((await fitVariant('preview', r.fn)).b64) <= PREVIEW_MAX_BYTES);
  assert.equal(r.calls.length, 3);
}
{
  const r = render([440_000]); // never fits the soft limit, but is below the hard limit: the smallest step is used
  const out = await fitVariant('preview', r.fn);
  assert.equal(r.calls.length, LADDER.preview.length);
  assert.ok(out);
}
assert.equal(await fitVariant('preview', render([2_000_000]).fn), null, 'too big for one queue blob: skipped');
assert.equal(await fitVariant('thumb', async () => null), null, 'render failure');
assert.equal(b64Bytes(b64OfSize(1001)), 1001);
assert.ok(isImageName('IMG_1.HEIC') && isImageName('a.jpg?x=1') && !isImageName('clip.mp4') && !isImageName('story.mov'));
assert.equal(mediaKey('Shared/a/b.jpg', 'thumb'), 'thumb|Shared/a/b.jpg');

// ---- eviction: previews only, least recently used first, thumbnails never
{
  const rows = [
    { ref: 'a', kind: 'thumb', bytes: 20, used: 1 },
    { ref: 'a', kind: 'preview', bytes: 300, used: 5 },
    { ref: 'b', kind: 'preview', bytes: 300, used: 2 },
    { ref: 'c', kind: 'preview', bytes: 300, used: 9 },
    { ref: 'b', kind: 'thumb', bytes: 20, used: 1 },
  ];
  assert.deepEqual(planEviction(rows, 10_000), []);
  assert.deepEqual(planEviction(rows, 700).map((r) => `${r.ref}:${r.kind}`), ['b:preview'], 'the oldest preview goes first');
  assert.deepEqual(planEviction(rows, 400).map((r) => r.ref), ['b', 'a'], 'then the next');
  const all = planEviction(rows, 0);
  assert.equal(all.length, 3);
  assert.ok(all.every((r) => r.kind === 'preview'), 'a thumbnail is never evicted');
}

// ---- message: decode rules
const ref = 'Shared/ev1/photo.jpg';
const good = buildMediaMessage({ from: 'aaaa', ts: '2026-11-13T10:00:00.000Z', ref, kind: 'thumb', rendered: { b64: b64OfSize(2000), width: 320, height: 240 } });
assert.deepEqual(decodeMessage(JSON.stringify(good)), good);
assert.equal(good.silent, true);
assert.equal(shouldWake(good), false, 'a picture never wakes the partner with a notification');
const bad = (patch) => decodeMessage(JSON.stringify({ ...good, ...patch }));
assert.equal(bad({ ref: '../x' }), null);
assert.equal(bad({ ref: 'Shared/../x.jpg' }), null);
assert.equal(bad({ ref: 'photos/a.jpg' }), null);
assert.equal(bad({ kind: 'original' }), null);
assert.equal(bad({ mime: 'text/html' }), null);
assert.equal(bad({ data: 'not base64!' }), null);
assert.equal(bad({ data: 'A'.repeat(MEDIA_MAX_DATA_CHARS + 4) }), null, 'bigger than the queue allows');
assert.equal(bad({ w: 0 }), null);
assert.equal(bad({ w: 99999 }), null);
assert.equal(bad({ h: 1.5 }), null);

// ---- the whole way: real libsodium, a 400 KB preview fits one queue blob (server limit 1 MB), the server sees only bytes
{
  const master = sodium.randombytes_buf(32);
  const mine = deriveDirectionKeys(sodium, master, 'a');
  const theirs = deriveDirectionKeys(sodium, master, 'b');
  const preview = buildMediaMessage({ from: 'aaaa', ts: '2026-11-13T10:00:00.000Z', ref, kind: 'preview', rendered: { b64: b64OfSize(PREVIEW_MAX_BYTES), width: 1080, height: 810 } });
  const sealed = sealEnvelope(sodium, mine.send, preview);
  assert.ok(sealed.blob.length < 1024 * 1024, `a 400 KB preview is ${sealed.blob.length} bytes as a blob, under the 1 MB queue limit`);
  const opened = openEnvelope(sodium, theirs.recv, sealed.blob);
  assert.equal(opened.message.data, preview.data);
  const asText = Buffer.from(sealed.blob).toString('latin1');
  assert.ok(!asText.includes(ref) && !asText.includes('image/jpeg'), 'the blob shows neither the path nor the type');

  // inbox: a media message goes to onMedia only, never notifies, never touches the database
  const stored = [];
  const notified = [];
  const deps = { db: {}, deviceId: 'bbbb', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({ mood: true, event: true, diary: true, period: true }), notify: (n) => notified.push(n), onMedia: (m) => stored.push(m) };
  assert.equal(await handleIncoming(deps, { id: 'e:1', message: JSON.stringify(opened.message) }), 'media');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].ref, ref);
  assert.equal(notified.length, 0);
  assert.equal(await handleIncoming({ ...deps, deviceId: 'aaaa' }, { id: 'e:2', message: JSON.stringify(opened.message) }), 'mine');
}

// ---- sender: thumbnail first, preview now on Wi-Fi, else outbox; flush later
const memoryOutbox = () => {
  const map = new Map();
  return { map, put: async (e) => void map.set(e.ref, e), list: async () => [...map.values()], remove: async (r) => void map.delete(r) };
};
const msgOf = (kind) => buildMediaMessage({ from: 'aaaa', ts: '2026-11-13T10:00:00.000Z', ref, kind, rendered: { b64: b64OfSize(2000), width: 10, height: 10 } });
const makeDeps = (over = {}) => {
  const sent = [];
  const deps = { send: async (m) => void sent.push(m.kind), unmetered: async () => true, wifiOnly: () => true, outbox: memoryOutbox(), now: () => 1_000_000, ...over };
  return { deps, sent };
};
{
  const { deps, sent } = makeDeps();
  assert.deepEqual(await sendVariants(deps, { thumb: msgOf('thumb'), preview: msgOf('preview') }), { thumb: 'sent', preview: 'sent' });
  assert.deepEqual(sent, ['thumb', 'preview'], 'thumbnail first');
}
{
  const { deps, sent } = makeDeps({ unmetered: async () => false });
  assert.equal((await sendVariants(deps, { thumb: msgOf('thumb'), preview: msgOf('preview') })).preview, 'queued', 'cellular + Wi-Fi-only: the preview waits');
  assert.deepEqual(sent, ['thumb'], 'the thumbnail still goes at once');
  assert.equal(deps.outbox.map.size, 1);
}
{
  const { deps, sent } = makeDeps({ unmetered: async () => false, wifiOnly: () => false });
  assert.equal((await sendVariants(deps, { thumb: msgOf('thumb'), preview: msgOf('preview') })).preview, 'sent', 'setting off: cellular is fine');
  assert.deepEqual(sent, ['thumb', 'preview']);
}
{
  const { deps } = makeDeps({ send: async () => { throw new Error('offline'); } });
  await assert.rejects(sendVariants(deps, { thumb: msgOf('thumb'), preview: msgOf('preview') }), /offline/, 'no thumbnail = the share failed (the caller retries)');
  assert.equal(deps.outbox.map.size, 0, 'nothing is queued behind a failed thumbnail');
}
{
  let n = 0;
  const { deps } = makeDeps({ send: async () => { n += 1; if (n === 2) throw new Error('lost'); } });
  assert.equal((await sendVariants(deps, { thumb: msgOf('thumb'), preview: msgOf('preview') })).preview, 'queued', 'preview failure after the thumbnail: kept for later');
}
{
  const { deps } = makeDeps();
  assert.deepEqual(await sendVariants(deps, { thumb: msgOf('thumb'), preview: null }), { thumb: 'sent', preview: 'skipped' });
}
{
  // flush: waits while metered, sends on Wi-Fi, drops what is too old, stops at the first failure, never throws
  let metered = true;
  const { deps, sent } = makeDeps({ unmetered: async () => !metered });
  await deps.outbox.put({ ref, queuedAt: 1_000_000, message: msgOf('preview') });
  assert.equal(await flushOutbox(deps), 0, 'metered: nothing sent');
  assert.equal(deps.outbox.map.size, 1);
  metered = false;
  assert.equal(await flushOutbox(deps), 1);
  assert.deepEqual(sent, ['preview']);
  assert.equal(deps.outbox.map.size, 0, 'removed after it was sent');
  assert.equal(await flushOutbox(deps), 0, 'empty outbox is cheap');

  await deps.outbox.put({ ref: 'Shared/old/a.jpg', queuedAt: 1_000_000 - OUTBOX_MAX_AGE_MS - 1, message: { ...msgOf('preview'), ref: 'Shared/old/a.jpg' } });
  assert.equal(await flushOutbox(deps), 0);
  assert.equal(deps.outbox.map.size, 0, 'a preview older than 14 days is dropped');

  const failing = makeDeps({ send: async () => { throw new Error('offline'); } });
  await failing.deps.outbox.put({ ref, queuedAt: 1_000_000, message: msgOf('preview') });
  assert.equal(await flushOutbox(failing.deps), 0);
  assert.equal(failing.deps.outbox.map.size, 1, 'kept for the next flush');
  assert.equal(await flushOutbox({ ...failing.deps, outbox: { ...memoryOutbox(), list: async () => { throw new Error('io'); } } }), 0, 'a broken outbox never throws');
}

// ---- Android backup exclusion plugin: adds to the SecureStore rules, never replaces them
{
  const plugin = require('../plugins/with-backup-exclude.js');
  const secureBackup = '<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n  <exclude domain="sharedpref" path="SecureStore"/>\n</full-backup-content>\n';
  const patched = plugin.patchBackup(secureBackup);
  assert.ok(patched.includes('path="SecureStore"') && patched.includes(plugin.EXCLUDE), 'SecureStore stays excluded, partner pictures added');
  assert.equal(plugin.patchBackup(patched), patched, 'idempotent');
  assert.equal(plugin.patchBackup('<nothing/>'), null);
  const secureExtraction = '<data-extraction-rules>\n  <cloud-backup>\n    <exclude domain="sharedpref" path="SecureStore"/>\n  </cloud-backup>\n  <device-transfer>\n    <exclude domain="sharedpref" path="SecureStore"/>\n  </device-transfer>\n</data-extraction-rules>\n';
  const p2 = plugin.patchExtraction(secureExtraction);
  assert.equal(p2.split(plugin.EXCLUDE).length - 1, 2, 'both the cloud backup and the device transfer');
  assert.equal(p2.split('path="SecureStore"').length - 1, 2);
  assert.equal(plugin.patchExtraction(p2), p2);
  const onlyCloud = plugin.patchExtraction('<data-extraction-rules>\n  <cloud-backup>\n  </cloud-backup>\n</data-extraction-rules>');
  assert.ok(onlyCloud.includes('<device-transfer>') && onlyCloud.split(plugin.EXCLUDE).length - 1 === 2, 'a missing section is created');
  assert.ok(plugin.backupRules().includes('SecureStore') && plugin.extractionRules().includes(plugin.EXCLUDE));
  const app = JSON.parse((await import('node:fs')).readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.ok(app.expo.plugins.includes('./plugins/with-backup-exclude'));
}

console.log('e2e media (stage 4): ok');
