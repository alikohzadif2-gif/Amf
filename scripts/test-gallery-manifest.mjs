// Shared gallery, stage 2: manifest format, batching, order, lazy-listing pages, sender journal, receiver store, wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'fflate';
import sodium from 'libsodium-wrappers';
import { b64urlEncode } from '../src/e2e/base64.ts';
import { deriveDirectionKeys } from '../src/e2e/crypto.ts';
import { openEnvelope, sealEnvelope } from '../src/e2e/envelope.ts';
import { shouldWake } from '../src/e2e/transport.ts';
import { initializeDatabase } from '../src/lib/database.ts';
import { ancestorsOf, createFlushGate, pageWindow, sortFolderNames, splitGalleryPath, subtreeRange } from '../src/gallery/gallery-logic.ts';
import { MANIFEST_MAX_ENTRIES, MANIFEST_MAX_INFLATED_BYTES, decodeBatch, encodeBatch, inflateCapped, isGalleryPath, kindOfName, parseEntry, splitBatches } from '../src/gallery/manifest.ts';
import { applyGalleryManifest, clearGalleryState, galleryFolderCount, galleryPendingCount, listGalleryPage, markGallerySent, pendingGallery, recordGalleryAdd, recordGalleryGone, recordGalleryRestored } from '../src/gallery/gallery-db.ts';
import { BYTE_LIMIT, LADDER, MEDIA_MAX_DATA_CHARS, PREVIEW_MAX_BYTES, b64Bytes, buildMediaMessage, fitVariant } from '../src/partner/media-logic.ts';
import { decodeMessage } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';

await sodium.ready;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const head = { from: 'aaaa', ts: '2026-11-18T10:00:00.000Z' };
const ent = (i, p = `Trip/Day 1/IMG_${String(i).padStart(4, '0')}.jpg`) => ({ id: `item-${String(i).padStart(6, '0')}`, p, k: 'i', s: 3_456_789 + i, o: i });

// ---- kinds and paths
assert.equal(kindOfName('a/IMG_1.JPG'), 'i');
assert.equal(kindOfName('clip.MP4'), 'v');
assert.equal(kindOfName('notes.pdf'), 'f');
assert.ok(isGalleryPath('Trip/Day 1/IMG_1.jpg') && isGalleryPath('a.jpg') && isGalleryPath('پوشه/عکس ۱.jpg'));
for (const bad of ['', '/abs.jpg', '../x.jpg', 'a/../x.jpg', 'a//b.jpg', 'a/./b.jpg', '.hidden/a.jpg', 'a\\b.jpg', 'a/\u0000b.jpg', 'x'.repeat(301), 5, null]) assert.equal(isGalleryPath(bad), false, `rejected: ${String(bad).slice(0, 20)}`);
assert.equal(parseEntry({ ...ent(1), k: 'x' }), null);
assert.equal(parseEntry({ ...ent(1), s: -1 }), null);
assert.equal(parseEntry({ ...ent(1), s: 1.5 }), null);
assert.equal(parseEntry({ ...ent(1), id: 'short' }), null);
assert.equal(parseEntry({ ...ent(1), id: 'has space in it' }), null);
assert.deepEqual(parseEntry({ ...ent(1), extra: 'ignored' }), ent(1), 'unknown fields are dropped');

// ---- batching keeps copy order and the limits
{
  const shuffled = Array.from({ length: 1000 }, (_, i) => ent(i)).sort(() => 0.5 - Math.sin(1));
  const batches = splitBatches([...shuffled].reverse());
  assert.equal(batches.length, 3, '1000 entries = 400 + 400 + 200');
  assert.deepEqual(batches.map((b) => b.entries.length), [400, 400, 200]);
  const flat = batches.flatMap((b) => b.entries.map((e) => e.o));
  assert.deepEqual(flat, [...flat].sort((a, b) => a - b), 'the copy order survives batching');
  assert.equal(new Set(flat).size, 1000, 'nothing lost, nothing doubled');
  const long = splitBatches(Array.from({ length: 50 }, (_, i) => ent(i, `${'folder-name-'.repeat(15)}/IMG_${i}.jpg`)), [], { maxRaw: 1500 });
  assert.ok(long.length > 3 && long.every((b) => b.entries.length >= 1), 'long names make smaller batches, never an empty one');
  const withGone = splitBatches([ent(1)], Array.from({ length: 450 }, (_, i) => `gone-id-${String(i).padStart(5, '0')}`));
  assert.deepEqual(withGone.map((b) => [b.entries.length, b.gone.length]), [[1, 0], [0, 400], [0, 50]], 'removals follow the entries');
  assert.deepEqual(splitBatches([]), []);
}

// ---- encode / decode
{
  const batch = splitBatches(Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => ent(i)))[0];
  const wire = encodeBatch(batch, head);
  assert.equal(wire.t, 'gallery-manifest');
  assert.equal(wire.silent, true);
  assert.equal(wire.n, 400);
  const raw = JSON.stringify(batch.entries).length;
  assert.ok(wire.z.length < raw / 4, `deflate shrinks 400 entries (${raw} -> ${wire.z.length} chars)`);
  assert.ok(JSON.stringify(wire).length < 40_000, 'a full message is small next to the 1 MB queue blob');
  assert.deepEqual(decodeBatch(wire.z, wire.n), { entries: batch.entries, gone: [] });
  assert.equal(shouldWake(wire), false, 'a manifest never wakes the partner with a notification');
  const both = encodeBatch({ entries: [ent(1)], gone: ['gone-id-00001'] }, head);
  assert.deepEqual(decodeBatch(both.z, both.n), { entries: [ent(1)], gone: ['gone-id-00001'] });
  assert.equal(decodeBatch(wire.z, 399), null, 'the count must match');
  assert.equal(decodeBatch(wire.z.slice(0, -4), wire.n), null, 'cut data');
  assert.equal(decodeBatch('!!!', 1), null);
  assert.equal(decodeBatch('', 1), null);
  assert.equal(decodeBatch(5, 1), null);
}
const wireOf = (obj) => {
  const z = b64urlEncode(deflateSync(new TextEncoder().encode(JSON.stringify(obj))));
  return { z, n: (obj.e?.length ?? 0) + (obj.g?.length ?? 0) };
};
{
  const ok = wireOf({ v: 1, e: [ent(1)], g: [] });
  assert.ok(decodeBatch(ok.z, ok.n));
  for (const bad of [
    { v: 2, e: [ent(1)], g: [] }, // a newer format is not guessed at
    { v: 1, e: [ent(1), { ...ent(2), p: '../escape.jpg' }], g: [] }, // one bad entry rejects all
    { v: 1, e: [], g: [] }, // empty
    { v: 1, e: [ent(1)] }, // missing list
    { v: 1, e: [ent(1)], g: [5] },
    { v: 1, e: Array.from({ length: 401 }, (_, i) => ent(i)), g: [] }, // too many
  ]) {
    const w = wireOf(bad);
    assert.equal(decodeBatch(w.z, w.n), null);
  }
  // a zip bomb: 60 MB of zeros is a few KB compressed; it stops at the cap
  const bomb = deflateSync(new Uint8Array(60_000_000));
  assert.ok(bomb.length < 100_000);
  const started = Date.now();
  assert.equal(inflateCapped(bomb, MANIFEST_MAX_INFLATED_BYTES), null);
  assert.equal(decodeBatch(b64urlEncode(bomb), 1), null);
  assert.ok(Date.now() - started < 2000, 'the bomb is stopped early');
  assert.equal(inflateCapped(new Uint8Array([1, 2, 3, 4]), 1000), null, 'not deflate data');
  assert.equal(inflateCapped(deflateSync(new Uint8Array(100)), 1000)?.length, 100);
}

// ---- the message through decodeMessage and the inbox (only from the encrypted queue)
{
  const batch = { entries: [ent(1), ent(2, 'Trip/b.mp4')], gone: [] };
  const wire = encodeBatch(batch, head);
  const msg = decodeMessage(JSON.stringify(wire));
  assert.equal(msg.t, 'gallery-manifest');
  assert.deepEqual(msg.entries, batch.entries);
  assert.equal(decodeMessage(JSON.stringify({ ...wire, n: 7 })), null);
  assert.equal(decodeMessage(JSON.stringify({ ...wire, z: 'AAAA' })), null);
  const got = [];
  const notified = [];
  const deps = { db: {}, deviceId: 'bbbb', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({ mood: true, event: true, diary: true, period: true }), notify: (n) => notified.push(n), onGallery: (m) => got.push(m) };
  assert.equal(await handleIncoming(deps, { id: 'e:1', message: JSON.stringify(wire) }), 'gallery');
  assert.equal(got.length, 1);
  assert.equal(notified.length, 0, 'a manifest never notifies');
  assert.equal(await handleIncoming(deps, { id: 'plain-1', message: JSON.stringify(wire) }), 'invalid', 'not accepted from the old plain mailbox');
  assert.equal(await handleIncoming({ ...deps, deviceId: 'aaaa' }, { id: 'e:2', message: JSON.stringify(wire) }), 'mine');
  // real encryption: the blob shows neither a path nor a name
  const master = sodium.randombytes_buf(32);
  const mine = deriveDirectionKeys(sodium, master, 'a');
  const theirs = deriveDirectionKeys(sodium, master, 'b');
  const full = encodeBatch(splitBatches(Array.from({ length: 400 }, (_, i) => ent(i)))[0], head);
  const sealed = sealEnvelope(sodium, mine.send, full);
  assert.ok(sealed.blob.length < 40_000);
  assert.deepEqual(openEnvelope(sodium, theirs.recv, sealed.blob).message, full);
  assert.ok(!Buffer.from(sealed.blob).toString('latin1').includes('IMG_'));
}

// ---- pure listing rules
assert.deepEqual(splitGalleryPath('a/b/c.jpg'), { parent: 'a/b', name: 'c.jpg' });
assert.deepEqual(splitGalleryPath('c.jpg'), { parent: '', name: 'c.jpg' });
assert.deepEqual(ancestorsOf('a/b/c.jpg'), ['a', 'a/b']);
assert.deepEqual(ancestorsOf('c.jpg'), []);
assert.deepEqual(subtreeRange('a/b'), { low: 'a/b/', high: 'a/b0' });
assert.deepEqual(sortFolderNames([{ name: 'Day 10' }, { name: 'day 2' }, { name: 'Day 1' }]).map((f) => f.name), ['Day 1', 'day 2', 'Day 10']);
{
  // folders first, then files; slices never overlap and cover everything
  assert.deepEqual(pageWindow(3, 100, 0, 5), { folderFrom: 0, folderTo: 3, fileFrom: 0, fileTo: 2 });
  assert.deepEqual(pageWindow(3, 100, 5, 5), { folderFrom: 3, folderTo: 3, fileFrom: 2, fileTo: 7 });
  assert.deepEqual(pageWindow(3, 100, 2, 3), { folderFrom: 2, folderTo: 3, fileFrom: 0, fileTo: 2 });
  assert.deepEqual(pageWindow(0, 10, 8, 5), { folderFrom: 0, folderTo: 0, fileFrom: 8, fileTo: 10 });
  assert.deepEqual(pageWindow(2, 0, 0, 30), { folderFrom: 0, folderTo: 2, fileFrom: 0, fileTo: 0 });
  assert.deepEqual(pageWindow(2, 3, 50, 5), { folderFrom: 2, folderTo: 2, fileFrom: 3, fileTo: 3 }, 'past the end = empty');
  for (const [f, n, size] of [[0, 0, 7], [4, 0, 3], [0, 25, 10], [5, 33, 8]]) {
    let seen = 0;
    for (let offset = 0; offset < f + n + size; offset += size) {
      const w = pageWindow(f, n, offset, size);
      seen += w.folderTo - w.folderFrom + (w.fileTo - w.fileFrom);
    }
    assert.equal(seen, f + n, `pages of ${size} cover ${f} folders + ${n} files exactly once`);
  }
}
{
  let t = 0;
  const gate = createFlushGate(50, 3000, () => t);
  assert.equal(gate.note(), true, 'the first file goes at once, so the partner sees the first folder');
  for (let i = 0; i < 49; i += 1) assert.equal(gate.note(), false);
  assert.equal(gate.note(), true, 'every 50 files');
  t = 3500;
  assert.equal(gate.note(), true, 'or after 3 seconds');
  gate.reset();
  assert.equal(gate.note(), false, 'a push made elsewhere restarts the count');
}

// ---- database
function memoryDb() {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...params) => { const r = db.prepare(sql).run(...params); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    getAllAsync: async (sql, ...params) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql, ...params) => db.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (fn) => { depth += 1; db.exec('BEGIN'); try { await fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth -= 1; } },
  };
}
const db = memoryDb();
await initializeDatabase(db);
assert.equal((await db.getAllAsync('SELECT version FROM migrations WHERE version = 20')).length, 1, 'migration 20 ran');

// sender journal
await recordGalleryAdd(db, { id: 'item-000001', o: 10, rel: 'Trip/b.jpg', size: 5 });
await recordGalleryAdd(db, { id: 'item-000002', o: 9, rel: 'Trip/a.mp4', size: 7 });
await recordGalleryAdd(db, { id: 'item-000003', o: 11, rel: 'notes.pdf', size: 9 });
assert.equal(await galleryPendingCount(db), 3);
{
  const p = await pendingGallery(db, 400);
  assert.deepEqual(p.entries.map((e) => [e.id, e.k, e.o]), [['item-000002', 'v', 9], ['item-000001', 'i', 10], ['item-000003', 'f', 11]], 'pending comes in copy order with the right kind');
  assert.equal((await pendingGallery(db, 2)).ids.length, 2, 'the limit is honoured');
  await markGallerySent(db, p.ids);
}
assert.equal(await galleryPendingCount(db), 0);
await recordGalleryGone(db, 'item-000001'); // the partner knew it: tell
await recordGalleryAdd(db, { id: 'item-000004', o: 12, rel: 'Trip/c.jpg', size: 1 });
await recordGalleryGone(db, 'item-000004'); // the partner never knew it: silence
{
  const p = await pendingGallery(db, 400);
  assert.deepEqual(p.gone, ['item-000001']);
  assert.deepEqual(p.entries, []);
  assert.equal(p.ids.length, 1, 'a file added and removed before it was told needs no message');
  await markGallerySent(db, p.ids);
}
await recordGalleryRestored(db, 'item-000001', 'Trip/b.jpg');
{
  const p = await pendingGallery(db, 400);
  assert.deepEqual(p.entries.map((e) => [e.id, e.o]), [['item-000001', 10]], 'a restored file returns to its old place in the order');
}
await recordGalleryAdd(db, { id: 'item-000001', o: 999, rel: 'Trip/b.jpg', size: 6 }); // hide-again / re-add: same id
assert.equal((await db.getFirstAsync('SELECT o FROM gallery_out WHERE item_id = ?', 'item-000001')).o, 10, 'the order of a known id does not move');

// receiver store
{
  const e = (id, p, o, k = 'i') => ({ id, p, k, s: 1, o });
  const batch1 = [e('r-000001', 'Trip/Day 2/b.jpg', 3), e('r-000002', 'Trip/Day 2/a.jpg', 2), e('r-000003', 'Trip/Day 10/x.jpg', 5), e('r-000004', 'Trip/Day 1/y.mp4', 4, 'v'), e('r-000005', 'root.jpg', 1), e('r-000006', 'Other/z.jpg', 6)];
  await applyGalleryManifest(db, batch1, []);
  await applyGalleryManifest(db, batch1, []); // a repeat changes nothing
  await applyGalleryManifest(db, [...batch1].reverse(), []); // nor does another order
  assert.equal((await db.getFirstAsync('SELECT COUNT(*) AS n FROM gallery_items')).n, 6);
  const root = await listGalleryPage(db, '', 0, 50);
  assert.equal(root.total, 3);
  assert.deepEqual(root.rows.map((r) => `${r.type}:${r.name}`), ['folder:Other', 'folder:Trip', 'file:root.jpg'], 'the top level shows folders first');
  const trip = await listGalleryPage(db, 'Trip', 0, 50);
  assert.deepEqual(trip.rows.map((r) => r.name), ['Day 1', 'Day 2', 'Day 10'], 'sub-folders in file-manager order');
  const day2 = await listGalleryPage(db, 'Trip/Day 2', 0, 50);
  assert.deepEqual(day2.rows.map((r) => r.name), ['a.jpg', 'b.jpg'], 'files in the sender\'s copy order (o 2 before 3)');
  assert.equal(await galleryFolderCount(db, 'Trip'), 4);
  assert.equal(await galleryFolderCount(db, 'Trip/Day 2'), 2);
  assert.equal(await galleryFolderCount(db, 'Tri'), 0, 'a folder name that is only a prefix is not counted');
  // paging reads only the page
  const many = Array.from({ length: 250 }, (_, i) => e(`m-${String(i).padStart(6, '0')}`, `Big/IMG_${i}.jpg`, 100 + i));
  for (let i = 0; i < many.length; i += 100) await applyGalleryManifest(db, many.slice(i, i + 100), []);
  const p1 = await listGalleryPage(db, 'Big', 0, 100);
  const p2 = await listGalleryPage(db, 'Big', 100, 100);
  const p3 = await listGalleryPage(db, 'Big', 200, 100);
  assert.deepEqual([p1.rows.length, p2.rows.length, p3.rows.length, p1.total], [100, 100, 50, 250]);
  assert.deepEqual([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.name), many.map((m) => m.p.slice(4)), 'pages join into the exact copy order');
  // a path taken by an older id goes to the new id
  await applyGalleryManifest(db, [e('r-000099', 'Trip/Day 2/a.jpg', 50)], []);
  assert.equal((await db.getAllAsync("SELECT id FROM gallery_items WHERE path = 'Trip/Day 2/a.jpg'")).length, 1);
  // removal: items go, an emptied folder goes, a folder that still has files stays
  await applyGalleryManifest(db, [], ['r-000003']);
  assert.deepEqual((await listGalleryPage(db, 'Trip', 0, 50)).rows.map((r) => r.name), ['Day 1', 'Day 2'], 'Day 10 is empty and gone');
  await applyGalleryManifest(db, [], ['r-000006', 'r-nothing']);
  assert.deepEqual((await listGalleryPage(db, '', 0, 50)).rows.map((r) => r.name), ['Big', 'Trip', 'root.jpg']);
  assert.equal((await db.getFirstAsync("SELECT COUNT(*) AS n FROM gallery_folders WHERE path = 'Trip'")).n, 1);
}
await clearGalleryState(db);
assert.equal((await db.getFirstAsync('SELECT COUNT(*) AS n FROM gallery_items')).n + (await db.getFirstAsync('SELECT COUNT(*) AS n FROM gallery_out')).n + (await db.getFirstAsync('SELECT COUNT(*) AS n FROM gallery_folders')).n, 0, 'unpairing clears both sides');

// ---- picture sizes for the viewer / cover (decided with the owner: 500-700 KB, never below 1080 px)
assert.equal(PREVIEW_MAX_BYTES, 700_000);
assert.equal(BYTE_LIMIT.preview, 700_000);
assert.ok(LADDER.preview.every((s) => s.edge >= 1080), 'the preview is never smaller than 1080 px');
for (let i = 1; i < LADDER.preview.length; i += 1) assert.ok(LADDER.preview[i].edge <= LADDER.preview[i - 1].edge && LADDER.preview[i].quality <= LADDER.preview[i - 1].quality);
assert.ok(LADDER.thumb.every((s) => s.edge >= 320), 'the 256 and 192 px steps of the small thumbnail are gone');
{
  const b64OfSize = (n) => Buffer.alloc(n, 7).toString('base64');
  const out = await fitVariant('preview', async (step) => ({ b64: b64OfSize(step.edge === 1600 ? 900_000 : 650_000), width: step.edge, height: 1000 }));
  assert.ok(b64Bytes(out.b64) <= PREVIEW_MAX_BYTES);
  assert.ok(MEDIA_MAX_DATA_CHARS >= Math.ceil((PREVIEW_MAX_BYTES * 4) / 3), 'a 700 KB picture is accepted by the receiver');
  const master = sodium.randombytes_buf(32);
  const keys = deriveDirectionKeys(sodium, master, 'a');
  const biggest = buildMediaMessage({ from: 'aaaa', ts: head.ts, ref: 'Shared/abc/x.jpg', kind: 'preview', rendered: { b64: b64OfSize(PREVIEW_MAX_BYTES), width: 1600, height: 1200 } });
  const sealed = sealEnvelope(sodium, keys.send, biggest);
  assert.ok(sealed.blob.length < 1024 * 1024, `a 700 KB picture is ${sealed.blob.length} bytes as a blob, under the 1 MB queue limit`);
  assert.ok(decodeMessage(JSON.stringify(biggest)), 'and it passes the receiver check');
}

// ---- wiring (no phone APIs in Node, so the source is read)
{
  const imp = read('src/vault/import.ts');
  assert.ok(/recordGalleryAdd\(db, \{ id: itemId, o: row\.id/.test(imp), 'every copied file is recorded for the partner, ordered by the queue row id');
  assert.ok(/galleryFileAdded\(db\)/.test(imp) && (imp.match(/galleryFlushNow\(db\)/g) ?? []).length === 2, 'pushed while running and when a job ends or pauses');
  assert.ok(!/md5|Crypto\.digest/.test(imp.replace(/md5: null/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'still no checksum in the add engine');
  const trash = read('src/vault/trash.ts');
  assert.ok(/recordGalleryGone/.test(trash) && /recordGalleryRestored/.test(trash));
  assert.ok(/recordGalleryGone/.test(read('src/vault/export.ts')));
  const manage = read('src/partner/manage.ts');
  assert.ok(/registerGalleryFlusher\(flushGalleryManifest\)/.test(manage));
  assert.ok(/onGallery: async/.test(manage) && /applyGalleryManifest/.test(manage));
  assert.ok(/clearGalleryState\(currentDb\)/.test(manage), 'unpairing clears the gallery lists');
  assert.ok(/void flushGalleryManifest\(db\)/.test(manage), 'a reconnect pushes what waited');
  assert.ok(!/shareFileResult|shareImageEncrypted/.test(imp) && !/shareFileResult/.test(read('src/gallery/outbox.ts')), 'no per-file message at add time');
  const inbox = read('src/partner/inbox.ts');
  assert.ok(/startsWith\('gallery-'\)\) && !raw\.id\.startsWith\('e:'\)/.test(inbox), 'only from the encrypted queue');
}
console.log('gallery manifest ok');
