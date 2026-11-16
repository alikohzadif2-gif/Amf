import type { ChunkReader } from '../server/types';
import { DriveClient } from './client';
import { DriveError, isDriveError } from './errors';
import type { DriveFile } from './types';

/** Drive wants chunk sizes in multiples of 256 KiB; 4 MiB keeps memory low and the request count small. */
export const DRIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 4;

export class DriveUploadCancelled extends Error {
  constructor() {
    super('upload cancelled');
    this.name = 'UploadCancelled'; // the name the upload queue treats as "paused", not as a failure
  }
}

export type DriveUploadMeta = { name: string; parentId: string; mimeType: string; modifiedTime?: string };
export type DriveUploadOptions = {
  chunkBytes?: number;
  onProgress?: (sent: number, total: number) => void;
  isCancelled?: () => boolean;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const retryable = (error: unknown): boolean =>
  isDriveError(error) && (error.kind === 'network' || (error.kind === 'http' && error.status >= 500));

/**
 * Resumable upload: open a session, send chunks, and after a dropped connection ask Google how much it has and
 * carry on from there. A cancelled upload leaves nothing behind (an unfinished session is simply abandoned).
 */
export async function uploadToDrive(
  client: DriveClient,
  reader: ChunkReader,
  meta: DriveUploadMeta,
  options: DriveUploadOptions = {},
): Promise<DriveFile> {
  const sleep = options.sleep ?? realSleep;
  const total = reader.size;
  if (total === 0) return client.createEmptyFile(meta.name, meta.parentId, meta.mimeType);
  const step = Math.max(256 * 1024, Math.floor((options.chunkBytes ?? DRIVE_CHUNK_BYTES) / (256 * 1024)) * 256 * 1024);

  let session: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !session; attempt += 1) {
    try {
      session = await client.startUpload({ ...meta, size: total });
    } catch (error) {
      if (!retryable(error) || attempt === MAX_ATTEMPTS - 1) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  if (!session) throw new DriveError('protocol', 0, 'no upload session');

  let offset = 0;
  let failures = 0;
  options.onProgress?.(0, total);
  while (true) {
    if (options.isCancelled?.()) throw new DriveUploadCancelled();
    const length = Math.min(step, total - offset);
    try {
      const bytes = await reader.read(offset, length);
      const result = await client.putChunk(session, bytes, offset, total);
      failures = 0;
      if (result.done) {
        options.onProgress?.(total, total);
        return result.file;
      }
      offset = Math.min(result.next, total);
      options.onProgress?.(offset, total);
    } catch (error) {
      if (!retryable(error) || (failures += 1) >= MAX_ATTEMPTS) throw error;
      await sleep(500 * 2 ** (failures - 1));
      try {
        const status = await client.uploadStatus(session, total);
        if (status.done) {
          options.onProgress?.(total, total);
          return status.file;
        }
        offset = Math.min(status.next, total);
      } catch (statusError) {
        if (!retryable(statusError)) throw statusError;
      }
    }
  }
}
