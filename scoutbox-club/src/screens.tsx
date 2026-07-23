import { useEffect, useState, type ReactNode } from 'react';
import {
  api, ApiError,
  type Session, type Player, type PlayerDetail, type OrgRequest, type Trial,
  type LedgerEntry, type ProofPack, type PlanInfo, type Reputation, type SearchFilters,
} from './api';

interface ScreenProps {
  session: Session;
  tick: number;
  notify: (text: string, error?: boolean) => void;
  openPlayer: (id: string) => void;
}

const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'];

const AVAILABILITY_LABELS: Record<string, string> = {
  available_now: 'Available now',
  end_of_season: 'End of season',
  loan_open: 'Open to loan',
  overseas_open: 'Open to overseas',
  not_seeking: 'Not seeking',
};

const CONTRACT_LABELS: Record<string, string> = {
  under_contract: 'Under contract',
  expiring_summer: 'Contract expiring',
  scholarship_ending: 'Scholarship ending',
  release_approaching: 'Release approaching',
  free_agent: 'Free agent',
  unknown: '—',
};

export function Toast({ text, error }: { text: string; error?: boolean }) {
  return <div className={`toast ${error ? 'error' : ''}`}>{text}</div>;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function TrustBar({ score }: { score: number }) {
  return (
    <div className="trust">
      <span>Trust {score}</span>
      <span className="bar"><i style={{ width: `${score}%` }} /></span>
    </div>
  );
}

function AgencyWall({ session }: { session: Session }) {
  if (session.org.type === 'agency') {
    return (
      <div className="wall">
        <b>The under-18 wall is active for this account.</b>
        <p>
          Under-18 players are on ScoutBox now — and agency accounts can never list, view or contact
          any of them. The API refuses on every endpoint, regardless of what this interface asks for.
          Under-18 representation rules apply: no agent access, no exceptions.
        </p>
      </div>
    );
  }
  if (session.org.type === 'club' && !session.org.verified) {
    return (
      <div className="wall">
        <b>Club verification pending — under-18 profiles are hidden.</b>
        <p>
          Only verified clubs can search or view under-18 players. Verification requires a company
          email domain and a signed safeguarding contract; until it clears, this workspace sees the
          adult pool only.
        </p>
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------- one-click safety */

// One-click reporting, reachable from every screen (topbar) and from
// profiles. Urgent reports immediately suspend communication pending review.
export function SafetyModal({ session, notify, onClose, presetPlayerId }: {
  session: Session;
  notify: (text: string, error?: boolean) => void;
  onClose: () => void;
  presetPlayerId?: string;
}) {
  const [targetKind, setTargetKind] = useState<'player' | 'scout' | 'club'>(presetPlayerId ? 'player' : 'scout');
  const [target, setTarget] = useState(presetPlayerId ?? '');
  const [reason, setReason] = useState('');
  const [urgent, setUrgent] = useState(false);

  const submit = async () => {
    if (!reason.trim()) return notify('Describe what happened — reports need a reason.', true);
    try {
      await api.report(session, {
        targetKind,
        targetPlayerId: targetKind === 'player' ? target : undefined,
        targetScoutName: targetKind === 'scout' ? target : undefined,
        targetOrgId: targetKind === 'club' ? target : undefined,
        reason,
        urgent,
      });
      notify(urgent ? 'Report filed — communication suspended pending review.' : 'Report filed for review. Thank you.');
      onClose();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer" style={{ width: 'min(520px, 92vw)' }}>
        <div className="head">
          <div>
            <h3>Report &amp; block</h3>
            <div className="sub">All reports are reviewed. Urgent reports suspend communication immediately.</div>
          </div>
          <button className="close" onClick={onClose}>Close</button>
        </div>
        <div className="section">
          <h4>What are you reporting?</h4>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['player', 'scout', 'club'] as const).map((k) => (
              <button key={k} className={targetKind === k ? 'primary' : ''} onClick={() => setTargetKind(k)}>
                Report {k === 'player' ? 'User' : k === 'scout' ? 'Scout' : 'Club'}
              </button>
            ))}
          </div>
        </div>
        <div className="section">
          <h4>{targetKind === 'player' ? 'Player id' : targetKind === 'scout' ? 'Scout name' : 'Club / org id'}</h4>
          <input style={{ width: '100%' }} value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder={targetKind === 'player' ? 'e.g. pl-adeyemi' : targetKind === 'scout' ? 'e.g. the name shown on the request' : 'e.g. org-northstar'} />
        </div>
        <div className="section">
          <h4>What happened?</h4>
          <input style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe the behaviour" />
        </div>
        <div className="section">
          <label className="chk" style={{ display: 'flex', gap: 8, color: 'var(--muted)' }}>
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
            Urgent — suspend communication immediately pending review
          </label>
        </div>
        <button className="primary" onClick={submit}>Submit report</button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- Search */

export function SearchScreen({ session, tick, openPlayer }: ScreenProps) {
  const [filters, setFilters] = useState<SearchFilters>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.searchPlayers(session, filters).then((p) => { setPlayers(p); setError(null); }).catch((e) => setError(errMsg(e)));
  }, [session, filters, tick]);

  return (
    <>
      <AgencyWall session={session} />
      <div className="filters">
        <input
          type="text"
          placeholder="Search name, city, country…"
          value={filters.q ?? ''}
          onChange={(e) => setFilters({ ...filters, q: e.target.value || undefined })}
        />
        <select value={filters.position ?? ''} onChange={(e) => setFilters({ ...filters, position: e.target.value || undefined })}>
          <option value="">Any position</option>
          {POSITIONS.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={filters.availability ?? ''} onChange={(e) => setFilters({ ...filters, availability: e.target.value || undefined })}>
          <option value="">Any availability</option>
          {Object.entries(AVAILABILITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="chk">
          <input type="checkbox" checked={!!filters.academyPlus} onChange={(e) => setFilters({ ...filters, academyPlus: e.target.checked || undefined })} />
          Academy+ only
        </label>
        <span className="pill">{players.length} players</span>
      </div>
      {error && <div className="notice block">{error}</div>}
      <div className="player-grid">
        {players.map((p) => (
          <div key={p.id} className="player-card" onClick={() => openPlayer(p.id)}>
            <div className="row1">
              <span className="name">{p.name}</span>
              <span className="pill blue">{p.position}</span>
            </div>
            <div className="meta">
              {p.age} · {p.foot} foot · {p.city ? `${p.city}, ` : ''}{p.country} · {p.heightCm} cm
            </div>
            <div className="badges">
              {p.guardianManaged && <span className="pill red">U18 · guardian-managed</span>}
              {p.academyPlus && <span className="pill green">Academy+</span>}
              {p.identityVerified && <span className="pill outline-green">ID ✓</span>}
              <span className="pill">{AVAILABILITY_LABELS[p.availability] ?? p.availability}</span>
              <span className="pill">{CONTRACT_LABELS[p.contractStatus] ?? p.contractStatus}</span>
              {p.badges.map((b) => <span key={b} className="pill gold">{b}</span>)}
            </div>
            <TrustBar score={p.trustScore} />
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Shortlist */

export function ShortlistScreen({ session, tick, openPlayer }: ScreenProps) {
  const [players, setPlayers] = useState<Player[]>([]);
  useEffect(() => { api.getShortlist(session).then(setPlayers).catch(() => {}); }, [session, tick]);
  if (!players.length) return <div className="notice">Nothing shortlisted yet — shortlist players from their profile. Every shortlist action lands on the Discovery Ledger under your name.</div>;
  return (
    <div className="player-grid">
      {players.map((p) => (
        <div key={p.id} className="player-card" onClick={() => openPlayer(p.id)}>
          <div className="row1"><span className="name">{p.name}</span><span className="pill blue">{p.position}</span></div>
          <TrustBar score={p.trustScore} />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- Requests */

export function RequestsScreen({ session, tick, openPlayer }: ScreenProps) {
  const [requests, setRequests] = useState<OrgRequest[]>([]);
  useEffect(() => { api.getRequests(session).then(setRequests).catch(() => {}); }, [session, tick]);
  return (
    <>
      <div className="notice" style={{ marginBottom: 16 }}>
        There is no direct message channel on ScoutBox. You file a request; contact unlocks only on
        acceptance. For under-18 players the request goes to the <b>parent or guardian</b> — never the
        child — and any conversation that opens is between your named staff and the guardian.
      </div>
      <div className="list-rows">
        {requests.length === 0 && <div className="notice">No requests sent yet.</div>}
        {requests.map((r) => (
          <div key={r.id} className="list-row">
            <span className={`pill ${r.type === 'trial' ? 'gold' : 'blue'}`}>{r.type}</span>
            <span className="grow">
              <a style={{ color: 'var(--accent-2)', cursor: 'pointer' }} onClick={() => openPlayer(r.playerId)}>{r.playerName ?? r.playerId}</a>
              {r.routedTo === 'guardian' && <span className="pill red" style={{ marginLeft: 8 }}>→ guardian</span>}
              {r.message && <span className="dim"> — “{r.message}”</span>}
            </span>
            <span className="dim">by {r.scoutName}{r.scoutRole ? ` (${r.scoutRole})` : ''}</span>
            <span className={`pill ${r.status === 'accepted' ? 'green' : r.status === 'declined' || r.status === 'suspended' ? 'red' : ''}`}>
              {r.status === 'pending' && r.routedTo === 'guardian' ? 'awaiting guardian' : r.status}
            </span>
            {r.status === 'accepted' && r.contactChannel && <span className="pill outline-green">channel open: {r.contactChannel}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- Trials */

const REPORT_FIELDS: { key: string; label: string; step?: string }[] = [
  { key: 'acceleration', label: 'Acceleration (0–10)' },
  { key: 'sprintSpeedKmh', label: 'Sprint speed (km/h)', step: '0.1' },
  { key: 'distanceKm', label: 'Distance covered (km)', step: '0.1' },
  { key: 'passCompletionPct', label: 'Pass completion (%)' },
  { key: 'duelSuccessPct', label: 'Duel success (%)' },
  { key: 'coachRating', label: 'Coach rating (1–10)' },
];

export function TrialsScreen({ session, tick, notify }: ScreenProps) {
  const [trials, setTrials] = useState<Trial[]>([]);
  const [filing, setFiling] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [localTick, setLocalTick] = useState(0);

  useEffect(() => { api.getTrials(session).then(setTrials).catch(() => {}); }, [session, tick, localTick]);

  const file = async (trialId: string) => {
    const report: Record<string, number> = {};
    for (const f of REPORT_FIELDS) if (form[f.key] !== undefined && form[f.key] !== '') report[f.key] = Number(form[f.key]);
    try {
      await api.fileTrialReport(session, trialId, report);
      notify('Trial report filed — synced to the player profile, Trust Score raised.');
      setFiling(null);
      setForm({});
      setLocalTick((t) => t + 1);
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const awaiting = trials.filter((t) => t.status === 'awaiting_report');

  return (
    <>
      {awaiting.length > 0 && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          {awaiting.length} trial{awaiting.length > 1 ? 's' : ''} awaiting a mandatory performance report.
          New trial requests are blocked until every report is filed — partial reports are rejected by the server.
        </div>
      )}
      <div className="list-rows">
        {trials.length === 0 && <div className="notice">No trials yet. Trials begin when a player accepts a trial request.</div>}
        {trials.map((t) => (
          <div key={t.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span className="grow"><b>{t.playerName}</b> <span className="dim">requested by {t.scoutName}</span></span>
              <span className={`pill ${t.status === 'reported' ? 'green' : 'gold'}`}>{t.status === 'reported' ? 'report filed' : 'awaiting report'}</span>
              {t.status === 'awaiting_report' && (
                <button onClick={() => { setFiling(filing === t.id ? null : t.id); setForm({}); }}>
                  {filing === t.id ? 'Cancel' : 'File report'}
                </button>
              )}
            </div>
            {t.status === 'reported' && t.report && (
              <div className="dim" style={{ marginTop: 6 }}>
                accel {t.report.acceleration}/10 · {t.report.sprintSpeedKmh} km/h · {t.report.distanceKm} km ·
                pass {t.report.passCompletionPct}% · duels {t.report.duelSuccessPct}% · coach {t.report.coachRating}/10
              </div>
            )}
            {filing === t.id && (
              <div>
                <div className="form-grid">
                  {REPORT_FIELDS.map((f) => (
                    <label key={f.key}>
                      {f.label}
                      <input
                        type="number"
                        step={f.step ?? '1'}
                        value={form[f.key] ?? ''}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <button className="primary" onClick={() => file(t.id)}>Submit full report</button>
                <span className="dim" style={{ marginLeft: 10 }}>All six metrics are mandatory.</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- Ledger */

const LEDGER_LABELS: Record<string, string> = {
  view: 'Viewed profile',
  save: 'Saved',
  shortlist: 'Shortlisted',
  contact_request: 'Contact requested',
  contact_accepted: 'Contact accepted',
  contact_declined: 'Contact declined',
  trial_request: 'Trial requested',
  trial_accepted: 'Trial accepted',
  trial_declined: 'Trial declined',
  trial_report: 'Trial report filed',
  signing: 'Signing recorded',
};

export function LedgerScreen({ session, tick, openPlayer }: ScreenProps) {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  useEffect(() => { api.getLedger(session).then(setRows).catch(() => {}); }, [session, tick]);
  return (
    <>
      <div className="notice" style={{ marginBottom: 16 }}>
        Append-only. Every action your organisation takes is timestamped to a named scout. This ledger is
        the evidence base for attribution and Proof Packs — it cannot be edited or purged.
      </div>
      <table className="data">
        <thead><tr><th>When</th><th>Action</th><th>Player</th><th>By</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{LEDGER_LABELS[r.type] ?? r.type}</td>
              <td><a style={{ color: 'var(--accent-2)', cursor: 'pointer' }} onClick={() => openPlayer(r.playerId)}>{r.playerId}</a></td>
              <td>{r.scoutName}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No entries yet — view a profile to create the first one.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

/* --------------------------------------------------------- Reputation */

export function ReputationScreen({ session, tick }: ScreenProps) {
  const [rep, setRep] = useState<Reputation | null>(null);
  useEffect(() => { api.getReputation(session).then(setRep).catch(() => {}); }, [session, tick]);
  if (!rep) return null;
  return (
    <>
      <div className="section">
        <h4>Track records</h4>
        <table className="data">
          <thead><tr><th>Scout / coach</th><th>Organisation</th><th>Discoveries</th><th>Success rate</th><th>Avg resale multiple</th></tr></thead>
          <tbody>
            {rep.seeded.map((r) => (
              <tr key={r.scoutName}>
                <td>{r.scoutName}</td><td>{r.orgName}</td><td>{r.discoveries}</td><td>{r.successRatePct}%</td><td>{r.avgResaleMultiple}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section">
        <h4>Live activity (computed from the Discovery Ledger)</h4>
        <table className="data">
          <thead><tr><th>Scout / coach</th><th>Organisation</th><th>Views</th><th>Contacts</th><th>Trials</th><th>Signings</th></tr></thead>
          <tbody>
            {rep.live.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No live activity yet this session.</td></tr>}
            {rep.live.map((r) => (
              <tr key={`${r.scoutName}-${r.orgName}`}>
                <td>{r.scoutName}</td><td>{r.orgName}</td><td>{r.views}</td><td>{r.contacts}</td><td>{r.trials}</td><td>{r.signings}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- Plan */

export function PlanScreen({ session, tick }: ScreenProps) {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  useEffect(() => { api.getPlan(session).then(setInfo).catch(() => {}); }, [session, tick]);
  if (!info) return null;
  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 22 }}>
        <div className="stat"><div className="v">{info.plan.name}</div><div className="k">Plan</div></div>
        <div className="stat"><div className="v">£{info.plan.pricePerMonthGBP}</div><div className="k">per month</div></div>
        <div className="stat"><div className="v">{info.plan.seats}</div><div className="k">named seats</div></div>
        <div className="stat"><div className="v">{info.plan.attributionWindowMonths} mo</div><div className="k">attribution window</div></div>
      </div>
      <div className="section">
        <h4>Fee protection</h4>
        <div className="notice">{info.compliance.feeProtection}</div>
      </div>
      <div className="section">
        <h4>Anti-circumvention terms</h4>
        <div className="notice">{info.compliance.antiCircumvention}</div>
      </div>
      <div className="section">
        <h4>Accountability</h4>
        <div className="notice">
          Every seat is a named individual. The API refuses any request that is not attributed to a person —
          shared logins do not exist on ScoutBox.
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------ Player drawer */

export function PlayerDrawer({ session, playerId, notify, onClose }: {
  session: Session;
  playerId: string;
  notify: (text: string, error?: boolean) => void;
  onClose: () => void;
}) {
  const [player, setPlayer] = useState<PlayerDetail | null>(null);
  const [proof, setProof] = useState<ProofPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestType, setRequestType] = useState<'contact' | 'trial' | null>(null);
  const [message, setMessage] = useState('');
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    setPlayer(null); setProof(null); setError(null);
    api.getPlayer(session, playerId).then(setPlayer).catch((e) => {
      setError(
        e instanceof ApiError && e.code === 'UNDER_18_WALL'
          ? 'The under-18 wall: agency accounts cannot view minors. This profile does not exist for your organisation.'
          : e instanceof ApiError && e.code === 'VERIFIED_CLUBS_ONLY'
            ? 'Under-18 profiles are visible to verified clubs only. Complete club verification to view this player.'
            : errMsg(e));
    });
  }, [session, playerId]);

  const act = async (action: 'save' | 'shortlist') => {
    try {
      await api.act(session, playerId, action);
      notify(`${action === 'save' ? 'Saved' : 'Shortlisted'} — logged to the Discovery Ledger under ${session.scoutName}.`);
    } catch (e) { notify(errMsg(e), true); }
  };

  const send = async () => {
    if (!requestType) return;
    const minor = player?.guardianManaged;
    try {
      await api.sendRequest(session, playerId, requestType, message);
      notify(minor
        ? `Sent to the parent/guardian. ${session.org.name} (${session.role}) has requested to discuss a ${requestType === 'trial' ? 'trial' : 'conversation'} — the guardian decides.`
        : `${requestType === 'trial' ? 'Trial' : 'Contact'} request sent to the player's Scout Inbox. Contact unlocks only if they accept.`);
      setRequestType(null); setMessage('');
    } catch (e) { notify(errMsg(e), true); }
  };

  const loadProof = () => api.getProofPack(session, playerId).then(setProof).catch((e) => notify(errMsg(e), true));

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer">
        {error && <><div className="notice block">{error}</div><div style={{ marginTop: 14 }}><button onClick={onClose}>Close</button></div></>}
        {player && (
          <>
            <div className="head">
              <div>
                <h3>{player.name}</h3>
                <div className="sub">
                  {player.position} · {player.age} · {player.foot} foot · {player.city ? `${player.city}, ` : ''}{player.country} · {player.heightCm} cm / {player.weightKg} kg
                </div>
                <div className="badges" style={{ marginTop: 8 }}>
                  {player.guardianManaged && <span className="pill red">U18 · guardian-managed</span>}
                  {player.academyPlus && <span className="pill green">Academy+ — fresh start cohort</span>}
                  {player.identityVerified && <span className="pill outline-green">Identity verified</span>}
                  <span className="pill">{AVAILABILITY_LABELS[player.availability] ?? player.availability}</span>
                  <span className="pill">{CONTRACT_LABELS[player.contractStatus] ?? player.contractStatus}</span>
                  {player.badges.map((b) => <span key={b} className="pill gold">{b}</span>)}
                </div>
              </div>
              <button className="close" onClick={onClose}>Close</button>
            </div>

            <TrustBar score={player.trustScore} />

            {player.guardianManaged && (
              <div className="notice warn" style={{ marginTop: 12 }}>
                This player is under 18. Their account is owned by a parent/guardian: you cannot message
                the child, ever. Requests below go to the guardian, who sees your club, your name and
                your verified role ({session.role}).
              </div>
            )}

            <div className="actions">
              <button onClick={() => act('save')}>Save</button>
              <button onClick={() => act('shortlist')}>Shortlist</button>
              {player.guardianManaged ? (
                <>
                  <button className="primary" onClick={() => setRequestType('contact')}>Contact Guardian</button>
                  <button className="primary" onClick={() => setRequestType('trial')}>Invite to trial (via guardian)</button>
                </>
              ) : (
                <>
                  <button className="primary" onClick={() => setRequestType('contact')}>Request contact</button>
                  <button className="primary" onClick={() => setRequestType('trial')}>Request trial</button>
                </>
              )}
              <button onClick={loadProof}>Proof Pack</button>
              <button onClick={() => setReporting(true)}>⚑ Report</button>
            </div>

            {requestType && (
              <div className="section">
                <h4>
                  {player.guardianManaged
                    ? `${requestType === 'trial' ? 'Trial invitation' : 'Conversation request'} — goes to the parent/guardian`
                    : `${requestType} request — goes to the player's Scout Inbox`}
                </h4>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input
                    style={{ flex: 1 }}
                    placeholder={player.guardianManaged
                      ? `Message to the guardian (they see ${session.org.name}, ${session.role}, ${session.scoutName})`
                      : 'Message to the player (they see your club and your name)'}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <button className="primary" onClick={send}>Send</button>
                  <button onClick={() => setRequestType(null)}>Cancel</button>
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 12.5 }}>
                  Messages are screened: personal contact details and off-platform contact are blocked by moderation.
                </div>
              </div>
            )}

            {proof && (
              <div className="section">
                <h4>Proof Pack — attribution evidence</h4>
                <div className="list-rows">
                  <div className="list-row">
                    <span className="grow">First qualifying interaction</span>
                    <span className="dim">
                      {proof.firstQualifyingInteraction
                        ? `${LEDGER_LABELS[proof.firstQualifyingInteraction.type] ?? proof.firstQualifyingInteraction.type} · ${new Date(proof.firstQualifyingInteraction.ts).toLocaleString()} · ${proof.firstQualifyingInteraction.scoutName}`
                        : 'none yet'}
                    </span>
                  </div>
                  <div className="list-row">
                    <span className="grow">Attribution window</span>
                    <span className="dim">{proof.attributionWindowMonths} months{proof.attributionWindowEnds ? ` — ends ${new Date(proof.attributionWindowEnds).toLocaleDateString()}` : ''}</span>
                  </div>
                  <div className="list-row">
                    <span className="grow">Logged events for {proof.org.name}</span>
                    <span className="dim">{proof.eventLog.length}</span>
                  </div>
                </div>
              </div>
            )}

            {player.stats && (
              <div className="section">
                <h4>Season output</h4>
                <div className="stat-grid">
                  <Stat v={player.stats.appearances} k="Appearances" />
                  {player.position === 'GK'
                    ? <Stat v={player.stats.cleanSheets ?? 0} k="Clean sheets" />
                    : <><Stat v={player.stats.goals} k="Goals" /><Stat v={player.stats.assists} k="Assists" /></>}
                  {player.stats.paceKmh != null && <Stat v={`${player.stats.paceKmh}`} k="Top speed km/h" />}
                  {player.stats.passCompletionPct != null && <Stat v={`${player.stats.passCompletionPct}%`} k="Pass completion" />}
                  {player.stats.duelSuccessPct != null && player.position !== 'GK' && <Stat v={`${player.stats.duelSuccessPct}%`} k="Duel success" />}
                </div>
              </div>
            )}

            {(player.contractUntil || player.marketValueRange || player.agentName) && (
              <div className="section">
                <h4>Contract</h4>
                <div className="stat-grid">
                  {player.contractUntil && <Stat v={player.contractUntil} k="Contracted until" />}
                  {player.marketValueRange && <Stat v={player.marketValueRange} k="Market value" />}
                  {player.agentName && <Stat v={player.agentName} k="Agent" />}
                </div>
              </div>
            )}

            <div className="section">
              <h4>Verified match attendance</h4>
              {player.attendance.length === 0 && <div className="notice">No verified attendances yet.</div>}
              <div className="list-rows">
                {player.attendance.map((a) => (
                  <div key={a.id} className="list-row">
                    <span className="pill green">GPS + device ✓</span>
                    <span className="grow">{a.fixture}</span>
                    <span className="dim">{a.venue} · {a.date}</span>
                  </div>
                ))}
              </div>
            </div>

            {player.trialReports.length > 0 && (
              <div className="section">
                <h4>Trial performance reports (institutional corroboration)</h4>
                <div className="list-rows">
                  {player.trialReports.map((r) => (
                    <div key={r.id} className="list-row">
                      <span className="grow">{r.orgName} <span className="dim">· {r.scoutName}</span></span>
                      <span className="dim">
                        accel {r.acceleration}/10 · {r.sprintSpeedKmh} km/h · {r.distanceKm} km · pass {r.passCompletionPct}% · duels {r.duelSuccessPct}% · coach {r.coachRating}/10
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="section">
              <h4>Medical</h4>
              {player.medical.shared ? (
                <div className="list-rows">
                  <div className="list-row"><span className="pill green">Shared by player</span><span className="grow">Condition: {player.medical.conditionStatus.replace(/_/g, ' ')}</span></div>
                  {player.medical.records.map((m) => (
                    <div key={m.id} className="list-row">
                      <span className="pill">{m.type}</span>
                      <span className="grow">{m.title}</span>
                      <span className="dim">{m.date}{m.layoffWeeks ? ` · ${m.layoffWeeks} wks out` : ''}{m.cleared ? ' · cleared' : ''}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="notice">
                  🔒 Medical data is player-controlled under data-protection law. This player has not switched
                  sharing on, so nothing is visible to any organisation — including yours.
                </div>
              )}
            </div>

            <div className="section">
              <h4>Transfer timeline</h4>
              <div className="list-rows">
                {player.timeline.map((t, i) => (
                  <div key={i} className="list-row"><span className="pill">{t.year}</span><span className="grow">{t.event}</span></div>
                ))}
              </div>
            </div>

            <div className="section">
              <h4>Media</h4>
              {player.media.length === 0 && <div className="notice">No uploads yet.</div>}
              <div className="list-rows">
                {player.media.map((m) => (
                  <div key={m.id} className="list-row">
                    <span className="pill blue">{m.kind}</span>
                    <span className="grow">{m.title}</span>
                    <span className="dim">{new Date(m.uploadedAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="section">
              <h4>Similar players — {player.similarPlayers.note}</h4>
              <div className="list-rows">
                {player.similarPlayers.archetypes.map((a) => (
                  <div key={a.archetypeId} className="list-row">
                    <span className="pill gold">archetype</span>
                    <span className="grow">{a.label}</span>
                    <span className="dim">{a.score}% match</span>
                  </div>
                ))}
                {player.similarPlayers.players.map((sp) => (
                  <div key={sp.playerId} className="list-row">
                    <span className="pill blue">{sp.position}</span>
                    <span className="grow">{sp.name}</span>
                    <span className="dim">{sp.score}% similar</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      {reporting && (
        <SafetyModal session={session} notify={notify} onClose={() => setReporting(false)} presetPlayerId={playerId} />
      )}
    </>
  );
}

function Stat({ v, k }: { v: ReactNode; k: string }) {
  return <div className="stat"><div className="v">{v}</div><div className="k">{k}</div></div>;
}
