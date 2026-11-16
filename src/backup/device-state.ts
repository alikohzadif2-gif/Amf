import { backupBlocker, isUnmeteredType, type Blocker, type DeviceState } from './constraints';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * Reads the network and battery through expo-network and expo-battery (loaded
 * lazily, so a missing native module only means "unknown", never a crash).
 * Unknown values never block: the upload itself fails and is retried.
 */
export async function readDeviceState(): Promise<DeviceState> {
  let connected = true;
  let unmetered = true;
  let batteryLevel: number | null = null;
  let charging: boolean | null = null;
  try {
    const Network = await import('expo-network');
    const net = await Network.getNetworkStateAsync();
    connected = net.isConnected !== false && net.isInternetReachable !== false;
    unmetered = isUnmeteredType(net.type);
  } catch {
    // unknown: do not block
  }
  try {
    const Battery = await import('expo-battery');
    if (await Battery.isAvailableAsync()) {
      const level = await Battery.getBatteryLevelAsync();
      batteryLevel = level >= 0 ? level : null;
      const state = await Battery.getBatteryStateAsync();
      if (state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL) charging = true;
      else if (state === Battery.BatteryState.UNPLUGGED) charging = false;
    }
  } catch {
    // unknown: do not block
  }
  return { connected, unmetered, batteryLevel, charging };
}

/** The reason the backup must wait right now (settings + device), or null. */
export async function currentBlocker(): Promise<Blocker | null> {
  const s = useSettingsStore.getState();
  return backupBlocker(await readDeviceState(), { wifiOnly: s.backupWifiOnly, chargingOnly: s.backupChargingOnly });
}

/** Calls `onChange` when the network or the charging state changes. Returns the unsubscribe function. */
export function watchDeviceState(onChange: () => void): () => void {
  const subs: { remove: () => void }[] = [];
  let cancelled = false;
  void (async () => {
    try {
      const Network = await import('expo-network');
      if (!cancelled) subs.push(Network.addNetworkStateListener(onChange));
    } catch {
      // no native module: the app-focus trigger still works
    }
    try {
      const Battery = await import('expo-battery');
      if (!cancelled) subs.push(Battery.addBatteryStateListener(onChange));
    } catch {
      // same
    }
  })();
  return () => {
    cancelled = true;
    for (const sub of subs) sub.remove();
  };
}
