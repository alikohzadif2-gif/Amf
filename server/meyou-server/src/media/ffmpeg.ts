// Locates the ffmpeg binary WITHOUT apt: FFMPEG_PATH, else the static binary that the npm
// package @ffmpeg-installer/ffmpeg ships inside node_modules (works on restricted networks
// because it only needs the npm registry).
import fs from 'node:fs';
import { createRequire } from 'node:module';

let cached: string | null | undefined;

export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env === process.env && cached !== undefined) return cached;
  let found: string | null = null;
  const fromEnv = env.FFMPEG_PATH?.trim();
  if (fromEnv) {
    found = fs.existsSync(fromEnv) ? fromEnv : null;
  } else {
    try {
      const req = createRequire(import.meta.url);
      const p = (req('@ffmpeg-installer/ffmpeg') as { path: string }).path;
      found = fs.existsSync(p) ? p : null;
    } catch {
      found = null;
    }
  }
  if (env === process.env) cached = found;
  return found;
}
