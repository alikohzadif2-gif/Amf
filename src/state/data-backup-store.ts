import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DataMarks } from '@/src/backup/data-backup';

/** R10b: which versions of events/memories (and event photos) were already queued for the server (persisted). */
type DataBackupState = {
  marks: DataMarks;
  /** UTC ISO of the last run that queued something. */
  lastAt: string | null;
  /** Move mode: something was queued, so the app's own copies may be removed once the uploads are verified. */
  moveDue: boolean;
  setMoveDue: (due: boolean) => void;
  remember: (marks: DataMarks, at: string) => void;
};

export const useDataBackupStore = create<DataBackupState>()(
  persist(
    (set) => ({
      marks: {},
      lastAt: null,
      moveDue: false,
      setMoveDue: (moveDue) => set({ moveDue }),
      remember: (marks, lastAt) => set((s) => ({ marks: { ...s.marks, ...marks }, lastAt })),
    }),
    { name: 'meyou-data-backup', storage: createJSONStorage(() => AsyncStorage), version: 1, partialize: ({ marks, lastAt, moveDue }) => ({ marks, lastAt, moveDue }) as DataBackupState },
  ),
);
