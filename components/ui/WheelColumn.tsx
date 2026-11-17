import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { wheelLayout } from '@/src/lib/layout';
import { textScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';

export const WHEEL_ITEM_HEIGHT = 40;

/**
 * One column of a wheel picker: a small snap `ScrollView` (the lists are short, so no library is needed — a web search found
 * no clearly maintained Expo-compatible wheel picker). The row in the middle is the selection; rows fade and shrink with distance.
 * Controlled by `index`; `onIndexChange` fires once the wheel has settled. A vertical list does not depend on the text direction.
 * The highlight bar behind all columns is drawn by `WheelPicker`.
 */
export function WheelColumn({
  items,
  index,
  onIndexChange,
  accessibilityLabel,
  flex = 1,
}: {
  items: string[];
  index: number;
  onIndexChange: (index: number) => void;
  accessibilityLabel: string;
  flex?: number;
}) {
  const colors = useColors();
  const { language } = useI18n();
  const { fontScale } = useWindowDimensions();
  const displaySize = useSettingsStore((state) => state.displaySize);
  const textScale = textScaleForDisplay(displaySize);
  const effectiveFontScale = fontScale * textScale;
  const { itemHeight, visibleRows } = wheelLayout(effectiveFontScale);
  const pad = Math.floor(visibleRows / 2);
  const scrollY = useRef(new Animated.Value(index * itemHeight)).current;
  const ref = useRef<ScrollView>(null);
  const settled = useRef(index);
  const previousItemHeight = useRef(itemHeight);
  const last = items.length - 1;
  const clamp = (i: number) => Math.min(last, Math.max(0, i));

  const goTo = (i: number, animated: boolean) => ref.current?.scrollTo({ y: clamp(i) * itemHeight, animated });

  // first layout, and any change made from outside (calendar switched, day clamped to the month length)
  useEffect(() => {
    if (previousItemHeight.current !== itemHeight) {
      previousItemHeight.current = itemHeight;
      settled.current = index;
      scrollY.setValue(index * itemHeight);
      goTo(index, false);
    } else if (index !== settled.current) {
      settled.current = index;
      goTo(index, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length, itemHeight]);
  useEffect(() => {
    const id = setTimeout(() => goTo(index, false), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = (y: number) => {
    const i = clamp(Math.round(y / itemHeight));
    if (Math.abs(y - i * itemHeight) > 0.5) goTo(i, true);
    if (i !== settled.current) {
      settled.current = i;
      void Haptics.selectionAsync().catch(() => {});
      onIndexChange(i);
    }
  };
  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => settle(e.nativeEvent.contentOffset.y);
  const onDragEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // a slow release may not start a momentum phase; settle by hand
    if (Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05) settle(e.nativeEvent.contentOffset.y);
  };

  return (
    <Animated.ScrollView
      ref={ref as never}
      style={{ flex, height: itemHeight * visibleRows }}
      contentContainerStyle={{ paddingVertical: itemHeight * pad }}
      showsVerticalScrollIndicator={false}
      snapToInterval={itemHeight}
      decelerationRate="fast"
      nestedScrollEnabled
      scrollEventThrottle={16}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
      onMomentumScrollEnd={onMomentumEnd}
      onScrollEndDrag={onDragEnd}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: items[index] }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const next = clamp(index + (e.nativeEvent.actionName === 'increment' ? 1 : -1));
        settled.current = next;
        goTo(next, true);
        onIndexChange(next);
      }}
    >
      {items.map((label, i) => {
        const input = [-2, -1, 0, 1, 2].map((d) => (i + d) * itemHeight);
        const opacity = scrollY.interpolate({ inputRange: input, outputRange: [0.22, 0.5, 1, 0.5, 0.22], extrapolate: 'clamp' });
        const scale = scrollY.interpolate({ inputRange: input, outputRange: [0.8, 0.9, 1, 0.9, 0.8], extrapolate: 'clamp' });
        return (
          <Pressable key={`${i}-${label}`} onPress={() => { settled.current = i; goTo(i, true); onIndexChange(i); }} accessible={false} style={[styles.row, { height: itemHeight }]}>
            <Animated.Text
              style={[styles.text, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 19 * textScale, lineHeight: Math.ceil(24 * effectiveFontScale), opacity, transform: [{ scale }] }]}
            >
              {label}
            </Animated.Text>
          </Pressable>
        );
      })}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', justifyContent: 'center' },
  text: { width: '100%', fontSize: 19, textAlign: 'center', flexShrink: 1 },
});
