import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createUploadQueue, type QueueActions, type QueueState } from '@/src/backup/queue';
import { logEvent } from '@/src/diagnostics/log';
import { providerFor } from '@/src/library/providers';
import { stripExifForUpload } from '@/src/security/strip-exif';
import { currentBlocker } from '@/src/backup/device-state';

/** The app-wide upload queue (persisted as `meyou-uploads`). */
export const uploadQueue = createUploadQueue({
  resolveProvider: providerFor,
  storage: AsyncStorage,
  prepare: stripExifForUpload,
  // Wi-Fi only / charging / low battery (settings + device); the watcher kicks the queue when that changes.
  canRun: currentBlocker,
});

// Diagnostics: one log line when an upload fails (name and code only).
uploadQueue.subscribe((state, previous) => {
  for (const job of state.jobs) {
    const before = previous.jobs.find((j) => j.id === job.id);
    if (job.state === 'failed' && before?.state !== 'failed') {
      logEvent('warn', `upload failed: ${job.name} (${job.error ?? 'error'})`);
    }
  }
});

export function useUploadQueue<T>(selector: (state: QueueState & QueueActions) => T): T {
  return useStore(uploadQueue, selector);
}
