// Sharing track, stage 7 (first part): sync conflict rules. Pure logic.
import assert from 'node:assert/strict';
import { MAX_ITEMS, MAX_PENDING_IDS, itemByRef, onBothPhones, refsAffected, applyEvent, deleteForBoth, deleteForMe, digestOf, digestPages, emptyState, newer, parseDigestPage, parseEvent, purgeTombstones, reconcile, tick, HI_ID, TOMBSTONE_MS } from '../src/sync/sync-logic.ts';
import { decodeMessage } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';
import { shouldWake, isTransientMessage } from '../src/e2e/transport.ts';
import { buildMediaMessage } from '../src/partner/media-logic.ts';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const A = 'dev-a';
const B = 'dev-b';
const add = (id, hash, v) => ({ t: 'add', id, hash, name: `${id}.jpg`, folder: 'Photos', v });
const apply = (s, ...evs) => evs.reduce((st, e) => applyEvent(st, e, A), s);

// order: counter first, device id breaks ties
assert.ok(newer({ counter: 2, device: A }, { counter: 1, device: B }));
assert.ok(newer({ counter: 1, device: B }, { counter: 1, device: A }));
assert.ok(!newer({ counter: 1, device: A }, { counter: 1, device: A }));
assert.equal(tick(emptyState(), A).v.counter, 1);

// add is idempotent; a bad hash is refused
let s = apply(emptyState(), add('i1', H1, { counter: 1, device: A }));
assert.deepEqual(apply(s, add('i1', H1, { counter: 1, device: A })), s);
assert.equal(Object.keys(apply(emptyState(), add('x', 'nothex', { counter: 1, device: A })).items).length, 0);

// concurrent renames converge on both phones, whatever the arrival order
const r1 = { t: 'rename', id: 'i1', name: 'from-a.jpg', v: { counter: 5, device: A } };
const r2 = { t: 'rename', id: 'i1', name: 'from-b.jpg', v: { counter: 5, device: B } };
const base = apply(emptyState(), add('i1', H1, { counter: 1, device: A }));
assert.equal(apply(base, r1, r2).items.i1.name, 'from-b.jpg');
assert.equal(apply(base, r2, r1).items.i1.name, 'from-b.jpg');
// name and folder are independent fields
const both = apply(base, r1, { t: 'move', id: 'i1', folder: 'Trips', v: { counter: 3, device: B } });
assert.deepEqual([both.items.i1.name, both.items.i1.folder], ['from-a.jpg', 'Trips']);

// delete for both beats a later edit and the same content coming back
const del = { t: 'del-both', id: 'i1', hash: H1, v: { counter: 6, device: A }, at: 1000 };
const gone = apply(base, del);
assert.equal(Object.keys(gone.items).length, 0);
assert.equal(Object.keys(apply(gone, { t: 'rename', id: 'i1', name: 'late', v: { counter: 99, device: B } }).items).length, 0);
assert.equal(Object.keys(apply(gone, add('i9', H1, { counter: 50, device: B })).items).length, 0, 'same content, new id: still blocked');
assert.equal(Object.keys(apply(gone, add('i9', H2, { counter: 50, device: B })).items).length, 1, 'other content is fine');
// delete arriving before the add (reordered events) still wins
assert.equal(Object.keys(apply(emptyState(), del, add('i1', H1, { counter: 1, device: A })).items).length, 0);
// the tombstone is purged after the trash period; then the content may return
const purged = purgeTombstones(gone, 1000 + TOMBSTONE_MS + 1);
assert.equal(Object.keys(purged.tombstones).length, 0);
assert.equal(Object.keys(apply(purged, add('i9', H1, { counter: 60, device: B })).items).length, 1);
assert.equal(Object.keys(purgeTombstones(gone, 1000 + TOMBSTONE_MS).tombstones).length, 1, 'still kept on the last day');

// delete for me: local only, never comes back by sync, produces no event
const mine = deleteForMe(base, 'i1');
assert.equal(Object.keys(mine.items).length, 0);
assert.equal(Object.keys(apply(mine, add('i7', H1, { counter: 9, device: B })).items).length, 0);
assert.equal(deleteForBoth(emptyState(), 'nope', A, 1).event, null);
const db = deleteForBoth(base, 'i1', A, 5);
assert.equal(db.event.t, 'del-both');
assert.ok(db.event.v.counter > base.clock);

// same hash under two ids: one item, smaller id kept, alias recorded, both devices as holders
const dup = apply(emptyState(), add('i2', H1, { counter: 1, device: A }), add('i1', H1, { counter: 2, device: B }));
assert.deepEqual(Object.keys(dup.items), ['i1']);
assert.deepEqual(dup.items.i1.aliases, ['i2']);
assert.deepEqual(dup.items.i1.holders.sort(), [A, B]);
assert.equal(apply(dup, { t: 'rename', id: 'i2', name: 'via-alias', v: { counter: 7, device: A } }).items.i1.name, 'via-alias', 'an edit by an alias id reaches the item');
const dup2 = apply(emptyState(), add('i1', H1, { counter: 1, device: A }), add('i2', H1, { counter: 2, device: B }));
assert.deepEqual(Object.keys(dup2.items), ['i1'], 'same result in either arrival order');

// reconcile: events only; missing ids reported, never invented
const phoneA = apply(emptyState(), add('i1', H1, { counter: 1, device: A }), { t: 'rename', id: 'i1', name: 'new', v: { counter: 4, device: A } });
const phoneB = apply(emptyState(), add('i1', H1, { counter: 1, device: A }), add('i3', H2, { counter: 2, device: B }));
const plan = reconcile(phoneA, digestOf(phoneB), A);
assert.deepEqual(plan.send.filter((e) => e.t === 'rename').map((e) => e.name), ['new']);
assert.deepEqual(plan.missing, ['i3']);
const withTomb = apply(phoneA, del);
assert.ok(reconcile(withTomb, digestOf(phoneB), A).send.some((e) => e.t === 'del-both'), 'a tombstone the partner lacks is sent');
assert.deepEqual(reconcile(mine, digestOf(apply(emptyState(), add('i1', H1, { counter: 1, device: A }))), A).missing, [], 'a hidden hash is not asked for again');

// convergence: both phones apply the same events in different orders and end identical
const events = [add('i1', H1, { counter: 1, device: A }), r1, r2, { t: 'move', id: 'i1', folder: 'X', v: { counter: 8, device: B } }, add('i2', H2, { counter: 2, device: B }), { t: 'del-both', id: 'i2', hash: H2, v: { counter: 9, device: A }, at: 5 }];
const forward = apply(emptyState(), ...events);
const backward = apply(emptyState(), ...[...events].reverse());
assert.deepEqual(forward.items, backward.items);
assert.deepEqual(forward.tombstones, backward.tombstones);

// ---- untrusted input is validated
const v1 = { counter: 3, device: 'dev-a' };
assert.equal(parseEvent({ t: 'add', id: 'i1', hash: H1, name: 'a.jpg', folder: 'P', v: v1 }).t, 'add');
for (const bad of [null, 5, { t: 'add', id: 'i1', hash: 'xyz', name: 'a', folder: 'P', v: v1 }, { t: 'add', id: '../x', hash: H1, name: 'a', folder: 'P', v: v1 },
  { t: 'add', id: 'i1', hash: H1, name: '', folder: 'P', v: v1 }, { t: 'add', id: 'i1', hash: H1, name: 'a\nb', folder: 'P', v: v1 }, { t: 'rename', id: 'i1', name: 'x'.repeat(256), v: v1 },
  { t: 'rename', id: 'i1', name: 'x', v: { counter: -1, device: 'd' } }, { t: 'rename', id: 'i1', name: 'x', v: { counter: 1.5, device: 'd' } }, { t: 'del-both', id: 'i1', hash: H1, v: v1, at: 0 },
  { t: 'bogus', id: 'i1', v: v1 }]) assert.equal(parseEvent(bad), null, JSON.stringify(bad));

// ---- digest pages: ranges tile the id space; reconcile in a range touches only that range
const many = Array.from({ length: 10 }, (_, k) => add(`i${String(k).padStart(2, '0')}`, String(k).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'), { counter: k + 1, device: A }));
const big = apply(emptyState(), ...many);
const pages = digestPages(big, 4);
assert.equal(pages.length, 3);
assert.equal(pages[0].lo, '');
assert.equal(pages.at(-1).hi, HI_ID);
for (let k = 1; k < pages.length; k += 1) assert.ok(pages[k].lo > pages[k - 1].hi, 'ranges do not overlap');
assert.equal(pages.reduce((n, p) => n + p.items.length, 0), 10);
assert.equal(digestPages(emptyState()).length, 1);
const nobody = digestOf(emptyState());
const first = reconcile(big, nobody, A, { lo: pages[0].lo, hi: pages[0].hi });
assert.equal(first.send.filter((e) => e.t === 'add').length, 4, 'only the ids of this page are offered');
assert.ok(parseDigestPage(JSON.parse(JSON.stringify(pages[1]))));
assert.equal(parseDigestPage({ ...pages[1], page: 9 }), null);
assert.equal(parseDigestPage({ ...pages[1], lo: 'z', hi: 'a' }), null);
assert.equal(parseDigestPage({ ...pages[1], items: [{ id: 'i1', hash: 'bad', nameV: v1, folderV: v1 }] }), null);

// ---- messages on the wire
const head2 = { from: 'dev1', ts: '2026-11-14T10:00:00.000Z' };
const evOk = { t: 'add', id: 'i1', hash: H1, name: 'a.jpg', folder: 'P', v: v1 };
assert.equal(decodeMessage(JSON.stringify({ ...head2, t: 'sync-ev', events: [evOk] })).t, 'sync-ev');
assert.equal(decodeMessage(JSON.stringify({ ...head2, t: 'sync-ev', events: [] })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head2, t: 'sync-ev', events: [evOk, { ...evOk, hash: 'bad' }] })), null, 'one bad event rejects the message');
assert.equal(decodeMessage(JSON.stringify({ ...head2, t: 'sync-ev', events: Array(51).fill(evOk) })), null);
assert.equal(decodeMessage(JSON.stringify({ ...head2, t: 'sync-digest', page: pages[0] })).t, 'sync-digest');
assert.equal(decodeMessage(JSON.stringify({ ...head2, t: 'sync-digest', page: { nope: 1 } })), null);
for (const t of ['sync-ev', 'sync-digest']) assert.equal(shouldWake({ t, silent: true }), false);
const got = [];
const deps = { db: {}, deviceId: 'me', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({}), notify() { assert.fail('never notifies'); }, onSync: (m) => void got.push(m.t) };
assert.equal(await handleIncoming(deps, { id: 'e:s', message: JSON.stringify({ ...head2, t: 'sync-ev', events: [evOk] }) }), 'sync');
assert.deepEqual(got, ['sync-ev']);

// ---- refs: a viewer finds its item; delete-for-both reports the paths to purge; on-both badge
const R1 = 'Shared/m1/photo.jpg';
const R2 = 'Shared/m2/same.jpg';
const withRef = apply(emptyState(), { ...add('i1', H1, { counter: 1, device: A }), ref: R1 });
assert.equal(itemByRef(withRef, R1).id, 'i1');
assert.equal(itemByRef(withRef, 'Shared/none/x.jpg'), null);
assert.equal(onBothPhones(withRef.items.i1), false);
const haved = apply(withRef, { t: 'have', id: 'i1', hash: H1, v: { counter: 4, device: B } });
assert.equal(onBothPhones(haved.items.i1), true, 'two devices reported the content');
assert.equal(onBothPhones(apply(haved, { t: 'have', id: 'i1', hash: H2, v: { counter: 5, device: 'dev-c' } }).items.i1), true);
assert.deepEqual(haved.items.i1.holders.sort(), [A, B]);
assert.equal(onBothPhones(apply(withRef, { t: 'have', id: 'i1', hash: H2, v: { counter: 4, device: B } }).items.i1), false, 'a have for another hash is ignored');
const twoRefs = apply(withRef, { ...add('i0', H1, { counter: 2, device: B }), ref: R2 });
assert.deepEqual(twoRefs.items.i0.refs.sort(), [R1, R2], 'same content under two ids keeps both paths');
const delEv = { t: 'del-both', id: 'i0', hash: H1, v: { counter: 9, device: A }, at: 7 };
assert.deepEqual(refsAffected(twoRefs, delEv).sort(), [R1, R2]);
assert.deepEqual(refsAffected(twoRefs, { t: 'rename', id: 'i0', name: 'x', v: v1 }), []);
assert.equal(itemByRef(apply(twoRefs, delEv), R1), null);
assert.equal(parseEvent({ t: 'add', id: 'i1', hash: H1, name: 'a', folder: 'P', ref: R1, v: v1 }).ref, R1);
for (const badRef of ['/etc/passwd', 'Shared/../x', 'Shared/a\\b', 5, '']) assert.equal(parseEvent({ t: 'add', id: 'i1', hash: H1, name: 'a', folder: 'P', ref: badRef, v: v1 }), null, String(badRef));
assert.ok(reconcile(withRef, digestOf(emptyState()), A).send.some((e) => e.t === 'add' && e.ref === R1), 'a digest repair carries the path');

// ---- floods are capped
let flooded = emptyState();
for (let k = 0; k < MAX_PENDING_IDS + 50; k += 1) flooded = applyEvent(flooded, { t: 'rename', id: `p${k}`, name: 'x', v: { counter: k + 1, device: B } }, A);
assert.equal(Object.keys(flooded.pending).length, MAX_PENDING_IDS);
const full = { ...emptyState(), items: Object.fromEntries(Array.from({ length: MAX_ITEMS }, (_, k) => [`q${k}`, { id: `q${k}`, hash: H2, name: 'n', nameV: v1, folder: 'f', folderV: v1, aliases: [], refs: [], holders: [A] }])) };
assert.equal(Object.keys(applyEvent(full, add('new', H1, { counter: 9, device: B }), A).items).length, MAX_ITEMS, 'no new item beyond the cap');

// ---- channel guard: sync and file messages never count when they come from the plain mailbox
const plainGot = [];
const plainDeps = { ...deps, onSync: () => void plainGot.push('sync'), onOriginal: () => void plainGot.push('orig') };
assert.equal(await handleIncoming(plainDeps, { id: '123', message: JSON.stringify({ ...head2, t: 'sync-ev', events: [evOk] }) }), 'invalid');
assert.equal(await handleIncoming(plainDeps, { id: '124', message: JSON.stringify({ ...head2, t: 'orig-req', rid: 'rid12345abcd', ref: 'Shared/a/b.jpg' }) }), 'invalid');
const mediaPlain = { ...deps, onMedia: () => void plainGot.push('media') };
assert.equal(await handleIncoming(mediaPlain, { id: '125', message: JSON.stringify(buildMediaMessage({ from: 'dev1', ts: head2.ts, ref: 'Shared/a/b.jpg', kind: 'thumb', rendered: { b64: 'AAAAAAAAAAAAAAAAAAAA', width: 10, height: 10 } })) }), 'invalid', 'pictures too');
assert.equal(await handleIncoming(mediaPlain, { id: 'e:125', message: JSON.stringify(buildMediaMessage({ from: 'dev1', ts: head2.ts, ref: 'Shared/a/b.jpg', kind: 'thumb', rendered: { b64: 'AAAAAAAAAAAAAAAAAAAA', width: 10, height: 10 } })) }), 'media', 'the same picture from the encrypted queue is accepted');
assert.deepEqual(plainGot, ['media'], 'only the encrypted one reached the handler');

// ---- file chunks skip the seen list; everything else is recorded
assert.equal(isTransientMessage({ t: 'orig-chunk' }), true);
for (const t of ['orig-meta', 'orig-req', 'sync-ev', 'chat', 'media']) assert.equal(isTransientMessage({ t }), false, t);

console.log('sync logic: ok');
