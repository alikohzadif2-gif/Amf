import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import type { CustomCategory } from './categories';
import { listCustomCategories } from './category-db';

/** The person's custom diary categories, reloaded whenever the screen gains focus and after `reload()`. */
export function useCustomCategories(): { customs: CustomCategory[]; reload: () => Promise<CustomCategory[]> } {
  const db = useSQLiteContext();
  const [customs, setCustoms] = useState<CustomCategory[]>([]);
  const reload = useCallback(async (): Promise<CustomCategory[]> => {
    try {
      const list = await listCustomCategories(db);
      setCustoms(list);
      return list;
    } catch {
      setCustoms([]);
      return [];
    }
  }, [db]);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  return { customs, reload };
}
