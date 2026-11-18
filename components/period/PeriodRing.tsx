import { View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import Svg, { Circle, G } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import type { DayInfo } from '@/src/period/cycle';
import { ringArcs, ringMarker } from '@/src/period/ring';

const SIZE = 232;
const STROKE = 20;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/** Circular cycle ring (react-native-svg): period, fertile window and PMS arcs, today's dot, the day number inside. */
export function PeriodRing({ info, dayText, caption, phaseText }: { info: DayInfo | null; dayText: string; caption: string; phaseText: string }) {
  const colors = useColors();
  const { language } = useI18n();
  const tint = { period: colors.primary, fertile: colors.success, pms: colors.moodSelected } as const;
  const mid = SIZE / 2;
  const arcs = info ? ringArcs(info) : [];
  const angle = info ? ringMarker(info) * 2 * Math.PI - Math.PI / 2 : 0;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', width: SIZE, height: SIZE, alignSelf: 'center' }} accessible accessibilityLabel={`${caption} ${dayText}, ${phaseText}`}>
      <Svg width={SIZE} height={SIZE}>
        <Circle cx={mid} cy={mid} r={R} stroke={colors.track} strokeWidth={STROKE} fill="none" />
        <G rotation={-90} origin={`${mid}, ${mid}`}>
          {arcs.map((a) => (
            <Circle
              key={a.phase}
              cx={mid}
              cy={mid}
              r={R}
              stroke={tint[a.phase]}
              strokeWidth={STROKE}
              fill="none"
              strokeDasharray={`${(a.to - a.from) * C} ${C}`}
              strokeDashoffset={-a.from * C}
            />
          ))}
        </G>
        {info ? <Circle cx={mid + R * Math.cos(angle)} cy={mid + R * Math.sin(angle)} r={STROKE / 2 + 3} fill={colors.card} stroke={colors.foreground} strokeWidth={3} /> : null}
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center', paddingHorizontal: 40 }}>
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13 }}>{caption}</Text>
        <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 52, lineHeight: language === 'fa' ? 74 : 60 }}>{dayText}</Text>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 14 }}>{phaseText}</Text>
      </View>
    </View>
  );
}
