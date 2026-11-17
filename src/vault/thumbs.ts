import { Directory, File } from 'expo-file-system';
import { createLimiter } from '@/src/media/limiter';
import { vaultDirectory, vaultFile } from './files';
import { THUMB_EDGES, THUMB_FOLDER, THUMB_QUALITY, fitEdge, isThumbFresh, thumbName } from './thumb-logic';

/**
 * Makes and finds the small pictures of Direct files (a re-encode, so EXIF/GPS never reaches a thumbnail). A thumbnail is made once,
 * when the file is added (or the first time a grid asks for it), then read from disk. At most two are made at a time.
 */
const run = createLimiter(2);
const inflight = new Map<string, Promise<string | null>>();

function thumbDirectory(): Directory {
  const dir = new Directory(vaultDirectory(), THUMB_FOLDER);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function freshUri(target: File, source: File): string | null {
  try {
    if (!target.exists) return null;
    return isThumbFresh(target.modificationTime, source.modificationTime) ? target.uri : null;
  } catch {
    return null;
  }
}

/** The thumbnail of a vault file (`rel` = path inside the vault), made if missing. Null when it cannot be made: callers fall back to the file. */
export function ensureThumb(rel: string, type: 'image' | 'video', edge: number): Promise<string | null> {
  const name = thumbName(rel, edge);
  const pending = inflight.get(name);
  if (pending) return pending;
  const job = run(async () => {
    const source = vaultFile(rel);
    const target = new File(thumbDirectory(), name);
    const hit = freshUri(target, source);
    if (hit) return hit;
    if (!source.exists) return null;
    return render(source, target, type, edge);
  })
    .catch(() => null)
    .finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}

async function render(source: File, target: File, type: 'image' | 'video', edge: number): Promise<string | null> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  let player: { release: () => void } | null = null;
  try {
    let input: Parameters<typeof ImageManipulator.manipulate>[0] = source.uri;
    if (type === 'video') {
      const { createVideoPlayer } = await import('expo-video');
      const made = createVideoPlayer({ uri: source.uri });
      player = made;
      const frame = (await made.generateThumbnailsAsync([0.5]))[0];
      if (!frame) return null;
      input = frame;
    }
    const base = await ImageManipulator.manipulate(input).renderAsync();
    if (!base.width || !base.height) return null;
    const fit = fitEdge(base.width, base.height, edge);
    let context = ImageManipulator.manipulate(input);
    if (fit.scaled) context = context.resize({ width: fit.width, height: fit.height });
    const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: THUMB_QUALITY });
    const temp = new File(saved.uri);
    try {
      if (target.exists) target.delete();
      temp.copy(target);
    } finally {
      try {
        temp.delete();
      } catch {
        // a leftover cache file is harmless
      }
    }
    return target.uri;
  } finally {
    player?.release();
  }
}

/** Removes the thumbnails of a file that left the vault folder (trash, delete). Best effort. */
export function dropThumbs(rel: string): void {
  try {
    const dir = thumbDirectory();
    for (const edge of THUMB_EDGES) {
      const file = new File(dir, thumbName(rel, edge));
      if (file.exists) file.delete();
    }
  } catch {
    // a thumbnail left behind only wastes a few KB
  }
}
