import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ListenerState } from '@/src/partner/mailbox-client';
import type { LocalProfile, Profile } from '@/src/partner/types';

/**
 * Pairing metadata is persisted here. The mailbox bearer token lives only in SecureStore.
 */
type PartnerState = {
  deviceId: string;
  serverUrl: string;
  role: 'owner' | 'member' | null;
  serverDeviceId: string;
  partnerDeviceId: string;
  paired: boolean;
  /** Unix seconds, retained for older local records and the existing UI. */
  pairedAt: number;
  /** Mailbox sequence cursor; numeric strings avoid precision loss. */
  lastSeq: string;
  /** Encrypted-queue cursor (stage 3), same format as `lastSeq`. */
  lastE2eSeq: string;
  me: LocalProfile;
  /** UTC ISO date the couple got together (Home "days together"). Local to this phone. */
  togetherSince?: string;
  /** Q7: the partner's own cycle length (15-60) from their last `period` message; undefined = use the estimate. */
  partnerCycleDays?: number;
  /** null until the partner's first `profile` message arrives. */
  partner: Profile | null;
  /** Not persisted: connection state and counters that screens watch to reload the mood / event lists. */
  link: ListenerState;
  moodTick: number;
  eventTick: number;
  periodTick: number;
  diaryTick: number;
  storyTick: number;
  chatTick: number;
  /** Likes / comments under library files changed (the viewer reloads them). */
  reactTick: number;
  setDeviceId: (id: string) => void;
  setPaired: (connection: { serverUrl: string; role: 'owner' | 'member'; serverDeviceId: string; partnerDeviceId: string }, pairedAt: number) => void;
  clearPairing: () => void;
  setLastSeq: (seq: string) => void;
  setLastE2eSeq: (seq: string) => void;
  setMe: (p: LocalProfile) => void;
  setPartner: (p: Profile | null) => void;
  setLink: (s: ListenerState) => void;
  bumpMoods: () => void;
  bumpEvents: () => void;
  bumpDiary: () => void;
  bumpStories: () => void;
  bumpChat: () => void;
  bumpReactions: () => void;
  bumpPeriod: () => void;
  setTogetherSince: (iso: string | undefined) => void;
  setPartnerCycleDays: (days: number | undefined) => void;
};

export const usePartnerStore = create<PartnerState>()(
  persist(
    (set) => ({
      deviceId: '',
      serverUrl: '',
      role: null,
      serverDeviceId: '',
      partnerDeviceId: '',
      paired: false,
      pairedAt: 0,
      lastSeq: '0',
      lastE2eSeq: '0',
      me: {},
      partner: null,
      link: 'stopped',
      moodTick: 0,
      eventTick: 0,
      periodTick: 0,
      diaryTick: 0,
      storyTick: 0,
      chatTick: 0,
      reactTick: 0,
      setDeviceId: (deviceId) => set({ deviceId }),
      setPaired: (connection, pairedAt) => set({ ...connection, paired: true, pairedAt, lastSeq: '0', lastE2eSeq: '0', partner: null, partnerCycleDays: undefined }),
      clearPairing: () => set({ serverUrl: '', role: null, serverDeviceId: '', partnerDeviceId: '', paired: false, pairedAt: 0, lastSeq: '0', lastE2eSeq: '0', partner: null, partnerCycleDays: undefined, link: 'stopped' }),
      setLastSeq: (lastSeq) => set((state) => {
        const old = state.lastSeq || '0';
        const next = lastSeq.replace(/^0+(?=\d)/, '');
        return next.length > old.length || (next.length === old.length && next > old) ? { lastSeq: next } : state;
      }),
      setLastE2eSeq: (lastE2eSeq) => set((state) => {
        const old = state.lastE2eSeq || '0';
        const next = lastE2eSeq.replace(/^0+(?=\d)/, '');
        return next.length > old.length || (next.length === old.length && next > old) ? { lastE2eSeq: next } : state;
      }),
      setMe: (me) => set({ me }),
      setPartner: (partner) => set({ partner }),
      setLink: (link) => set({ link }),
      bumpMoods: () => set((s) => ({ moodTick: s.moodTick + 1 })),
      bumpEvents: () => set((s) => ({ eventTick: s.eventTick + 1 })),
      bumpDiary: () => set((s) => ({ diaryTick: s.diaryTick + 1 })),
      bumpStories: () => set((s) => ({ storyTick: s.storyTick + 1 })),
      bumpChat: () => set((s) => ({ chatTick: s.chatTick + 1 })),
      bumpReactions: () => set((s) => ({ reactTick: s.reactTick + 1 })),
      bumpPeriod: () => set((s) => ({ periodTick: s.periodTick + 1 })),
      setTogetherSince: (togetherSince) => set({ togetherSince }),
      setPartnerCycleDays: (partnerCycleDays) => set({ partnerCycleDays }),
    }),
    {
      name: 'meyou-partner',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<PartnerState>;
        // An older build paired through a different transport. That pairing cannot authenticate to the mailbox API, so it is dropped.
        return {
          deviceId: old.deviceId ?? '',
          serverUrl: '',
          role: null,
          serverDeviceId: '',
          partnerDeviceId: '',
          paired: false,
          pairedAt: 0,
          lastSeq: '0',
          me: old.me ?? {},
          togetherSince: old.togetherSince,
          partner: null,
        };
      },
      partialize: ({ deviceId, serverUrl, role, serverDeviceId, partnerDeviceId, paired, pairedAt, lastSeq, lastE2eSeq, me, togetherSince, partner }) => ({ deviceId, serverUrl, role, serverDeviceId, partnerDeviceId, paired, pairedAt, lastSeq, lastE2eSeq, me, togetherSince, partner }),
    },
  ),
);
