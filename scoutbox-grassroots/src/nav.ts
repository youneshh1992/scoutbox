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

/**
 * P2.5 — a labelled subgroup INSIDE a section.
 *
 * Presentation only. It decides how a section's children are arranged in the
 * sidebar and which siblings the phone-width strip lists. It is NOT a
 * navigation level: a group has no route, cannot be "opened", and never
 * appears in a breadcrumb. Every child of a grouped section belongs to
 * exactly one group — `validateNavConfig` says so and `navConfig` asserts it.
 */
export interface NavGroup {
  id: string;
  labelKey: string;
  items: ScreenId[];
}

export interface NavSection {
  id: 'home' | 'recruitment' | 'players' | 'organisation';
  labelKey: string;
  icon: string; // key into icons.tsx
  children: NavItem[];
  /** Optional grouping of `children` for display. `children` stays the one
   *  flat, complete list every other consumer (resolver, palette, tests) reads. */
  groups?: NavGroup[];
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
//
// P2.5: four sections, not six. A grassroots manager runs the club from a
// phone on a touchline; the four things they do are look after their players,
// recruit, run the club, and read messages. Discover folds into Recruitment as
// its first group; Coverage and Calibration are scout planning and move there
// too; Network (one page) folds into Club. No route moved.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'home', labelKey: 'navsec.home', icon: 'home',
    children: [{ id: 'feed', labelKey: 'nav.feed', aliases: ['dashboard', 'accueil', 'home'] }],
  },
  {
    id: 'players', labelKey: 'navsec.players', icon: 'user',
    children: [
      { id: 'squad', labelKey: 'nav.squad', aliases: ['squad', 'match days', 'team', 'effectif', 'équipe'] },
      { id: 'coaches', labelKey: 'nav.coaches', aliases: ['coach', 'staff coaches', 'entraîneurs'] },
      { id: 'friendlies', labelKey: 'nav.friendlies', aliases: ['friendly matches', 'amicaux'] },
      { id: 'fixtures', labelKey: 'nav.fixtures', aliases: ['matches', 'schedule', 'rencontres'] },
    ],
  },
  {
    id: 'recruitment', labelKey: 'navsec.recruitment', icon: 'target',
    // Order = display order. The groups below name the same ids and nothing
    // else; `validateNavConfig` refuses a child in zero or two groups.
    children: [
      // — Discover
      { id: 'search', labelKey: 'nav2.search', aliases: ['players', 'player search', 'find players', 'discover', 'joueurs', 'recherche'] },
      { id: 'shortlist', labelKey: 'nav.shortlist', aliases: ['watchlist', 'saved players', 'présélection'] },
      { id: 'filmroom', labelKey: 'nav.filmroom', aliases: ['film', 'clips', 'footage', 'vidéo'] },
      { id: 'insight', labelKey: 'nav.insight', aliases: ['scouting insight', 'analyse'] },
      // — Pipeline (Open Days are how grassroots recruits, so they sit here)
      { id: 'recruitment', labelKey: 'nav2.recruitment', aliases: ['pipeline', 'applications', 'recrutement'] },
      { id: 'rooms', labelKey: 'nav2.rooms', aliases: ['recruitment rooms', 'room', 'rooms', 'workspace', 'salles'] },
      { id: 'requests', labelKey: 'nav2.requests', aliases: ['player requests', 'contact requests', 'demandes'] },
      { id: 'opportunities', labelKey: 'nav.opportunities', aliases: ['open roles', 'positions', 'opportunités'] },
      { id: 'campaigns', labelKey: 'nav.campaigns', aliases: ['campagnes'] },
      { id: 'opendays', labelKey: 'nav.opendays', aliases: ['open days', 'portes ouvertes'] },
      { id: 'outcomes', labelKey: 'nav2.outcomes', aliases: ['signings', 'post-signing', 'signatures'] },
      // — Evidence
      { id: 'assessments', labelKey: 'nav.assessments', aliases: ['reports', 'scouting reports', 'évaluations', 'rapports'] },
      { id: 'video', labelKey: 'nav2.video', aliases: ['evidence', 'video workspace', 'preuves'] },
      { id: 'trials', labelKey: 'nav.trials', aliases: ['trial', 'trial reports', 'essais'] },
      { id: 'trialdays', labelKey: 'nav.trialdays', aliases: ['trial days', 'journées d’essai'] },
      // — Intelligence (M18/M19 — none is a ranking)
      { id: 'briefs', labelKey: 'nav2.briefs', aliases: ['recruitment briefs', 'brief', 'briefs', 'criteria', 'cahier des charges', 'briefs de recrutement'] },
      { id: 'matching', labelKey: 'nav2.matching', aliases: ['player matching', 'explainable matching', 'match criteria', 'who matches', 'why this player matches', 'correspondance', 'critères de correspondance'] },
      { id: 'watchlists', labelKey: 'nav2.watchlists', aliases: ['dynamic watchlists', 'dynamic watchlist', 'saved criteria', 'listes dynamiques', 'critères enregistrés'] },
      { id: 'secondlook', labelKey: 'nav2.secondlook', aliases: ['second look', 'worth another look', 'evidence changed', 'reconsider', 'second regard', 'nouveau regard'] },
      { id: 'nobodymissed', labelKey: 'nav2.nobodymissed', aliases: ['nobody missed', 'evaluation coverage', 'coverage gaps', 'not yet evaluated', 'couverture d’évaluation'] },
      // — Analytics (M20 measures the process, never a player or a colleague)
      { id: 'dashboard', labelKey: 'nav2.dashboard', aliases: ['director dashboard', 'recruitment analytics', 'analytics', 'pipeline health', 'how long does it take', 'stalled rooms', 'tableau de bord', 'analyse du recrutement'] },
      { id: 'funnel', labelKey: 'nav.funnel', aliases: ['recruitment funnel', 'entonnoir'] },
      { id: 'ledger', labelKey: 'nav.ledger', aliases: ['discovery ledger', 'audit trail', 'registre'] },
      // — Planning: scout planning, not squad management
      { id: 'coverage', labelKey: 'nav.coverage', aliases: ['scout coverage', 'planning', 'couverture'] },
      { id: 'calibration', labelKey: 'nav.calibration', aliases: ['scout calibration', 'calibrage'] },
    ],
    groups: [
      { id: 'discover', labelKey: 'navgrp.discover', items: ['search', 'shortlist', 'filmroom', 'insight'] },
      { id: 'pipeline', labelKey: 'navgrp.pipeline', items: ['recruitment', 'rooms', 'requests', 'opportunities', 'campaigns', 'opendays', 'outcomes'] },
      { id: 'evidence', labelKey: 'navgrp.evidence', items: ['assessments', 'video', 'trials', 'trialdays'] },
      { id: 'intelligence', labelKey: 'navgrp.intelligence', items: ['briefs', 'matching', 'watchlists', 'secondlook', 'nobodymissed'] },
      { id: 'analytics', labelKey: 'navgrp.analytics', items: ['dashboard', 'funnel', 'ledger'] },
      { id: 'planning', labelKey: 'navgrp.planning', items: ['coverage', 'calibration'] },
    ],
  },
  {
    // "Club": the club's own relationships and administration. Clubs & Groups
    // is visible to everyone exactly as it was under Network; the four
    // administrative pages keep their lead / verification gates. Because the
    // section is not itself gated, a non-lead sees Club with that one child —
    // never an empty husk, because `filterSections` drops empty sections.
    id: 'organisation', labelKey: 'navsec.club', icon: 'building',
    children: [
      { id: 'network', labelKey: 'nav2.network', aliases: ['clubs', 'groups', 'federation', 'network', 'réseau'] },
      { id: 'organisation', labelKey: 'nav2.organisation', aliases: ['staff', 'security', 'settings', 'organisation'], visible: leadOrVer },
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

// ------------------------------------------------------------------ groups
export interface NavGroupView { id: string | null; labelKey: string | null; children: NavItem[] }

/**
 * A section's children arranged by group, in group order. Works on a section
 * that has already been through `filterSections`: a group whose every item
 * was filtered out disappears rather than rendering an empty heading. A
 * section without groups yields one unlabelled group holding all children.
 */
export function groupedChildren(section: NavSection): NavGroupView[] {
  if (!section.groups || section.groups.length === 0) return [{ id: null, labelKey: null, children: section.children }];
  const byId = new Map(section.children.map((c) => [c.id, c] as const));
  return section.groups
    .map((g) => ({ id: g.id, labelKey: g.labelKey, children: g.items.map((id) => byId.get(id)).filter((c): c is NavItem => !!c) }))
    .filter((g) => g.children.length > 0);
}

/** The items shown beside `itemId` at phone width: its group, or the whole
 *  section when the section has no groups. Never more than one group. */
export function groupSiblings(section: NavSection, itemId: ScreenId | null): NavItem[] {
  const hit = groupedChildren(section).find((g) => g.children.some((c) => c.id === itemId));
  return hit ? hit.children : groupedChildren(section)[0]?.children ?? [];
}

/** The group an item belongs to, or null in an ungrouped section. */
export function groupOf(section: NavSection, itemId: ScreenId | null): NavGroupView | null {
  const hit = groupedChildren(section).find((g) => g.children.some((c) => c.id === itemId));
  return hit && hit.id ? hit : null;
}

/**
 * Structural soundness of the configuration, as a list of problems. Empty
 * means sound. Checked by `navConfig` so a child that is added to a section
 * but forgotten in its groups fails a test instead of silently vanishing from
 * the sidebar.
 */
export function validateNavConfig(sections: NavSection[] = NAV_SECTIONS): string[] {
  const problems: string[] = [];
  for (const s of sections) {
    if (!s.groups) continue;
    const ids = s.children.map((c) => c.id);
    const seen = new Map<string, number>();
    for (const g of s.groups) {
      if (g.items.length === 0) problems.push(`${s.id}/${g.id}: empty group`);
      for (const id of g.items) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if (!ids.includes(id)) problems.push(`${s.id}/${g.id}: "${id}" is not a child of ${s.id}`);
      }
    }
    for (const id of ids) {
      const n = seen.get(id) ?? 0;
      if (n !== 1) problems.push(`${s.id}: "${id}" appears in ${n} groups (must be exactly 1)`);
    }
  }
  return problems;
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
      // P2.5: the palette path names the group too ("Recruitment › Pipeline ›
      // Rooms"), so a result says where it lives in the sidebar.
      groupLabel: (() => { const g = groupOf(section, item.id); return g?.labelKey ? translate(g.labelKey) : ''; })(),
      aliases: item.aliases ?? [],
    }))
  ).concat([{ sectionId: 'home' as NavSection['id'], itemId: INBOX_ITEM.id, sectionLabel: '', groupLabel: '', label: translate(INBOX_ITEM.labelKey), aliases: INBOX_ITEM.aliases ?? [] }]);
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
