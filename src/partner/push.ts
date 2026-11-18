/**
 * Push registration (S10, part 1): gets this phone's FCM token and tells the user's own server about it
 * (PUT /push/token with the UI language), so the server can wake the phone when the partner sends something.
 * Pure logic with injected dependencies (no React Native imports): the native bits live in push-native.ts.
 */
import type { MailboxClient, PushNotifyChoice } from './mailbox-client';

/** R1b: the id the server sends since R1a (importance HIGH + sound). The old `meyou-partner` (importance DEFAULT) cannot be changed by Android, so it is deleted. */
export const PUSH_CHANNEL = 'meyou-partner-v2';
/** Channels of earlier versions: `meyou-partner` (push, S10) and `partner` (the app's own local notifications). */
export const OLD_CHANNELS: readonly string[] = ['meyou-partner', 'partner'];

/** Same shape the server accepts: 32..4096 printable ASCII characters, no spaces. */
const TOKEN_RE = /^[\x21-\x7e]{32,4096}$/;

export type PushState =
  | 'unknown' // not tried yet
  | 'registered' // the server has this phone's token
  | 'no-permission' // Android notification permission not granted
  | 'unavailable' // no native module or no token (Expo Go, build without google-services.json, no Google services)
  | 'server-no-push' // the user's server has no Firebase key (it does not announce `push`)
  | 'failed'; // network or server error: tried, will be tried again at the next start / token change

export type PermissionResult = 'granted' | 'denied' | 'unavailable';

export type PushDeps = {
  client: Pick<MailboxClient, 'me' | 'registerPushToken'>;
  /** UI language, sent so the server can localize the generic notification text. */
  language: string;
  /** S11: the Settings switches. The server skips the FCM send for a type that is off. */
  notify: PushNotifyChoice;
  permission: () => Promise<PermissionResult>;
  /** The native FCM token, or null when this build cannot get one. Must not throw (a throw counts as unavailable). */
  getToken: () => Promise<string | null>;
};

export const isUsableToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_RE.test(value);

/** Registers (or refreshes) this phone's token on the server. Never throws; returns what happened. */
export async function registerPush(deps: PushDeps): Promise<PushState> {
  // Local checks first, so a phone that cannot receive push never touches the network.
  const permission = await deps.permission().catch((): PermissionResult => 'unavailable');
  if (permission === 'unavailable') return 'unavailable';
  if (permission !== 'granted') return 'no-permission';
  const token = await deps.getToken().catch(() => null);
  if (!isUsableToken(token)) return 'unavailable';
  try {
    const me = await deps.client.me();
    if (!Array.isArray(me.features) || !me.features.includes('push')) return 'server-no-push';
    await deps.client.registerPushToken(token, deps.language, deps.notify);
    return 'registered';
  } catch {
    // Offline, server down, or the token was revoked (the listener notices that on its own).
    return 'failed';
  }
}

/** Best effort: removes this phone's token from the server (before unpairing, while the token still works). */
export async function unregisterPush(client: Pick<MailboxClient, 'removePushToken'>): Promise<boolean> {
  try {
    await client.removePushToken();
    return true;
  } catch {
    return false;
  }
}
