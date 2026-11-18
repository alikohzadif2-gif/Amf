/** Local notifications only (expo-notifications). Loaded lazily so a missing native module never crashes the app. */
import { ensurePushChannel } from './push-native';
import { PUSH_CHANNEL } from './push';

type Mod = typeof import('expo-notifications');
let mod: Mod | null | undefined;

async function load(): Promise<Mod | null> {
  if (mod !== undefined) return mod;
  try {
    const n = await import('expo-notifications');
    // The foreground handler is installed once by installNotificationHandlers (push-native.ts).
    // R1b: local notifications share the push channel (HIGH + sound), so there is one channel in the system settings.
    await ensurePushChannel();
    mod = n;
  } catch {
    mod = null;
  }
  return mod;
}

export type ShowResult = 'shown' | 'denied' | 'unavailable';

/** Shows one notification now. `askPermission` is true for the Test button; false for background arrivals. */
export async function showLocal(title: string, body: string, askPermission = false): Promise<ShowResult> {
  const n = await load();
  if (!n) return 'unavailable';
  try {
    let perm = await n.getPermissionsAsync();
    if (!perm.granted && askPermission) perm = await n.requestPermissionsAsync();
    if (!perm.granted) return 'denied';
    await n.scheduleNotificationAsync({ content: { title, body }, trigger: { channelId: PUSH_CHANNEL } });
    return 'shown';
  } catch {
    return 'unavailable';
  }
}

let asking: Promise<void> | null = null;

/** Asks for the notification permission once (Android 13+); safe to call repeatedly: callers share one prompt. */
export function ensureNotificationPermission(): Promise<void> {
  asking ??= (async () => {
    const n = await load();
    if (!n) return;
    try {
      const perm = await n.getPermissionsAsync();
      if (!perm.granted && perm.canAskAgain) await n.requestPermissionsAsync();
    } catch {
      // ignore: notifications are optional
    }
  })().finally(() => {
    asking = null;
  });
  return asking;
}
