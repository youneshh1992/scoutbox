// The one ScoutBox wordmark: "ScoutBox" in Albert Sans ExtraBold, the brand
// green square drawn as a box on the baseline (never the ▪ glyph, which the
// font centres on the x-height), and the ™ raised beside it. Used by the
// Player's Home header and its entry screen; the portals draw the same mark
// in CSS (`.wordmark::after` + `.tm`).
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useColors } from '../theme';

export function Wordmark({ size = 24, color, tmColor, label }: { size?: number; color?: string; tmColor?: string; label?: string }) {
  const c = useColors();
  const ink = color ?? c.text;
  const square = Math.max(5, Math.round(size * 0.25));
  return (
    <View style={styles.row} accessibilityRole="header" aria-level={1} accessibilityLabel={label ?? 'ScoutBox'}>
      <Text style={{ color: ink, fontSize: size, fontWeight: '800', letterSpacing: -size * 0.046, lineHeight: Math.round(size * 1.08) }}>ScoutBox</Text>
      <View style={{ width: square, height: square, borderRadius: 1, marginLeft: 3, backgroundColor: c.accent }} />
      <Text style={{ color: tmColor ?? c.muted, fontSize: Math.max(7, Math.round(size * 0.33)), fontWeight: '700', letterSpacing: 0.4, lineHeight: Math.max(9, Math.round(size * 0.42)), alignSelf: 'flex-start', marginLeft: 1 }} accessibilityLabel="trademark">TM</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline' },
});
