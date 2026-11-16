// Sharing track, stage 6 (first half): original file on request, as encrypted chunks. Pure logic, no device, no libsodium.
import assert from 'node:assert/strict';
import { b64urlEncode } from '../src/e2e/base64.ts';
import { shouldWake } from '../src/e2e/transport.ts';
import { decodeMessage } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';
import { planEviction } from '../src/partner/media-logic.ts';
import {
  ORIG_CHUNK_BYTES, ORIG_CHUNK_B64_CHARS, ORIG_MAX_BYTES, ORIG_VIDEO_MAX_BYTES, ORIG_WINDOW_CHUNKS, isVideoName, origMaxBytes, ORIG_REQUEST_MAX_AGE_MS, ORIG_SPACE_MARGIN_BYTES,
  chunkCount, chunkLength, createOriginalWaiter, withRetry, isFreshRequest, origExt, receiveOrig, serveOriginal, staleTransfers,
} from '../src/partner/orig-logic.ts';

const REF = 'Shared/abc123/photo.jpg';
const NOW = '2026-11-14T10:00:00.000Z';
const fileOf = (size) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255);

// ---- constants and sizes
assert.equal(ORIG_CHUNK_BYTES, 262144);
assert.ok(ORIG_CHUNK_B64_CHARS * 4 / 3 + 1024 < 1024 * 1024, 'a sealed chunk fits the 1 MB queue blob');
assert.equal(chunkCount(1), 1);
assert.equal(chunkCount(ORIG_CHUNK_BYTES), 1);
assert.equal(chunkCount(ORIG_CHUNK_BYTES + 1), 2);
assert.equal(chunkLength(ORIG_CHUNK_BYTES + 5, 1), 5);
assert.equal(origExt('IMG_1.HEIC'), 'heic');
assert.equal(origExt('noext'), 'jpg');
assert.equal(origExt('a.verylongext'), 'jpg');

// ---- decode: valid and invalid
const head = { from: 'dev1', ts: NOW, rid: 'rid12345abcd' };
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-req', ref: REF })).t, 'orig-req');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-req', ref: '../x' })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, rid: 'short', t: 'orig-req', ref: REF })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: REF, size: 600000, chunks: 3, ext: 'jpg' })).chunks, 3);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: REF, size: 600000, chunks: 2, ext: 'jpg' })), null, 'chunk count must match size');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: REF, size: ORIG_MAX_BYTES + 1, chunks: chunkCount(ORIG_MAX_BYTES + 1), ext: 'jpg' })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: REF, size: 10, chunks: 1, ext: '../' })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-chunk', i: 0, data: 'AAAA' })).i, 0);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-chunk', i: -1, data: 'AAAA' })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-chunk', i: 0, data: 'AA+/' })), null, 'base64url only');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-chunk', i: 0, data: 'A'.repeat(ORIG_CHUNK_B64_CHARS + 1) })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-nack', reason: 'missing' })).reason, 'missing');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-nack', reason: 'x' })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-cancel' })).t, 'orig-cancel');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-bogus' })), null);
for (const t of ['orig-req', 'orig-meta', 'orig-chunk', 'orig-nack', 'orig-cancel']) assert.equal(shouldWake({ t, silent: true }), false, `${t} never shows a notification`);

// ---- freshness
assert.ok(isFreshRequest(NOW, Date.parse(NOW) + 1000));
assert.ok(!isFreshRequest(NOW, Date.parse(NOW) + ORIG_REQUEST_MAX_AGE_MS + 1));
assert.ok(!isFreshRequest('garbage', Date.now()));

// ---- in-memory fakes
function makeReceiver({ free = 10 ** 12, cap = 10 ** 12 } = {}) {
  const rows = new Map();
  const files = new Map();
  const done = [];
  const cancels = [];
  const more = [];
  const deps = {
    transfers: { get: async (rid) => rows.get(rid) ?? null, put: async (t) => void rows.set(t.rid, { ...t }), remove: async (rid) => void rows.delete(rid) },
    parts: {
      start: async (t) => void files.set(t.file, []),
      append: async (t, bytes) => { const list = files.get(t.file); for (const b of bytes) list.push(b); },
      finish: async (t) => {
        const bytes = files.get(t.file);
        if (bytes.length !== t.size) return false;
        done.push({ ref: t.ref, bytes: Uint8Array.from(bytes) });
        files.delete(t.file);
        return true;
      },
      discard: async (t) => void files.delete(t.file),
    },
    freeBytes: async () => free,
    sendCancel: async (rid) => void cancels.push(rid),
    requestMore: async (rid, ref, from, count) => void more.push({ rid, ref, from, count }),
    capBytes: () => cap,
    now: () => 1000,
  };
  const ask = (rid, ref = REF) => rows.set(rid, { rid, ref, state: 'asked', ext: 'jpg', size: 0, chunks: 0, next: 0, until: 0, file: `o-${rid}.part`, updated: 1 });
  return { rows, files, done, cancels, more, deps, ask };
}

function makeSender(bytes, { failAt = -1, cancelAfter = -1, shortRead = false } = {}) {
  const sent = [];
  const cancelled = new Set();
  const deps = {
    lookup: async (ref) => (ref === REF && bytes ? { size: bytes.length, ext: 'png', read: async (o, l) => (shortRead ? bytes.slice(o, o + l - 1) : bytes.slice(o, o + l)) } : null),
    send: async (m) => {
      if (sent.length === failAt) throw new Error('offline');
      sent.push(m);
      if (cancelAfter >= 0 && sent.length === cancelAfter) cancelled.add(m.rid);
    },
    cancelled: (rid) => cancelled.has(rid),
    from: 'dev1',
    nowIso: () => NOW,
  };
  return { sent, deps };
}

// ---- round trip: 2.5 chunks, through JSON like the transport does
{
  const bytes = fileOf(ORIG_CHUNK_BYTES * 2 + 1234);
  const sender = makeSender(bytes);
  const rcv = makeReceiver();
  rcv.ask('rid0000000001');
  assert.equal(await serveOriginal(sender.deps, { rid: 'rid0000000001', ref: REF }), 'sent');
  assert.equal(sender.sent.length, 1 + 3);
  assert.equal(sender.sent[0].t, 'orig-meta');
  assert.equal(sender.sent[0].ext, 'png');
  const events = [];
  for (const m of sender.sent) {
    const decoded = decodeMessage(JSON.stringify(m));
    assert.ok(decoded, `${m.t} decodes`);
    events.push(await receiveOrig(rcv.deps, decoded));
  }
  assert.deepEqual(events.map((e) => e.kind), ['meta', 'progress', 'progress', 'done']);
  assert.equal(rcv.done.length, 1);
  assert.deepEqual(Buffer.from(rcv.done[0].bytes), Buffer.from(bytes), 'the file arrives byte for byte');
  assert.equal(rcv.rows.size, 0, 'the transfer record is gone');
  // a replay of the last chunk after completion is ignored
  assert.equal((await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(sender.sent[3])))).kind, 'ignored');
}

// ---- unasked meta/chunk is ignored (the partner cannot fill this phone)
{
  const sender = makeSender(fileOf(1000));
  const rcv = makeReceiver();
  await serveOriginal(sender.deps, { rid: 'rid0000000002', ref: REF });
  for (const m of sender.sent) assert.equal((await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(m)))).kind, 'ignored');
  assert.equal(rcv.files.size, 0);
}

// ---- meta for another ref than asked
{
  const rcv = makeReceiver();
  rcv.ask('rid0000000003', 'Shared/other/x.jpg');
  const sender = makeSender(fileOf(100));
  await serveOriginal(sender.deps, { rid: 'rid0000000003', ref: REF });
  assert.equal((await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(sender.sent[0])))).kind, 'ignored');
}

// ---- replay of a middle chunk is ignored; a gap fails and cancels
{
  const sender = makeSender(fileOf(ORIG_CHUNK_BYTES * 3));
  await serveOriginal(sender.deps, { rid: 'rid0000000004', ref: REF });
  const m = sender.sent.map((x) => decodeMessage(JSON.stringify(x)));
  const rcv = makeReceiver();
  rcv.ask('rid0000000004');
  await receiveOrig(rcv.deps, m[0]);
  await receiveOrig(rcv.deps, m[1]);
  assert.equal((await receiveOrig(rcv.deps, m[1])).kind, 'ignored', 'replayed chunk');
  const gap = await receiveOrig(rcv.deps, m[3]); // skipped chunk 1
  assert.deepEqual([gap.kind, gap.reason], ['failed', 'order']);
  assert.deepEqual(rcv.cancels, ['rid0000000004']);
  assert.equal(rcv.rows.size, 0);
  assert.equal(rcv.files.size, 0, 'the part file is removed');
}

// ---- wrong chunk length fails
{
  const rcv = makeReceiver();
  rcv.ask('rid0000000005');
  const sender = makeSender(fileOf(ORIG_CHUNK_BYTES + 10));
  await serveOriginal(sender.deps, { rid: 'rid0000000005', ref: REF });
  await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(sender.sent[0])));
  const bad = { ...sender.sent[1], data: b64urlEncode(fileOf(100)) };
  const out = await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(bad)));
  assert.deepEqual([out.kind, out.reason], ['failed', 'size']);
}

// ---- not enough space: failed + cancel, nothing started
{
  const rcv = makeReceiver({ free: 1000 });
  rcv.ask('rid0000000006');
  const sender = makeSender(fileOf(5000));
  await serveOriginal(sender.deps, { rid: 'rid0000000006', ref: REF });
  const out = await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(sender.sent[0])));
  assert.deepEqual([out.kind, out.reason], ['failed', 'space']);
  assert.deepEqual(rcv.cancels, ['rid0000000006']);
  assert.equal(rcv.files.size, 0);
  const enough = makeReceiver({ free: 5000 + ORIG_SPACE_MARGIN_BYTES });
  enough.ask('rid0000000006');
  assert.equal((await receiveOrig(enough.deps, decodeMessage(JSON.stringify(sender.sent[0])))).kind, 'meta');
}

// ---- sender: missing file, too big, cancel, failed post, file changed
{
  const missing = makeSender(null);
  assert.equal(await serveOriginal(missing.deps, { rid: 'rid0000000007', ref: REF }), 'missing');
  assert.equal(missing.sent[0].t, 'orig-nack');
  const unknown = makeSender(fileOf(10));
  assert.equal(await serveOriginal(unknown.deps, { rid: 'rid0000000007', ref: 'Shared/never/x.jpg' }), 'missing');
  const big = { lookup: async () => ({ size: ORIG_MAX_BYTES + 1, ext: 'jpg', read: async () => new Uint8Array(0) }), send: async () => undefined, cancelled: () => false, from: 'd', nowIso: () => NOW };
  assert.equal(await serveOriginal(big, { rid: 'rid0000000007', ref: REF }), 'too-big');
  const cancel = makeSender(fileOf(ORIG_CHUNK_BYTES * 4), { cancelAfter: 2 });
  assert.equal(await serveOriginal(cancel.deps, { rid: 'rid0000000008', ref: REF }), 'cancelled');
  assert.equal(cancel.sent.length, 2, 'stops right after the cancel');
  const failing = makeSender(fileOf(ORIG_CHUNK_BYTES * 3), { failAt: 2 });
  assert.equal(await serveOriginal(failing.deps, { rid: 'rid0000000009', ref: REF }), 'failed');
  const changed = makeSender(fileOf(ORIG_CHUNK_BYTES + 5), { shortRead: true });
  assert.equal(await serveOriginal(changed.deps, { rid: 'rid0000000010', ref: REF }), 'failed');
  assert.equal(changed.sent.at(-1).t, 'orig-nack');
}

// ---- nack ends the transfer
{
  const rcv = makeReceiver();
  rcv.ask('rid0000000011');
  const out = await receiveOrig(rcv.deps, decodeMessage(JSON.stringify({ ...head, rid: 'rid0000000011', t: 'orig-nack', reason: 'missing' })));
  assert.deepEqual([out.kind, out.reason], ['nack', 'missing']);
  assert.equal(rcv.rows.size, 0);
}

// ---- stale transfers
{
  const all = [{ rid: 'a', updated: 0 }, { rid: 'b', updated: 10 ** 12 }];
  assert.deepEqual(staleTransfers(all, 10 ** 12 + 1000).map((t) => t.rid), ['a']);
}

// ---- cache: originals are evicted by age, thumbs never
{
  const rows = [
    { ref: 'a', kind: 'thumb', bytes: 20_000, used: 1 },
    { ref: 'a', kind: 'original', bytes: 5_000_000, used: 2 },
    { ref: 'b', kind: 'preview', bytes: 300_000, used: 3 },
    { ref: 'c', kind: 'original', bytes: 4_000_000, used: 4 },
  ];
  const plan = planEviction(rows, 4_400_000);
  assert.deepEqual(plan.map((r) => `${r.ref}:${r.kind}`), ['a:original']);
  assert.ok(planEviction(rows, 0).every((r) => r.kind !== 'thumb'));
}

// ---- waiter
{
  const w = createOriginalWaiter({ metaWaitMs: 40, idleMs: 40 });
  // offline: nobody answers
  assert.equal(await w.request(REF, 'rid0000000012', async () => undefined), 'offline');
  assert.equal(w.active(REF), false);
  // success with progress, and a second tap joins the first
  const seen = [];
  const first = w.request(REF, 'rid0000000013', async () => undefined, (d, t) => seen.push([d, t]));
  const second = w.request(REF, 'ignored-rid', async () => assert.fail('a joined tap sends nothing'));
  w.onEvent({ kind: 'meta', rid: 'rid0000000013', ref: REF, size: 1, chunks: 2 });
  w.onEvent({ kind: 'progress', rid: 'rid0000000013', ref: REF, done: 1, total: 2 });
  w.onEvent({ kind: 'done', rid: 'rid0000000013', ref: REF });
  assert.deepEqual([await first, await second], ['ok', 'ok']);
  assert.deepEqual(seen, [[1, 2]]);
  // idle after meta -> io
  const stuck = w.request(REF, 'rid0000000014', async () => undefined);
  w.onEvent({ kind: 'meta', rid: 'rid0000000014', ref: REF, size: 1, chunks: 2 });
  assert.equal(await stuck, 'io');
  // nack / failed / send error / cancel
  const nacked = w.request(REF, 'rid0000000015', async () => undefined);
  w.onEvent({ kind: 'nack', rid: 'rid0000000015', ref: REF, reason: 'missing' });
  assert.equal(await nacked, 'missing');
  assert.equal(await w.request(REF, 'rid0000000016', async () => { throw new Error('net'); }), 'send');
  const cancelled = w.request(REF, 'rid0000000017', async () => undefined);
  assert.equal(w.cancel(REF), 'rid0000000017');
  assert.equal(await cancelled, 'cancelled');
  assert.equal(w.cancel(REF), null);
  w.onEvent({ kind: 'done', rid: 'unknown', ref: REF }); // unknown rid: nothing happens
}

// ---- inbox dispatch
{
  const got = [];
  const deps = { db: {}, deviceId: 'me', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({}), notify() { assert.fail('never notifies'); }, onOriginal: (m) => void got.push(m.t) };
  for (const t of ['orig-req', 'orig-cancel']) {
    const extra = t === 'orig-req' ? { ref: REF } : {};
    assert.equal(await handleIncoming(deps, { id: 'e:x', message: JSON.stringify({ ...head, t, ...extra }) }), 'original');
  }
  assert.deepEqual(got, ['orig-req', 'orig-cancel']);
  assert.equal(await handleIncoming(deps, { id: 'e:y', message: JSON.stringify({ ...head, from: 'me', t: 'orig-req', ref: REF }) }), 'mine');
}

// ---- video: limits, windows, resume, cache cap
assert.ok(isVideoName('clip.MP4') && isVideoName('Shared/x/a.mov') && !isVideoName('a.jpg') && !isVideoName('mp4'));
assert.equal(origMaxBytes('mp4'), ORIG_VIDEO_MAX_BYTES);
assert.equal(origMaxBytes('jpg'), ORIG_MAX_BYTES);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: 'Shared/a/v.mp4', size: 500 * 1024 * 1024, chunks: chunkCount(500 * 1024 * 1024), ext: 'mp4' })).ext, 'mp4');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: 'Shared/a/v.jpg', size: 500 * 1024 * 1024, chunks: chunkCount(500 * 1024 * 1024), ext: 'jpg' })), null, 'a photo may not be video-sized');
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-meta', ref: 'Shared/a/v.mp4', size: ORIG_VIDEO_MAX_BYTES + 1, chunks: chunkCount(ORIG_VIDEO_MAX_BYTES + 1), ext: 'mp4' })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-req', ref: REF, start: 20, count: 16 })).start, 20);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-req', ref: REF, start: -1 })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-req', ref: REF, count: 17 })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head, t: 'orig-req', ref: REF, count: 0 })), null);

{
  // a 40-chunk video: the sender sends one window per request; the receiver asks for the next window itself
  const total = 40;
  const bytes = fileOf(ORIG_CHUNK_BYTES * total - 100);
  const VREF = 'Shared/vid/clip.mp4';
  const mk = () => ({ lookup: async (ref) => (ref === VREF ? { size: bytes.length, ext: 'mp4', read: async (o, l) => bytes.slice(o, o + l) } : null) });
  const rcv = makeReceiver();
  rcv.ask('rid0000000020', VREF);
  let from = 0;
  let count = ORIG_WINDOW_CHUNKS;
  let requests = 0;
  let last;
  for (;;) {
    requests += 1;
    const sent = [];
    const r = await serveOriginal({ ...mk(), send: async (m) => void sent.push(m), cancelled: () => false, from: 'dev1', nowIso: () => NOW }, { rid: 'rid0000000020', ref: VREF, start: from, count });
    assert.equal(r, 'sent');
    const chunks = sent.filter((m) => m.t === 'orig-chunk');
    assert.ok(chunks.length <= ORIG_WINDOW_CHUNKS, 'never more than one window');
    const before = rcv.more.length;
    for (const m of sent) last = await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(m)));
    if (last.kind === 'done') break;
    assert.equal(rcv.more.length, before + 1, 'exactly one request for the next window');
    ({ from, count } = rcv.more.at(-1));
  }
  assert.equal(requests, 3, '16 + 16 + 8 chunks');
  assert.deepEqual(Buffer.from(rcv.done[0].bytes), Buffer.from(bytes));
}

{
  // resume: the transfer stops after 5 chunks; a new request from chunk 5 (new rid) finishes the file
  const total = 8;
  const bytes = fileOf(ORIG_CHUNK_BYTES * total);
  const VREF = 'Shared/vid/clip.mp4';
  const src = { lookup: async () => ({ size: bytes.length, ext: 'mp4', read: async (o, l) => bytes.slice(o, o + l) }), cancelled: () => false, from: 'dev1', nowIso: () => NOW };
  const rcv = makeReceiver();
  rcv.ask('rid0000000030', VREF);
  const first = [];
  await serveOriginal({ ...src, send: async (m) => void first.push(m) }, { rid: 'rid0000000030', ref: VREF });
  for (const m of first.slice(0, 1 + 5)) await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(m))); // meta + chunks 0..4, then the phone goes away
  assert.equal(rcv.rows.get('rid0000000030').next, 5);
  const row = rcv.rows.get('rid0000000030');
  rcv.rows.delete('rid0000000030'); // what manage.ts does: same record under a fresh request id
  rcv.rows.set('rid0000000031', { ...row, rid: 'rid0000000031', until: Math.min(row.chunks, row.next + ORIG_WINDOW_CHUNKS) });
  const second = [];
  await serveOriginal({ ...src, send: async (m) => void second.push(m) }, { rid: 'rid0000000031', ref: VREF, start: 5, count: ORIG_WINDOW_CHUNKS });
  assert.deepEqual(second.map((m) => m.t === 'orig-chunk' ? m.i : m.t), ['orig-meta', 5, 6, 7]);
  let out;
  for (const m of second) out = await receiveOrig(rcv.deps, decodeMessage(JSON.stringify(m)));
  assert.equal(out.kind, 'done');
  assert.deepEqual(Buffer.from(rcv.done[0].bytes), Buffer.from(bytes), 'the resumed file is complete and identical');
  // a resume meta that disagrees with the record fails
  const rcv2 = makeReceiver();
  rcv2.ask('rid0000000030', VREF);
  await receiveOrig(rcv2.deps, decodeMessage(JSON.stringify(first[0])));
  const lie = { ...first[0], size: first[0].size - ORIG_CHUNK_BYTES, chunks: first[0].chunks - 1 };
  const failed = await receiveOrig(rcv2.deps, decodeMessage(JSON.stringify(lie)));
  assert.deepEqual([failed.kind, failed.reason], ['failed', 'size']);
  // a request past the end is refused
  const beyond = [];
  assert.equal(await serveOriginal({ ...src, send: async (m) => void beyond.push(m) }, { rid: 'rid0000000033', ref: VREF, start: 99 }), 'missing');
}

{
  // a video bigger than the cache cap is refused before any chunk
  const rcv = makeReceiver({ cap: 100 * 1024 * 1024 });
  rcv.ask('rid0000000040', 'Shared/vid/big.mp4');
  const size = 200 * 1024 * 1024;
  const meta = decodeMessage(JSON.stringify({ ...head, rid: 'rid0000000040', t: 'orig-meta', ref: 'Shared/vid/big.mp4', size, chunks: chunkCount(size), ext: 'mp4' }));
  const out = await receiveOrig(rcv.deps, meta);
  assert.deepEqual([out.kind, out.reason], ['failed', 'cache']);
  assert.deepEqual(rcv.cancels, ['rid0000000040']);
}

// ---- retry: a rate limit or a blip does not end the transfer; a dead link still fails after the last try
{
  let calls = 0;
  const waits = [];
  const sleep = async (ms) => void waits.push(ms);
  assert.equal(await withRetry(async () => { calls += 1; if (calls < 3) throw new Error('429'); return 'ok'; }, [10, 20, 30], sleep), 'ok');
  assert.deepEqual(waits, [10, 20]);
  let n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw new Error('down'); }, [1, 1], async () => undefined), /down/);
  assert.equal(n, 3, 'first try + 2 retries');
  assert.equal(await withRetry(async () => 7, [1], sleep), 7);
}

console.log('e2e original: ok');
