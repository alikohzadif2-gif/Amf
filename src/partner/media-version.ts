import { create } from 'zustand';

/** Counts the pictures stored from the partner (stage 4). Screens that show a shared photo list it in their effect deps and look again when it changes. */
export const usePartnerMediaVersion = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
