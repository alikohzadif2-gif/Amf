import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMedia, shuffle, toBlocks } from '../src/explore/layout.ts';

const e = (key, type) => ({ key, item: { type } });
assert.deepEqual(isMedia([e('a', 'image'), e('b', 'dir'), e('c', 'video'), e('d', 'file')]).map((x) => x.key), ['a', 'c'], 'photos and videos only');

const list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const mixed = shuffle(list);
assert.deepEqual([...mixed].sort((a, b) => a - b), list, 'a shuffle keeps every item once');
assert.deepEqual(list, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'the input is not changed');
assert.notDeepEqual(shuffle(list, () => 0), shuffle(list, () => 0.99), 'a different random gives a different order');

const blocks = toBlocks([1, 2, 3, 4, 5, 6, 7, 8], String);
assert.equal(blocks.length, 2, '8 items = one full block and one part block');
assert.deepEqual([blocks[0].big, blocks[0].side, blocks[0].row], [1, [2, 3], [4, 5, 6]]);
assert.deepEqual([blocks[1].big, blocks[1].side, blocks[1].row], [7, [8], []]);
assert.deepEqual(blocks.map((b) => b.bigRight), [false, true], 'the big tile alternates sides');
assert.deepEqual(toBlocks([], String), []);

const screen = readFileSync(new URL('../app/(tabs)/explore.tsx', import.meta.url), 'utf8');
assert.match(screen, /RefreshControl/, 'pull down = a new mix');
assert.match(screen, /useViewerStore\.getState\(\)\.open/, 'a tap opens the existing viewer');
const tabs = readFileSync(new URL('../app/(tabs)/_layout.tsx', import.meta.url), 'utf8');
const order = [...tabs.matchAll(/name: '(\w+)', label/g)].map((m) => m[1]);
assert.deepEqual(order, ['index', 'status', 'explore', 'events', 'diary'], 'Explore sits in the middle of five tabs');
for (const lang of ['en', 'fa']) {
  const dict = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
  for (const key of ['tabExplore', 'exploreEmpty', 'exploreIndexing']) assert.ok(dict[key], `${lang}.${key}`);
}
// Explore tool card: the Archive's Time / Type / Source tools in one slim glass row, no live blur (it made the app lag).
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/(tabs)/explore.tsx', import.meta.url), 'utf8');
  assert.match(src, /applyTimeOrder\(/, 'Time tool');
  assert.match(src, /applyTypeFilter\(/, 'Type tool');
  assert.match(src, /applySourceMode\(/, 'Source tool (phone / server)');
  assert.ok(src.indexOf("t('sortTime')") < src.indexOf("t('sortType')") && src.indexOf("t('sortType')") < src.indexOf('SOURCE_LABEL[source]'), 'order: Time, Type, then Source at the end of the row');
  assert.doesNotMatch(src, /BlurView/, 'the card is translucent only');
}

console.log('explore ok');
