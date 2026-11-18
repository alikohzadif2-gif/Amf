import { b64urlDecode, b64urlEncode } from './base64';
import {
  KEY_LEN,
  buildKeyQr,
  buildRequestQr,
  deriveDirectionKeys,
  newKeyPair,
  newMasterKey,
  newNonce,
  openPairingKey,
  parseDirectKey,
  parseKeyQr,
  parseRequestQr,
  safetyCode,
  sealPairingKey,
  type DirectionKeys,
  type Role,
  type Sodium,
} from './crypto';
import type { KvStore } from './key-store';

/**
 * Pairing of the two phones, in person, with two QR codes (stage 1 of the sharing track):
 *   Phone B  startRequest()   shows QR 1 = {B's public key, a one-time nonce}
 *   Phone A  acceptRequest()  scans QR 1, makes the master key, shows QR 2 = master key sealed to B's public key
 *   Phone B  acceptKey()      scans QR 2 and opens it
 *   both     confirm()        after comparing the same 12-digit safety code
 * Nothing here touches the server. Keys are only usable (`getKeys`) after `confirm()` on this phone.
 *
 * One-QR pairing (the normal way, `createDirect` / `acceptDirect`): the owner's invitation QR already carries the
 * master key next to the server invite, so ONE scan in person connects the phone to the server and gives it the
 * keys. There is no second QR and no code to compare: the key travels only camera-to-screen, never through the
 * server or a messenger, so nobody can swap it. The in-person two-QR flow above stays for pairing from a distance.
 */
const KEY_RECORD = 'meyou-e2e-v1';
const PENDING_RECORD = 'meyou-e2e-pending-v1';
/** QR 1 stays valid this long. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

type KeyRecord = { role: Role; sk: string; pk: string; partnerPk: string; master: string; confirmed: boolean; createdAt: number };
type Pending = { sk: string; pk: string; nonce: string; createdAt: number };

export type E2eStatus =
  | { state: 'none' }
  | { state: 'waiting-key' } // B showed QR 1 and waits for QR 2
  | { state: 'unconfirmed'; code: string; role: Role }
  | { state: 'paired'; code: string; role: Role; createdAt: number };

export type StartResult = { ok: true; qr: string } | { ok: false; reason: 'already' | 'storage' };
export type AcceptRequestResult = { ok: true; qr: string; code: string } | { ok: false; reason: 'invalid' | 'already' | 'storage' };
export type AcceptKeyResult = { ok: true; code: string } | { ok: false; reason: 'invalid' | 'no-pending' | 'expired' | 'wrong' | 'already' | 'storage' };

export function createE2ePairing(deps: { sodium: Sodium; store: KvStore; now?: () => number }) {
  const { sodium: s, store } = deps;
  const now = deps.now ?? Date.now;
  const dec = (text: string) => b64urlDecode(text) ?? new Uint8Array(0);

  async function readRecord(): Promise<KeyRecord | null> {
    const raw = await store.get(KEY_RECORD);
    if (!raw) return null;
    try {
      const r = JSON.parse(raw) as KeyRecord;
      return r && typeof r.master === 'string' && (r.role === 'a' || r.role === 'b') ? r : null;
    } catch {
      return null;
    }
  }
  async function readPending(): Promise<Pending | null> {
    const raw = await store.get(PENDING_RECORD);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Pending;
      return p && typeof p.sk === 'string' && typeof p.nonce === 'string' ? p : null;
    } catch {
      return null;
    }
  }
  const codeOf = (r: KeyRecord) => {
    // One-QR pairing has no public keys to mix in: the code is then derived from the shared key alone, so both phones agree.
    if (!r.partnerPk) return safetyCode(s, dec(r.master), new Uint8Array(0), new Uint8Array(0));
    const a = r.role === 'a' ? dec(r.pk) : dec(r.partnerPk);
    const b = r.role === 'a' ? dec(r.partnerPk) : dec(r.pk);
    return safetyCode(s, dec(r.master), a, b);
  };

  /** Phone B: new request. A confirmed pairing must be removed with `reset()` first, never overwritten silently. */
  async function startRequest(): Promise<StartResult> {
    const existing = await readRecord();
    if (existing?.confirmed) return { ok: false, reason: 'already' };
    try {
      const kp = newKeyPair(s);
      const nonce = newNonce(s);
      await store.remove(KEY_RECORD); // an old unconfirmed attempt
      await store.set(PENDING_RECORD, JSON.stringify({ sk: b64urlEncode(kp.privateKey), pk: b64urlEncode(kp.publicKey), nonce: b64urlEncode(nonce), createdAt: now() } satisfies Pending));
      return { ok: true, qr: buildRequestQr(kp.publicKey, nonce) };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  /** Phone A: reads QR 1, creates the master key and the sealed QR 2. Waits for `confirm()`. */
  async function acceptRequest(rawQr1: string): Promise<AcceptRequestResult> {
    const request = parseRequestQr(rawQr1);
    if (!request) return { ok: false, reason: 'invalid' };
    const existing = await readRecord();
    if (existing?.confirmed) return { ok: false, reason: 'already' };
    try {
      const own = newKeyPair(s);
      const master = newMasterKey(s);
      const sealed = sealPairingKey(s, { master, ownPublicKey: own.publicKey, nonce: request.nonce }, request.publicKey);
      const record: KeyRecord = { role: 'a', sk: b64urlEncode(own.privateKey), pk: b64urlEncode(own.publicKey), partnerPk: b64urlEncode(request.publicKey), master: b64urlEncode(master), confirmed: false, createdAt: now() };
      await store.remove(PENDING_RECORD);
      await store.set(KEY_RECORD, JSON.stringify(record));
      return { ok: true, qr: buildKeyQr(sealed), code: codeOf(record) };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  /** Phone B: reads QR 2 and opens it with the key pair of the pending request. */
  async function acceptKey(rawQr2: string): Promise<AcceptKeyResult> {
    const sealed = parseKeyQr(rawQr2);
    if (!sealed) return { ok: false, reason: 'invalid' };
    if ((await readRecord())?.confirmed) return { ok: false, reason: 'already' };
    const pending = await readPending();
    if (!pending) return { ok: false, reason: 'no-pending' };
    if (now() - pending.createdAt > REQUEST_TTL_MS) {
      await store.remove(PENDING_RECORD);
      return { ok: false, reason: 'expired' };
    }
    const own = { publicKey: dec(pending.pk), privateKey: dec(pending.sk) };
    const opened = openPairingKey(s, sealed, own, dec(pending.nonce));
    if (!opened || opened.master.length !== KEY_LEN) return { ok: false, reason: 'wrong' };
    try {
      const record: KeyRecord = { role: 'b', sk: pending.sk, pk: pending.pk, partnerPk: b64urlEncode(opened.partnerPublicKey), master: b64urlEncode(opened.master), confirmed: false, createdAt: now() };
      await store.set(KEY_RECORD, JSON.stringify(record));
      await store.remove(PENDING_RECORD);
      return { ok: true, code: codeOf(record) };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  /** The person saw the same code on both phones. */
  async function confirm(): Promise<boolean> {
    const r = await readRecord();
    if (!r) return false;
    if (r.confirmed) return true;
    try {
      await store.set(KEY_RECORD, JSON.stringify({ ...r, confirmed: true }));
      return true;
    } catch {
      return false;
    }
  }

  /** Drops an attempt that is not confirmed (codes differ, cancel). A confirmed pairing is untouched. */
  async function cancel(): Promise<void> {
    await store.remove(PENDING_RECORD);
    const r = await readRecord();
    if (r && !r.confirmed) await store.remove(KEY_RECORD);
  }

  /** Deletes everything, including a confirmed pairing. The caller asks the person first. */
  async function reset(): Promise<void> {
    await store.remove(PENDING_RECORD);
    await store.remove(KEY_RECORD);
  }

  /**
   * Owner phone, one-QR pairing: returns the master key (base64url) to put inside the invitation QR.
   * Idempotent: every invitation of the same unpaired owner carries the SAME key, so an older QR that is still
   * valid on the server can never give the partner a key the owner does not have.
   */
  async function createDirect(): Promise<{ ok: true; key: string } | { ok: false; reason: 'storage' }> {
    try {
      const existing = await readRecord();
      if (existing?.role === 'a' && existing.confirmed && dec(existing.master).length === KEY_LEN) return { ok: true, key: existing.master };
      const kp = newKeyPair(s);
      const master = newMasterKey(s);
      const record: KeyRecord = { role: 'a', sk: b64urlEncode(kp.privateKey), pk: b64urlEncode(kp.publicKey), partnerPk: '', master: b64urlEncode(master), confirmed: true, createdAt: now() };
      await store.remove(PENDING_RECORD);
      await store.set(KEY_RECORD, JSON.stringify(record));
      return { ok: true, key: record.master };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  /** Partner phone, one-QR pairing: stores the master key from the scanned invitation. The keys are usable at once. */
  async function acceptDirect(key: string): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'storage' }> {
    const master = parseDirectKey(key);
    if (!master) return { ok: false, reason: 'invalid' };
    try {
      const kp = newKeyPair(s);
      const record: KeyRecord = { role: 'b', sk: b64urlEncode(kp.privateKey), pk: b64urlEncode(kp.publicKey), partnerPk: '', master: b64urlEncode(master), confirmed: true, createdAt: now() };
      await store.remove(PENDING_RECORD);
      await store.set(KEY_RECORD, JSON.stringify(record));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  async function status(): Promise<E2eStatus> {
    const r = await readRecord();
    if (r) return r.confirmed ? { state: 'paired', code: codeOf(r), role: r.role, createdAt: r.createdAt } : { state: 'unconfirmed', code: codeOf(r), role: r.role };
    const p = await readPending();
    return p && now() - p.createdAt <= REQUEST_TTL_MS ? { state: 'waiting-key' } : { state: 'none' };
  }

  /** For the next stages (encrypted queue): the two direction keys and the partner's public key. Null until confirmed. */
  async function getKeys(): Promise<(DirectionKeys & { partnerPublicKey: Uint8Array; role: Role }) | null> {
    const r = await readRecord();
    if (!r?.confirmed) return null;
    return { ...deriveDirectionKeys(s, dec(r.master), r.role), partnerPublicKey: dec(r.partnerPk), role: r.role };
  }

  return { startRequest, acceptRequest, acceptKey, createDirect, acceptDirect, confirm, cancel, reset, status, getKeys };
}

export type E2ePairing = ReturnType<typeof createE2ePairing>;
