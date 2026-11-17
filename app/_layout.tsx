import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import {
  Vazirmatn_400Regular,
  Vazirmatn_500Medium,
  Vazirmatn_600SemiBold,
  Vazirmatn_700Bold,
} from '@expo-google-fonts/vazirmatn';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { AppState, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSettingsHydrated, useSettingsStore } from '@/src/state/settings-store';
import { welcomeTarget } from '@/src/lib/welcome';
import { PartnerListener } from '@/components/partner/PartnerListener';
import { FEATURES } from '@/src/constants/features';
import { AppLockGate } from '@/components/security/AppLockGate';
import { installErrorCapture, loadLog, logEvent } from '@/src/diagnostics/log';
import { initializeDatabase } from '@/src/lib/database';
import { setSharedDb } from '@/src/vault/db-ref';
import { runLegacyMigration } from '@/src/vault/legacy-migrate';
import { refreshWidget } from '@/src/widget/refresh';

installErrorCapture();
void loadLog();

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

/** Phone status bar (clock, battery, signal): dark icons on the light theme, light icons on the dark theme. Follows the app's theme setting, not only the system one. */
function AppStatusBar() {
  const colors = useColors();
  return <StatusBar style={colors.isDark ? 'light' : 'dark'} />;
}

function RootLayoutNav() {
  const colors = useColors();
  const pathname = usePathname();
  useEffect(() => {
    logEvent('info', `nav: ${pathname}`); // in-memory only: traceEvent rewrites the whole log file synchronously
  }, [pathname]);
  const hydrated = useSettingsHydrated();
  const onboarded = useSettingsStore((s) => s.onboarded);
  const target = welcomeTarget(hydrated, onboarded);
  // Wait for the saved settings first, otherwise the welcome would flash for existing users.
  if (target === 'wait') return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={target === 'welcome'}>
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={target === 'app'}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* The pop animation of this form keeps its TextInputs attached while Fabric re-mounts them: crash on save (logcat). */}
        <Stack.Screen name="diary/new" options={{ headerShown: false, animation: 'none' }} />
        <Stack.Screen name="story/new" options={{ headerShown: false, animation: 'slide_from_bottom' }} />
        <Stack.Screen name="story/view" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="chat" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

/** Hands the open database to code that has no React context (the pick kit adds files to Direct with it). */
function SharedDbBridge() {
  const db = useSQLiteContext();
  useEffect(() => {
    setSharedDb(db);
    // Stage 2A-3: copy the old gallery/app-folder library into Direct once (no deletes), in the background after start-up.
    const timer = setTimeout(() => void runLegacyMigration(db), 3000);
    return () => {
      clearTimeout(timer);
      setSharedDb(null);
    };
  }, [db]);
  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Vazirmatn_400Regular,
    Vazirmatn_500Medium,
    Vazirmatn_600SemiBold,
    Vazirmatn_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => logEvent('info', `app state: ${state}`));
    return () => sub.remove();
  }, []);

  // Redraw the days-together widget each time the app opens (new day, changed language/digits/calendar).
  useEffect(() => {
    void refreshWidget();
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary onError={(error) => logEvent('error', `render: ${error.name}: ${error.message}`)}>
        <GestureHandlerRootView>
          <KeyboardProvider>
            <SQLiteProvider
              databaseName="meyou.db"
              onInit={initializeDatabase}
            >
              <SharedDbBridge />
              {FEATURES.partner ? <PartnerListener /> : null}
              <AppStatusBar />
              <RootLayoutNav />
              <AppLockGate />
            </SQLiteProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
