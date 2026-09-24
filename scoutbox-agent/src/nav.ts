// ScoutBox Agent — the ONE navigation source of truth (M15-Nav pattern).
//
// Five sections and one utility destination: an agent's day is their clients,
// the transactions they act in, the opportunities those clients can legitimately
// see, their own regulatory standing and their agency. The transaction workspace
// (P5.6D) is a permissioned multi-party record — it is NOT an offer workflow and
// NOT a negotiation surface, and nothing in it agrees or signs anything.
//
// Visibility filtering here is CONVENIENCE ONLY. The server enforces every
// permission through its matrix on every request; hiding a destination never
// becomes authorization, and typing a hidden route still hits the same rules.
import type { ScreenId } from './App';

export interface NavItem {
  id: ScreenId;
  labelKey: string;
  aliases?: string[];
  visible?: (ctx: NavContext) => boolean;
  primary?: boolean;
  shortKey?: string;
}

export interface NavGroup { id: string; labelKey: string; items: ScreenId[] }

export interface NavSection {
  id: 'home' | 'clients' | 'transactions' | 'opportunities' | 'agency';
  labelKey: string;
  icon: string;
  children: NavItem[];
  groups?: NavGroup[];
  visible?: (ctx: NavContext) => boolean;
}

export interface NavContext {
  role: string;
  /** The agency tiers the server reported for this member (null until /me answered). */
  tiers: string[] | null;
}

const has = (ctx: NavContext, tier: string) => !!ctx.tiers && ctx.tiers.includes(tier);
const licensed = (ctx: NavContext) => has(ctx, 'licensed_agent');

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'home', labelKey: 'navsec.home', icon: 'home',
    children: [
      { id: 'home', labelKey: 'nav.home', aliases: ['dashboard', 'accueil', 'overview'] },
      { id: 'profile', labelKey: 'nav.profile', shortKey: 'navshort.profile', aliases: ['verification', 'licence', 'license', 'fifa', 'registration', 'my profile', 'vérification', 'licence fifa'] },
      // P5.6C: the agent's own regulatory standing, conflict contexts, consents
      // and attributed review items. Not a transaction room (no offer, no terms).
      { id: 'compliance', labelKey: 'nav.compliance', shortKey: 'navshort.compliance', aliases: ['conflict', 'conflicts', 'consent', 'consents', 'policy', 'policies', 'review', 'regulatory', 'conformité', 'conflit', 'consentement'] },
    ],
  },
  {
    id: 'clients', labelKey: 'navsec.clients', icon: 'user',
    children: [
      { id: 'clients', labelKey: 'nav.clients', aliases: ['players', 'relationships', 'representation', 'requests', 'joueurs', 'représentation'] },
    ],
  },
  {
    // P5.6D: the multi-party transaction workspace. Reading is every member's;
    // opening one, changing its parties and moving its status are the licensed
    // individual's, and the server refuses the rest whatever this list shows.
    id: 'transactions', labelKey: 'navsec.transactions', icon: 'target',
    children: [
      { id: 'transactions', labelKey: 'nav.transactions', shortKey: 'navshort.transactions', aliases: ['transaction', 'transfer', 'loan', 'deal', 'workspace', 'parties', 'transfert', 'pr\u00eat', 'op\u00e9ration'] },
    ],
  },
  {
    id: 'opportunities', labelKey: 'navsec.opportunities', icon: 'target',
    // The board reads only through an active relationship, which only a
    // licensed agent can hold. Convenience filter; the server refuses the rest.
    visible: licensed,
    children: [
      { id: 'opportunities', labelKey: 'nav.opportunities', aliases: ['board', 'trials', 'open trials', 'opportunités'] },
    ],
  },
  {
    id: 'agency', labelKey: 'navsec.agency', icon: 'building',
    children: [
      { id: 'agency', labelKey: 'nav.agency', aliases: ['team', 'members', 'compliance', 'settings', 'audit', 'équipe', 'conformité', 'paramètres'] },
    ],
  },
];

// Inbox is a utility destination, not a section (it keeps its unread badge).
export const INBOX_ITEM: NavItem = { id: 'inbox', labelKey: 'nav.inbox', aliases: ['inbox', 'notifications', 'messages', 'boîte de réception'] };

// ------------------------------------------------------------ pure helpers
export function filterSections(ctx: NavContext): NavSection[] {
  const out: NavSection[] = [];
  for (const s of NAV_SECTIONS) {
    if (s.visible && !s.visible(ctx)) continue;
    const children = s.children.filter((c) => !c.visible || c.visible(ctx));
    if (children.length === 0) continue;
    out.push({ ...s, children });
  }
  return out;
}

export interface NavLocation { sectionId: NavSection['id'] | null; itemId: ScreenId | null }

export function resolveNavigationLocation(screenId: string): NavLocation {
  if (screenId === INBOX_ITEM.id) return { sectionId: null, itemId: 'inbox' };
  for (const s of NAV_SECTIONS) {
    const item = s.children.find((c) => c.id === screenId);
    if (item) return { sectionId: s.id, itemId: item.id };
  }
  return { sectionId: null, itemId: null };
}

export function allItems(): { section: NavSection; item: NavItem }[] {
  return NAV_SECTIONS.flatMap((section) => section.children.map((item) => ({ section, item })));
}

export interface NavGroupView { id: string | null; labelKey: string | null; children: NavItem[] }
export function groupedChildren(section: NavSection): NavGroupView[] {
  if (!section.groups || section.groups.length === 0) return [{ id: null, labelKey: null, children: section.children }];
  const byId = new Map(section.children.map((c) => [c.id, c] as const));
  return section.groups
    .map((g) => ({ id: g.id, labelKey: g.labelKey, children: g.items.map((id) => byId.get(id)).filter((c): c is NavItem => !!c) }))
    .filter((g) => g.children.length > 0);
}
export function groupSiblings(section: NavSection, itemId: ScreenId | null): NavItem[] {
  const hit = groupedChildren(section).find((g) => g.children.some((c) => c.id === itemId));
  return hit ? hit.children : groupedChildren(section)[0]?.children ?? [];
}
export const STRIP_MAX_VISIBLE = 4;
export interface StripLayout { visible: NavItem[]; overflow: NavItem[]; activeInOverflow: NavItem | null }
export function stripLayout(section: NavSection, itemId: ScreenId | null, max: number = STRIP_MAX_VISIBLE): StripLayout {
  const items = groupSiblings(section, itemId);
  if (items.length <= max) return { visible: items, overflow: [], activeInOverflow: null };
  const flagged = items.filter((c) => c.primary);
  const visible = flagged.length > 0 ? flagged.slice(0, max - 1) : items.slice(0, max - 1);
  const overflow = items.filter((c) => !visible.includes(c));
  return { visible, overflow, activeInOverflow: overflow.find((c) => c.id === itemId) ?? null };
}
export function groupOf(section: NavSection, itemId: ScreenId | null): NavGroupView | null {
  const hit = groupedChildren(section).find((g) => g.children.some((c) => c.id === itemId));
  return hit && hit.id ? hit : null;
}

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

export function searchNav(query: string, ctx: NavContext, translate: (key: string) => string) {
  const q = query.trim().toLowerCase();
  const sections = filterSections(ctx);
  const rows = sections.flatMap((section) =>
    section.children.map((item) => ({
      sectionId: section.id, itemId: item.id,
      sectionLabel: translate(section.labelKey), label: translate(item.labelKey),
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
// "#/<screenId>" is the flat contract. Two parameterised routes, each parsed
// by its own strict pattern:
//   "#/clients/:id"                       → one client relationship
//   "#/clients/:id/<tab>"                 → …opened on a tab
//   "#/agency/<tab>"                      → the Agency workspace on a tab
//   "#/compliance/<ctxId>"                → one compliance context (P5.6C)
//   "#/transactions/:id"                  → one transaction workspace (P5.6D)
//   "#/transactions/:id/<tab>"            → …opened on a tab
// M23 P5.6E adds two READ tabs: the club contacts a club routed to this agent,
// and the client's trials as scheduling (never assessment). Both are gated on the
// client's own disclosure choice, and both refuse plainly when it is off.
export const CLIENT_TABS = ['overview', 'representation', 'opportunities', 'contacts', 'trials', 'offers', 'activity'] as const;
export type ClientTab = (typeof CLIENT_TABS)[number];
export const AGENCY_TABS = ['overview', 'team', 'compliance', 'settings'] as const;
export type AgencyTab = (typeof AGENCY_TABS)[number];

const CLIENT_HASH = /^#\/clients\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/(overview|representation|opportunities|contacts|trials|offers|activity))?$/;
const AGENCY_HASH = /^#\/agency\/(overview|team|compliance|settings)$/;
const CONTEXT_HASH = /^#\/compliance\/(ctx-[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
export const TRANSACTION_TABS = ['overview', 'parties', 'compliance', 'documents', 'messages', 'timeline'] as const;
export type TransactionTab = (typeof TRANSACTION_TABS)[number];
const TRANSACTION_HASH = /^#\/transactions\/(atx-[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/(overview|parties|compliance|documents|messages|timeline))?$/;

export function clientFromHash(hash: string): { id: string; tab: ClientTab } | null {
  const m = CLIENT_HASH.exec(hash ?? '');
  return m ? { id: m[1], tab: (m[2] as ClientTab | undefined) ?? 'overview' } : null;
}
export const hashForClient = (id: string, tab: ClientTab = 'overview') => (tab === 'overview' ? `#/clients/${id}` : `#/clients/${id}/${tab}`);

export function agencyTabFromHash(hash: string): AgencyTab | null {
  const m = AGENCY_HASH.exec(hash ?? '');
  return m ? (m[1] as AgencyTab) : null;
}
export const hashForAgency = (tab: AgencyTab = 'overview') => (tab === 'overview' ? '#/agency' : `#/agency/${tab}`);

export function contextFromHash(hash: string): string | null {
  const m = CONTEXT_HASH.exec(hash ?? '');
  return m ? m[1] : null;
}
export const hashForContext = (id: string) => `#/compliance/${id}`;

export function transactionFromHash(hash: string): { id: string; tab: TransactionTab } | null {
  const m = TRANSACTION_HASH.exec(hash ?? '');
  return m ? { id: m[1], tab: (m[2] as TransactionTab | undefined) ?? 'overview' } : null;
}
export const hashForTransaction = (id: string, tab: TransactionTab = 'overview') => (tab === 'overview' ? `#/transactions/${id}` : `#/transactions/${id}/${tab}`);

export function screenFromHash(hash: string): ScreenId | null {
  if (clientFromHash(hash)) return 'clients';
  if (agencyTabFromHash(hash)) return 'agency';
  if (contextFromHash(hash)) return 'compliance';
  if (transactionFromHash(hash)) return 'transactions';
  const m = /^#\/([a-z]+)$/.exec(hash ?? '');
  if (!m) return null;
  const id = m[1];
  if (id === INBOX_ITEM.id) return 'inbox';
  return allItems().some(({ item }) => item.id === id) ? (id as ScreenId) : null;
}
export const hashForScreen = (id: ScreenId) => `#/${id}`;

// -------------------------------------------------------------- shortcuts
export const MAX_SHORTCUTS = 5;
const shortcutsKey = (orgId: string, userId: string) => `sb-agent-shortcuts:${orgId}:${userId}`;
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
const COLLAPSE_KEY = 'sb-agent-nav-collapsed';
export function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
export function saveCollapsed(collapsed: boolean) {
  try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
}
