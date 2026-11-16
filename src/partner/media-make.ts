import { File } from 'expo-file-system';
import { fitVariant, type MediaKind, type Rendered } from './media-logic';

/**
 * Makes the thumbnail and the preview of a phone image with expo-image-manipulator (stage 4). A re-encode drops EXIF/GPS.
 * Never enlarges a small picture. Returns null for a kind that could not be made (the share then goes on without it).
 */
export async function makeVariant(uri: string, kind: MediaKind): Promise<Rendered | null> {
  try {
    const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
    const base = await ImageManipulator.manipulate(uri).renderAsync();
    const { width, height } = base;
    if (!width || !height) return null;
    return await fitVariant(kind, async ({ edge, quality }) => {
      const scale = Math.min(1, edge / Math.max(width, height));
      let context = ImageManipulator.manipulate(uri);
      if (scale < 1) context = context.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
      const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
      try {
        new File(saved.uri).delete(); // the temporary file; the base64 is all we need
      } catch {
        // a leftover cache file is harmless
      }
      return saved.base64 ? { b64: saved.base64, width: saved.width, height: saved.height } : null;
    });
  } catch {
    return null;
  }
}

/**
 * A poster frame of a phone video (stage 6), sized like a thumbnail. Uses expo-video's thumbnail generator and the same re-encode
 * (no metadata). Null when the phone cannot make one: the share then goes on without a poster.
 */
export async function makeVideoPoster(uri: string): Promise<Rendered | null> {
  try {
    const { createVideoPlayer } = await import('expo-video');
    const player = createVideoPlayer({ uri });
    try {
      const frames = await player.generateThumbnailsAsync([0.5]);
      const frame = frames[0];
      if (!frame) return null;
      const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
      const base = await ImageManipulator.manipulate(frame).renderAsync();
      const { width, height } = base;
      if (!width || !height) return null;
      return await fitVariant('thumb', async ({ edge, quality }) => {
        const scale = Math.min(1, edge / Math.max(width, height));
        let context = ImageManipulator.manipulate(frame);
        if (scale < 1) context = context.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
        const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
        try {
          new File(saved.uri).delete();
        } catch {
          // a leftover cache file is harmless
        }
        return saved.base64 ? { b64: saved.base64, width: saved.width, height: saved.height } : null;
      });
    } finally {
      player.release();
    }
  } catch {
    return null;
  }
}
