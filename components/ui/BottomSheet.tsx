import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, BackHandler, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { cardScaleForDisplay, radii } from '@/constants/theme';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * Shared centered dialog for menus, pickers and small forms.
 * The body is scrollable and the card stays within the safe viewport so it cannot
 * be clipped by the bottom edge or overlap the floating tab bar.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  cancelLabel,
  actionLabel,
  onAction,
  actionDisabled,
  bottomOffset = 0,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  cancelLabel: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  bottomOffset?: number;
  children: ReactNode;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const displaySize = useSettingsStore((state) => state.displaySize);
  const cardScale = cardScaleForDisplay(displaySize);
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      anim.setValue(0);
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 240, mass: 0.8 }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, anim]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCloseRef.current();
      return true;
    });
    return () => sub.remove();
  }, [visible]);

  if (!mounted) return null;

  const actionOn = !!onAction && !actionDisabled;
  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  const opacity = anim;
  const maxCardHeight = Math.max(220, windowHeight - insets.top - insets.bottom - 48 - bottomOffset);

  return (
    <View style={[StyleSheet.absoluteFill, { direction: isRTL ? 'rtl' : 'ltr' }, styles.overlay]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={cancelLabel} style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <View style={styles.centerStage} pointerEvents="box-none">
        <Animated.View
          onStartShouldSetResponder={() => true}
          style={[
            styles.card,
            {
              width: Math.min(windowWidth - 40, 460),
              maxHeight: maxCardHeight,
              backgroundColor: colors.sheet,
              borderRadius: radii.card * cardScale,
              opacity,
              transform: [{ scale }],
            },
          ]}
        >
          <View style={[styles.header, { flexDirection: rowOf(isRTL), paddingHorizontal: 18 * cardScale, paddingTop: 18 * cardScale, paddingBottom: 14 * cardScale, borderBottomColor: colors.border }]}>
            <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose} style={styles.side}>
              <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 15 }}>{cancelLabel}</Text>
            </Pressable>
            <Text
              accessibilityRole="header"
              style={{ flex: 1, flexShrink: 1, textAlign: 'center', color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 17 }}
            >
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !actionOn }}
              disabled={!actionOn}
              hitSlop={10}
              onPress={onAction}
              style={[styles.side, { alignItems: isRTL ? 'flex-start' : 'flex-end' }]}
            >
              {actionLabel ? (
                <Text style={{ color: actionOn ? colors.primary : colors.mutedForeground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15 }}>
                  {actionLabel}
                </Text>
              ) : null}
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingHorizontal: 18 * cardScale, paddingTop: 16 * cardScale, paddingBottom: Math.max(16, insets.bottom * 0.25) * cardScale, gap: 14 * cardScale }}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  centerStage: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  card: { overflow: 'hidden', elevation: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 24 },
  header: { alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  side: { minWidth: 64 },
});
