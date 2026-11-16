import { FEATURES } from '@/src/constants/features';
import { useDriveStore } from '@/src/state/drive-store';
import type { SourceConfig } from './types';

/**
 * A source the Library and the backup code may use. A real personal server can be saved
 * (Settings > Server connection, S2); since S4 `FEATURES.serverLibrary` is on and it is a Library
 * source too (the flag stays as the switch to hide it again).
 */
export function isSourceActive(source: SourceConfig): boolean {
  if (!source.enabled) return false;
  // Google Drive is a source only while somebody is signed in (Settings > Google Drive).
  if (source.kind === 'drive') return useDriveStore.getState().account !== null;
  if (source.kind === 'server' && source.backend === 'real' && !FEATURES.serverLibrary) return false;
  return true;
}
