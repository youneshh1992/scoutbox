// M23 P2.5 — page chrome for the player app.
//
// PageHeader: the reference's 64px phone header. Home carries the wordmark;
// every other page carries a back chevron (when it is not a tab root) and
// its title. On the right, in the reference's order: the page's own primary
// action, the appearance switch, the notification bell, and the Report
// control that every screen keeps (§33).
//
// PageTabs: the "functions of one destination" control — the reference's
// underline tabs. Rendered as a real tablist so a screen reader, a keyboard
// and a test all see the same thing.
import { useEffect, useRef, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from './Text';
import { Gradient } from './Vivid';
import { Icon } from './Icon';
import { useColors, useStyles, type Palette } from '../theme';
import { pt } from '../i18n';
import { NotificationBell } from './NotificationBell';
import { ReportButton } from './ReportSheet';
import { ThemeSwitch } from './ThemeSwitch';
import { Wordmark } from './Wordmark';

export function PageHeader({ title, back, action, hint, wordmark, prominent, accessory }: { title: string; back?: boolean; action?: ReactNode; hint?: string; wordmark?: boolean; prominent?: boolean; accessory?: ReactNode }) {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          {back && (
            <Pressable accessibilityRole="button" accessibilityLabel={pt('back')} onPress={() => router.back()} style={styles.back} hitSlop={8}>
              <Icon name="chevron-left" size={20} color={colors.text} />
            </Pressable>
          )}
          {wordmark ? (
            <Wordmark size={24} label={title} />
          ) : (
            <Text role="heading" aria-level={1} style={[styles.h1, prominent && { fontSize: width < 360 ? 22 : 28, fontWeight: '800', letterSpacing: -1 }]} numberOfLines={prominent ? 2 : 1}>{title}</Text>
          )}
        </View>
        <View style={styles.actions}>
          {accessory ?? <ThemeSwitch />}
          <NotificationBell />
          <ReportButton />
        </View>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {action ? <View style={styles.actionRow}>{action}</View> : null}
    </View>
  );
}

export interface PageTab { key: string; label: string }

export function PageTabs({ tabs, value, onChange }: { tabs: PageTab[]; value: string; onChange: (key: string) => void }) {
  const styles = useStyles(makeStyles);
  const scroll = useRef<ScrollView>(null);
  const positions = useRef<Record<string, number>>({});
  useEffect(() => { scroll.current?.scrollTo({ x: Math.max(0, (positions.current[value] ?? 0) - 12), animated: false }); }, [value]);
  return (
    <View role="tablist" aria-label={pt('sectionsOf')} style={styles.tabs}>
      <ScrollView horizontal ref={scroll} showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1, gap: 2 }}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <Pressable
            key={t.key}
            onLayout={(e) => { positions.current[t.key] = e.nativeEvent.layout.x; }}
            role="tab"
            aria-selected={selected}
            onPress={() => onChange(t.key)}
            style={({ pressed }) => [styles.tab, { minWidth: Math.max(66, t.label.length * 7 + 24) }, selected && styles.tabOn, pressed && { opacity: 0.7 }]}
          >
            {selected && <Gradient control />}<Text style={[styles.tabText, selected && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
      </ScrollView>
    </View>
  );
}

/** Reads `?tab=` so a page tab is deep-linkable, falling back to the first tab. */
export function pickTab(tabs: PageTab[], wanted: string | string[] | undefined): string {
  const w = Array.isArray(wanted) ? wanted[0] : wanted;
  return tabs.some((t) => t.key === w) ? (w as string) : tabs[0].key;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  header: { gap: 6, marginBottom: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 48 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  h1: { color: colors.text, fontSize: 24, fontWeight: '800', flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
  tabs: {
    flexDirection: 'row', gap: 2, justifyContent: 'space-between',
    backgroundColor: colors.panel2, borderRadius: 18, padding: 4, marginBottom: 16, zIndex: 1,
  },
  // M24B — a page tab is a 44px touch target (paddingVertical 13 + the 16px line keeps the underline tight to the text).
  tab: { minHeight: 44, paddingVertical: 13, paddingHorizontal: 4, overflow: 'hidden', borderRadius: 14, flexGrow: 1, alignItems: 'center', justifyContent: 'center', marginBottom: -1 },
  tabOn: { backgroundColor: colors.tabActiveBg },
  tabText: { color: colors.tabInactive, fontSize: 12, fontWeight: '500' },
  tabTextOn: { color: colors.gradientInk, fontWeight: '600' },
});
