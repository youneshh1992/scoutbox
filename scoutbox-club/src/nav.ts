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
      { id: 'insight', labelKey: 'nav.insight', aliases: ['scouting insight', 'suitability', 'matches', 'analyse'] },
      { id: 'ledger', labelKey: 'nav.ledger', aliases: ['discovery ledger', 'audit trail', 'registre'] },
    ],
  },
  {
    id: 'recruitment', labelKey: 'navsec.recruitment', icon: 'target',
    children: [
      { id: 'recruitment', labelKey: 'nav2.recruitment', aliases: ['pipeline', 'applications', 'cases', 'recrutement'] },
      { id: 'assessments', labelKey: 'nav.assessments', aliases: ['reports', 'scouting reports', 'assessment', 'évaluations', 'rapports'] },
      { id: 'video', labelKey: 'nav2.video', aliases: ['evidence', 'video workspace', 'evidence requests', 'preuves'] },
      { id: 'trials', labelKey: 'nav.trials', aliases: ['trial', 'trial reports', 'essais'] },
      { id: 'trialdays', labelKey: 'nav.trialdays', aliases: ['trial days', 'journées d’essai'] },
      { id: 'requests', labelKey: 'nav2.requests', aliases: ['player requests', 'contact requests', 'demandes'] },
      { id: 'outcomes', labelKey: 'nav2.outcomes', aliases: ['signings', 'post-signing', 'outcomes', 'signatures'] },
      { id: 'funnel', labelKey: 'nav.funnel', aliases: ['recruitment funnel', 'entonnoir'] },
    ],
  },
  {
    id: 'planning', labelKey: 'navsec.planning', icon: 'clipboard',
    children: [
      { id: 'planner', labelKey: 'nav2.planner', aliases: ['squad planner', 'squad', 'effectif'] },
      { id: 'coverage', labelKey: 'nav.coverage', aliases: ['scout coverage', 'planning', 'couverture'] },
      { id: 'calibration', labelKey: 'nav.calibration', aliases: ['scout calibration', 'calibrage'] },
      { id: 'fixtures', labelKey: 'nav.fixtures', aliases: ['matches', 'schedule', 'rencontres'] },
    ],
  },
  {
    id: 'network', labelKey: 'navsec.network', icon: 'globe',
    children: [
      { id: 'network', labelKey: 'nav2.network', aliases: ['clubs', 'groups', 'federation', 'club network', 'réseau'] },
      { id: 'representation', labelKey: 'nav.representation', aliases: ['agents', 'agencies', 'représentation'] },
    ],
  },
  {
    id: 'organisation', labelKey: 'navsec.organisation', icon: 'building',
    // Administrative tooling: shown only to leads / verification authorities.
    // Convenience only — every route stays server-enforced.
    visible: leadOrVer,
    children: [
      { id: 'organisation', labelKey: 'nav2.organisation', aliases: ['staff', 'security', 'mfa', 'sso', 'audit', 'settings', 'general', 'organisation'] },
      { id: 'verification', labelKey: 'nav.verification', aliases: ['verify', 'staff verification', 'club verification', 'vérification'], visible: leadOrVer },
      { id: 'imports', labelKey: 'nav2.imports', aliases: ['integrations', 'imports', 'webhooks', 'api', 'intégrations'], visible: (c) => isLeadRole(c.role) },
      { id: 'budgets', labelKey: 'nav2.budgets', aliases: ['finance', 'deal budgets', 'budgeting', 'budgets'], visible: (c) => isLeadRole(c.role) },
      { id: 'plan', labelKey: 'nav.plan', aliases: ['billing', 'compliance', 'subscription', 'abonnement'], visible: (c) => isLeadRole(c.role) },
      { id: 'reputation', labelKey: 'nav.reputation', aliases: ['standing', 'réputation'] },
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
export function screenFromHash(hash: string): ScreenId | null {
  const m = /^#\/([a-z]+)$/.exec(hash ?? '');
  if (!m) return null;
  const id = m[1];
  if (id === INBOX_ITEM.id) return 'messages';
  return allItems().some(({ item }) => item.id === id) ? (id as ScreenId) : null;
}
export const hashForScreen = (id: ScreenId) => `#/${id}`;

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
