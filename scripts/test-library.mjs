import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toJalaali } from 'jalaali-js';
import { MockProvider } from '../src/storage/mock-provider.ts';
import { FolderLoader } from '../src/library/folder-loader.ts';
import { indexProviders } from '../src/library/indexer.ts';
import {
  groupByPeriod, itemState, matchesQuery, mergeInto, normalizeText, sortRefs, compareEntries,
} from '../src/library/merge.ts';
import { ServerError } from '../src/server/errors.ts';
import { diagnoseSource, issueFromError, worstIssue, ISSUE_TEXT, ITEM_ISSUE_TEXT } from '../src/library/load-issue.ts';
import { LruIndex } from '../src/media/lru.ts';
import { createLimiter } from '../src/media/limiter.ts';

const server = new MockProvider('s', 'server', 0);
const mirror = new MockProvider('d', 'server', 0, false, 'alt');
const kinds = { s: 'server', d: 'server', l: 'local' };

// merged folder: roots are merged by name, files shared by md5 get two refs
const providers = [server, mirror];
const root = new FolderLoader(providers, null);
while (await root.loadMore());
assert.equal(root.entries('name').length, 4, 'four merged roots');
const photos = root.entries('name').find((e) => e.item.name === 'Photos');
assert.equal(photos.refs.length, 2, 'Photos exists on both sources');
const sub = new FolderLoader(providers, photos.refs);
while (await sub.loadMore());
const y2024 = sub.entries('name').find((e) => e.item.name === '2024');
const files = new FolderLoader(providers, y2024.refs);
while (await files.loadMore());
const list = files.entries('name');
assert.ok(list.some((e) => e.refs.length === 2), 'shared files merged');
assert.ok(list.some((e) => e.refs.length === 1), 'unshared files stay single');
assert.equal(list[0].item.type, 'dir', 'folders first');

// state icons
const e2 = list.find((e) => e.refs.length === 2);
assert.equal(itemState(e2, kinds, new Set()), 'cloud-only');
assert.equal(itemState(e2, kinds, new Set([e2.key])), 'backed-up');
const loc = { key: 'k', item: e2.item, refs: [{ sourceId: 'l', itemId: 'x' }] };
assert.equal(itemState(loc, kinds, new Set()), 'local-only');
assert.equal(sortRefs([{ sourceId: 'd', itemId: 'a' }, { sourceId: 'l', itemId: 'b' }], kinds)[0].sourceId, 'l');

// same-source duplicates are not merged
const map = new Map();
const it = (id) => ({ id, parentId: null, name: 'a.jpg', type: 'image', size: 1, mtime: '2024-01-01T00:00:00.000Z' });
mergeInto(map, 's', [it('1'), it('2')]);
assert.equal(map.size, 2);

// index of 5,000 items
const big = new MockProvider('big', 'server', 0, true);
const t0 = Date.now();
const index = await indexProviders([big], () => {});
assert.ok(index.length >= 4990 && index.length <= 5010, `indexed ${index.length}`);
const tNames = Date.now();
const found = index.filter((e) => matchesQuery(e, 'img_0042'));
assert.ok(found.length >= 1);
console.log(`index ${index.length} items in ${tNames - t0} ms, search ${Date.now() - tNames} ms`);

// albums by month/year in both calendars
const toG = (iso) => { const d = new Date(iso); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }; };
const toJ = (iso) => { const d = new Date(iso); const j = toJalaali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); return { year: j.jy, month: j.jm }; };
const media = index.filter((e) => e.item.type === 'image' || e.item.type === 'video');
const gm = groupByPeriod(media, toG, 'month');
const jm = groupByPeriod(media, toJ, 'month');
assert.equal(gm.reduce((n, g) => n + g.entries.length, 0), media.length);
assert.equal(jm.reduce((n, g) => n + g.entries.length, 0), media.length);
assert.ok(gm.length >= 40 && gm[0].id > gm[gm.length - 1].id, 'months sorted newest first');
assert.ok(groupByPeriod(media, toJ, 'year').length <= 6);
const march = groupByPeriod([{ key: 'x', item: { ...it('1'), mtime: '2025-03-21T12:00:00.000Z' }, refs: [] }], toJ, 'month')[0];
assert.deepEqual([march.year, march.month], [1404, 1], '21 Mar 2025 is 1 Farvardin 1404');

// search normalisation
assert.equal(normalizeText('كتاب ۱۲۳ي'), 'کتاب 123ی');
assert.ok(matchesQuery({ key: 'k', item: { ...it('1'), name: 'سفر شمال.jpg' }, refs: [] }, 'شمال'));
assert.ok(matchesQuery({ key: 'k', item: it('1'), refs: [] }, 'trip', ['Trip 2024']));
assert.ok(!matchesQuery({ key: 'k', item: it('1'), refs: [] }, 'zzz'));
assert.ok(compareEntries({ item: { ...it('1'), mtime: '2025-01-01T00:00:00.000Z' } }, { item: { ...it('2'), mtime: '2024-01-01T00:00:00.000Z' } }, 'newest') < 0);

// LRU: cap is enforced, least recently used goes first
const lru = new LruIndex();
for (let i = 0; i < 100; i += 1) lru.put(`k${i}`, `f${i}`, 10);
lru.touch('k0');
const evicted = lru.evictTo(500);
assert.equal(lru.totalBytes, 500);
assert.equal(evicted.length, 50);
assert.ok(lru.has('k0'), 'recently used survives');
assert.ok(!lru.has('k1'), 'oldest evicted');
const copy = new LruIndex(); copy.load(lru.toJSON());
assert.equal(copy.totalBytes, 500);
lru.put('big', 'b', 400);
lru.evictTo(500);
assert.ok(lru.totalBytes <= 500 && lru.has('big'), 'newest item kept');

// limiter never exceeds its concurrency
const run = createLimiter(3);
let active = 0, peak = 0;
await Promise.all(Array.from({ length: 20 }, () => run(async () => {
  active += 1; peak = Math.max(peak, active);
  await new Promise((r) => setTimeout(r, 2));
  active -= 1;
})));
assert.equal(peak, 3);

// U24: the library shell uses the shared controls and keeps the large virtualized grid.
const libraryScreen = readFileSync('app/library.tsx', 'utf8');
const folderRow = readFileSync('src/library/ui/FolderRow.tsx', 'utf8');
const entryCell = readFileSync('src/library/ui/EntryCell.tsx', 'utf8');
const mediaGrid = readFileSync('src/library/ui/MediaGrid.tsx', 'utf8');
assert.match(libraryScreen, /<Chip\b/, 'Library tabs use shared chips');
assert.match(libraryScreen, /<Fab\b/, 'Library import uses a floating action button');
assert.match(libraryScreen, /<MediaSourceSheet/, 'the existing media source sheet remains wired');
assert.match(libraryScreen, /allowFiles/, 'the import sheet keeps Camera, Gallery and Files');
assert.match(libraryScreen, /<FlashList|FolderPage/, 'Library content stays on the existing virtualized pages');
assert.match(folderRow, /IconTile/);
assert.match(entryCell, /radii\.tile/);
assert.match(mediaGrid, /const COLUMNS = 3/);
assert.match(mediaGrid, /<FlashList/);
assert.match(mediaGrid, /onEndReached=\{onEndReached\}/, 'paging is unchanged');

// U25: viewer and Library sheets/pages reuse the shared sheet, inputs and empty states.
const viewer = readFileSync('app/viewer.tsx', 'utf8');
const sheets = readFileSync('src/library/ui/Sheets.tsx', 'utf8');
const pages = readFileSync('src/library/ui/pages.tsx', 'utf8');
assert.match(viewer, /<BottomSheet\b/, 'viewer details use the shared BottomSheet');
assert.match(viewer, /title=\{t\('viewerInfo'\)\}/, 'viewer details keep their localized title');
assert.match(viewer, /setFavorite\(/, 'viewer favorite action remains wired');
assert.match(viewer, /saveOffline\(entry\)/, 'viewer offline action remains wired');
assert.match(sheets, /<BottomSheet\b/, 'tag and album dialogs use the shared BottomSheet');
assert.doesNotMatch(sheets, /\bModal\b/, 'tag and album dialogs do not open a native Modal');
assert.match(sheets, /setTag\(entries, option\.tag, n !== entries\.length\)/, 'tag selection behavior remains wired');
assert.match(sheets, /setAlbumItems\(album\.id, entries, n !== entries\.length\)/, 'album selection behavior remains wired');
assert.match(libraryScreen, /visible=\{sheet === 'tag'\}/, 'tag sheet stays mounted for shared sheet transitions');
assert.match(libraryScreen, /visible=\{sheet === 'album'\}/, 'album sheet stays mounted for shared sheet transitions');
assert.match(pages, /<IconTile\b/, 'Library category and album rows use shared icon tiles');
assert.match(pages, /<EmptyState\b/, 'Library page empty states use the shared empty state');
assert.match(pages, /<Chip\b/, 'Library search filters use shared chips');
assert.match(mediaGrid, /<EmptyState\b/, 'virtualized grid empty states use the shared empty state');

// ---- S4: a source that fails gives a friendly reason, the other sources still show ---------------
{
  const failing = (id, kind, error) => ({
    id, kind, isMock: false,
    capabilities: () => ({ canUpload: false, canDelete: false, supportsChanges: false, needsPermission: false }),
    test: async () => ({ ok: false, code: 'error', latencyMs: 0 }),
    list: async () => { throw error; },
  });
  assert.equal(issueFromError(new ServerError('unauthorized', 401)), 'unauthorized');
  assert.equal(issueFromError(new ServerError('network')), 'unreachable');
  assert.equal(issueFromError(new ServerError('timeout')), 'unreachable');
  assert.equal(issueFromError(new ServerError('http', 502)), 'unreachable');
  assert.equal(issueFromError(new ServerError('http', 404)), 'missing');
  assert.equal(issueFromError(new ServerError('http', 500)), 'error');
  assert.equal(issueFromError(new ServerError('http', 429, 'busy', 30)), 'busy', '429 rate_limited / locked_out: busy, never unauthorized');
  assert.equal(worstIssue(['busy', 'unreachable']), 'busy');
  assert.equal(worstIssue(['busy', 'unauthorized']), 'unauthorized');
  assert.equal(await diagnoseSource({ kind: 'server', test: async () => ({ ok: false, code: 'error', latencyMs: 0, busy: true }) }), 'busy');
  assert.equal(ISSUE_TEXT.busy, 'connBusy');
  assert.equal(issueFromError(new ServerError('protocol', 200)), 'error');
  assert.equal(issueFromError(new Error('boom')), 'error');
  assert.equal(worstIssue([]), null);
  assert.equal(worstIssue(['error', 'missing']), 'missing');
  assert.equal(worstIssue(['missing', 'unreachable', 'unauthorized']), 'unauthorized');
  for (const key of Object.values({ ...ISSUE_TEXT, ...ITEM_ISSUE_TEXT })) {
    for (const lang of ['en', 'fa']) {
      const dict = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
      assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${lang} has ${key}`);
    }
  }

  for (const [error, issue] of [
    [new ServerError('unauthorized', 401), 'unauthorized'],
    [new ServerError('network'), 'unreachable'],
    [new ServerError('http', 404), 'missing'],
  ]) {
    const good = new MockProvider('good', 'server', 0);
    const loader = new FolderLoader([failing('bad', 'server', error), good], null);
    while (await loader.loadMore());
    assert.equal(loader.issue, issue);
    assert.equal(loader.failed, 1);
    const alone = new FolderLoader([new MockProvider('solo', 'server', 0)], null);
    while (await alone.loadMore());
    assert.equal(loader.entries('name').length, alone.entries('name').length, 'the working source still lists its roots');
    assert.ok(alone.entries('name').length > 0);
  }
  const okOnly = new FolderLoader([new MockProvider('ok', 'server', 0)], null);
  while (await okOnly.loadMore());
  assert.equal(okOnly.issue, null);
  // a failing phone source is not described as a server problem
  const phone = new FolderLoader([failing('p', 'local', new Error('permission'))], null);
  while (await phone.loadMore());
  assert.equal(phone.failed, 1);
  assert.equal(phone.issue, null);

  const seen = [];
  const indexed = await indexProviders(
    [failing('bad', 'server', new ServerError('unauthorized', 401)), failing('p', 'local', new Error('x')), new MockProvider('ok', 'server', 0)],
    () => {}, () => false, (sourceId, issue) => seen.push([sourceId, issue]),
  );
  assert.ok(indexed.length > 0, 'files of the working source are still indexed');
  assert.deepEqual(seen, [['bad', 'unauthorized']]);

  const withTest = (kind, result) => ({ kind, test: async () => result });
  assert.equal(await diagnoseSource(withTest('server', { ok: false, code: 'unauthorized', latencyMs: 0 })), 'unauthorized');
  assert.equal(await diagnoseSource(withTest('server', { ok: false, code: 'unavailable', latencyMs: 0 })), 'unreachable');
  assert.equal(await diagnoseSource(withTest('server', { ok: true, code: 'ok', latencyMs: 1 })), 'missing');
  assert.equal(await diagnoseSource(withTest('server', { ok: false, code: 'error', latencyMs: 0 })), 'error');
  assert.equal(await diagnoseSource({ kind: 'server', test: async () => { throw new Error('x'); } }), 'error');
  assert.equal(await diagnoseSource(withTest('local', { ok: true, code: 'ok', latencyMs: 1 })), 'error');
  assert.equal(await diagnoseSource(null), 'error');
}

console.log('library tests passed');

// R7: memory media opens as a grid first; one tap hides/shows the icons in every viewer.
{
  const { useViewerStore } = await import('../src/library/viewer-store.ts');
  const e = (k) => ({ key: k, item: { name: k, type: 'image' }, refs: [] });
  useViewerStore.getState().open([e('a'), e('b'), e('c')], 1, { grid: true });
  assert.equal(useViewerStore.getState().grid, true, 'diary media asks for the grid');
  assert.equal(useViewerStore.getState().index, 1);
  useViewerStore.getState().open([e('a'), e('b')], 0);
  assert.equal(useViewerStore.getState().grid, false, 'Archive/Library open the swipe viewer directly');
  useViewerStore.getState().open([e('a')], 0, { grid: true });
  assert.equal(useViewerStore.getState().grid, false, 'a single item needs no grid');
  const diaryDetail = readFileSync('app/diary/[id].tsx', 'utf8');
  const diaryNew = readFileSync('app/diary/new.tsx', 'utf8');
  const library = readFileSync('app/library.tsx', 'utf8');
  assert.match(diaryDetail, /open\(media, index, \{ grid: true \}\)/, 'diary detail opens the grid');
  assert.match(diaryNew, /open\(media, index, \{ grid: true \}\)/, 'diary editor opens the grid');
  assert.doesNotMatch(library, /grid: true/, 'Library opens the swipe viewer directly');
  assert.match(viewer, /numColumns=\{3\}/, 'viewer has a 3-column tile grid');
  assert.match(viewer, /setChrome\(\(v\) => !v\)/, 'a tap toggles the icons');
  assert.match(viewer, /\{chrome && !vertical \? <SafeAreaView/, "the top icons are hidden when chrome is off (and in reel mode)");
  assert.match(viewer, /Gesture\.Exclusive\(double, single/, 'single tap waits for the double-tap zoom');
  assert.match(viewer, /hardwareBackPress/, 'system back returns from the viewer to the grid');
}
console.log('R7 viewer grid + hidden controls checks passed');

// Q8a: Archive time order (Time tool) + saved default
{
  const { applyTimeOrder, inTimeOrder, isTimeOrder, timeSortMode, DEFAULT_TIME_ORDER, TIME_ORDERS } = await import('../src/library/time-order.ts');
  const now = new Date('2026-10-19T12:00:00Z'); // a Monday
  const mk = (name, mtime, type = 'image') => ({ key: name, item: { name, type, mtime, size: 1 }, refs: [] });
  const list = [
    mk('dir', '1970-01-01T00:00:00Z', 'dir'),
    mk('a-today', '2026-10-19T01:00:00Z'),
    mk('b-3d', '2026-10-16T10:00:00Z'),
    mk('c-lastmonth', '2026-09-30T10:00:00Z'),
    mk('d-lastyear', '2025-12-01T10:00:00Z'),
    mk('e-nodate', '1970-01-01T00:00:00Z'),
  ];
  const names = (order, kind = 'gregorian') => applyTimeOrder(list, order, undefined, kind, now, 0).map((e) => e.key);
  assert.deepEqual(names('all'), ['dir', 'a-today', 'b-3d', 'c-lastmonth', 'd-lastyear', 'e-nodate'], 'all = by name, nothing hidden');
  assert.deepEqual(names('today'), ['dir', 'a-today']);
  assert.deepEqual(names('week'), ['dir', 'a-today', 'b-3d'], 'week = last 7 days, newest first');
  assert.deepEqual(names('month'), ['dir', 'a-today', 'b-3d', 'c-lastmonth'], 'month = the last 31 days (never empty on the 1st of a calendar month)');
  assert.deepEqual(names('year'), ['dir', 'a-today', 'b-3d', 'c-lastmonth'], 'gregorian year; undated files are not in a period');
  assert.deepEqual(names('newest'), ['dir', 'a-today', 'b-3d', 'c-lastmonth', 'd-lastyear', 'e-nodate']);
  assert.deepEqual(names('oldest'), ['dir', 'e-nodate', 'd-lastyear', 'c-lastmonth', 'b-3d', 'a-today']);
  // Jalali month: 2026-10-19 is 27 Mehr 1405; 2026-09-30 is 8 Mehr 1405 -> same Jalali month, same Jalali year
  assert.deepEqual(names('month', 'jalali'), ['dir', 'a-today', 'b-3d', 'c-lastmonth'], 'month is the same in both calendars');
  // a per-item date override moves the file
  const moved = applyTimeOrder(list, 'today', { 'd-lastyear': { date: '2026-10-19T05:00:00Z' } }, 'gregorian', now, 0).map((e) => e.key);
  assert.ok(moved.includes('d-lastyear'), 'archive date override is used');
  assert.equal(inTimeOrder('2026-10-19T23:59:59Z', 'today', now, 'gregorian', 0), true);
  assert.equal(inTimeOrder('2026-10-20T00:00:00Z', 'today', now, 'gregorian', 0), false);
  // local days: in Iran (UTC+3:30) 2026-10-18T21:00Z is already 00:30 on the 19th
  assert.equal(inTimeOrder('2026-10-18T21:00:00Z', 'today', now, 'gregorian', 210), true, 'local day, not UTC day');
  assert.equal(inTimeOrder('2026-10-18T21:00:00Z', 'today', now, 'gregorian', 0), false);
  // the first day of a Jalali month (1 Aban 1405 = 2026-10-23): "this month" still shows the last weeks
  const aban = new Date('2026-10-23T09:00:00Z');
  assert.equal(inTimeOrder('2026-10-10T10:00:00Z', 'month', aban, 'jalali', 210), true, 'month is not empty on the 1st');
  assert.equal(inTimeOrder('2026-09-10T10:00:00Z', 'month', aban, 'jalali', 210), false);
  assert.equal(DEFAULT_TIME_ORDER, 'all');
  assert.equal(TIME_ORDERS.length, 7);
  assert.ok(isTimeOrder('week') && !isTimeOrder('name'));
  assert.equal(timeSortMode('all'), 'name');
  // wiring guards: two views only, default setting, reusable drawer
  const lib = readFileSync(new URL('../app/library.tsx', import.meta.url), 'utf8');
  assert.ok(!/libTabCategories|libTabFavorites/.test(lib), 'only Folders and Albums');
  assert.ok(lib.includes('SortToolbar') && lib.includes('archiveTimeOrder'), 'toolbar + saved default');
  assert.ok(readFileSync(new URL('../src/state/settings-store.ts', import.meta.url), 'utf8').includes("archiveTimeOrder: 'all'"));
  console.log('Q8a time order ok');
}

// Q8b: Type = multi tags on files and folders
{
  const { BUILTIN_TYPES, typeOptions, resolveTypeTag, tagKeyOf, applyTypeFilter, typeLabel } = await import('../src/library/type-tags.ts');
  const en = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'));
  const t = (k) => en[k];
  assert.deepEqual(BUILTIN_TYPES.map((b) => t(b.label)), ['Name', 'Birthday', 'Valentine', 'Anniversary', 'Date', 'University', 'Café', 'Cinema', 'Military service']);
  const opts = typeOptions(['Ali', '@cafe', 'Zed'], t);
  assert.equal(opts.length, 11, 'nine built-ins + two custom (a built-in tag is not repeated)');
  assert.deepEqual(opts.slice(9).map((o) => o.label), ['Ali', 'Zed'], 'custom tags are auto-added after the built-ins');
  assert.equal(resolveTypeTag(' café ', t), '@cafe', 'typing a built-in name uses the built-in');
  assert.equal(resolveTypeTag('Ali', t), 'Ali');
  assert.equal(typeLabel('@cinema', t), 'Cinema');
  const file = { key: 'md5:1', item: { name: 'a.jpg', type: 'image', mtime: '2026-01-01T00:00:00Z', size: 1 }, refs: [{ sourceId: 's', itemId: '/P/a.jpg' }] };
  const dirA = { key: 'dir:Trips', item: { name: 'Trips', type: 'dir', mtime: '', size: 0 }, refs: [{ sourceId: 's', itemId: '/A/Trips' }] };
  const dirB = { key: 'dir:Trips', item: { name: 'Trips', type: 'dir', mtime: '', size: 0 }, refs: [{ sourceId: 's', itemId: '/B/Trips' }] };
  assert.notEqual(tagKeyOf(dirA), tagKeyOf(dirB), 'same folder name in two places = two tag keys');
  assert.equal(tagKeyOf(file), 'md5:1');
  const tags = { [tagKeyOf(file)]: ['@birthday', 'Ali'], [tagKeyOf(dirA)]: ['Ali'] };
  assert.deepEqual(applyTypeFilter([file, dirA, dirB], 'Ali', tags), [file, dirA], 'one custom type filters files and folders');
  assert.deepEqual(applyTypeFilter([file, dirA, dirB], '@birthday', tags), [file], 'several tags per item');
  assert.equal(applyTypeFilter([file], null, tags).length, 1);
  const ud = readFileSync(new URL('../src/library/user-data.ts', import.meta.url), 'utf8');
  assert.ok(ud.includes('tagKeyOf'), 'setTag keys folders by path');
  const lib = readFileSync(new URL('../app/library.tsx', import.meta.url), 'utf8');
  assert.ok(lib.includes("<TagSheet entries={selectedList}"), 'folders can be tagged too');
  console.log('Q8b type tags ok');
}

// Q8c: Date range (month to month, app calendar, UTC filtering)
{
  const { normalizeRange, rangeToUtc, inDateRange, applyDateRange, yearChoices } = await import('../src/library/date-range.ts');
  // Aban 1402 = 2023-10-23 .. 2023-11-21; Azar 1402 = 2023-11-22 .. 2023-12-21
  const r = normalizeRange({ year: 1402, month: 8 }, { year: 1402, month: 9 });
  const u = rangeToUtc(r, 'jalali');
  assert.equal(new Date(u.from).toISOString(), '2023-10-23T00:00:00.000Z');
  assert.equal(new Date(u.to).toISOString(), '2023-12-22T00:00:00.000Z', 'ends at the first day after Azar');
  assert.equal(inDateRange('2023-10-22T23:00:00Z', r, 'jalali'), false);
  assert.equal(inDateRange('2023-10-23T00:00:00Z', r, 'jalali'), true);
  assert.equal(inDateRange('2023-12-21T23:59:00Z', r, 'jalali'), true);
  assert.equal(inDateRange('2023-12-22T00:00:00Z', r, 'jalali'), false);
  assert.equal(inDateRange('1970-01-01T00:00:00Z', r, 'jalali'), false, 'undated files are out');
  // reversed picks are swapped; the last month of a year rolls over
  assert.deepEqual(normalizeRange({ year: 2024, month: 5 }, { year: 2023, month: 2 }), { start: { year: 2023, month: 2 }, end: { year: 2024, month: 5 } });
  const g = rangeToUtc({ start: { year: 2023, month: 11 }, end: { year: 2023, month: 12 } }, 'gregorian');
  assert.equal(new Date(g.to).toISOString(), '2024-01-01T00:00:00.000Z');
  const mk = (name, mtime, type = 'image') => ({ key: name, item: { name, type, mtime, size: 1 }, refs: [] });
  const list = [mk('d', '', 'dir'), mk('in', '2023-11-05T10:00:00Z'), mk('out', '2024-03-01T10:00:00Z')];
  assert.deepEqual(applyDateRange(list, r, undefined, 'jalali').map((e) => e.key), ['d', 'in'], 'folders stay, files filtered');
  assert.deepEqual(applyDateRange(list, { start: { year: 2024, month: 3 }, end: { year: 2024, month: 3 } }, { in: { date: '2024-03-10T00:00:00Z' } }, 'gregorian').map((e) => e.key), ['d', 'in', 'out'], 'Archive date override counts');
  assert.equal(applyDateRange(list, null, undefined, 'jalali').length, 3);
  const yj = yearChoices('jalali', new Date('2026-10-19T00:00:00Z'));
  assert.deepEqual([yj[0], yj[yj.length - 1]], [1405, 1348]);
  assert.equal(yearChoices('gregorian', new Date('2026-10-19T00:00:00Z'))[0], 2026);
  const lib = readFileSync(new URL('../app/library.tsx', import.meta.url), 'utf8');
  assert.ok(lib.includes('MonthRangePicker') && lib.includes('useDateRange'), 'range drawer wired');
  console.log('Q8c date range ok');
}
