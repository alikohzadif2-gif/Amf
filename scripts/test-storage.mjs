import assert from 'node:assert/strict';
import { MockProvider } from '../src/storage/mock-provider.ts';
import { buildMockTree, countFiles } from '../src/storage/mock-tree.ts';

const tree = buildMockTree('server');
const files = countFiles(tree);
assert.ok(files >= 280 && files <= 340, `expected ~300 files, got ${files}`);
assert.equal((tree.children.get(null) ?? []).length, 4, 'four top folders');

// deterministic
const again = buildMockTree('server');
assert.equal(
  JSON.stringify([...tree.items.values()]),
  JSON.stringify([...again.items.values()]),
);

// two mock servers share some md5s (for diff/merge tests) but not all
const mirror = buildMockTree('alt');
const serverMd5 = new Set([...tree.items.values()].map((i) => i.md5).filter(Boolean));
const shared = [...mirror.items.values()].filter((i) => i.md5 && serverMd5.has(i.md5));
assert.ok(shared.length > 20, `shared md5 count ${shared.length}`);
assert.ok(shared.length < files, 'not identical');

const provider = new MockProvider('t', 'server', 1);
const test = await provider.test();
assert.equal(test.ok, true);
assert.equal(test.rootCount, 4);

// paging
const roots = await provider.list(null);
assert.equal(roots.items.length, 4);
const photos = await provider.list('Photos/2024', { limit: 10 });
assert.equal(photos.items.length > 0, true);
let cursor = (await provider.list('Photos/2024', { limit: 10 })).nextCursor;
let count = 10;
while (cursor) {
  const page = await provider.list('Photos/2024', { limit: 10, cursor });
  count += page.items.length;
  cursor = page.nextCursor;
}
const all = await provider.list('Photos/2024', { limit: 1000 });
assert.equal(count, all.items.length, 'paging covers everything once');

// thumbs, upload, changes, delete
const first = all.items.find((i) => i.type === 'image');
const thumb = await provider.getThumb(first.id);
assert.ok(thumb.uri.startsWith('data:image/svg+xml'));
assert.equal(await provider.getThumb('Documents'), null);
const up = await provider.upload({ name: 'new.jpg', size: 123, parentId: 'Shared', sourceUri: 'file:///x' });
assert.equal((await provider.stat(up.id)).size, 123);
let ch = await provider.changes();
assert.equal(ch.changes.length, 1);
await provider.delete(up.id);
ch = await provider.changes(ch.cursor);
assert.equal(ch.changes[0].op, 'delete');
assert.equal(await provider.stat(up.id), null);
await provider.delete('Photos');
assert.equal(await provider.stat('Photos/2024'), null, 'delete removes descendants');

console.log(`storage tests passed (${files} mock files)`);
