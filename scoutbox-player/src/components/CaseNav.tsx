// M24B — the player's category control: one row of pills that scrolls
// sideways, the current one heavier and marked with a dot (never colour
// alone), every target at least 44px tall. The subcategories below it are
// the existing `PageTabs` underline tabs. The current category is scrolled
// into view so it is never off screen at 360px.
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { Gradient } from './Vivid';
import { Text } from './Text';
import { useColors, useStyles, type Palette } from '../theme';
import { pt } from '../i18n';
import type { PlayerCaseNav } from '../caseNav';

export function CaseCategories({ model, value, onChange }: { model: PlayerCaseNav; value: string; onChange: (categoryId: string) => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const scroll = useRef<ScrollView>(null);
  const xs = useRef<Record<string, number>>({});
  useEffect(() => {
    const x = xs.current[value];
    if (typeof x === 'number') scroll.current?.scrollTo({ x: Math.max(0, x - 16), animated: true });
  }, [value]);
  return (
    <View accessibilityLabel={pt('caseAreas')} style={styles.wrap} testID="case-categories">
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
        {model.categories.map((c) => {
          const active = c.id === value;
          return (
            <Pressable
              key={c.id}
              onLayout={(e) => { xs.current[c.id] = e.nativeEvent.layout.x; }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              aria-selected={active}
              accessibilityLabel={pt(c.labelKey as Parameters<typeof pt>[0])}
              onPress={() => { if (!active) onChange(c.id); }}
              style={({ pressed }) => [styles.pill, active && styles.pillOn, pressed && { opacity: 0.75 }]}
              testID={`cat-${c.id}`}
            >
              {active && <Gradient control />}<Icon name={({ journey: 'route', contact: 'message-circle', trial: 'calendar-days', offer: 'file-text', signing: 'file-check-2' } as Record<string, string>)[c.id] ?? 'compass'} size={20} color={active ? colors.gradientInk : colors.iconFg} />
              <Text style={[styles.text, active && styles.textOn]} numberOfLines={1}>{pt(c.labelKey as Parameters<typeof pt>[0])}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  wrap: { marginHorizontal: -18 },
  row: { paddingHorizontal: 18, gap: 6, paddingVertical: 2 },
  pill: { overflow: 'hidden', minHeight: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel, flexDirection: 'row', alignItems: 'center', gap: 7 },
  pillOn: { backgroundColor: colors.tabActiveBg, borderColor: colors.tabActiveBg },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { color: colors.muted, fontSize: 13.5, fontWeight: '500' },
  textOn: { color: colors.gradientInk, fontWeight: '700' },
});
