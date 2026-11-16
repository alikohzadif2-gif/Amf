import type { PartnerMessage } from './types';

export type MailboxConnection = { url: string; token: string };
export type MailboxErrorKind = 'network' | 'unauthorized' | 'http' | 'protocol';

export class MailboxError extends Error {
  constructor(
    readonly kind: MailboxErrorKind,
    readonly status = 0,
    readonly errorKey?: string,
  ) {
    super(kind === 'http' ? `Mailbox HTTP ${status}` : `Mailbox ${kind}`);
    this.name = 'MailboxError';
  }
}

export const isMailboxError = (value: unknown): value is MailboxError =>
  value instanceof Error && value.name === 'MailboxError';

export type MailboxMe = {
  deviceId: string;
  role: 'owner' | 'member';
  household: { partner: { deviceId: string; name: string } | null };
  features: string[];
};
export type MailboxInvite = { code: string; expiresAt: string; link: string };
export type MailboxJoin = { deviceId: string; token: string };
export type MailboxEnvelope = { seq: number; time: string; body: Record<string, unknown> };
export type MailboxPage = { messages: MailboxEnvelope[]; cursor: string };
/** Which system notifications this phone wants (S11, API_CONTRACT D.11). */
export type PushNotifyChoice = { mood: boolean; event: boolean; diary: boolean; period: boolean };
export type MailboxPublishResult = { seq: number; time: string };
export type E2eQueuePage = { messages: { seq: number; time: string; id: string; blob: string }[]; cursor: string; more: boolean };

type FetchLike = typeof fetch;
type RequestOptions = {
  method?: string;
  body?: string;
  authenticated?: boolean;
};

const normalizeBase = (value: string) => value.trim().replace(/\/+$/, '');
const validSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function apiUrl(base: string, path: string, query?: Record<string, string | number>) {
  const url = new URL(`${normalizeBase(base)}/api/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

async function request<T>(
  base: string,
  token: string | undefined,
  path: string,
  options: RequestOptions = {},
  fetcher: FetchLike = fetch,
  query?: Record<string, string | number>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(apiUrl(base, path, query), {
      method: options.method ?? 'GET',
      headers: {
        ...(options.authenticated === false || !token ? {} : { Authorization: `Bearer ${token}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body,
    });
  } catch {
    throw new MailboxError('network');
  }

  if (response.status === 401 || response.status === 403) {
    throw new MailboxError('unauthorized', response.status);
  }
  if (!response.ok) {
    let key: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === 'string') key = body.error;
    } catch {
      // The status still identifies the failure when an error body is not JSON.
    }
    throw new MailboxError('http', response.status, key);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new MailboxError('protocol', response.status);
  }
}

export class MailboxClient {
  readonly url: string;

  constructor(
    private readonly connection: MailboxConnection,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.url = normalizeBase(connection.url);
  }

  me(): Promise<MailboxMe> {
    return request(this.url, this.connection.token, '/me', {}, this.fetcher);
  }

  createInvite(): Promise<MailboxInvite> {
    return request(this.url, this.connection.token, '/invites', { method: 'POST' }, this.fetcher);
  }

  publish(body: PartnerMessage): Promise<MailboxPublishResult> {
    return request<MailboxPublishResult>(
      this.url,
      this.connection.token,
      '/mailbox',
      { method: 'POST', body: JSON.stringify(body) },
      this.fetcher,
    );
  }

  /** Encrypted queue (sharing track, stage 3): `blob` is base64url of an opaque encrypted message; `wake` asks for a generic visible push. */
  e2ePost(id: string, blob: string, wake: boolean): Promise<{ seq: number; time: string; duplicate?: true }> {
    return request(this.url, this.connection.token, '/e2e/queue', { method: 'POST', body: JSON.stringify({ id, blob, wake }) }, this.fetcher);
  }

  /** Blobs waiting for this phone after `since`; reading deletes nothing (only `e2eAck` does). */
  e2eList(since: string, limit = 20): Promise<E2eQueuePage> {
    return request<E2eQueuePage>(this.url, this.connection.token, '/e2e/queue', {}, this.fetcher, { since, limit });
  }

  e2eAck(seqs: number[]): Promise<{ deleted: number }> {
    return request(this.url, this.connection.token, '/e2e/ack', { method: 'POST', body: JSON.stringify({ seqs }) }, this.fetcher);
  }

  poll(since: string, limit = 100): Promise<MailboxPage> {
    return request<MailboxPage>(
      this.url,
      this.connection.token,
      '/mailbox',
      {},
      this.fetcher,
      { since, limit },
    ).then((page: MailboxPage) => {
      if (
        !page ||
        !Array.isArray(page.messages) ||
        typeof page.cursor !== 'string' ||
        !/^\d{1,20}$/.test(page.cursor) ||
        page.messages.some((message) => !validSeq(message?.seq) || typeof message.time !== 'string' || !message.body || typeof message.body !== 'object')
      ) {
        throw new MailboxError('protocol');
      }
      return page;
    });
  }

  /**
   * S9 server route: registers this phone's FCM token and UI language (answers `{ registered: true }`).
   * S11: `notify` says which system notifications this phone wants (`false` = the server skips the FCM send
   * for that type, API_CONTRACT D.11); left out = the server keeps what it has.
   */
  registerPushToken(fcmToken: string, lang: string, notify?: PushNotifyChoice): Promise<{ registered: boolean }> {
    return request(
      this.url,
      this.connection.token,
      '/push/token',
      { method: 'PUT', body: JSON.stringify(notify ? { fcmToken, lang, notify } : { fcmToken, lang }) },
      this.fetcher,
    );
  }

  /** Idempotent on the server (answers `{ removed: true }`). */
  removePushToken(): Promise<{ removed: boolean }> {
    return request(this.url, this.connection.token, '/push/token', { method: 'DELETE' }, this.fetcher);
  }

  revoke(deviceId: string): Promise<{ revoked: boolean }> {
    return request(
      this.url,
      this.connection.token,
      `/devices/${encodeURIComponent(deviceId)}`,
      { method: 'DELETE' },
      this.fetcher,
    );
  }
}

/** Public, single-use invite exchange. The returned token must be stored in SecureStore. */
export function joinMailbox(
  url: string,
  code: string,
  deviceName: string,
  fetcher: FetchLike = fetch,
): Promise<MailboxJoin> {
  return request(
    url,
    undefined,
    '/join',
    { method: 'POST', authenticated: false, body: JSON.stringify({ code, deviceName }) },
    fetcher,
  );
}

export type MailboxSource = 'replay' | 'live';

export type ListenerState = 'connecting' | 'connected' | 'offline' | 'stopped' | 'unauthorized';

export type MailboxSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
};
export type MailboxSocketFactory = (url: string, headers: Record<string, string>) => MailboxSocket;

/** React Native supports auth headers in the third WebSocket argument. Never put tokens in URLs. */
const defaultSocket: MailboxSocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (
    url: string,
    protocols?: string[],
    options?: { headers: Record<string, string> },
  ) => MailboxSocket)(url, undefined, { headers });

function websocketUrl(base: string, since: string, path: string) {
  const url = new URL(`${normalizeBase(base)}/api/v1${path}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('since', since);
  return url.toString();
}

export type MailboxListenerOptions = {
  connection: MailboxConnection;
  since: () => string;
  /** `replay` = fetched over HTTP before the socket opens; `live` = arrived on the open WebSocket. */
  onMessage: (message: MailboxEnvelope, source: MailboxSource) => void | Promise<void>;
  onState?: (state: ListenerState) => void;
  fetcher?: FetchLike;
  createSocket?: MailboxSocketFactory;
  retryMs?: { min: number; max: number };
  /** Stage 3: which channel to follow. Default = the plain mailbox. The encrypted queue passes `/e2e/ws` and its own page reader. */
  wsPath?: string;
  poll?: (client: MailboxClient, cursor: string) => Promise<MailboxPage>;
};

/** Replays missed rows over HTTP before each WebSocket connection, then reconnects with the new cursor. */
export class MailboxListener {
  private socket: MailboxSocket | null = null;
  private stopped = true;
  private delay = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: MailboxListenerOptions) {}

  start() {
    if (this.stopped) {
      this.stopped = false;
      void this.connect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    this.options.onState?.('stopped');
  }

  private async replay() {
    const client = new MailboxClient(this.options.connection, this.options.fetcher);
    let cursor = this.options.since();
    for (let pageNumber = 0; pageNumber < 20 && !this.stopped; pageNumber += 1) {
      const page = await (this.options.poll ? this.options.poll(client, cursor) : client.poll(cursor));
      for (const message of page.messages) {
        if (this.stopped) return;
        if (message.seq <= Number(cursor)) continue;
        await this.options.onMessage(message, 'replay');
      }
      if (page.messages.length === 0 || page.cursor === cursor) return;
      cursor = page.cursor;
    }
  }

  private async connect() {
    if (this.stopped) return;
    this.options.onState?.('connecting');
    try {
      await this.replay();
      if (this.stopped) return;
      const socket = (this.options.createSocket ?? defaultSocket)(
        websocketUrl(this.options.connection.url, this.options.since(), this.options.wsPath ?? '/mailbox/ws'),
        { Authorization: `Bearer ${this.options.connection.token}` },
      );
      this.socket = socket;
      socket.onopen = () => {
        this.delay = 0;
        this.options.onState?.('connected');
      };
      socket.onmessage = (event) => {
        let frame: { type?: unknown; seq?: unknown; time?: unknown; body?: unknown };
        try {
          frame = JSON.parse(String(event.data)) as typeof frame;
        } catch {
          return;
        }
        if (
        frame.type !== 'message' ||
          !validSeq(frame.seq) ||
          typeof frame.time !== 'string' ||
          !frame.body ||
          typeof frame.body !== 'object'
        ) {
          return;
        }
        const message = { seq: frame.seq, time: frame.time, body: frame.body as Record<string, unknown> };
        this.queue = this.queue
          .then(() => this.options.onMessage(message, 'live'))
          .catch(() => {
            this.socket?.close();
          });
      };
      const lost = (code?: number) => {
        if (this.stopped || this.socket !== socket) return;
        this.socket = null;
        if (code === 4401) {
          this.stopped = true;
          this.options.onState?.('unauthorized');
          return;
        }
        this.options.onState?.('offline');
        const { min, max } = this.options.retryMs ?? { min: 1000, max: 30_000 };
        this.delay = Math.min(max, this.delay === 0 ? min : this.delay * 2);
        this.retry = setTimeout(() => {
          this.retry = null;
          void this.connect();
        }, this.delay);
      };
      socket.onclose = (event) => lost(event.code);
      socket.onerror = () => lost();
    } catch (error) {
      if (this.stopped) return;
      if (isMailboxError(error) && error.kind === 'unauthorized') {
        this.stopped = true;
        this.options.onState?.('unauthorized');
        return;
      }
      this.options.onState?.('offline');
      const { min, max } = this.options.retryMs ?? { min: 1000, max: 30_000 };
      this.delay = Math.min(max, this.delay === 0 ? min : this.delay * 2);
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.connect();
      }, this.delay);
    }
  }
}

/** The encrypted queue as a mailbox channel: the listener replays over HTTP, then follows `/e2e/ws`. The body is `{ id, blob }`. */
export const e2eChannel: Pick<MailboxListenerOptions, 'wsPath' | 'poll'> = {
  wsPath: '/e2e/ws',
  poll: async (client, cursor) => {
    const page = await client.e2eList(cursor, 20);
    if (!page || !Array.isArray(page.messages) || typeof page.cursor !== 'string' || !/^\d{1,20}$/.test(page.cursor)) throw new MailboxError('protocol');
    return { cursor: page.cursor, messages: page.messages.map((m) => ({ seq: m.seq, time: m.time, body: { id: m.id, blob: m.blob } })) };
  },
};
