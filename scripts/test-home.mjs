import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mod from '../src/lib/home.ts';

const m = mod.weekItems ? mod : mod.default;
const { weekItems, weekDays, showConnectCard, daysTogether } = m;

// 2026-10-16 is a Friday
const today = '2026-10-16T00:00:00.000Z';
assert.deepEqual(weekDays(today, 'sat').map((d) => d.slice(8, 10)), ['10', '11', '12', '13', '14', '15', '16'], 'Saturday-first week');
assert.deepEqual(weekDays(today, 'mon').map((d) => d.slice(8, 10)), ['12', '13', '14', '15', '16', '17', '18']);
assert.deepEqual(weekDays(today, 'sun').map((d) => d.slice(8, 10)), ['11', '12', '13', '14', '15', '16', '17']);

const ev = (id, date, repeat = null, cal = 'gregorian') => ({ id, date, repeat, cal });
const events = [
  ev('a', '2026-10-17T00:00:00.000Z'), // tomorrow, one-off
  ev('b', '2026-10-12T00:00:00.000Z'), // Monday, one-off (already passed, same week for Mon/Sun start)
  ev('c', '2020-10-14T00:00:00.000Z', 'yearly'), // yearly, falls on 14 Oct this year
  ev('d', '2026-11-01T00:00:00.000Z'), // next month: never
  ev('e', '2027-10-15T00:00:00.000Z', 'yearly'), // yearly but first date is next year: not this week
];
// Saturday start: 10..16 Oct -> b (12), c (14); a (17) is next week
const sat = weekItems(events, today, 'sat');
assert.deepEqual(sat.map((i) => i.event.id), ['b', 'c']);
assert.deepEqual(sat.map((i) => i.days), [-4, -2], 'days from today (negative = already passed this week)');
// Monday start: 12..18 Oct -> b, c, a
const mon = weekItems(events, today, 'mon');
assert.deepEqual(mon.map((i) => i.event.id), ['b', 'c', 'a']);
assert.deepEqual(mon.map((i) => i.days), [-4, -2, 1]);
assert.ok(mon.every((i, k) => k === 0 || mon[k - 1].date <= i.date), 'oldest first');
// a yearly event shows the date of this year's occurrence, not its first date
assert.equal(mon.find((i) => i.event.id === 'c').date.slice(0, 10), '2026-10-14');
assert.deepEqual(weekItems([], today, 'sat'), []);

// Connect card: real pairing action when enabled, hidden once paired
assert.equal(showConnectCard(false, false), 'shell');
assert.equal(showConnectCard(false, true), 'shell');
assert.equal(showConnectCard(true, false), 'pair');
assert.equal(showConnectCard(true, true), 'hidden');

// days together: same number as the widget (one formula), 0 on the day itself, never negative
const { buildModel } = await import('../src/widget/model.ts');
const now = new Date('2026-10-16T09:00:00');
assert.equal(daysTogether('2026-10-16T00:00:00.000Z', today), 0);
assert.equal(daysTogether('2026-10-06T00:00:00.000Z', today), 10);
assert.equal(daysTogether('2026-12-01T00:00:00.000Z', today), 0, 'future date never negative');
const wm = buildModel({ togetherSince: '2026-10-06T00:00:00.000Z' }, { language: 'en', digits: 'latin' }, now);
assert.equal(wm.days, String(daysTogether('2026-10-06T00:00:00.000Z', '2026-10-16T00:00:00.000Z')), 'widget value equals the Home card');
assert.equal(buildModel(null, { language: 'en' }, now).days, null, 'no date: the widget and the card show the set-date hint');

// wiring
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const home = read('../app/(tabs)/index.tsx');
assert.match(home, /Fab floating aboveTabBar icon="camera"/, 'camera FAB');
assert.match(home, /router\.push\('\/story\/new'\)/, 'the camera FAB opens the story camera (phase 4)');
assert.match(home, /storyMenuView/, 'avatar menu: View story (phase 6)');
assert.match(home, /myRing === 'none' \? router\.push\('\/settings'\)/, 'no story: the avatar goes straight to Settings');
assert.match(home, /weekItems\(events, today, weekStart\)/, 'week start from Settings');
assert.match(home, /SectionLabel label=\{t\('homeThisWeek'\)\}/);
assert.match(home, /ConnectCardShell/);
const homeStatus = read('../components/home/HomeStatus.tsx');
assert.match(homeStatus, /Feather name="bell"/, 'the reference clip has a bell in the header');
assert.doesNotMatch(home, /t\('brand'\)/, 'plain greeting title, not the brand');
assert.doesNotMatch(home, /MyStatusCard|latestMood\(db, true\)/, 'R2: no My status card on Home');
const motion = read('../src/lib/motion.ts');
assert.match(homeStatus, /<FloatingEmoji emoji=\{mood\.emoji\} \/>/, 'the partner card\'s big emoji floats');
assert.match(homeStatus, /withRepeat\(withTiming\(-FLOAT_DISTANCE, \{ duration: FLOAT_HALF_MS, easing: Easing\.inOut\(Easing\.sin\) \}\), -1, true\)/, 'endless sine up/down');
assert.match(homeStatus, /useReducedMotion/, 'no float when reduced motion is on');
assert.doesNotMatch(homeStatus, /scale:|rotate:/, 'only vertical movement');
assert.match(homeStatus, /homeWhatsUp/, 'header title "What\'s up?" (reference clip, replaces the R2 choice)');
assert.match(home, /togetherParts\(togetherSince, today, kind\)/, 'years/months/days in the selected calendar');
assert.match(home, /DaysTogetherCard/);
assert.match(home, /router\.push\('\/settings\/profile'\)/, 'together-date shortcut opens the local profile screen');
assert.match(home, /OnThisDayCard/);
assert.match(home, /LibraryShortcut onPress=\{\(\) => router.push\('\/library'\)\}/);
assert.doesNotMatch(home, /function HomeCard|<HomeCard/, 'old HomeCard styling removed');
assert.doesNotMatch(home, /homeQuickMood|title="eventAdd"/, 'old quick-action buttons removed');
assert.doesNotMatch(home, /scanAll|buildIndex|rebuildIndex|startIndex/, 'Home never starts a library scan');
const cards = read('../components/home/HomeCards.tsx');
assert.match(cards, /onPress=\{onPress\}/);
assert.doesNotMatch(cards, /marginLeft|marginRight|paddingLeft|paddingRight/, 'logical layout only');
const card = read('../components/home/ConnectCard.tsx');
assert.match(card, /onPress=\{\(\) => router\.push\('\/settings\/pair'\)\}/, 'Home opens partner pairing');
assert.doesNotMatch(card, /comingSoon/);
for (const lang of ['fa', 'en']) {
  const j = JSON.parse(read(`../src/i18n/locales/${lang}.json`));
  for (const k of ['homeConnectTitle', 'homeConnectBody', 'homeThisWeek', 'homeEventsCount', 'homeNoEventsWeek', 'homeSnapTitle', 'homeSnapDone', 'homeStatusSaved', 'homeDaysTogether', 'homeSetTogether', 'unitYear', 'unitYears', 'unitMonth', 'unitMonths', 'unitDay', 'unitDays', 'homeLibrary', 'homeLibraryHint']) {
    assert.ok(j[k] && j[k].length > 0, `${lang}.${k}`);
  }
}

// R2: years / months / days together, counted in the person's calendar
const { togetherParts, togetherLabel } = m;
assert.deepEqual(togetherParts('2021-07-10T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'gregorian'), { years: 5, months: 3, days: 2 });
assert.deepEqual(togetherParts('2026-01-31T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'gregorian'), { years: 0, months: 1, days: 1 }, 'borrows the length of February');
assert.deepEqual(togetherParts('2025-12-25T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 'gregorian'), { years: 0, months: 0, days: 11 });
assert.deepEqual(togetherParts('2026-12-01T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'gregorian'), { years: 0, months: 0, days: 0 }, 'a future date gives zeros');
assert.deepEqual(togetherParts('2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'jalali'), { years: 0, months: 0, days: 0 });
// Jalali: 1 Farvardin 1400 (2021-03-21) to 1 Mehr 1405 (2026-09-23) = 5 years 6 months 0 days; months are Jalali months
assert.deepEqual(togetherParts('2021-03-21T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 'jalali'), { years: 5, months: 6, days: 0 });
assert.deepEqual(togetherParts('2021-03-21T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'jalali'), { years: 5, months: 5, days: 30 }, '31 Shahrivar is 30 days after 1 Shahrivar');
const dict = { en: JSON.parse(read('../src/i18n/locales/en.json')), fa: JSON.parse(read('../src/i18n/locales/fa.json')) };
const lab = (lang, p, join) => togetherLabel(p, (k) => dict[lang][k], (n) => String(n), join);
assert.equal(lab('en', { years: 5, months: 3, days: 2 }), '5 years 3 months 2 days');
assert.equal(lab('en', { years: 1, months: 1, days: 1 }), '1 year 1 month 1 day');
assert.equal(lab('en', { years: 2, months: 0, days: 0 }), '2 years', 'zero parts are left out');
assert.equal(lab('en', { years: 0, months: 0, days: 0 }), '0 days');
assert.equal(lab('fa', { years: 5, months: 3, days: 2 }, ' و '), '5 سال و 3 ماه و 2 روز');
const index = read('../app/(tabs)/index.tsx');
// Q6: the week list is not wrapped in a second card (each EventItem is the card), and the partner avatar gets the sharper photo path
assert.doesNotMatch(index, /borderRadius: 24, paddingHorizontal: 16, marginBottom: 18/, 'no frame around the EventItem cards');
assert.match(homeStatus, /<Avatar b64=\{partner\?\.avatarB64\} photo=\{partner\?\.avatarPhoto\}/, 'Home shows the partner\'s sharper photo when there is one');
assert.doesNotMatch(home, /scanAll|buildIndex|rebuildIndex|startIndex|\.build\(\)/, 'the Latest diary cover never starts a Library scan');

// relative time of the partner's mood card
const { timeAgo } = mod;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
assert.deepEqual(timeAgo('2026-10-23T11:59:30.000Z', NOW), { unit: 'now', n: 0 });
assert.deepEqual(timeAgo('2026-10-23T12:30:00.000Z', NOW), { unit: 'now', n: 0 }, 'a future time counts as now');
assert.deepEqual(timeAgo('2026-10-23T11:55:00.000Z', NOW), { unit: 'minutes', n: 5 });
assert.deepEqual(timeAgo('2026-10-23T09:00:00.000Z', NOW), { unit: 'hours', n: 3 });
assert.deepEqual(timeAgo('2026-10-20T12:00:00.000Z', NOW), { unit: 'days', n: 3 });
assert.deepEqual(timeAgo('2026-10-10T12:00:00.000Z', NOW), { unit: 'date', n: 0 });
assert.deepEqual(timeAgo('garbage', NOW), { unit: 'date', n: 0 });
// the label is refreshed exactly when it changes: boundaries sit on the minute marks of the moment the status was set
const { msUntilAgoChanges } = mod;
const SET = '2026-10-23T11:55:20.000Z';
assert.equal(msUntilAgoChanges(SET, Date.parse('2026-10-23T11:55:20.000Z')), 60000, 'just set: the next change is in a minute');
assert.equal(msUntilAgoChanges(SET, Date.parse('2026-10-23T11:56:05.000Z')), 15000, '45 s into the first minute: 15 s to "1 minute ago"');
assert.equal(msUntilAgoChanges(SET, Date.parse('2026-10-23T12:00:20.000Z')), 60000, 'exactly on the "5 minutes" mark: the next one is a minute away');
assert.equal(msUntilAgoChanges(SET, Date.parse('2026-10-23T12:00:19.800Z')), 1000, 'never under one second');
assert.equal(msUntilAgoChanges(SET, Date.parse('2026-10-23T11:55:00.000Z')), 20000, 'a phone clock behind the sender: waits for it');
assert.equal(msUntilAgoChanges('garbage', NOW), 60000);
// after 5 min 20 s the card says 5, one minute later 6 (the screen re-reads the clock at those moments)
assert.deepEqual(timeAgo(SET, Date.parse('2026-10-23T12:00:40.000Z')), { unit: 'minutes', n: 5 });
assert.deepEqual(timeAgo(SET, Date.parse('2026-10-23T12:01:21.000Z')), { unit: 'minutes', n: 6 });
assert.match(homeStatus, /useNowFrom\(mood\?\.ts\)/, 'the card counts from the moment the status was set');
assert.match(homeStatus, /msUntilAgoChanges\(ts, Date\.now\(\)\)/); assert.match(homeStatus, /AppState\.addEventListener\('change'/, 'refreshed when the app returns to the foreground');
// the partner's mood history and the newest memory
{
  const { DatabaseSync } = await import('node:sqlite');
  const { initializeDatabase } = await import('../src/lib/database.ts');
  const { insertMood, listPartnerMoods, clearMoodLocal } = await import('../src/partner/mood-db.ts');
  const { latestDiaryEntry, saveDiaryEntry } = await import('../src/diary/diary-db.ts');
  const raw = new DatabaseSync(':memory:');
  const db = {
    runAsync: async (sql, ...args) => { const r = raw.prepare(sql).run(...args); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    getAllAsync: async (sql, ...args) => raw.prepare(sql).all(...args),
    getFirstAsync: async (sql, ...args) => raw.prepare(sql).get(...args) ?? null,
    execAsync: async (sql) => void raw.exec(sql),
  };
  await initializeDatabase(db);
  for (const [i, emoji] of ['😤', '🤗', '😊', '🥳'].entries()) await insertMood(db, { msgId: `p${i}`, fromMe: false, emoji, text: null, intensity: 3, ts: `2026-10-2${i}T10:00:00.000Z` });
  await insertMood(db, { msgId: 'mine', fromMe: true, emoji: '😎', text: null, intensity: 3, ts: '2026-10-25T10:00:00.000Z' });
  await clearMoodLocal(db, false, 'c1', '2026-10-26T10:00:00.000Z');
  const base = { category: 'none', mood: null, body: '', mediaKeys: [], saved: false, updatedAt: '2026-10-22T00:00:00.000Z' };
  await saveDiaryEntry(db, { ...base, id: 'old', title: 'Old', createdAt: '2026-10-01T00:00:00.000Z' });
  await saveDiaryEntry(db, { ...base, id: 'new', title: 'New', createdAt: '2026-10-20T00:00:00.000Z' });
}
for (const lang of ['en', 'fa']) {
  const d = JSON.parse(read(`../src/i18n/locales/${lang}.json`));
  assert.match(d.homePartnerIs, /\{name\}/); assert.match(d.agoMinutes, /\{n\}/);
}
console.log('home tests ok');
