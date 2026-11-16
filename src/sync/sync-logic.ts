/**
 * Sharing track, stage 7 (first small part): the sync rules, pure and tested. No storage, no network, no device code yet.
 *
 * CONFLICT RULE (decided; short version: "delete for both is final, everything else is last-writer-wins"):
 *  1. Every change is an event with a Lamport counter: counter = max(own counter, highest seen) + 1. Order = (counter, device id).
 *  2. Name and folder are separate fields; each field is last-writer-wins by that order. Two phones renaming at once: the higher
 *     (counter, device) wins on both phones, so they converge without asking anyone.
 *  3. "Delete for both" writes a tombstone that beats every edit of that item, even a later one, and it blocks the same content
 *     (SHA-256) from coming back as a new item while the tombstone lives (30 days, the trash period). After the purge the
 *     content may be added again like any new file.
 *  4. "Delete for me" is local only and never sent. The hash goes on a local "hidden" list so a sync never adds it back.
 *  5. Same SHA-256 under two ids = the same file: the smaller id is kept, the other becomes an alias (no second copy, no transfer);
 *     the item gets the "on both phones" badge once each side has reported the hash.
 *  6. Events may arrive in any order: an edit that comes before its add waits in `pending` and is replayed when the add arrives, so
 *     two phones that saw the same events always end identical.
 *  7. A full-list comparison (id + hash + field versions + tombstones) repairs missed events; it only ever produces events,
 *     it never rewrites state directly.
 */
export type Version = { counter: number; device: string };
export type SyncItem = {
  id: string;
  hash: string;
  name: string;
  nameV: Version;
  folder: string;
  folderV: Version;
  /** Ids merged into this one because they have the same hash. */
  aliases: string[];
  /** Shared paths (`Shared/<id>/<file>`) this item is known by on either phone, so a viewer can find its item. */
  refs: string[];
  /** Devices that reported having the content. */
  holders: string[];
};
export type Tombstone = { id: string; hash: string; v: Version; at: number };
export type SyncState = {
  items: Record<string, SyncItem>;
  tombstones: Record<string, Tombstone>;
  /** Local "delete for me" hashes: never added back by a sync. */
  hidden: string[];
  /** Edits that arrived before the add of their item (events can come in any order); replayed when the add arrives. */
  pending: Record<string, SyncEvent[]>;
  /** Highest counter seen or used. */
  clock: number;
};
export type SyncEvent =
  | { t: 'add'; id: string; hash: string; name: string; folder: string; ref?: string; v: Version }
  | { t: 'rename'; id: string; name: string; v: Version }
  | { t: 'move'; id: string; folder: string; v: Version }
  | { t: 'del-both'; id: string; hash: string; v: Version; at: number }
  | { t: 'have'; id: string; hash: string; v: Version };

/** Limits against a partner phone (or a bug) that floods the state: beyond them new items / waiting edits are dropped, not stored. */
export const MAX_ITEMS = 20000;
export const MAX_PENDING_IDS = 200;
export const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;
export const emptyState = (): SyncState => ({ items: {}, tombstones: {}, hidden: [], pending: {}, clock: 0 });

/** True when `a` is strictly newer than `b`. */
export const newer = (a: Version, b: Version): boolean => a.counter > b.counter || (a.counter === b.counter && a.device > b.device);

/** The next version for a local change; the clock moves forward. */
export function tick(state: SyncState, device: string): { state: SyncState; v: Version } {
  const counter = state.clock + 1;
  return { state: { ...state, clock: counter }, v: { counter, device } };
}

const bump = (state: SyncState, v: Version): SyncState => (v.counter > state.clock ? { ...state, clock: v.counter } : state);
const SHA256 = /^[0-9a-f]{64}$/;
export const isSha256 = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v);

const blockedByTombstone = (state: SyncState, id: string, hash: string): boolean =>
  !!state.tombstones[id] || Object.values(state.tombstones).some((t) => t.hash === hash);

/** Applies one event (local or remote) and returns the new state. Idempotent: applying it twice changes nothing more. */
export function applyEvent(state: SyncState, ev: SyncEvent, self: string): SyncState {
  let next = bump(state, ev.v);
  switch (ev.t) {
    case 'add': {
      if (!isSha256(ev.hash) || blockedByTombstone(next, ev.id, ev.hash) || next.hidden.includes(ev.hash)) return next;
      if (!next.items[ev.id] && Object.keys(next.items).length >= MAX_ITEMS) return next;
      const holder = ev.v.device;
      const sameHash = Object.values(next.items).find((i) => i.hash === ev.hash);
      if (sameHash && sameHash.id !== ev.id) {
        // rule 5: the smaller id is canonical; the other id is only an alias
        const keep = sameHash.id < ev.id ? sameHash : { ...sameHash, id: ev.id, aliases: sameHash.aliases };
        const drop = keep.id === sameHash.id ? ev.id : sameHash.id;
        const merged: SyncItem = { ...keep, aliases: [...new Set([...keep.aliases, drop])], holders: [...new Set([...keep.holders, holder])], refs: [...new Set([...keep.refs, ...(sameHash.refs ?? []), ...(ev.ref ? [ev.ref] : [])])] };
        const items = { ...next.items };
        delete items[sameHash.id];
        items[merged.id] = merged;
        return replayPending({ ...next, items }, ev.id, self);
      }
      const existing = next.items[ev.id];
      if (existing) {
        return { ...next, items: { ...next.items, [ev.id]: { ...existing, holders: [...new Set([...existing.holders, holder])], refs: [...new Set([...existing.refs, ...(ev.ref ? [ev.ref] : [])])] } } };
      }
      const item: SyncItem = { id: ev.id, hash: ev.hash, name: ev.name, nameV: ev.v, folder: ev.folder, folderV: ev.v, aliases: [], refs: ev.ref ? [ev.ref] : [], holders: [holder] };
      return replayPending({ ...next, items: { ...next.items, [ev.id]: item } }, ev.id, self);
    }
    case 'rename':
    case 'move': {
      const target = resolveId(next, ev.id);
      const item = target ? next.items[target] : undefined;
      if (!item) {
        // deleted for both: the edit is void (rule 3). Unknown yet: it waits for its add (rule 6).
        if (next.tombstones[ev.id]) return next;
        const waiting = next.pending[ev.id] ?? [];
        if (!next.pending[ev.id] && Object.keys(next.pending).length >= MAX_PENDING_IDS) return next;
        return { ...next, pending: { ...next.pending, [ev.id]: [...waiting, ev].slice(-20) } };
      }
      if (ev.t === 'rename') {
        if (!newer(ev.v, item.nameV)) return next;
        return { ...next, items: { ...next.items, [item.id]: { ...item, name: ev.name, nameV: ev.v } } };
      }
      if (!newer(ev.v, item.folderV)) return next;
      return { ...next, items: { ...next.items, [item.id]: { ...item, folder: ev.folder, folderV: ev.v } } };
    }
    case 'del-both': {
      const old = next.tombstones[ev.id];
      const tomb: Tombstone = old && !newer(ev.v, old.v) ? old : { id: ev.id, hash: ev.hash, v: ev.v, at: ev.at };
      const items = { ...next.items };
      const pending = { ...next.pending };
      delete pending[ev.id];
      next = { ...next, pending };
      for (const item of Object.values(items)) {
        if (item.id === ev.id || item.aliases.includes(ev.id) || item.hash === ev.hash) delete items[item.id];
      }
      return { ...next, items, tombstones: { ...next.tombstones, [ev.id]: tomb } };
    }
    case 'have': {
      const target = resolveId(next, ev.id);
      const item = target ? next.items[target] : undefined;
      if (!item || item.hash !== ev.hash) return next;
      return { ...next, items: { ...next.items, [item.id]: { ...item, holders: [...new Set([...item.holders, ev.v.device])] } } };
    }
  }
  void self;
  return next;
}

/** Applies the edits that waited for `id` (the add just arrived). */
function replayPending(state: SyncState, id: string, self: string): SyncState {
  const waiting = state.pending[id];
  if (!waiting) return state;
  const pending = { ...state.pending };
  delete pending[id];
  return waiting.reduce((st, ev) => applyEvent(st, ev, self), { ...state, pending });
}

/** An id, or the canonical id when it is an alias. */
export function resolveId(state: SyncState, id: string): string | null {
  if (state.items[id]) return id;
  const found = Object.values(state.items).find((i) => i.aliases.includes(id));
  return found ? found.id : null;
}

/** "Delete for me": local only, the content never comes back through a sync. No event is produced. */
export function deleteForMe(state: SyncState, id: string): SyncState {
  const target = resolveId(state, id);
  const item = target ? state.items[target] : undefined;
  if (!item) return state;
  const items = { ...state.items };
  delete items[item.id];
  return { ...state, items, hidden: [...new Set([...state.hidden, item.hash])] };
}

/** "Delete for both": the local tombstone and the event to send. */
export function deleteForBoth(state: SyncState, id: string, device: string, now: number): { state: SyncState; event: SyncEvent | null } {
  const target = resolveId(state, id);
  const item = target ? state.items[target] : undefined;
  if (!item) return { state, event: null };
  const { state: ticked, v } = tick(state, device);
  const event: SyncEvent = { t: 'del-both', id: item.id, hash: item.hash, v, at: now };
  return { state: applyEvent(ticked, event, device), event };
}

/** Forgets tombstones older than the trash period (the content may then be added again). */
export function purgeTombstones(state: SyncState, now: number): SyncState {
  const tombstones = Object.fromEntries(Object.entries(state.tombstones).filter(([, t]) => now - t.at <= TOMBSTONE_MS));
  return { ...state, tombstones };
}

/** What a phone tells the other in a full-list comparison: compact, no names. */
export type Digest = { items: { id: string; hash: string; nameV: Version; folderV: Version }[]; tombstones: { id: string; hash: string; v: Version; at: number }[] };
export const digestOf = (state: SyncState): Digest => ({
  items: Object.values(state.items).map((i) => ({ id: i.id, hash: i.hash, nameV: i.nameV, folderV: i.folderV })),
  tombstones: Object.values(state.tombstones).map((t) => ({ id: t.id, hash: t.hash, v: t.v, at: t.at })),
});

/**
 * Compares my state with the partner's digest and returns only EVENTS to send (rule 6): items they lack, the newer name/folder, and
 * tombstones they lack. `missing` = ids they have and I do not (I ask for them through the normal flow; it is not sent here).
 */
export function reconcile(mine: SyncState, theirs: Digest, device: string, range?: { lo: string; hi: string }): { send: SyncEvent[]; missing: string[] } {
  const inRange = (id: string) => !range || (id >= range.lo && id <= range.hi);
  const send: SyncEvent[] = [];
  const theirItems = new Map(theirs.items.map((i) => [i.id, i]));
  const theirTombs = new Set(theirs.tombstones.map((t) => t.id));
  for (const tomb of Object.values(mine.tombstones).filter((t) => inRange(t.id))) {
    if (!theirTombs.has(tomb.id)) send.push({ t: 'del-both', id: tomb.id, hash: tomb.hash, v: tomb.v, at: tomb.at });
  }
  for (const item of Object.values(mine.items).filter((i) => inRange(i.id))) {
    const other = theirItems.get(item.id);
    if (!other) {
      send.push({ t: 'add', id: item.id, hash: item.hash, name: item.name, folder: item.folder, ...(item.refs[0] ? { ref: item.refs[0] } : {}), v: item.nameV });
      continue;
    }
    if (newer(item.nameV, other.nameV)) send.push({ t: 'rename', id: item.id, name: item.name, v: item.nameV });
    if (newer(item.folderV, other.folderV)) send.push({ t: 'move', id: item.id, folder: item.folder, v: item.folderV });
    if (!item.holders.includes(other.nameV.device) && other.hash === item.hash) send.push({ t: 'have', id: item.id, hash: item.hash, v: { counter: mine.clock, device } });
  }
  const missing = theirs.items.filter((i) => !mine.items[i.id] && !resolveId(mine, i.id) && !mine.tombstones[i.id] && !mine.hidden.includes(i.hash)).map((i) => i.id);
  return { send, missing };
}

/** One page of the full-list comparison: only ids in [lo, hi] (the first page starts at '', the last ends at HI_ID). */
export type DigestPage = Digest & { lo: string; hi: string; page: number; pages: number };
export const HI_ID = '\uffff';
export const DIGEST_PAGE_SIZE = 400; // ~400 items * ~170 bytes stays far below the 1 MB blob

/** Splits my digest into pages by sorted id; an empty state is one empty page covering everything. */
export function digestPages(state: SyncState, pageSize = DIGEST_PAGE_SIZE): DigestPage[] {
  const all = digestOf(state);
  const ids = [...new Set([...all.items.map((i) => i.id), ...all.tombstones.map((t) => t.id)])].sort();
  const pages = Math.max(1, Math.ceil(ids.length / pageSize));
  return Array.from({ length: pages }, (_, k) => {
    const slice = ids.slice(k * pageSize, (k + 1) * pageSize);
    const lo = k === 0 ? '' : slice[0];
    const hi = k === pages - 1 ? HI_ID : slice[slice.length - 1];
    const has = new Set(slice);
    return { items: all.items.filter((i) => has.has(i.id)), tombstones: all.tombstones.filter((t) => has.has(t.id)), lo, hi, page: k, pages };
  });
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isVersion = (v: unknown): v is Version => !!v && typeof v === 'object' && Number.isInteger((v as Version).counter) && (v as Version).counter >= 0 && (v as Version).counter < 2 ** 40 && typeof (v as Version).device === 'string' && ID_RE.test((v as Version).device);
const isRef = (v: unknown): v is string => isText(v) && v.startsWith('Shared/') && !v.includes('..') && !v.includes('\\');
const isText = (v: unknown, max = 255): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f]/.test(v);

/** Validates an untrusted event from the partner; null when anything is off. */
export function parseEvent(raw: unknown): SyncEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id) || !isVersion(e.v)) return null;
  switch (e.t) {
    case 'add':
      if (!isSha256(e.hash) || !isText(e.name) || !isText(e.folder)) return null;
      if (e.ref !== undefined && !isRef(e.ref)) return null;
      return { t: 'add', id: e.id, hash: e.hash, name: e.name, folder: e.folder, ...(e.ref !== undefined ? { ref: e.ref as string } : {}), v: e.v };
    case 'rename':
      return isText(e.name) ? { t: 'rename', id: e.id, name: e.name, v: e.v } : null;
    case 'move':
      return isText(e.folder) ? { t: 'move', id: e.id, folder: e.folder, v: e.v } : null;
    case 'del-both':
      return isSha256(e.hash) && typeof e.at === 'number' && Number.isFinite(e.at) && e.at > 0 ? { t: 'del-both', id: e.id, hash: e.hash, v: e.v, at: e.at } : null;
    case 'have':
      return isSha256(e.hash) ? { t: 'have', id: e.id, hash: e.hash, v: e.v } : null;
    default:
      return null;
  }
}

/** Validates an untrusted digest page. */
export function parseDigestPage(raw: unknown): DigestPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.items) || !Array.isArray(d.tombstones) || d.items.length > DIGEST_PAGE_SIZE || d.tombstones.length > DIGEST_PAGE_SIZE) return null;
  if (typeof d.lo !== 'string' || typeof d.hi !== 'string' || d.lo.length > 64 || d.hi.length > 64 || d.lo > d.hi) return null;
  if (!Number.isInteger(d.page) || !Number.isInteger(d.pages) || (d.page as number) < 0 || (d.pages as number) < 1 || (d.page as number) >= (d.pages as number)) return null;
  const items: Digest['items'] = [];
  for (const i of d.items as Record<string, unknown>[]) {
    if (!i || typeof i.id !== 'string' || !ID_RE.test(i.id) || !isSha256(i.hash) || !isVersion(i.nameV) || !isVersion(i.folderV)) return null;
    items.push({ id: i.id, hash: i.hash, nameV: i.nameV, folderV: i.folderV });
  }
  const tombstones: Digest['tombstones'] = [];
  for (const t of d.tombstones as Record<string, unknown>[]) {
    if (!t || typeof t.id !== 'string' || !ID_RE.test(t.id) || !isSha256(t.hash) || !isVersion(t.v) || typeof t.at !== 'number' || !Number.isFinite(t.at)) return null;
    tombstones.push({ id: t.id, hash: t.hash, v: t.v, at: t.at });
  }
  return { items, tombstones, lo: d.lo, hi: d.hi, page: d.page as number, pages: d.pages as number };
}

/** The item a shared path belongs to (any of its refs, or an alias's), or null. */
export function itemByRef(state: SyncState, ref: string): SyncItem | null {
  return Object.values(state.items).find((i) => i.refs.includes(ref)) ?? null;
}

/** Every shared path an event touches, read BEFORE it is applied (a delete removes the item that knew them). */
export function refsAffected(state: SyncState, ev: SyncEvent): string[] {
  if (ev.t !== 'del-both') return [];
  return [...new Set(Object.values(state.items).filter((i) => i.id === ev.id || i.aliases.includes(ev.id) || i.hash === ev.hash).flatMap((i) => i.refs))];
}

/** The content is on both phones once two different devices reported it. */
export const onBothPhones = (item: SyncItem): boolean => new Set(item.holders).size >= 2;
