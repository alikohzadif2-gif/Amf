import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { bearer, makeEnv, type Env } from './helpers.js';
import { abs, put } from './fixtures.js';
import { libraryDir, loadConfig, uploadsDir } from '../src/config.js';
import { folderSegments, suffixedName } from '../src/uploads/service.js';
import type { UploadOptions } from '../src/uploads/service.js';

const OCT = 'application/offset+octet-stream';
const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest('hex');
const rnd = (n: number) => crypto.randomBytes(n);

async function withEnv(fn: (e: Env, up: UploadOptions) => Promise<void>, extra: Record<string, string> = {}, up: UploadOptions = {}) {
  const e = await makeEnv(extra, { uploads: up });
  try {
    await fn(e, up);
  } finally {
    await e.cleanup();
  }
}

interface Meta { name: string; size: number; rootId: string; path: string; md5?: string; mtime?: string | number }
const create = (e: Env, m: Partial<Meta> & { name: string; size: number }, token = e.token) =>
  e.app.inject({ method: 'POST', url: '/api/v1/uploads', headers: bearer(token), payload: { rootId: 'Photos', path: '', ...m } });
const patch = (e: Env, id: string, offset: number | string, data: Buffer, token = e.token, ct = OCT) =>
  e.app.inject({ method: 'PATCH', url: `/api/v1/uploads/${id}`, headers: { ...bearer(token), 'content-type': ct, 'upload-offset': String(offset) }, payload: data });
const complete = (e: Env, id: string, token = e.token) =>
  e.app.inject({ method: 'POST', url: `/api/v1/uploads/${id}/complete`, headers: bearer(token) });

async function sendAll(e: Env, meta: Partial<Meta> & { name: string }, data: Buffer, chunk = 1024 * 1024) {
  const c = await create(e, { ...meta, size: data.length });
  assert.equal(c.statusCode, 200, c.body);
  const { uploadId, offset } = c.json() as { uploadId: string; offset: number };
  assert.equal(offset, 0);
  for (let o = 0; o < data.length; o += chunk) {
    const r = await patch(e, uploadId, o, data.subarray(o, o + chunk));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((r.json() as { offset: number }).offset, Math.min(o + chunk, data.length));
  }
  return { uploadId, done: await complete(e, uploadId) };
}

const tmpFiles = (e: Env) => (fs.existsSync(uploadsDir(e.cfg)) ? fs.readdirSync(uploadsDir(e.cfg)) : []);

test('helpers: folder segments and suffix names', () => {
  assert.deepEqual(folderSegments(''), []);
  assert.deepEqual(folderSegments('/'), []);
  assert.deepEqual(folderSegments('2026/10/'), ['2026', '10']);
  assert.deepEqual(folderSegments(undefined), []);
  for (const bad of ['..', 'a/../b', './a', 'a//b', 'a\\b', 'a\0b', '.hidden/x', '�', 5, 'x'.repeat(256)]) assert.equal(folderSegments(bad), null, String(bad));
  assert.equal(suffixedName('photo.jpg', 1), 'photo (1).jpg');
  assert.equal(suffixedName('archive.tar.gz', 2), 'archive.tar (2).gz');
  assert.equal(suffixedName('README', 3), 'README (3)');
});

test('config: upload limits have defaults and are validated', () => {
  const c = loadConfig({ DATA_DIR: '/x' });
  assert.equal(c.uploadMaxChunkBytes, 8 * 1024 * 1024);
  assert.equal(c.uploadMinFreeBytes, 512 * 1024 * 1024);
  assert.equal(c.uploadMaxFileBytes, 20 * 1024 ** 3);
  assert.equal(c.uploadSessionTtlHours, 48);
  assert.throws(() => loadConfig({ DATA_DIR: '/x', UPLOAD_MAX_CHUNK_MB: '0' }));
});

test('happy path: 3 chunks, file lands in a new folder, is indexed and listed', () =>
  withEnv(async (e) => {
    const data = rnd(2_500_000);
    const { uploadId, done } = await sendAll(e, { name: 'IMG_0001.jpg', path: '2026/10', md5: md5(data) }, data);
    assert.equal(done.statusCode, 200, done.body);
    const item = done.json() as { id: string; name: string; size: number; type: string };
    assert.equal(item.name, 'IMG_0001.jpg');
    assert.equal(item.size, data.length);
    assert.equal(item.type, 'image'); // by extension
    assert.ok(fs.readFileSync(abs(e.cfg, 'Photos/2026/10/IMG_0001.jpg')).equals(data));
    assert.deepEqual(tmpFiles(e), []); // temp file is gone
    // Listed right away (no waiting for a rescan) and the id is the one the tree reports.
    const t = await e.app.inject({ method: 'GET', url: '/api/v1/tree?root=Photos&path=2026/10', headers: bearer(e.token) });
    assert.deepEqual((t.json() as { items: { id: string }[] }).items.map((i) => i.id), [item.id]);
    const top = await e.app.inject({ method: 'GET', url: '/api/v1/tree?root=Photos', headers: bearer(e.token) });
    assert.deepEqual((top.json() as { items: { name: string }[] }).items.map((i) => i.name), ['2026']);
    // Change log: folders and the file were added.
    const ch = await e.app.inject({ method: 'GET', url: '/api/v1/changes', headers: bearer(e.token) });
    const adds = (ch.json() as { changes: { op: string; path: string }[] }).changes.filter((c) => c.op === 'add').map((c) => c.path);
    assert.deepEqual(adds, ['2026', '2026/10', '2026/10/IMG_0001.jpg']);
    // The bytes come back identical through the read API.
    const f = await e.app.inject({ method: 'GET', url: `/api/v1/items/${item.id}/file`, headers: bearer(e.token) });
    assert.ok(f.rawPayload.equals(data));
    assert.ok(uploadId.length === 22);
  }));

test('a zero-byte file and a path of "/" work', () =>
  withEnv(async (e) => {
    const { done } = await sendAll(e, { name: 'empty.txt', path: '/', rootId: 'Videos' }, Buffer.alloc(0));
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(fs.statSync(abs(e.cfg, 'Videos/empty.txt')).size, 0);
  }));

test('resume: the same request returns the open session and its offset', () =>
  withEnv(async (e) => {
    const data = rnd(3 * 1024 * 1024 + 123);
    const meta = { name: 'clip.mp4', rootId: 'Videos', path: 'a', md5: md5(data) };
    const c1 = (await create(e, { ...meta, size: data.length })).json() as { uploadId: string; offset: number };
    await patch(e, c1.uploadId, 0, data.subarray(0, 1024 * 1024));
    await patch(e, c1.uploadId, 1024 * 1024, data.subarray(1024 * 1024, 2 * 1024 * 1024));
    // Phone restarts: same POST, no state kept.
    const c2 = (await create(e, { ...meta, size: data.length })).json() as { uploadId: string; offset: number };
    assert.equal(c2.uploadId, c1.uploadId);
    assert.equal(c2.offset, 2 * 1024 * 1024);
    // A different md5 or size is a different upload.
    const other = (await create(e, { ...meta, size: data.length, md5: md5(rnd(5)) })).json() as { uploadId: string };
    assert.notEqual(other.uploadId, c1.uploadId);
    const rest = await patch(e, c2.uploadId, c2.offset, data.subarray(c2.offset));
    assert.equal(rest.statusCode, 200);
    const done = await complete(e, c2.uploadId);
    assert.equal(done.statusCode, 200, done.body);
    assert.ok(fs.readFileSync(abs(e.cfg, 'Videos/a/clip.mp4')).equals(data));
  }));

test('resume after a dropped connection keeps the bytes that arrived (real HTTP)', () =>
  withEnv(async (e) => {
    await e.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (e.app.server.address() as AddressInfo).port;
    const data = rnd(1024 * 1024);
    const c = (await create(e, { name: 'drop.jpg', size: data.length })).json() as { uploadId: string };
    // Send a header that promises 1 MiB, write 300 000 bytes, then kill the socket.
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PATCH', path: `/api/v1/uploads/${c.uploadId}`, headers: { authorization: `Bearer ${e.token}`, 'content-type': OCT, 'upload-offset': '0', 'content-length': String(data.length) } });
      req.on('error', () => undefined);
      req.write(data.subarray(0, 300_000), () => setTimeout(() => { req.destroy(); resolve(); }, 150));
    });
    // Give the server a moment to notice the closed socket.
    let offset = -1;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      offset = ((await create(e, { name: 'drop.jpg', size: data.length })).json() as { offset: number }).offset;
      if (offset > 0) break;
    }
    assert.ok(offset > 0 && offset <= 300_000, `partial bytes kept, offset=${offset}`);
    // The client re-syncs from the server's offset and finishes.
    const r = await patch(e, c.uploadId, offset, data.subarray(offset));
    assert.equal(r.statusCode, 200, r.body);
    const done = await complete(e, c.uploadId);
    assert.equal(done.statusCode, 200, done.body);
    assert.ok(fs.readFileSync(abs(e.cfg, 'Photos/drop.jpg')).equals(data));
  }));

test('wrong or missing Upload-Offset: 409 with the real offset, 400 when absent or malformed', () =>
  withEnv(async (e) => {
    const data = rnd(2000);
    const c = (await create(e, { name: 'a.bin', size: 2000 })).json() as { uploadId: string };
    await patch(e, c.uploadId, 0, data.subarray(0, 1000));
    for (const wrong of [0, 500, 1500]) {
      const r = await patch(e, c.uploadId, wrong, data.subarray(0, 100));
      assert.equal(r.statusCode, 409);
      assert.deepEqual(r.json(), { error: 'offset_mismatch', offset: 1000 });
    }
    assert.equal((await patch(e, c.uploadId, 'abc', data.subarray(0, 10))).statusCode, 400);
    assert.equal((await patch(e, c.uploadId, '-1', data.subarray(0, 10))).statusCode, 400);
    const noHeader = await e.app.inject({ method: 'PATCH', url: `/api/v1/uploads/${c.uploadId}`, headers: { ...bearer(e.token), 'content-type': OCT }, payload: data.subarray(0, 10) });
    assert.equal(noHeader.statusCode, 400);
    const badType = await patch(e, c.uploadId, 1000, data.subarray(1000), e.token, 'application/json');
    assert.equal(badType.statusCode, 400);
    // Nothing was written by the failed attempts.
    assert.equal(((await create(e, { name: 'a.bin', size: 2000 })).json() as { offset: number }).offset, 1000);
  }));

test('complete: 400 while incomplete, 422 on md5 mismatch (session dropped), ok with the right md5', () =>
  withEnv(async (e) => {
    const data = rnd(5000);
    const c = (await create(e, { name: 'm.bin', size: 5000, md5: md5(data) })).json() as { uploadId: string };
    await patch(e, c.uploadId, 0, data.subarray(0, 2000));
    const early = await complete(e, c.uploadId);
    assert.equal(early.statusCode, 400);
    assert.deepEqual(early.json(), { error: 'upload_incomplete', offset: 2000 });
    assert.equal(fs.existsSync(abs(e.cfg, 'Photos/m.bin')), false);

    // Right size, wrong content (the md5 given at create belongs to other bytes).
    const wrong = (await create(e, { name: 'w.bin', size: 5000, md5: md5(rnd(3)) })).json() as { uploadId: string };
    await patch(e, wrong.uploadId, 0, data);
    const r = await complete(e, wrong.uploadId);
    assert.equal(r.statusCode, 422);
    assert.deepEqual(r.json(), { error: 'md5_mismatch' });
    assert.equal(fs.existsSync(abs(e.cfg, 'Photos/w.bin')), false, 'nothing placed');
    assert.equal((await complete(e, wrong.uploadId)).statusCode, 404, 'session is gone');
    // Same request again starts clean at offset 0.
    const again = (await create(e, { name: 'w.bin', size: 5000, md5: md5(rnd(3)) })).json() as { offset: number };
    assert.equal(again.offset, 0);

    // The good upload still completes.
    const r2 = await patch(e, c.uploadId, 2000, data.subarray(2000));
    assert.equal(r2.statusCode, 200);
    assert.equal((await complete(e, c.uploadId)).statusCode, 200);
    assert.ok(fs.readFileSync(abs(e.cfg, 'Photos/m.bin')).equals(data));
  }));

test('mtime: the original modification time is kept, and bad values are refused', () =>
  withEnv(async (e) => {
    const when = '2024-05-06T07:08:09.000Z';
    const { done } = await sendAll(e, { name: 'old.jpg', path: 'm', mtime: when }, rnd(50));
    assert.equal((done.json() as { mtime: string }).mtime, when);
    assert.equal(fs.statSync(abs(e.cfg, 'Photos/m/old.jpg')).mtime.toISOString(), when);
    const ms = Date.UTC(2020, 0, 2, 3, 4, 5);
    const r2 = (await sendAll(e, { name: 'old2.jpg', mtime: ms }, rnd(10))).done;
    assert.equal((r2.json() as { mtime: string }).mtime, new Date(ms).toISOString());
    // The next rescan sees the same time: no 'update' change.
    const res = await e.app.indexer.scan();
    assert.deepEqual([res.added, res.updated, res.deleted], [0, 0, 0]);
    // Without mtime the time of the upload is used.
    const r3 = (await sendAll(e, { name: 'now.jpg' }, rnd(10))).done;
    assert.ok(Math.abs(Date.parse((r3.json() as { mtime: string }).mtime) - Date.now()) < 60_000);
    for (const bad of ['yesterday', -5, Date.now() + 3 * 86_400_000, {}, true]) {
      assert.equal((await create(e, { name: 'b.jpg', size: 1, mtime: bad as string })).statusCode, 400, JSON.stringify(bad));
    }
  }));

test('md5 is validated at create', () =>
  withEnv(async (e) => {
    for (const bad of ['xyz', 'a'.repeat(31), 'g'.repeat(32), 12]) assert.equal((await create(e, { name: 'x.jpg', size: 1, md5: bad as string })).statusCode, 400);
    assert.equal((await create(e, { name: 'x.jpg', size: 1, md5: 'A'.repeat(32) })).statusCode, 200);
  }));

test('name collision: never overwrite, add a numbered suffix', () =>
  withEnv(async (e) => {
    const original = put(e.cfg, 'Photos/trip/IMG.jpg', 'ORIGINAL');
    const a = rnd(100);
    const b = rnd(100);
    const r1 = (await sendAll(e, { name: 'IMG.jpg', path: 'trip' }, a)).done;
    assert.equal((r1.json() as { name: string }).name, 'IMG (1).jpg');
    const r2 = (await sendAll(e, { name: 'IMG.jpg', path: 'trip' }, b)).done;
    assert.equal((r2.json() as { name: string }).name, 'IMG (2).jpg');
    assert.equal(fs.readFileSync(original, 'utf8'), 'ORIGINAL');
    assert.ok(fs.readFileSync(abs(e.cfg, 'Photos/trip/IMG (1).jpg')).equals(a));
    assert.ok(fs.readFileSync(abs(e.cfg, 'Photos/trip/IMG (2).jpg')).equals(b));
    // A folder with the same name also blocks the name.
    fs.mkdirSync(abs(e.cfg, 'Photos/trip/folder.jpg'));
    const r3 = (await sendAll(e, { name: 'folder.jpg', path: 'trip' }, a)).done;
    assert.equal((r3.json() as { name: string }).name, 'folder (1).jpg');
  }));

test('two sessions for the same name finish at the same time: both kept, different names', () =>
  withEnv(async (e) => {
    const x = rnd(50_000);
    const y = rnd(50_001);
    const [cx, cy] = await Promise.all([create(e, { name: 'same.jpg', size: x.length }), create(e, { name: 'same.jpg', size: y.length })]);
    const ix = (cx.json() as { uploadId: string }).uploadId;
    const iy = (cy.json() as { uploadId: string }).uploadId;
    assert.notEqual(ix, iy);
    await Promise.all([patch(e, ix, 0, x), patch(e, iy, 0, y)]);
    const [rx, ry] = await Promise.all([complete(e, ix), complete(e, iy)]);
    assert.equal(rx.statusCode, 200);
    assert.equal(ry.statusCode, 200);
    const names = [(rx.json() as { name: string }).name, (ry.json() as { name: string }).name].sort();
    assert.deepEqual(names, ['same (1).jpg', 'same.jpg']);
    const onDisk = fs.readdirSync(abs(e.cfg, 'Photos')).sort();
    assert.deepEqual(onDisk, ['same (1).jpg', 'same.jpg']);
  }));

test('many sessions at once (concurrent uploads) all arrive intact', () =>
  withEnv(async (e) => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.bin`, data: rnd(300_000 + i) }));
    await Promise.all(files.map((f) => sendAll(e, { name: f.name, path: 'batch' }, f.data, 100_000).then(({ done }) => assert.equal(done.statusCode, 200, done.body))));
    for (const f of files) assert.ok(fs.readFileSync(abs(e.cfg, `Photos/batch/${f.name}`)).equals(f.data), f.name);
    assert.deepEqual(tmpFiles(e), []);
  }));

test('two PATCHes with the same offset at once: one wins, the other gets 409', () =>
  withEnv(async (e) => {
    const data = rnd(1000);
    const c = (await create(e, { name: 'race.bin', size: 1000 })).json() as { uploadId: string };
    const [a, b] = await Promise.all([patch(e, c.uploadId, 0, data), patch(e, c.uploadId, 0, data)]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal((await complete(e, c.uploadId)).statusCode, 200);
    assert.ok(fs.readFileSync(abs(e.cfg, 'Photos/race.bin')).equals(data));
  }));

test('complete twice (answer lost): same item, no extra file; create again returns "all sent"', () =>
  withEnv(async (e) => {
    const data = rnd(777);
    const { uploadId, done } = await sendAll(e, { name: 'once.jpg', md5: md5(data) }, data);
    const again = await complete(e, uploadId);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), done.json());
    const c = (await create(e, { name: 'once.jpg', size: data.length, md5: md5(data) })).json() as { uploadId: string; offset: number };
    assert.deepEqual(c, { uploadId, offset: data.length });
    assert.deepEqual(fs.readdirSync(abs(e.cfg, 'Photos')), ['once.jpg']);
    // The file is removed by hand: a new upload is a real new one.
    fs.rmSync(abs(e.cfg, 'Photos/once.jpg'));
    const c2 = (await create(e, { name: 'once.jpg', size: data.length, md5: md5(data) })).json() as { offset: number };
    assert.equal(c2.offset, 0);
  }));

test('traversal and bad names are refused and nothing is written outside the library', () =>
  withEnv(async (e) => {
    const outside = path.join(e.cfg.dataDir, 'outside.txt');
    const bad: Partial<Meta>[] = [
      { name: '../outside.txt' },
      { name: '..' },
      { name: '.' },
      { name: 'a/b.jpg' },
      { name: 'a\\b.jpg' },
      { name: '.hidden.jpg' },
      { name: '' },
      { name: 'nul\0.jpg' },
      { name: 'x'.repeat(256) },
      { name: 'ok.jpg', path: '../..' },
      { name: 'ok.jpg', path: '../library/Photos' },
      { name: 'ok.jpg', path: 'a/../../b' },
      { name: 'ok.jpg', path: 'a\\..\\b' },
      { name: 'ok.jpg', path: '.git' },
      { name: 'ok.jpg', rootId: '..' },
      { name: 'ok.jpg', rootId: '../uploads' },
      { name: 'ok.jpg', rootId: 'Photos/..' },
      { name: 'ok.jpg', rootId: '' },
    ];
    for (const m of bad) {
      const r = await create(e, { size: 3, ...m } as Meta);
      assert.equal(r.statusCode, 400, JSON.stringify(m) + ' -> ' + r.body);
    }
    assert.equal((await create(e, { name: 'ok.jpg', size: 3, rootId: 'Nope' })).statusCode, 404);
    for (const body of [null, 'x', [], { name: 'a.jpg' }, { name: 'a.jpg', size: -1, rootId: 'Photos' }, { name: 'a.jpg', size: 1.5, rootId: 'Photos' }, { name: 'a.jpg', size: '3', rootId: 'Photos' }]) {
      const r = await e.app.inject({ method: 'POST', url: '/api/v1/uploads', headers: { ...bearer(e.token), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      assert.equal(r.statusCode, 400, JSON.stringify(body));
    }
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(tmpFiles(e), [], 'no session was created');
  }));

test('traversal through the file system: a symlinked folder or a file in the way is refused', () =>
  withEnv(async (e) => {
    const outsideDir = path.join(e.cfg.dataDir, 'elsewhere');
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(libraryDir(e.cfg), 'Photos', 'link'));
    put(e.cfg, 'Photos/afile', 'x');
    assert.equal((await create(e, { name: 'a.jpg', size: 1, path: 'link' })).statusCode, 400);
    assert.equal((await create(e, { name: 'a.jpg', size: 1, path: 'link/deeper' })).statusCode, 400);
    assert.equal((await create(e, { name: 'a.jpg', size: 1, path: 'afile/sub' })).statusCode, 400);
    assert.deepEqual(fs.readdirSync(outsideDir), []);

    // The symlink appears AFTER the session was opened: complete still refuses.
    const c = (await create(e, { name: 'late.jpg', size: 1, path: 'later/x' })).json() as { uploadId: string };
    await patch(e, c.uploadId, 0, Buffer.from('z'));
    fs.symlinkSync(outsideDir, path.join(libraryDir(e.cfg), 'Photos', 'later'));
    const r = await complete(e, c.uploadId);
    assert.equal(r.statusCode, 400, r.body);
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  }));

test('auth: every upload route needs the token; no delete route exists', () =>
  withEnv(async (e) => {
    const c = (await create(e, { name: 'a.jpg', size: 4 })).json() as { uploadId: string };
    const calls: [string, string][] = [['POST', '/api/v1/uploads'], ['PATCH', `/api/v1/uploads/${c.uploadId}`], ['POST', `/api/v1/uploads/${c.uploadId}/complete`], ['DELETE', `/api/v1/uploads/${c.uploadId}`]];
    for (const [method, url] of calls) {
      const none = await e.app.inject({ method: method as 'POST', url, headers: { 'content-type': OCT, 'upload-offset': '0' }, payload: Buffer.from('abcd') });
      assert.equal(none.statusCode, 401, `${method} ${url}`);
      const wrong = await e.app.inject({ method: method as 'POST', url, headers: { ...bearer('nope'), 'content-type': OCT, 'upload-offset': '0' }, payload: Buffer.from('abcd') });
      assert.equal(wrong.statusCode, 401, `${method} ${url}`);
    }
    const del = await e.app.inject({ method: 'DELETE', url: `/api/v1/uploads/${c.uploadId}`, headers: bearer(e.token) });
    assert.equal(del.statusCode, 404);
    const delItem = await e.app.inject({ method: 'DELETE', url: '/api/v1/items/AAAAAAAAAAAAAAAAAAAAAA', headers: bearer(e.token) });
    assert.equal(delItem.statusCode, 404);
    // Unknown / malformed ids.
    assert.equal((await patch(e, 'short', 0, Buffer.from('a'))).statusCode, 404);
    assert.equal((await patch(e, 'A'.repeat(22), 0, Buffer.from('a'))).statusCode, 404);
    assert.equal((await complete(e, 'A'.repeat(22))).statusCode, 404);
    // The first session is intact.
    assert.equal((await patch(e, c.uploadId, 0, Buffer.from('abcd'))).statusCode, 200);
  }));

test('limits: file too big 413, chunk too big 413, chunk past the declared size 400', () =>
  withEnv(
    async (e) => {
      assert.equal((await create(e, { name: 'huge.bin', size: 2 * 1024 * 1024 })).statusCode, 413);
      const c = (await create(e, { name: 'ok.bin', size: 900_000 })).json() as { uploadId: string };
      const big = await patch(e, c.uploadId, 0, rnd(1024 * 1024 + 1));
      assert.equal(big.statusCode, 413);
      const past = await create(e, { name: 'small.bin', size: 100 });
      const id = (past.json() as { uploadId: string }).uploadId;
      assert.equal((await patch(e, id, 0, rnd(101))).statusCode, 400);
      assert.equal((await patch(e, id, 0, rnd(100))).statusCode, 200);
      assert.equal((await patch(e, id, 100, rnd(1))).statusCode, 400);
      assert.equal((await complete(e, id)).statusCode, 200);
      assert.equal(fs.statSync(abs(e.cfg, 'Photos/small.bin')).size, 100);
    },
    { UPLOAD_MAX_FILE_MB: '1', UPLOAD_MAX_CHUNK_MB: '1' },
  ));

test('a chunked body (no Content-Length) that overruns is cut off and nothing is kept (real HTTP)', () =>
  withEnv(async (e) => {
    await e.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (e.app.server.address() as AddressInfo).port;
    const c = (await create(e, { name: 'chunky.bin', size: 1000 })).json() as { uploadId: string };
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PATCH', path: `/api/v1/uploads/${c.uploadId}`, headers: { authorization: `Bearer ${e.token}`, 'content-type': OCT, 'upload-offset': '0', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write(rnd(600));
      req.write(rnd(600));
      req.end();
    });
    assert.equal(status, 400);
    assert.equal(fs.statSync(path.join(uploadsDir(e.cfg), c.uploadId)).size, 0);
    // A chunked body that fits is accepted.
    const ok = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PATCH', path: `/api/v1/uploads/${c.uploadId}`, headers: { authorization: `Bearer ${e.token}`, 'content-type': OCT, 'upload-offset': '0', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write(rnd(500));
      req.end(rnd(500));
    });
    assert.equal(ok, 200);
    assert.equal((await complete(e, c.uploadId)).statusCode, 200);
  }));

test('disk full: 507 when the file does not fit (create) and when space runs out mid-upload (patch)', async () => {
  let free = 10 * 1024 * 1024 * 1024;
  await withEnv(
    async (e) => {
      // Plenty of room.
      const first = await create(e, { name: 'a.bin', size: 1000 });
      assert.equal(first.statusCode, 200);
      // Free space falls below file + reserve.
      free = 1000 + 512;
      const r = await create(e, { name: 'b.bin', size: 1000 });
      assert.equal(r.statusCode, 507);
      assert.deepEqual(r.json(), { error: 'insufficient_storage' });
      assert.deepEqual(tmpFiles(e).length, 1, 'no session for the refused file');
      // Already open session cannot write when the disk is (nearly) full.
      const id = (first.json() as { uploadId: string }).uploadId;
      free = 100;
      const p = await patch(e, id, 0, rnd(500));
      assert.equal(p.statusCode, 507);
      assert.equal(fs.statSync(path.join(uploadsDir(e.cfg), id)).size, 0);
      // Space comes back: the same session continues.
      free = 10 * 1024 * 1024 * 1024;
      assert.equal((await patch(e, id, 0, rnd(1000))).statusCode, 200);
      assert.equal((await complete(e, id)).statusCode, 200);
    },
    { UPLOAD_MIN_FREE_MB: '0' },
    { diskFree: async () => free },
  );
});

test('disk full: other open sessions reserve their remaining bytes', async () => {
  await withEnv(
    async (e) => {
      const a = await create(e, { name: 'big1.bin', size: 600 });
      assert.equal(a.statusCode, 200);
      // 1000 free, 600 already promised: a second 600 does not fit, 400 does.
      assert.equal((await create(e, { name: 'big2.bin', size: 600 })).statusCode, 507);
      assert.equal((await create(e, { name: 'big3.bin', size: 400 })).statusCode, 200);
    },
    { UPLOAD_MIN_FREE_MB: '0' },
    { diskFree: async () => 1000 },
  );
});

test('stale sessions, old done rows and orphaned temp files are cleaned up', async () => {
  let now = Date.now();
  await withEnv(
    async (e) => {
      const idle = (await create(e, { name: 'idle.bin', size: 10 })).json() as { uploadId: string };
      const fresh = (await create(e, { name: 'fresh.bin', size: 10 })).json() as { uploadId: string };
      const fin = await sendAll(e, { name: 'fin.bin' }, rnd(10));
      const orphan = path.join(uploadsDir(e.cfg), 'orphan-file');
      fs.writeFileSync(orphan, 'x');
      const young = path.join(uploadsDir(e.cfg), 'young-file');
      fs.writeFileSync(young, 'x');
      const old = new Date(Date.now() - 2 * 3_600_000);
      fs.utimesSync(orphan, old, old);

      // 47 h later nothing is stale yet; the idle session is kept.
      now += 47 * 3_600_000;
      fs.utimesSync(young, new Date(now), new Date(now)); // "just created" on the test clock
      let r = await e.app.uploads.cleanup();
      assert.equal(r.sessions, 0);
      assert.ok(fs.existsSync(path.join(uploadsDir(e.cfg), idle.uploadId)));
      assert.equal(r.orphans, 1);
      assert.equal(fs.existsSync(orphan), false);
      assert.equal(fs.existsSync(young), true, 'a young unknown file is not touched');

      // The second session is used, then 3 more hours pass: only the untouched one is stale.
      await create(e, { name: 'fresh.bin', size: 10 });
      now += 3 * 3_600_000;
      r = await e.app.uploads.cleanup();
      assert.equal(r.sessions, 1);
      assert.equal(r.orphans, 1, 'the unknown file is now 3 hours old');
      // Both open sessions were last touched at "now - 3h" or earlier; idle is 50h old, fresh 3h old.
      assert.equal(fs.existsSync(path.join(uploadsDir(e.cfg), idle.uploadId)), false);
      assert.equal(fs.existsSync(path.join(uploadsDir(e.cfg), fresh.uploadId)), true);
      assert.equal((await patch(e, idle.uploadId, 0, rnd(1))).statusCode, 404);
      // The finished file is untouched, and its "done" row is gone (older than 10 minutes).
      assert.ok(fs.existsSync(abs(e.cfg, 'Photos/fin.bin')));
      assert.equal((await complete(e, fin.uploadId)).statusCode, 404);
    },
    {},
    { now: () => now },
  );
});

test('uploaded files are picked up by the next rescan without duplicates or extra changes', () =>
  withEnv(async (e) => {
    const data = rnd(4000);
    await sendAll(e, { name: 'scan.jpg', path: 'x' }, data);
    const before = (await e.app.inject({ method: 'GET', url: '/api/v1/changes', headers: bearer(e.token) })).json() as { changes: unknown[]; cursor: string };
    const res = await e.app.indexer.scan();
    assert.deepEqual([res.added, res.updated, res.deleted], [0, 0, 0]);
    const after = (await e.app.inject({ method: 'GET', url: '/api/v1/changes', headers: bearer(e.token) })).json() as { changes: unknown[]; cursor: string };
    assert.equal(after.cursor, before.cursor);
  }));

test('upload routes have their own rate limit', () =>
  withEnv(
    async (e) => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await create(e, { name: `r${i}.bin`, size: 1 })).statusCode);
      assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
      assert.ok(codes.slice(5).every((c) => c === 429), codes.join());
      // Media reads are not affected by the upload limit.
      const r = await e.app.inject({ method: 'GET', url: '/api/v1/roots', headers: bearer(e.token) });
      assert.equal(r.statusCode, 200);
    },
    { UPLOAD_RATE_LIMIT_MAX: '5' },
  ));

test('tokens never appear in the log during uploads', () =>
  withEnv(async (e) => {
    await sendAll(e, { name: 'log.jpg' }, rnd(100));
    assert.ok(e.logs.length > 0);
    assert.ok(!e.logs.join('').includes(e.token));
  }));
