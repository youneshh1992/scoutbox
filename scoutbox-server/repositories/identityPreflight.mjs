/**
 * Read-only preflight for the S4a cutover of guardians, players and the
 * guardian–child link (readiness review §5 and §7.1): validate the two blob
 * collections and every relationship between them, and — only when nothing
 * is refused and no policy decision is pending — emit a migration CANDIDATE:
 * the exact rows the live tables would receive, which `writeCandidate` can
 * load into the intended STRICT schema (temporary databases in tests; the
 * future migration 0005 reuses the same functions).
 *
 * What this module never does: run a migration, write the source database,
 * boot a server, repair, coerce or drop a record. A report says one of two
 * things and claims nothing more:
 *   - `invalid`   — at least one record or relationship the target refuses;
 *                   every one is listed with its id and reason; no candidate.
 *   - `complete`  — every record and relationship fits the target constraints;
 *                   the candidate is emitted. This is a statement about the
 *                   data, not an approval: the cutover is a separate, later
 *                   step with its own decision.
 *
 * The Founder's decision on legacy minors (readiness review §5.5, answered
 * 11 October 2026: "Stop until resolved"): an existing under-18 player with NO
 * guardian link at all — `guardianId` null or absent and listed by no
 * guardian's `childIds` — REFUSES the whole cutover until that record is
 * resolved by hand. It is not imported unchanged, not omitted, not given an
 * invented guardian or link, not re-dated and not deleted; its id is listed
 * (`legacyMinorsWithoutLink`) and no candidate is emitted. Age is evaluated
 * at the explicit instant `now` the caller supplies, and the future migration
 * re-evaluates at its own run time. This decision concerns the migration only
 * and is not a deletion or retention policy.
 *
 * Findings that are counted but refuse nothing (as §5.2 specifies, and
 * deliberately NOT covered by that decision): a child listed by a guardian
 * that is not its primary (`role = 'co'`), an adult still linked to a
 * guardian, a minor whose only links are `co` links. Each is listed by id so
 * the operator can see what the cutover would carry.
 *
 * Reports carry ids, field names, reasons and counts only: never an e-mail
 * address, a password hash, an e-mail code or a record. Output is
 * deterministic for a given input and evaluation date (`now`): every list is
 * sorted and nothing depends on array order.
 */
import { isAdult } from '../domain.mjs';
import {
  playerToRow, playerFromRow, guardianToRow, validateGuardianRecord,
  PLAYER_COLUMNS, GUARDIAN_COLUMNS,
} from './identityMapping.mjs';
import { validatePlayerRecordWithItems as validatePlayerRecord, subrecordsLive, prepareSubrecordStatements, writeChildRows } from './playerSubrecords.mjs';

export const CORE_IDENTITY_LIVE_MIGRATION = '0005_core_identity_live';
export const PREFLIGHT_STATUS = Object.freeze({ COMPLETE: 'complete', INVALID: 'invalid' });
/** The refusal reason for a legacy minor with no guardian link (the Founder's decision, readiness review §5.5). */
export const MINOR_WITHOUT_LINK_REASON = 'a minor on the evaluation date with no guardian link at all (guardianId empty, listed by no guardian): by the Founder\'s decision the cutover stops until this record is resolved by hand — it is not imported, omitted, linked, re-dated or deleted here';
export const AUTHORISES_NOTHING = 'This report validates data against the intended S4a schema. It does not approve, schedule or perform the cutover; migration 0005 is not registered and the blob stays authoritative.';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const label = (rec, i) => (isPlainObject(rec) && typeof rec.id === 'string' && rec.id ? rec.id : `#${i}`);

/**
 * The intended live DDL of the three tables: the identity section of
 * `docs/architecture/sql/01_identity.sql` plus the transitional `facets_json`
 * column on `players` and `guardians` (readiness review §1, §7.1). Used to
 * build TEMPORARY candidate schemas for tests and the preflight's SQL check;
 * not registered as a migration, and not applied to any real database by
 * anything in this step. `scripts/testCoreIdentityMapping.mjs` asserts it
 * equals the documented DDL column for column apart from `facets_json`.
 */
export const CANDIDATE_DDL = `
CREATE TABLE guardians (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  email                   TEXT NOT NULL,
  password_hash           TEXT,
  email_verified          INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  email_code_hash         TEXT,
  id_verified             INTEGER NOT NULL DEFAULT 0 CHECK (id_verified IN (0,1)),
  idv_reference           TEXT,
  disclaimer_accepted     INTEGER NOT NULL DEFAULT 0 CHECK (disclaimer_accepted IN (0,1)),
  disclaimer_accepted_at  INTEGER,
  co_guardian_of          TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  prefs_quiet_start       TEXT,
  prefs_quiet_end         TEXT,
  prefs_school_hours_mute INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
  prefs_timezone          TEXT,
  created_at              INTEGER,
  deleted_at              INTEGER,
  facets_json             TEXT CHECK (facets_json IS NULL OR json_valid(facets_json))
) STRICT;
CREATE UNIQUE INDEX guardians_email ON guardians (lower(email));
CREATE INDEX guardians_co_guardian_of ON guardians (co_guardian_of);

CREATE TABLE players (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  birth_date               TEXT NOT NULL CHECK (length(birth_date) = 10),
  country                  TEXT NOT NULL,
  city                     TEXT,
  position                 TEXT CHECK (position IS NULL OR position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  foot                     TEXT CHECK (foot IS NULL OR foot IN ('left','right')),
  height_cm                INTEGER,
  weight_kg                INTEGER,
  squad_number             INTEGER,
  contract_until_date      TEXT CHECK (contract_until_date IS NULL OR length(contract_until_date) = 10),
  market_value_range       TEXT,
  agent_name               TEXT,
  academy_plus             INTEGER NOT NULL DEFAULT 0 CHECK (academy_plus IN (0,1)),
  first_team_seeker        INTEGER NOT NULL DEFAULT 0 CHECK (first_team_seeker IN (0,1)),
  availability             TEXT NOT NULL DEFAULT 'not_seeking' CHECK (availability IN ('available_now','end_of_season','loan_open','overseas_open','not_seeking')),
  contract_status          TEXT NOT NULL DEFAULT 'unknown' CHECK (contract_status IN ('under_contract','expiring_summer','scholarship_ending','release_approaching','free_agent','unknown')),
  level                    TEXT NOT NULL DEFAULT 'amateur' CHECK (level IN ('amateur','semi_pro','pro')),
  football_category        TEXT,
  identity_verified        INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0,1)),
  guardian_id              TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  lat                      REAL,
  lng                      REAL,
  stats_appearances        INTEGER,
  stats_goals              INTEGER,
  stats_assists            INTEGER,
  stats_pace_kmh           REAL,
  stats_pass_completion_pct REAL,
  stats_duel_success_pct   REAL,
  stats_clean_sheets       INTEGER,
  medical_shared           INTEGER NOT NULL DEFAULT 0 CHECK (medical_shared IN (0,1)),
  medical_condition_status TEXT NOT NULL DEFAULT 'unknown',
  prefs_quiet_start        TEXT,
  prefs_quiet_end          TEXT,
  prefs_school_hours_mute  INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
  prefs_timezone           TEXT,
  programme_track          TEXT,
  programme_started_at     INTEGER,
  password_hash            TEXT,
  created_at               INTEGER,
  deleted_at               INTEGER,
  facets_json              TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)),
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE INDEX players_guardian ON players (guardian_id);
CREATE INDEX players_created_at ON players (created_at);
CREATE INDEX players_search ON players (country, position, availability);
CREATE INDEX players_level ON players (level);

CREATE TABLE guardian_children (
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','co')),
  PRIMARY KEY (guardian_id, player_id)
) STRICT;
CREATE INDEX guardian_children_player ON guardian_children (player_id);
`;

/** Create the three candidate tables on a connection (a temporary database); refuses a connection that already has them. */
export function createCandidateSchema(sqlite) {
  const existing = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guardians', 'players', 'guardian_children')").all();
  if (existing.length) throw new Error(`createCandidateSchema: ${existing.map((r) => r.name).join(', ')} already exist on this connection; the candidate schema is for a temporary database only`);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(CANDIDATE_DDL);
}

const insertSql = (table, columns) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;
/**
 * A candidate row is rendered in the S4a layout (the arrays inside facets_json).
 * On a connection where migration 0007 is recorded, the `players` row is
 * re-rendered without them (`subrecords: 'tables'`); the arrays are written as
 * child rows by the caller. Decoding and re-encoding go through the one mapping.
 */
export function playerRowFor(sqlite, candidateRow) {
  return subrecordsLive(sqlite) ? playerToRow(playerFromRow(candidateRow), { subrecords: 'tables' }) : candidateRow;
}

/**
 * Load a candidate into the candidate tables, inside the caller's transaction:
 * guardians in two passes (rows without their `co_guardian_of`, then the links,
 * so array order cannot matter), players, then the link rows. Foreign keys are
 * enforced on every statement and `PRAGMA foreign_key_check` must be empty
 * afterwards. Returns the counts written. Throws on the first refusal — the
 * caller's transaction then rolls back and the tables hold nothing of it.
 */
export function writeCandidate(sqlite, candidate) {
  if (!candidate || !Array.isArray(candidate.guardians) || !Array.isArray(candidate.players) || !Array.isArray(candidate.links)) {
    throw new TypeError('writeCandidate needs a candidate { guardians, players, links } (a report that is not complete has none)');
  }
  // The rows must be what `validateCoreIdentity` emits. A reference column is
  // either null/absent (no link) or a non-empty string; anything else — an
  // empty string, a number — is a malformed candidate and is refused BEFORE
  // the first statement, so a present value can never be dropped by the
  // two-pass write below and nothing is half-written.
  const describeValue = (v) => (v === null ? 'null' : v === undefined ? 'absent' : v === '' ? 'an empty string' : Array.isArray(v) ? 'an array' : `a ${typeof v}`);
  const reference = (where, col, v, { required = false } = {}) => {
    if (v === null || v === undefined) { if (required) throw new TypeError(`writeCandidate: malformed candidate — ${where}: ${col} is ${describeValue(v)}`); return; }
    if (typeof v !== 'string' || v === '') throw new TypeError(`writeCandidate: malformed candidate — ${where}: ${col} is ${describeValue(v)}, not a non-empty id`);
  };
  candidate.guardians.forEach((row, i) => { reference(`guardians ${row?.id ?? `#${i}`}`, 'id', row?.id, { required: true }); reference(`guardians ${row.id}`, 'co_guardian_of', row.co_guardian_of); });
  candidate.players.forEach((row, i) => { reference(`players ${row?.id ?? `#${i}`}`, 'id', row?.id, { required: true }); reference(`players ${row.id}`, 'guardian_id', row.guardian_id); });
  candidate.links.forEach((row) => { reference('links', 'guardian_id', row?.guardian_id, { required: true }); reference('links', 'player_id', row?.player_id, { required: true }); if (row.role !== 'primary' && row.role !== 'co') throw new TypeError(`writeCandidate: malformed candidate — links: role ${JSON.stringify(row.role)} is not primary or co`); });
  const insG = sqlite.prepare(insertSql('guardians', GUARDIAN_COLUMNS));
  const linkG = sqlite.prepare('UPDATE guardians SET co_guardian_of = ? WHERE id = ?');
  const insP = sqlite.prepare(insertSql('players', PLAYER_COLUMNS));
  const insL = sqlite.prepare('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (@guardian_id, @player_id, @role)');
  const pending = [];
  for (const row of candidate.guardians) {
    const { co_guardian_of, ...rest } = row;
    insG.run({ ...rest, co_guardian_of: null });
    if (co_guardian_of !== null && co_guardian_of !== undefined) pending.push([co_guardian_of, row.id]);
  }
  for (const [target, id] of pending) {
    if (linkG.run(target, id).changes !== 1) throw new Error(`writeCandidate: co_guardian_of of guardian ${id} was not written`);
  }
  for (const row of candidate.players) insP.run(playerRowFor(sqlite, row));
  if (subrecordsLive(sqlite)) {
    // S5: the arrays are rows of the child tables, written from the same record the candidate row renders.
    const st = prepareSubrecordStatements(sqlite);
    for (const row of candidate.players) writeChildRows(st, playerFromRow(row));
  }
  for (const row of candidate.links) insL.run(row);
  const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
  return { guardians: candidate.guardians.length, players: candidate.players.length, links: candidate.links.length };
}

/**
 * Validate the two collections and their relationships; build the candidate
 * when allowed. `db` is a snapshot's `db` (or any object with `players` and
 * `guardians`); `now` is the evaluation instant for adult/minor (an integer
 * ms timestamp, so a report is reproducible).
 */
export function validateCoreIdentity(db, { now = Date.now() } = {}) {
  const refusals = [];   // { collection, id, reason }  — the target refuses; no candidate
  const findings = [];   // { kind, id, detail }        — counted, carried as is
  const legacyMinorsWithoutLink = []; // ids refused under the Founder's decision (also in `refusals`)
  const refuse = (collection, id, reason) => refusals.push({ collection, id, reason });

  const players = Array.isArray(db?.players) ? db.players : null;
  const guardians = Array.isArray(db?.guardians) ? db.guardians : null;
  const describeValue = (v) => (v === undefined ? 'absent' : v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
  if (!isPlainObject(db)) refuse('snapshot', null, `the snapshot is ${db === null ? 'null' : typeof db}, not an object`);
  else {
    if (!players) refuse('players', null, `the players collection is ${describeValue(db.players)}, not an array`);
    if (!guardians) refuse('guardians', null, `the guardians collection is ${describeValue(db.guardians)}, not an array`);
  }
  const onDate = new Date(Number.isFinite(now) ? now : Date.now());

  // 1. Records, one by one. Ids of VALID records are what relationships are checked against.
  const validPlayers = new Map();   // id → record
  const validGuardians = new Map();
  const seenPlayerIds = new Map();  // id → count (duplicates refuse every copy)
  const seenGuardianIds = new Map();
  for (const [i, rec] of (players ?? []).entries()) {
    const id = label(rec, i);
    const v = validatePlayerRecord(rec);
    if (!v.ok) { for (const p of v.problems) refuse('players', id, p); continue; }
    seenPlayerIds.set(rec.id, (seenPlayerIds.get(rec.id) ?? 0) + 1);
    validPlayers.set(rec.id, rec);
  }
  for (const [i, rec] of (guardians ?? []).entries()) {
    const id = label(rec, i);
    const v = validateGuardianRecord(rec);
    if (!v.ok) { for (const p of v.problems) refuse('guardians', id, p); continue; }
    seenGuardianIds.set(rec.id, (seenGuardianIds.get(rec.id) ?? 0) + 1);
    validGuardians.set(rec.id, rec);
  }
  for (const [id, n] of seenPlayerIds) if (n > 1) { refuse('players', id, `duplicate id (${n} records)`); validPlayers.delete(id); }
  for (const [id, n] of seenGuardianIds) if (n > 1) { refuse('guardians', id, `duplicate id (${n} records)`); validGuardians.delete(id); }

  // 2. Guardian e-mail uniqueness under the target's comparison (lower(email)). The address itself is never reported.
  const byEmail = new Map();
  for (const g of validGuardians.values()) {
    const key = g.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(g.id);
  }
  for (const ids of byEmail.values()) {
    if (ids.length < 2) continue;
    const sorted = ids.slice().sort(byText);
    for (const id of sorted) refuse('guardians', id, `shares its e-mail (compared case-insensitively) with ${sorted.filter((x) => x !== id).join(', ')}; the unique index guardians_email would refuse the import`);
  }

  // 3. References and links.
  const describeRef = (map, refused, id) => (refused.has(id) ? 'a record this report refused' : map.has(id) ? null : 'no record');
  const refusedPlayers = new Set([...seenPlayerIds.keys()].filter((id) => !validPlayers.has(id)));
  const refusedGuardians = new Set([...seenGuardianIds.keys()].filter((id) => !validGuardians.has(id)));
  for (const [id, n] of seenPlayerIds) if (n > 1) refusedPlayers.add(id);
  for (const [id, n] of seenGuardianIds) if (n > 1) refusedGuardians.add(id);
  // Guardians named by refused records are also "refused" for reference purposes.
  for (const [i, rec] of (guardians ?? []).entries()) if (isPlainObject(rec) && typeof rec.id === 'string' && !validGuardians.has(rec.id)) refusedGuardians.add(rec.id);
  for (const [i, rec] of (players ?? []).entries()) if (isPlainObject(rec) && typeof rec.id === 'string' && !validPlayers.has(rec.id)) refusedPlayers.add(rec.id);

  const listedBy = new Map(); // playerId → [guardianId] (valid guardians whose childIds list it)
  const links = [];           // { guardian_id, player_id, role } in guardian order, then childIds order
  // Presence, never truthiness: a reference is checked whenever the record
  // carries one (validation already refused '' and non-text values).
  const present = (v) => v !== null && v !== undefined;
  for (const g of validGuardians.values()) {
    if (present(g.coGuardianOf)) {
      if (g.coGuardianOf === g.id) refuse('guardians', g.id, 'coGuardianOf names itself');
      else { const why = describeRef(validGuardians, refusedGuardians, g.coGuardianOf); if (why) refuse('guardians', g.id, `coGuardianOf names ${why} (${g.coGuardianOf})`); }
    }
    const seen = new Set();
    for (const childId of g.childIds ?? []) {
      if (seen.has(childId)) { refuse('guardians', g.id, `childIds lists ${childId} more than once (the link primary key would refuse it)`); continue; }
      seen.add(childId);
      const why = describeRef(validPlayers, refusedPlayers, childId);
      if (why) { refuse('guardians', g.id, `childIds names ${why} (${childId})`); continue; }
      if (!listedBy.has(childId)) listedBy.set(childId, []);
      listedBy.get(childId).push(g.id);
    }
  }
  for (const p of validPlayers.values()) {
    if (!present(p.guardianId)) continue;
    const why = describeRef(validGuardians, refusedGuardians, p.guardianId);
    if (why) { refuse('players', p.id, `guardianId names ${why} (${p.guardianId})`); continue; }
    if (!(listedBy.get(p.id) ?? []).includes(p.guardianId)) refuse('players', p.id, `guardianId names ${p.guardianId} but that guardian's childIds does not list the player (the two sides disagree; only the operator can say which is right)`);
  }
  // Roles, counted findings and the Founder's rule for unlinked minors — on the valid, consistent records.
  let primaryLinks = 0; let coLinks = 0; let adultsStillLinked = 0; let coGuardianArrangements = 0; let minorsCoOnly = 0;
  for (const g of validGuardians.values()) {
    if (present(g.coGuardianOf) && validGuardians.has(g.coGuardianOf) && g.coGuardianOf !== g.id) { coGuardianArrangements += 1; findings.push({ kind: 'co_guardian_arrangement', id: g.id, detail: `co-guardian of ${g.coGuardianOf}` }); }
    for (const childId of g.childIds ?? []) {
      const child = validPlayers.get(childId);
      if (!child) continue;
      const role = child.guardianId === g.id ? 'primary' : 'co';
      if (role === 'primary') primaryLinks += 1; else { coLinks += 1; findings.push({ kind: 'co_link', id: g.id, detail: `lists ${childId}, whose primary guardian is ${child.guardianId ?? 'none'}; imported as role co` }); }
      links.push({ guardian_id: g.id, player_id: childId, role });
    }
  }
  for (const p of validPlayers.values()) {
    const hasPrimary = present(p.guardianId);
    const linked = (listedBy.get(p.id) ?? []).length > 0 || hasPrimary;
    const adult = isAdult(p, onDate);
    if (adult && linked) { adultsStillLinked += 1; findings.push({ kind: 'adult_still_linked', id: p.id, detail: `an adult on the evaluation date, still linked to ${[...new Set([...(hasPrimary ? [p.guardianId] : []), ...(listedBy.get(p.id) ?? [])])].sort(byText).join(', ')}; imported unchanged, no policy implied` }); }
    if (!adult && !linked) { legacyMinorsWithoutLink.push(p.id); refuse('players', p.id, MINOR_WITHOUT_LINK_REASON); }
    if (!adult && linked && !hasPrimary) { minorsCoOnly += 1; findings.push({ kind: 'minor_with_co_links_only', id: p.id, detail: `a minor with no primary guardian (guardianId null or absent) listed by ${(listedBy.get(p.id) ?? []).slice().sort(byText).join(', ')}` }); }
  }

  // 4. Status and candidate.
  refusals.sort((a, b) => byText(a.collection, b.collection) || byText(String(a.id), String(b.id)) || byText(a.reason, b.reason));
  findings.sort((a, b) => byText(a.kind, b.kind) || byText(a.id, b.id) || byText(a.detail, b.detail));
  legacyMinorsWithoutLink.sort(byText);
  const status = refusals.length ? PREFLIGHT_STATUS.INVALID : PREFLIGHT_STATUS.COMPLETE;
  const candidate = status === PREFLIGHT_STATUS.COMPLETE
    ? { guardians: guardians.map(guardianToRow), players: players.map(playerToRow), links }
    : null;
  return {
    status,
    evaluatedAt: onDate.getTime(),
    counts: {
      players: players?.length ?? 0, guardians: guardians?.length ?? 0,
      validPlayers: validPlayers.size, validGuardians: validGuardians.size,
      links: links.length, primaryLinks, coLinks, adultsStillLinked, coGuardianArrangements, minorsWithCoLinksOnly: minorsCoOnly,
      refusals: refusals.length, findings: findings.length, legacyMinorsWithoutLink: legacyMinorsWithoutLink.length,
    },
    refusals,
    findings,
    legacyMinorsWithoutLink,
    candidate,
    authorises: AUTHORISES_NOTHING,
  };
}

/** The report without the candidate rows (which carry hashes and codes): what a tool prints or a test compares. */
export function publicReport(report) {
  const { candidate, ...rest } = report;
  return { ...rest, candidate: candidate ? { guardians: candidate.guardians.length, players: candidate.players.length, links: candidate.links.length } : null };
}
