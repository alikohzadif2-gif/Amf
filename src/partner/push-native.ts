/**
 * The native side of push (expo-notifications + Firebase). Loaded lazily so a missing native module
 * (Expo Go, web, a build without google-services.json) degrades to "unavailable" and never crashes the app.
 */
import { Platform } from 'react-native';
import { getDictionary } from '@/src/i18n';
import { useSettingsStore } from '@/src/state/settings-store';
import { OLD_CHANNELS, PUSH_CHANNEL, isUsableToken, type PermissionResult } from './push';
import { foregroundDecision, parsePushData, type PushData } from './push-events';

type Mod = typeof import('expo-notifications');
let mod: Mod | null | undefined;

async function load(): Promise<Mod | null> {
  if (Platform.OS !== 'android') return null;
  if (mod !== undefined) return mod;
  try {
    mod = await import('expo-notifications');
  } catch {
    mod = null;
  }
  return mod;
}

/**
 * Creates the channel the server's notifications use (channel id `meyou-partner-v2`, API_CONTRACT D.11) with importance HIGH
 * (heads-up pop-up) and the default sound, and deletes the channels of earlier versions: Android never changes the importance of
 * an existing channel, so a new id is the only fix. The app's own local notifications use this channel too (notify.ts).
 */
export async function ensurePushChannel(): Promise<void> {
  const n = await load();
  if (!n) return;
  try {
    const dict = getDictionary(useSettingsStore.getState().language);
    await n.setNotificationChannelAsync(PUSH_CHANNEL, { name: dict.pushChannelName, importance: n.AndroidImportance.HIGH, sound: 'default' });
    for (const old of OLD_CHANNELS) await n.deleteNotificationChannelAsync(old).catch(() => undefined);
  } catch {
    // The channel is created again at the next start.
  }
}

/** Reads the permission; it never shows a prompt (the prompt is shown once after pairing, see notify.ts). */
export async function nativePermission(): Promise<PermissionResult> {
  const n = await load();
  if (!n) return 'unavailable';
  try {
    return (await n.getPermissionsAsync()).granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** The raw FCM registration token of this install, or null. */
export async function nativeToken(): Promise<string | null> {
  const n = await load();
  if (!n) return null;
  try {
    const token = await n.getDevicePushTokenAsync();
    return isUsableToken(token.data) ? token.data : null;
  } catch {
    return null; // no google-services.json in this build, or no Google services on the phone
  }
}

/** Calls back when Firebase hands this install a new token. Returns the unsubscribe function. */
export function onTokenChange(callback: () => void): () => void {
  let remove: (() => void) | null = null;
  let stopped = false;
  void load().then((n) => {
    if (!n || stopped) return;
    try {
      const sub = n.addPushTokenListener(() => callback());
      remove = () => sub.remove();
    } catch {
      // not available in this build
    }
  });
  return () => {
    stopped = true;
    remove?.();
  };
}

export type NotificationHandlers = {
  /** A push (our `{ type, seq }` data) reached the open app. */
  onPush: (data: PushData) => void;
  /** A notification was tapped; `id` is the notification's identifier. Also called once for a cold start. */
  onTap: (id: string) => void;
};

/**
 * Installs the app's notification handling (the only setNotificationHandler call in the app):
 * - foreground: our local notifications show; mood/event/diary/period/profile/unpair pushes are held back and turned into a sync
 *   (the app shows its own single notification, see shouldNotifyLocal); `test` pushes show as they are;
 * - tap: any notification tap (also the one that started the app, via getLastNotificationResponseAsync) runs a sync.
 *   The tap never depends on the notification's data (Android does not always hand it over).
 * Returns the cleanup function.
 */
export function installNotificationHandlers(handlers: NotificationHandlers): () => void {
  let stopped = false;
  const subs: { remove: () => void }[] = [];
  void load().then(async (n) => {
    if (!n || stopped) return;
    try {
      n.setNotificationHandler({
        handleNotification: async (notification) => {
          const data = parsePushData(notification.request.content.data);
          if (data) handlers.onPush(data);
          const { show } = foregroundDecision(data);
          return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
        },
      });
      // Data-only messages may not go through the handler on every Android version: the received listener covers them.
      subs.push(
        n.addNotificationReceivedListener((notification) => {
          const data = parsePushData(notification.request.content.data);
          if (data) handlers.onPush(data);
        }),
      );
      subs.push(n.addNotificationResponseReceivedListener((response) => handlers.onTap(response.notification.request.identifier)));
      const last = await n.getLastNotificationResponseAsync();
      if (last && !stopped) handlers.onTap(last.notification.request.identifier);
    } catch {
      // Notifications are optional: the app keeps working without them.
    }
  });
  return () => {
    stopped = true;
    for (const sub of subs) sub.remove();
  };
}
