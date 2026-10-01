// M24B — the two-row case navigation for the portals.
//
//   Row 1 — the categories: a segmented control. The current one is marked
//           by weight, a dot and `aria-current`, never by colour alone.
//   Row 2 — the current category's subcategories: a real ARIA tablist
//           (role=tab, aria-selected, aria-controls), lighter than row 1.
//
// At phone width both rows scroll horizontally and every target is at least
// 44px tall; the current category and subcategory are scrolled into view so
// the active item is never off screen. Only the current category's
// subcategories are in the DOM — a function the audience may not see is not
// rendered hidden, it is absent.
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { categoryOf, type CaseCategory, type CaseLocation, type CaseNavModel, type CaseSub } from './caseNav';

export interface CaseNavProps {
  model: CaseNavModel;
  value: CaseLocation;
  onChange: (loc: CaseLocation) => void;
  translate: (key: string) => string;
  /** Element id prefix: `${idPrefix}-tab-${sub}` / `${idPrefix}-panel-${sub}`. */
  idPrefix: string;
  /** Accessible name of the whole control (e.g. "Room sections"). */
  label: string;
  /** Accessible name of the category row (e.g. "Areas of this case"). */
  categoriesLabel: string;
  /** Accessible name of the subcategory row for a category (e.g. "Pages in Evaluation"). */
  subsLabel: (categoryLabel: string) => string;
  /** Audience / role filter: a sub that returns false is not rendered; a category with no visible sub is not rendered. */
  visible?: (sub: CaseSub, category: CaseCategory) => boolean;
  testId?: string;
  /** Optional per-button test ids (the suites address subcategories by id). */
  catTestId?: (categoryId: string) => string;
  subTestId?: (subId: string) => string;
}

export function visibleCategories(model: CaseNavModel, visible?: CaseNavProps['visible']): { category: CaseCategory; subs: CaseSub[] }[] {
  return model.categories
    .map((category) => ({ category, subs: category.subs.filter((s) => !visible || visible(s, category)) }))
    .filter((c) => c.subs.length > 0);
}

function rove(e: KeyboardEvent<HTMLElement>, ids: string[], current: string, go: (id: string) => void) {
  const i = ids.indexOf(current);
  if (i < 0) return;
  let next: number | null = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = ids.length - 1;
  if (next === null) return;
  e.preventDefault();
  go(ids[next]);
}

function intoView(el: Element | null) {
  try { (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* not in a layout context */ }
}

export function CaseNav({ model, value, onChange, translate, idPrefix, label, categoriesLabel, subsLabel, visible, testId, catTestId, subTestId }: CaseNavProps) {
  const cats = visibleCategories(model, visible);
  const active = cats.find((c) => c.category.id === value.category) ?? cats[0];
  const catsRef = useRef<HTMLUListElement>(null);
  const subsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll the current category and page into view: now, after the next
    // frame, once the fonts have settled (widths change), and on a resize —
    // so the active item is never off screen at 360px.
    const reveal = () => {
      intoView(catsRef.current?.querySelector('[aria-current="true"]') ?? null);
      intoView(subsRef.current?.querySelector('[aria-selected="true"]') ?? null);
    };
    reveal();
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(reveal) : null;
    const timer = setTimeout(reveal, 300);
    try { document.fonts?.ready?.then(reveal); } catch { /* no font API */ }
    window.addEventListener('resize', reveal);
    return () => { if (raf !== null) cancelAnimationFrame(raf); clearTimeout(timer); window.removeEventListener('resize', reveal); };
  }, [value.category, value.sub]);

  if (!active) return null;
  const catIds = cats.map((c) => c.category.id);
  const subIds = active.subs.map((s) => s.id);
  const pickCategory = (id: string) => {
    const c = cats.find((x) => x.category.id === id);
    if (!c) return;
    onChange({ category: c.category.id, sub: c.subs[0].id });
    // Focus follows the arrow keys so a keyboard user hears the new category.
    queueMicrotask(() => (catsRef.current?.querySelector<HTMLButtonElement>(`[data-cat="${id}"]`))?.focus());
  };
  const pickSub = (id: string) => {
    onChange({ category: active.category.id, sub: id });
    queueMicrotask(() => (subsRef.current?.querySelector<HTMLButtonElement>(`[data-sub="${id}"]`))?.focus());
  };
  const catLabel = translate(active.category.labelKey);

  return (
    <div className="casenav" data-casenav={model.id} data-category={active.category.id} data-sub={value.sub} data-testid={testId} aria-label={label} role="group">
      <nav className="casenav-catnav" aria-label={categoriesLabel}>
        <ul className="casenav-cats" ref={catsRef}>
          {cats.map(({ category, subs }) => {
            const current = category.id === active.category.id;
            return (
              <li key={category.id}>
                <button
                  type="button"
                  className={`casenav-cat${current ? ' active' : ''}`}
                  aria-current={current ? 'true' : undefined}
                  data-cat={category.id}
                  data-subs={subs.map((s) => s.id).join(' ')}
                  data-testid={catTestId?.(category.id)}
                  onClick={() => { if (!current) pickCategory(category.id); }}
                  onKeyDown={(e) => rove(e, catIds, category.id, pickCategory)}
                >
                  <span className="casenav-cat-text">{translate(category.labelKey)}</span>
                  <span className="casenav-cat-count" aria-hidden="true">{subs.length}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="casenav-subs" role="tablist" aria-label={subsLabel(catLabel)} ref={subsRef} data-cat={active.category.id}>
        {active.subs.map((s) => {
          const selected = s.id === value.sub;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${s.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${s.id}`}
              className={`casenav-sub${selected ? ' active' : ''}`}
              data-sub={s.id}
              data-testid={subTestId?.(s.id)}
              onClick={() => { if (!selected) pickSub(s.id); }}
              onKeyDown={(e) => rove(e, subIds, s.id, pickSub)}
            >
              {translate(s.labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The attributes a subcategory's panel carries so the tab → panel relation holds. */
export function casePanelProps(idPrefix: string, sub: string, label: string) {
  return { role: 'tabpanel' as const, id: `${idPrefix}-panel-${sub}`, 'aria-labelledby': `${idPrefix}-tab-${sub}`, 'aria-label': label };
}

/** A compact "Category / Sub" line for a breadcrumb or a header. */
export function CaseCrumb({ model, value, translate, prefix }: { model: CaseNavModel; value: CaseLocation; translate: (k: string) => string; prefix?: string[] }) {
  const cat = categoryOf(model, value.category);
  const sub = cat?.subs.find((s) => s.id === value.sub);
  if (!cat || !sub) return null;
  const parts = [...(prefix ?? []), translate(cat.labelKey), translate(sub.labelKey)];
  return (
    <p className="casenav-crumb" data-testid="case-crumb" aria-label={parts.join(' / ')}>
      {parts.map((p, i) => (
        <span key={`${i}-${p}`} className={i === parts.length - 1 ? 'casenav-crumb-current' : undefined}>
          {i > 0 && <span className="crumb-sep" aria-hidden="true"> / </span>}{p}
        </span>
      ))}
    </p>
  );
}
