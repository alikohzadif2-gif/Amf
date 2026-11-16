import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/constants/colors';

const THUMB_H = 52;
const HIT_W = 30;

export type FastScrollbarHandle = {
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSize: (h: number) => void;
  onLayout: (h: number) => void;
};

/**
 * A slim vertical scrollbar with a draggable handle for long lists (Explore). Fades out when idle.
 * Mount it over the list (position absolute); feed it the list's scroll events, and give it
 * `scrollTo(offset)` to move the list while the handle is dragged.
 */
export const FastScrollbar = forwardRef<FastScrollbarHandle, { scrollTo: (offset: number) => void; bottomInset?: number }>(function FastScrollbar(
  { scrollTo, bottomInset = 0 },
  ref,
) {
  const colors = useColors();
  const y = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const content = useRef(0);
  const view = useRef(0);
  const offset = useRef(0);
  const dragging = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trackH, setTrackH] = useState(0);
  const track = useRef(0);
  const [active, setActive] = useState(false);

  const range = () => Math.max(1, content.current - view.current);
  const travel = () => Math.max(1, track.current - THUMB_H);

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: false }).start();
    hideTimer.current = setTimeout(() => {
      if (!dragging.current) Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: false }).start();
    }, 1200);
  }, [opacity]);

  const place = useCallback(() => {
    const frac = Math.min(1, Math.max(0, offset.current / range()));
    y.setValue(frac * travel());
  }, [y]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    onScroll: (e) => {
      offset.current = e.nativeEvent.contentOffset.y;
      content.current = e.nativeEvent.contentSize.height;
      view.current = e.nativeEvent.layoutMeasurement.height;
      if (!dragging.current) {
        place();
        show();
      }
    },
    onContentSize: (h) => { content.current = h; },
    onLayout: (h) => { view.current = h; },
  }), [place, show]);

  const startFrac = useRef(0);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          dragging.current = true;
          setActive(true);
          if (hideTimer.current) clearTimeout(hideTimer.current);
          opacity.setValue(1);
          // jump the handle under the finger, then follow it
          const frac = Math.min(1, Math.max(0, (e.nativeEvent.locationY - THUMB_H / 2) / travel()));
          startFrac.current = frac;
          y.setValue(frac * travel());
          scrollTo(frac * range());
        },
        onPanResponderMove: (_e, g) => {
          const frac = Math.min(1, Math.max(0, startFrac.current + g.dy / travel()));
          y.setValue(frac * travel());
          scrollTo(frac * range());
        },
        onPanResponderRelease: () => { dragging.current = false; setActive(false); show(); },
        onPanResponderTerminate: () => { dragging.current = false; setActive(false); show(); },
      }),
    [opacity, scrollTo, show, y],
  );

  return (
    <View
      pointerEvents="box-none"
      style={[styles.track, { bottom: bottomInset }]}
      onLayout={(e) => { track.current = e.nativeEvent.layout.height; setTrackH(e.nativeEvent.layout.height); }}
    >
      {trackH > 0 ? (
        <Animated.View style={[styles.hit, { opacity, transform: [{ translateY: y }] }]} {...pan.panHandlers}>
          <View style={[styles.thumb, { width: active ? 8 : 5, backgroundColor: withAlpha(colors.foreground, active ? 0.55 : 0.35) }]} />
        </Animated.View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  track: { position: 'absolute', top: 0, right: 0, width: HIT_W },
  hit: { position: 'absolute', top: 0, right: 0, width: HIT_W, height: THUMB_H, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 3 },
  thumb: { height: THUMB_H - 8, borderRadius: 4 },
});
