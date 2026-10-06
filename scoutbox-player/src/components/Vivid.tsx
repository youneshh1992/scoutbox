import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import { SafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, RadialGradient, Stop, Rect, Circle, Path } from 'react-native-svg';
import { useColors, useTheme } from '../theme';
import { Text } from './Text';
import { Icon } from './Icon';

/** Exact CSS 135deg geometry, including non-square controls. */
export function Gradient({ colors, diagonal = true, radius = 0, contrast = true, opacity = 1, control = false }: { colors?: readonly string[]; diagonal?: boolean; radius?: number; contrast?: boolean; opacity?: number; control?: boolean }) {
  const c = useColors(); const softControl = control;
  const stops = colors ?? [c.accent, c.gradientEnd];
  const id = useId().replace(/:/g, '');
  const [box, setBox] = useState({ width: 1, height: 1 });
  const reach = (box.width + box.height) / 4;
  return <View onLayout={({ nativeEvent: { layout } }) => setBox({ width: layout.width, height: layout.height })} pointerEvents="none" aria-hidden accessible={false} style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden', backgroundColor: softControl ? c.panel : 'transparent' }]}><Svg width="100%" height="100%" opacity={opacity * (softControl ? 0.7 : 1)}><Defs><LinearGradient id={id} gradientUnits="userSpaceOnUse" x1={diagonal ? box.width / 2 - reach : 0} y1={diagonal ? box.height / 2 - reach : 0} x2={diagonal ? box.width / 2 + reach : 0} y2={diagonal ? box.height / 2 + reach : box.height}>{stops.map((color, i) => <Stop key={i} offset={i / Math.max(1, stops.length - 1)} stopColor={color} />)}</LinearGradient></Defs><Rect width="100%" height="100%" fill={`url(#${id})`} />{contrast && <Rect width="100%" height="100%" fill={c.gradientShade} />}</Svg></View>;
}

/** Stationary emerald, teal and blue colour with a restrained warm edge. A neutral top-left pocket protects the logo. */
export function Atmosphere() {
  const c = useColors(); const { scheme } = useTheme(); const dark = scheme === 'dark';
  const id = useId().replace(/:/g, '');
  return <View pointerEvents="none" accessible={false} aria-hidden style={[StyleSheet.absoluteFill, { backgroundColor: c.bg, overflow: 'hidden' }]}>
    <Svg width="100%" height="100%" viewBox="0 0 430 900" preserveAspectRatio="xMidYMin slice">
      <Defs>
        <LinearGradient id={`${id}base`} x1="0%" y1="0%" x2="90%" y2="100%">
          <Stop offset="0" stopColor="#effaf4" /><Stop offset="0.32" stopColor="#e5f5ef" /><Stop offset="0.68" stopColor="#e3edf5" /><Stop offset="1" stopColor="#eeeae1" />
        </LinearGradient>
        <RadialGradient id={`${id}green`}><Stop offset="0" stopColor="#00e676" stopOpacity={dark ? 0.16 : 0.36} /><Stop offset="1" stopColor="#00e676" stopOpacity="0" /></RadialGradient>
        <RadialGradient id={`${id}cyan`}><Stop offset="0" stopColor="#00c8ff" stopOpacity={dark ? 0.12 : 0.18} /><Stop offset="1" stopColor="#00c8ff" stopOpacity="0" /></RadialGradient>
        <RadialGradient id={`${id}blue`}><Stop offset="0" stopColor="#176cc4" stopOpacity="0.24" /><Stop offset="1" stopColor="#176cc4" stopOpacity="0" /></RadialGradient>
        <RadialGradient id={`${id}warm`}><Stop offset="0" stopColor="#c39754" stopOpacity="0.17" /><Stop offset="1" stopColor="#c39754" stopOpacity="0" /></RadialGradient>
        <RadialGradient id={`${id}logo`}><Stop offset="0" stopColor={dark ? c.bg : '#ffffff'} stopOpacity="1" /><Stop offset="0.55" stopColor={dark ? c.bg : '#ffffff'} stopOpacity="0.96" /><Stop offset="1" stopColor={dark ? c.bg : '#ffffff'} stopOpacity="0" /></RadialGradient>
      </Defs>
      <Rect width="430" height="900" fill={dark ? c.bg : `url(#${id}base)`} />
      <Circle cx="430" cy="260" r="245" fill={`url(#${id}cyan)`} />
      <Circle cx="-35" cy="680" r="310" fill={`url(#${id}green)`} />
      {!dark && <>
        <Circle cx="410" cy="620" r="310" fill={`url(#${id}blue)`} />
        <Circle cx="345" cy="940" r="260" fill={`url(#${id}warm)`} />
        <Circle cx="0" cy="155" r="230" fill={`url(#${id}green)`} />
      </>}
      <Circle cx="70" cy="20" r="190" fill={`url(#${id}logo)`} />
    </Svg>
  </View>;
}

/** One aligned pitch drawing; boxes sit inside the touchlines. */
export function PitchArt({ color }: { color: string }) {
  return <Svg color={color} width="110" height="70" viewBox="0 0 160 100" accessible={false} aria-hidden>
    <Rect x="5" y="5" width="150" height="90" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <Path d="M80 5V95 M5 27H29V73H5 M155 27H131V73H155 M5 39H15V61H5 M155 39H145V61H155" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <Circle cx="80" cy="50" r="14" fill="none" stroke="currentColor" strokeWidth="1.2" /><Circle cx="80" cy="50" r="1.5" fill="currentColor" />
  </Svg>;
}
export function PlayerScreen({ children, ...props }: SafeAreaViewProps) {
  return <SafeAreaView {...props}><Atmosphere />{children}</SafeAreaView>;
}

export function ColorAvatar({ initials, size = 52, index = 0, icon }: { initials?: string; size?: number; index?: number; icon?: string }) {
  const colors = [['#00e676', '#0088ff'], ['#00c8ff', '#0088ff'], ['#00e676', '#00c8ff']][Math.abs(index) % 3];
  return <View style={{ width: size, height: size, borderRadius: size / 2, padding: 2, overflow: 'hidden', flexShrink: 0 }}><Gradient colors={colors} contrast={false} /><View style={{ flex: 1, borderRadius: size / 2, backgroundColor: '#0e2029', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#09151b' }}>{icon ? <Icon name={icon} size={size * 0.43} color={colors[0]} active /> : <Text style={{ color: colors[0], fontSize: size * 0.29, fontWeight: '800' }}>{initials}</Text>}</View></View>;
}

/** One quiet entrance per mount; accessibility preference wins, with cleanup. */
export function Reveal({ children, grow = false }: { children: ReactNode; grow?: boolean }) {
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let disposed = false; let animation: Animated.CompositeAnimation | undefined;
    const setMotion = (reduced: boolean) => {
      animation?.stop();
      if (disposed) return;
      if (reduced) { progress.setValue(1); return; }
      progress.setValue(0);
      animation = Animated.timing(progress, { toValue: 1, duration: 650, useNativeDriver: true }); animation.start();
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(setMotion).catch(() => {});
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setMotion);
    return () => { disposed = true; animation?.stop(); listener.remove(); };
  }, [progress]);
  return <Animated.View style={{ opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }), transformOrigin: 'bottom', transform: grow ? [{ scaleY: progress.interpolate({ inputRange: [0, 1], outputRange: [0.05, 1] }) }] : [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>{children}</Animated.View>;
}

export function ScoreRing({ value, label, size = 82 }: { value: number; label: string; size?: number }) {
  const c = useColors(); const id = useId().replace(/:/g, ''); const radius = 33; const length = 2 * Math.PI * radius;
  return <Reveal><View accessibilityLabel={`${label}: ${value} out of 100`} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}><Svg width={size} height={size} viewBox="0 0 82 82" style={StyleSheet.absoluteFill}><Defs><LinearGradient id={id}><Stop offset="0" stopColor="#00e676" /><Stop offset="0.5" stopColor="#40dfff" /><Stop offset="1" stopColor="#0088ff" /></LinearGradient></Defs><Circle cx="41" cy="41" r={radius} fill="none" stroke={c.line} strokeWidth="6" /><Circle cx="41" cy="41" r={radius} fill="none" stroke={`url(#${id})`} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${length * Math.max(0, Math.min(100, value)) / 100} ${length}`} transform="rotate(-90 41 41)" /></Svg><Text style={{ color: c.text, fontSize: 25, fontWeight: '800' }}>{value}</Text><Text style={{ color: c.muted, fontSize: 9 }}>OF 100</Text></View></Reveal>;
}
