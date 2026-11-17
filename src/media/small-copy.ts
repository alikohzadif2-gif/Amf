import { Directory, File, Paths } from 'expo-file-system';
import { thumbHash } from '@/src/vault/thumb-logic';

/**
 * A small JPEG copy (long side about `edge` px) of any local picture that is not in the vault: the sender's own photo in a chat, the
 * private copy of an event photo. Lists and grids show this instead of decoding the full file. Made once, then read from the cache
 * folder (the OS may clear it; it is simply made again). Null when it cannot be made: the caller then uses the original.
 */
const inflight = new Map<string, Promise<string | null>>();

function folder(): Directory {
  const dir = new Directory(Paths.cache, 'meyou-small');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function smallCopy(uri: string, edge = 320): Promise<string | null> {
  const name = `${thumbHash(uri)}.${edge}.jpg`;
  const pending = inflight.get(name);
  if (pending) return pending;
  const job = (async () => {
    try {
      const target = new File(folder(), name);
      if (target.exists && (target.size ?? 0) > 0) return target.uri;
      const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
      const base = await ImageManipulator.manipulate(uri).renderAsync();
      const longSide = Math.max(base.width, base.height);
      if (!longSide) return null;
      if (longSide <= edge) return uri; // already small: no copy needed
      const scale = edge / longSide;
      const small = await ImageManipulator.manipulate(uri).resize({ width: Math.max(1, Math.round(base.width * scale)), height: Math.max(1, Math.round(base.height * scale)) }).renderAsync();
      const saved = await small.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
      const temp = new File(saved.uri);
      if (target.exists) target.delete();
      temp.copy(target);
      try {
        temp.delete();
      } catch {
        // a leftover cache file is harmless
      }
      return target.uri;
    } catch {
      return null;
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, job);
  return job;
}
