// M15-Nav — the ONE navigation source of truth for ScoutBox Pro.
//
// This configuration drives the sidebar, the page-level secondary tabs, the
// command palette, active-section resolution and pinned shortcuts, so the
// five surfaces can never drift apart.
//
// Visibility filtering here is CONVENIENCE ONLY. The server keeps enforcing
// every permission (401/403/404) exactly as before — hiding a destination
// never becomes authorization, and typing a hidden route still hits the same
// server rules.
import type { ScreenId } from './App';

export interface NavItem {
  id: ScreenId;
  /** i18n key for the tab label (falls back to nav.<id>). */
  labelKey: string;
  /** Palette-only friendly aliases (English + French, lowercase). */
  aliases?: string[];
  /** Client-side convenience filter; server authorization stays authoritative. */
  visible?: (ctx: NavContext) => boolean;
}

export interface NavSection {
  id: 'home' | 'discover' | 'recruitment' | 'planning' | 'network' | 'organisation';
  labelKey: string;
  icon: string; // key into icons.tsx
  children: NavItem[];
  visible?: (ctx: NavContext) => boolean;
}

export interface NavContext {
  role: string;
  /** Verification authority for this org, fetched once per session (null = none). */
  verLevel: string | null;
}

// Mirrors the server's lead heuristic (m12/shared.mjs). Convenience only.
export const LEAD_RE = /head|director|lead|manager|owner|chief/i;
export const isLeadRole = (role: string) => LEAD_RE.test(role ?? '');

const leadOrVer = (ctx: NavContext) => isLeadRole(ctx.role) || ctx.verLevel !== null;

// ---------------------------------------------------------------- sections
// Every legacy sidebar ScreenId appears EXACTLY ONCE below (asserted by the
// nav test suite), except `messages` which is the Inbox utility.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'home', labelKey: 'navsec.home', icon: 'home',
    children: [{ id: 'feed', labelKey: 'nav.feed', aliases: ['dashboard', 'accueil', 'home'] }],
  },
  {
    id: 'discover', labelKey: 'navsec.discover', icon: 'search',
    children: [
      { id: 'search', labelKey: 'nav2.search', aliases: ['players', 'player search', 'find players', 'joueurs', 'recherche'] },
      { id: 'shortlist', labelKey: 'nav.shortlist', aliases: ['watchlist', 'saved players', 'présélection'] },
      { id: 'filmroom', labelKey: 'nav.filmroom', aliases: ['film', 'clips', 'footage', 'vidéo'] },
      { id: 'opportunities', labelKey: 'nav.opportunities', aliases: ['open roles', 'positions', 'opportunités'] },
      { id: 'campaigns', labelKey: 'nav.campaigns', aliases: ['campagnes'] },
      { id: 'insight', labelKey: 'nav.insight', aliases: ['scouting insight', 'analyse'] },
      { id: 'ledger', labelKey: 'nav.ledger', aliases: ['discovery ledger', 'audit trail', 'registre'] },
    ],
  },
  {
    id: 'recruitment', labelKey: 'navsec.recruitment', icon: 'target',
    children: [
      { id: 'recruitment', labelKey: 'nav2.recruitment', aliases: ['pipeline', 'applications', 'recrutement'] },
      // M17: the club's private decision layer over a player. It lives inside
      // Recruitment as ONE destination — no seventh sidebar section.
      { id: 'rooms', labelKey: 'nav2.rooms', aliases: ['recruitment rooms', 'room', 'rooms', 'workspace', 'salles'] },
      // M18: three more destinations INSIDE Recruitment — never a seventh
      // sidebar section. Second Look reports what changed since a decision;
      // Nobody Missed is evaluation coverage over a written brief; Briefs is
      // the club's own explicit demand.
      { id: 'secondlook', labelKey: 'nav2.secondlook', aliases: ['second look', 'worth another look', 'evidence changed', 'reconsider', 'second regard', 'nouveau regard'] },
      { id: 'nobodymissed', labelKey: 'nav2.nobodymissed', aliases: ['nobody missed', 'evaluation coverage', 'coverage gaps', 'not yet evaluated', 'couverture d’évaluation'] },
      { id: 'briefs', labelKey: 'nav2.briefs', aliases: ['recruitment briefs', 'brief', 'briefs', 'criteria', 'cahier des charges', 'briefs de recrutement'] },
      // M19: two more destinations INSIDE Recruitment, for the same reason —
      // Player Matching answers "who satisfies the criteria we wrote, and
      // why"; a Dynamic Watchlist saves those criteria and keeps the answer
      // current. Neither is a ranking, and neither earns a sidebar section.
      { id: 'matching', labelKey: 'nav2.matching', aliases: ['player matching', 'explainable matching', 'match criteria', 'who matches', 'why this player matches', 'correspondance', 'critères de correspondance'] },
      { id: 'watchlists', labelKey: 'nav2.watchlists', aliases: ['dynamic watchlists', 'dynamic watchlist', 'saved criteria', 'listes dynamiques', 'critères enregistrés'] },
      // M20: the Director Dashboard is recruitment ANALYTICS, so it belongs
      // beside the work it measures rather than in a section of its own. It
      // measures the process — never a player, never a colleague.
      { id: 'dashboard', labelKey: 'nav2.dashboard', aliases: ['director dashboard', 'recruitment analytics', 'analytics', 'pipeline health', 'how long does it take', 'stalled rooms', 'tableau de bord', 'analyse du recrutement'] },
      { id: 'assessments', labelKey: 'nav.assessments', aliases: ['reports', 'scouting reports', 'évaluations', 'rapports'] },
      { id: 'video', labelKey: 'nav2.video', aliases: ['evidence', 'video workspace', 'preuves'] },
      { id: 'trials', labelKey: 'nav.trials', aliases: ['trial', 'trial reports', 'essais'] },
      { id: 'trialdays', labelKey: 'nav.trialdays', aliases: ['trial days', 'journées d’essai'] },
      { id: 'opendays', labelKey: 'nav.opendays', aliases: ['open days', 'portes ouvertes'] },
      { id: 'requests', labelKey: 'nav2.requests', aliases: ['player requests', 'contact requests', 'demandes'] },
      { id: 'outcomes', labelKey: 'nav2.outcomes', aliases: ['signings', 'post-signing', 'signatures'] },
      { id: 'funnel', labelKey: 'nav.funnel', aliases: ['recruitment funnel', 'entonnoir'] },
    ],
  },
  {
    id: 'planning', labelKey: 'navsec.team', icon: 'clipboard',
    children: [
      { id: 'squad', labelKey: 'nav.squad', aliases: ['squad', 'match days', 'effectif'] },
      { id: 'coaches', labelKey: 'nav.coaches', aliases: ['coach', 'staff coaches', 'entraîneurs'] },
      { id: 'friendlies', labelKey: 'nav.friendlies', aliases: ['friendly matches', 'amicaux'] },
      { id: 'fixtures', labelKey: 'nav.fixtures', aliases: ['matches', 'schedule', 'rencontres'] },
      { id: 'coverage', labelKey: 'nav.coverage', aliases: ['scout coverage', 'planning', 'couverture'] },
      { id: 'calibration', labelKey: 'nav.calibration', aliases: ['scout calibration', 'calibrage'] },
    ],
  },
  {
    id: 'network', labelKey: 'navsec.network', icon: 'globe',
    children: [
      { id: 'network', labelKey: 'nav2.network', aliases: ['clubs', 'groups', 'federation', 'réseau'] },
    ],
  },
  {
    id: 'organisation', labelKey: 'navsec.organisation', icon: 'building',
    visible: leadOrVer,
    children: [
      { id: 'organisation', labelKey: 'nav2.organisation', aliases: ['staff', 'security', 'settings', 'organisation'] },
      { id: 'verification', labelKey: 'nav.verification', aliases: ['verify', 'staff verification', 'club verification', 'vérification'], visible: leadOrVer },
      { id: 'imports', labelKey: 'nav2.imports', aliases: ['integrations', 'imports', 'webhooks', 'intégrations'], visible: (c) => isLeadRole(c.role) },
      { id: 'plan', labelKey: 'nav.plan', aliases: ['billing', 'compliance', 'subscription', 'abonnement'], visible: (c) => isLeadRole(c.role) },
    ],
  },
];

// Inbox is a utility destination, not a section (it keeps its unread badge).
export const INBOX_ITEM: NavItem = { id: 'messages', labelKey: 'nav.messages', aliases: ['inbox', 'messages', 'threads', 'boîte de réception'] };

// ------------------------------------------------------------ pure helpers
export function filterSections(ctx: NavContext): NavSection[] {
  const out: NavSection[] = [];
  for (const s of NAV_SECTIONS) {
    if (s.visible && !s.visible(ctx)) continue;
    const children = s.children.filter((c) => !c.visible || c.visible(ctx));
    if (children.length === 0) continue; // never show an empty destination
    out.push({ ...s, children });
  }
  return out;
}

export interface NavLocation { sectionId: NavSection['id'] | null; itemId: ScreenId | null }

/** Deterministic active-location resolution: one screen id → one section. */
export function resolveNavigationLocation(screenId: string): NavLocation {
  if (screenId === INBOX_ITEM.id) return { sectionId: null, itemId: 'messages' };
  for (const s of NAV_SECTIONS) {
    const item = s.children.find((c) => c.id === screenId);
    if (item) return { sectionId: s.id, itemId: item.id };
  }
  return { sectionId: null, itemId: null }; // unknown path highlights nothing
}

export function allItems(): { section: NavSection; item: NavItem }[] {
  return NAV_SECTIONS.flatMap((section) => section.children.map((item) => ({ section, item })));
}

/** Command-palette search over PERMITTED destinations only. Aliases are for
 *  finding things, never for bypassing the visibility filter. */
export function searchNav(query: string, ctx: NavContext, translate: (key: string) => string) {
  const q = query.trim().toLowerCase();
  const sections = filterSections(ctx);
  const rows = sections.flatMap((section) =>
    section.children.map((item) => ({
      sectionId: section.id, itemId: item.id,
      sectionLabel: translate(section.labelKey), label: translate(item.labelKey),
      aliases: item.aliases ?? [],
    }))
  ).concat([{ sectionId: 'home' as NavSection['id'], itemId: INBOX_ITEM.id, sectionLabel: '', label: translate(INBOX_ITEM.labelKey), aliases: INBOX_ITEM.aliases ?? [] }]);
  if (!q) return rows.slice(0, 8);
  const scored = rows.map((r) => {
    const label = r.label.toLowerCase();
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (label.includes(q)) score = 1;
    else if (r.aliases.some((a) => a.startsWith(q))) score = 2;
    else if (r.aliases.some((a) => a.includes(q))) score = 3;
    else if (r.sectionLabel.toLowerCase().includes(q)) score = 4;
    return { ...r, score };
  }).filter((r) => r.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  return scored.slice(0, 8);
}

// ------------------------------------------------------------- deep links
// The workspace historically had no URLs at all; screens now sync to
// location.hash ("#/verification") so bookmarks and direct links work. Every
// legacy screen id IS the route — nothing was renamed or broken.
//
// M17 adds the FIRST parameterised route: "#/recruitment/rooms/:roomId". It is
// parsed by its own strict pattern and resolved separately from the screen id,
// so the flat "#/<screenId>" contract above is unchanged and every malformed
// hash still rejects exactly as before.
const ROOM_HASH = /^#\/recruitment\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

/** The room id inside a deep link, or null for any other (or malformed) hash. */
export function roomFromHash(hash: string): string | null {
  const m = ROOM_HASH.exec(hash ?? '');
  return m ? m[1] : null;
}
export const hashForRoom = (roomId: string) => `#/recruitment/rooms/${roomId}`;

// M18 extends the SAME mechanism rather than inventing a second one:
//   "#/recruitment/second-look"      → the Second Look queue
//   "#/recruitment/nobody-missed"    → Evaluation Coverage for a brief
//   "#/recruitment/briefs/:briefId"  → one Recruitment Brief
// Each is parsed by its own strict pattern, so the flat "#/<screenId>"
// contract is unchanged and every malformed hash still rejects exactly as
// before.
export const SECOND_LOOK_HASH = '#/recruitment/second-look';
export const NOBODY_MISSED_HASH = '#/recruitment/nobody-missed';
const BRIEF_HASH = /^#\/recruitment\/briefs\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

/** The brief id inside a deep link, or null for any other (or malformed) hash. */
export function briefFromHash(hash: string): string | null {
  const m = BRIEF_HASH.exec(hash ?? '');
  return m ? m[1] : null;
}
export const hashForBrief = (briefId: string) => `#/recruitment/briefs/${briefId}`;

// M19 extends the SAME mechanism a third time rather than inventing another:
//   "#/recruitment/matching"            → the Player Matching workspace
//   "#/recruitment/matching?c=<state>"  → …with the criteria that were run
//   "#/recruitment/watchlists"          → the Dynamic Watchlist list
//   "#/recruitment/watchlists/:id"      → one Dynamic Watchlist
//
// The criteria payload rides in the hash so a search survives refresh, Back,
// Forward and a link shared with a colleague. It is opaque and UNTRUSTED: the
// server validates every criterion again and refuses anything it does not
// recognise, so a hand-edited link can widen nothing.
export const MATCHING_HASH = '#/recruitment/matching';
export const WATCHLISTS_HASH = '#/recruitment/watchlists';
const MATCHING_RE = /^#\/recruitment\/matching(?:\?c=([A-Za-z0-9%._~-]{1,8000}))?$/;
const WATCHLIST_HASH = /^#\/recruitment\/watchlists\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

/** The encoded criteria state inside a matching deep link, or null. */
export function criteriaFromHash(hash: string): string | null {
  const m = MATCHING_RE.exec(hash ?? '');
  return m?.[1] ?? null;
}
export const hashForMatching = (encoded?: string | null) =>
  (encoded ? `${MATCHING_HASH}?c=${encoded}` : MATCHING_HASH);

/** The watchlist id inside a deep link, or null for any other (or malformed) hash. */
export function watchlistFromHash(hash: string): string | null {
  const m = WATCHLIST_HASH.exec(hash ?? '');
  return m ? m[1] : null;
}
export const hashForWatchlist = (id: string) => `${WATCHLISTS_HASH}/${id}`;

// M20 extends the SAME mechanism a fourth time:
//   "#/recruitment/dashboard"          → the Director Dashboard
//   "#/recruitment/dashboard?<filters>" → …with the window and filters applied
//
// The filters ride in the hash so a director can send a colleague the exact
// view they are looking at. Every value is validated again server-side and an
// unrecognised one is refused, so a hand-edited link can widen nothing — and
// there is deliberately no filter here that names a person.
export const DASHBOARD_HASH = '#/recruitment/dashboard';
const DASHBOARD_RE = /^#\/recruitment\/dashboard(?:\?([A-Za-z0-9%._~=&-]{1,600}))?$/;

/** Filters a Director Dashboard link may carry. No person appears here. */
export const DASHBOARD_FILTER_KEYS = ['window', 'from', 'to', 'source', 'priority', 'brief', 'stallDays'] as const;
export type DashboardFilterKey = (typeof DASHBOARD_FILTER_KEYS)[number];

/** The filters inside a dashboard deep link. Unknown keys are dropped. */
export function dashboardFromHash(hash: string): Record<string, string> | null {
  const m = DASHBOARD_RE.exec(hash ?? '');
  if (!m) return null;
  const out: Record<string, string> = {};
  if (!m[1]) return out;
  for (const [k, v] of new URLSearchParams(m[1])) {
    if ((DASHBOARD_FILTER_KEYS as readonly string[]).includes(k) && v) out[k] = v;
  }
  return out;
}
export function hashForDashboard(filters: Record<string, string | number | undefined | null> = {}): string {
  const q = new URLSearchParams();
  for (const k of DASHBOARD_FILTER_KEYS) {
    const v = filters[k];
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${DASHBOARD_HASH}?${s}` : DASHBOARD_HASH;
}

/** Canonical hashes for the unparameterised M18/M19 destinations. */
const PRETTY_HASH: Partial<Record<ScreenId, string>> = {
  secondlook: SECOND_LOOK_HASH,
  nobodymissed: NOBODY_MISSED_HASH,
  matching: MATCHING_HASH,
  watchlists: WATCHLISTS_HASH,
  dashboard: DASHBOARD_HASH,
};

export function screenFromHash(hash: string): ScreenId | null {
  // A room deep link resolves to the Rooms destination (which then opens it).
  if (roomFromHash(hash)) return 'rooms';
  if (briefFromHash(hash)) return 'briefs';
  if (hash === SECOND_LOOK_HASH) return 'secondlook';
  if (hash === NOBODY_MISSED_HASH) return 'nobodymissed';
  // M18.2 — the PARENT of a deep link the app itself produces
  // ("#/recruitment/rooms/:id", "#/recruitment/briefs/:id") is a valid way to
  // reach the list. Before this, trimming the id off a shared link landed on
  // Home with nothing highlighted — a hidden assumption the M18.2 live suite
  // tripped over.
  if (hash === '#/recruitment/rooms') return 'rooms';
  if (hash === '#/recruitment/briefs') return 'briefs';
  // M19 — a matching link carries its criteria; a watchlist link carries an id.
  if (MATCHING_RE.test(hash ?? '')) return 'matching';
  if (watchlistFromHash(hash)) return 'watchlists';
  if (hash === WATCHLISTS_HASH) return 'watchlists';
  // M20 — a dashboard link carries its window and filters.
  if (DASHBOARD_RE.test(hash ?? '')) return 'dashboard';
  const m = /^#\/([a-z]+)$/.exec(hash ?? '');
  if (!m) return null;
  const id = m[1];
  if (id === INBOX_ITEM.id) return 'messages';
  return allItems().some(({ item }) => item.id === id) ? (id as ScreenId) : null;
}
export const hashForScreen = (id: ScreenId) => PRETTY_HASH[id] ?? `#/${id}`;

// -------------------------------------------------------------- shortcuts
// Pinned by ITEM ID (rename-safe). Stored locally per identity — honest
// limitation: no server-side preference store exists yet, so pins do not
// roam across devices. Invalid or no-longer-visible ids drop out gracefully.
export const MAX_SHORTCUTS = 5;
const shortcutsKey = (orgId: string, userId: string) => `sb-nav-shortcuts:${orgId}:${userId}`;
export function loadShortcuts(orgId: string, userId: string, ctx: NavContext): ScreenId[] {
  try {
    const raw = localStorage.getItem(shortcutsKey(orgId, userId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    const permitted = new Set(filterSections(ctx).flatMap((s) => s.children.map((c) => c.id)));
    permitted.add(INBOX_ITEM.id);
    return list.filter((x): x is ScreenId => typeof x === 'string' && permitted.has(x as ScreenId)).slice(0, MAX_SHORTCUTS);
  } catch { return []; }
}
export function saveShortcuts(orgId: string, userId: string, ids: ScreenId[]) {
  try { localStorage.setItem(shortcutsKey(orgId, userId), JSON.stringify(ids.slice(0, MAX_SHORTCUTS))); } catch { /* private mode */ }
}

// -------------------------------------------------------- collapsed state
const COLLAPSE_KEY = 'sb-nav-collapsed';
export function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
export function saveCollapsed(collapsed: boolean) {
  try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
}
