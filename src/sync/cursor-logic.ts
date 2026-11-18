/**
 * Stage 2D: when is a full list comparison (the sync digest) needed? Pure logic, no React Native imports.
 *
 * Normal case: the phone keeps the last acknowledged queue cursor (`lastE2eSeq`) and, after opening, only fetches what is newer
 * (HTTP replay `since=<cursor>`, then the WebSocket). No digest.
 * The digest is only a repair, and only in these cases:
 *  - first pairing (`repairPending` is set by `setPaired`),
 *  - lost state (the phone has no record of ever talking to the queue, e.g. wiped storage, or the first start after this update),
 *  - stale (no contact with the queue for more than 30 days: the server queue may have pruned what the partner sent).
 * A repair stays `repairPending` until a digest was really sent, so an attempt that fails offline is retried at the next start.
 */
export const STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** Writing `lastContactAt` on every message would rewrite the persisted store thousands of times; once an hour is plenty against a 30 day limit. */
export const CONTACT_THROTTLE_MS = 60 * 60 * 1000;

export type RepairReason = 'first-pair' | 'lost-state' | 'stale';

export type RepairInput = {
  paired: boolean;
  /** A repair was requested earlier and has not completed yet. */
  repairPending: boolean;
  /** Unix ms of the last successful contact with the queue (replay or socket); 0 = never recorded. */
  lastContactAt: number;
};

export function repairReason(input: RepairInput, now: number): RepairReason | null {
  if (!input.paired) return null;
  if (input.repairPending) return 'first-pair';
  if (!(input.lastContactAt > 0)) return 'lost-state';
  // A clock set back makes `now - last` negative: that is not "stale".
  if (now - input.lastContactAt > STALE_MS) return 'stale';
  return null;
}

/** True when `lastContactAt` should be rewritten now (never recorded, clock moved back, or the throttle window passed). */
export function shouldRecordContact(lastContactAt: number, now: number): boolean {
  return !(lastContactAt > 0) || now < lastContactAt || now - lastContactAt >= CONTACT_THROTTLE_MS;
}
