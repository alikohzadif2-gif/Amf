// S6 manual load test (NOT part of `pnpm test`): a 300 MB video + 200 photos through the app's real
// backup code (scan -> queue -> ServerProvider.upload) into the REAL server, with "airplane mode"
// switched on and off while it runs. Usage:  npx tsx scripts/test-backup-load.mjs [videoMB] [photos]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ServerProvider } from '../src/server/server-provider.ts';
import { parseServerQr } from '../src/server/qr.ts';
import { scanNewMedia } from '../src/backup/backup-new.ts';
import { createUploadQueue } from '../src/backup/queue.ts';

const videoMb = Number(process.argv[2] ?? 300);
const photoCount = Number(process.argv[3] ?? 200);
const serverDir = path.resolve(new URL('../server/meyou-server', import.meta.url).pathname);
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-load-data-'));
const phoneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-load-phone-'));
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_NO_WARNINGS: '1', DATA_DIR: dataDir, DOMAIN: 'localhost', PUBLIC_URL: url, PORT: String(port), HOST: '127.0.0.1', SERVER_NAME: 'Load', UPLOAD_RATE_LIMIT_MAX: '100000', RATE_LIMIT_MAX: '100000', MEDIA_RATE_LIMIT_MAX: '100000' };
const init = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init'], { cwd: serverDir, env, encoding: 'utf8' });
const link = /meyou:\/\/server\?[^\s]+/.exec(init.stdout)?.[0];
assert.ok(link, 'init printed a link');
const code = parseServerQr(link);
const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], { cwd: serverDir, env, stdio: 'ignore' });
const stop = () => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(phoneDir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${url}/api/v1/ping`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

// ---- the phone: 200 photos (0.3-3 MB, dates over 14 months) + one big video -------------
const files = {};
const md5File = (file) => { const h = crypto.createHash('md5'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20); let n; let pos = 0; while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) { h.update(buf.subarray(0, n)); pos += n; } fs.closeSync(fd); return h.digest('hex'); };
for (let i = 1; i <= photoCount; i += 1) {
  const name = `IMG_${String(i).padStart(4, '0')}.jpg`;
  const file = path.join(phoneDir, name);
  fs.writeFileSync(file, crypto.randomBytes(300_000 + Math.floor(Math.random() * 2_700_000)));
  const mtime = new Date(Date.UTC(2025, 5 + (i % 14), 1 + (i % 27), 12)).toISOString();
  files[`${i}`] = { name, type: 'image', mtime, file };
}
{
  const file = path.join(phoneDir, 'VID_BIG.mp4');
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < videoMb; i += 1) fs.writeSync(fd, crypto.randomBytes(1 << 20));
  fs.closeSync(fd);
  files.big = { name: 'VID_BIG.mp4', type: 'video', mtime: '2026-05-05T12:00:00.000Z', file };
}
for (const f of Object.values(files)) { f.size = fs.statSync(f.file).size; f.md5 = md5File(f.file); }
const totalBytes = Object.values(files).reduce((a, f) => a + f.size, 0);
console.log(`phone: ${photoCount} photos + ${videoMb} MB video = ${(totalBytes / 1048576).toFixed(0)} MB`);

const dir = (id, name) => ({ id, parentId: null, name, type: 'dir', size: 0, mtime: new Date(0).toISOString() });
const phone = {
  id: 'local', kind: 'local', isMock: false,
  list: async (parent, opts = {}) => {
    if (parent === null) return { items: [dir('ml:album:1', 'Camera')] };
    const all = Object.entries(files).map(([id, f]) => ({ id: `ml:asset:${id}`, parentId: parent, name: f.name, type: f.type, size: 0, mtime: f.mtime }));
    const off = Number(opts.cursor ?? 0); const lim = opts.limit ?? 100;
    return { items: all.slice(off, off + lim), nextCursor: off + lim < all.length ? String(off + lim) : undefined };
  },
  getOriginalUrl: async (id) => files[id.replace('ml:asset:', '')]?.file ?? null,
};
const localInfo = (uri) => { const f = Object.values(files).find((x) => x.file === uri); return f ? { size: f.size, md5: f.size <= 50 * 1048576 ? f.md5 : undefined } : null; };
const openReader = async (uri) => {
  const fd = fs.openSync(uri, 'r');
  return { size: fs.fstatSync(fd).size, read: async (offset, length) => { const b = Buffer.alloc(length); const n = fs.readSync(fd, b, 0, length, offset); return new Uint8Array(b.subarray(0, n)); }, close: () => fs.closeSync(fd) };
};

// ---- "airplane mode": requests fail and the rule says no-network; the watcher kicks when it ends ----
let airplane = false;
let sentBytes = 0;
let drops = 0;
const fetchLike = (input, init) => {
  if (airplane) { drops += 1; return Promise.reject(new TypeError('Network request failed')); }
  if (init?.method === 'PATCH') sentBytes += init.body.length;
  return fetch(input, init);
};
const target = new ServerProvider('load', { endpoints: () => [{ id: 'e', url: code.url, token: code.token }], failover: () => false, timeoutMs: 15000, fetch: fetchLike, openReader });
const queue = createUploadQueue({ resolveProvider: () => target, canRun: () => (airplane ? 'no-network' : null), retryDelaysMs: [200, 500, 1000, 2000, 4000] });

const choice = { photos: true, videos: true, scope: 'camera', albums: [] };
const t0 = Date.now();
const scan = await scanNewMedia({ phone, target, backedUp: {}, localInfo, choice });
assert.equal(scan.jobs.length, photoCount + 1);
queue.getState().enqueue(scan.jobs);
queue.getState().beginRun({ scanned: scan.scanned, skipped: scan.alreadyThere, unreadable: scan.unreadable, queued: scan.jobs.length });
console.log(`scan: ${scan.jobs.length} jobs in ${Date.now() - t0} ms`);

// toggle airplane mode 3 times at fixed fractions of the data sent
const toggles = [0.15, 0.45, 0.8].map((f) => f * totalBytes);
let next = 0;
const watcher = setInterval(() => {
  if (!airplane && next < toggles.length && sentBytes >= toggles[next]) {
    airplane = true; next += 1;
    console.log(`  airplane ON at ${(sentBytes / 1048576).toFixed(0)} MB`);
    setTimeout(() => { airplane = false; console.log('  airplane OFF'); void queue.getState().kick(); }, 2500);
  }
}, 20);
const t1 = Date.now();
await queue.getState().start();
// the loop stops while "offline"; the watcher's kick above restarts it
while (queue.getState().jobs.some((j) => j.state === 'queued' || j.state === 'uploading')) {
  await new Promise((r) => setTimeout(r, 100));
  if (!queue.getState().running) await queue.getState().kick();
}
clearInterval(watcher);
const secs = (Date.now() - t1) / 1000;

const s = queue.getState();
const states = s.jobs.reduce((m, j) => ({ ...m, [j.state]: (m[j.state] ?? 0) + 1 }), {});
console.log(`upload: ${JSON.stringify(states)} in ${secs.toFixed(1)} s (${(totalBytes / 1048576 / secs).toFixed(0)} MB/s), dropped requests: ${drops}, bytes sent by PATCH: ${(sentBytes / 1048576).toFixed(0)} MB`);
assert.deepEqual(states, { done: photoCount + 1 });
assert.ok(next === 3, 'airplane mode was toggled 3 times');

// ---- verify on the server's disk ---------------------------------------------------------------
const lib = path.join(dataDir, 'library');
let checked = 0;
for (const f of Object.values(files)) {
  const d = new Date(f.mtime);
  const rel = f.type === 'video' ? 'Videos' : 'Photos';
  const onDisk = path.join(lib, rel, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), f.name);
  assert.ok(fs.existsSync(onDisk), `missing ${onDisk}`);
  assert.equal(fs.statSync(onDisk).size, f.size, `size ${f.name}`);
  assert.equal(md5File(onDisk), f.md5, `md5 ${f.name}`);
  assert.equal(fs.statSync(onDisk).mtime.toISOString(), f.mtime, `mtime ${f.name}`);
  checked += 1;
}
console.log(`verified on the server disk: ${checked} files, md5 + size + date identical`);
assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0, 'no temp files left');
// a second run uploads nothing
await new Promise((r) => setTimeout(r, 300));
const again = await scanNewMedia({ phone, target: new ServerProvider('load2', { endpoints: () => [{ id: 'e', url: code.url, token: code.token }], failover: () => false, timeoutMs: 15000 }), backedUp: {}, localInfo, choice });
assert.equal(again.jobs.length, 0);
assert.equal(again.alreadyThere, photoCount + 1);
console.log(`second scan: 0 new, ${again.alreadyThere} already on the server; peak RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
console.log('backup load test ok');
process.exit(0);
