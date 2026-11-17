import { create } from 'zustand';
import type { PushState } from '@/src/partner/push';

/** Not persisted: what the last push registration attempt ended with (the Settings screen shows it). */
type PushStore = {
  state: PushState;
  setState: (state: PushState) => void;
};

export const usePushStore = create<PushStore>()((set) => ({
  state: 'unknown',
  setState: (state) => set({ state }),
}));
