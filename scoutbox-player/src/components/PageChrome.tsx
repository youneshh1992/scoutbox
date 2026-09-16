// M23 P2.5 — page chrome for the player app.
//
// PageHeader: one compact row — title, optional back control, optional
// primary action, then the bell and the ⚑ Report button that every screen
// carries. Every tab used to draw its own 26px title row; this is the one
// place that decides what a page header looks like.
//
// PageTabs: the "functions of one destination" control. A destination is a
// tab in the bar; the things you do there are page tabs. Rendered as a real
// tablist so a screen reader, a keyboard and a test all see the same thing.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../theme';
import { pt } from '../i18n';
import { NotificationBell } from './NotificationBell';
import { ReportButton } from './ReportSheet';

export function PageHeader({ title, back, action, hint }: { title: string; back?: boolean; action?: ReactNode; hint?: string }) {
  const router = useRouter();
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          {back && (
            <Pressable accessibilityRole="button" accessibilityLabel={pt('back')} onPress={() => router.back()} style={styles.back}>
              <Text style={styles.backText}>‹</Text>
            </Pressable>
          )}
          <Text role="heading" aria-level={1} style={styles.h1} numberOfLines={1}>{title}</Text>
        </View>
        <View style={styles.actions}>
          {action}
          <NotificationBell />
          <ReportButton />
        </View>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export interface PageTab { key: string; label: string }

export function PageTabs({ tabs, value, onChange }: { tabs: PageTab[]; value: string; onChange: (key: string) => void }) {
  return (
    <View role="tablist" aria-label={pt('sectionsOf')} style={styles.tabs}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <Pressable
            key={t.key}
            role="tab"
            aria-selected={selected}
            onPress={() => onChange(t.key)}
            style={({ pressed }) => [styles.tab, selected && styles.tabOn, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.tabText, selected && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Reads `?tab=` so a page tab is deep-linkable, falling back to the first tab. */
export function pickTab(tabs: PageTab[], wanted: string | string[] | undefined): string {
  const w = Array.isArray(wanted) ? wanted[0] : wanted;
  return tabs.some((t) => t.key === w) ? (w as string) : tabs[0].key;
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 40 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  h1: { color: colors.text, fontSize: 21, fontWeight: '800', flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12.5, lineHeight: 17 },
  back: {
    width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg2, alignItems: 'center', justifyContent: 'center',
  },
  backText: { color: colors.text, fontSize: 20, lineHeight: 22 },
  tabs: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 3,
    borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg2,
  },
  tab: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 9, flexGrow: 1, alignItems: 'center' },
  tabOn: { backgroundColor: colors.panel },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  tabTextOn: { color: colors.text },
});
