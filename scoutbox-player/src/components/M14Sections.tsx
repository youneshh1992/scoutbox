import { RecordIdentity, DetailFact } from './RecordDetails';
import { GuidanceNote } from './InformationRows';
// M14 player/guardian sections: structured coach references (with honest
// verification provenance) and squad-invitation acceptance. Verification is
// display-only here — it changes nothing about who may see or contact whom.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text, TextInput } from './Text';
import { useColors, type Palette } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m14, type PlayerReference } from '../data/m14client';
import { pt, pFmtDate } from '../i18n';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    setErr(null);
    fn().then((x) => ok && setV(x)).catch((e) => ok && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}

const inputStyle = (colors: Palette) => ({
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const);

function ReferenceCard({ r }: { r: PlayerReference }) {
  const colors = useColors();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 18, marginTop: 8, gap: 14 }}>
      <RecordIdentity name={r.coachName} subtitle={`${r.roleAtTime ?? pt('m14refCoach')} · ${r.orgName}`} status={r.status === 'withdrawn' ? <Pill label={pt('m14refWithdrawn')} tone="red" /> : undefined} />
      <DetailFact label="Relationship" value={`${r.relationship}${r.capacity ? ` · ${r.capacity}` : ''}${r.fromYear ? ` · ${r.fromYear}–${r.toYear ?? ''}` : ''}`} icon="users" />
      <View style={{ borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 12 }}><Text style={{ color: colors.text, fontSize: 14, lineHeight: 22 }}>{r.structured.summary}</Text></View>
      {r.structured.strengths ? <View style={{ gap: 6 }}><Text style={{ color: colors.accentText, fontSize: 12, fontWeight: '600' }}>{pt('m14refStrengths')}</Text><Text style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>{r.structured.strengths}</Text></View> : null}
      {r.structured.development ? <View style={{ gap: 6 }}><Text style={{ color: colors.iconFg, fontSize: 12, fontWeight: '600' }}>{pt('m14refDevelopment')}</Text><Text style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>{r.structured.development}</Text></View> : null}
      <DetailFact label="Recorded" value={pFmtDate(r.createdAt)} icon="calendar-days" />
      <GuidanceNote title="Reference provenance" icon="shield">{r.provenance}</GuidanceNote>
    </View>
  );
}

/** Player's own references (You tab, adults and minors alike — read-only). */
export function ReferencesSection({ playerId }: { playerId: string }) {
  const [items] = useLoad(() => m14.references(playerId), [playerId]);
  if (!items?.length) return null;
  return (
    <Card>
      <SectionTitle>{pt('m14refTitle')}</SectionTitle>
      <Muted>{pt('m14refNote')}</Muted>
      {items.map((r) => <ReferenceCard key={r.id} r={r} />)}
    </Card>
  );
}

/** Guardian view of a child's references. */
export function ChildReferencesSection({ guardianId, childId, childName }: { guardianId: string; childId: string; childName: string }) {
  const [items] = useLoad(() => m14.gChildReferences(guardianId, childId), [guardianId, childId]);
  if (!items?.length) return null;
  return (
    <Card>
      <SectionTitle>{pt('m14refTitle')} — {childName}</SectionTitle>
      <Muted>{pt('m14refGuardianNote')}</Muted>
      {items.map((r) => <ReferenceCard key={r.id} r={r} />)}
    </Card>
  );
}

/** Squad invitation code entry. Adults accept for themselves; the guardian
 *  variant accepts for a child. The server enforces both — this is only UI. */
export function InviteCodeSection({ actor }: { actor: { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string; childName: string } }) {
  const colors = useColors();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <SectionTitle>{pt('m14invTitle')}</SectionTitle>
      <Muted>{actor.kind === 'guardian' ? pt('m14invGuardianNote') : pt('m14invNote')}</Muted>
      <Row style={{ marginTop: 6 }}>
        <TextInput
          style={[inputStyle(colors), { flex: 1 }]} value={code} onChangeText={setCode}
          placeholder={pt('m14invPlaceholder')} placeholderTextColor={colors.muted}
          accessibilityLabel={pt('m14invPlaceholder')}
        />
        <Button
          testID="invite-accept"
          label={pt('m14invAccept')}
          onPress={async () => {
            try {
              const r = actor.kind === 'guardian'
                ? await m14.gAcceptInvite(actor.id, actor.childId, code)
                : await m14.acceptInvite(actor.id, code);
              setMsg(`${r.note}`);
              setCode('');
            } catch (e) { setMsg(`${e instanceof Error ? e.message : 'failed'}`); }
          }}
        />
      </Row>
      {msg ? <View style={{ marginTop: 4 }}><Muted>{msg}</Muted></View> : null}
    </Card>
  );
}
