import { toDigits } from '@/src/lib/calendar';
import type { TranslationKey } from '@/src/i18n';
import type { Blocker } from './constraints';
import type { BackupOutcome } from './run-backup';

/** Human text for the result of "Back up new media" (codes in, i18n text out). */
export function backupMessage(
  outcome: BackupOutcome,
  t: (key: TranslationKey) => string,
  digits: 'persian' | 'latin',
): string {
  switch (outcome.code) {
    case 'no-server':
      return t('backupNoServer');
    case 'no-access':
      return t('backupNoAccess');
    case 'unreachable':
      return t('backupUnreachable');
    case 'no-upload':
      return t('backupNoUpload');
    case 'nothing-selected':
      return t('backupNothingSelected');
    case 'no-albums':
      return t('backupNoAlbums');
    default:
      return outcome.queued === 0
        ? t('backupNothingNew')
        : `${toDigits(outcome.queued, digits)} ${t('backupQueued')}`;
  }
}

const BLOCKER_KEY: Record<Blocker, TranslationKey> = {
  'no-network': 'backupWaitNetwork',
  'no-wifi': 'backupWaitWifi',
  'low-battery': 'backupWaitBattery',
  'not-charging': 'backupWaitCharging',
};

/** Why the queue is waiting, as a translation key (null when the code is unknown). */
export function waitingKey(code: string | null): TranslationKey | null {
  return code && code in BLOCKER_KEY ? BLOCKER_KEY[code as Blocker] : null;
}

/** Failure code of a job (see `errorCode` in queue.ts) -> translation key. */
export function uploadErrorKey(code?: string): TranslationKey {
  if (code === 'unauthorized') return 'testUnauthorized';
  if (code === 'drive-unauthorized') return 'driveSessionExpired';
  if (code === 'drive-full') return 'uploadErrDriveFull';
  if (code === 'network' || code === 'timeout') return 'uploadErrNetwork';
  if (code === 'prepare') return 'uploadErrStrip';
  if (code === 'http-507') return 'uploadErrServerFull';
  if (code === 'http-413') return 'uploadErrTooBig';
  if (code === 'http-502' || code === 'http-503' || code === 'http-504' || code === 'http-429' || code === 'protocol') {
    return 'uploadErrServerBusy';
  }
  return 'uploadErrOther';
}
