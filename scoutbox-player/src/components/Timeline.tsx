import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors } from '../theme';

/** Decorative chronology marker, never an online/verification indicator.
 * A steady core remains visible; only its halo breathes, slowly. */
function TimelinePoint() {
  const c = useColors();
  const pulse = useRef(new Animated.Value(0)).current;
  useFocusEffect(useCallback(() => {
    let alive = true; let reduced = true; let preferenceChanged = false;
    let animation: Animated.CompositeAnimation | undefined;
    const sync = () => {
      animation?.stop(); pulse.setValue(0);
      const active = Platform.OS === 'web' ? document.visibilityState === 'visible' : AppState.currentState === 'active';
      if (!alive || reduced || !active) return;
      animation = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true, isInteraction: false }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true, isInteraction: false }),
      ]));
      animation.start();
    };
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { preferenceChanged = true; reduced = value; sync(); });
    const app = AppState.addEventListener('change', sync);
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', sync);
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive && !preferenceChanged) { reduced = value; sync(); } }).catch(() => {});
    return () => { alive = false; animation?.stop(); pulse.setValue(0); motion.remove(); app.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', sync); };
  }, [pulse]));
  return <View accessible={false} aria-hidden pointerEvents="none" testID="timeline-point" style={{ width: 20, height: 24, alignItems: 'center', justifyContent: 'center' }}>
    <Animated.View style={{ position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: c.accent, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.38] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.35] }) }] }} />
    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent, borderWidth: 1, borderColor: c.accentText }} />
  </View>;
}

/** Keep sibling items in one gap-free View so rails meet, including expanded details. */
export function TimelineItem({ date, children, last = false, testID }: { date: string; children: ReactNode; last?: boolean; testID?: string }) {
  const c = useColors();
  return <View testID={testID} style={{ flexDirection: 'row', gap: 12 }}>
    <View style={{ width: 20, flexShrink: 0 }}>
      {!last && <View testID="timeline-rail" accessible={false} aria-hidden style={{ position: 'absolute', width: 2, top: 12, bottom: -12, left: 9, backgroundColor: c.accent, opacity: 0.25 }} />}
      <TimelinePoint />
    </View>
    <View style={{ flex: 1, minWidth: 0, paddingTop: 3, paddingBottom: last ? 4 : 22, gap: 5 }}>
      {date ? <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18, fontWeight: '500' }}>{date}</Text> : null}
      {typeof children === 'string' || typeof children === 'number' ? <Text style={{ color: c.text, fontSize: 14, lineHeight: 21, fontWeight: '500' }}>{children}</Text> : children}
    </View>
  </View>;
}

export function EventRow({ date, label, onPress, testID, children, open: initial = false, last = false }: { date: string; label: string; onPress?: () => void; testID?: string; children?: ReactNode; open?: boolean; last?: boolean }) {
  const c = useColors(); const [open, setOpen] = useState(initial);
  const expandable = !!children; const press = expandable ? () => setOpen(v => !v) : onPress;
  return <TimelineItem date={date} last={last} testID={testID}>
    <Pressable onPress={press} disabled={!press} accessibilityRole={press ? 'button' : undefined} accessibilityLabel={`${label}. ${date}`} accessibilityState={expandable ? { expanded: open } : undefined} aria-expanded={expandable ? open : undefined} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: press ? 44 : undefined, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ flex: 1, color: c.text, fontSize: 14.5, lineHeight: 21, fontWeight: '600' }}>{label}</Text>
      {press && <Icon name={expandable && open ? 'chevron-down' : 'chevron-right'} size={17} color={c.accentText} />}
    </Pressable>
    {expandable && open && <View style={{ padding: 12, gap: 8, backgroundColor: c.panel, borderRadius: 12, borderWidth: 1, borderColor: c.line }}>{children}</View>}
  </TimelineItem>;
}
