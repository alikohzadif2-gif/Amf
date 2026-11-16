// Thumbnails and previews: sharp for images, an ffmpeg frame for videos. Results are cached under
// $DATA_DIR/cache/<kind>/<xx>/<key>.jpg; the key contains the item id, size and the file's
// size+mtime, so an edited file gets a new thumbnail and old entries simply age out.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { cacheDir, type Config } from '../config.js';
import { resolveFfmpeg } from './ffmpeg.js';
import type { ItemRow } from './store.js';

export const THUMB_SIZES = [64, 128, 256, 384, 512, 768, 1024] as const;
export const PREVIEW_SIZE = 1600;

/** Snap a requested size up to the next allowed bucket (limits the number of cache files). */
export function snapSize(requested: number): number {
  return THUMB_SIZES.find((s) => s >= requested) ?? THUMB_SIZES[THUMB_SIZES.length - 1]!;
}

export class Unsupported extends Error {}

class Gate {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const imageGate = new Gate(3);
const videoGate = new Gate(2);
const inflight = new Map<string, Promise<void>>();

export interface Rendered {
  file: string;
  etag: string;
}

function cachePath(cfg: Config, kind: 'thumb' | 'preview', item: ItemRow, size: number): Rendered {
  const key = crypto.createHash('sha256').update(`${item.id}|${size}|${item.size}|${item.mtime_ms}`).digest('hex').slice(0, 40);
  return { file: path.join(cacheDir(cfg), kind, key.slice(0, 2), `${key}.jpg`), etag: `"${key}"` };
}

async function videoFrame(abs: string, maxSide: number, atSeconds: number): Promise<Buffer> {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Unsupported('ffmpeg not available');
  const args = [
    '-v', 'error', '-nostdin', '-ss', String(atSeconds), '-i', abs, '-frames:v', '1',
    '-vf', `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
    '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1',
  ];
  return new Promise<Buffer>((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err || !stdout || stdout.length === 0) reject(new Unsupported('no frame'));
      else resolve(stdout);
    });
  });
}

async function render(item: ItemRow, abs: string, size: number, durationHint: number | null): Promise<Buffer> {
  if (item.type === 'image') {
    return imageGate.run(async () => {
      try {
        return await sharp(abs, { failOn: 'none', limitInputPixels: 400_000_000 })
          .rotate()
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: size >= 1024 ? 82 : 76, mozjpeg: true })
          .toBuffer();
      } catch {
        // HEIC with HEVC and other formats sharp's prebuilt libvips cannot read: best effort via ffmpeg.
        const frame = await videoGate.run(() => videoFrame(abs, size, 0));
        return sharp(frame).jpeg({ quality: 76 }).toBuffer();
      }
    });
  }
  if (item.type === 'video') {
    // A frame one second in (or the middle of a very short clip) is usually better than a black first frame.
    const at = durationHint && durationHint > 0 ? Math.min(1, durationHint / 2) : 0;
    const frame = await videoGate.run(async () => {
      try {
        return await videoFrame(abs, Math.max(size, 64), at);
      } catch {
        return videoFrame(abs, Math.max(size, 64), 0);
      }
    });
    return imageGate.run(() =>
      sharp(frame, { failOn: 'none' })
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: size >= 1024 ? 82 : 76 })
        .toBuffer(),
    );
  }
  throw new Unsupported('not an image or video');
}

/** Returns the cached JPEG for an item, creating it if needed. Throws Unsupported when it cannot be made. */
export async function getRendered(cfg: Config, kind: 'thumb' | 'preview', item: ItemRow, abs: string, size: number): Promise<Rendered> {
  const out = cachePath(cfg, kind, item, size);
  if (fs.existsSync(out.file)) return out;
  const pending = inflight.get(out.file);
  if (pending) {
    await pending;
    return out;
  }
  const job = (async () => {
    const buf = await render(item, abs, size, item.duration);
    fs.mkdirSync(path.dirname(out.file), { recursive: true });
    const tmp = `${out.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, out.file);
  })();
  inflight.set(out.file, job);
  try {
    await job;
  } finally {
    inflight.delete(out.file);
  }
  return out;
}
