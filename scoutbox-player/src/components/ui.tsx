// The Player's primitives. M24A: every colour comes from the active
// palette (theme.ts) and every glyph of text is Inter (Text.tsx); the
// shapes are the reference's phone components — 12px cards on a hairline
// rule, soft 5px chips, a full-width lime primary action with dark-green
// text, and headings that read as headings rather than uppercase labels.
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { Text } from './Text';
import { useColors, useStyles, type Palette } from '../theme';

export function Card({ children, style, testID }: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.card, style]} testID={testID}>{children}</View>;
}

export function Pill({ label, tone = 'default' }: { label: string; tone?: 'default' | 'green' | 'blue' | 'gold' | 'red' }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const tones = {
    default: { bg: colors.panel, border: colors.line, fg: colors.muted },
    green: { bg: colors.greenBg, border: colors.greenBg, fg: colors.greenInk },
    blue: { bg: colors.infoBg, border: colors.infoBg, fg: colors.infoInk },
    gold: { bg: colors.goldBg, border: colors.goldBg, fg: colors.goldInk },
    red: { bg: colors.dangerBg, border: colors.dangerBg, fg: colors.dangerInk },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: tones.bg, borderColor: tones.border }]}>
      <Text style={{ color: tones.fg, fontSize: 11, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Button({ label, onPress, primary, danger, disabled, small, pill, testID }: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  small?: boolean;
  /** M24C — the authentication submit: a compact rounded pill. */
  pill?: boolean;
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
        danger && { backgroundColor: colors.dangerBg, borderColor: colors.danger },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={{ color: primary ? colors.accentInk : danger ? colors.dangerInk : colors.text, fontWeight: '600', fontSize: small ? 12.5 : 13 }}>{label}</Text>
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.sectionTitle}>{children}</Text>;
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

const makeStyles = (colors: Palette) => StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  btn: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 11,
    paddingHorizontal: 16,
    minHeight: 43,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.3,
    marginTop: 14,
    marginBottom: 2,
  },
  trustTrack: {
    flex: 1,
    height: 8,
    borderRadius: 5,
    backgroundColor: colors.panel2,
    overflow: 'hidden',
  },
  trustFill: {
    height: '100%',
    backgroundColor: colors.accentText,
  },
});
