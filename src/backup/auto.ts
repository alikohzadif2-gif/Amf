import { AppState } from 'react-native';
import { FEATURES } from '@/src/constants/features';
import { useSettingsStore } from '@/src/state/settings-store';
import { uploadQueue } from '@/src/state/upload-queue-store';
import { currentBlocker, watchDeviceState } from './device-state';
import { backupNewData, backupTargetSourceId, moveVerifiedToServer, type DataDb } from './run-backup';
import { logEvent } from '@/src/diagnostics/log';

/** New entries (memories, events, files added to the Archive) are tiny, so they are looked at every few minutes while the app is used. */
export const AUTO_DATA_EVERY_MS = 2 * 60 * 1000;
/** While the app is in front, the round is also checked on a timer: a memory saved or a photo added now must not wait for the next app start. */
export const AUTO_CHECK_EVERY_MS = 60 * 1000;

let lastAutoData = 0;
let dataRunning = false;

/**
 * One automatic round: wake the queue, and (when automatic backup is on, a server is set up and the Wi-Fi/battery rules allow)
 * queue new memories, events and Archive files (also retries uploads that failed for a passing server problem); in "move" mode also remove the verified copies from the phone.
 * The phone GALLERY is never scanned here: it is only backed up by hand (Settings > Backup > Back up gallery now).
 * Safe to call often; it never throws.
 */
export async function autoBackupTick(now: number = Date.now(), db?: DataDb): Promise<void> {
  try {
    if (!FEATURES.serverBackup) return;
    // Pending uploads continue when the network or the charger came back (unless paused by hand).
    void uploadQueue.getState().kick();
    const s = useSettingsStore.getState();
    if (!s.backupAuto || !backupTargetSourceId()) return;
    if (await currentBlocker()) return;
    if (dataRunning) return;
    const due = now - lastAutoData >= AUTO_DATA_EVERY_MS;
    if (!db || !due) return;
    dataRunning = true;
    try {
      lastAutoData = now;
      await uploadQueue.getState().retryTransient(); // failed only for a passing reason (network, busy/hiccuping server): try again
      const data = await backupNewData(db);
      logEvent('info', `auto backup data: ${data.code}`);
      if (s.backupMode === 'move') {
        const freed = await moveVerifiedToServer();
        if (freed > 0) logEvent('info', `auto backup moved: ${freed} bytes freed`);
      }
    } finally {
      dataRunning = false;
    }
  } catch {
    // an automatic round must never crash the app
  }
}

/** Starts the triggers (app start, back to foreground, network/charger change). Returns the stop function. */
export function startBackupWatcher(db?: DataDb): () => void {
  void autoBackupTick(Date.now(), db);
  let timer: ReturnType<typeof setInterval> | null = null;
  const startTimer = () => {
    if (!timer) timer = setInterval(() => void autoBackupTick(Date.now(), db), AUTO_CHECK_EVERY_MS);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  if (AppState.currentState === 'active') startTimer();
  const appSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      startTimer();
      void autoBackupTick(Date.now(), db);
    } else {
      stopTimer();
    }
  });
  const stopDevice = watchDeviceState(() => void autoBackupTick(Date.now(), db));
  return () => {
    stopTimer();
    appSub.remove();
    stopDevice();
  };
}
