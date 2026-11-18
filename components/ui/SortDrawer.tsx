import { Feather } from '@expo/vector-icons';
import { ScrollView, StyleSheet } from 'react-native';
import type { ReactNode } from 'react';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Chip } from '@/components/ui/Chip';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

/** Reusable sort/filter tool bar (Q8a; Memories reuse it in Q9): a row of tool chips, each opens a {@link SortDrawer}. */
export type SortTool<Id extends string = string> = { id: Id; label: string; value?: string; active?: boolean };

export function SortToolbar<Id extends string>({ tools, onOpen }: { tools: readonly SortTool<Id>[]; onOpen: (id: Id) => void }) {
  const { isRTL } = useI18n();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={[styles.bar, { flexDirection: rowOf(isRTL) }]}>
      {tools.map((tool) => (
        <Chip
          key={tool.id}
          label={tool.value ? `${tool.label}: ${tool.value}` : tool.label}
          trailingIcon="chevron-down"
          selected={tool.active}
          onPress={() => onOpen(tool.id)}
        />
      ))}
    </ScrollView>
  );
}

export type SortOption<Id extends string = string> = { id: Id; label: string };

/** Drawer with a vertical list of options (single choice); `children` replaces the list for custom tools (date range, Q8c). */
export function SortDrawer<Id extends string>({
  visible, title, options, value, onSelect, onClose, children, actionLabel, onAction, actionDisabled, bottomOffset,
}: {
  visible: boolean; title: string; options?: readonly SortOption<Id>[]; value?: Id;
  onSelect?: (id: Id) => void; onClose: () => void; children?: ReactNode;
  actionLabel?: string; onAction?: () => void; actionDisabled?: boolean; bottomOffset?: number;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} cancelLabel={t('cancel')} actionLabel={actionLabel} onAction={onAction} actionDisabled={actionDisabled} bottomOffset={bottomOffset}>
      {children ?? (options ?? []).map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => { onSelect?.(option.id); onClose(); }}
            style={[styles.row, { flexDirection: rowOf(isRTL), borderColor: colors.border }]}
          >
            <Text style={{ flex: 1, color: on ? colors.primary : colors.foreground, fontFamily: fontFamilyFor(language, on ? 'semibold' : 'regular'), fontSize: 16, textAlign: isRTL ? 'right' : 'left' }}>{option.label}</Text>
            {on ? <Feather name="check" size={18} color={colors.primary} /> : <View style={{ width: 18 }} />}
          </Pressable>
        );
      })}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  bar: { gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  row: { alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
});
