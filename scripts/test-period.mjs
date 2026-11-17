import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, migratePeriod } from '../src/lib/database.ts';
import { isValidStartDay, validCycleDays } from '../src/period/cycle.ts';
import { readFileSync } from 'node:fs';
import { addDays, cycleLengths, cycleStarts, cycleStats, dayDiff, phaseForDay, predict, toDay } from '../src/period/cycle.ts';
import { applyPeriodMessage, buildPeriodMessage, dayInfo, clearPeriodEvents, deletePeriodEvent, listPeriodEvents, logPeriodLocal, periodDay, predictNext } from '../src/period/period-db.ts';
import { decodeMessage, encodeMessage } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';
import { ringArcs, ringMarker } from '../src/period/ring.ts';
import { shouldNotifyLocal } from '../src/partner/push-events.ts';
import { MOODS } from '../src/partner/moods.ts';

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...p) => {
      const r = db.prepare(sql).run(...p);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
  };
}

// ---- date helpers ----------------------------------------------------------------------------
assert.equal(addDays('2026-02-27', 3), '2026-03-02');
assert.equal(addDays('2026-03-01', -1), '2026-02-28');
assert.equal(dayDiff('2026-01-01', '2026-03-01'), 59);
assert.equal(toDay('2026-10-18T23:59:59.000Z'), '2026-10-18');
assert.equal(toDay('nope'), null);

// ---- first cycle: no history -> default 28 days ---------------------------------------------
assert.equal(predict([]), null);
assert.equal(phaseForDay([], '2026-10-01'), null);
const first = predict(['2026-10-01']);
assert.equal(first.basis, 'default');
assert.equal(first.length, 28);
assert.equal(first.nextStart, '2026-10-29');
assert.equal(first.ovulation, '2026-10-15'); // next period - 14 days
assert.equal(first.fertileFrom, '2026-10-10');
assert.equal(first.fertileTo, '2026-10-16');
const phases = [];
for (let i = 0; i < 28; i++) phases.push(phaseForDay(['2026-10-01'], addDays('2026-10-01', i)).phase);
assert.deepEqual(phases.slice(0, 5), Array(5).fill('period'));
assert.equal(phases[5], 'follicular');
assert.equal(phases[8], 'follicular');
assert.deepEqual(phases.slice(9, 14), Array(5).fill('fertile')); // 5 days before ovulation
assert.equal(phases[14], 'ovulation');
assert.equal(phases[15], 'fertile'); // 1 day after
assert.equal(phases[16], 'luteal');
assert.equal(phases[22], 'luteal');
// PMS = the last 5 days before the next period
assert.deepEqual(phases.slice(23), Array(5).fill('pms'));
assert.equal(phaseForDay(['2026-10-01'], '2026-10-01').dayOfCycle, 1);
assert.equal(phaseForDay(['2026-10-01'], '2026-10-28').daysUntilNext, 1);
// a day before the first logged period has no phase; after the predicted date with nothing logged it is "late"
assert.equal(phaseForDay(['2026-10-01'], '2026-09-30'), null);
const late = phaseForDay(['2026-10-01'], '2026-11-02');
assert.equal(late.phase, 'late');
assert.equal(late.dayOfCycle, 33);
assert.equal(late.daysUntilNext, -4);

// ---- regular history: average of the cycles --------------------------------------------------
const regular = ['2026-06-01', '2026-06-30', '2026-07-29', '2026-08-27']; // 29, 29, 29
assert.deepEqual(cycleLengths(regular), [29, 29, 29]);
const reg = predict(regular);
assert.equal(reg.basis, 'history');
assert.equal(reg.cycles, 3);
assert.equal(reg.length, 29);
assert.equal(reg.regular, true);
assert.equal(reg.nextStart, '2026-09-25');
// a finished cycle uses its real length, the open one the average
assert.equal(phaseForDay(regular, '2026-07-10').cycleLength, 29);
assert.equal(phaseForDay(regular, '2026-07-10').nextStart, '2026-07-29');

// ---- irregular cycles ------------------------------------------------------------------------
const irregular = ['2026-01-01', '2026-01-24', '2026-03-06', '2026-03-30', '2026-05-10']; // 23, 41, 24, 41
assert.deepEqual(cycleLengths(irregular), [23, 41, 24, 41]);
const irr = cycleStats(irregular);
assert.equal(irr.length, 32); // (23+41+24+41)/4 = 32.25
assert.equal(irr.regular, false); // spread 18 > 7
assert.equal(predict(irregular).nextStart, '2026-06-11');
assert.equal(cycleStats(['2026-01-01', '2026-01-18', '2026-02-04']).regular, false); // 17-day cycles: under 21
assert.equal(cycleStats(['2026-01-01', '2026-02-10', '2026-03-22']).regular, false); // 40-day cycles: over 35
// a missed log (gap > 60) and a typo (gap < 15) never enter the average
assert.deepEqual(cycleLengths(['2026-01-01', '2026-01-29', '2026-05-01', '2026-05-29']), [28, 28]);
assert.deepEqual(cycleStarts(['2026-01-01', '2026-01-04', '2026-01-29']), ['2026-01-01', '2026-01-29']); // logged twice
assert.deepEqual(cycleStarts(['2026-02-01', '2026-01-01', '2026-01-01']), ['2026-01-01', '2026-02-01']);
// only the latest 6 cycles count
const many = ['2025-01-01'];
for (const n of [40, 40, 28, 28, 28, 28, 28, 28]) many.push(addDays(many[many.length - 1], n));
assert.equal(cycleStats(many).length, 28);
assert.equal(cycleStats(many).cycles, 6);

// ---- PMS and a short cycle -------------------------------------------------------------------
const short = ['2026-01-01', '2026-01-22', '2026-02-12']; // 21-day cycles
assert.equal(phaseForDay(short, '2026-02-12').phase, 'period');
const shortPhases = Array.from({ length: 21 }, (_, i) => phaseForDay(['2026-01-01', '2026-01-22'], addDays('2026-01-01', i)).phase);
assert.equal(shortPhases[7], 'ovulation'); // 21 - 14
assert.deepEqual(shortPhases.slice(16), Array(5).fill('pms'));
assert.equal(shortPhases.filter((p) => p === 'pms').length, 5);

// ---- database --------------------------------------------------------------------------------
const db = memoryDb();
await initializeDatabase(db);
await migratePeriod(db); // idempotent
assert.deepEqual(await listPeriodEvents(db, true), []);
assert.equal(await predictNext(db, true), null);
const a = await logPeriodLocal(db, { kind: 'started', day: '2026-09-03' });
assert.equal(a.fromMe, true);
assert.equal(a.kind, 'started');
assert.equal(await logPeriodLocal(db, { kind: 'started', day: '2026-09-03' }), null, 'same day twice is a duplicate');
await logPeriodLocal(db, { kind: 'pain', day: '2026-09-03' });
await logPeriodLocal(db, { kind: 'started', day: '2026-10-01' });
const mine = await listPeriodEvents(db, true);
assert.equal(mine.length, 3);
assert.equal(mine[0].day, '2026-10-01');
assert.equal((await predictNext(db, true)).nextStart, '2026-10-29'); // 28 days
assert.equal((await dayInfo(db, true, '2026-10-20')).phase, 'luteal');
assert.equal(await predictNext(db, false), null, 'the partner log is separate');
assert.equal(await deletePeriodEvent(db, mine[0].id), true);
assert.equal((await predictNext(db, true)).lastStart, '2026-09-03');
// clearing the whole history removes only the log shown (mine or the partner's) and reports how many went
await db.runAsync("INSERT INTO period_events (msg_id, from_me, kind, day, ts) VALUES ('partner-1', 0, 'started', '2026-08-01', '2026-08-01T00:00:00.000Z')");
const mineBefore = (await listPeriodEvents(db, true)).length;
assert.equal(await clearPeriodEvents(db, true), mineBefore);
assert.deepEqual(await listPeriodEvents(db, true), []);
assert.equal(await predictNext(db, true), null);
assert.equal(await clearPeriodEvents(db, true), 0, 'nothing left to clear');
assert.equal((await listPeriodEvents(db, false)).length, 1, 'the partner log was not touched');
assert.equal(await clearPeriodEvents(db, false), 1);

// ---- messages: two clients round-trip --------------------------------------------------------
const phoneA = memoryDb();
const phoneB = memoryDb();
await initializeDatabase(phoneA);
await initializeDatabase(phoneB);
const sent = buildPeriodMessage('started', '2026-10-05', 'dev-A', '2026-10-05T07:30:00.000Z');
const body = encodeMessage(sent);
assert.ok(body && body.length < 300);
assert.deepEqual(decodeMessage(body), sent);
const deps = (db, deviceId) => ({
  db,
  deviceId,
  setPartner() {},
  onUnpaired() {},
  replyProfile() {},
  prefs: () => ({ mood: true, event: true, diary: true, period: true }),
  notify() {},
  onPeriod: (msg, id) => applyPeriodMessage(db, id, msg),
});
assert.equal(await handleIncoming(deps(phoneB, 'dev-B'), { id: '41', message: body }), 'period');
assert.equal(await handleIncoming(deps(phoneB, 'dev-B'), { id: '41', message: body }), 'duplicate', 'same seq twice');
assert.equal(await handleIncoming(deps(phoneA, 'dev-A'), { id: '41', message: body }), 'mine', 'own message is ignored');
const got = await listPeriodEvents(phoneB, false);
assert.equal(got.length, 1);
assert.deepEqual({ kind: got[0].kind, day: got[0].day, fromMe: got[0].fromMe, msgId: got[0].msgId }, { kind: 'started', day: '2026-10-05', fromMe: false, msgId: '41' });
assert.equal((await predictNext(phoneB, false)).nextStart, '2026-11-02');
for (const kind of ['pain', 'better']) {
  const m = encodeMessage(buildPeriodMessage(kind, '2026-10-06', 'dev-A', '2026-10-06T09:00:00.000Z'));
  assert.equal(await handleIncoming(deps(phoneB, 'dev-B'), { id: kind, message: m }), 'period');
}
assert.deepEqual((await listPeriodEvents(phoneB, false)).map((r) => r.kind).sort(), ['better', 'pain', 'started']);
// invalid kind / unknown fields
assert.equal(decodeMessage(JSON.stringify({ t: 'period', from: 'x', ts: '2026-10-05T00:00:00Z', kind: 'oops' })), null);
assert.equal(decodeMessage(JSON.stringify({ t: 'period', from: 'x', ts: '2026-10-05T00:00:00Z', kind: 'pain', secret: 1 })).secret, undefined);
// the day: never in the future of the send time, defaults to the send day
assert.equal(periodDay({ ts: '2026-10-05T07:00:00Z' }), '2026-10-05');
assert.equal(periodDay({ ts: '2026-10-05T07:00:00Z', date: '2026-10-03T00:00:00Z' }), '2026-10-03');
assert.equal(periodDay({ ts: '2026-10-05T07:00:00Z', date: '2027-01-01T00:00:00Z' }), '2026-10-05');
// a phone without onPeriod (old wiring) still answers 'period'
assert.equal(await handleIncoming({ ...deps(phoneB, 'dev-B'), onPeriod: undefined }, { id: '99', message: body }), 'period');

// ---- R5b: ring arcs, notification, mood ------------------------------------------------------
{
  const info = phaseForDay(['2026-10-01'], '2026-10-03'); // default 28-day cycle
  const arcs = ringArcs(info);
  assert.deepEqual(arcs.map((a) => a.phase), ['period', 'fertile', 'pms']);
  const [p, f, m] = arcs;
  assert.equal(p.from, 0);
  assert.equal(p.to, 5 / 28);
  assert.equal(f.from, 9 / 28); // ovulation at offset 14, fertile from 5 days before
  assert.equal(f.to, 16 / 28);
  assert.equal(m.from, 23 / 28); // PMS = last 5 days
  assert.equal(m.to, 1);
  assert.ok(arcs.every((a, i) => a.to > a.from && (i === 0 || a.from >= arcs[i - 1].to)), 'arcs never overlap');
  assert.equal(ringMarker(info), 2.5 / 28, 'dot on day 3');
  const late = phaseForDay(['2026-10-01'], '2026-11-10');
  assert.equal(late.phase, 'late');
  assert.equal(ringMarker(late), (28 - 0.5) / 28 > 1 ? 1 : Math.min(late.dayOfCycle - 0.5, 28) / 28, 'late dot stays on the ring');
  assert.ok(ringMarker(late) <= 1);
  // a short cycle still gives non-overlapping arcs
  const short = ringArcs(phaseForDay(['2026-10-01', '2026-10-19'], '2026-10-05')); // 18-day cycle
  assert.ok(short.every((a, i) => a.to > a.from && (i === 0 || a.from >= short[i - 1].to)), 'short cycle arcs');
}
assert.ok(MOODS.some((m) => m.id === 'period' && m.emoji === '🩸'), 'period mood');
assert.equal(shouldNotifyLocal({ kind: 'period', source: 'replay', pushRegistered: true, heldByForegroundHandler: false }), false, 'system already showed it');
assert.equal(shouldNotifyLocal({ kind: 'period', source: 'live', pushRegistered: true, heldByForegroundHandler: false }), true);
{
  const shown = [];
  const mk = (db, notifyOn, extra = {}) => ({
    db, deviceId: 'dev-B', setPartner() {}, onUnpaired() {}, replyProfile() {},
    prefs: () => ({ mood: true, event: true, diary: true, period: notifyOn }),
    notify: (n) => void shown.push(n),
    onPeriod: (msg, id) => applyPeriodMessage(db, id, msg),
    ...extra,
  });
  const dbB = memoryDb();
  await initializeDatabase(dbB);
  for (const [i, kind] of ['started', 'pain', 'better'].entries()) {
    const m = encodeMessage(buildPeriodMessage(kind, '2026-10-0' + (i + 1), 'dev-A', '2026-10-0' + (i + 1) + 'T09:00:00.000Z'));
    assert.equal(await handleIncoming(mk(dbB, true), { id: 'n' + i, message: m }), 'period');
  }
  assert.deepEqual(shown.map((n) => [n.kind, n.msg.kind]), [['period', 'started'], ['period', 'pain'], ['period', 'better']], 'three distinct notifications');
  const off = encodeMessage(buildPeriodMessage('started', '2026-11-01', 'dev-A', '2026-11-01T09:00:00.000Z'));
  assert.equal(await handleIncoming(mk(dbB, false), { id: 'off', message: off }), 'period');
  assert.equal(shown.length, 3, 'switch off: stored, not notified');
  assert.equal(await handleIncoming(mk(dbB, true), { id: 'off', message: off }), 'duplicate');
  assert.equal(shown.length, 3, 'duplicate: no second notification');
}

// ---- Q7: any start date, own cycle length -----------------------------------------------------
{
  // a 32-day cycle: from history (starts 32 days apart) and as the owner's own setting
  const s1 = '2026-06-01', s2 = addDays(s1, 32), s3 = addDays(s2, 32);
  const hist = predict([s1, s2, s3]);
  assert.equal(hist.length, 32); assert.equal(hist.basis, 'history'); assert.equal(hist.nextStart, addDays(s3, 32));
  assert.equal(hist.ovulation, addDays(s3, 32 - 14), 'ovulation = next start - 14 days');
  const own = predict([s3], 32);
  assert.equal(own.basis, 'custom'); assert.equal(own.length, 32); assert.equal(own.nextStart, addDays(s3, 32)); assert.equal(own.ovulation, addDays(s3, 18));
  assert.equal(predict([s3]).length, 28, 'no setting + no history: the 28-day estimate');
  assert.equal(predict([s1, addDays(s1, 26), addDays(s1, 52)], 32).length, 32, 'the set length wins over the average of history');
  assert.equal(predict([s3], 10).basis, 'default', 'an invalid length (below 15) is ignored'); assert.equal(predict([s3], 61).basis, 'default'); assert.equal(predict([s3], 30.5).basis, 'default'); assert.equal(predict([s3], null).basis, 'default');
  assert.deepEqual([15, 28, 60].map(validCycleDays), [true, true, true]); assert.deepEqual([14, 61, NaN, '28', null].map(validCycleDays), [false, false, false, false, false]);
  const day = phaseForDay([s3], addDays(s3, 18), 32);
  assert.equal(day.phase, 'ovulation'); assert.equal(day.cycleLength, 32); assert.equal(day.nextStart, addDays(s3, 32)); assert.equal(day.daysUntilNext, 14);
  assert.equal(phaseForDay([s3], addDays(s3, 18))?.phase, 'luteal', 'with 28 days the same day is later in the cycle');
  assert.equal(phaseForDay([s3], addDays(s3, 33), 32).phase, 'late');
  // an old start date (years ago) is a normal log; it joins the history and may be followed by newer ones
  const old = '2024-03-10';
  assert.equal(isValidStartDay(old, '2026-10-19'), true); assert.equal(isValidStartDay('2026-10-19', '2026-10-19'), true, 'today is fine');
  assert.equal(isValidStartDay('2026-10-20', '2026-10-19'), false, 'no future day'); assert.equal(isValidStartDay('2026-02-30', '2026-10-19'), false); assert.equal(isValidStartDay('nope', '2026-10-19'), false);
  const oldInfo = phaseForDay([old], '2026-10-19');
  assert.equal(oldInfo.phase, 'late'); assert.equal(oldInfo.start, old); assert.ok(oldInfo.dayOfCycle > 500);
  assert.equal(predict([old]).nextStart, addDays(old, 28)); assert.equal(predict([old], 32).nextStart, addDays(old, 32));
  assert.deepEqual(cycleStarts(['2026-09-01', old]), [old, '2026-09-01'], 'an old start sorts before newer ones');
  // stored in the db like any other day, in the right order
  const dbQ7 = memoryDb(); await initializeDatabase(dbQ7);
  assert.ok(await logPeriodLocal(dbQ7, { kind: 'started', day: '2026-09-01' })); assert.ok(await logPeriodLocal(dbQ7, { kind: 'started', day: old }));
  assert.deepEqual((await listPeriodEvents(dbQ7, true)).map((r) => r.day), ['2026-09-01', old]);
  assert.equal((await predictNext(dbQ7, true, 33)).length, 33); assert.equal((await dayInfo(dbQ7, true, '2026-09-10', 33)).cycleLength, 33);
  // the protocol: my cycle length travels with the update (0 = none), a bad value is dropped, an old app sends none
  const withLen = decodeMessage(encodeMessage(buildPeriodMessage('started', '2026-10-05', 'dev-A', '2026-10-05T07:30:00.000Z', 32)));
  assert.equal(withLen.cycleDays, 32);
  assert.equal(decodeMessage(encodeMessage(buildPeriodMessage('started', '2026-10-05', 'dev-A', '2026-10-05T07:30:00.000Z', 0))).cycleDays, 0);
  const plain = decodeMessage(encodeMessage(buildPeriodMessage('started', '2026-10-05', 'dev-A', '2026-10-05T07:30:00.000Z')));
  assert.equal('cycleDays' in plain, false, 'a message without it decodes as before');
  for (const bad of [5, 99, 28.5, '28', null, -1]) assert.equal('cycleDays' in decodeMessage(JSON.stringify({ ...withLen, cycleDays: bad })), false, `dropped: ${String(bad)}`);
  // wiring (source guards: screens cannot run here)
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const screen = src('../app/period.tsx');
  assert.match(screen, /<DateWheel/); assert.match(screen, /periodPickDate/); assert.match(screen, /isValidStartDay\(startDay, today\)/); assert.match(screen, /predict\(starts, custom\)/);
  assert.match(src('../src/partner/manage.ts'), /periodCycleDays \?\? 0/); assert.match(src('../src/partner/manage.ts'), /setPartnerCycleDays\(message\.cycleDays \|\| undefined\)/);
  assert.match(src('../src/partner/manage.ts'), /isValidStartDay\(when, ts\.slice\(0, 10\)\)/, 'a future day is refused when saving');
  assert.match(src('../src/state/settings-store.ts'), /periodCycleDays: null/, 'reset restores the estimate');
  assert.match(src('../app/settings/profile.tsx'), /from '@\/components\/ui\/DateWheel'/, 'the profile reuses the same date wheels');
  const dict = { en: JSON.parse(src('../src/i18n/locales/en.json')), fa: JSON.parse(src('../src/i18n/locales/fa.json')) };
  for (const lang of ['en', 'fa']) for (const k of ['periodPickDate', 'periodPickConfirm', 'periodPickFuture', 'periodCycleLen', 'periodCycleAuto', 'periodCycleDays', 'periodCycleUseEstimate', 'periodCycleHint', 'periodBasisCustom', 'periodBasisCustomPartner']) assert.ok(dict[lang][k], `${lang}.${k}`);
  assert.match(dict.en.periodBasisCustom, /set by you/);
}

console.log('period tests passed');
