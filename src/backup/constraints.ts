/**
 * Pure rules for "may the backup send bytes right now?" (SERVER_PHASES Q8).
 * The native reading of the network and the battery lives in `device-state.ts`;
 * this file only decides, so it can be tested in Node.
 */

export type DeviceState = {
  /** Any usable network. */
  connected: boolean;
  /** Wi-Fi or Ethernet (not mobile data). */
  unmetered: boolean;
  /** 0..1, or null when unknown. */
  batteryLevel: number | null;
  /** null when unknown. */
  charging: boolean | null;
};

export type Blocker = 'no-network' | 'no-wifi' | 'low-battery' | 'not-charging';

export type BackupConstraints = {
  wifiOnly: boolean;
  chargingOnly: boolean;
};

/** Below this level (and not charging) nothing is sent. */
export const LOW_BATTERY_LEVEL = 0.2;

/** Why the backup must wait, or null when it may run. The first matching reason wins. */
export function backupBlocker(state: DeviceState, constraints: BackupConstraints): Blocker | null {
  if (!state.connected) return 'no-network';
  if (constraints.wifiOnly && !state.unmetered) return 'no-wifi';
  if (constraints.chargingOnly && state.charging === false) return 'not-charging';
  if (state.charging === false && state.batteryLevel !== null && state.batteryLevel >= 0 && state.batteryLevel < LOW_BATTERY_LEVEL) {
    return 'low-battery';
  }
  return null;
}

/** Network types (expo-network `NetworkStateType` values) that count as "Wi-Fi only" friendly. */
export function isUnmeteredType(type: string | undefined): boolean {
  return type === 'WIFI' || type === 'ETHERNET';
}
