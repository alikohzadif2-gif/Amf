import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ServerProvider } from '../src/server/server-provider.ts';
import { ServerClient, isValidServerUrl, normalizeUrl } from '../src/server/client.ts';
import { dirId, fileId, parseDirId, parseFileId } from '../src/server/ids.ts';
import { parseServerQr } from '../src/server/qr.ts';
import { testConnection } from '../src/server/test-connection.ts';
import { StubSshInstaller } from '../src/server/ssh-installer.ts';
import { createUploadQueue } from '../src/backup/queue.ts';
import { scanNewMedia } from '../src/backup/backup-new.ts';
import { MockProvider } from '../src/storage/mock-provider.ts';
import { startFakeServer, contentFor } from './fake-server.mjs';

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const noSleep = async () => {};

// ---- ids, urls, QR, SSH stub --------------------------------------------------
{
  const d = dirId('my root', 'a b/ç:d');
  assert.deepEqual(parseDirId(d), { rootId: 'my root', path: 'a b/ç:d' });
  const f = fileId('r', 'id:1', 'x/y z.jpg');
  assert.deepEqual(parseFileId(f), { rootId: 'r', serverId: 'id:1', path: 'x/y z.jpg' });
  assert.equal(parseDirId(f), null);
  assert.equal(normalizeUrl(' 192.168.1.5:8080/ '), 'http://192.168.1.5:8080');
  assert.equal(isValidServerUrl('https://home.example.com:8443'), true);
  assert.equal(isValidServerUrl('ftp://x'), false);
  assert.equal(isValidServerUrl(''), false);

  const json = parseServerQr('{"url":"https://h.example:8443/","token":" abc ","name":"Home","fp":"AA:BB"}');
  assert.deepEqual(json, { url: 'https://h.example:8443', token: 'abc', name: 'Home', fingerprint: 'AA:BB' });
  const link = parseServerQr('meyou://server?url=http%3A%2F%2F10.0.0.2%3A8787&token=t%2Fk&name=My+Server');
  assert.deepEqual(link, { url: 'http://10.0.0.2:8787', token: 't/k', name: 'My Server', fingerprint: undefined });
  assert.equal(parseServerQr('hello'), null);
  assert.equal(parseServerQr('{"url":"x"}'), null);
  assert.equal(parseServerQr('meyou://server?url=http%3A%2F%2Fa.b'), null);

  const ssh = new StubSshInstaller();
  assert.equal(ssh.available, false);
  assert.deepEqual(await ssh.install(), { ok: false, code: 'not-implemented' });
}

// ---- provider against the fake HTTP server -----------------------------------
const server = await startFakeServer({ token: 'secret', dropPatchAt: 0 });
const dead = { id: 'dead', url: 'http://127.0.0.1:1', token: 'secret' };
const good = { id: 'good', url: server.url, token: 'secret' };

const makeProvider = (endpoints, failover = true, readers = {}) =>
  new ServerProvider('srv', {
    endpoints: () => endpoints,
    failover: () => failover,
    timeoutMs: 3000,
    sleep: noSleep,
    openReader: async (uri) => {
      const data = readers[uri];
      if (!data) throw new Error(`no file ${uri}`);
      return { size: data.length, read: async (offset, length) => new Uint8Array(data.subarray(offset, offset + length)) };
    },
  });

const provider = makeProvider([good]);

// test(): ok / unauthorized / unavailable
{
  const ok = await provider.test();
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'ok');
  assert.equal(ok.rootCount, 2);
  const bad = await makeProvider([{ ...good, token: 'wrong' }]).test();
  assert.deepEqual([bad.ok, bad.code], [false, 'unauthorized']);
  const down = await makeProvider([dead]).test();
  assert.deepEqual([down.ok, down.code], [false, 'unavailable']);
  const none = await makeProvider([]).test();
  assert.equal(none.ok, false);
}

// browse: roots, nested, paging
const roots = await provider.list(null);
assert.deepEqual(roots.items.map((i) => i.name), ['Photos', 'Videos']);
assert.ok(roots.items.every((i) => i.type === 'dir' && i.parentId === null));
const photos = roots.items[0];
const top = await provider.list(photos.id);
assert.equal(top.items[0].name, '2024');
assert.equal(top.items[0].type, 'dir');
assert.equal(top.items[0].parentId, photos.id);
assert.ok(top.items.some((i) => i.name === 'cover.jpg'));
const dir2024 = top.items[0];
let seen = [];
let cursor;
let pages = 0;
do {
  const page = await provider.list(dir2024.id, { limit: 10, cursor });
  seen = seen.concat(page.items);
  cursor = page.nextCursor;
  pages += 1;
} while (cursor);
assert.equal(seen.length, 25);
assert.equal(pages, 3);
assert.equal(new Set(seen.map((i) => i.id)).size, 25, 'paging covers everything once');
assert.ok(seen.every((i) => i.type === 'image' && i.md5 && i.size > 0));

// stat on a fresh provider (empty cache) resolves via the parent listing
{
  const fresh = makeProvider([good]);
  const statDir = await fresh.stat(dir2024.id);
  assert.equal(statDir?.name, '2024');
  const statFile = await fresh.stat(seen[3].id);
  assert.equal(statFile?.name, seen[3].name);
  assert.equal(await fresh.stat(dirId('photos', 'nope')), null);
}

// thumbnails / preview / original: auth goes in headers, never in the URL
{
  const first = seen[0];
  const thumb = await provider.getThumb(first.id, 256);
  assert.ok(thumb.uri.includes('/thumb?size=256'));
  assert.ok(!thumb.uri.includes('secret'), 'token must not be in the URL');
  assert.equal(thumb.headers.Authorization, 'Bearer secret');
  const ok = await fetch(thumb.uri, { headers: thumb.headers });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(thumb.uri)).status, 401, 'without headers the server refuses');
  const preview = await provider.getPreview(first.id);
  assert.equal((await fetch(preview.uri, { headers: preview.headers })).status, 200);
  assert.equal(await provider.getThumb(dir2024.id), null);

  const bare = await provider.getOriginalUrl(first.id);
  assert.ok(bare.endsWith('/file') && !bare.includes('secret'));
  assert.equal((await fetch(bare)).status, 401, 'bare URL alone is not enough: video needs headers');
  const videoDir = await provider.list(roots.items[1].id);
  const clip = videoDir.items[0];
  const src = await provider.getOriginalSource(clip.id);
  const range = await fetch(src.uri, { headers: { ...src.headers, Range: 'bytes=100-199' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 100-199/${clip.size}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), contentFor(300000, 5).subarray(100, 200));
}

// upload: chunked (1 MiB chunks), progress, md5 verified by the server
const big = contentFor(2_500_000, 3);
const readers = { 'file:///big.bin': big, 'file:///pic.jpg': contentFor(1234, 8) };
const uploader = makeProvider([good], true, readers);
{
  const progress = [];
  const item = await uploader.upload({
    name: 'big.bin', size: big.length, parentId: dirId('photos', 'Uploads/2026'), sourceUri: 'file:///big.bin',
    md5: md5(big), onProgress: (sent) => progress.push(sent),
  });
  assert.equal(item.name, 'big.bin');
  assert.equal(item.size, big.length);
  assert.equal(parseFileId(item.id).path, 'Uploads/2026/big.bin');
  assert.deepEqual(progress.at(-1), big.length);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.equal(server.requests.patch, 3, '2.5 MB = 3 chunks of 1 MiB');
  assert.deepEqual(md5(server.completedUploads.at(-1).data), md5(big));
  const listed = await uploader.list(dirId('photos', 'Uploads/2026'));
  assert.equal(listed.items[0].name, 'big.bin');
  // null parent goes to the first root
  const rootUp = await uploader.upload({ name: 'pic.jpg', size: 1234, parentId: null, sourceUri: 'file:///pic.jpg' });
  assert.equal(parseFileId(rootUp.id).rootId, 'photos');
  await assert.rejects(() => uploader.upload({ name: 'x', size: 1, parentId: null, sourceUri: 'file:///missing' }));
  await assert.rejects(() => uploader.delete('x'));
}

// changes: items from /changes carry root/path so ids stay usable
{
  const all = await uploader.changes();
  assert.equal(all.changes.length, 2);
  assert.equal(all.changes[0].op, 'add');
  assert.equal(parseFileId(all.changes[0].id).path, 'Uploads/2026/big.bin');
  assert.equal(all.changes[0].item.parentId, dirId('photos', 'Uploads/2026'));
  const none = await uploader.changes(all.cursor);
  assert.equal(none.changes.length, 0);
}

// resume after the connection drops in the middle of an upload
{
  const flaky = await startFakeServer({ token: 'secret', dropPatchAt: 2 });
  const p = new ServerProvider('flaky', {
    endpoints: () => [{ id: 'f', url: flaky.url, token: 'secret' }],
    timeoutMs: 3000,
    sleep: noSleep,
    openReader: async () => ({ size: big.length, read: async (o, l) => new Uint8Array(big.subarray(o, o + l)) }),
  });
  const sent = [];
  await p.upload({ name: 'resume.bin', size: big.length, parentId: dirId('videos', ''), sourceUri: 'x', md5: md5(big), onProgress: (s) => sent.push(s) });
  assert.equal(flaky.requests.post, 2, 'second POST /uploads resumed the same upload');
  assert.equal(md5(flaky.completedUploads[0].data), md5(big));
  assert.ok(sent.includes(1048576), 'continued from the 1 MiB offset the server reported');
  await flaky.close();
}

// failover: dead first, good second
{
  const withFailover = makeProvider([dead, good], true);
  const t = await withFailover.test();
  assert.equal(t.ok, true);
  assert.ok((await withFailover.list(null)).items.length === 2);
  const thumb = await withFailover.getThumb(seen[0].id);
  assert.ok(thumb.uri.startsWith(server.url), 'URLs use the endpoint that works');
  const noFailover = makeProvider([dead, good], false);
  assert.equal((await noFailover.test()).code, 'unavailable');
  // a 401 is a configuration error, not a reason to switch
  const unauth = makeProvider([{ ...good, token: 'bad' }, good], true);
  assert.equal((await unauth.test()).code, 'unauthorized');
}

// wizard/servers-screen connection test
{
  const ok = await testConnection({ url: server.url, token: 'secret' });
  assert.deepEqual([ok.ok, ok.code, ok.rootCount, ok.ping.name], [true, 'ok', 2, 'Fake meYou server']);
  assert.equal((await testConnection({ url: server.url, token: 'nope' })).code, 'unauthorized');
  assert.equal((await testConnection({ url: 'http://127.0.0.1:1', token: 'x' }, undefined, 2000)).code, 'unavailable');
}

// client timeout -> 'timeout'
{
  const slow = new ServerClient({ url: server.url, token: 'secret' }, () => new Promise(() => {}), 50);
  await assert.rejects(() => slow.ping(), (e) => e.kind === 'timeout');
}

// ---- upload queue ------------------------------------------------------------
{
  const store = new Map();
  const memory = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  const q = createUploadQueue({ resolveProvider: () => uploader, storage: memory, storageName: 'q' });
  const base = { sourceId: 'srv', parentId: dirId('photos', 'Queue') };
  const n = q.getState().enqueue([
    { ...base, uri: 'file:///pic.jpg', name: 'a.jpg', size: 1234, backupKey: 'key-a' },
    { ...base, uri: 'file:///missing.jpg', name: 'b.jpg', size: 10, backupKey: 'key-b' },
    { ...base, uri: 'file:///pic.jpg', name: 'dupe.jpg', size: 1234 },
  ]);
  assert.equal(n, 2, 'same file queued twice is ignored');
  await q.getState().start();
  let s = q.getState();
  assert.deepEqual(s.jobs.map((j) => j.state), ['done', 'failed']);
  assert.equal(s.jobs[1].error, 'error');
  assert.ok(s.backedUp['key-a'] && !s.backedUp['key-b']);
  assert.equal(s.running, false);
  readers['file:///missing.jpg'] = contentFor(10, 1);
  await q.getState().retryFailed();
  s = q.getState();
  assert.deepEqual(s.jobs.map((j) => j.state), ['done', 'done']);
  assert.ok(s.backedUp['key-b']);
  // pause: a paused queue does not start new jobs
  q.getState().enqueue([{ ...base, uri: 'file:///pic.jpg', name: 'c.jpg', size: 1234 }]);
  q.getState().pause();
  q.setState({ paused: true });
  await q.getState().resume();
  assert.equal(q.getState().jobs.at(-1).state, 'done');
  q.getState().clearFinished();
  assert.equal(q.getState().jobs.length, 0);
  // persistence: backedUp survives, interrupted jobs go back to queued
  const interrupted = createUploadQueue({ resolveProvider: () => uploader, storage: memory, storageName: 'q' });
  assert.ok(interrupted.getState().backedUp['key-a']);
  store.set('q2', JSON.stringify({ state: { jobs: [{ id: 'x', sourceId: 'srv', parentId: null, uri: 'u', name: 'n', size: 1, state: 'uploading', sent: 1, addedAt: '2026-01-01T00:00:00.000Z' }], paused: false, backedUp: {} }, version: 1 }));
  const restored = createUploadQueue({ resolveProvider: () => uploader, storage: memory, storageName: 'q2' });
  assert.equal(restored.getState().jobs[0].state, 'queued');
  // a missing source fails the job instead of crashing
  const lost = createUploadQueue({ resolveProvider: () => null });
  lost.getState().enqueue([{ sourceId: 'gone', parentId: null, uri: 'u', name: 'n', size: 1 }]);
  await lost.getState().start();
  assert.equal(lost.getState().jobs[0].state, 'failed');
}

// ---- "back up new media" scan -------------------------------------------------
{
  // phone: one photo the server already has (same name + size), two new ones, one video
  const existing = seen[0];
  const phoneItems = [
    { id: 'ml:asset:1', name: existing.name, type: 'image', size: 0, mtime: '2024-05-01T10:00:00.000Z' },
    { id: 'ml:asset:2', name: 'NEW_1.jpg', type: 'image', size: 0, mtime: '2026-02-03T09:00:00.000Z' },
    { id: 'ml:asset:3', name: 'NEW_2.jpg', type: 'image', size: 0, mtime: '2026-02-20T09:00:00.000Z' },
    { id: 'ml:asset:4', name: 'trip.mp4', type: 'video', size: 0, mtime: '2025-12-15T12:00:00.000Z' },
    { id: 'ml:asset:5', name: 'notes.txt', type: 'text', size: 0, mtime: '2025-12-31T23:59:59.000Z' },
  ].map((i) => ({ ...i, parentId: 'ml:album:1' }));
  const phone = {
    id: 'local', kind: 'local', isMock: false,
    list: async (parent) => parent === null
      ? { items: [{ id: 'ml:album:1', parentId: null, name: 'Camera', type: 'dir', size: 0, mtime: new Date(0).toISOString() }] }
      : { items: phoneItems },
    getOriginalUrl: async (id) => `file:///${id}`,
  };
  const sizes = { 'file:///ml:asset:1': existing.size, 'file:///ml:asset:2': 111, 'file:///ml:asset:3': 222, 'file:///ml:asset:4': 3333 };
  const localInfo = (uri) => (sizes[uri] ? { size: sizes[uri] } : null);
  const scan = await scanNewMedia({ phone, target: makeProvider([good]), backedUp: {}, localInfo });
  assert.equal(scan.scanned, 4, 'only photos and videos are considered');
  assert.deepEqual(scan.jobs.map((j) => j.name).sort(), ['NEW_1.jpg', 'NEW_2.jpg', 'trip.mp4']);
  assert.equal(scan.alreadyThere, 1);
  const byName = Object.fromEntries(scan.jobs.map((j) => [j.name, j]));
  assert.deepEqual(parseDirId(byName['NEW_1.jpg'].parentId), { rootId: 'photos', path: '2026/02' });
  assert.deepEqual(parseDirId(byName['trip.mp4'].parentId), { rootId: 'videos', path: '2025/12' });
  assert.ok(scan.jobs.every((j) => j.backupKey && j.sourceId === 'srv'));
  // already queued/uploaded items are skipped next time
  const again = await scanNewMedia({
    phone, target: makeProvider([good]), localInfo,
    backedUp: Object.fromEntries(scan.jobs.map((j) => [j.backupKey, '2026-03-01T00:00:00.000Z'])),
  });
  assert.equal(again.jobs.length, 0);

  // works against the demo (mock) server too: uploads go to its first root
  const mock = new MockProvider('mock-srv', 'server', 1);
  const mockScan = await scanNewMedia({ phone, target: mock, backedUp: {}, localInfo });
  assert.ok(mockScan.jobs.length >= 3);
  assert.ok(mockScan.jobs.every((j) => j.parentId !== null && !j.parentId.startsWith('d:')), 'demo server: plain root id');
  const mq = createUploadQueue({ resolveProvider: () => mock });
  mq.getState().enqueue(mockScan.jobs.slice(0, 1));
  await mq.getState().start();
  assert.equal(mq.getState().jobs[0].state, 'done');
}

await server.close();

// ---- optional: a real server (set MEYOU_SERVER_URL and MEYOU_SERVER_TOKEN) ------
const realUrl = process.env.MEYOU_SERVER_URL;
const realToken = process.env.MEYOU_SERVER_TOKEN;
if (realUrl && realToken) {
  const real = new ServerProvider('real', { endpoints: () => [{ id: 'real', url: realUrl, token: realToken }] });
  const t = await real.test();
  console.log(`real server ${realUrl}: ${t.code}, ${t.latencyMs} ms, ${t.rootCount ?? 0} roots`);
  assert.equal(t.ok, true, 'real server test failed');
  const rr = await real.list(null);
  for (const root of rr.items.slice(0, 3)) {
    const page = await real.list(root.id, { limit: 5 });
    console.log(`  ${root.name}: ${page.items.length} items on the first page${page.nextCursor ? ' (+more)' : ''}`);
  }
} else {
  console.log('real-server smoke skipped (set MEYOU_SERVER_URL and MEYOU_SERVER_TOKEN to run it)');
}

console.log('server tests passed');
