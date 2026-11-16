import { File } from 'expo-file-system';
import type { PreparedFile } from '@/src/backup/queue';
import { fileMd5 } from '@/src/server/file-reader';
import { MD5_MAX_BYTES } from '@/src/backup/backup-new';
import { useSettingsStore } from '@/src/state/settings-store';
import { reencodePlan } from './exif';

/**
 * Upload step: with "Remove location and EXIF data" on, a photo is re-encoded
 * by expo-image-manipulator (a re-encode writes a fresh file without metadata)
 * and the copy is uploaded instead. Throws when that fails, so a photo that must
 * be cleaned is never sent as is.
 */
export async function stripExifForUpload(job: {
  uri: string;
  name: string;
}): Promise<PreparedFile | null> {
  if (!useSettingsStore.getState().stripExif) return null;
  const plan = reencodePlan(job.name);
  if (!plan) return null;
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(job.uri);
  try {
    const ref = await context.renderAsync();
    const saved = await ref.saveAsync({
      format: { jpeg: SaveFormat.JPEG, png: SaveFormat.PNG, webp: SaveFormat.WEBP }[plan.format],
      compress: 0.95,
    });
    const file = new File(saved.uri);
    const size = file.info().size ?? 0;
    if (size <= 0) throw new Error('re-encoded file is empty');
    return {
      uri: saved.uri,
      name: plan.name,
      size,
      md5: size <= MD5_MAX_BYTES ? fileMd5(saved.uri) : undefined,
      cleanup: () => {
        try {
          new File(saved.uri).delete();
        } catch {
          // already gone
        }
      },
    };
  } finally {
    context.release?.();
  }
}

