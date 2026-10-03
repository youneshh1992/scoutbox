// M24C — the approved Player components, one for one with the reference
// phone screens in ScoutBox-Design-Explorer.html (Home, Football Passport,
// Box Cam, Messages). Every size below is the reference's computed value at
// phone width; every colour comes from the active palette so light and dark
// both match. These are presentation pieces only: they render what a screen
// hands them and perform no request of their own.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors, useStyles, type Palette } from '../theme';

export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** `.p-greeting` — a quiet kicker over the page's 25px heading. */
export function Greeting({ kicker, title, testID }: { kicker: string; title: string; testID?: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.greeting} testID={testID}>
      <Text style={s.kicker}>{kicker}</Text>
      <Text role="heading" aria-level={1} style={s.h1}>{title}</Text>
    </View>
  );
}

/** `.p-section` — a 17px heading with an optional count bubble or text link on the right. */
export function SectionHead({ title, count, link, onLink, testID }: { title: string; count?: number; link?: string; onLink?: () => void; testID?: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.section} testID={testID}>
      <Text role="heading" aria-level={2} style={s.h2}>{title}</Text>
      {typeof count === 'number' ? <View style={s.count}><Text style={s.countText}>{count}</Text></View> : null}
      {link && onLink ? <TextButton label={link} onPress={onLink} /> : null}
    </View>
  );
}

/** `.f-textbtn` — a green text link with a chevron. */
export function TextButton({ label, onPress, size = 12, testID }: { label: string; onPress: () => void; size?: number; testID?: string }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} hitSlop={6} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 7 }, pressed && { opacity: 0.7 }]}>
      <Text style={{ color: c.accent2, fontSize: size, fontWeight: '500' }}>{label}</Text>
      <Icon name="chevron-right" size={13} color={c.accent2} />
    </Pressable>
  );
}

/** `.p-mobile-icon` — the soft green tile behind a lucide glyph. */
export function IconTile({ name, size = 18 }: { name: string; size?: number }) {
  const s = useStyles(makeStyles);
  const c = useColors();
  return <View style={s.iconTile}><Icon name={name} size={size} color={c.iconFg} /></View>;
}

/** `.p-mobile-row` — an attention row: icon tile, two lines, chevron. */
export function MobileRow({ icon, title, sub, onPress, testID }: { icon: string; title: string; sub: string; onPress?: () => void; testID?: string }) {
  const s = useStyles(makeStyles);
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`${title}. ${sub}`} testID={testID} style={({ pressed }) => [s.row, pressed && { opacity: 0.75 }]}>
      <IconTile name={icon} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
        <Text style={s.rowSub} numberOfLines={2}>{sub}</Text>
      </View>
      {onPress ? <Icon name="chevron-right" size={15} color={c.muted} /> : null}
    </Pressable>
  );
}

/** `.p-passport` — the dark-green Football Passport card on Home. */
export function PassportCard({ name, line, onOpen, linkLabel, label }: { name: string; line: string; onOpen: () => void; linkLabel: string; label: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.passport} testID="home-passport">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
        <View style={s.passportAvatar}><Text style={{ color: '#153c25', fontSize: 15, fontWeight: '600' }}>{initialsOf(name)}</Text></View>
        <View style={s.passportLabel}><Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '500' }}>{label}</Text></View>
      </View>
      <Text style={s.passportName}>{name}</Text>
      <Text style={s.passportLine}>{line}</Text>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={linkLabel} testID="home-passport-link" style={({ pressed }) => [s.passportLink, pressed && { opacity: 0.75 }]}>
        <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '600' }}>{linkLabel}</Text>
        <Icon name="arrow-right" size={16} color="#ffffff" />
      </Pressable>
    </View>
  );
}

/** `.p-development` — one development focus with a primary action under it. */
export function DevelopmentCard({ icon, title, sub, children }: { icon: string; title: string; sub: string; children?: ReactNode }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.card} testID="home-development">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconTile name={icon} />
        <View style={{ flex: 1 }}>
          <Text style={s.rowTitle}>{title}</Text>
          <Text style={[s.sub, { fontSize: 11, marginTop: 4 }]}>{sub}</Text>
        </View>
      </View>
      {children ? <View style={{ marginTop: 18 }}>{children}</View> : null}
    </View>
  );
}

/** `.f-status` — a dot and a short state word. */
export function StatusDot({ label, tone = 'ok' }: { label: string; tone?: 'ok' | 'pending' | 'urgent' }) {
  const c = useColors();
  const dot = tone === 'urgent' ? c.danger : tone === 'pending' ? c.gold : c.accentText;
  const ink = tone === 'urgent' ? c.danger : tone === 'pending' ? c.gold : c.safetyText;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 6, height: 6, backgroundColor: dot }} />
      <Text style={{ color: ink, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

/** `.p-profile-intro` — large avatar, name, one line, status. */
export function ProfileIntro({ name, line, status }: { name: string; line: string; status?: string }) {
  const s = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={s.intro} testID="passport-intro">
      <View style={s.avatarLarge}><Text style={{ color: c.iconFg, fontSize: 23, fontWeight: '600' }}>{initialsOf(name)}</Text></View>
      <Text role="heading" aria-level={1} style={[s.h1, { fontSize: 24, marginTop: 13 }]}>{name}</Text>
      <Text style={s.sub}>{line}</Text>
      {status ? <View style={{ marginTop: 10 }}><StatusDot label={status} /></View> : null}
    </View>
  );
}

/** `.p-history` + `.f-record` — numbered records in one card. */
export function HistoryList({ rows, testID }: { rows: { index: string; title: string; sub: string; right?: ReactNode }[]; testID?: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.history} testID={testID}>
      {rows.map((r, i) => (
        <View key={`${r.index}-${i}`} style={[s.record, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
          <Text style={s.index}>{r.index}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.recordTitle}>{r.title}</Text>
            <Text style={[s.sub, { fontSize: 12, marginTop: 2 }]}>{r.sub}</Text>
            {r.right ? <View style={{ marginTop: 6 }}>{r.right}</View> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** `.p-training-visual` — the Box Cam hero: a glyph in a disc, a title and a line on the soft green (M24F: no pitch drawing). */
export function TrainingVisual({ title, sub }: { title: string; sub: string }) {
  const s = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={s.training} testID="boxcam-visual">
      <View style={s.trainingDisc}><Icon name="scan-line" size={18} color={c.iconFg} /></View>
      <Text style={[s.rowTitle, { backgroundColor: c.training, paddingHorizontal: 5 }]}>{title}</Text>
      <Text style={[s.sub, { fontSize: 12, backgroundColor: c.training, paddingHorizontal: 5 }]}>{sub}</Text>
    </View>
  );
}

/** `.p-session-facts` — icon + fact pairs in a row. */
export function SessionFacts({ facts }: { facts: { icon: string; label: string }[] }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18, marginVertical: 14 }}>
      {facts.map((f) => (
        <View key={f.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={f.icon} size={15} color={c.safetyText} />
          <Text style={{ color: c.safetyText, fontSize: 12 }}>{f.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** `.p-label.light` — a soft label chip. */
export function LightLabel({ label }: { label: string }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.safety, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 8 }}>
      <Text style={{ color: c.safetyText, fontSize: 11, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

/** `.f-footnote` */
export function Footnote({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={{ color: c.muted, fontSize: 11, lineHeight: 17.6, marginTop: 16 }}>{children}</Text>;
}

/** A plain reference card (`.p-trust`, `.p-chat-invite` …). */
export function RefCard({ children, style, testID }: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  const s = useStyles(makeStyles);
  return <View style={[s.card, style]} testID={testID}>{children}</View>;
}

const makeStyles = (c: Palette) => StyleSheet.create({
  greeting: { marginBottom: 22, gap: 0 },
  kicker: { color: c.muted, fontSize: 12, lineHeight: 19 },
  h1: { color: c.text, fontSize: 25, fontWeight: '700', letterSpacing: -0.6, lineHeight: 30, marginVertical: 6 },
  h2: { color: c.text, fontSize: 19, fontWeight: '600', letterSpacing: -0.4, lineHeight: 24, flexShrink: 1 },
  sub: { color: c.muted, fontSize: 13, lineHeight: 20 },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 30, marginBottom: 8 },
  count: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.count, alignItems: 'center', justifyContent: 'center' },
  countText: { color: c.text, fontSize: 11 },
  iconTile: { borderRadius: 9, padding: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  // M24F — an attention row is a row, not a card: hairline-separated, full width
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.line },
  rowTitle: { color: c.text, fontSize: 14.5, fontWeight: '600', lineHeight: 19 },
  rowSub: { color: c.muted, fontSize: 12.5, lineHeight: 17, marginTop: 3 },
  passport: { backgroundColor: c.passport, borderRadius: 15, padding: 18, overflow: 'hidden' },
  passportAvatar: { width: 41, height: 41, borderRadius: 21, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  passportLabel: { backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 5, paddingVertical: 5, paddingHorizontal: 8 },
  passportName: { color: '#ffffff', fontSize: 24, fontWeight: '600', letterSpacing: -0.5, lineHeight: 29, marginTop: 19 },
  passportLine: { color: c.passportText, fontSize: 12, lineHeight: 18, marginTop: 6 },
  passportLink: { marginTop: 18, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.15)', width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  card: { paddingVertical: 14, borderTopWidth: 1, borderTopColor: c.line },
  intro: { alignItems: 'center', paddingTop: 4, paddingBottom: 19 },
  avatarLarge: { width: 68, height: 68, borderRadius: 34, backgroundColor: c.iconBg, borderWidth: 4, borderColor: c.panel, alignItems: 'center', justifyContent: 'center', shadowColor: c.line, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 0, height: 0 } },
  history: { borderTopWidth: 1, borderTopColor: c.line },
  record: { flexDirection: 'row', gap: 9, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.line },
  index: { width: 24, color: c.accentText, fontSize: 11, fontWeight: '600', paddingTop: 3 },
  recordTitle: { color: c.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  training: { backgroundColor: c.training, height: 170, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', gap: 7 },
  trainingDisc: { backgroundColor: c.trainingDisc, borderRadius: 999, padding: 10 },
  pitch: { position: 'absolute', top: 15, bottom: 15, left: 20, right: 20, borderWidth: 1, borderColor: c.trainingLine, opacity: 0.35 },
  pitchHalf: { position: 'absolute', top: 0, bottom: 0, left: '50%', borderLeftWidth: 1, borderColor: c.trainingLine },
  pitchCircle: { position: 'absolute', width: 50, height: 50, borderRadius: 25, borderWidth: 1, borderColor: c.trainingLine, left: '50%', top: '50%', marginLeft: -25, marginTop: -25 },
});
