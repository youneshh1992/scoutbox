// M24B — the player's recruitment experience as CATEGORY → SUBCATEGORY.
//
// Plain data, no React Native imports: e2e/caseNav.test.mjs bundles this file
// and asserts the same rules as for the portals (every category ≤ 5
// subcategories, unique ids, legacy links resolve). The design-system module
// cannot be imported from the Expo root, so the few helpers the screen needs
// are repeated here, verbatim in behaviour.
//
// Nothing here reads anything a club keeps private: every subcategory is a
// view over /player/journeys, /player/inbox, /player/trials, /player/offers,
// /player/signings or the opportunities board — the same endpoints the
// Opportunities screen already read, split by what the player is doing.
// A category is UI organisation only; it is never a lifecycle state.

export interface PlayerCaseSub { id: string; labelKey: string }
export interface PlayerCaseCategory { id: string; labelKey: string; subs: readonly PlayerCaseSub[] }
export interface PlayerCaseNav { id: string; categories: readonly PlayerCaseCategory[] }
export interface PlayerCaseLocation { category: string; sub: string }

export const PLAYER_NAV: PlayerCaseNav = {
  id: 'player',
  // M24D — five categories, none wider than three pages. The Board (open
  // roles, fit, squad invites, follow-ups) is one page of the journey, and
  // the former Current stage / Tasks pages are part of the Overview.
  categories: [
    {
      id: 'journey', labelKey: 'catJourney',
      subs: [
        { id: 'overview', labelKey: 'subOverview' },
        { id: 'activity', labelKey: 'subActivity' },
        { id: 'board', labelKey: 'catBoard' },
      ],
    },
    {
      id: 'contact', labelKey: 'catContact',
      subs: [
        { id: 'messages', labelKey: 'subMessages' },
        { id: 'requests', labelKey: 'subContact' },
      ],
    },
    {
      id: 'trial', labelKey: 'catTrial',
      subs: [
        { id: 'invitation', labelKey: 'subInvitation' },
        { id: 'schedule', labelKey: 'subSchedule' },
        { id: 'details', labelKey: 'subDetails' },
      ],
    },
    {
      id: 'offer', labelKey: 'catOffer',
      subs: [
        { id: 'offer-terms', labelKey: 'subOffer' },
        { id: 'offer-documents', labelKey: 'subDocuments' },
        { id: 'offer-response', labelKey: 'subResponse' },
      ],
    },
    {
      id: 'signing', labelKey: 'catSigning',
      subs: [
        { id: 'signing-status', labelKey: 'subSigning' },
        { id: 'signing-documents', labelKey: 'subDocuments' },
        { id: 'signing-contract', labelKey: 'subContract' },
      ],
    },
  ],
};

/** M24D — links written before the Board became a page of the journey, and
 *  before Current stage and Tasks folded into the Overview, still land. */
export const PLAYER_LEGACY_SUBS: Readonly<Record<string, string>> = {
  stage: 'overview', tasks: 'overview',
  'board-open': 'board', 'board-fit': 'board', 'board-invites': 'board', 'board-followups': 'board',
};
const PLAYER_LEGACY_CATS: Readonly<Record<string, PlayerCaseLocation>> = { board: { category: 'journey', sub: 'board' } };

export function playerDefaultLocation(model: PlayerCaseNav = PLAYER_NAV): PlayerCaseLocation {
  const c = model.categories[0];
  return { category: c.id, sub: c.subs[0].id };
}

/** `?cat=&tab=` → a location, falling back category-first then to the default. Unknown values never throw. */
export function playerLocation(cat: string | string[] | undefined, tab: string | string[] | undefined, model: PlayerCaseNav = PLAYER_NAV): PlayerCaseLocation {
  const rawC = Array.isArray(cat) ? cat[0] : cat;
  const rawS = Array.isArray(tab) ? tab[0] : tab;
  const legacyCat = rawC ? PLAYER_LEGACY_CATS[rawC] : undefined;
  const c = legacyCat ? legacyCat.category : rawC;
  const s = rawS && PLAYER_LEGACY_SUBS[rawS] ? PLAYER_LEGACY_SUBS[rawS] : (rawS ?? legacyCat?.sub);
  const category = model.categories.find((x) => x.id === c) ?? null;
  if (category) {
    const sub = category.subs.find((x) => x.id === s) ?? category.subs[0];
    return { category: category.id, sub: sub.id };
  }
  if (s) for (const x of model.categories) for (const y of x.subs) if (y.id === s) return { category: x.id, sub: y.id };
  return playerDefaultLocation(model);
}

/** The route a notification target opens: the category that holds the record. */
export function playerCategoryFor(kind: 'trial' | 'offer' | 'signing' | 'inbox'): string {
  return kind === 'inbox' ? 'contact' : kind;
}
