/**
 * Shared gallery, stage 3: which small pictures to ask the partner's phone for, and when. Pure (the clock and the sender are injected), tested in Node.
 *
 * The screen tells the scheduler which files are on screen NOW (`setWanted`, top to bottom). Rules:
 *  - at most `maxInFlight` files are asked for at once (a folder of 3000 files never floods the queue or the partner's phone);
 *  - requests go out in screen order, in groups of up to `batch` ids;
 *  - a file that scrolled away before its request went out is dropped (fast scrolling never queues what nobody sees);
 *    a file already asked for stays asked (its answer is on the way and is kept);
 *  - no answer within `timeoutMs` = asked again, up to `maxTries` times in all, then `failed` (the tile keeps its placeholder; a new
 *    `setWanted` after `retryAfterMs` may try again);
 *  - a file whose picture is already on this phone is never asked for (`has`).
 */
export type ThumbSchedulerOptions = {
  /** Asks the partner's phone for these ids (one message). A throw counts as a failed try. */
  send: (ids: string[]) => Promise<void>;
  /** True when this phone already holds the file's small picture. */
  has: (id: string) => boolean;
  maxInFlight?: number;
  batch?: number;
  timeoutMs?: number;
  maxTries?: number;
  retryAfterMs?: number;
  now?: () => number;
};

type Entry = { tries: number; askedAt: number; failedAt: number };

export function createThumbScheduler(options: ThumbSchedulerOptions) {
  const maxInFlight = options.maxInFlight ?? 8;
  const batch = Math.min(options.batch ?? 4, 8);
  const timeoutMs = options.timeoutMs ?? 25_000;
  const maxTries = options.maxTries ?? 2;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;

  let wanted: string[] = [];
  const inFlight = new Map<string, Entry>();
  const failed = new Map<string, Entry>();
  const tries = new Map<string, number>();
  /** Files whose picture arrived: never asked for again (until a tap on the tile says it is missing). */
  const done = new Set<string>();

  function pump(): void {
    const t = now();
    // timeouts first: a silent file is asked again or given up
    for (const [id, entry] of [...inFlight]) {
      if (t - entry.askedAt < timeoutMs) continue;
      inFlight.delete(id);
      if (entry.tries >= maxTries) failed.set(id, { ...entry, failedAt: t });
    }
    const room = maxInFlight - inFlight.size;
    if (room <= 0) return;
    const next: string[] = [];
    for (const id of wanted) {
      if (next.length >= room) break;
      if (inFlight.has(id) || done.has(id) || options.has(id)) continue;
      const lost = failed.get(id);
      if (lost) {
        if (t - lost.failedAt < retryAfterMs) continue;
        failed.delete(id);
        tries.delete(id);
      }
      next.push(id);
    }
    for (let i = 0; i < next.length; i += batch) {
      const ids = next.slice(i, i + batch);
      for (const id of ids) {
        const n = (tries.get(id) ?? 0) + 1;
        tries.set(id, n);
        inFlight.set(id, { tries: n, askedAt: t, failedAt: 0 });
      }
      void options.send(ids).catch(() => {
        // the post did not go: these ids may be asked again at once on the next pump (a try was used)
        for (const id of ids) {
          const entry = inFlight.get(id);
          if (!entry) continue;
          inFlight.delete(id);
          if (entry.tries >= maxTries) failed.set(id, { ...entry, failedAt: now() });
        }
      });
    }
  }

  return {
    /** The files on screen now, top to bottom. Replaces the previous list. */
    setWanted(ids: readonly string[]): void {
      wanted = [...new Set(ids)];
      pump();
    },
    /** A picture arrived for this id (or the screen found it on the phone): its slot is free. */
    arrived(id: string): void {
      done.add(id);
      inFlight.delete(id);
      failed.delete(id);
      tries.delete(id);
      pump();
    },
    /** Call now and then (a timer on the screen) so silent files time out and the next ones go. */
    tick(): void {
      pump();
    },
    /** Ask again right now for a file that failed (a tap on its tile). */
    retry(id: string): void {
      done.delete(id);
      failed.delete(id);
      tries.delete(id);
      pump();
    },
    state(id: string): 'inflight' | 'failed' | 'idle' {
      return inFlight.has(id) ? 'inflight' : failed.has(id) ? 'failed' : 'idle';
    },
    get inFlightCount(): number {
      return inFlight.size;
    },
    reset(): void {
      wanted = [];
      inFlight.clear();
      failed.clear();
      tries.clear();
      done.clear();
    },
  };
}
