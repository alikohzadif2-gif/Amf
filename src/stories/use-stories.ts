import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { usePartnerStore } from '@/src/state/partner-store';
import { listActiveStories } from './stories-db';
import { msUntilNextExpiry, type StoryRow } from './story-logic';

/** My active stories and the partner's, reloaded on focus, when a story message arrives and exactly when the next one expires. */
export function useStories() {
  const db = useSQLiteContext();
  const tick = usePartnerStore((s) => s.storyTick);
  const [mine, setMine] = useState<StoryRow[]>([]);
  const [partner, setPartner] = useState<StoryRow[]>([]);

  const load = useCallback(async () => {
    const now = Date.now();
    const [a, b] = await Promise.all([listActiveStories(db, true, now), listActiveStories(db, false, now)]);
    setMine(a);
    setPartner(b);
  }, [db]);

  useEffect(() => {
    void load();
  }, [load, tick]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    const wait = msUntilNextExpiry([...mine, ...partner], Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => void load(), Math.min(Math.max(wait, 1000), 2 ** 30));
    return () => clearTimeout(timer);
  }, [mine, partner, load]);

  return { mine, partner, reload: load };
}
