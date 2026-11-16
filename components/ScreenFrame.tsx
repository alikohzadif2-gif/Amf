import type { ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { usePullRefresh } from '@/hooks/usePullRefresh';
import { useTabBarHeight } from '@/components/ui/useTabBarHeight';
import { useI18n } from '@/src/i18n';

type ScreenFrameProps = {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** Tab screens: pad the bottom so content clears the floating tab bar (and the FAB above it). */
  tabBar?: boolean;
  /** Pull-to-refresh (scrolling frames only): runs this and shows the spinner until it ends. */
  onRefresh?: () => Promise<unknown>;
};

export function ScreenFrame({
  children,
  scroll = false,
  contentStyle,
  tabBar = false,
  onRefresh,
}: ScreenFrameProps) {
  const colors = useColors();
  const { isRTL } = useI18n();
  const direction = isRTL ? 'rtl' : 'ltr';
  const barSpace = useTabBarHeight();
  const pull = usePullRefresh(onRefresh ?? (async () => undefined));
  const tabPadding = tabBar ? { paddingBottom: barSpace + 96 } : null;

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { direction },
            tabPadding,
            contentStyle,
          ]}
          showsVerticalScrollIndicator={false}
          refreshControl={onRefresh ? pull.control : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, { direction }, tabBar ? { paddingBottom: barSpace } : null, contentStyle]}>
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 30,
  },
});
