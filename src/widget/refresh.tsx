import React from 'react';
import { requestWidgetUpdate } from 'react-native-android-widget';
import { DaysTogetherWidget } from './DaysTogetherWidget';
import { loadModel } from './load';

/** Redraws the widget after the date changes. Never throws: Expo Go has no widget module and no widget may be on the home screen. */
export async function refreshWidget(): Promise<void> {
  try {
    await requestWidgetUpdate({
      widgetName: 'DaysTogether',
      renderWidget: async () => {
        const model = await loadModel();
        return {
          light: <DaysTogetherWidget model={model} theme="light" />,
          dark: <DaysTogetherWidget model={model} theme="dark" />,
        };
      },
    });
  } catch {
    // nothing to update
  }
}
