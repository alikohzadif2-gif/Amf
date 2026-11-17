import { parseDigestPage, parseEvent, type DigestPage, type SyncEvent } from './sync-logic';

/**
 * Sync messages (stage 7), data only (silent, never a notification):
 *   sync-ev      {events}  up to 50 validated events (add / rename / move / del-both / have)
 *   sync-digest  {page}    one page of the full-list comparison; the receiver answers with sync-ev for what the sender lacks
 * A digest is never answered with a digest, so two phones cannot loop.
 */
export const SYNC_MAX_EVENTS = 50;
type Head = { from: string; ts: string; silent: true };
export type SyncEventsMessage = Head & { t: 'sync-ev'; events: SyncEvent[] };
export type SyncDigestMessage = Head & { t: 'sync-digest'; page: DigestPage };
export type SyncMessage = SyncEventsMessage | SyncDigestMessage;

/** Undefined when `d.t` is not a sync message, null when it is one but invalid. */
export function decodeSync(d: Record<string, unknown>, base: { from: string; ts: string }): SyncMessage | null | undefined {
  if (d.t !== 'sync-ev' && d.t !== 'sync-digest') return undefined;
  const head = { ...base, silent: true as const };
  if (d.t === 'sync-ev') {
    if (!Array.isArray(d.events) || d.events.length < 1 || d.events.length > SYNC_MAX_EVENTS) return null;
    const events: SyncEvent[] = [];
    for (const raw of d.events) {
      const ev = parseEvent(raw);
      if (!ev) return null; // one bad event rejects the whole message: a partner phone that sends one is not trusted further
      events.push(ev);
    }
    return { ...head, t: 'sync-ev', events };
  }
  const page = parseDigestPage(d.page);
  return page ? { ...head, t: 'sync-digest', page } : null;
}
