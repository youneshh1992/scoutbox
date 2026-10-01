// M24B — case navigation: CATEGORY → SUBCATEGORY, for one recruitment case.
//
// A case (a Recruitment Room, a client, a transaction, the player's own
// journey) has many FUNCTIONS. They used to sit in one flat tab strip that
// grew by one tab per milestone. They are now arranged in a small number of
// categories, each holding at most CASE_NAV_MAX_SUBS subcategories.
//
// Three rules this module keeps:
//   • A category is UI organisation only. It is not a lifecycle state, it is
//     never persisted, and nothing on the server knows the word. The journey
//     projection stays the one source of truth for where a case is.
//   • Every subcategory is a function the application already had (or a
//     read-only view over canonical records). Nothing here invents one.
//   • The model is DATA, validated by `validateCaseNav` and asserted by
//     e2e/caseNav.test.mjs, so a sixth subcategory fails a test rather than
//     quietly widening a row.
//
// Routing: a deep link names `<category>/<sub>`; a legacy flat link names a
// single tab id, which `parseCaseSegments` still resolves — the server's
// notification targets and next-action tabs keep working unchanged.

export interface CaseSub {
  /** Stable id; appears in deep links and in `data-sub` attributes. */
  id: string;
  /** Translation key for the label. */
  labelKey: string;
  /** Legacy flat tab ids that resolve to this subcategory (deep links, notifications, next actions). */
  legacy?: readonly string[];
}

export interface CaseCategory {
  id: string;
  labelKey: string;
  subs: readonly CaseSub[];
}

export interface CaseNavModel {
  /** Which case this model describes (room, client, transaction, player). */
  id: string;
  categories: readonly CaseCategory[];
}

export interface CaseLocation { category: string; sub: string }

/** The hard rule: no category may hold more than this many subcategories. */
export const CASE_NAV_MAX_SUBS = 5;

const SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * Structural soundness, as a list of problems (empty = sound). Checked by the
 * node suite for every application's model.
 */
export function validateCaseNav(model: CaseNavModel): string[] {
  const problems: string[] = [];
  const catIds = new Set<string>();
  const subIds = new Set<string>();
  const legacyIds = new Set<string>();
  if (model.categories.length === 0) problems.push(`${model.id}: no categories`);
  for (const c of model.categories) {
    if (!SLUG.test(c.id)) problems.push(`${model.id}/${c.id}: category id is not a slug`);
    if (catIds.has(c.id)) problems.push(`${model.id}/${c.id}: duplicate category id`);
    catIds.add(c.id);
    if (c.subs.length === 0) problems.push(`${model.id}/${c.id}: empty category`);
    if (c.subs.length > CASE_NAV_MAX_SUBS) problems.push(`${model.id}/${c.id}: ${c.subs.length} subcategories (max ${CASE_NAV_MAX_SUBS})`);
    for (const s of c.subs) {
      if (!SLUG.test(s.id)) problems.push(`${model.id}/${c.id}/${s.id}: sub id is not a slug`);
      if (subIds.has(s.id)) problems.push(`${model.id}: "${s.id}" appears in more than one category`);
      subIds.add(s.id);
      for (const l of s.legacy ?? []) {
        if (legacyIds.has(l)) problems.push(`${model.id}: legacy tab "${l}" maps to more than one sub`);
        legacyIds.add(l);
      }
    }
  }
  // A category id must never collide with a sub id: "<id>" alone in a link
  // would otherwise be ambiguous.
  for (const id of catIds) if (subIds.has(id)) problems.push(`${model.id}: "${id}" is both a category and a sub`);
  return problems;
}

export function defaultLocation(model: CaseNavModel): CaseLocation {
  const c = model.categories[0];
  return { category: c.id, sub: c.subs[0].id };
}

export function categoryOf(model: CaseNavModel, categoryId: string): CaseCategory | null {
  return model.categories.find((c) => c.id === categoryId) ?? null;
}

/** The location of a subcategory by its own id. */
export function locate(model: CaseNavModel, subId: string): CaseLocation | null {
  for (const c of model.categories) for (const s of c.subs) if (s.id === subId) return { category: c.id, sub: s.id };
  return null;
}

/** A sub id OR a legacy flat tab id → its location. */
export function resolveTab(model: CaseNavModel, tab: string | null | undefined): CaseLocation | null {
  if (!tab) return null;
  const direct = locate(model, tab);
  if (direct) return direct;
  for (const c of model.categories) for (const s of c.subs) if (s.legacy?.includes(tab)) return { category: c.id, sub: s.id };
  return null;
}

/**
 * Path segments after the case id → a location, strictly:
 *   []                 → the default (first category, first sub)
 *   [category]         → that category's first sub
 *   [tab]              → a sub id or a legacy tab id
 *   [category, sub]    → that sub, which must belong to that category
 * Anything else is null (a malformed link rejects, exactly as before).
 */
export function parseCaseSegments(model: CaseNavModel, segs: readonly string[]): CaseLocation | null {
  if (segs.length === 0) return defaultLocation(model);
  if (segs.length === 1) {
    const cat = categoryOf(model, segs[0]);
    if (cat) return { category: cat.id, sub: cat.subs[0].id };
    return resolveTab(model, segs[0]);
  }
  if (segs.length === 2) {
    const cat = categoryOf(model, segs[0]);
    if (!cat) return null;
    const sub = cat.subs.find((s) => s.id === segs[1]);
    return sub ? { category: cat.id, sub: sub.id } : null;
  }
  return null;
}

/** The segments a link carries for a location: none for the default, else `[category, sub]`. */
export function caseSegments(model: CaseNavModel, loc: CaseLocation | null | undefined): string[] {
  if (!loc) return [];
  const d = defaultLocation(model);
  if (loc.category === d.category && loc.sub === d.sub) return [];
  return [loc.category, loc.sub];
}

/** Every sub id in display order. */
export function allSubs(model: CaseNavModel): string[] {
  return model.categories.flatMap((c) => c.subs.map((s) => s.id));
}

/** The largest category in the model (for the max-5 assertion). */
export function widestCategory(model: CaseNavModel): number {
  return Math.max(0, ...model.categories.map((c) => c.subs.length));
}
