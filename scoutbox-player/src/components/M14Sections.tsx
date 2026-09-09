// M14 player/guardian sections: structured coach references (with honest
// verification provenance) and squad-invitation acceptance. Verification is
// display-only here — it changes nothing about who may see or contact whom.
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
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

const input = {
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const;

function ReferenceCard({ r }: { r: PlayerReference }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, marginTop: 8 }}>
      <Row>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{r.coachName}</Text>
        <Pill label={`${r.roleAtTime ?? pt('m14refCoach')} · ${r.orgName}`} tone="green" />
        {r.status === 'withdrawn' ? <Pill label={pt('m14refWithdrawn')} tone="red" /> : null}
      </Row>
      <View><Muted>{r.relationship}{r.capacity ? ` · ${r.capacity}` : ''}{r.fromYear ? ` · ${r.fromYear}–${r.toYear ?? ''}` : ''}</Muted></View>
      <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>{r.structured.summary}</Text>
      {r.structured.strengths ? <View><Muted>{pt('m14refStrengths')}: {r.structured.strengths}</Muted></View> : null}
      {r.structured.development ? <View><Muted>{pt('m14refDevelopment')}: {r.structured.development}</Muted></View> : null}
      <View style={{ marginTop: 4 }}><Muted>✓ {r.provenance} · {pFmtDate(r.createdAt)}</Muted></View>
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
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <SectionTitle>{pt('m14invTitle')}</SectionTitle>
      <Muted>{actor.kind === 'guardian' ? pt('m14invGuardianNote') : pt('m14invNote')}</Muted>
      <Row style={{ marginTop: 6 }}>
        <TextInput
          style={[input, { flex: 1 }]} value={code} onChangeText={setCode}
          placeholder={pt('m14invPlaceholder')} placeholderTextColor={colors.muted}
          accessibilityLabel={pt('m14invPlaceholder')}
        />
        <Button
          label={pt('m14invAccept')}
          onPress={async () => {
            try {
              const r = actor.kind === 'guardian'
                ? await m14.gAcceptInvite(actor.id, actor.childId, code)
                : await m14.acceptInvite(actor.id, code);
              setMsg(`✅ ${r.note}`);
              setCode('');
            } catch (e) { setMsg(`⚠️ ${e instanceof Error ? e.message : 'failed'}`); }
          }}
        />
      </Row>
      {msg ? <View style={{ marginTop: 4 }}><Muted>{msg}</Muted></View> : null}
    </Card>
  );
}
