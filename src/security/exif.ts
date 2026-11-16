import { extensionOf } from '@/src/storage/item-type';

export type ReencodePlan = { format: 'jpeg' | 'png' | 'webp'; name: string };

/**
 * Decides how a photo is re-encoded so GPS and other EXIF data are dropped.
 * Returns null for files we leave alone (videos, documents, GIF/BMP).
 * HEIC/HEIF become JPEG (the name gets a .jpg extension).
 */
export function reencodePlan(name: string): ReencodePlan | null {
  const ext = extensionOf(name);
  const base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return { format: 'jpeg', name };
    case 'png':
      return { format: 'png', name };
    case 'webp':
      return { format: 'webp', name };
    case 'heic':
    case 'heif':
      return { format: 'jpeg', name: `${base}.jpg` };
    default:
      return null;
  }
}
