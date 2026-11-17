import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import { Alert, AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { applyDiaryMessage, buildDiaryMessage, buildReplyMessage } from '@/src/diary/diary-share';
import type { DiaryRow } from '@/src/diary/diary-db';
import { addChat, getChat, markChatRead, markChatSeenUpTo, setChatFailed, type ChatMediaType } from '@/src/chat/chat-db';
import { addComment, applyCommentMessage, applyLikeMessage, deleteComment, setLike } from '@/src/library/reactions-db';
import { applyEventMessage, buildEventMessage, type EventRow } from '@/src/events/events-db';
import { e2ePairing } from '@/src/e2e';
import { nativeSodium } from '@/src/e2e/sodium';
import { createSeenStore, receiveEncrypted, sendEncrypted } from '@/src/e2e/transport';
import type { KvStore } from '@/src/e2e/key-store';
import { traceEvent } from '@/src/diagnostics/log';
import { getDictionary } from '@/src/i18n';
import { isValidStartDay } from '@/src/period/cycle';
import { applyPeriodMessage, buildPeriodMessage, insertPeriodEvent, logPeriodLocal } from '@/src/period/period-db';
import { openFileReader } from '@/src/server/file-reader';
import { secureTokenStore } from '@/src/server/token-store';
import type { ImageRef } from '@/src/storage/types';
import { refreshWidget } from '@/src/widget/refresh';
import { useServersStore } from '@/src/state/servers-store';
import { usePartnerStore } from '@/src/state/partner-store';
import { usePushStore } from '@/src/state/push-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { handleIncoming, type InboxDeps } from './inbox';
import { applyStoryMessage, applyStorySeen } from '@/src/stories/stories-db';
import type { StoryRow } from '@/src/stories/story-logic';
import type { StoryMessage, StorySeenMessage } from './types';
import { encodeMessage, MAX_CHAT, MAX_NOTE } from './messages';
import { clearMoodLocal, insertMood } from './mood-db';
import {
  isMailboxError,
  joinMailbox,
  MailboxClient,
  MailboxListener,
  type MailboxConnection,
  type MailboxSource,
  type MailboxMe,
} from './mailbox-client';
import { showLocal, type ShowResult } from './notify';
import { isUnmetered } from '@/src/lib/network';
import { buildMediaMessage, isImageName, type MediaMessage } from './media-logic';
import { makeVariant, makeVideoPoster } from './media-make';
import { fileOutbox, resetOutboxIndex } from './media-outbox';
import { flushOutbox, sendVariants, type SendDeps } from './media-send';
import { clearAllPartnerMedia, copyPartnerOriginal, getPartnerMedia, partnerOriginalState, removePartnerMedia, removePartnerOriginal, storePartnerMedia } from './media-store';
import { repairReason, shouldRecordContact } from '../sync/cursor-logic';
import { applyEvent, deleteForBoth, deleteForMe, digestPages, itemByRef, onBothPhones, reconcile, refsAffected, tick, type SyncEvent, type SyncItem } from '../sync/sync-logic';
import { SYNC_MAX_EVENTS, type SyncMessage } from '../sync/sync-messages';
import { smallCopy } from '@/src/media/small-copy';
import { hashSource } from '../sync/sha256';
import { clearSyncState, loadSyncState, saveSyncState } from '../sync/sync-store';
import { ORIG_CHUNK_BYTES, ORIG_WINDOW_CHUNKS, createOriginalWaiter, withRetry, isFreshRequest, isVideoName, receiveOrig, serveOriginal, type OrigMessage, type OriginalOutcome } from './orig-logic';
import { clearAllOriginals, cleanStaleTransfers, findTransferByRef, forgetSharedOriginals, freeDiskBytes, lookupSharedOriginal, partSize, sharedOriginalUri, partStore, recordSharedOriginal, rekeyTransfer, transferStore } from './orig-store';
import { sharedFileName, sharedFolder, splitSharedPath } from './media-ref';
import { registerPush, unregisterPush, type PushState } from './push';
import { createPushRouter, shouldNotifyLocal } from './push-events';
import { ensurePushChannel, nativePermission, nativeToken } from './push-native';
import type { PartnerMessage, ChatMessage, ChatSeenMessage, CommentMessage, LikeMessage, DiaryMessage, EventMessage, MoodClearedMessage, MoodIntensity, MoodMessage, PeriodKind, PeriodMessage, ProfileMessage } from './types';

const PARTNER_TOKEN_KEY = 'partner-mailbox';
const store = () => usePartnerStore.getState();
const nowIso = () => new Date().toISOString();
const unixNow = () => Math.floor(Date.now() / 1000);

type PendingInvite = {
  connection: MailboxConnection;
  deviceId: string;
  serverName: string;
  link: string;
  expiresAt: string;
};
let pendingInvite: PendingInvite | null = null;
/** Follows the encrypted queue (`/e2e/ws`): the only channel between the two phones. */
let e2eListener: MailboxListener | null = null;
let starting = false;

export function getDeviceId(): string {
  if (!store().deviceId) {
    const bytes = getRandomBytes(8);
    store().setDeviceId(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  return store().deviceId;
}

async function readConn(): Promise<MailboxConnection | null> {
  const { paired, serverUrl } = store();
  if (!paired || !serverUrl) return null;
  const token = await secureTokenStore.get(PARTNER_TOKEN_KEY);
  return token ? { url: serverUrl, token } : null;
}

/** Plain AsyncStorage (not secret): the ids of encrypted messages already applied. */
const asyncKv: KvStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};
const e2eSeen = createSeenStore(asyncKv);
const e2eKeys = () => e2ePairing().getKeys();

/** Thrown when something must go to the partner but this phone has no confirmed E2E keys (not paired in person yet). */
export class NoKeysError extends Error {
  constructor() {
    super('no e2e keys');
    this.name = 'NoKeysError';
  }
}
let lastNoKeysNotice = 0;
/** "Pair securely first" (fa/en). Shown at most once every 4 seconds, so a send that makes several messages does not stack dialogs. */
function noKeysNotice(): void {
  const now = Date.now();
  if (now - lastNoKeysNotice < 4000) return;
  lastNoKeysNotice = now;
  const dict = getDictionary(useSettingsStore.getState().language);
  try {
    Alert.alert(dict.needSecurePairing);
  } catch {
    // no UI (a background run): the caller still gets the failure
  }
}

/**
 * The one way every partner message leaves this phone. It is sealed with the confirmed E2E keys and goes through the encrypted
 * queue only. A failure is a failure (the caller's retry rules apply); there is NO plain path and no fallback. Without keys
 * (not paired in person yet) it throws `NoKeysError` after telling the person to pair securely first; local work is unaffected.
 * `msgId` is the id this phone stores for its own mood / period rows (`e:<envelope id>`).
 */
async function publishPartner(connection: MailboxConnection, message: PartnerMessage): Promise<{ msgId: string }> {
  if (!(await e2eKeys())) {
    noKeysNotice();
    throw new NoKeysError();
  }
  const client = new MailboxClient(connection);
  const id = await sendEncrypted({ sodium: nativeSodium, keys: e2eKeys, client }, message as unknown as Record<string, unknown>);
  return { msgId: `e:${id}` };
}

/** Stage 6: every original-file message is sealed and sent through the encrypted queue only; there is no plain fallback for a file. */
async function postOrig(message: OrigMessage, known?: NonNullable<Awaited<ReturnType<typeof readConn>>>): Promise<void> {
  const connection = known ?? (await readConn());
  if (!connection) throw new Error('not paired');
  await sendEncrypted({ sodium: nativeSodium, keys: e2eKeys, client: new MailboxClient(connection) }, message as unknown as Record<string, unknown>);
}

const originalWaiter = createOriginalWaiter();
/** Requests the partner cancelled while this phone was serving them. */
const cancelledOriginals = new Set<string>();
/** One original is served at a time (a later request waits its turn). */
let originalServing: Promise<void> = Promise.resolve();

/** Previews are made one at a time (decoding a photo is heavy). */
let previewServing: Promise<void> = Promise.resolve();
/** Receiver: when a preview of a shared picture was asked for last, so a screen that redraws does not ask again and again. */
const previewAsked = new Map<string, number>();
const PREVIEW_ASK_AGAIN_MS = 10 * 60 * 1000;

/**
 * Asks the partner's phone for the preview of a picture that is on screen and only has its thumbnail here. Respects the
 * "previews on Wi-Fi only" setting. The answer arrives as an ordinary `media` message and the screens look again (media version).
 * Best effort, never throws.
 */
async function askPreview(path: string): Promise<void> {
  try {
    if (isVideoName(path) || !store().paired) return;
    const last = previewAsked.get(path);
    if (last !== undefined && Date.now() - last < PREVIEW_ASK_AGAIN_MS) return;
    if (useSettingsStore.getState().sharePreviewWifiOnly && !(await isUnmetered())) return;
    if (!(await e2eKeys())) return;
    if (previewAsked.size > 500) previewAsked.clear();
    previewAsked.set(path, Date.now());
    const rid = Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
    await postOrig({ ...origHead(rid), t: 'orig-preview-req', ref: path }).catch(() => previewAsked.delete(path));
  } catch {
    previewAsked.delete(path);
  }
}

const origHead = (rid: string) => ({ from: getDeviceId(), ts: nowIso(), silent: true as const, rid });

async function handleOriginalMessage(db: SQLiteDatabase, message: OrigMessage): Promise<void> {
  switch (message.t) {
    case 'orig-cancel':
      if (cancelledOriginals.size > 100) cancelledOriginals.clear();
      cancelledOriginals.add(message.rid);
      return;
    case 'orig-req': {
      if (!isFreshRequest(message.ts, Date.now())) return; // an old tap that waited in the queue: never start a big transfer late
      const { rid, ref, start, count } = message;
      originalServing = originalServing
        .then(async () => {
          if (!(await e2eKeys())) return;
          const connection = await readConn(); // read once for the whole transfer, not once per chunk
          if (!connection) return;
          await serveOriginal(
            // each post is retried a few times (a rate limit or a network blip must not end a long transfer)
            { lookup: (r) => lookupSharedOriginal(db, r), send: (m) => withRetry(() => postOrig(m, connection)), cancelled: (id) => cancelledOriginals.has(id), from: getDeviceId(), nowIso },
            { rid, ref, start, count },
          );
        })
        .catch(() => undefined)
        .finally(() => cancelledOriginals.delete(rid));
      return;
    }
    case 'orig-preview-req': {
      // Stage 2D: the preview (~1080 px) is no longer pushed with every new photo; the partner asks for it when the picture is on screen.
      if (!isFreshRequest(message.ts, Date.now()) || isVideoName(message.ref)) return;
      previewServing = previewServing
        .then(async () => {
          if (!(await e2eKeys())) return;
          const connection = await readConn();
          const uri = connection ? await sharedOriginalUri(db, message.ref) : null;
          if (!connection || !uri) return;
          const preview = await makeVariant(uri, 'preview');
          if (!preview) return;
          await withRetry(() => publishPartner(connection, buildMediaMessage({ from: getDeviceId(), ts: nowIso(), ref: message.ref, kind: 'preview', rendered: preview })));
        })
        .catch(() => undefined);
      return;
    }
    default: {
      const event = await receiveOrig(
        { transfers: transferStore(db), parts: partStore(db), freeBytes: freeDiskBytes, sendCancel: (rid) => postOrig({ ...origHead(rid), t: 'orig-cancel' }),
          requestMore: (rid, ref, from, count) => postOrig({ ...origHead(rid), t: 'orig-req', ref, start: from, count }),
          capBytes: () => Math.max(0, useSettingsStore.getState().partnerCacheMb) * 1024 * 1024,
          now: Date.now },
        message,
      );
      originalWaiter.onEvent(event);
    }
  }
}

/**
 * "Full quality": asks the partner's phone for the original of the shared photo `ref` and waits. The file arrives as encrypted
 * chunks, is cached on this phone (size-capped like the previews) and `'ok'` is returned. `'offline'` = the other phone did not
 * answer in time. Never throws.
 */
export async function requestPartnerOriginal(ref: string, onProgress?: (done: number, total: number) => void): Promise<OriginalOutcome> {
  const db = currentDb;
  if (!db) return 'send';
  if (originalWaiter.active(ref)) return originalWaiter.request(ref, '', async () => undefined, onProgress);
  // Stage 2D: the same content (same SHA-256) is already here under another path: copy it, no transfer (works offline).
  if (await copyFromSameContent(db, ref)) return 'ok';
  if (!(await readConn()) || !(await e2eKeys())) return 'no-keys';
  const rid = Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
  const transfers = transferStore(db);
  // Resume: an unfinished transfer whose part file still holds exactly the chunks counted continues from the first missing chunk.
  const unfinished = await findTransferByRef(db, ref);
  let from = 0;
  if (unfinished && unfinished.chunks > 0 && partSize(unfinished) >= unfinished.next * ORIG_CHUNK_BYTES /* chunks received ahead may have grown the file; they are re-sent */ && unfinished.next < unfinished.chunks) {
    from = unfinished.next;
    await rekeyTransfer(db, unfinished.rid, { ...unfinished, rid, until: Math.min(unfinished.chunks, from + ORIG_WINDOW_CHUNKS), updated: Date.now() });
  } else {
    if (unfinished) {
      await partStore(db).discard(unfinished);
      await transfers.remove(unfinished.rid);
    }
    await transfers.put({ rid, ref, state: 'asked', ext: 'jpg', size: 0, chunks: 0, next: 0, until: 0, file: `o-${rid}.part`, updated: Date.now() });
  }
  const outcome = await originalWaiter.request(ref, rid, () => postOrig({ ...origHead(rid), t: 'orig-req', ref, ...(from > 0 ? { start: from, count: ORIG_WINDOW_CHUNKS } : {}) }), onProgress);
  if (outcome !== 'ok') {
    const row = await transfers.get(rid).catch(() => null);
    // Paused / interrupted while receiving: keep the part file so the next tap resumes. Everything else is cleaned up.
    const keep = row?.state === 'receiving' && (outcome === 'cancelled' || outcome === 'io' || outcome === 'offline');
    if (row && !keep) {
      await partStore(db).discard(row);
      await transfers.remove(rid).catch(() => undefined);
    }
    if (outcome === 'offline' || outcome === 'io' || outcome === 'cancelled') void postOrig({ ...origHead(rid), t: 'orig-cancel' }).catch(() => undefined);
    return outcome;
  }
  if ((await partnerOriginalState(db, ref)) !== 'cached') return 'space'; // a cache cap smaller than the file removed it again
  return (await verifyOriginal(db, ref)) === 'hash' ? 'hash' : 'ok'; // stage 7: the whole file must match the sender's SHA-256
}

async function copyFromSameContent(db: SQLiteDatabase, ref: string): Promise<boolean> {
  try {
    const item = itemByRef(await withSync(() => loadSyncState(db)), ref);
    if (!item) return false;
    for (const other of item.refs) {
      if (other !== ref && (await partnerOriginalState(db, other)) === 'cached' && (await copyPartnerOriginal(db, other, ref))) return true;
    }
  } catch {
    // no dedupe: the normal transfer follows
  }
  return false;
}

/** The person pressed cancel while an original is coming. */
/** (For a video this is "pause": the received part is kept and the next tap continues.) */
export const cancelPartnerOriginal = (ref: string): void => {
  originalWaiter.cancel(ref);
};

/** `available` = a small picture of the partner's photo is here and the original can be asked for; `cached` = already on this phone. */
export async function partnerOriginalStatus(ref: string): Promise<'cached' | 'available' | 'none'> {
  if (!currentDb) return 'none';
  try {
    return await partnerOriginalState(currentDb, ref);
  } catch {
    return 'none';
  }
}

// ---------------------------------------------------------------- stage 7: hash + sync (rules in src/sync/sync-logic.ts)

async function postSync(message: SyncMessage): Promise<void> {
  const connection = await readConn();
  if (!connection) throw new Error('not paired');
  await sendEncrypted({ sodium: nativeSodium, keys: e2eKeys, client: new MailboxClient(connection) }, message as unknown as Record<string, unknown>);
}

const syncHead = () => ({ from: getDeviceId(), ts: nowIso(), silent: true as const });
/** The sync state is read, changed and written whole: one change at a time. */
let syncChain: Promise<unknown> = Promise.resolve();
const withSync = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = syncChain.then(job, job);
  syncChain = run.catch(() => undefined);
  return run;
};

async function sendSyncEvents(events: SyncEvent[]): Promise<void> {
  for (let i = 0; i < events.length; i += SYNC_MAX_EVENTS) {
    await postSync({ ...syncHead(), t: 'sync-ev', events: events.slice(i, i + SYNC_MAX_EVENTS) });
  }
}

async function handleSyncMessage(db: SQLiteDatabase, message: SyncMessage): Promise<void> {
  if (message.t === 'sync-ev') {
    const purged = await withSync(async () => {
      let state = await loadSyncState(db);
      const refs: string[] = [];
      for (const ev of message.events) {
        refs.push(...refsAffected(state, ev)); // read before the delete removes the item that knew them
        state = applyEvent(state, ev, getDeviceId());
      }
      await saveSyncState(db, state);
      return refs;
    });
    await purgeSharedLocally(db, purged); // "delete for both" from the partner: the cached pictures and my share registration go
    return;
  }
  // A digest page: answer with the events the sender lacks (never with a digest of our own).
  const plan = await withSync(async () => reconcile(await loadSyncState(db), message.page, getDeviceId(), { lo: message.page.lo, hi: message.page.hi }));
  if (plan.send.length > 0) await sendSyncEvents(plan.send).catch(() => undefined);
}

/**
 * After a file is shared: hashes it (streamed, the JS thread is released between pieces), adds it to the sync state under a random
 * id and tells the partner. Best effort and in the background; a failure leaves the share itself untouched.
 */
async function registerForSync(ref: string, uri: string, name: string): Promise<void> {
  const db = currentDb;
  if (!db || !(await e2eKeys())) return;
  try {
    const source = await lookupSharedOriginal(db, ref);
    if (!source) return;
    const hash = await hashSource(source);
    const id = Array.from(getRandomBytes(12), (b) => b.toString(16).padStart(2, '0')).join('');
    const event = await withSync(async () => {
      const { state, v } = tick(await loadSyncState(db), getDeviceId());
      const ev: SyncEvent = { t: 'add', id, hash, name: name.slice(0, 255) || 'file', folder: 'Shared', ref, v };
      await saveSyncState(db, applyEvent(state, ev, getDeviceId()));
      return ev;
    });
    await sendSyncEvents([event]);
  } catch (error) {
    traceEvent(`sync: register failed ${error instanceof Error ? error.name : 'error'}`);
  }
  void uri;
}

/** Removes the cached pictures of these shared paths here and stops serving them from this phone. Never touches a user's own file. */
async function purgeSharedLocally(db: SQLiteDatabase, refs: string[]): Promise<void> {
  for (const ref of new Set(refs)) await removePartnerMedia(db, ref).catch(() => undefined);
  await forgetSharedOriginals(db, [...new Set(refs)]);
}

/**
 * The cached original of `ref` is compared with the SHA-256 the sender registered. A mismatch deletes it ('hash'); a match tells the
 * partner "I have it" (the "on both phones" badge). 'unknown' = no registered hash for this path (nothing to compare).
 */
async function verifyOriginal(db: SQLiteDatabase, ref: string): Promise<'ok' | 'hash' | 'unknown'> {
  try {
    const item = itemByRef(await withSync(() => loadSyncState(db)), ref);
    const cached = await getPartnerMedia(db, ref, 'original');
    if (!item || !cached || cached.kind !== 'original') return 'unknown';
    const reader = await openFileReader(cached.image.uri);
    const hash = await hashSource({ size: reader.size, read: reader.read });
    if (hash !== item.hash) {
      await removePartnerOriginal(db, ref);
      return 'hash';
    }
    const event = await withSync(async () => {
      const { state, v } = tick(await loadSyncState(db), getDeviceId());
      const ev: SyncEvent = { t: 'have', id: item.id, hash: item.hash, v };
      await saveSyncState(db, applyEvent(state, ev, getDeviceId()));
      return ev;
    });
    await sendSyncEvents([event]).catch(() => undefined);
    return 'ok';
  } catch {
    return 'unknown';
  }
}

/** For the viewer: is this shared path known to the sync, and is the content on both phones? */
export async function syncStatusForRef(ref: string): Promise<{ known: boolean; onBoth: boolean }> {
  const db = currentDb;
  if (!db) return { known: false, onBoth: false };
  const item = itemByRef(await withSync(() => loadSyncState(db)), ref);
  return { known: !!item, onBoth: !!item && onBothPhones(item) };
}

/** "Delete for me" for a shared photo/video: my copies go and the content is never added back by a sync. Nothing is sent. */
export async function deleteSharedForMe(ref: string): Promise<void> {
  const db = currentDb;
  if (!db) return;
  const item = itemByRef(await withSync(() => loadSyncState(db)), ref);
  if (item) await syncDeleteForMe(item.id);
  await purgeSharedLocally(db, [ref, ...(item?.refs ?? [])]);
}

/**
 * "Delete for both": a tombstone and an event; both phones drop the cached pictures and the sender stops serving the file. The
 * sender's own original file in their library or gallery is not deleted. 'unknown' = this item has no sync record (nothing done).
 */
export async function deleteSharedForBoth(ref: string): Promise<'ok' | 'unsent' | 'unknown'> {
  const db = currentDb;
  if (!db) return 'unknown';
  const item = itemByRef(await withSync(() => loadSyncState(db)), ref);
  if (!item) return 'unknown';
  const sent = await syncDeleteForBoth(item.id);
  await purgeSharedLocally(db, [ref, ...item.refs]);
  return sent ? 'ok' : 'unsent';
}

/**
 * Sends my full list to the partner in pages; they answer with the events I lack. Safe to call any time (it is idempotent).
 * Heavy for big lists: it is a REPAIR, not part of every start (see `repairIfNeeded`). Returns true only when every page was sent. Never throws.
 */
export async function syncNow(): Promise<boolean> {
  const db = currentDb;
  if (!db || !(await e2eKeys())) return false;
  try {
    const state = await withSync(() => loadSyncState(db));
    for (const page of digestPages(state)) await postSync({ ...syncHead(), t: 'sync-digest', page });
    return true;
  } catch (error) {
    traceEvent(`sync: digest failed ${error instanceof Error ? error.name : 'error'}`);
    return false;
  }
}

let repairing: Promise<void> | null = null;

/**
 * Stage 2D: the full comparison only when it is owed (first pairing, lost state, more than 30 days without contact; see
 * src/sync/cursor-logic.ts). The need is written to the store first, so a failed attempt (offline) is retried at the next start.
 * Otherwise nothing is sent: the saved queue cursor and the listener bring in only what is new. Never throws.
 */
export function repairIfNeeded(): Promise<void> {
  if (repairing) return repairing;
  const { paired, repairPending, lastContactAt } = store();
  const reason = repairReason({ paired, repairPending, lastContactAt }, Date.now());
  if (!reason) return Promise.resolve();
  store().requestRepair();
  traceEvent(`sync: repair ${reason}`);
  repairing = (async () => {
    if (await syncNow()) store().markRepaired(Date.now());
  })()
    .catch(() => undefined)
    .finally(() => {
      repairing = null;
    });
  return repairing;
}

/** Remembers a successful contact with the queue (throttled, so a burst of messages is one store write). */
function recordContact(): void {
  const now = Date.now();
  if (store().paired && shouldRecordContact(store().lastContactAt, now)) store().setContact(now);
}

/** The synced items on this phone (for the "on both phones" badge: `holders` has both device ids). */
export async function syncItems(): Promise<SyncItem[]> {
  if (!currentDb) return [];
  const state = await withSync(() => loadSyncState(currentDb as SQLiteDatabase));
  return Object.values(state.items);
}

/** "Delete for me": local only, the content is never added back by a sync. */
export async function syncDeleteForMe(id: string): Promise<void> {
  const db = currentDb;
  if (!db) return;
  await withSync(async () => saveSyncState(db, deleteForMe(await loadSyncState(db), id)));
}

/** "Delete for both": a tombstone here and an event to the partner. False when the item is unknown or the event could not be sent (the digest repairs it later). */
export async function syncDeleteForBoth(id: string): Promise<boolean> {
  const db = currentDb;
  if (!db) return false;
  const result = await withSync(async () => {
    const out = deleteForBoth(await loadSyncState(db), id, getDeviceId(), Date.now());
    await saveSyncState(db, out.state);
    return out.event;
  });
  if (!result) return false;
  try {
    await sendSyncEvents([result]);
    return true;
  } catch {
    return false;
  }
}

export type InviteFailure = 'no-server' | 'missing-token' | 'feature' | 'owner' | 'full' | 'network' | 'storage';
export type InviteStartResult =
  | { kind: 'ready'; link: string; expiresAt: string; serverName: string }
  | { kind: 'error'; reason: InviteFailure };

function inviteFailure(error: unknown): InviteFailure {
  if (isMailboxError(error)) {
    if (error.kind === 'unauthorized') return 'missing-token';
    if (error.errorKey === 'household_full') return 'full';
    if (error.kind === 'network') return 'network';
  }
  return 'network';
}

/** Owner creates a server-issued, short-lived invite using a saved personal server. */
export async function beginPairing(serverEntryId: string): Promise<InviteStartResult> {
  const entry = useServersStore.getState().servers.find((server) => server.id === serverEntryId);
  if (!entry) return { kind: 'error', reason: 'no-server' };
  const token = await secureTokenStore.get(entry.id);
  if (!token) return { kind: 'error', reason: 'missing-token' };
  const connection = { url: entry.url, token };
  const client = new MailboxClient(connection);

  try {
    const me = await client.me();
    if (!me.features.includes('e2e')) return { kind: 'error', reason: 'feature' };
    if (me.role !== 'owner') return { kind: 'error', reason: 'owner' };
    if (me.household.partner) return { kind: 'error', reason: 'full' };
    const invite = await client.createInvite();
    pendingInvite = {
      connection,
      deviceId: me.deviceId,
      serverName: entry.name,
      link: invite.link,
      expiresAt: invite.expiresAt,
    };
    return { kind: 'ready', ...invite, serverName: entry.name };
  } catch (error) {
    return { kind: 'error', reason: inviteFailure(error) };
  }
}

export type InviteProgress = 'waiting' | 'paired' | 'expired' | 'failed';

/** Called while the owner displays the QR; stores the partner connection when the join is visible in /me. */
export async function checkPendingPairing(): Promise<InviteProgress> {
  const invite = pendingInvite;
  if (!invite) return 'failed';
  const expires = Date.parse(invite.expiresAt);
  if (Number.isFinite(expires) && Date.now() >= expires) {
    pendingInvite = null;
    return 'expired';
  }
  try {
    const me = await new MailboxClient(invite.connection).me();
    if (!me.household.partner) return 'waiting';
    try {
      await savePairedConnection(invite.connection, me, 'owner', me.household.partner.deviceId);
    } catch {
      return 'failed';
    }
    pendingInvite = null;
    store().setPartner({ name: me.household.partner.name });
    void sendProfile(false);
    return 'paired';
  } catch (error) {
    return isMailboxError(error) && error.kind === 'unauthorized' ? 'failed' : 'waiting';
  }
}

async function savePairedConnection(
  connection: MailboxConnection,
  me: MailboxMe,
  role: 'owner' | 'member',
  partnerDeviceId: string,
) {
  await secureTokenStore.set(PARTNER_TOKEN_KEY, connection.token);
  store().setPaired(
    {
      serverUrl: connection.url,
      role,
      serverDeviceId: me.deviceId,
      partnerDeviceId,
    },
    unixNow(),
  );
}

export type JoinFailure = 'invalid' | 'full' | 'network' | 'storage' | 'already' | 'name';

/** Phone 2 joins with the one-time invite, then keeps its own returned token in SecureStore. */
export async function acceptPairing(
  invite: { url: string; code: string },
  rawDeviceName: string,
): Promise<'ok' | JoinFailure> {
  if (store().paired) return 'already';
  const deviceName = rawDeviceName.trim();
  if (!deviceName || deviceName.length > 64 || /[\u0000-\u001f\u007f]/.test(deviceName)) return 'name';

  let joinedDeviceId: string | undefined;
  let joinedToken: string | undefined;
  let storedToken = false;
  try {
    const joined = await joinMailbox(invite.url, invite.code, deviceName);
    joinedDeviceId = joined.deviceId;
    joinedToken = joined.token;
    const connection = { url: invite.url, token: joined.token };
    await secureTokenStore.set(PARTNER_TOKEN_KEY, joined.token);
    storedToken = true;
    const me = await new MailboxClient(connection).me();
    const partner = me.household.partner;
    if (me.deviceId !== joined.deviceId || me.role !== 'member' || !partner || !me.features.includes('e2e')) {
      try {
        await secureTokenStore.remove(PARTNER_TOKEN_KEY);
      } catch {
        // Keep the app unpaired even if the OS secure store cannot remove the orphaned credential yet.
      }
      try {
        await new MailboxClient(connection).revoke(joined.deviceId);
      } catch {
        // Invalid join responses must not leave a device occupying the household slot.
      }
      return 'invalid';
    }
    await savePairedConnection(connection, me, 'member', partner.deviceId);
    store().setPartner({ name: partner.name });
    void sendProfile(true);
    return 'ok';
  } catch (error) {
    if (storedToken) {
      try {
        await secureTokenStore.remove(PARTNER_TOKEN_KEY);
      } catch {
        // Revoking the server device below remains authoritative.
      }
    }
    if (joinedDeviceId && joinedToken) {
      try {
        await new MailboxClient({ url: invite.url, token: joinedToken }).revoke(joinedDeviceId);
      } catch {
        // The consumed invite cannot be reused; the owner can create a new one.
      }
    }
    if (isMailboxError(error)) {
      if (error.errorKey === 'invalid_code' || error.status === 400) return 'invalid';
      if (error.errorKey === 'household_full' || error.status === 409) return 'full';
      if (error.kind === 'unauthorized') return 'invalid';
      if (error.kind === 'network') return 'network';
    }
    return error instanceof Error && /SecureStore|storage/i.test(error.message) ? 'storage' : 'network';
  }
}

async function clearLocal() {
  pendingInvite = null;
  stopListening();
  try {
    await secureTokenStore.remove(PARTNER_TOKEN_KEY);
  } catch {
    // Clear pairing state even if secure storage is temporarily unavailable.
  }
  store().clearPairing();
  usePushStore.getState().setState('unknown');
  // Stage 4: the old partner's pictures and the previews still waiting for Wi-Fi do not stay on the phone.
  try {
    await clearAllPartnerMedia(currentDb);
    await clearAllOriginals(currentDb);
    await clearSyncState(currentDb);
    await resetOutboxIndex();
  } catch {
    // a leftover private file is harmless; nothing in the app points to it any more
  }
  // A new partner needs a new in-person pairing: the old keys and the applied-ids list go with the old pairing.
  try {
    await e2ePairing().reset();
    await e2eSeen.clear();
  } catch {
    // The keys are replaced anyway at the next pairing (`startRequest` / `acceptRequest`).
  }
}

/**
 * An `unpair` message arrived. A new pairing replays the mailbox from the start, so an OLD `unpair` (left by an earlier pairing of
 * this household, kept up to 30 days) used to remove the brand-new pairing a few seconds after it was made. The server decides:
 * the message only counts when the partner device we are paired with is really gone. Returns false = stale, keep the pairing.
 */
async function unpairedByMessage(): Promise<boolean> {
  const connection = await readConn();
  if (!connection) {
    await clearLocal();
    return true;
  }
  try {
    const me = await new MailboxClient(connection).me();
    const partner = me.household.partner;
    const expected = store().partnerDeviceId;
    if (partner && (!expected || partner.deviceId === expected)) {
      traceEvent('unpair message ignored: the partner is still paired (stale message from an earlier pairing)');
      return false;
    }
  } catch (error) {
    if (!(isMailboxError(error) && error.kind === 'unauthorized')) {
      traceEvent('unpair message ignored: could not verify it with the server');
      return false; // cannot verify: keep the pairing; a revoked token still shows the "token not accepted" notice
    }
  }
  await clearLocal();
  return true;
}

/**
 * Unpair revokes the other device when this phone is owner, or this device when it is a member.
 * A failed network request keeps local credentials so the user can retry.
 */
export async function unpair(): Promise<'ok' | 'failed' | 'not-paired'> {
  const connection = await readConn();
  const state = store();
  if (!connection || !state.role) return 'not-paired';
  const client = new MailboxClient(connection);
  const target = state.role === 'owner' ? state.partnerDeviceId : state.serverDeviceId;
  if (!target) return 'failed';

  const message = { t: 'unpair', from: getDeviceId(), ts: nowIso() } as const;
  try {
    try {
      await publishPartner(connection, message);
    } catch {
      // Revocation is authoritative; delivery is best effort, and the receiver also detects 401/4401.
    }
    // Remove this phone's push token first: after a member revokes itself the token stops working.
    await unregisterPush(client);
    try {
      await client.revoke(target);
    } catch (error) {
      if (!(isMailboxError(error) && (error.kind === 'unauthorized' || error.status === 404))) {
        return 'failed';
      }
    }
    await clearLocal();
    return 'ok';
  } catch {
    return 'failed';
  }
}

export async function sendProfile(hello = false): Promise<'sent' | 'avatar-dropped' | 'photo-failed' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  const { me } = store();
  // R10c: the sharper photo is shared once as an encrypted picture (its reference is kept in `me.avatarPhoto`); the tiny one stays in the message.
  let photo = me.avatarB64 ? me.avatarPhoto : undefined;
  let photoFailed = false;
  if (me.avatarB64 && me.avatarUri && !photo) {
    const uploaded = await shareFile(`avatar-${getDeviceId()}`, me.avatarUri.split('/').pop() ?? 'avatar.jpg', me.avatarUri);
    if (uploaded) {
      photo = uploaded;
      const now = store().me;
      if (now.avatarUri === me.avatarUri) store().setMe({ ...now, avatarPhoto: uploaded }); // not when the photo was replaced meanwhile
    } else {
      photoFailed = true; // Q1: the tiny photo is still sent; the owner is told the sharp one did not go
    }
  }
  const base: ProfileMessage = {
    t: 'profile',
    from: getDeviceId(),
    ts: nowIso(),
    name: me.name,
    birthday: me.birthday,
    togetherSince: store().togetherSince,
    hello: hello ? true : undefined,
  };
  let body = encodeMessage({ ...base, avatarB64: me.avatarB64, avatarPhoto: photo });
  const dropped = !!me.avatarB64 && body === null;
  if (body === null) body = encodeMessage({ ...base, avatarPhoto: photo });
  if (body === null) body = encodeMessage(base);
  if (body === null) return 'failed';
  try {
    await publishPartner(connection, JSON.parse(body) as ProfileMessage);
    return dropped ? 'avatar-dropped' : photoFailed ? 'photo-failed' : 'sent';
  } catch {
    return 'failed';
  }
}

export async function sendMood(
  db: SQLiteDatabase,
  mood: { emoji: string; text: string; intensity: MoodIntensity; activity?: string | null; /** colour of my custom mood (0-7) */ preset?: number | null },
): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  const text = mood.text.trim().slice(0, MAX_NOTE) || undefined;
  const message: MoodMessage = {
    t: 'mood',
    from: getDeviceId(),
    ts: nowIso(),
    emoji: mood.emoji,
    text,
    intensity: mood.intensity,
    ...(typeof mood.preset === 'number' ? { preset: mood.preset } : {}),
  };
  const body = encodeMessage(message);
  if (body === null) return 'failed';
  try {
    const sent = await publishPartner(connection, JSON.parse(body) as MoodMessage);
    await insertMood(db, { msgId: sent.msgId, fromMe: true, emoji: message.emoji, text: text ?? null, intensity: message.intensity, ts: message.ts, activity: mood.activity ?? null });
    store().bumpMoods();
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** R3: clears my current mood on this phone (always) and tells the partner when paired. `local` = saved here, not sent. */
export async function clearMood(db: SQLiteDatabase): Promise<'sent' | 'local' | 'failed'> {
  const ts = nowIso();
  const connection = await readConn();
  let result: 'sent' | 'local' = 'local';
  if (connection) {
    const body = encodeMessage({ t: 'mood', from: getDeviceId(), ts, cleared: true } satisfies MoodClearedMessage);
    try {
      if (body !== null) {
        const sent = await publishPartner(connection, JSON.parse(body) as MoodClearedMessage);
        await clearMoodLocal(db, true, sent.msgId, ts);
        store().bumpMoods();
        return 'sent';
      }
    } catch {
      /* offline: keep the clear on this phone */
    }
  }
  try {
    await clearMoodLocal(db, true, null, ts);
    store().bumpMoods();
    return result;
  } catch {
    return 'failed';
  }
}

/** Q1: why sharing a file failed, as a short technical code (`connection`, `file`, `no-keys`, `type`, `send`). */
export type ShareResult = { ok: true; path: string } | { ok: false; reason: string };
let lastShareReason = '';
/** The reason code of the latest failed share (for the dialog after `sendProfile` says `photo-failed`). */
export const getLastShareReason = () => lastShareReason;

/**
 * Shares one phone file with the partner and returns the reference both phones use for it. Nothing is uploaded to a server:
 * a still image goes as an encrypted thumbnail (now) and preview (Wi-Fi) through the queue, a video as a poster; the original
 * stays on this phone until the partner asks for "full quality" (chunks through the same queue). Needs E2E keys; any other
 * kind of file is not shared (`type`).
 */
export async function shareFileResult(id: string, name: string, uri: string): Promise<ShareResult> {
  const result = await shareFileInner(id, name, uri);
  if (!result.ok) lastShareReason = result.reason;
  return result;
}

async function shareFileInner(id: string, name: string, uri: string): Promise<ShareResult> {
  if (!(await readConn())) {
    traceEvent('share: no connection (not paired / no token)');
    return { ok: false, reason: 'connection' };
  }
  if (!(await e2eKeys())) {
    noKeysNotice();
    return { ok: false, reason: 'no-keys' };
  }
  if (isImageName(name || uri)) return shareImageEncrypted(id, name, uri);
  if (isVideoName(name || uri)) return shareVideoEncrypted(id, name, uri);
  traceEvent('share: only photos and videos can be shared');
  return { ok: false, reason: 'type' };
}

function mediaSendDeps(connection: MailboxConnection): SendDeps {
  return {
    send: async (message: MediaMessage) => {
      await publishPartner(connection, message);
    },
    unmetered: () => isUnmetered(),
    wifiOnly: () => useSettingsStore.getState().sharePreviewWifiOnly,
    outbox: fileOutbox,
    now: () => Date.now(),
  };
}

/** The reference the message carries for an encrypted picture (`Shared/<id>/<name>`, an opaque id: nothing is stored on the server). */
async function shareImageEncrypted(id: string, name: string, uri: string): Promise<ShareResult> {
  const connection = await readConn();
  if (!connection) return { ok: false, reason: 'connection' };
  const ref = `${sharedFolder(id)}/${sharedFileName(name)}`;
  if (!splitSharedPath(ref)) return { ok: false, reason: 'file' };
  const thumb = await makeVariant(uri, 'thumb');
  if (!thumb) return { ok: false, reason: 'file' };
  // Stage 6: remember where the original is, so the partner can ask for "full quality" later.
  if (currentDb) await recordSharedOriginal(currentDb, ref, uri, name).catch(() => undefined);
  void registerForSync(ref, uri, name);
  const from = getDeviceId();
  const ts = nowIso();
  try {
    const outcome = await sendVariants(mediaSendDeps(connection), {
      thumb: buildMediaMessage({ from, ts, ref, kind: 'thumb', rendered: thumb }),
      preview: null, // stage 2D: the preview is sent only when the partner's screen asks for it (orig-preview-req)
    });
    traceEvent(`share: encrypted thumb sent, preview ${outcome.preview}`);
    return { ok: true, path: ref };
  } catch (error) {
    traceEvent(`share: encrypted send failed ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : String(error).slice(0, 160)}`);
    return { ok: false, reason: 'send' };
  }
}

/**
 * A video with E2E keys: nothing goes to the server. The sender's file is registered (the partner pulls it chunk by chunk with
 * "download", stage 6) and a poster frame, when the phone can make one, goes as the thumbnail.
 */
async function shareVideoEncrypted(id: string, name: string, uri: string): Promise<ShareResult> {
  const connection = await readConn();
  if (!connection) return { ok: false, reason: 'connection' };
  const ref = `${sharedFolder(id)}/${sharedFileName(name)}`;
  if (!splitSharedPath(ref)) return { ok: false, reason: 'file' };
  try {
    await openFileReader(uri); // must be readable now; later reads are checked when the partner asks
  } catch {
    return { ok: false, reason: 'file' };
  }
  if (currentDb) await recordSharedOriginal(currentDb, ref, uri, name).catch(() => undefined);
  void registerForSync(ref, uri, name);
  const poster = await makeVideoPoster(uri);
  if (poster) {
    try {
      await publishPartner(connection, buildMediaMessage({ from: getDeviceId(), ts: nowIso(), ref, kind: 'thumb', rendered: poster }));
    } catch (error) {
      traceEvent(`share: video poster not sent ${error instanceof Error ? error.name : 'error'}`);
      return { ok: false, reason: 'send' };
    }
  }
  traceEvent(`share: encrypted video registered, poster ${poster ? 'sent' : 'none'}`);
  return { ok: true, path: ref };
}

/** Sends the previews that waited for Wi-Fi. Cheap when the outbox is empty. Never throws. */
export async function flushMediaOutbox(): Promise<number> {
  try {
    const connection = await readConn();
    if (!connection || !(await e2eKeys())) return 0;
    return await flushOutbox(mediaSendDeps(connection));
  } catch {
    return 0;
  }
}

/** Shares a phone file (see `shareFileResult`) and returns its reference, or null when it could not be shared. */
export async function shareFile(id: string, name: string, uri: string): Promise<string | null> {
  const result = await shareFileResult(id, name, uri);
  return result.ok ? result.path : null;
}

/**
 * The picture of a shared reference, always from a file on this phone: the thumbnail (kept for good), the preview or the
 * original (the cache). The nearest stored kind stands in for a missing one. Null when nothing is stored yet. No server is asked.
 */
export async function sharedImage(path: string, kind: 'thumb' | 'preview' | 'original' = 'preview'): Promise<ImageRef | null> {
  if (!currentDb) return null;
  try {
    const stored = await getPartnerMedia(currentDb, path, kind);
    if (stored) {
      if (kind === 'preview' && stored.kind === 'thumb') void askPreview(path); // on screen, thumbnail only: fetch the sharper one
      return stored.image.uri ? stored.image : null;
    }
    // A picture this phone shared itself: its own file is the picture (nothing was stored for it).
    const own = isVideoName(path) ? null : await sharedOriginalUri(currentDb, path);
    if (!own) return null;
    if (kind === 'thumb') return { uri: (await smallCopy(own)) ?? own }; // my own sent photo in a list: a small copy, not the full file
    return { uri: own };
  } catch {
    return null;
  }
}

/**
 * Stories: shares the photo/video with the partner (encrypted, see `shareFileResult`) and tells them (data only, no notification). Best effort like events:
 * `failed` / `not-paired` leave the story on this phone only.
 */
export async function sendStory(story: StoryRow): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    const extension = story.type === 'video' ? (story.mediaUri.split('?')[0].split('.').pop() ?? 'mp4').toLowerCase() : 'jpg';
    const media = await shareFile(story.id, `story.${/^[a-z0-9]{2,4}$/.test(extension) ? extension : 'mp4'}`, story.mediaUri);
    if (!media) return 'failed';
    const message: StoryMessage = {
      from: getDeviceId(),
      ts: nowIso(),
      t: 'story',
      silent: true,
      id: story.id,
      type: story.type,
      media,
      ...(story.overlayText ? { overlayText: story.overlayText, overlayY: story.overlayY } : {}),
      ...(story.caption ? { caption: story.caption } : {}),
      date: story.createdAt,
    };
    const body = encodeMessage(message);
    if (body === null) return 'failed';
    await publishPartner(connection, JSON.parse(body) as StoryMessage);
    return 'sent';
  } catch (error) {
    traceEvent(`story send: failed ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : String(error).slice(0, 160)}`);
    return 'failed';
  }
}

/** The partner is told a story of mine was removed. */
export async function sendStoryDeleted(id: string, type: 'photo' | 'video' = 'photo'): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    await publishPartner(connection, { from: getDeviceId(), ts: nowIso(), t: 'story', silent: true, id, type, deleted: true });
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** "I opened your story `id`" (the time of the message is the time it was seen). */
export async function sendStorySeen(id: string): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    await publishPartner(connection, { from: getDeviceId(), ts: nowIso(), t: 'story-seen', silent: true, id });
    return 'sent';
  } catch {
    return 'failed';
  }
}

let applyingRemoteTogether = false;
let unwatchTogether: (() => void) | null = null;
/** A changed local "together since" date goes to the partner at once (profile message); a date we just received is not sent back. */
function watchTogetherSince() {
  if (unwatchTogether) return;
  unwatchTogether = usePartnerStore.subscribe((state, previous) => {
    if (applyingRemoteTogether || !state.paired || state.togetherSince === previous.togetherSince || !state.togetherSince) return;
    void sendProfile(false);
  });
}

/**
 * R5a: logs a period update (`started` = first day of a period, `pain`, `better`) on this phone and tells the partner when paired.
 * `day` defaults to today (UTC). `local` = saved here only (not paired or offline); `duplicate` = that owner/kind/day exists.
 */
export async function sendPeriod(db: SQLiteDatabase, kind: PeriodKind, day?: string): Promise<'sent' | 'local' | 'duplicate' | 'failed'> {
  const ts = nowIso();
  const when = day ?? ts.slice(0, 10);
  if (!isValidStartDay(when, ts.slice(0, 10))) return 'failed'; // Q7: never a future day (a past day of any age is fine)
  const connection = await readConn();
  if (connection) {
    const body = encodeMessage(buildPeriodMessage(kind, when, getDeviceId(), ts, useSettingsStore.getState().periodCycleDays ?? 0)); // Q7: my own cycle length travels with every update (0 = none)
    try {
      if (body !== null) {
        const sent = await publishPartner(connection, JSON.parse(body) as PeriodMessage);
        const stored = await insertPeriodEvent(db, { msgId: sent.msgId, fromMe: true, kind, day: when, ts });
        store().bumpPeriod();
        return stored ? 'sent' : 'duplicate';
      }
    } catch {
      /* offline: keep it on this phone */
    }
  }
  try {
    const row = await logPeriodLocal(db, { kind, day: when, ts });
    if (row) store().bumpPeriod();
    return row ? 'local' : 'duplicate';
  } catch {
    return 'failed';
  }
}

/** Surprise events are excluded by buildEventMessage and never reach the server. */
export async function sendEvent(event: EventRow | { id: string; deleted: true }): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  const message: EventMessage | null = buildEventMessage(event, getDeviceId(), nowIso());
  if (!message) return 'not-paired';
  const body = encodeMessage(message);
  if (body === null) return 'failed';
  try {
    await publishPartner(connection, JSON.parse(body) as EventMessage);
    return 'sent';
  } catch {
    return 'failed';
  }
}

/**
 * R8a: tells the partner about a saved memory (create, edit; `silent` for a media-only change) or its deletion.
 * A copy that came from the partner is never sent. Best effort like events: offline = the partner gets the next edit.
 */
export async function sendDiary(db: SQLiteDatabase, entry: DiaryRow | { id: string; deleted: true }, options: { silent?: boolean } = {}): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    let media: string[] | undefined;
    if (!('deleted' in entry) && entry.fromMe !== false) {
      if (entry.mediaKeys.length > 99) return 'failed';
      media = [];
      for (const [index, key] of entry.mediaKeys.entries()) {
        if (splitSharedPath(key)) {
          media.push(key);
          continue;
        }
        const rawName = key.split(/[?#]/, 1)[0].split('/').pop() ?? '';
        let name = rawName;
        try {
          name = decodeURIComponent(rawName);
        } catch {
          // Keep the original final path segment when it is not valid URI encoding.
        }
        // Q1: the key is a Library key, not a file path: make the original a readable file first.
        const { resolveMediaFile } = await import('@/src/diary/diary-media');
        const file = await resolveMediaFile(key);
        if (!file) {
          traceEvent(`diary send: media #${index + 1} could not be resolved to a phone file`);
          return 'failed';
        }
        try {
          const shared = await shareFileResult(entry.id, `attachment-${index + 1}-${file.name || name}`, file.uri);
          if (!shared.ok) {
            if (shared.reason === 'type') {
              traceEvent(`diary send: media #${index + 1} is not a photo or video, left out`);
              continue;
            }
            traceEvent(`diary send: media #${index + 1} not shared (${shared.reason})`);
            return 'failed';
          }
          media.push(shared.path);
        } finally {
          file.release();
        }
      }
    }
    const message: DiaryMessage | null = await buildDiaryMessage(db, entry, getDeviceId(), nowIso(), { ...options, ...(media ? { media } : {}) });
    if (!message) return 'not-paired';
    const body = encodeMessage(message);
    if (body === null) {
      traceEvent('diary send: message too big to encode');
      return 'failed';
    }
    await publishPartner(connection, JSON.parse(body) as DiaryMessage);
    return 'sent';
  } catch (error) {
    traceEvent(`diary send: failed ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : String(error).slice(0, 160)}`);
    return 'failed';
  }
}

/**
 * A reply under a memory (or its removal) goes to the partner as a `diary` message with `replyTo`. Best effort like memories:
 * `failed` means it is saved here but the partner has not got it (the screen says so; there is no retry queue).
 */
export async function sendDiaryReply(reply: { id: string; memoryId: string; body?: string; createdAt?: string; deleted?: true }): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    const message = buildReplyMessage(reply, getDeviceId(), nowIso());
    const body = encodeMessage(message);
    if (body === null) return 'failed';
    await publishPartner(connection, JSON.parse(body) as DiaryMessage);
    return 'sent';
  } catch (error) {
    traceEvent(`diary reply send: failed ${error instanceof Error ? error.name : 'error'}`);
    return 'failed';
  }
}

let chatScreenOpen = false;
/** The chat screen tells the app it is on screen, so a new text does not also pop up as a notification. */
export function setChatScreenOpen(open: boolean) {
  chatScreenOpen = open;
}

/** Direct chat: sends one text to the partner. Returns false when it could not be sent (the message stays stored as `failed`). */
type ChatMedia = { media?: string | null; mediaType?: ChatMediaType | null };
async function publishChat(msg: { id: string; body: string; createdAt: string } & ChatMedia): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    const message: ChatMessage = {
      t: 'chat', from: getDeviceId(), ts: msg.createdAt, id: msg.id,
      ...(msg.body ? { text: msg.body } : {}),
      ...(msg.media ? { media: msg.media, mediaType: msg.mediaType ?? 'photo' } : {}),
    };
    const body = encodeMessage(message);
    if (body === null) return 'failed';
    await publishPartner(connection, JSON.parse(body) as ChatMessage);
    return 'sent';
  } catch (error) {
    traceEvent(`chat send: failed ${error instanceof Error ? error.name : 'error'}`);
    return 'failed';
  }
}

/**
 * Direct chat: stores my text first (so it shows at once), then sends it. `failed` = saved here but the partner has not got it;
 * the chat shows a retry (`retryChat`).
 */
export async function sendChat(db: SQLiteDatabase, text: string): Promise<'sent' | 'not-paired' | 'failed' | 'empty'> {
  const body = text.trim().slice(0, MAX_CHAT);
  if (!body) return 'empty';
  const msg = {
    id: `c${Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('')}`,
    body,
    createdAt: nowIso(),
  };
  await addChat(db, { id: msg.id, fromMe: true, body: msg.body, createdAt: msg.createdAt });
  store().bumpChat();
  const result = await publishChat(msg);
  if (result !== 'sent') {
    await setChatFailed(db, msg.id, true);
    store().bumpChat();
  }
  return result;
}

/** Sends a message that is stored as `failed` once more (same id, so the partner never gets it twice). */
export async function retryChat(db: SQLiteDatabase, id: string): Promise<'sent' | 'not-paired' | 'failed'> {
  const row = await getChat(db, id);
  if (!row || !row.fromMe) return 'failed';
  const result = await publishChat({ id: row.id, body: row.body, createdAt: row.createdAt, media: row.media, mediaType: row.mediaType });
  if (result === 'sent') {
    await setChatFailed(db, id, false);
    store().bumpChat();
  }
  return result;
}

/**
 * "Send to Direct" (viewer): one photo/video goes into the chat like a text. `media` = the reference of a phone file already
 * shared with `shareFileResult`. Same stored-first / retry rules as `sendChat`.
 */
export async function sendChatMedia(
  db: SQLiteDatabase,
  input: { media: string; mediaType: ChatMediaType; text?: string },
): Promise<'sent' | 'not-paired' | 'failed' | 'empty'> {
  if (!input.media) return 'empty';
  const msg = {
    id: `c${Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('')}`,
    body: (input.text ?? '').trim().slice(0, MAX_CHAT),
    createdAt: nowIso(),
    media: input.media,
    mediaType: input.mediaType,
  };
  if (!(await readConn())) return 'not-paired';
  await addChat(db, { id: msg.id, fromMe: true, body: msg.body, createdAt: msg.createdAt, media: msg.media, mediaType: msg.mediaType });
  store().bumpChat();
  const result = await publishChat(msg);
  if (result !== 'sent') {
    await setChatFailed(db, msg.id, true);
    store().bumpChat();
  }
  return result;
}

async function publishMessage(message: LikeMessage | CommentMessage): Promise<'sent' | 'not-paired' | 'failed'> {
  const connection = await readConn();
  if (!connection) return 'not-paired';
  try {
    await publishPartner(connection, message);
    return 'sent';
  } catch (error) {
    traceEvent(`${message.t} send: failed ${error instanceof Error ? error.name : 'error'}`);
    return 'failed';
  }
}

/** Likes (or removes my like from) a library file; the partner sees it under the file. Stored here first; data only, no notification. */
export async function sendLike(db: SQLiteDatabase, item: string, on: boolean): Promise<'sent' | 'not-paired' | 'failed'> {
  await setLike(db, item, true, on);
  store().bumpReactions();
  return publishMessage({ t: 'like', from: getDeviceId(), ts: nowIso(), silent: true, item, on });
}

/** Writes a comment under a library file (or, with `remove`, deletes mine). The partner sees it under the file. */
export async function sendComment(db: SQLiteDatabase, input: { item: string; text?: string; id?: string; remove?: boolean }): Promise<'sent' | 'not-paired' | 'failed' | 'empty'> {
  const id = input.id ?? `m${Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (input.remove) {
    await deleteComment(db, id, true);
    store().bumpReactions();
    return publishMessage({ t: 'comment', from: getDeviceId(), ts: nowIso(), silent: true, id, item: input.item, deleted: true });
  }
  const text = (input.text ?? '').trim();
  if (!text) return 'empty';
  await addComment(db, { id, item: input.item, fromMe: true, body: text });
  store().bumpReactions();
  return publishMessage({ t: 'comment', from: getDeviceId(), ts: nowIso(), silent: true, id, item: input.item, text: text.slice(0, 1000) });
}

let pendingChatSeen: string | null = null;
let chatSeenRunning = false;
let chatSeenAgain = false;

async function runChatSeen(db: SQLiteDatabase): Promise<void> {
  const newest = await markChatRead(db);
  if (newest) {
    pendingChatSeen = newest;
    store().bumpChat(); // the red number on the Home icon goes away
  }
  const id = pendingChatSeen;
  if (!id) return;
  const connection = await readConn();
  if (!connection) return;
  try {
    const receipt: ChatSeenMessage = { t: 'chat-seen', from: getDeviceId(), ts: nowIso(), silent: true, id };
    await publishPartner(connection, receipt);
    if (pendingChatSeen === id) pendingChatSeen = null;
  } catch {
    // best effort: the receipt is sent again the next time the chat is opened or a message arrives
  }
}

/**
 * "I read your messages": marks the partner's texts as read here and tells the partner (they get "Seen" under their last text).
 * Call it only while the chat screen is on screen and the app is in front. Calls that overlap are folded into one more run.
 */
export async function markChatSeen(db: SQLiteDatabase): Promise<void> {
  if (chatSeenRunning) {
    chatSeenAgain = true;
    return;
  }
  chatSeenRunning = true;
  try {
    do {
      chatSeenAgain = false;
      await runChatSeen(db);
    } while (chatSeenAgain);
  } finally {
    chatSeenRunning = false;
  }
}

/** R5b: dictionary key of the local notification text for each period update. */
const PERIOD_NOTIFY_KEY = { started: 'periodNotifyStarted', pain: 'periodNotifyPain', better: 'periodNotifyBetter' } as const;

type ArrivalContext = { seq: string; source: MailboxSource };

/**
 * The app's own notification. With a working push the system already showed mood/event messages that were
 * found by a replay (the app was closed), so those are skipped: see shouldNotifyLocal in push-events.ts.
 */
async function notifyLocal(notification: Parameters<InboxDeps['notify']>[0], arrival: ArrivalContext) {
  if (notification.kind === 'chat' && chatScreenOpen && AppState.currentState === 'active') return;
  const show = shouldNotifyLocal({
    kind: notification.kind,
    source: arrival.source,
    pushRegistered: usePushStore.getState().state === 'registered',
    heldByForegroundHandler: pushRouter.wasHeld(arrival.seq),
  });
  if (!show) return;
  const dict = getDictionary(useSettingsStore.getState().language);
  const name = store().partner?.name || dict.partnerDefaultName;
  if (notification.kind === 'mood') await showLocal(`${notification.msg.emoji} ${name}`, notification.msg.text || dict.moodNotifyBody);
  else if (notification.kind === 'event') await showLocal(name, `${dict.eventNotifyBody} ${notification.msg.title}`);
  else if (notification.kind === 'diary' && notification.msg.replyTo) await showLocal(name, `${dict.diaryNotifyReply} ${(notification.msg.text ?? '').slice(0, 80)}`.trim());
  else if (notification.kind === 'diary') await showLocal(name, `${notification.updated ? dict.diaryNotifyUpdated : dict.diaryNotifyBody} ${notification.msg.title ?? ''}`.trim());
  else if (notification.kind === 'period') await showLocal(name, dict[PERIOD_NOTIFY_KEY[notification.msg.kind]]);
  else if (notification.kind === 'chat') await showLocal(name, (notification.msg.text ?? (notification.msg.mediaType === 'video' ? dict.chatMediaVideo : dict.chatMediaPhoto)).slice(0, 120));
  else await showLocal(dict.brand, dict.partnerUnpairedNotice);
}

function inboxDeps(db: SQLiteDatabase, arrival: ArrivalContext) {
  return {
    db,
    deviceId: getDeviceId(),
    setPartner: (profile: Parameters<InboxDeps['setPartner']>[0]) => store().setPartner(profile),
    setTogetherSince: (iso: string) => {
      if (store().togetherSince === iso) return;
      applyingRemoteTogether = true;
      try {
        store().setTogetherSince(iso);
      } finally {
        applyingRemoteTogether = false;
      }
      void refreshWidget();
    },
    onUnpaired: unpairedByMessage,
    replyProfile: () => void sendProfile(false),
    prefs: () => {
      const settings = useSettingsStore.getState();
      return { mood: settings.notifyMood, event: settings.notifyEvent, diary: settings.notifyDiary, period: settings.notifyPeriod };
    },
    notify: (notification: Parameters<InboxDeps['notify']>[0]) => notifyLocal(notification, arrival),
    onMedia: async (message: MediaMessage) => {
      await storePartnerMedia(db, message);
    },
    onOriginal: (message: OrigMessage) => handleOriginalMessage(db, message),
    onSync: (message: SyncMessage) => handleSyncMessage(db, message),
    onMoodStored: () => store().bumpMoods(),
    setMoodPreset: (emoji: string, preset: number) => {
      const known = useSettingsStore.getState().partnerMoodPresets;
      if (known[emoji] !== preset) useSettingsStore.getState().setSetting('partnerMoodPresets', { ...known, [emoji]: preset });
    },
    onPeriod: async (message: PeriodMessage, id: string) => {
      const stored = await applyPeriodMessage(db, id, message);
      if (stored && message.cycleDays !== undefined) store().setPartnerCycleDays(message.cycleDays || undefined); // Q7
      if (stored) store().bumpPeriod();
      return stored;
    },
    onDiary: async (message: DiaryMessage) => {
      const done = await applyDiaryMessage(db, message, () => Array.from(getRandomBytes(6), (b) => b.toString(16).padStart(2, '0')).join(''));
      if (done !== 'ignored') store().bumpDiary();
      return done;
    },
    onChat: async (message: ChatMessage, id: string) => {
      const stored = await addChat(db, { id: message.id, fromMe: false, body: message.text ?? '', createdAt: message.ts, media: message.media, mediaType: message.mediaType });
      if (stored) store().bumpChat();
      // The chat is open and the app is in front: this text is read at once (no badge) and the partner gets "Seen".
      if (stored && chatScreenOpen && AppState.currentState === 'active') void markChatSeen(db);
      return stored;
    },
    onChatSeen: async (message: ChatSeenMessage) => {
      if (await markChatSeenUpTo(db, message.id)) store().bumpChat();
    },
    onLike: async (message: LikeMessage) => {
      await applyLikeMessage(db, message);
      store().bumpReactions();
    },
    onComment: async (message: CommentMessage) => {
      await applyCommentMessage(db, message);
      store().bumpReactions();
    },
    onStory: async (message: StoryMessage) => {
      if ((await applyStoryMessage(db, message)) !== 'ignored') store().bumpStories();
    },
    onStorySeen: async (message: StorySeenMessage) => {
      if (await applyStorySeen(db, message)) store().bumpStories();
    },
    onEvent: async (message: EventMessage) => {
      const mode = useSettingsStore.getState().calendarMode;
      await applyEventMessage(db, message, mode === 'gregorian' ? 'gregorian' : 'jalali');
      store().bumpEvents();
    },
  };
}

/** Follows the encrypted queue. Only with confirmed keys; everything it delivers is decrypted, applied, then ACKed (deleted on the server). */
async function startE2eListener(db: SQLiteDatabase, connection: MailboxConnection) {
  if (e2eListener || !(await e2eKeys())) return;
  const e2e = new MailboxListener({
    connection,
    since: () => store().lastE2eSeq || '0',
    // `unauthorized` (401 / socket close 4401) keeps the pairing and the token: the screens show the
    // "token not accepted" notice with a link to Settings > Server connection; Unpair stays available.
    onPresence: (online) => store().setPartnerOnline(online),
    onState: (state) => {
      store().setLink(state);
      if (state === 'connected') recordContact(); // the HTTP replay from the saved cursor succeeded
    },
    onMessage: async (message, source) => {
      await receiveEncrypted(
        {
          sodium: nativeSodium,
          keys: e2eKeys,
          seen: e2eSeen,
          client: new MailboxClient(connection),
          apply: (raw) => handleIncoming(inboxDeps(db, { seq: `e2e:${message.seq}`, source }), raw),
        },
        message,
      );
      if (store().paired) {
        store().setLastE2eSeq(String(message.seq)); // only after decrypt + apply + ACK: this is the last confirmed cursor
        recordContact();
      }
    },
  });
  e2eListener = e2e;
  e2e.start();
  void flushMediaOutbox();
}

/** Listens only for a paired device with E2E keys; the HTTP replay and the WebSocket both use the same queue cursor. */
export async function startListening(db: SQLiteDatabase) {
  currentDb = db;
  void cleanStaleTransfers(db);
  void repairIfNeeded(); // decided before the listener below touches lastContactAt
  watchTogetherSince();
  if (starting || e2eListener) return;
  starting = true;
  try {
    const connection = await readConn();
    if (connection) await startE2eListener(db, connection);
  } finally {
    starting = false;
  }
}

export function stopListening() {
  e2eListener?.stop();
  e2eListener = null;
}

/** The database handle of the open app (set by the listener), so a push or a tap can run a sync from outside React. */
let currentDb: SQLiteDatabase | null = null;

/**
 * Fetches the mailbox now: restarts the listener, which replays from the saved cursor first, then reopens the
 * socket (a stale socket cannot swallow a message). Does nothing when not paired or when the listener has not
 * started yet: its start replays anyway (cold start from a tap). Never throws.
 */
export async function syncMailbox(): Promise<void> {
  const db = currentDb;
  if (!db || !store().paired || AppState.currentState !== 'active') return;
  try {
    stopListening();
    await startListening(db);
  } catch {
    // The next foreground start replays again.
  }
}

/** Push and tap events of the open app: one sync each (see push-events.ts). */
export const pushRouter = createPushRouter({ sync: () => void syncMailbox() });

let pushSyncing: Promise<PushState> | null = null;
let pushAgain = false;

async function runPushSync(): Promise<PushState> {
  const connection = await readConn();
  if (!connection || !store().paired) {
    usePushStore.getState().setState('unknown');
    return 'unknown';
  }
  await ensurePushChannel();
  const settings = useSettingsStore.getState();
  const state = await registerPush({
    client: new MailboxClient(connection),
    language: settings.language,
    notify: { mood: settings.notifyMood, event: settings.notifyEvent, diary: settings.notifyDiary, period: settings.notifyPeriod },
    permission: nativePermission,
    getToken: nativeToken,
  });
  usePushStore.getState().setState(state);
  return state;
}

/**
 * Registers this phone's FCM token (and UI language) on the server. Never throws. Calls that arrive while one
 * is running are folded into one more run afterwards, so a token change and a language change cannot race.
 */
export function syncPushRegistration(): Promise<PushState> {
  if (pushSyncing) {
    pushAgain = true;
    return pushSyncing;
  }
  pushSyncing = (async () => {
    let result = await runPushSync();
    while (pushAgain) {
      pushAgain = false;
      result = await runPushSync();
    }
    return result;
  })().finally(() => {
    pushSyncing = null;
  });
  return pushSyncing;
}

export async function sendTestNotification(): Promise<ShowResult> {
  const dict = getDictionary(useSettingsStore.getState().language);
  return showLocal(dict.brand, dict.notifTestBody, true);
}
