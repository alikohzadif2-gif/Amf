import { Feather } from '@expo/vector-icons';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { logEvent } from '@/src/diagnostics/log';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { authenticate } from '@/src/security/auth';
import { shouldLock } from '@/src/security/lock-logic';
import { useSettingsStore } from '@/src/state/settings-store';

const SCREEN_KEY = 'meyou-secure';

/** "Block screenshots" also blanks meYou in the recent-apps list (Android FLAG_SECURE). */
function useScreenCaptureBlock() {
  const block = useSettingsStore((s) => s.blockScreenshots);
  useEffect(() => {
    const run = block ? preventScreenCaptureAsync(SCREEN_KEY) : allowScreenCaptureAsync(SCREEN_KEY);
    run.catch(() => logEvent('warn', 'screen capture setting could not be applied'));
  }, [block]);
}

/**
 * Covers the app with a lock screen while it is locked. Locks at start (when
 * app lock is on) and when the app returns after the chosen time in the
 * background. The covering view is opaque, so nothing underneath is visible.
 */
export function AppLockGate() {
  const colors = useColors();
  const { language, t } = useI18n();
  const appLock = useSettingsStore((s) => s.appLock);
  const [hydrated, setHydrated] = useState(() => useSettingsStore.persist.hasHydrated());
  const [locked, setLocked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);
  useScreenCaptureBlock();

  useEffect(() => {
    if (hydrated) return;
    return useSettingsStore.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  // First decision once the saved settings are known (turning the lock ON later does not lock at once).
  useEffect(() => {
    if (hydrated) setLocked(useSettingsStore.getState().appLock);
  }, [hydrated]);

  useEffect(() => {
    if (!appLock) {
      backgroundedAt.current = null;
      setLocked(false);
    }
  }, [appLock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (prompting.current) return; // the system prompt itself pauses the app
      const { appLock: enabled, autoLock } = useSettingsStore.getState();
      if (state === 'background') {
        backgroundedAt.current = Date.now();
        if (enabled && autoLock === 'immediate') setLocked(true);
      } else if (state === 'active') {
        const lock = shouldLock({ enabled, backgroundedAt: backgroundedAt.current, now: Date.now(), autoLock });
        backgroundedAt.current = null;
        if (lock) {
          logEvent('info', 'app locked after background');
          setLocked(true);
        }
      }
    });
    return () => sub.remove();
  }, []);

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    setBusy(true);
    setMessage(null);
    const result = await authenticate(t('lockPromptUnlock'), t('cancel'));
    prompting.current = false;
    setBusy(false);
    // 'unavailable': the phone no longer has a screen lock; never lock the person out.
    if (result === 'ok' || result === 'unavailable') {
      backgroundedAt.current = null;
      setLocked(false);
    } else if (result === 'failed') {
      setMessage(t('lockAuthFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (hydrated && locked && appLock && AppState.currentState === 'active') void unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, locked, appLock]);

  if (hydrated && !locked) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: colors.background }]}>
      {hydrated ? (
        <>
          <Feather name="lock" size={34} color={colors.primary} />
          <Text style={[styles.title, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold') }]}>
            {t('lockedTitle')}
          </Text>
          {message ? (
            <Text style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), fontSize: 13 }}>{message}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void unlock()}
            style={({ pressed }) => [styles.button, { backgroundColor: colors.primary, opacity: pressed || busy ? 0.7 : 1 }]}
          >
            {busy ? <ActivityIndicator color="#fff" /> : null}
            <Text style={{ color: '#fff', fontFamily: fontFamilyFor(language, 'medium'), fontSize: 15 }}>{t('lockUnlock')}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { zIndex: 1000, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  title: { fontSize: 22 },
  button: { minHeight: 48, minWidth: 180, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 6 },
});
