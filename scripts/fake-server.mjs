// Fake meYou file server implementing docs/API_CONTRACT.md section A.
// Used by `pnpm test:server`, and handy by hand:
//   node scripts/fake-server.mjs --port 8787 --token demo
// then add http://<your-pc-ip>:8787 + token "demo" in Settings > Server connection.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// 1x1 JPEG, used for every thumbnail/preview.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export function contentFor(size, seed) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 7 + seed) % 256;
  return buf;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const typeOf = (name) => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv'].includes(ext)) return 'video';
  if (['txt', 'md'].includes(ext)) return 'text';
  return 'file';
};

export async function startFakeServer({ port = 0, token = 'test-token', dropPatchAt = 0, certFingerprint } = {}) {
  /** key `${root}/${path}` -> { id, root, path, name, type, size, mtime, md5, data } ; dirs have data null */
  const nodes = new Map();
  const roots = [
    { id: 'photos', name: 'Photos' },
    { id: 'videos', name: 'Videos' },
  ];
  let nextId = 1;
  const changeLog = [];
  const requests = { patch: 0, post: 0, byPath: {} };
  const uploads = new Map();
  const completedUploads = [];

  const put = (root, path, extra) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const node = { id: `it${nextId++}`, root, path, name, mtime: '2024-05-01T10:00:00.000Z', ...extra };
    nodes.set(`${root}/${path}`, node);
    return node;
  };
  const ensureDirs = (root, path) => {
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!nodes.has(`${root}/${acc}`)) put(root, acc, { type: 'dir', size: 0, data: null });
    }
  };

  ensureDirs('photos', '2024');
  for (let i = 1; i <= 25; i += 1) {
    const name = `IMG_${String(i).padStart(4, '0')}.jpg`;
    const data = contentFor(2000 + i, i);
    put('photos', `2024/${name}`, { type: 'image', size: data.length, md5: md5(data), mime: 'image/jpeg', data, width: 4000, height: 3000 });
  }
  const top = contentFor(1500, 99);
  put('photos', 'cover.jpg', { type: 'image', size: top.length, md5: md5(top), mime: 'image/jpeg', data: top });
  const video = contentFor(300000, 5);
  put('videos', 'clip.mp4', { type: 'video', size: video.length, md5: md5(video), mime: 'video/mp4', data: video, duration: 12 });

  const toItem = (n) => ({
    id: n.id, name: n.name, type: n.type, size: n.size, mtime: n.mtime,
    ...(n.md5 ? { md5: n.md5 } : {}), ...(n.mime ? { mime: n.mime } : {}),
    ...(n.width ? { width: n.width, height: n.height } : {}), ...(n.duration ? { duration: n.duration } : {}),
  });
  const byId = (id) => [...nodes.values()].find((n) => n.id === id);
  const children = (root, path) =>
    [...nodes.values()]
      .filter((n) => n.root === root && n.path !== path && (path === '' ? !n.path.includes('/') : n.path.startsWith(`${path}/`) && !n.path.slice(path.length + 1).includes('/')))
      .sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));

  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.byPath[url.pathname] = (requests.byPath[url.pathname] ?? 0) + 1;
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
    const p = url.pathname;
    const q = url.searchParams;
    if (!p.startsWith('/api/v1/')) return send(res, 404, { error: 'not found' });
    const route = p.slice('/api/v1'.length);

    if (route === '/ping') return send(res, 200, { name: 'Fake meYou server', version: '0.0.1', features: ['tree', 'thumb', 'range', 'uploads', 'changes'], ...(certFingerprint ? { certFingerprint } : {}) });
    if (route === '/me') return send(res, 200, { deviceId: 'fake-device', role: 'owner', household: { partner: null }, features: [] });
    if (route === '/roots') return send(res, 200, roots);
    if (route === '/tree') {
      const root = q.get('root') ?? '';
      const path = q.get('path') ?? '';
      if (!roots.some((r) => r.id === root)) return send(res, 404, { error: 'no such root' });
      if (path !== '' && nodes.get(`${root}/${path}`)?.type !== 'dir') return send(res, 404, { error: 'no such dir' });
      const all = children(root, path);
      const offset = Number.parseInt(q.get('cursor') ?? '0', 10) || 0;
      const limit = Number.parseInt(q.get('limit') ?? '100', 10) || 100;
      const items = all.slice(offset, offset + limit).map(toItem);
      return send(res, 200, { items, ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) });
    }
    if (route === '/changes') {
      const since = Number.parseInt(q.get('since') ?? '0', 10) || 0;
      return send(res, 200, { changes: changeLog.slice(since), cursor: String(changeLog.length) });
    }
    const itemMatch = /^\/items\/([^/]+)\/(thumb|preview|file)$/.exec(route);
    if (itemMatch) {
      const node = byId(decodeURIComponent(itemMatch[1]));
      if (!node || node.type === 'dir') return send(res, 404, { error: 'no such item' });
      if (itemMatch[2] !== 'file') {
        if (node.type !== 'image' && node.type !== 'video') return send(res, 404, { error: 'no preview' });
        return send(res, 200, JPEG, { 'Content-Type': 'image/jpeg' });
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] === '' ? node.size - 1 : Math.min(Number(range[2]), node.size - 1);
        return send(res, 206, node.data.subarray(start, end + 1), { 'Content-Range': `bytes ${start}-${end}/${node.size}`, 'Accept-Ranges': 'bytes', 'Content-Type': node.mime ?? 'application/octet-stream' });
      }
      return send(res, 200, node.data, { 'Accept-Ranges': 'bytes', 'Content-Type': node.mime ?? 'application/octet-stream' });
    }
    if (route === '/uploads' && req.method === 'POST') {
      requests.post += 1;
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const key = [body.rootId, body.path, body.name, body.size, body.md5 ?? ''].join('|');
      const existing = [...uploads.values()].find((u) => u.key === key && !u.completed);
      if (existing) return send(res, 200, { uploadId: existing.id, offset: existing.offset });
      const upload = { id: `up${uploads.size + 1}`, key, ...body, offset: 0, chunks: [], completed: false };
      uploads.set(upload.id, upload);
      return send(res, 200, { uploadId: upload.id, offset: 0 });
    }
    const up = /^\/uploads\/([^/]+)(\/complete)?$/.exec(route);
    if (up) {
      const upload = uploads.get(up[1]);
      if (!upload) return send(res, 404, { error: 'no such upload' });
      if (up[2] && req.method === 'POST') {
        if (upload.offset !== upload.size) return send(res, 400, { error: 'incomplete' });
        const data = Buffer.concat(upload.chunks);
        if (upload.md5 && md5(data) !== upload.md5) return send(res, 422, { error: 'md5 mismatch' });
        ensureDirs(upload.rootId, upload.path);
        const path = upload.path ? `${upload.path}/${upload.name}` : upload.name;
        const node = put(upload.rootId, path, { type: typeOf(upload.name), size: data.length, md5: md5(data), data, mtime: new Date().toISOString() });
        upload.completed = true;
        completedUploads.push({ id: upload.id, data });
        changeLog.push({ id: node.id, op: 'add', item: { ...toItem(node), root: node.root, path: node.path } });
        return send(res, 200, toItem(node));
      }
      if (req.method === 'PATCH') {
        requests.patch += 1;
        const body = await readBody(req);
        if (dropPatchAt && requests.patch === dropPatchAt) {
          req.socket.destroy(); // simulates a network drop mid-upload (chunk not stored)
          return;
        }
        const offset = Number(req.headers['upload-offset']);
        if (offset !== upload.offset) return send(res, 409, { offset: upload.offset });
        upload.chunks.push(body);
        upload.offset += body.length;
        return send(res, 200, { offset: upload.offset });
      }
    }
    return send(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    token,
    requests,
    nodes,
    completedUploads,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const s = await startFakeServer({ port: Number(arg('port', '8787')), token: arg('token', 'demo') });
  console.log(`Fake meYou server on ${s.url} (token: ${s.token}). Ctrl+C to stop.`);
}
