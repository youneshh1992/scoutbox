// M15-Nav — navigation UI. All structure comes from nav.ts; nothing here
// keeps its own list of destinations. Visibility filtering is convenience —
// the server stays authoritative for every route.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ScreenId } from './App';
import {
  INBOX_ITEM, MAX_SHORTCUTS, type NavContext, type NavLocation, type NavSection,
  allItems, filterSections, searchNav,
} from './nav';
import { Icon } from './icons';
import { t } from './i18n';

// ------------------------------------------------------------------ Sidebar
export function Sidebar({
  sections, location, onNavigate, collapsed, onToggleCollapsed, shortcuts,
  onTogglePin, unreadMessages, badges = {}, onOpenPalette, drawerOpen, onCloseDrawer, footer,
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
}) {
  const labelFor = (id: ScreenId) => {
    const hit = allItems().find(({ item }) => item.id === id);
    return hit ? t(hit.item.labelKey as Parameters<typeof t>[0]) : id;
  };
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '');
  return (
    <>
      {drawerOpen && <div className="drawer-veil nav-drawer-veil" onClick={onCloseDrawer} />}
      <nav className={`sidebar ${collapsed ? 'collapsed' : ''} ${drawerOpen ? 'drawer-open' : ''}`} aria-label="Main navigation">
        <div className="brand">{collapsed ? <span>S<span className="brand-sub">G</span></span> : <>Scout<span>Box</span> <span className="brand-sub">Grassroots</span></>}</div>

        <button className="nav-search" onClick={onOpenPalette} aria-label={t('navsec.searchAria')} title={t('navsec.searchAria')}>
          <Icon name="search" />
          {!collapsed && <><span className="grow">{t('navsec.search')}</span><kbd>{isMac ? '⌘K' : 'Ctrl+K'}</kbd></>}
        </button>

        {sections.map((s) => {
          const active = location.sectionId === s.id;
          const label = t(s.labelKey as Parameters<typeof t>[0]);
          const count = badges[s.id];
          return (
            <button
              key={s.id}
              className={`nav-section ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              title={collapsed ? label : undefined}
              onClick={() => { onNavigate(s.children[0].id); onCloseDrawer(); }}
            >
              <Icon name={s.icon} />
              {!collapsed && <span className="grow">{label}</span>}
              {!!count && count > 0 && <span className="nav-badge" aria-label={`${count}`}>{count}</span>}
              {active && <span className="nav-active-bar" aria-hidden="true" />}
            </button>
          );
        })}

        {shortcuts.length > 0 && !collapsed && (
          <div className="nav-shortcuts">
            <div className="nav-group-label">{t('navsec.shortcuts')}</div>
            {shortcuts.map((id) => (
              <button key={id} className={`nav-shortcut ${location.itemId === id ? 'active' : ''}`} onClick={() => { onNavigate(id); onCloseDrawer(); }}>
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
          onClick={() => { onNavigate('messages'); onCloseDrawer(); }}
        >
          <Icon name="inbox" />
          {!collapsed && <span className="grow">{t('nav.messages')}</span>}
          {unreadMessages > 0 && <span className="nav-badge">{unreadMessages}</span>}
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

// ------------------------------------------------------------ SecondaryNav
// One reusable page-level tab row for the active section. Keyboard: roving
// arrows; narrow widths scroll horizontally (no unreachable tabs).
export function SecondaryNav({ section, activeItemId, onNavigate }: {
  section: NavSection;
  activeItemId: ScreenId | null;
  onNavigate: (id: ScreenId) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  if (section.children.length <= 1) return null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = btns.findIndex((b) => b === document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    next?.focus();
  };
  return (
    <nav className="subnav" aria-label={t(section.labelKey as Parameters<typeof t>[0])} ref={ref} onKeyDown={onKey}>
      {section.children.map((c) => (
        <button
          key={c.id}
          className={activeItemId === c.id ? 'active' : ''}
          aria-current={activeItemId === c.id ? 'page' : undefined}
          onClick={() => onNavigate(c.id)}
        >
          {t(c.labelKey as Parameters<typeof t>[0])}
        </button>
      ))}
    </nav>
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
  const results = searchNav(q, ctx, (k) => t(k as Parameters<typeof t>[0]));
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
