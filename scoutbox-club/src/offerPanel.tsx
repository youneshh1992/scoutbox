// M23 P6 — the canonical Offer, inside the Room's Offer tab.
//
//   Recruitment Decision ≠ Offer ≠ Offer Acceptance ≠ Signing
//
// A positive decision (P5) opens the door to considering an Offer and creates
// none. The club drafts one here — an explicit act — edits it as a DRAFT,
// then ISSUES an exact, immutable revision, which moves the case to Offer
// made. From then on the recipient answers: an acceptance or a decline is
// their own act, recorded by the server, never typed here. An accepted Offer
// reads "signing pending"; nothing on this screen signs anything.
//
// What never appears here: an "accept for the player" control, a signing
// control, a fee, a negotiation, the decision's rationale, an assessment.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';
import { rooms, type Room, type OfferSurface, type OfferClubView, type OfferRevisionView, type OfferStatus, type OfferHistoryItem } from './roomsApi';
import { t, fmtDateTime, fmtDate } from './i18n';

interface Props {
  session: Session;
  room: Room;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
}

const statusLabel = (s: string) => t(`rm.st.${s}`, s.replace(/_/g, ' '));
/** Text + a glyph for every Offer status — never colour alone (§44). */
export const OFFER_GLYPH: Record<OfferStatus, string> = { DRAFT: '○', ISSUED: '➤', ACCEPTED: '✓', DECLINED: '✕', WITHDRAWN: '⊘', EXPIRED: '⌛', SUPERSEDED: '↻' };
export const offerStatusLabel = (s: OfferStatus | null) => (s ? `${OFFER_GLYPH[s] ?? ''} ${t(`of.st.${s}`, s)}` : '');

export function offerErrMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const specific = t(`of.err.${e.code}`, '');
    const d = e.details as { blockers?: string[]; reasons?: string[]; allowed?: string[]; current?: { status?: string } } | null;
    const codes = d?.blockers ?? d?.reasons;
    const tail = Array.isArray(codes) && codes.length ? ` ${codes.map((b) => t(`of.b.${b}`, b)).join(' · ')}` : '';
    if (specific) return `${specific}${tail}`;
    if (e.code === 'RATE_LIMITED') return t('rm.errRateLimited');
    if (/REV_CONFLICT$|VERSION_CONFLICT$/.test(e.code)) return t('common.conflict');
    if (e.code === 'ROOM_NOT_FOUND') return t('of.err.ROOM_NOT_FOUND');
    return t('of.err.generic');
  }
  return e instanceof Error ? t('of.err.generic') : t('of.err.generic');
}

const toLocalInput = (ms: number | null) => {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** A datetime-local value is a wall time in this browser's zone; the server takes an instant with an explicit offset, so it is sent as UTC. */
const fromLocalInput = (v: string): string | null => { if (!v) return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : v; };

interface TermsForm { role: string; squad: string; startDate: string; endDate: string; conditions: string; recipientMessage: string; internalNote: string; expiresAt: string }
const formOf = (r: OfferRevisionView | null): TermsForm => ({
  role: r?.terms.role ?? '', squad: r?.terms.squad ?? '', startDate: r?.terms.startDate ?? '', endDate: r?.terms.endDate ?? '',
  conditions: r?.terms.conditions ?? '', recipientMessage: r?.recipientMessage ?? '', internalNote: r?.internalNote ?? '', expiresAt: toLocalInput(r?.expiresAt ?? null),
});

export function OfferWorkflow({ session, room, notify, reload }: Props) {
  const [data, setData] = useState<OfferSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  const [form, setForm] = useState<TermsForm>(formOf(null));
  const [withdrawReason, setWithdrawReason] = useState('');
  const [history, setHistory] = useState<OfferHistoryItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await rooms.offers(session, room.roomId);
      setData(d); setError(null);
      const focus = d.offers.find((o) => o.id === (d.liveOfferId ?? '')) ?? d.offers[0] ?? null;
      setOpen((cur) => (cur && d.offers.some((o) => o.id === cur) ? cur : focus?.id ?? null));
      const cur = focus?.currentRevision ?? null;
      if (cur && cur.status === 'DRAFT') setForm(formOf(cur));
      if (focus) setHistory((await rooms.offerHistory(session, focus.id)).items);
      else setHistory([]);
    } catch (e) { setError(offerErrMessage(e)); }
  }, [session, room.roomId]);
  useEffect(() => { void load(); }, [load, room.rev]);

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try { const msg = await fn(); setLive(msg); notify(msg); await load(); }
    catch (e) { const msg = offerErrMessage(e); setLive(msg); notify(msg, true); await load(); }
    finally { setBusy(false); }
  };

  if (error) return <div className="notice block" role="status">{error}</div>;
  if (!data) return <div className="dim">{t('common.loading')}</div>;

  const req = data.requirements;
  const offer: OfferClubView | null = data.offers.find((o) => o.id === open) ?? data.offers[0] ?? null;
  const cur = offer?.currentRevision ?? null;
  const isDraft = !!cur && cur.status === 'DRAFT';
  const liveRev = offer ? offer.revisions.find((r) => r.id === offer.liveRevisionId) ?? null : null;
  const termsInput = () => ({
    terms: { role: form.role.trim() || null, squad: form.squad.trim() || null, startDate: form.startDate || null, endDate: form.endDate || null, conditions: form.conditions.trim() || null },
    recipientMessage: form.recipientMessage.trim() || null, internalNote: form.internalNote.trim() || null, expiresAt: fromLocalInput(form.expiresAt),
  });
  const set = (k: keyof TermsForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const startDraft = () => run(async () => {
    await rooms.createOffer(session, room.roomId, { terms: {}, clientKey: `of-create-${room.roomId}-${Date.now().toString(36)}` });
    return t('of.draftOpened');
  });
  const saveDraft = () => run(async () => {
    if (!offer || !isDraft) return t('of.noDraft');
    await rooms.updateOfferDraft(session, offer.id, { ...termsInput(), expectedRev: offer.rev });
    return t('of.saved');
  });
  const issue = () => run(async () => {
    if (!offer || !isDraft) return t('of.noDraft');
    // Save what is on screen first, so the issued revision is the one the person is looking at.
    const saved = await rooms.updateOfferDraft(session, offer.id, { ...termsInput(), expectedRev: offer.rev });
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.issueOffer, name: String(saved.offer.currentRevision?.revisionNumber ?? '') })) return t('of.notIssued');
    const r = await rooms.issueOffer(session, offer.id, { expectedRev: saved.offer.rev, clientKey: `of-issue-${offer.id}-${saved.offer.currentRevisionId}` });
    reload();
    return r.lifecycle?.applied ? t('of.issuedMoved').replace('{status}', statusLabel(r.lifecycle.to ?? '')) : t('of.issued');
  });
  const withdraw = () => run(async () => {
    if (!offer || !cur) return t('of.noDraft');
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.withdrawOffer, name: String(cur.revisionNumber) })) return t('of.kept');
    const r = await rooms.withdrawOffer(session, offer.id, { expectedRev: offer.rev, reason: withdrawReason.trim() || undefined, clientKey: `of-withdraw-${offer.id}-${cur.id}` });
    setWithdrawReason('');
    reload();
    return r.lifecycle?.applied ? t('of.withdrawnMoved').replace('{status}', statusLabel(r.lifecycle.to ?? '')) : t('of.withdrawn');
  });
  const revise = () => run(async () => {
    if (!offer) return t('of.noDraft');
    await rooms.reviseOffer(session, offer.id, { expectedRev: offer.rev, clientKey: `of-revise-${offer.id}-${offer.revisions.length + 1}` });
    return t('of.revisionOpened');
  });

  const canRevise = !!offer && !!cur && ['ISSUED', 'EXPIRED', 'DECLINED', 'WITHDRAWN'].includes(cur.status) && req.canDraft && !req.blocked && !req.subjectRemoved;
  const canWithdraw = !!offer && !!cur && (cur.status === 'DRAFT' || cur.status === 'ISSUED') && req.canIssue && !req.subjectRemoved;
  const issueBlocked = req.issueBlockers.length > 0;

  return (
    <div aria-label={t('of.title')} data-testid="offer-workflow">
      <div role="status" aria-live="polite" className="dim" style={{ fontSize: 12.5, minHeight: 16 }}>{live}</div>

      {/* ---- the Offer ---- */}
      <div className="section" aria-label={t('of.title')}>
        <h4>{t('of.title')}</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('of.intro')}</div>
        {!offer && <div className="dim" data-testid="offer-none">{t('of.none')}</div>}
        {offer && (
          <div data-testid="offer-card" data-offer-id={offer.id} data-status={offer.status} data-live-status={offer.liveStatus ?? ''}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="pill" data-testid="offer-status">{offerStatusLabel(offer.status)}</span>
              {offer.liveStatus && offer.liveStatus !== offer.status && <span className="pill" data-testid="offer-live-status">{t('of.liveRevision')}: {offerStatusLabel(offer.liveStatus)}</span>}
              <span className="dim" style={{ fontSize: 12.5 }}>{t('of.revision')} {cur?.revisionNumber ?? '—'} · {t('tr.rev')} {offer.rev}</span>
              {offer.agentShared && <span className="pill" data-testid="offer-agent-shared">{t('of.agentShared')}</span>}
            </div>
            {offer.status === 'ACCEPTED' && <div className="notice block" role="status" style={{ marginTop: 6 }} data-testid="offer-accepted-note">{t('of.acceptedNote')}</div>}
            {offer.status === 'ISSUED' && liveRev && <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }} data-testid="offer-awaiting">{t('of.awaiting').replace('{who}', liveRev.recipient?.type === 'guardian' ? t('of.who.guardian') : t('of.who.player')).replace('{expires}', liveRev.expiresAt ? fmtDateTime(liveRev.expiresAt) : '—')}</div>}
            {offer.firstViewedAt && <div className="dim" style={{ fontSize: 12 }}>{t('of.firstViewed').replace('{at}', fmtDateTime(offer.firstViewedAt))}</div>}
          </div>
        )}
        {req.blocked && <div className="notice block" role="status" style={{ marginTop: 6 }}>{t('of.blocked')}</div>}
        {req.subjectRemoved && <div className="notice block" role="status" style={{ marginTop: 6 }}>{t('of.subjectRemoved')}</div>}
        {!req.canDraft && !req.subjectRemoved && <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('of.readOnly')}</div>}
      </div>

      {/* ---- readiness ---- */}
      <div className="section" aria-label={t('of.readiness')}>
        <h4>{t('of.readiness')}</h4>
        <div className="list-rows">
          <div className="list-row"><span className="grow">{t('of.caseStatus')}</span><span className="pill" data-testid="offer-case-status">{statusLabel(req.status ?? '')}</span></div>
          {!offer && (
            <div className="list-row"><span className="grow">{t('of.canDraft')}</span><span className="pill" data-testid="offer-draft-availability" data-possible={req.draftBlockers.length === 0 ? '1' : '0'}>{req.draftBlockers.length === 0 ? `✓ ${t('of.possible')}` : `○ ${req.draftBlockers.map((b) => t(`of.b.${b}`, b)).join(' · ')}`}</span></div>
          )}
          {offer && isDraft && (
            <div className="list-row"><span className="grow">{t('of.canIssue')}</span><span className="pill" data-testid="offer-issue-availability" data-possible={issueBlocked ? '0' : '1'}>{issueBlocked ? `○ ${req.issueBlockers.map((b) => t(`of.b.${b}`, b)).join(' · ')}` : `✓ ${t('of.possible')}`}</span></div>
          )}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('of.readinessNote')}</div>
        {!offer && req.canDraft && req.draftBlockers.length === 0 && (
          <button className="primary" onClick={startDraft} disabled={busy} data-testid="offer-start" style={{ marginTop: 8 }}>{t('of.startDraft')}</button>
        )}
      </div>

      {/* ---- draft editor ---- */}
      {offer && isDraft && req.canDraft && (
        <div className="section" aria-label={t('of.draft')} data-testid="offer-draft">
          <h4>{t('of.draft')} — {t('of.revision')} {cur?.revisionNumber}</h4>
          <form onSubmit={(e) => { e.preventDefault(); void saveDraft(); }} aria-label={t('of.draftForm')}>
            <div className="notice block" role="status" data-testid="offer-draft-label"><b>{t('of.draftLabel')}</b> <span className="dim">· {cur?.createdBy?.name ?? ''}</span></div>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 8 }}>
              <label style={{ fontSize: 13 }}>{t('of.f.role')}<input style={{ width: '100%', marginTop: 4 }} value={form.role} maxLength={80} onChange={set('role')} aria-label={t('of.f.role')} /></label>
              <label style={{ fontSize: 13 }}>{t('of.f.squad')}<input style={{ width: '100%', marginTop: 4 }} value={form.squad} maxLength={80} onChange={set('squad')} aria-label={t('of.f.squad')} /></label>
              <label style={{ fontSize: 13 }}>{t('of.f.startDate')} <span className="dim">({t('of.required')})</span><input type="date" style={{ width: '100%', marginTop: 4 }} value={form.startDate} onChange={set('startDate')} aria-label={t('of.f.startDate')} aria-required="true" /></label>
              <label style={{ fontSize: 13 }}>{t('of.f.endDate')}<input type="date" style={{ width: '100%', marginTop: 4 }} value={form.endDate} onChange={set('endDate')} aria-label={t('of.f.endDate')} /></label>
              <label style={{ fontSize: 13 }}>{t('of.f.expiresAt')} <span className="dim">({t('of.required')})</span><input type="datetime-local" style={{ width: '100%', marginTop: 4 }} value={form.expiresAt} onChange={set('expiresAt')} aria-label={t('of.f.expiresAt')} aria-required="true" aria-describedby="of-expiry-hint" /></label>
            </div>
            <div id="of-expiry-hint" className="dim" style={{ fontSize: 12 }}>{t('of.expiryHint')}</div>
            <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>{t('of.f.conditions')}<textarea style={{ width: '100%', minHeight: 56, marginTop: 4 }} value={form.conditions} maxLength={1000} onChange={set('conditions')} aria-label={t('of.f.conditions')} /></label>
            <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>{t('of.f.recipientMessage')}<textarea style={{ width: '100%', minHeight: 56, marginTop: 4 }} value={form.recipientMessage} maxLength={2000} onChange={set('recipientMessage')} aria-label={t('of.f.recipientMessage')} aria-describedby="of-msg-hint" /></label>
            <div id="of-msg-hint" className="dim" style={{ fontSize: 12 }}>{t('of.recipientMessageHint')}</div>
            <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>{t('of.f.internalNote')}<textarea style={{ width: '100%', minHeight: 56, marginTop: 4 }} value={form.internalNote} maxLength={2000} onChange={set('internalNote')} aria-label={t('of.f.internalNote')} aria-describedby="of-note-hint" data-testid="offer-internal-note" /></label>
            <div id="of-note-hint" className="dim" style={{ fontSize: 12 }}>{t('of.internalNoteHint')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button type="submit" disabled={busy} data-testid="offer-save">{t('of.save')}</button>
              {req.canIssue && <button type="button" className="primary" onClick={issue} disabled={busy || issueBlocked} data-testid="offer-issue" aria-describedby="of-issue-note">{t('of.issue')}</button>}
            </div>
            <div id="of-issue-note" className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('of.issueNote')}</div>
          </form>
        </div>
      )}

      {/* ---- withdraw / revise ---- */}
      {offer && (canWithdraw || canRevise) && (
        <div className="section" aria-label={t('of.actions')} data-testid="offer-actions">
          <h4>{t('of.actions')}</h4>
          {canWithdraw && (
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: 'block', fontSize: 13 }}>{t('of.withdrawReason')}<input style={{ width: '100%', marginTop: 4 }} value={withdrawReason} maxLength={400} onChange={(e) => setWithdrawReason(e.target.value)} aria-label={t('of.withdrawReason')} /></label>
              <button type="button" onClick={withdraw} disabled={busy} data-testid="offer-withdraw" style={{ marginTop: 6 }}>{cur?.status === 'DRAFT' ? t('of.withdrawDraft') : t('of.withdraw')}</button>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{cur?.status === 'DRAFT' ? t('of.withdrawDraftNote') : t('of.withdrawNote')}</div>
            </div>
          )}
          {canRevise && (
            <div>
              <button type="button" onClick={revise} disabled={busy} data-testid="offer-revise">{t('of.revise')}</button>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('of.reviseNote')}</div>
            </div>
          )}
        </div>
      )}

      {/* ---- revisions ---- */}
      {offer && (
        <div className="section" aria-label={t('of.revisions')} data-testid="offer-revisions">
          <h4>{t('of.revisions')} ({offer.revisions.length})</h4>
          <div className="list-rows">
            {offer.revisions.slice().sort((a, b) => b.revisionNumber - a.revisionNumber).map((r) => <RevisionCard key={r.id} r={r} responses={offer.responses.filter((x) => x.revisionId === r.id)} />)}
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('of.revisionsNote')}</div>
        </div>
      )}

      {/* ---- other Offers on this case ---- */}
      {data.offers.length > 1 && (
        <div className="section" aria-label={t('of.others')}>
          <h4>{t('of.others')}</h4>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.offers.map((o) => <button key={o.id} type="button" className={o.id === offer?.id ? 'primary' : ''} onClick={() => setOpen(o.id)} aria-pressed={o.id === offer?.id}>{offerStatusLabel(o.status)} · {fmtDate(o.createdAt)}</button>)}
          </div>
        </div>
      )}

      {/* ---- history ---- */}
      {offer && (
        <div className="section" aria-label={t('of.history')} data-testid="offer-history">
          <h4>{t('of.history')}</h4>
          <div className="list-rows">
            {history.slice().reverse().map((h) => (
              <div key={h.id} className="list-row" data-action={h.action}>
                <span className="grow">{t(`of.h.${h.action}`, h.action.replace(/_/g, ' '))} <span className="dim">· {h.by?.name ?? t(`of.by.${h.by?.kind ?? 'system'}`, h.by?.kind ?? '')}</span></span>
                <span className="dim" style={{ fontSize: 12 }}>{fmtDateTime(h.at)}</span>
              </div>
            ))}
            {history.length === 0 && <div className="dim">{t('of.none')}</div>}
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('of.appendOnly')}</div>
        </div>
      )}

      {/* The honest line is the app's own copy (EN/FR), never the server's English text. */}
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }} data-testid="offer-honest">{t('of.honest')}</div>
    </div>
  );
}

function RevisionCard({ r, responses }: { r: OfferRevisionView; responses: OfferClubView['responses'] }) {
  const resp = responses[0] ?? null;
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-revision-id={r.id} data-revision-status={r.status}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span className="grow"><b>{t('of.revision')} {r.revisionNumber}</b> <span className="dim">· {r.issuedAt ? `${t('of.issuedAt')} ${fmtDateTime(r.issuedAt)}` : `${t('of.createdAt')} ${r.createdAt ? fmtDateTime(r.createdAt) : ''}`}{r.issuedBy?.name ? ` · ${r.issuedBy.name}` : ''}</span></span>
        <span className="pill" data-status={r.status}>{offerStatusLabel(r.status)}</span>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 4 }}>
        {r.terms.role ?? '—'}{r.terms.squad ? ` · ${r.terms.squad}` : ''} · {r.terms.startDate ? `${t('of.f.startDate')} ${r.terms.startDate}` : t('of.noStart')}{r.terms.endDate ? ` → ${r.terms.endDate}` : ''}
      </div>
      {r.terms.conditions && <div className="dim" style={{ fontSize: 12.5 }}>{r.terms.conditions}</div>}
      <div className="dim" style={{ fontSize: 12.5 }}>{t('of.expires')}: {r.expiresAt ? fmtDateTime(r.expiresAt) : t('of.noExpiry')}{r.documents.length ? ` · ${t('of.documents').replace('{n}', String(r.documents.length))}` : ''}</div>
      {r.recipientMessage && <div className="dim" style={{ fontSize: 12.5 }}>“{r.recipientMessage}”</div>}
      {r.internalNote && <div className="dim" style={{ fontSize: 12.5 }} data-testid="offer-note">🔒 {r.internalNote}</div>}
      {resp && <div style={{ fontSize: 12.5, marginTop: 4 }} data-testid="offer-response">{resp.responseType === 'accepted' ? t('of.respAccepted') : t('of.respDeclined')} · {t(`of.who.${resp.actorType}`)} · {fmtDateTime(resp.occurredAt)}{resp.reason ? ` · “${resp.reason}”` : ''}</div>}
      {r.withdrawnAt && <div className="dim" style={{ fontSize: 12.5 }}>{t('of.withdrawnAt')} {fmtDateTime(r.withdrawnAt)}{r.withdrawReason ? ` · 🔒 ${r.withdrawReason}` : ''}</div>}
      {r.supersededByRevisionId && <div className="dim" style={{ fontSize: 12 }}>{t('of.supersededBy')}</div>}
      {r.readiness && <div className="dim" style={{ fontSize: 12 }}>{t('of.transactionChecked')}</div>}
    </div>
  );
}
