import { useCallback, useEffect, useState } from 'react';
import { api, DEMO_MODE, type Notification, type Org, type Session } from './api';
import {
  SearchScreen, ShortlistScreen, RequestsScreen, MessagesScreen, TrialsScreen,
  LedgerScreen, ReputationScreen, PlanScreen, PlayerDrawer, Toast, SafetyModal,
} from './screens';

const ROLES = ['Head of Recruitment', 'First-Team Scout', 'Academy Coach', 'Agent'];

const SESSION_KEY = 'scoutbox-club-session';

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export type ScreenId = 'search' | 'shortlist' | 'requests' | 'messages' | 'trials' | 'ledger' | 'reputation' | 'plan';

const NAV: { id: ScreenId; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'shortlist', label: 'Shortlist' },
  { id: 'requests', label: 'Requests' },
  { id: 'messages', label: 'Messages' },
  { id: 'trials', label: 'Trials & Reports' },
  { id: 'ledger', label: 'Discovery Ledger' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'plan', label: 'Plan & Compliance' },
];

export default function App() {
  // Sessions persist across refreshes (cleared by "Switch org").
  const [session, setSession] = useState<Session | null>(loadSession);

  const login = (s: Session) => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode */ }
    setSession(s);
  };
  const logout = () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
    setSession(null);
  };

  // A restored session's user id may be stale (in-memory server restarts);
  // re-login once with the stored identity to mint a fresh one.
  useEffect(() => {
    const restored = loadSession();
    if (!restored) return;
    api.login(restored.org.id, restored.scoutName, restored.role)
      .then(login)
      .catch(logout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return session ? <Workspace session={session} onLogout={logout} /> : <Login onLogin={login} />;
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scoutName, setScoutName] = useState('');
  const [role, setRole] = useState(ROLES[0]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listOrgs().then(setOrgs).catch(() => setError('Cannot reach scoutbox-server on localhost:4000 — start it first.'));
  }, []);

  const enter = async () => {
    if (!selected) return setError('Pick an organisation.');
    if (!scoutName.trim()) return setError('Enter your name — every session is attributed to a named individual.');
    try {
      onLogin(await api.login(selected, scoutName, role));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    }
  };

  return (
    <div className="login">
      <div style={{ textAlign: 'center' }}>
        <h1>Scout<span>Box</span></h1>
        <div className="tagline">The recruitment OS. Every action attributed. No unsolicited contact.</div>
        {DEMO_MODE && <div className="pill blue" style={{ marginTop: 10 }}>Self-contained demo — no server needed</div>}
      </div>
      <div className="org-grid">
        {orgs.map((o) => (
          <button key={o.id} className={`org-card ${selected === o.id ? 'selected' : ''}`} onClick={() => setSelected(o.id)}>
            <span className="org-name">{o.name}</span>
            <span>
              <span className={`pill ${o.type === 'agency' ? 'red' : 'blue'}`}>{o.type}</span>{' '}
              <span className="pill">{o.plan}</span>{' '}
              {o.trustedPartner && <span className="pill gold">Trusted Partner</span>}{' '}
              {o.type === 'club' && (o.verified
                ? <span className="pill green">Verified</span>
                : <span className="pill">verification pending</span>)}
            </span>
          </button>
        ))}
      </div>
      <div className="enter-row">
        <input
          placeholder="Your name (scout / coach / agent)"
          value={scoutName}
          onChange={(e) => setScoutName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && enter()}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <button className="primary" onClick={enter}>Enter workspace</button>
      </div>
      {error && <div className="notice block">{error}</div>}
    </div>
  );
}

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [screen, setScreen] = useState<ScreenId>('search');
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumped by live sync to refetch screens
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [bellOpen, setBellOpen] = useState(false);

  useEffect(() => api.onChange(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    api.getNotifications(session).then(setNotifications).catch(() => {});
  }, [session, tick]);

  const unread = notifications.filter((n) => !n.read).length;

  const openBell = async () => {
    setBellOpen(!bellOpen);
    if (!bellOpen && unread > 0) {
      try {
        await api.markNotificationsRead(session);
        setNotifications(await api.getNotifications(session));
      } catch { /* stays unread */ }
    }
  };

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const props = { session, tick, notify, openPlayer: setOpenPlayerId };

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Scout<span>Box</span></div>
        {NAV.map((n) => (
          <button key={n.id} className={screen === n.id ? 'active' : ''} onClick={() => setScreen(n.id)}>
            {n.label}
          </button>
        ))}
        <div className="spacer" />
        <div className="whoami">
          <b>{session.scoutName}</b>
          {session.role} · {session.org.name} · {session.org.plan}
          <div style={{ marginTop: 8 }}>
            <button onClick={onLogout} style={{ padding: 0, color: 'var(--accent-2)' }}>Switch org</button>
          </div>
        </div>
      </nav>
      <div className="main">
        <div className="topbar">
          <h2>{NAV.find((n) => n.id === screen)?.label}</h2>
          {session.org.trustedPartner && <span className="pill gold">Trusted Partner</span>}
          {session.org.type === 'club' && (session.org.verified
            ? <span className="pill green">Verified club</span>
            : <span className="pill">verification pending — U18 hidden</span>)}
          <span className={`pill ${session.org.type === 'agency' ? 'red' : 'blue'}`}>{session.org.type}</span>
          <span className="pill outline-green">● live sync</span>
          <button onClick={openBell} title="Notifications" style={{ position: 'relative' }}>
            🔔{unread > 0 && <span className="bell-badge">{unread}</span>}
          </button>
          <button onClick={() => setSafetyOpen(true)} title="One-click reporting — available on every screen">⚑ Report / Block</button>
        </div>
        {bellOpen && (
          <div className="bell-panel">
            {notifications.length === 0 && <div className="notice">Nothing yet — you'll hear the moment a player or guardian responds.</div>}
            {notifications.slice(0, 20).map((n) => (
              <div key={n.id} className="list-row" style={{ opacity: n.read ? 0.7 : 1 }}>
                <span className="grow" style={{ fontSize: 13 }}>{n.text}</span>
                <span className="dim">{new Date(n.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
        <div className="content">
          {screen === 'search' && <SearchScreen {...props} />}
          {screen === 'shortlist' && <ShortlistScreen {...props} />}
          {screen === 'requests' && <RequestsScreen {...props} />}
          {screen === 'messages' && <MessagesScreen {...props} />}
          {screen === 'trials' && <TrialsScreen {...props} />}
          {screen === 'ledger' && <LedgerScreen {...props} />}
          {screen === 'reputation' && <ReputationScreen {...props} />}
          {screen === 'plan' && <PlanScreen {...props} />}
        </div>
      </div>
      {openPlayerId && (
        <PlayerDrawer session={session} playerId={openPlayerId} notify={notify} onClose={() => setOpenPlayerId(null)} />
      )}
      {safetyOpen && <SafetyModal session={session} notify={notify} onClose={() => setSafetyOpen(false)} />}
      {toast && <Toast text={toast.text} error={toast.error} />}
    </div>
  );
}
