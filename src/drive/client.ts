import { DriveError } from './errors';
import {
  FOLDER_MIME,
  type DriveAbout,
  type DriveAuth,
  type DriveFile,
  type DriveFilePage,
  type FetchLike,
} from './types';

export const API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const DEFAULT_TIMEOUT_MS = 30_000;

export const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,thumbnailLink,parents,' +
  'imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),shortcutDetails(targetId,targetMimeType)';

/** Escapes a value for a Drive `q` string literal. */
export function qEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const QUOTA_REASONS = new Set([
  'storagequotaexceeded',
  'userratelimitexceeded',
  'ratelimitexceeded',
  'dailylimitexceeded',
  'quotaexceeded',
]);

async function errorFromResponse(response: Response): Promise<DriveError> {
  let reason = '';
  try {
    const body = (await response.json()) as { error?: { errors?: { reason?: string }[]; status?: string; message?: string } };
    reason = (body.error?.errors?.[0]?.reason ?? body.error?.status ?? '').toLowerCase().replace(/_/g, '');
  } catch {
    // no JSON body
  }
  if (response.status === 401) return new DriveError('unauthorized', 401);
  if (response.status === 404) return new DriveError('not-found', 404);
  if (response.status === 429 || QUOTA_REASONS.has(reason)) return new DriveError('quota', response.status, reason || undefined);
  if (response.status === 403) return new DriveError('forbidden', 403, reason || undefined);
  return new DriveError('http', response.status, reason || undefined);
}

export type UploadStart = {
  name: string;
  parentId: string;
  size: number;
  mimeType: string;
  /** UTC ISO modification time of the source file (kept as Drive's modifiedTime). */
  modifiedTime?: string;
};

/** Result of one chunk: finished (the file) or the next offset Google expects. */
export type ChunkResult = { done: true; file: DriveFile } | { done: false; next: number };

/**
 * Thin wrapper around the Drive REST API v3. Bearer tokens come from `auth`; one 401 triggers one forced token refresh
 * and a retry. Upload-session URLs are pre-authorised by Google, so chunk requests carry no token.
 */
export class DriveClient {
  constructor(
    private readonly auth: DriveAuth,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private async send(url: string, init: RequestInit, token: string | null): Promise<Response> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const headers = { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      return await this.fetchImpl(url, { ...init, headers, ...(controller ? { signal: controller.signal } : {}) });
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw new DriveError('network', 0, error instanceof Error ? error.message : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** An authorised request; a 401 is retried once with a fresh token. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.auth.getAccessToken();
    let response = await this.send(url, init, token);
    if (response.status === 401) {
      token = await this.auth.getAccessToken(true);
      response = await this.send(url, init, token);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    try {
      return (await response.json()) as T;
    } catch {
      throw new DriveError('protocol', response.status, 'invalid JSON');
    }
  }

  async about(): Promise<DriveAbout> {
    return this.json<DriveAbout>(`${API}/about?fields=user(emailAddress,displayName,photoLink),storageQuota(limit,usage,usageInDrive)`);
  }

  /** One page of the (non-trashed) children of a folder: folders first, then by name. */
  async listChildren(parentId: string, pageToken?: string, pageSize = 200, foldersOnly = false): Promise<DriveFilePage> {
    const parts = [`'${qEscape(parentId)}' in parents`, 'trashed = false'];
    if (foldersOnly) parts.push(`mimeType = '${FOLDER_MIME}'`);
    const params = new URLSearchParams({
      q: parts.join(' and '),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: String(Math.min(Math.max(pageSize, 1), 1000)),
      orderBy: 'folder,name',
      spaces: 'drive',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params.toString()}`);
    return { files: page.files ?? [], nextPageToken: page.nextPageToken || undefined };
  }

  async getFile(id: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`);
  }

  /** `root` is Drive's alias for My Drive; this returns its real id. */
  async rootId(): Promise<string> {
    const root = await this.json<{ id: string }>(`${API}/files/root?fields=id`);
    return root.id;
  }

  async findFolder(name: string, parentId: string): Promise<DriveFile | null> {
    const q = [
      `name = '${qEscape(name)}'`,
      `'${qEscape(parentId)}' in parents`,
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
    ].join(' and ');
    const params = new URLSearchParams({ q, fields: `files(${FILE_FIELDS})`, pageSize: '1', spaces: 'drive' });
    const page = await this.json<{ files?: DriveFile[] }>(`${API}/files?${params.toString()}`);
    return page.files?.[0] ?? null;
  }

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }

  /** Moves a file or folder to the Drive bin (recoverable for 30 days); never deletes for good. */
  async trash(id: string): Promise<void> {
    await this.json<unknown>(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /** URL of the file's bytes (needs the Authorization header). */
  mediaUrl(id: string): string {
    return `${API}/files/${encodeURIComponent(id)}?alt=media`;
  }

  async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.auth.getAccessToken()}` };
  }

  /** Opens a resumable upload session and returns its URL. */
  async startUpload(meta: UploadStart): Promise<string> {
    const response = await this.request(`${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': meta.mimeType,
        'X-Upload-Content-Length': String(meta.size),
      },
      body: JSON.stringify({
        name: meta.name,
        parents: [meta.parentId],
        ...(meta.modifiedTime ? { modifiedTime: meta.modifiedTime } : {}),
      }),
    });
    const location = response.headers.get('location') ?? response.headers.get('Location');
    if (!location) throw new DriveError('protocol', response.status, 'no upload session URL');
    return location;
  }

  private async chunkResult(response: Response, total: number): Promise<ChunkResult> {
    if (response.status === 308) {
      // "Resume Incomplete": the Range header says what Google has, e.g. `bytes=0-1048575`.
      const range = response.headers.get('range') ?? response.headers.get('Range');
      const match = range ? /bytes=\d+-(\d+)/.exec(range) : null;
      return { done: false, next: match ? Number(match[1]) + 1 : 0 };
    }
    if (response.ok) {
      try {
        return { done: true, file: (await response.json()) as DriveFile };
      } catch {
        throw new DriveError('protocol', response.status, 'invalid upload result');
      }
    }
    if (response.status === 404 || response.status === 410) throw new DriveError('not-found', response.status, 'upload session expired');
    throw await errorFromResponse(response);
  }

  /** Sends bytes [start, start + bytes.length) of `total`. */
  async putChunk(sessionUrl: string, bytes: Uint8Array, start: number, total: number): Promise<ChunkResult> {
    const end = start + bytes.length - 1;
    const response = await this.send(
      sessionUrl,
      { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end}/${total}` }, body: bytes as unknown as BodyInit },
      null,
    );
    return this.chunkResult(response, total);
  }

  /** Asks Google how much of the session it already has (after a dropped connection). */
  async uploadStatus(sessionUrl: string, total: number): Promise<ChunkResult> {
    const response = await this.send(sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } }, null);
    return this.chunkResult(response, total);
  }

  /** An empty file cannot be sent in chunks: a plain create with no content. */
  async createEmptyFile(name: string, parentId: string, mimeType: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType, parents: [parentId] }),
    });
  }
}
