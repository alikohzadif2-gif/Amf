import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { FloatingTabBar, type TabBarProps, type TabItem } from '@/components/ui/FloatingTabBar';
import { TabBarBackdrop } from '@/components/ui/TabBarBackdrop';

/** Five tabs, Explore in the middle (UI_PHASES section 6). Settings is a stack screen opened from the Home avatar. */
const TABS: readonly TabItem[] = [
  { name: 'index', label: 'home', icon: 'home-outline', iconActive: 'home' },
  { name: 'status', label: 'tabStatus', icon: 'happy-outline', iconActive: 'happy' },
  { name: 'explore', label: 'tabExplore', icon: 'compass-outline', iconActive: 'compass' },
  { name: 'events', label: 'tabEvents', icon: 'calendar-outline', iconActive: 'calendar' },
  { name: 'diary', label: 'tabDiary', icon: 'book-outline', iconActive: 'book' },
];

/**
 * Renders nothing; it only hands the navigator's tab-bar props up. The real bar is drawn next to the navigator (not inside it).
 */
function BarBridge({ props, onProps }: { props: TabBarProps; onProps: (props: TabBarProps) => void }) {
  useEffect(() => {
    onProps(props);
  }, [props.state, props.navigation]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function TabLayout() {
  const [barProps, setBarProps] = useState<TabBarProps | null>(null);
  const renderBar = useCallback((props: TabBarProps) => <BarBridge props={props} onProps={setBarProps} />, []);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <Tabs screenOptions={{ headerShown: false }} tabBar={renderBar}>
          {TABS.map((tab) => (
            <Tabs.Screen key={tab.name} name={tab.name} />
          ))}
        </Tabs>
      </View>
      {barProps ? (
        <>
          <TabBarBackdrop />
          <FloatingTabBar {...barProps} items={TABS} />
        </>
      ) : null}
    </View>
  );
}
