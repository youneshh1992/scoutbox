import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, DEMO_MODE, type Notification, type Org, type Session } from './api';
import { agent, demoIdentities, isSummary, type Me } from './agentApi';
import {
  AgencyScreen, ClientsScreen, HomeScreen, InboxScreen, OpportunitiesScreen, ProfileScreen, SafetyModal, Toast, markClean,
} from './screens';
import { ComplianceScreen } from './compliance';
import { TransactionsScreen } from './transactions';
import {
  NAV_SECTIONS, type NavContext, type AgencyTab, type ClientTab, type TransactionTab,
  agencyTabFromHash, clientFromHash, contextFromHash, hashForAgency, hashForClient, hashForContext, hashForScreen, loadCollapsed, loadShortcuts,
  resolveNavigationLocation, saveCollapsed, saveShortcuts, screenFromHash, transactionFromHash, hashForTransaction,} from './nav';
import { CommandPalette, NeedsAttention, OrgChips, Sidebar, SecondaryNav, TopBar, useNavSections, usePaletteHotkey } from './navui';
import { fmtStamp, getLang, setLang, t } from './i18n';
import { confirmLeave, guardHashChange, installDirtyGuard, noteNavigated } from './dirtyGuard';

// A job title, not a permission: the agency's administrator sets roles, and
// only a verified licence permits a regulated action (login.roleNote).
const ROLES = ['Agent', 'Director', 'Analyst', 'Assistant', 'Finance'];

const SESSION_KEY = 'scoutbox-agent-session';

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export type ScreenId = 'home' | 'profile' | 'compliance' | 'transactions' | 'clients' | 'opportunities' | 'agency' | 'inbox';

/** Where a notification leads. Types not listed stay plain text. */
const NOTIFICATION_SCREEN: Record<string, ScreenId> = {
  representation_request: 'clients',
  representation_confirmed: 'clients',
  representation_rejected: 'clients',
  representation_terminated: 'clients',
  representation_disputed: 'clients',
  representation_expiring: 'clients',
  agent_verification: 'profile',
  agent_verification_stale: 'compliance',
  agency_membership: 'agency',
  regulatory_review_required: 'compliance',
  regulatory_review_completed: 'compliance',
  regulatory_consent_requested: 'compliance',
  regulatory_consent_granted: 'compliance',
  regulatory_consent_declined: 'compliance',
  regulatory_consent_revoked: 'compliance',
  // M23 P5.6D: workspace traffic and its compliance half both land on the
  // transaction, because that is where the person can act on either.
  agent_transaction: 'transactions',
  agent_transaction_action: 'transactions',
  agent_transaction_compliance: 'transactions',
};

interface BellRow { n: Notification; count: number; unread: boolean }
function bellRows(items: Notification[]): BellRow[] {
  const rows = new Map<string, BellRow>();
  for (const n of items) {
    const key = `${n.type}|${n.refId ?? ''}|${n.text}`;
    const hit = rows.get(key);
    if (hit) { hit.count += n.repeatCount ?? 1; hit.unread = hit.unread || !n.read; continue; }
    rows.set(key, { n, count: n.repeatCount ?? 1, unread: !n.read });
  }
  return [...rows.values()];
}

export default function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const login = (s: Session) => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode */ }
    setSession(s);
  };
  const logout = () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
    setSession(null);
  };
  useEffect(() => {
    const restored = loadSession();
    if (!restored) return;
    api.getNotifications(restored).catch((e) => { if (e instanceof ApiError && e.status === 401) logout(); });
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
  useEffect(() => {
    api.listOrgs().then((list) => { setOrgs(list); if (list.length === 1) setSelected(list[0].id); }).catch(() => setError(t('login.unreachable')));
  }, []);
  const enter = async (asName = scoutName, asRole = role) => {
    if (!selected) return setError(t('login.pickOrg'));
    if (!asName.trim()) return setError(t('login.nameRequired'));
    try { onLogin(await api.login(selected, asName, asRole, password || undefined)); } catch (e) { setError(e instanceof Error ? e.message : 'Login failed'); }
  };
  return (
    <div className="login">
      <div style={{ textAlign: 'center' }}>
        <h1>Scout<span>Box</span> <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--gold)' }}>Agent</span></h1>
        <div className="tagline">{t('login.tagline')}</div>
        {DEMO_MODE && <div className="pill blue" style={{ marginTop: 10 }}>{t('login.demo')}</div>}
      </div>
      <div className="org-grid">
        {orgs.map((o) => (
          <button key={o.id} className={`org-card ${selected === o.id ? 'selected' : ''}`} onClick={() => setSelected(o.id)}>
            <span className="org-name">{o.name}</span>
            <span><span className="pill red">{o.type}</span> <span className="pill">{o.plan}</span></span>
          </button>
        ))}
      </div>
      {DEMO_MODE && demoIdentities.length > 0 && (
        // The demo's roster, offered rather than guessed. A name that is not on
        // it is refused AGENCY_MEMBERSHIP_REQUIRED — correctly, because only an
        // administrator adds a member — and in a demo there is no administrator
        // to ask, so an unlisted name used to be a dead end.
        <div className="demo-identities" data-testid="demo-identities">
          <p className="tagline" style={{ maxWidth: 560, textAlign: 'center', fontSize: 12.5, margin: '0 0 10px' }}>{t('login.demoWho')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            {demoIdentities.map((d) => (
              <button
                key={d.name}
                className="secondary"
                data-testid={`demo-as-${d.tier}`}
                onClick={() => { setScoutName(d.name); setRole(d.role); void enter(d.name, d.role); }}
                title={t('login.demoAs').replace('{name}', d.name)}
              >
                {d.name} <span className="pill">{d.tier.replace(/_/g, ' ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="enter-row">
        <input placeholder={t('login.name')} value={scoutName} onChange={(e) => setScoutName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && enter()} aria-label={t('login.name')} />
        <input type="password" placeholder={t('login.password')} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && enter()} className="login-pw" aria-label={t('login.password')} />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        <button className="primary" onClick={() => void enter()}>{t('login.enter')}</button>
      </div>
      <div className="tagline" style={{ maxWidth: 560, textAlign: 'center', fontSize: 12.5 }}>{t('login.roleNote')}</div>
      {error && <div className="notice block">{error}</div>}
      <div className="login-signature" data-testid="login-signature">Built by <span>Guni &amp; Younes</span></div>
    </div>
  );
}

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [screen, setScreenState] = useState<ScreenId>(() => screenFromHash(window.location.hash) ?? 'home');
  const [client, setClient] = useState<{ id: string; tab: ClientTab } | null>(() => clientFromHash(window.location.hash));
  const [agencyTab, setAgencyTab] = useState<AgencyTab>(() => agencyTabFromHash(window.location.hash) ?? 'overview');
  const [contextId, setContextId] = useState<string | null>(() => contextFromHash(window.location.hash));
  // The open transaction AND its tab, both read from the hash: a deep link to
  // #/transactions/atx-7/documents must open the documents tab, not whichever
  // tab the screen happened to be on (D14).
  const [transaction, setTransaction] = useState<{ id: string; tab: TransactionTab } | null>(() => transactionFromHash(window.location.hash));

  const setScreen = useCallback((id: ScreenId) => {
    if (!confirmLeave(t('common.unsaved'))) return;
    markClean();
    setScreenState(id);
    setClient(null);
    setContextId(null);
    setTransaction(null);
    if (id !== 'agency') setAgencyTab('overview');
    try { if (window.location.hash !== hashForScreen(id)) window.history.replaceState(null, '', hashForScreen(id)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /** Opening a compliance context PUSHES, so Back closes it again. */
  const openContext = useCallback((id: string | null) => {
    if (!confirmLeave(t('common.unsaved'))) return;
    markClean();
    setScreenState('compliance');
    setContextId(id);
    const target = id ? hashForContext(id) : hashForScreen('compliance');
    try { if (window.location.hash !== target) window.history.pushState(null, '', target); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /** Opening a transaction PUSHES, so Back closes it again. */
  const openTransaction = useCallback((id: string | null, tab: TransactionTab = 'overview') => {
    if (!confirmLeave(t('common.unsaved'))) return;
    markClean();
    setScreenState('transactions');
    setTransaction(id ? { id, tab } : null);
    const target = id ? hashForTransaction(id, tab) : hashForScreen('transactions');
    try { if (window.location.hash !== target) window.history.pushState(null, '', target); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  /** Switching tab REPLACES, so Back closes the transaction rather than walking its tabs. */
  const transactionTab = useCallback((tab: TransactionTab) => {
    setTransaction((c) => {
      if (!c) return c;
      try { window.history.replaceState(null, '', hashForTransaction(c.id, tab)); } catch { /* sandboxed */ }
      return { ...c, tab };
    });
    noteNavigated();
  }, []);
  /** Opening a client PUSHES, so the browser Back button closes it again. */
  /**
   * M23 P8 §30 — a contact, Offer or signing notification carries a server-
   * resolved target naming the CLIENT (the player) and the tab; the agent's own
   * relationship with that client is looked up now, so a revoked mandate opens
   * nothing. Other rows keep their type-level destination.
   */
  const openTarget = useCallback(async (n: Notification) => {
    const target = n.target ?? null;
    const dest = NOTIFICATION_SCREEN[n.type];
    if (target?.kind === 'client' && session) {
      try {
        const list = await agent.clients(session);
        const rel = (list.items ?? []).find((r) => r.clientId === (target as { clientId: string }).clientId && !isSummary(r));
        if (rel) { openClient(rel.id, ((target as { tab?: string }).tab as ClientTab) ?? 'overview'); return; }
      } catch { /* the relationship is not open to this agent now: plain text */ }
      if (dest) setScreen(dest);
      return;
    }
    if (dest === 'clients' && n.refId && /^rep-/.test(n.refId)) openClient(n.refId);
    else if (dest === 'compliance' && n.refId && /^ctx-/.test(n.refId)) openContext(n.refId);
    else if (dest === 'transactions' && n.refId && /^atx-/.test(n.refId)) openTransaction(n.refId);
    else if (dest) setScreen(dest);
  }, [session]);
  const openClient = useCallback((id: string, tab: ClientTab = 'overview') => {
    if (!confirmLeave(t('common.unsaved'))) return;
    markClean();
    setScreenState('clients');
    setClient({ id, tab });
    try { if (window.location.hash !== hashForClient(id, tab)) window.history.pushState(null, '', hashForClient(id, tab)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  const clientTab = useCallback((tab: ClientTab) => {
    setClient((c) => {
      if (!c) return c;
      try { window.history.replaceState(null, '', hashForClient(c.id, tab)); } catch { /* sandboxed */ }
      return { ...c, tab };
    });
    noteNavigated();
  }, []);
  const closeClient = useCallback(() => {
    if (!confirmLeave(t('common.unsaved'))) return;
    markClean();
    setClient(null);
    try { if (window.location.hash !== hashForScreen('clients')) window.history.pushState(null, '', hashForScreen('clients')); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  const selectAgencyTab = useCallback((tab: AgencyTab) => {
    if (!confirmLeave(t('common.unsaved'))) return;
    markClean();
    setAgencyTab(tab);
    try { window.history.replaceState(null, '', hashForAgency(tab)); } catch { /* sandboxed */ }
    noteNavigated();
  }, []);
  useEffect(() => installDirtyGuard(), []);
  useEffect(() => {
    const onHash = () => {
      if (!guardHashChange(() => t('common.unsaved'))) return;
      const id = screenFromHash(window.location.hash);
      if (id) setScreenState(id);
      setClient(clientFromHash(window.location.hash));
      setContextId(contextFromHash(window.location.hash));
      // The hash is the truth for an open transaction too. Without this, going
      // back to #/transactions left the detail on screen, because the id lived
      // only in state (D12).
      setTransaction(transactionFromHash(window.location.hash));
      setAgencyTab(agencyTabFromHash(window.location.hash) ?? 'overview');
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
  }, []);

  // Identity, roles and capabilities — fetched once per session and after
  // every live change. Convenience: the server enforces the matrix itself.
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let gone = false;
    agent.me(session).then((m) => { if (!gone) { setMe(m); setMeError(null); } }).catch((e) => {
      if (gone) return;
      if (e instanceof ApiError && e.status === 401) onLogout();
      else setMeError(e instanceof ApiError ? e.message : t('common.loadFailed'));
    });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tick]);
  const navCtx: NavContext = { role: session.role, tiers: me?.affiliation.tiers ?? null };
  const sections = useNavSections(navCtx);
  const loc = resolveNavigationLocation(screen);
  const activeSection = sections.find((s) => s.id === loc.sectionId) ?? null;

  const [shortcuts, setShortcuts] = useState<ScreenId[]>([]);
  useEffect(() => { setShortcuts(loadShortcuts(session.org.id, session.userId, navCtx)); }, [session, me]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
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
    if (event === 'typing') return;
    setTick((x) => x + 1);
  }), [session]);
  useEffect(() => { api.getNotifications(session).then(setNotifications).catch(() => {}); }, [session, tick]);
  const unread = notifications.filter((n) => !n.read).length;
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 3500);
  }, []);
  useEffect(() => {
    if (seenNotifIds.current === null) { seenNotifIds.current = new Set(notifications.map((n) => n.id)); return; }
    const fresh = notifications.filter((n) => !n.read && !seenNotifIds.current!.has(n.id));
    for (const n of notifications) seenNotifIds.current.add(n.id);
    if (fresh.length > 0) notify(`🔔 ${fresh[0].text}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications]);
  const openBell = async () => {
    setBellOpen(!bellOpen);
    if (!bellOpen && unread > 0) {
      try { await api.markNotificationsRead(session); setNotifications(await api.getNotifications(session)); } catch { /* stays unread */ }
    }
  };

  // Home's action centre reads the same projection as the Home screen.
  const [homeCounts, setHomeCounts] = useState<{ pending: number; disputed: number; expiringSoon: number; gap: boolean } | null>(null);
  useEffect(() => {
    let gone = false;
    agent.home(session).then((h) => { if (!gone) setHomeCounts({ pending: h.counts.pending, disputed: h.counts.disputed, expiringSoon: h.counts.expiringSoon, gap: h.alerts.some((a) => a.kind === 'verification' || a.kind === 'jurisdiction') }); }).catch(() => { if (!gone) setHomeCounts(null); });
    return () => { gone = true; };
  }, [session, tick]);

  const props = { session, tick, notify };
  const breadcrumbSection = NAV_SECTIONS.find((s) => s.id === loc.sectionId) ?? null;
  const screenLabel = t((NAV_SECTIONS.flatMap((s) => s.children).find((c) => c.id === screen)?.labelKey ?? `nav.${screen}`) as Parameters<typeof t>[0]);

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
        unreadMessages={unread}
        onOpenPalette={() => setPaletteOpen(true)}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        brand={{ short: 'A', long: 'Agent' }}
        footer={
          <div className="whoami">
            <b>{session.scoutName}</b>
            {session.role} · {session.org.name}
            <OrgChips org={session.org} />
            {me && <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }} data-testid="my-tiers">{me.affiliation.tiers.map((x) => <span key={x} className="pill blue" style={{ fontSize: 10.5, padding: '1px 7px' }}>{t(`tier.${x}` as Parameters<typeof t>[0])}</span>)}</div>}
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
              <button onClick={onLogout} style={{ padding: 0, color: 'var(--accent-2)' }}>{t('common.switchOrg')}</button>
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
            {notifications.length === 0 && <div className="notice">{t('inbox.empty')}</div>}
            {bellRows(notifications).slice(0, 20).map(({ n, count, unread: u }) => {
              const dest = NOTIFICATION_SCREEN[n.type];
              return (
                <div key={n.id} className="list-row" style={{ opacity: u ? 1 : 0.7 }}>
                  <span className="grow" style={{ fontSize: 13 }}>{n.text}{count > 1 && <span className="pill" style={{ marginLeft: 6 }}>×{count}</span>}</span>
                  {(dest || n.target?.kind === 'client') && <button onClick={() => { void openTarget(n); setBellOpen(false); }}>{t('common.open')}</button>}
                  <span className="dim">{fmtStamp(n.ts)}</span>
                </div>
              );
            })}
          </div>
        )}
        {activeSection && <SecondaryNav section={activeSection} activeItemId={loc.itemId} onNavigate={setScreen} />}
        <div className="content">
          {meError && <div className="notice block" role="alert" data-testid="me-error">{meError}</div>}
          {screen === 'home' && homeCounts && (
            <NeedsAttention unread={unread} pending={homeCounts.pending} disputed={homeCounts.disputed} expiringSoon={homeCounts.expiringSoon} verificationGap={homeCounts.gap} onNavigate={setScreen} />
          )}
          {screen === 'home' && <HomeScreen {...props} onNavigate={setScreen} />}
          {screen === 'profile' && <ProfileScreen {...props} me={me} />}
          {screen === 'compliance' && <ComplianceScreen {...props} me={me} contextId={contextId} onOpenContext={openContext} onOpenClient={openClient} />}
          {screen === 'transactions' && (
            <TransactionsScreen {...props} me={me} transactionId={transaction?.id ?? null} transactionTab={transaction?.tab ?? 'overview'} onOpenTransaction={openTransaction} onTransactionTab={transactionTab} />
          )}
          {screen === 'clients' && (
            <ClientsScreen {...props} me={me} clientId={client?.id ?? null} clientTab={client?.tab ?? 'overview'} onOpenClient={openClient} onClientTab={clientTab} onCloseClient={closeClient} />
          )}
          {screen === 'opportunities' && <OpportunitiesScreen {...props} me={me} />}
          {screen === 'inbox' && <InboxScreen {...props} onOpenClient={openClient} />}
          {screen === 'agency' && <AgencyScreen {...props} me={me} tab={agencyTab} onTab={selectAgencyTab} />}
        </div>
      </div>
      {safetyOpen && <SafetyModal session={session} notify={notify} onClose={() => setSafetyOpen(false)} />}
      <CommandPalette ctx={navCtx} open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={setScreen} shortcuts={shortcuts} onTogglePin={togglePin} />
      {toast && <Toast text={toast.text} error={toast.error} />}
    </div>
  );
}
