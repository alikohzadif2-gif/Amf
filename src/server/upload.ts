import type { ServerClient } from './client';
import { isServerError, ServerError } from './errors';
import type { ChunkReader, ServerItem } from './types';

export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 4;
const MAX_RESYNCS = 8;

export class UploadCancelled extends Error {
  constructor() {
    super('upload cancelled');
    this.name = 'UploadCancelled';
  }
}

export type UploadMeta = { name: string; size: number; rootId: string; path: string; md5?: string; mtime?: string };

export type UploadOptions = {
  chunkBytes?: number;
  onProgress?: (sent: number, total: number) => void;
  isCancelled?: () => boolean;
  /** Injected so tests do not wait; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One pass: open (or resume) the server-side upload, send chunks from the
 * offset the server reports, then complete. The server answers a repeated
 * `POST /uploads` for the same file with the existing upload and its current
 * offset, which is how resuming works (no state is needed on the phone).
 */
async function pass(
  client: ServerClient,
  reader: ChunkReader,
  meta: UploadMeta,
  options: UploadOptions,
): Promise<ServerItem> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const session = await client.createUpload(meta);
  let offset = session.offset;
  let resyncs = 0;
  options.onProgress?.(offset, meta.size);
  while (offset < meta.size) {
    if (options.isCancelled?.()) throw new UploadCancelled();
    const length = Math.min(chunkBytes, meta.size - offset);
    const bytes = await reader.read(offset, length);
    const next = await client.patchUpload(session.uploadId, offset, bytes);
    if (next !== offset + length) {
      resyncs += 1;
      if (resyncs > MAX_RESYNCS || next < 0 || next > meta.size) {
        throw new ServerError('protocol', 0, 'upload offset out of sync');
      }
    }
    offset = next;
    options.onProgress?.(offset, meta.size);
  }
  if (options.isCancelled?.()) throw new UploadCancelled();
  return client.completeUpload(session.uploadId);
}

/** Resumable chunked upload with retry + exponential backoff on network trouble. */
export async function uploadResumable(
  client: ServerClient,
  reader: ChunkReader,
  meta: UploadMeta,
  options: UploadOptions = {},
): Promise<ServerItem> {
  const sleep = options.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await pass(client, reader, meta, options);
    } catch (error) {
      if (error instanceof UploadCancelled) throw error;
      lastError = error;
      const retryable = isServerError(error) && (error.isUnreachable || error.kind === 'protocol');
      if (!retryable || attempt === MAX_ATTEMPTS - 1) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}
