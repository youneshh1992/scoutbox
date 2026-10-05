import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import { SafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, RadialGradient, Stop, Rect, Circle } from 'react-native-svg';
import { useColors, useTheme } from '../theme';
import { Text } from './Text';
import { Icon } from './Icon';

export const SPECTRUM = ['#00e676', '#37dcff', '#ad85ff', '#ff6eac', '#ffd166'] as const;
export function Gradient({ colors = ['#c6ff63', '#00e676', '#00bdb7'], diagonal = true, radius = 0 }: { colors?: readonly string[]; diagonal?: boolean; radius?: number }) {
  const id = useId().replace(/:/g, '');
  return <View pointerEvents="none" aria-hidden accessible={false} style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}><Svg width="100%" height="100%" preserveAspectRatio="none"><Defs><LinearGradient id={id} x1="0%" y1="0%" x2={diagonal ? '100%' : '0%'} y2="100%">{colors.map((c, i) => <Stop key={i} offset={i / (colors.length - 1)} stopColor={c} />)}</LinearGradient></Defs><Rect width="100%" height="100%" fill={`url(#${id})`} /></Svg></View>;
}

/** Native SVG lights, not remote artwork. Content remains readable over a dark centre. */
export function Atmosphere() {
  const { scheme } = useTheme(); const dark = scheme === 'dark'; const id = useId().replace(/:/g, '');
  const lights = dark ? ['#00b77b', '#44128d', '#e6008f', '#00bdd6'] : ['#62ffb5', '#c1afff', '#ffa5d5', '#63e8ff'];
  return <View pointerEvents="none" accessible={false} aria-hidden style={StyleSheet.absoluteFill}><Svg width="100%" height="100%" viewBox="0 0 430 900" preserveAspectRatio="none"><Defs>{lights.map((c, i) => <RadialGradient key={i} id={`${id}${i}`}><Stop offset="0" stopColor={c} stopOpacity={dark ? 0.6 : 0.55} /><Stop offset="1" stopColor={c} stopOpacity="0" /></RadialGradient>)}</Defs><Rect width="430" height="900" fill={dark ? '#070c10' : '#f2fff9'} /><Circle cx="35" cy="30" r="270" fill={`url(#${id}0)`} /><Circle cx="400" cy="450" r="330" fill={`url(#${id}1)`} /><Circle cx="280" cy="940" r="410" fill={`url(#${id}2)`} /><Circle cx="-90" cy="830" r="290" fill={`url(#${id}3)`} /></Svg></View>;
}
export function PlayerScreen({ children, ...props }: SafeAreaViewProps) {
  return <SafeAreaView {...props}><Atmosphere />{children}</SafeAreaView>;
}

export function ColorAvatar({ initials, size = 52, index = 0, icon }: { initials?: string; size?: number; index?: number; icon?: string }) {
  const colors = [['#c6ff63', '#00e676', '#00bdb7'], ['#71f1ff', '#368dff', '#8f63ff'], ['#ffc765', '#ff568e', '#a456ff'], ['#e5b0ff', '#9c65ff', '#5168ff']][Math.abs(index) % 4];
  return <View style={{ width: size, height: size, borderRadius: size / 2, padding: 2, overflow: 'hidden', flexShrink: 0 }}><Gradient colors={colors} /><View style={{ flex: 1, borderRadius: size / 2, backgroundColor: '#0e2029', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#09151b' }}>{icon ? <Icon name={icon} size={size * 0.43} color={colors[0]} active /> : <Text style={{ color: colors[0], fontSize: size * 0.29, fontWeight: '800' }}>{initials}</Text>}</View></View>;
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
  return <Reveal><View accessibilityLabel={`${label}: ${value} out of 100`} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}><Svg width={size} height={size} viewBox="0 0 82 82" style={StyleSheet.absoluteFill}><Defs><LinearGradient id={id}><Stop offset="0" stopColor="#00e676" /><Stop offset="0.5" stopColor="#40dfff" /><Stop offset="1" stopColor="#ae83ff" /></LinearGradient></Defs><Circle cx="41" cy="41" r={radius} fill="none" stroke={c.line} strokeWidth="6" /><Circle cx="41" cy="41" r={radius} fill="none" stroke={`url(#${id})`} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${length * Math.max(0, Math.min(100, value)) / 100} ${length}`} transform="rotate(-90 41 41)" /></Svg><Text style={{ color: c.text, fontSize: 25, fontWeight: '800' }}>{value}</Text><Text style={{ color: c.muted, fontSize: 9 }}>OF 100</Text></View></Reveal>;
}
