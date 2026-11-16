import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { ensureNotificationPermission } from '@/src/partner/notify';
import { pushRouter, startListening, stopListening, syncPushRegistration } from '@/src/partner/manage';
import { settleWithin } from '@/src/partner/push-events';
import { installNotificationHandlers, onTokenChange } from '@/src/partner/push-native';
import { usePushStore } from '@/src/state/push-store';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

/** Longest wait for the first push registration before the listener starts (offline or a slow server must not block it). */
const PUSH_FIRST_TRY_MS = 8000;

/**
 * Mounted once under the SQLite provider.
 * - The mailbox listener runs only while the app is open (no foreground service, no permanent notification).
 *   When the app is closed, the partner's messages reach the phone through push (FCM).
 * - Notification handling: a tap, or a push that reaches the open app, runs a mailbox sync.
 */
export function PartnerListener() {
  const db = useSQLiteContext();
  const paired = usePartnerStore((s) => s.paired);

  useEffect(() => installNotificationHandlers(pushRouter), []);

  useEffect(() => {
    let cancelled = false;
    let sub: { remove: () => void } | null = null;

    const run = async () => {
      if (!paired) {
        stopListening();
        return;
      }
      await ensureNotificationPermission();
      // The push state decides whether a replayed message still needs the app's own notification (the system
      // already showed it), so the first registration attempt runs before the first replay.
      await settleWithin(syncPushRegistration(), PUSH_FIRST_TRY_MS, 'unknown' as const);
      if (cancelled) return;
      void startListening(db);
      // Android freezes sockets in the background: reconnect (with replay) when the app is used again.
      sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') void startListening(db);
        else stopListening();
      });
    };
    void run();

    return () => {
      cancelled = true;
      sub?.remove();
      stopListening();
    };
  }, [paired, db]);

  usePushRegistration(paired);
  return null;
}

/**
 * Keeps this phone's FCM token registered on the server (S10). The first registration after pairing / at start is
 * done by the listener effect above; this hook handles what changes later: the app language, a new token from
 * Firebase, a change of the notification-type switches (S11: the server skips the FCM send for a type that is
 * off), and the app coming back to the front while the last attempt did not succeed (e.g. the permission was
 * granted in Android settings).
 */
function usePushRegistration(paired: boolean) {
  const language = useSettingsStore((s) => s.language);
  const firstLanguage = useRef(language);
  const notifyMood = useSettingsStore((s) => s.notifyMood);
  const notifyEvent = useSettingsStore((s) => s.notifyEvent);
  const notifyDiary = useSettingsStore((s) => s.notifyDiary);
  const notifyPeriod = useSettingsStore((s) => s.notifyPeriod);
  const firstNotify = useRef(`${notifyMood}/${notifyEvent}/${notifyDiary}/${notifyPeriod}`);

  useEffect(() => {
    if (!paired || firstLanguage.current === language) return;
    firstLanguage.current = language;
    void syncPushRegistration();
  }, [paired, language]);

  // The first registration (start / pairing) already sends the saved switches; only a later change needs a sync.
  useEffect(() => {
    const now = `${notifyMood}/${notifyEvent}/${notifyDiary}/${notifyPeriod}`;
    if (!paired || firstNotify.current === now) return;
    firstNotify.current = now;
    void syncPushRegistration();
  }, [paired, notifyMood, notifyEvent, notifyDiary, notifyPeriod]);

  useEffect(() => {
    if (!paired) return;
    const stopToken = onTokenChange(() => void syncPushRegistration());
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && usePushStore.getState().state !== 'registered') void syncPushRegistration();
    });
    return () => {
      stopToken();
      sub.remove();
    };
  }, [paired]);
}
