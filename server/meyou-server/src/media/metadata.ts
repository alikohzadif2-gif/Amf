// Image size (sharp) and video duration/size (ffmpeg -i, no ffprobe needed).
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { resolveFfmpeg } from './ffmpeg.js';

export interface Meta {
  width: number | null;
  height: number | null;
  duration: number | null;
}

const NONE: Meta = { width: null, height: null, duration: null };

export async function imageMeta(absPath: string): Promise<Meta> {
  try {
    const m = await sharp(absPath, { failOn: 'none' }).metadata();
    if (!m.width || !m.height) return NONE;
    // EXIF orientation 5..8 means the picture is shown rotated by 90 degrees.
    const swap = (m.orientation ?? 1) >= 5;
    return { width: swap ? m.height : m.width, height: swap ? m.width : m.height, duration: null };
  } catch {
    return NONE; // unsupported (e.g. HEVC HEIC): the item is still listed, just without a size
  }
}

/** Parse the text `ffmpeg -i` prints on stderr. Exported for tests. */
export function parseFfmpegInfo(text: string): Meta {
  let duration: number | null = null;
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (d) duration = Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 100) / 100;
  let width: number | null = null;
  let height: number | null = null;
  const v = /Video:[^\n]*?[,\s](\d{2,5})x(\d{2,5})[,\s\[]/.exec(text);
  if (v) {
    width = Number(v[1]);
    height = Number(v[2]);
    const rot = /rotate\s*:\s*(-?\d+)/.exec(text);
    if (rot && Math.abs(Number(rot[1])) % 180 === 90) [width, height] = [height, width];
  }
  return { width, height, duration };
}

export async function videoMeta(absPath: string): Promise<Meta> {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return NONE;
  return new Promise<Meta>((resolve) => {
    // `ffmpeg -i file` with no output exits with code 1 but prints the stream info.
    execFile(ffmpeg, ['-hide_banner', '-i', absPath], { timeout: 15_000, maxBuffer: 1 << 20 }, (_err, _out, stderr) => {
      resolve(parseFfmpegInfo(String(stderr ?? '')));
    });
  });
}
