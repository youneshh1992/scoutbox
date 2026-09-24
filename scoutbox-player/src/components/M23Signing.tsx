// M23 P7 — the player's signing: the document the club presented, exactly as
// presented, identified by its SHA-256 digest; who still has to sign; and the
// player's own act, behind a second explicit step that names the revision
// and the digest being confirmed (§46, §51). Confirming is the player's own
// signature on that exact document. It is NOT the contract being signed by
// ScoutBox, and nothing is "signed" until every required party has
// confirmed and the club completes the signing (§24).
//
// A guardian sees nothing here: the guardian pathway is closed in every
// jurisdiction in this build (§14), and the server lists nothing for it.
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Linking, Text, View } from 'react-native';
import { m12, type FamilySigning, type FamilySigningParty, type SigningPartyType, type SigningStatus } from '../data/m12client';
import { colors } from '../theme';
import { pt } from '../i18n';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';

type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

const GLYPH: Record<SigningStatus, string> = { DRAFT: '○', READY: '➤', IN_PROGRESS: '◐', COMPLETED: '✓', CANCELLED: '⊘', VOIDED: '⊗', EXPIRED: '⌛', SUPERSEDED: '↻' };
const tone = (s: SigningStatus | null) => (s === 'READY' || s === 'IN_PROGRESS' ? 'gold' : s === 'COMPLETED' ? 'green' : s === 'CANCELLED' || s === 'VOIDED' || s === 'EXPIRED' ? 'red' : 'default');
const stLabel = (s: SigningStatus | null) => {
  if (!s) return '';
  const key = `signingSt_${s}` as Parameters<typeof pt>[0];
  try { return `${GLYPH[s]} ${pt(key) ?? s}`; } catch { return s; }
};
const partyLabel = (p: SigningPartyType) => {
  const key = `signingParty_${p}` as Parameters<typeof pt>[0];
  try { return pt(key) ?? p; } catch { return p; }
};
const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const shortSha = (sha: string | null) => (sha ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : '—');
const errMsg = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code ?? (e instanceof Error ? e.message : '');
  const key = `signingErr_${code}` as Parameters<typeof pt>[0];
  try { const s = pt(key); if (s) return s; } catch { /* unknown code */ }
  return pt('signingErr_generic');
};
const keyFor = (sid: string, rid: string) => `sg-complete-${sid}-${rid}`;

export function SigningSection({ actor }: { actor: Actor }) {
  const [items, setItems] = useState<FamilySigning[] | null>(null);
  const [tick, setTick] = useState(0);
  const [arm, setArm] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The tab keeps this screen mounted; a package the club presented, superseded
  // or cancelled while the player was elsewhere must not stay on screen stale.
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(useCallback(() => { setFocusTick((x) => x + 1); }, []));
  useEffect(() => {
    let on = true;
    (actor.kind === 'player' ? m12.getSignings(actor.id) : m12.gSignings(actor.id)).then((x) => on && setItems(x)).catch(() => on && setItems([]));
    return () => { on = false; };
  }, [actor.id, actor.kind, tick, focusTick]);
  if (!items || items.length === 0) return null;
  if (actor.kind !== 'player') return null;

  const confirm = async (s: FamilySigning) => {
    if (busy || !s.nextAction) return;
    setBusy(s.id); setMsg(null);
    try {
      await m12.completeSigning(actor.id, s.id, s.nextAction.revisionId, s.nextAction.documentSha256 ?? '', keyFor(s.id, s.nextAction.revisionId));
      setMsg(pt('signingConfirmed'));
      setArm(null);
      setTick((x) => x + 1);
    } catch (e) { setMsg(errMsg(e)); setArm(null); setTick((x) => x + 1); }
    finally { setBusy(null); }
  };
  const openDoc = async (s: FamilySigning, revisionId: string) => {
    if (busy) return;
    setBusy(s.id); setMsg(null);
    try {
      const f = await m12.getSigningDocument(actor.id, s.id, revisionId);
      if (f.file) { try { await Linking.openURL(`data:${f.file.mime};base64,${f.file.base64}`); } catch { /* not openable here */ } }
      setMsg(pt('signingDocumentOpened'));
    } catch { setMsg(pt('signingDocumentFailed')); }
    finally { setBusy(null); }
  };

  return (
    <Card testID="signing-section">
      <SectionTitle>✍️ {pt('signingTitle')}</SectionTitle>
      <Muted size={12.5}>{pt('signingHint')}</Muted>
      {items.map((s) => {
        const cur = s.currentRevision;
        const live = !!s.nextAction && !!cur && (s.status === 'READY' || s.status === 'IN_PROGRESS');
        const mine = cur?.requiredParties.find((p: FamilySigningParty) => p.partyType === 'PLAYER') ?? null;
        const older = s.revisions.filter((r) => r.id !== cur?.id);
        return (
          <View key={s.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }} testID={`signing-${s.id}`} accessibilityLabel={`${pt('signingTitle')} ${s.club.name ?? ''}`}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5, flex: 1 }}>{s.club.name ?? '—'}</Text>
              <Pill label={stLabel(s.status)} tone={tone(s.status)} />
            </Row>
            {cur && (
              <View style={{ marginTop: 4, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }} testID={`signing-revision-${cur.id}`}>
                <Muted size={12}>{pt('signingRevision')} {cur.revisionNumber} · {pt('signingPresentedAt')} {fmt(cur.readyAt)}{s.expiresAt ? ` · ${pt('signingExpires')} ${fmt(s.expiresAt)}` : ''}</Muted>
                {cur.contract && <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>{pt('signingStart')}: {cur.contract.startDate ?? '—'}{cur.contract.endDate ? ` · ${pt('signingEnd')}: ${cur.contract.endDate}` : ''}</Text>}
                {cur.document ? (
                  <View style={{ marginTop: 4 }} testID={`signing-document-${cur.id}`}>
                    <Row>
                      <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>{cur.document.label ?? cur.document.filename ?? pt('signingDocument')}</Text>
                      <Button small label={pt('signingOpenDocument')} onPress={() => openDoc(s, cur.id)} disabled={busy === s.id} testID={`signing-open-${cur.id}`} />
                    </Row>
                    <Muted size={11.5}>{pt('signingDigest')}: <Text testID={`signing-digest-${cur.id}`} accessibilityLabel={cur.document.sha256 ?? undefined}>{shortSha(cur.document.sha256)}</Text></Muted>
                  </View>
                ) : <Muted size={12.5}>{pt('signingNoDocument')}</Muted>}
                <View style={{ marginTop: 4 }} testID={`signing-parties-${cur.id}`}>
                  {cur.requiredParties.map((p) => (
                    <Muted key={p.partyType} size={12}>{p.status === 'COMPLETED' ? '✓' : '○'} {partyLabel(p.partyType)} · {p.status === 'COMPLETED' ? `${pt('signingPartyDone')} ${fmt(p.completedAt)}` : pt('signingPartyPending')}</Muted>
                  ))}
                </View>
              </View>
            )}
            {s.status === 'COMPLETED' && s.completion && (
              <View style={{ marginTop: 6 }} testID={`signing-completed-${s.id}`}>
                <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '700' }}>{pt('signingCompleted').replace('{when}', fmt(s.completion.completedAt))}</Text>
                <Muted size={12}>{pt('signingCompletedNote')}</Muted>
              </View>
            )}
            {mine?.status === 'COMPLETED' && s.status !== 'COMPLETED' && <View testID={`signing-yours-done-${s.id}`}><Muted size={12}>{pt('signingYouConfirmed')} {fmt(mine.completedAt)} · {pt('signingAwaitingOthers')}</Muted></View>}
            {live && arm !== s.id && (
              <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <Button small primary label={pt('signingSign')} onPress={() => setArm(s.id)} testID={`signing-sign-${s.id}`} />
              </Row>
            )}
            {live && arm === s.id && cur && s.nextAction && (
              <View style={{ marginTop: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.gold, padding: 8 }} accessibilityRole="alert" testID={`signing-confirm-${s.id}`}>
                <Text style={{ color: colors.text, fontSize: 13 }}>{pt('signingConfirmWarn').replace('{n}', String(cur.revisionNumber)).replace('{club}', s.club.name ?? '—')}</Text>
                <Muted size={11.5}>{pt('signingDigest')}: {shortSha(s.nextAction.documentSha256)}</Muted>
                <Muted size={12}>{s.honest}</Muted>
                <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <Button small primary label={pt('signingConfirmSign').replace('{n}', String(cur.revisionNumber))} onPress={() => confirm(s)} disabled={busy === s.id} testID={`signing-confirm-sign-${s.id}`} />
                  <Button small label={pt('signingCancel')} onPress={() => setArm(null)} testID={`signing-cancel-${s.id}`} />
                </Row>
              </View>
            )}
            {older.length > 0 && (
              <View style={{ marginTop: 6 }}>
                <Muted size={12}>{pt('signingOlderRevisions')}</Muted>
                {older.map((r) => <Muted key={r.id} size={12}>{pt('signingRevision')} {r.revisionNumber} · {stLabel(r.status)} · {shortSha(r.document?.sha256 ?? null)}</Muted>)}
              </View>
            )}
            {s.status !== 'COMPLETED' && <Muted size={12}>{pt('signingNotYetSigned')}</Muted>}
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite" style={{ marginTop: 6 }} testID="signing-message"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}
