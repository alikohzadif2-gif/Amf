import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { withAlpha } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { useTabBarHeight } from './useTabBarHeight';

/**
 * Soft fade behind the floating tab bar so scrolling content melts away under it instead of being cut off.
 * It is a plain gradient on purpose: it used to be 14 stacked real-time BlurViews (Android "dimezis" blur), which re-captured
 * and re-blurred the whole screen on every scroll frame and was the main cause of the laggy, low-fps feel.
 */
export function TabBarBackdrop() {
  const colors = useColors();
  const height = useTabBarHeight();
  return (
    <View pointerEvents="none" style={[styles.root, { height }]}>
      <LinearGradient
        colors={[withAlpha(colors.background, 0), withAlpha(colors.background, 0.55), withAlpha(colors.background, 0.88), withAlpha(colors.background, 0.97)]}
        locations={[0, 0.4, 0.72, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
