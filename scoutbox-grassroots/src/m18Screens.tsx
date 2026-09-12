// M18 org screens — Second Look, Nobody Missed, Recruitment Briefs.
//
// Three rules this file keeps visible at all times:
//
//   • Neither system is player-facing. Nothing rendered here is ever shown to a
//     player or a guardian, and the words "you were missed" and "a club
//     reconsidered you" exist nowhere in ScoutBox. These are the CLUB's own
//     workflow surfaces.
//
//   • Second Look reports WHAT CHANGED since the club's recorded decision. It
//     never says that decision was wrong and never recommends signing anyone.
//     A reason the club gave that player evidence can never resolve (squad
//     space, budget, timing…) is printed as STILL STANDING, so no card can
//     imply a club-side reason went away. A room reopens only when a recruiter
//     clicks Reopen Room.
//
//   • Nobody Missed is EVALUATION COVERAGE — workflow coverage over a declared
//     denominator. Never Scout Quality, Recruitment Quality, a Scouting Score
//     or a Fairness Score. There is no hidden score, no match score and no
//     ranking by quality; the Trust Score appears only as EVIDENCE CONFIDENCE
//     with its note, and a suppressed breakdown renders its note, never zeros.
//
// No invented numbers anywhere: a comparison row whose previous value was never
// recorded prints "Previous detail unavailable", never a fabricated figure and
// never 0.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Session } from './api';
import {
  m18, BRIEF_EVIDENCE_REQUIREMENTS, BRIEF_FEET, BRIEF_LEVELS, BRIEF_POSITIONS,
  BRIEF_TRANSITIONS, BRIEF_TRUST_BANDS, NOBODY_MISSED_DISMISS_REASONS,
  NOBODY_MISSED_SORTS, SECOND_LOOK_DISMISS_REASONS,
  type BriefInput, type BriefListResult, type ComparisonRow, type EvaluationCoverage,
  type NobodyMissedItem, type NobodyMissedResult, type RecruitmentBrief,
  type SecondLookChangesResult, type SecondLookItem, type SecondLookListResult,
  type TrustMovement,
} from './m18Api';
import { STANDARD_PROTOCOLS } from './combineApi';
import { t, fmtDate, fmtDateTime } from './i18n';
import { ConflictNotice, conflictOf, type Conflict } from './conflict';
import { registerDirtyGuard } from './dirtyGuard';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';

// Grassroots keeps a SIMPLER brief: no standardized-Combine threshold
// criterion. Everything else — the gates, the copy and the honesty rules — is
// identical to Pro, and a SIMULATED Combine result is never production
// recruitment evidence in either app.
const ALLOW_COMBINE_CRITERIA = false;

// The standing grassroots ceilings are enforced on the server (a brief is
// clamped to 50 km and semi-pro whatever is posted). The form states them
// rather than accepting a wider value and silently narrowing it afterwards.
const GRASSROOTS_MAX_RADIUS_KM = 50;
const GRASSROOTS_LEVELS = BRIEF_LEVELS.filter((l) => l !== 'pro');

export interface M18ScreenProps {
  session: Session;
  tick: number;
  notify: (text: string, error?: boolean) => void;
  openPlayer: (id: string) => void;
}

// ------------------------------------------------------------ small helpers
const reasonLabel = (code: string) => t(`rm.reason.${code}`, code.replace(/_/g, ' '));
const bandLabel = (code?: string | null) => (code ? t(`m18.band.${code}`, code.replace(/_/g, ' ')) : t('m18.none'));
const statusLabel = (code?: string | null) => (code ? t(`m18.sl.status.${code}`, code.replace(/_/g, ' ')) : t('m18.none'));
const archivedLabel = (code?: string | null) => (code ? t(`rm.st.${code}`, code.replace(/_/g, ' ')) : t('m18.none'));
const briefStatusLabel = (code: string) => t(`m18.br.status.${code}`, code.replace(/_/g, ' '));
const slDismissLabel = (code: string) => t(`m18.sl.dr.${code}`, code.replace(/_/g, ' '));
const nmDismissLabel = (code: string) => t(`m18.nm.dr.${code}`, code.replace(/_/g, ' '));
const sortLabel = (code: string) => t(`m18.nm.sort.${code}`, code.replace(/_/g, ' '));
const componentLabel = (code: string) => t(`m18.comp.${code}`, code);
const levelLabel = (code: string) => t(`m18.br.level.${code}`, code.replace(/_/g, ' '));

function errMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'SECOND_LOOK_NOT_FOUND') return t('m18.err.notFound');
    if (e.code === 'SECOND_LOOK_TRANSITION_INVALID') return t('m18.err.transition');
    if (e.code === 'SECOND_LOOK_REASON_UNKNOWN' || e.code === 'NM_REASON_UNKNOWN') return t('m18.err.reasonUnknown');
    if (e.code === 'BRIEF_NOT_FOUND') return t('m18.err.briefNotFound');
    if (e.code === 'BRIEF_TRANSITION_INVALID') return t('m18.err.briefTransition');
    if (e.code === 'BRIEFS_FULL') return t('m18.err.briefsFull');
    if (e.code === 'LEAD_REQUIRED') return t('m18.err.leadRequired');
    if (e.code === 'NOT_VISIBLE') return t('m18.err.notVisible');
    if (e.code === 'ROOM_ENGINE_UNAVAILABLE') return t('m18.err.roomEngine');
    if (e.code === 'RATE_LIMITED') return t('m18.err.rateLimited');
    if (e.code === 'BRIEF_VERSION_CONFLICT') return t('common.conflict');
    return e.message;
  }
  if (e instanceof Error) {
    // The demo mirror throws the same codes as bare Errors.
    const known: Record<string, string> = {
      SECOND_LOOK_NOT_FOUND: t('m18.err.notFound'),
      SECOND_LOOK_TRANSITION_INVALID: t('m18.err.transition'),
      SECOND_LOOK_REASON_UNKNOWN: t('m18.err.reasonUnknown'),
      NM_REASON_UNKNOWN: t('m18.err.reasonUnknown'),
      BRIEF_NOT_FOUND: t('m18.err.briefNotFound'),
      BRIEF_VERSION_CONFLICT: t('common.conflict'),
      BRIEF_TRANSITION_INVALID: t('m18.err.briefTransition'),
      NOT_VISIBLE: t('m18.err.notVisible'),
    };
    return known[e.message] ?? e.message;
  }
  return 'failed';
}

/** The Trust Score never appears without saying what it is. */
function TrustNote({ note }: { note?: string | null }) {
  return <span className="dim" style={{ fontSize: 12, display: 'block' }}>{note ?? t('m18.trustNote')}</span>;
}

/** A status is never communicated by colour alone — always a word too. */
function Mark({ met }: { met: boolean }) {
  return (
    <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>{met ? '✓' : '○'}</span>
  );
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as { score?: number; band?: string };
    if (typeof o.score === 'number') return `${o.score} · ${bandLabel(o.band)}`;
    return JSON.stringify(v);
  }
  return String(v);
}

function TrustMovementList({ movement }: { movement: TrustMovement[] }) {
  if (!movement.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <b style={{ fontSize: 13 }}>{t('m18.sl.trustMovement')}</b>
      <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
        {movement.map((m, i) => (
          <li key={`${m.component}-${m.code}-${i}`} style={{ fontSize: 13 }}>
            <span aria-hidden="true">{m.direction === 'up' ? '▲' : '▼'}</span>{' '}
            {componentLabel(m.component)} — {t(`m18.trustcode.${m.code}`, m.code.replace(/_/g, ' ').toLowerCase())}{' '}
            <span className="dim">({m.direction === 'up' ? t('m18.sl.dirUp') : t('m18.sl.dirDown')})</span>
          </li>
        ))}
      </ul>
      <div className="dim" style={{ fontSize: 12 }}>{t('m18.sl.trustContext')}</div>
    </div>
  );
}

// =========================================================== SECOND LOOK
type SlTab = 'worth' | 'changed' | 'reviewed' | 'dismissed';

const SL_TABS: [SlTab, string][] = [
  ['worth', 'm18.sl.tab.worth'],
  ['changed', 'm18.sl.tab.changed'],
  ['reviewed', 'm18.sl.tab.reviewed'],
  ['dismissed', 'm18.sl.tab.dismissed'],
];

/** "Evidence Changed" is the kind whose changes REDUCE the evidence available. */
const isEvidenceChanged = (i: SecondLookItem) => i.kind === 'evidence_removed';

/**
 * A failed load has to offer a way out. Every one of these panels used to
 * render the message and stop: the only recovery from a dropped connection was
 * to navigate away and come back, which is not something a user has any reason
 * to guess. `role="alert"` also gets the failure announced, which a plain
 * <div> appearing mid-page does not.
 */
function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice block" role="alert">
      <div>{message}</div>
      {onRetry && <button style={{ marginTop: 6 }} onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}

export function SecondLookScreen({ session, tick, notify, openPlayer }: M18ScreenProps) {
  const [tab, setTab] = useState<SlTab>('worth');
  const [data, setData] = useState<SecondLookListResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [changesFor, setChangesFor] = useState<SecondLookItem | null>(null);

  const reload = useCallback(() => setBump((b) => b + 1), []);

  useEffect(() => {
    let live = true;
    setErr(null);
    // One read of the whole queue: the four tabs are the SAME items in
    // different workflow states, so splitting them client-side keeps every tab
    // count honest instead of showing a number from a different fetch.
    m18.secondLook(session, { status: 'all', limit: 100 })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, tick, bump]);

  const items = data?.items ?? [];
  const buckets = useMemo(() => ({
    worth: items.filter((i) => i.status === 'open' && !isEvidenceChanged(i)),
    changed: items.filter((i) => i.status === 'open' && isEvidenceChanged(i)),
    reviewed: items.filter((i) => i.status === 'reviewed'),
    dismissed: items.filter((i) => i.status === 'dismissed'),
  }), [items]);

  if (changesFor) {
    return (
      <ReviewChangesView
        session={session}
        item={changesFor}
        onBack={() => setChangesFor(null)}
      />
    );
  }

  return (
    <div>
      <h2>{t('m18.sl.title')}</h2>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('m18.sl.intro')}</div>
      <div className="notice block" style={{ marginBottom: 10, fontSize: 12.5 }}>
        {data?.disclaimer ?? t('m18.sl.disclaimer')}
      </div>

      <div
        role="tablist"
        aria-label={t('m18.sl.tabsLabel')}
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}
      >
        {SL_TABS.map(([id, key]) => (
          <button
            key={id}
            role="tab"
            id={`m18-sl-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="m18-sl-panel"
            className={tab === id ? 'primary' : ''}
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => setTab(id)}
          >
            {t(key)} ({buckets[id].length})
          </button>
        ))}
      </div>

      {err && <LoadError message={err} onRetry={reload} />}

      <div
        role="tabpanel"
        id="m18-sl-panel"
        aria-labelledby={`m18-sl-tab-${tab}`}
        aria-label={t('m18.sl.panelLabel')}
      >
        {!data && !err && <div className="dim">{t('m18.loading')}</div>}
        {data && buckets[tab].length === 0 && <div className="dim">{t(`m18.sl.empty.${tab}`, t('m18.sl.empty'))}</div>}
        {buckets[tab].map((item) => (
          <SecondLookCard
            key={item.id}
            session={session}
            item={item}
            notify={notify}
            openPlayer={openPlayer}
            reload={reload}
            onReviewChanges={() => setChangesFor(item)}
          />
        ))}
      </div>

      <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>{data?.note ?? t('m18.sl.note')}</div>
    </div>
  );
}

/** ONE card per player, carrying every change — never three alerts for one result. */
function SecondLookCard({
  session, item, notify, openPlayer, reload, onReviewChanges,
}: {
  session: Session;
  item: SecondLookItem;
  notify: (text: string, error?: boolean) => void;
  openPlayer: (id: string) => void;
  reload: () => void;
  onReviewChanges: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState<string>(SECOND_LOOK_DISMISS_REASONS[0]);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenCodes, setReopenCodes] = useState<string[]>(['continue_monitoring']);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); notify(done); reload(); }
    catch (e) { notify(errMessage(e), true); }
    finally { setBusy(false); }
  };

  const changes = item.changes ?? [];
  const unresolvedCodes = item.unresolvedReasonCodes ?? [];
  const open = item.status === 'open';

  return (
    <article className="section" aria-label={`${t('m18.sl.cardLabel')}: ${item.playerName ?? t('m18.sl.playerWithheld')}`}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>{item.playerName ?? t('m18.sl.playerWithheld')}</h3>
        {item.kindLabel && <span className="pill blue">{item.kindLabel}</span>}
        <span className="pill">{statusLabel(item.status)}</span>
        {item.playerName && (
          <button onClick={() => openPlayer(item.playerId)}>{t('m18.sl.openProfile')}</button>
        )}
      </div>

      {item.playerAvailable === false && (
        <div className="notice block" style={{ marginTop: 8 }}>{t('m18.sl.playerUnavailable')}</div>
      )}

      {/* What this club decided, and when. Stated, never judged. */}
      <div style={{ marginTop: 8, fontSize: 13 }}>
        <div>
          <b>{t('m18.sl.archivedOn')}:</b>{' '}
          {item.decisionAt ? fmtDate(item.decisionAt) : <span className="dim">—</span>}
          {item.archivedStatus && <> · <span className="pill">{archivedLabel(item.archivedStatus)}</span></>}
        </div>
        <div style={{ marginTop: 4 }}>
          <b>{t('m18.sl.originalReason')}:</b>{' '}
          {(item.archiveReasonCodes ?? []).length > 0
            ? (item.archiveReasonCodes ?? []).map(reasonLabel).join(' · ')
            : <span className="dim">{t('m18.sl.noReasonRecorded')}</span>}
        </div>
      </div>

      {item.summary && <div style={{ marginTop: 8, fontSize: 13.5 }}>{item.summary}</div>}

      {/* Every change, with a tick each. A change that REDUCES the evidence is
          marked as such in words — it is never framed as wrongdoing. */}
      <div style={{ marginTop: 10 }}>
        <b style={{ fontSize: 13 }}>{t('m18.sl.newSince')}</b>
        {changes.length === 0 && <div className="dim" style={{ fontSize: 13 }}>{t('m18.sl.noChanges')}</div>}
        <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
          {changes.map((c, i) => (
            <li key={c.fingerprint ?? `${c.type}-${i}`} style={{ fontSize: 13, marginBottom: 3 }}>
              <Mark met={!c.negative} />
              {c.text}
              {c.negative && <> <span className="pill">{t('m18.sl.reducesEvidence')}</span></>}
              {' '}
              <span className="dim">{fmtDate(c.occurredAt)}</span>
              {(c.relatesTo ?? []).length > 0 && (
                <div className="dim" style={{ fontSize: 12 }}>
                  {t('m18.sl.relatesTo')}: {(c.relatesTo ?? []).map(reasonLabel).join(', ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Reasons the club gave that NOTHING in a player's record can resolve.
          Printed so the card can never imply a club-side reason went away. */}
      {unresolvedCodes.length > 0 && (
        <div className="notice block" style={{ marginTop: 10, fontSize: 13 }}>
          <b>{t('m18.sl.stillStands')}</b>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
            {unresolvedCodes.map((c) => <li key={c}>{reasonLabel(c)}</li>)}
          </ul>
          <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('m18.sl.stillStandsNote')}</div>
        </div>
      )}

      <TrustMovementList movement={item.trustMovement ?? []} />

      {item.currentTrust && (
        <div style={{ marginTop: 8 }} title={item.currentTrust.note ?? t('m18.trustNote')}>
          <span className="dim" style={{ fontSize: 13 }}>{t('m18.sl.currentTrust')}:</span>{' '}
          <b>{item.currentTrust.score}</b>{' '}
          <span className="pill">{item.currentTrust.bandLabel ?? bandLabel(item.currentTrust.band)}</span>
          <TrustNote note={item.currentTrust.note} />
        </div>
      )}

      {item.status === 'reviewed' && item.reviewedAt && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>{t('m18.sl.reviewedOn')}: {fmtDateTime(item.reviewedAt)}</div>
      )}
      {item.status === 'dismissed' && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>
          {t('m18.sl.dismissedOn')}: {item.dismissedAt ? fmtDateTime(item.dismissedAt) : '—'}
          {item.dismissReason && <> · {slDismissLabel(item.dismissReason)}</>}
        </div>
      )}
      {item.status === 'reopened_room' && item.reopenedAt && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>{t('m18.sl.reopenedOn')}: {fmtDateTime(item.reopenedAt)}</div>
      )}

      {/* CTAs. Reopening a room happens ONLY because a recruiter clicked. */}
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={onReviewChanges}>{t('m18.sl.reviewChanges')}</button>
        {open && (
          <button disabled={busy} onClick={() => act(() => m18.reviewSecondLook(session, item.id), t('m18.sl.markedReviewed'))}>
            {t('m18.sl.markReviewed')}
          </button>
        )}
        {(open || item.status === 'reviewed') && (
          <>
            <button className="primary" disabled={busy} onClick={() => { setReopenOpen((v) => !v); setDismissOpen(false); }} aria-expanded={reopenOpen}>
              {t('m18.sl.reopenRoom')}
            </button>
            <button disabled={busy} onClick={() => { setDismissOpen((v) => !v); setReopenOpen(false); }} aria-expanded={dismissOpen}>
              {t('m18.sl.dismiss')}
            </button>
          </>
        )}
      </div>

      {reopenOpen && (
        <div className="section" style={{ marginTop: 8 }} aria-label={t('m18.sl.reopenPanel')}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>{t('m18.sl.reopenIntro')}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {['continue_monitoring', 'insufficient_recent_evidence', 'technical_fit', 'trial_needed'].map((code) => (
              <label key={code} style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={reopenCodes.includes(code)}
                  onChange={(e) => setReopenCodes((prev) => (e.target.checked ? [...prev, code] : prev.filter((x) => x !== code)))}
                />{' '}
                {reasonLabel(code)}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="primary"
              disabled={busy || reopenCodes.length === 0}
              onClick={() => act(() => m18.reopenRoom(session, item.id, reopenCodes), t('m18.sl.reopened'))}
            >
              {t('m18.sl.confirmReopen')}
            </button>
            <button onClick={() => setReopenOpen(false)}>{t('common.cancel')}</button>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m18.sl.reopenNote')}</div>
        </div>
      )}

      {dismissOpen && (
        <div className="section" style={{ marginTop: 8 }} aria-label={t('m18.sl.dismissPanel')}>
          <label style={{ fontSize: 13 }}>
            {t('m18.sl.dismissReason')}{' '}
            <select aria-label={t('m18.sl.dismissReason')} value={dismissReason} onChange={(e) => setDismissReason(e.target.value)}>
              {SECOND_LOOK_DISMISS_REASONS.map((r) => <option key={r} value={r}>{slDismissLabel(r)}</option>)}
            </select>
          </label>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              disabled={busy}
              onClick={() => act(() => m18.dismissSecondLook(session, item.id, dismissReason), t('m18.sl.dismissed'))}
            >
              {t('m18.sl.confirmDismiss')}
            </button>
            <button onClick={() => setDismissOpen(false)}>{t('common.cancel')}</button>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m18.sl.dismissNote')}</div>
        </div>
      )}
    </article>
  );
}

// ------------------------------------------------------- Review Changes view
/**
 * At Previous Review vs Now — deliberately focused. Only rows that CHANGED, or
 * rows whose previous value was never recorded, are shown. A missing previous
 * value prints "Previous detail unavailable"; it is never fabricated and never
 * rendered as 0.
 */
function ReviewChangesView({ session, item, onBack }: { session: Session; item: SecondLookItem; onBack: () => void }) {
  const [data, setData] = useState<SecondLookChangesResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((b) => b + 1), []);

  useEffect(() => {
    let live = true;
    setErr(null);
    m18.secondLookChanges(session, item.id)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, item.id, bump]);

  const rows: ComparisonRow[] = (data?.comparison?.rows ?? []).filter((r) => r.changed === true || r.available === false);

  return (
    <div>
      <button onClick={onBack}>← {t('m18.sl.back')}</button>
      <h2 style={{ marginTop: 10 }}>{t('m18.sl.compareTitle')}</h2>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {item.playerName ?? t('m18.sl.playerWithheld')}
      </div>

      {err && <LoadError message={err} onRetry={reload} />}
      {!data && !err && <div className="dim">{t('m18.loading')}</div>}

      {data?.unavailableNote && <div className="notice block">{data.unavailableNote}</div>}

      {data && !data.unavailableNote && (
        <div className="section" aria-label={t('m18.sl.comparePanel')}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <b>{t('m18.sl.previousReview')}:</b>{' '}
            {data.previous?.at ? fmtDate(data.previous.at) : <span className="dim">—</span>}
            {data.previous?.recommendation && <> · {t(`rm.rec.${data.previous.recommendation}`, data.previous.recommendation.replace(/_/g, ' '))}</>}
            {(data.previous?.reasonCodes ?? []).length > 0 && (
              <div className="dim">{t('m18.sl.originalReason')}: {(data.previous?.reasonCodes ?? []).map(reasonLabel).join(' · ')}</div>
            )}
            {data.previous?.note && <div className="dim">{data.previous.note}</div>}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t('m18.sl.colWhat')}</th>
                  <th>{t('m18.sl.atPrevious')}</th>
                  <th>{t('m18.sl.now')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{t(`m18.sl.row.${r.key}`, r.label)}</td>
                    <td>
                      {r.available
                        ? fmtValue(r.was)
                        : <span className="dim">{t('m18.sl.previousUnavailable')}</span>}
                    </td>
                    <td>{fmtValue(r.now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <div className="dim" style={{ marginTop: 8 }}>{t('m18.sl.noChangedRows')}</div>}
          {data.comparison?.note && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{data.comparison.note}</div>}

          {(data.changes ?? []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <b style={{ fontSize: 13 }}>{t('m18.sl.newSince')}</b>
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                {(data.changes ?? []).map((c, i) => (
                  <li key={`${c.type}-${i}`} style={{ fontSize: 13 }}>
                    <Mark met={!c.negative} />{c.text}{' '}
                    <span className="dim">{fmtDate(c.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TrustMovementList movement={data.trustMovement ?? []} />

          {(data.unresolvedReasonCodes ?? []).length > 0 && (
            <div className="notice block" style={{ marginTop: 10, fontSize: 13 }}>
              <b>{t('m18.sl.stillStands')}</b>
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                {(data.unresolvedReasonCodes ?? []).map((c) => <li key={c}>{reasonLabel(c)}</li>)}
              </ul>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('m18.sl.stillStandsNote')}</div>
            </div>
          )}

          <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>{data.note ?? t('m18.sl.note')}</div>
          <div className="dim" style={{ fontSize: 12 }}>{data.disclaimer ?? t('m18.sl.disclaimer')}</div>
        </div>
      )}
    </div>
  );
}

// ========================================================== NOBODY MISSED
export function NobodyMissedScreen({
  session, tick, notify, openPlayer, onOpenRoom,
}: M18ScreenProps & { onOpenRoom?: (roomId: string) => void }) {
  const [briefs, setBriefs] = useState<BriefListResult | null>(null);
  const [briefId, setBriefId] = useState<string>('');
  const [sort, setSort] = useState<string>('newest_evidence');
  const [data, setData] = useState<NobodyMissedResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((b) => b + 1), []);

  useEffect(() => {
    let live = true;
    m18.briefs(session)
      .then((d) => {
        if (!live) return;
        setBriefs(d);
        setBriefId((prev) => prev || (d.items.find((b) => b.status === 'active')?.id ?? d.items[0]?.id ?? ''));
      })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, tick]);

  useEffect(() => {
    if (!briefId) return;
    let live = true;
    setErr(null);
    m18.nobodyMissed(session, { briefId, sort })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { setErr(errMessage(e)); setData(null); } });
    return () => { live = false; };
  }, [session, briefId, sort, tick, bump]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); notify(done); reload(); }
    catch (e) { notify(errMessage(e), true); }
  };

  return (
    <div>
      <h2>{t('m18.nm.title')}</h2>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('m18.nm.intro')}</div>
      <div className="notice block" style={{ marginBottom: 10, fontSize: 12.5 }}>{t('m18.nm.notQuality')}</div>

      <div className="section" aria-label={t('m18.nm.briefPickerLabel')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>
            {t('m18.nm.brief')}{' '}
            <select aria-label={t('m18.nm.brief')} value={briefId} onChange={(e) => setBriefId(e.target.value)}>
              {(briefs?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.title} — {briefStatusLabel(b.status)} (v{b.version})</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            {t('m18.nm.sort')}{' '}
            <select aria-label={t('m18.nm.sort')} value={sort} onChange={(e) => setSort(e.target.value)}>
              {(data?.sorts ?? NOBODY_MISSED_SORTS).map((s) => <option key={s} value={s}>{sortLabel(s)}</option>)}
            </select>
          </label>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m18.nm.noRank')}</div>
      </div>

      {err && <LoadError message={err} onRetry={reload} />}
      {!data && !err && briefId && <div className="dim">{t('m18.loading')}</div>}
      {!briefId && briefs && <div className="dim">{t('m18.nm.noBriefs')}</div>}

      {data && (
        <>
          <CoveragePanel coverage={data.coverage} live={data.live} note={data.note} brief={data.brief} />

          {data.evaluationPolicy && (
            <details className="section">
              <summary>{t('m18.nm.policyTitle')} (v{data.evaluationPolicy.version})</summary>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                <b>{t('m18.nm.counts')}</b>
                <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                  {data.evaluationPolicy.counts.map((c) => <li key={c.key}><Mark met />{c.label}</li>)}
                </ul>
                <b style={{ display: 'block', marginTop: 8 }}>{t('m18.nm.doesNotCount')}</b>
                <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                  {data.evaluationPolicy.doesNotCount.map((c) => <li key={c.key}><Mark met={false} />{c.why}</li>)}
                </ul>
                <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
                  {t('m18.nm.recentDays', 'A player decided on recently is not surfaced here.')} ({data.evaluationPolicy.recentDecisionDays})
                </div>
              </div>
            </details>
          )}

          <div className="section" aria-label={t('m18.nm.listLabel')}>
            <h4>{t('m18.nm.candidates')} ({data.total})</h4>
            {!data.live && <div className="notice block">{data.note}</div>}
            {data.live && data.items.length === 0 && <div className="dim">{t('m18.nm.empty')}</div>}
            {data.items.map((c) => (
              <CandidateCard
                key={c.playerId}
                item={c}
                openPlayer={openPlayer}
                onReview={() => act(() => m18.reviewCandidate(session, { briefId: c.briefId, playerId: c.playerId }), t('m18.nm.reviewed'))}
                onDismiss={(reason) => act(() => m18.dismissCandidate(session, { briefId: c.briefId, playerId: c.playerId, reason }), t('m18.nm.dismissed'))}
                onAdd={async () => {
                  try {
                    const out = await m18.addCandidateToRoom(session, { briefId: c.briefId, playerId: c.playerId });
                    notify(t('m18.nm.addedToRoom'));
                    reload();
                    if (out.roomId) onOpenRoom?.(out.roomId);
                  } catch (e) { notify(errMessage(e), true); }
                }}
              />
            ))}
            <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{data.note}</div>
          </div>
        </>
      )}
    </div>
  );
}

/** Evaluation Coverage — a count over a declared denominator. Never a score. */
function CoveragePanel({
  coverage, live, note, brief,
}: { coverage: EvaluationCoverage | null; live: boolean; note: string; brief: RecruitmentBrief }) {
  return (
    <div className="section" aria-label={t('m18.nm.coverageLabel')}>
      <h4>{t('m18.nm.coverage')}</h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {brief.title} · v{brief.version} · {briefStatusLabel(brief.status)}
      </div>

      {!live && <div className="notice block">{note}</div>}

      {/* A suppressed breakdown renders its NOTE, never zeros. */}
      {live && coverage?.suppressed && <div className="notice block">{coverage.note}</div>}

      {live && coverage && !coverage.suppressed && (
        <div className="stat-grid">
          <div className="stat">
            <div className="v">{coverage.eligible}</div>
            <div className="k">{t('m18.nm.eligible')}</div>
          </div>
          <div className="stat">
            <div className="v">{coverage.evaluated ?? '—'}</div>
            <div className="k">{t('m18.nm.evaluated')}</div>
          </div>
          <div className="stat">
            <div className="v">{coverage.notYetEvaluated ?? '—'}</div>
            <div className="k">{t('m18.nm.notYet')}</div>
          </div>
          <div className="stat">
            <div className="v">{coverage.coveragePercent == null ? '—' : `${coverage.coveragePercent}%`}</div>
            <div className="k">{t('m18.nm.percent')}</div>
          </div>
        </div>
      )}

      {live && coverage && !coverage.suppressed && coverage.complete && (
        <div className="dim" style={{ fontSize: 13, marginTop: 6 }}>{t('m18.nm.complete')}</div>
      )}
      {coverage && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{coverage.note}</div>}
      <div className="dim" style={{ fontSize: 12 }}>{t('m18.nm.notQuality')}</div>
    </div>
  );
}

function CandidateCard({
  item, openPlayer, onReview, onDismiss, onAdd,
}: {
  item: NobodyMissedItem;
  openPlayer: (id: string) => void;
  onReview: () => void;
  onDismiss: (reason: string) => void;
  onAdd: () => void;
}) {
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<string>(NOBODY_MISSED_DISMISS_REASONS[0]);

  return (
    <article className="section" aria-label={`${t('m18.nm.cardLabel')}: ${item.name ?? item.playerId}`}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h4 style={{ margin: 0 }}>{item.name ?? item.playerId}</h4>
        <span className="dim">
          {item.position ?? '—'} · {item.age ?? '—'}
          {item.distanceKm != null && <> · {item.distanceKm} km</>}
        </span>
        <span className="pill">{t('m18.nm.state')}: {t(`m18.nm.st.${item.state}`, item.state.replace(/_/g, ' '))}</span>
        <button onClick={() => openPlayer(item.playerId)}>{t('m18.sl.openProfile')}</button>
      </div>

      <div style={{ marginTop: 6, fontSize: 13 }} title={item.trustNote ?? t('m18.trustNote')}>
        <span className="dim">{t('m18.nm.confidence')}:</span>{' '}
        <span className="pill">{bandLabel(item.trustBand)}</span>
        <TrustNote note={item.trustNote} />
      </div>

      {/* "Why is this player here?" — every criterion the club typed in. */}
      <div style={{ marginTop: 8 }}>
        <b style={{ fontSize: 13 }}>{t('m18.nm.whyShown')}</b>
        <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
          {item.reasons.map((r) => (
            <li key={r.key} style={{ fontSize: 13 }}>
              <Mark met={r.met} />
              {r.text}
              <span className="dim"> — {r.met ? t('m18.nm.met') : t('m18.nm.notMet')}</span>
            </li>
          ))}
        </ul>
      </div>

      {item.lastEvidenceAt && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>
          {t('m18.nm.lastEvidence')}: {fmtDate(item.lastEvidenceAt)}
        </div>
      )}

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={onReview}>{t('m18.nm.reviewPlayer')}</button>
        <button className="primary" onClick={onAdd}>{t('m18.nm.addToRoom')}</button>
        <button onClick={() => setDismissOpen((v) => !v)} aria-expanded={dismissOpen}>{t('m18.nm.dismissForBrief')}</button>
      </div>

      {dismissOpen && (
        <div className="section" style={{ marginTop: 8 }} aria-label={t('m18.nm.dismissPanel')}>
          <label style={{ fontSize: 13 }}>
            {t('m18.nm.dismissReason')}{' '}
            <select aria-label={t('m18.nm.dismissReason')} value={reason} onChange={(e) => setReason(e.target.value)}>
              {NOBODY_MISSED_DISMISS_REASONS.map((r) => <option key={r} value={r}>{nmDismissLabel(r)}</option>)}
            </select>
          </label>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => { setDismissOpen(false); onDismiss(reason); }}>{t('m18.nm.confirmDismiss')}</button>
            <button onClick={() => setDismissOpen(false)}>{t('common.cancel')}</button>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m18.nm.dismissNote')}</div>
        </div>
      )}

      {item.note && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{item.note}</div>}
    </article>
  );
}

// ====================================================== RECRUITMENT BRIEFS
export interface BriefsScreenProps extends M18ScreenProps {
  /** Deep link: "#/recruitment/briefs/:briefId" opens this brief directly. */
  briefId?: string | null;
  onOpenBrief?: (briefId: string) => void;
  onCloseBrief?: () => void;
}

export function BriefsScreen(props: BriefsScreenProps) {
  return props.briefId
    ? <BriefDetail {...props} briefId={props.briefId} />
    : <BriefList {...props} />;
}

const EMPTY_FORM: BriefInput = {
  title: '', positions: [], minAge: null, maxAge: null, radiusKm: null,
  maxLevel: null, foot: null, availability: null,
  evidenceRequirements: [], minTrustBand: null, combineProtocols: [],
  activeFrom: null, activeUntil: null,
};

function BriefList({ session, tick, notify, onOpenBrief }: BriefsScreenProps) {
  const [data, setData] = useState<BriefListResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((b) => b + 1), []);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    setErr(null);
    m18.briefs(session)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, tick, bump]);

  return (
    <div>
      <h2>{t('m18.br.title')}</h2>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('m18.br.intro')}</div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>{t('m18.br.noHidden')}</div>

      {err && <LoadError message={err} onRetry={reload} />}

      <div style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          {creating ? t('common.cancel') : t('m18.br.new')}
        </button>
      </div>

      {creating && (
        <BriefForm
          vocabulary={data?.vocabulary}
          initial={EMPTY_FORM}
          submitLabel={t('common.create')}
          onSubmit={async (input) => {
            const out = await m18.createBrief(session, input);
            if (out.ok) {
              notify(t('m18.br.created'));
              setCreating(false);
              setBump((b) => b + 1);
            }
            return out;
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="section" aria-label={t('m18.br.listLabel')}>
        {!data && !err && <div className="dim">{t('m18.loading')}</div>}
        {data && data.items.length === 0 && <div className="dim">{t('m18.br.empty')}</div>}
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>{t('m18.br.colTitle')}</th>
                <th>{t('common.status')}</th>
                <th>{t('m18.br.version')}</th>
                <th>{t('m18.br.criteria')}</th>
                <th>{t('m18.br.updated')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((b) => (
                <tr key={b.id}>
                  <td><b>{b.title}</b></td>
                  <td><span className="pill">{briefStatusLabel(b.status)}</span></td>
                  <td>v{b.version}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {b.criteriaExplained.length === 0
                      ? <span className="dim">{t('m18.br.noCriteria')}</span>
                      : b.criteriaExplained.map((c) => `${c.label}: ${c.value}`).join(' · ')}
                  </td>
                  <td>{fmtDate(b.updatedAt)}</td>
                  <td>
                    <button onClick={() => onOpenBrief?.(b.id)} aria-label={`${t('m18.br.open')} ${b.title}`}>
                      {t('m18.br.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BriefDetail({ session, tick, notify, briefId, onCloseBrief }: BriefsScreenProps & { briefId: string }) {
  const [brief, setBrief] = useState<RecruitmentBrief | null>(null);
  const [vocab, setVocab] = useState<BriefListResult['vocabulary'] | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [editing, setEditing] = useState(false);
  const [coverage, setCoverage] = useState<EvaluationCoverage | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    m18.brief(session, briefId)
      .then((b) => { if (live) setBrief(b); })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    m18.briefs(session).then((d) => { if (live) setVocab(d.vocabulary); }).catch(() => { /* form falls back */ });
    m18.evaluationCoverage(session)
      .then((d) => { if (live) setCoverage(d.items.find((x) => x.briefId === briefId)?.coverage ?? null); })
      .catch(() => { /* coverage strip is progressive enhancement */ });
    return () => { live = false; };
  }, [session, briefId, tick, bump]);

  const [statusConflict, setStatusConflict] = useState<Conflict | null>(null);
  const setStatus = async (status: string) => {
    const action = status === 'archived' ? DESTRUCTIVE_ACTIONS.archiveBrief : status === 'paused' ? DESTRUCTIVE_ACTIONS.pauseBrief : null;
    if (action && !confirmDestructive({ ...action, name: brief?.title ?? null })) return;
    setStatusConflict(null);
    try {
      const out = await m18.patchBrief(session, briefId, { status, expectedRev: brief?.rev });
      if (out.ok) { notify(t('m18.br.statusChanged')); setBump((b) => b + 1); }
      else notify(out.message, true);
    } catch (e) {
      const c = conflictOf(e);
      if (c) setStatusConflict(c); else notify(errMessage(e), true);
    }
  };

  if (err) {
    return (
      <div>
        <button onClick={() => onCloseBrief?.()}>← {t('m18.br.back')}</button>
        <div className="notice block" style={{ marginTop: 10 }}>{err}</div>
      </div>
    );
  }
  if (!brief) return <div className="dim">{t('m18.loading')}</div>;

  const transitions = BRIEF_TRANSITIONS[brief.status] ?? [];

  return (
    <div>
      <button onClick={() => onCloseBrief?.()}>← {t('m18.br.back')}</button>

      <div className="section" style={{ marginTop: 10 }} aria-label={t('m18.br.detailLabel')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>{brief.title}</h3>
          <span className="pill blue">{briefStatusLabel(brief.status)}</span>
          <span className="pill">{t('m18.br.version')} {brief.version}</span>
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          {t('m18.br.updated')}: {fmtDateTime(brief.updatedAt)}
          {brief.createdBy?.name && <> · {t('m18.br.createdBy')}: {brief.createdBy.name}</>}
        </div>

        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 13 }}>{t('m18.br.criteria')}</b>
          {brief.criteriaExplained.length === 0
            ? <div className="dim" style={{ fontSize: 13 }}>{t('m18.br.noCriteria')}</div>
            : (
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                {brief.criteriaExplained.map((c) => (
                  <li key={c.key} style={{ fontSize: 13 }}><b>{c.label}:</b> {c.value}</li>
                ))}
              </ul>
            )}
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{brief.note ?? t('m18.br.noHidden')}</div>
        </div>

        {(brief.activeFrom || brief.activeUntil) && (
          <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>
            {t('m18.br.window')}: {brief.activeFrom ?? '—'} → {brief.activeUntil ?? '—'}
          </div>
        )}

        {statusConflict && <ConflictNotice conflict={statusConflict} onReload={() => { setStatusConflict(null); setBump((b) => b + 1); }} />}
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? t('common.cancel') : t('m18.br.edit')}
          </button>
          {transitions.map((to) => (
            <button key={to} className={to === 'active' ? 'primary' : ''} onClick={() => setStatus(to)}>
              {t(`m18.br.action.${to}`, to)}
            </button>
          ))}
          {transitions.length === 0 && <span className="dim" style={{ fontSize: 12.5 }}>{t('m18.br.terminal')}</span>}
        </div>
      </div>

      {coverage && (
        <div className="section" aria-label={t('m18.nm.coverageLabel')}>
          <h4>{t('m18.nm.coverage')}</h4>
          {coverage.suppressed
            ? <div className="notice block">{coverage.note}</div>
            : (
              <div className="stat-grid">
                <div className="stat"><div className="v">{coverage.eligible}</div><div className="k">{t('m18.nm.eligible')}</div></div>
                <div className="stat"><div className="v">{coverage.evaluated ?? '—'}</div><div className="k">{t('m18.nm.evaluated')}</div></div>
                <div className="stat"><div className="v">{coverage.notYetEvaluated ?? '—'}</div><div className="k">{t('m18.nm.notYet')}</div></div>
                <div className="stat"><div className="v">{coverage.coveragePercent == null ? '—' : `${coverage.coveragePercent}%`}</div><div className="k">{t('m18.nm.percent')}</div></div>
              </div>
            )}
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{coverage.note}</div>
        </div>
      )}

      {editing && (
        <BriefForm
          vocabulary={vocab}
          initial={{
            title: brief.title,
            positions: brief.criteria.positions,
            minAge: brief.criteria.minAge,
            maxAge: brief.criteria.maxAge,
            radiusKm: brief.criteria.radiusKm,
            maxLevel: brief.criteria.maxLevel,
            foot: brief.criteria.foot,
            availability: brief.criteria.availability,
            evidenceRequirements: brief.criteria.evidenceRequirements,
            minTrustBand: brief.criteria.minTrustBand,
            combineProtocols: brief.criteria.combineProtocols,
            activeFrom: brief.activeFrom,
            activeUntil: brief.activeUntil,
          }}
          submitLabel={t('common.save')}
          onSubmit={async (input) => {
            const out = await m18.patchBrief(session, briefId, { ...input, expectedRev: brief.rev });
            if (out.ok) { notify(t('m18.br.saved')); setEditing(false); setBump((b) => b + 1); }
            return out;
          }}
          // M18.2 — closing the editor re-reads the brief. "Reload latest" on a
          // conflict goes through here, and a detail view that kept showing the
          // pre-conflict title after "Reload latest" was found by m182Live J1.
          onCancel={() => { setEditing(false); setBump((b) => b + 1); }}
        />
      )}
    </div>
  );
}

type SaveOutcome =
  | { ok: true; brief: RecruitmentBrief }
  | { ok: false; error: 'BRIEF_INVALID'; details: { field: string; error: string; unknown?: string[] }[]; message: string }
  | { ok: false; error: 'BRIEF_CRITERION_PROHIBITED'; prohibited: string[]; message: string };

/**
 * The brief form. Every field is a criterion the club types in itself: there is
 * no hidden criterion, no weight and no ranking. A protected characteristic can
 * never be a criterion — the server refuses it and says so, and this form shows
 * that refusal in the server's own words rather than swallowing it.
 */
function BriefForm({
  vocabulary, initial, submitLabel, onSubmit, onCancel,
}: {
  vocabulary?: BriefListResult['vocabulary'];
  initial: BriefInput;
  submitLabel: string;
  onSubmit: (input: BriefInput) => Promise<SaveOutcome>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<BriefInput>(initial);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; error: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  // M18.2 — a conflict keeps the draft. `savedRef` is the last state the
  // server accepted (or the initial one), so "dirty" is a real comparison and
  // a successful save clears it without a second flag to forget.
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const savedRef = useRef<string>(JSON.stringify(initial));
  const isDirty = useCallback(() => JSON.stringify(form) !== savedRef.current, [form]);
  useEffect(() => registerDirtyGuard(isDirty), [isDirty]);

  const positions = vocabulary?.positions ?? [...BRIEF_POSITIONS];
  const evidence = vocabulary?.evidenceRequirements ?? BRIEF_EVIDENCE_REQUIREMENTS;
  const bands = vocabulary?.trustBands ?? [...BRIEF_TRUST_BANDS];

  const set = <K extends keyof BriefInput>(k: K, v: BriefInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k: 'positions' | 'evidenceRequirements', value: string) =>
    setForm((f) => {
      const cur = (f[k] ?? []) as string[];
      return { ...f, [k]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] };
    });

  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

  const submit = async () => {
    setBusy(true);
    setFieldErrors([]);
    setMessage(null);
    setConflict(null);
    try {
      const out = await onSubmit(form);
      if (out.ok) savedRef.current = JSON.stringify(form);
      if (!out.ok) {
        setMessage(out.message);
        if (out.error === 'BRIEF_INVALID') setFieldErrors(out.details);
        // A prohibited criterion is reported, never quietly dropped.
        if (out.error === 'BRIEF_CRITERION_PROHIBITED') {
          setFieldErrors(out.prohibited.map((p) => ({ field: p, error: 'BRIEF_CRITERION_PROHIBITED' })));
        }
      }
    } catch (e) {
      const c = conflictOf(e);
      if (c) setConflict(c); else setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section" aria-label={t('m18.br.formLabel')}>
      <h4>{t('m18.br.formTitle')}</h4>

      {conflict && (
        <ConflictNotice
          conflict={conflict}
          onReload={() => { setConflict(null); onCancel(); }}
          onKeepChanges={() => setConflict(null)}
        />
      )}
      {message && <div className="notice block">{message}</div>}
      {fieldErrors.length > 0 && (
        <ul style={{ margin: '0 0 8px', paddingInlineStart: 20 }}>
          {fieldErrors.map((f, i) => (
            <li key={`${f.field}-${i}`} style={{ fontSize: 13 }}>
              <b>{t(`m18.br.field.${f.field}`, f.field)}</b> — {t(`m18.br.err.${f.error}`, f.error.replace(/_/g, ' ').toLowerCase())}
            </li>
          ))}
        </ul>
      )}

      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
        {t('m18.br.fTitle')}
        <input
          style={{ display: 'block', width: '100%', maxWidth: 420, marginTop: 4 }}
          aria-label={t('m18.br.fTitle')}
          value={form.title ?? ''}
          onChange={(e) => set('title', e.target.value)}
        />
      </label>

      <fieldset style={{ border: '1px solid var(--line, #ccc)', borderRadius: 6, marginBottom: 8 }}>
        <legend style={{ fontSize: 13 }}>{t('m18.br.fPositions')}</legend>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {positions.map((p) => (
            <label key={p} style={{ fontSize: 13 }}>
              <input type="checkbox" checked={(form.positions ?? []).includes(p)} onChange={() => toggle('positions', p)} /> {p}
            </label>
          ))}
        </div>
      </fieldset>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fMinAge')}{' '}
          <input type="number" style={{ width: 80 }} aria-label={t('m18.br.fMinAge')} value={form.minAge ?? ''} onChange={(e) => set('minAge', num(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fMaxAge')}{' '}
          <input type="number" style={{ width: 80 }} aria-label={t('m18.br.fMaxAge')} value={form.maxAge ?? ''} onChange={(e) => set('maxAge', num(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fRadius')}{' '}
          <input
            type="number" style={{ width: 100 }} max={GRASSROOTS_MAX_RADIUS_KM}
            aria-label={t('m18.br.fRadius')} value={form.radiusKm ?? ''}
            onChange={(e) => {
              const v = num(e.target.value);
              set('radiusKm', v == null ? null : Math.min(v, GRASSROOTS_MAX_RADIUS_KM));
            }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fLevel')}{' '}
          <select aria-label={t('m18.br.fLevel')} value={form.maxLevel ?? ''} onChange={(e) => set('maxLevel', e.target.value || null)}>
            <option value="">{t('m18.br.any')}</option>
            {GRASSROOTS_LEVELS.map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
          </select>
        </label>
        <p className="muted" style={{ fontSize: 12, flexBasis: '100%', margin: 0 }}>{t('m18.br.grassrootsCap')}</p>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fFoot')}{' '}
          <select aria-label={t('m18.br.fFoot')} value={form.foot ?? ''} onChange={(e) => set('foot', e.target.value || null)}>
            <option value="">{t('m18.br.any')}</option>
            {BRIEF_FEET.map((f) => <option key={f} value={f}>{t(`m18.br.foot.${f}`, f)}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fAvailability')}{' '}
          <input style={{ width: 160 }} aria-label={t('m18.br.fAvailability')} value={form.availability ?? ''} onChange={(e) => set('availability', e.target.value || null)} />
        </label>
      </div>

      <fieldset style={{ border: '1px solid var(--line, #ccc)', borderRadius: 6, marginBottom: 8 }}>
        <legend style={{ fontSize: 13 }}>{t('m18.br.fEvidence')}</legend>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {evidence.map((r) => (
            <label key={r.key} style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={(form.evidenceRequirements ?? []).includes(r.key)}
                onChange={() => toggle('evidenceRequirements', r.key)}
              /> {t(`m18.br.ev.${r.key}`, r.label)}
            </label>
          ))}
        </div>
      </fieldset>

      {ALLOW_COMBINE_CRITERIA && (
        <fieldset style={{ border: '1px solid var(--line, #ccc)', borderRadius: 6, marginBottom: 8 }}>
          <legend style={{ fontSize: 13 }}>{t('m18.br.fCombine')}</legend>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {STANDARD_PROTOCOLS.map((p) => (
              <label key={p.id} style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={(form.combineProtocols ?? []).includes(p.id)}
                  onChange={() => setForm((f) => {
                    const cur = f.combineProtocols ?? [];
                    return { ...f, combineProtocols: cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id] };
                  })}
                /> {p.title}
              </label>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{t('m18.br.combineNote')}</div>
        </fieldset>
      )}

      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
        {t('m18.br.fMinBand')}{' '}
        <select aria-label={t('m18.br.fMinBand')} value={form.minTrustBand ?? ''} onChange={(e) => set('minTrustBand', e.target.value || null)}>
          <option value="">{t('m18.br.any')}</option>
          {bands.map((b) => <option key={b} value={b}>{bandLabel(b)}</option>)}
        </select>
        <span className="dim" style={{ display: 'block', fontSize: 12 }}>{t('m18.trustNote')}</span>
      </label>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fFrom')}{' '}
          <input type="date" aria-label={t('m18.br.fFrom')} value={form.activeFrom ?? ''} onChange={(e) => set('activeFrom', e.target.value || null)} />
        </label>
        <label style={{ fontSize: 13 }}>
          {t('m18.br.fUntil')}{' '}
          <input type="date" aria-label={t('m18.br.fUntil')} value={form.activeUntil ?? ''} onChange={(e) => set('activeUntil', e.target.value || null)} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy} onClick={submit}>{submitLabel}</button>
        <button onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m18.br.prohibitedNote')}</div>
    </div>
  );
}
