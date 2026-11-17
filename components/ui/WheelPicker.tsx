import { StyleSheet, useWindowDimensions } from 'react-native';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { radii } from '@/constants/theme';
import { useI18n } from '@/src/i18n';
import { rowOf, wheelLayout } from '@/src/lib/layout';
import { WHEEL_ITEM_HEIGHT, WheelColumn } from './WheelColumn';

export type WheelSpec = { key: string; items: string[]; index: number; onIndexChange: (i: number) => void; label: string; flex?: number };

/** Card with several `WheelColumn`s side by side and one highlighted row across all of them (onboarding birthday). */
export function WheelPicker({ columns }: { columns: WheelSpec[] }) {
  const colors = useColors();
  const { isRTL } = useI18n();
  const { fontScale } = useWindowDimensions();
  const { itemHeight } = wheelLayout(fontScale);
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View pointerEvents="none" style={[styles.bar, { backgroundColor: colors.raised, height: itemHeight, marginTop: -itemHeight / 2 }]} />
      <View style={{ flexDirection: rowOf(isRTL) }}>
        {columns.map((c) => (
          <WheelColumn key={c.key} items={c.items} index={c.index} onIndexChange={c.onIndexChange} accessibilityLabel={c.label} flex={c.flex} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.card, borderWidth: 1, paddingHorizontal: 10, justifyContent: 'center', overflow: 'hidden' },
  bar: { position: 'absolute', start: 10, end: 10, top: '50%', height: WHEEL_ITEM_HEIGHT, marginTop: -WHEEL_ITEM_HEIGHT / 2, borderRadius: 14 },
});
