import { StyleSheet, Text, View } from 'react-native';

/** A thin bar showing how much of a download has arrived (0..100), with an optional label above it. */
export function DownloadBar({ percent, label, font }: { percent: number; label?: string; font?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <View style={styles.wrap} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: clamped }}>
      {label ? <Text style={[styles.label, font ? { fontFamily: font } : null]}>{`${label} ${clamped}%`}</Text> : null}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${clamped}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: 6 },
  label: { color: '#FFFFFF', fontSize: 13, textAlign: 'center' },
  track: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3, backgroundColor: '#FFFFFF' },
});
