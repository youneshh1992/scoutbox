import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, AppState, Dimensions, Easing, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

type MotionState = 'waiting' | 'running' | 'complete' | 'reduced';

/** Reveal once per screen visit, only when the plot (not just its card) is visible.
 * Web uses clipped intersection geometry; native measures while awaiting entry.
 * No background timers after playback, and no continuous/pulsing animation. */
export function ChartEntrance({ children }: { children: (progress: Animated.Value) => ReactNode }) {
  const host = useRef<View>(null);
  const progress = useRef(new Animated.Value(1)).current;
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [state, setState] = useState<MotionState>('waiting');
  const [run, setRun] = useState(0);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));

  useEffect(() => {
    let mounted = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      changed = true;
      if (mounted) setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted && !changed) setReduced(value);
    }).catch(() => { if (mounted && !changed) setReduced(true); });
    return () => { mounted = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(1);
    if (!focused || reduced === null) { setState('waiting'); return; }
    if (reduced) { setState('reduced'); return; }
    let disposed = false;
    let played = false;
    let intersection = false;
    let observer: IntersectionObserver | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let animation: Animated.CompositeAnimation | undefined;
    setState('waiting');
    const start = () => {
      if (disposed || played) return;
      played = true;
      observer?.disconnect();
      if (timer) clearInterval(timer);
      progress.setValue(0);
      setState('running');
      setRun(value => value + 1);
      animation = Animated.timing(progress, {
        toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      });
      animation.start(({ finished }) => { if (!disposed && finished) setState('complete'); });
    };
    const checkWeb = () => {
      if (document.visibilityState === 'visible' && intersection) start();
    };
    if (Platform.OS === 'web' && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(entries => {
        intersection = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.35);
        checkWeb();
      }, { threshold: [0, 0.35], rootMargin: '0px 0px -80px 0px' });
      if (host.current) observer.observe(host.current as unknown as Element);
      document.addEventListener('visibilitychange', checkWeb);
    } else {
      // Also covers older web engines: measure the visible plot, not mount time.
      const measure = () => {
        if (AppState.currentState !== 'active') return;
        host.current?.measureInWindow((x, y, width, height) => {
          const screen = Dimensions.get('window');
          const visibleHeight = Math.min(y + height, screen.height - 64) - Math.max(y, 0);
          const visibleWidth = Math.min(x + width, screen.width) - Math.max(x, 0);
          if (width > 0 && height > 0 && visibleWidth > 0 && visibleHeight >= height * 0.35) start();
        });
      };
      timer = setInterval(measure, 160);
      measure();
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      if (timer) clearInterval(timer);
      animation?.stop();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', checkWeb);
    };
  }, [focused, reduced, progress]);

  return <View ref={host} collapsable={false} testID="season-bars-motion" {...(Platform.OS === 'web' ? { dataSet: { motionState: state, motionRun: String(run) } } : {})}>
    {children(progress)}
  </View>;
}
