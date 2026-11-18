// Silent (data-only) wake-up pushes per recipient device are coalesced: a video is thousands of blobs, and one push per blob would flood
// the push service (which throttles senders) for no gain, since a woken or connected phone drains the whole queue in one go.
//   - The first silent push goes out at once.
//   - Further ones inside `gapMs` do not; ONE trailing push is scheduled for the end of the gap, so a blob that arrived after the phone
//     finished syncing is still announced. The trailing push names the newest seq.
// Visible pushes ("wake") are never coalesced.
export interface Coalescer {
  /** Returns true when the caller should push now; otherwise a trailing push is (already) scheduled. */
  silent(deviceId: string, seq: number, send: (seq: number) => void): boolean;
  stop(): void;
}

export function createSilentPushCoalescer(gapMs: number, now: () => number = Date.now, timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clear: (t) => clearTimeout(t as NodeJS.Timeout) }): Coalescer {
  const lastAt = new Map<string, number>();
  const trailing = new Map<string, { timer: unknown; seq: number; send: (seq: number) => void }>();
  return {
    silent(deviceId, seq, send) {
      const at = now();
      const last = lastAt.get(deviceId);
      const waiting = trailing.get(deviceId);
      if (waiting) {
        waiting.seq = Math.max(waiting.seq, seq); // already scheduled: only remember the newest
        waiting.send = send;
        return false;
      }
      if (last === undefined || at - last >= gapMs) {
        lastAt.set(deviceId, at);
        return true;
      }
      const entry = { timer: undefined as unknown, seq, send };
      entry.timer = timers.set(() => {
        trailing.delete(deviceId);
        lastAt.set(deviceId, now());
        entry.send(entry.seq);
      }, gapMs - (at - last));
      trailing.set(deviceId, entry);
      return false;
    },
    stop() {
      for (const t of trailing.values()) timers.clear(t.timer);
      trailing.clear();
      lastAt.clear();
    },
  };
}
