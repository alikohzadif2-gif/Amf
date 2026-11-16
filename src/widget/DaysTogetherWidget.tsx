import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import colors, { accentColors } from '@/constants/colors';
import type { WidgetModel } from './model';

/** Same layout for light and dark (the library needs identical structure); only colours change. */
export function DaysTogetherWidget({ model, theme }: { model: WidgetModel; theme: 'light' | 'dark' }) {
  const palette = colors[theme];
  const accent = accentColors[model.accent] as `#${string}`;
  return (
    <FlexWidget
      clickAction="OPEN_APP"
      accessibilityLabel={`${model.title} ${model.days ?? ''}`.trim()}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: palette.card as `#${string}`,
        borderRadius: 24,
        padding: 12,
      }}
    >
      <TextWidget text={model.title} maxLines={1} style={{ fontSize: 13, color: palette.mutedForeground as `#${string}` }} />
      {model.days !== null ? (
        <TextWidget text={model.days} maxLines={1} style={{ fontSize: 44, fontWeight: 'bold', color: accent }} />
      ) : null}
      <TextWidget
        text={model.line}
        maxLines={2}
        style={{ fontSize: 12, textAlign: 'center', color: palette.mutedForeground as `#${string}` }}
      />
    </FlexWidget>
  );
}
