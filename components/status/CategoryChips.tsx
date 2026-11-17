import { View } from 'react-native';
import { Chip } from '@/components/ui';
import { useI18n } from '@/src/i18n';
import { HScroll } from './HScroll';

/** Horizontally scrolling category chips ("All" first). In RTL the order is reversed and the row starts at the right edge (see `HScroll`). */
export function CategoryChips<T extends string>({ items, value, onChange, onLongPress }: { items: { id: T; label: string; a11y?: string }[]; value: T; onChange: (id: T) => void; onLongPress?: (id: T) => void }) {
  const { isRTL } = useI18n();
  const list = isRTL ? [...items].reverse() : items;
  return (
    <View style={{ marginHorizontal: -22, marginBottom: 14 }}>
      <HScroll rtl={isRTL}>
        <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
          {list.map((c) => (
            <Chip key={c.id} label={c.label} accessibilityLabel={c.a11y} selected={value === c.id} onPress={() => onChange(c.id)} onLongPress={onLongPress ? () => onLongPress(c.id) : undefined} />
          ))}
        </View>
      </HScroll>
    </View>
  );
}
