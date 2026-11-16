// S2 + S4: the app's connection code and Library source (ServerProvider) against the REAL server from server/meyou-server (phase S1).
// Starts it on a free local port with a temporary data folder. Skipped (exit 0) when the server
// package has no node_modules (run `npm ci` in server/meyou-server first).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ServerClient } from '../src/server/client.ts';
import { parseServerQr } from '../src/server/qr.ts';
import { connectionMessageKey } from '../src/server/connection-text.ts';
import { testConnection } from '../src/server/test-connection.ts';
import { ServerProvider } from '../src/server/server-provider.ts';
import { isServerError } from '../src/server/errors.ts';
import { dirId, fileId, parseDirId, parseFileId } from '../src/server/ids.ts';
import { FolderLoader } from '../src/library/folder-loader.ts';
import { diagnoseSource } from '../src/library/load-issue.ts';
import { mergeInto } from '../src/library/merge.ts';
import { originalSource } from '../src/storage/original.ts';
import { uploadResumable, UploadCancelled } from '../src/server/upload.ts';
import { scanNewMedia } from '../src/backup/backup-new.ts';
import { createUploadQueue } from '../src/backup/queue.ts';
import { ServerError } from '../src/server/errors.ts';
import { MailboxClient, MailboxListener, joinMailbox } from '../src/partner/mailbox-client.ts';
import { resolveShared, uploadShared } from '../src/partner/shared-media.ts';
import crypto from 'node:crypto';

const serverDir = path.resolve(new URL('../server/meyou-server', import.meta.url).pathname);
if (!fs.existsSync(path.join(serverDir, 'node_modules', 'tsx'))) {
  console.log('live server test skipped: run "npm ci" in server/meyou-server to enable it');
  process.exit(0);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

const children = [];
const dirs = [];
const logs = [];

function cli(args, env) {
  return { cmd: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', ...args], opts: { cwd: serverDir, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } } };
}

async function startServer(extraEnv = {}, { init = true } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-live-'));
  dirs.push(dataDir);
  const url = `http://127.0.0.1:${port}`;
  const env = { DATA_DIR: dataDir, DOMAIN: 'localhost', PUBLIC_URL: url, PORT: String(port), HOST: '127.0.0.1', SERVER_NAME: 'Live Home', ...extraEnv };
  let link = null;
  if (init) {
    const c = cli(['init'], env);
    const r = spawnSync(c.cmd, c.args, { ...c.opts, encoding: 'utf8' });
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    link = /^(meyou:\/\/server\?\S+)$/m.exec(r.stdout)?.[1] ?? null;
    assert.ok(link, 'init printed a link');
  }
  const c = cli(['serve'], env);
  const child = spawn(c.cmd, c.args, c.opts);
  children.push(child);
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/api/v1/ping`);
      if (res.status === 200 || res.status === 429) return { url, link, dataDir };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${logs.join('')}`);
}

function startPlainServer(status, body, contentType) {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

try {
  const real = await startServer();
  const code = parseServerQr(real.link);
  assert.ok(code, 'the link printed by init is accepted by the app');
  assert.equal(code.url, real.url);
  assert.equal(code.name, 'Live Home');
  assert.ok(code.token.length >= 40);

  // 1. Connect with the token from the link
  const ok = await testConnection({ url: code.url, token: code.token });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.code, 'ok');
  assert.equal(ok.ping.name, 'Live Home');
  assert.deepEqual(ok.ping.features, ['media', 'upload', 'mailbox', 'e2e']); // S3: media read API, S5: resumable upload, sharing stage 2: encrypted queue
  assert.equal(ok.me.role, 'owner');
  assert.deepEqual(ok.me.household, { partner: null });
  assert.deepEqual(ok.me.features, ['media', 'upload', 'mailbox', 'e2e']);
  assert.equal(ok.rootCount, 2);
  assert.equal(connectionMessageKey(ok), 'testOk');

  // 2. The client sees the folders the server created
  const client = new ServerClient({ url: code.url, token: code.token });
  assert.deepEqual((await client.roots()).map((r) => r.id), ['Photos', 'Videos']);
  assert.equal((await client.me()).role, 'owner');

  // 3. Wrong token: ping (public) works, the token check fails with its own message
  const wrong = await testConnection({ url: code.url, token: 'x'.repeat(43) });
  assert.deepEqual([wrong.ok, wrong.issue, connectionMessageKey(wrong)], [false, 'unauthorized', 'connUnauthorized']);
  const empty = await testConnection({ url: code.url, token: 'short' });
  assert.equal(empty.issue, 'unauthorized');

  // 4. Nobody home / not a meYou server
  const closed = await testConnection({ url: `http://127.0.0.1:${await freePort()}`, token: code.token }, undefined, 3000);
  assert.deepEqual([closed.code, closed.issue, connectionMessageKey(closed)], ['unavailable', 'unreachable', 'connUnreachable']);
  const html = await startPlainServer(200, '<html>hello</html>', 'text/html');
  const notMe = await testConnection({ url: html.url, token: code.token });
  assert.deepEqual([notMe.ok, notMe.issue], [false, 'not-meyou']);
  html.close();
  const missing = await startPlainServer(404, 'nope', 'text/plain');
  assert.equal((await testConnection({ url: missing.url, token: code.token })).issue, 'not-meyou');
  missing.close();

  // 5. Trailing slash / no scheme in what the person typed
  const typed = await testConnection({ url: `${real.url.replace('http://', '')}/`, token: code.token });
  assert.equal(typed.ok, true);

  // 6. Rate limiting is reported as "busy", not as a broken server
  // The start-up readiness poll uses one of the allowed public requests, so allow 3: poll, a, b pass; c is limited.
  const limited = await startServer({ PUBLIC_RATE_LIMIT_MAX: '3' }, { init: false });
  const a = await testConnection({ url: limited.url, token: 'x'.repeat(43) });
  const b = await testConnection({ url: limited.url, token: 'x'.repeat(43) });
  const c = await testConnection({ url: limited.url, token: 'x'.repeat(43) });
  assert.ok(![a, b].some((r) => r.issue === 'busy'));
  assert.deepEqual([c.ok, c.issue, connectionMessageKey(c)], [false, 'busy', 'connBusy']);

  // 7. S3 media read API through the app's ServerClient (tree, thumb, preview, Range, changes)
  const media = await startServer({ SCAN_INTERVAL_SECONDS: '1' });
  const mcode = parseServerQr(media.link);
  const mclient = new ServerClient({ url: mcode.url, token: mcode.token });
  const sharp = createRequire(path.join(serverDir, 'package.json'))('sharp');
  const photos = path.join(media.dataDir, 'library', 'Photos');
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toFile(path.join(photos, 'live.jpg'));
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  fs.writeFileSync(path.join(photos, 'bytes.bin'), bytes);
  fs.mkdirSync(path.join(photos, 'trip'));
  let page;
  for (let i = 0; i < 80; i++) {
    page = await mclient.tree('Photos', '');
    if (page.items.length === 3) break; // the 1 s rescan picks the new files up
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(page.items.map((x) => x.name), ['trip', 'bytes.bin', 'live.jpg']);
  assert.equal(page.items[0].type, 'dir');
  const img = page.items.find((x) => x.name === 'live.jpg');
  assert.deepEqual([img.type, img.mime, img.width, img.height], ['image', 'image/jpeg', 640, 480]);
  assert.equal(page.nextCursor, undefined);
  const small = await mclient.tree('Photos', '', undefined, 2);
  assert.equal(small.items.length, 2);
  assert.ok(small.nextCursor);
  const rest = await mclient.tree('Photos', '', small.nextCursor, 2);
  assert.deepEqual(rest.items.map((x) => x.name), ['live.jpg']);

  const th = await fetch(mclient.thumbUrl(img.id, 128), { headers: mclient.authHeaders() });
  assert.equal(th.status, 200);
  assert.equal(th.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([(await sharp(Buffer.from(await th.arrayBuffer())).metadata()).width], [128]);
  const pv = await fetch(mclient.previewUrl(img.id), { headers: mclient.authHeaders() });
  assert.equal(pv.status, 200);
  assert.equal((await fetch(mclient.thumbUrl(img.id, 128))).status, 401, 'no header, no thumbnail');

  const bin = page.items.find((x) => x.name === 'bytes.bin');
  const part = await fetch(mclient.fileUrl(bin.id), { headers: { ...mclient.authHeaders(), Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/100');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
  const oob = await fetch(mclient.fileUrl(bin.id), { headers: { ...mclient.authHeaders(), Range: 'bytes=500-' } });
  assert.equal(oob.status, 416);

  const ch = await mclient.changes('0');
  assert.ok(ch.changes.some((c) => c.op === 'add' && c.path === 'live.jpg' && c.root === 'Photos' && c.item?.id === img.id));
  assert.equal((await mclient.changes(ch.cursor)).changes.length, 0);
  fs.rmSync(path.join(photos, 'bytes.bin'));
  let gone;
  for (let i = 0; i < 80 && !gone; i++) {
    gone = (await mclient.changes(ch.cursor)).changes.find((c) => c.op === 'delete' && c.path === 'bytes.bin');
    if (!gone) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(gone, 'a deleted file shows up as a delete change');


  // 8. S4: the app's real ServerProvider (the Library source) against the real server
  const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) throw new Error('timed out waiting for the server');
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const ffmpegPath = createRequire(path.join(serverDir, 'package.json'))('@ffmpeg-installer/ffmpeg').path;
  const videos = path.join(media.dataDir, 'library', 'Videos');
  spawnSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', path.join(videos, 'clip.mp4')], { stdio: 'inherit' });
  assert.ok(fs.existsSync(path.join(videos, 'clip.mp4')), 'test video was generated');
  fs.mkdirSync(path.join(photos, 'trip'), { recursive: true });
  await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg().toFile(path.join(photos, 'trip', 'inner.jpg'));
  fs.mkdirSync(path.join(photos, 'many'));
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(photos, 'many', `f${String(i).padStart(3, '0')}.txt`), `file ${i}`);

  const makeProvider = (url, token, id = 'live') =>
    new ServerProvider(id, { endpoints: () => [{ id: `e-${id}`, url, token }], failover: () => false, timeoutMs: 3000 });
  const prov = makeProvider(mcode.url, mcode.token);

  // roots, folders first, item fields and ids
  const roots = (await prov.list(null)).items;
  assert.deepEqual(roots.map((r) => [r.name, r.type]), [['Photos', 'dir'], ['Videos', 'dir']]);
  assert.deepEqual(parseDirId(roots[0].id), { rootId: 'Photos', path: '' });
  const photosId = dirId('Photos', '');
  const videosId = dirId('Videos', '');
  const listed = await until(async () => {
    const page = (await prov.list(photosId)).items;
    return page.some((i) => i.name === 'many') && page.some((i) => i.name === 'trip') ? page : null;
  });
  assert.equal(listed[0].type, 'dir', 'folders come first');
  const live = listed.find((i) => i.name === 'live.jpg');
  assert.deepEqual([live.type, live.mime, live.width, live.height, live.parentId], ['image', 'image/jpeg', 640, 480, photosId]);
  assert.equal(parseFileId(live.id).serverId, img.id);
  assert.equal(live.id, fileId('Photos', img.id, 'live.jpg'));

  // paging through the provider (limit 1 -> cursor)
  const first = await prov.list(photosId, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor, 'a next page is announced');
  const second = await prov.list(photosId, { limit: 1, cursor: first.nextCursor });
  assert.notEqual(second.items[0].id, first.items[0].id);

  // nested folder
  // the 1 s rescan indexes the files written above; wait for them instead of sleeping
  const inner = await until(async () => {
    const items = (await prov.list(dirId('Photos', 'trip'))).items;
    return items.length > 0 ? items : null;
  });
  assert.deepEqual(inner.map((i) => i.name), ['inner.jpg']);
  assert.deepEqual(parseFileId(inner[0].id).path, 'trip/inner.jpg');

  // stat on a fresh provider (no id cache): file, folder, unknown
  const fresh = makeProvider(mcode.url, mcode.token, 'fresh');
  assert.equal((await fresh.stat(live.id)).name, 'live.jpg');
  assert.equal((await fresh.stat(dirId('Photos', 'trip'))).type, 'dir');
  assert.equal(await fresh.stat(fileId('Photos', 'AAAAAAAAAAAAAAAAAAAAAA', 'nope.jpg')), null);

  // the app's folder loader pages through a 250-file folder against the real server (page size 120)
  await until(async () => (await mclient.tree('Photos', 'many', undefined, 500)).items.length === 250);
  const manyRef = [{ sourceId: 'live', itemId: dirId('Photos', 'many') }];
  const loader = new FolderLoader([prov], manyRef);
  let rounds = 0;
  while (await loader.loadMore()) rounds += 1;
  assert.equal(loader.entries('name').length, 250);
  assert.ok(rounds >= 2, `paged in ${rounds + 1} requests`);
  assert.equal(loader.issue, null);

  // thumbnails, preview and original with the Authorization header and no token in the URL
  const thumb = await prov.getThumb(live.id, 128);
  assert.ok(thumb.headers.Authorization.startsWith('Bearer '));
  assert.ok(!thumb.uri.includes(mcode.token), 'no token inside the URL');
  const thumbRes = await fetch(thumb.uri, { headers: thumb.headers });
  assert.deepEqual([thumbRes.status, thumbRes.headers.get('content-type')], [200, 'image/jpeg']);
  assert.equal((await sharp(Buffer.from(await thumbRes.arrayBuffer())).metadata()).width, 128);
  assert.equal((await fetch(thumb.uri)).status, 401, 'the image view needs the header');
  const prevRef = await prov.getPreview(live.id);
  assert.equal((await fetch(prevRef.uri, { headers: prevRef.headers })).status, 200);

  // video: listing, poster frame, and Range reads the way the player makes them
  const clip = await until(async () => (await prov.list(videosId)).items.find((i) => i.name === 'clip.mp4'));
  assert.deepEqual([clip.type, clip.mime, clip.width, clip.height], ['video', 'video/mp4', 320, 240]);
  assert.ok(clip.duration >= 2 && clip.duration <= 4, `duration ${clip.duration}`);
  const diskBytes = fs.readFileSync(path.join(videos, 'clip.mp4'));
  assert.equal(clip.size, diskBytes.length);
  const poster = await prov.getThumb(clip.id, 256);
  const posterRes = await fetch(poster.uri, { headers: poster.headers });
  assert.deepEqual([posterRes.status, posterRes.headers.get('content-type')], [200, 'image/jpeg']);
  const source = await originalSource(prov, clip.id);
  assert.ok(source.headers.Authorization && !source.uri.includes(mcode.token));
  const head = await fetch(source.uri, { headers: { ...source.headers, Range: 'bytes=0-1023' } });
  assert.deepEqual([head.status, head.headers.get('content-type'), head.headers.get('accept-ranges')], [206, 'video/mp4', 'bytes']);
  assert.equal(head.headers.get('content-range'), `bytes 0-1023/${diskBytes.length}`);
  assert.deepEqual(Buffer.from(await head.arrayBuffer()), diskBytes.subarray(0, 1024));
  const mid = Math.floor(diskBytes.length / 2);
  const seek = await fetch(source.uri, { headers: { ...source.headers, Range: `bytes=${mid}-` } });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get('content-range'), `bytes ${mid}-${diskBytes.length - 1}/${diskBytes.length}`);
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), diskBytes.subarray(mid));
  const tail = await fetch(source.uri, { headers: { ...source.headers, Range: 'bytes=-500' } });
  assert.deepEqual([tail.status, Buffer.from(await tail.arrayBuffer()).equals(diskBytes.subarray(diskBytes.length - 500))], [206, true]);
  assert.equal((await fetch(source.uri, { headers: { Range: 'bytes=0-9' } })).status, 401);

  // /changes through the provider uses the same ids as the listing
  const pc = await prov.changes('0');
  const liveChange = pc.changes.find((c) => c.item?.name === 'live.jpg');
  assert.equal(liveChange.op, 'add');
  assert.equal(liveChange.id, live.id);
  assert.equal(liveChange.item.parentId, photosId);

  // the same file seen on the phone and the server merges into one entry (the "backed up" badge)
  const merged = new Map();
  mergeInto(merged, 'local', [{ ...live, id: 'local-1' }]);
  mergeInto(merged, 'live', [live]);
  assert.equal(merged.size, 1);
  assert.equal([...merged.values()][0].refs.length, 2);

  // errors: wrong token, nobody home, a folder or file that is gone
  const wrongProv = makeProvider(mcode.url, 'x'.repeat(43), 'wrong');
  assert.deepEqual([(await wrongProv.test()).ok, (await wrongProv.test()).code], [false, 'unauthorized']);
  await assert.rejects(() => wrongProv.list(null), (e) => isServerError(e) && e.kind === 'unauthorized');
  const wrongLoader = new FolderLoader([wrongProv], null);
  while (await wrongLoader.loadMore());
  assert.equal(wrongLoader.issue, 'unauthorized');
  assert.equal(await diagnoseSource(wrongProv), 'unauthorized');
  const wrongThumb = await wrongProv.getThumb(live.id, 128);
  assert.equal((await fetch(wrongThumb.uri, { headers: wrongThumb.headers })).status, 401);

  const deadProv = makeProvider(`http://127.0.0.1:${await freePort()}`, mcode.token, 'dead');
  assert.deepEqual([(await deadProv.test()).ok, (await deadProv.test()).code], [false, 'unavailable']);
  const deadLoader = new FolderLoader([deadProv], null);
  while (await deadLoader.loadMore());
  assert.equal(deadLoader.issue, 'unreachable');
  assert.equal(await diagnoseSource(deadProv), 'unreachable');
  await assert.rejects(() => deadProv.getOriginalSource(clip.id), (e) => isServerError(e) && e.isUnreachable);

  await assert.rejects(() => prov.list(dirId('Photos', 'nope')), (e) => isServerError(e) && e.kind === 'http' && e.status === 404);
  const goneLoader = new FolderLoader([prov], [{ sourceId: 'live', itemId: dirId('Photos', 'nope') }]);
  while (await goneLoader.loadMore());
  assert.equal(goneLoader.issue, 'missing');

  fs.rmSync(path.join(photos, 'trip', 'inner.jpg'));
  const innerThumb = await prov.getThumb(inner[0].id, 128);
  await until(async () => (await fetch(innerThumb.uri, { headers: innerThumb.headers })).status === 404);
  assert.equal(await diagnoseSource(prov), 'missing', 'server is fine, so the file itself is gone');


  // 8b. S5: resumable upload with the app's real client (src/server/upload.ts) against the real server
  {
    const upClient = mclient;
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 4321);
    const md5 = crypto.createHash('md5').update(bytes).digest('hex');
    const reader = { size: bytes.length, read: async (offset, length) => new Uint8Array(bytes.subarray(offset, offset + length)) };
    const noSleep = async () => {};
    const progress = [];
    const item = await uploadResumable(upClient, reader, { name: 'up.mp4', size: bytes.length, rootId: 'Videos', path: '2026/10', md5 }, { sleep: noSleep, onProgress: (sent) => progress.push(sent) });
    assert.equal(item.name, 'up.mp4');
    assert.equal(item.size, bytes.length);
    assert.equal(item.type, 'video');
    assert.deepEqual(fs.readFileSync(path.join(media.dataDir, 'library', 'Videos', '2026', '10', 'up.mp4')), bytes);
    assert.equal(progress.at(-1), bytes.length);
    // listed immediately through the normal read API, same id as the upload answer
    const listed = await mclient.tree('Videos', '2026/10');
    assert.deepEqual(listed.items.map((i) => i.id), [item.id]);
    const changed = await mclient.changes('0');
    assert.ok(changed.changes.some((c) => c.op === 'add' && c.path === '2026/10/up.mp4' && c.id === item.id));

    // the network drops twice in the middle: the client's retry resumes at the server's offset
    const flaky = Object.create(upClient);
    let patches = 0;
    const sentOffsets = [];
    flaky.patchUpload = async (id, offset, chunk) => {
      patches += 1;
      if (patches === 2 || patches === 4) throw new ServerError('network', 0, 'dropped');
      sentOffsets.push(offset);
      return upClient.patchUpload(id, offset, chunk);
    };
    const bytes2 = crypto.randomBytes(5 * 1024 * 1024);
    const reader2 = { size: bytes2.length, read: async (o, l) => new Uint8Array(bytes2.subarray(o, o + l)) };
    const item2 = await uploadResumable(flaky, reader2, { name: 'flaky.bin', size: bytes2.length, rootId: 'Photos', path: '', md5: crypto.createHash('md5').update(bytes2).digest('hex') }, { sleep: noSleep });
    assert.deepEqual(fs.readFileSync(path.join(media.dataDir, 'library', 'Photos', 'flaky.bin')), bytes2);
    assert.equal(item2.size, bytes2.length);
    assert.ok(patches >= 7, 'there were retries');
    assert.equal(sentOffsets[0], 0);
    assert.ok(sentOffsets.every((o, i) => i === 0 || o > sentOffsets[i - 1]), 'no byte was sent twice after a resume: ' + sentOffsets.join());

    // stopping and starting again later (cancel in the middle, then the same call again)
    const bytes3 = crypto.randomBytes(4 * 1024 * 1024);
    const reader3 = { size: bytes3.length, read: async (o, l) => new Uint8Array(bytes3.subarray(o, o + l)) };
    const meta3 = { name: 'paused.bin', size: bytes3.length, rootId: 'Photos', path: 'p' };
    let seen = 0;
    await assert.rejects(() => uploadResumable(upClient, reader3, meta3, { sleep: noSleep, isCancelled: () => ++seen > 3 }), (e) => e instanceof UploadCancelled || e.name === 'UploadCancelled');
    const resumed = await upClient.createUpload(meta3);
    assert.ok(resumed.offset > 0 && resumed.offset < bytes3.length, 'the server kept the part that was sent: ' + resumed.offset);
    const item3 = await uploadResumable(upClient, reader3, meta3, { sleep: noSleep });
    assert.deepEqual(fs.readFileSync(path.join(media.dataDir, 'library', 'Photos', 'p', 'paused.bin')), bytes3);
    assert.equal(item3.name, 'paused.bin');

    // wrong md5: the client gets an http 422 (not retried) and the server keeps nothing
    await assert.rejects(
      () => uploadResumable(upClient, reader3, { name: 'wrong.bin', size: bytes3.length, rootId: 'Photos', path: '', md5: '0'.repeat(32) }, { sleep: noSleep }),
      (e) => isServerError(e) && e.kind === 'http' && e.status === 422,
    );
    assert.equal(fs.existsSync(path.join(media.dataDir, 'library', 'Photos', 'wrong.bin')), false);

    // the same name again never overwrites
    const dup = await uploadResumable(upClient, reader, { name: 'up.mp4', size: bytes.length, rootId: 'Videos', path: '2026/10' }, { sleep: noSleep });
    assert.equal(dup.name, 'up (1).mp4');
    assert.deepEqual(fs.readFileSync(path.join(media.dataDir, 'library', 'Videos', '2026', '10', 'up.mp4')), bytes);

    // wrong token and traversal
    const badClient = new ServerClient({ url: mcode.url, token: 'x'.repeat(43) });
    await assert.rejects(() => badClient.createUpload({ name: 'a.jpg', size: 1, rootId: 'Photos', path: '' }), (e) => isServerError(e) && e.kind === 'unauthorized');
    await assert.rejects(() => upClient.createUpload({ name: '../a.jpg', size: 1, rootId: 'Photos', path: '' }), (e) => isServerError(e) && e.kind === 'http' && e.status === 400);
    await assert.rejects(() => upClient.createUpload({ name: 'a.jpg', size: 1, rootId: 'Photos', path: '../..' }), (e) => isServerError(e) && e.kind === 'http' && e.status === 400);
    assert.equal(fs.existsSync(path.join(media.dataDir, 'a.jpg')), false);
  }

  // 8c. S6: backup with the app's real code: scan -> queue -> ServerProvider.upload -> real server
  {
    const noSleep = async () => {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-phone-'));
    dirs.push(tmp);
    // a fake phone gallery with real files on disk
    const phoneFiles = {};
    const addPhone = (assetId, name, type, mtime, bytes) => {
      const file = path.join(tmp, `${assetId}-${name}`);
      fs.writeFileSync(file, bytes);
      phoneFiles[assetId] = { name, type, mtime, file, bytes };
    };
    addPhone('1', 'IMG_0001.jpg', 'image', '2026-02-15T12:00:00.000Z', crypto.randomBytes(1_500_000));
    addPhone('2', 'IMG_0002.jpg', 'image', '2025-11-20T12:00:00.000Z', crypto.randomBytes(300_000));
    addPhone('3', 'VID_0001.mp4', 'video', '2025-07-10T12:00:00.000Z', crypto.randomBytes(3_200_000));
    const dirItem = (id, name) => ({ id, parentId: null, name, type: 'dir', size: 0, mtime: new Date(0).toISOString() });
    const phone = {
      id: 'local', kind: 'local', isMock: false,
      list: async (parent) =>
        parent === null
          ? { items: [dirItem('fs:library', 'meYou'), dirItem('ml:album:1', 'Camera')] }
          : parent === 'ml:album:1'
            ? { items: Object.entries(phoneFiles).map(([id, f]) => ({ id: `ml:asset:${id}`, parentId: parent, name: f.name, type: f.type, size: 0, mtime: f.mtime })) }
            : { items: [] },
      getOriginalUrl: async (id) => phoneFiles[id.replace('ml:asset:', '')]?.file ?? null,
    };
    const localInfo = (uri) => {
      try {
        const bytes = fs.readFileSync(uri);
        return { size: bytes.length, md5: crypto.createHash('md5').update(bytes).digest('hex') };
      } catch {
        return null;
      }
    };
    const openReader = async (uri) => {
      const fd = fs.openSync(uri, 'r');
      return {
        size: fs.fstatSync(fd).size,
        read: async (offset, length) => {
          const buf = Buffer.alloc(length);
          const n = fs.readSync(fd, buf, 0, length, offset);
          return new Uint8Array(buf.subarray(0, n));
        },
        close: () => fs.closeSync(fd),
      };
    };
    // the network drops on the 3rd and the 6th request of the whole run
    let requests = 0;
    const flakyFetch = (input, init) => {
      requests += 1;
      if (requests === 3 || requests === 6) return Promise.reject(new TypeError('Network request failed'));
      return fetch(input, init);
    };
    const target = new ServerProvider('live-backup', {
      endpoints: () => [{ id: 'e', url: mcode.url, token: mcode.token }],
      failover: () => false,
      timeoutMs: 5000,
      sleep: noSleep,
      fetch: flakyFetch,
      openReader,
    });
    assert.ok((await target.features()).includes('upload'), 'the server announces upload');
    const choice = { photos: true, videos: true, scope: 'camera', albums: [] };
    const now = () => new Date('2026-10-17T10:00:00.000Z');
    const scan = await scanNewMedia({ phone, target, backedUp: {}, localInfo, choice, now });
    assert.equal(scan.jobs.length, 3);
    assert.equal(scan.alreadyThere, 0);
    const q = createUploadQueue({ resolveProvider: () => target, sleep: noSleep, retryDelaysMs: [1, 1, 1] });
    q.getState().enqueue(scan.jobs);
    q.getState().beginRun({ scanned: scan.scanned, skipped: scan.alreadyThere, unreadable: scan.unreadable, queued: 3 });
    await q.getState().start();
    assert.ok(requests >= 6, 'the two simulated drops really happened');
    assert.deepEqual(q.getState().jobs.map((j) => j.state), ['done', 'done', 'done'], 'all uploaded despite two dropped requests');
    assert.equal(q.getState().run.uploaded, 3);
    const lib = path.join(media.dataDir, 'library');
    const expected = {
      'Photos/2026/02/IMG_0001.jpg': phoneFiles['1'],
      'Photos/2025/11/IMG_0002.jpg': phoneFiles['2'],
      'Videos/2025/07/VID_0001.mp4': phoneFiles['3'],
    };
    for (const [rel, f] of Object.entries(expected)) {
      const onDisk = path.join(lib, ...rel.split('/'));
      assert.deepEqual(fs.readFileSync(onDisk), f.bytes, `${rel} is byte-identical`);
      assert.equal(fs.statSync(onDisk).mtime.toISOString(), f.mtime, `${rel} keeps the photo's date`);
    }
    // the second run finds everything already there (by name and size on the server) and queues nothing
    const again = await scanNewMedia({ phone, target: makeProvider(mcode.url, mcode.token), backedUp: {}, localInfo, choice, now });
    assert.equal(again.jobs.length, 0, 'nothing is uploaded twice');
    assert.equal(again.alreadyThere, 3);
    // and the library lists the new files (the S4 view of what S6 sent)
    const listed = await mclient.tree('Photos', '2026/02');
    assert.deepEqual(listed.items.map((i) => i.name), ['IMG_0001.jpg']);
    // nothing was deleted on either side
    for (const f of Object.values(phoneFiles)) assert.ok(fs.existsSync(f.file), 'phone file is still there');

    // Wi-Fi rule: while the rule says "no-wifi" nothing is sent; after it clears the queue continues
    addPhone('4', 'IMG_0004.jpg', 'image', '2026-03-03T12:00:00.000Z', crypto.randomBytes(200_000));
    let blocker = 'no-wifi';
    const gated = createUploadQueue({ resolveProvider: () => makeProvider(mcode.url, mcode.token), canRun: () => blocker, sleep: noSleep });
    const scan2 = await scanNewMedia({ phone, target: makeProvider(mcode.url, mcode.token), backedUp: {}, localInfo, choice, now });
    assert.deepEqual(scan2.jobs.map((j) => j.name), ['IMG_0004.jpg']);
    gated.getState().enqueue(scan2.jobs);
    await gated.getState().start();
    assert.equal(gated.getState().waiting, 'no-wifi');
    assert.equal(fs.existsSync(path.join(lib, 'Photos', '2026', '03', 'IMG_0004.jpg')), false, 'nothing sent while waiting for Wi-Fi');
    blocker = null;
    const withOpener = new ServerProvider('live-backup2', { endpoints: () => [{ id: 'e', url: mcode.url, token: mcode.token }], failover: () => false, timeoutMs: 5000, sleep: noSleep, openReader });
    const gated2 = createUploadQueue({ resolveProvider: () => withOpener, canRun: () => blocker, sleep: noSleep });
    gated2.getState().enqueue(scan2.jobs);
    await gated2.getState().kick();
    assert.deepEqual(fs.readFileSync(path.join(lib, 'Photos', '2026', '03', 'IMG_0004.jpg')), phoneFiles['4'].bytes);

    // pause in the middle of a file: the server keeps the part, resume sends only the rest
    addPhone('5', 'VID_0005.mp4', 'video', '2026-04-04T12:00:00.000Z', crypto.randomBytes(5 * 1024 * 1024 + 77));
    const patches = [];
    let pauseQueue = null;
    const watched = new ServerProvider('live-backup3', {
      endpoints: () => [{ id: 'e', url: mcode.url, token: mcode.token }],
      failover: () => false,
      timeoutMs: 5000,
      sleep: noSleep,
      openReader,
      fetch: (input, init) => {
        if (init?.method === 'PATCH') {
          patches.push(Number(init.headers['Upload-Offset']));
          if (patches.length === 2) pauseQueue.getState().pause(); // the person taps Pause during the 2nd chunk
        }
        return fetch(input, init);
      },
    });
    pauseQueue = createUploadQueue({ resolveProvider: () => watched, sleep: noSleep });
    const scan3 = await scanNewMedia({ phone, target: makeProvider(mcode.url, mcode.token), backedUp: {}, localInfo, choice, now });
    assert.deepEqual(scan3.jobs.map((j) => j.name), ['VID_0005.mp4']);
    pauseQueue.getState().enqueue(scan3.jobs);
    await pauseQueue.getState().start();
    assert.equal(pauseQueue.getState().jobs[0].state, 'queued', 'paused, not failed');
    assert.equal(fs.existsSync(path.join(lib, 'Videos', '2026', '04', 'VID_0005.mp4')), false);
    await pauseQueue.getState().resume();
    assert.equal(pauseQueue.getState().jobs[0].state, 'done');
    assert.deepEqual(fs.readFileSync(path.join(lib, 'Videos', '2026', '04', 'VID_0005.mp4')), phoneFiles['5'].bytes);
    assert.deepEqual(patches, [0, 1048576, 2097152, 3145728, 4194304, 5242880], 'after the pause no byte was sent twice: ' + patches.join());

    // wrong token: the job fails with the code the UI shows, nothing is retried forever
    const badTarget = new ServerProvider('bad', { endpoints: () => [{ id: 'e', url: mcode.url, token: 'x'.repeat(43) }], failover: () => false, timeoutMs: 3000, sleep: noSleep, openReader });
    const badQueue = createUploadQueue({ resolveProvider: () => badTarget, sleep: noSleep });
    badQueue.getState().enqueue([{ ...scan2.jobs[0], uri: phoneFiles['4'].file, name: 'IMG_BAD.jpg', backupKey: undefined }]);
    await badQueue.getState().start();
    assert.equal(badQueue.getState().jobs[0].error, 'unauthorized');
  }

  // 8d. S7/S8 against the real server using two instances of the app's MailboxClient and listener:
  //     invite -> join -> live messages both ways -> HTTP replay -> revoke -> third device refused.
  {
    const WS = createRequire(path.join(serverDir, 'package.json'))('ws');
    const owner = code.token;
    const ownerConnection = { url: real.url, token: owner };
    const ownerClient = new MailboxClient(ownerConnection);
    const ownerMe = await ownerClient.me();
    const inv = await ownerClient.createInvite();
    const link = new URL(inv.link);
    assert.equal(link.protocol, 'meyou:');
    assert.equal(link.host, 'join');
    assert.equal(link.searchParams.get('url'), real.url);
    assert.equal(link.searchParams.get('code'), inv.code);
    const joined = await joinMailbox(real.url, link.searchParams.get('code'), 'Partner phone');
    const memberConnection = { url: real.url, token: joined.token };
    const memberClient = new MailboxClient(memberConnection);
    const memberMe = await memberClient.me();
    assert.equal(memberMe.household.partner.deviceId, ownerMe.deviceId);

    // R-Q1: shared files (event photo, memory media, sharp profile photo) with the PAIRING tokens against the real server:
    // the partner's token uploads into Shared/<id>/, the owner's token finds it and reads preview + thumbnail.
    {
      const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z', 'base64');
      const jpegReader = { size: jpeg.length, read: async (offset, length) => new Uint8Array(jpeg.subarray(offset, offset + length)) };
      const memberShared = new ServerClient(memberConnection);
      const ownerShared = new ServerClient(ownerConnection);
      for (const [id, name] of [
        [`event-${crypto.randomBytes(6).toString('hex')}`, 'photo.jpg'],
        [`avatar-${memberMe.deviceId}`, 'avatar-k3j9x.jpg'],
        [`mem-${crypto.randomBytes(6).toString('hex')}`, 'attachment-1-عکس خاطره.jpg'],
      ]) {
        const where = await uploadShared(memberShared, jpegReader, { id, name, md5: crypto.createHash('md5').update(jpeg).digest('hex') });
        assert.ok(where.startsWith(`Shared/${id}/`), where);
        const ref = await resolveShared(ownerShared, where, 'preview');
        assert.ok(ref, `owner finds ${where}`);
        const res = await fetch(ref.uri, { headers: ref.headers });
        assert.equal(res.status, 200, `preview of ${where}`);
        assert.match(res.headers.get('content-type') ?? '', /^image\//, `image type of ${where}`);
        assert.ok((await res.arrayBuffer()).byteLength > 0);
        const thumb = await resolveShared(ownerShared, where, 'thumb');
        assert.equal((await fetch(thumb.uri, { headers: thumb.headers })).status, 200, `thumbnail of ${where}`);
      }
    }
    assert.equal((await assert.rejects(joinMailbox(real.url, inv.code, 'Again'), (e) => e.kind === 'http' && e.status === 400)), undefined, 'invite codes are single-use');

    const waitFor = async (condition, details) => {
      for (let i = 0; i < 120 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(condition(), details);
    };
    const ownerCursor = { value: '0' };
    const memberCursor = { value: '0' };
    const ownerMessages = [];
    const memberMessages = [];
    const ownerStates = [];
    const memberStates = [];
    const socketFactory = (url, headers) => new WS(url, { headers });
    const makeListener = (connection, cursor, messages, states) =>
      new MailboxListener({
        connection,
        since: () => cursor.value,
        createSocket: socketFactory,
        retryMs: { min: 10, max: 50 },
        onState: (state) => states.push(state),
        onMessage: async (message) => {
          messages.push(message);
          cursor.value = String(message.seq);
        },
      });
    const ownerListener = makeListener(ownerConnection, ownerCursor, ownerMessages, ownerStates);
    const memberListener = makeListener(memberConnection, memberCursor, memberMessages, memberStates);
    ownerListener.start();
    memberListener.start();
    await waitFor(() => ownerStates.includes('connected') && memberStates.includes('connected'), 'both application WebSocket listeners connected');

    const moodTime = new Date().toISOString();
    const mood = await ownerClient.publish({ t: 'mood', from: 'app-owner', ts: moodTime, emoji: '😊', intensity: 4 });
    await waitFor(() => memberMessages.some((message) => message.seq === mood.seq), 'member receives the app-side mood message live');
    assert.equal(ownerMessages.length, 0, 'sender does not receive its own message');

    // Stop one listener while a message is stored, then reconnect: the app listener must replay by seq.
    memberListener.stop();
    const profileTime = new Date().toISOString();
    const profile = await ownerClient.publish({ t: 'profile', from: 'app-owner', ts: profileTime, name: 'Owner' });
    memberListener.start();
    await waitFor(() => memberMessages.some((message) => message.seq === profile.seq), 'member listener replays a missed row after reconnect');

    const eventTime = new Date().toISOString();
    const event = await memberClient.publish({ t: 'event', from: 'app-member', ts: eventTime, id: 'app-event', title: 'Dinner', date: eventTime });
    await waitFor(() => ownerMessages.some((message) => message.seq === event.seq), 'owner receives the app-side event live');
    assert.equal(memberMessages.some((message) => message.seq === event.seq), false, 'member does not receive its own message');
    const ownerPage = await ownerClient.poll('0');
    const memberPage = await memberClient.poll('0');
    assert.deepEqual(ownerPage.messages.map((message) => message.body.t), ['event']);
    assert.deepEqual(memberPage.messages.map((message) => message.body.t), ['mood', 'profile']);
    assert.equal((await memberClient.poll(memberPage.cursor)).messages.length, 0);

    const unpairTime = new Date().toISOString();
    const unpair = await ownerClient.publish({ t: 'unpair', from: 'app-owner', ts: unpairTime });
    await waitFor(() => memberMessages.some((message) => message.seq === unpair.seq), 'partner receives unpair before revocation');
    await ownerClient.revoke(memberMe.deviceId);
    await waitFor(() => memberStates.includes('unauthorized'), 'revocation closes the app listener');
    await assert.rejects(memberClient.me(), (error) => error.kind === 'unauthorized');

    ownerListener.stop();
    memberListener.stop();
    const newInvite = await ownerClient.createInvite();
    const second = await joinMailbox(real.url, new URL(newInvite.link).searchParams.get('code'), 'Second phone');
    await assert.rejects(ownerClient.createInvite(), (error) => error.kind === 'http' && error.errorKey === 'household_full');
    assert.ok(second.token);
  }

  // 9. The token never reaches the server log
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('').includes(code.token), 'token not in server logs');
  assert.ok(!logs.join('').includes(mcode.token), 'media token not in server logs');

  console.log('live server tests ok');
} finally {
  for (const child of children) child.kill();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
