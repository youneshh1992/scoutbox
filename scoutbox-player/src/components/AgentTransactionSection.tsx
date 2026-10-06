import { RecordIdentity } from './RecordDetails';
import { GuidanceNote } from './InformationRows';
// M23 P5.6D — "My transactions": the individual's side of a multi-party
// transaction workspace.
//
// The card shows what the individual is entitled to see and nothing else: the
// clubs, the agency and which representation acts, what the compliance layer
// currently says, the documents shared with them, their own consent's state,
// and the timeline of what happened in their view of it. A club-private note, a
// club-private document, the agent's agreement reference and any fee have no
// field here to arrive in.
//
// The one action is confirming their OWN participation, and the card says
// plainly what that does and does not mean. Nothing here is an offer, nothing
// is a signature, and ScoutBox never negotiates on anyone's behalf.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { useColors } from '../theme';
import { TimelineItem, DetailFact, InfoNote, RecordPanel, Button, Card, Disclosure, Muted, Pill, Row, SectionTitle } from './ui';
import { m26, type PlayerTransaction, type TxTimelineEntry } from '../data/m26client';
import { pt } from '../i18n';
import { uiLocale } from '../time';

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

type K = Parameters<typeof pt>[0];
const typeKey = (t: string) => (t === 'employment_contract' ? 'm26typeEmployment' : t === 'transfer' ? 'm26typeTransfer' : t === 'loan' ? 'm26typeLoan' : 'm26typeOther') as K;
const roleKey = (r: string) => (r === 'individual' ? 'm26roleIndividual' : r === 'engaging_entity' ? 'm26roleEngaging' : 'm26roleReleasing') as K;
const statusKey = (s: string) => `m26status_${s}` as K;
/** Tone is decoration; the word beside it is the state, so no state is colour-only. */
const tone = (s: string): 'green' | 'blue' | 'gold' | 'red' | 'default' =>
  (s === 'READY' || s === 'ACTIVE' ? 'green' : s === 'COMPLIANCE_BLOCKED' ? 'red' : s === 'COMPLIANCE_PENDING' || s === 'ON_HOLD' ? 'gold' : s === 'CANCELLED' || s === 'CLOSED' || s === 'ARCHIVED' ? 'default' : 'blue');
const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function Timeline({ playerId, tx }: { playerId: string; tx: PlayerTransaction }) {
  const colors = useColors();
  const [data] = useLoad(() => m26.timeline(playerId, tx.id), [playerId, tx.id]);
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <View style={{ marginTop: 6 }} testID={`tx-timeline-${tx.id}`}>
      <Muted size={11.5}>{pt('m26timeline')}</Muted>
      <View style={{ marginTop: 12 }}>{items.slice(0, 6).map((e: TxTimelineEntry, i) => (
        <TimelineItem key={e.id} date={fmt(e.at)} last={i === Math.min(items.length, 6) - 1}>
          <Text style={{ color: colors.text, fontSize: 14, lineHeight: 21, fontWeight: '500' }}>{pt(`m26action_${e.action}` as K)}</Text>
          <Muted size={12}>{e.actor?.label ?? '—'}</Muted>
        </TimelineItem>
      ))}</View>
    </View>
  );
}

export function AgentTransactionSection({ playerId, isMinor }: { playerId: string; isMinor: boolean }) {
  const colors = useColors();
  const [data, reload, err] = useLoad(() => m26.list(playerId), [playerId]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Structurally absent for under-18s: the server answers an empty list with a
  // note, and no minor transaction pathway is enabled in any jurisdiction.
  if (isMinor) return null;

  const items = data?.items ?? [];
  if (items.length === 0 && !err) return null; // nothing to show: no empty card in the way

  const confirm = async (tx: PlayerTransaction) => {
    setBusy(true); setMsg(null);
    try {
      await m26.confirm(playerId, tx.id, { expectedRev: tx.rev });
      setMsg(pt('m26confirmedMsg'));
      reload();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setMsg(code === 'TRANSACTION_VERSION_CONFLICT' ? pt('m26conflict') : e instanceof Error && e.message ? e.message : pt('m26failed'));
    } finally { setBusy(false); }
  };

  return (
    <Card testID="agent-transactions">
      <SectionTitle>{pt('m26title')}</SectionTitle>
      <Disclosure label="About transactions"><GuidanceNote size={12}>{pt('m26intro')}</GuidanceNote></Disclosure>
      {err && <Muted size={12}>{err}</Muted>}
      {items.map((tx) => {
        const mine = tx.parties.find((p) => p.subjectKind === 'player' && p.subjectId === playerId);
        const clubs = tx.parties.filter((p) => p.subjectKind === 'club' && !p.removed);
        const myConsent = tx.consents.find((c) => c.mine);
        return (
          <View key={tx.id} style={{ marginTop: 8, gap: 12, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 18 }} testID={`agent-transaction-${tx.id}`}>
            <RecordIdentity name={pt(typeKey(tx.type))} subtitle={tx.agency?.name ?? '—'} icon="file-text" status={<Pill label={pt(statusKey(tx.status))} tone={tone(tx.status)} />} />
            {clubs.length > 0 && <DetailFact label="Clubs involved" value={clubs.map(c => c.name ?? '—').join(', ')} icon="building-2" />}
            {mine && !mine.confirmedAt && (
              <View style={{ marginTop: 6 }}>
                <Muted size={11.5}>{pt('m26confirmWhat')}</Muted>
                <Button small primary disabled={busy} label={pt('m26confirm')} onPress={() => confirm(tx)} />
              </View>
            )}
            {mine?.confirmedAt && <GuidanceNote icon="info" size={11.5}>{pt('m26youConfirmedOn')} {fmt(mine.confirmedAt)}</GuidanceNote>}
            <Disclosure label={pt('m26details')} testID={`tx-details-${tx.id}`}>
              {clubs.map((c) => (
                <RecordPanel key={c.id} title={c.name ?? '—'} subtitle={pt(roleKey(c.partyRole))} icon="building-2"><DetailFact label="Confirmation" value={c.confirmedAt ? pt('m26confirmed') : pt('m26awaitingThem')} icon="circle-check" /></RecordPanel>
              ))}
              <DetailFact label={pt('m26compliance')} value={`${tx.compliance.blocked ? pt('m26complianceBlocked') : tx.compliance.clear ? pt('m26complianceClear') : pt('m26compliancePending')}${tx.compliance.staleness ? ` · ${pt('m26stale')}` : ''}`} icon="shield-check" />
              {tx.representations.length > 0 && <DetailFact label={pt('m26actingFor')} value={tx.representations.filter((r) => r.status !== 'withdrawn').map((r) => pt(roleKey(r.partyRole))).join(', ') || '—'} icon="users" />}
              {myConsent && <DetailFact label={pt('m26myConsent')} value={myConsent.status.replace(/_/g, ' ')} icon="file-check-2" />}
              {tx.documents.length > 0 && (
                <View style={{ marginTop: 4 }} testID={`tx-documents-${tx.id}`}>
                  <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>{pt('m26sharedDocs')}</Text>
                  {tx.documents.map((d) => <DetailFact key={d.id} label={`v${d.version}`} value={d.label} icon="file-text" />)}
                </View>
              )}
              {tx.notes.length > 0 && (
                <View style={{ marginTop: 4 }} testID={`tx-notes-${tx.id}`}>
                  {tx.notes.map((n) => <InfoNote key={n.id} icon="message-circle">{n.text}</InfoNote>)}
                </View>
              )}
              <GuidanceNote size={11}>{tx.offerBoundary.honest}</GuidanceNote>
              <Timeline playerId={playerId} tx={tx} />
            </Disclosure>
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
      <GuidanceNote icon="info" size={11}>{pt('m26honest')}</GuidanceNote>
    </Card>
  );
}
