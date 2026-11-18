import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/lib/database.ts';
import { partsToIso, isoToParts, parseTypedInt } from '../src/partner/birthday.ts';
import { decodeMessage, encodeMessage, MAX_BODY } from '../src/partner/messages.ts';
import { insertMood, latestMood, listMoods, saveMoodLocal } from '../src/partner/mood-db.ts';
import { parseMailboxInvite, randomDeviceId } from '../src/partner/pairing.ts';
import { handleIncoming } from '../src/partner/inbox.ts';
import { readFileSync } from 'node:fs';
import { sharedFileName, sharedFolder, splitSharedPath } from '../src/partner/media-ref.ts';
import { existsSync } from 'node:fs';

const rnd = (n) => new Uint8Array(randomBytes(n));

// node:sqlite shaped like the part of expo-sqlite that meYou uses
function memoryDb() {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...p) => ({ changes: Number(db.prepare(sql).run(...p).changes) }),
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
  };
}

// ---- device id and invite link ---------------------------------------------------
{
  assert.match(randomDeviceId(rnd), /^[0-9a-f]{16}$/);
  assert.notEqual(randomDeviceId(rnd), randomDeviceId(rnd));
  const code = 'ABCDEFGHJKMNPQRSTUVWXYZ2';
  const link = `meyou://join?url=${encodeURIComponent('https://meyou.example.org:18443/')}&code=${code}`;
  assert.deepEqual(parseMailboxInvite(link), { url: 'https://meyou.example.org:18443', code });
  assert.equal(parseMailboxInvite(link.toLowerCase().replace('meyou://join', 'meyou://join'))?.code, code); // typed codes are upper-cased
  for (const bad of ['', 'hello', '{}', 'meyou://server?url=https%3A%2F%2Fx.y&code=' + code, 'https://x.y/join?code=' + code, `meyou://join?url=ftp%3A%2F%2Fx.y&code=${code}`, 'meyou://join?url=https%3A%2F%2Fx.y&code=SHORT', `meyou://join?url=https%3A%2F%2Fu%3Ap%40x.y&code=${code}`, 'meyou://join?code=' + code]) {
    assert.equal(parseMailboxInvite(bad), null, bad);
  }
}

// ---- message validation ------------------------------------------------------------
{
  const base = { from: 'dev1', ts: '2026-10-15T10:00:00.000Z' };
  const mood = { t: 'mood', ...base, emoji: '😊', text: 'good day', intensity: 4 };
  assert.deepEqual(decodeMessage(encodeMessage(mood)), mood);
  assert.equal(decodeMessage(JSON.stringify({ ...mood, text: '' })).text, undefined);
  for (const bad of [{ ...mood, intensity: 9 }, { ...mood, intensity: 2.5 }, { ...mood, emoji: '' }, { ...mood, from: '' }, { ...mood, ts: 'not a date' }, { ...mood, t: 'chat' }, { t: 'mood' }]) {
    assert.equal(decodeMessage(JSON.stringify(bad)), null, JSON.stringify(bad));
  }
  assert.equal(decodeMessage('not json'), null);
  assert.equal(decodeMessage(undefined), null);
  assert.equal(decodeMessage('null'), null);
  const ev = { t: 'event', ...base, id: 'e1', title: 'Anniversary', date: '2025-03-20T00:00:00.000Z', repeat: 'yearly' };
  assert.deepEqual(decodeMessage(JSON.stringify(ev)), { ...ev, cal: undefined });
  assert.equal(decodeMessage(JSON.stringify({ ...ev, title: '' })), null);
  const prof = { t: 'profile', ...base, name: 'Sam', birthday: '1995-06-01T00:00:00.000Z', hello: true };
  assert.deepEqual(decodeMessage(JSON.stringify(prof)), { ...prof, avatarB64: undefined });
  assert.deepEqual(decodeMessage(JSON.stringify({ t: 'unpair', ...base })), { t: 'unpair', ...base });
  // longer than MAX_BODY: refused, never truncated
  assert.equal(encodeMessage({ ...prof, avatarB64: 'A'.repeat(MAX_BODY) }), null);
  assert.ok(encodeMessage({ ...prof, avatarB64: 'A'.repeat(2500) }));
  // R10c: the sharper photo is a server path next to the tiny one; anything that is not `Shared/...` is dropped
  const photo = 'Shared/avatar-0123456789abcdef/avatar-k3j9x.jpg';
  const sharp = decodeMessage(JSON.stringify({ ...prof, avatarB64: 'QQ==', avatarPhoto: photo }));
  assert.equal(sharp.avatarPhoto, photo);
  assert.equal(sharp.avatarB64, 'QQ==');
  for (const bad of ['/etc/passwd', 'Shared/../x.jpg', 'Other/a.jpg', 'Shared//a.jpg', 5, 'Shared/' + 'a'.repeat(300)]) {
    assert.equal(decodeMessage(JSON.stringify({ ...prof, avatarPhoto: bad })).avatarPhoto, undefined, `dropped: ${String(bad).slice(0, 20)}`);
  }
  assert.equal('avatarPhoto' in decodeMessage(JSON.stringify(prof)), false, 'a profile without it decodes as before');
  assert.ok(encodeMessage({ ...prof, avatarB64: 'A'.repeat(2500), avatarPhoto: photo }), 'tiny photo + path still fit in one message');
}

// ---- R1b: protocol v2 fields and types (API_CONTRACT D.13) ---------------------------
{
  const base = { from: 'dev1', ts: '2026-10-15T10:00:00.000Z' };
  const dec = (m) => decodeMessage(JSON.stringify(m));
  // event: icon, note, photo; an unusable value drops only that field
  const ev = { t: 'event', ...base, id: 'e1', title: 'Trip', date: '2026-12-01T00:00:00.000Z' };
  const full = dec({ ...ev, icon: 'plane', note: 'Pack light', photo: 'Shared/e1/photo.jpg', silent: true, unknown: 'x' });
  assert.equal(full.icon, 'plane');
  assert.equal(full.note, 'Pack light');
  assert.equal(full.photo, 'Shared/e1/photo.jpg');
  assert.equal(full.silent, true);
  assert.ok(!('unknown' in full), 'unknown fields are dropped');
  for (const photo of ['/etc/passwd', 'Shared/../secret', 'Other/e1/a.jpg', 'Shared//a.jpg', 'Shared/e1\\a.jpg', 'x'.repeat(301), 5]) assert.equal(dec({ ...ev, photo }).photo, undefined, String(photo));
  assert.equal(dec({ ...ev, note: 'n'.repeat(1001) }).note, undefined);
  assert.equal(dec({ ...ev, icon: 'i'.repeat(33) }).icon, undefined);
  assert.ok(!('icon' in dec(ev)) && !('note' in dec(ev)) && !('photo' in dec(ev)) && !('silent' in dec(ev)), 'an old message decodes exactly as before');
  // profile: togetherSince
  const prof = { t: 'profile', ...base, name: 'Sam' };
  assert.equal(dec({ ...prof, togetherSince: '2020-02-14T00:00:00.000Z' }).togetherSince, '2020-02-14T00:00:00.000Z');
  assert.ok(!('togetherSince' in dec({ ...prof, togetherSince: 'nope' })));
  // mood: cleared needs no emoji or intensity
  assert.deepEqual(dec({ t: 'mood', ...base, cleared: true }), { t: 'mood', ...base, cleared: true });
  assert.equal(dec({ t: 'mood', ...base, cleared: false }), null, 'cleared:false without an emoji is still invalid');
  // diary
  assert.deepEqual(dec({ t: 'diary', ...base, id: 'd1', deleted: true, title: 'ignored' }), { t: 'diary', ...base, id: 'd1', deleted: true });
  assert.deepEqual(dec({ t: 'diary', ...base, id: 'd1', title: 'Beach', body: 'Sun', category: 'travel', mood: '😊', date: base.ts, mediaCount: 3, extra: 1 }), { t: 'diary', ...base, id: 'd1', title: 'Beach', body: 'Sun', category: 'travel', mood: '😊', date: base.ts, mediaCount: 3 });
  assert.equal(dec({ t: 'diary', ...base, id: '' }), null);
  assert.equal(dec({ t: 'diary', ...base, id: 'd1', mediaCount: -1 }).mediaCount, undefined);
  // period: only the three kinds the server pushes visibly
  for (const kind of ['started', 'pain', 'better']) assert.deepEqual(dec({ t: 'period', ...base, kind }), { t: 'period', ...base, kind });
  assert.equal(dec({ t: 'period', ...base, kind: 'other' }), null);
  assert.equal(dec({ t: 'period', ...base }), null);
  // unknown types from a newer app are ignored
  assert.equal(dec({ t: 'chat', ...base, text: 'hi' }), null);
  // every new type fits the mailbox limit with room to spare
  assert.ok(encodeMessage({ t: 'diary', ...base, id: 'd1', body: 'b'.repeat(3000) }));
}

// ---- birthday: stored as UTC Gregorian, typed in the chosen calendar --------------------
{
  assert.equal(partsToIso('jalali', { year: 1403, month: 12, day: 30 }), '2025-03-20T00:00:00.000Z'); // leap year
  assert.equal(partsToIso('jalali', { year: 1404, month: 12, day: 30 }), null);
  assert.equal(partsToIso('jalali', { year: 1404, month: 1, day: 1 }), '2025-03-21T00:00:00.000Z');
  assert.equal(partsToIso('gregorian', { year: 2024, month: 2, day: 29 }), '2024-02-29T00:00:00.000Z');
  assert.equal(partsToIso('gregorian', { year: 2023, month: 2, day: 29 }), null);
  assert.equal(partsToIso('gregorian', { year: 2023, month: 13, day: 1 }), null);
  assert.equal(partsToIso('gregorian', { year: Number.NaN, month: 1, day: 1 }), null);
  assert.deepEqual(isoToParts('jalali', '2025-03-20T00:00:00.000Z'), { year: 1403, month: 12, day: 30 });
  assert.deepEqual(isoToParts('gregorian', '2025-03-20T00:00:00.000Z'), { year: 2025, month: 3, day: 20 });
  assert.equal(isoToParts('gregorian', 'x'), null);
  assert.equal(parseTypedInt('۱۴۰۳'), 1403);
  assert.equal(parseTypedInt('٠٨'), 8);
  assert.equal(parseTypedInt(' 12 '), 12);
  assert.ok(Number.isNaN(parseTypedInt('')) && Number.isNaN(parseTypedInt('1a')) && Number.isNaN(parseTypedInt('-3')));
}

// ---- SQLite: migration chain + mood history ---------------------------------------------
{
  const db = memoryDb();
  await initializeDatabase(db);
  await initializeDatabase(db); // idempotent
  const versions = await db.getAllAsync('SELECT version, name FROM migrations ORDER BY version');
  assert.deepEqual(versions.map((v) => v.name), ['phase-1-bootstrap', 'phase-3-library', 'phase-7-mood', 'phase-8-events', 'u13-status', 'u16-events', 'u19-diary', 'r2-event-share', 'r5a-period', 'r6-diary-categories', 'r8a-diary-share', 'diary-replies', 'stories', 'chat-messages', 'media-reactions', 'partner-media', 'vault', 'partner-originals', 'sync-state', 'gallery']);
  const m = (o) => ({ msgId: null, fromMe: false, emoji: '😊', text: null, intensity: 3, ts: '2026-10-15T10:00:00.000Z', ...o });
  assert.equal(await insertMood(db, m({ msgId: 'a' })), true);
  assert.equal(await insertMood(db, m({ msgId: 'a' })), false); // same mailbox id = duplicate
  assert.equal(await insertMood(db, m({ msgId: null, fromMe: true, ts: '2026-10-16T10:00:00.000Z', text: 'hi' })), true);
  assert.equal(await insertMood(db, m({ msgId: null, fromMe: true, ts: '2026-10-14T10:00:00.000Z' })), true);
  const list = await listMoods(db);
  assert.deepEqual(list.map((x) => x.ts.slice(0, 10)), ['2026-10-16', '2026-10-15', '2026-10-14']);
  assert.equal((await latestMood(db, true)).text, 'hi');
  assert.equal((await latestMood(db, false)).msgId, 'a');
  assert.equal((await listMoods(db, 1)).length, 1);

  // local status (partner dormant): a from_me row with a local message id, never a duplicate of another
  const a = await saveMoodLocal(db, { emoji: '🙂', text: '  fine  ', ts: '2026-10-17T08:00:00.000Z' });
  const b = await saveMoodLocal(db, { emoji: '😴', ts: '2026-10-17T08:00:00.000Z' });
  assert.match(a.msgId, /^local-/);
  assert.notEqual(a.msgId, b.msgId);
  assert.deepEqual([a.fromMe, a.text, a.intensity, b.text], [true, 'fine', 3, null]);
  const mine = await latestMood(db, true);
  assert.equal(mine.ts, '2026-10-17T08:00:00.000Z');
  assert.equal((await latestMood(db, false)).msgId, 'a', 'partner side untouched');
  assert.equal((await listMoods(db)).length, 5);
}

// ---- R2: the partner's togetherSince reaches the store; shared files go to Shared/<id>/ -------------------------
{
  const db = memoryDb();
  await initializeDatabase(db);
  const applied = [];
  const deps = { db, deviceId: 'me', setPartner: () => {}, setTogetherSince: (iso) => applied.push(iso), onUnpaired: () => {}, replyProfile: () => {}, prefs: () => ({ mood: true, event: true, diary: true, period: true }), notify: () => {} };
  const body = (o) => ({ id: '1', message: JSON.stringify({ t: 'profile', from: 'p', ts: '2026-10-15T10:00:00.000Z', name: 'Sam', ...o }) });
  const seen = [];
  const photoPath = 'Shared/avatar-abc/avatar-1.jpg';
  assert.equal(await handleIncoming({ ...deps, setPartner: (p) => seen.push(p) }, body({ name: 'Sam', avatarB64: 'QQ==', avatarPhoto: photoPath })), 'profile');
  assert.equal(seen[0].avatarPhoto, photoPath, 'R10c: the partner profile keeps the sharper photo path');
  assert.equal(seen[0].avatarB64, 'QQ==');
  assert.equal(await handleIncoming(deps, body({ togetherSince: '2020-02-14T00:00:00.000Z' })), 'profile');
  assert.deepEqual(applied, ['2020-02-14T00:00:00.000Z']);
  await handleIncoming(deps, body({}));
  assert.equal(applied.length, 1, 'a profile without the date never clears ours');

  const manage = readFileSync(new URL('../src/partner/manage.ts', import.meta.url), 'utf8');
  assert.match(manage, /togetherSince: store\(\)\.togetherSince/, 'sendProfile carries the together date');
  assert.match(manage, /applyingRemoteTogether/, 'a date we just received is not sent back');
  // Q1: memory media are Library keys, never file paths: sendDiary resolves each key to a readable file before the upload
  assert.match(manage, /resolveMediaFile\(key\)/, 'sendDiary resolves a Library key to a file');
  assert.doesNotMatch(manage, /shareFile\([^)]*,\s*key\)/, 'a Library key is never passed to the uploader as a path');
  assert.match(manage, /shareFileResult/, 'a failed shared upload reports its reason');
  const diaryMedia = readFileSync(new URL('../src/diary/diary-media.ts', import.meta.url), 'utf8');
  assert.match(diaryMedia, /downloadFileAsync/, 'server-only originals are downloaded to a temporary file');
  assert.match(diaryMedia, /release/, 'the temporary file is removed after the upload');
  assert.match(manage, /state\.togetherSince === previous\.togetherSince/, 'only a changed date triggers a profile message');

  assert.equal(sharedFolder('ev1'), 'Shared/ev1');
  assert.equal(sharedFileName('a/b:c.jpg'), 'a_b_c.jpg');
  assert.equal(sharedFileName('..'), 'photo.jpg');
  assert.deepEqual(splitSharedPath('Shared/ev1/a.jpg'), { folder: 'Shared/ev1', name: 'a.jpg' });
  for (const bad of ['', 'Shared/a.jpg', 'Other/ev1/a.jpg', 'Shared/../x/a.jpg', 'Shared//a.jpg']) assert.equal(splitSharedPath(bad), null, bad);

  // Stage 2B: no server upload / plain mailbox path is left in the app (every partner message is sealed, no fallback)
  for (const gone of ['src/partner/shared-media.ts', 'src/server/upload.ts', 'src/server/server-provider.ts', 'src/server/runtime.ts']) {
    assert.equal(existsSync(new URL(`../${gone}`, import.meta.url)), false, `${gone} is removed`);
  }
  assert.doesNotMatch(manage, /uploadShared|resolveShared|sharedOriginal\(|serverItemRef|sharedClient|\.publish\(|ServerClient/, 'manage.ts has no server file / plain mailbox call');
  assert.doesNotMatch(manage, /['"]\/mailbox/, 'no plain mailbox route');
  const publish = manage.slice(manage.indexOf('async function publishPartner'), manage.indexOf('/** Stage 6: every original-file message'));
  assert.match(publish, /if \(!\(await e2eKeys\(\)\)\)[\s\S]*throw new NoKeysError/, 'no E2E keys: the message is refused, never sent plain');
  assert.match(publish, /sendEncrypted/, 'with keys it is sealed and goes through the encrypted queue');
  assert.match(manage, /needSecurePairing/, 'the \"pair securely first\" notice is shown');
  const shareInner = manage.slice(manage.indexOf('async function shareFileInner'), manage.indexOf('function mediaSendDeps'));
  assert.match(shareInner, /reason: 'no-keys'/, 'a file is not shared without keys');
  assert.match(shareInner, /reason: 'type'/, 'only photos and videos are shared');
  const client = readFileSync(new URL('../src/partner/mailbox-client.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /'\/mailbox'|\/mailbox\/ws|publish\(|poll\(/, 'the REST client has no plain mailbox call');
  const en = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'));
  const fa = JSON.parse(readFileSync(new URL('../src/i18n/locales/fa.json', import.meta.url), 'utf8'));
  assert.ok(en.needSecurePairing && fa.needSecurePairing, 'the no-keys notice exists in fa and en');
}

console.log('partner tests ok');
