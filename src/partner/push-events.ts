/**
 * Push events (S10, part 2): what the app does when an FCM message arrives or a notification is tapped.
 * Pure logic with injected dependencies (no React Native imports) so it runs in the test suite;
 * the native listeners live in push-native.ts and the wiring in manage.ts / PartnerListener.
 *
 * The server's data is only `{ type, seq }` (API_CONTRACT D.11). The content always comes from the mailbox.
 */

export type PushType = 'mood' | 'event' | 'diary' | 'period' | 'profile' | 'unpair' | 'story' | 'story-seen' | 'chat' | 'chat-seen' | 'e2e' | 'test';
export type PushData = { type: PushType; seq: string };

const TYPES: readonly string[] = ['mood', 'event', 'diary', 'period', 'profile', 'unpair', 'chat', 'e2e', 'test'];

/** Reads the data of a received notification. Anything that is not exactly the server's shape is null. */
export function parsePushData(data: unknown): PushData | null {
  if (!data || typeof data !== 'object') return null;
  const { type, seq } = data as { type?: unknown; seq?: unknown };
  if (typeof type !== 'string' || !TYPES.includes(type)) return null;
  // The server sends seq as a string; a number is tolerated, anything else is not a push of ours.
  const text = typeof seq === 'number' && Number.isSafeInteger(seq) ? String(seq) : seq;
  if (typeof text !== 'string' || !/^\d{1,15}$/.test(text)) return null;
  return { type: type as PushType, seq: text };
}

export type ForegroundDecision = { show: boolean; sync: boolean };

/**
 * App is open when a notification arrives.
 * - Not ours (no push data): it is a local notification of the app itself: show it.
 * - `test` (CLI push-test): show it as it is, nothing to sync.
 * - `mood` / `event` / `diary` / `period`: do not let the system show the generic text. The message is fetched into the app, and the
 *   app's own notification is shown once (see shouldNotifyLocal), so there is exactly one.
 * - `profile` / `unpair`: data only. Sync, show nothing.
 */
export function foregroundDecision(data: PushData | null): ForegroundDecision {
  if (!data || data.type === 'test') return { show: true, sync: false };
  return { show: false, sync: true };
}

export type LocalNotifyInput = {
  kind: 'mood' | 'event' | 'diary' | 'period' | 'chat' | 'unpair';
  /** `replay` = fetched over HTTP when the listener starts; `live` = arrived on the open WebSocket. */
  source: 'replay' | 'live';
  /** The server accepted this phone's FCM token, so it sends a system notification for mood/event. */
  pushRegistered: boolean;
  /** True when the open app received this message's push itself and kept the system from showing it. */
  heldByForegroundHandler: boolean;
};

/**
 * Should the app show its own notification for a stored message?
 * The server pushes every mood/event to a registered phone, so a message that is only found by a replay
 * (app was closed or in the background) was already shown by the system: no second one.
 * Local notifications stay for: live messages, a phone without a working push (no permission, no token,
 * server without a key, registration failed), pushes the open app held back, and `unpair`
 * (the server sends that one data-only, so the system never shows anything for it).
 */
export function shouldNotifyLocal(input: LocalNotifyInput): boolean {
  if (input.kind === 'unpair') return true;
  if (input.source === 'live') return true;
  if (input.heldByForegroundHandler) return true;
  return !input.pushRegistered;
}

/** Small remember-the-last-N set, so a long-running app cannot grow without bound. */
function boundedSet(limit: number) {
  const items = new Set<string>();
  return {
    has: (key: string) => items.has(key),
    /** Returns true when the key was new. */
    add(key: string): boolean {
      if (items.has(key)) return false;
      items.add(key);
      if (items.size > limit) items.delete(items.values().next().value as string);
      return true;
    },
  };
}

export type PushRouterDeps = {
  /** Fetch the mailbox now (replay). Must not throw; may be a no-op when the listener is not ready yet. */
  sync: () => void;
};

/**
 * Remembers what the open app already saw and turns notification events into one sync each.
 * The same push can reach both the notification handler and the received listener, and the same tap is
 * reported again by getLastNotificationResponseAsync after a remount: every event runs at most once.
 */
export function createPushRouter(deps: PushRouterDeps) {
  const held = boundedSet(200);
  const seen = boundedSet(200);
  const taps = boundedSet(50);
  return {
    /** A push arrived while the app is open. */
    onPush(data: PushData): void {
      if (data.type === 'test') return;
      if (data.type === 'mood' || data.type === 'event' || data.type === 'diary' || data.type === 'period' || data.type === 'chat') held.add(data.seq);
      // Stage 3: the encrypted queue has its own seq numbers; `e2e:<seq>` is the arrival id manage.ts uses for it.
      if (data.type === 'e2e') held.add(`e2e:${data.seq}`);
      if (seen.add(`${data.type}:${data.seq}`)) deps.sync();
    },
    /** The person tapped a notification (also called once at a cold start with the last response). */
    onTap(id: string): void {
      if (taps.add(id)) deps.sync();
    },
    /** True when onPush saw this seq as a visible type (mood/event/diary/period): the system did not show it. */
    wasHeld: (seq: string) => held.has(seq),
  };
}

/** Resolves with the promise's value, or `fallback` after `ms`; never rejects. */
export async function settleWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
