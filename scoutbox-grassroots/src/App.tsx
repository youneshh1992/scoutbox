import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, DEMO_MODE, type Channel, type Notification, type Org, type Session } from './api';
import {
  FeedScreen, FilmRoomScreen, SearchScreen, ShortlistScreen, RequestsScreen, MessagesScreen,
  TrialsScreen, OpenDaysScreen, SquadScreen, FriendliesScreen, FixturesScreen, LedgerScreen, FunnelScreen, PlanScreen,
  PlayerDrawer, Toast, SafetyModal,
} from './screens';
import {
  AssessmentsScreen, RecruitmentScreen, OpportunitiesScreen,
  CampaignsScreen, VideoScreen, OutcomesScreen, TrialDaysScreen, CoachesScreen,
} from './m12screens';
import {
  ImportsScreen, CoverageScreen, CalibrationScreen, InsightScreen,
  NetworkScreen, OrganisationScreen,
} from './m13screens';
import { VerificationScreen } from './m14screens';
import { RoomsScreen } from './roomsScreens';
import { m14 } from './m14api';
import {
  hashForRoom, hashForScreen, loadCollapsed, loadShortcuts, resolveNavigationLocation,
  roomFromHash, saveCollapsed, saveShortcuts, screenFromHash, NAV_SECTIONS, type NavContext,
} from './nav';
import { CommandPalette, NeedsAttention, Sidebar, SecondaryNav, useNavSections, usePaletteHotkey } from './navui';
import { Icon } from './icons';
import { getLang, setLang, t } from './i18n';

const ROLES = ['Manager', 'Coach', 'Volunteer Scout', 'Club Secretary'];

const SESSION_KEY = 'scoutbox-grassroots-session';

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export type ScreenId =
  | 'feed' | 'filmroom' | 'search' | 'shortlist' | 'requests' | 'messages' | 'trials' | 'opendays'
  | 'squad' | 'friendlies' | 'fixtures' | 'ledger' | 'funnel' | 'plan'
  | 'assessments' | 'recruitment' | 'coaches' | 'opportunities' | 'campaigns' | 'video' | 'outcomes' | 'trialdays'
  | 'insight' | 'coverage' | 'calibration' | 'imports' | 'network' | 'organisation' | 'verification'
  | 'rooms';

// M15-Nav: the flat sidebar list is gone — the information architecture
// lives in src/nav.ts (sections → child tabs) and also drives the command
// palette, resolver and shortcuts. Every ScreenId stays deep-linkable as
// "#/<screenId>"; nothing was removed or renamed.

export default function App() {
  // Sessions persist across refreshes (cleared by "Switch org").
  const [session, setSession] = useState<Session | null>(loadSession);

  const login = (s: Session) => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode */ }
    setSession(s);
  };
  const logout = () => {
    try {
      localStorage.removeItem(SESSION_KEY);
      // Offline drafts are identity-scoped and cleared on logout (F12C).
      const stale = session ? Object.keys(localStorage).filter((k) => k.startsWith(`sbdraft:${session.org.id}:${session.userId}:`)) : [];
      for (const k of stale) localStorage.removeItem(k);
    } catch { /* private mode */ }
    setSession(null);
  };

  // Session restore validates the stored bearer token instead of silently
  // re-logging in (which cannot supply a provisioned club password). A 401/403
  // means the session expired — back to login; transient network failures keep
  // the session and the workspace shows its reconnecting state.
  useEffect(() => {
    const restored = loadSession();
    if (!restored) return;
    api.getNotifications(restored).catch((e) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) logout();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return session ? <Workspace session={session} onLogout={logout} /> : <Login onLogin={login} />;
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scoutName, setScoutName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(ROLES[0]);
  const [error, setError] = useState<string | null>(null);
  const [reg, setReg] = useState({ name: '', federation: '', registrationId: '', city: '', lat: '', lng: '', scoutName: '' });

  useEffect(() => {
    api.listOrgs().then(setOrgs).catch(() => setError('Cannot reach scoutbox-server on localhost:4000 — start it first.'));
  }, []);

  const enter = async () => {
    if (!selected) return setError('Pick an organisation.');
    if (!scoutName.trim()) return setError('Enter your name — every session is attributed to a named individual.');
    try {
      onLogin(await api.login(selected, scoutName, role, password || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    }
  };

  return (
    <div className="login">
      <div style={{ textAlign: 'center' }}>
        <h1>Scout<span>Box</span> <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-2)' }}>Grassroots</span></h1>
        <div className="tagline">Local football only: federation-registered grassroots clubs scouting within 50km of their ground. Every action attributed. No unsolicited contact.</div>
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
          placeholder="Your name (manager / coach / volunteer)"
          value={scoutName}
          onChange={(e) => setScoutName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && enter()}
        />
        <input
          type="password"
          placeholder="Club password (if provisioned)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && enter()}
          style={{ width: 200 }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <button className="primary" onClick={enter}>Enter workspace</button>
      </div>
      {error && <div className="notice block">{error}</div>}
      <div className="register-box">
        <h3>Register your club</h3>
        <p className="dim" style={{ margin: '4px 0 10px', fontSize: 13 }}>
          ScoutBox Grassroots is for federation-registered semi-pro and amateur clubs only. Scouting is
          limited to players within 50km of your ground; adults are visible immediately, under-18s only
          after verification and the safeguarding contract.
        </p>
        <div className="reg-grid">
          <input placeholder="Club name" value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} />
          <input placeholder="Federation (e.g. The FA — England)" value={reg.federation} onChange={(e) => setReg({ ...reg, federation: e.target.value })} />
          <input placeholder="Federation registration id" value={reg.registrationId} onChange={(e) => setReg({ ...reg, registrationId: e.target.value })} />
          <input placeholder="Town / city" value={reg.city} onChange={(e) => setReg({ ...reg, city: e.target.value })} />
          <input placeholder="Ground latitude (e.g. 51.55)" value={reg.lat} onChange={(e) => setReg({ ...reg, lat: e.target.value })} />
          <input placeholder="Ground longitude (e.g. -0.02)" value={reg.lng} onChange={(e) => setReg({ ...reg, lng: e.target.value })} />
          <input placeholder="Your name" value={reg.scoutName} onChange={(e) => setReg({ ...reg, scoutName: e.target.value })} />
          <button
            className="primary"
            onClick={async () => {
              setError(null);
              try {
                onLogin(await api.registerGrassroots({
                  name: reg.name.trim(), federation: reg.federation.trim(), registrationId: reg.registrationId.trim(),
                  city: reg.city.trim(), lat: Number(reg.lat), lng: Number(reg.lng), scoutName: reg.scoutName.trim(), role: 'Manager',
                }));
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Registration failed');
              }
            }}
          >Register club</button>
        </div>
      </div>
    </div>
  );
}

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  // Deep links: the hash IS the screen id ("#/verification"). Unknown or
  // absent hashes land on Home without highlighting a wrong section.
  const [screen, setScreenState] = useState<ScreenId>(() => screenFromHash(window.location.hash) ?? 'feed');
  // M17: the first parameterised route. The room id lives beside the screen id
  // so back/forward/refresh/deep-entry all land on exactly the same place.
  const [roomId, setRoomId] = useState<string | null>(() => roomFromHash(window.location.hash));
  const setScreen = useCallback((id: ScreenId) => {
    setScreenState(id);
    setRoomId(null);
    try { if (window.location.hash !== hashForScreen(id)) window.history.replaceState(null, '', hashForScreen(id)); } catch { /* sandboxed */ }
  }, []);
  /** Opening a room PUSHES, so the browser Back button closes it again. */
  const openRoom = useCallback((id: string) => {
    setScreenState('rooms');
    setRoomId(id);
    try { if (window.location.hash !== hashForRoom(id)) window.history.pushState(null, '', hashForRoom(id)); } catch { /* sandboxed */ }
  }, []);
  const closeRoom = useCallback(() => {
    setScreenState('rooms');
    setRoomId(null);
    try { if (window.location.hash !== hashForScreen('rooms')) window.history.pushState(null, '', hashForScreen('rooms')); } catch { /* sandboxed */ }
  }, []);
  useEffect(() => {
    const onHash = () => {
      const id = screenFromHash(window.location.hash);
      if (id) setScreenState(id);
      setRoomId(roomFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
  }, []);

  // Verification authority — fetched ONCE per session for the nav filter.
  // Convenience only: the server keeps enforcing every permission.
  const [verLevel, setVerLevel] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    m14.me(session).then((me) => { if (!gone) setVerLevel(me.verificationLevel ?? null); }).catch(() => { if (!gone) setVerLevel(null); });
    return () => { gone = true; };
  }, [session]);
  const navCtx: NavContext = { role: session.role, verLevel };
  const sections = useNavSections(navCtx);
  const loc = resolveNavigationLocation(screen);
  const activeSection = sections.find((s) => s.id === loc.sectionId) ?? null;

  const [shortcuts, setShortcuts] = useState<ScreenId[]>([]);
  useEffect(() => { setShortcuts(loadShortcuts(session.org.id, session.userId, navCtx)); }, [session, verLevel]); // eslint-disable-line react-hooks/exhaustive-deps
  const togglePin = useCallback((id: ScreenId) => {
    setShortcuts((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveShortcuts(session.org.id, session.userId, next);
      return next;
    });
  }, [session]);

  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => { saveCollapsed(!c); return !c; }), []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePaletteHotkey(useCallback(() => setPaletteOpen(true), []));

  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumped by live sync to refetch screens
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const seenNotifIds = useRef<Set<string> | null>(null);

  const [live, setLive] = useState(true);
  const [lang, setLangState] = useState(getLang());
  const [, setLangTick] = useState(0);
  useEffect(() => {
    const onLang = () => setLangState(getLang());
    window.addEventListener('sb-lang', onLang);
    return () => window.removeEventListener('sb-lang', onLang);
  }, []);
  useEffect(() => api.onChange(session, (event, payload) => {
    if (event === 'sse_status') { setLive((payload as { connected?: boolean } | undefined)?.connected !== false); return; }
    if (event === 'typing') return; // transient — handled inside Messages
    setTick((t) => t + 1);
  }), [session]);

  useEffect(() => {
    api.getNotifications(session).then(setNotifications).catch(() => {});
    api.getChannels(session).then(setChannels).catch(() => {});
  }, [session, tick]);

  const unread = notifications.filter((n) => !n.read).length;

  // Unread messages: anything from the player/guardian side newer than the
  // last time we opened that thread.
  const unreadMessages = channels.reduce(
    (sum, c) => sum + c.messages.filter((m) => m.sender.kind !== 'org_user' && m.ts > (c.readBy?.org ?? 0)).length,
    0
  );

  // Pop up a toast the moment something new lands (messages, acceptances…).
  useEffect(() => {
    if (seenNotifIds.current === null) {
      seenNotifIds.current = new Set(notifications.map((n) => n.id));
      return;
    }
    const fresh = notifications.filter((n) => !n.read && !seenNotifIds.current!.has(n.id));
    for (const n of notifications) seenNotifIds.current.add(n.id);
    if (fresh.length > 0) notify(`🔔 ${fresh[0].text}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications]);

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

  const breadcrumbSection = NAV_SECTIONS.find((s) => s.id === loc.sectionId) ?? null;
  const screenLabel = t((loc.itemId ? (NAV_SECTIONS.flatMap((s) => s.children).find((c) => c.id === screen)?.labelKey ?? `nav.${screen}`) : `nav.${screen}`) as Parameters<typeof t>[0]);

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <Sidebar
        sections={sections}
        location={loc}
        onNavigate={setScreen}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        shortcuts={shortcuts}
        onTogglePin={togglePin}
        unreadMessages={unreadMessages}
        onOpenPalette={() => setPaletteOpen(true)}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        footer={
          <div className="whoami">
            <b>{session.scoutName}</b>
            {session.role} · {session.org.name} · {session.org.plan}
            <div style={{ marginTop: 6 }}>
              <button onClick={() => setScreen('verification')} style={{ padding: 0, color: 'var(--muted)', fontSize: 12 }}>{t('navsec.myVerification')}</button>
            </div>
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 12 }} title={t('common.machineTranslated')}>
                {t('common.language')}:{' '}
                <select aria-label={t('common.language')} value={lang} onChange={(e) => { setLang(e.target.value as 'en' | 'fr'); setLangTick((x) => x + 1); }}>
                  <option value="en">English</option>
                  <option value="fr">Français (trad. automatique)</option>
                </select>
              </label>
            </div>
            <div style={{ marginTop: 6 }}>
              <button onClick={onLogout} style={{ padding: 0, color: 'var(--accent-2)' }}>Switch org</button>
            </div>
          </div>
        }
      />
      <div className="main">
        <div className="topbar">
          <button className="nav-hamburger" aria-label={t('navsec.openMenu')} onClick={() => setDrawerOpen(true)}><Icon name="menu" /></button>
          <h2>
            {breadcrumbSection && breadcrumbSection.children.length > 1 && (
              <><span className="crumb">{t(breadcrumbSection.labelKey as Parameters<typeof t>[0])}</span><span className="crumb-sep"> / </span></>
            )}
            {screenLabel}
          </h2>
          {session.org.trustedPartner && <span className="pill gold">Trusted Partner</span>}
          {session.org.safeguardingCertified && <span className="pill green">🛡 Safeguarding Certified</span>}
          {session.org.type === 'club' && (session.org.verified
            ? <span className="pill outline-green">Verified club</span>
            : <span className="pill">verification pending — U18 hidden</span>)}
          <span className={`pill ${session.org.type === 'agency' ? 'red' : 'blue'}`}>{session.org.type}</span>
          {live ? <span className="pill outline-green">● live sync</span> : <span className="pill red">○ reconnecting — updates resume automatically</span>}
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
        {activeSection && <SecondaryNav section={activeSection} activeItemId={loc.itemId} onNavigate={setScreen} />}
        <div className="content">
          {screen === 'feed' && (
            <NeedsAttention session={session} tick={tick} unreadMessages={unreadMessages} verLevel={verLevel} onNavigate={setScreen} />
          )}
          {screen === 'feed' && <FeedScreen {...props} />}
          {screen === 'filmroom' && <FilmRoomScreen {...props} />}
          {screen === 'opendays' && <OpenDaysScreen {...props} />}
          {screen === 'squad' && <SquadScreen {...props} />}
          {screen === 'friendlies' && <FriendliesScreen {...props} />}
          {screen === 'fixtures' && <FixturesScreen {...props} />}
          {screen === 'search' && <SearchScreen {...props} />}
          {screen === 'shortlist' && <ShortlistScreen {...props} />}
          {screen === 'requests' && <RequestsScreen {...props} />}
          {screen === 'messages' && <MessagesScreen {...props} />}
          {screen === 'trials' && <TrialsScreen {...props} />}
          {screen === 'ledger' && <LedgerScreen {...props} />}
          {screen === 'funnel' && <FunnelScreen {...props} />}
          {screen === 'plan' && <PlanScreen {...props} />}
          {screen === 'assessments' && <AssessmentsScreen {...props} />}
          {screen === 'recruitment' && <RecruitmentScreen {...props} />}
          {screen === 'rooms' && <RoomsScreen {...props} roomId={roomId} onOpenRoom={openRoom} onCloseRoom={closeRoom} />}
          {screen === 'coaches' && <CoachesScreen {...props} />}
          {screen === 'opportunities' && <OpportunitiesScreen {...props} />}
          {screen === 'campaigns' && <CampaignsScreen {...props} />}
          {screen === 'video' && <VideoScreen {...props} />}
          {screen === 'outcomes' && <OutcomesScreen {...props} />}
          {screen === 'trialdays' && <TrialDaysScreen {...props} />}
          {screen === 'imports' && <ImportsScreen {...props} />}
          {screen === 'coverage' && <CoverageScreen {...props} />}
          {screen === 'calibration' && <CalibrationScreen {...props} />}
          {screen === 'insight' && <InsightScreen {...props} />}
          {screen === 'network' && <NetworkScreen {...props} />}
          {screen === 'organisation' && <OrganisationScreen {...props} />}
          {screen === 'verification' && <VerificationScreen {...props} />}
        </div>
      </div>
      {openPlayerId && (
        <PlayerDrawer
          session={session}
          playerId={openPlayerId}
          notify={notify}
          onClose={() => setOpenPlayerId(null)}
          onOpenRoom={(id) => { setOpenPlayerId(null); openRoom(id); }}
        />
      )}
      {safetyOpen && <SafetyModal session={session} notify={notify} onClose={() => setSafetyOpen(false)} />}
      <CommandPalette
        ctx={navCtx}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setScreen}
        shortcuts={shortcuts}
        onTogglePin={togglePin}
      />
      {toast && <Toast text={toast.text} error={toast.error} />}
    </div>
  );
}
