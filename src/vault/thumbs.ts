import { Directory, File } from 'expo-file-system';
import { Image } from 'expo-image';
import { thumbFailure, thumbOk, extensionOf } from '@/src/diagnostics/thumb-trace';
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
    if (!(target.size > 0)) {
      target.delete(); // an empty leftover of a failed save must never be served as the thumbnail
      return null;
    }
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
    if (!source.exists) {
      thumbFailure('exists', extensionOf(rel), 'the file is not in the vault folder');
      return null;
    }
    return render(source, target, type, edge, extensionOf(rel));
  })
    .catch((error) => {
      thumbFailure('job', extensionOf(rel), error);
      return null;
    })
    .finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}

async function render(source: File, target: File, type: 'image' | 'video', edge: number, ext: string): Promise<string | null> {
  const started = Date.now();
  let step = 'decode';
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  let player: { release: () => void } | null = null;
  try {
    let input: Parameters<typeof ImageManipulator.manipulate>[0] = source.uri;
    if (type === 'video') {
      step = 'video-frame';
      const { createVideoPlayer } = await import('expo-video');
      const made = createVideoPlayer({ uri: source.uri });
      player = made;
      const frame = (await made.generateThumbnailsAsync([0.5]))[0];
      if (!frame) {
        thumbFailure(step, ext, 'no frame returned');
        return null;
      }
      input = frame;
    }
    step = 'decode';
    const base = await ImageManipulator.manipulate(input).renderAsync();
    if (!base.width || !base.height) {
      thumbFailure(step, ext, 'decoded size is zero');
      return null;
    }
    const fit = fitEdge(base.width, base.height, edge);
    step = 'resize';
    let context = ImageManipulator.manipulate(input);
    if (fit.scaled) context = context.resize({ width: fit.width, height: fit.height });
    const rendered = await context.renderAsync();
    step = 'save';
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: THUMB_QUALITY });
    const temp = new File(saved.uri);
    step = 'copy';
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
    if (!(target.size > 0)) {
      thumbFailure('copy', ext, 'the saved thumbnail is empty');
      return null;
    }
    // The first few: can the app's image view load what was just written? (a grey tile may be a display problem, not a making problem)
    if (checked < 3) {
      checked += 1;
      step = 'display';
      const shown = await Image.prefetch(target.uri).catch((error) => {
        thumbFailure('display', ext, error);
        return null;
      });
      if (shown === false) {
        thumbFailure('display', ext, 'expo-image could not load the thumbnail it was given');
        target.delete();
        return null;
      }
    }
    thumbOk(ext, target.size, Date.now() - started);
    return target.uri;
  } catch (error) {
    thumbFailure(step, ext, error);
    return null;
  } finally {
    player?.release();
  }
}

let checked = 0;

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
