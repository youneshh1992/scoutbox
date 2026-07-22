import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { colors } from '../theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Pill({ label, tone = 'default' }: { label: string; tone?: 'default' | 'green' | 'blue' | 'gold' | 'red' }) {
  const tones = {
    default: { bg: 'transparent', border: colors.line, fg: colors.muted },
    green: { bg: colors.accent, border: colors.accent, fg: '#04240f' },
    blue: { bg: '#14497a', border: '#1c68af', fg: '#eaf6ff' },
    gold: { bg: colors.gold, border: colors.gold, fg: '#3a2c05' },
    red: { bg: '#8a2b2b', border: '#a83c3c', fg: '#fff' },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: tones.bg, borderColor: tones.border }]}>
      <Text style={{ color: tones.fg, fontSize: 11.5, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Button({ label, onPress, primary, danger, disabled, small }: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        small && { paddingVertical: 6, paddingHorizontal: 12 },
        primary && { backgroundColor: colors.accent, borderColor: colors.accent },
        danger && { backgroundColor: '#8a2b2b', borderColor: '#a83c3c' },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={{ color: primary ? '#04240f' : colors.text, fontWeight: '600', fontSize: small ? 13 : 15 }}>{label}</Text>
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Muted({ children, size = 13 }: { children: ReactNode; size?: number }) {
  return <Text style={{ color: colors.muted, fontSize: size, lineHeight: size * 1.45 }}>{children}</Text>;
}

export function TrustBar({ score }: { score: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: colors.muted, fontSize: 13 }}>Trust {score}</Text>
      <View style={styles.trustTrack}>
        <View style={[styles.trustFill, { width: `${score}%` }]} />
      </View>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  btn: {
    backgroundColor: colors.panel2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  sectionTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 10,
    marginBottom: 2,
  },
  trustTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bg2,
    overflow: 'hidden',
  },
  trustFill: {
    height: '100%',
    backgroundColor: colors.accent,
  },
});
