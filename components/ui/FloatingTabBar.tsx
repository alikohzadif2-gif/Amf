import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { scaleTextStyle } from '@/components/ui/scaling';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/constants/colors';
import { layout, navBarHeightForFontScale, radii, textScaleForDisplay } from '@/constants/theme';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { useSettingsStore } from '@/src/state/settings-store';
import { rowOf } from '@/src/lib/layout';
import { GENTLE_SPRING, SOFT_SPRING } from '@/src/lib/motion';

export type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];
type IconName = keyof typeof Ionicons.glyphMap;

export type TabItem = { name: string; label: TranslationKey; icon: IconName; iconActive: IconName };

/**
 * Floating pill tab bar (UI_PHASES 5.2): margin from the screen edges and above the system bar, radius 28,
 * active tab = pill-shaped tint + filled icon + coral label, inactive = muted outline icon + label.
 * Motion: one tint bubble slides (spring) to the tapped tab; the icon cross-fades outline -> filled with a small pop and the label colour fades.
 * Tab order mirrors in RTL (Home on the right). `items` maps route names to label/icons; routes not listed are skipped.
 */
export function FloatingTabBar({ state, navigation, items }: TabBarProps & { items: readonly TabItem[] }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { language, isRTL, t } = useI18n();
  const { fontScale } = useWindowDimensions();
  const displaySize = useSettingsStore((state) => state.displaySize);
  const effectiveFontScale = fontScale * textScaleForDisplay(displaySize);
  const textScale = textScaleForDisplay(displaySize);

  // Sliding bubble: tab positions come from onLayout (physical x, so RTL needs no special case).
  const [tabBoxes, setTabBoxes] = useState<Record<string, { x: number; w: number }>>({});
  const focusedKey = state.routes[state.index]?.key;
  const box = focusedKey ? tabBoxes[focusedKey] : undefined;
  const bubbleX = useSharedValue(0);
  const bubbleW = useSharedValue(0);
  const placed = useRef(false);
  useEffect(() => {
    if (!box) return;
    const x = box.x - BAR_BORDER; // absolute `left: 0` starts inside the border; onLayout x includes it
    if (!placed.current) {
      placed.current = true; // first layout: no slide-in from nowhere
      bubbleX.value = x;
      bubbleW.value = box.w;
      return;
    }
    bubbleX.value = withSpring(x, GENTLE_SPRING);
    bubbleW.value = withSpring(box.w, GENTLE_SPRING);
  }, [box?.x, box?.w]); // eslint-disable-line react-hooks/exhaustive-deps
  const bubbleStyle = useAnimatedStyle(() => ({ width: bubbleW.value, opacity: bubbleW.value > 0 ? 1 : 0, transform: [{ translateX: bubbleX.value }] }));

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + layout.navBarBottomGap, paddingHorizontal: layout.navBarMargin }]}>
      <View
        accessibilityRole="tablist"
        style={[
          styles.bar,
          {
            direction: isRTL ? 'rtl' : 'ltr',
            flexDirection: rowOf(isRTL),
            height: navBarHeightForFontScale(effectiveFontScale),
            // Nearly opaque instead of a live blur: 15 real-time blur views (this + the backdrop) re-drew the whole screen on every scroll frame.
            backgroundColor: withAlpha(colors.navBar, colors.isDark ? 0.94 : 0.92),
            borderColor: withAlpha('#FFFFFF', colors.isDark ? 0.14 : 0.7),
          },
        ]}
      >
        <Animated.View pointerEvents="none" style={[styles.bubble, { backgroundColor: withAlpha(colors.primary, 0.16) }, bubbleStyle]} />
        {state.routes.map((route, index) => {
          const item = items.find((i) => i.name === route.name);
          if (!item) return null;
          const focused = state.index === index;
          const label = t(item.label);
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <TabButton
              key={route.key}
              focused={focused}
              label={label}
              item={item}
              idleColor={colors.mutedForeground}
              activeColor={colors.primary}
              fontFamily={fontFamilyFor(language, focused ? 'bold' : 'medium')}
              textScale={textScale}
              onLayoutBox={(x, w) => setTabBoxes((prev) => (prev[route.key]?.x === x && prev[route.key]?.w === w ? prev : { ...prev, [route.key]: { x, w } }))}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            />
          );
        })}
      </View>
    </View>
  );
}

const BAR_BORDER = 1;

function TabButton({ focused, label, item, idleColor, activeColor, fontFamily, textScale, onLayoutBox, onPress, onLongPress }: {
  focused: boolean;
  label: string;
  item: TabItem;
  idleColor: string;
  activeColor: string;
  fontFamily: string;
  textScale: number;
  onLayoutBox: (x: number, w: number) => void;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const progress = useSharedValue(focused ? 1 : 0);
  const pop = useSharedValue(1);
  useEffect(() => {
    progress.value = withTiming(focused ? 1 : 0, { duration: 240 });
    if (focused) pop.value = withSequence(withTiming(0.78, { duration: 90 }), withSpring(1, SOFT_SPRING));
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps
  const iconWrap = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const outline = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const filled = useAnimatedStyle(() => ({ opacity: progress.value }));
  const labelStyle = useAnimatedStyle(() => ({ color: interpolateColor(progress.value, [0, 1], [idleColor, activeColor]) }));
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: focused }}
      onPress={onPress}
      onLongPress={onLongPress}
      onLayout={(e) => onLayoutBox(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={styles.tab}
    >
      <Animated.View style={[styles.icon, iconWrap]}>
        <Animated.View style={[StyleSheet.absoluteFill, outline]}>
          <Ionicons name={item.icon} size={24} color={idleColor} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, filled]}>
          <Ionicons name={item.iconActive} size={24} color={activeColor} />
        </Animated.View>
      </Animated.View>
      <Animated.Text style={[scaleTextStyle({ fontFamily, fontSize: 11.5, flexShrink: 1, textAlign: 'center' }, textScale), labelStyle]}>{label}</Animated.Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bubble: { position: 'absolute', left: 0, top: 6, bottom: 6, borderRadius: radii.navBar - 6 },
  icon: { width: 24, height: 24 },
  wrap: { position: 'absolute', start: 0, end: 0 },
  bar: {
    height: layout.navBarHeight,
    borderRadius: radii.navBar,
    borderWidth: 1,
    padding: 6,
    gap: 4,
    alignItems: 'stretch',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 0, // a translucent bar would show the Android elevation shadow through itself
  },
  tab: { flex: 1, borderRadius: radii.navBar - 6, alignItems: 'center', justifyContent: 'center', gap: 3 },
});
