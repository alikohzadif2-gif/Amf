import type { ItemType } from './types';

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp']);
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'webm', '3gp', 'avi']);
const TEXT = new Set(['txt', 'md', 'log', 'json', 'csv']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function typeFromName(name: string): ItemType {
  const ext = extensionOf(name);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (TEXT.has(ext)) return 'text';
  return 'file';
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  pdf: 'application/pdf',
};

export function mimeFromName(name: string): string | undefined {
  return MIME[extensionOf(name)];
}
