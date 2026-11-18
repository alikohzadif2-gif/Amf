/**
 * Pairing by link. The two payloads of the in-person pairing (`meyou-e2e1:req:...` and `meyou-e2e1:key:...`)
 * can also travel as a link through any messenger. The cryptography is the same: nothing here is secret enough to
 * matter on its own, because the keys only become usable after both phones show the same safety code (`confirm()`),
 * and that code is compared outside the link (a voice call). A link that was changed on the way shows different codes.
 */
export type PairingPayloadKind = 'req' | 'key';

const BASE = 'meyou://settings/secure-pairing';
const PAYLOAD = /meyou-e2e1:(?:req|key):[A-Za-z0-9_.-]+/;

export function kindOfPayload(payload: string): PairingPayloadKind | null {
  if (payload.startsWith('meyou-e2e1:req:')) return 'req';
  if (payload.startsWith('meyou-e2e1:key:')) return 'key';
  return null;
}

/** The link that opens the pairing screen with this payload, or null when it is not a pairing payload. */
export function toPairingLink(payload: string): string | null {
  return PAYLOAD.test(payload) && kindOfPayload(payload) ? `${BASE}?c=${encodeURIComponent(payload)}` : null;
}

/** Accepts the link, a message that contains the link, or the raw payload. Returns the payload or null. */
export function payloadFromText(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep the raw text: it may already be the plain payload
  }
  const found = PAYLOAD.exec(decoded) ?? PAYLOAD.exec(raw);
  return found ? found[0] : null;
}
