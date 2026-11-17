import { usePartnerStore } from '@/src/state/partner-store';
import { syncMailbox } from './manage';

/**
 * Pull-to-refresh of the app's own screens: fetch the partner mailbox now (new texts, statuses, memories, stories ...),
 * then make every screen read its data from the phone again. Does nothing network-wise when not paired.
 */
export async function refreshApp(): Promise<void> {
  try {
    await syncMailbox();
  } finally {
    const s = usePartnerStore.getState();
    s.bumpMoods();
    s.bumpEvents();
    s.bumpDiary();
    s.bumpStories();
    s.bumpChat();
    s.bumpReactions();
    s.bumpPeriod();
  }
}
