import assert from 'node:assert/strict';
import { ServerClient, isValidServerUrl, normalizeUrl } from '../src/server/client.ts';
import { dirId, fileId, parseDirId, parseFileId } from '../src/server/ids.ts';
import { parseServerQr } from '../src/server/qr.ts';
import { testConnection } from '../src/server/test-connection.ts';
import { existsSync } from 'node:fs';
import { startFakeServer } from './fake-server.mjs';

// ---- ids, urls, QR --------------------------------------------------
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

}

// ---- the connection test against the fake HTTP server (ping + /me; no library, no upload) -------------------
const server = await startFakeServer({ token: 'secret' });
{
  const ok = await testConnection({ url: server.url, token: 'secret' });
  assert.deepEqual([ok.ok, ok.code, ok.ping.name, ok.me.role], [true, 'ok', 'Fake meYou server', 'owner']);
  assert.equal('rootCount' in ok, false, 'a server has no folders any more');
  assert.equal((await testConnection({ url: server.url, token: 'nope' })).code, 'unauthorized');
  assert.equal((await testConnection({ url: 'http://127.0.0.1:1', token: 'x' }, undefined, 2000)).code, 'unavailable');
}

// client timeout -> 'timeout'
{
  const slow = new ServerClient({ url: server.url, token: 'secret' }, () => new Promise(() => {}), 50);
  await assert.rejects(() => slow.ping(), (e) => e.kind === 'timeout');
}

// the client has no library / upload method left
{
  const client = new ServerClient({ url: server.url, token: 'secret' });
  for (const gone of ['roots', 'tree', 'changes', 'thumbUrl', 'previewUrl', 'fileUrl', 'createUpload', 'patchUpload', 'completeUpload']) {
    assert.equal(typeof client[gone], 'undefined', `ServerClient.${gone} is removed`);
  }
  assert.equal(existsSync(new URL('../src/server/server-provider.ts', import.meta.url)), false, 'ServerProvider is removed');
}

await server.close();

console.log('server tests passed');
