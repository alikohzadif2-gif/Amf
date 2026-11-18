import type { MediaMessage } from './media-logic';

/**
 * Sender side of the encrypted pictures (stage 4). Pure logic with injected dependencies (no React Native imports).
 * Order for one new photo: thumbnail first (a failure is the caller's failure: nothing half-sent is reported as sent),
 * then the preview at once (no network-type condition since stage 4: cellular is fine), and only when that post fails does it wait in the outbox for the next flush.
 */
export type OutboxEntry = { ref: string; queuedAt: number; message: MediaMessage };

export interface Outbox {
  put(entry: OutboxEntry): Promise<void>;
  list(): Promise<OutboxEntry[]>;
  remove(ref: string): Promise<void>;
}

export type SendDeps = {
  /** Seals and posts one message (publishPartner); throws when it could not be posted. */
  send: (message: MediaMessage) => Promise<void>;
  outbox: Outbox;
  now: () => number;
};

/** A preview that has waited this long is dropped: the partner has the thumbnail, and the full quality can still be asked for. */
export const OUTBOX_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export type SendOutcome = { thumb: 'sent'; preview: 'sent' | 'queued' | 'skipped' };

export async function sendVariants(deps: SendDeps, parts: { thumb: MediaMessage; preview: MediaMessage | null }): Promise<SendOutcome> {
  await deps.send(parts.thumb); // throws: the caller treats the share as failed
  if (!parts.preview) return { thumb: 'sent', preview: 'skipped' };
  try {
    await deps.send(parts.preview);
    return { thumb: 'sent', preview: 'sent' };
  } catch {
    // the network failed after the thumbnail went: keep the preview for the next flush
  }
  await deps.outbox.put({ ref: parts.preview.ref, queuedAt: deps.now(), message: parts.preview });
  return { thumb: 'sent', preview: 'queued' };
}

/** Sends what waits in the outbox. Returns how many were sent. Never throws. */
export async function flushOutbox(deps: SendDeps): Promise<number> {
  let sent = 0;
  let entries: OutboxEntry[];
  try {
    entries = await deps.outbox.list();
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;
  const old = entries.filter((entry) => deps.now() - entry.queuedAt > OUTBOX_MAX_AGE_MS);
  for (const entry of old) await deps.outbox.remove(entry.ref).catch(() => undefined);
  const fresh = entries.filter((entry) => !old.includes(entry));
  if (fresh.length === 0) return 0;
  for (const entry of fresh) {
    try {
      await deps.send(entry.message);
      await deps.outbox.remove(entry.ref);
      sent += 1;
    } catch {
      break; // offline again: try at the next flush
    }
  }
  return sent;
}
