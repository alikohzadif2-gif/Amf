import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/lib/database.ts';
import { readFileSync } from 'node:fs';
import { applyEventMessage, buildEventMessage, deleteEvent, eventSyncAction, getEvent, listEvents, newEventId, parseTags, saveEvent } from '../src/events/events-db.ts';
import { DEFAULT_EVENT_ICON, EVENT_ICONS, eventIconById, eventIconOrDefault, normalizeEventIcon } from '../src/events/icons.ts';
import { encodeMessage } from '../src/partner/messages.ts';
import { migrateEvents, migrateLibrary, migrateMood, migrateStatus } from '../src/lib/database.ts';
import { addDays, countdown, daysBetween, isOnThisDay, isoIn, monthRange, nextOccurrence, occurrenceInYear, occurrencesBetween, todayIso, weekRange, yearsAgo } from '../src/events/recurrence.ts';
import { handleIncoming } from '../src/partner/inbox.ts';
import { decodeMessage } from '../src/partner/messages.ts';
import { partsToIso } from '../src/partner/birthday.ts';

const T = '2026-10-15T00:00:00.000Z'; // a Thursday
const ev = (date, cal, repeat = 'yearly') => ({ date, cal, repeat });

// ---- today / days ----------------------------------------------------------------------------
assert.equal(todayIso(new Date(2026, 9, 15, 23, 59)), T); // local calendar day, not UTC
assert.equal(daysBetween(T, '2026-10-16T13:00:00.000Z'), 1);
assert.equal(daysBetween('2026-10-20T00:00:00.000Z', T), -5);
assert.equal(addDays(T, 20), '2026-11-04T00:00:00.000Z');

// ---- DONE WHEN: a Jalali and a Gregorian anniversary each show the right countdown -------------
{
  // Jalali anniversary typed as 20 Mehr 1399 -> repeats on 20 Mehr every Jalali year
  const jalali = ev(partsToIso('jalali', { year: 1399, month: 7, day: 20 }), 'jalali');
  assert.equal(jalali.date, '2020-10-11T00:00:00.000Z');
  const cj = countdown(jalali, T); // 20 Mehr 1405 (2026-10-12) is already past
  assert.deepEqual(cj, { date: '2027-10-12T00:00:00.000Z', days: 362 });
  // Gregorian anniversary 4 July 2020
  const greg = ev('2020-07-04T00:00:00.000Z', 'gregorian');
  assert.deepEqual(countdown(greg, T), { date: '2027-07-04T00:00:00.000Z', days: 262 });
  // the same stored date repeats differently depending on the calendar it was typed in
  const asGreg = ev('2020-10-11T00:00:00.000Z', 'gregorian');
  assert.equal(nextOccurrence(asGreg, T), '2026-10-11T00:00:00.000Z' < T ? '2027-10-11T00:00:00.000Z' : '2026-10-11T00:00:00.000Z');
  assert.notEqual(nextOccurrence(jalali, T), nextOccurrence(asGreg, T));
  // today is the day itself -> 0 days
  assert.deepEqual(countdown(greg, '2026-07-04T10:00:00.000Z'), { date: '2026-07-04T00:00:00.000Z', days: 0 });
  assert.equal(countdown(ev('2026-10-16T00:00:00.000Z', 'gregorian', null), T).days, 1);
}

// ---- 30 Esfand / 29 Feb land on the last day of a shorter month ---------------------------------
{
  const esfand30 = ev(partsToIso('jalali', { year: 1403, month: 12, day: 30 }), 'jalali'); // 1403 is a leap year
  assert.equal(esfand30.date, '2025-03-20T00:00:00.000Z');
  assert.equal(occurrenceInYear(esfand30, 1404), '2026-03-20T00:00:00.000Z'); // 29 Esfand 1404 (common year)
  assert.equal(occurrenceInYear(esfand30, 1408), '2030-03-20T00:00:00.000Z'); // leap again: 30 Esfand 1408
  assert.deepEqual(countdown(esfand30, '2026-03-10T00:00:00.000Z'), { date: '2026-03-20T00:00:00.000Z', days: 10 });
  const feb29 = ev('2024-02-29T00:00:00.000Z', 'gregorian');
  assert.deepEqual(countdown(feb29, '2025-02-20T00:00:00.000Z'), { date: '2025-02-28T00:00:00.000Z', days: 8 });
  assert.deepEqual(countdown(feb29, '2028-02-20T00:00:00.000Z'), { date: '2028-02-29T00:00:00.000Z', days: 9 });
  assert.equal(isoIn('jalali', 1404, 6, 31), '2025-09-22T00:00:00.000Z'); // 31 Shahrivar 1404
  assert.equal(isoIn('jalali', 1404, 7, 31), isoIn('jalali', 1404, 7, 30)); // Mehr has 30 days: clamped
}

// ---- one-off events, future first dates, ranges -------------------------------------------------
{
  const once = ev('2026-10-01T00:00:00.000Z', 'gregorian', null);
  assert.equal(nextOccurrence(once, T), null); // past one-off: no countdown
  assert.equal(countdown(once, T), null);
  const future = ev('2030-05-05T00:00:00.000Z', 'jalali'); // a yearly event never occurs before its first date
  assert.equal(nextOccurrence(future, T), '2030-05-05T00:00:00.000Z');
  assert.deepEqual(occurrencesBetween(future, '2026-01-01T00:00:00.000Z', '2028-12-31T00:00:00.000Z'), []);
  const greg = ev('2020-07-04T00:00:00.000Z', 'gregorian');
  assert.deepEqual(occurrencesBetween(greg, '2026-07-01T00:00:00.000Z', '2026-07-31T00:00:00.000Z'), ['2026-07-04T00:00:00.000Z']);
  assert.deepEqual(occurrencesBetween(greg, '2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z'), []);
  assert.equal(occurrencesBetween(greg, '2022-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z').length, 4);
  // this week (Saturday start): Sat 10 Oct .. Fri 16 Oct 2026; Sunday start: Sun 11 .. Sat 17; Monday start: Mon 12 .. Sun 18
  assert.deepEqual(weekRange(T, 'sat'), { start: '2026-10-10T00:00:00.000Z', end: '2026-10-16T00:00:00.000Z' });
  assert.deepEqual(weekRange(T, 'sun'), { start: '2026-10-11T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z' });
  assert.deepEqual(weekRange(T, 'mon'), { start: '2026-10-12T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' });
  assert.deepEqual(weekRange('2026-10-10T00:00:00.000Z', 'sat'), { start: '2026-10-10T00:00:00.000Z', end: '2026-10-16T00:00:00.000Z' });
  // this month in each calendar: Mehr 1405 = 23 Sep .. 22 Oct 2026; October 2026
  assert.deepEqual(monthRange('jalali', 1405, 7), { start: '2026-09-23T00:00:00.000Z', end: '2026-10-22T00:00:00.000Z' });
  assert.deepEqual(monthRange('gregorian', 2026, 2), { start: '2026-02-01T00:00:00.000Z', end: '2026-02-28T00:00:00.000Z' });
  // a Jalali event on 20 Mehr is "this month" in the Jalali Mehr range, an event on 1 Aban is not
  const mehr = monthRange('jalali', 1405, 7);
  assert.equal(occurrencesBetween(ev('2020-10-11T00:00:00.000Z', 'jalali'), mehr.start, mehr.end).length, 1);
  assert.equal(occurrencesBetween(ev('2020-10-23T00:00:00.000Z', 'jalali'), mehr.start, mehr.end).length, 0);
}

// ---- on this day -------------------------------------------------------------------------------------
{
  assert.equal(isOnThisDay('2021-10-15T00:00:00.000Z', T, 'gregorian'), true);
  assert.equal(isOnThisDay('2026-10-15T00:00:00.000Z', T, 'gregorian'), false); // this year is not "earlier"
  assert.equal(isOnThisDay('2021-10-14T00:00:00.000Z', T, 'gregorian'), false);
  assert.equal(isOnThisDay('2021-10-15T00:00:00.000Z', T, 'jalali'), true); // 23 Mehr 1400 = 23 Mehr 1405 (same day in both calendars by coincidence)
  assert.equal(isOnThisDay('2021-10-14T00:00:00.000Z', T, 'jalali'), false);
  assert.equal(isOnThisDay('2024-10-14T00:00:00.000Z', T, 'jalali'), true); // 23 Mehr 1403
  assert.equal(isOnThisDay('2024-10-14T00:00:00.000Z', T, 'gregorian'), false);
  assert.equal(yearsAgo('2021-10-15T00:00:00.000Z', T, 'gregorian'), 5);
}

// ---- SQLite: migration 4 + events ---------------------------------------------------------------------
function memoryDb() {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...p) => ({ changes: Number(db.prepare(sql).run(...p).changes) }),
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
  };
}
{
  assert.deepEqual(parseTags('trip, café،trip , ,x'), ['trip', 'café', 'x']);
  assert.match(newEventId((n) => new Uint8Array(n).fill(171)), /^ev(ab){8}$/);
  const db = memoryDb();
  await initializeDatabase(db);
  const names = (await db.getAllAsync('SELECT name FROM migrations ORDER BY version')).map((r) => r.name);
  assert.deepEqual(names, ['phase-1-bootstrap', 'phase-3-library', 'phase-7-mood', 'phase-8-events', 'u13-status', 'u16-events', 'u19-diary', 'r2-event-share', 'r5a-period', 'r6-diary-categories', 'r8a-diary-share', 'diary-replies', 'stories', 'chat-messages', 'media-reactions', 'partner-media', 'vault', 'partner-originals', 'sync-state']);
  const mine = { id: 'ev1', title: 'Anniversary', date: '2020-10-11T00:00:00.000Z', repeat: 'yearly', cal: 'jalali', tags: ['us', 'trip'], mediaKey: 'md5:abc', fromMe: true, updatedAt: '2026-10-01T10:00:00.000Z', description: null, icon: null, surprise: false, photoUri: null, photo: null };
  await saveEvent(db, mine);
  assert.deepEqual(await getEvent(db, 'ev1'), mine);
  await saveEvent(db, { ...mine, title: 'Anniversary 2', tags: [], mediaKey: null, updatedAt: '2026-10-02T10:00:00.000Z' });
  assert.equal((await getEvent(db, 'ev1')).title, 'Anniversary 2');
  assert.equal((await listEvents(db)).length, 1);

  // partner's message: update with newer ts wins but keeps OUR tags and attachment; older ts is ignored
  await saveEvent(db, { ...mine, tags: ['us'], mediaKey: 'md5:abc', updatedAt: '2026-10-02T10:00:00.000Z' });
  const msg = (o) => ({ t: 'event', from: 'p', ts: '2026-10-03T10:00:00.000Z', id: 'ev1', title: 'Renamed', date: '2020-10-12T00:00:00.000Z', ...o });
  await applyEventMessage(db, msg({}), 'gregorian');
  const after = await getEvent(db, 'ev1');
  assert.deepEqual([after.title, after.date, after.tags, after.mediaKey, after.fromMe, after.cal], ['Renamed', '2020-10-12T00:00:00.000Z', ['us'], 'md5:abc', true, 'jalali']);
  await applyEventMessage(db, msg({ ts: '2026-09-01T00:00:00.000Z', title: 'Stale' }), 'gregorian');
  assert.equal((await getEvent(db, 'ev1')).title, 'Renamed');
  // new event from the partner: stored as theirs, default calendar when the message has none, own cal when it has one
  await applyEventMessage(db, msg({ id: 'ev2', repeat: 'yearly' }), 'gregorian');
  await applyEventMessage(db, msg({ id: 'ev3', repeat: 'yearly', cal: 'jalali' }), 'gregorian');
  const [e2, e3] = [await getEvent(db, 'ev2'), await getEvent(db, 'ev3')];
  assert.deepEqual([e2.fromMe, e2.cal, e2.repeat, e2.tags, e2.mediaKey], [false, 'gregorian', 'yearly', [], null]);
  assert.equal(e3.cal, 'jalali');
  // delete message removes it, deleting a missing id is fine
  await applyEventMessage(db, { t: 'event', from: 'p', ts: '2026-10-04T00:00:00.000Z', id: 'ev2', title: '', date: '2026-10-04T00:00:00.000Z', deleted: true }, 'jalali');
  assert.equal(await getEvent(db, 'ev2'), null);
  await deleteEvent(db, 'nope');
  assert.deepEqual((await listEvents(db)).map((e) => e.id), ['ev1', 'ev3']);

  // through the inbox: stored, notified once; a deletion is not notified
  const notes = [];
  const deps = {
    db, deviceId: 'me', setPartner() {}, onUnpaired() {}, replyProfile() {}, prefs: () => ({ mood: true, event: true, diary: true, period: true }),
    notify: (n) => notes.push(n.kind),
    onEvent: (m) => applyEventMessage(db, m, 'jalali'),
  };
  const raw = (o) => ({ id: 'x', time: 1, event: 'message', topic: 't', message: JSON.stringify({ t: 'event', from: 'p', ts: '2026-10-05T00:00:00.000Z', ...o }) });
  assert.equal(await handleIncoming(deps, raw({ id: 'ev9', title: 'Dinner', date: '2026-11-01T00:00:00.000Z' })), 'event');
  assert.equal((await getEvent(db, 'ev9')).title, 'Dinner');
  assert.equal(await handleIncoming(deps, raw({ id: 'ev9', deleted: true })), 'event');
  assert.equal(await getEvent(db, 'ev9'), null);
  assert.deepEqual(notes, ['event']);

  // R1b: diary/period are recognised without a handler (R5b, R8a add them); R3 stores a mood clear (no notification); nothing throws
  const other = (o) => ({ id: 'x', message: JSON.stringify({ from: 'p', ts: '2026-10-06T00:00:00.000Z', ...o }) });
  assert.equal(await handleIncoming(deps, other({ t: 'mood', cleared: true })), 'mood-cleared');
  assert.equal(await handleIncoming(deps, other({ t: 'mood', cleared: true })), 'duplicate', 'same message id twice');
  assert.equal(await handleIncoming(deps, other({ t: 'diary', id: 'd1', title: 'Beach' })), 'diary');
  assert.equal(await handleIncoming(deps, other({ t: 'period', kind: 'started' })), 'period');
  assert.equal(await handleIncoming(deps, other({ t: 'future-type' })), 'invalid');
  assert.deepEqual(notes, ['event']);
}

// ---- message validation for the new fields ---------------------------------------------------------------
{
  const base = { t: 'event', from: 'p', ts: '2026-10-05T00:00:00.000Z' };
  assert.equal(decodeMessage(JSON.stringify({ ...base, id: '', title: 'x', date: base.ts })), null);
  assert.equal(decodeMessage(JSON.stringify({ ...base, id: 'a', title: '', date: base.ts })), null);
  assert.equal(decodeMessage(JSON.stringify({ ...base, id: 'a', title: 'x', date: 'nope' })), null);
  assert.equal(decodeMessage(JSON.stringify({ ...base, id: 'a', title: 'x', date: base.ts, cal: 'lunar' })).cal, undefined);
  assert.equal(decodeMessage(JSON.stringify({ ...base, id: 'a', title: 'x', date: base.ts, cal: 'jalali' })).cal, 'jalali');
  const del = decodeMessage(JSON.stringify({ ...base, id: 'a', deleted: true }));
  assert.deepEqual([del.deleted, del.id], [true, 'a']);
}

// ---- U16: description / icon / surprise ----------------------------------------------------------
{
  const mem = () => {
    const d = new DatabaseSync(':memory:');
    return {
      execAsync: async (sql) => void d.exec(sql),
      runAsync: async (sql, ...p) => ({ changes: Number(d.prepare(sql).run(...p).changes) }),
      getAllAsync: async (sql, ...p) => d.prepare(sql).all(...p),
      getFirstAsync: async (sql, ...p) => d.prepare(sql).get(...p) ?? null,
    };
  };
  const base = { id: 'e1', title: 'Trip', date: '2026-12-01T00:00:00.000Z', repeat: null, cal: 'gregorian', tags: [], mediaKey: null, fromMe: true, updatedAt: '2026-10-01T00:00:00.000Z' };

  // a phone that already ran migrations 1-5 with an old event row (no new columns)
  const old = mem();
  await old.execAsync('CREATE TABLE migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  await migrateLibrary(old);
  await migrateMood(old);
  await migrateEvents(old);
  await migrateStatus(old);
  await old.runAsync("INSERT INTO events (id, title, date, repeat, cal, tags, media_key, from_me, updated_at) VALUES ('old', 'Old', '2020-01-01T00:00:00.000Z', 'yearly', 'jalali', '[]', NULL, 1, '2026-01-01T00:00:00.000Z')");
  await initializeDatabase(old);
  await initializeDatabase(old); // idempotent
  const cols = await old.getAllAsync('PRAGMA table_info(events)');
  for (const c of ['description', 'icon', 'surprise']) assert.equal(cols.filter((x) => x.name === c).length, 1, c);
  const loaded = await getEvent(old, 'old');
  assert.deepEqual([loaded.description, loaded.icon, loaded.surprise], [null, null, false], 'old events load with defaults');
  const surpriseCol = cols.find((x) => x.name === 'surprise');
  assert.equal(surpriseCol.dflt_value, '0');
  assert.ok((await old.getAllAsync('SELECT version FROM migrations')).some((v) => v.version === 6));

  // save / reload / edit
  const db = mem();
  await initializeDatabase(db);
  await saveEvent(db, { ...base, description: '  Dinner at 8\nbring flowers ', icon: 'plane', surprise: true });
  const a = await getEvent(db, 'e1');
  assert.deepEqual([a.description, a.icon, a.surprise], ['Dinner at 8\nbring flowers', 'plane', true]);
  await saveEvent(db, { ...base, description: '   ', icon: 'not-an-icon', surprise: false, updatedAt: '2026-10-02T00:00:00.000Z' });
  const b = await getEvent(db, 'e1');
  assert.deepEqual([b.description, b.icon, b.surprise], [null, null, false], 'blank description -> null, unknown icon -> null');
  // a partner message never touches our description / icon / surprise
  await saveEvent(db, { ...base, description: 'mine', icon: 'cake', surprise: true, updatedAt: '2026-10-03T00:00:00.000Z' });
  await applyEventMessage(db, { t: 'event', from: 'p', ts: '2026-10-04T00:00:00.000Z', id: 'e1', title: 'Renamed', date: base.date }, 'gregorian');
  const c = await getEvent(db, 'e1');
  assert.deepEqual([c.title, c.description, c.icon, c.surprise], ['Renamed', 'mine', 'cake', true]);
  await applyEventMessage(db, { t: 'event', from: 'p', ts: '2026-10-05T00:00:00.000Z', id: 'e9', title: 'Theirs', date: base.date }, 'gregorian');
  const d = await getEvent(db, 'e9');
  assert.deepEqual([d.description, d.icon, d.surprise, d.fromMe], [null, null, false, false], 'partner events have no local details');

  // surprise events are never published
  const full = { ...base, description: null, icon: null, surprise: false };
  const msg = buildEventMessage(full, 'dev', '2026-10-06T00:00:00.000Z');
  assert.equal(msg.title, 'Trip');
  assert.equal(buildEventMessage({ ...full, surprise: true, description: 'secret', icon: 'cake' }, 'dev', '2026-10-06T00:00:00.000Z'), null, 'surprise -> no message');
  const wire = encodeMessage(buildEventMessage({ ...full, description: 'secret', icon: 'cake' }, 'dev', '2026-10-06T00:00:00.000Z'));
  assert.doesNotMatch(wire, /surprise|description|tags|mediaKey|photoUri/, 'R2: surprise, tags and local fields never go over the wire');
  assert.match(wire, /"icon":"cake"/);
  assert.match(wire, /"note":"secret"/, 'R2: the description travels as `note`');
  // R2: photo path, icon and note travel; a message with `icon` replaces icon, note and photo, one without leaves them
  const photoMsg = buildEventMessage({ ...full, icon: null, description: null, photo: 'Shared/e1/e1-abc.jpg', photoUri: 'file:///private/e1.jpg' }, 'dev', '2026-10-06T00:00:00.000Z');
  assert.equal(photoMsg.icon, 'heart', 'no icon -> the default heart is sent, so the receiver knows this is a full message');
  assert.equal(photoMsg.photo, 'Shared/e1/e1-abc.jpg');
  assert.equal(photoMsg.note, undefined);
  assert.doesNotMatch(encodeMessage(photoMsg), /file:|private/, 'the private copy never leaves the phone');
  assert.equal(decodeMessage(encodeMessage(photoMsg)).photo, 'Shared/e1/e1-abc.jpg', 'round trip');
  {
    const r = mem();
    await initializeDatabase(r);
    const at = (n) => `2026-10-0${n}T00:00:00.000Z`;
    const m = (n, o) => ({ t: 'event', from: 'p', ts: at(n), id: 'r1', title: 'Trip', date: base.date, ...o });
    await applyEventMessage(r, m(1, { icon: 'plane', note: 'Pack the tent', photo: 'Shared/r1/a.jpg' }), 'gregorian');
    const x = await getEvent(r, 'r1');
    assert.deepEqual([x.icon, x.description, x.photo, x.photoUri, x.fromMe], ['plane', 'Pack the tent', 'Shared/r1/a.jpg', null, false]);
    await applyEventMessage(r, m(2, { title: 'Trip 2' }), 'gregorian'); // older app: no `icon` -> keeps icon, note, photo
    const y = await getEvent(r, 'r1');
    assert.deepEqual([y.title, y.icon, y.description, y.photo], ['Trip 2', 'plane', 'Pack the tent', 'Shared/r1/a.jpg']);
    await applyEventMessage(r, m(3, { icon: 'cake' }), 'gregorian'); // full message without note/photo -> removed
    const z = await getEvent(r, 'r1');
    assert.deepEqual([z.icon, z.description, z.photo], ['cake', null, null]);
    // our private copy is kept while the shared photo is the one we uploaded, dropped when the partner replaces it
    await saveEvent(r, { ...z, fromMe: true, photoUri: 'file:///mine/r1.jpg', photo: 'Shared/r1/mine.jpg', updatedAt: at(4) });
    await applyEventMessage(r, m(5, { icon: 'cake', photo: 'Shared/r1/mine.jpg' }), 'gregorian');
    assert.equal((await getEvent(r, 'r1')).photoUri, 'file:///mine/r1.jpg');
    await applyEventMessage(r, m(6, { icon: 'cake', photo: 'Shared/r1/theirs.jpg' }), 'gregorian');
    const w = await getEvent(r, 'r1');
    assert.deepEqual([w.photoUri, w.photo], [null, 'Shared/r1/theirs.jpg']);
  }
  assert.deepEqual(buildEventMessage({ id: 'e1', deleted: true }, 'dev', '2026-10-06T00:00:00.000Z').deleted, true);
  assert.equal(eventSyncAction(null, { surprise: false }), 'send');
  assert.equal(eventSyncAction({ surprise: false }, { surprise: false }), 'send');
  assert.equal(eventSyncAction(null, { surprise: true }), 'none', 'new surprise: nothing sent');
  assert.equal(eventSyncAction({ surprise: true }, { surprise: true }), 'none');
  assert.equal(eventSyncAction({ surprise: false }, { surprise: true }), 'delete', 'a shared event turned into a surprise is retracted');
  assert.equal(eventSyncAction({ surprise: true }, { surprise: false }), 'send', 'revealed surprise is shared');
  assert.equal(eventSyncAction({ surprise: true }, null), 'none', 'deleting a surprise sends nothing');
  assert.equal(eventSyncAction({ surprise: false }, null), 'delete');
  const manage = readFileSync(new URL('../src/partner/manage.ts', import.meta.url), 'utf8');
  assert.match(manage, /buildEventMessage\(event, getDeviceId\(\), nowIso\(\)\)/, 'sendEvent goes through the guard');

  // icons
  assert.deepEqual(EVENT_ICONS.map((i) => i.id), ['heart', 'cake', 'party', 'plane', 'glass', 'briefcase', 'dumbbell']);
  assert.equal(new Set(EVENT_ICONS.map((i) => i.mci)).size, 7);
  assert.equal(DEFAULT_EVENT_ICON, 'heart');
  assert.equal(eventIconById('cake').mci, 'cake-variant');
  assert.equal(eventIconById('nope'), undefined);
  assert.equal(normalizeEventIcon('plane'), 'plane');
  assert.equal(normalizeEventIcon('x'), null);
  assert.equal(normalizeEventIcon(null), null);
  assert.equal(eventIconOrDefault(null).id, 'heart');
  assert.equal(eventIconOrDefault('dumbbell').id, 'dumbbell');
  const dict = (l) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/${l}.json`, import.meta.url), 'utf8'));
  for (const l of ['en', 'fa']) for (const i of EVENT_ICONS) assert.ok(dict(l)[i.label], `${l}.${i.label}`);
  for (const l of ['en', 'fa']) for (const key of ['eventUpcoming', 'eventPast', 'eventUpcomingEmpty', 'eventPastEmpty', 'eventSetNextDate', 'eventSurprise']) assert.ok(dict(l)[key], `${l}.${key}`);
  const screen = readFileSync(new URL('../app/(tabs)/events.tsx', import.meta.url), 'utf8');
  const itemUi = readFileSync(new URL('../components/events/EventItem.tsx', import.meta.url), 'utf8');
  const eventRoute = readFileSync(new URL('../app/event.tsx', import.meta.url), 'utf8');
  for (const l of ['en', 'fa']) {
    for (const key of ['eventLoadFailed', 'eventNotFound', 'eventSaveFailed', 'eventDeleteFailed']) {
      assert.ok(dict(l)[key], `${l}.${key}`);
    }
  }
  assert.match(screen, /eventUpcoming/);
  assert.match(screen, /eventPast/);
  assert.match(screen, /setView/);
  assert.match(screen, /<Fab icon="calendar"/);
  assert.match(screen, /router\.push\('\/event'\)/, 'empty-state action opens the create-event route');
  assert.match(screen, /pathname: '\/event', params: view === 'month' \? \{ date: selected \} : \{\}/, 'calendar FAB opens the event route with the selected day');
  assert.match(screen, /setSelected\(isoIn\(kind, next\.y, next\.m, Math\.min\(selectedDay, lastDay\)\)\)/, 'month navigation moves and clamps the selected date');
  assert.match(itemUi, /eventIconOrDefault/);
  assert.match(itemUi, /event\.surprise/);
  assert.match(itemUi, /pathname: '\/event', params: \{ id: event\.id \}/, 'event rows open the edit route');
  assert.match(eventRoute, /useLocalSearchParams<\{ id\?: string; date\?: string \}>/, 'the route accepts create-date and edit-id parameters');
  assert.match(eventRoute, /getEvent\(db, id\)/, 'the edit route loads its event from SQLite');
  assert.match(eventRoute, /actionDisabled=\{loadState !== 'ready' \|\| loadFailed \|\| !title\.trim\(\) \|\| !iso \|\| saving\}/, 'Add/Save requires a loaded event, a title and a valid date, and is off while saving');
  assert.match(eventRoute, /<SegmentedControl<EventCal>/, 'date picker switches between Jalali and Gregorian');
  assert.match(eventRoute, /<WheelPicker[\s\S]*?profileYear[\s\S]*?profileMonth[\s\S]*?profileDay/, 'date picker reuses the shared year/month/day wheel');
  assert.match(eventRoute, /const iso = partsToIso\(cal, parts\)/, 'the selected calendar date is stored as UTC ISO');
  assert.match(eventRoute, /formatDate\(iso, cal, language, digits\)/, 'the selected date label follows calendar, language and digits');
  assert.match(eventRoute, /tags: parseTags\(tags\)/, 'existing tags remain saved while the editor stays hidden');
  assert.match(eventRoute, /<MediaSourceSheet[\s\S]*?onSelect=\{\(source\) => \{ if \(source !== 'files'\) void pickMedia\(source\); \}\}/, 'the event photo source sheet offers only camera and gallery');
  assert.match(eventRoute, /pickEventPhoto\(source, existing\?\.id \?\? newId\)/, 'R2: the event photo is picked for one event and is NOT imported into the Library');
  assert.doesNotMatch(eventRoute, /pickFromSource|importFromPhone/, 'R2: no Library import for the event photo');
  assert.match(eventRoute, /shareFileResult\(id,/, 'R2: the photo is uploaded to Shared/<id>/ before the event message is sent');
  assert.match(eventRoute, /await saveEvent\(db, row\)/, 'Add and Save write through the existing SQLite event store');
  assert.match(eventRoute, /Alert\.alert\(t\('eventDeleteTitle'\), t\('eventDeleteBody'/, 'delete asks for confirmation');
  assert.match(eventRoute, /await deleteEvent\(db, existing\.id\)/, 'confirmed delete uses the existing event store');
  assert.doesNotMatch(eventRoute, /TextInput|eventTags/, 'tags have no visible editor');
}

console.log('events tests ok');
