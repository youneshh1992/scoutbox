/**
 * The Football Passport's own records: a player's Passport preferences (bio, positions, availability, the position history and the public
 * selections), self-submitted career entries, achievements (with a verified club's confirmation), share links (token
 * hashes only) and correction requests. Every field is a typed column with its vocabulary and length CHECKs; there are no
 * JSON columns. Football dates are stored as the player gave them, to the precision given: 'YYYY', 'YYYY-MM' or
 * 'YYYY-MM-DD' (the routes write any accepted form, an epoch or `{ year, month }`, in that shape). Positions are
 * PLAYER_POSITIONS codes; secondary positions and public selections are ordered child rows.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write it at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own; an unknown field and
 * an update from inside its own update are refused. Preferences are saved whole (`passportPrefs.save(playerId, change)`):
 * a row exists only once a player or guardian saved, and the position history only grows. A share's view count is
 * `shares.recordView(id)`.
 *
 * Queries decode deep-frozen records in insertion (rowid) order unless they say otherwise. Modules receive them in
 * `verificationReads`.
 *
 * References. Player and guardian ids carry no key (tolerant, as recruitment, scouting and verification: an account
 * deletion leaves these rows under the old id). A confirmation's organisation → orgs is an immediate RESTRICT
 * key; the preferences' child rows cascade with their preferences.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { PLAYER_POSITIONS } from './identity.mjs';
import {
  text,
  int,
  oneOf,
  date,
  group,
  quote,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  upsertSql,
} from './fieldSpecs.mjs';

export const PASSPORT_MIGRATION = '0024_passport';
export const PASSPORT_COLLECTIONS = Object.freeze([
  'passportPrefs',
  'passportCareerEntries',
  'passportAchievements',
  'passportShares',
  'passportCorrections',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const AVAILABILITY = Object.freeze(['open_to_trials', 'open_to_contact', 'not_looking']);
export const SUBMITTERS = Object.freeze(['player', 'guardian']);
export const SHARE_MODES = Object.freeze(['public', 'recruitment']);
export const CORRECTION_TARGETS = Object.freeze([
  'timeline_event',
  'career_entry',
  'club_history',
  'reference',
  'trial',
  'assessment',
  'achievement',
  'signing',
]);
export const CORRECTION_OUTCOMES = Object.freeze(['corrected', 'rejected', 'referred']);
/** Text limits: the routes shorten free text to these; ids, codes and lists over them are refused. */
export const PASSPORT_LIMITS = Object.freeze({
  id: 80,
  bio: 400,
  orgName: 100,
  role: 60,
  note: 200,
  title: 120,
  reason: 500,
  resolutionReason: 400,
  targetId: 80,
  selection: 120,
  selections: 100,
  secondary: 3,
  name: 200,
  shareDays: { min: 1, max: 90, default: 30 },
});
const L = PASSPORT_LIMITS;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, o);
const position = (k, c, o = {}) => oneOf(k, c, PLAYER_POSITIONS, o);
const PREFS_SPEC = [
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('bio', 'bio', L.bio),
  position('primaryPosition', 'position_primary'),
  oneOf('availability', 'availability', AVAILABILITY),
  date('availableFrom', 'available_from'),
  int('updatedAt', 'updated_at', { req: true }),
];
const HISTORY_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  date('from', 'from_date', { req: true }),
  position('primary', 'position_primary', { req: true }),
  oneOf('submittedBy', 'submitted_by', SUBMITTERS, { req: true }),
  int('recordedAt', 'recorded_at', { req: true }),
];
const CAREER_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('orgName', 'org_name', L.orgName, { req: true, nonEmpty: true }),
  text('role', 'role', L.role),
  date('from', 'from_date', { req: true }),
  date('to', 'to_date'),
  text('note', 'note', L.note),
  oneOf('submittedBy', 'submitted_by', SUBMITTERS, { req: true }),
  int('createdAt', 'created_at', { req: true }),
  int('withdrawnAt', 'withdrawn_at'),
];
const ACHIEVEMENT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  text('orgName', 'org_name', L.orgName),
  date('when', 'when_date'),
  oneOf('submittedBy', 'submitted_by', SUBMITTERS, { req: true }),
  group(
    'confirmation',
    [
      oneOf('provenance', 'confirmation_provenance', ['verified_club_confirmed'], { req: true }),
      idf('orgId', 'confirmation_org_id', { req: true, nonEmpty: true }),
      text('orgName', 'confirmation_org_name', L.name, { req: true }),
      text('byName', 'confirmation_by_name', L.name),
      int('at', 'confirmation_at', { req: true }),
    ],
    { nullable: true },
  ),
  int('createdAt', 'created_at', { req: true }),
  int('withdrawnAt', 'withdrawn_at'),
];
const SHARE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  oneOf('mode', 'mode', SHARE_MODES, { req: true }),
  text('tokenHash', 'token_hash', 64, { req: true, nonEmpty: true }),
  group('createdBy', [
    oneOf('kind', 'created_by_kind', SUBMITTERS, { req: true }),
    idf('id', 'created_by_id', { req: true, nonEmpty: true }),
  ]),
  int('createdAt', 'created_at', { req: true }),
  int('expiresAt', 'expires_at', { req: true }),
  int('revokedAt', 'revoked_at'),
  group(
    'revokedBy',
    [
      oneOf('kind', 'revoked_by_kind', [...SUBMITTERS, 'trust_safety'], { req: true }),
      idf('id', 'revoked_by_id', { req: true, nonEmpty: true }),
    ],
    { nullable: true },
  ),
  int('views', 'views', { req: true, def: 0 }),
];
const CORRECTION_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  oneOf('targetType', 'target_kind', CORRECTION_TARGETS, { req: true }),
  text('targetId', 'target_id', L.targetId),
  text('reason', 'reason', L.reason, { req: true, nonEmpty: true }),
  group('by', [
    oneOf('kind', 'by_kind', SUBMITTERS, { req: true }),
    idf('id', 'by_id', { req: true, nonEmpty: true }),
    text('name', 'by_name', L.name),
  ]),
  oneOf('status', 'status', ['open', 'resolved'], { req: true }),
  group(
    'resolution',
    [
      oneOf('outcome', 'resolution_outcome', CORRECTION_OUTCOMES, { req: true }),
      text('reason', 'resolution_reason', L.resolutionReason, { req: true, nonEmpty: true }),
      int('at', 'resolved_at', { req: true }),
    ],
    { nullable: true },
  ),
  int('createdAt', 'created_at', { req: true }),
];

// ------------------------------------------------------------------ DDL (generated from the specs)
const codeList = (name, owner, ownerTable, ownerCol, col, check) => `CREATE TABLE ${name} (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(${ownerCol}) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  ${col}    TEXT NOT NULL CHECK (${check}),
  PRIMARY KEY (${owner}, ord),
  UNIQUE (${owner}, ${col})
) STRICT;`;
const POSITION_CHECK = (c) => `${c} IN (${PLAYER_POSITIONS.map(quote).join(',')})`;
export const PASSPORT_DDL = [
  tableDdl('passport_prefs', PREFS_SPEC, ['PRIMARY KEY (player_id)']),
  codeList(
    'passport_pref_positions',
    'player_id',
    'passport_prefs',
    'player_id',
    'code',
    `${POSITION_CHECK('code')} AND ord < ${L.secondary}`,
  ),
  tableDdl(
    'passport_position_history',
    [
      ...HISTORY_SPEC.slice(0, 1),
      idf('playerId', 'player_id', { req: true, nonEmpty: true }),
      ...HISTORY_SPEC.slice(1),
    ],
    ['FOREIGN KEY (player_id) REFERENCES passport_prefs(player_id) ON DELETE CASCADE'],
  ),
  'CREATE INDEX passport_position_history_player ON passport_position_history (player_id);',
  codeList(
    'passport_position_history_positions',
    'history_id',
    'passport_position_history',
    'id',
    'code',
    `${POSITION_CHECK('code')} AND ord < ${L.secondary}`,
  ),
  codeList(
    'passport_public_selections',
    'player_id',
    'passport_prefs',
    'player_id',
    'selection',
    `length(selection) > 0 AND length(selection) <= ${L.selection} AND ord < ${L.selections}`,
  ),
  tableDdl('passport_career_entries', CAREER_SPEC),
  'CREATE INDEX passport_career_entries_player ON passport_career_entries (player_id);',
  tableDdl('passport_achievements', ACHIEVEMENT_SPEC, [
    'FOREIGN KEY (confirmation_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX passport_achievements_player ON passport_achievements (player_id);',
  tableDdl('passport_shares', SHARE_SPEC, [
    'CHECK (length(token_hash) = 64)',
    'CHECK (views >= 0)',
    'CHECK ((revoked_at IS NULL) = (revoked_by_kind IS NULL))',
  ]),
  'CREATE UNIQUE INDEX passport_shares_token_hash ON passport_shares (token_hash);',
  'CREATE INDEX passport_shares_player ON passport_shares (player_id);',
  tableDdl('passport_corrections', CORRECTION_SPEC, [
    "CHECK ((status = 'resolved') = (resolution_outcome IS NOT NULL))",
  ]),
  'CREATE INDEX passport_corrections_status ON passport_corrections (status);',
  'CREATE INDEX passport_corrections_player ON passport_corrections (player_id);',
].join('\n');
export const PASSPORT_TABLES = Object.freeze([
  'passport_prefs',
  'passport_pref_positions',
  'passport_position_history',
  'passport_position_history_positions',
  'passport_public_selections',
  'passport_career_entries',
  'passport_achievements',
  'passport_shares',
  'passport_corrections',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw, key = 'id') =>
  `${at} ${isPlainObject(raw) && typeof raw[key] === 'string' ? raw[key] : ''}`.trim();
function typeList(list, at, field, max, ok, what) {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list)) return bad(at, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(at, field, `holds more than ${max} entries`);
  const i = list.findIndex((x) => !ok(x));
  if (i >= 0) return bad(at, `${field}[${i}]`, `must be ${what} (got ${describe(list[i])})`);
  if (new Set(list).size !== list.length) return bad(at, field, 'names an entry twice');
  return { ok: true, list: [...list] };
}
const isPosition = (x) => PLAYER_POSITIONS.includes(x);
const typePositions = (list, at, field) =>
  typeList(list, at, field, L.secondary, isPosition, `a position code (${PLAYER_POSITIONS.join('|')})`);

/** The preferences of a player who never saved any. */
export const blankPrefs = (playerId) => ({
  playerId,
  bio: null,
  positions: null,
  positionHistory: [],
  availability: null,
  availableFrom: null,
  publicSelections: [],
  updatedAt: null,
});

export function typePrefs(raw, at = 'passportPrefs') {
  const label = labelOf(at, raw, 'playerId');
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { positions, positionHistory, publicSelections, ...flatPart } = raw;
  // positions: null, or { primary, secondary[] }; an object with neither is stored (and read back) as null.
  let primary = null;
  let secondary = [];
  if (positions !== undefined && positions !== null) {
    if (!isPlainObject(positions))
      return bad(label, 'positions', `must be an object or null (got ${describe(positions)})`);
    const unknown = Object.keys(positions).filter((k) => k !== 'primary' && k !== 'secondary');
    if (unknown.length)
      return bad(label, 'positions', `carries field(s) this build does not store: ${unknown.join(', ')}`);
    if (positions.primary != null && !isPosition(positions.primary))
      return bad(
        label,
        'positions.primary',
        `must be a position code (${PLAYER_POSITIONS.join('|')}) (got ${describe(positions.primary)})`,
      );
    primary = positions.primary ?? null;
    const s = typePositions(positions.secondary, label, 'positions.secondary');
    if (!s.ok) return s;
    secondary = s.list;
  }
  const t = typeSpec(PREFS_SPEC, { ...flatPart, primaryPosition: primary }, label);
  if (!t.ok) return t;
  if (!Array.isArray(positionHistory ?? []))
    return bad(label, 'positionHistory', `must be a list (got ${describe(positionHistory)})`);
  const history = [];
  for (const [i, h] of (positionHistory ?? []).entries()) {
    const { secondary: hs, ...hFlat } = isPlainObject(h) ? h : {};
    if (!isPlainObject(h)) return bad(label, `positionHistory[${i}]`, `must be an object (got ${describe(h)})`);
    const ht = typeSpec(HISTORY_SPEC, hFlat, `${label}.positionHistory[${i}]`);
    if (!ht.ok) return ht;
    const hp = typePositions(hs, `${label}.positionHistory[${i}]`, 'secondary');
    if (!hp.ok) return hp;
    history.push({ ...ht.record, secondary: hp.list });
  }
  if (new Set(history.map((h) => h.id)).size !== history.length)
    return bad(label, 'positionHistory', 'names an id twice');
  const sel = typeList(
    publicSelections,
    label,
    'publicSelections',
    L.selections,
    (x) => typeof x === 'string' && x.length > 0 && x.length <= L.selection,
    `an id of at most ${L.selection} characters`,
  );
  if (!sel.ok) return sel;
  const { primaryPosition, ...rest } = t.record;
  return {
    ok: true,
    record: {
      ...rest,
      positions: primaryPosition || secondary.length ? { primary: primaryPosition, secondary } : null,
      positionHistory: history,
      publicSelections: sel.list,
    },
  };
}
const simpleTyper =
  (spec, fallback) =>
  (raw, at = fallback) =>
    typeSpec(spec, raw, labelOf(at, raw));
export const typeCareerEntry = simpleTyper(CAREER_SPEC, 'passportCareerEntries');
export const typeAchievement = simpleTyper(ACHIEVEMENT_SPEC, 'passportAchievements');
export const typeShare = simpleTyper(SHARE_SPEC, 'passportShares');
/** A correction: `resolvedAt` is the resolution's instant (one column), accepted when it agrees. */
export function typeCorrection(raw, at = 'passportCorrections') {
  const label = labelOf(at, raw);
  const t = typeSpec(CORRECTION_SPEC, raw, label, ['resolvedAt']);
  if (!t.ok) return t;
  const resolvedAt = t.record.resolution?.at ?? null;
  if (raw.resolvedAt !== undefined && raw.resolvedAt !== resolvedAt)
    return bad(label, 'resolvedAt', "must be the resolution's instant");
  if ((t.record.status === 'resolved') !== (t.record.resolution !== null))
    return bad(label, 'resolution', 'is set exactly when the correction is resolved');
  return { ok: true, record: { ...t.record, resolvedAt } };
}

// ------------------------------------------------------------------ rows
const ENTITIES = {
  passportCareerEntries: {
    table: 'passport_career_entries',
    spec: CAREER_SPEC,
    type: typeCareerEntry,
    immutable: ['id', 'playerId', 'submittedBy', 'createdAt'],
  },
  passportAchievements: {
    table: 'passport_achievements',
    spec: ACHIEVEMENT_SPEC,
    type: typeAchievement,
    immutable: ['id', 'playerId', 'submittedBy', 'createdAt'],
  },
  passportShares: {
    table: 'passport_shares',
    spec: SHARE_SPEC,
    type: typeShare,
    immutable: ['id', 'playerId', 'mode', 'tokenHash', 'createdBy', 'createdAt'],
  },
  passportCorrections: {
    table: 'passport_corrections',
    spec: CORRECTION_SPEC,
    type: typeCorrection,
    immutable: ['id', 'playerId', 'targetType', 'targetId', 'reason', 'by', 'createdAt'],
  },
};
const decodeFlat = (name, row) => {
  const rec = decode(ENTITIES[name].spec, row);
  if (name === 'passportCorrections') rec.resolvedAt = rec.resolution?.at ?? null;
  return rec;
};
const encodeFlat = (name, rec) => {
  const { resolvedAt: _r, ...r } = rec;
  return encode(ENTITIES[name].spec, r);
};

function prefsStatements(sqlite) {
  return {
    upsert: sqlite.prepare(upsertSql('passport_prefs', PREFS_SPEC, ['player_id'])),
    byPlayer: sqlite.prepare('SELECT * FROM passport_prefs WHERE player_id = ?'),
    all: sqlite.prepare('SELECT * FROM passport_prefs ORDER BY rowid'),
    posDel: sqlite.prepare('DELETE FROM passport_pref_positions WHERE player_id = ?'),
    posIns: sqlite.prepare('INSERT INTO passport_pref_positions (player_id, ord, code) VALUES (?, ?, ?)'),
    histIns: sqlite.prepare(
      'INSERT INTO passport_position_history (id, player_id, from_date, position_primary, submitted_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    histPosIns: sqlite.prepare(
      'INSERT INTO passport_position_history_positions (history_id, ord, code) VALUES (?, ?, ?)',
    ),
    selDel: sqlite.prepare('DELETE FROM passport_public_selections WHERE player_id = ?'),
    selIns: sqlite.prepare('INSERT INTO passport_public_selections (player_id, ord, selection) VALUES (?, ?, ?)'),
  };
}
function decodePrefs(sqlite, rows) {
  const pids = rows.map((r) => r.player_id);
  const pos = childRowsOf(sqlite, 'passport_pref_positions', 'player_id', pids, { order: 'ord' });
  const hist = childRowsOf(sqlite, 'passport_position_history', 'player_id', pids, { order: 'rowid' });
  const histPos = childRowsOf(
    sqlite,
    'passport_position_history_positions',
    'history_id',
    pids.flatMap((p) => hist.all(p).map((h) => h.id)),
    { order: 'ord' },
  );
  const sel = childRowsOf(sqlite, 'passport_public_selections', 'player_id', pids, { order: 'ord' });
  return rows.map((row) => {
    const { primaryPosition, ...rec } = decode(PREFS_SPEC, row);
    const secondary = pos.all(row.player_id).map((r) => r.code);
    return {
      ...rec,
      positions: primaryPosition || secondary.length ? { primary: primaryPosition, secondary } : null,
      positionHistory: hist
        .all(row.player_id)
        .map((h) => ({ ...decode(HISTORY_SPEC, h), secondary: histPos.all(h.id).map((r) => r.code) })),
      publicSelections: sel.all(row.player_id).map((r) => r.selection),
    };
  });
}
/** Write a typed preferences record; `knownHistory` is the ids already stored (the history only grows). */
function writePrefs(st, rec, knownHistory = new Set()) {
  st.upsert.run(encode(PREFS_SPEC, { ...rec, primaryPosition: rec.positions?.primary ?? null }));
  st.posDel.run(rec.playerId);
  (rec.positions?.secondary ?? []).forEach((c, i) => st.posIns.run(rec.playerId, i, c));
  for (const h of rec.positionHistory) {
    if (knownHistory.has(h.id)) continue;
    st.histIns.run(h.id, rec.playerId, h.from, h.primary, h.submittedBy, h.recordedAt);
    h.secondary.forEach((c, i) => st.histPosIns.run(h.id, i, c));
  }
  st.selDel.run(rec.playerId);
  rec.publicSelections.forEach((s, i) => st.selIns.run(rec.playerId, i, s));
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const passportLive = (sqlite) => migrationApplied(sqlite, PASSPORT_MIGRATION);
function readAll(sqlite) {
  const out = { passportPrefs: decodePrefs(sqlite, prefsStatements(sqlite).all.all()) };
  for (const [name, e] of Object.entries(ENTITIES))
    out[name] = sqlite
      .prepare(`SELECT * FROM ${e.table} ORDER BY rowid`)
      .all()
      .map((r) => decodeFlat(name, r));
  return out;
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const PASSPORT_RECORDS = {
  names: PASSPORT_COLLECTIONS,
  read(sqlite) {
    return passportLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL = PASSPORT_COLLECTIONS.map((n) =>
  n === 'passportPrefs' ? 'SELECT player_id AS pid FROM passport_prefs' : `SELECT player_id FROM ${ENTITIES[n].table}`,
).join(' UNION ALL ');
const playerRefCount = (sqlite, cond) =>
  sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get().n;
export const unresolvedPlayerReferences = (sqlite) =>
  passportLive(sqlite)
    ? { passport: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') }
    : null;
export const retainedPlayerReferences = (sqlite) =>
  passportLive(sqlite)
    ? {
        passport: playerRefCount(
          sqlite,
          'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)',
        ),
      }
    : null;

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'save', 'recordView']);
const clone = (v) => JSON.parse(JSON.stringify(v));
/**
 * `createPassportRepository({ sqlite, unit, now, log })`: `passportPrefs`, `careerEntries`, `achievements`, `shares` and
 * `corrections`, each with its writes and queries, plus `reads` (the queries alone, merged into `verificationReads`).
 */
export function createPassportRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the passport repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const ps = prefsStatements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key))
      throw refusal(
        'PASSPORT_NESTED_UPDATE',
        `${key} is already being updated; make the second change after the first returns`,
      );
    updating.add(key);
    try {
      return fn();
    } finally {
      updating.delete(key);
    }
  };

  // ---- preferences
  const prefsOf = (playerId) => {
    const row = typeof playerId === 'string' ? ps.byPlayer.get(playerId) : null;
    return row ? deepFreeze(decodePrefs(sqlite, [row])[0]) : null;
  };
  const passportPrefs = {
    /** The player's saved preferences, or null when nobody saved any (use `blankPrefs`). */
    forPlayer: prefsOf,
    /**
     * `save(playerId, change)`: `change` edits a plain copy of the stored preferences (or the blank ones) and the result
     * is typed whole and written at once. The position history only grows: a stored entry cannot change or go.
     */
    save: (playerId, change) =>
      guard(`passport_prefs ${playerId}`, () =>
        operation(() => {
          if (typeof change !== 'function')
            throw new TypeError(
              'passportPrefs.save(playerId, change) needs a function that edits the copy it is given',
            );
          const stored = prefsOf(playerId);
          const draft = clone(stored ?? blankPrefs(playerId));
          const returned = change(draft);
          const t = typePrefs(returned === undefined ? draft : returned);
          if (!t.ok) throw refusal('PASSPORT_INPUT_INVALID', t.reason);
          const next = t.record;
          if (next.playerId !== playerId)
            throw refusal('PASSPORT_INPUT_INVALID', `passport_prefs ${playerId}: playerId cannot change`);
          if (next.updatedAt === null)
            throw refusal('PASSPORT_INPUT_INVALID', `passport_prefs ${playerId}: updatedAt is required`);
          const before = stored?.positionHistory ?? [];
          if (before.some((h, i) => JSON.stringify(h) !== JSON.stringify(next.positionHistory[i])))
            throw refusal(
              'PASSPORT_INPUT_INVALID',
              `passport_prefs ${playerId}: the position history only grows (a stored entry cannot change or go)`,
            );
          const taken = next.positionHistory
            .slice(before.length)
            .find((h) => q('SELECT 1 FROM passport_position_history WHERE id = ?').get(h.id));
          if (taken) throw refusal('PASSPORT_DUPLICATE', `passport_position_history ${taken.id} already exists`);
          writePrefs(ps, next, new Set(before.map((h) => h.id)));
          return prefsOf(playerId);
        }),
      ),
  };

  // ---- the flat records
  const read = (name, id) => {
    if (typeof id !== 'string') return null;
    const row = q(`SELECT * FROM ${ENTITIES[name].table} WHERE id = ?`).get(id);
    return row ? deepFreeze(decodeFlat(name, row)) : null;
  };
  const list =
    (name, where, order = 'rowid') =>
    (...args) =>
      q(`SELECT * FROM ${ENTITIES[name].table} WHERE ${where} ORDER BY ${order}`)
        .all(...args)
        .map((r) => deepFreeze(decodeFlat(name, r)));
  const typedOr = (name, raw) => {
    const t = ENTITIES[name].type(raw, name);
    if (!t.ok) throw refusal('PASSPORT_INPUT_INVALID', t.reason);
    return t.record;
  };
  const write = (name, rec) => q(upsertSql(ENTITIES[name].table, ENTITIES[name].spec)).run(encodeFlat(name, rec));
  const create = (name) => (raw) =>
    operation(() => {
      const r = typedOr(name, raw);
      if (read(name, r.id)) throw refusal('PASSPORT_DUPLICATE', `${ENTITIES[name].table} ${r.id} already exists`);
      write(name, r);
      return read(name, r.id);
    });
  /** `update(id, change)`: `change` edits a plain copy of the stored record; the result is typed whole and written at once. */
  const update = (name) => (id, change) =>
    guard(`${ENTITIES[name].table} ${id}`, () =>
      operation(() => {
        if (typeof change !== 'function')
          throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
        const stored = read(name, id);
        if (!stored)
          throw refusal('PASSPORT_NOT_FOUND', `${ENTITIES[name].table} ${id} is not a record of the repository`);
        const draft = clone(stored);
        const returned = change(draft);
        const next = typedOr(name, returned === undefined ? draft : returned);
        for (const k of ENTITIES[name].immutable)
          if (JSON.stringify(next[k]) !== JSON.stringify(stored[k]))
            throw refusal('PASSPORT_INPUT_INVALID', `${ENTITIES[name].table} ${id}: ${k} cannot change`);
        write(name, next);
        return read(name, id);
      }),
    );
  const paged =
    (name, where, desc) =>
    (args, { limit, after = null }) => {
      const rows = q(
        `SELECT rowid AS rid, * FROM ${ENTITIES[name].table} WHERE ${where} AND (? IS NULL OR rowid ${desc ? '<' : '>'} ?) ORDER BY rowid ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
      ).all(...args, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      return { rows: rows.map((r) => ({ key: [r.rid], record: deepFreeze(decodeFlat(name, r)) })) };
    };

  const careerEntries = {
    create: create('passportCareerEntries'),
    update: update('passportCareerEntries'),
    byId: (id) => read('passportCareerEntries', id),
    forPlayer: list('passportCareerEntries', 'player_id = ?'),
  };
  const achievements = {
    create: create('passportAchievements'),
    update: update('passportAchievements'),
    byId: (id) => read('passportAchievements', id),
    forPlayer: list('passportAchievements', 'player_id = ?'),
  };
  const sharesPage = paged('passportShares', '1 = 1', true);
  const shares = {
    create: create('passportShares'),
    update: update('passportShares'),
    byId: (id) => read('passportShares', id),
    byHash: (hash) => {
      const row = q('SELECT * FROM passport_shares WHERE token_hash = ?').get(hash);
      return row ? deepFreeze(decodeFlat('passportShares', row)) : null;
    },
    forPlayer: list('passportShares', 'player_id = ?'),
    /** The player's shares neither revoked nor expired at `at`. */
    activeCount: (playerId, at) =>
      q('SELECT COUNT(*) AS n FROM passport_shares WHERE player_id = ? AND revoked_at IS NULL AND expires_at > ?').get(
        playerId,
        at,
      ).n,
    /** Every share, newest first, by cursor (`after` is the previous page's last `[rowid]`): the T&S list. */
    page: (opts) => sharesPage([], opts),
    /** Count one successful opening of share `id`. */
    recordView: (id) =>
      operation(() => {
        q('UPDATE passport_shares SET views = views + 1 WHERE id = ?').run(id);
      }),
  };
  const openPage = paged('passportCorrections', "status = 'open'", false);
  const allPage = paged('passportCorrections', '1 = 1', false);
  const corrections = {
    create: create('passportCorrections'),
    update: update('passportCorrections'),
    byId: (id) => read('passportCorrections', id),
    /** The T&S queue, oldest first, by cursor: open corrections, or every correction with `all`. */
    page: ({ all = false, ...opts }) => (all ? allPage : openPage)([], opts),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { passportPrefs, careerEntries, achievements, shares, corrections };
  const counters = {
    passportPrefs: q('SELECT COUNT(*) AS n FROM passport_prefs'),
    ...Object.fromEntries(Object.entries(ENTITIES).map(([n, e]) => [n, q(`SELECT COUNT(*) AS n FROM ${e.table}`)])),
  };
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (merged into `verificationReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!passportLive(sqlite))
        throw new Error(
          `the passport repository needs ${PASSPORT_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(PASSPORT_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return PASSPORT_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
