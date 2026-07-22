import { useCallback, useEffect, useState } from 'react';
import { api, DEMO_MODE, type Org, type Session } from './api';
import {
  SearchScreen, ShortlistScreen, RequestsScreen, TrialsScreen,
  LedgerScreen, ReputationScreen, PlanScreen, PlayerDrawer, Toast,
} from './screens';

export type ScreenId = 'search' | 'shortlist' | 'requests' | 'trials' | 'ledger' | 'reputation' | 'plan';

const NAV: { id: ScreenId; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'shortlist', label: 'Shortlist' },
  { id: 'requests', label: 'Requests' },
  { id: 'trials', label: 'Trials & Reports' },
  { id: 'ledger', label: 'Discovery Ledger' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'plan', label: 'Plan & Compliance' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  return session ? <Workspace session={session} onLogout={() => setSession(null)} /> : <Login onLogin={setSession} />;
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scoutName, setScoutName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listOrgs().then(setOrgs).catch(() => setError('Cannot reach scoutbox-server on localhost:4000 — start it first.'));
  }, []);

  const enter = async () => {
    if (!selected) return setError('Pick an organisation.');
    if (!scoutName.trim()) return setError('Enter your name — every session is attributed to a named individual.');
    try {
      onLogin(await api.login(selected, scoutName));
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
              {o.trustedPartner && <span className="pill gold">Trusted Partner</span>}
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

  useEffect(() => api.onChange(() => setTick((t) => t + 1)), []);

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
          {session.org.name} · {session.org.plan}
          <div style={{ marginTop: 8 }}>
            <button onClick={onLogout} style={{ padding: 0, color: 'var(--accent-2)' }}>Switch org</button>
          </div>
        </div>
      </nav>
      <div className="main">
        <div className="topbar">
          <h2>{NAV.find((n) => n.id === screen)?.label}</h2>
          {session.org.trustedPartner && <span className="pill gold">Trusted Partner</span>}
          <span className={`pill ${session.org.type === 'agency' ? 'red' : 'blue'}`}>{session.org.type}</span>
          <span className="pill outline-green">● live sync</span>
        </div>
        <div className="content">
          {screen === 'search' && <SearchScreen {...props} />}
          {screen === 'shortlist' && <ShortlistScreen {...props} />}
          {screen === 'requests' && <RequestsScreen {...props} />}
          {screen === 'trials' && <TrialsScreen {...props} />}
          {screen === 'ledger' && <LedgerScreen {...props} />}
          {screen === 'reputation' && <ReputationScreen {...props} />}
          {screen === 'plan' && <PlanScreen {...props} />}
        </div>
      </div>
      {openPlayerId && (
        <PlayerDrawer session={session} playerId={openPlayerId} notify={notify} onClose={() => setOpenPlayerId(null)} />
      )}
      {toast && <Toast text={toast.text} error={toast.error} />}
    </div>
  );
}
