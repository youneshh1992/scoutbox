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
import { Linking, View } from 'react-native';
import { Text, TextInput } from './Text';
import { m12, type FamilyOffer, type FamilyOfferRevision, type OfferStatus } from '../data/m12client';
import { useColors } from '../theme';
import { pt } from '../i18n';
import { fmtDayTime, humanDate } from '../time';
import { Button, Card, Disclosure, Kicker, Muted, Row, SectionTitle } from './ui';

type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

const GLYPH: Record<OfferStatus, string> = { DRAFT: '○', ISSUED: '➤', ACCEPTED: '✓', DECLINED: '✕', WITHDRAWN: '⊘', EXPIRED: '◷', SUPERSEDED: '↻' };
const tone = (s: OfferStatus | null) => (s === 'ISSUED' ? 'gold' : s === 'ACCEPTED' ? 'green' : s === 'DECLINED' || s === 'WITHDRAWN' || s === 'EXPIRED' ? 'red' : 'default');
const stLabel = (s: OfferStatus | null) => {
  if (!s) return '';
  const key = `offerSt_${s}` as Parameters<typeof pt>[0];
  try { return `${GLYPH[s]} ${pt(key) ?? s}`; } catch { return s; }
};
const fmt = (ms: number | null) => (ms ? fmtDayTime(ms) : '—');
const errMsg = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code ?? (e instanceof Error ? e.message : '');
  const key = `offerErr_${code}` as Parameters<typeof pt>[0];
  try { const s = pt(key); if (s) return s; } catch { /* unknown code */ }
  return pt('offerErr_generic');
};
const keyFor = (oid: string, rid: string, what: string) => `of-${what}-${oid}-${rid}`;

export type OfferView = 'all' | 'offer' | 'documents' | 'response';

// M24B — one read, three views: the Offer (terms + your act), its documents, your answer and sharing.
export function OfferSection({ actor, view = 'all' }: { actor: Actor; view?: OfferView }) {
  const colors = useColors();
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
  if (offers.length === 0 && actor.kind === 'player' && view === 'all') return null;
  const show = (...views: OfferView[]) => view === 'all' || views.includes(view);

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

  // M24F.4 — the Offer reads like a document, not a form: the kicker, the
  // club large, the role, the dates, the status, then Accept / Decline. Every
  // condition, message, document, earlier revision and the agent sharing sit
  // behind "View terms" (the Documents and Response views still show their
  // own part directly, as the case navigation expects). One quiet line says
  // what accepting is not.
  const statusColor = (st: OfferStatus | null) => (tone(st) === 'red' ? colors.danger : tone(st) === 'gold' ? colors.gold : tone(st) === 'green' ? colors.accentText : colors.muted);
  return (
    <Card testID="offer-section" flush={offers.length > 0 && view === 'offer'}>
      {/* M24F.5 — the tab already says Offer and each offer carries its own kicker; the heading only names an empty section. */}
      {offers.length === 0 || view !== 'offer' ? <SectionTitle>{pt('offersTitle')}</SectionTitle> : null}
      {offers.length === 0 && <View style={{ marginTop: 6 }}><Muted size={12.5}>{pt('offersNone')}</Muted></View>}
      {offers.map((o) => {
        const cur = o.currentRevision;
        const live = o.status === 'ISSUED' && o.awaitingYourResponse && !!cur;
        const older = o.revisions.filter((r) => r.id !== cur?.id);
        const mine = o.responses.find((x) => x.revisionId === cur?.id) ?? null;
        const dates = cur ? (cur.terms.startDate && cur.terms.endDate ? `${humanDate(cur.terms.startDate)} – ${humanDate(cur.terms.endDate)}` : cur.terms.startDate ? `${pt('offerStart')} ${humanDate(cur.terms.startDate)}` : cur.terms.endDate ? `${pt('offerEnd')} ${humanDate(cur.terms.endDate)}` : '') : '';
        return (
          <View key={o.id} style={{ marginTop: 10, paddingTop: 18 }} testID={`offer-${o.id}`} accessibilityLabel={`${pt('offersTitle')} ${o.club.name ?? ''}`}>
            <Kicker>{pt('offerKicker')}</Kicker>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 26, lineHeight: 32, letterSpacing: -0.6, marginTop: 8 }}>{o.club.name ?? '—'}{actor.kind === 'guardian' && o.playerName ? ` · ${o.playerName}` : ''}</Text>
            {cur && show('offer') ? (
              <View style={{ marginTop: 6, gap: 4 }}>
                <Text style={{ color: colors.text, fontSize: 16, lineHeight: 22 }}>{cur.terms.squad ? `${cur.terms.squad} · ` : ''}{cur.terms.role ?? '—'}</Text>
                {dates ? <Text style={{ color: colors.muted, fontSize: 14.5, lineHeight: 21 }}>{dates}</Text> : null}
              </View>
            ) : null}
            {cur && (
              <View style={{ marginTop: 18 }} testID={`offer-revision-${cur.id}`}>
                {/* The status, on its own line; the revision and the expiry, quietly, beneath it. */}
                <Text style={{ color: statusColor(o.status), fontSize: 16, fontWeight: '600', lineHeight: 22 }} accessibilityLabel={`${pt('offerStatus')}: ${stLabel(o.status)}`}>{stLabel(o.status)}</Text>
                <Text style={{ color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>{`${pt('offerRevision')} ${cur.revisionNumber} · ${cur.status === 'EXPIRED' ? pt('offerExpired') : pt('offerExpires')} ${fmt(cur.expiresAt)}`}</Text>
                {show('documents') && !show('offer') && cur.documents.length > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Muted size={12}>{pt('offerDocuments')}</Muted>
                    {cur.documents.map((d) => (
                      <Row key={d.id} style={{ marginTop: 2 }}>
                        <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{d.label ?? d.id}</Text>
                        <Button small label={pt('offerOpenDocument')} onPress={() => openDoc(o, d.id)} testID={`offer-doc-${d.id}`} />
                      </Row>
                    ))}
                  </View>
                )}
                {view === 'documents' && cur.documents.length === 0 && <Muted size={12.5}>{pt('offerNoDocuments')}</Muted>}
              </View>
            )}
            {show('offer', 'response') && o.status === 'ACCEPTED' && <View style={{ marginTop: 10 }} testID={`offer-signing-pending-${o.id}`}><Text style={{ color: colors.accentText, fontSize: 13, fontWeight: '600' }}>{pt('offerSigningPending')}</Text></View>}
            {show('offer') && o.status === 'ISSUED' && o.notAnswerableReason === 'CASE_PAUSED' && <View style={{ marginTop: 10 }} testID={`offer-paused-${o.id}`} accessibilityRole="text"><Muted size={12.5}>{pt('offerPaused')}</Muted></View>}
            {show('offer', 'response') && mine && <View style={{ marginTop: 8 }}><Muted size={12}>{mine.actorType === 'guardian' && actor.kind === 'player' ? pt('offerAnsweredByGuardian') : `${pt('offerAnsweredAt')} ${fmt(mine.occurredAt)}`}</Muted></View>}
            {view === 'response' && !mine && live && <Muted size={12.5}>{pt('offerAwaitingYou')}</Muted>}
            {show('offer') && live && !arm && (
              <Row style={{ marginTop: 16, flexWrap: 'wrap' }}>
                <Button primary label={pt('offerAccept')} onPress={() => setArm({ id: o.id, what: 'accept' })} testID={`offer-accept-${o.id}`} />
                <Button tertiary label={pt('offerDecline')} onPress={() => setArm({ id: o.id, what: 'decline' })} testID={`offer-decline-${o.id}`} />
              </Row>
            )}
            {show('offer') && live && arm?.id === o.id && cur && (
              <View style={{ marginTop: 14, borderLeftWidth: 2, borderLeftColor: colors.gold, paddingLeft: 12, paddingVertical: 4 }} accessibilityRole="alert" testID={`offer-confirm-${o.id}`}>
                <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 20 }}>{(arm.what === 'accept' ? pt('offerAcceptWarn') : pt('offerDeclineWarn')).replace('{n}', String(cur.revisionNumber))}</Text>
                {arm.what === 'decline' && (
                  <TextInput
                    style={{ marginTop: 8, backgroundColor: colors.panel2, color: colors.text, borderRadius: 8, padding: 10, fontSize: 13 }}
                    placeholder={pt('offerDeclineReason')} placeholderTextColor={colors.muted} accessibilityLabel={pt('offerDeclineReason')}
                    value={reason[o.id] ?? ''} onChangeText={(v) => setReason((s) => ({ ...s, [o.id]: v.slice(0, 400) }))} maxLength={400}
                  />
                )}
                <Row style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  <Button small primary={arm.what === 'accept'} danger={arm.what === 'decline'} label={(arm.what === 'accept' ? pt('offerConfirmAccept') : pt('offerConfirmDecline')).replace('{n}', String(cur.revisionNumber))} onPress={() => answer(o, cur, arm.what)} disabled={busy === o.id} testID={`offer-confirm-${arm.what}-${o.id}`} />
                  <Button small tertiary label={pt('offerCancel')} onPress={() => setArm(null)} testID={`offer-cancel-${o.id}`} />
                </Row>
                <Muted size={12}>{pt('offerNotSigning')}</Muted>
              </View>
            )}
            {show('offer') && cur && (
              <View style={{ marginTop: 12 }}>
                <Disclosure label={pt('offerViewTerms')} testID={`offer-terms-${o.id}`}>
                  {cur.terms.conditions ? <Muted size={13}>{pt('offerConditions')}: {cur.terms.conditions}</Muted> : null}
                  {cur.recipientMessage ? <Muted size={13}>{pt('offerMessage')}: “{cur.recipientMessage}”</Muted> : null}
                  {cur.documents.length > 0 ? (
                    <View style={{ marginTop: 6 }}>
                      <Muted size={12}>{pt('offerDocuments')}</Muted>
                      {cur.documents.map((d) => (
                        <Row key={d.id} style={{ marginTop: 2 }}>
                          <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{d.label ?? d.id}</Text>
                          <Button small label={pt('offerOpenDocument')} onPress={() => openDoc(o, d.id)} testID={`offer-doc-${d.id}`} />
                        </Row>
                      ))}
                    </View>
                  ) : <Muted size={12.5}>{pt('offerNoDocuments')}</Muted>}
                  {older.length > 0 ? (
                    <View style={{ marginTop: 6 }}>
                      <Muted size={12}>{pt('offerOlderRevisions')}</Muted>
                      {older.map((r) => <Muted key={r.id} size={12}>{pt('offerRevision')} {r.revisionNumber} · {stLabel(r.status)} · {r.terms.role ?? '—'} · {r.terms.startDate ?? '—'}</Muted>)}
                    </View>
                  ) : null}
                  {view !== 'response' && actor.kind === 'player' && o.status !== 'DRAFT' ? (
                    <View style={{ marginTop: 8 }}>
                      <Muted size={12}>{pt('offerSharing')}</Muted>
                      <Row style={{ marginTop: 4, flexWrap: 'wrap' }}>
                        <Button small label={o.agentShared ? pt('offerAgentUnshare') : pt('offerAgentShare')} onPress={() => share(o)} disabled={busy === o.id} testID={`offer-share-${o.id}`} />
                        <Muted size={12}>{o.agentShared ? pt('offerAgentShared') : pt('offerAgentShareHint')}</Muted>
                      </Row>
                    </View>
                  ) : null}
                </Disclosure>
                <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 10 }} testID={`offer-not-signature-${o.id}`}>{pt('offerNotSignature')}</Text>
              </View>
            )}
            {view === 'response' && actor.kind === 'player' && o.status !== 'DRAFT' && (
              <Row style={{ marginTop: 10, flexWrap: 'wrap' }}>
                <Button small label={o.agentShared ? pt('offerAgentUnshare') : pt('offerAgentShare')} onPress={() => share(o)} disabled={busy === o.id} testID={`offer-share-${o.id}`} />
                <Muted size={12}>{o.agentShared ? pt('offerAgentShared') : pt('offerAgentShareHint')}</Muted>
              </Row>
            )}
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite" style={{ marginTop: 10 }} testID="offer-message"><Muted size={12.5}>{msg}</Muted></View>}
      <View style={{ marginTop: 8 }}><Disclosure label="About offers" testID="about-offers"><Muted size={12.5}>{actor.kind === 'guardian' ? pt('offersGuardianHint') : pt('offersHint')}</Muted></Disclosure></View>
    </Card>
  );
}
