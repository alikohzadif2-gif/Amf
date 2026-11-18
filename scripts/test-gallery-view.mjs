// Shared gallery, stage 3: thumbnail request message, gallery refs, the load scheduler (concurrency, screen order, scroll, timeouts), paging, wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { shouldWake } from '../src/e2e/transport.ts';
import { initializeDatabase } from '../src/lib/database.ts';
import { GALLERY_COLUMNS, GALLERY_GAP, GALLERY_PAGE, galleryTileWidth } from '../src/gallery/gallery-logic.ts';
import { THUMB_REQ_MAX_IDS } from '../src/gallery/gallery-messages.ts';
import { galleryRef, idOfGalleryRef } from '../src/gallery/gallery-ref.ts';
import { createThumbScheduler } from '../src/gallery/thumb-scheduler.ts';
import { applyGalleryManifest, listGalleryPage } from '../src/gallery/gallery-db.ts';
import { buildMediaMessage, planEviction } from '../src/partner/media-logic.ts';
import { decodeMessage } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const head = { from: 'aaaa', ts: '2026-11-18T10:00:00.000Z' };
const id = (i) => `item-${String(i).padStart(6, '0')}`;

// ---- the request message
{
  const wire = { t: 'gallery-thumb-req', ...head, silent: true, ids: [id(1), id(2), id(3)] };
  const msg = decodeMessage(JSON.stringify(wire));
  assert.equal(msg.t, 'gallery-thumb-req');
  assert.deepEqual(msg.ids, [id(1), id(2), id(3)]);
  assert.equal(shouldWake(wire), false, 'a request never notifies');
  assert.deepEqual(decodeMessage(JSON.stringify({ ...wire, ids: [id(1), id(1), id(2)] })).ids, [id(1), id(2)], 'duplicates are dropped');
  assert.equal(THUMB_REQ_MAX_IDS, 8);
  assert.ok(decodeMessage(JSON.stringify({ ...wire, ids: Array.from({ length: 8 }, (_, i) => id(i)) })));
  for (const bad of [[], Array.from({ length: 9 }, (_, i) => id(i)), ['short'], [id(1), 5], 'item-000001', null, [`${'x'.repeat(65)}`], ['has space in it']]) {
    assert.equal(decodeMessage(JSON.stringify({ ...wire, ids: bad })), null, `rejected: ${JSON.stringify(bad)?.slice(0, 30)}`);
  }
  const got = [];
  const deps = { db: {}, deviceId: 'bbbb', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({ mood: true, event: true, diary: true, period: true }), notify: () => assert.fail('no notification'), onGallery: (m) => got.push(m) };
  assert.equal(await handleIncoming(deps, { id: 'e:1', message: JSON.stringify(wire) }), 'gallery');
  assert.equal(got[0].t, 'gallery-thumb-req');
  assert.equal(await handleIncoming(deps, { id: 'plain-1', message: JSON.stringify(wire) }), 'invalid', 'only from the encrypted queue');
}

// ---- the ref both phones compute
{
  const ref = galleryRef(id(7), 'Trip/Day 1/IMG 0007.jpg');
  assert.equal(ref, `Shared/${id(7)}/IMG 0007.jpg`);
  assert.equal(idOfGalleryRef(ref), id(7));
  assert.equal(galleryRef(id(7), 'a/b:c*d?.jpg'), `Shared/${id(7)}/b_c_d_.jpg`, 'a name is made safe like every shared file name');
  assert.equal(galleryRef(id(7), 'root.mp4'), `Shared/${id(7)}/root.mp4`, 'a file in the root');
  for (const bad of ['', 'Shared/x.jpg', `Other/${id(1)}/a.jpg`, `Shared/${id(1)}/../a.jpg`, `Shared/short/a.jpg`, `Shared/${id(1)}/sub/a.jpg`, `Shared/${id(1)}//a.jpg`]) assert.equal(idOfGalleryRef(bad), null, `not a gallery ref: ${bad}`);
  // the answer is an ordinary media message with this ref and the receiver accepts it
  const media = buildMediaMessage({ ...head, ref, kind: 'thumb', rendered: { b64: Buffer.alloc(20_000, 7).toString('base64'), width: 320, height: 240 } });
  assert.equal(decodeMessage(JSON.stringify(media)).ref, ref);
  assert.equal(media.kind, 'thumb');
}

// ---- layout numbers
assert.equal(GALLERY_COLUMNS, 3);
assert.equal(galleryTileWidth(400, 32), Math.floor((400 - 32 - GALLERY_GAP * 2) / 3));
assert.ok(galleryTileWidth(100, 32) >= 60, 'never a tiny tile');
assert.equal(GALLERY_PAGE, 60);

// ---- the scheduler
function rig(options = {}) {
  let t = 1_000;
  const sent = [];
  const stored = new Set(options.stored ?? []);
  const s = createThumbScheduler({ send: async (ids) => { sent.push(ids); if (options.failSend) throw new Error('offline'); }, has: (i) => stored.has(i), now: () => t, ...options.opts });
  return { s, sent, stored, advance: (ms) => { t += ms; }, flat: () => sent.flat() };
}
{
  // order, batches and the concurrency limit: a folder with 3000 files never has more than 8 asked at once
  const r = rig();
  const all = Array.from({ length: 3000 }, (_, i) => id(i));
  r.s.setWanted(all.slice(0, 30)); // what one screen shows
  assert.equal(r.s.inFlightCount, 8, 'at most 8 at once');
  assert.deepEqual(r.flat(), all.slice(0, 8), 'in screen order, top first');
  assert.ok(r.sent.every((ids) => ids.length <= 4), 'groups of at most 4');
  r.s.arrived(id(0));
  assert.equal(r.s.inFlightCount, 8, 'an arrival frees one slot and the next tile takes it');
  assert.equal(r.flat().at(-1), id(8));
  for (let i = 1; i < 30; i += 1) r.s.arrived(id(i));
  assert.equal(r.flat().length, 30, 'every visible tile was asked for exactly once');
  assert.equal(new Set(r.flat()).size, 30);
  assert.equal(r.s.inFlightCount, 0);
}
{
  // scrolling: tiles that scrolled away before their turn are never asked for; the ones already asked stay asked
  const r = rig();
  const screen1 = Array.from({ length: 20 }, (_, i) => id(i));
  r.s.setWanted(screen1);
  assert.equal(r.flat().length, 8);
  const screen2 = Array.from({ length: 20 }, (_, i) => id(500 + i)); // a fast scroll far down
  r.s.setWanted(screen2);
  assert.equal(r.s.inFlightCount, 8, 'the 8 already asked still count, nothing new goes out');
  assert.ok(!r.flat().some((x) => screen1.indexOf(x) >= 8), 'nothing of the skipped screen was asked');
  for (let i = 0; i < 8; i += 1) r.s.arrived(id(i));
  assert.deepEqual(r.flat().slice(8, 16), screen2.slice(0, 8), 'the new screen is served top first');
  assert.ok(!r.flat().some((x) => x === id(10)), 'tile 10 (never reached) was not asked');
  r.s.setWanted([]);
  for (const x of screen2.slice(0, 8)) r.s.arrived(x);
  assert.equal(r.flat().length, 16, 'leaving the screen asks for nothing more');
}
{
  // already on the phone = never asked; duplicates ignored
  const r = rig({ stored: [id(1), id(3)] });
  r.s.setWanted([id(1), id(2), id(2), id(3), id(4)]);
  assert.deepEqual(r.flat().sort(), [id(2), id(4)]);
}
{
  // no answer: asked again once, then failed; a failed tile waits `retryAfterMs`, or a tap retries at once
  const r = rig({ opts: { timeoutMs: 1000, maxTries: 2, retryAfterMs: 5000 } });
  r.s.setWanted([id(1)]);
  assert.equal(r.flat().length, 1);
  r.s.tick();
  assert.equal(r.flat().length, 1, 'not yet timed out');
  r.advance(1001);
  r.s.tick();
  assert.equal(r.flat().length, 2, 'asked a second time after the timeout');
  r.advance(1001);
  r.s.tick();
  assert.equal(r.s.state(id(1)), 'failed');
  assert.equal(r.flat().length, 2, 'two tries, then it gives up');
  r.advance(2000);
  r.s.setWanted([id(1)]);
  assert.equal(r.flat().length, 2, 'still cooling down');
  r.advance(4000);
  r.s.setWanted([id(1)]);
  assert.equal(r.flat().length, 3, 'tried again after the cool-down');
  r.s.retry(id(1));
  assert.equal(r.s.state(id(1)), 'inflight');
  r.s.arrived(id(1));
  assert.equal(r.s.state(id(1)), 'idle');
  // a timeout frees the slot for the next tile
  const q = rig({ opts: { timeoutMs: 1000, maxInFlight: 2, batch: 2, maxTries: 1 } });
  q.s.setWanted([id(1), id(2), id(3), id(4)]);
  assert.deepEqual(q.flat(), [id(1), id(2)]);
  q.advance(1500);
  q.s.tick();
  assert.deepEqual(q.flat().slice(2), [id(3), id(4)], 'silent files give way to the next ones');
  assert.equal(q.s.state(id(1)), 'failed');
}
{
  // the post itself fails (offline): the ids are free again at once and are tried again, then given up
  const r = rig({ failSend: true, opts: { maxTries: 2 } });
  r.s.setWanted([id(1), id(2)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.s.inFlightCount, 0);
  r.s.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.flat().length, 4, 'two tries for each');
  r.s.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.flat().length, 4);
  assert.equal(r.s.state(id(1)), 'failed');
  r.s.reset();
  assert.equal(r.s.state(id(1)), 'idle');
}
{
  // a scroll through a big folder: every tile asked once, never more than 8 outstanding at any moment
  const r = rig();
  let peak = 0;
  for (let top = 0; top < 600; top += 9) {
    r.s.setWanted(Array.from({ length: 18 }, (_, i) => id(top + i)));
    peak = Math.max(peak, r.s.inFlightCount);
    let before;
    do {
      before = r.flat().length;
      for (const x of r.flat()) r.s.arrived(x); // the partner answers at once in this model
    } while (r.flat().length !== before);
  }
  assert.ok(peak <= 8);
  const asked = r.flat();
  assert.equal(new Set(asked).size, asked.length, 'no tile asked twice');
  assert.ok(asked.length >= 590, 'and every tile that was on screen was served');
}

// ---- lazy listing: a folder of 3000 files is read page by page, in the copy order
function memoryDb() {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...p) => { const r = db.prepare(sql).run(...p); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
    withTransactionAsync: async (fn) => { db.exec('BEGIN'); try { await fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}
{
  const db = memoryDb();
  await initializeDatabase(db);
  const entries = [];
  for (let i = 0; i < 3000; i += 1) entries.push({ id: id(i), p: i % 100 === 0 ? `Big/Sub A/IMG_${i}.jpg` : `Big/IMG_${i}.jpg`, k: 'i', s: 1, o: i + 1 });
  for (let i = 0; i < entries.length; i += 400) await applyGalleryManifest(db, entries.slice(i, i + 400), []);
  const top = await listGalleryPage(db, '', 0, GALLERY_PAGE);
  assert.deepEqual(top.rows.map((r) => `${r.type}:${r.name}`), ['folder:Big'], 'at the top only the folder shows, no file');
  const first = await listGalleryPage(db, 'Big', 0, GALLERY_PAGE);
  assert.equal(first.rows.length, GALLERY_PAGE);
  assert.equal(first.rows[0].type, 'folder', 'sub-folders come before the files');
  assert.equal(first.total, 1 + 2970, 'one sub-folder plus 2970 loose files');
  let seen = [];
  for (let offset = 0; offset < first.total; offset += GALLERY_PAGE) seen = seen.concat((await listGalleryPage(db, 'Big', offset, GALLERY_PAGE)).rows);
  assert.equal(seen.length, first.total, 'the pages cover the folder exactly once');
  const files = seen.filter((r) => r.type === 'file');
  assert.deepEqual(files.map((f) => f.ord), [...files.map((f) => f.ord)].sort((a, b) => a - b), 'files keep the sender\'s order across pages');
}

// ---- wiring (the phone parts cannot run in Node, so the source is read)
{
  const manage = read('src/partner/manage.ts');
  assert.ok(/registerGalleryThumbHooks\(\{/.test(manage) && /t: 'gallery-thumb-req'/.test(manage), 'the receiver posts one silent request');
  assert.ok(/message\.t === 'gallery-thumb-req'\) return serveGalleryThumbs/.test(manage), 'the sender serves requests');
  assert.ok(/isFreshRequest\(message\.ts, Date\.now\(\)\)\) return;\n\s+try \{/.test(manage), 'an old request is dropped while serving too');
  assert.ok(/galleryThumbArrived\(message\.ref\)/.test(manage) && /galleryThumbReset\(\)/.test(manage));
  const serve = read('src/gallery/gallery-serve.ts');
  assert.ok(/item\.state !== 'hidden'/.test(serve), 'a trashed or unhidden file is not served');
  assert.ok(/kind: 'thumb'/.test(manage) && /ensureThumb\(item\.rel/.test(serve) && /makeVideoPoster/.test(serve));
  const source = read('src/gallery/gallery-source.ts');
  assert.ok(/item\.state !== 'hidden'/.test(source));
  const orig = read('src/partner/orig-store.ts');
  assert.equal((orig.match(/vaultSourceForRef\(db, ref\)/g) ?? []).length, 2, 'the original and the preview of a gallery file come from the vault');
  const screen = read('app/gallery.tsx');
  assert.ok(/galleryWant\(visible\)/.test(screen) && /onViewableItemsChanged/.test(screen) && /windowSize=\{5\}/.test(screen), 'only visible tiles are asked for');
  assert.ok(/onEndReached=\{loadMore\}/.test(screen) && /listGalleryPage\(db, folder, offset, limit\)/.test(screen), 'rows are read a page at a time');
  assert.ok(!/requestPartnerOriginal|origFull/.test(screen + read('components/gallery/GalleryTile.tsx')), 'the original is asked for only in the viewer');
  assert.ok(/<SharedViewer path=\{viewing\}.*hideDelete/.test(screen) && /hideDelete = false/.test(read('components/diary/SharedThumb.tsx')));
  assert.ok(/galleryPartnerOpen/.test(read('app/vault.tsx')));
  const tile = read('components/gallery/GalleryTile.tsx');
  assert.ok(/s\.stamp\[id\]/.test(tile) && !/usePartnerMediaVersion/.test(tile), 'a tile redraws only when its own picture arrived');
  assert.ok(!/sharePreviewWifiOnly/.test(read('src/gallery/thumb-client.ts') + read('src/gallery/gallery-serve.ts')), 'thumbnails are not held back by the Wi-Fi switch');
}

// ---- offline copy: what reached this phone from the gallery is kept; the original opens by itself
{
  const gref = (n) => galleryRef(id(n), `F/x${n}.jpg`);
  const rows = [
    { ref: gref(1), kind: 'original', bytes: 5_000_000, used: 1 },
    { ref: gref(2), kind: 'preview', bytes: 400_000, used: 2 },
    { ref: 'Shared/chat-photo-000001/a.jpg', kind: 'preview', bytes: 400_000, used: 3 },
    { ref: 'Shared/chat-photo-000002/b.jpg', kind: 'original', bytes: 3_000_000, used: 4 },
    { ref: gref(3), kind: 'thumb', bytes: 20_000, used: 0 },
  ];
  const pinned = (ref) => ref.startsWith(`Shared/${id(1)}/`) || ref.startsWith(`Shared/${id(2)}/`) || ref.startsWith(`Shared/${id(3)}/`);
  assert.ok(planEviction(rows, 0).some((r) => r.ref === gref(1)), 'without pinning the old gallery original would be evicted');
  const plan = planEviction(rows, 1_000_000, pinned);
  assert.ok(plan.length > 0 && plan.every((r) => !pinned(r.ref)), 'only chat cache is evicted, never a gallery file');
  assert.deepEqual(planEviction(rows, 0, pinned).map((r) => r.ref), ['Shared/chat-photo-000001/a.jpg', 'Shared/chat-photo-000002/b.jpg']);
  assert.deepEqual(planEviction(rows.slice(0, 2), 0, pinned), [], 'gallery files do not count towards the cap');
  const store = read('src/partner/media-store.ts');
  assert.ok(/galleryPinned\(db, rows\.filter/.test(store) && /\(ref\) => pinned\.has\(ref\)/.test(store), 'the cap spares gallery files');
  assert.ok(/pinned\.has\(r\.ref\)/.test(store), 'clear previews spares them too');
  const viewer = read('components/diary/SharedThumb.tsx');
  assert.ok(/autoOriginal && !?path|!autoOriginal \|\| !path \|\| status !== 'available'/.test(viewer) && /isVideoName\(path\) \|\| autoTried\.current === path/.test(viewer), 'a photo loads its original once when opened; videos stay manual');
  assert.ok(/setStatus\('none'\)/.test(viewer), 'never acts on the previous file\'s state');
  assert.ok(/hideDelete autoOriginal/.test(read('app/gallery.tsx')));
}
console.log('gallery view ok');
