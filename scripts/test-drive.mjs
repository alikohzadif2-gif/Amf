import assert from 'node:assert/strict';
import { DriveClient } from '../src/drive/client.ts';
import { DriveError } from '../src/drive/errors.ts';
import { DriveProvider, itemTypeOf } from '../src/drive/provider.ts';
import { uploadToDrive } from '../src/drive/upload.ts';
import { applySourceMode, sourceKindOf } from '../src/library/source-mode.ts';
import { itemState, sortRefs, mergeInto } from '../src/library/merge.ts';
import { issueFromError } from '../src/library/load-issue.ts';
import { analyzeStorage } from '../src/tools/storage-stats.ts';
import { DEFAULT_SOURCE_MODE, SOURCE_MODES } from '../src/library/source-mode.ts';
import { mediaBox } from '../src/chat/media-box.ts';
import { scanNewMedia } from '../src/backup/backup-new.ts';
import { errorCode, isTransientCode } from '../src/backup/queue.ts';
import { uploadErrorKey } from '../src/backup/messages.ts';

const noSleep = async () => {};
const FOLDER = 'application/vnd.google-apps.folder';

/** A tiny in-memory Google Drive: just enough of the v3 REST API for what the app calls. */
function fakeDrive(options = {}) {
  const files = new Map(); // id -> { id, name, mimeType, parents, trashed, bytes?, md5Checksum?, ... }
  const sessions = new Map(); // url -> { meta, received: number, total }
  const log = [];
  let n = 0;
  const state = { tokenCalls: 0, failNext: [], dropNextChunk: 0, status401: options.status401 ?? 0 };
  files.set('root', { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [] });

  const add = (file) => {
    const id = file.id ?? `f${(n += 1)}`;
    const full = { trashed: false, parents: ['root'], modifiedTime: '2024-05-01T10:00:00.000Z', ...file, id };
    files.set(id, full);
    return full;
  };
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const projection = (file) => {
    const { bytes, ...rest } = file;
    return { ...rest, size: bytes ? String(bytes.length) : rest.size };
  };
  const children = (parent, q) => [...files.values()].filter((f) => {
    if (f.id === 'root' || f.trashed || !f.parents?.includes(parent)) return false;
    if (q.includes(`mimeType = '${FOLDER}'`) && f.mimeType !== FOLDER) return false;
    const m = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
    if (m && f.name !== m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')) return false;
    return true;
  });

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const auth = init.headers?.Authorization;
    log.push({ method, url: input, auth, range: init.headers?.['Content-Range'] });
    if (state.failNext.length > 0) {
      const next = state.failNext.shift();
      if (next === 'network') throw new TypeError('Network request failed');
      return json(next, { error: { errors: [{ reason: next === 403 ? 'storageQuotaExceeded' : 'backendError' }] } });
    }
    // upload sessions are pre-authorised: no Authorization header there
    if (url.hostname === 'upload.fake') {
      const session = sessions.get(input);
      if (!session) return json(404, { error: {} });
      const range = init.headers['Content-Range'];
      const total = session.total;
      if (range.startsWith('bytes */')) {
        return session.received >= total ? finish(session) : resume(session);
      }
      const [, start, end] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (state.dropNextChunk > 0) { state.dropNextChunk -= 1; throw new TypeError('Network request failed'); }
      assert.equal(Number(start), session.received, 'chunk starts where Google expects');
      session.chunks.push(init.body);
      session.received = Number(end) + 1;
      return session.received >= total ? finish(session) : resume(session);
    }
    if (auth !== `Bearer tok${state.tokenCalls}`) return json(401, { error: { errors: [{ reason: 'authError' }] } });
    if (state.status401 > 0) { state.status401 -= 1; return json(401, { error: {} }); }

    const path = url.pathname.replace(/^\/drive\/v3/, '').replace(/^\/upload\/drive\/v3/, '');
    if (path === '/about') return json(200, { user: { emailAddress: 'a@b.c', displayName: 'Ali' }, storageQuota: { limit: '1000', usage: '10' } });
    if (path === '/files/root') return json(200, { id: 'root' });
    if (path === '/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const all = children(parent, q);
      const size = Number(url.searchParams.get('pageSize') ?? 100);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + size);
      return json(200, { files: page.map(projection), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if (path === '/files' && method === 'POST') {
      if (url.searchParams.get('uploadType') === 'resumable') {
        const meta = JSON.parse(init.body);
        const session = `https://upload.fake/session/${(n += 1)}`;
        sessions.set(session, { meta, received: 0, total: Number(init.headers['X-Upload-Content-Length']), mime: init.headers['X-Upload-Content-Type'], chunks: [] });
        return new Response('', { status: 200, headers: { Location: session } });
      }
      const body = JSON.parse(init.body);
      return json(200, projection(add(body)));
    }
    const one = /^\/files\/([^/]+)$/.exec(path);
    if (one) {
      const file = files.get(decodeURIComponent(one[1]));
      if (!file) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
      if (method === 'PATCH') { Object.assign(file, JSON.parse(init.body)); return json(200, { id: file.id }); }
      if (method === 'GET' && url.searchParams.get('alt') === 'media') return new Response('bytes', { status: 200 });
      if (method === 'GET') return json(200, projection(file));
    }
    return json(400, { error: { errors: [{ reason: 'badRequest' }] } });
  };
  const finish = (session) => {
    const bytes = Buffer.concat(session.chunks.map((c) => Buffer.from(c)));
    const file = add({ name: session.meta.name, mimeType: session.mime, parents: session.meta.parents, modifiedTime: session.meta.modifiedTime ?? '2026-10-25T00:00:00.000Z', bytes, md5Checksum: 'm' + bytes.length });
    return json(200, projection(file));
  };
  const resume = (session) =>
    new Response('', { status: 308, headers: session.received > 0 ? { Range: `bytes=0-${session.received - 1}` } : {} });
  return { fetchImpl, files, add, log, state, sessions };
}

function makeProvider(drive, extra = {}) {
  let root = extra.root ?? null;
  let account = extra.account ?? true;
  const auth = {
    async getAccessToken(force) {
      if (force) drive.state.tokenCalls += 1;
      if (!account) throw new DriveError('unauthorized');
      return `tok${drive.state.tokenCalls}`;
    },
  };
  const provider = new DriveProvider('drive', {
    auth,
    hasAccount: () => account,
    rootFolder: () => root,
    onRootFolder: (f) => { root = f; extra.onRoot?.(f); },
    openReader: extra.openReader,
    fetch: drive.fetchImpl,
    sleep: noSleep,
    now: extra.now,
  });
  return { provider, setAccount: (v) => { account = v; }, getRoot: () => root, setRoot: (r) => { root = r; } };
}

const reader = (size, fill = 7) => {
  const data = new Uint8Array(size).fill(fill);
  return { size, async read(offset, length) { return data.slice(offset, offset + length); } };
};

// ---- item types ---------------------------------------------------------------
{
  assert.equal(itemTypeOf({ id: '1', name: 'a', mimeType: FOLDER }), 'dir');
  assert.equal(itemTypeOf({ id: '1', name: 'a.jpg', mimeType: 'image/jpeg' }), 'image');
  assert.equal(itemTypeOf({ id: '1', name: 'a.mp4', mimeType: 'video/mp4' }), 'video');
  assert.equal(itemTypeOf({ id: '1', name: 'a.txt', mimeType: 'text/plain' }), 'text');
  assert.equal(itemTypeOf({ id: '1', name: 'x.pdf', mimeType: 'application/pdf' }), 'file');
  assert.equal(itemTypeOf({ id: '1', name: 'clip.mov', mimeType: 'application/octet-stream' }), 'video');
  assert.equal(itemTypeOf({ id: '1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }), null, 'Google Docs have no bytes');
  assert.equal(itemTypeOf({ id: '1', name: 'link', mimeType: 'application/vnd.google-apps.shortcut' }), null);
}

// ---- first sign-in: the meYou folder is made once, then found ----------------------
{
  const drive = fakeDrive();
  let saved = null;
  const { provider, getRoot } = makeProvider(drive, { onRoot: (f) => { saved = f; } });
  const first = await provider.list(null);
  assert.deepEqual(first.items, []);
  assert.equal(saved.name, 'meYou');
  assert.equal(drive.log.filter((l) => l.method === 'POST').length, 1, 'meYou was created once');
  await provider.list(null);
  assert.equal(drive.log.filter((l) => l.method === 'POST').length, 1, 'and not again');
  // a fresh install on the same account finds the existing folder instead of making a second one
  const again = makeProvider(drive);
  await again.provider.list(null);
  assert.equal([...drive.files.values()].filter((f) => f.name === 'meYou').length, 1);
  assert.equal(getRoot().id, saved.id);
}

// ---- listing: mapping, paging, hidden kinds ---------------------------------------
{
  const drive = fakeDrive();
  const top = drive.add({ name: 'Trip', mimeType: FOLDER, id: 'lib' });
  drive.add({ name: 'b.jpg', mimeType: 'image/jpeg', parents: ['lib'], bytes: Buffer.alloc(10), md5Checksum: 'abc', imageMediaMetadata: { width: 400, height: 300 } });
  drive.add({ name: 'c.mp4', mimeType: 'video/mp4', parents: ['lib'], bytes: Buffer.alloc(20), videoMediaMetadata: { width: 1920, height: 1080, durationMillis: '12500' } });
  drive.add({ name: 'Notes', mimeType: 'application/vnd.google-apps.document', parents: ['lib'] });
  drive.add({ name: 'gone.jpg', mimeType: 'image/jpeg', parents: ['lib'], trashed: true });
  drive.add({ name: 'Sub', mimeType: FOLDER, parents: ['lib'] });
  const { provider } = makeProvider(drive, { root: { id: 'lib', name: 'Trip' } });
  const page = await provider.list(null);
  const names = page.items.map((i) => i.name);
  assert.deepEqual(names.sort(), ['Sub', 'b.jpg', 'c.mp4'], 'docs and trashed files are not listed');
  const img = page.items.find((i) => i.name === 'b.jpg');
  assert.deepEqual([img.type, img.size, img.md5, img.width, img.height, img.parentId], ['image', 10, 'abc', 400, 300, null]);
  const vid = page.items.find((i) => i.name === 'c.mp4');
  assert.equal(vid.duration, 12.5);
  assert.equal(page.items.find((i) => i.name === 'Sub').type, 'dir');
  // folders first (orderBy folder,name is sent to Google)
  assert.ok(drive.log.some((l) => decodeURIComponent(l.url).includes('orderBy=folder,name')));
  // sub-folder listing keeps its parent id
  const sub = await provider.list(page.items.find((i) => i.name === 'Sub').id);
  assert.deepEqual(sub.items, []);
  // paging
  for (let i = 0; i < 5; i += 1) drive.add({ name: `p${i}.jpg`, mimeType: 'image/jpeg', parents: ['lib'] });
  // pages are cut by Google before docs are dropped, so a page can be short: follow the cursor to the end
  const paged = [];
  let cursor;
  let pages = 0;
  do {
    const part = await provider.list(null, { limit: 4, cursor });
    paged.push(...part.items.map((i) => i.name));
    cursor = part.nextCursor;
    pages += 1;
  } while (cursor);
  assert.ok(pages >= 2, 'more than one page');
  assert.deepEqual(paged.sort(), ['Sub', 'b.jpg', 'c.mp4', 'p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);
  assert.equal(top.id, 'lib');
}

// ---- token refresh: one retry on 401, then unauthorized ---------------------------
{
  const drive = fakeDrive();
  drive.state.status401 = 1;
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' } });
  await provider.list(null);
  assert.equal(drive.state.tokenCalls, 1, 'a fresh token was requested once');
  assert.ok(drive.log.some((l) => l.auth === 'Bearer tok1'));
  const second = fakeDrive({ status401: 5 });
  const other = makeProvider(second, { root: { id: 'root', name: 'r' } });
  await assert.rejects(() => other.provider.list(null), (e) => e.kind === 'unauthorized');
  assert.equal(issueFromError(new DriveError('unauthorized', 401)), 'unauthorized');
}

// ---- errors map to kinds ----------------------------------------------------------
{
  const drive = fakeDrive();
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' } });
  drive.state.failNext.push('network');
  await assert.rejects(() => provider.list(null), (e) => e.kind === 'network');
  drive.state.failNext.push(403);
  await assert.rejects(() => provider.list(null), (e) => e.kind === 'quota');
  drive.state.failNext.push(500);
  await assert.rejects(() => provider.list(null), (e) => e.kind === 'http' && e.status === 500);
  assert.equal(issueFromError(new DriveError('quota', 403)), 'busy');
  assert.equal(issueFromError(new DriveError('network')), 'unreachable');
  assert.equal(issueFromError(new DriveError('not-found', 404)), 'missing');
  assert.equal(await provider.stat('nope'), null, 'a missing file is null, not an error');
}

// ---- signed out -------------------------------------------------------------------
{
  const drive = fakeDrive();
  const { provider, setAccount } = makeProvider(drive, { account: false });
  await assert.rejects(() => provider.list(null), (e) => e.kind === 'unauthorized');
  assert.deepEqual(await provider.test(), { ok: false, code: 'permission-needed', latencyMs: 0 });
  assert.equal(drive.log.length, 0, 'no request is made without an account');
  assert.equal((await provider.requestAccess()).code, 'unavailable', 'no sign-in module wired in this test');
  setAccount(true);
  const ok = await provider.test();
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'ok');
  assert.equal(provider.capabilities().needsPermission, true);
  assert.equal(provider.capabilities().canDelete, true);
}

// ---- test(): offline and quota ----------------------------------------------------
{
  const drive = fakeDrive();
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' } });
  drive.state.failNext.push('network');
  assert.equal((await provider.test()).code, 'unavailable');
  drive.state.failNext.push(403);
  const quota = await provider.test();
  assert.equal(quota.ok, false);
  assert.equal(quota.busy, true);
}

// ---- thumbnails and originals carry the token, never put it in the URL ------------
{
  const drive = fakeDrive();
  drive.add({ id: 'img', name: 'a.jpg', mimeType: 'image/jpeg', thumbnailLink: 'https://lh3.fake/abc=s220' });
  drive.add({ id: 'bare', name: 'b.jpg', mimeType: 'image/jpeg' });
  let clock = 0;
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' }, now: () => clock });
  await provider.list(null);
  const thumb = await provider.getThumb('img', 512);
  assert.equal(thumb.uri, 'https://lh3.fake/abc=s512');
  assert.equal(thumb.headers.Authorization, 'Bearer tok0');
  assert.equal((await provider.getPreview('img')).uri, 'https://lh3.fake/abc=s1600');
  assert.equal(await provider.getThumb('bare'), null, 'no thumbnail from Drive means null');
  const original = await provider.getOriginalSource('img');
  assert.ok(original.uri.endsWith('/files/img?alt=media'));
  assert.ok(!original.uri.includes('tok'), 'no token in the URL');
  assert.equal(original.headers.Authorization, 'Bearer tok0');
  assert.equal(await provider.getOriginalUrl('img'), original.uri);
  // an old thumbnail link is asked for again
  const before = drive.log.length;
  clock = 25 * 60_000;
  await provider.getThumb('img', 256);
  assert.ok(drive.log.length > before, 'stale link refreshed');
}

// ---- create folder: find or create, never a duplicate ------------------------------
{
  const drive = fakeDrive();
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' } });
  const a = await provider.createFolder("Ali's trip", null);
  const b = await provider.createFolder("Ali's trip", null);
  assert.equal(a.id, b.id);
  assert.equal(a.type, 'dir');
  assert.equal([...drive.files.values()].filter((f) => f.name === "Ali's trip").length, 1);
  const inner = await provider.createFolder('Day 1', a.id);
  assert.deepEqual(drive.files.get(inner.id).parents, [a.id]);
  await assert.rejects(() => provider.createFolder('   ', null));
  const made = await provider.makeFolder('Picker', 'root');
  assert.ok(drive.files.get(made.id));
  const folders = await provider.listFolders('root');
  assert.ok(folders.some((f) => f.name === 'Picker'));
}

// ---- delete = move to the Drive bin (never a real DELETE) ---------------------------
{
  const drive = fakeDrive();
  drive.add({ id: 'x', name: 'x.jpg', mimeType: 'image/jpeg' });
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' } });
  await provider.list(null);
  await provider.delete('x');
  assert.equal(drive.files.get('x').trashed, true);
  assert.ok(!drive.log.some((l) => l.method === 'DELETE'), 'no permanent delete is ever sent');
  assert.deepEqual((await provider.list(null)).items, []);
  assert.equal(await provider.stat('x'), null, 'a trashed file counts as gone');
}

// ---- uploads ------------------------------------------------------------------------
{
  const drive = fakeDrive();
  const progress = [];
  const { provider } = makeProvider(drive, { root: { id: 'root', name: 'r' }, openReader: async () => reader(600 * 1024) });
  const item = await provider.upload({ name: 'big.jpg', size: 600 * 1024, parentId: null, sourceUri: 'file:///x', mtime: '2020-01-02T03:04:05.000Z', onProgress: (s, t) => progress.push([s, t]) });
  assert.equal(item.name, 'big.jpg');
  assert.equal(item.type, 'image');
  assert.equal(item.size, 600 * 1024);
  assert.equal(item.mtime, '2020-01-02T03:04:05.000Z', 'the source date is kept');
  const session = [...drive.sessions.values()][0];
  assert.equal(session.mime, 'image/jpeg');
  assert.deepEqual(session.meta.parents, ['root']);
  assert.equal(progress[0][0], 0);
  assert.deepEqual(progress[progress.length - 1], [600 * 1024, 600 * 1024]);
  assert.ok(!drive.log.filter((l) => l.url.includes('upload.fake')).some((l) => l.auth), 'chunks carry no token');
}

// ---- upload helper directly: chunking, resume, cancel, empty ------------------------
{
  const drive = fakeDrive();
  const client = new DriveClient({ getAccessToken: async () => 'tok0' }, drive.fetchImpl);
  // chunk size 256 KiB, file 600 KiB -> 3 chunks
  const sent = [];
  const file = await uploadToDrive(client, reader(600 * 1024), { name: 'v.mp4', parentId: 'root', mimeType: 'video/mp4' }, { chunkBytes: 256 * 1024, onProgress: (s) => sent.push(s), sleep: noSleep });
  assert.equal(file.name, 'v.mp4');
  assert.deepEqual(sent, [0, 256 * 1024, 512 * 1024, 600 * 1024]);
  const chunkCalls = drive.log.filter((l) => l.range);
  assert.deepEqual(chunkCalls.map((l) => l.range), [`bytes 0-${256 * 1024 - 1}/${600 * 1024}`, `bytes ${256 * 1024}-${512 * 1024 - 1}/${600 * 1024}`, `bytes ${512 * 1024}-${600 * 1024 - 1}/${600 * 1024}`]);

  // a dropped connection mid-upload: ask Google where it is, carry on, finish
  drive.state.dropNextChunk = 1;
  const resumed = await uploadToDrive(client, reader(600 * 1024), { name: 'r.mp4', parentId: 'root', mimeType: 'video/mp4' }, { chunkBytes: 256 * 1024, sleep: noSleep });
  assert.equal(resumed.name, 'r.mp4');
  assert.equal(Buffer.from([...drive.files.values()].find((f) => f.name === 'r.mp4').bytes).length, 600 * 1024, 'every byte arrived once');

  // cancel
  let calls = 0;
  await assert.rejects(
    () => uploadToDrive(client, reader(600 * 1024), { name: 'c.mp4', parentId: 'root', mimeType: 'video/mp4' }, { chunkBytes: 256 * 1024, sleep: noSleep, isCancelled: () => (calls += 1) > 1 }),
    (e) => e.name === 'UploadCancelled',
  );
  assert.ok(![...drive.files.values()].some((f) => f.name === 'c.mp4'), 'a cancelled upload leaves no file');

  // empty file: a plain create
  const empty = await uploadToDrive(client, reader(0), { name: 'e.txt', parentId: 'root', mimeType: 'text/plain' }, { sleep: noSleep });
  assert.equal(empty.name, 'e.txt');

  // quota full stops the upload with a quota error
  drive.state.failNext.push(403);
  await assert.rejects(
    () => uploadToDrive(client, reader(10), { name: 'q.jpg', parentId: 'root', mimeType: 'image/jpeg' }, { sleep: noSleep }),
    (e) => e.kind === 'quota',
  );
}

// ---- how Drive fits the Archive ---------------------------------------------------
{
  assert.equal(sourceKindOf('drive'), 'drive');
  const kinds = { local: 'local', drive: 'drive', srv: 'server' };
  const map = new Map();
  mergeInto(map, 'local', [{ id: 'l1', parentId: null, name: 'a.jpg', type: 'image', size: 5, mtime: '2024-01-01T00:00:00.000Z', md5: 'same' }]);
  mergeInto(map, 'drive', [
    { id: 'd1', parentId: null, name: 'a.jpg', type: 'image', size: 5, mtime: '2024-01-01T00:00:00.000Z', md5: 'same' },
    { id: 'd2', parentId: null, name: 'only.jpg', type: 'image', size: 6, mtime: '2024-01-02T00:00:00.000Z', md5: 'drv' },
  ]);
  const entries = [...map.values()];
  assert.equal(entries.length, 2, 'the same photo on the phone and in Drive is one entry');
  assert.deepEqual(applySourceMode(entries, 'drive', kinds).map((e) => e.item.name).sort(), ['a.jpg', 'only.jpg']);
  assert.deepEqual(applySourceMode(entries, 'phone', kinds).map((e) => e.item.name), ['a.jpg']);
  assert.equal(applySourceMode(entries, 'server', kinds).length, 0);
  const both = entries.find((e) => e.item.name === 'a.jpg');
  assert.equal(itemState(both, kinds, new Set()), 'backed-up');
  assert.equal(itemState(entries.find((e) => e.item.name === 'only.jpg'), kinds, new Set()), 'cloud-only');
  assert.deepEqual(sortRefs(both.refs, kinds).map((r) => r.sourceId), ['local', 'drive'], 'phone is preferred, then Drive');
  const stats = analyzeStorage(entries, kinds);
  assert.equal(stats.bySource.drive.count, 2);
  assert.equal(stats.bySource.local.count, 1);
  assert.equal(stats.bySource.server.count, 0);
}

// ---- the Archive opens on Google Drive ----------------------------------------------
assert.equal(DEFAULT_SOURCE_MODE, 'phone');
assert.deepEqual([...SOURCE_MODES], ['drive', 'phone', 'server', 'vault']);

// ---- chat preview: original proportions, no forced square ----------------------------
{
  const wide = mediaBox(16 / 9, 400);
  assert.ok(wide.width > wide.height, 'a landscape photo stays landscape');
  assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.02);
  const tall = mediaBox(9 / 16, 400);
  assert.ok(tall.height > tall.width, 'a portrait photo stays portrait');
  assert.ok(Math.abs(tall.width / tall.height - 9 / 16) < 0.03);
  assert.ok(tall.height <= 560, 'but never absurdly tall');
  const square = mediaBox(1, 400);
  assert.equal(square.width, square.height, 'a square photo is square only because it is');
  assert.equal(mediaBox(0.1, 400).ratio, 0.5, 'very tall is limited to 1:2');
  assert.equal(mediaBox(9, 400).ratio, 2, 'very wide is limited to 2:1');
  assert.notEqual(mediaBox(null, 400).width, mediaBox(null, 400).height, 'the placeholder is not a square either');
  assert.ok(mediaBox(1.5, 200).width <= Math.round(200 * 0.68), 'fits a narrow screen');
}

// ---- backup goes to Google Drive: Photos/<year>/<month>, made once --------------------
{
  const drive = fakeDrive();
  drive.add({ id: 'lib', name: 'meYou', mimeType: FOLDER });
  const { provider } = makeProvider(drive, { root: { id: 'lib', name: 'meYou' } });
  const dir = (id, name) => ({ id, parentId: null, name, type: 'dir', size: 0, mtime: new Date(0).toISOString() });
  const file = (id, name, type, mtime) => ({ id, parentId: 'ml:album:1', name, type, size: 0, mtime });
  const items = [
    file('a1', 'IMG_1.jpg', 'image', '2026-02-15T12:00:00.000Z'),
    file('a2', 'IMG_2.jpg', 'image', '2026-02-20T12:00:00.000Z'),
    file('a3', 'IMG_3.jpg', 'image', '2026-03-01T12:00:00.000Z'),
    file('a4', 'MOV_1.mp4', 'video', '2026-02-16T12:00:00.000Z'),
  ];
  const phone = {
    id: 'local', kind: 'local', isMock: false,
    capabilities: () => ({ canUpload: false, canDelete: false, supportsChanges: false, needsPermission: true }),
    test: async () => ({ ok: true, code: 'ok', latencyMs: 0 }),
    list: async (parentId) => (parentId === null ? { items: [dir('ml:album:1', 'Camera')] } : { items: parentId === 'ml:album:1' ? items : [] }),
    stat: async () => null, getThumb: async () => null, getPreview: async () => null,
    getOriginalUrl: async (id) => `file:///${id}`,
    upload: async () => { throw new Error('no'); }, delete: async () => {}, changes: async () => ({ changes: [], cursor: '' }),
  };
  const localInfo = () => ({ size: 10 });
  const now = new Date('2026-10-17T10:00:00.000Z');
  const choice = { photos: true, videos: true, scope: 'camera', albums: [] };
  const scan = await scanNewMedia({ phone, target: provider, localInfo, backedUp: {}, choice, now: () => now });
  assert.equal(scan.jobs.length, 4);
  const folderOf = (id) => drive.files.get(id);
  const pathOf = (id) => { const parts = []; for (let f = folderOf(id); f && f.id !== 'lib'; f = folderOf(f.parents?.[0])) parts.unshift(f.name); return parts.join('/'); };
  const byName = Object.fromEntries(scan.jobs.map((j) => [j.name, pathOf(j.parentId)]));
  assert.deepEqual(byName, { 'IMG_1.jpg': 'Photos/2026/02', 'IMG_2.jpg': 'Photos/2026/02', 'IMG_3.jpg': 'Photos/2026/03', 'MOV_1.mp4': 'Videos/2026/02' });
  assert.equal(scan.jobs[0].parentId, scan.jobs[1].parentId, 'two photos of one month share one folder');
  assert.equal(scan.jobs.every((j) => j.sourceId === 'drive'), true);
  const folderCount = [...drive.files.values()].filter((f) => f.mimeType === FOLDER).length;
  await scanNewMedia({ phone, target: provider, localInfo, backedUp: {}, choice, now: () => now });
  assert.equal([...drive.files.values()].filter((f) => f.mimeType === FOLDER).length, folderCount, 'a second scan makes no second folder');
}

// ---- the upload queue understands Drive failures ----------------------------------------
{
  assert.equal(errorCode(new DriveError('network')), 'network');
  assert.equal(isTransientCode(errorCode(new DriveError('network'))), true);
  assert.equal(errorCode(new DriveError('quota', 403)), 'drive-full');
  assert.equal(isTransientCode('drive-full'), false, 'a full Drive needs the person, not a retry');
  assert.equal(errorCode(new DriveError('quota', 429)), 'http-429');
  assert.equal(isTransientCode('http-429'), true, 'a rate limit passes by itself');
  assert.equal(errorCode(new DriveError('unauthorized', 401)), 'drive-unauthorized');
  assert.equal(errorCode(new DriveError('http', 503)), 'http-503');
  assert.equal(uploadErrorKey('drive-full'), 'uploadErrDriveFull');
  assert.equal(uploadErrorKey('drive-unauthorized'), 'driveSessionExpired');
}

console.log('drive tests ok');
