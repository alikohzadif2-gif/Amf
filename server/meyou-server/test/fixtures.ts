// Tiny real media files for the tests (generated, nothing committed).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { libraryDir, type Config } from '../src/config.js';
import { resolveFfmpeg } from '../src/media/ffmpeg.js';

export async function jpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } } }).jpeg({ quality: 70 });
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

export async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
}

/** HEIF container with AV1 (decodable by sharp's prebuilt libvips). HEVC HEIC cannot be generated here. */
export async function heifAv1(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 90, b: 90 } } }).heif({ compression: 'av1', quality: 50 }).toBuffer();
}

export function makeMp4(file: string, seconds = 2, size = '320x240'): void {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg binary not found');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`, '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', file]);
}

export function put(cfg: Config, rel: string, data: Buffer | string): string {
  const abs = path.join(libraryDir(cfg), ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

export function abs(cfg: Config, rel: string): string {
  return path.join(libraryDir(cfg), ...rel.split('/'));
}
