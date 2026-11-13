/**
 * Saved searches: a club's "tell me when…" search, its filters as typed columns (no JSON). The scout's name is read
 * live from the staff row. Owned by discovery (domains/discovery/savedSearches.mjs).
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen.
 * Organisations and staff are RESTRICT keys.
 */
import {
  isPlainObject,
  describe,
  text,
  int,
  bool,
  oneOf,
  group,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  insertSql,
} from './fieldSpecs.mjs';
import { migrationApplied, operationOn } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { PLAYER_POSITIONS, PLAYER_FEET, PLAYER_AVAILABILITY } from './identity.mjs';

export const SAVED_SEARCHES_MIGRATION = '0038_operations';
export const SAVED_SEARCHES_COLLECTIONS = Object.freeze(['savedSearches']);
export const SAVED_SEARCHES_TABLES = Object.freeze(['saved_searches']);

export const SEARCH_AGE_GROUPS = Object.freeze(['u16', 'u18', '18-21', 'senior']);
export const SAVED_SEARCH_LIMITS = Object.freeze({ id: 80, name: 120, q: 120, country: 60, newDays: 3650 });
const L = SAVED_SEARCH_LIMITS;

const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };
const FILTER_SPEC = [
  text('q', 'q', L.q, { nonEmpty: true }),
  oneOf('position', 'position', PLAYER_POSITIONS),
  oneOf('foot', 'foot', PLAYER_FEET),
  oneOf('availability', 'availability', PLAYER_AVAILABILITY),
  text('country', 'country', L.country, { nonEmpty: true }),
  bool('academyPlus', 'academy_plus'),
  oneOf('ageGroup', 'age_group', SEARCH_AGE_GROUPS),
  int('newDays', 'new_days'),
];
export const SAVED_SEARCH_FILTERS = Object.freeze(FILTER_SPEC.map((f) => f.k));
const SAVED_SEARCH_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  idf('userId', 'user_id', req),
  text('name', 'name', L.name, { req: true, nonEmpty: true }),
  group('filters', FILTER_SPEC, { sparse: true }),
  int('createdAt', 'created_at', req),
];

export const SAVED_SEARCHES_DDL = [
  tableDdl('saved_searches', SAVED_SEARCH_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
    `CHECK (new_days IS NULL OR (new_days >= 1 AND new_days <= ${L.newDays}))`,
    'CHECK (academy_plus IS NULL OR academy_plus = 1)',
  ]),
  'CREATE INDEX saved_searches_org ON saved_searches (org_id);',
].join('\n');

const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
export function typeSavedSearch(raw, at = 'savedSearches') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { scoutName: _live, ...rest } = raw; // the scout's name is read live from the staff row, never stored
  const t = typeSpec(SAVED_SEARCH_SPEC, rest, label);
  if (!t.ok) return t;
  const f = t.record.filters;
  if (f.academyPlus === false) return bad(label, 'filters.academyPlus', 'is true or absent');
  if (f.newDays !== undefined && (f.newDays < 1 || f.newDays > L.newDays))
    return bad(label, 'filters.newDays', `must be from 1 to ${L.newDays}`);
  return t;
}

const SEARCH_SELECT =
  'SELECT s.rowid AS rowid, s.*, u.name AS scout_name FROM saved_searches s JOIN org_users u ON u.id = s.user_id';
const decodeSearch = (row) => {
  const d = decode(SAVED_SEARCH_SPEC, row);
  return {
    id: d.id,
    orgId: d.orgId,
    userId: d.userId,
    scoutName: row.scout_name,
    name: d.name,
    filters: d.filters,
    createdAt: d.createdAt,
  };
};

export const savedSearchesLive = (sqlite) => migrationApplied(sqlite, SAVED_SEARCHES_MIGRATION);
/** Every saved search read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SAVED_SEARCHES_RECORDS = {
  names: SAVED_SEARCHES_COLLECTIONS,
  read: (sqlite) =>
    savedSearchesLive(sqlite)
      ? { savedSearches: sqlite.prepare(`${SEARCH_SELECT} ORDER BY s.rowid`).all().map(decodeSearch) }
      : null,
};

const WRITES = new Set(['create', 'remove']);

/** `createSavedSearchesRepository({ sqlite, unit, now, log })`: the searches' writes and queries, plus `reads`. */
export function createSavedSearchesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the saved searches repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const { q, refusal, invalid } = writeKit(sqlite, 'SAVED_SEARCH');

  const byId = (id) => {
    const row = typeof id === 'string' ? q(`${SEARCH_SELECT} WHERE s.id = ?`).get(id) : null;
    return row ? deepFreeze(decodeSearch(row)) : null;
  };
  const need = (s, tbl, id) => {
    if (!q(`SELECT 1 FROM ${tbl} WHERE id = ?`).get(id))
      throw refusal('REFERENCE_MISSING', `saved_searches ${s} names no ${tbl} row (${id})`);
  };
  const acts = {
    create: (raw) =>
      operation(() => {
        const t = typeSavedSearch(raw);
        if (!t.ok) throw invalid(t.reason);
        const s = t.record;
        if (q('SELECT 1 FROM saved_searches WHERE id = ?').get(s.id))
          throw refusal('DUPLICATE', `saved_searches ${s.id} already exists`);
        need(s.id, 'orgs', s.orgId);
        need(s.id, 'org_users', s.userId);
        q(insertSql('saved_searches', SAVED_SEARCH_SPEC)).run(encode(SAVED_SEARCH_SPEC, s));
        return byId(s.id);
      }),
    /** The organisation deletes its saved search. False when it has none by that id. */
    remove: (orgId, id) =>
      operation(() => q('DELETE FROM saved_searches WHERE id = ? AND org_id = ?').run(id, orgId).changes === 1),
    byId,
    /** The organisation's saved searches, oldest first (one club's list: not paged). */
    forOrg: (orgId) =>
      q(`${SEARCH_SELECT} WHERE s.org_id = ? ORDER BY s.rowid`)
        .all(orgId)
        .map((r) => deepFreeze(decodeSearch(r))),
    /**
     * The saved searches of current staff that could match a player with these fields: a search that names a position,
     * foot, country or availability is skipped unless it is the player's. The caller applies the whole filter.
     */
    candidatesFor: ({ position = null, foot = null, country = null, availability = null }) =>
      q(`${SEARCH_SELECT}
      WHERE u.removed_at IS NULL
        AND (s.position IS NULL OR s.position = ?) AND (s.foot IS NULL OR s.foot = ?)
        AND (s.country IS NULL OR s.country = ?) AND (s.availability IS NULL OR s.availability = ?)
      ORDER BY s.rowid`)
        .all(position, foot, country, availability)
        .map((r) => deepFreeze(decodeSearch(r))),
    count: () => q('SELECT COUNT(*) AS n FROM saved_searches').get().n,
  };
  const counts = () => ({ savedSearches: acts.count() });
  return {
    ...acts,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(acts).filter(([k]) => !WRITES.has(k)))),
    attach() {
      if (!savedSearchesLive(sqlite))
        throw new Error(`the saved searches repository needs ${SAVED_SEARCHES_MIGRATION} recorded`);
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll: () => SAVED_SEARCHES_RECORDS.read(sqlite),
    log,
    now,
  };
}
