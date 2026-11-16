import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { RingState } from '@/src/stories/story-logic';

const RING = 2.5;
const GAP = 2;
/** Total space the ring adds around the avatar on each side; the wrapper uses it as a negative margin so the layout does not move. */
const EXTRA = RING + GAP;

/** Instagram-style ring around an avatar: colourful = a story to watch, grey = already watched, nothing = no story. */
export function StoryRing({ state, size, children }: { state: RingState; size: number; children: ReactNode }) {
  const colors = useColors();
  if (state === 'none') return <>{children}</>;
  const outer = size + EXTRA * 2;
  const inner = (
    <View style={{ width: size + GAP * 2, height: size + GAP * 2, borderRadius: (size + GAP * 2) / 2, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  );
  if (state === 'seen') {
    return (
      <View style={[styles.base, { width: outer, height: outer, borderRadius: outer / 2, margin: -EXTRA, borderWidth: RING - 0.5, borderColor: colors.border }]}>
        {inner}
      </View>
    );
  }
  return (
    <LinearGradient
      colors={['#FFB347', colors.primary, '#C13584']}
      start={{ x: 0, y: 1 }}
      end={{ x: 1, y: 0 }}
      style={[styles.base, { width: outer, height: outer, borderRadius: outer / 2, margin: -EXTRA }]}
    >
      {inner}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
