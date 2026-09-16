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
import { BriefsScreen, NobodyMissedScreen, SecondLookScreen } from './m18Screens';
import { MatchingScreen, WatchlistsScreen } from './m19Screens';
import { DirectorDashboardScreen } from './m20Screens';
import type { DashboardFilters } from './m20Api';
import { m14 } from './m14api';
import {
  briefFromHash, criteriaFromHash, hashForBrief, hashForMatching, hashForRoom, hashForScreen,
  dashboardFromHash, hashForDashboard,
  hashForWatchlist, loadCollapsed, loadShortcuts, resolveNavigationLocation, roomFromHash,
  saveCollapsed, saveShortcuts, screenFromHash, watchlistFromHash,
  NAV_SECTIONS, type NavContext,
} from './nav';
import { CommandPalette, NeedsAttention, OrgChips, Sidebar, SecondaryNav, TopBar, useNavSections, usePaletteHotkey } from './navui';
import { fmtStamp, getLang, setLang, t } from './i18n';
import { confirmLeave, guardHashChange, installDirtyGuard, noteNavigated } from './dirtyGuard';

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
  | 'rooms'
  | 'secondlook' | 'nobodymissed' | 'briefs'
  | 'matching' | 'watchlists'
  | 'dashboard';

// M15-Nav: the flat sidebar list is gone — the information architecture
// lives in src/nav.ts (sections → child tabs) and also drives the command
// palette, resolver and shortcuts. Every ScreenId stays deep-linkable as
// "#/<screenId>"; nothing was removed or renamed.


// ---------------------------------------------------------------- M18.1 bell
/**
 * Where a notification leads. A notification you cannot act on is only an
 * interruption: the bell rendered the sentence and a time and dropped both the
 * type and the refId, so "someone assigned you a task in the Recruitment Room
 * for X" left you to go and find it. Rows with a destination are now buttons.
 *
 * A type that is NOT in this table stays plain text. Sending someone to an
 * approximately-right screen is worse than not offering the jump, and this
 * table is deliberately incomplete rather than speculatively full.
 */
const NOTIFICATION_SCREEN: Record<string, ScreenId> = {
  second_look: 'secondlook',
  recruitment_room: 'rooms',
  verification: 'verification',
  case: 'recruitment',
  application: 'opportunities',
  accepted: 'messages',
  declined: 'messages',
  message: 'messages',
  open_trial: 'trials',
  trial_day: 'trialdays',
  outcome: 'outcomes',
  campaign: 'campaigns',
  review_queue: 'campaigns',
  coverage: 'coverage',
  calibration: 'calibration',
  saved_search: 'search',
};

interface BellRow { n: Notification; count: number; unread: boolean }

/**
 * Collapse repeats. The server already coalesces an identical notification the
 * recipient has not read yet; this also folds together copies that straddle a
 * read, so twenty rows in the bell are twenty different things. The newest
 * occurrence is kept, the count is summed, and the row counts as unread if ANY
 * of its occurrences is — a row must never look dealt-with while the badge
 * still counts it.
 */
function bellRows(items: Notification[]): BellRow[] {
  const rows = new Map<string, BellRow>();
  for (const n of items) { // newest first
    const key = `${n.type}|${n.refId ?? ''}|${n.text}`;
    const hit = rows.get(key);
    if (hit) { hit.count += n.repeatCount ?? 1; hit.unread = hit.unread || !n.read; continue; }
    rows.set(key, { n, count: n.repeatCount ?? 1, unread: !n.read });
  }
  return [...rows.values()];
}


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
  // re-logging in (which cannot supply a provisioned club password). A 401
  // means the session expired — back to login; transient network failures keep
  // the session and the workspace shows its reconnecting state.
  useEffect(() => {
    const restored = loadSession();
    if (!restored) return;
    api.getNotifications(restored).catch((e) => {
      // M18.2 — only a 401 ends the session. A 403 is a permission answer
      // about ONE request; treating it as "signed out" threw people out of
      // the workspace for opening a screen they were not allowed to see.
      if (e instanceof ApiError && e.status === 401) logout();
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
          className="login-pw"
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
  // M18 reuses that same mechanism for "#/recruitment/briefs/:briefId".
  const [briefId, setBriefId] = useState<string | null>(() => briefFromHash(window.location.hash));
  // M19 reuses it a third time: one watchlist id, and the opaque criteria
  // state a matching link carries.
  const [watchlistId, setWatchlistId] = useState<string | null>(() => watchlistFromHash(window.location.hash));
  const [matchState, setMatchState] = useState<string | null>(() => criteriaFromHash(window.location.hash));
  // M20 reuses it a fourth time: the Director Dashboard's window and filters
  // live in the hash so a director can send a colleague the exact view they
  // are reading. None of these filters names a person.
  const [dashFilters, setDashFilters] = useState<DashboardFilters>(() => (dashboardFromHash(window.location.hash) ?? {}) as DashboardFilters);
  // M18.2 — every programmatic navigation asks the dirty-guard first. A form
  // with nothing unsaved never triggers it.
  const setScreen = useCallback((id: ScreenId) => {
    if (!confirmLeave(t('brief.unsaved'))) return;
    setScreenState(id);
    setRoomId(null);
    setBriefId(null);
    setWatchlistId(null);
    if (id !== 'matching') setMatchState(null);
    if (id !== 'dashboard') setDashFilters({});
    try { if (window.location.hash !== hashForScreen(id)) window.history.replaceState(null, '', hashForScreen(id)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /** Opening a room PUSHES, so the browser Back button closes it again. */
  const openRoom = useCallback((id: string) => {
    if (!confirmLeave(t('brief.unsaved'))) return;
    setScreenState('rooms');
    setBriefId(null);
    setRoomId(id);
    try { if (window.location.hash !== hashForRoom(id)) window.history.pushState(null, '', hashForRoom(id)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  const closeRoom = useCallback(() => {
    setScreenState('rooms');
    setRoomId(null);
    try { if (window.location.hash !== hashForScreen('rooms')) window.history.pushState(null, '', hashForScreen('rooms')); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /** Opening a brief PUSHES, so the browser Back button closes it again. */
  const openBrief = useCallback((id: string) => {
    if (!confirmLeave(t('brief.unsaved'))) return;
    setScreenState('briefs');
    setRoomId(null);
    setBriefId(id);
    try { if (window.location.hash !== hashForBrief(id)) window.history.pushState(null, '', hashForBrief(id)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  const closeBrief = useCallback(() => {
    if (!confirmLeave(t('brief.unsaved'))) return;
    setScreenState('briefs');
    setBriefId(null);
    try { if (window.location.hash !== hashForScreen('briefs')) window.history.pushState(null, '', hashForScreen('briefs')); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /** Opening a Dynamic Watchlist PUSHES, so Back closes it again. */
  const openWatchlist = useCallback((id: string) => {
    if (!confirmLeave(t('brief.unsaved'))) return;
    setScreenState('watchlists');
    setRoomId(null);
    setBriefId(null);
    setWatchlistId(id);
    try { if (window.location.hash !== hashForWatchlist(id)) window.history.pushState(null, '', hashForWatchlist(id)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  const closeWatchlist = useCallback(() => {
    if (!confirmLeave(t('brief.unsaved'))) return;
    setScreenState('watchlists');
    setWatchlistId(null);
    try { if (window.location.hash !== hashForScreen('watchlists')) window.history.pushState(null, '', hashForScreen('watchlists')); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /**
   * A criteria set that was actually run becomes the URL, so refresh, Back and
   * a link pasted to a colleague all reproduce the same search. It REPLACES
   * rather than pushes: editing a row is not a navigation, and nobody wants
   * thirty Back presses to leave the editor.
   */
  const publishMatchState = useCallback((encoded: string | null) => {
    setMatchState(encoded);
    try {
      const next = hashForMatching(encoded);
      if (window.location.hash !== next) window.history.replaceState(null, '', next);
    } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /**
   * Changing a dashboard filter REPLACES rather than pushes: adjusting a
   * window is reading, not navigating, and nobody wants six Back presses to
   * leave a dashboard.
   */
  const publishDashFilters = useCallback((f: DashboardFilters) => {
    setDashFilters(f);
    try {
      const next = hashForDashboard(f as Record<string, string | number | undefined | null>);
      if (window.location.hash !== next) window.history.replaceState(null, '', next);
    } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  // M18.2 — close/reload prompt while a form is dirty.
  useEffect(() => installDirtyGuard(), []);
  useEffect(() => {
    const onHash = () => {
      // M18.2 — the dirty-guard decides BEFORE any state changes (see dirtyGuard.ts).
      if (!guardHashChange(() => t('brief.unsaved'))) return;
      const id = screenFromHash(window.location.hash);
      if (id) setScreenState(id);
      setRoomId(roomFromHash(window.location.hash));
      setBriefId(briefFromHash(window.location.hash));
      setWatchlistId(watchlistFromHash(window.location.hash));
      setMatchState(criteriaFromHash(window.location.hash));
      setDashFilters((dashboardFromHash(window.location.hash) ?? {}) as DashboardFilters);
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
        brand={{ short: 'G', long: 'Grassroots' }}
        footer={
          <div className="whoami">
            <b>{session.scoutName}</b>
            {session.role} · {session.org.name} · {session.org.plan}
            <OrgChips org={session.org} />
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
        <TopBar
          title={screenLabel}
          crumb={breadcrumbSection && breadcrumbSection.children.length > 1 ? t(breadcrumbSection.labelKey as Parameters<typeof t>[0]) : null}
          live={live}
          unread={unread}
          bellOpen={bellOpen}
          onToggleBell={openBell}
          onReport={() => setSafetyOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        {bellOpen && (
          <div className="bell-panel">
            {notifications.length === 0 && <div className="notice">Nothing yet — you'll hear the moment a player or guardian responds.</div>}
            {bellRows(notifications).slice(0, 20).map(({ n, count, unread }) => {
              const dest = NOTIFICATION_SCREEN[n.type];
              return (
                <div key={n.id} className="list-row" style={{ opacity: unread ? 1 : 0.7 }}>
                  <span className="grow" style={{ fontSize: 13 }}>
                    {n.text}
                    {count > 1 && <span className="pill" style={{ marginLeft: 6 }}>×{count}</span>}
                  </span>
                  {dest && (
                    <button onClick={() => { setScreen(dest); setBellOpen(false); }}>{t('common.open')}</button>
                  )}
                  <span className="dim">{fmtStamp(n.ts)}</span>
                </div>
              );
            })}
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
          {screen === 'dashboard' && (
            <DirectorDashboardScreen {...props} filters={dashFilters} onFilters={publishDashFilters} />
          )}
          {screen === 'assessments' && <AssessmentsScreen {...props} />}
          {screen === 'recruitment' && <RecruitmentScreen {...props} />}
          {screen === 'rooms' && <RoomsScreen {...props} roomId={roomId} onOpenRoom={openRoom} onCloseRoom={closeRoom} />}
          {screen === 'secondlook' && <SecondLookScreen {...props} />}
          {screen === 'nobodymissed' && <NobodyMissedScreen {...props} onOpenRoom={openRoom} />}
          {screen === 'briefs' && <BriefsScreen {...props} briefId={briefId} onOpenBrief={openBrief} onCloseBrief={closeBrief} />}
          {screen === 'matching' && (
            <MatchingScreen
              {...props}
              encodedCriteria={matchState}
              onCriteriaState={publishMatchState}
              onOpenWatchlist={openWatchlist}
            />
          )}
          {screen === 'watchlists' && (
            <WatchlistsScreen
              {...props}
              watchlistId={watchlistId}
              onOpenWatchlist={openWatchlist}
              onCloseWatchlist={closeWatchlist}
              onOpenRoom={openRoom}
              onNewWatchlist={() => setScreen('matching')}
            />
          )}
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
