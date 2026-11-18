import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { TimeOrder } from '@/src/library/time-order';
import { createJSONStorage, persist } from 'zustand/middleware';
import { defaultAccent, type AccentName } from '@/constants/colors';
import type { DisplaySize } from '@/constants/theme';
import type { CustomActivity, CustomMood, StatusLabels } from '@/src/partner/status-custom';

export type Language = 'fa' | 'en';
export type ThemeMode = 'light' | 'dark' | 'auto';
export type CalendarMode = 'jalali' | 'gregorian' | 'both';
export type WeekStart = 'sat' | 'sun' | 'mon';
export type DigitMode = 'persian' | 'latin';
export type Gender = 'female' | 'male';

export type PreviewQuality = 'low' | 'medium' | 'high';
export type VideoMode = 'stream' | 'download';
export type AutoLock = 'immediate' | '1m' | '5m' | '15m';

/** Every persisted preference (no functions). Defaults live in settingsDefaults. */
export type SettingsValues = {
  // Language & calendar, appearance (Phase 1)
  language: Language;
  theme: ThemeMode;
  displaySize: DisplaySize;
  accent: AccentName;
  calendarMode: CalendarMode;
  weekStart: WeekStart;
  digits: DigitMode;
  // Server connection
  serverFailover: boolean;
  confirmFingerprint: boolean;
  // Media & cache
  thumbCacheMb: number;
  /** Stage 4: size cap (MB) of the partner's preview pictures kept on this phone. Thumbnails are not counted against it when trimming. */
  partnerCacheMb: number;
  /** Stage 4: send the medium preview of a new photo only on Wi-Fi/Ethernet (thumbnails always go at once). */
  previewQuality: PreviewQuality;
  videoMode: VideoMode;
  dataSaver: boolean;
  // Partner & notifications
  notifyMood: boolean;
  notifyEvent: boolean;
  notifyDiary: boolean;
  notifyPeriod: boolean;
  /** Q7: my own cycle length (15-60 days) used instead of the estimate; null = estimate. Sent with my `period` messages. */
  periodCycleDays: number | null;
  /** Q8a: which Archive time order is active when the Archive opens. */
  archiveTimeOrder: TimeOrder;
  /** Folders hidden from Explore (`sourceId\0folderId`); their files (and sub-folders') never show there. Local only. */
  exploreHiddenFolders: string[];
  // Status (R3): ids of moods / activities hidden from the Status tab (local only)
  hiddenMoods: string[];
  hiddenActivities: string[];
  // Status (Q4): my own moods/activities and edited labels of the built-in ones (local only; the label travels as text when sent)
  statusCustomMoods: CustomMood[];
  // colour (preset 0-7) the partner gave their own custom moods, by emoji; filled from their mood messages
  partnerMoodPresets: Record<string, number>;
  statusCustomActivities: CustomActivity[];
  statusLabels: StatusLabels;
  // Status (Q5): `mc:<id>`/`ac:<id>` of categories whose text is hidden (emoji only), or `all`; category names live in `statusLabels`
  statusHiddenNames: string[];
  // Security
  appLock: boolean;
  autoLock: AutoLock;
  blockScreenshots: boolean;
  /** Chosen on the first-run gender step (required). Male: the Period screen shows only the partner's cycle. null = not chosen yet (an install from before this step). */
  gender: Gender | null;
  // First run (U8): false until the welcome / onboarding is finished
  onboarded: boolean;
};

export const settingsDefaults: SettingsValues = {
  language: 'fa',
  theme: 'auto',
  displaySize: 'normal',
  accent: defaultAccent,
  calendarMode: 'jalali',
  weekStart: 'sat',
  digits: 'persian',
  serverFailover: true,
  confirmFingerprint: true,
  thumbCacheMb: 500,
  partnerCacheMb: 300,
  previewQuality: 'medium',
  videoMode: 'stream',
  dataSaver: false,
  notifyMood: true,
  notifyEvent: true,
  notifyDiary: true,
  notifyPeriod: true,
  periodCycleDays: null,
  archiveTimeOrder: 'all',
  exploreHiddenFolders: [],
  hiddenMoods: [],
  hiddenActivities: [],
  statusCustomMoods: [],
  partnerMoodPresets: {},
  statusCustomActivities: [],
  statusLabels: {},
  statusHiddenNames: [],
  appLock: false,
  autoLock: '1m',
  blockScreenshots: false,
  gender: null,
  onboarded: false,
};

type SettingsActions = {
  setSetting: <K extends keyof SettingsValues>(
    key: K,
    value: SettingsValues[K],
  ) => void;
  /** Resets every preference except the language, the gender and the first-run flag. */
  resetSettings: () => void;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeMode) => void;
  setDisplaySize: (displaySize: DisplaySize) => void;
  setAccent: (accent: AccentName) => void;
  setCalendarMode: (calendarMode: CalendarMode) => void;
  setWeekStart: (weekStart: WeekStart) => void;
  setDigits: (digits: DigitMode) => void;
};

export const useSettingsStore = create<SettingsValues & SettingsActions>()(
  persist(
    (set) => ({
      ...settingsDefaults,
      setSetting: (key, value) => set({ [key]: value } as Partial<SettingsValues>),
      resetSettings: () =>
        set((state) => ({ ...settingsDefaults, language: state.language, onboarded: state.onboarded, gender: state.gender })),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      setDisplaySize: (displaySize) => set({ displaySize }),
      setAccent: (accent) => set({ accent }),
      setCalendarMode: (calendarMode) => set({ calendarMode }),
      setWeekStart: (weekStart) => set({ weekStart }),
      setDigits: (digits) => set({ digits }),
    }),
    {
      name: 'meyou-settings',
      storage: createJSONStorage(() => AsyncStorage),
      version: 5,
      // v1 -> v2 only added keys. v2 -> v3 (U3): the default accent became coral for NEW installs;
      // existing users keep whatever accent they had saved (nothing is rewritten), and persist
      // merges any new keys with the defaults.
      // v3 -> v4 (U8): `onboarded`. Anyone who already has saved settings is an existing install and skips the welcome.
      // v4 -> v5 (R10a): `displaySize`; persist merges the new default for existing installs.
      // (A brand-new install has nothing saved, so migrate never runs and the default `false` applies.)
      migrate: (persisted, version) => {
        const state = persisted as SettingsValues & SettingsActions;
        return version < 4 ? { ...state, onboarded: true } : state;
      },
    },
  ),
);

/** True once the saved settings have been read from storage (used before the first-run redirect, like AppLockGate). */
export function useSettingsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useSettingsStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    const off = useSettingsStore.persist.onFinishHydration(() => setHydrated(true));
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true);
    return off;
  }, [hydrated]);
  return hydrated;
}
