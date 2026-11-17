import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, migrateDiary, migrateDiaryCategories } from '../src/lib/database.ts';
import { deleteDiaryEntry, getDiaryEntry, listDiaryEntries, saveDiaryEntry } from '../src/diary/diary-db.ts';
import { DIARY_CATEGORIES, DIARY_NO_CATEGORY, diaryCategoryLabel, diaryCategoryName, isDiaryCategory } from '../src/diary/categories.ts';
import { addCustomCategory, deleteCustomCategory, listCustomCategories } from '../src/diary/category-db.ts';
import { defaultCustomRange, intersectDayRanges, presetCalendar, resolveDateRange } from '../src/diary/date-range.ts';
import { rangeToDays } from '../src/library/date-range.ts';

const dict = Object.fromEntries(['en', 'fa'].map((lang) => [lang, JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'))]));
const diaryListScreen = readFileSync(new URL('../app/(tabs)/diary.tsx', import.meta.url), 'utf8');
const diaryNewScreen = readFileSync(new URL('../app/diary/new.tsx', import.meta.url), 'utf8');
const diaryEntryScreen = readFileSync(new URL('../app/diary/[id].tsx', import.meta.url), 'utf8');
assert.match(diaryListScreen, /<FlatList/, 'The list is a plain FlatList that stays mounted (FlashList remount crashed after saving a memory)');
assert.doesNotMatch(diaryListScreen, /FlashList/);
assert.match(diaryListScreen, /router\.push\('\/diary\/new'/, 'New Entry actions must use the registered route');
assert.match(diaryListScreen, /router\.push\(`\/diary\/\$\{encodeURIComponent\(id\)\}`/, 'Diary cards must open the entry route');
assert.match(diaryNewScreen, /saveDiaryEntry/);
assert.match(diaryNewScreen, /router\.back\(\)/, 'Saving returns to the list so it reloads on focus');
assert.match(diaryNewScreen, /useEffect\(/, 'Opening the photo viewer must not reset an unsaved editor draft on refocus');
assert.doesNotMatch(diaryNewScreen, /useFocusEffect/, 'The create/edit draft is initialized once per route id');
assert.match(diaryNewScreen, /MediaSourceSheet/, 'The diary editor must use the shared camera/gallery sheet');
assert.match(diaryNewScreen, /pickFromSource\(source, \{ multiple: true \}\)/, 'Diary gallery picks must allow the gallery to select its maximum');
assert.doesNotMatch(diaryNewScreen, /max: remaining|imagesOnly: true|slice\(0,\s*4\)/, 'Diary attachments must not be capped or restricted to images');
assert.match(diaryNewScreen, /MOODS\.map|moodItems\.map/, 'The editor reuses the shared mood catalogue');
assert.match(diaryNewScreen, /diaryPhotoRemove/, 'Picked photo thumbnails can be removed');
assert.match(diaryEntryScreen, /getDiaryEntry/);
assert.match(diaryEntryScreen, /useLocalSearchParams/);
assert.match(diaryEntryScreen, /deleteDiaryEntry/);
assert.match(diaryEntryScreen, /Alert\.alert/, 'Deleting an entry must ask for confirmation');
assert.match(diaryEntryScreen, /useViewerStore/);
assert.match(diaryEntryScreen, /item\.lib\.item\.type === 'video'/, 'Diary detail identifies attached videos and opens them in the viewer');
assert.match(diaryEntryScreen, /diaryBookmarkSave|diaryBookmarkRemove/, 'The detail screen can toggle Saved');
assert.match(diaryEntryScreen, /pathname: '\/diary\/new'/, 'Edit opens the shared create/edit route');
const diaryCard = readFileSync(new URL('../components/diary/DiaryCard.tsx', import.meta.url), 'utf8');
const categorySheet = readFileSync(new URL('../components/diary/CategorySheet.tsx', import.meta.url), 'utf8');
assert.match(diaryListScreen, /DiaryCard/, 'R6: the list uses the three-row card');
assert.match(diaryListScreen, /resolveDateRange/, 'R6: the list filters by date range');
assert.match(diaryListScreen, /SortToolbar/, 'Q9: Memories use the shared Time/Type/Date range tool bar');
assert.match(diaryListScreen, /MonthRangePicker/, 'Q9: month-range drawer reused from the Archive');
assert.doesNotMatch(diaryListScreen, /diarySort|DateRangeSheet|diaryNewestFirst/, 'Q9: the old sorting is gone');
assert.match(diaryListScreen, /CategorySheet/, 'R6: categories can be managed from the list');
assert.match(diaryListScreen, /diaryCategoryNone/, 'R6: "No category" filter');
assert.match(diaryNewScreen, /CategorySheet/, 'R6: categories can be created in the editor');
assert.match(diaryNewScreen, /useState<string>\(DIARY_NO_CATEGORY\)/, 'R6: a new memory starts with no category');
assert.match(diaryEntryScreen, /pickFromSource\(source, \{ multiple: true \}\)/, 'R6: photos/videos can be added on the detail screen');
assert.match(diaryEntryScreen, /confirmRemoveMedia/, 'R6: removing media from a memory asks first');
assert.match(diaryCard, /DIARY_CARD_EMOJI_SIZE = 26/, 'mood emoji sits next to the title on the wide card');
assert.match(diaryCard, /extraMedia/, 'the card shows a +N badge for more media');
assert.match(diaryCard, /replied/, 'the card shows "Replied" when the partner answered');
assert.match(diaryCard, /dateLabel/, 'R6: date sits in the card corner');
assert.match(categorySheet, /deleteCustomCategory/);
assert.doesNotMatch(diaryCard, /DIARY_CATEGORIES/, 'The card receives the label; it does not look categories up itself');
for (const lang of ['en', 'fa']) {
  for (const key of [
    'diaryCategoryNone', 'diaryCategoryManage', 'diaryCategoryAddAction', 'diaryCategoryNamePlaceholder', 'diaryCategoryExists',
    'diaryCategoryLimit', 'diaryCategoryFailed', 'diaryCategoryDelete', 'diaryCategoryDeleteTitle', 'diaryCategoryDeleteBody',
    'diaryCategoryCustomEmpty', 'sortTime', 'sortType', 'sortRange', 'rangeApply', 'diaryAddMedia', 'diaryRemoveMediaTitle', 'diaryRemoveMediaBody', 'diaryRemoveMediaAction',
  ]) assert.ok(dict[lang][key], `${lang}.${key}`);
}
for (const lang of ['en', 'fa']) {
  for (const key of [
    'diaryAddPhotos', 'diaryHowFeel', 'diaryPhotoRemove', 'diaryPhotos', 'diaryOpenPhoto',
    'diaryPhotosUnavailable', 'diaryEditEntry', 'diaryDeleteEntry', 'diaryDeleteConfirmTitle',
    'diaryDeleteConfirmBody', 'diaryDeleteConfirmAction', 'diaryDeleteFailed',
    'diaryBookmarkSave', 'diaryBookmarkRemove',
  ]) assert.ok(dict[lang][key], `${lang}.${key}`);
}

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...params) => { const r = db.prepare(sql).run(...params); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    getAllAsync: async (sql, ...params) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql, ...params) => db.prepare(sql).get(...params) ?? null,
  };
}
const db = memoryDb();
await initializeDatabase(db);
await migrateDiary(db); // idempotent
await migrateDiaryCategories(db); // idempotent
assert.equal((await db.getAllAsync('SELECT version FROM migrations WHERE version = 10')).length, 1);
assert.equal((await db.getAllAsync('SELECT version FROM migrations WHERE version = 7')).length, 1);
assert.equal((await db.getAllAsync('PRAGMA table_info(diary)')).length, 11, 'R8a adds from_me and shared_media');
assert.equal((await db.getAllAsync('SELECT version FROM migrations WHERE version = 11')).length, 1);

assert.deepEqual(DIARY_CATEGORIES.map((c) => c.id), ['date-night', 'travel', 'milestone', 'random', 'gift', 'fight-makeup']);
assert.equal(isDiaryCategory('travel'), true);
assert.equal(isDiaryCategory('unknown'), false);
for (const c of DIARY_CATEGORIES) for (const lang of ['en', 'fa']) assert.ok(dict[lang][c.name], `${lang}.${c.name}`);
assert.equal(dict.fa[diaryCategoryName('date-night')], 'قرار');
assert.equal(dict.fa[diaryCategoryName('fight-makeup')], 'دعوا و آشتی');

const entry = (id, overrides = {}) => ({
  id, title: `Title ${id}`, category: 'random', mood: null, body: `Body ${id}`,
  mediaKeys: [], saved: false, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', ...overrides,
});
await saveDiaryEntry(db, entry('one', { title: 'Trip to Kish', category: 'travel', mood: '😊', body: 'سفر عالی بود', mediaKeys: ['a', 'b'], saved: true }));
await saveDiaryEntry(db, entry('two', { title: 'A small gift', category: 'gift', body: 'Bought a book', createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' }));
await saveDiaryEntry(db, entry('three', { title: 'Anniversary', category: 'milestone', body: 'A wonderful day', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' }));
await saveDiaryEntry(db, entry('four', { mediaKeys: ['photo-1', 'photo-2', 'photo-3', 'photo-4'] }));
assert.deepEqual((await getDiaryEntry(db, 'four')).mediaKeys, ['photo-1', 'photo-2', 'photo-3', 'photo-4'], 'Four photos are accepted');
const manyMediaKeys = Array.from({ length: 32 }, (_, index) => `media-${index + 1}`);
await saveDiaryEntry(db, entry('many-media', { mediaKeys: manyMediaKeys }));
assert.deepEqual((await getDiaryEntry(db, 'many-media')).mediaKeys, manyMediaKeys, 'Any number of photo/video library keys round-trips without truncation');
await deleteDiaryEntry(db, 'four');
await deleteDiaryEntry(db, 'many-media');

const loaded = await getDiaryEntry(db, 'one');
assert.equal(loaded.title, 'Trip to Kish');
assert.equal(loaded.category, 'travel');
assert.equal(loaded.mood, '😊');
assert.deepEqual(loaded.mediaKeys, ['a', 'b']);
assert.equal(loaded.saved, true);
assert.equal(await getDiaryEntry(db, 'missing'), null);

// Update preserves the original creation timestamp and updates editable fields.
await saveDiaryEntry(db, { ...loaded, title: '  Updated trip  ', body: 'Revised body, سفر عالی بود', saved: false, updatedAt: '2026-10-17T01:00:00.000Z' });
const updated = await getDiaryEntry(db, 'one');
assert.equal(updated.title, 'Updated trip');
assert.equal(updated.body, 'Revised body, سفر عالی بود');
assert.equal(updated.createdAt, '2026-10-15T00:00:00.000Z');
assert.deepEqual(updated.mediaKeys, ['a', 'b'], 'Editing keeps attached Library keys unless the editor removes them');
assert.equal(updated.saved, false);
assert.equal(updated.updatedAt, '2026-10-17T01:00:00.000Z');

assert.deepEqual((await listDiaryEntries(db, { sort: 'newest' })).map((x) => x.id), ['two', 'one', 'three']);
assert.deepEqual((await listDiaryEntries(db, { sort: 'oldest' })).map((x) => x.id), ['three', 'one', 'two']);
assert.deepEqual((await listDiaryEntries(db, { category: 'gift' })).map((x) => x.id), ['two']);
assert.deepEqual((await listDiaryEntries(db, { category: 'all' })).length, 3);
assert.deepEqual((await listDiaryEntries(db, { saved: true })).map((x) => x.id), []);
assert.deepEqual((await listDiaryEntries(db, { saved: false })).length, 3);
assert.deepEqual((await listDiaryEntries(db, { query: 'updated' })).map((x) => x.id), ['one']);
assert.deepEqual((await listDiaryEntries(db, { query: 'کتاب' })).length, 0);
assert.deepEqual((await listDiaryEntries(db, { query: 'سفر عالی' })).map((x) => x.id), ['one']);
assert.deepEqual((await listDiaryEntries(db, { query: '۱۴۰۵', calendar: 'jalali', language: 'fa', digits: 'persian' })).map((x) => x.id), ['two', 'one', 'three'], 'searches dates formatted in the selected calendar');
assert.deepEqual((await listDiaryEntries(db, { query: 'October', calendar: 'gregorian', language: 'en', digits: 'latin' })).map((x) => x.id), ['two', 'one', 'three']);
assert.deepEqual((await listDiaryEntries(db, { category: 'travel', query: 'book' })).length, 0, 'filters combine');

await assert.rejects(() => saveDiaryEntry(db, entry('bad', { category: 'wrong' })), /Unknown diary category/);
await assert.rejects(() => saveDiaryEntry(db, entry('bad-media', { mediaKeys: ['valid', 42] })), /array of strings/);
await deleteDiaryEntry(db, 'two');
assert.equal(await getDiaryEntry(db, 'two'), null);
assert.deepEqual((await listDiaryEntries(db)).map((x) => x.id), ['one', 'three']);

// ---- R6: custom categories, "no category", date ranges ----
assert.equal(DIARY_NO_CATEGORY, 'none');
await saveDiaryEntry(db, entry('none-entry', { category: 'none' }));
assert.equal((await getDiaryEntry(db, 'none-entry')).category, 'none', '"No category" round-trips');
const addedCat = await addCustomCategory(db, '  Road   trips  ', 'cabc123', ['Travel', 'No category'], '2026-10-19T00:00:00.000Z');
assert.deepEqual(addedCat, { ok: true, category: { id: 'cabc123', name: 'Road trips' } }, 'names are trimmed and single-spaced');
assert.equal((await addCustomCategory(db, 'road TRIPS', 'cdup', [])).reason, 'exists', 'duplicate custom name (any case) is refused');
assert.equal((await addCustomCategory(db, 'travel', 'cres', ['Travel'])).reason, 'exists', 'a built-in name is refused');
assert.equal((await addCustomCategory(db, '   ', 'cempty', [])).reason, 'empty');
assert.deepEqual(await listCustomCategories(db), [{ id: 'cabc123', name: 'Road trips' }]);
await saveDiaryEntry(db, entry('custom-entry', { category: 'cabc123', title: 'Custom one' }));
assert.deepEqual((await listDiaryEntries(db, { category: 'cabc123' })).map((x) => x.id), ['custom-entry'], 'filter by a custom category');
assert.deepEqual((await listDiaryEntries(db, { category: 'none' })).map((x) => x.id), ['none-entry'], 'filter by "No category"');
const labelT = (key) => dict.en[key];
assert.equal(diaryCategoryLabel('cabc123', await listCustomCategories(db), labelT), 'Road trips');
assert.equal(diaryCategoryLabel('travel', [], labelT), 'Travel');
assert.equal(diaryCategoryLabel('none', [], labelT), 'No category');
assert.equal(diaryCategoryLabel('cgone', [], labelT), 'No category', 'an unknown id reads as "No category"');
await assert.rejects(() => saveDiaryEntry(db, entry('bad-custom', { category: 'cnope' })), /Unknown diary category/);
await deleteCustomCategory(db, 'cabc123');
assert.equal((await getDiaryEntry(db, 'custom-entry')).category, 'none', 'memories of a deleted category become "No category"');
assert.equal((await getDiaryEntry(db, 'custom-entry')).title, 'Custom one', 'the memory itself is kept');
assert.deepEqual(await listCustomCategories(db), []);
for (let i = 0; i < 30; i += 1) assert.equal((await addCustomCategory(db, `Cat ${i}`, `cx${i}`, [])).ok, true);
assert.equal((await addCustomCategory(db, 'One too many', 'cover', [])).reason, 'limit', 'at most 30 custom categories');

// Date ranges. 2026-10-19 is a Monday.
const today = '2026-10-19T00:00:00.000Z';
assert.equal(resolveDateRange({ preset: 'all' }, 'gregorian', 'sat', today), null);
assert.deepEqual(resolveDateRange({ preset: 'week' }, 'gregorian', 'sat', today), { from: '2026-10-17', to: '2026-10-23' }, 'week starts on the chosen weekday (Saturday)');
assert.deepEqual(resolveDateRange({ preset: 'week' }, 'gregorian', 'mon', today), { from: '2026-10-19', to: '2026-10-25' });
assert.deepEqual(resolveDateRange({ preset: 'month' }, 'gregorian', 'sat', today), { from: '2026-10-01', to: '2026-10-31' });
assert.deepEqual(resolveDateRange({ preset: 'year' }, 'gregorian', 'sat', today), { from: '2026-01-01', to: '2026-12-31' });
// 27 Mehr 1405 = 2026-10-19: Mehr 1405 runs 23 Sep - 22 Oct 2026; year 1405 runs 21 Mar 2026 - 20 Mar 2027.
assert.deepEqual(resolveDateRange({ preset: 'month' }, 'jalali', 'sat', today), { from: '2026-09-23', to: '2026-10-22' }, 'month follows the Jalali calendar');
assert.deepEqual(resolveDateRange({ preset: 'year' }, 'jalali', 'sat', today), { from: '2026-03-21', to: '2027-03-20' }, 'year follows the Jalali calendar');
assert.deepEqual(resolveDateRange({ preset: 'custom', from: '2026-10-20T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' }, 'gregorian', 'sat', today), { from: '2026-10-10', to: '2026-10-20' }, 'a reversed custom range is swapped');
assert.equal(resolveDateRange({ preset: 'custom', from: '2026-10-20T00:00:00.000Z' }, 'gregorian', 'sat', today), null, 'an incomplete custom range filters nothing');
assert.deepEqual(defaultCustomRange(today), { from: '2026-10-13T00:00:00.000Z', to: today });
assert.equal(presetCalendar('both', 'fa'), 'jalali');
assert.equal(presetCalendar('both', 'en'), 'gregorian');
assert.equal(presetCalendar('gregorian', 'fa'), 'gregorian');

// The range works on the memory's date (inclusive on both ends) and combines with the other filters.
const rdb = memoryDb();
await initializeDatabase(rdb);
for (const [id, at] of [['a', '2026-10-09T23:59:59.000Z'], ['b', '2026-10-10T00:00:00.000Z'], ['c', '2026-10-15T12:00:00.000Z'], ['d', '2026-10-20T23:59:59.000Z'], ['e', '2026-10-21T00:00:00.000Z']]) {
  await saveDiaryEntry(rdb, entry(id, { category: id === 'c' ? 'travel' : 'random', createdAt: at, updatedAt: at }));
}
const range = { from: '2026-10-10', to: '2026-10-20' };
assert.deepEqual((await listDiaryEntries(rdb, { range, sort: 'oldest' })).map((x) => x.id), ['b', 'c', 'd'], 'both ends are inclusive');
assert.deepEqual((await listDiaryEntries(rdb, { range, category: 'travel' })).map((x) => x.id), ['c'], 'range + category combine');
assert.deepEqual((await listDiaryEntries(rdb, { range: null })).length, 5, 'no range = all memories');

// Add / remove media in an existing memory (what the detail screen saves): other fields stay, the date does not move.
await saveDiaryEntry(rdb, entry('m1', { mediaKeys: ['k1'] }));
const m1 = await getDiaryEntry(rdb, 'm1');
await saveDiaryEntry(rdb, { ...m1, mediaKeys: [...m1.mediaKeys, 'k2', 'k3'], updatedAt: '2026-10-19T08:00:00.000Z' });
assert.deepEqual((await getDiaryEntry(rdb, 'm1')).mediaKeys, ['k1', 'k2', 'k3']);
await saveDiaryEntry(rdb, { ...(await getDiaryEntry(rdb, 'm1')), mediaKeys: ['k1', 'k3'], updatedAt: '2026-10-19T08:01:00.000Z' });
const m1b = await getDiaryEntry(rdb, 'm1');
assert.deepEqual(m1b.mediaKeys, ['k1', 'k3']);
assert.equal(m1b.createdAt, '2026-10-15T00:00:00.000Z');
assert.equal(m1b.title, 'Title m1');

// Existing memories (old built-in categories, and a legacy empty value) keep working after the migration.
await rdb.runAsync("INSERT INTO diary (id, title, category, mood, body, media_keys, saved, created_at, updated_at) VALUES ('legacy', 'Old', 'gift', NULL, '', '[]', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
assert.equal((await getDiaryEntry(rdb, 'legacy')).category, 'gift');

// ---- R8a: memories travel to the partner (text, category by name, mood, date, attachment count) ----
{
  const { buildDiaryMessage, applyDiaryMessage } = await import('../src/diary/diary-share.ts');
  const { handleIncoming } = await import('../src/partner/inbox.ts');
  const { encodeMessage } = await import('../src/partner/messages.ts');
  const a = memoryDb(); const b = memoryDb();
  await initializeDatabase(a); await initializeDatabase(b);
  let n = 0; const newId = () => `x${++n}`;
  const ts1 = '2026-10-19T10:00:00.000Z', ts2 = '2026-10-19T11:00:00.000Z';
  // A: a built-in category and a custom one (sent by name, never by its local id)
  await addCustomCategory(a, 'Picnics', 'cA');
  const m1 = entry('r1', { title: 'Beach', body: 'Sun', category: 'travel', mood: '😊', mediaKeys: ['p', 'q'], createdAt: '2026-10-10T00:00:00.000Z' });
  await saveDiaryEntry(a, m1);
  const msg1 = await buildDiaryMessage(a, m1, 'devA', ts1);
  assert.deepEqual(msg1, { t: 'diary', from: 'devA', ts: ts1, id: 'r1', title: 'Beach', body: 'Sun', category: 'travel', mood: '😊', date: '2026-10-10T00:00:00.000Z', mediaCount: 2 });
  assert.ok(encodeMessage(msg1));
  const custom = await buildDiaryMessage(a, entry('r2', { category: 'cA' }), 'devA', ts1, { silent: true });
  assert.equal(custom.category, 'Picnics'); assert.equal(custom.silent, true);
  assert.equal((await buildDiaryMessage(a, entry('r3', { category: 'cGone' }), 'devA', ts1)).category, 'none', 'unknown custom id falls back to none');
  assert.equal((await buildDiaryMessage(a, entry('r4', { title: 'T'.repeat(300), body: 'b'.repeat(5000) }), 'devA', ts1)).body.length, 3000, 'body is cut to what the parser accepts');
  assert.equal(await buildDiaryMessage(a, entry('r5', { fromMe: false }), 'devA', ts1), null, 'a received copy is never sent back');
  assert.deepEqual(await buildDiaryMessage(a, { id: 'r1', deleted: true }, 'devA', ts1), { t: 'diary', from: 'devA', ts: ts1, id: 'r1', deleted: true });

  // B: receives it
  assert.equal(await applyDiaryMessage(b, msg1, newId), 'created');
  const got = await getDiaryEntry(b, 'r1');
  assert.equal(got.title, 'Beach'); assert.equal(got.body, 'Sun'); assert.equal(got.category, 'travel'); assert.equal(got.mood, '😊');
  assert.equal(got.createdAt, '2026-10-10T00:00:00.000Z'); assert.equal(got.fromMe, false); assert.equal(got.sharedMedia, 2); assert.deepEqual(got.mediaKeys, []);
  // custom category by name: created once on B, reused afterwards
  assert.equal(await applyDiaryMessage(b, { ...custom, silent: undefined }, newId), 'created');
  const cat = (await listCustomCategories(b)).find((c) => c.name === 'Picnics');
  assert.ok(cat); assert.equal((await getDiaryEntry(b, 'r2')).category, cat.id);
  await applyDiaryMessage(b, { ...custom, id: 'r2b' }, newId);
  assert.equal((await listCustomCategories(b)).filter((c) => c.name === 'Picnics').length, 1);
  // edit wins, older message ignored, my own memory untouched, partner's local save/bookmark kept
  await saveDiaryEntry(b, { ...(await getDiaryEntry(b, 'r1')), saved: true, updatedAt: '2026-10-19T10:30:00.000Z' });
  assert.equal(await applyDiaryMessage(b, { ...msg1, ts: ts2, title: 'Beach day', mediaCount: 3 }, newId), 'updated');
  const edited = await getDiaryEntry(b, 'r1');
  assert.equal(edited.title, 'Beach day'); assert.equal(edited.sharedMedia, 3); assert.equal(edited.saved, true);
  assert.equal(await applyDiaryMessage(b, { ...msg1, ts: '2026-10-19T09:00:00.000Z', title: 'Old' }, newId), 'ignored');
  assert.equal((await getDiaryEntry(b, 'r1')).title, 'Beach day');
  await saveDiaryEntry(b, entry('mine1', { title: 'Mine' }));
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: ts2, id: 'mine1', title: 'Hijack' }, newId), 'ignored');
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: ts2, id: 'mine1', deleted: true }, newId), 'ignored');
  assert.equal((await getDiaryEntry(b, 'mine1')).title, 'Mine');
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: ts2, id: 'nope' }, newId), 'ignored', 'no title and not known: nothing to show');
  // delete
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: ts2, id: 'r1', deleted: true }, newId), 'deleted');
  assert.equal(await getDiaryEntry(b, 'r1'), null);

  // inbox: stores and notifies (not for silent / deleted / switched off / ignored)
  const notes = [];
  const deps = (diary = true) => ({ db: b, deviceId: 'devB', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({ mood: true, event: true, diary, period: true }), notify: (x) => void notes.push(x), onDiary: (m) => applyDiaryMessage(b, m, newId) });
  const env = (m) => ({ id: '1', message: JSON.stringify(m) });
  assert.equal(await handleIncoming(deps(), env({ ...msg1, id: 'n1', ts: ts2 })), 'diary');
  assert.equal(notes.length, 1); assert.equal(notes[0].kind, 'diary'); assert.equal(notes[0].updated, false);
  await handleIncoming(deps(), env({ ...msg1, id: 'n1', ts: '2026-10-19T12:00:00.000Z', title: 'Again' }));
  assert.equal(notes.length, 2); assert.equal(notes[1].updated, true);
  await handleIncoming(deps(), env({ ...msg1, id: 'n2', ts: ts2, silent: true })); assert.equal(notes.length, 2, 'silent: stored, no notification');
  assert.ok(await getDiaryEntry(b, 'n2'));
  await handleIncoming(deps(false), env({ ...msg1, id: 'n3', ts: ts2 })); assert.equal(notes.length, 2, 'switch off: stored, no notification');
  await handleIncoming(deps(), env({ t: 'diary', from: 'devA', ts: '2026-10-19T13:00:00.000Z', id: 'n1', deleted: true })); assert.equal(notes.length, 2, 'delete: no notification');
  assert.equal(await getDiaryEntry(b, 'n1'), null);
  assert.equal(await handleIncoming(deps(), env({ ...msg1, from: 'devB', id: 'n9' })), 'mine');
  // wiring
  const manage = readFileSync(new URL('../src/partner/manage.ts', import.meta.url), 'utf8');
  assert.match(manage, /export async function sendDiary/); assert.match(manage, /onDiary:/); assert.match(manage, /diaryNotifyBody/);
  assert.match(diaryNewScreen, /sendDiary\(db, next\)/); assert.match(diaryEntryScreen, /sendDiary\(db, \{ id, deleted: true \}\)/); assert.match(diaryEntryScreen, /silent: true/);
  for (const lang of ['en', 'fa']) for (const key of ['diaryNotifyBody', 'diaryNotifyUpdated', 'diarySharedMedia']) assert.ok(dict[lang][key], `${lang}.${key}`);
  assert.match(dict.en.diarySharedMedia, /\{n\}/); assert.match(dict.fa.diarySharedMedia, /\{n\}/);
}
// ---- Replies under a memory: stored locally, travel as `diary` messages with `replyTo`, removed with the memory ----
{
  const { addReply, listReplies, deleteReply, replySummary } = await import('../src/diary/reply-db.ts');
  const { buildDiaryMessage, buildReplyMessage, applyDiaryMessage } = await import('../src/diary/diary-share.ts');
  const { handleIncoming } = await import('../src/partner/inbox.ts');
  const { encodeMessage, decodeMessage } = await import('../src/partner/messages.ts');
  const a = memoryDb(); const b = memoryDb();
  await initializeDatabase(a); await initializeDatabase(b);
  let n = 0; const newId = () => `y${++n}`;
  const t0 = '2026-10-20T10:00:00.000Z', t1 = '2026-10-20T11:00:00.000Z', t2 = '2026-10-20T12:00:00.000Z';

  // local storage: oldest first, empty / duplicate refused, text cut to the limit, own-only delete
  await saveDiaryEntry(a, entry('mem1', { title: 'Shop' }));
  assert.equal(await addReply(a, { id: 'rp1', memoryId: 'mem1', fromMe: true, body: '  Nice  ', createdAt: t1 }), true);
  assert.equal(await addReply(a, { id: 'rp0', memoryId: 'mem1', fromMe: false, body: 'First', createdAt: t0 }), true);
  assert.equal(await addReply(a, { id: 'rp1', memoryId: 'mem1', fromMe: true, body: 'again', createdAt: t2 }), false, 'a replayed id is ignored');
  assert.equal(await addReply(a, { id: 'rpE', memoryId: 'mem1', fromMe: true, body: '   ', createdAt: t2 }), false, 'an empty reply is not stored');
  assert.deepEqual((await listReplies(a, 'mem1')).map((r) => [r.id, r.fromMe, r.body]), [['rp0', false, 'First'], ['rp1', true, 'Nice']]);
  assert.equal(await deleteReply(a, 'rp0', true), false, 'my delete cannot remove the partner\'s reply');
  assert.equal(await deleteReply(a, 'rp0', false), true);
  // the list badge: "answered" = somebody other than the memory's author replied
  await saveDiaryEntry(a, entry('mem2', { title: 'Mine, only I replied' }));
  await addReply(a, { id: 'rp2', memoryId: 'mem2', fromMe: true, body: 'note to self', createdAt: t1 });
  await saveDiaryEntry(a, entry('mem3', { title: 'From partner', fromMe: false }));
  await addReply(a, { id: 'rp3', memoryId: 'mem3', fromMe: true, body: 'I answered', createdAt: t1 });
  const summary = await replySummary(a);
  assert.deepEqual(summary.get('mem1'), { count: 1, answered: false }, 'only my own reply left on my memory');
  assert.deepEqual(summary.get('mem2'), { count: 1, answered: false });
  assert.deepEqual(summary.get('mem3'), { count: 1, answered: true }, 'I answered the partner\'s memory');
  await addReply(a, { id: 'rp4', memoryId: 'mem2', fromMe: false, body: 'from partner', createdAt: t2 });
  assert.equal((await replySummary(a)).get('mem2').answered, true, 'the partner answered my memory');
  // deleting the memory takes its replies along
  await deleteDiaryEntry(a, 'mem2');
  assert.deepEqual(await listReplies(a, 'mem2'), []);

  // wire format: encode -> decode, and a malformed reply is dropped
  const sent = buildReplyMessage({ id: 'rpX', memoryId: 'mem1', body: '  Lovely!  ', createdAt: t1 }, 'devA', t2);
  assert.deepEqual(sent, { t: 'diary', from: 'devA', ts: t2, id: 'rpX', replyTo: 'mem1', text: 'Lovely!', date: t1 });
  assert.deepEqual(decodeMessage(encodeMessage(sent)), sent);
  assert.deepEqual(buildReplyMessage({ id: 'rpX', memoryId: 'mem1', deleted: true }, 'devA', t2), { t: 'diary', from: 'devA', ts: t2, id: 'rpX', replyTo: 'mem1', deleted: true });
  assert.equal(decodeMessage(JSON.stringify({ ...sent, text: '' })), null, 'no words, no reply');
  assert.equal(decodeMessage(JSON.stringify({ ...sent, text: 'x'.repeat(1001) })), null, 'longer than the limit');
  assert.equal(buildReplyMessage({ id: 'rpL', memoryId: 'mem1', body: 'x'.repeat(1500) }, 'devA', t2).text.length, 1000, 'the sender cuts to the parser limit');

  // the partner's phone: has the memory, receives the reply once, never twice, never for an unknown memory
  const memory = await buildDiaryMessage(a, entry('mem1', { title: 'Shop', createdAt: '2026-10-10T00:00:00.000Z' }), 'devA', t0);
  assert.equal(await applyDiaryMessage(b, memory, newId), 'created');
  const notes = [];
  const deps = (diary = true) => ({ db: b, deviceId: 'devB', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({ mood: true, event: true, diary, period: true }), notify: (x) => void notes.push(x), onDiary: (m) => applyDiaryMessage(b, m, newId) });
  const env = (m) => ({ id: '1', message: JSON.stringify(m) });
  assert.equal(await handleIncoming(deps(), env(sent)), 'diary');
  assert.deepEqual((await listReplies(b, 'mem1')).map((r) => [r.id, r.fromMe, r.body]), [['rpX', false, 'Lovely!']], 'stored as the partner\'s reply');
  assert.equal(notes.length, 1); assert.equal(notes[0].msg.replyTo, 'mem1'); assert.equal(notes[0].msg.text, 'Lovely!');
  await handleIncoming(deps(), env(sent)); assert.equal(notes.length, 1, 'a replayed reply does not notify twice');
  assert.equal((await listReplies(b, 'mem1')).length, 1);
  assert.equal(await applyDiaryMessage(b, { ...sent, id: 'rpY', replyTo: 'nope' }, newId), 'ignored', 'unknown memory');
  assert.equal((await getDiaryEntry(b, 'rpX')), null, 'a reply never becomes a memory');
  await handleIncoming(deps(false), env({ ...sent, id: 'rpZ' })); assert.equal(notes.length, 1, 'switched off: stored, no notification');
  assert.equal((await listReplies(b, 'mem1')).length, 2);
  // the partner removes their reply; they cannot remove one of mine; the memory's author cannot be changed by a reply
  await addReply(b, { id: 'rpMine', memoryId: 'mem1', fromMe: true, body: 'mine', createdAt: t2 });
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: t2, id: 'rpMine', replyTo: 'mem1', deleted: true }, newId), 'ignored');
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: t2, id: 'rpX', replyTo: 'mem1', deleted: true }, newId), 'deleted');
  assert.deepEqual((await listReplies(b, 'mem1')).map((r) => r.id).sort(), ['rpMine', 'rpZ']);
  assert.equal((await getDiaryEntry(b, 'mem1')).title, 'Shop', 'the memory itself is untouched by replies');
  // the author deleting the memory removes its replies on the partner's phone too
  assert.equal(await applyDiaryMessage(b, { t: 'diary', from: 'devA', ts: t2, id: 'mem1', deleted: true }, newId), 'deleted');
  assert.deepEqual(await listReplies(b, 'mem1'), []);

  // wiring: screen, sender, notification text, strings
  const manage = readFileSync(new URL('../src/partner/manage.ts', import.meta.url), 'utf8');
  assert.match(manage, /export async function sendDiaryReply/); assert.match(manage, /diaryNotifyReply/);
  assert.match(diaryEntryScreen, /sendDiaryReply\(/); assert.match(diaryEntryScreen, /listReplies\(db, id\)/); assert.match(diaryEntryScreen, /DIARY_REPLY_MAX/);
  assert.match(diaryListScreen, /replySummary\(db\)/, 'the list marks answered memories');
  for (const lang of ['en', 'fa']) for (const key of ['diaryNotifyReply', 'diaryRepliesTitle', 'diaryReplyWaiting', 'diaryReplyFirst', 'diaryReplyPlaceholder', 'diaryReplySend', 'diaryReplyDelete', 'diaryReplyDeleteTitle', 'diaryReplyDeleteBody', 'diaryReplyNotSent', 'diaryReplyFailed', 'diaryReplied', 'diaryBy', 'diaryYou', 'diaryShare', 'diaryEditShort', 'diarySavedShort', 'diaryMenu']) assert.ok(dict[lang][key], `${lang}.${key}`);
  assert.match(dict.en.diaryReplyWaiting, /\{name\}/); assert.match(dict.fa.diaryReplyWaiting, /\{name\}/);
  assert.match(dict.en.diaryBy, /\{name\}/); assert.match(dict.fa.diaryBy, /\{name\}/);
}
// Q2: a memory's category files its media in the Archive; saving can never take the app down.
{
  const { planArchiveCategory } = await import('../src/diary/archive-category.ts');
  const { hasRealDate } = await import('../src/library/merge.ts');
  assert.deepEqual(planArchiveCategory(['a', 'b', 'a'], 'date-night', undefined, {}), { set: ['a', 'b'], clear: [] }, 'new category: every media key once');
  assert.deepEqual(planArchiveCategory(['a', 'b'], 'cX', 'date-night', { a: { category: 'cX' } }), { set: ['b'], clear: [] }, 'custom category; already filed keys are skipped');
  assert.deepEqual(planArchiveCategory(['a', 'b'], DIARY_NO_CATEGORY, 'travel', { a: { category: 'travel' }, b: { category: 'gift' } }), { set: [], clear: ['a'] }, 'back to none: only the memory\'s old category is cleared, a hand-set one stays');
  assert.deepEqual(planArchiveCategory(['a'], DIARY_NO_CATEGORY, undefined, { a: { category: 'gift' } }), { set: [], clear: [] }, 'a new memory without a category never wipes an Archive category');
  assert.deepEqual(planArchiveCategory(['', 'a'], 'gift', 'gift', {}), { set: ['a'], clear: [] }, 'empty keys are ignored');
  assert.equal(hasRealDate('1970-01-01T00:00:00.000Z'), false, 'the epoch is no date');
  assert.equal(hasRealDate('not a date'), false); assert.equal(hasRealDate(null), false); assert.equal(hasRealDate(undefined), false);
  assert.equal(hasRealDate('2026-10-19T00:00:00.000Z'), true);
  const folderRow = readFileSync(new URL('../src/library/ui/FolderRow.tsx', import.meta.url), 'utf8');
  assert.match(folderRow, /hasRealDate\(folderDate\)/, 'folder rows show no date when there is none');
  const media = readFileSync(new URL('../src/diary/diary-media.ts', import.meta.url), 'utf8');
  assert.match(media, /export async function syncMemoryCategoryToArchive/); assert.match(media, /setArchiveMetadata/);
  assert.match(diaryNewScreen, /syncMemoryCategoryToArchive\(next\.mediaKeys, next\.category, record\?\.category, db\)/, 'saving files the media under the category');
  assert.match(diaryEntryScreen, /syncMemoryCategoryToArchive\(mediaKeys, updated\.category, undefined, db\)/, 'media added on the detail screen follows the category');
  assert.match(diaryNewScreen, /InteractionManager\.runAfterInteractions/, 'the send starts after the screen closed');
  assert.match(diaryNewScreen, /\.catch\(\(sendError/, 'a failing send is caught, never unhandled');
  assert.match(diaryNewScreen, /logEvent\('error', `diary save/, 'a save error is logged');
  for (const screen of [diaryNewScreen, diaryEntryScreen]) assert.match(screen, /RouteErrorBoundary as ErrorBoundary/, 'a render error shows the message instead of closing the app');
  const manageSrc = readFileSync(new URL('../src/partner/manage.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(manageSrc, /fileMd5|SHARE_MD5_MAX_BYTES/, 'no file is hashed synchronously on the JS thread (nothing is uploaded; the sync hash is streamed)');
}
console.log('Diary data-layer tests passed.');

// ---- Q9: Memories use the shared Time / Type / Date range tools ----
{
  const today = '2026-10-19';
  assert.deepEqual(resolveDateRange({ preset: 'today' }, 'gregorian', 'monday', today), { from: '2026-10-19', to: '2026-10-19' }, 'Time: today');
  const aban = rangeToDays({ start: { year: 1402, month: 8 }, end: { year: 1402, month: 9 } }, 'jalali');
  assert.deepEqual(aban, { from: '2023-10-23', to: '2023-12-21' }, 'month range as inclusive UTC days');
  assert.deepEqual(intersectDayRanges(null, aban), aban);
  assert.deepEqual(intersectDayRanges(aban, null), aban);
  assert.deepEqual(intersectDayRanges({ from: '2023-01-01', to: '2023-11-30' }, aban), { from: '2023-10-23', to: '2023-11-30' }, 'Time and range overlap');
  const none = intersectDayRanges({ from: '2020-01-01', to: '2020-12-31' }, aban);
  assert.ok(none.from > none.to, 'disjoint ranges give an empty range');
  await saveDiaryEntry(db, entry('q9-aban', { createdAt: '2023-11-05T10:00:00.000Z', updatedAt: '2023-11-05T10:00:00.000Z' }));
  await saveDiaryEntry(db, entry('q9-out', { createdAt: '2024-02-05T10:00:00.000Z', updatedAt: '2024-02-05T10:00:00.000Z' }));
  assert.deepEqual((await listDiaryEntries(db, { range: aban })).map((x) => x.id), ['q9-aban'], 'the month range filters memories');
  assert.deepEqual((await listDiaryEntries(db, { range: aban, sort: 'oldest' })).map((x) => x.id), ['q9-aban'], 'Time oldest + range');
}
