// Saved searches. When a player joins, SQL narrows the saved searches of current staff to those the player could
// match, and the whole filter is then applied to the player as the club sees them.
//
// An empty or blank string, `false` or null means "no filter", as the apps send it.
import { SAVED_SEARCH_FILTERS, SEARCH_AGE_GROUPS, OPERATIONS_LIMITS } from '../../repositories/operations.mjs';
import { PLAYER_POSITIONS, PLAYER_FEET, PLAYER_AVAILABILITY } from '../../repositories/identity.mjs';

const L = OPERATIONS_LIMITS;
const unset = (v) => v === undefined || v === null || v === false || (typeof v === 'string' && !v.trim());
const RULES = {
  q: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= L.searchQ,
  position: (v) => PLAYER_POSITIONS.includes(v),
  foot: (v) => PLAYER_FEET.includes(v),
  availability: (v) => PLAYER_AVAILABILITY.includes(v),
  country: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= L.country,
  academyPlus: (v) => v === true,
  ageGroup: (v) => SEARCH_AGE_GROUPS.includes(v),
  newDays: (v) => Number.isSafeInteger(v) && v >= 1 && v <= L.newDays,
};

/** The filters as stored (only the set ones), or `{ field }` naming the first junk one. */
export function readSearchFilters(raw) {
  if (raw === undefined || raw === null) return { filters: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { field: 'filters' };
  const filters = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!SAVED_SEARCH_FILTERS.includes(k)) return { field: `filters.${k}` };
    if (unset(v)) continue;
    if (!RULES[k](v)) return { field: `filters.${k}` };
    filters[k] = v;
  }
  return { filters };
}

function matchesSearch(view, f) {
  if (f.q) {
    const n = String(f.q).toLowerCase();
    if (!view.name.toLowerCase().includes(n) && !(view.city || '').toLowerCase().includes(n) && !(view.country || '').toLowerCase().includes(n)) return false;
  }
  if (f.position && view.position !== f.position) return false;
  if (f.availability && view.availability !== f.availability) return false;
  if (f.academyPlus && !view.academyPlus) return false;
  if (f.country && view.country !== f.country) return false;
  if (f.foot && view.foot !== f.foot) return false;
  if (f.ageGroup === 'u16' && view.age >= 16) return false;
  if (f.ageGroup === 'u18' && view.age >= 18) return false;
  if (f.ageGroup === '18-21' && (view.age < 18 || view.age > 21)) return false;
  if (f.ageGroup === 'senior' && view.age < 22) return false;
  return true;
}

const searchView = (s) => ({ id: s.id, orgId: s.orgId, userId: s.userId, scoutName: s.scoutName, name: s.name, filters: { ...s.filters }, createdAt: s.createdAt });

export function registerSavedSearches({ byId, orgRouter, notify, nextId, playerViewForOrg, reqText, savedSearches }) {
  if (typeof savedSearches?.create !== 'function') throw new TypeError('registerSavedSearches needs the saved-searches repository');

  function checkSavedSearches(player) {
    for (const ss of savedSearches.candidatesFor({ position: player.position ?? null, foot: player.foot ?? null, country: player.country ?? null, availability: player.availability ?? null })) {
      const org = byId.org(ss.orgId);
      if (!org) continue;
      const view = playerViewForOrg(player, org);
      if (view && matchesSearch(view, ss.filters)) {
        notify({ kind: 'org_user', id: ss.userId }, 'saved_search', `New match for your saved search “${ss.name}”: ${player.name} (${player.position ?? '—'}) just joined.`, player.id);
      }
    }
  }

  // One club's list: not paged.
  orgRouter.get('/searches', (req, res) => {
    res.json(savedSearches.forOrg(req.org.id).map(searchView));
  });

  orgRouter.post('/searches', (req, res) => {
    const { name, filters } = req.body || {};
    if (!reqText(name, L.searchName)) return res.status(400).json({ error: 'NAME_REQUIRED' });
    const read = readSearchFilters(filters);
    if (read.field) return res.status(400).json({ error: 'FIELD_INVALID', field: read.field, message: `${read.field} is not a search filter this build accepts.` });
    const ss = savedSearches.create({ id: nextId('ss'), orgId: req.org.id, userId: req.orgUser.id, name: name.trim(), filters: read.filters, createdAt: Date.now() });
    res.status(201).json(searchView(ss));
  });

  orgRouter.delete('/searches/:id', (req, res) => {
    if (!savedSearches.remove(req.org.id, req.params.id)) return res.status(404).json({ error: 'SEARCH_NOT_FOUND' });
    res.json({ ok: true });
  });

  return { checkSavedSearches };
}
