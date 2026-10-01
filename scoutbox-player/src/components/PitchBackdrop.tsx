// M24A — the reference's pitch behind the Player's content: faint white
// markings (touchline, halfway line, centre circle and spot, one penalty
// box) over a barely visible turf grain, sitting BEHIND every card and
// never in front of a tap.
//
// The markings are plain Views so they draw identically on iOS, Android and
// the web. The grain is two repeating gradients, which only CSS can paint;
// on the web it is a real background layer, on native the markings alone
// carry the texture (documented in M24A_DESIGN_IMPLEMENTATION.md).
// Everything here is absolutely positioned, pointerEvents="none" and hidden
// from assistive technology, so it never changes layout or focus order.
import { Platform, StyleSheet, View } from 'react-native';
import { useColors } from '../theme';

export function PitchBackdrop({ height = 510, top = 28 }: { height?: number; top?: number }) {
  const c = useColors();
  const line = { borderColor: c.pitch };
  const grain = Platform.OS === 'web'
    ? ({ backgroundImage: `repeating-linear-gradient(103deg, transparent 0 3px, ${c.grain} 3px 4px, transparent 4px 9px), repeating-linear-gradient(90deg, transparent 0 70px, ${c.band} 70px 140px)` } as unknown as object)
    : null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={[StyleSheet.absoluteFill, styles.layer, { overflow: 'hidden' }]}>
      {grain && <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.layer, grain]} />}
      {/* touchlines */}
      <View style={[styles.pitch, line, { top, height }]} />
      {/* halfway line */}
      <View style={[styles.half, line, { top: top + height / 2 }]} />
      {/* centre circle and spot */}
      <View style={[styles.circle, line, { top: top + height / 2 - 48 }]} />
      <View style={[styles.spot, { backgroundColor: c.pitch, top: top + height / 2 - 2 }]} />
      {/* penalty box, top end */}
      <View style={[styles.box, line, { top }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // pointer-events is inherited on the web, but every layer says so itself:
  // nothing here may ever sit between a finger and a control.
  layer: { pointerEvents: 'none', zIndex: 0 },
  pitch: { pointerEvents: 'none', position: 'absolute', left: 12, right: 12, borderWidth: 1, borderRadius: 2 },
  half: { pointerEvents: 'none', position: 'absolute', left: 12, right: 12, borderTopWidth: 1 },
  circle: { pointerEvents: 'none', position: 'absolute', left: '50%', marginLeft: -48, width: 96, height: 96, borderRadius: 48, borderWidth: 1 },
  spot: { pointerEvents: 'none', position: 'absolute', left: '50%', marginLeft: -2, width: 4, height: 4, borderRadius: 2 },
  box: { pointerEvents: 'none', position: 'absolute', left: '28%', width: '44%', height: 65, borderWidth: 1, borderTopWidth: 0 },
});
