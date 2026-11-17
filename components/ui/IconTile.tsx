import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { radii } from '@/constants/theme';
import { withAlpha } from '@/constants/colors';

/**
 * Rounded-square tile holding a Feather icon or an emoji (Settings row icons, event icon grid, emoji grids).
 * `color` tints the icon and a soft background; without it the tile uses the `raised` fill.
 * `selected` = coral border. Without `onPress` it is a plain View.
 */
export function IconTile({
  icon,
  emoji,
  size = 48,
  color,
  selected = false,
  onPress,
  accessibilityLabel,
}: {
  icon?: keyof typeof Feather.glyphMap;
  emoji?: string;
  size?: number;
  color?: string;
  selected?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const box = {
    width: size,
    height: size,
    borderRadius: Math.min(radii.tile, Math.round(size * 0.38)),
    backgroundColor: color ? withAlpha(color, 0.16) : colors.raised,
    borderColor: selected ? colors.primary : 'transparent',
  };
  const content = emoji ? (
    <Text style={{ fontSize: Math.round(size * 0.5) }}>{emoji}</Text>
  ) : icon ? (
    <Feather name={icon} size={Math.round(size * 0.46)} color={color ?? colors.foreground} />
  ) : null;
  if (!onPress) {
    return (
      <View style={[styles.tile, box]} accessibilityLabel={accessibilityLabel}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, box, { opacity: pressed ? 0.75 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
});
