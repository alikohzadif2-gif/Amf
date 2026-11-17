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
  /** Encrypted-queue cursor (numeric string, avoids precision loss). */
  lastE2eSeq: string;
  /** Unix ms of the last successful contact with the queue; 0 = never recorded (see src/sync/cursor-logic.ts). */
  lastContactAt: number;
  /** A full-list repair (sync digest) is owed: set when pairing and when the phone detects lost or stale state; cleared once a digest was sent. */
  repairPending: boolean;
  me: LocalProfile;
  /** UTC ISO date the couple got together (Home "days together"). Local to this phone. */
  togetherSince?: string;
  /** Q7: the partner's own cycle length (15-60) from their last `period` message; undefined = use the estimate. */
  partnerCycleDays?: number;
  /** null until the partner's first `profile` message arrives. */
  partner: Profile | null;
  /** Not persisted: connection state and counters that screens watch to reload the mood / event lists. */
  link: ListenerState;
  /** Not persisted: the partner has the app open right now (server `presence` frame); null = not known. */
  partnerOnline: boolean | null;
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
  setLastE2eSeq: (seq: string) => void;
  setContact: (ms: number) => void;
  requestRepair: () => void;
  markRepaired: (ms: number) => void;
  setMe: (p: LocalProfile) => void;
  setPartner: (p: Profile | null) => void;
  setLink: (s: ListenerState) => void;
  setPartnerOnline: (online: boolean | null) => void;
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
      lastE2eSeq: '0',
      lastContactAt: 0,
      repairPending: false,
      me: {},
      partner: null,
      link: 'stopped',
      partnerOnline: null,
      moodTick: 0,
      eventTick: 0,
      periodTick: 0,
      diaryTick: 0,
      storyTick: 0,
      chatTick: 0,
      reactTick: 0,
      setDeviceId: (deviceId) => set({ deviceId }),
      setPaired: (connection, pairedAt) => set({ ...connection, paired: true, pairedAt, lastE2eSeq: '0', lastContactAt: 0, repairPending: true, partner: null, partnerCycleDays: undefined }),
      clearPairing: () => set({ serverUrl: '', role: null, serverDeviceId: '', partnerDeviceId: '', paired: false, pairedAt: 0, lastE2eSeq: '0', lastContactAt: 0, repairPending: false, partner: null, partnerCycleDays: undefined, link: 'stopped', partnerOnline: null }),
      setLastE2eSeq: (lastE2eSeq) => set((state) => {
        const old = state.lastE2eSeq || '0';
        const next = lastE2eSeq.replace(/^0+(?=\d)/, '');
        return next.length > old.length || (next.length === old.length && next > old) ? { lastE2eSeq: next } : state;
      }),
      setContact: (lastContactAt) => set({ lastContactAt }),
      requestRepair: () => set((state) => (state.repairPending ? state : { repairPending: true })),
      markRepaired: (lastContactAt) => set({ repairPending: false, lastContactAt }),
      setMe: (me) => set({ me }),
      setPartner: (partner) => set({ partner }),
      setLink: (link) => set((state) => (link === 'connected' || state.partnerOnline === null ? { link } : { link, partnerOnline: null })),
      setPartnerOnline: (partnerOnline) => set({ partnerOnline }),
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
              me: old.me ?? {},
          togetherSince: old.togetherSince,
          partner: null,
        };
      },
      partialize: ({ deviceId, serverUrl, role, serverDeviceId, partnerDeviceId, paired, pairedAt, lastE2eSeq, lastContactAt, repairPending, me, togetherSince, partner }) => ({ deviceId, serverUrl, role, serverDeviceId, partnerDeviceId, paired, pairedAt, lastE2eSeq, lastContactAt, repairPending, me, togetherSince, partner }),
    },
  ),
);
