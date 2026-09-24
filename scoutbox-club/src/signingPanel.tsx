// M23 P7 — Signing & Contract Completion, inside the Room's Signing tab.
//
//   Offer accepted ≠ Signing ≠ Contract effective
//
// An accepted Offer opens the door to a signing and starts none. A lead opens
// the package here — an explicit act — attaches the exact document (its
// SHA-256 is computed from the bytes on the server), presents it, and then
// each required party confirms that exact revision: the player in their own
// app, the club through a recruitment lead here. Only a recruitment lead
// completes the package, and only when every party has confirmed; only then
// does the server write the signing record and move the case to Signed.
//
// What never appears here: a "sign for the player" control, a legal claim,
// a fee, a negotiation, the recruitment decision's rationale.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Session } from './api';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';
import { rooms, type Room, type SigningSurface, type SigningClubView, type SigningStatus, type SigningHistoryItem } from './roomsApi';
import { t, fmtDateTime, fmtDate } from './i18n';

interface Props {
  session: Session;
  room: Room;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
}

const statusLabel = (s: string) => t(`rm.st.${s}`, s.replace(/_/g, ' '));
/** Text + a glyph for every signing status — never colour alone (§96). */
export const SIGNING_GLYPH: Record<SigningStatus, string> = { DRAFT: '○', READY: '➤', IN_PROGRESS: '◐', COMPLETED: '✓', CANCELLED: '⊘', VOIDED: '⊘', EXPIRED: '⌛', SUPERSEDED: '↻' };
export const signingStatusLabel = (s: SigningStatus | null) => (s ? `${SIGNING_GLYPH[s] ?? ''} ${t(`sg.st.${s}`, s)}` : '');

export function signingErrMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const specific = t(`sg.err.${e.code}`, '');
    const d = e.details as { blockers?: string[]; reasons?: string[]; current?: { status?: string } } | null;
    const codes = d?.blockers ?? d?.reasons;
    const tail = Array.isArray(codes) && codes.length ? ` ${codes.map((b) => t(`sg.b.${b}`, b)).join(' · ')}` : '';
    if (specific) return `${specific}${tail}`;
    if (e.code === 'RATE_LIMITED') return t('rm.errRateLimited');
    if (/REV_CONFLICT$|VERSION_CONFLICT$/.test(e.code)) return t('common.conflict');
    if (e.code === 'ROOM_NOT_FOUND') return t('of.err.ROOM_NOT_FOUND');
    return t('sg.err.generic');
  }
  return t('sg.err.generic');
}

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
const shortDigest = (sha: string | null) => (sha ? `${sha.slice(0, 12)}…${sha.slice(-6)}` : '—');

export function SigningWorkflow({ session, room, notify, reload }: Props) {
  const [data, setData] = useState<SigningSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<SigningHistoryItem[]>([]);
  const [contract, setContract] = useState({ startDate: '', endDate: '' });
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const executedRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await rooms.signing(session, room.roomId);
      setData(d); setError(null);
      const focus = d.packages.find((p) => p.id === (d.livePackageId ?? '')) ?? d.packages[0] ?? null;
      setOpen((cur) => (cur && d.packages.some((p) => p.id === cur) ? cur : focus?.id ?? null));
      const cur = focus?.currentRevision ?? null;
      if (cur?.status === 'DRAFT') { setContract({ startDate: cur.contract?.startDate ?? '', endDate: cur.contract?.endDate ?? '' }); setNote(focus?.internalNote ?? ''); }
      if (focus) setHistory((await rooms.signingHistory(session, focus.id)).items); else setHistory([]);
    } catch (e) { setError(signingErrMessage(e)); }
  }, [session, room.roomId]);
  useEffect(() => { void load(); }, [load, room.rev]);

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try { const msg = await fn(); setLive(msg); notify(msg); await load(); }
    catch (e) { const msg = signingErrMessage(e); setLive(msg); notify(msg, true); await load(); }
    finally { setBusy(false); }
  };

  if (error) return <div className="notice block" role="status">{error}</div>;
  if (!data) return <div className="dim">{t('common.loading')}</div>;

  const req = data.requirements;
  const pkg: SigningClubView | null = data.packages.find((p) => p.id === open) ?? data.packages[0] ?? null;
  const cur = pkg?.currentRevision ?? null;
  const st = pkg?.status ?? null;
  const isDraft = st === 'DRAFT';
  const presented = st === 'READY' || st === 'IN_PROGRESS';
  const allSigned = !!cur && cur.requiredParties.length > 0 && cur.requiredParties.every((p) => p.status === 'COMPLETED');
  const clubParty = cur?.requiredParties.find((p) => p.partyType === 'CLUB_SIGNATORY') ?? null;
  const canStart = req.startBlockers.length === 0 && !!req.acceptedOfferId;

  const start = () => run(async () => {
    if (!req.acceptedOfferId) return t('sg.notDone');
    await rooms.startSigning(session, req.acceptedOfferId, { clientKey: `sg-start-${req.acceptedOfferId}-${Date.now().toString(36)}` });
    return t('sg.started');
  });
  const saveDraft = () => run(async () => {
    if (!pkg || !isDraft) return t('sg.notDone');
    await rooms.updateSigningDraft(session, pkg.id, { contract: { startDate: contract.startDate || null, endDate: contract.endDate || null }, internalNote: note.trim() || null, expectedRev: pkg.rev });
    return t('sg.saved');
  });
  const attach = (kind: 'document' | 'executed') => run(async () => {
    if (!pkg) return t('sg.notDone');
    const input = kind === 'document' ? fileRef.current : executedRef.current;
    const file = input?.files?.[0];
    if (!file) return t('sg.pickFile');
    const dataUrl = await readAsDataUrl(file);
    if (kind === 'document') await rooms.attachSigningDocument(session, pkg.id, { dataUrl, filename: file.name, label: file.name, expectedRev: pkg.rev });
    else await rooms.attachExecutedDocument(session, pkg.id, { dataUrl, filename: file.name, expectedRev: pkg.rev });
    if (input) input.value = '';
    return kind === 'document' ? t('sg.attached') : t('sg.executedAttached');
  });
  const present = () => run(async () => {
    if (!pkg || !isDraft) return t('sg.notDone');
    await rooms.updateSigningDraft(session, pkg.id, { contract: { startDate: contract.startDate || null, endDate: contract.endDate || null }, internalNote: note.trim() || null, expectedRev: pkg.rev });
    const fresh = (await rooms.signingPackage(session, pkg.id)).signing;
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.presentSigning, name: String(fresh.currentRevision?.revisionNumber ?? '') })) return t('sg.notDone');
    await rooms.presentSigning(session, pkg.id, { expectedRev: fresh.rev, clientKey: `sg-ready-${pkg.id}-${fresh.currentRevisionId}` });
    return t('sg.presented');
  });
  const clubSign = () => run(async () => {
    if (!pkg || !cur?.document?.sha256) return t('sg.notDone');
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.clubSignSigning, name: shortDigest(cur.document.sha256) })) return t('sg.notDone');
    await rooms.completeClubParty(session, pkg.id, { expectedRev: pkg.rev, revisionId: cur.id, documentSha256: cur.document.sha256, clientKey: `sg-club-${pkg.id}-${cur.id}` });
    return t('sg.clubSigned');
  });
  const complete = () => run(async () => {
    if (!pkg || !cur) return t('sg.notDone');
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.completeSigning, name: String(cur.revisionNumber) })) return t('sg.notDone');
    const r = await rooms.completeSigning(session, pkg.id, { expectedRev: pkg.rev, clientKey: `sg-complete-${pkg.id}-${cur.id}` });
    reload();
    return r.lifecycle?.applied ? t('sg.completedMoved').replace('{status}', statusLabel(r.lifecycle.to ?? '')) : t('sg.completed');
  });
  const close = (kind: 'cancel' | 'void') => run(async () => {
    if (!pkg) return t('sg.notDone');
    if (!confirmDestructive({ ...(kind === 'cancel' ? DESTRUCTIVE_ACTIONS.cancelSigning : DESTRUCTIVE_ACTIONS.voidSigning), name: String(cur?.revisionNumber ?? '') })) return t('sg.notDone');
    const input = { expectedRev: pkg.rev, reason: reason.trim() || undefined, clientKey: `sg-${kind}-${pkg.id}-${cur?.id ?? ''}` };
    if (kind === 'cancel') await rooms.cancelSigning(session, pkg.id, input); else await rooms.voidSigning(session, pkg.id, input);
    setReason('');
    return kind === 'cancel' ? t('sg.cancelled') : t('sg.voided');
  });
  const supersede = () => run(async () => {
    if (!pkg || !cur) return t('sg.notDone');
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.supersedeSigning, name: String(cur.revisionNumber) })) return t('sg.notDone');
    await rooms.supersedeSigning(session, pkg.id, { expectedRev: pkg.rev, reason: reason.trim() || undefined, clientKey: `sg-supersede-${pkg.id}-${cur.id}` });
    setReason('');
    return t('sg.superseded');
  });
  const openDoc = (kind: 'document' | 'executed') => run(async () => {
    if (!pkg) return t('sg.notDone');
    const d = await rooms.signingDocument(session, pkg.id, kind);
    if (d.file) window.open(`data:${d.file.mime};base64,${d.file.base64}`, '_blank', 'noopener');
    return t('sg.opened');
  });

  return (
    <div aria-label={t('sg.title')} data-testid="signing-workflow">
      <div role="status" aria-live="polite" className="dim" style={{ fontSize: 12.5, minHeight: 16 }}>{live}</div>

      <div className="section" aria-label={t('sg.title')}>
        <h4>{t('sg.title')}</h4>
        <p className="dim" style={{ fontSize: 12.5 }}>{t('sg.intro')}</p>
        {data.legacySigning && <div className="notice" data-testid="signing-legacy">{t('sg.legacy').replace('{when}', fmtDateTime(data.legacySigning.at ?? 0))}</div>}

        {!pkg && (
          <div data-testid="signing-none">
            <div className="dim">{t('sg.none')}</div>
            <div data-testid="signing-start-availability" data-possible={canStart ? '1' : '0'} className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>
              {canStart ? t('sg.canStart') : `${t('sg.cannotStart')} ${req.startBlockers.map((b) => t(`sg.b.${b}`, b)).join(' · ')}`}
            </div>
            {canStart && <button className="primary" disabled={busy} onClick={start} data-testid="signing-start" aria-describedby="sg-start-note">{t('sg.start')}</button>}
            <p id="sg-start-note" className="dim" style={{ fontSize: 12 }}>{t('sg.startNote')}</p>
          </div>
        )}

        {pkg && cur && (
          <div data-testid="signing-package" data-status={st ?? ''}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="pill" data-testid="signing-status">{signingStatusLabel(st)}</span>
              <span className="dim" style={{ fontSize: 12.5 }}>{t('sg.revision')} {cur.revisionNumber}</span>
              {pkg.expiresAt && !pkg.terminal && <span className="dim" style={{ fontSize: 12.5 }}>{t('sg.expires')} {fmtDateTime(pkg.expiresAt)}</span>}
            </div>

            {/* ---- contract days ---- */}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <label>{t('sg.contractStart')}<input type="date" aria-label={t('sg.contractStart')} aria-required="true" value={isDraft ? contract.startDate : cur.contract?.startDate ?? ''} disabled={!isDraft} onChange={(e) => setContract((c) => ({ ...c, startDate: e.target.value }))} /></label>
              <label>{t('sg.contractEnd')}<input type="date" aria-label={t('sg.contractEnd')} value={isDraft ? contract.endDate : cur.contract?.endDate ?? ''} disabled={!isDraft} onChange={(e) => setContract((c) => ({ ...c, endDate: e.target.value }))} /></label>
            </div>
            {isDraft && (
              <>
                <label style={{ display: 'block', marginTop: 8 }}>{t('sg.note')}<textarea aria-label={t('sg.note')} data-testid="signing-internal-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></label>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  <button disabled={busy} onClick={saveDraft} data-testid="signing-save">{t('sg.save')}</button>
                  <label>{t('sg.document')}<input type="file" ref={fileRef} accept="application/pdf,image/png,image/jpeg,image/webp" aria-label={t('sg.document')} aria-required="true" data-testid="signing-file" /></label>
                  <button disabled={busy} onClick={() => attach('document')} data-testid="signing-attach">{t('sg.attach')}</button>
                </div>
              </>
            )}

            {/* ---- the document ---- */}
            <div style={{ marginTop: 8 }} data-testid="signing-document">
              {cur.document ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>📄 {cur.document.label ?? cur.document.filename ?? t('sg.document')}</span>
                  <code aria-label={t('sg.digest')} title={cur.document.sha256 ?? ''} data-testid="signing-digest" data-sha256={cur.document.sha256 ?? ''} style={{ fontSize: 11.5 }}>{shortDigest(cur.document.sha256)}</code>
                  <button disabled={busy} onClick={() => openDoc('document')} data-testid="signing-open-document">{t('sg.open')}</button>
                </div>
              ) : <div className="dim" data-testid="signing-no-document">{t('sg.noDocument')}</div>}
              {cur.executedDocument && <div className="dim" style={{ fontSize: 12.5 }} data-testid="signing-executed">🗂 {t('sg.executedOnFile')} <code>{shortDigest(cur.executedDocument.sha256)}</code> <button disabled={busy} onClick={() => openDoc('executed')}>{t('sg.open')}</button></div>}
            </div>

            {/* ---- parties ---- */}
            <ul aria-label={t('sg.parties')} data-testid="signing-parties" style={{ marginTop: 8 }}>
              {cur.requiredParties.map((p) => (
                <li key={p.partyType} data-testid={`signing-party-${p.partyType}`} data-party-status={p.status}>
                  {p.status === 'COMPLETED' ? '✓' : '○'} {t(`sg.party.${p.partyType}`, p.partyType)} — {p.status === 'COMPLETED' ? `${t('sg.partyCompleted')} ${fmtDateTime(p.completedAt ?? 0)}${p.completedBy?.name ? ` · ${p.completedBy.name}` : ''}` : t('sg.partyPending')}
                </li>
              ))}
            </ul>

            {/* ---- acts ---- */}
            {isDraft && req.canManage && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button className="primary" disabled={busy || !cur.document} onClick={present} data-testid="signing-present" aria-describedby="sg-present-note">{t('sg.present')}</button>
                <p id="sg-present-note" className="dim" style={{ fontSize: 12, width: '100%' }}>{t('sg.presentNote')}</p>
              </div>
            )}
            {presented && (
              <div style={{ marginTop: 8 }}>
                {req.canComplete && clubParty && clubParty.status !== 'COMPLETED' && <button className="primary" disabled={busy} onClick={clubSign} data-testid="signing-club-sign" aria-describedby="sg-club-note">{t('sg.clubSign')}</button>}
                <p id="sg-club-note" className="dim" style={{ fontSize: 12 }}>{req.canComplete ? t('sg.clubSignNote') : t('sg.leadOnly')}</p>
                {req.canManage && (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <label>{t('sg.executed')}<input type="file" ref={executedRef} accept="application/pdf,image/png,image/jpeg,image/webp" aria-label={t('sg.executed')} data-testid="signing-executed-file" /></label>
                    <button disabled={busy} onClick={() => attach('executed')} data-testid="signing-attach-executed">{t('sg.attachExecuted')}</button>
                  </div>
                )}
                {req.canComplete && <button className="primary" disabled={busy || !allSigned} onClick={complete} data-testid="signing-complete" aria-describedby="sg-complete-note">{t('sg.complete')}</button>}
                <p id="sg-complete-note" className="dim" style={{ fontSize: 12 }}>{allSigned ? t('sg.completeNote') : t('sg.waitingParties')}</p>
              </div>
            )}
            {(isDraft || presented) && req.canManage && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <input aria-label={t('sg.reason')} placeholder={t('sg.reason')} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="signing-reason" />
                <button disabled={busy} onClick={() => close('cancel')} data-testid="signing-cancel">{t('sg.cancel')}</button>
                {presented && req.canComplete && <button disabled={busy} onClick={() => close('void')} data-testid="signing-void">{t('sg.void')}</button>}
                {presented && <button disabled={busy} onClick={supersede} data-testid="signing-supersede">{t('sg.supersede')}</button>}
              </div>
            )}
            {st === 'COMPLETED' && pkg.completion && (
              <div className="notice" data-testid="signing-completed-note" style={{ marginTop: 8 }}>
                ✓ {t('sg.completedNote').replace('{when}', fmtDateTime(pkg.completion.completedAt))}{pkg.completion.contract?.startDate ? ` · ${t('sg.contractFrom')} ${fmtDate(pkg.completion.contract.startDate)}${pkg.completion.contract.endDate ? ` → ${fmtDate(pkg.completion.contract.endDate)}` : ''}` : ''}
              </div>
            )}
            {pkg.terminal && st !== 'COMPLETED' && canStart && <button disabled={busy} onClick={start} data-testid="signing-start-again">{t('sg.startAgain')}</button>}
            {!req.canManage && <p className="dim" style={{ fontSize: 12 }}>{t('sg.readOnly')}</p>}
          </div>
        )}

        {data.packages.length > 1 && (
          <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }} data-testid="signing-packages">
            {data.packages.map((p) => <button key={p.id} className={p.id === open ? 'primary' : ''} onClick={() => setOpen(p.id)} style={{ marginRight: 6 }}>{signingStatusLabel(p.status)} · {fmtDateTime(p.createdAt)}</button>)}
          </div>
        )}

        {pkg && history.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary>{t('sg.history')}</summary>
            <ul data-testid="signing-history">{history.map((h) => <li key={h.id}>{fmtDateTime(h.at)} · {t(`sg.h.${h.action}`, h.action.replace(/_/g, ' '))}{h.by?.name ? ` · ${h.by.name}` : ''}</li>)}</ul>
          </details>
        )}
        <p className="dim" style={{ fontSize: 12 }}>{t('sg.honest')}</p>
      </div>
    </div>
  );
}
