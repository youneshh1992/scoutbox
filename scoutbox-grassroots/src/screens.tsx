import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, ApiError,
  type Session, type Player, type PlayerDetail, type OrgRequest, type Trial,
  type LedgerEntry, type ProofPack, type PlanInfo, type Reputation, type SearchFilters,
  type Channel, type FiledReport, type TrialDetails,
  type FeedItem, type FilmRoomItem, type FixtureGroup, type SavedSearch, type OrgNote,
  type Funnel, type Invoice,
} from './api';

const TAG_LABELS: Record<string, string> = {
  first_touch: 'First touch', pace: 'Pace', positioning: 'Positioning', work_rate: 'Work rate',
  left_foot: 'Left foot', right_foot: 'Right foot', aerial: 'Aerial', composure: 'Composure',
  vision: 'Vision', pressing: 'Pressing', finishing: 'Finishing', distribution: 'Distribution',
};

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
  const [myReports, setMyReports] = useState<FiledReport[]>([]);

  useEffect(() => { api.getMyReports(session).then(setMyReports).catch(() => {}); }, [session]);

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
        {myReports.length > 0 && (
          <div className="section" style={{ marginTop: 22 }}>
            <h4>Your reports — you always hear back</h4>
            <div className="list-rows">
              {myReports.map((r) => (
                <div key={r.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="pill">{r.targetKind}</span>
                    <span className="grow" style={{ fontSize: 13 }}>{r.reason}</span>
                    <span className={`pill ${r.status === 'resolved' ? 'green' : 'gold'}`}>{r.status === 'resolved' ? 'reviewed' : 'in review'}</span>
                  </div>
                  {r.outcome && <span className="dim" style={{ fontSize: 12.5 }}>{r.outcome}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- Home feed */

const FEED_LABELS: Record<FeedItem['type'], string> = {
  new_player: 'New on ScoutBox',
  new_clip: 'New footage',
  shortlist_new_clip: 'Your shortlist posted',
  report_due: 'Report due',
};

export function FeedScreen({ session, tick, openPlayer }: ScreenProps) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  useEffect(() => { api.getFeed(session).then(setItems).catch(() => setItems([])); }, [session, tick]);

  if (items === null) {
    return <div className="player-grid">{[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="player-card skeleton" style={{ height: 90 }} />)}</div>;
  }

  return (
    <>
      <AgencyWall session={session} />
      <div className="notice" style={{ marginBottom: 16 }}>
        What changed since you last looked: new players, fresh footage (your shortlist first), and
        reports coming due. Every open from here is logged like any other view.
      </div>
      {items.length === 0 && <div className="notice">Quiet fortnight — nothing new yet.</div>}
      <div className="list-rows">
        {items.map((it, i) => (
          <div key={i} className="list-row" style={{ cursor: 'pointer' }} onClick={() => openPlayer(it.playerId)}>
            <span className={`pill ${it.type === 'report_due' ? 'red' : it.type === 'shortlist_new_clip' ? 'gold' : it.type === 'new_player' ? 'green' : 'blue'}`}>
              {FEED_LABELS[it.type]}
            </span>
            <span className="grow">
              <b>{it.playerName}</b>
              {it.type === 'new_player' && <span className="dim"> — {it.position}, {it.age}{it.guardianManaged ? ' · U18 (guardian-managed)' : ''}</span>}
              {(it.type === 'new_clip' || it.type === 'shortlist_new_clip') && (
                <span className="dim"> — “{it.title}”{it.verifiedClip ? ' · ✅ Verified Clip' : ''}{it.hasVideo ? ' · playable' : ''}</span>
              )}
              {it.type === 'report_due' && <span className="dim"> — mandatory trial report due {it.dueAt ? new Date(it.dueAt).toLocaleDateString() : 'soon'}</span>}
            </span>
            <span className="dim">{new Date(it.ts).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ Film Room */

export function FilmRoomScreen({ session, notify, openPlayer }: ScreenProps) {
  const [deck, setDeck] = useState<FilmRoomItem[]>([]);
  const [index, setIndex] = useState(0);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [pendingTags, setPendingTags] = useState<string[]>([]);
  const viewed = useRef(new Set<string>());

  useEffect(() => {
    api.getFilmRoom(session).then(setDeck).catch(() => {});
    api.getScoutTags(session).then(setTagOptions).catch(() => {});
  }, [session]);

  const current = deck[index] ?? null;

  useEffect(() => {
    // A play in the Film Room is a view — honest signal back to the player.
    if (current && !viewed.current.has(current.media.id)) {
      viewed.current.add(current.media.id);
      api.recordClipView(session, current.player.id, current.media.id).catch(() => {});
    }
    setPendingTags([]);
  }, [current, session]);

  const step = useCallback((dir: number) => {
    setIndex((i) => Math.min(Math.max(i + dir, 0), Math.max(deck.length - 1, 0)));
  }, [deck.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const submitTags = async () => {
    if (!current || pendingTags.length === 0) return;
    try {
      await api.tagClip(session, current.player.id, current.media.id, pendingTags);
      notify('Tagged — aggregated anonymously into the player\'s "what scouts noticed".');
      setPendingTags([]);
    } catch (e) { notify(errMsg(e), true); }
  };

  if (deck.length === 0) {
    return <div className="notice">No playable footage yet. Clips appear here the moment players upload them — Verified Clips first.</div>;
  }

  return (
    <div className="filmroom">
      <div className="filmroom-stage">
        {current && (
          <>
            <video key={current.media.id} className="filmroom-video" src={api.mediaUrl(current.media.url)!} controls autoPlay muted loop />
            <div className="filmroom-overlay">
              <div className="row1">
                <a style={{ color: 'var(--text)', fontWeight: 700, fontSize: 18, cursor: 'pointer' }} onClick={() => openPlayer(current.player.id)}>
                  {current.player.name}
                </a>
                <span className="pill blue">{current.player.position}</span>
                <span className="pill">{current.player.age}</span>
                {current.player.guardianManaged && <span className="pill red">U18</span>}
                {current.media.verifiedClip && <span className="pill green">✅ Verified Clip — filmed at a confirmed fixture</span>}
              </div>
              <div className="dim">“{current.media.title}” · {current.media.views} view{current.media.views === 1 ? '' : 's'} · trust {current.player.trustScore}</div>
              <div className="filmroom-tags">
                {tagOptions.map((t) => (
                  <button
                    key={t}
                    className={pendingTags.includes(t) ? 'primary' : ''}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => setPendingTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
                  >
                    {TAG_LABELS[t] ?? t}
                  </button>
                ))}
                {pendingTags.length > 0 && <button className="primary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={submitTags}>Save tags</button>}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="filmroom-controls">
        <button onClick={() => step(-1)} disabled={index === 0}>↑ Previous</button>
        <span className="pill">{index + 1} / {deck.length}</span>
        <button className="primary" onClick={() => step(1)} disabled={index >= deck.length - 1}>↓ Next clip</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Fixtures */

export function FixturesScreen({ session, tick, openPlayer }: ScreenProps) {
  const [fixtures, setFixtures] = useState<FixtureGroup[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => { api.getFixtures(session).then(setFixtures).catch(() => {}); }, [session, tick]);
  return (
    <>
      <div className="notice" style={{ marginBottom: 16 }}>
        Scout by match. Every fixture below is built from GPS+device-verified attendance — ScoutBox
        ground truth, not self-reported CVs. Open one to see who provably played.
      </div>
      <div className="list-rows">
        {fixtures.map((f) => {
          const key = `${f.fixture}|${f.date}`;
          return (
            <div key={key} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpenKey(openKey === key ? null : key)}>
                <span className="pill green">GPS ✓</span>
                <span className="grow"><b>{f.fixture}</b> <span className="dim">— {f.venue}</span></span>
                <span className="dim">{f.date}</span>
                <span className="pill">{f.players.length} player{f.players.length === 1 ? '' : 's'}</span>
              </div>
              {openKey === key && (
                <div className="list-rows" style={{ marginTop: 8 }}>
                  {f.players.map((p) => (
                    <div key={p.id} className="list-row" style={{ cursor: 'pointer' }} onClick={() => openPlayer(p.id)}>
                      <span className="pill blue">{p.position}</span>
                      <span className="grow">{p.name}</span>
                      <span className="dim">{p.age} · trust {p.trustScore}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ Compare */

// Side-by-side comparison — the spreadsheet scouts keep, built in.
export function CompareModal({ session, playerIds, onClose }: {
  session: Session;
  playerIds: string[];
  onClose: () => void;
}) {
  const [players, setPlayers] = useState<PlayerDetail[]>([]);
  useEffect(() => {
    Promise.all(playerIds.map((id) => api.getPlayer(session, id).catch(() => null)))
      .then((list) => setPlayers(list.filter((p): p is PlayerDetail => !!p)));
  }, [session, playerIds]);

  const rows: { label: string; get: (p: PlayerDetail) => ReactNode }[] = [
    { label: 'Position · age', get: (p) => `${p.position} · ${p.age}` },
    { label: 'Trust', get: (p) => p.trustScore },
    { label: 'Apps', get: (p) => p.stats?.appearances ?? '—' },
    { label: 'Goals', get: (p) => p.stats?.goals ?? '—' },
    { label: 'Assists', get: (p) => p.stats?.assists ?? '—' },
    { label: 'Top speed', get: (p) => p.stats?.paceKmh ? `${p.stats.paceKmh} km/h` : '—' },
    { label: 'Pass %', get: (p) => p.stats?.passCompletionPct ? `${p.stats.passCompletionPct}%` : '—' },
    { label: 'Duels %', get: (p) => p.stats?.duelSuccessPct ? `${p.stats.duelSuccessPct}%` : '—' },
    { label: 'Verified attendance', get: (p) => p.attendance.length },
    { label: 'Verified clips', get: (p) => p.media.filter((m) => m.verifiedClip).length },
    { label: 'Trial reports', get: (p) => p.trialReports.length },
    { label: 'Combine (verified)', get: (p) => (p.drillResults ?? []).filter((r) => r.verified).map((r) => `${r.metric} ${r.value}${r.unit}`).join(', ') || '—' },
    { label: 'Availability', get: (p) => AVAILABILITY_LABELS[p.availability] ?? p.availability },
    { label: 'Status', get: (p) => p.guardianManaged ? 'U18 · guardian-managed' : CONTRACT_LABELS[p.contractStatus] ?? p.contractStatus },
  ];

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer" style={{ width: 'min(980px, 94vw)' }}>
        <div className="head">
          <div><h3>Compare</h3><div className="sub">Side by side — verified data only.</div></div>
          <button className="close" onClick={onClose}>Close</button>
        </div>
        <table className="data">
          <thead>
            <tr><th></th>{players.map((p) => <th key={p.id}>{p.name}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={{ color: 'var(--muted)' }}>{r.label}</td>
                {players.map((p) => <td key={p.id}>{r.get(p)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- Search */

export function SearchScreen({ session, tick, notify, openPlayer }: ScreenProps) {
  const [filters, setFilters] = useState<SearchFilters>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [saveName, setSaveName] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    api.searchPlayers(session, filters).then((p) => { setPlayers(p); setError(null); }).catch((e) => setError(errMsg(e)));
  }, [session, filters, tick]);

  useEffect(() => {
    api.getSavedSearches(session).then(setSaved).catch(() => {});
  }, [session, tick]);

  const saveCurrent = async () => {
    if (!saveName.trim()) return notify('Name the search first (e.g. "U16 left-footed wingers").', true);
    try {
      await api.saveSearch(session, saveName.trim(), filters);
      setSaveName('');
      setSaved(await api.getSavedSearches(session));
      notify('Saved — you\'ll be notified the moment a new player matches.');
    } catch (e) { notify(errMsg(e), true); }
  };

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 3 ? prev : [...prev, id]);
  };

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
        <select value={filters.ageGroup ?? ''} onChange={(e) => setFilters({ ...filters, ageGroup: (e.target.value || undefined) as SearchFilters['ageGroup'] })}>
          <option value="">Any age group</option>
          <option value="u16">U16</option>
          <option value="u18">U18</option>
          <option value="18-21">18–21</option>
          <option value="senior">22+</option>
        </select>
        <select value={filters.country ?? ''} onChange={(e) => setFilters({ ...filters, country: e.target.value || undefined })}>
          <option value="">Any country</option>
          {['GB', 'PT', 'FR', 'SE', 'PL', 'NG', 'GH', 'AR', 'JP', 'KR'].map((c) => <option key={c}>{c}</option>)}
        </select>
        <label className="chk">
          <input type="checkbox" checked={!!filters.newDays} onChange={(e) => setFilters({ ...filters, newDays: e.target.checked ? 7 : undefined })} />
          New this week
        </label>
        <span className="pill">{players.length} players</span>
      </div>
      <div className="filters" style={{ marginTop: -8 }}>
        <input type="text" placeholder="Save this search as… (alerts on new matches)" value={saveName} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveCurrent()} />
        <button onClick={saveCurrent}>💾 Save search</button>
        {saved.map((s) => (
          <span key={s.id} className="pill blue" style={{ cursor: 'pointer' }} title={`by ${s.scoutName}`}>
            <span onClick={() => setFilters(s.filters)}>🔔 {s.name}</span>{' '}
            <span onClick={() => api.deleteSavedSearch(session, s.id).then(() => api.getSavedSearches(session).then(setSaved))} title="Delete">✕</span>
          </span>
        ))}
        {compareIds.length >= 2 && (
          <button className="primary" onClick={() => setComparing(true)}>⚖ Compare {compareIds.length}</button>
        )}
      </div>
      {error && <div className="notice block">{error}</div>}
      <div className="notice" style={{ marginBottom: 14 }}>
        📍 Showing amateur and semi-pro players within <b>50 km</b> of your ground, nearest first — the
        Grassroots radius is a platform rule, enforced by the server. Professional-level players are not
        on this platform.
      </div>
      {comparing && <CompareModal session={session} playerIds={compareIds} onClose={() => setComparing(false)} />}
      <div className="player-grid">
        {players.map((p) => (
          <div key={p.id} className="player-card" onClick={() => openPlayer(p.id)}>
            <div className="row1">
              <span className="name">{p.name}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                <label className="chk" title="Select to compare">
                  <input type="checkbox" checked={compareIds.includes(p.id)} onChange={() => toggleCompare(p.id)} /> ⚖
                </label>
                <span className="pill blue">{p.position}</span>
              </span>
            </div>
            <div className="meta">
              {p.age} · {p.foot} foot · {p.city ? `${p.city}, ` : ''}{p.country} · {p.heightCm} cm
            </div>
            <div className="badges">
              {p.guardianManaged && <span className="pill red">U18 · guardian-managed</span>}
              {typeof p.distanceKm === 'number' && <span className="pill blue">{p.distanceKm} km away</span>}
              {p.level === 'semi_pro' && <span className="pill gold">semi-pro</span>}
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

/* ----------------------------------------------------------- Messages */

// Threads only exist where a request was accepted. For minors the thread is
// with the guardian; the header says so. Every message is moderated + logged.
export function MessagesScreen({ session, tick, notify }: ScreenProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachReportId, setAttachReportId] = useState('');
  const [trials, setTrials] = useState<Trial[]>([]);
  const [typing, setTyping] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastTyped = useRef(0);
  const typingTimer = useRef<number | null>(null);

  useEffect(() => { api.getChannels(session).then(setChannels).catch(() => {}); }, [session, tick]);
  useEffect(() => { api.getTrials(session).then(setTrials).catch(() => {}); }, [session, tick]);
  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight }); }, [channels, openId]);

  const open = channels.find((c) => c.id === openId) ?? null;

  // Read receipts: opening a thread marks it read for our side.
  useEffect(() => {
    if (openId) api.markChannelRead(session, openId).catch(() => {});
  }, [openId, session]);

  // Typing indicator: listen for the counterparty's typing pings.
  useEffect(() => {
    return api.onChange((event, payload) => {
      if (event === 'typing' && payload?.channelId === openId && payload?.side !== 'org') {
        setTyping(true);
        if (typingTimer.current) window.clearTimeout(typingTimer.current);
        typingTimer.current = window.setTimeout(() => setTyping(false), 3000);
      }
    });
  }, [openId]);

  const onDraftChange = (v: string) => {
    setDraft(v);
    // throttle our own typing pings
    if (open && Date.now() - lastTyped.current > 2000) {
      lastTyped.current = Date.now();
      api.sendTyping(session, open.id).catch(() => {});
    }
  };

  const openPlayerReports = open
    ? trials.filter((t) => t.playerId === open.playerId && t.status === 'reported' && t.report).map((t) => t.report!)
    : [];

  const send = async () => {
    if (!open || !draft.trim()) return;
    try {
      await api.sendMessage(session, open.id, draft.trim(), attachReportId || undefined);
      setDraft('');
      setAttachReportId('');
      setChannels(await api.getChannels(session));
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  return (
    <>
      <div className="notice" style={{ marginBottom: 16 }}>
        Threads open only when a request is accepted, stay on-platform, and are moderated and logged.
        For under-18 players you are talking to the <b>parent or guardian</b> — never the child.
      </div>
      {channels.length === 0 && <div className="notice">No open threads. Send a request; a thread opens when it's accepted.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14 }}>
        <div className="list-rows">
          {channels.map((c) => (
            <div
              key={c.id}
              className="list-row"
              style={{ cursor: 'pointer', borderColor: openId === c.id ? 'var(--accent-2)' : undefined }}
              onClick={() => setOpenId(c.id)}
            >
              <span className="grow">
                <b>{c.playerName}</b>
                <div className="dim">{c.counterparty === 'guardian' ? 'via guardian' : 'direct'} · {c.messages.length} msg</div>
              </span>
            </div>
          ))}
        </div>
        {open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="list-row">
              <span className="grow">
                <b>{open.playerName}</b>{' '}
                {open.counterparty === 'guardian' && <span className="pill red">thread is with the guardian</span>}
              </span>
              <span className="dim">opened {new Date(open.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="thread" ref={threadRef}>
              {open.messages.length === 0 && <div className="notice">Say hello — they accepted your request.</div>}
              {open.messages.map((m) => {
                const mine = m.sender.kind === 'org_user';
                const read = mine && open.readBy?.counterparty != null && open.readBy.counterparty >= m.ts;
                return (
                  <div key={m.id} className={`bubble ${mine ? 'mine' : 'theirs'}`}>
                    <div className="who">{m.sender.name} · {new Date(m.ts).toLocaleTimeString()}</div>
                    {m.text}
                    {m.attachment?.kind === 'clip' && (
                      <div style={{ marginTop: 6 }}>
                        <span className="pill blue">🎬 {m.attachment.title}</span>{' '}
                        {m.attachment.verifiedClip && <span className="pill green">✅ Verified Clip</span>}
                        {api.mediaUrl(m.attachment.url) && <video className="clip" style={{ marginTop: 6 }} controls preload="metadata" src={api.mediaUrl(m.attachment.url)!} />}
                      </div>
                    )}
                    {m.attachment?.kind === 'trial_report' && (
                      <div style={{ marginTop: 6 }}>
                        <span className="pill gold">📊 Trial report — {m.attachment.orgName}</span>
                        <div className="dim" style={{ fontSize: 12 }}>{m.attachment.summary}</div>
                      </div>
                    )}
                    {mine && <div className="who" style={{ textAlign: 'right', marginTop: 2 }}>{read ? '✓✓ read' : '✓ sent'}</div>}
                  </div>
                );
              })}
              {typing && <div className="dim" style={{ fontSize: 12.5 }}>… {open.counterparty === 'guardian' ? 'the guardian is' : `${open.playerName} is`} typing</div>}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              {openPlayerReports.length > 0 && (
                <select value={attachReportId} onChange={(e) => setAttachReportId(e.target.value)} title="Attach a filed trial report">
                  <option value="">📎 no attachment</option>
                  {openPlayerReports.map((r) => (
                    <option key={r.id} value={r.id}>📊 trial report ({new Date(r.filedAt).toLocaleDateString()})</option>
                  ))}
                </select>
              )}
              <input
                style={{ flex: 1 }}
                placeholder="Write a message (moderated — no personal contact details)"
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              <button className="primary" onClick={send}>Send</button>
            </div>
          </div>
        ) : (
          channels.length > 0 && <div className="notice">Pick a thread.</div>
        )}
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
    const report: Record<string, number | string> = {};
    for (const f of REPORT_FIELDS) if (form[f.key] !== undefined && form[f.key] !== '') report[f.key] = Number(form[f.key]);
    if (form.strengthNote) report.strengthNote = form.strengthNote;
    if (form.focusNote) report.focusNote = form.focusNote;
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
              <span className="grow">
                <b>{t.playerName}</b> <span className="dim">requested by {t.scoutName}</span>
                {t.guardianApproved && <span className="pill red" style={{ marginLeft: 8 }}>guardian approved</span>}
                <div className="dim">
                  {t.proposedDate ? `${t.proposedDate}` : 'date TBC'}{t.venue ? ` · ${t.venue}` : ''}{t.notes ? ` · ${t.notes}` : ''}
                  {t.status === 'awaiting_report' && t.reportDueAt ? ` · report due ${new Date(t.reportDueAt).toLocaleDateString()}` : ''}
                </div>
              </span>
              {api.trialIcsUrl(session, t.id) && (
                <a className="pill blue" style={{ textDecoration: 'none' }} href={api.trialIcsUrl(session, t.id)!} download={`scoutbox-trial-${t.id}.ics`}>📅 .ics</a>
              )}
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
                <div style={{ display: 'flex', gap: 10, margin: '8px 0' }}>
                  <input style={{ flex: 1 }} placeholder="One strength (goes to the player — optional)" value={form.strengthNote ?? ''} onChange={(e) => setForm({ ...form, strengthNote: e.target.value })} />
                  <input style={{ flex: 1 }} placeholder="One focus area (goes to the player — optional)" value={form.focusNote ?? ''} onChange={(e) => setForm({ ...form, focusNote: e.target.value })} />
                </div>
                <button className="primary" onClick={() => file(t.id)}>Submit full report</button>
                <span className="dim" style={{ marginLeft: 10 }}>All six metrics are mandatory; the feedback notes reach the player even if it goes no further.</span>
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

export function FunnelScreen({ session, tick }: ScreenProps) {
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  useEffect(() => { api.getFunnel(session).then(setFunnel).catch(() => {}); }, [session, tick]);
  if (!funnel) return <div className="notice">Loading your recruitment funnel…</div>;
  const max = Math.max(...funnel.stages.map((s) => s.count), 1);
  const pct = (i: number) => {
    const prev = funnel.stages[i - 1]?.count ?? 0;
    if (i === 0 || prev === 0) return null;
    return Math.round((funnel.stages[i].count / prev) * 100);
  };
  return (
    <>
      <div className="notice" style={{ marginBottom: 18 }}>
        Every stage below is a real recorded event on the Discovery Ledger — views through to signings.
        The numbers are the numbers.
      </div>
      <div className="section">
        {funnel.stages.map((s, i) => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <div style={{ width: 150, color: 'var(--muted)', fontSize: 13 }}>{s.label}</div>
            <div style={{ flex: 1, background: 'var(--panel-2)', borderRadius: 6, overflow: 'hidden', height: 22 }}>
              <div style={{ width: `${Math.max(2, (s.count / max) * 100)}%`, height: '100%', background: 'var(--accent)', opacity: 0.35 + 0.65 * (1 - i / funnel.stages.length) }} />
            </div>
            <div style={{ width: 46, fontWeight: 700, textAlign: 'right' }}>{s.count}</div>
            <div style={{ width: 70, color: 'var(--muted)', fontSize: 12, textAlign: 'right' }}>
              {pct(i) !== null ? `${pct(i)}% conv.` : ''}
            </div>
          </div>
        ))}
      </div>
      {funnel.byScout.length > 0 && (
        <div className="section">
          <h4>Activity by scout</h4>
          {funnel.byScout.map((s) => (
            <div key={s.scoutName} className="list-row">
              <span>{s.scoutName}</span>
              <span className="pill blue">{s.events} ledger events</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function PlanScreen({ session, tick, notify }: ScreenProps) {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [verifyEmail, setVerifyEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  useEffect(() => {
    api.getPlan(session).then(setInfo).catch(() => {});
    api.getInvoices(session).then(setInvoices).catch(() => {});
  }, [session, tick]);
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
        <h4>Company email verification {session.org.emailDomainVerified ? '— ✓ verified' : ''}</h4>
        {session.org.emailDomainVerified ? (
          <div className="notice">
            Domain control confirmed{session.org.emailDomain ? ` for @${session.org.emailDomain}` : ''}. This is one of the
            safeguarding requirements for access to under-18 players.
          </div>
        ) : (
          <>
            <div className="notice" style={{ marginBottom: 10 }}>
              Prove control of a company mailbox — free email providers are refused. A code lands in the
              mailbox; entering it here confirms the domain.
            </div>
            <div className="filters">
              <input type="text" placeholder="recruitment@yourclub.com" value={verifyEmail} onChange={(e) => setVerifyEmail(e.target.value)} />
              <button onClick={async () => {
                try {
                  await api.requestEmailVerification(session, verifyEmail.trim());
                  setCodeSent(true);
                  notify('Verification code sent — check the mailbox.');
                } catch (e) {
                  notify(e instanceof Error ? e.message : 'Could not send the code', true);
                }
              }}>Send code</button>
              {codeSent && (
                <>
                  <input type="text" placeholder="6-char code" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} style={{ maxWidth: 140 }} />
                  <button className="primary" onClick={async () => {
                    try {
                      const r = await api.confirmEmailVerification(session, verifyCode.trim());
                      session.org.emailDomainVerified = true;
                      session.org.emailDomain = r.emailDomain;
                      notify(`Domain @${r.emailDomain} verified.`);
                    } catch (e) {
                      notify(e instanceof Error ? e.message : 'Code rejected', true);
                    }
                  }}>Confirm</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      <div className="section">
        <h4>Invoices — success fees</h4>
        {invoices.length === 0 && <div className="notice">No invoices yet. A signing recorded inside the attribution window issues one automatically.</div>}
        {invoices.map((inv) => (
          <div key={inv.id} className="list-row">
            <span>{inv.description}</span>
            <span className="pill gold">€{inv.amount}</span>
            <span className="pill">{inv.status}</span>
            <span className="pill blue">{new Date(inv.ts).toLocaleDateString()}</span>
          </div>
        ))}
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
  const [trialDetails, setTrialDetails] = useState<TrialDetails>({});
  const [reporting, setReporting] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [moreLike, setMoreLike] = useState<(Player & { similarity: number })[] | null>(null);

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
      await api.sendRequest(session, playerId, requestType, message, requestType === 'trial' ? trialDetails : undefined);
      notify(minor
        ? `Sent to the parent/guardian. ${session.org.name} (${session.role}) has requested to discuss a ${requestType === 'trial' ? 'trial' : 'conversation'} — the guardian decides.`
        : `${requestType === 'trial' ? 'Trial' : 'Contact'} request sent to the player's Scout Inbox. Contact unlocks only if they accept.`);
      setRequestType(null); setMessage(''); setTrialDetails({});
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
                  {typeof player.distanceKm === 'number' && <span className="pill blue">{player.distanceKm} km from your ground</span>}
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
              <button onClick={() => api.moreLikeThis(session, playerId).then((r) => setMoreLike(r.players)).catch((e) => notify(errMsg(e), true))}>≈ More like this</button>
              {!player.guardianManaged && (
                <button onClick={async () => {
                  if (!window.confirm(`Record the signing of ${player.name} by ${session.org.name}? This freezes the attribution evidence and notifies the player.`)) return;
                  try {
                    const s = await api.recordSigning(session, playerId);
                    notify(`🎉 Signing recorded${s.insideAttributionWindow ? ' — inside the attribution window' : ''}. Timeline updated.`);
                  } catch (e) { notify(errMsg(e), true); }
                }}>✍ Record signing</button>
              )}
              <button onClick={() => setReporting(true)}>⚑ Report</button>
            </div>

            {moreLike && (
              <div className="section">
                <h4>More like {player.name}</h4>
                <div className="list-rows">
                  {moreLike.slice(0, 6).map((m) => (
                    <div key={m.id} className="list-row" style={{ cursor: 'pointer' }}>
                      <span className="pill blue">{m.position}</span>
                      <span className="grow">{m.name}</span>
                      <span className="dim">{m.similarity}% similar · trust {m.trustScore}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="section">
              <h4>Internal notes — your org only, never visible to the player</h4>
              <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                <input style={{ flex: 1 }} placeholder='e.g. "Watched live 12/8 — second viewing needed"' value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
                <button onClick={async () => {
                  if (!noteDraft.trim()) return;
                  try {
                    await api.addNote(session, playerId, noteDraft.trim());
                    setNoteDraft('');
                    setPlayer(await api.getPlayer(session, playerId));
                  } catch (e) { notify(errMsg(e), true); }
                }}>Add note</button>
              </div>
              <div className="list-rows">
                {(player.orgNotes ?? []).map((n: OrgNote) => (
                  <div key={n.id} className="list-row">
                    <span className="grow" style={{ fontSize: 13 }}>{n.text}</span>
                    <span className="dim">{n.scoutName} · {new Date(n.ts).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </div>

            {requestType && (
              <div className="section">
                <h4>
                  {player.guardianManaged
                    ? `${requestType === 'trial' ? 'Trial invitation' : 'Conversation request'} — goes to the parent/guardian`
                    : `${requestType} request — goes to the player's Scout Inbox`}
                </h4>
                {requestType === 'trial' && (
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <input type="date" title="Proposed date" value={trialDetails.proposedDate ?? ''} onChange={(e) => setTrialDetails({ ...trialDetails, proposedDate: e.target.value || undefined })} />
                    <input type="date" title="Alternative slot 1" value={trialDetails.altSlots?.[0] ?? ''} onChange={(e) => setTrialDetails({ ...trialDetails, altSlots: [e.target.value, trialDetails.altSlots?.[1] ?? ''].filter(Boolean) })} />
                    <input type="date" title="Alternative slot 2" value={trialDetails.altSlots?.[1] ?? ''} onChange={(e) => setTrialDetails({ ...trialDetails, altSlots: [trialDetails.altSlots?.[0] ?? '', e.target.value].filter(Boolean) })} />
                    <input style={{ flex: 1 }} placeholder="Venue (e.g. Eastport Training Centre)" value={trialDetails.venue ?? ''} onChange={(e) => setTrialDetails({ ...trialDetails, venue: e.target.value || undefined })} />
                    <input style={{ flex: 1 }} placeholder="What to bring / notes" value={trialDetails.notes ?? ''} onChange={(e) => setTrialDetails({ ...trialDetails, notes: e.target.value || undefined })} />
                  </div>
                )}
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

            {(player.drillResults?.length ?? 0) > 0 && (
              <div className="section">
                <h4>At-home combine (video-verified drills)</h4>
                <div className="list-rows">
                  {player.drillResults!.map((r) => (
                    <div key={r.id} className="list-row">
                      {r.verified ? <span className="pill green">🎥 verified</span> : <span className="pill">self-reported</span>}
                      <span className="grow">{r.drillName}</span>
                      <span className="dim">{r.metric}: <b style={{ color: 'var(--text)' }}>{r.value}{r.unit}</b> · {new Date(r.ts).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                  <div key={m.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="pill blue">{m.kind}</span>
                      {m.verifiedClip && <span className="pill green">✅ Verified Clip — confirmed fixture</span>}
                      <span className="grow">{m.title}</span>
                      <span className="dim">{m.views ?? 0} view{(m.views ?? 0) === 1 ? '' : 's'} · {new Date(m.uploadedAt).toLocaleDateString()}</span>
                    </div>
                    {Object.keys(m.tags ?? {}).length > 0 && (
                      <div className="badges">
                        {Object.entries(m.tags!).map(([t, n]) => <span key={t} className="pill gold">{TAG_LABELS[t] ?? t} ×{n}</span>)}
                      </div>
                    )}
                    {api.mediaUrl(m.url) && <video className="clip" controls preload="metadata" src={api.mediaUrl(m.url)!} />}
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
