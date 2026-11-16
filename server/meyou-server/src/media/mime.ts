// Item type + MIME detection: by file extension, and a tiny magic-byte sniff for files
// whose extension is missing or unknown (e.g. "IMG_0001" copied without a suffix).
import fs from 'node:fs';

export type ItemType = 'dir' | 'image' | 'video' | 'file' | 'text';

interface Kind {
  type: ItemType;
  mime: string;
}

const EXT: Record<string, Kind> = {
  jpg: { type: 'image', mime: 'image/jpeg' },
  jpeg: { type: 'image', mime: 'image/jpeg' },
  jpe: { type: 'image', mime: 'image/jpeg' },
  png: { type: 'image', mime: 'image/png' },
  webp: { type: 'image', mime: 'image/webp' },
  gif: { type: 'image', mime: 'image/gif' },
  bmp: { type: 'image', mime: 'image/bmp' },
  avif: { type: 'image', mime: 'image/avif' },
  heic: { type: 'image', mime: 'image/heic' },
  heif: { type: 'image', mime: 'image/heif' },
  tif: { type: 'image', mime: 'image/tiff' },
  tiff: { type: 'image', mime: 'image/tiff' },
  mp4: { type: 'video', mime: 'video/mp4' },
  m4v: { type: 'video', mime: 'video/x-m4v' },
  mov: { type: 'video', mime: 'video/quicktime' },
  webm: { type: 'video', mime: 'video/webm' },
  mkv: { type: 'video', mime: 'video/x-matroska' },
  '3gp': { type: 'video', mime: 'video/3gpp' },
  avi: { type: 'video', mime: 'video/x-msvideo' },
  txt: { type: 'text', mime: 'text/plain' },
  md: { type: 'text', mime: 'text/markdown' },
  csv: { type: 'text', mime: 'text/csv' },
  log: { type: 'text', mime: 'text/plain' },
  json: { type: 'text', mime: 'application/json' },
  pdf: { type: 'file', mime: 'application/pdf' },
  zip: { type: 'file', mime: 'application/zip' },
};

const BINARY: Kind = { type: 'file', mime: 'application/octet-stream' };

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Classify by extension only (no I/O). `null` when the extension is unknown. */
export function kindByName(name: string): Kind | null {
  return EXT[extOf(name)] ?? null;
}

/** Look at the first bytes of a file. */
export function sniff(head: Buffer): Kind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return EXT.jpg!;
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return EXT.png!;
  if (head.length >= 6 && (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a')) return EXT.gif!;
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return EXT.webp!;
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return EXT.webm!;
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return EXT.mov!;
    if (/^(heic|heix|mif1|msf1|hevc)/.test(brand)) return EXT.heic!;
    if (brand === 'avif') return EXT.avif!;
    return EXT.mp4!;
  }
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === '%PDF') return EXT.pdf!;
  return null;
}

/** Full classification of a regular file. Reads 16 bytes only when the extension is unknown. */
export async function classify(name: string, absPath: string): Promise<Kind> {
  const byName = kindByName(name);
  if (byName) return byName;
  try {
    const fh = await fs.promises.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const { bytesRead } = await fh.read(buf, 0, 16, 0);
      return sniff(buf.subarray(0, bytesRead)) ?? BINARY;
    } finally {
      await fh.close();
    }
  } catch {
    return BINARY;
  }
}
