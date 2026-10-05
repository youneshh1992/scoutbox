// The Player's primitives. M24A: every colour comes from the active
// palette (theme.ts) and every glyph of text is Inter (Text.tsx).
//
// Player refresh: grouped surfaces, rounded controls and semantic colours.
// Domain states retain their existing labels and actions.
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useState, type ReactNode } from 'react';
import { Text } from './Text';
import { Icon } from './Icon';
import { sectionIcon } from './sectionIcon';
import { Gradient, ColorAvatar } from './Vivid';
import { useColors, useStyles, type Palette } from '../theme';

export function Card({ children, style, testID, raised, flush }: { children: ReactNode; style?: ViewStyle; testID?: string; /** a real surface (hero, sheet) */ raised?: boolean; /** no top rule (first section under a heading) */ flush?: boolean }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.section, raised && styles.raised, flush && { marginTop: 0 }, style]} testID={testID}>{children}</View>;
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

export function Button({ label, onPress, primary, danger, disabled, small, pill, tertiary, testID, selected }: {
  label: string;
  onPress: () => void;
  selected?: boolean;
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
      accessibilityState={{ disabled: !!disabled, selected }}
      aria-pressed={selected}
      style={({ pressed }) => [
        styles.btn,
        small && { paddingVertical: 9, paddingHorizontal: 12, minHeight: 44 },
        pill && { borderRadius: 999, paddingHorizontal: 24, alignSelf: 'flex-start', minHeight: 42 },
        primary && { backgroundColor: colors.accent, borderColor: colors.accent },
        danger && { backgroundColor: 'transparent', borderColor: colors.dangerBg },
        tertiary && { backgroundColor: 'transparent', borderColor: 'transparent', paddingHorizontal: 4, minHeight: 44 },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      {primary && <Gradient />}
      <Text style={{ color: primary ? colors.accentInk : danger ? colors.danger : tertiary ? colors.accent2 : colors.text, fontWeight: '600', fontSize: small ? 12.5 : 13.5 }}>{label}</Text>
    </Pressable>
  );
}

export function SectionTitle({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 8 }}><Icon name={sectionIcon(typeof children === 'string' ? children : '')} size={25} color={colors.iconFg} /><Text role="heading" aria-level={2} style={[styles.sectionTitle, { marginTop: 0, marginBottom: 0, flex: 1 }]} testID={testID}>{children}</Text></View>;
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
export function ListRow({ label, value, count, onPress, testID, icon, right, danger }: { label: string; value?: string; count?: string | number; onPress?: () => void; testID?: string; icon?: string; right?: ReactNode; danger?: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  icon = icon ?? sectionIcon(label);
  const body = (
    <>
      {icon ? <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: danger ? colors.dangerBg : colors.iconBg, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={23} color={danger ? colors.danger : colors.iconFg} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</Text>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      </View>
      {count != null ? <Text style={styles.rowCount}>{count}</Text> : null}
      {right}
      {onPress && !right ? <Icon name="chevron-right" size={16} color={colors.muted} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.listRow} testID={testID}>{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={[label, count != null ? String(count) : null, value].filter(Boolean).join('. ')} testID={testID} style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.7 }]}>
      {body}
    </Pressable>
  );
}

/** M24F.2 — a fact row: a label (and an optional quiet line) on the left, the value on the right, a hairline below. The settings and the Clubs categories are made of these. */
export function FactRow({ k, v, sub, testID }: { k: string; v?: string; sub?: string | null; testID?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.fact} testID={testID}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.factKey}>{k}</Text>
        {sub ? <Text style={styles.factSub}>{sub}</Text> : null}
      </View>
      {v ? <Text style={styles.factValue}>{v}</Text> : null}
    </View>
  );
}

/** M24F — progressive disclosure: a row that opens its detail under it. Nothing is hidden for good; it is one tap away. */
export function Disclosure({ label, children, testID, open: initial = false, hint }: { label: string; children: ReactNode; testID?: string; open?: boolean; hint?: string }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(initial);
  return (
    <View testID={testID}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} aria-expanded={open} style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.7 }]}>
        <View style={{ width: 34, height: 34, borderRadius: 12, backgroundColor: colors.iconBg, alignItems: 'center', justifyContent: 'center' }}><Icon name={sectionIcon(label)} size={21} color={colors.iconFg} /></View>
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

/** M24F.3 — the one-line rule, as a component. A preview row shows an
 *  identity (initials), ONE primary line, ONE optional secondary line, a
 *  time and an essential state — nothing else; everything else is behind
 *  the row (it opens). `accent` is the special-message treatment: a thin
 *  coloured edge and a small label (never colour alone). */
export type RowAccent = 'trial' | 'offer' | 'signing' | 'request' | null;
export function PreviewRow({ title, line, time, unread, accent, accentLabel, initials, onPress, testID }: {
  title: string; line?: string | null; time?: string | null; unread?: boolean; accent?: RowAccent; accentLabel?: string; initials?: string; onPress?: () => void; testID?: string;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const accentColor = accent === 'trial' ? colors.trial : accent === 'offer' ? colors.offer : accent === 'signing' ? colors.signing : accent === 'request' ? colors.infoInk : null;
  const accentInk = accent === 'trial' ? colors.trialInk : accent === 'offer' ? colors.offerInk : accent === 'signing' ? colors.signingInk : colors.infoInk;
  const accentBg = accent === 'trial' ? colors.trialBg : accent === 'offer' ? colors.offerBg : accent === 'signing' ? colors.signingBg : colors.infoBg;
  const a11y = [title, line, accentLabel, unread ? 'unread' : null, time].filter(Boolean).join('. ');
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={a11y} testID={testID} style={({ pressed }) => [styles.preview, pressed && { opacity: 0.75 }]}>
      {accentColor ? <View style={[styles.previewEdge, { backgroundColor: accentColor }]} testID={accent ? `row-accent-${accent}` : undefined} /> : null}
      {initials !== undefined ? <ColorAvatar initials={initials} index={Array.from(title).reduce((n,c)=>n+c.charCodeAt(0),0)} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[styles.previewTitle, unread && { fontWeight: '700' }]} numberOfLines={2}>{title}</Text>
          {accentLabel ? <View style={[styles.previewLabel, { backgroundColor: accentBg, flexShrink: 0 }]}><Text style={{ color: accentInk, fontSize: 10.5, fontWeight: '600', letterSpacing: 0.3 }}>{accentLabel}</Text></View> : null}
        </View>
        {line ? <Text style={[styles.previewLine, unread && { color: colors.text, fontWeight: '500' }]} numberOfLines={1}>{line}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        {time ? <Text style={styles.previewTime}>{time}</Text> : null}
        {unread ? <View style={styles.unreadDot} accessibilityLabel="unread" testID="row-unread" /> : null}
      </View>
    </Pressable>
  );
}

/** M24F.3 — the one way to say "there is more": a quiet text link with a chevron. */
export function DetailLink({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} hitSlop={6} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 8, alignSelf: 'flex-start' }, pressed && { opacity: 0.7 }]}>
      <Text style={{ color: colors.accent2, fontSize: 13, fontWeight: '500' }}>{label}</Text>
      <Icon name="chevron-right" size={14} color={colors.accent2} />
    </Pressable>
  );
}

/** M24F.3 — a compact timeline row: a date, one label, a chevron; the provenance is behind it. */
export function EventRow({ date, label, onPress, testID, children, open: initial = false }: { date: string; label: string; onPress?: () => void; testID?: string; children?: ReactNode; open?: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(initial);
  const expandable = !!children;
  const press = expandable ? () => setOpen((v) => !v) : onPress;
  return (
    <View testID={testID}>
      <Pressable onPress={press} disabled={!press} accessibilityRole={press ? 'button' : undefined} accessibilityLabel={`${label}. ${date}`} accessibilityState={expandable ? { expanded: open } : undefined} style={({ pressed }) => [styles.event, pressed && { opacity: 0.7 }]}>
        <Text style={styles.eventDate}>{date}</Text>
        <Text style={styles.eventLabel} numberOfLines={2}>{label}</Text>
        {press ? <Icon name={expandable && open ? 'chevron-down' : 'chevron-right'} size={14} color={colors.muted} /> : null}
      </Pressable>
      {expandable && open ? <View style={styles.eventBody}>{children}</View> : null}
    </View>
  );
}

/** M24F.5 — one moment in a timeline: a small dot on a quiet rail, the date
 *  above, the event below. No columns, no dividers — a rhythm, not a table. */
export function TimelineItem({ date, children, last, testID }: { date: string; children: ReactNode; last?: boolean; testID?: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 12 }} testID={testID}>
      <View style={{ width: 8, alignItems: 'center', paddingTop: 5 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
        {last ? null : <View style={{ width: 1, flex: 1, backgroundColor: colors.line, marginTop: 4 }} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: last ? 4 : 16 }}>
        <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 16 }}>{date}</Text>
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20, marginTop: 1 }}>{children}</Text>
      </View>
    </View>
  );
}

/** M24F — a small uppercase kicker: the kind of a thing, where a pill would be noise. */
export function Kicker({ children, tone }: { children: ReactNode; tone?: 'urgent' | 'accent' | 'trial' }) {
  const colors = useColors();
  return <Text style={{ color: tone === 'urgent' ? colors.danger : tone === 'accent' ? colors.accentText : tone === 'trial' ? colors.trialInk : colors.muted, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}>{children}</Text>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  fact: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  factKey: { color: colors.text, fontSize: 14.5, fontWeight: '500', flexShrink: 1 },
  factValue: { color: colors.text, fontSize: 14.5, fontWeight: '600', textAlign: 'right', flexShrink: 1, maxWidth: '55%' },
  factSub: { color: colors.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  section: {
    backgroundColor: colors.panel,
    borderWidth: 1, borderColor: colors.line,
    borderRadius: 24,
    padding: 18,
    marginTop: 8,
    gap: 10,
  },
  raised: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 24,
    padding: 18,
    paddingTop: 18,
    paddingBottom: 18,
    marginTop: 8,
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  btn: {
    backgroundColor: colors.panel2,
    borderColor: colors.panel2,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 11,
    paddingHorizontal: 16,
    minHeight: 44,
    overflow: 'hidden',
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
  rowCount: { color: colors.muted, fontSize: 14, fontVariant: ['tabular-nums'] },
  disclosureBody: { paddingTop: 10, paddingBottom: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 88, paddingVertical: 16, position: 'relative', borderBottomWidth: 1, borderBottomColor: colors.line },
  previewEdge: { position: 'absolute', left: -7, top: 28, width: 3, height: 28, borderRadius: 2 },
  previewAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.iconBg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  previewTitle: { color: colors.text, fontSize: 16, fontWeight: '600', lineHeight: 22, flexShrink: 1 },
  previewLine: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  previewTime: { color: colors.muted, fontSize: 12 },
  previewLabel: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  event: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  eventDate: { color: colors.muted, fontSize: 12.5, minWidth: 82 },
  eventLabel: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 19 },
  eventBody: { paddingVertical: 10, paddingLeft: 94, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
});
