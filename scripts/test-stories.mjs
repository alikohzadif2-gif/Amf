import assert from 'node:assert/strict';
import { decodeMessage } from '../src/partner/messages.ts';
import * as mod from '../src/stories/story-logic.ts';

const m = mod.isActive ? mod : mod.default;
const { STORY_TTL_MS, expiresAtOf, isActive, timeLeft, clampOverlayY, cleanText, newStoryId, activeStories, clockText, ringState, firstUnseenIndex, msUntilNextExpiry, storyExportName, indexAfterDelete, storyReplyBody } = m;

const t0 = '2026-10-23T10:00:00.000Z';
assert.equal(STORY_TTL_MS, 86400000);
assert.equal(expiresAtOf(t0), '2026-10-24T10:00:00.000Z', 'a story lasts 24 hours');
const t0ms = new Date(t0).getTime();
assert.equal(isActive(expiresAtOf(t0), t0ms + 23 * 3600000), true);
assert.equal(isActive(expiresAtOf(t0), t0ms + 24 * 3600000), false, 'expired exactly at 24 h');
assert.equal(isActive('garbage', t0ms), false);
assert.deepEqual(timeLeft(expiresAtOf(t0), t0ms + 23.5 * 3600000), { unit: 'minutes', n: 30 });
assert.deepEqual(timeLeft(expiresAtOf(t0), t0ms + 1 * 3600000), { unit: 'hours', n: 23 });
assert.deepEqual(timeLeft(expiresAtOf(t0), t0ms + 30 * 3600000), { unit: 'minutes', n: 0 });
assert.equal(clampOverlayY(-3), 0.1);
assert.equal(clampOverlayY(7), 0.9);
assert.equal(clampOverlayY(NaN), 0.5);
assert.equal(cleanText('   ', 10), null);
assert.equal(cleanText('  hello world ', 5), 'hello');
assert.match(newStoryId(1, () => 0.5), /^st[a-z0-9]+$/);
assert.notEqual(newStoryId(5, () => 0.1), newStoryId(5, () => 0.2));
const list = [
  { id: 'b', createdAt: '2026-10-23T09:00:00.000Z', expiresAt: '2026-10-24T09:00:00.000Z' },
  { id: 'old', createdAt: '2026-10-21T09:00:00.000Z', expiresAt: '2026-10-22T09:00:00.000Z' },
  { id: 'a', createdAt: '2026-10-23T08:00:00.000Z', expiresAt: '2026-10-24T08:00:00.000Z' },
];
assert.deepEqual(activeStories(list, t0ms).map((s) => s.id), ['a', 'b'], 'expired dropped, oldest first');
assert.match(clockText(t0), /^\d\d:\d\d$/);

// rings
assert.equal(ringState([], true), 'none');
assert.equal(ringState([{ viewedAt: null }], true), 'unseen', 'my own ring stays coloured');
assert.equal(ringState([{ viewedAt: '2026-10-23T11:00:00.000Z' }], true), 'unseen');
assert.equal(ringState([{ viewedAt: null }, { viewedAt: 'x' }], false), 'unseen', 'one unseen = coloured');
assert.equal(ringState([{ viewedAt: 'x' }, { viewedAt: 'y' }], false), 'seen');
assert.equal(firstUnseenIndex([{ viewedAt: 'x' }, { viewedAt: null }, { viewedAt: null }]), 1);
assert.equal(firstUnseenIndex([{ viewedAt: 'x' }]), 0);
assert.equal(msUntilNextExpiry([], 0), null);
assert.equal(msUntilNextExpiry(list, t0ms), new Date('2026-10-22T09:00:00.000Z').getTime() > t0ms ? 0 : 0);

// phase 6: save name, index after delete, 24 h expiry end to end
assert.equal(storyExportName({ createdAt: t0, mediaUri: 'file:///d/stories/st1.jpg', type: 'photo' }), 'story-20261023-100000.jpg');
assert.equal(storyExportName({ createdAt: t0, mediaUri: 'file:///d/stories/st1.MP4?x=1', type: 'video' }), 'story-20261023-100000.mp4');
assert.equal(storyExportName({ createdAt: 'bad', mediaUri: 'file:///d/noext', type: 'video' }), 'story-story.mp4');
assert.equal(indexAfterDelete(1, 0), null, 'last story deleted: leave the viewer');
assert.equal(indexAfterDelete(3, 2), 1, 'deleting the last of several shows the new last one');
assert.equal(indexAfterDelete(3, 0), 0, 'deleting the first shows the next (now first)');
assert.equal(indexAfterDelete(3, 1), 1);
const mineStory = { id: 'm', createdAt: t0, expiresAt: expiresAtOf(t0), viewedAt: null };
assert.equal(activeStories([mineStory], t0ms + 24 * 3600000 - 1).length, 1, 'still there 1 ms before 24 h');
assert.equal(activeStories([mineStory], t0ms + 24 * 3600000).length, 0, 'gone at 24 h');
assert.equal(ringState(activeStories([mineStory], t0ms + 24 * 3600000), true), 'none', 'ring disappears when the story expires');

// protocol: decode of the new message types

const dec = decodeMessage;
if (dec) {
  const base = { from: 'dev1', ts: t0, silent: true };
  const story = dec(JSON.stringify({ ...base, t: 'story', id: 's1', type: 'video', media: 'Shared/s1/story.mp4', overlayText: 'hi', overlayY: 0.3, caption: 'c', date: t0 }));
  assert.equal(story.t, 'story');
  assert.equal(story.type, 'video');
  assert.equal(story.media, 'Shared/s1/story.mp4');
  assert.equal(story.overlayY, 0.3);
  assert.equal(dec(JSON.stringify({ ...base, t: 'story', id: 's1', type: 'photo', media: '../etc/passwd' })), null, 'path must be inside Shared/');
  assert.equal(dec(JSON.stringify({ ...base, t: 'story', id: 's1', type: 'photo' })), null, 'media is required');
  assert.equal(dec(JSON.stringify({ ...base, t: 'story', id: 's1', type: 'photo', deleted: true })).deleted, true);
  assert.equal(dec(JSON.stringify({ ...base, t: 'story-seen', id: 's1' })).t, 'story-seen');
  assert.equal(dec(JSON.stringify({ ...base, t: 'story-seen', id: '' })), null);
}
// Replying to the partner's story: goes to Direct as a text with a marker line; no input box in my own viewer.
assert.equal(storyReplyBody('↩ Reply', '   ', 2000), null, 'a blank reply is not sent');
assert.equal(storyReplyBody('↩ Reply', ' hi ', 2000), '↩ Reply\nhi');
assert.equal(storyReplyBody('↩ Reply', 'x'.repeat(5000), 2000).length, 2000, 'never longer than the chat limit');
{
  const { readFileSync } = await import('node:fs');
  const view = readFileSync(new URL('../app/story/view.tsx', import.meta.url), 'utf8');
  assert.match(view, /\{!mine \? \(\s*<View style=\{\[styles\.replyBar/, 'the reply box is only on the partner story');
  assert.match(view, /sendChat\(db, body\)/, 'a story reply is sent through the direct chat');
  assert.match(view, /halted = paused \|\| menuOpen \|\| typing/, 'the story waits while a reply is typed');
}
console.log('stories ok');
