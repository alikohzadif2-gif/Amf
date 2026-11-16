import { useSQLiteContext } from 'expo-sqlite';
import { useEffect } from 'react';
import { startBackupWatcher } from '@/src/backup/auto';

/** Mounted once (app/_layout.tsx) while FEATURES.serverBackup is on: runs the automatic backup triggers. Renders nothing. */
export function BackupWatcher() {
  const db = useSQLiteContext();
  useEffect(() => startBackupWatcher(db), [db]);
  return null;
}
