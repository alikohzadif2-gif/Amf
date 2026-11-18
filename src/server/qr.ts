import { isValidServerUrl, normalizeUrl } from './client';

/**
 * QR payload written by the server installer (docs/API_CONTRACT.md, section C).
 * Accepted forms:
 *   JSON:  {"url":"https://host:8443","token":"...","name":"Home","fp":"AB:CD:.."}
 *   Link:  meyou://server?url=<encoded>&token=<encoded>&name=<encoded>&fp=<encoded>
 */
export type QrServer = { url: string; token: string; name?: string; fingerprint?: string };

/** Validates and normalizes the four fields of a server code (also used by the deep link route). */
export function buildQrServer(url: unknown, token: unknown, name: unknown, fp: unknown): QrServer | null {
  if (typeof url !== 'string' || typeof token !== 'string') return null;
  const cleanToken = token.trim();
  if (cleanToken === '' || !isValidServerUrl(url)) return null;
  return {
    url: normalizeUrl(url),
    token: cleanToken,
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined,
    fingerprint: typeof fp === 'string' && fp.trim() !== '' ? fp.trim() : undefined,
  };
}

export function parseServerQr(raw: string): QrServer | null {
  const text = raw.trim();
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      return buildQrServer(data.url, data.token, data.name, data.fp ?? data.fingerprint);
    } catch {
      return null;
    }
  }
  const match = /^meyou:\/\/server\?(.*)$/i.exec(text);
  if (!match) return null;
  const params = new Map<string, string>();
  for (const part of match[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      params.set(decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  return buildQrServer(params.get('url'), params.get('token'), params.get('name'), params.get('fp'));
}
