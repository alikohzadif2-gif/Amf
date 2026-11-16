import { useSettingsStore } from '@/src/state/settings-store';
import { uploadQueue } from '@/src/state/upload-queue-store';
import { isGalleryJob } from './reset-logic';

/**
 * Settings > Backup > Reset: the gallery backup goes back to "nothing chosen" and the gallery photos still waiting to upload are dropped.
 * Nothing is deleted on the phone or on the server, and memories/events/Archive backup is not touched.
 * (An app cannot withdraw its own gallery permission: the screen opens the phone's app settings for that last step.)
 * Returns how many waiting gallery uploads were dropped.
 */
export function resetGalleryBackup(): number {
  const settings = useSettingsStore.getState();
  settings.setSetting('backupScope', 'selected');
  settings.setSetting('backupAlbums', []);
  const queue = uploadQueue.getState();
  const waiting = queue.jobs.filter((j) => (j.state === 'queued' || j.state === 'failed') && isGalleryJob(j));
  for (const job of waiting) queue.removeJob(job.id);
  return waiting.length;
}
