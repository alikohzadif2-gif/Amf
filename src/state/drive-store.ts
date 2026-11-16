import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DriveAccount } from '@/src/drive/types';

/** The Drive folder that is the Archive's top level (the person can change it in Settings > Google Drive). */
export type DriveRootFolder = { id: string; name: string };

type DriveState = {
  /** Who is signed in (never a token: tokens stay with Google Play Services on the phone). */
  account: DriveAccount | null;
  rootFolder: DriveRootFolder | null;
  /** Where the photos/videos added to a new memory are stored: Google Drive (default) or this phone. */
  diarySource: 'drive' | 'phone';
  /** The Drive folder for memories (inside the Archive's folder); null = a `Diary` folder made on first use. */
  diaryFolder: DriveRootFolder | null;
  setDiarySource: (source: 'drive' | 'phone') => void;
  setDiaryFolder: (folder: DriveRootFolder | null) => void;
  setAccount: (account: DriveAccount | null) => void;
  setRootFolder: (folder: DriveRootFolder | null) => void;
  /** Signed out: forget the account and the chosen folders. */
  clear: () => void;
};

export const useDriveStore = create<DriveState>()(
  persist(
    (set) => ({
      account: null,
      rootFolder: null,
      diarySource: 'drive',
      diaryFolder: null,
      setDiarySource: (diarySource) => set({ diarySource }),
      setDiaryFolder: (diaryFolder) => set({ diaryFolder }),
      setAccount: (account) => set({ account }),
      setRootFolder: (rootFolder) => set({ rootFolder }),
      clear: () => set({ account: null, rootFolder: null, diaryFolder: null }),
    }),
    { name: 'meyou-drive-account', storage: createJSONStorage(() => AsyncStorage), version: 1 },
  ),
);
