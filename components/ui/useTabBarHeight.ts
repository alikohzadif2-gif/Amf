import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';
import { layout, navBarHeightForFontScale, textScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';

/** Space the floating tab bar occupies at the bottom of the screen (system inset + gap + bar). Content in tab screens pads by this. */
export function useTabBarHeight(): number {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const displaySize = useSettingsStore((state) => state.displaySize);
  const effectiveFontScale = fontScale * textScaleForDisplay(displaySize);
  return insets.bottom + layout.navBarBottomGap + navBarHeightForFontScale(effectiveFontScale);
}
