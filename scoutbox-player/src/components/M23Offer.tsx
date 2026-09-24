// M23 P6 — the recipient's Offers: a club's proposal, exactly as issued, with
// its revision number, its expiry and its documents. Accepting or declining
// is the recipient's own act, behind a second explicit step so it cannot be
// triggered by accident (§46). An acceptance is NOT a signing, and the screen
// says so every time it matters.
//
// A minor's own device shows nothing: in this build no Offer is issued to a
// player under the age of majority, and a guardian route sees only what the
// server addressed to that guardian.
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Linking, Text, TextInput, View } from 'react-native';
import { m12, type FamilyOffer, type FamilyOfferRevision, type OfferStatus } from '../data/m12client';
import { colors } from '../theme';
import { pt } from '../i18n';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';

type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

const GLYPH: Record<OfferStatus, string> = { DRAFT: '○', ISSUED: '➤', ACCEPTED: '✓', DECLINED: '✕', WITHDRAWN: '⊘', EXPIRED: '⌛', SUPERSEDED: '↻' };
const tone = (s: OfferStatus | null) => (s === 'ISSUED' ? 'gold' : s === 'ACCEPTED' ? 'green' : s === 'DECLINED' || s === 'WITHDRAWN' || s === 'EXPIRED' ? 'red' : 'default');
const stLabel = (s: OfferStatus | null) => {
  if (!s) return '';
  const key = `offerSt_${s}` as Parameters<typeof pt>[0];
  try { return `${GLYPH[s]} ${pt(key) ?? s}`; } catch { return s; }
};
const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const errMsg = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code ?? (e instanceof Error ? e.message : '');
  const key = `offerErr_${code}` as Parameters<typeof pt>[0];
  try { const s = pt(key); if (s) return s; } catch { /* unknown code */ }
  return pt('offerErr_generic');
};
const keyFor = (oid: string, rid: string, what: string) => `of-${what}-${oid}-${rid}`;

export function OfferSection({ actor }: { actor: Actor }) {
  const [offers, setOffers] = useState<FamilyOffer[] | null>(null);
  const [tick, setTick] = useState(0);
  const [arm, setArm] = useState<{ id: string; what: 'accept' | 'decline' } | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // P6.1 (stale UX): the tab keeps this screen mounted, so an Offer the club
  // paused, withdrew or revised while the player was elsewhere would stay on
  // screen as it was. Every return to the tab re-reads the list.
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(useCallback(() => { setFocusTick((x) => x + 1); }, []));
  useEffect(() => {
    let on = true;
    (actor.kind === 'player' ? m12.getOffers(actor.id) : m12.gOffers(actor.id)).then((x) => on && setOffers(x)).catch(() => on && setOffers([]));
    return () => { on = false; };
  }, [actor.id, actor.kind, tick, focusTick]);
  if (!offers) return null;
  if (offers.length === 0 && actor.kind === 'player') return null;

  const answer = async (o: FamilyOffer, rev: FamilyOfferRevision, what: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(o.id); setMsg(null);
    try {
      const r = reason[o.id]?.trim() || undefined;
      if (actor.kind === 'player') {
        if (what === 'accept') await m12.acceptOffer(actor.id, o.id, rev.id, keyFor(o.id, rev.id, 'accept'));
        else await m12.declineOffer(actor.id, o.id, rev.id, keyFor(o.id, rev.id, 'decline'), r);
      } else if (what === 'accept') await m12.gAcceptOffer(actor.id, o.id, rev.id, keyFor(o.id, rev.id, 'accept'));
      else await m12.gDeclineOffer(actor.id, o.id, rev.id, keyFor(o.id, rev.id, 'decline'), r);
      setMsg(what === 'accept' ? pt('offerAccepted') : pt('offerDeclined'));
      setArm(null);
      setReason((s) => ({ ...s, [o.id]: '' }));
      setTick((x) => x + 1);
    } catch (e) { setMsg(errMsg(e)); setArm(null); setTick((x) => x + 1); }
    finally { setBusy(null); }
  };
  const share = async (o: FamilyOffer) => {
    if (busy || actor.kind !== 'player') return;
    setBusy(o.id); setMsg(null);
    try { await m12.shareOfferWithAgent(actor.id, o.id, !o.agentShared); setTick((x) => x + 1); }
    catch (e) { setMsg(errMsg(e)); }
    finally { setBusy(null); }
  };
  const openDoc = async (o: FamilyOffer, docId: string) => {
    if (busy) return;
    setBusy(o.id); setMsg(null);
    try {
      const f = actor.kind === 'player' ? await m12.getOfferDocument(actor.id, o.id, docId) : await m12.gOfferDocument(actor.id, o.id, docId);
      if (f.file) { try { await Linking.openURL(`data:${f.file.mime};base64,${f.file.base64}`); } catch { /* not openable here */ } }
      setMsg(pt('offerDocumentOpened'));
    } catch { setMsg(pt('offerDocumentFailed')); }
    finally { setBusy(null); }
  };

  return (
    <Card testID="offer-section">
      <SectionTitle>📄 {pt('offersTitle')}</SectionTitle>
      <Muted size={12.5}>{actor.kind === 'guardian' ? pt('offersGuardianHint') : pt('offersHint')}</Muted>
      {offers.length === 0 && <View style={{ marginTop: 6 }}><Muted size={12.5}>{pt('offersNone')}</Muted></View>}
      {offers.map((o) => {
        const cur = o.currentRevision;
        const live = o.status === 'ISSUED' && o.awaitingYourResponse && !!cur;
        const older = o.revisions.filter((r) => r.id !== cur?.id);
        const mine = o.responses.find((x) => x.revisionId === cur?.id) ?? null;
        return (
          <View key={o.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }} testID={`offer-${o.id}`} accessibilityLabel={`${pt('offersTitle')} ${o.club.name ?? ''}`}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5, flex: 1 }}>{o.club.name ?? '—'}{actor.kind === 'guardian' && o.playerName ? ` · ${o.playerName}` : ''}</Text>
              <Pill label={stLabel(o.status)} tone={tone(o.status)} />
            </Row>
            {cur && (
              <View style={{ marginTop: 4, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }} testID={`offer-revision-${cur.id}`}>
                <Muted size={12}>{pt('offerRevision')} {cur.revisionNumber} · {cur.status === 'EXPIRED' ? pt('offerExpired') : pt('offerExpires')} {fmt(cur.expiresAt)}</Muted>
                <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>{pt('offerRole')}: {cur.terms.role ?? '—'}{cur.terms.squad ? ` · ${pt('offerSquad')}: ${cur.terms.squad}` : ''}</Text>
                <Text style={{ color: colors.text, fontSize: 13 }}>{pt('offerStart')}: {cur.terms.startDate ?? '—'}{cur.terms.endDate ? ` · ${pt('offerEnd')}: ${cur.terms.endDate}` : ''}</Text>
                {cur.terms.conditions ? <Muted size={12.5}>{pt('offerConditions')}: {cur.terms.conditions}</Muted> : null}
                {cur.recipientMessage ? <Muted size={12.5}>{pt('offerMessage')}: “{cur.recipientMessage}”</Muted> : null}
                {cur.documents.length > 0 && (
                  <View style={{ marginTop: 4 }}>
                    <Muted size={12}>{pt('offerDocuments')}</Muted>
                    {cur.documents.map((d) => (
                      <Row key={d.id} style={{ marginTop: 2 }}>
                        <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>{d.label ?? d.id}</Text>
                        <Button small label={pt('offerOpenDocument')} onPress={() => openDoc(o, d.id)} testID={`offer-doc-${d.id}`} />
                      </Row>
                    ))}
                  </View>
                )}
              </View>
            )}
            {o.status === 'ACCEPTED' && <View style={{ marginTop: 6 }} testID={`offer-signing-pending-${o.id}`}><Text style={{ color: colors.accent, fontSize: 13, fontWeight: '700' }}>{pt('offerSigningPending')}</Text></View>}
            {o.status === 'ISSUED' && o.notAnswerableReason === 'CASE_PAUSED' && <View style={{ marginTop: 6 }} testID={`offer-paused-${o.id}`} accessibilityRole="text"><Muted size={12.5}>{pt('offerPaused')}</Muted></View>}
            {mine && <Muted size={12}>{mine.actorType === 'guardian' && actor.kind === 'player' ? pt('offerAnsweredByGuardian') : `${pt('offerAnsweredAt')} ${fmt(mine.occurredAt)}`}</Muted>}
            {live && !arm && (
              <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <Button small primary label={pt('offerAccept')} onPress={() => setArm({ id: o.id, what: 'accept' })} testID={`offer-accept-${o.id}`} />
                <Button small label={pt('offerDecline')} onPress={() => setArm({ id: o.id, what: 'decline' })} testID={`offer-decline-${o.id}`} />
              </Row>
            )}
            {live && arm?.id === o.id && cur && (
              <View style={{ marginTop: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.gold, padding: 8 }} accessibilityRole="alert" testID={`offer-confirm-${o.id}`}>
                <Text style={{ color: colors.text, fontSize: 13 }}>{(arm.what === 'accept' ? pt('offerAcceptWarn') : pt('offerDeclineWarn')).replace('{n}', String(cur.revisionNumber))}</Text>
                {arm.what === 'decline' && (
                  <TextInput
                    style={{ marginTop: 6, backgroundColor: colors.panel2, color: colors.text, borderRadius: 8, padding: 8, fontSize: 13 }}
                    placeholder={pt('offerDeclineReason')} placeholderTextColor={colors.muted} accessibilityLabel={pt('offerDeclineReason')}
                    value={reason[o.id] ?? ''} onChangeText={(v) => setReason((s) => ({ ...s, [o.id]: v.slice(0, 400) }))} maxLength={400}
                  />
                )}
                <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <Button small primary={arm.what === 'accept'} danger={arm.what === 'decline'} label={(arm.what === 'accept' ? pt('offerConfirmAccept') : pt('offerConfirmDecline')).replace('{n}', String(cur.revisionNumber))} onPress={() => answer(o, cur, arm.what)} disabled={busy === o.id} testID={`offer-confirm-${arm.what}-${o.id}`} />
                  <Button small label={pt('offerCancel')} onPress={() => setArm(null)} testID={`offer-cancel-${o.id}`} />
                </Row>
                <Muted size={12}>{pt('offerNotSigning')}</Muted>
              </View>
            )}
            {actor.kind === 'player' && o.status !== 'DRAFT' && (
              <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <Button small label={o.agentShared ? pt('offerAgentUnshare') : pt('offerAgentShare')} onPress={() => share(o)} disabled={busy === o.id} testID={`offer-share-${o.id}`} />
                <Muted size={12}>{o.agentShared ? pt('offerAgentShared') : pt('offerAgentShareHint')}</Muted>
              </Row>
            )}
            {older.length > 0 && (
              <View style={{ marginTop: 6 }}>
                <Muted size={12}>{pt('offerOlderRevisions')}</Muted>
                {older.map((r) => <Muted key={r.id} size={12}>{pt('offerRevision')} {r.revisionNumber} · {stLabel(r.status)} · {r.terms.role ?? '—'} · {r.terms.startDate ?? '—'}</Muted>)}
              </View>
            )}
            <Muted size={12}>{pt('offerNotSigning')}</Muted>
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite" style={{ marginTop: 6 }} testID="offer-message"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}
