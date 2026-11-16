import { ServerError } from './errors';
import type {
  Endpoint,
  FetchLike,
  ServerChanges,
  ServerItem,
  ServerMe,
  ServerPing,
  ServerRoot,
  ServerTreePage,
  UploadSession,
} from './types';

const API = '/api/v1';
const DEFAULT_TIMEOUT_MS = 15000;

export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

export function isValidServerUrl(input: string): boolean {
  try {
    const url = new URL(normalizeUrl(input));
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Thin typed wrapper over the file-server HTTP contract (docs/API_CONTRACT.md A). */
/** Seconds from the `Retry-After` header, else the JSON body's `retryAfter`; clamped to 1..86400, undefined when absent. */
export async function retryAfterOf(response: { headers?: { get(name: string): string | null }; json(): Promise<unknown> }): Promise<number | undefined> {
  const clamp = (n: number) => Math.min(86_400, Math.max(1, Math.ceil(n)));
  const header = Number(response.headers?.get('retry-after') ?? '');
  if (Number.isFinite(header) && header > 0) return clamp(header);
  try {
    const body = (await response.json()) as { retryAfter?: unknown } | null;
    const n = typeof body?.retryAfter === 'number' ? body.retryAfter : Number.NaN;
    return Number.isFinite(n) && n > 0 ? clamp(n) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * React Native's `fetch` (whatwg-fetch) turns a Uint8Array body into a Blob and then throws
 * "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported": every upload chunk failed on the phone.
 * XMLHttpRequest sends a typed array natively (base64), so binary bodies go through it; everything else uses `fetch`.
 */
export const defaultFetch: FetchLike = (input, init) => {
  const body = init?.body;
  // Only inside React Native (Node, used by the tests, has a fetch that sends typed arrays and no XMLHttpRequest).
  const reactNative = typeof navigator !== 'undefined' && (navigator as { product?: string }).product === 'ReactNative';
  if (!reactNative || typeof XMLHttpRequest === 'undefined' || !(body instanceof Uint8Array)) {
    return fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>;
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    xhr.open(init?.method ?? 'POST', input);
    for (const [name, value] of Object.entries(init?.headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.responseType = 'text';
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      const headers = new Map<string, string>();
      for (const line of (xhr.getAllResponseHeaders() ?? '').split(/\r?\n/)) {
        const at = line.indexOf(':');
        if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
      }
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => JSON.parse(text) as unknown,
      });
    };
    xhr.onerror = () => fail(new TypeError('Network request failed'));
    xhr.ontimeout = () => fail(new TypeError('Network request timed out'));
    xhr.onabort = () => fail(new Error('Aborted'));
    init?.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body as unknown as XMLHttpRequestBodyInit);
  });
};

export class ServerClient {
  readonly baseUrl: string;

  constructor(
    endpoint: Pick<Endpoint, 'url' | 'token'>,
    private readonly fetcher: FetchLike = defaultFetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.baseUrl = normalizeUrl(endpoint.url);
    this.token = endpoint.token;
  }

  private readonly token: string;

  /** Headers for any authenticated request, also used for images and video. */
  authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Absolute URL of an API path (no token inside the URL). */
  url(path: string, query?: Record<string, string | number | undefined>): string {
    let out = `${this.baseUrl}${API}${path}`;
    if (query) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
      if (parts.length > 0) out += `?${parts.join('&')}`;
    }
    return out;
  }

  private async request(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; query?: Record<string, string | number | undefined> } = {},
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Racing a timer as well as aborting: some fetch implementations ignore abort.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ServerError('timeout'));
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetcher(this.url(path, init.query), {
          method: init.method ?? 'GET',
          headers: { ...this.authHeaders(), ...init.headers },
          body: init.body,
          signal: controller.signal,
        }),
        timedOut,
      ]);
      if (response.status === 401 || response.status === 403) {
        throw new ServerError('unauthorized', response.status);
      }
      // `rate_limited` and `locked_out` both answer 429 (contract D.7/D.12): the saved server and token stay.
      if (response.status === 429) throw new ServerError('http', 429, 'busy', await retryAfterOf(response));
      return response;
    } catch (error) {
      if (error instanceof ServerError) throw error;
      if (controller.signal.aborted) throw new ServerError('timeout');
      throw new ServerError('network', 0, error instanceof Error ? error.message : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(
    path: string,
    init?: Parameters<ServerClient['request']>[1],
  ): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw new ServerError('http', response.status);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ServerError('protocol', response.status, 'invalid JSON');
    }
  }

  /** Public route. The answer must look like a meYou server, otherwise `protocol` (some other web server answered). */
  async ping(): Promise<ServerPing> {
    const data = await this.json<Partial<ServerPing>>('/ping');
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.name !== 'string' ||
      typeof data.version !== 'string' ||
      !Array.isArray(data.features) ||
      !data.features.every((f) => typeof f === 'string')
    ) {
      throw new ServerError('protocol', 200, 'not a meYou server');
    }
    return data as ServerPing;
  }

  /** Who this token belongs to (contract section D.4). */
  me(): Promise<ServerMe> {
    return this.json<ServerMe>('/me');
  }

  roots(): Promise<ServerRoot[]> {
    return this.json<ServerRoot[]>('/roots');
  }

  tree(root: string, path: string, cursor?: string, limit?: number): Promise<ServerTreePage> {
    return this.json<ServerTreePage>('/tree', { query: { root, path, cursor, limit } });
  }

  changes(since?: string): Promise<ServerChanges> {
    return this.json<ServerChanges>('/changes', { query: { since } });
  }

  thumbUrl(serverId: string, size: number): string {
    return this.url(`/items/${encodeURIComponent(serverId)}/thumb`, { size });
  }

  previewUrl(serverId: string): string {
    return this.url(`/items/${encodeURIComponent(serverId)}/preview`);
  }

  fileUrl(serverId: string): string {
    return this.url(`/items/${encodeURIComponent(serverId)}/file`);
  }

  createUpload(input: { name: string; size: number; rootId: string; path: string; md5?: string; mtime?: string }): Promise<UploadSession> {
    return this.json<UploadSession>('/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  /**
   * Sends one chunk. Returns the server's new offset. When the server's offset
   * differs from ours it answers 409 with `{ offset }`; that offset is returned
   * so the caller can re-sync instead of failing.
   */
  async patchUpload(uploadId: string, offset: number, chunk: Uint8Array): Promise<number> {
    const response = await this.request(`/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'PATCH',
      headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
      body: chunk,
    });
    if (response.ok || response.status === 409) {
      let body: { offset?: unknown } = {};
      try {
        body = (await response.json()) as { offset?: unknown };
      } catch {
        // handled below
      }
      if (typeof body.offset === 'number') return body.offset;
      throw new ServerError('protocol', response.status, 'missing offset');
    }
    throw new ServerError('http', response.status);
  }

  completeUpload(uploadId: string): Promise<ServerItem> {
    return this.json<ServerItem>(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' });
  }
}
