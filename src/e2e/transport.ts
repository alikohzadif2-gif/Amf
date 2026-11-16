import { blobToText, openEnvelope, sealEnvelope, textToBlob } from './envelope';
import type { DirectionKeys, Sodium } from './crypto';
import type { KvStore } from './key-store';

/**
 * Encrypted transport of the app's partner messages (sharing track, stage 3). Pure logic with injected
 * dependencies (no React Native imports), so the test suite runs it with libsodium-wrappers.
 * The messages themselves are unchanged (`PartnerMessage`, src/partner/types.ts); only their carrier changed:
 * they are sealed with the sender's key and travel as opaque blobs through the server's `/e2e/queue`.
 */

/**
 * Should the partner's phone be woken with a visible, generic notification ("something new from your partner")?
 * The same rule the server applied to plain messages (server `pushHint`): moods, events, memories, period updates and chat
 * texts do; a clear, a delete, `silent`, profile, unpair, stories, likes, comments and "seen" marks do not.
 * It is the only thing about a message the server learns (one bit, sent as `wake`).
 */
export function shouldWake(m: Record<string, unknown>): boolean {
  if (m.silent === true || m.cleared === true || m.deleted === true) return false;
  if (m.t === 'period') return m.kind === 'started' || m.kind === 'pain' || m.kind === 'better';
  return m.t === 'mood' || m.t === 'event' || m.t === 'diary' || m.t === 'chat';
}

export type QueueApi = {
  e2ePost(id: string, blob: string, wake: boolean): Promise<{ seq: number; time: string; duplicate?: true }>;
  e2eAck(seqs: number[]): Promise<{ deleted: number }>;
};

export type KeyProvider = () => Promise<DirectionKeys | null>;

export class E2eNotReadyError extends Error {
  constructor() {
    super('E2E keys are not confirmed on this phone');
    this.name = 'E2eNotReadyError';
  }
}

/** Seals one message and posts it. Returns the envelope id. Throws `E2eNotReadyError` without keys; network errors are the client's own. Never sends plaintext. */
export async function sendEncrypted(deps: { sodium: Sodium; keys: KeyProvider; client: Pick<QueueApi, 'e2ePost'> }, message: Record<string, unknown>): Promise<string> {
  const keys = await deps.keys();
  if (!keys) throw new E2eNotReadyError();
  const { id, blob } = sealEnvelope(deps.sodium, keys.send, message);
  await deps.client.e2ePost(id, blobToText(blob), shouldWake(message));
  return id;
}

/** Ids of the newest blobs already applied, kept on the phone so a replay (the server resends, a lost ACK) is not applied twice. */
export function createSeenStore(kv: KvStore, key = 'meyou-e2e-seen-v1', limit = 1000) {
  let ids: string[] | null = null;
  const load = async (): Promise<string[]> => {
    if (ids) return ids;
    try {
      const parsed = JSON.parse((await kv.get(key)) ?? '[]') as unknown;
      ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(-limit) : [];
    } catch {
      ids = [];
    }
    return ids;
  };
  return {
    async has(id: string): Promise<boolean> {
      return (await load()).includes(id);
    },
    async add(id: string): Promise<void> {
      const list = await load();
      if (list.includes(id)) return;
      list.push(id);
      if (list.length > limit) list.splice(0, list.length - limit);
      await kv.set(key, JSON.stringify(list));
    },
    async clear(): Promise<void> {
      ids = [];
      await kv.remove(key);
    },
  };
}
export type SeenStore = ReturnType<typeof createSeenStore>;

/**
 * File chunks (`orig-chunk`) are not recorded in the seen list. A video is thousands of chunks: recording each would push the real
 * messages out of the 1000-id list (a replay window for the server) and rewrite the whole list thousands of times. A replayed chunk is
 * harmless anyway: `receiveOrig` ignores a chunk it already has, and one for a finished or unknown transfer.
 */
export const isTransientMessage = (message: Record<string, unknown>): boolean => message.t === 'orig-chunk';

export type ReceiveResult = 'applied' | 'duplicate' | 'invalid';

/**
 * One blob from the queue. Order matters: decrypt -> apply to the app -> remember the id -> ACK (the server then deletes it).
 * - Not decryptable (changed, wrong key, junk): ACKed and dropped, because it can never be read and must not block the queue.
 * - `apply` throws: nothing is ACKed, so the blob comes again at the next sync.
 * - A failed ACK is harmless: the blob comes again and is recognised as a duplicate.
 */
export async function receiveEncrypted(
  deps: {
    sodium: Sodium;
    keys: KeyProvider;
    seen: SeenStore;
    client: Pick<QueueApi, 'e2eAck'>;
    /** Hands the decrypted message to the app's inbox; `id` is stable per message (`e:<envelope id>`), like the mailbox seq before. */
    apply: (raw: { id: string; message: string }) => Promise<unknown>;
  },
  incoming: { seq: number; body: Record<string, unknown> },
): Promise<ReceiveResult> {
  const keys = await deps.keys();
  if (!keys) throw new E2eNotReadyError();
  const ack = async () => {
    try {
      await deps.client.e2eAck([incoming.seq]);
    } catch {
      // comes again; recognised as a duplicate
    }
  };
  const text = incoming.body.blob;
  const blob = typeof text === 'string' ? textToBlob(text) : null;
  const opened = blob ? openEnvelope(deps.sodium, keys.recv, blob) : null;
  if (!opened) {
    await ack();
    return 'invalid';
  }
  const transient = isTransientMessage(opened.message);
  if (!transient && (await deps.seen.has(opened.id))) {
    await ack();
    return 'duplicate';
  }
  await deps.apply({ id: `e:${opened.id}`, message: JSON.stringify(opened.message) });
  if (!transient) await deps.seen.add(opened.id);
  await ack();
  return 'applied';
}
