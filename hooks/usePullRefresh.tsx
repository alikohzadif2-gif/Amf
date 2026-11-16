import { useCallback, useRef, useState } from 'react';
import { RefreshControl } from 'react-native';
import { useColors } from '@/hooks/useColors';

/**
 * Pull-to-refresh like Explore's: `control` goes into a ScrollView/FlatList as `refreshControl`.
 * A failing task never throws out of the gesture; the spinner always stops.
 */
export function usePullRefresh(task: () => Promise<unknown>) {
  const colors = useColors();
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(task);
  latest.current = task;
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await latest.current();
    } catch {
      // the screen keeps what it had
    } finally {
      setRefreshing(false);
    }
  }, []);
  const control = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />;
  return { refreshing, onRefresh, control };
}
