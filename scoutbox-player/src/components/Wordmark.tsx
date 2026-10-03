// The one ScoutBox wordmark: "ScoutBox" in Albert Sans ExtraBold (the brand
// mark — M24E keeps it when everything else moved to Inter), the brand green
// square drawn as a box on the baseline (never the small-square glyph, which the font
// centres on the x-height), and the TM raised beside it. Used by the Player's
// Home header and its entry screen; the portals draw the same mark in CSS
// (`.wordmark` on `--sb-font-brand`, `.wordmark::after` + `.tm`).
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useColors } from '../theme';

export function Wordmark({ size = 24, color, tmColor, label }: { size?: number; color?: string; tmColor?: string; label?: string }) {
  const c = useColors();
  const ink = color ?? c.text;
  const square = Math.max(5, Math.round(size * 0.25));
  const lineHeight = Math.round(size * 1.08);
  const tmSize = Math.max(7, Math.round(size * 0.3));
  // M24F.2 — the ™ rides above the green square, tight to the final "x": one
  // column after the letters (2px gap), the square on the baseline, the ™ at
  // the top. The mark reads as one word.
  return (
    <View style={styles.row} accessibilityRole="header" aria-level={1} accessibilityLabel={label ?? 'ScoutBox'}>
      <Text brand style={{ color: ink, fontSize: size, fontWeight: '800', letterSpacing: -size * 0.046, lineHeight }}>ScoutBox</Text>
      <View style={{ marginLeft: 2, height: lineHeight, justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: Math.round(size * 0.06), paddingBottom: Math.round(size * 0.17) }} testID="wordmark-mark">
        <Text style={{ color: tmColor ?? c.muted, fontSize: tmSize, fontWeight: '700', letterSpacing: 0.3, lineHeight: tmSize + 1 }} accessibilityLabel="trademark">TM</Text>
        <View style={{ width: square, height: square, borderRadius: 1, backgroundColor: c.accent }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end' },
});
