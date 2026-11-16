import type {
  ChangesResult,
  ImageRef,
  ListOptions,
  ListResult,
  ProviderCapabilities,
  ProviderChange,
  ProviderTestResult,
  StorageItem,
  StorageProvider,
  TestCode,
  UploadInput,
} from '../storage/types';
import { ServerClient } from './client';
import { isServerError, ServerError } from './errors';
import { baseName, dirId, fileId, joinPath, parentPath, parseDirId, parseFileId } from './ids';
import { uploadResumable } from './upload';
import type { Endpoint, FetchLike, OpenReader, ServerItem } from './types';

const DEFAULT_LIMIT = 100;
const EPOCH = new Date(0).toISOString();
const VERIFY_EVERY_MS = 60_000;
const CACHE_MAX = 5000;

export type ServerProviderOptions = {
  /** Endpoints in failover order (read on every call, so edits apply at once). */
  endpoints: () => Promise<Endpoint[]> | Endpoint[];
  /** When false only the first endpoint is used. */
  failover?: () => boolean;
  fetch?: FetchLike;
  openReader?: OpenReader;
  timeoutMs?: number;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function testCodeFor(error: unknown): TestCode {
  if (error instanceof ServerError) {
    if (error.kind === 'unauthorized') return 'unauthorized';
    if (error.isUnreachable) return 'unavailable';
  }
  return 'error';
}

/**
 * StorageProvider for the personal file server (docs/API_CONTRACT.md section A).
 * Several endpoints can be configured; with failover on, the next one is tried
 * when the current one is unreachable, and the working one is remembered.
 * Thumbnails, previews and originals are returned with Authorization headers
 * (ImageRef.headers / getOriginalSource), never with the token in the URL.
 */
export class ServerProvider implements StorageProvider {
  readonly kind = 'server' as const;
  readonly isMock = false;
  private active = 0;
  private verifiedAt = 0;
  private verifying: Promise<void> | null = null;
  private readonly cache = new Map<string, StorageItem>();

  constructor(
    readonly id: string,
    private readonly options: ServerProviderOptions,
  ) {}

  capabilities(): ProviderCapabilities {
    return { canUpload: true, canDelete: false, supportsChanges: true, needsPermission: false };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private makeClient(endpoint: Endpoint): ServerClient {
    return new ServerClient(endpoint, this.options.fetch, this.options.timeoutMs);
  }

  private async candidates(): Promise<Endpoint[]> {
    const all = await this.options.endpoints();
    if (all.length === 0) throw new ServerError('network', 0, 'no server configured');
    const failover = this.options.failover?.() ?? true;
    if (!failover) return [all[0]];
    const start = this.active < all.length ? this.active : 0;
    return [...all.slice(start), ...all.slice(0, start)];
  }

  /** Runs `fn` on the first reachable endpoint and remembers which one worked. */
  private async withClient<T>(fn: (client: ServerClient) => Promise<T>): Promise<T> {
    const all = await this.options.endpoints();
    const list = await this.candidates();
    let lastError: unknown = new ServerError('network');
    for (const endpoint of list) {
      try {
        const result = await fn(this.makeClient(endpoint));
        const index = all.findIndex((e) => e.id === endpoint.id);
        if (index >= 0) this.active = index;
        this.verifiedAt = this.now();
        return result;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ServerError) || !error.isUnreachable) throw error;
      }
    }
    this.verifiedAt = 0;
    throw lastError;
  }

  /** The client for building URLs; re-checks reachability at most once a minute. */
  private async urlClient(): Promise<ServerClient> {
    if (this.now() - this.verifiedAt > VERIFY_EVERY_MS) {
      if (!this.verifying) {
        this.verifying = this.withClient((client) => client.ping())
          .then(() => undefined)
          .finally(() => {
            this.verifying = null;
          });
      }
      await this.verifying;
    }
    const all = await this.options.endpoints();
    return this.makeClient(all[this.active < all.length ? this.active : 0]);
  }

  async test(): Promise<ProviderTestResult> {
    const started = this.now();
    try {
      const roots = await this.withClient(async (client) => {
        await client.ping();
        return client.roots();
      });
      return { ok: true, code: 'ok', latencyMs: this.now() - started, rootCount: roots.length };
    } catch (error) {
      const busy = isServerError(error) && error.kind === 'http' && error.status === 429;
      return {
        ok: false,
        code: testCodeFor(error),
        latencyMs: this.now() - started,
        ...(busy ? { busy: true, ...(isServerError(error) && error.retryAfter ? { retryAfter: error.retryAfter } : {}) } : {}),
      };
    }
  }

  /** Features the server announces on `/ping` (e.g. `upload`). Throws like any request when unreachable. */
  async features(): Promise<string[]> {
    const ping = await this.withClient((client) => client.ping());
    return ping.features;
  }

  private remember(item: StorageItem): StorageItem {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(item.id, item);
    return item;
  }

  private toItem(rootId: string, parentPathValue: string, parentId: string | null, raw: ServerItem): StorageItem {
    const path = joinPath(parentPathValue, raw.name);
    const base = {
      parentId,
      name: raw.name,
      type: raw.type,
      size: raw.size ?? 0,
      mtime: raw.mtime,
      md5: raw.md5,
      mime: raw.mime,
      width: raw.width,
      height: raw.height,
      duration: raw.duration,
    };
    return this.remember({
      id: raw.type === 'dir' ? dirId(rootId, path) : fileId(rootId, raw.id, path),
      ...base,
    });
  }

  async list(parentId: string | null, options: ListOptions = {}): Promise<ListResult> {
    if (parentId === null) {
      const roots = await this.withClient((client) => client.roots());
      const items = roots.map((root) =>
        this.remember({
          id: dirId(root.id, ''),
          parentId: null,
          name: root.name,
          type: 'dir',
          size: 0,
          mtime: EPOCH,
        }),
      );
      return { items };
    }
    const ref = parseDirId(parentId);
    if (!ref) return { items: [] };
    const page = await this.withClient((client) =>
      client.tree(ref.rootId, ref.path, options.cursor, options.limit ?? DEFAULT_LIMIT),
    );
    return {
      items: page.items.map((raw) => this.toItem(ref.rootId, ref.path, parentId, raw)),
      nextCursor: page.nextCursor || undefined,
    };
  }

  async stat(id: string): Promise<StorageItem | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const dir = parseDirId(id);
    if (dir) {
      if (dir.path === '') {
        const roots = await this.list(null);
        return roots.items.find((item) => item.id === id) ?? null;
      }
      return this.findInParent(dir.rootId, parentPath(dir.path), id);
    }
    const file = parseFileId(id);
    if (file && file.rootId !== '') return this.findInParent(file.rootId, parentPath(file.path), id);
    return null;
  }

  private async findInParent(rootId: string, path: string, id: string): Promise<StorageItem | null> {
    const parentId = dirId(rootId, path);
    let cursor: string | undefined;
    do {
      const page = await this.list(parentId, { cursor, limit: 500 });
      const found = page.items.find((item) => item.id === id);
      if (found) return found;
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }

  async getThumb(id: string, size = 256): Promise<ImageRef | null> {
    const file = parseFileId(id);
    if (!file) return null;
    const client = await this.urlClient();
    return { uri: client.thumbUrl(file.serverId, size), headers: client.authHeaders() };
  }

  async getPreview(id: string): Promise<ImageRef | null> {
    const file = parseFileId(id);
    if (!file) return null;
    const client = await this.urlClient();
    return { uri: client.previewUrl(file.serverId), headers: client.authHeaders() };
  }

  /** Bare URL (no token inside). Callers that need auth use getOriginalSource. */
  async getOriginalUrl(id: string): Promise<string | null> {
    return (await this.getOriginalSource(id))?.uri ?? null;
  }

  /** Original file URL + Authorization header: used for streaming (Range) and downloads. */
  async getOriginalSource(id: string): Promise<ImageRef | null> {
    const file = parseFileId(id);
    if (!file) return null;
    const client = await this.urlClient();
    return { uri: client.fileUrl(file.serverId), headers: client.authHeaders() };
  }

  async upload(input: UploadInput): Promise<StorageItem> {
    const open = this.options.openReader;
    if (!open) throw new Error('Uploads are not available in this environment');
    let rootId: string;
    let path: string;
    if (input.parentId === null) {
      const roots = await this.withClient((client) => client.roots());
      if (roots.length === 0) throw new ServerError('protocol', 0, 'server has no library root');
      rootId = roots[0].id;
      path = '';
    } else {
      const ref = parseDirId(input.parentId);
      if (!ref) throw new Error('Parent folder not found');
      rootId = ref.rootId;
      path = ref.path;
    }
    const reader = await open(input.sourceUri);
    try {
      const meta = { name: input.name, size: reader.size, rootId, path, md5: input.md5, mtime: input.mtime };
      const raw = await this.withClient((client) =>
        uploadResumable(client, reader, meta, {
          onProgress: input.onProgress,
          isCancelled: input.isCancelled,
          sleep: this.options.sleep,
        }),
      );
      const parentId = path === '' ? dirId(rootId, '') : dirId(rootId, path);
      return this.toItem(rootId, path, parentId, { ...raw, name: raw.name || input.name });
    } finally {
      reader.close?.();
    }
  }

  async delete(): Promise<void> {
    throw new Error('The file server contract has no delete operation');
  }

  async changes(since?: string): Promise<ChangesResult> {
    const result = await this.withClient((client) => client.changes(since));
    const changes: ProviderChange[] = result.changes.map((change) => {
      const raw = change.item;
      const rootId = change.root ?? raw?.root ?? '';
      const path = change.path ?? raw?.path ?? raw?.name ?? '';
      const item: StorageItem | undefined = raw
        ? {
            id: raw.type === 'dir' ? dirId(rootId, path) : fileId(rootId, raw.id, path),
            parentId: path.includes('/') ? dirId(rootId, parentPath(path)) : rootId ? dirId(rootId, '') : null,
            name: raw.name || baseName(path),
            type: raw.type,
            size: raw.size ?? 0,
            mtime: raw.mtime,
            md5: raw.md5,
            mime: raw.mime,
            width: raw.width,
            height: raw.height,
            duration: raw.duration,
          }
        : undefined;
      return { id: item?.id ?? fileId(rootId, change.id, path), op: change.op, item };
    });
    return { changes, cursor: result.cursor };
  }
}
