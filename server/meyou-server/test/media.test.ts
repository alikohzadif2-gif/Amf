import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { bearer, makeEnv, type Env } from './helpers.js';
import { abs, heifAv1, jpeg, makeMp4, png, put } from './fixtures.js';
import { libraryDir } from '../src/config.js';
import { itemId } from '../src/media/store.js';
import { kindByName, sniff } from '../src/media/mime.js';
import { parseFfmpegInfo } from '../src/media/metadata.js';
import { parseRange } from '../src/media/range.js';
import { cleanRelPath } from '../src/media/routes.js';
import { snapSize } from '../src/media/thumbs.js';

async function withEnv(fn: (e: Env) => Promise<void>, extra: Record<string, string> = {}) {
  const e = await makeEnv(extra);
  try {
    await fn(e);
  } finally {
    await e.cleanup();
  }
}

const get = (e: Env, url: string, headers: Record<string, string> = {}) =>
  e.app.inject({ method: 'GET', url, headers: { ...bearer(e.token), ...headers } });

interface Item { id: string; name: string; type: string; size: number; mtime: string; mime?: string; width?: number; height?: number; duration?: number }
async function tree(e: Env, root: string, p = '', extra = ''): Promise<{ items: Item[]; nextCursor?: string }> {
  const r = await get(e, `/api/v1/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}${extra}`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function idOf(e: Env, root: string, p: string): Promise<string> {
  const parts = p.split('/');
  const name = parts.pop()!;
  const t = await tree(e, root, parts.join('/'), '&limit=500');
  const it = t.items.find((i) => i.name === name);
  assert.ok(it, `${p} is indexed`);
  return it.id;
}

// ---- units ------------------------------------------------------------------------------

test('unit: mime by name, sniff, snapSize, cleanRelPath', () => {
  assert.deepEqual(kindByName('a.JPG'), { type: 'image', mime: 'image/jpeg' });
  assert.deepEqual(kindByName('clip.mov'), { type: 'video', mime: 'video/quicktime' });
  assert.equal(kindByName('noext'), null);
  assert.equal(kindByName('.hidden'), null);
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.type, 'image');
  assert.equal(sniff(Buffer.from('....ftypisom....'))?.mime, 'video/mp4');
  assert.equal(sniff(Buffer.from('plain text here...')), null);
  assert.equal(snapSize(1), 64);
  assert.equal(snapSize(100), 128);
  assert.equal(snapSize(256), 256);
  assert.equal(snapSize(5000), 1024);
  assert.equal(cleanRelPath(undefined), '');
  assert.equal(cleanRelPath('/a/b/'), 'a/b');
  for (const bad of ['..', 'a/../b', './a', 'a//b', 'a\\b', 'a\0b']) assert.equal(cleanRelPath(bad), null, bad);
});

test('unit: parseRange', () => {
  assert.deepEqual(parseRange(undefined, 100), { kind: 'none' });
  assert.deepEqual(parseRange('bytes=0-9', 100), { kind: 'range', start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { kind: 'range', start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-5', 100), { kind: 'range', start: 95, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { kind: 'range', start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=50-5000', 100), { kind: 'range', start: 50, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=200-300', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=abc', 'garbage']) {
    assert.deepEqual(parseRange(bad, 100), { kind: 'invalid' }, bad);
  }
  assert.deepEqual(parseRange('bytes=0-1,5-6', 100), { kind: 'none' });
  assert.deepEqual(parseRange('items=0-1', 100), { kind: 'none' });
  assert.deepEqual(parseRange('bytes=0-', 0), { kind: 'invalid' });
});

test('unit: parseFfmpegInfo reads duration, size and rotation', () => {
  const text = `  Duration: 00:01:02.50, start: 0.000000, bitrate: 1000 kb/s
    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 1000 kb/s, 30 fps
    Metadata:
      rotate          : 90`;
  assert.deepEqual(parseFfmpegInfo(text), { width: 1080, height: 1920, duration: 62.5 });
  assert.deepEqual(parseFfmpegInfo('nothing useful'), { width: null, height: null, duration: null });
});

test('ids are stable: same root + path gives the same id', () => {
  assert.equal(itemId('Photos', 'a/b.jpg'), itemId('Photos', 'a/b.jpg'));
  assert.notEqual(itemId('Photos', 'a/b.jpg'), itemId('Videos', 'a/b.jpg'));
  assert.match(itemId('Photos', 'x'), /^[A-Za-z0-9_-]{22}$/);
});

// ---- indexing and listing ---------------------------------------------------------------

test('scan + /tree: dirs first, item shape, metadata, mime, dotfiles and symlinks ignored', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/b.jpg', await jpeg(80, 40));
    put(e.cfg, 'Photos/A.png', await png(30, 20));
    put(e.cfg, 'Photos/rot.jpg', await jpeg(80, 40, 6)); // EXIF orientation 6: shown 40x80
    put(e.cfg, 'Photos/notes.txt', 'سلام\nhello');
    put(e.cfg, 'Photos/no-extension', await jpeg(10, 10));
    put(e.cfg, 'Photos/data.bin', Buffer.from([1, 2, 3, 4]));
    put(e.cfg, 'Photos/.hidden.jpg', await jpeg(10, 10));
    put(e.cfg, 'Photos/2026/trip/x.jpg', await jpeg(16, 16));
    put(e.cfg, 'Photos/.secret/y.jpg', await jpeg(16, 16));
    makeMp4(abs(e.cfg, 'Videos/clip.mp4'), 2, '320x240');
    fs.symlinkSync('/etc/hostname', abs(e.cfg, 'Photos/link.txt'));
    fs.symlinkSync('/etc', abs(e.cfg, 'Photos/linkdir'));

    const r = await e.app.indexer.scan();
    assert.ok(r.added >= 10);

    const t = await tree(e, 'Photos');
    assert.deepEqual(t.items.map((i) => i.name), ['2026', 'A.png', 'b.jpg', 'data.bin', 'no-extension', 'notes.txt', 'rot.jpg']);
    assert.equal(t.items[0]!.type, 'dir');
    const by = Object.fromEntries(t.items.map((i) => [i.name, i]));
    assert.equal(by['b.jpg']!.type, 'image');
    assert.equal(by['b.jpg']!.mime, 'image/jpeg');
    assert.equal(by['b.jpg']!.width, 80);
    assert.equal(by['b.jpg']!.height, 40);
    assert.equal(by['b.jpg']!.size, fs.statSync(abs(e.cfg, 'Photos/b.jpg')).size);
    assert.ok(!Number.isNaN(Date.parse(by['b.jpg']!.mtime)));
    assert.equal(by['rot.jpg']!.width, 40);
    assert.equal(by['rot.jpg']!.height, 80);
    assert.equal(by['no-extension']!.type, 'image'); // sniffed
    assert.equal(by['notes.txt']!.type, 'text');
    assert.equal(by['data.bin']!.type, 'file');
    assert.equal(by['data.bin']!.mime, 'application/octet-stream');
    assert.equal(by['data.bin']!.width, undefined);

    const sub = await tree(e, 'Photos', '2026/trip');
    assert.deepEqual(sub.items.map((i) => i.name), ['x.jpg']);

    const v = await tree(e, 'Videos');
    assert.equal(v.items.length, 1);
    assert.equal(v.items[0]!.type, 'video');
    assert.equal(v.items[0]!.mime, 'video/mp4');
    assert.equal(v.items[0]!.width, 320);
    assert.equal(v.items[0]!.height, 240);
    assert.ok(v.items[0]!.duration! >= 1.5 && v.items[0]!.duration! <= 2.5, String(v.items[0]!.duration));
  }));

test('ids survive a restart (new indexer, same database) and a fresh database', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/s.jpg', await jpeg(8, 8));
    await e.app.indexer.scan();
    const id = await idOf(e, 'Photos', 's.jpg');
    assert.equal(id, itemId('Photos', 's.jpg'));
    const { Indexer } = await import('../src/media/indexer.js');
    const second = new Indexer(e.cfg, e.db, e.app.log);
    const before = (e.db.prepare('SELECT COUNT(*) AS c FROM changes').get() as { c: number }).c;
    await second.scan();
    assert.equal(await idOf(e, 'Photos', 's.jpg'), id);
    const after = (e.db.prepare('SELECT COUNT(*) AS c FROM changes').get() as { c: number }).c;
    assert.equal(after, before, 'an unchanged library adds no change entries');
  }));

test('/tree pagination: limit, nextCursor, no duplicates, bad cursor and limit', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/sub/inner.txt', 'x');
    for (let i = 0; i < 7; i++) put(e.cfg, `Photos/f${i}.txt`, String(i));
    await e.app.indexer.scan();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const t = await tree(e, 'Photos', '', `&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      assert.ok(t.items.length <= 3);
      seen.push(...t.items.map((i) => i.name));
      cursor = t.nextCursor;
      pages++;
    } while (cursor);
    assert.deepEqual(seen, ['sub', 'f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt']);
    assert.equal(pages, 3);
    const exact = await tree(e, 'Photos', '', '&limit=8');
    assert.equal(exact.nextCursor, undefined);
    for (const q of ['&cursor=garbage', '&limit=0', '&limit=abc', '&limit=-1']) {
      assert.equal((await get(e, `/api/v1/tree?root=Photos${q}`)).statusCode, 400, q);
    }
    assert.equal((await tree(e, 'Photos', '', '&limit=99999')).items.length, 8); // clamped to 500
  }));

test('/tree errors and traversal attempts', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/a.txt', 'a');
    await e.app.indexer.scan();
    const code = async (url: string) => (await get(e, url)).statusCode;
    assert.equal(await code('/api/v1/tree'), 400);
    assert.equal(await code('/api/v1/tree?root='), 400);
    assert.equal(await code('/api/v1/tree?root=..'), 400);
    assert.equal(await code('/api/v1/tree?root=a%2Fb'), 400);
    assert.equal(await code('/api/v1/tree?root=Nope'), 404);
    assert.equal(await code('/api/v1/tree?root=Photos&path=..'), 400);
    assert.equal(await code('/api/v1/tree?root=Photos&path=../Videos'), 400);
    assert.equal(await code('/api/v1/tree?root=Photos&path=%2e%2e%2f%2e%2e%2fetc'), 400);
    assert.equal(await code('/api/v1/tree?root=Photos&path=a%5Cb'), 400);
    assert.equal(await code('/api/v1/tree?root=Photos&path=/etc'), 404); // absolute path is just a missing folder
    assert.equal(await code('/api/v1/tree?root=Photos&path=missing'), 404);
    assert.equal(await code('/api/v1/tree?root=Photos&path=a.txt'), 404); // a file is not a folder
    assert.equal((await get(e, '/api/v1/tree?root=Photos&path=/')).statusCode, 200);
  }));

test('media routes need a token', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/a.jpg', await jpeg(8, 8));
    await e.app.indexer.scan();
    const id = await idOf(e, 'Photos', 'a.jpg');
    for (const url of ['/api/v1/tree?root=Photos', `/api/v1/items/${id}/thumb`, `/api/v1/items/${id}/preview`, `/api/v1/items/${id}/file`, '/api/v1/changes']) {
      const r = await e.app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
      assert.equal(r.headers['www-authenticate'], 'Bearer');
    }
  }));

// ---- thumbs and previews ------------------------------------------------------------------

test('thumb and preview for images: sizes, snapping, rotation, cache, ETag, errors', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/wide.jpg', await jpeg(2400, 1200));
    put(e.cfg, 'Photos/small.png', await png(30, 20));
    put(e.cfg, 'Photos/rot.jpg', await jpeg(300, 100, 6)); // shown 100x300
    put(e.cfg, 'Photos/doc.txt', 'text');
    put(e.cfg, 'Photos/broken.jpg', Buffer.from('this is not a jpeg'));
    put(e.cfg, 'Photos/real.heic', await heifAv1(64, 48));
    put(e.cfg, 'Photos/hevc.heic', Buffer.from('not decodable'));
    fs.mkdirSync(abs(e.cfg, 'Photos/folder'));
    await e.app.indexer.scan();
    const wide = await idOf(e, 'Photos', 'wide.jpg');

    const dims = async (url: string) => {
      const r = await get(e, url);
      assert.equal(r.statusCode, 200, `${url} ${r.body.slice(0, 80)}`);
      assert.equal(r.headers['content-type'], 'image/jpeg');
      assert.equal(Number(r.headers['content-length']), r.rawPayload.length);
      const m = await sharp(r.rawPayload).metadata();
      return { w: m.width!, h: m.height! };
    };
    assert.deepEqual(await dims(`/api/v1/items/${wide}/thumb`), { w: 256, h: 128 }); // default 256
    assert.deepEqual(await dims(`/api/v1/items/${wide}/thumb?size=64`), { w: 64, h: 32 });
    assert.deepEqual(await dims(`/api/v1/items/${wide}/thumb?size=100`), { w: 128, h: 64 }); // snapped up
    assert.deepEqual(await dims(`/api/v1/items/${wide}/thumb?size=99999`), { w: 1024, h: 512 }); // clamped
    assert.deepEqual(await dims(`/api/v1/items/${wide}/preview`), { w: 1600, h: 800 });
    const small = await idOf(e, 'Photos', 'small.png');
    assert.deepEqual(await dims(`/api/v1/items/${small}/preview`), { w: 30, h: 20 }); // never enlarged
    assert.deepEqual(await dims(`/api/v1/items/${await idOf(e, 'Photos', 'rot.jpg')}/thumb?size=256`), { w: 85, h: 256 }); // EXIF rotation applied
    assert.deepEqual(await dims(`/api/v1/items/${await idOf(e, 'Photos', 'real.heic')}/thumb?size=64`), { w: 64, h: 48 }); // HEIF (AV1)

    // cached on disk + ETag/304
    const r1 = await get(e, `/api/v1/items/${wide}/thumb?size=64`);
    const etag = r1.headers.etag as string;
    assert.ok(etag);
    assert.ok(fs.existsSync(`${e.cfg.dataDir}/cache/thumb`));
    const r2 = await get(e, `/api/v1/items/${wide}/thumb?size=64`, { 'if-none-match': etag });
    assert.equal(r2.statusCode, 304);

    // a replaced file gets a new thumbnail
    fs.writeFileSync(abs(e.cfg, 'Photos/wide.jpg'), await jpeg(1000, 1000));
    fs.utimesSync(abs(e.cfg, 'Photos/wide.jpg'), new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(await dims(`/api/v1/items/${wide}/thumb?size=64`), { w: 64, h: 64 });

    // errors
    assert.equal((await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'doc.txt')}/thumb`)).statusCode, 415);
    assert.equal((await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'broken.jpg')}/thumb`)).statusCode, 415);
    assert.equal((await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'hevc.heic')}/preview`)).statusCode, 415);
    assert.equal((await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'folder')}/thumb`)).statusCode, 404);
    assert.equal((await get(e, '/api/v1/items/AAAAAAAAAAAAAAAAAAAAAA/thumb')).statusCode, 404);
    assert.equal((await get(e, '/api/v1/items/short/thumb')).statusCode, 404);
    assert.equal((await get(e, '/api/v1/items/..%2F..%2Fetc%2Fpasswd/thumb')).statusCode, 404);
    assert.equal((await get(e, `/api/v1/items/${wide}/thumb?size=abc`)).statusCode, 400);
    assert.equal((await get(e, `/api/v1/items/${wide}/thumb?size=0`)).statusCode, 400);
  }));

test('thumb and preview of a video come from an ffmpeg frame', () =>
  withEnv(async (e) => {
    makeMp4(abs(e.cfg, 'Videos/clip.mp4'), 2, '640x360');
    await e.app.indexer.scan();
    const id = await idOf(e, 'Videos', 'clip.mp4');
    const t = await get(e, `/api/v1/items/${id}/thumb?size=128`);
    assert.equal(t.statusCode, 200, t.body.slice(0, 100));
    assert.equal(t.headers['content-type'], 'image/jpeg');
    const tm = await sharp(t.rawPayload).metadata();
    assert.deepEqual([tm.width, tm.height], [128, 72]);
    const p = await get(e, `/api/v1/items/${id}/preview`);
    assert.equal(p.statusCode, 200);
    const pm = await sharp(p.rawPayload).metadata();
    assert.deepEqual([pm.width, pm.height], [640, 360]); // smaller than 1600: not enlarged
    // the frame is not an empty picture
    const stats = await sharp(p.rawPayload).stats();
    assert.ok(stats.channels.some((c) => c.stdev > 5), 'frame has content');
  }));

// ---- original file with Range ---------------------------------------------------------------

test('file: full, Range (start, middle, suffix, open end, clamp), 416, ignored ranges, validators, HEAD', () =>
  withEnv(async (e) => {
    const body = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    put(e.cfg, 'Videos/raw.mp4', body); // content does not need to be a real video here
    await e.app.indexer.scan();
    const id = await idOf(e, 'Videos', 'raw.mp4');
    const url = `/api/v1/items/${id}/file`;

    const full = await get(e, url);
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['content-length'], '100');
    assert.equal(full.headers['content-type'], 'video/mp4');
    assert.match(String(full.headers['content-disposition']), /^inline; filename="raw\.mp4"/);
    assert.ok(full.headers.etag && full.headers['last-modified']);
    assert.deepEqual(full.rawPayload, body);

    const part = async (range: string, extraHeaders: Record<string, string> = {}) => get(e, url, { range, ...extraHeaders });
    let r = await part('bytes=0-9');
    assert.equal(r.statusCode, 206);
    assert.equal(r.headers['content-range'], 'bytes 0-9/100');
    assert.equal(r.headers['content-length'], '10');
    assert.deepEqual(r.rawPayload, body.subarray(0, 10));
    r = await part('bytes=10-19');
    assert.equal(r.headers['content-range'], 'bytes 10-19/100');
    assert.deepEqual(r.rawPayload, body.subarray(10, 20));
    r = await part('bytes=-5');
    assert.equal(r.statusCode, 206);
    assert.equal(r.headers['content-range'], 'bytes 95-99/100');
    assert.deepEqual(r.rawPayload, body.subarray(95));
    r = await part('bytes=90-');
    assert.equal(r.headers['content-range'], 'bytes 90-99/100');
    r = await part('bytes=50-5000');
    assert.equal(r.headers['content-range'], 'bytes 50-99/100');
    assert.equal(r.rawPayload.length, 50);
    r = await part('bytes=99-99');
    assert.deepEqual(r.rawPayload, body.subarray(99));

    for (const bad of ['bytes=100-', 'bytes=500-600', 'bytes=9-3', 'bytes=abc', 'nonsense', 'bytes=-0']) {
      r = await part(bad);
      assert.equal(r.statusCode, 416, bad);
      assert.equal(r.headers['content-range'], 'bytes */100');
      assert.deepEqual(r.json(), { error: 'range_not_satisfiable' });
    }
    // multi-range and other units are ignored: the whole file is returned
    assert.equal((await part('bytes=0-1,5-6')).rawPayload.length, 100);
    assert.equal((await part('items=0-1')).statusCode, 200);

    // validators
    const etag = full.headers.etag as string;
    assert.equal((await get(e, url, { 'if-none-match': etag })).statusCode, 304);
    assert.equal((await part('bytes=0-9', { 'if-range': etag })).statusCode, 206);
    assert.equal((await part('bytes=0-9', { 'if-range': '"other"' })).statusCode, 200); // stale validator: full file

    const head = await e.app.inject({ method: 'HEAD', url, headers: bearer(e.token) });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-length'], '100');
    assert.equal(head.rawPayload.length, 0);
  }));

test('file: empty file, text type, unicode name, folders and unknown ids', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/empty.txt', '');
    put(e.cfg, 'Photos/یادداشت.txt', 'سلام');
    fs.mkdirSync(abs(e.cfg, 'Photos/dir'));
    await e.app.indexer.scan();
    const empty = await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'empty.txt')}/file`);
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.headers['content-length'], '0');
    assert.equal((await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'empty.txt')}/file`, { range: 'bytes=0-' })).statusCode, 416);
    const fa = await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'یادداشت.txt')}/file`);
    assert.equal(fa.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(String(fa.headers['content-disposition']), /filename\*=UTF-8''%DB%8C/);
    assert.equal(fa.body, 'سلام');
    assert.equal((await get(e, `/api/v1/items/${await idOf(e, 'Photos', 'dir')}/file`)).statusCode, 404);
    assert.equal((await get(e, '/api/v1/items/AAAAAAAAAAAAAAAAAAAAAA/file')).statusCode, 404);
    assert.equal((await get(e, '/api/v1/items/..%2F..%2Fetc%2Fpasswd/file')).statusCode, 404);
  }));

test('file: a file replaced by a symlink (or removed) after indexing is refused', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/a.txt', 'secret-free');
    put(e.cfg, 'Photos/b.txt', 'b');
    await e.app.indexer.scan();
    const a = await idOf(e, 'Photos', 'a.txt');
    const b = await idOf(e, 'Photos', 'b.txt');
    fs.rmSync(abs(e.cfg, 'Photos/a.txt'));
    fs.symlinkSync('/etc/hostname', abs(e.cfg, 'Photos/a.txt'));
    assert.equal((await get(e, `/api/v1/items/${a}/file`)).statusCode, 404);
    fs.rmSync(abs(e.cfg, 'Photos/b.txt'));
    assert.equal((await get(e, `/api/v1/items/${b}/file`)).statusCode, 404);
  }));

test('media routes have their own, higher rate limit', () =>
  withEnv(
    async (e) => {
      put(e.cfg, 'Photos/a.txt', 'a');
      await e.app.indexer.scan();
      const id = await idOf(e, 'Photos', 'a.txt');
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await get(e, `/api/v1/items/${id}/file`)).statusCode);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
      assert.equal((await get(e, '/api/v1/me')).statusCode, 200); // other routes keep their own budget
    },
    { MEDIA_RATE_LIMIT_MAX: '5', RATE_LIMIT_MAX: '1000' },
  ));

// ---- changes ---------------------------------------------------------------------------------

test('/changes: add, update, rename, delete, cursor, paging, bad input', () =>
  withEnv(async (e) => {
    const changes = async (since: string, extra = '') => {
      const r = await get(e, `/api/v1/changes?since=${since}${extra}`);
      assert.equal(r.statusCode, 200, r.body);
      return r.json() as { changes: { id: string; op: string; root: string; path: string; item?: Item }[]; cursor: string };
    };
    put(e.cfg, 'Photos/one.txt', '1');
    await e.app.indexer.scan();
    let c = await changes('0');
    assert.deepEqual(c.changes.map((x) => [x.op, x.path]), [['add', 'one.txt']]);
    assert.equal(c.changes[0]!.root, 'Photos');
    assert.equal(c.changes[0]!.item!.name, 'one.txt');
    assert.equal(c.changes[0]!.id, c.changes[0]!.item!.id);
    let cursor = c.cursor;

    // nothing new: empty list, same cursor
    c = await changes(cursor);
    assert.deepEqual(c.changes, []);
    assert.equal(c.cursor, cursor);

    // add + update
    put(e.cfg, 'Photos/two.txt', '2');
    fs.writeFileSync(abs(e.cfg, 'Photos/one.txt'), 'one-changed');
    fs.utimesSync(abs(e.cfg, 'Photos/one.txt'), new Date(), new Date(Date.now() + 3000));
    await e.app.indexer.scan();
    c = await changes(cursor);
    assert.deepEqual(c.changes.map((x) => `${x.op}:${x.path}`).sort(), ['add:two.txt', 'update:one.txt']);
    assert.equal(c.changes.find((x) => x.op === 'update')!.item!.size, 11);
    cursor = c.cursor;

    // rename = delete + add (the id follows the path)
    fs.renameSync(abs(e.cfg, 'Photos/two.txt'), abs(e.cfg, 'Photos/renamed.txt'));
    await e.app.indexer.scan();
    c = await changes(cursor);
    assert.deepEqual(c.changes.map((x) => `${x.op}:${x.path}`).sort(), ['add:renamed.txt', 'delete:two.txt']);
    const del = c.changes.find((x) => x.op === 'delete')!;
    assert.equal(del.item, undefined);
    assert.equal(del.root, 'Photos');
    assert.equal(del.id, itemId('Photos', 'two.txt'));
    assert.equal((await tree(e, 'Photos')).items.some((i) => i.name === 'two.txt'), false);
    cursor = c.cursor;

    // delete a folder: the folder and its files are reported
    put(e.cfg, 'Photos/dir/in.txt', 'x');
    await e.app.indexer.scan();
    cursor = (await changes(cursor)).cursor;
    fs.rmSync(abs(e.cfg, 'Photos/dir'), { recursive: true });
    await e.app.indexer.scan();
    c = await changes(cursor);
    assert.deepEqual(c.changes.map((x) => `${x.op}:${x.path}`).sort(), ['delete:dir', 'delete:dir/in.txt']);

    // paging through the whole log with limit=2
    let since = '0';
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const page = await changes(since, '&limit=2');
      if (page.changes.length === 0 && page.cursor === since) break;
      total += page.changes.length;
      since = page.cursor;
    }
    // 9 log rows; the add of two.txt, dir and dir/in.txt are skipped because those items are gone now
    assert.equal(total, 6);

    for (const bad of ['abc', '-1', '1.5']) assert.equal((await get(e, `/api/v1/changes?since=${bad}`)).statusCode, 400, bad);
    assert.equal((await get(e, '/api/v1/changes?limit=0')).statusCode, 400);
    assert.equal((await get(e, '/api/v1/changes')).statusCode, 200); // since defaults to 0
  }));

test('indexPath hook (used by S5 after an upload) indexes one file and its folders', () =>
  withEnv(async (e) => {
    await e.app.indexer.scan();
    const before = (await get(e, '/api/v1/changes')).json().cursor as string;
    put(e.cfg, 'Photos/2026/10/new.jpg', await jpeg(20, 10));
    const row = await e.app.indexer.indexPath('Photos', '2026/10/new.jpg');
    assert.equal(row?.width, 20);
    const t = await tree(e, 'Photos', '2026/10');
    assert.deepEqual(t.items.map((i) => i.name), ['new.jpg']);
    const c = (await get(e, `/api/v1/changes?since=${before}`)).json();
    assert.deepEqual(c.changes.map((x: { op: string; path: string }) => `${x.op}:${x.path}`), ['add:2026', 'add:2026/10', 'add:2026/10/new.jpg']);
    // refused: traversal, dotfiles, missing, directories
    for (const bad of ['../x.jpg', 'a/../b.jpg', '.hid.jpg', 'missing.jpg', '2026']) assert.equal(await e.app.indexer.indexPath('Photos', bad), null, bad);
  }));

test('a missing library folder aborts the scan and keeps the index (no mass delete)', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Photos/keep.txt', 'k');
    await e.app.indexer.scan();
    fs.renameSync(libraryDir(e.cfg), `${libraryDir(e.cfg)}.away`);
    await assert.rejects(() => e.app.indexer.scan(), /library folder unreadable/);
    fs.renameSync(`${libraryDir(e.cfg)}.away`, libraryDir(e.cfg));
    assert.equal((await tree(e, 'Photos')).items.length, 1);
    const deletes = (e.db.prepare("SELECT COUNT(*) AS c FROM changes WHERE op = 'delete'").get() as { c: number }).c;
    assert.equal(deletes, 0);
  }));

test('a removed root folder reports its files as deleted', () =>
  withEnv(async (e) => {
    put(e.cfg, 'Extra/x.txt', 'x');
    await e.app.indexer.scan();
    assert.equal((await tree(e, 'Extra')).items.length, 1);
    fs.rmSync(abs(e.cfg, 'Extra'), { recursive: true });
    await e.app.indexer.scan();
    assert.equal((await get(e, '/api/v1/tree?root=Extra')).statusCode, 404);
    const ops = (e.db.prepare("SELECT op FROM changes WHERE root = 'Extra' ORDER BY seq").all() as { op: string }[]).map((r) => r.op);
    assert.deepEqual(ops, ['add', 'delete']);
  }));

// ---- scale ----------------------------------------------------------------------------------

test('a folder with 2,000 files is indexed and listed in bounded time', { timeout: 120_000 }, () =>
  withEnv(async (e) => {
    const tiny = await png(4, 4);
    for (let i = 0; i < 2000; i++) put(e.cfg, `Photos/big/img_${String(i).padStart(4, '0')}.png`, tiny);
    const t0 = Date.now();
    const r = await e.app.indexer.scan();
    const scanMs = Date.now() - t0;
    assert.equal(r.added, 2001); // 2000 files + the folder
    assert.ok(scanMs < 60_000, `scan took ${scanMs} ms`);

    const t1 = Date.now();
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const t = await tree(e, 'Photos', 'big', `&limit=500${cursor ? `&cursor=${cursor}` : ''}`);
      names.push(...t.items.map((i) => i.name));
      cursor = t.nextCursor;
      pages++;
    } while (cursor);
    const listMs = Date.now() - t1;
    assert.equal(pages, 4);
    assert.equal(new Set(names).size, 2000);
    assert.equal(names[0], 'img_0000.png');
    assert.equal(names[1999], 'img_1999.png');
    assert.ok(listMs < 5_000, `listing took ${listMs} ms`);

    // a rescan of an unchanged library is cheap and adds no changes
    const t2 = Date.now();
    const again = await e.app.indexer.scan();
    assert.equal(again.added + again.updated + again.deleted, 0);
    assert.ok(Date.now() - t2 < 30_000);
    console.log(`# 2000 files: first scan ${scanMs} ms, list ${listMs} ms, rescan ${Date.now() - t2} ms`);
  }));

// ---- upgrade -----------------------------------------------------------------------------------

test('upgrade from schema 1 (S1/S2 database) keeps the household and the token', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { openDb, schemaVersion, findDeviceByTokenHash } = await import('../src/db.js');
  const { initHousehold } = await import('../src/init.js');
  const { dbFile, loadConfig } = await import('../src/config.js');
  const { hashToken } = await import('../src/tokens.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-upgrade-'));
  try {
    const cfg = loadConfig({ DATA_DIR: dir, DOMAIN: 'meyou.example.com' });
    const db = openDb(dbFile(cfg));
    const token = initHousehold(cfg, db).token!;
    // Turn it back into a v1 database: no media tables, user_version 1.
    db.exec('DROP TABLE items; DROP TABLE changes; DROP TABLE uploads; DROP TABLE mailbox; PRAGMA user_version = 1;');
    assert.equal(schemaVersion(db), 1);
    db.close();

    const again = openDb(dbFile(cfg)); // what `setup.sh update` does on start
    assert.equal(schemaVersion(again), 7);
    assert.ok(findDeviceByTokenHash(again, hashToken(token)), 'old token still valid');
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 0);
    // a library that already has files is indexed on the first scan after the update
    fs.writeFileSync(path.join(dir, 'library', 'Photos', 'old.txt'), 'x');
    const { Indexer } = await import('../src/media/indexer.js');
    const r = await new Indexer(cfg, again, { info() {}, warn() {}, error() {} }).scan();
    assert.equal(r.added, 1);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
