// M23 P5.6C — "Agent consent": the player's decision about an agent who would
// act for more than one party in the same transaction.
//
// The card shows exactly what the decision needs: who is asking, the agent's
// licence STATE in ScoutBox, which transaction, which other party, and that
// declining is a real option. Granting requires two explicit acknowledgements
// (the server refuses without both). A granted consent can be revoked here at
// any time, and the card says what a revocation does and does not undo.
//
// No fee, no contract terms and no legal advice appear here. ScoutBox records
// the answer; it does not advise the player.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m25, m25ClientKey, type AgentConsentRequest, type ConsentAction } from '../data/m25client';
import { pt } from '../i18n';

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

const statusKey = (s: AgentConsentRequest['status']) => (
  s === 'requested' ? 'm25pending' : s === 'granted' ? 'm25granted' : s === 'declined' ? 'm25declined' : 'm25revoked'
) as Parameters<typeof pt>[0];
const tone = (s: AgentConsentRequest['status']): 'green' | 'blue' | 'gold' | 'red' | 'default' => (s === 'granted' ? 'green' : s === 'requested' ? 'blue' : s === 'revoked' ? 'red' : 'default');
const typeKey = (t: string) => (t === 'employment_contract' ? 'm25typeEmployment' : t === 'transfer' ? 'm25typeTransfer' : t === 'loan' ? 'm25typeLoan' : 'm25typeOther') as Parameters<typeof pt>[0];
const roleKey = (r: string) => (r === 'individual' ? 'm25roleIndividual' : r === 'engaging_entity' ? 'm25roleEngaging' : 'm25roleReleasing') as Parameters<typeof pt>[0];
const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : '—');

export function AgentConsentSection({ playerId, isMinor }: { playerId: string; isMinor: boolean }) {
  const [data, reload, err] = useLoad(() => m25.list(playerId), [playerId]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<Record<string, { particulars: boolean; legalAdvice: boolean }>>({});
  // Structurally absent for under-18s: the server answers an empty list with a note.
  if (isMinor) return null;

  const answer = async (k: AgentConsentRequest, action: ConsentAction, okKey: Parameters<typeof pt>[0]) => {
    setBusy(true); setMsg(null);
    const a = ack[k.id] ?? { particulars: false, legalAdvice: false };
    try {
      await m25.answer(playerId, k.id, action, {
        ...(action === 'grant' ? { acknowledgedParticulars: a.particulars, acknowledgedLegalAdvice: a.legalAdvice } : {}),
        expectedRev: k.rev, clientKey: m25ClientKey(),
      });
      setMsg(pt(okKey)); reload();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setMsg(code === 'CONSENT_VERSION_CONFLICT' ? pt('m25conflict') : code === 'CONSENT_INPUT_INVALID' ? pt('m25needAck') : e instanceof Error && e.message ? e.message : pt('m25failed'));
    } finally { setBusy(false); }
  };
  const toggle = (id: string, field: 'particulars' | 'legalAdvice') =>
    setAck((cur) => {
      const prev = cur[id] ?? { particulars: false, legalAdvice: false };
      return { ...cur, [id]: { ...prev, [field]: !prev[field] } };
    });

  const items = data?.items ?? [];
  if (items.length === 0 && !err) return null; // nothing asked: no empty card in the way

  return (
    <Card testID="agent-consent">
      <SectionTitle>📝 {pt('m25title')}</SectionTitle>
      <Muted size={12}>{pt('m25intro')}</Muted>
      {err && <Muted size={12}>{err}</Muted>}
      {items.map((k) => {
        const a = ack[k.id] ?? { particulars: false, legalAdvice: false };
        const others = (k.context?.parties ?? []).filter((p) => k.otherPartyRoles.includes(p.partyRole));
        return (
          <View key={k.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }} testID={`agent-consent-${k.id}`}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{k.agent.displayName ?? '—'}</Text>
              <Pill label={pt(statusKey(k.status))} tone={tone(k.status)} />
            </Row>
            <Muted size={12}>
              {pt('m25agency')}: {k.agent.agency ?? '—'} · {pt('m25licence')}: {k.agent.licence.replace(/_/g, ' ').toLowerCase()}
            </Muted>
            <Muted size={12}>
              {pt('m25transaction')}: {pt(typeKey(k.context?.type ?? ''))}{k.context?.jurisdictions?.length ? ` (${k.context.jurisdictions.join(', ')})` : ''}
            </Muted>
            <Muted size={12}>
              {pt('m25alsoActingFor')}: {others.length ? others.map((p) => `${p.name ?? pt(roleKey(p.partyRole))} — ${pt(roleKey(p.partyRole))}`).join(', ') : k.otherPartyRoles.map((r) => pt(roleKey(r))).join(', ')}
            </Muted>
            <Muted size={11.5}>{pt('m25whatItMeans')}</Muted>
            {k.status === 'requested' && (
              <>
                <Muted size={11.5}>{pt('m25beforeYouAnswer')}</Muted>
                <View style={{ marginTop: 6, gap: 4 }}>
                  <Button small={true} label={`${a.particulars ? '☑' : '☐'} ${pt('m25ackParticulars')}`} onPress={() => toggle(k.id, 'particulars')} />
                  <Button small={true} label={`${a.legalAdvice ? '☑' : '☐'} ${pt('m25ackLegalAdvice')}`} onPress={() => toggle(k.id, 'legalAdvice')} />
                </View>
                <Row style={{ marginTop: 6 }}>
                  <Button small primary disabled={busy || !a.particulars || !a.legalAdvice} label={pt('m25grant')} onPress={() => answer(k, 'grant', 'm25grantedMsg')} />
                  <Button small disabled={busy} label={pt('m25decline')} onPress={() => answer(k, 'decline', 'm25declinedMsg')} />
                </Row>
                {(!a.particulars || !a.legalAdvice) && <Muted size={11}>{pt('m25needAck')}</Muted>}
              </>
            )}
            {k.status === 'granted' && (
              <View style={{ marginTop: 6 }}>
                <Muted size={11.5}>{pt('m25grantedOn')} {fmt(k.grantedAt)}</Muted>
                <Button small danger disabled={busy} label={pt('m25revoke')} onPress={() => answer(k, 'revoke', 'm25revokedMsg')} />
                <Muted size={11}>{pt('m25revokeNote')}</Muted>
              </View>
            )}
            {k.status === 'declined' && <Muted size={11.5}>{pt('m25declinedNote')}</Muted>}
            {k.status === 'revoked' && <Muted size={11.5}>{pt('m25revokedNote')}</Muted>}
            <Muted size={11}>{k.honest}</Muted>
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}
