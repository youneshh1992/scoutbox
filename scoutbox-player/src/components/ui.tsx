// The Player's primitives. M24A: every colour comes from the active
// palette (theme.ts) and every glyph of text is Inter (Text.tsx).
//
// M24F — a card is not the default primitive. `Card` is now a SECTION: a
// hairline-ruled block of content with vertical breathing room and no box
// around it (whitespace and typography do the grouping). The few surfaces
// that genuinely are objects (a hero, a sheet) opt in with `raised`. Pills
// are quiet chips for real state; buttons have one primary, quiet
// secondaries, text tertiaries and a plainly destructive style.
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useState, type ReactNode } from 'react';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors, useStyles, type Palette } from '../theme';

export function Card({ children, style, testID, raised, flush }: { children: ReactNode; style?: ViewStyle; testID?: string; /** a real surface (hero, sheet) */ raised?: boolean; /** no top rule (first section under a heading) */ flush?: boolean }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.section, raised && styles.raised, flush && { borderTopWidth: 0, paddingTop: 0 }, style]} testID={testID}>{children}</View>;
}

export function Pill({ label, tone = 'default' }: { label: string; tone?: 'default' | 'green' | 'blue' | 'gold' | 'red' }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const tones = {
    default: { bg: colors.panel2, fg: colors.muted },
    green: { bg: colors.greenBg, fg: colors.greenInk },
    blue: { bg: colors.infoBg, fg: colors.infoInk },
    gold: { bg: colors.goldBg, fg: colors.goldInk },
    red: { bg: colors.dangerBg, fg: colors.dangerInk },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: tones.bg }]}>
      <Text style={{ color: tones.fg, fontSize: 11, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Button({ label, onPress, primary, danger, disabled, small, pill, tertiary, testID }: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  small?: boolean;
  /** M24C — the authentication submit: a compact rounded pill. */
  pill?: boolean;
  /** M24F — a text action, no border: for the third-level choice beside a primary. */
  tertiary?: boolean;
  /**
   * Optional stable handle for a live browser test. A label is the accessible
   * name and is translated; a testID is neither, so a journey can name the
   * control it means without pinning English.
   */
  testID?: string;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      // M21 §115: the control announces itself as a button and carries its
      // label, so it is reachable by keyboard and by a screen reader — and,
      // incidentally, by a test that drives the real interface.
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.btn,
        small && { paddingVertical: 7, paddingHorizontal: 12, minHeight: 34 },
        pill && { borderRadius: 999, paddingHorizontal: 24, alignSelf: 'flex-start', minHeight: 42 },
        primary && { backgroundColor: colors.accent, borderColor: colors.accent },
        danger && { backgroundColor: 'transparent', borderColor: colors.dangerBg },
        tertiary && { backgroundColor: 'transparent', borderColor: 'transparent', paddingHorizontal: 4, minHeight: small ? 30 : 38 },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={{ color: primary ? colors.accentInk : danger ? colors.danger : tertiary ? colors.accent2 : colors.text, fontWeight: '600', fontSize: small ? 12.5 : 13.5 }}>{label}</Text>
    </Pressable>
  );
}

export function SectionTitle({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles(makeStyles);
  return <Text role="heading" aria-level={2} style={styles.sectionTitle} testID={testID}>{children}</Text>;
}

export function Muted({ children, size = 13 }: { children: ReactNode; size?: number }) {
  const colors = useColors();
  return <Text style={{ color: colors.muted, fontSize: size, lineHeight: size * 1.5 }}>{children}</Text>;
}

/**
 * M18.1 — profile completeness, NOT the ScoutBox Trust Score. The name is kept
 * so call sites do not churn; the label says what the number actually is.
 */
export function TrustBar({ score }: { score: number }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>Profile {score}%</Text>
      <View style={styles.trustTrack}>
        <View style={[styles.trustFill, { width: `${score}%` }]} />
      </View>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, style]}>{children}</View>;
}

/** M24F — a list row: a label, an optional value line, a chevron when it leads somewhere. The Account page is made of these. */
export function ListRow({ label, value, onPress, testID, icon, right, danger }: { label: string; value?: string; onPress?: () => void; testID?: string; icon?: string; right?: ReactNode; danger?: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const body = (
    <>
      {icon ? <Icon name={icon} size={18} color={danger ? colors.danger : colors.muted} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</Text>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      </View>
      {right}
      {onPress && !right ? <Icon name="chevron-right" size={16} color={colors.muted} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.listRow} testID={testID}>{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={value ? `${label}. ${value}` : label} testID={testID} style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.7 }]}>
      {body}
    </Pressable>
  );
}

/** M24F — progressive disclosure: a row that opens its detail under it. Nothing is hidden for good; it is one tap away. */
export function Disclosure({ label, children, testID, open: initial = false, hint }: { label: string; children: ReactNode; testID?: string; open?: boolean; hint?: string }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(initial);
  return (
    <View testID={testID}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.7 }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowLabel}>{label}</Text>
          {hint ? <Text style={styles.rowValue}>{hint}</Text> : null}
        </View>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} color={colors.muted} />
      </Pressable>
      {open ? <View style={styles.disclosureBody}>{children}</View> : null}
    </View>
  );
}

/** M24F — a small uppercase kicker: the kind of a thing, where a pill would be noise. */
export function Kicker({ children, tone }: { children: ReactNode; tone?: 'urgent' | 'accent' }) {
  const colors = useColors();
  return <Text style={{ color: tone === 'urgent' ? colors.danger : tone === 'accent' ? colors.accentText : colors.muted, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}>{children}</Text>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  section: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 18,
    paddingBottom: 6,
    marginTop: 4,
    gap: 10,
  },
  raised: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 18,
    paddingTop: 18,
    paddingBottom: 18,
    marginTop: 8,
  },
  pill: {
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  btn: {
    backgroundColor: 'transparent',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '600',
    letterSpacing: -0.4,
    lineHeight: 24,
    marginTop: 26,
    marginBottom: 4,
  },
  trustTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.panel2,
    overflow: 'hidden',
  },
  trustFill: {
    height: '100%',
    backgroundColor: colors.accentText,
  },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowLabel: { color: colors.text, fontSize: 15, fontWeight: '500', lineHeight: 20 },
  rowValue: { color: colors.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  disclosureBody: { paddingTop: 10, paddingBottom: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
});
