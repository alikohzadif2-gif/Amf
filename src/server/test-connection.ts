import type { TestCode } from '../storage/types';
import { ServerClient } from './client';
import { isServerError } from './errors';
import type { FetchLike, ServerMe, ServerPing } from './types';

/**
 * Why a connection test failed (codes only; the UI maps them to fa/en text in
 * `connectionMessageKey`). React Native's fetch hides the native cause of a network
 * failure, so `unreachable` covers: no internet, wrong address, server down, and (on
 * https) a certificate the phone does not trust. `certificate` is used only when the
 * error text says so.
 */
export type ConnectionIssue =
  | 'unauthorized'
  | 'unreachable'
  | 'timeout'
  | 'certificate'
  | 'not-meyou'
  | 'busy'
  | 'server-error';

export type ConnectionTest = {
  ok: boolean;
  /** Coarse code shared with the Library sources. */
  code: TestCode;
  issue?: ConnectionIssue;
  latencyMs: number;
  /** Only for `busy` (429 `rate_limited` or `locked_out`): seconds until the server accepts requests again. */
  retryAfter?: number;
  ping?: ServerPing;
  /** Who this token is; absent on servers that do not implement `/me` yet. */
  me?: ServerMe;
  rootCount?: number;
};

const CERT_HINT = /ssl|\btls\b|certificate|certpath|cert\.|cert_|trust anchor|handshake|self[- ]signed/i;

export function classifyFailure(error: unknown): ConnectionIssue {
  if (!isServerError(error)) return 'unreachable';
  switch (error.kind) {
    case 'unauthorized':
      return 'unauthorized';
    case 'timeout':
      return 'timeout';
    case 'protocol':
      return 'not-meyou';
    case 'network':
      return CERT_HINT.test(error.message) ? 'certificate' : 'unreachable';
    case 'http':
      if (error.status === 429) return 'busy';
      if (error.status === 502 || error.status === 503 || error.status === 504) return 'unreachable';
      if (error.status >= 500) return 'server-error';
      // 404, 405 ...: something answered, but not the meYou API.
      return 'not-meyou';
  }
}

function codeFor(issue: ConnectionIssue): TestCode {
  if (issue === 'unauthorized') return 'unauthorized';
  if (issue === 'unreachable' || issue === 'timeout' || issue === 'certificate') return 'unavailable';
  return 'error';
}

/**
 * One server address: ping (is it a meYou server?), roots (proves the token works),
 * then /me (who am I; optional, a server without it still counts as connected).
 */
export async function testConnection(
  endpoint: { url: string; token: string },
  fetcher?: FetchLike,
  timeoutMs?: number,
): Promise<ConnectionTest> {
  const started = Date.now();
  try {
    const client = new ServerClient(endpoint, fetcher, timeoutMs);
    const ping = await client.ping();
    const roots = await client.roots();
    let me: ServerMe | undefined;
    try {
      me = await client.me();
    } catch (error) {
      // Only "route does not exist" is tolerated; a 401/timeout here is a real failure.
      if (!(isServerError(error) && error.kind === 'http' && error.status === 404)) throw error;
    }
    return { ok: true, code: 'ok', latencyMs: Date.now() - started, ping, me, rootCount: roots.length };
  } catch (error) {
    const issue = classifyFailure(error);
    const retryAfter = issue === 'busy' && isServerError(error) ? error.retryAfter : undefined;
    return { ok: false, code: codeFor(issue), issue, latencyMs: Date.now() - started, ...(retryAfter ? { retryAfter } : {}) };
  }
}
