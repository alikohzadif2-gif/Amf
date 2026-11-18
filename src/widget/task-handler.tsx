import React from 'react';
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { DaysTogetherWidget } from './DaysTogetherWidget';
import { loadModel } from './load';

/** Called by Android when the widget is added or on its periodic update (see app.json). Tapping it opens the app. */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps) {
  if (props.widgetInfo.widgetName !== 'DaysTogether') return;
  if (props.widgetAction === 'WIDGET_ADDED' || props.widgetAction === 'WIDGET_UPDATE' || props.widgetAction === 'WIDGET_RESIZED') {
    const model = await loadModel();
    props.renderWidget({
      light: <DaysTogetherWidget model={model} theme="light" />,
      dark: <DaysTogetherWidget model={model} theme="dark" />,
    });
  }
}
