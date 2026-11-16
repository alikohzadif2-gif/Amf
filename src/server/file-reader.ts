import { File, FileMode } from 'expo-file-system';
import type { ChunkReader, OpenReader } from './types';

/**
 * Reads a phone file chunk by chunk through a file handle (reads only the bytes asked for).
 * Not `file.slice().arrayBuffer()`: expo-file-system builds that slice with `new Blob([Uint8Array])`, which React Native refuses
 * ("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"): that made every upload fail.
 */
export const openFileReader: OpenReader = async (uri: string): Promise<ChunkReader> => {
  const file = new File(uri);
  const info = file.info();
  if (!info.exists) throw new Error('File not found');
  return {
    size: info.size ?? 0,
    async read(offset, length) {
      try {
        const handle = file.open(FileMode.ReadOnly);
        try {
          handle.offset = offset;
          return new Uint8Array(handle.readBytes(length));
        } finally {
          handle.close();
        }
      } catch {
        // A source that cannot be opened as a handle: read it whole and cut the piece (fine for small files).
        const all = await file.bytes();
        return all.slice(offset, offset + length);
      }
    },
  };
};

/** MD5 of a phone file (used so the server can verify and skip duplicates). */
export function fileMd5(uri: string): string | undefined {
  try {
    return new File(uri).info({ md5: true }).md5 ?? undefined;
  } catch {
    return undefined;
  }
}
