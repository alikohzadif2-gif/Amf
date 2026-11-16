import { useRef, type ReactNode } from 'react';
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Horizontal scroller for chip rows and tile grids. It is always laid out physically left-to-right (`direction: 'ltr'`) so Android
 * behaves the same in every language; in RTL the caller reverses the item order (see `toColumns`) and this component jumps to the
 * right end whenever its content changes, so the first item sits at the right edge.
 */
export function HScroll({ children, rtl, contentStyle }: { children: ReactNode; rtl: boolean; contentStyle?: StyleProp<ViewStyle> }) {
  const ref = useRef<ScrollView>(null);
  return (
    <ScrollView
      ref={ref}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ direction: 'ltr' }}
      contentContainerStyle={[{ direction: 'ltr', paddingHorizontal: 22 }, contentStyle]}
      onContentSizeChange={() => (rtl ? ref.current?.scrollToEnd({ animated: false }) : ref.current?.scrollTo({ x: 0, animated: false }))}
    >
      {children}
    </ScrollView>
  );
}
