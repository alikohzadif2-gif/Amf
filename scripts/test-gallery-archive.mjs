// Shared gallery, stage 5: the partner's gallery as an Archive / Explore source. Only files this phone holds a picture of are listed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/lib/database.ts';
import {
  PARTNER_PREVIEW_ABOVE, PARTNER_SOURCE_ID, buildPartnerTree, listPartner, parsePartnerId, partnerDirId, partnerFileId, partnerMtime, partnerOnlyItemId, statPartner,
} from '../src/gallery/archive-source-logic.ts';
import { applyGalleryManifest, loadedGalleryItems } from '../src/gallery/gallery-db.ts';
import { galleryRef } from '../src/gallery/gallery-ref.ts';
import { applySourceMode, sourceKindsOf } from '../src/library/source-mode.ts';
import { sortRefs } from '../src/library/merge.ts';
import { analyzeStorage } from '../src/tools/storage-stats.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const id = (i) => `item-${String(i).padStart(6, '0')}`;
const ROOT = "Partner's gallery";

// ---- ids
assert.equal(PARTNER_SOURCE_ID, 'partner-gallery');
assert.deepEqual(parsePartnerId(partnerFileId('abc12345')), { type: 'file', id: 'abc12345' });
assert.deepEqual(parsePartnerId(partnerDirId('Trip/Day 1')), { type: 'dir', path: 'Trip/Day 1' });
assert.deepEqual(parsePartnerId(partnerDirId('')), { type: 'dir', path: '' }, 'the top of the partner gallery');
for (const bad of ['fs:file:///x', 'pg:', 'server:1', '', 'pgx:1']) assert.equal(parsePartnerId(bad), null, `not ours: ${bad}`);

// ---- the tree: only loaded media, folders only when something below them is loaded
const item = (i, path, kind = 'i', extra = {}) => ({ id: id(i), path, name: path.slice(path.lastIndexOf('/') + 1), kind, size: 1000 + i, ord: i, used: 1_800_000_000_000 + i, ...extra });
const loaded = [
  item(3, 'Trip/Day 1/IMG_0003.jpg'),
  item(1, 'Trip/Day 1/IMG_0001.jpg'),
  item(2, 'Trip/Day 10/IMG_0002.jpg'),
  item(4, 'Trip/Day 2/clip.mp4', 'v'),
  item(5, 'notes.pdf', 'f'), // not media: never listed
  item(6, 'Loose.jpg'),
];
const tree = buildPartnerTree(loaded);
{
  assert.deepEqual(listPartner(tree, null, ROOT).items.map((x) => [x.id, x.type, x.name, x.parentId]), [['pgd:', 'dir', ROOT, null]], 'one folder at the root');
  assert.deepEqual(listPartner(buildPartnerTree([]), null, ROOT).items, [], 'nothing loaded = no empty folder');
  assert.deepEqual(listPartner(buildPartnerTree([item(5, 'a.pdf', 'f')]), null, ROOT).items, [], 'only a non-media file = nothing');
  const top = listPartner(tree, 'pgd:', ROOT).items;
  assert.deepEqual(top.map((x) => `${x.type}:${x.name}`), ['dir:Trip', 'image:Loose.jpg'], 'folders first, the pdf is left out');
  const trip = listPartner(tree, 'pgd:Trip', ROOT).items;
  assert.deepEqual(trip.map((x) => x.name), ['Day 1', 'Day 2', 'Day 10'], 'sub-folders in file-manager (natural) order');
  assert.ok(trip.every((x) => x.parentId === 'pgd:Trip'));
  const day1 = listPartner(tree, 'pgd:Trip/Day 1', ROOT).items;
  assert.deepEqual(day1.map((x) => x.name), ['IMG_0001.jpg', 'IMG_0003.jpg'], 'files in the sender\'s copy order');
  assert.equal(day1[0].id, `pg:${id(1)}`);
  assert.equal(day1[0].type, 'image');
  assert.equal(day1[0].mime, 'image/jpeg');
  assert.equal(day1[0].size, 1001, 'the real file size from the manifest');
  assert.equal(listPartner(tree, 'pgd:Trip/Day 2', ROOT).items[0].type, 'video');
  assert.deepEqual(listPartner(tree, 'pgd:Nope', ROOT).items, [], 'an unknown folder is empty');
  assert.deepEqual(listPartner(tree, 'fs:file:///x', ROOT).items, [], 'an id of another source is empty');
  assert.deepEqual(listPartner(tree, `pg:${id(1)}`, ROOT).items, [], 'a file has no children');
}
{
  // paging with the cursor (the index walk and the folder loader both use it)
  const many = buildPartnerTree(Array.from({ length: 250 }, (_, i) => item(i + 1, `Big/IMG_${i + 1}.jpg`)));
  let cursor;
  let names = [];
  let pages = 0;
  do {
    const page = listPartner(many, 'pgd:Big', ROOT, cursor, 100);
    names = names.concat(page.items.map((x) => x.name));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(names.length, 250);
  assert.equal(new Set(names).size, 250, 'every file exactly once');
}
{
  // stat
  assert.equal(statPartner(tree, `pg:${id(2)}`, ROOT).name, 'IMG_0002.jpg');
  assert.equal(statPartner(tree, 'pg:missing-id-0', ROOT), null);
  assert.equal(statPartner(tree, `pg:${id(5)}`, ROOT), null, 'a non-media file is unknown');
  assert.equal(statPartner(tree, 'pgd:Trip/Day 1', ROOT).name, 'Day 1');
  assert.equal(statPartner(tree, 'pgd:Trip/Day 1', ROOT).parentId, 'pgd:Trip');
  assert.equal(statPartner(tree, 'pgd:Trip/Day 9', ROOT), null);
  assert.equal(statPartner(tree, 'pgd:', ROOT).name, ROOT);
  assert.equal(statPartner(buildPartnerTree([]), 'pgd:', ROOT), null);
}

// ---- dates: when the thumbnail arrived; no thumbnail = "no date" (under one day after 1970)
{
  assert.equal(partnerMtime(item(1, 'a.jpg', 'i', { used: 1_800_000_000_000 })), new Date(1_800_000_000_000).toISOString());
  const none = Date.parse(partnerMtime(item(1, 'a.mp4', 'v', { used: 0, ord: 123_456_789 })));
  assert.ok(none >= 0 && none < 86_400_000, 'never looks like a real date');
  assert.equal(partnerMtime(item(1, 'a.mp4', 'v', { used: 0, ord: 7 })), partnerMtime(item(1, 'a.mp4', 'v', { used: 0, ord: 7 })), 'stable');
}

// ---- the database side: only gallery files that have a picture on this phone, with real SQLite
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
const store = (db, ref, kind, used) => db.runAsync('INSERT INTO partner_media (ref, kind, file, bytes, w, h, used) VALUES (?, ?, ?, 1, 1, 1, ?)', ref, kind, `${kind}-${ref.length}.jpg`, used);
{
  const db = memoryDb();
  await initializeDatabase(db);
  const entries = [
    { id: id(1), p: 'Trip/IMG_1.jpg', k: 'i', s: 11, o: 1 },
    { id: id(2), p: 'Trip/IMG_2.jpg', k: 'i', s: 12, o: 2 },
    { id: id(3), p: 'Trip/clip.mp4', k: 'v', s: 13, o: 3 },
    { id: id(4), p: 'Trip/never-loaded.jpg', k: 'i', s: 14, o: 4 },
    { id: id(5), p: 'Other/IMG_5.jpg', k: 'i', s: 15, o: 5 },
  ];
  await applyGalleryManifest(db, entries, []);
  await store(db, galleryRef(id(1), 'Trip/IMG_1.jpg'), 'thumb', 5000);
  await store(db, galleryRef(id(1), 'Trip/IMG_1.jpg'), 'preview', 9000); // a preview does not change the date
  await store(db, galleryRef(id(2), 'Trip/IMG_2.jpg'), 'preview', 7000); // preview only: no thumbnail date
  await store(db, galleryRef(id(3), 'Trip/clip.mp4'), 'original', 8000); // a downloaded video with no poster
  await store(db, galleryRef(id(5), 'Other/IMG_5.jpg'), 'thumb', 6000);
  await store(db, 'Shared/chatphoto12345/photo.jpg', 'thumb', 1); // a chat picture: same naming scheme, but not a gallery file
  await store(db, 'Shared/item-000099/ghost.jpg', 'thumb', 2); // a thumbnail of a file that is no longer in the list
  await store(db, 'Backup/whatever.jpg', 'thumb', 3);
  const got = (await loadedGalleryItems(db)).sort((a, b) => a.ord - b.ord);
  assert.deepEqual(got.map((g) => g.id), [id(1), id(2), id(3), id(5)], 'exactly the gallery files with a picture here');
  assert.deepEqual(got.map((g) => g.used), [5000, 0, 0, 6000], 'the date is the thumbnail\'s; no thumbnail = 0');
  assert.deepEqual(got.map((g) => g.size), [11, 12, 13, 15]);
  const t = buildPartnerTree(got);
  assert.deepEqual(listPartner(t, 'pgd:', ROOT).items.map((x) => x.name), ['Other', 'Trip']);
  assert.deepEqual(listPartner(t, 'pgd:Trip', ROOT).items.map((x) => x.name), ['IMG_1.jpg', 'IMG_2.jpg', 'clip.mp4'], 'the unloaded file is not there');
  // unpairing clears the list and the pictures: nothing left to show
  await db.runAsync('DELETE FROM gallery_items');
  await db.runAsync('DELETE FROM partner_media');
  assert.deepEqual(await loadedGalleryItems(db), []);
}
{
  // more loaded files than one SQL chunk (400)
  const db = memoryDb();
  await initializeDatabase(db);
  const entries = Array.from({ length: 1000 }, (_, i) => ({ id: id(i + 1), p: `Big/IMG_${i + 1}.jpg`, k: 'i', s: 1, o: i + 1 }));
  for (let i = 0; i < entries.length; i += 400) await applyGalleryManifest(db, entries.slice(i, i + 400), []);
  for (const e of entries) await store(db, galleryRef(e.id, e.p), 'thumb', 1000 + e.o);
  const got = await loadedGalleryItems(db);
  assert.equal(got.length, 1000);
  assert.equal(new Set(got.map((g) => g.id)).size, 1000);
}

// ---- partner-only entries (the viewer asks the partner's phone only for these)
{
  const kinds = { vault: 'vault', 'partner-gallery': 'partner' };
  assert.equal(partnerOnlyItemId([{ sourceId: 'partner-gallery', itemId: `pg:${id(1)}` }], kinds), id(1));
  assert.equal(partnerOnlyItemId([{ sourceId: 'partner-gallery', itemId: `pg:${id(1)}` }, { sourceId: 'vault', itemId: 'fs:x' }], kinds), null, 'a copy in the vault needs nothing from the partner');
  assert.equal(partnerOnlyItemId([{ sourceId: 'vault', itemId: 'fs:x' }], kinds), null);
  assert.equal(partnerOnlyItemId([], kinds), null);
  assert.equal(partnerOnlyItemId([{ sourceId: 'partner-gallery', itemId: 'pgd:Trip' }], kinds), null, 'a folder is not a file');
}

// ---- Archive "Shared gallery" mode: both sources; a file on both prefers the copy on this phone; the analyzer does not count what is not stored here
{
  assert.deepEqual([...sourceKindsOf('vault')], ['vault', 'partner']);
  const kinds = { vault: 'vault', 'partner-gallery': 'partner' };
  const e = (key, ...sources) => ({ key, item: { id: key, parentId: null, name: `${key}.jpg`, type: 'image', size: 5, mtime: '2026-01-01T00:00:00Z' }, refs: sources.map((sourceId) => ({ sourceId, itemId: 'i' })) });
  assert.deepEqual(applySourceMode([e('a', 'vault'), e('b', 'partner-gallery'), e('c', 'local')], 'vault', { ...kinds, local: 'local' }).map((x) => x.key), ['a', 'b']);
  assert.deepEqual(sortRefs(e('x', 'partner-gallery', 'vault').refs, kinds).map((r) => r.sourceId), ['vault', 'partner-gallery']);
  const stats = analyzeStorage([e('a', 'vault'), e('b', 'partner-gallery'), e('c', 'vault', 'partner-gallery')], kinds);
  assert.equal(stats.total.count, 2, 'the partner-only file is not stored here at that size');
  assert.deepEqual(stats.bySource.partner, { count: 1, bytes: 5 });
}
assert.equal(PARTNER_PREVIEW_ABOVE, 400);

// ---- wiring that has no pure function: read the source
{
  const sources = read('src/state/sources-store.ts');
  assert.ok(/kind: 'partner'/.test(sources) && /version: 7/.test(sources) && /DEFAULT_SOURCES: SourceConfig\[\] = \[VAULT_SOURCE, PARTNER_SOURCE\]/.test(sources), 'the partner source is built in, saved lists get it (v7)');
  assert.ok(/new PartnerGalleryProvider/.test(read('src/storage/registry.ts')));
  const provider = read('src/storage/partner-gallery-provider.ts');
  assert.ok(/readonly kind = 'partner'/.test(provider) && /canUpload: false, canDelete: false/.test(provider), 'read only');
  assert.ok(/partnerEpoch\(\)/.test(provider) && /loadedGalleryItems\(db\)/.test(provider), 'one read per change');
  assert.ok(/getPartnerMedia\(db, ref, size !== undefined && size > PARTNER_PREVIEW_ABOVE/.test(provider), 'big tiles get the preview');
  assert.ok(!/requestPartnerOriginal|gallery-thumb-req|galleryWant/.test(provider), 'listing never asks the partner\'s phone for anything');
  assert.ok(/partnerEpoch\(\)/.test(read('src/library/providers.ts')), 'the index signature moves with the partner side');
  assert.ok(/provider\.kind\)|sourceKindsOf\(source\)\.includes\(provider\.kind\)/.test(read('src/library/ui/pages.tsx')), 'the folder pages list both sources');
  assert.ok(/startArchiveSync\(\)/.test(read('app/_layout.tsx')) && /stopArchiveSync\(\)/.test(read('app/_layout.tsx')));
  const sync = read('src/gallery/archive-sync.ts');
  assert.ok(/status === 'idle'/.test(sync) && /void index\.build\(\)/.test(sync) && !/build\(true\)/.test(sync), 'a quiet, signature-guarded rebuild; never forced, never before a screen asked for the index');
  const viewer = read('app/viewer.tsx');
  assert.ok(/<ArchiveOriginalBar entry=\{entry\} \/>/.test(viewer) && /reloadKey/.test(viewer));
  const bar = read('components/gallery/ArchiveOriginalBar.tsx');
  assert.ok(/requestPartnerOriginal\(ref/.test(bar) && /status !== 'available'/.test(bar), 'the existing original request, only while the original is not here');
  assert.ok(/export const ORIG_MESSAGE/.test(read('components/diary/SharedThumb.tsx')));
}
console.log('gallery archive source: all checks passed');
