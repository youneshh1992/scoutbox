/**
 * Grassroots operations: open days, match days and the friendlies board.
 *
 * Records:
 *   - An open day (`openTrials`): a grassroots club's open trial session, its positions as ordered rows and the players
 *     registered for it (by themselves, or by a guardian for a child), each answered once with an outcome. Deleting an
 *     open day stamps `deletedAt`: it leaves every list and count, and its row stays so a coverage assignment that
 *     names it keeps its key.
 *   - A match day (`matchdays`): the squad-wide log of one game, with the rostered players it credited as rows.
 *   - A friendly (`friendlies`): a club's post on the local friendlies board, with one response per other club.
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen; lists decode
 * child rows in one batch. Modules receive the queries as `grassrootsReads`.
 *
 * References. Organisations and staff are RESTRICT keys. Player and guardian ids carry no key (a registration and a
 * match-day credit outlive the account; the registration's copy of the name goes with it). Child rows cascade with
 * their owner (owners are never hard-deleted).
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import {
  text,
  int,
  bool,
  oneOf,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  insertSql,
  isFootballDate,
} from './fieldSpecs.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const GRASSROOTS_MIGRATION = '0037_grassroots';
export const GRASSROOTS_COLLECTIONS = Object.freeze(['openTrials', 'matchdays', 'friendlies']);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const OPEN_TRIAL_OUTCOMES = Object.freeze(['invite_trial', 'declined']);
export const GRASSROOTS_LIMITS = Object.freeze({
  id: 80,
  title: 160,
  venue: 160,
  ageGroup: 40,
  notes: 2000,
  position: 40,
  positions: 20,
  playerName: 200,
  outcomeNote: 200,
  fixture: 160,
  result: 20,
  matchdayPlayers: 100,
  message: 200,
  registrations: 5000,
  responses: 500,
});
const L = GRASSROOTS_LIMITS;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };
const day = (k, c) => text(k, c, 10, req); // a calendar day YYYY-MM-DD (checked in typing and by the DDL)

const OPEN_TRIAL_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  day('date', 'trial_date'),
  text('venue', 'venue', L.venue, { req: true, nonEmpty: true }),
  text('ageGroup', 'age_group', L.ageGroup, { req: true, nonEmpty: true }),
  text('notes', 'notes', L.notes, req),
  idf('createdByUserId', 'created_by_user_id', req),
  int('createdAt', 'created_at', req),
  int('deletedAt', 'deleted_at'),
];
const REGISTRATION_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  text('playerName', 'player_name', L.playerName),
  bool('byGuardian', 'by_guardian', req),
  idf('guardianId', 'guardian_id'),
  int('ts', 'registered_at', req),
  oneOf('outcome', 'outcome', OPEN_TRIAL_OUTCOMES),
  text('outcomeNote', 'outcome_note', L.outcomeNote),
  int('outcomeAt', 'outcome_at'),
];
const REGISTRATION_ROW_SPEC = [
  REGISTRATION_SPEC[0],
  idf('openTrialId', 'open_trial_id', req),
  ...REGISTRATION_SPEC.slice(1),
];
const MATCHDAY_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  text('fixture', 'fixture', L.fixture, { req: true, nonEmpty: true }),
  text('venue', 'venue', L.venue, req),
  day('date', 'match_date'),
  text('result', 'result', L.result, { nonEmpty: true }),
  idf('loggedByUserId', 'logged_by_user_id', req),
  int('ts', 'created_at', req),
];
const FRIENDLY_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  idf('postedByUserId', 'posted_by_user_id', req),
  text('ageGroup', 'age_group', L.ageGroup, { req: true, nonEmpty: true }),
  day('date', 'match_date'),
  text('venue', 'venue', L.venue, req),
  text('notes', 'notes', L.notes, req),
  int('createdAt', 'created_at', req),
];
const RESPONSE_SPEC = [
  idf('orgId', 'org_id', req),
  text('message', 'message', L.message, req),
  idf('respondedByUserId', 'responded_by_user_id', req),
  int('ts', 'responded_at', req),
];
const RESPONSE_ROW_SPEC = [idf('friendlyId', 'friendly_id', req), ...RESPONSE_SPEC];

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const ownedBy = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE CASCADE`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const idCol = (c) => col(c, `TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`);
const ordCol = () => col('ord', 'INTEGER NOT NULL CHECK (ord >= 0)');
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;
const DAY_GLOB = (c) => `CHECK (${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;

export const GRASSROOTS_DDL = [
  tableDdl('open_trials', OPEN_TRIAL_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'created_by_user_id'),
    DAY_GLOB('trial_date'),
  ]),
  'CREATE INDEX open_trials_org ON open_trials (org_id, trial_date) WHERE deleted_at IS NULL;',
  'CREATE INDEX open_trials_date ON open_trials (trial_date) WHERE deleted_at IS NULL;',
  table('open_trial_positions', [
    idCol('open_trial_id'),
    ordCol(),
    col('position', `TEXT NOT NULL CHECK (length(position) > 0 AND length(position) <= ${L.position})`),
    ownedBy('open_trials', 'open_trial_id'),
    'PRIMARY KEY (open_trial_id, ord)',
    'UNIQUE (open_trial_id, position)',
  ]),
  tableDdl('open_trial_registrations', REGISTRATION_ROW_SPEC, [
    ownedBy('open_trials', 'open_trial_id'),
    'UNIQUE (open_trial_id, player_id)',
    'CHECK ((guardian_id IS NOT NULL) = (by_guardian = 1))',
    'CHECK ((outcome IS NULL) = (outcome_at IS NULL))',
    'CHECK (outcome IS NOT NULL OR outcome_note IS NULL)',
  ]),
  'CREATE INDEX open_trial_registrations_player ON open_trial_registrations (player_id);',
  'CREATE INDEX open_trial_registrations_unresolved ON open_trial_registrations (open_trial_id) WHERE outcome IS NULL;',

  tableDdl('matchdays', MATCHDAY_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'logged_by_user_id'),
    DAY_GLOB('match_date'),
  ]),
  'CREATE INDEX matchdays_org ON matchdays (org_id);',
  table('matchday_players', [
    idCol('matchday_id'),
    ordCol(),
    idCol('player_id'),
    ownedBy('matchdays', 'matchday_id'),
    'PRIMARY KEY (matchday_id, ord)',
    'UNIQUE (matchday_id, player_id)',
  ]),

  tableDdl('friendlies', FRIENDLY_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'posted_by_user_id'),
    DAY_GLOB('match_date'),
  ]),
  'CREATE INDEX friendlies_date ON friendlies (match_date, id);',
  'CREATE INDEX friendlies_org ON friendlies (org_id);',
  table('friendly_responses', [
    ...RESPONSE_ROW_SPEC.map((f) =>
      col(
        f.c,
        f.t === 'int'
          ? 'INTEGER NOT NULL'
          : `TEXT NOT NULL CHECK (length(${f.c}) <= ${f.max}${f.nonEmpty ? ` AND length(${f.c}) > 0` : ''})`,
      ),
    ),
    ownedBy('friendlies', 'friendly_id'),
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'responded_by_user_id'),
    'PRIMARY KEY (friendly_id, org_id)',
  ]),
  'CREATE INDEX friendly_responses_org ON friendly_responses (org_id);',
].join('\n');
export const GRASSROOTS_TABLES = Object.freeze([
  'open_trials',
  'open_trial_positions',
  'open_trial_registrations',
  'matchdays',
  'matchday_players',
  'friendlies',
  'friendly_responses',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= L.id;
/** A calendar day that exists, written YYYY-MM-DD. */
export const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isFootballDate(v);
const checkDay = (rec, label, k) =>
  isDay(rec[k]) ? null : bad(label, k, `must be a calendar day written YYYY-MM-DD (got ${describe(rec[k])})`);

export function typeRegistration(raw, at = 'registration') {
  const label = labelOf(at, raw);
  const t = typeSpec(REGISTRATION_SPEC, raw, label);
  if (!t.ok) return t;
  const r = t.record;
  if (r.byGuardian !== (r.guardianId !== null))
    return bad(label, 'guardianId', 'is set exactly when a guardian registered the player');
  if ((r.outcome === null) !== (r.outcomeAt === null))
    return bad(label, 'outcomeAt', 'is set exactly when there is an outcome');
  if (r.outcome === null && r.outcomeNote !== null) return bad(label, 'outcomeNote', 'goes with an outcome');
  return { ok: true, record: r };
}
export function typeOpenTrial(raw, at = 'openTrials') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { positions, registrations, ...rest } = raw;
  const t = typeSpec(OPEN_TRIAL_SPEC, rest, label);
  if (!t.ok) return t;
  const d = checkDay(t.record, label, 'date');
  if (d) return d;
  if (!Array.isArray(positions) || positions.length > L.positions)
    return bad(label, 'positions', `must be a list of at most ${L.positions}`);
  for (const [i, p] of positions.entries())
    if (typeof p !== 'string' || !p.length || p.length > L.position)
      return bad(label, `positions[${i}]`, `must be text of 1 to ${L.position} characters`);
  if (new Set(positions).size !== positions.length) return bad(label, 'positions', 'names a position twice');
  if (!Array.isArray(registrations) || registrations.length > L.registrations)
    return bad(label, 'registrations', 'must be a list');
  const regs = [];
  for (const [i, x] of registrations.entries()) {
    const r = typeRegistration(x, `${label}.registrations[${i}]`);
    if (!r.ok) return r;
    if (regs.some((y) => y.playerId === r.record.playerId))
      return bad(label, `registrations[${i}]`, 'registers a player twice');
    regs.push(r.record);
  }
  return { ok: true, record: { ...t.record, positions: [...positions], registrations: regs } };
}
export function typeMatchday(raw, at = 'matchdays') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { playerIds, ...rest } = raw;
  const t = typeSpec(MATCHDAY_SPEC, rest, label);
  if (!t.ok) return t;
  const d = checkDay(t.record, label, 'date');
  if (d) return d;
  if (!Array.isArray(playerIds) || playerIds.length > L.matchdayPlayers)
    return bad(label, 'playerIds', `must be a list of at most ${L.matchdayPlayers}`);
  for (const [i, v] of playerIds.entries())
    if (!isId(v)) return bad(label, `playerIds[${i}]`, `must be a player id (got ${describe(v)})`);
  if (new Set(playerIds).size !== playerIds.length) return bad(label, 'playerIds', 'names a player twice');
  return { ok: true, record: { ...t.record, playerIds: [...playerIds] } };
}
export const typeResponse = (raw, at = 'response') => typeSpec(RESPONSE_SPEC, raw, at);
export function typeFriendly(raw, at = 'friendlies') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { responses, ...rest } = raw;
  const t = typeSpec(FRIENDLY_SPEC, rest, label);
  if (!t.ok) return t;
  const d = checkDay(t.record, label, 'date');
  if (d) return d;
  if (!Array.isArray(responses) || responses.length > L.responses) return bad(label, 'responses', 'must be a list');
  const out = [];
  for (const [i, x] of responses.entries()) {
    const r = typeResponse(x, `${label}.responses[${i}]`);
    if (!r.ok) return r;
    if (r.record.orgId === t.record.orgId) return bad(label, `responses[${i}]`, "is the poster's own");
    if (out.some((y) => y.orgId === r.record.orgId))
      return bad(label, `responses[${i}]`, 'is a second response from one organisation');
    out.push(r.record);
  }
  return { ok: true, record: { ...t.record, responses: out } };
}

// ------------------------------------------------------------------ geography (the radius prefilter)
const KM_PER_DEGREE = 111.32;
/** The latitude/longitude box that holds every point within `km` of `loc` (a prefilter; the exact distance is the caller's). */
export function boxAround(loc, km) {
  // 1% wider than the radius: the exact test (haversine on a 6,371 km sphere, distances rounded to 0.1 km) can accept a
  // point a little beyond km / 111.32 degrees, and a prefilter must never drop what the exact test keeps.
  km *= 1.01;
  const dLat = km / KM_PER_DEGREE;
  const cos = Math.cos((loc.lat * Math.PI) / 180);
  const dLng = cos > 1e-6 ? Math.min(180, km / (KM_PER_DEGREE * cos)) : 180;
  return { minLat: loc.lat - dLat, maxLat: loc.lat + dLat, minLng: loc.lng - dLng, maxLng: loc.lng + dLng };
}
// Longitude wrap is ignored: a box crossing ±180° only loses candidates on the far side of the antimeridian.
const BOX_SQL = (alias) => `${alias}.lat IS NOT NULL AND ${alias}.lat BETWEEN ? AND ? AND ${alias}.lng BETWEEN ? AND ?`;
const boxArgs = (b) => [b.minLat, b.maxLat, b.minLng, b.maxLng];

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    trial: p(insertSql('open_trials', OPEN_TRIAL_SPEC)),
    position: p('INSERT INTO open_trial_positions (open_trial_id, ord, position) VALUES (?, ?, ?)'),
    registration: p(insertSql('open_trial_registrations', REGISTRATION_ROW_SPEC)),
    matchday: p(insertSql('matchdays', MATCHDAY_SPEC)),
    credit: p('INSERT INTO matchday_players (matchday_id, ord, player_id) VALUES (?, ?, ?)'),
    friendly: p(insertSql('friendlies', FRIENDLY_SPEC)),
    response: p(insertSql('friendly_responses', RESPONSE_ROW_SPEC)),
  };
}
function writeTrial(st, t) {
  st.trial.run(encode(OPEN_TRIAL_SPEC, t));
  writeTrialChildren(st, t);
}
function writeTrialChildren(st, t) {
  t.positions.forEach((pos, i) => st.position.run(t.id, i, pos));
  for (const r of t.registrations) st.registration.run(encode(REGISTRATION_ROW_SPEC, { ...r, openTrialId: t.id }));
}
function writeMatchday(st, m) {
  st.matchday.run(encode(MATCHDAY_SPEC, m));
  writeMatchdayChildren(st, m);
}
function writeMatchdayChildren(st, m) {
  m.playerIds.forEach((pid, i) => st.credit.run(m.id, i, pid));
}
function writeFriendly(st, f) {
  st.friendly.run(encode(FRIENDLY_SPEC, f));
  writeFriendlyChildren(st, f);
}
function writeFriendlyChildren(st, f) {
  for (const r of f.responses) st.response.run(encode(RESPONSE_ROW_SPEC, { ...r, friendlyId: f.id }));
}
function decodeTrials(sqlite, rows) {
  const tids = rows.map((r) => r.id);
  const positions = childRowsOf(sqlite, 'open_trial_positions', 'open_trial_id', tids, { order: 'ord' });
  const regs = childRowsOf(sqlite, 'open_trial_registrations', 'open_trial_id', tids);
  return rows.map((row) => ({
    ...decode(OPEN_TRIAL_SPEC, row),
    positions: positions.all(row.id).map((p) => p.position),
    registrations: regs.all(row.id).map((r) => decode(REGISTRATION_SPEC, r)),
  }));
}
function decodeMatchdays(sqlite, rows) {
  const credits = childRowsOf(
    sqlite,
    'matchday_players',
    'matchday_id',
    rows.map((r) => r.id),
    { order: 'ord' },
  );
  return rows.map((row) => ({ ...decode(MATCHDAY_SPEC, row), playerIds: credits.all(row.id).map((c) => c.player_id) }));
}
function decodeFriendlies(sqlite, rows) {
  const responses = childRowsOf(
    sqlite,
    'friendly_responses',
    'friendly_id',
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    ...decode(FRIENDLY_SPEC, row),
    responses: responses.all(row.id).map((r) => decode(RESPONSE_SPEC, r)),
  }));
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const grassrootsLive = (sqlite) => migrationApplied(sqlite, GRASSROOTS_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return {
    openTrials: decodeTrials(sqlite, all('open_trials')),
    matchdays: decodeMatchdays(sqlite, all('matchdays')),
    friendlies: decodeFriendlies(sqlite, all('friendlies')),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const GRASSROOTS_RECORDS = {
  names: GRASSROOTS_COLLECTIONS,
  read(sqlite) {
    return grassrootsLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'remove', 'register', 'resolve', 'redactPlayer', 'respond']);

/**
 * `createGrassrootsRepository({ sqlite, unit, now, log })`: `openTrials`, `matchdays` and `friendlies`, each with its
 * writes and queries, plus `reads` (the queries alone: `grassrootsReads`).
 */
export function createGrassrootsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the grassroots repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const st = statements(sqlite);
  const typedOr = (type, raw, name) => {
    const t = type(raw, name);
    if (!t.ok) throw refusal('GRASSROOTS_INPUT_INVALID', t.reason);
    return t.record;
  };
  const str = (v) => typeof v === 'string';
  const need = (what, table, id) => {
    if (!q(`SELECT 1 FROM ${table} WHERE id = ?`).get(id))
      throw refusal('GRASSROOTS_REFERENCE_MISSING', `${what} names no ${table} row (${id})`);
  };
  const duplicate = (table, id) => {
    if (q(`SELECT 1 FROM ${table} WHERE id = ?`).get(id))
      throw refusal('GRASSROOTS_DUPLICATE', `${table} ${id} already exists`);
  };
  /** Rows after `after` (a [rowid] key), newest first, decoded: `{ items, nextCursor }`. */
  const newestPage = (sql, args, { after = null, limit }, dec) => {
    const rows = q(`${sql} AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`).all(
      ...args,
      after?.[0] ?? null,
      after?.[0] ?? null,
      limit + 1,
    );
    const page = pageOf(rows, limit, (r) => [r.rowid]);
    return { items: dec(page.items), nextCursor: page.nextCursor };
  };

  // ---- open days
  const decT = (rows) => decodeTrials(sqlite, rows).map(deepFreeze);
  const LIVE_T = 'deleted_at IS NULL';
  const trialById = (id) =>
    str(id) ? (decT(q(`SELECT * FROM open_trials WHERE id = ? AND ${LIVE_T}`).all(id))[0] ?? null) : null;
  const openTrials = {
    /** A new open day with its positions; no registrations. */
    create: (raw) =>
      operation(() => {
        const t = typedOr(typeOpenTrial, raw, 'openTrials');
        if (t.registrations.length || t.deletedAt !== null)
          throw refusal(
            'GRASSROOTS_INPUT_INVALID',
            `open_trials ${t.id}: a new open day has no registrations and is not deleted`,
          );
        duplicate('open_trials', t.id);
        need(`open_trials ${t.id}`, 'orgs', t.orgId);
        need(`open_trials ${t.id}`, 'org_users', t.createdByUserId);
        writeTrial(st, t);
        return trialById(t.id);
      }),
    /** The organisation deletes its open day at `at`: it leaves every list. False when it has none by that id. */
    remove: (orgId, id, at) =>
      operation(
        () =>
          q(`UPDATE open_trials SET deleted_at = ? WHERE id = ? AND org_id = ? AND ${LIVE_T}`).run(at, id, orgId)
            .changes === 1,
      ),
    /** Register a player (once per open day); returns the registration. */
    register: (trialId, raw) =>
      operation(() => {
        const r = typedOr(typeRegistration, raw, 'open_trial_registrations');
        if (r.outcome !== null)
          throw refusal(
            'GRASSROOTS_INPUT_INVALID',
            `open_trial_registrations ${r.id}: a new registration has no outcome`,
          );
        if (!trialById(trialId)) throw refusal('GRASSROOTS_NOT_FOUND', `open_trials ${trialId} is not a live open day`);
        if (
          q('SELECT 1 FROM open_trial_registrations WHERE open_trial_id = ? AND player_id = ?').get(trialId, r.playerId)
        )
          throw refusal('ALREADY_REGISTERED', `open_trials ${trialId}: ${r.playerId} is already registered`);
        duplicate('open_trial_registrations', r.id);
        st.registration.run(encode(REGISTRATION_ROW_SPEC, { ...r, openTrialId: trialId }));
        return registrationOf(trialId, r.id);
      }),
    /** Answer a registration once: `{ outcome, note, at }`. */
    resolve: (trialId, regId, { outcome, note = null, at }) =>
      operation(() => {
        const r = registrationOf(trialId, regId);
        if (!r) throw refusal('GRASSROOTS_NOT_FOUND', `open_trials ${trialId} has no registration ${regId}`);
        if (r.outcome !== null)
          throw refusal('ALREADY_RESOLVED', `open_trial_registrations ${regId} is already answered`);
        const next = typedOr(
          typeRegistration,
          { ...r, outcome, outcomeNote: note, outcomeAt: at },
          'open_trial_registrations',
        );
        q('UPDATE open_trial_registrations SET outcome = ?, outcome_note = ?, outcome_at = ? WHERE id = ?').run(
          next.outcome,
          next.outcomeNote,
          next.outcomeAt,
          regId,
        );
        return registrationOf(trialId, regId);
      }),
    /** A deleted player's registrations keep the id and lose the name. */
    redactPlayer: (playerId) =>
      operation(
        () =>
          q(
            'UPDATE open_trial_registrations SET player_name = NULL WHERE player_id = ? AND player_name IS NOT NULL',
          ).run(playerId).changes,
      ),
    byId: trialById,
    forOrgById: (orgId, id) => {
      const t = trialById(id);
      return t && t.orgId === orgId ? t : null;
    },
    /** A page of the organisation's open days, newest first. */
    pageForOrg: (orgId, page) =>
      newestPage(`SELECT rowid, * FROM open_trials WHERE org_id = ? AND ${LIVE_T}`, [orgId], page, decT),
    countForOrg: (orgId) => q(`SELECT COUNT(*) AS n FROM open_trials WHERE org_id = ? AND ${LIVE_T}`).get(orgId).n,
    /** How many of the organisation's open days before `today` still have a registrant waiting for an answer (the no-ghosting rule). */
    unresolvedBefore: (orgId, today) =>
      q(`SELECT COUNT(*) AS n FROM open_trial_registrations r JOIN open_trials t ON t.id = r.open_trial_id
      WHERE t.org_id = ? AND t.${LIVE_T} AND t.trial_date < ? AND r.outcome IS NULL`).get(orgId, today).n,
    /** Every registration at the organisation's open days: `{ playerId, ts }` (the pathway record). */
    registrantsOf: (orgId) =>
      q(`SELECT r.player_id AS playerId, r.registered_at AS ts FROM open_trial_registrations r JOIN open_trials t ON t.id = r.open_trial_id
      WHERE t.org_id = ? AND t.${LIVE_T}`)
        .all(orgId)
        .map((r) => ({ playerId: r.playerId, ts: r.ts })),
    /** Upcoming open days (on or after `today`) of these organisations, by date. */
    upcomingForOrgs: (orgIds, today) =>
      orgIds.length
        ? decT(
            q(
              `SELECT * FROM open_trials WHERE ${LIVE_T} AND trial_date >= ? AND org_id IN (SELECT value FROM json_each(?)) ORDER BY trial_date, id`,
            ).all(today, JSON.stringify(orgIds)),
          )
        : [],
    /** The open days (past ones too; deleted ones never) hosted by an organisation whose location is inside `box`, by date. */
    inBox: (box) =>
      decT(
        q(
          `SELECT t.* FROM open_trials t JOIN orgs o ON o.id = t.org_id WHERE t.${LIVE_T} AND ${BOX_SQL('o')} ORDER BY t.trial_date, t.id`,
        ).all(...boxArgs(box)),
      ),
    /** Every upcoming open day, by date (the opportunity board filters them per player). */
    upcoming: (today) =>
      decT(q(`SELECT * FROM open_trials WHERE ${LIVE_T} AND trial_date >= ? ORDER BY trial_date, id`).all(today)),
  };
  function registrationOf(trialId, regId) {
    const row = q('SELECT * FROM open_trial_registrations WHERE id = ? AND open_trial_id = ?').get(regId, trialId);
    return row ? deepFreeze(decode(REGISTRATION_SPEC, row)) : null;
  }

  // ---- match days
  const decM = (rows) => decodeMatchdays(sqlite, rows).map(deepFreeze);
  const matchdays = {
    create: (raw) =>
      operation(() => {
        const m = typedOr(typeMatchday, raw, 'matchdays');
        duplicate('matchdays', m.id);
        need(`matchdays ${m.id}`, 'orgs', m.orgId);
        need(`matchdays ${m.id}`, 'org_users', m.loggedByUserId);
        writeMatchday(st, m);
        return decM(q('SELECT * FROM matchdays WHERE id = ?').all(m.id))[0];
      }),
    /** A page of the organisation's match days, newest first. */
    pageForOrg: (orgId, page) => newestPage('SELECT rowid, * FROM matchdays WHERE org_id = ?', [orgId], page, decM),
    countForOrg: (orgId) => q('SELECT COUNT(*) AS n FROM matchdays WHERE org_id = ?').get(orgId).n,
  };

  // ---- friendlies
  const decF = (rows) => decodeFriendlies(sqlite, rows).map(deepFreeze);
  const friendlyById = (id) => (str(id) ? (decF(q('SELECT * FROM friendlies WHERE id = ?').all(id))[0] ?? null) : null);
  const friendlies = {
    create: (raw) =>
      operation(() => {
        const f = typedOr(typeFriendly, raw, 'friendlies');
        if (f.responses.length)
          throw refusal('GRASSROOTS_INPUT_INVALID', `friendlies ${f.id}: a new friendly has no responses`);
        duplicate('friendlies', f.id);
        need(`friendlies ${f.id}`, 'orgs', f.orgId);
        need(`friendlies ${f.id}`, 'org_users', f.postedByUserId);
        writeFriendly(st, f);
        return friendlyById(f.id);
      }),
    /** Another organisation answers the friendly (once). */
    respond: (id, raw) =>
      operation(() => {
        const f = friendlyById(id);
        if (!f) throw refusal('GRASSROOTS_NOT_FOUND', `friendlies ${id} is not a record of the repository`);
        const r = typedOr(typeResponse, raw, `friendlies ${id} response`);
        if (r.orgId === f.orgId)
          throw refusal('GRASSROOTS_INPUT_INVALID', `friendlies ${id}: the poster cannot respond to its own friendly`);
        if (f.responses.some((x) => x.orgId === r.orgId))
          throw refusal('ALREADY_RESPONDED', `friendlies ${id}: ${r.orgId} has already responded`);
        need(`friendlies ${id} response`, 'orgs', r.orgId);
        need(`friendlies ${id} response`, 'org_users', r.respondedByUserId);
        st.response.run(encode(RESPONSE_ROW_SPEC, { ...r, friendlyId: id }));
        return friendlyById(id);
      }),
    byId: friendlyById,
    /**
     * A page of the board for `orgId`, by match date then id: its own friendlies and those posted by organisations
     * inside `box` (null: its own only) that `keep(friendly)` accepts (the exact distance). `after` is `[date, id]`.
     */
    boardPage: (orgId, box, { after = null, limit }, keep = () => true) => {
      const batch = Math.max(limit + 1, 100);
      const kept = [];
      let from = after;
      for (;;) {
        const rows = q(`SELECT f.* FROM friendlies f JOIN orgs o ON o.id = f.org_id
          WHERE (f.org_id = ? OR (? = 1 AND ${BOX_SQL('o')}))
            AND (? IS NULL OR f.match_date > ? OR (f.match_date = ? AND f.id > ?))
          ORDER BY f.match_date, f.id LIMIT ?`).all(
          orgId,
          box ? 1 : 0,
          ...boxArgs(box ?? { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 }),
          from?.[0] ?? null,
          from?.[0] ?? null,
          from?.[0] ?? null,
          from?.[1] ?? null,
          batch,
        );
        for (const f of decF(rows)) if (f.orgId === orgId || keep(f)) kept.push(f);
        if (kept.length > limit || rows.length < batch) break;
        const last = rows[rows.length - 1];
        from = [last.match_date, last.id];
      }
      return pageOf(kept, limit, (f) => [f.date, f.id]);
    },
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { openTrials, matchdays, friendlies };
  const counters = {
    openTrials: q('SELECT COUNT(*) AS n FROM open_trials'),
    matchdays: q('SELECT COUNT(*) AS n FROM matchdays'),
    friendlies: q('SELECT COUNT(*) AS n FROM friendlies'),
  };
  return {
    ...repo,
    /** The queries alone, for modules that must not write (`grassrootsReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!grassrootsLive(sqlite))
        throw new Error(
          `the grassroots repository needs ${GRASSROOTS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(GRASSROOTS_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return GRASSROOTS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
