// M15-Nav / P2.5 — navigation UI. All structure comes from nav.ts; nothing
// here keeps its own list of destinations. Visibility filtering is
// convenience — the server stays authoritative for every route.
//
// P2.5 changed the shape, not the rules:
//   • the sidebar is an ACCORDION — the active section is expanded and lists
//     its children, arranged by group; other sections toggle with a chevron
//     for the session (nothing persisted: there is nothing worth remembering);
//   • the collapsed 64px rail opens a keyboard-operable FLYOUT per section;
//   • the page tab strip is gone from the desktop — it was a second navigation
//     bar carrying destinations. At phone width, where the sidebar is a
//     drawer, `SecondaryNav` lists only the active GROUP's siblings (≤ 6);
//   • the top bar is one row: the page `<h1>`, a live-state dot, the bell and
//     Report / Block. Organisation badges moved to the account block, where
//     the organisation is named.
// Pro uses workspace tiles and a focused page index. The collapsed rail
// retains the shared navigation model and keyboard-operable flyouts.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ScreenId } from './App';
import {
  INBOX_ITEM, MAX_SHORTCUTS, type NavContext, type NavGroupView, type NavItem, type NavLocation, type NavSection,
  allItems, filterSections, groupedChildren, searchNav, stripLayout,
} from './nav';
import { Icon } from './icons';
import { type Theme } from '../../design-system/theme';
import { t } from './i18n';

type TKey = Parameters<typeof t>[0];
const tr = (key: string) => t(key as TKey);

export interface Brand { short: string; long: string }
/** The organisation block under the wordmark (reference `.p-org`): initials tile, name, one quiet line. */
export interface OrgBlock { initials: string; name: string; line?: string }

/** ≤ 900px: the sidebar is a drawer. Tapping a multi-page section there
 *  expands it (the pages are the point of opening a drawer) rather than
 *  navigating away and closing it. Desktop behaviour is unchanged. */
function useIsPhoneShell(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

// ------------------------------------------------------------------ Sidebar
export function Sidebar({
  sections, location, onNavigate, collapsed, onToggleCollapsed, shortcuts,
  onTogglePin, unreadMessages, badges = {}, onOpenPalette, drawerOpen, onCloseDrawer, footer, brand, org,
}: {
  sections: NavSection[];
  location: NavLocation;
  onNavigate: (id: ScreenId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  shortcuts: ScreenId[];
  onTogglePin: (id: ScreenId) => void;
  unreadMessages: number;
  badges?: Partial<Record<NavSection['id'], number>>;
  onOpenPalette: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  footer: ReactNode;
  brand: Brand;
  org?: OrgBlock;
}) {
  const labelFor = (id: ScreenId) => {
    const hit = allItems().find(({ item }) => item.id === id);
    return hit ? tr(hit.item.labelKey) : id;
  };

  // Accordion state. The active section is ALWAYS open; others can be opened
  // for the session with their chevron. Deterministic and unpersisted.
  const [open, setOpen] = useState<Set<string>>(() => new Set(location.sectionId ? [location.sectionId] : []));
  // Any navigation re-opens the destination's section — including a page
  // inside a section the person had folded, so the active page is never
  // hidden in a closed accordion.
  // M24D — and only that section: arriving somewhere folds the sections the
  // person had opened on the way, so the sidebar shows one expanded section
  // (its one open group) rather than everything they passed through.
  useEffect(() => {
    if (location.sectionId) setOpen((prev) => (prev.size === 1 && prev.has(location.sectionId!) ? prev : new Set([location.sectionId!])));
  }, [location.sectionId, location.itemId]);
  const toggle = (id: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Collapsed-rail flyout: at most one open. Closed by Escape, by clicking
  // elsewhere, by leaving it with the pointer, and by navigating.
  const [flyout, setFlyout] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => { if (navRef.current && !navRef.current.contains(e.target as Node)) setFlyout(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [flyout]);
  useEffect(() => { if (!collapsed) setFlyout(null); }, [collapsed]);

  const go = useCallback((id: ScreenId) => { onNavigate(id); onCloseDrawer(); setFlyout(null); }, [onNavigate, onCloseDrawer]);
  const phone = useIsPhoneShell();

  return (
    <>
      {drawerOpen && <div className="drawer-veil nav-drawer-veil" onClick={onCloseDrawer} />}
      <nav ref={navRef} id="app-sidebar" className={`sidebar ${collapsed ? 'collapsed' : ''} ${drawerOpen ? 'drawer-open' : ''}`} aria-label="Main navigation">
        {/* M24A — the reference wordmark: one ink, a green square, the edition beside it. */}
        <div className="brand" title={`ScoutBox ${brand.long}`}>
          {collapsed ? <span className="wordmark" aria-label={`ScoutBox ${brand.long}`}>S</span> : <><span className="wordmark">ScoutBox</span><sup className="tm" aria-label="trademark">TM</sup><span className="brand-sub">{brand.long}</span></>}
        </div>
        {org && (
          <div className="p-org" aria-label={org.name}>
            <span className="p-avatar club" aria-hidden="true">{org.initials}</span>
            <span><strong>{org.name}</strong>{org.line && <small>{org.line}</small>}</span>
          </div>
        )}

        <div className="nav-scroll" data-testid="nav-scroll">
        {!collapsed && <div className="pro-workspace-switcher" aria-label="Workspaces">
          {sections.map(s=><button key={s.id} className={location.sectionId===s.id?'selected':''} aria-label={tr(s.labelKey)} aria-current={location.sectionId===s.id?'page':undefined} onClick={() => { if (phone && s.children.length > 1) onNavigate(s.children[0].id); else go(s.children[0].id); }}><Icon name={s.icon} size={21}/><span>{tr(s.labelKey)}</span>{!!badges[s.id] && <b>{badges[s.id]}</b>}</button>)}
          <button className={location.itemId==='messages'?'selected':''} aria-label={t('nav.messages')} aria-current={location.itemId==='messages'?'page':undefined} onClick={()=>go('messages')}><Icon name="messages-square" size={21}/><span>{t('nav.messages')}</span>{unreadMessages>0&&<b>{unreadMessages}</b>}</button>
        </div>}
        {!collapsed && location.sectionId && <div className="pro-nav-caption">{location.sectionId && sections.find(s=>s.id===location.sectionId)?.children.length !== 1 ? 'Workspace pages' : 'Quick access'}</div>}
        {!collapsed && location.sectionId==='home' && <div className="pro-home-nav">{sections.flatMap(s=>s.children).filter(c=>['search','filmroom','dashboard','briefs'].includes(c.id)).map(c=><button key={c.id} onClick={()=>go(c.id)}><span>{tr(c.labelKey)}</span><Icon name="arrow-up-right" size={14}/></button>)}</div>}
        <div className="pro-context-nav">{sections.filter(s=>collapsed || (s.id===location.sectionId && s.children.length>1)).map((s) => (
          <SectionRow
            key={s.id}
            section={s}
            active={location.sectionId === s.id}
            activeItemId={location.itemId}
            expanded={collapsed ? open.has(s.id) : true}
            onToggle={() => toggle(s.id)}
            collapsed={collapsed}
            flyoutOpen={flyout === s.id}
            onFlyout={(want) => setFlyout(want ? s.id : null)}
            count={badges[s.id]}
            onNavigate={go}
            expandOnSelect={phone && drawerOpen}
          />
        ))}</div>

        {shortcuts.length > 0 && !collapsed && (
          <div className="nav-shortcuts">
            <div className="nav-group-label">{t('navsec.shortcuts')}</div>
            {shortcuts.map((id) => (
              <button key={id} className={`nav-shortcut ${location.itemId === id ? 'active' : ''}`} onClick={() => go(id)}>
                <Icon name="pin" size={12} />
                <span className="grow">{labelFor(id)}</span>
                <span
                  role="button" tabIndex={0} className="nav-unpin" aria-label={t('navsec.unpin')} title={t('navsec.unpin')}
                  onClick={(e) => { e.stopPropagation(); onTogglePin(id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onTogglePin(id); } }}
                >×</span>
              </button>
            ))}
          </div>
        )}

        {collapsed && <><div className="nav-divider" role="separator" />
        <button
          className={`nav-section ${location.itemId === 'messages' ? 'active' : ''}`}
          aria-current={location.itemId === 'messages' ? 'page' : undefined}
          aria-label={t('nav.messages')}
          title={collapsed ? t('nav.messages') : undefined}
          onClick={() => go('messages')}
        >
          <Icon name="inbox" />
          {!collapsed && <span className="grow">{t('nav.messages')}</span>}
          {unreadMessages > 0 && <span className="nav-badge">{unreadMessages}</span>}
          {location.itemId === 'messages' && <span className="nav-active-bar" aria-hidden="true" />}
        </button></>}

        </div>
        <div className="spacer" />
        {!collapsed && footer}
        <button className="nav-collapse" onClick={onToggleCollapsed} aria-label={collapsed ? t('navsec.expand') : t('navsec.collapse')} title={collapsed ? t('navsec.expand') : t('navsec.collapse')}>
          <Icon name={collapsed ? 'expand' : 'collapse'} />
          {!collapsed && <span className="grow">{t('navsec.collapse')}</span>}
        </button>
      </nav>
    </>
  );
}

/** One section: its button, its chevron, and — when expanded or flown out —
 *  its grouped children. */
function SectionRow({ section: s, active, activeItemId, expanded, onToggle, collapsed, flyoutOpen, onFlyout, count, onNavigate, expandOnSelect }: {
  section: NavSection; active: boolean; activeItemId: ScreenId | null; expanded: boolean; onToggle: () => void;
  collapsed: boolean; flyoutOpen: boolean; onFlyout: (open: boolean) => void; count?: number; onNavigate: (id: ScreenId) => void;
  expandOnSelect?: boolean;
}) {
  const label = tr(s.labelKey);
  const multi = s.children.length > 1;
  const groups = groupedChildren(s);
  const panelId = `navsec-${s.id}`;
  const flyRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLButtonElement>(null);

  // Keyboard inside a flyout: arrows move, Escape closes and returns focus.
  const onFlyKey = (e: KeyboardEvent) => {
    const items = Array.from(flyRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
    const i = items.findIndex((b) => b === document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); onFlyout(false); iconRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  useEffect(() => {
    if (flyoutOpen) flyRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
  }, [flyoutOpen]);

  // M24D — the groups inside an expanded section are an accordion of their
  // own: ONE group open at a time, the group holding the current page by
  // default (the first group when the current page is elsewhere), so the
  // sidebar never lists every page of Recruitment at once. The person may open
  // another group (the open one folds) or fold the open one; any navigation
  // returns to following the current page. Nothing is persisted. The rail's
  // flyout and a section with no groups keep every page visible.
  const activeGroupId = groups.find((g) => g.children.some((c) => c.id === activeItemId))?.id ?? null;
  const [chosenGroup, setChosenGroup] = useState<string | null | undefined>(undefined);
  useEffect(() => { setChosenGroup(undefined); }, [activeItemId]);
  const openGroup = chosenGroup === undefined ? (activeGroupId ?? groups[0]?.id ?? null) : chosenGroup;

  // A group is a labelled container, not a destination: role="group" with its
  // name. In the accordion its heading is a disclosure button (aria-expanded,
  // aria-controls) that never navigates; in the flyout menu it is plain text.
  const pages = (g: NavGroupView, role: 'menuitem' | undefined) => g.children.map((c) => (
    <button
      key={c.id}
      role={role}
      className={`nav-child ${activeItemId === c.id ? 'active' : ''}`}
      aria-current={activeItemId === c.id ? 'page' : undefined}
      onClick={() => onNavigate(c.id)}
    >
      {tr(c.labelKey)}
    </button>
  ));
  const children = (role: 'menuitem' | undefined, accordion: boolean) => groups.map((g) => {
    if (!g.labelKey) return <div key="all" className="nav-group">{pages(g, role)}</div>;
    const name = tr(g.labelKey);
    if (!accordion) {
      return (
        <div key={g.id} className="nav-group" role="group" aria-label={name}>
          <div className="nav-group-label" aria-hidden="true">{name}</div>
          {pages(g, role)}
        </div>
      );
    }
    const isOpen = openGroup === g.id;
    const gid = `${panelId}-${g.id}`;
    return (
      <div key={g.id} className={`nav-group ${isOpen ? 'open' : ''} ${activeGroupId === g.id ? 'has-active' : ''}`} role="group" aria-label={name}>
        <button
          type="button"
          className="nav-group-label"
          aria-expanded={isOpen}
          aria-controls={gid}
          onClick={() => setChosenGroup(isOpen ? null : g.id)}
        >
          <span className="grow">{name}</span>
          <Icon name="chevron" size={11} />
        </button>
        {isOpen && <div id={gid} className="nav-group-pages">{pages(g, role)}</div>}
      </div>
    );
  });

  if (collapsed) {
    // Rail: a single-child section navigates; a multi-child one opens a menu.
    return (
      <div className="nav-sec" onMouseLeave={() => flyoutOpen && onFlyout(false)}>
        <button
          ref={iconRef}
          className={`nav-section ${active ? 'active' : ''}`}
          aria-current={active ? 'page' : undefined}
          aria-label={label}
          title={label}
          aria-haspopup={multi ? 'menu' : undefined}
          aria-expanded={multi ? flyoutOpen : undefined}
          onClick={() => (multi ? onFlyout(!flyoutOpen) : onNavigate(s.children[0].id))}
          onKeyDown={(e) => { if (multi && e.key === 'ArrowRight') { e.preventDefault(); onFlyout(true); } }}
        >
          <Icon name={s.icon} />
          {!!count && count > 0 && <span className="nav-badge" aria-label={`${count}`}>{count}</span>}
          {active && <span className="nav-active-bar" aria-hidden="true" />}
        </button>
        {multi && flyoutOpen && (
          <div ref={flyRef} className="nav-flyout" role="menu" aria-label={label} onKeyDown={onFlyKey}>
            <div className="nav-flyout-title" aria-hidden="true">{label}</div>
            {children('menuitem', false)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`nav-sec ${expanded && multi ? 'open' : ''}`}>
      <div className="nav-sec-row">
        <button
          className={`nav-section ${active ? 'active' : ''}`}
          aria-current={active ? 'page' : undefined}
          aria-label={label}
          aria-expanded={expandOnSelect && multi ? expanded : undefined}
          onClick={() => (expandOnSelect && multi ? onToggle() : onNavigate(s.children[0].id))}
        >
          <Icon name={s.icon} />
          <span className="grow">{label}</span>
          {!!count && count > 0 && <span className="nav-badge" aria-label={`${count}`}>{count}</span>}
          {active && <span className="nav-active-bar" aria-hidden="true" />}
        </button>
        {multi && (
          <button
            className="nav-toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={`${t('navsec.toggle')} ${label}`}
            title={`${t('navsec.toggle')} ${label}`}
            onClick={onToggle}
          >
            <Icon name="chevron" size={12} />
          </button>
        )}
      </div>
      {multi && expanded && (
        <div id={panelId} className="nav-children" aria-label={`${t('navsec.pagesIn')} ${label}`}>
          {children(undefined, true)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- SecondaryNav
// P2.5: phone width only (CSS hides it above 900px, where the sidebar lists
// the same pages). It shows the active GROUP's siblings — never the whole
// section. P2.5 closure: a group longer than one row shows its primary pages
// and puts the rest behind an explicit "More" menu (`stripLayout`), so no
// page is discoverable only by scrolling a clipped strip. When the current
// page sits in the menu, the More control carries its name and the active
// state. Keyboard: roving arrows across the tabs; the menu is a real menu.
export function SecondaryNav({ section, activeItemId, onNavigate }: {
  section: NavSection;
  activeItemId: ScreenId | null;
  onNavigate: (id: ScreenId) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { visible, overflow, activeInOverflow } = stripLayout(section, activeItemId);
  const label = (c: NavItem) => tr(c.shortKey ?? c.labelKey);

  useEffect(() => { setOpen(false); }, [activeItemId, section.id]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (visible.length + overflow.length <= 1) return null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? []);
    const i = btns.findIndex((b) => b === document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length]?.focus();
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
    const i = items.findIndex((b) => b === document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); moreRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  const pick = (id: ScreenId) => {
    setOpen(false);
    onNavigate(id);
    // Focus must not be stranded on a removed menu: the More control if it is
    // still there, otherwise the page title.
    requestAnimationFrame(() => (moreRef.current ?? document.querySelector<HTMLElement>('h1.page-title'))?.focus());
  };

  return (
    <nav className="subnav" aria-label={t('navsec.inThisArea')} ref={ref} onKeyDown={onKey}>
      {visible.map((c) => (
        <button
          key={c.id}
          className={activeItemId === c.id ? 'active' : ''}
          aria-current={activeItemId === c.id ? 'page' : undefined}
          onClick={() => onNavigate(c.id)}
        >
          {label(c)}
        </button>
      ))}
      {overflow.length > 0 && (
        <button
          ref={moreRef}
          className={`subnav-more ${activeInOverflow ? 'active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={`subnav-more-${section.id}`}
          aria-label={activeInOverflow ? `${t('navsec.moreAria')} — ${tr(activeInOverflow.labelKey)}` : `${t('navsec.moreAria')} (${overflow.length})`}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
        >
          {/* Current page inside the menu: the control shows THAT page's name
              with the active state and the menu caret; its accessible name
              still says it is the More menu. Otherwise "More" + a count. */}
          {activeInOverflow ? <b>{label(activeInOverflow)}</b> : <>{t('navsec.more')} <span className="subnav-more-count">{overflow.length}</span></>}
          <span className="subnav-caret" aria-hidden="true">▾</span>
        </button>
      )}
      {open && (
        <div id={`subnav-more-${section.id}`} ref={menuRef} className="subnav-menu" role="menu" aria-label={t('navsec.moreMenu')} onKeyDown={onMenuKey}>
          {overflow.map((c) => (
            <button
              key={c.id}
              role="menuitem"
              className={`subnav-menu-item ${activeItemId === c.id ? 'active' : ''}`}
              aria-current={activeItemId === c.id ? 'page' : undefined}
              onClick={() => pick(c.id)}
            >
              {tr(c.labelKey)}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

// ------------------------------------------------------------------ TopBar
/**
 * One row. The page title is the page's `<h1>` (§47); the crumb inside it is
 * the owning section, muted. Live state is a dot while healthy and a red
 * pill while reconnecting — the one state a user must act on. Report / Block
 * is never hidden (§33): under 640px it shrinks to its glyph with the same
 * accessible name.
 */
export function TopBar({ title, crumb, edition, live, unread, bellOpen, drawerOpen = false, theme, onToggleTheme, onOpenPalette, onToggleBell, onReport, onOpenDrawer }: {
  title: string; crumb?: string | null; edition?: string; live: boolean; unread: number; bellOpen: boolean; drawerOpen?: boolean;
  theme: Theme; onToggleTheme: () => void; onOpenPalette: () => void;
  onToggleBell: () => void; onReport: () => void; onOpenDrawer: () => void;
}) {
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '');
  return (
    <header className="topbar">
      {/* PRE-M24 (PM-7): the menu button says whether the drawer is open */}
      <button className="nav-hamburger" aria-label={t('navsec.openMenu')} aria-expanded={drawerOpen} aria-controls="app-sidebar" onClick={onOpenDrawer}><Icon name="menu" /></button>
      {/* M24A — the reference breadcrumb: edition / section / page. The page
          name stays the document's <h1>; the parts before it are its path. */}
      <div className="p-breadcrumb">
        {edition && <span className="crumb crumb-edition" aria-hidden="true">{edition}<span className="crumb-sep"> / </span></span>}
        <h1 className="page-title" tabIndex={-1}>
          {crumb && <><span className="crumb">{crumb}</span><span className="crumb-sep"> / </span></>}
          {title}
        </h1>
      </div>
      <div className="p-toolbar">

        <button className="p-top-search" onClick={onOpenPalette} aria-label={t('navsec.searchAria')} title={t('navsec.searchAria')}>
          <Icon name="search" size={18} />
          <span>{t('navsec.searchWorkspace')}</span>
          <kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>
        {live
          ? <span className="live-dot on" role="status" aria-label={t('navsec.liveOk')} title={t('navsec.liveOk')} />
          : <span className="pill red" role="status">○ {t('navsec.liveOff')}</span>}
        <button
          className="topbar-bell"
          onClick={onToggleBell}
          title="Notifications"
          aria-label={`Notifications${unread > 0 ? ` — ${unread} unread` : ''}`}
          aria-expanded={bellOpen}
        >
          <Icon name="bell" size={18} />{unread > 0 && <span className="bell-badge" aria-hidden="true">{unread}</span>}
        </button>
        <button className="topbar-safety" onClick={onReport} title={t('navsec.reportAria')} aria-label={t('navsec.reportAria')}>
          <Icon name="flag" size={18} /> <span className="safety-long">{t('navsec.report')}</span>
        </button>
      </div>
    </header>
  );
}

/** The organisation's standing badges — moved out of the top bar, where they
 *  repeated on every page, to the account block, where the organisation is
 *  named. Same pills, same wording. */
export function OrgChips({ org }: { org: { type: string; trustedPartner?: boolean; safeguardingCertified?: boolean; verified?: boolean } }) {
  // M24D — one quiet line of standing, not a row of badges: the same facts, as text.
  // M24F — presentation casing: "Club · Verified · Safeguarding Certified"; the data values stay as they are.
  const facts = [
    org.type === 'club' ? 'Club' : org.type === 'academy' ? 'Academy' : org.type.charAt(0).toUpperCase() + org.type.slice(1),
    org.type === 'club' ? (org.verified ? 'Verified' : 'Verification Pending · U18 hidden') : null,
    org.trustedPartner ? 'Trusted Partner' : null,
    org.safeguardingCertified ? 'Safeguarding Certified' : null,
  ].filter(Boolean);
  return <div className="org-chips org-standing" aria-label={t('navsec.orgStatus')}>{facts.map((fact,i)=><span key={i}>{fact}</span>)}</div>;
}

// ---------------------------------------------------------- CommandPalette
export function CommandPalette({ ctx, open, onClose, onNavigate, shortcuts, onTogglePin }: {
  ctx: NavContext;
  open: boolean;
  onClose: () => void;
  onNavigate: (id: ScreenId) => void;
  shortcuts: ScreenId[];
  onTogglePin: (id: ScreenId) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  if (!open) return null;
  const results = searchNav(q, ctx, tr);
  const go = (itemId: ScreenId) => { onNavigate(itemId); onClose(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); go(results[sel].itemId as ScreenId); }
  };
  return (
    <div className="palette-veil" onClick={onClose} role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('navsec.searchAria')} onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input-row">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            placeholder={t('navsec.searchPlaceholder')}
            aria-label={t('navsec.searchAria')}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" role="listbox" aria-label={t('navsec.searchResults')}>
          {results.length === 0 && <div className="notice" style={{ margin: 8 }}>{t('navsec.searchEmpty')}</div>}
          {results.map((r, i) => {
            const pinned = shortcuts.includes(r.itemId as ScreenId);
            const canPin = !pinned && shortcuts.length < MAX_SHORTCUTS && r.itemId !== 'messages';
            return (
              <div
                key={r.itemId}
                role="option"
                aria-selected={i === sel}
                className={`palette-row ${i === sel ? 'selected' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => go(r.itemId as ScreenId)}
              >
                <span className="palette-path">
                  {r.sectionLabel && <><span className="dim">{r.sectionLabel}</span><span className="dim"> › </span></>}
                  {r.groupLabel && <><span className="dim">{r.groupLabel}</span><span className="dim"> › </span></>}
                  <b>{r.label}</b>
                </span>
                {(pinned || canPin) && (
                  <button
                    className={`palette-pin ${pinned ? 'pinned' : ''}`}
                    aria-label={pinned ? t('navsec.unpin') : t('navsec.pin')}
                    title={pinned ? t('navsec.unpin') : t('navsec.pin')}
                    onClick={(e) => { e.stopPropagation(); onTogglePin(r.itemId as ScreenId); }}
                  >
                    <Icon name="pin" size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Global ⌘K / Ctrl+K. Modifier-gated, so plain typing in inputs is never
 *  affected; the browser's own shortcut is prevented while the app is open. */
export function usePaletteHotkey(openPalette: () => void) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);
}

// Convenience hook: filtered sections recomputed only when ctx changes.
export function useNavSections(ctx: NavContext): NavSection[] {
  const [sections, setSections] = useState(() => filterSections(ctx));
  useEffect(() => { setSections(filterSections(ctx)); }, [ctx.role, ctx.verLevel]); // eslint-disable-line react-hooks/exhaustive-deps
  return sections;
}
export { INBOX_ITEM };

// ---------------------------------------------------- Home action centre
// "Needs attention" — honest counts only, sourced from data the workspace
// already loads (unread inbox) plus the verification request queue for
// users who hold reviewer authority. Nothing here invents backend numbers;
// when there is nothing to act on, the card disappears entirely.
import type { Session } from './api';
import { m14 } from './m14api';

export function NeedsAttention({ session, tick, unreadMessages, verLevel, onNavigate }: {
  session: Session; tick: number; unreadMessages: number; verLevel: string | null;
  onNavigate: (id: ScreenId) => void;
}) {
  const [verRequests, setVerRequests] = useState<number | null>(null);
  const reviewer = verLevel !== null; // convenience gate; the server still decides
  useEffect(() => {
    if (!reviewer) { setVerRequests(null); return; }
    let gone = false;
    m14.listRequests(session)
      .then((r) => { if (!gone) setVerRequests(r.items.length); })
      .catch(() => { if (!gone) setVerRequests(null); }); // 403 → simply no card
    return () => { gone = true; };
  }, [session, tick, reviewer]);
  const rows: { key: string; label: string; count: number; target: ScreenId }[] = [];
  if (unreadMessages > 0) rows.push({ key: 'inbox', label: t('navsec.attnMessages'), count: unreadMessages, target: 'messages' });
  if (verRequests !== null && verRequests > 0) rows.push({ key: 'ver', label: t('navsec.attnVerification'), count: verRequests, target: 'verification' });
  if (rows.length === 0) return null;
  return (
    <div className="attn-card" role="region" aria-label={t('navsec.attnTitle')}>
      <div className="attn-title">{t('navsec.attnTitle')}</div>
      {rows.map((r) => (
        <button key={r.key} className="attn-row" onClick={() => onNavigate(r.target)}>
          <span className="attn-count">{r.count}</span>
          <span className="grow">{r.label}</span>
          <Icon name="chevron" size={12} />
        </button>
      ))}
    </div>
  );
}
