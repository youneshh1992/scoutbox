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
// This file is byte-identical in Pro and Grassroots; the brand is a prop.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ScreenId } from './App';
import {
  INBOX_ITEM, MAX_SHORTCUTS, type NavContext, type NavItem, type NavLocation, type NavSection,
  allItems, filterSections, groupSiblings, groupedChildren, searchNav,
} from './nav';
import { Icon } from './icons';
import { t } from './i18n';

type TKey = Parameters<typeof t>[0];
const tr = (key: string) => t(key as TKey);

export interface Brand { short: string; long: string }

// ------------------------------------------------------------------ Sidebar
export function Sidebar({
  sections, location, onNavigate, collapsed, onToggleCollapsed, shortcuts,
  onTogglePin, unreadMessages, badges = {}, onOpenPalette, drawerOpen, onCloseDrawer, footer, brand,
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
}) {
  const labelFor = (id: ScreenId) => {
    const hit = allItems().find(({ item }) => item.id === id);
    return hit ? tr(hit.item.labelKey) : id;
  };
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '');

  // Accordion state. The active section is ALWAYS open; others can be opened
  // for the session with their chevron. Deterministic and unpersisted.
  const [open, setOpen] = useState<Set<string>>(() => new Set(location.sectionId ? [location.sectionId] : []));
  useEffect(() => {
    if (location.sectionId) setOpen((prev) => (prev.has(location.sectionId!) ? prev : new Set(prev).add(location.sectionId!)));
  }, [location.sectionId]);
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

  return (
    <>
      {drawerOpen && <div className="drawer-veil nav-drawer-veil" onClick={onCloseDrawer} />}
      <nav ref={navRef} className={`sidebar ${collapsed ? 'collapsed' : ''} ${drawerOpen ? 'drawer-open' : ''}`} aria-label="Main navigation">
        <div className="brand">{collapsed ? <span>S<span className="brand-sub">{brand.short}</span></span> : <>Scout<span>Box</span> <span className="brand-sub">{brand.long}</span></>}</div>

        <button className="nav-search" onClick={onOpenPalette} aria-label={t('navsec.searchAria')} title={t('navsec.searchAria')}>
          <Icon name="search" />
          {!collapsed && <><span className="grow">{t('navsec.search')}</span><kbd>{isMac ? '⌘K' : 'Ctrl+K'}</kbd></>}
        </button>

        {sections.map((s) => (
          <SectionRow
            key={s.id}
            section={s}
            active={location.sectionId === s.id}
            activeItemId={location.itemId}
            expanded={open.has(s.id)}
            onToggle={() => toggle(s.id)}
            collapsed={collapsed}
            flyoutOpen={flyout === s.id}
            onFlyout={(want) => setFlyout(want ? s.id : null)}
            count={badges[s.id]}
            onNavigate={go}
          />
        ))}

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

        <div className="nav-divider" role="separator" />
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
        </button>

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
function SectionRow({ section: s, active, activeItemId, expanded, onToggle, collapsed, flyoutOpen, onFlyout, count, onNavigate }: {
  section: NavSection; active: boolean; activeItemId: ScreenId | null; expanded: boolean; onToggle: () => void;
  collapsed: boolean; flyoutOpen: boolean; onFlyout: (open: boolean) => void; count?: number; onNavigate: (id: ScreenId) => void;
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

  const children = (role: 'menuitem' | undefined) => groups.map((g) => (
    <div key={g.id ?? 'all'} className="nav-group">
      {g.labelKey && <div className="nav-group-label">{tr(g.labelKey)}</div>}
      {g.children.map((c) => (
        <button
          key={c.id}
          role={role}
          className={`nav-child ${activeItemId === c.id ? 'active' : ''}`}
          aria-current={activeItemId === c.id ? 'page' : undefined}
          onClick={() => onNavigate(c.id)}
        >
          {tr(c.labelKey)}
        </button>
      ))}
    </div>
  ));

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
            {children('menuitem')}
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
          onClick={() => onNavigate(s.children[0].id)}
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
          {children(undefined)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- SecondaryNav
// P2.5: phone width only (CSS hides it above 900px, where the sidebar lists
// the same pages). It shows the active GROUP's siblings — never the whole
// section — so it fits in one row. Keyboard: roving arrows.
export function SecondaryNav({ section, activeItemId, onNavigate }: {
  section: NavSection;
  activeItemId: ScreenId | null;
  onNavigate: (id: ScreenId) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const items: NavItem[] = groupSiblings(section, activeItemId);
  if (items.length <= 1) return null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = btns.findIndex((b) => b === document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length]?.focus();
  };
  return (
    <nav className="subnav" aria-label={t('navsec.inThisArea')} ref={ref} onKeyDown={onKey}>
      {items.map((c) => (
        <button
          key={c.id}
          className={activeItemId === c.id ? 'active' : ''}
          aria-current={activeItemId === c.id ? 'page' : undefined}
          onClick={() => onNavigate(c.id)}
        >
          {tr(c.labelKey)}
        </button>
      ))}
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
export function TopBar({ title, crumb, live, unread, bellOpen, onToggleBell, onReport, onOpenDrawer }: {
  title: string; crumb?: string | null; live: boolean; unread: number; bellOpen: boolean;
  onToggleBell: () => void; onReport: () => void; onOpenDrawer: () => void;
}) {
  return (
    <header className="topbar">
      <button className="nav-hamburger" aria-label={t('navsec.openMenu')} onClick={onOpenDrawer}><Icon name="menu" /></button>
      <h1 className="page-title">
        {crumb && <><span className="crumb">{crumb}</span><span className="crumb-sep"> / </span></>}
        {title}
      </h1>
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
        🔔{unread > 0 && <span className="bell-badge" aria-hidden="true">{unread}</span>}
      </button>
      <button className="topbar-safety" onClick={onReport} title={t('navsec.reportAria')} aria-label={t('navsec.reportAria')}>
        <span aria-hidden="true">⚑</span> <span className="safety-long">{t('navsec.report')}</span>
      </button>
    </header>
  );
}

/** The organisation's standing badges — moved out of the top bar, where they
 *  repeated on every page, to the account block, where the organisation is
 *  named. Same pills, same wording. */
export function OrgChips({ org }: { org: { type: string; trustedPartner?: boolean; safeguardingCertified?: boolean; verified?: boolean } }) {
  return (
    <div className="org-chips" aria-label={t('navsec.orgStatus')}>
      {org.trustedPartner && <span className="pill gold">Trusted Partner</span>}
      {org.safeguardingCertified && <span className="pill green">🛡 Safeguarding Certified</span>}
      {org.type === 'club' && (org.verified
        ? <span className="pill outline-green">Verified club</span>
        : <span className="pill">verification pending — U18 hidden</span>)}
      <span className={`pill ${org.type === 'agency' ? 'red' : 'blue'}`}>{org.type}</span>
    </div>
  );
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
