import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, migrateChat } from '../src/lib/database.ts';
import { addChat, getChat, lastChat, listChat, markChatRead, markChatSeenUpTo, setChatFailed, unreadChatCount } from '../src/chat/chat-db.ts';
import { decodeMessage, encodeMessage, MAX_CHAT } from '../src/partner/messages.ts';
import { handleIncoming } from '../src/partner/inbox.ts';
import { parsePushData, createPushRouter } from '../src/partner/push-events.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dict = Object.fromEntries(['en', 'fa'].map((lang) => [lang, JSON.parse(read(`../src/i18n/locales/${lang}.json`))]));

// ---- message format -------------------------------------------------------------------------------
const wire = (o) => JSON.stringify({ t: 'chat', from: 'p', ts: '2026-10-24T10:00:00.000Z', id: 'c1', text: 'سلام', ...o });
assert.deepEqual(decodeMessage(wire({})), { from: 'p', ts: '2026-10-24T10:00:00.000Z', t: 'chat', id: 'c1', text: 'سلام' });
assert.equal(decodeMessage(wire({ text: '   ' })), null, 'blank text is dropped');
assert.equal(decodeMessage(wire({ text: '' })), null);
assert.equal(decodeMessage(wire({ text: 5 })), null);
assert.equal(decodeMessage(wire({ id: '' })), null, 'a message needs an id');
assert.equal(decodeMessage(wire({ id: 'x'.repeat(65) })), null);
assert.equal(decodeMessage(wire({ text: 'a'.repeat(MAX_CHAT + 1) })), null, 'too long is dropped, never cut');
assert.ok(decodeMessage(wire({ text: 'a'.repeat(MAX_CHAT) })), 'the longest text is accepted');
const longest = { t: 'chat', from: 'p', ts: '2026-10-24T10:00:00.000Z', id: 'c'.repeat(64), text: '\u{1F600}'.repeat(MAX_CHAT / 2) };
assert.ok(encodeMessage(longest), 'the longest chat message still fits the body limit');

// ---- database -------------------------------------------------------------------------------------
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
await migrateChat(db); // idempotent
assert.equal((await db.getAllAsync('SELECT version FROM migrations WHERE version = 14')).length, 1);
assert.equal(await lastChat(db), null);

assert.equal(await addChat(db, { id: 'a', fromMe: true, body: 'one', createdAt: '2026-10-24T10:00:00.000Z' }), true);
assert.equal(await addChat(db, { id: 'a', fromMe: true, body: 'again', createdAt: '2026-10-24T10:00:01.000Z' }), false, 'same id = a replay');
assert.equal(await addChat(db, { id: 'b', fromMe: false, body: '  two  ', createdAt: '2026-10-24T10:01:00.000Z' }), true);
assert.equal(await addChat(db, { id: 'c', fromMe: true, body: '   ', createdAt: '2026-10-24T10:02:00.000Z' }), false, 'blank text is not stored');
assert.equal(await addChat(db, { id: '', fromMe: true, body: 'x', createdAt: '2026-10-24T10:02:00.000Z' }), false);
assert.deepEqual((await listChat(db)).map((m) => [m.id, m.fromMe, m.body]), [['a', true, 'one'], ['b', false, 'two']], 'oldest first, trimmed');
assert.equal((await lastChat(db)).id, 'b');

for (let i = 0; i < 5; i += 1) await addChat(db, { id: `n${i}`, fromMe: i % 2 === 0, body: `m${i}`, createdAt: `2026-10-25T10:0${i}:00.000Z` });
assert.deepEqual((await listChat(db, 3)).map((m) => m.id), ['n2', 'n3', 'n4'], 'a limit keeps the newest ones');

await addChat(db, { id: 'f', fromMe: true, body: 'lost', createdAt: '2026-10-26T10:00:00.000Z', failed: true });
assert.equal((await getChat(db, 'f')).failed, true);
await setChatFailed(db, 'f', false);
assert.equal((await getChat(db, 'f')).failed, false, 'a retry that works clears the mark');
await setChatFailed(db, 'b', true);
assert.equal((await getChat(db, 'b')).failed, false, "only my own messages can be marked failed");

// ---- inbox ----------------------------------------------------------------------------------------
const notified = [];
const deps = {
  db, deviceId: 'me', setPartner: () => {}, onUnpaired: () => {}, replyProfile: () => {},
  prefs: () => ({ mood: true, event: true, diary: true, period: true }),
  notify: (n) => void notified.push(n),
  onChat: async (m) => addChat(db, { id: m.id, fromMe: false, body: m.text, createdAt: m.ts }),
};
const env = (id, o = {}) => ({ id, message: wire(o) });
assert.equal(await handleIncoming(deps, env('1', { id: 'in1', text: 'hi' })), 'chat');
assert.equal((await getChat(db, 'in1')).body, 'hi');
assert.equal(notified.length, 1);
assert.equal(notified[0].kind, 'chat');
assert.equal(await handleIncoming(deps, env('1', { id: 'in1', text: 'hi' })), 'duplicate', 'a replayed message is stored once and does not notify again');
assert.equal(notified.length, 1);
assert.equal(await handleIncoming(deps, env('2', { from: 'me', id: 'mine1' })), 'mine', 'my own message coming back is ignored');
assert.equal(await handleIncoming(deps, { id: '3', message: wire({ text: '' }) }), 'invalid');

// ---- push -----------------------------------------------------------------------------------------
assert.deepEqual(parsePushData({ type: 'chat', seq: '12' }), { type: 'chat', seq: '12' });
let syncs = 0;
const router = createPushRouter({ sync: () => { syncs += 1; } });
router.onPush({ type: 'chat', seq: '12' });
assert.equal(router.wasHeld('12'), true, 'an open app holds the generic system text of a chat push');
assert.equal(syncs, 1);

// ---- wiring ---------------------------------------------------------------------------------------
const manage = read('../src/partner/manage.ts');
assert.match(manage, /export async function sendChat/);
assert.match(manage, /export async function retryChat/);
assert.match(manage, /onChat:/, 'incoming chat is stored');
assert.match(manage, /chatScreenOpen/, 'no pop-up while the chat is open');
const screen = read('../app/chat.tsx');
assert.match(screen, /<FlatList/);
assert.match(screen, /inverted/);
assert.match(screen, /sendChat\(db/);
assert.match(screen, /retryChat\(db/);
assert.match(screen, /setChatScreenOpen\(true\)/);
assert.match(screen, /\/settings\/partner-profile/, 'the header opens the partner profile');
assert.doesNotMatch(screen, /react-native-keyboard-controller/, 'the plain keyboard padding is used (see diary/new)');
assert.match(read('../app/_layout.tsx'), /name="chat"/, 'the route is registered');
assert.match(read('../app/(tabs)/index.tsx'), /router\.push\('\/chat'\)/, 'the Home icon opens the chat');
assert.match(read('../server/meyou-server/src/partner/service.ts'), /'chat', 'chat-seen'/, 'the server accepts chat and chat-seen messages');
for (const lang of ['en', 'fa']) for (const key of ['chatTitle', 'chatEmptyTitle', 'chatEmptyBody', 'chatPlaceholder', 'chatSend', 'chatNotSent', 'chatRetryFailed', 'chatNotPaired', 'chatOpenProfile', 'chatSeen']) assert.ok(dict[lang][key], `${lang}.${key}`);

// ---- unread count and "Seen" -----------------------------------------------------------------------
{
  // chat-seen message format
  const seenWire = (o) => JSON.stringify({ t: 'chat-seen', from: 'p', ts: '2026-10-24T10:00:00.000Z', id: 'c1', silent: true, ...o });
  assert.deepEqual(decodeMessage(seenWire({})), { from: 'p', ts: '2026-10-24T10:00:00.000Z', t: 'chat-seen', id: 'c1', silent: true });
  assert.equal(decodeMessage(seenWire({ id: '' })), null);
  assert.equal(decodeMessage(seenWire({ id: 'x'.repeat(65) })), null);
  assert.ok(encodeMessage({ t: 'chat-seen', from: 'p', ts: '2026-10-24T10:00:00.000Z', id: 'c1', silent: true }));

  // the partner's texts are unread until the chat is opened; my own never are
  const unread = await unreadChatCount(db);
  assert.ok(unread >= 3, 'received texts start unread');
  assert.equal((await getChat(db, 'a')).seen, false);
  assert.equal(await markChatRead(db), 'n3', 'returns the newest unread partner text (to tell the partner)');
  assert.equal(await unreadChatCount(db), 0);
  assert.equal(await markChatRead(db), null, 'nothing left to mark');
  await addChat(db, { id: 'late', fromMe: false, body: 'new', createdAt: '2026-10-27T10:00:00.000Z' });
  assert.equal(await unreadChatCount(db), 1, 'a text that arrives later is unread again');
  assert.equal(await markChatRead(db), 'late');
  await addChat(db, { id: 'old-read', fromMe: false, body: 'seen on screen', createdAt: '2026-10-27T10:01:00.000Z', read: true });
  assert.equal(await unreadChatCount(db), 0, 'a text received while the chat is open is read at once');

  // "Seen": the partner read my messages up to an id
  assert.equal(await markChatSeenUpTo(db, 'zzz'), false, 'unknown id');
  assert.equal(await markChatSeenUpTo(db, 'n3'), false, 'only my own message ids count');
  assert.equal(await markChatSeenUpTo(db, 'n2'), true);
  const seen = Object.fromEntries((await listChat(db, 50)).filter((m) => m.fromMe).map((m) => [m.id, m.seen]));
  assert.deepEqual([seen.a, seen.n0, seen.n2, seen.n4, seen.f], [true, true, true, false, false], 'that message and every older one of mine; newer ones stay unseen');
  assert.equal(await markChatSeenUpTo(db, 'n2'), false, 'a repeated receipt changes nothing');
  assert.equal(await markChatSeenUpTo(db, 'f'), true);
  assert.equal((await getChat(db, 'n4')).seen, true);

  // the inbox hands the receipt on and never notifies
  const got = [];
  const notifiedBefore = notified.length;
  const seenDeps = { ...deps, onChatSeen: async (m) => void got.push(m.id) };
  assert.equal(await handleIncoming(seenDeps, { id: '9', message: seenWire({ id: 'n4' }) }), 'chat-seen');
  assert.deepEqual(got, ['n4']);
  assert.equal(notified.length, notifiedBefore, 'a receipt is never a notification');
  assert.equal(await handleIncoming(seenDeps, { id: '10', message: seenWire({ from: 'me' }) }), 'mine');

  // a phone that already had the chat table (before read/seen existed): old rows count as read, nothing is unseen
  const old = memoryDb();
  await old.execAsync('CREATE TABLE migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  await old.execAsync("CREATE TABLE chat_messages (id TEXT PRIMARY KEY NOT NULL, from_me INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'sent');");
  await old.execAsync("INSERT INTO chat_messages (id, from_me, body, created_at) VALUES ('o1', 0, 'old', '2026-10-20T10:00:00.000Z'), ('o2', 1, 'mine', '2026-10-20T10:01:00.000Z');");
  await migrateChat(old);
  await migrateChat(old); // idempotent
  assert.equal(await unreadChatCount(old), 0, 'messages from before the update do not become a huge badge');
  assert.equal((await getChat(old, 'o2')).seen, false);
}

// ---- wiring of the badge and the Seen mark ---------------------------------------------------------
assert.match(manage, /export async function markChatSeen/);
assert.match(manage, /t: 'chat-seen'/);
assert.match(manage, /onChatSeen:/, 'the partner receipt marks my messages seen');
assert.match(manage, /chatScreenOpen && AppState\.currentState === 'active'\) void markChatSeen/, 'a text that arrives in the open chat is read at once');
assert.match(screen, /markChatSeen\(db\)/, 'opening the chat marks the texts read');
assert.match(screen, /t\('chatSeen'\)/, 'the chat shows the Seen mark');
const homeSrc = read('../app/(tabs)/index.tsx');
assert.match(homeSrc, /unreadChatCount\(db\)/, 'the Home Direct icon counts unread texts');
assert.match(homeSrc, /unreadChat > 0/);
assert.equal(dict.fa.chatSeen, 'دیده شد');
assert.equal(dict.en.chatSeen, 'Seen');

console.log('chat ok');
