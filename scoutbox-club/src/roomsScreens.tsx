// M17 org screens — Recruitment Rooms.
//
// A Recruitment Room is the CLUB's private decision layer over one player:
// what we think, what we have reviewed, what we are waiting on, what we
// decided. The Football Passport stays the player's truth layer — this screen
// renders the server's composed projection of it with provenance intact and
// never re-derives, re-scores or "ticks off" anything on the player's behalf.
//
// Three rules this file keeps visible at all times:
//   • The room is private to the organisation. The player, their guardian and
//     every other club can never see it — the privacy note travels with it.
//   • The Trust Score is EVIDENCE CONFIDENCE, never football ability. It is
//     rendered with its note everywhere it appears, it never drives a status,
//     and rooms are never sorted or ranked by it.
//   • No invented numbers: decision readiness is counts plus words, room health
//     is a word, a missing measurement is blank and never zero, and a decision
//     is a human judgement recorded with structured reasons.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type Session } from './api';
import { ConflictNotice, conflictOf, type Conflict } from './conflict';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';
import {
  rooms, ROOM_PRIORITIES, ROOM_TASK_STATES, ROOM_EVIDENCE_REVIEW_STATES, REASON_REQUIRED_STATUSES,
  type Room, type RoomActivityItem, type RoomAttentionItem, type RoomComment, type RoomTrust,
  type RoomDecision, type RoomDecisionTaxonomy, type RoomListResult, type RoomReadiness,
  type ContactRecord, type ContactList, type ContactCaseMove,
} from './roomsApi';
import { STANDARD_PROTOCOLS } from './combineApi';
import { m12, type StaffRow } from './m12api';
import { PassportBody, ProvPill } from './m15screens';
import { t, fmtDate, fmtDateTime } from './i18n';
import { TrialPanel } from './trialPanel';
import { DecisionWorkflow } from './decisionPanel';
import { OfferWorkflow } from './offerPanel';
import { SigningWorkflow } from './signingPanel';
// M23 P8 — the journey strip and timeline, rendered from the server's projection.
import { JourneyStrip, JourneyTimeline, useRoomJourney } from './journeyStrip';
import type { RoomJourney } from './roomsApi';

interface RoomsScreenProps {
  session: Session;
  tick: number;
  notify: (text: string, error?: boolean) => void;
  openPlayer: (id: string) => void;
  /** Deep link: "#/recruitment/rooms/:roomId" opens this room directly. */
  roomId?: string | null;
  /** M23 P8: the tab a deep link named ("#/recruitment/rooms/:id/offer"). */
  roomTab?: string | null;
  onRoomTab?: (roomId: string, tab: string) => void;
  onOpenRoom?: (roomId: string) => void;
  onCloseRoom?: () => void;
}

type TabId = 'overview' | 'passport' | 'evidence' | 'assessments' | 'combine' | 'development' | 'discussion' | 'contact' | 'trial' | 'activity' | 'decision' | 'offer' | 'signing';

const TAB_KEYS: [TabId, string][] = [
  ['overview', 'rm.tab.overview'], ['passport', 'rm.tab.passport'], ['evidence', 'rm.tab.evidence'],
  ['assessments', 'rm.tab.assessments'], ['combine', 'rm.tab.combine'], ['development', 'rm.tab.development'],
  ['discussion', 'rm.tab.discussion'], ['contact', 'rm.tab.contact'], ['trial', 'rm.tab.trial'], ['activity', 'rm.tab.activity'], ['decision', 'rm.tab.decision'], ['offer', 'rm.tab.offer'], ['signing', 'rm.tab.signing'],
];

const VIEWS: [string, string][] = [
  ['all', 'rm.view.all'], ['mine', 'rm.view.mine'], ['assigned', 'rm.view.assigned'],
  ['shortlisted', 'rm.view.shortlisted'], ['trials', 'rm.view.trials'],
  ['offers', 'rm.view.offers'], ['archived', 'rm.view.archived'],
];

// ------------------------------------------------------------ small helpers
const statusLabel = (code: string, fallback?: string | null) => t(`rm.st.${code}`, fallback ?? code.replace(/_/g, ' '));
const healthLabel = (code: string | null, fallback?: string | null) => (code ? t(`rm.health.${code}`, fallback ?? code.replace(/_/g, ' ')) : t('rm.none'));
const reasonLabel = (code: string) => t(`rm.reason.${code}`, code.replace(/_/g, ' '));
const recommendationLabel = (code: string) => t(`rm.rec.${code}`, code.replace(/_/g, ' '));
const priorityLabel = (code: string) => t(`rm.pri.${code}`, code);
const taskStateLabel = (code: string) => t(`rm.task.${code}`, code.replace(/_/g, ' '));
const reviewStateLabel = (code: string) => t(`rm.rev.${code}`, code.replace(/_/g, ' '));
const readinessLabel = (key: string, fallback: string) => t(`rm.ready.${key}`, fallback);
const activityLabel = (type: string) => t(`rm.ev.${type}`, type.replace(/^(room|case)_/, '').replace(/_/g, ' '));

function errMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'ROOM_NOT_FOUND') return t('rm.errNotFound');
    if (e.code === 'ROOM_RESTRICTED') return t('rm.errRestricted');
    if (e.code === 'NOT_VISIBLE') return t('rm.errNotVisible');
    if (e.code === 'ROOM_REASON_REQUIRED') return t('rm.errReasonRequired');
    if (e.code === 'ROOM_REASON_PROHIBITED') return t('rm.errReasonProhibited');
    if (e.code === 'RATE_LIMITED') return t('rm.errRateLimited');
    // A lost update is now refused rather than applied, so it has to be
    // explainable: the person is told their work is intact and what to do.
    if (e.code === 'ROOM_VERSION_CONFLICT') return t('common.conflict');
    // M23 P8 — the legacy status move's three refusals, explained rather than echoed.
    if (e.code === 'ROOM_EVIDENCE_REQUIRED') return t('rm.errEvidenceRequired');
    if (e.code === 'ROOM_TRANSITION_INVALID') return t('rm.errTransitionInvalid');
    if (e.code === 'ROOM_PERMISSION_REQUIRED') return t('rm.errPermission');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

/** The Trust Score never appears without saying what it is. */
function TrustNote({ inline }: { inline?: boolean }) {
  return <span className="dim" style={{ fontSize: inline ? 11.5 : 12.5, display: inline ? 'inline' : 'block' }}>{t('rm.trustNote')}</span>;
}

/**
 * The Trust Score value. `trust` is null in two different situations and they
 * must not read the same way: the player record is not visible to this
 * organisation at all, or evidence confidence could not be read right now.
 * Neither is a score. Rendering "—" or 0 for either invites a scout to read
 * "no confidence in this player" out of what is only a missing value, which is
 * the one thing evidence confidence must never be mistaken for.
 */
function TrustValue({ trust, playerAvailable, compact }: { trust: RoomTrust | null; playerAvailable: boolean; compact?: boolean }) {
  if (trust) return <><b>{trust.score}</b> <span className="pill">{trust.bandLabel}</span></>;
  const withheld = !playerAvailable;
  return (
    <span className="dim" style={{ fontSize: compact ? 12 : undefined }} title={withheld ? t('rm.trustWithheldNote') : t('term.trustUnavailableNote')}>
      {withheld ? t('rm.trustWithheldShort') : (compact ? t('rm.trustUnavailableShort') : t('term.trustUnavailable'))}
    </span>
  );
}

// ================================================================== screen
export function RoomsScreen(props: RoomsScreenProps) {
  return props.roomId
    ? <RoomView {...props} roomId={props.roomId} />
    : <RoomsList {...props} />;
}

// =================================================================== list

/** A failed load offers a retry — see the same component in m18Screens.tsx. */
function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice block" role="alert">
      <div>{message}</div>
      {onRetry && <button style={{ marginTop: 6 }} onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}

function RoomsList({ session, tick, onOpenRoom }: RoomsScreenProps) {
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<RoomListResult | null>(null);
  const [attention, setAttention] = useState<RoomAttentionItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((b) => b + 1), []);

  useEffect(() => {
    let live = true;
    setErr(null);
    rooms.list(session, { view, q: query || undefined })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    rooms.needsAttention(session)
      .then((d) => { if (live) setAttention(d.items); })
      .catch(() => { /* the strip is progressive enhancement */ });
    return () => { live = false; };
  }, [session, tick, view, query, bump]);

  const funnel = data?.funnel ?? null;
  const open = (id: string) => onOpenRoom?.(id);

  const strip: [string, string, number][] = [
    ['active', 'rm.fn.active', funnel?.active ?? 0],
    ['shortlisted', 'rm.fn.shortlisted', funnel?.shortlisted ?? 0],
    ['trials', 'rm.fn.trials', funnel?.trials ?? 0],
    ['offers', 'rm.fn.offers', funnel?.offers ?? 0],
    ['__attention', 'rm.fn.attention', attention.length],
  ];

  return (
    <div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('rm.intro')}</div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>🔒 {t('rm.privacy')}</div>

      {/* Funnel strip — your organisation's own activity, no league table. */}
      <div className="stat-grid" aria-label={t('rm.funnel')} style={{ marginBottom: 10 }}>
        {strip.map(([id, key, n]) => (
          <button
            key={id}
            className="stat"
            style={{ textAlign: 'left', cursor: id === '__attention' ? 'default' : 'pointer' }}
            aria-current={view === id ? 'true' : undefined}
            aria-label={`${t(key)}: ${n}`}
            onClick={() => { if (id !== '__attention') setView(id); }}
          >
            <div className="v">{n}</div>
            <div className="k">{t(key)}{view === id ? ` · ${t('rm.filtering')}` : ''}</div>
          </button>
        ))}
      </div>
      {funnel && <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>{funnel.note}</div>}

      {/* Saved views + search */}
      <div role="tablist" aria-label={t('rm.views')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {VIEWS.map(([id, key]) => (
          <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'primary' : ''} onClick={() => setView(id)}>{t(key)}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          style={{ flex: 1, minWidth: 180 }}
          aria-label={t('rm.search')}
          placeholder={t('rm.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setQuery(q.trim()); }}
        />
        <button onClick={() => setQuery(q.trim())}>{t('rm.search')}</button>
        {query && <button onClick={() => { setQ(''); setQuery(''); }}>{t('common.cancel')}</button>}
      </div>

      {err && <LoadError message={err} onRetry={reload} />}

      {/* Needs attention — deterministic workflow signals, never a ranking. */}
      <div className="section" aria-label={t('rm.attention')}>
        <h4>{t('rm.attention')}</h4>
        {attention.length === 0 && <div className="dim">{t('rm.attentionNone')}</div>}
        <div className="list-rows">
          {attention.map((a) => (
            <div key={a.roomId} className="list-row" style={{ flexWrap: 'wrap' }}>
              <span className="grow"><b>{a.playerName ?? t('rm.playerWithheld')}</b> <span className="pill">{statusLabel(a.status)}</span></span>
              <span className="dim" style={{ fontSize: 12.5 }}>{a.reasons.map((r) => r.text).join(' ')}</span>
              <button onClick={() => open(a.roomId)}>{t('rm.open')}</button>
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.attentionNote')}</div>
      </div>

      {/* Rooms table — ordered by recent activity, never by Trust Score. */}
      <div className="section" aria-label={t('rm.tableLabel')}>
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>{t('rm.col.player')}</th>
                <th>{t('rm.col.position')}</th>
                <th>{t('rm.col.age')}</th>
                <th>{t('rm.col.club')}</th>
                <th>
                  {t('rm.col.trust')}
                  <div className="dim" style={{ fontWeight: 400, fontSize: 11 }}>{t('rm.trustNote')}</div>
                </th>
                <th>{t('rm.col.status')}</th>
                <th>{t('rm.col.lead')}</th>
                <th>{t('rm.col.tasks')}</th>
                <th>{t('rm.col.activity')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((r) => (
                <tr key={r.roomId}>
                  <td>
                    {r.playerAvailable
                      ? <b>{r.playerName}</b>
                      : <span className="dim">{t('rm.playerWithheld')}</span>}
                    {r.tags.length > 0 && <div>{r.tags.map((tag) => <span key={tag} className="pill" style={{ marginRight: 4 }}>{tag}</span>)}</div>}
                  </td>
                  <td>{r.position ?? <span className="dim">—</span>}</td>
                  <td>{r.age ?? <span className="dim">—</span>}</td>
                  <td>{r.currentClub ?? <span className="dim">—</span>}</td>
                  <td title={r.trust?.note ?? t('rm.trustNote')}>
                    <TrustValue trust={r.trust} playerAvailable={r.playerAvailable} compact />
                  </td>
                  <td><span className="pill">{statusLabel(r.status, r.statusLabel)}</span></td>
                  <td>{r.ownerName ?? <span className="dim">—</span>}</td>
                  <td>{r.openTasks}</td>
                  <td>{r.lastActivityAt ? fmtDate(r.lastActivityAt) : <span className="dim">—</span>}</td>
                  <td><button onClick={() => open(r.roomId)} aria-label={`${t('rm.open')} ${r.playerName ?? r.roomId}`}>{t('rm.open')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.items.length === 0 && <div className="dim" style={{ marginTop: 8 }}>{t('rm.empty')}</div>}
        {!data && !err && <div className="dim" style={{ marginTop: 8 }}>{t('rm.loading')}</div>}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{data?.note ?? t('rm.noSort')}</div>
        <div className="dim" style={{ fontSize: 12 }}>{t('rm.noSort')}</div>
      </div>
    </div>
  );
}

// =================================================================== room
const isTabId = (x: unknown): x is TabId => TAB_KEYS.some(([id]) => id === x);

function RoomView({ session, tick, notify, openPlayer, roomId, roomTab, onRoomTab, onCloseRoom }: RoomsScreenProps & { roomId: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTabState] = useState<TabId>(isTabId(roomTab) ? roomTab : 'overview');
  const [bump, setBump] = useState(0);
  const [staff, setStaff] = useState<StaffRow[]>([]);

  const reload = useCallback(() => setBump((b) => b + 1), []);
  // M23 P8 — the tab follows the deep link (back/forward included), and a
  // click writes the tab into the link.
  useEffect(() => { if (isTabId(roomTab)) setTabState(roomTab); }, [roomTab, roomId]);
  const setTab = useCallback((id: TabId) => { setTabState(id); onRoomTab?.(roomId, id); }, [onRoomTab, roomId]);
  // §55 — returning to the page re-reads the case; a colleague or the player may have moved it.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', reload);
    window.addEventListener('pageshow', reload);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('focus', reload); window.removeEventListener('pageshow', reload); document.removeEventListener('visibilitychange', onVisible); };
  }, [reload]);

  useEffect(() => {
    let live = true;
    setErr(null);
    rooms.get(session, roomId)
      .then((r) => { if (live) setRoom(r); })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, roomId, tick, bump]);

  useEffect(() => {
    let live = true;
    m12.listStaff(session).then((s) => { if (live) setStaff(s.filter((x) => !x.removedAt)); }).catch(() => { /* optional */ });
    return () => { live = false; };
  }, [session]);

  if (err) {
    return (
      <div>
        <button onClick={() => onCloseRoom?.()}>← {t('rm.back')}</button>
        <div className="notice block" style={{ marginTop: 10 }}>{err}</div>
      </div>
    );
  }
  if (!room) return <RoomLoading />;

  return <RoomBody session={session} room={room} tick={tick} notify={notify} reload={reload} staff={staff} openPlayer={openPlayer} tab={tab} setTab={setTab} onCloseRoom={onCloseRoom} />;
}

function RoomLoading() { return <div className="dim">{t('rm.loading')}</div>; }

function RoomBody({ session, room, tick, notify, reload, staff, openPlayer, tab, setTab, onCloseRoom }: PanelProps & { tick: number; tab: TabId; setTab: (id: TabId) => void; onCloseRoom?: () => void }) {
  // M23 P8 — ONE journey read per room view, shared by the strip and the timeline.
  const { journey, bump } = useRoomJourney(session, room, tick);
  const shared = { session, room, notify, reload, staff, openPlayer, journey };

  return (
    <div>
      <button onClick={() => onCloseRoom?.()}>← {t('rm.back')}</button>
      <RoomHeader {...shared} />
      <JourneyStrip session={session} room={room} journey={journey} notify={notify} reload={reload} bump={bump} onTab={(id) => setTab(id as TabId)} />

      {/* In-screen tab strip: scrolls horizontally on a narrow layout. */}
      <div
        role="tablist"
        aria-label={t('rm.tabsLabel')}
        style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', margin: '10px 0', paddingBottom: 4 }}
      >
        {TAB_KEYS.map(([id, key]) => (
          <button
            key={id}
            role="tab"
            id={`rm-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`rm-panel-${id}`}
            className={tab === id ? 'primary' : ''}
            style={{ whiteSpace: 'nowrap', flex: '0 0 auto' }}
            onClick={() => setTab(id)}
          >
            {t(key)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`rm-panel-${tab}`} aria-labelledby={`rm-tab-${tab}`} aria-label={t(`rm.tab.${tab}`)}>
        {tab === 'overview' && <OverviewPanel {...shared} />}
        {tab === 'passport' && <PassportPanel {...shared} />}
        {tab === 'evidence' && <EvidencePanel {...shared} />}
        {tab === 'assessments' && <AssessmentsPanel {...shared} />}
        {tab === 'combine' && <RoomCombinePanel {...shared} />}
        {tab === 'development' && <DevelopmentPanel {...shared} />}
        {tab === 'discussion' && <DiscussionPanel {...shared} />}
        {tab === 'contact' && <ContactPanel {...shared} />}
        {tab === 'trial' && <TrialPanel session={session} room={room} notify={notify} reload={reload} />}
        {tab === 'activity' && <ActivityPanel {...shared} />}
        {tab === 'decision' && <DecisionPanel {...shared} />}
        {tab === 'offer' && <OfferWorkflow session={session} room={room} notify={notify} reload={reload} />}
        {tab === 'signing' && <SigningWorkflow session={session} room={room} notify={notify} reload={reload} />}
      </div>

      <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>🔒 {room.privacyNote}</div>
    </div>
  );
}

interface PanelProps {
  session: Session;
  room: Room;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
  staff: StaffRow[];
  openPlayer: (id: string) => void;
  /** M23 P8 — the journey projection (null until read, or in demo mode). */
  journey?: RoomJourney | null;
}

// ---------------------------------------------------------------- header
function RoomHeader({ session, room, notify, reload, staff, openPlayer }: PanelProps) {
  const [to, setTo] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [taxonomy, setTaxonomy] = useState<RoomDecisionTaxonomy | null>(null);
  // A conflict is the one message the person must not miss, and a toast is
  // exactly where it gets missed: a routine live-sync notification arriving a
  // second later replaces it. It stays on the panel until they act on it.
  const [conflict, setConflict] = useState<Conflict | null>(null);

  useEffect(() => {
    let live = true;
    rooms.decisions(session, room.roomId).then((d) => { if (live) setTaxonomy(d.taxonomy); }).catch(() => { /* picker falls back */ });
    return () => { live = false; };
  }, [session, room.roomId]);

  const needsReason = !!to && REASON_REQUIRED_STATUSES.includes(to);

  const move = async () => {
    if (!to) return;
    const action = to === 'archived' ? DESTRUCTIVE_ACTIONS.archiveRoom : to === 'closed' ? DESTRUCTIVE_ACTIONS.closeRoom : null;
    if (action && !confirmDestructive({ ...action, name: room.playerName ?? null })) return;
    setConflict(null);
    try {
      await rooms.setStatus(session, room.roomId, { status: to, reasonCodes: codes, note: note.trim() || null, expectedRev: room.rev });
      notify(`${t('rm.statusMoved')} ${statusLabel(to)}`);
      setTo(''); setCodes([]); setNote('');
      reload();
    } catch (e) {
      const c = conflictOf(e);
      if (c) setConflict(c); else notify(errMessage(e), true);
    }
  };

  const patch = async (input: Parameters<typeof rooms.patch>[2], done: string) => {
    setConflict(null);
    try { await rooms.patch(session, room.roomId, { ...input, expectedRev: room.rev }); notify(done); reload(); }
    catch (e) {
      const c = conflictOf(e);
      if (c) setConflict(c); else notify(errMessage(e), true);
    }
  };

  return (
    <div className="section room-head" aria-label={t('rm.headerLabel')}>
      {/* M23 P2.5 — identity row: who, where they stand, and the two things a
          scout does from here (move the room, open the profile). Everything
          else is one disclosure below. Nothing here is inferred from a score. */}
      <div className="room-id">
        <div className="room-who">
          <h3 style={{ margin: 0 }}>{room.playerAvailable ? room.playerName : t('rm.playerWithheld')}</h3>
          {room.playerAvailable && (
            <span className="dim">
              {(room.passport?.player.position ?? '—')} · {room.passport?.player.age ?? '—'}
              {room.passport?.status.currentClub?.orgName ? ` · ${room.passport.status.currentClub.orgName}` : ` · ${t('rm.noClub')}`}
            </span>
          )}
          <div className="badges">
            <span className="pill blue">{t('rm.status')}: {statusLabel(room.status, room.statusLabel)}</span>
            <span className="pill">{t('rm.priority')}: {priorityLabel(room.priority)}</span>
            <span className="pill">{t('rm.health')}: {healthLabel(room.health, room.healthLabel)}</span>
            {room.restricted && <span className="pill gold">{t('rm.restricted')}</span>}
          </div>
        </div>
        <div className="room-actions">
          <label style={{ fontSize: 13 }}>
            {t('rm.changeStatus')}{' '}
            <select aria-label={t('rm.changeStatus')} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">{t('rm.pick')}</option>
              {room.allowedTransitions.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </label>
          <button className="primary" disabled={!to} onClick={move}>{t('rm.apply')}</button>
          {room.playerAvailable && (
            <button onClick={() => openPlayer(room.playerId)}>{t('rm.openProfile')}</button>
          )}
        </div>
      </div>

      {conflict && <ConflictNotice conflict={conflict} onReload={() => { setConflict(null); reload(); }} />}

      {!room.playerAvailable && (
        <div className="notice block" style={{ marginTop: 8 }}>{room.unavailableNote ?? t('rm.unavailable')}</div>
      )}

      {/* Trust Score — evidence confidence. The disclaimer and the no-ranking
          statement stay visible; they are what make the number honest. */}
      {room.trust && (
        <div className="room-trust">
          <div className="room-trust-row" title={room.trust.note}>
            <span className="dim">{t('rm.trustScore')}</span>
            <span style={{ fontSize: 18, fontWeight: 800 }}>{room.trust.score}</span>
            <span className="dim">/ 100</span>
            <span className="pill blue">{room.trust.bandLabel}</span>
            {room.trust.simulatedEvidenceIncluded && <span className="pill gold">{t('rm.demo')}</span>}
            <span className="dim" style={{ fontSize: 12 }}>{room.trust.disclaimer ?? t('rm.trustDisclaimer')}</span>
          </div>
          <div className="dim" style={{ fontSize: 12 }}><TrustNote inline /> {t('rm.noSort')}</div>
        </div>
      )}

      {to && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <h4 style={{ margin: '0 0 6px' }}>{t('rm.moveTo')} {statusLabel(to)}</h4>
          {needsReason && <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('rm.errReasonRequired')}</div>}
          <ReasonPicker taxonomy={taxonomy} selected={codes} onChange={setCodes} />
          <input
            style={{ width: '100%', marginTop: 6 }}
            aria-label={t('rm.note')}
            placeholder={t('rm.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.noteInternal')}</div>
        </div>
      )}

      {/* Details: who owns and leads the room, when it moved, priority, access
          and tags. One disclosure, not eight rows of chrome. */}
      <details className="room-details">
        <summary>{t('rm.details')}</summary>
        <div className="badges-meta">
          <span className="pill">{t('rm.roomLead')}: {room.leadScout?.name ?? t('rm.none')}</span>
          <span className="pill">{t('rm.owner')}: {room.owner.name ?? t('rm.none')}</span>
          <span className="pill">{t('rm.updated')}: {fmtDateTime(room.updatedAt)}</span>
          <span className="pill">{t('rm.source')}: {t(`rm.src.${room.sourceContext}`, room.sourceContext)}</span>
        </div>
        <div className="actions" style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>
            {t('rm.priority')}{' '}
            <select aria-label={t('rm.priority')} value={room.priority} onChange={(e) => patch({ priority: e.target.value }, t('rm.prioritySaved'))}>
              {ROOM_PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
            </select>
          </label>

          <label style={{ fontSize: 13 }}>
            {t('rm.roomLead')}{' '}
            <select aria-label={t('rm.roomLead')} value={room.leadScout?.userId ?? ''} onChange={(e) => patch({ leadScoutUserId: e.target.value || null }, t('rm.leadSaved'))}>
              <option value="">{t('rm.none')}</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>

          <label style={{ fontSize: 13, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={room.restricted} aria-label={t('rm.restricted')} onChange={(e) => patch({ restricted: e.target.checked }, t('rm.restrictedSaved'))} />
            {t('rm.restricted')}
          </label>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{room.priorityNote}</div>

        {room.tags.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {room.tags.map((tag) => (
              <span key={tag} className="pill">
                {tag}{' '}
                <button aria-label={`${t('rm.removeTag')} ${tag}`} style={{ padding: 0 }} onClick={() => patch({ tags: room.tags.filter((x) => x !== tag) }, t('rm.tagsSaved'))}>×</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            aria-label={t('rm.addTag')}
            placeholder={t('rm.addTag')}
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            style={{ minWidth: 160 }}
          />
          <button onClick={() => { if (tagDraft.trim()) { patch({ tags: [...room.tags, tagDraft.trim()] }, t('rm.tagsSaved')); setTagDraft(''); } }}>{t('rm.addTag')}</button>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.tagNote')}</div>
      </details>
    </div>
  );
}

/** Structured reason picker, grouped by category. Free text is never a reason
 *  code, and a protected characteristic is not in the taxonomy at all. */
function ReasonPicker({ taxonomy, selected, onChange }: { taxonomy: RoomDecisionTaxonomy | null; selected: string[]; onChange: (codes: string[]) => void }) {
  const categories = taxonomy?.categories ?? {};
  const toggle = (code: string) => onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  const keys = Object.keys(categories);
  if (keys.length === 0) return <div className="dim" style={{ fontSize: 12.5 }}>{t('rm.reasonsLoading')}</div>;
  return (
    <div aria-label={t('rm.reasons')}>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('rm.reasonsNote')}</div>
      {keys.map((cat) => (
        <div key={cat} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t(`rm.reasonCat.${cat}`, cat)}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {categories[cat].map((code) => (
              <label key={code} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={selected.includes(code)} onChange={() => toggle(code)} aria-label={reasonLabel(code)} />
                {reasonLabel(code)}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- overview
function ReadinessBlock({ readiness }: { readiness: RoomReadiness | null }) {
  if (!readiness) return <div className="dim">{t('rm.readinessUnavailable')}</div>;
  return (
    <>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>
        {t('rm.readinessCount')}: <b>{readiness.complete}</b> / {readiness.total}
      </div>
      <div className="list-rows">
        {readiness.items.map((i) => (
          <div key={i.key} className="list-row">
            <span className="grow"><b>{readinessLabel(i.key, i.label)}</b></span>
            <span className="dim">{i.value}</span>
            <span className="pill">{i.complete ? `✓ ${t('rm.done')}` : `○ ${t('rm.outstanding')}`}</span>
          </div>
        ))}
      </div>
      {readiness.blockers.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t('rm.blockers')}</div>
          <div className="list-rows">
            {readiness.blockers.map((b) => (
              <div key={b.key} className="list-row"><span className="grow">{b.text}</span></div>
            ))}
          </div>
        </div>
      )}
      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{readiness.note}</div>
    </>
  );
}

function OverviewPanel({ session, room, notify, reload, staff }: PanelProps) {
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');

  const addTask = async () => {
    if (!title.trim()) return;
    try {
      await rooms.createTask(session, room.roomId, { title: title.trim(), assigneeUserId: assignee || null });
      notify(t('rm.taskAdded'));
      setTitle(''); setAssignee('');
      reload();
    } catch (e) { notify(errMessage(e), true); }
  };

  const setTaskStatus = async (taskId: string, status: string) => {
    try { await rooms.updateTask(session, room.roomId, taskId, { status }); reload(); }
    catch (e) { notify(errMessage(e), true); }
  };

  return (
    <>
      <div className="section" aria-label={t('rm.summary')}>
        <h4>{t('rm.summary')}</h4>
        <div className="list-rows">
          <div className="list-row"><span className="grow">{t('rm.status')}</span><span className="pill">{statusLabel(room.status, room.statusLabel)}</span></div>
          <div className="list-row"><span className="grow">{t('rm.roomLead')}</span><span>{room.leadScout?.name ?? t('rm.none')}</span></div>
          <div className="list-row" title={room.trust?.note ?? t('rm.trustNote')}>
            <span className="grow">{t('rm.trustScore')}</span>
            <span><TrustValue trust={room.trust} playerAvailable={room.playerAvailable} /></span>
          </div>
          <div className="list-row"><span className="grow">{t('rm.health')}</span><span className="pill">{healthLabel(room.health, room.healthLabel)}</span></div>
          <div className="list-row"><span className="grow">{t('rm.openTasks')}</span><span>{room.tasks.filter((x) => x.status === 'open' || x.status === 'in_progress').length}</span></div>
        </div>
        <TrustNote />
      </div>

      <div className="section" aria-label={t('rm.readiness')}>
        <h4>{t('rm.readiness')}</h4>
        <ReadinessBlock readiness={room.readiness} />
      </div>

      <div className="section" aria-label={t('rm.missingEvidence')}>
        <h4>{t('rm.missingEvidence')}</h4>
        {room.missingEvidence.length === 0 && <div className="dim">{t('rm.missingNone')}</div>}
        <div className="list-rows">
          {room.missingEvidence.map((m) => (
            <div key={m.id} className="list-row" style={{ flexWrap: 'wrap' }}>
              <span className="grow">{m.explanation}</span>
              <span className="pill">{t(`rm.gap.${m.status}`, m.status.replace(/_/g, ' '))}</span>
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.requestEvidenceNote')}</div>
      </div>

      <div className="section" aria-label={t('rm.tasks')}>
        <h4>{t('rm.tasks')}</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('rm.tasksNote')}</div>
        <div className="list-rows">
          {room.tasks.map((task) => (
            <div key={task.id} className="list-row" style={{ flexWrap: 'wrap' }}>
              <span className="grow"><b>{task.title}</b>{task.description ? <span className="dim"> — {task.description}</span> : null}</span>
              <span className="dim">{task.assigneeName ?? t('rm.unassigned')}</span>
              <select aria-label={`${t('rm.taskStatus')} ${task.title}`} value={task.status} onChange={(e) => setTaskStatus(task.id, e.target.value)}>
                {ROOM_TASK_STATES.map((s) => <option key={s} value={s}>{taskStateLabel(s)}</option>)}
              </select>
            </div>
          ))}
          {room.tasks.length === 0 && <div className="dim">{t('rm.noTasks')}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <input style={{ flex: 1, minWidth: 160 }} aria-label={t('rm.taskTitle')} placeholder={t('rm.taskTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <select aria-label={t('rm.assignee')} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t('rm.unassigned')}</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="primary" onClick={addTask}>{t('rm.newTask')}</button>
        </div>
      </div>

      <div className="section" aria-label={t('rm.latestActivity')}>
        <h4>{t('rm.latestActivity')}</h4>
        <ActivityRows items={room.activity.items.slice(0, 6)} />
      </div>
    </>
  );
}

// --------------------------------------------------------------- passport
function PassportPanel({ session, room, notify }: PanelProps) {
  if (!room.playerAvailable || !room.passport) {
    return <div className="notice block">{room.unavailableNote ?? t('rm.unavailable')}</div>;
  }
  return (
    <div className="section" aria-label={t('rm.tab.passport')}>
      <h4>🛂 {t('rm.tab.passport')}</h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('rm.passportNote')}</div>
      <PassportBody session={session} p={room.passport} notify={notify} />
    </div>
  );
}

// --------------------------------------------------------------- evidence
function EvidencePanel({ session, room, notify, reload }: PanelProps) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!room.playerAvailable) return <div className="notice block">{room.unavailableNote ?? t('rm.unavailable')}</div>;

  const review = async (evidenceId: string, state: string) => {
    try {
      await rooms.reviewEvidence(session, room.roomId, evidenceId, { state, note: notes[evidenceId]?.trim() || null });
      notify(t('rm.reviewSaved'));
      reload();
    } catch (e) { notify(errMessage(e), true); }
  };

  const request = async (suggestionId: string) => {
    try {
      const r = await rooms.requestEvidence(session, room.roomId, suggestionId);
      notify(`${t('rm.evidenceRequested')} — ${t(`rm.routed.${r.routedTo}`, r.routedTo)}`);
      reload();
    } catch (e) { notify(errMessage(e), true); }
  };

  return (
    <>
      <div className="section" aria-label={t('rm.tab.evidence')}>
        <h4>{t('rm.tab.evidence')}</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('rm.evidenceNote')}</div>
        {room.evidence.length === 0 && <div className="dim">{t('rm.noEvidence')}</div>}
        <div className="list-rows">
          {room.evidence.map((e) => (
            <div key={e.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="grow"><b>{e.label ?? e.title ?? e.claimType ?? e.id}</b>{e.recordedAt ? <span className="dim"> · {fmtDate(e.recordedAt)}</span> : null}</span>
                {e.provenance
                  ? <ProvPill provenance={e.provenance} copy={e.provenanceCopy} />
                  : <span className="pill">{t('rm.provUnknown')}</span>}
                <span className="pill">{t('rm.review')}: {reviewStateLabel(e.review.state)}</span>
              </div>
              {e.provenanceCopy && <div className="dim" style={{ fontSize: 11.5 }}>{e.provenanceCopy}</div>}
              {e.review.note && <div className="dim" style={{ fontSize: 12.5 }}>“{e.review.note}” — {e.review.by}{e.review.at ? ` · ${fmtDate(e.review.at)}` : ''}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <input
                  style={{ flex: 1, minWidth: 140 }}
                  aria-label={`${t('rm.reviewNotePlaceholder')} ${e.id}`}
                  placeholder={t('rm.reviewNotePlaceholder')}
                  value={notes[e.id] ?? ''}
                  onChange={(ev) => setNotes({ ...notes, [e.id]: ev.target.value })}
                />
                <select aria-label={`${t('rm.review')} ${e.id}`} value={e.review.state} onChange={(ev) => review(e.id, ev.target.value)}>
                  {ROOM_EVIDENCE_REVIEW_STATES.map((s) => <option key={s} value={s}>{reviewStateLabel(s)}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.reviewNote')}</div>
      </div>

      <div className="section" aria-label={t('rm.missingEvidence')}>
        <h4>{t('rm.missingEvidence')}</h4>
        {room.missingEvidence.length === 0 && <div className="dim">{t('rm.missingNone')}</div>}
        <div className="list-rows">
          {room.missingEvidence.map((m) => (
            <div key={m.id} className="list-row" style={{ flexWrap: 'wrap' }}>
              <span className="grow">{m.explanation} <span className="dim">({m.ruleId} v{m.ruleVersion})</span></span>
              <span className="pill">{t(`rm.gap.${m.status}`, m.status.replace(/_/g, ' '))}</span>
              {m.status === 'open' && <button onClick={() => request(m.id)}>{t('rm.requestEvidence')}</button>}
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.requestEvidenceNote')}</div>
      </div>
    </>
  );
}

// ------------------------------------------------------------ assessments
function AssessmentsPanel({ session, room, notify, reload, staff }: PanelProps) {
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState('');

  if (!room.playerAvailable) return <div className="notice block">{room.unavailableNote ?? t('rm.unavailable')}</div>;

  const assign = async () => {
    if (!userId) return;
    try {
      await rooms.assignAssessment(session, room.roomId, { userId, kind: kind.trim() || undefined });
      notify(t('rm.assessmentAssigned'));
      setUserId(''); setKind('');
      reload();
    } catch (e) { notify(errMessage(e), true); }
  };

  const withheld = room.assessmentsWithheldPendingOwnSubmission ?? 0;

  return (
    <div className="section" aria-label={t('rm.tab.assessments')}>
      <h4>{t('rm.tab.assessments')}</h4>
      {withheld > 0 && <div className="notice block" style={{ marginBottom: 8 }}>{withheld} {t('rm.assessWithheld')}</div>}
      {room.assessments.length === 0 && <div className="dim">{t('rm.noAssessments')}</div>}
      <div className="list-rows">
        {room.assessments.map((a) => (
          <div key={a.id} className="list-row" style={{ flexWrap: 'wrap' }}>
            <span className="grow"><b>{a.scoutName}</b>{a.context ? <span className="dim"> · {a.context}</span> : null}</span>
            <span className="pill">{t(`rm.assess.${a.state}`, a.state.replace(/_/g, ' '))}</span>
            {a.recommendation && <span className="pill blue">{t(`rm.rec.${a.recommendation}`, a.recommendation.replace(/_/g, ' '))}</span>}
            <span className="dim">{a.submittedAt ? fmtDate(a.submittedAt) : fmtDate(a.createdAt)}</span>
          </div>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.assessNote')}</div>

      <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <h4 style={{ margin: '0 0 6px' }}>{t('rm.assignAssessment')}</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select aria-label={t('rm.assignee')} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('rm.pick')}</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <input style={{ minWidth: 160 }} aria-label={t('rm.assessmentKind')} placeholder={t('rm.assessmentKind')} value={kind} onChange={(e) => setKind(e.target.value)} />
          <button className="primary" onClick={assign}>{t('rm.assignAssessment')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- combine
function RoomCombinePanel({ session, room, notify, reload }: PanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(['combine-box-control-60']));
  const [title, setTitle] = useState('');

  if (!room.playerAvailable) return <div className="notice block">{room.unavailableNote ?? t('rm.unavailable')}</div>;

  const combine = room.combine;
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const request = async () => {
    const protocolIds = [...selected];
    if (!protocolIds.length) { notify(t('rm.combineNeedProtocols'), true); return; }
    try {
      await rooms.requestCombine(session, room.roomId, { protocolIds, title: title.trim() || null });
      notify(t('rm.combineRequested'));
      setTitle('');
      reload();
    } catch (e) { notify(errMessage(e), true); }
  };

  return (
    <div className="section" aria-label={t('rm.tab.combine')}>
      <h4>{t('rm.tab.combine')}</h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('rm.combineNote')}</div>

      {combine && combine.shared ? (
        combine.results.length > 0 ? (
          <div className="list-rows">
            {combine.results.map((r) => (
              <div key={`${r.protocolId}-${r.completedAt}`} className="list-row" style={{ flexWrap: 'wrap' }}>
                <span className="grow"><b>{r.protocolTitle}</b></span>
                <span><b>{r.display}</b> <span className="dim">{r.metricUnit}</span></span>
                {r.combineVerified && <span className="pill green">✓ {t('rm.combineVerified')}</span>}
                <span className="dim">{fmtDate(r.completedAt)}</span>
              </div>
            ))}
          </div>
        ) : <div className="dim">{t('rm.combineNoResults')}</div>
      ) : <div className="dim">{combine?.note ?? t('rm.combineNotShared')}</div>}
      {combine?.shared && combine.note && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{combine.note}</div>}
      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.combineBlank')}</div>

      <div style={{ marginTop: 10 }}>
        <h4 style={{ margin: '0 0 6px' }}>{t('rm.combineRequests')}</h4>
        {(combine?.requests ?? []).length === 0 && <div className="dim">{t('rm.combineNoRequests')}</div>}
        <div className="list-rows">
          {(combine?.requests ?? []).map((r) => (
            <div key={r.id} className="list-row" style={{ flexWrap: 'wrap' }}>
              <span className="grow"><b>{r.title || t('rm.tab.combine')}</b> <span className="dim">{r.protocols.map((p) => p.protocolTitle).join(', ')}</span></span>
              <span className="pill">{r.completedCount}/{r.requiredCount}</span>
              <span className="pill">{t(`rm.creq.${r.state}`, r.state)}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <h4 style={{ margin: '0 0 6px' }}>{t('rm.requestCombine')}</h4>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          {STANDARD_PROTOCOLS.map((p) => (
            <label key={p.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={p.title} />
              {p.title}{!p.productionSupported && <span className="dim" title={t('rm.combineUnsupported')}> ⓘ</span>}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input style={{ flex: 1, minWidth: 160 }} aria-label={t('rm.combineTitle')} placeholder={t('rm.combineTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className="primary" onClick={request}>{t('rm.requestCombine')}</button>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.combineUnsupported')}</div>
        <div className="dim" style={{ fontSize: 12 }}>{t('rm.combineRequestNote')}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ development
function DevelopmentPanel({ room }: PanelProps) {
  if (!room.playerAvailable) return <div className="notice block">{room.unavailableNote ?? t('rm.unavailable')}</div>;
  const d = room.development;
  const minutes = d?.verifiedActiveMs != null ? Math.round(d.verifiedActiveMs / 60000) : null;
  return (
    <div className="section" aria-label={t('rm.tab.development')}>
      <h4>{t('rm.tab.development')}</h4>
      {!d || d.shared === false ? (
        <div className="dim">{d?.note ?? t('rm.devNotShared')}</div>
      ) : (
        <>
          <div className="stat-grid" aria-label={t('rm.devStats')}>
            <div className="stat"><div className="v">{d.boxSessions ?? '—'}</div><div className="k">{t('rm.devSessions')}</div></div>
            <div className="stat"><div className="v">{minutes ?? '—'}</div><div className="k">{t('rm.devMinutes')}</div></div>
            <div className="stat"><div className="v">{d.assignedCompleted ?? '—'}/{d.assigned ?? '—'}</div><div className="k">{t('rm.devAssigned')}</div></div>
            <div className="stat"><div className="v">{d.days ?? '—'}</div><div className="k">{t('rm.devWindow')}</div></div>
          </div>
          {(d.focus ?? []).length > 0 && (
            <div className="list-rows" style={{ marginTop: 8 }}>
              {(d.focus ?? []).map((f) => (
                <div key={f.category} className="list-row">
                  <span className="grow">{t(`rm.devCat.${f.category}`, f.category.replace(/_/g, ' '))}</span>
                  <span className="dim">{Math.round(f.activeMs / 60000)} {t('rm.devMinutesShort')}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{d?.note ?? t('rm.devNote')}</div>
    </div>
  );
}

// ------------------------------------------------------------- discussion
function CommentRow({
  c, session, room, notify, reload, depth,
}: { c: RoomComment; session: Session; room: Room; notify: PanelProps['notify']; reload: () => void; depth: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body ?? '');
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const mine = c.author.userId === session.userId;

  const save = async () => {
    try { await rooms.editComment(session, room.roomId, c.id, draft); notify(t('rm.commentEdited')); setEditing(false); reload(); }
    catch (e) { notify(errMessage(e), true); }
  };
  const remove = async () => {
    if (!confirmDestructive(DESTRUCTIVE_ACTIONS.deleteComment)) return;
    try { await rooms.deleteComment(session, room.roomId, c.id); notify(t('rm.commentDeleted')); reload(); }
    catch (e) { notify(errMessage(e), true); }
  };
  const postReply = async () => {
    if (!reply.trim()) return;
    try { await rooms.addComment(session, room.roomId, { body: reply.trim(), replyToId: c.id }); setReply(''); setReplying(false); reload(); }
    catch (e) { notify(errMessage(e), true); }
  };

  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', marginLeft: depth * 18 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span className="grow"><b>{c.author.name}</b> <span className="dim">{fmtDateTime(c.createdAt)}</span></span>
        {c.edited && <span className="pill">{t('rm.edited')}</span>}
        {c.deleted && <span className="pill">{t('rm.deletedPill')}</span>}
      </div>
      {c.deleted
        ? <div className="dim" style={{ fontStyle: 'italic' }}>{t('rm.deleted')}</div>
        : editing
          ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              <input style={{ flex: 1, minWidth: 160 }} aria-label={t('rm.edit')} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button className="primary" onClick={save}>{t('common.save')}</button>
              <button onClick={() => { setEditing(false); setDraft(c.body ?? ''); }}>{t('common.cancel')}</button>
            </div>
          )
          : <div style={{ fontSize: 13.5, marginTop: 2 }}>{c.body}</div>}
      {c.mentions.length > 0 && (
        <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
          {t('rm.mentioned')}: {c.mentions.map((m) => `@${m.name}`).join(', ')}
        </div>
      )}
      {!c.deleted && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          <button onClick={() => setReplying((x) => !x)}>{t('rm.reply')}</button>
          {mine && !editing && <button onClick={() => setEditing(true)}>{t('rm.edit')}</button>}
          {mine && <button onClick={remove}>{t('rm.delete')}</button>}
        </div>
      )}
      {replying && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <input style={{ flex: 1, minWidth: 160 }} aria-label={t('rm.reply')} placeholder={t('rm.replyPlaceholder')} value={reply} onChange={(e) => setReply(e.target.value)} />
          <button className="primary" onClick={postReply}>{t('rm.post')}</button>
        </div>
      )}
    </div>
  );
}

function DiscussionPanel({ session, room, notify, reload, staff }: PanelProps) {
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);

  const post = async () => {
    if (!body.trim()) return;
    try {
      await rooms.addComment(session, room.roomId, { body: body.trim(), mentions });
      notify(t('rm.commentPosted'));
      setBody(''); setMentions([]);
      reload();
    } catch (e) { notify(errMessage(e), true); }
  };

  // Threading: a reply renders directly under its parent, one level deep.
  const roots = room.comments.filter((c) => !c.replyToId).sort((a, b) => b.createdAt - a.createdAt);
  const repliesOf = (id: string) => room.comments.filter((c) => c.replyToId === id).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="section" aria-label={t('rm.tab.discussion')}>
      <h4>{t('rm.tab.discussion')}</h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('rm.discussionNote')}</div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <input style={{ flex: 1, minWidth: 180 }} aria-label={t('rm.comment')} placeholder={t('rm.comment')} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') post(); }} />
        <button className="primary" onClick={post}>{t('rm.post')}</button>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="dim" style={{ fontSize: 12.5 }}>{t('rm.mention')}:</span>
        {staff.map((u) => (
          <label key={u.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              aria-label={`${t('rm.mention')} ${u.name}`}
              checked={mentions.includes(u.id)}
              onChange={() => setMentions((prev) => (prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id]))}
            />
            @{u.name}
          </label>
        ))}
        {staff.length === 0 && <span className="dim" style={{ fontSize: 12.5 }}>{t('rm.noStaff')}</span>}
      </div>

      {room.comments.length === 0 && <div className="dim">{t('rm.noComments')}</div>}
      <div className="list-rows">
        {roots.map((c) => (
          <div key={c.id}>
            <CommentRow c={c} session={session} room={room} notify={notify} reload={reload} depth={0} />
            {repliesOf(c.id).map((r) => (
              <CommentRow key={r.id} c={r} session={session} room={room} notify={notify} reload={reload} depth={1} />
            ))}
          </div>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.commentTombstoneNote')}</div>
    </div>
  );
}

// ---------------------------------------------------------------- activity
function ActivityRows({ items }: { items: RoomActivityItem[] }) {
  if (items.length === 0) return <div className="dim">{t('rm.noActivity')}</div>;
  return (
    <div className="list-rows">
      {items.map((a) => (
        <div key={a.id} className="list-row" style={{ flexWrap: 'wrap' }}>
          <span className="dim" style={{ minWidth: 120 }}>{fmtDateTime(a.at)}</span>
          <span className="grow">{activityLabel(a.type)}</span>
          <span className="dim">{a.actor?.name ?? t('rm.system')}</span>
        </div>
      ))}
    </div>
  );
}

function ActivityPanel({ session, room, journey }: PanelProps) {
  const [items, setItems] = useState<RoomActivityItem[]>(room.activity.items);
  const [cursor, setCursor] = useState<string | null>(room.activity.nextCursor);
  const [total, setTotal] = useState(room.activity.total);

  const more = async () => {
    try {
      const r = await rooms.activity(session, room.roomId, { cursor });
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
      setTotal(r.total);
    } catch { /* the timeline stays as it is */ }
  };

  return (
    <div className="section" aria-label={t('rm.tab.activity')}>
      <h4>{t('rm.tab.activity')} <span className="dim" style={{ fontSize: 12.5 }}>({total})</span></h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('rm.activityNote')}</div>
      <ActivityRows items={items} />
      {cursor && <button style={{ marginTop: 8 }} onClick={more}>{t('rm.more')}</button>}
      {journey ? <JourneyTimeline journey={journey} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- decision
function DecisionRow({ d, currentScore }: { d: RoomDecision; currentScore: number | null }) {
  const snapScore = d.snapshot?.trust?.score ?? null;
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span className="grow"><b>{recommendationLabel(d.recommendation)}</b> <span className="dim">· {d.by.name}{d.by.role ? ` (${d.by.role})` : ''} · {fmtDateTime(d.createdAt)}</span></span>
        {d.supersededById && <span className="pill">{t('rm.superseded')}</span>}
      </div>
      {d.reasonCodes.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {d.reasonCodes.map((c) => <span key={c} className="pill">{reasonLabel(c)}</span>)}
        </div>
      )}
      {d.note && <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>“{d.note}”</div>}
      {snapScore != null && (
        <div style={{ fontSize: 12.5, marginTop: 4 }} title={t('rm.trustNote')}>
          <b>{t('rm.trustAtDecision')}: {snapScore}</b>
          {currentScore != null && <span className="dim"> · {t('rm.trustCurrent')}: {currentScore}</span>}
          <TrustNote inline />
        </div>
      )}
      {d.snapshot?.note && <div className="dim" style={{ fontSize: 11.5 }}>{d.snapshot.note}</div>}
    </div>
  );
}

function DecisionPanel({ session, room, notify, reload }: PanelProps) {
  const [taxonomy, setTaxonomy] = useState<RoomDecisionTaxonomy | null>(null);
  const [recommendation, setRecommendation] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const clientKey = useMemo(() => `rm-${room.roomId}-${Date.now()}`, [room.roomId]);

  useEffect(() => {
    let live = true;
    rooms.decisions(session, room.roomId).then((d) => { if (live) setTaxonomy(d.taxonomy); }).catch(() => { /* picker falls back */ });
    return () => { live = false; };
  }, [session, room.roomId]);

  const current = room.decision.current;
  const history = room.decision.history.slice().sort((a, b) => b.createdAt - a.createdAt);
  const recommendations = taxonomy?.recommendations ?? [];

  const [decisionConflict, setDecisionConflict] = useState<Conflict | null>(null);
  const record = async () => {
    if (!recommendation) return;
    setBusy(true);
    setDecisionConflict(null);
    try {
      await rooms.recordDecision(session, room.roomId, { recommendation, reasonCodes: codes, note: note.trim() || null, clientKey, expectedRev: room.rev });
      notify(t('rm.decisionRecorded'));
      setRecommendation(''); setCodes([]); setNote('');
      reload();
    } catch (e) {
      const c = conflictOf(e);
      if (c) setDecisionConflict(c); else notify(errMessage(e), true);
    }
    finally { setBusy(false); }
  };

  return (
    <>
      <DecisionWorkflow session={session} room={room} notify={notify} reload={reload} />

      <div className="section" aria-label={t('rm.currentDecision')}>
        <h4>{t('rm.currentDecision')}</h4>
      {decisionConflict && <ConflictNotice conflict={decisionConflict} onReload={() => { setDecisionConflict(null); reload(); }} onKeepChanges={() => setDecisionConflict(null)} />}
        {current
          ? <div className="list-rows"><DecisionRow d={current} currentScore={room.trust?.score ?? null} /></div>
          : <div className="dim">{t('rm.noDecision')}</div>}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.decisionHuman')}</div>
      </div>

      <div className="section" aria-label={t('rm.readiness')}>
        <h4>{t('rm.readiness')}</h4>
        <ReadinessBlock readiness={room.readiness} />
      </div>

      <div className="section" aria-label={t('rm.recordDecision')}>
        <h4>{t('rm.recordDecision')}</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <label style={{ fontSize: 13 }}>
            {t('rm.recommendation')}{' '}
            <select aria-label={t('rm.recommendation')} value={recommendation} onChange={(e) => setRecommendation(e.target.value)}>
              <option value="">{t('rm.pick')}</option>
              {recommendations.map((r) => <option key={r} value={r}>{recommendationLabel(r)}</option>)}
            </select>
          </label>
        </div>
        <ReasonPicker taxonomy={taxonomy} selected={codes} onChange={setCodes} />
        <input style={{ width: '100%', marginTop: 8 }} aria-label={t('rm.note')} placeholder={t('rm.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('rm.noteInternal')}</div>
        <button className="primary" style={{ marginTop: 8 }} disabled={!recommendation || busy} onClick={record}>{t('rm.recordDecision')}</button>
      </div>

      <div className="section" aria-label={t('rm.history')}>
        <h4>{t('rm.history')}</h4>
        {history.length === 0 && <div className="dim">{t('rm.noDecision')}</div>}
        <div className="list-rows">
          {history.map((d) => <DecisionRow key={d.id} d={d} currentScore={room.trust?.score ?? null} />)}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.decisionAppendOnly')}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- contact (M23 P3)
//
// A page-local tab inside the Room: Contact is a FUNCTION of the case, not a
// destination. Everything the recipient will read is written here and is
// visibly separate from Discussion, which never travels with it. A draft is
// shown as a draft; "Delivered" means "in their ScoutBox Inbox" and the note
// beside it says exactly that; a failed send keeps the draft; a recorded call
// says who recorded it.
const contactStatusLabel = (code: string, fallback?: string | null) => t(`ct.st.${code}`, fallback ?? code.replace(/_/g, ' '));
const contactChannelLabel = (code: string, fallback?: string | null) => t(`ct.ch.${code}`, fallback ?? code.replace(/_/g, ' '));
const contactEventLabel = (code: string) => t(`ct.ev.${code}`, code.replace(/^contact_/, '').replace(/_/g, ' '));

function contactErrMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const specific = t(`ct.err.${e.code}`, '');
    if (specific) return specific;
    if (/VERSION_CONFLICT$/.test(e.code)) return t('common.conflict');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

function ContactRow({ c, canWrite, busy, onEdit, onSend, onCancel }: {
  c: ContactRecord; canWrite: boolean; busy: boolean;
  onEdit: (c: ContactRecord) => void; onSend: (c: ContactRecord) => void; onCancel: (c: ContactRecord) => void;
}) {
  const editable = canWrite && (c.status === 'draft' || c.status === 'failed');
  const tone = c.status === 'delivered' || c.status === 'responded' || c.status === 'recorded' ? 'blue' : c.status === 'failed' ? 'gold' : '';
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-contact-id={c.id} data-contact-status={c.status}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className={`pill ${tone}`.trim()}>{contactStatusLabel(c.status, c.statusLabel)}</span>
        <span className="pill">{contactChannelLabel(c.channel, c.channelLabel)}</span>
        {c.recipient && <span className="pill">{c.recipient.type === 'guardian' ? t('ct.toGuardian') : t('ct.toPlayer')}</span>}
        <span className="dim grow" style={{ fontSize: 12.5 }}>{fmtDateTime(c.status === 'recorded' ? (c.occurredAt ?? c.createdAt) : c.createdAt)}</span>
      </div>
      {c.subject && <b style={{ marginTop: 4 }}>{c.subject}</b>}
      {c.body && <div style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
      {c.summary && <div className="dim" style={{ marginTop: 2, fontSize: 13 }}>“{c.summary}”</div>}
      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
        {c.status === 'draft' && t('ct.draftNote')}
        {c.status === 'delivered' && `${t('ct.deliveredNote')} · ${c.sentBy?.name ?? ''} · ${fmtDateTime(c.deliveredAt ?? c.createdAt)}`}
        {c.status === 'responded' && `${t('ct.deliveredNote')} · ${c.sentBy?.name ?? ''} · ${fmtDateTime(c.deliveredAt ?? c.createdAt)}`}
        {c.status === 'failed' && `${t('ct.failedNote')} (${c.attempts} ${t('ct.attempts')})`}
        {c.status === 'recorded' && `${t('ct.recordedNote')} ${c.recordedBy?.name ?? ''} · ${fmtDateTime(c.recordedAt ?? c.createdAt)}`}
        {c.status === 'cancelled' && t('ct.cancelledNote')}
      </div>
      {c.emailCopy && <div className="dim" style={{ fontSize: 12 }}>{t(`ct.emailCopy.${c.emailCopy.state}`, c.emailCopy.state)}</div>}
      {c.lifecycle?.applied && <div className="dim" style={{ fontSize: 12 }}>{t('ct.caseMoved')}</div>}
      {c.response && (
        <div className="notice block" style={{ marginTop: 6 }} aria-label={t('ct.response')}>
          <b>{t('ct.response')}:</b>{' '}
          <span className={`pill ${c.response.kind === 'accepted' ? 'blue' : ''}`.trim()}>{t(`ct.resp.${c.response.kind}`, c.response.kind)}</span>{' '}
          <span className="dim">{t(`ct.by.${c.response.by}`, c.response.by)} · {fmtDateTime(c.response.at)}</span>
          {c.response.message && <div style={{ marginTop: 4 }}>“{c.response.message}”</div>}
        </div>
      )}
      {editable && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <button className="primary" disabled={busy} onClick={() => onSend(c)}>{t('ct.send')}</button>
          <button disabled={busy} onClick={() => onEdit(c)}>{t('ct.edit')}</button>
          <button disabled={busy} onClick={() => onCancel(c)}>{t('ct.cancel')}</button>
        </div>
      )}
      <details style={{ marginTop: 4 }}>
        <summary className="dim" style={{ fontSize: 12, cursor: 'pointer' }}>{t('ct.timeline')} ({c.history.length})</summary>
        <div className="list-rows">
          {c.history.map((h) => (
            <div key={h.id} className="list-row" style={{ fontSize: 12.5 }}>
              <span className="dim" style={{ minWidth: 120 }}>{fmtDateTime(h.at)}</span>
              <span className="grow">{contactEventLabel(h.action)}</span>
              <span className="dim">{h.by?.name ?? ''}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ContactPanel({ session, room, notify, reload }: PanelProps) {
  const [data, setData] = useState<ContactList | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [subject, setSubject] = useState('');
  /**
   * M23 P5.6E — the routing the club asks for. `player_only` is the default and
   * is always available; `both` asks that the client's own agent be a party as
   * well. There is no third option, and the server decides again at send time.
   */
  const [mode, setMode] = useState<'player_only' | 'both'>('player_only');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<ContactRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [live, setLive] = useState('');
  const [channel, setChannel] = useState('phone');
  const [occurredAt, setOccurredAt] = useState('');
  const [summary, setSummary] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // One key per compose session, so a retried save or send is the same request.
  const createKey = useMemo(() => `ct-${room.roomId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, [room.roomId, bump]);

  const refresh = useCallback(() => setBump((b) => b + 1), []);
  useEffect(() => {
    let on = true;
    setLoadErr(null);
    rooms.contacts(session, room.roomId).then((d) => { if (on) setData(d); }).catch((e) => { if (on) setLoadErr(contactErrMessage(e)); });
    return () => { on = false; };
  }, [session, room.roomId, room.rev, bump]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setConflict(null);
    try { const msg = await fn(); setLive(msg); notify(msg); refresh(); reload(); }
    catch (e) { const c = conflictOf(e); if (c) setConflict(c); else { const m = contactErrMessage(e); setLive(m); notify(m, true); } }
    finally { setBusy(false); }
  };
  const clearCompose = () => { setEditing(null); setSubject(''); setBody(''); };
  const moveText = (moved: ContactCaseMove | undefined) => (moved && 'to' in moved ? ` ${t('ct.caseMoved')}` : '');

  const saveDraft = () => run(async () => {
    if (editing) { await rooms.patchContact(session, room.roomId, editing.id, { subject: subject.trim() || null, body: body.trim(), contactMode: mode, expectedRev: editing.rev }); clearCompose(); return t('ct.updated'); }
    await rooms.createContact(session, room.roomId, { subject: subject.trim() || null, body: body.trim(), contactMode: mode, clientKey: createKey });
    clearCompose();
    return t('ct.drafted');
  });
  const sendNow = () => run(async () => {
    const c = editing
      ? (await rooms.patchContact(session, room.roomId, editing.id, { subject: subject.trim() || null, body: body.trim(), contactMode: mode, expectedRev: editing.rev })).contact
      : (await rooms.createContact(session, room.roomId, { subject: subject.trim() || null, body: body.trim(), contactMode: mode, clientKey: createKey })).contact;
    const r = await rooms.sendContact(session, room.roomId, c.id, { expectedRev: c.rev, clientKey: `${createKey}-send` });
    clearCompose();
    return r.delivered ? `${t('ct.sent')}${moveText(r.case)}` : t('ct.sendFailed');
  });
  const sendExisting = (c: ContactRecord) => run(async () => {
    const r = await rooms.sendContact(session, room.roomId, c.id, { expectedRev: c.rev, clientKey: `ct-send-${c.id}-${c.rev}` });
    return r.delivered ? `${t('ct.sent')}${moveText(r.case)}` : t('ct.sendFailed');
  });
  const cancelDraft = (c: ContactRecord) => run(async () => { await rooms.cancelContact(session, room.roomId, c.id, { expectedRev: c.rev }); if (editing?.id === c.id) clearCompose(); return t('ct.cancelled'); });
  const startEdit = (c: ContactRecord) => { setEditing(c); setSubject(c.subject ?? ''); setBody(c.body ?? ''); };
  const recordExternal = () => run(async () => {
    const ts = new Date(occurredAt).getTime();
    if (!occurredAt || !Number.isFinite(ts)) throw new ApiError(400, 'CONTACT_OCCURRED_AT_INVALID', t('ct.err.CONTACT_OCCURRED_AT_INVALID'));
    const r = await rooms.recordExternalContact(session, room.roomId, {
      channel, occurredAt: ts, summary: summary.trim() || null,
      recipientType: data?.routing.type === 'guardian' ? 'guardian' : 'player',
      clientKey: `ct-ext-${room.roomId}-${channel}-${ts}`,
    });
    setSummary(''); setOccurredAt(''); setConfirmed(false);
    return `${t('ct.recorded')}${moveText(r.case)}`;
  });

  if (loadErr) return <div className="section" aria-label={t('ct.title')}><LoadError message={loadErr} onRetry={refresh} /></div>;
  if (!data) return <div className="section" aria-label={t('ct.title')}><div className="dim">{t('rm.loading')}</div></div>;

  const routing = data.routing;
  const canCompose = data.canWrite && data.case.acceptsContact && routing.available;
  const spokeTo = routing.type === 'guardian' ? t('ct.spokeToGuardian') : t('ct.spokeToPlayer');

  return (
    <>
      <div className="section" aria-label={t('ct.title')}>
        <h4>{t('ct.title')}</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('ct.intro')}</div>

        {/* Routing: who this WOULD reach, decided by the server now — never by this screen. */}
        <div className="badges" style={{ marginBottom: 8 }} aria-label={t('ct.routingLabel')} data-testid="ct-routing" data-agent-party={routing.agentParty ? '1' : '0'}>
          {routing.available
            ? <span className={`pill ${routing.type === 'guardian' ? 'gold' : 'blue'}`}>{routing.type === 'guardian' ? t('ct.routeGuardian') : t('ct.routePlayer')}</span>
            : <span className="pill">{t('ct.routeUnavailable')}{routing.reason ? ` — ${t(`ct.reason.${routing.reason}`, '')}` : ''}</span>}
          {/*
            M23 P5.6E §21. The client's own agent as a SECOND party, never a
            replacement. When the club asked and the answer was no, the rule that
            refused is named as a code — the club learns what it may do, not
            facts about the player it has not been given.
          */}
          {routing.available && routing.agentParty && <span className="pill blue" data-testid="ct-agent-party">{t('ct.agentParty')}</span>}
          {routing.available && !routing.agentParty && routing.agentRefusal && (
            <span className="pill" data-testid="ct-agent-refused" data-code={routing.agentRefusal}>{t(`ct.agentRefusal.${routing.agentRefusal}`, t('ct.agentRefusal.default'))}</span>
          )}
        </div>
        {/*
          The mode the club ASKS for. Whether it is honoured is re-derived when
          the message is sent, so a stale screen cannot route anybody: asking is
          not permission, and there is deliberately no option that reaches the
          agent INSTEAD of the player.
        */}
        {data.canWrite && routing.available && !routing.minor && (
          <fieldset className="room-fieldset" style={{ marginBottom: 8 }} data-testid="ct-mode">
            <legend style={{ fontSize: 12.5 }}>{t('ct.modeLegend')}</legend>
            {(routing.modes ?? ['player_only', 'both']).map((m) => (
              <label key={m} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, marginRight: 14 }}>
                <input
                  type="radio"
                  name="contact-mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  data-testid={`ct-mode-${m}`}
                  aria-label={t(`ct.mode.${m}`)}
                />
                {t(`ct.mode.${m}`)}
              </label>
            ))}
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('ct.modeNote')}</div>
          </fieldset>
        )}

        {!data.case.acceptsContact && (
          <div className="notice block" role="status" style={{ marginBottom: 8 }}>
            {t('ct.caseGate')} <span className="dim">({t('rm.status')}: {statusLabel(data.case.status)})</span>
          </div>
        )}
        {data.cooldown && (
          <div className="notice block" role="status" style={{ marginBottom: 8 }}>{t('ct.cooldown')} {fmtDateTime(data.cooldown.until)}.</div>
        )}
        {!data.canWrite && <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('ct.readOnly')}</div>}
        {conflict && <ConflictNotice conflict={conflict} onReload={() => { setConflict(null); refresh(); }} onKeepChanges={() => setConflict(null)} />}

        {data.canWrite && (
          <form onSubmit={(e) => { e.preventDefault(); saveDraft(); }} aria-label={editing ? t('ct.editing') : t('ct.compose')}>
            {editing && <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('ct.editing')} · <button type="button" onClick={clearCompose}>{t('ct.discardEdit')}</button></div>}
            <label style={{ display: 'block', fontSize: 13 }}>
              {t('ct.subject')}
              <input style={{ width: '100%', marginTop: 2 }} aria-label={t('ct.subject')} maxLength={data.limits.subject} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canCompose && !editing} />
            </label>
            <label style={{ display: 'block', fontSize: 13, marginTop: 6 }}>
              {t('ct.body')}
              <textarea style={{ width: '100%', minHeight: 90, marginTop: 2 }} aria-label={t('ct.body')} maxLength={data.limits.body} value={body} onChange={(e) => setBody(e.target.value)} disabled={!canCompose && !editing} />
            </label>
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('ct.sharedNote')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button type="submit" disabled={busy || !body.trim() || (!canCompose && !editing)}>{editing ? t('ct.update') : t('ct.saveDraft')}</button>
              <button type="button" className="primary" disabled={busy || !body.trim() || !canCompose} onClick={sendNow}>{t('ct.sendNow')}</button>
            </div>
          </form>
        )}

        {data.canWrite && (
          <details className="room-details" style={{ marginTop: 10 }}>
            <summary>{t('ct.external')}</summary>
            <div className="dim" style={{ fontSize: 12.5, margin: '6px 0' }}>{t('ct.externalNote')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 13 }}>
                {t('ct.channel')}<br />
                <select aria-label={t('ct.channel')} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {data.channels.external.map((ch) => <option key={ch.id} value={ch.id}>{contactChannelLabel(ch.id, ch.label)}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                {t('ct.occurredAt')}<br />
                <input type="datetime-local" aria-label={t('ct.occurredAt')} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
              </label>
            </div>
            <input style={{ width: '100%', marginTop: 6 }} aria-label={t('ct.summary')} placeholder={t('ct.summary')} maxLength={data.limits.summary} value={summary} onChange={(e) => setSummary(e.target.value)} />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginTop: 6 }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} aria-label={`${t('ct.spokeTo')} ${spokeTo}`} />
              {t('ct.spokeTo')} <b>{spokeTo}</b> {t('ct.spokeToConfirm')}
            </label>
            <button style={{ marginTop: 8 }} disabled={busy || !confirmed || !occurredAt || !canCompose} onClick={recordExternal}>{t('ct.record')}</button>
          </details>
        )}
        <div role="status" aria-live="polite" className="dim" style={{ fontSize: 12.5, marginTop: 8, minHeight: 16 }}>{live}</div>
      </div>

      <div className="section" aria-label={t('ct.history')}>
        <h4>{t('ct.history')} <span className="dim" style={{ fontSize: 12.5 }}>({data.items.length})</span></h4>
        {data.items.length === 0 && <div className="dim">{t('ct.none')}</div>}
        <div className="list-rows">
          {data.items.slice().reverse().map((c) => (
            <ContactRow key={c.id} c={c} canWrite={data.canWrite} busy={busy} onEdit={startEdit} onSend={sendExisting} onCancel={cancelDraft} />
          ))}
        </div>
        {data.omitted > 0 && <div className="notice block" style={{ marginTop: 6 }}>{data.omitted} {t('ct.omitted')}</div>}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('ct.historyNote')}</div>
      </div>
    </>
  );
}
