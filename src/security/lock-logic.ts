import type { AutoLock } from '@/src/state/settings-store';

/** How long the app may stay in the background before it asks again. */
export const AUTO_LOCK_MS: Record<AutoLock, number> = {
  immediate: 0,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
};

/**
 * True when returning to the app must show the lock screen.
 * `backgroundedAt` is when the app left the foreground (ms), null if it did not.
 * A clock that moved backwards locks too (fail safe).
 */
export function shouldLock(input: {
  enabled: boolean;
  backgroundedAt: number | null;
  now: number;
  autoLock: AutoLock;
}): boolean {
  if (!input.enabled || input.backgroundedAt === null) return false;
  const away = input.now - input.backgroundedAt;
  return away < 0 || away >= AUTO_LOCK_MS[input.autoLock];
}
