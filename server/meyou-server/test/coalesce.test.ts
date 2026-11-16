import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilentPushCoalescer } from '../src/e2e/coalesce.js';

function fake() {
  let t = 0;
  const jobs: { at: number; fn: () => void; id: number; live: boolean }[] = [];
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      for (const j of jobs.filter((x) => x.live && x.at <= t)) {
        j.live = false;
        j.fn();
      }
    },
    timers: { set: (fn: () => void, ms: number) => { const j = { at: t + ms, fn, id: jobs.length, live: true }; jobs.push(j); return j; }, clear: (j: unknown) => { (j as { live: boolean }).live = false; } },
  };
}

test('first silent push goes at once, the burst is coalesced, one trailing push names the newest seq', () => {
  const f = fake();
  const c = createSilentPushCoalescer(10_000, f.now, f.timers);
  const sent: number[] = [];
  const send = (seq: number) => void sent.push(seq);
  assert.equal(c.silent('dev', 1, send), true);
  for (let seq = 2; seq <= 500; seq += 1) assert.equal(c.silent('dev', seq, send), false);
  assert.deepEqual(sent, []);
  f.advance(9_999);
  assert.deepEqual(sent, []);
  f.advance(1);
  assert.deepEqual(sent, [500], 'one trailing push for the newest blob');
  // after the trailing push the gap starts again
  assert.equal(c.silent('dev', 501, send), false);
  f.advance(10_000);
  assert.deepEqual(sent, [500, 501]);
  // a quiet period resets: the next one is immediate
  f.advance(60_000);
  assert.equal(c.silent('dev', 502, send), true);
  c.stop();
});

test('devices are independent and stop() cancels the trailing push', () => {
  const f = fake();
  const c = createSilentPushCoalescer(10_000, f.now, f.timers);
  const sent: string[] = [];
  assert.equal(c.silent('a', 1, () => void sent.push('a')), true);
  assert.equal(c.silent('b', 2, () => void sent.push('b')), true);
  assert.equal(c.silent('a', 3, () => void sent.push('a')), false);
  c.stop();
  f.advance(20_000);
  assert.deepEqual(sent, []);
});
