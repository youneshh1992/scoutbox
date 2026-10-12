/**
 * Players and guardians — the live repositories for the core identity tables
 * (migration plan step S4a; readiness review §1, §4, §5).
 *
 * LIVE since the S4a integration: `repositories/index.mjs` creates these
 * repositories at boot behind the registered migration 0005, `TABLE_BACKED`
 * lists both collections, and the blobs are never written again. The
 * registration is development work on this branch; a real-data cutover is
 * the operator's decision (OPERATIONS.md).
 *
 * Authority. A repository attaches only when the cutover record
 * `0005_core_identity_live` is in `data_migrations` — never because the
 * tables exist (the S1 shadow created tables of the same name) or hold rows —
 * and it refuses the shadow definitions outright (no `facets_json` column).
 * Initialisation is explicit state in `meta.coreIdentityInit`: `pending` only
 * for a database nothing was ever saved to, `done` otherwise; `initialize()`
 * imports the first installation's records once, atomically with the state
 * change and only when the preflight is `complete` (a refused snapshot —
 * including a legacy minor without any guardian link, by the Founder's
 * decision — writes nothing and the next boot retries); `attach()` never
 * imports: an empty authoritative domain stays empty whatever array or blob
 * the caller holds.
 *
 * Storage follows the S3 organisation pattern through the ONE mapping of
 * `identityMapping.mjs`: column-backed fields change only through
 * `insert`/`update`/`restore` and the link operations; since S5 the player
 * arrays (`media`, `attendance`, …, `medical.records`, `programme.completed`)
 * are rows of the `player_*` tables written only through `addItem` /
 * `setItems` / `patchItem` (and `insert` / `restore`), served read-only on the
 * record; `trialReports` is derived from the trials collection and written
 * nowhere; everything else (`coGuardians`, the guardian's outstanding
 * `emailCode`, unknown fields) is a facet mutated in place on the record the
 * views serve and flushed inside every save, counted as persisted only once
 * that save committed. The record views refuse a write to a column-backed
 * field — nested values of `location`, `stats`, `notificationPrefs`,
 * `medical.shared`, `medical.conditionStatus`, `programme.track`,
 * `programme.startedAt` included — to `childIds`, and to every array and item.
 *
 * Relationships. `players.guardian_id` and the `primary` row of
 * `guardian_children` are written together by every link change and can no
 * longer disagree: `link(..., 'primary')` refuses a second primary,
 * `unlink`/`ageUp` clear both sides, a dangling or duplicate link is refused,
 * a new minor is created with its primary link in the same transaction (an
 * unlinked child cannot be created), and a guardian's e-mail is unique
 * case-insensitively. `childIds` on the guardian record is derived from the
 * link rows (in their order) and served read-only. Today's domain behaviour
 * is preserved where the writers survey it: `ageUp` clears the primary link
 * only (co-guardians keep listing the child, as today), `remove` is today's
 * hard delete and `restore` is the signing rollback's whole-record write.
 * None of this is a deletion or retention policy (O1 stays open).
 *
 * Transactions. Every write operation is validated first (a refusal throws
 * before any statement and changes nothing, in or out of a unit), then runs
 * its statements and, only once they are committed, its memory bookkeeping
 * (`atomically`). Outside the store's unit of work the statements get a
 * transaction of their own (refused inside anyone else's: the bookkeeping
 * could not follow a foreign rollback) and a failure anywhere up to and
 * including COMMIT leaves SQL and memory — records, held references, link
 * arrays, indexes, views, facet tracking — exactly as they were; the
 * operation is simply retried. Inside a unit the operation joins it through
 * the store's `unit.join`, so a failure after a statement poisons the whole
 * unit even when the caller catches the error (the unit cannot commit the
 * fragment), and the save hook's `snapshotState` / `restoreState` put the
 * bookkeeping back when the unit rolls back. Ordinary saves keep the S3
 * contract: a failed flush leaves facet edits pending for the next save.
 */
import { readonlyView, markView } from './readonly.mjs';
import { captureGraph, restoreGraph } from './memento.mjs';
import { migrationApplied, transaction } from './database.mjs';
import { requireRuntime } from '../runtime.mjs';
import { isAdult } from '../domain.mjs';
import {
  playerToRow, playerFromRow, guardianToRow, guardianFromRow, validateGuardianRecord,
  PLAYER_COLUMNS, GUARDIAN_COLUMNS, PLAYER_MIGRATED_KEYS, GUARDIAN_MIGRATED_KEYS, PLAYER_COMPOSITES, GUARDIAN_COMPOSITES, RESERVED_KEYS,
  PLAYER_SUBRECORD_KEYS, PLAYER_COMPOSITE_SUBRECORDS, PLAYER_DERIVED_KEYS,
} from './identityMapping.mjs';
import { validateCoreIdentity, writeCandidate, publicReport, playerRowFor, CORE_IDENTITY_LIVE_MIGRATION } from './identityPreflight.mjs';
import {
  PLAYER_SUBRECORDS_MIGRATION, subrecordsLive, SUBRECORD_KEYS, SUBRECORD_SPECS, SUBRECORD_TABLES, getSubrecords, validateSubrecordArray,
  validatePlayerRecordWithItems as validatePlayerRecord, prepareSubrecordStatements, writeChildRows, writeArrayRows, deleteChildRows,
  readAllChildren, countChildRows, itemRows, trialReportsFor, readTrialsBlob, readPlayersWithChildren, emptyChildren, reconcileTrialReportCopy,
} from './playerSubrecords.mjs';

/** `meta` key holding the initialisation state (`pending` | `done`); absent reads as `done`. */
export const CORE_IDENTITY_INIT_META = 'coreIdentityInit';
/** The two collections the identity repositories own; coupled through the link rows. */
export const IDENTITY_COLLECTIONS = Object.freeze(['players', 'guardians']);
/** Composites whose remainder is a mutable facet: only the column-backed sub-keys are guarded. */
export const PLAYER_SPLIT_COMPOSITES = Object.freeze(['medical', 'programme']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.hasOwn(o, k);
const setOwn = (o, k, v) => { Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true }); return o; };
/** A JSON clone that keeps own keys named like Object.prototype members as data. */
const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
const present = (v) => v !== null && v !== undefined;
const describeValue = (v) => (v === null ? 'null' : v === undefined ? 'absent' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const sqlReason = (err) => String(err?.message ?? err).replace(/^SQLITE_\w+:\s*/, '');

const insertSql = (table, columns) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;
const updateSql = (table, columns) => `UPDATE ${table} SET ${columns.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`;

/**
 * Whole-snapshot access for the tools that read or write the database file as
 * one unit (backups, restores, the persistence suites): the two collections as
 * the server sees them, and the inverse — make the three tables equal to the
 * snapshot's `players` and `guardians`, inside the caller's transaction.
 *
 * The collections are COUPLED: the link rows derive from both, so a snapshot
 * must carry both or neither (`repositories/index.mjs` refuses one without the
 * other). The whole pair is validated first with the reviewed preflight —
 * shapes, every record, duplicate ids and e-mails, every reference, both sides
 * of every link, the Founder's legacy-minor rule, age at `now` — and any
 * refusal throws before a statement runs, so the caller's transaction rolls
 * back with nothing changed. An explicitly empty pair is intentional: it
 * empties the tables. The write is a REWRITE: the three tables are emptied
 * (links, players, guardians) and the validated candidate is inserted in the
 * snapshot's order (guardians in two passes for `co_guardian_of`, then
 * players, then the links derived from the guardians' `childIds` in their
 * order), so the outcome never depends on obsolete rows or on input order —
 * a replacement guardian may reuse the e-mail of the one it replaces, two
 * retained guardians may swap e-mails, a co-guardian may be listed before its
 * primary (review of 9656a4b). Unknown JSON keys, null/absent shape and the
 * outstanding `emailCode` ride in the rows through the one mapping. Before
 * the cutover record exists both methods decline (`null` / `false`) and the
 * caller keeps the blobs.
 *
 * S5 (review of 132eda2, finding 1): once 0007 is recorded a `trialReports`
 * ARRAY on a snapshot player is a claim about the trials collection — the FINAL
 * one: `trials` supplied with the snapshot (written as a blob in the same
 * transaction) when the snapshot carries it, the retained blob when it omits
 * it. A claim that disagrees (an entry with no trial report of that id, a
 * different content or order, a duplicate), or a claim no trials list can
 * judge, refuses the whole save before a statement runs. An absent key or a
 * null is no claim: the trials stand and the record reads back with whatever
 * reports name it. A trials-only snapshot (no players) changes the derived view
 * and needs no player at all. The copy is never stored, so the only honest
 * outcomes are "equal" or "refused" — never a silent drop.
 */
export const IDENTITY_SNAPSHOT = {
  names: IDENTITY_COLLECTIONS,
  cutOver: (sqlite) => migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION),
  read(sqlite) {
    if (!this.cutOver(sqlite)) return null;
    const childIds = new Map();
    for (const l of sqlite.prepare('SELECT guardian_id, player_id FROM guardian_children ORDER BY rowid').all()) {
      if (!childIds.has(l.guardian_id)) childIds.set(l.guardian_id, []);
      childIds.get(l.guardian_id).push(l.player_id);
    }
    // S5 (migration 0007 recorded): the arrays come from the child tables and
    // `trialReports` from the trials blob of the same file; before it the
    // facets carry everything (an S4a file, a rollback copy).
    const players = subrecordsLive(sqlite)
      ? readPlayersWithChildren(sqlite, prepareSubrecordStatements(sqlite), { trials: readTrialsBlob(sqlite) ?? [] }).map((x) => x.record)
      : sqlite.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players ORDER BY rowid`).all().map((r) => playerFromRow(r));
    return {
      guardians: sqlite.prepare(`SELECT ${GUARDIAN_COLUMNS.join(', ')} FROM guardians ORDER BY rowid`).all().map((r) => guardianFromRow(r, childIds.get(r.id) ?? [])),
      players,
    };
  },
  replace(sqlite, { players, guardians }, { now = Date.now(), trials = undefined } = {}) {
    if (!this.cutOver(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('identity snapshot: replace() runs inside the caller\'s transaction');
    for (const [name, value] of [['players', players], ['guardians', guardians]]) {
      if (!Array.isArray(value)) throw new TypeError(`${name}: the snapshot collection must be an array of records (got ${describeValue(value)}); the save was rolled back and nothing was written`);
    }
    const report = validateCoreIdentity({ players, guardians }, { now });
    if (report.status !== 'complete') {
      const listed = report.refusals.slice(0, 20).map((r) => `${r.collection} ${r.id ?? '(collection)'}: ${r.reason}`).join('; ');
      throw new Error(`identity snapshot: ${report.refusals.length} record(s) or relationship(s) were refused (${listed}${report.refusals.length > 20 ? '; …' : ''}); the save was rolled back and no player, guardian or link was changed`);
    }
    const { candidate } = report;
    // The trialReports claims, judged against the FINAL trials (see above) before any statement runs.
    if (subrecordsLive(sqlite)) {
      const finalTrials = trials === undefined ? readTrialsBlob(sqlite) : trials;
      const list = Array.isArray(finalTrials) ? finalTrials : null;
      const problems = [];
      for (const row of candidate.players) {
        const copy = playerFromRow(row).trialReports; // the candidate row carries the record's value in its facets (the S4a layout)
        if (copy === null || copy === undefined) continue;
        if (!list) { problems.push(`players ${row.id}: the trials collection ${trials === undefined ? 'retained in the file' : 'supplied with the snapshot'} is ${describeValue(finalTrials)}, not an array, so its trialReports copy cannot be reconciled`); continue; }
        problems.push(...reconcileTrialReportCopy(row.id, copy, trialReportsFor(list, row.id), { hint: 'resolve the snapshot before saving it' }));
      }
      if (problems.length) {
        const ids = new Set(problems.map((p) => p.slice(0, p.indexOf(':'))));
        throw Object.assign(new Error(`identity snapshot: the trialReports of ${ids.size} player(s) cannot be reconciled with the trials collection (${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}); the save was rolled back and nothing was written`), { code: 'TRIAL_REPORTS_UNRECONCILED', problems });
      }
    }
    // The three tables are REWRITTEN from the validated candidate (review of
    // 9656a4b, finding 3): every existing row goes first — links, then players,
    // then guardians, children before parents so no foreign key is ever left
    // dangling — and the candidate is inserted in the snapshot's order
    // (guardians in two passes for `co_guardian_of`, then players, then the
    // links derived from the guardians' `childIds`). Nothing about the outcome
    // depends on what the tables held before or on the order the collections
    // list their records: a replacement guardian may carry the e-mail of the
    // one it replaces, two retained guardians may swap e-mails, a co-guardian
    // may be listed before its primary — the unique e-mail index and the
    // foreign keys judge the FINAL state only, which the preflight already
    // accepted. The caller's transaction makes the rewrite all-or-nothing.
    // S5: the child rows CASCADE with the player rows here and are written again
    // below from the snapshot's records, so the FINAL state holds exactly the
    // arrays the snapshot carries (a record without an array has no rows; an
    // empty array has none and reads back empty; a null stays null).
    sqlite.exec('DELETE FROM guardian_children');
    sqlite.exec('DELETE FROM players');
    sqlite.exec('DELETE FROM guardians');
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
    for (const [target, id] of pending) linkG.run(target, id);
    for (const row of candidate.players) insP.run(playerRowFor(sqlite, row));
    if (subrecordsLive(sqlite)) {
      const st = prepareSubrecordStatements(sqlite);
      for (const row of candidate.players) writeChildRows(st, playerFromRow(row));
    }
    for (const row of candidate.links) insL.run(row);
    const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`identity snapshot: foreign_key_check found ${broken.length} broken reference(s) after the write; the save was rolled back`);
    return true;
  },
};

/**
 * `trialReports(playerId)` (optional) resolves the derived `trialReports` of a
 * player from the authoritative trials collection (S5 decision 5); without it
 * every player's list is empty. It is read live on every access.
 */
export function createIdentityRepositories({ sqlite, log = () => {}, warn = () => {}, unit = null, now = Date.now, trialReports = null }) {
  if (!sqlite) throw new TypeError('the identity repositories need a SQLite connection (node:sqlite); the data layer has no in-memory fallback');
  requireRuntime();
  if (typeof sqlite.isTransaction !== 'boolean') throw new Error('NODE_UNSUPPORTED: this SQLite connection has no transaction state (isTransaction); the identity repositories cannot tell a save transaction from autocommit');
  // Authority is the cutover record, never the tables. Checked before any statement is prepared.
  if (!migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION)) throw new Error(`core identity: the cutover record ${CORE_IDENTITY_LIVE_MIGRATION} is missing from data_migrations; the players, guardians and guardian_children tables cannot be trusted as the source of truth`);
  // The S1 shadow created tables of the same names without facets_json; attaching to them would lose every facet.
  for (const table of ['players', 'guardians']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.length) throw new Error(`core identity: the ${table} table does not exist although the cutover record is present`);
    if (!cols.includes('facets_json')) throw new Error(`core identity: the ${table} table is the S1 shadow definition (no facets_json column), not the live table; refusing to attach`);
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guardian_children'").get()) throw new Error('core identity: the guardian_children table does not exist although the cutover record is present');
  // S5: the sub-record tables are the only place the arrays live once 0007 is recorded; the repository never attaches to a database between 0005 and 0007 (the same boot applies both).
  if (!subrecordsLive(sqlite)) throw new Error(`core identity: the sub-record record ${PLAYER_SUBRECORDS_MIGRATION} is missing from data_migrations; the player arrays have no authoritative storage on this connection`);
  for (const table of SUBRECORD_TABLES) if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error(`core identity: the ${table} table does not exist although ${PLAYER_SUBRECORDS_MIGRATION} is recorded`);
  if (trialReports !== null && typeof trialReports !== 'function') throw new TypeError('the identity repositories take trialReports as a function (playerId → the trial reports naming the player) or null');
  const derivedTrialReports = (playerId) => (trialReports ? trialReports(playerId) : []);

  // The store's participant API: `active()` says whether a unit is open, `join(work)` runs an operation inside it through the poisoning boundary.
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the identity repositories need the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  const inUnit = () => !!unit?.active?.();
  const stmt = {
    allPlayers: sqlite.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players ORDER BY rowid`),
    allGuardians: sqlite.prepare(`SELECT ${GUARDIAN_COLUMNS.join(', ')} FROM guardians ORDER BY rowid`),
    allLinks: sqlite.prepare('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid'),
    insertPlayer: sqlite.prepare(insertSql('players', PLAYER_COLUMNS)),
    updatePlayer: sqlite.prepare(updateSql('players', PLAYER_COLUMNS)),
    playerFacets: sqlite.prepare('UPDATE players SET facets_json = @facets_json WHERE id = @id'),
    // The column and the row's shape metadata (facets_json.__meta: is guardianId present, is it null) change together.
    setPlayerGuardian: sqlite.prepare('UPDATE players SET guardian_id = @guardian_id, facets_json = @facets_json WHERE id = @id'),
    deletePlayer: sqlite.prepare('DELETE FROM players WHERE id = ?'),
    insertGuardian: sqlite.prepare(insertSql('guardians', GUARDIAN_COLUMNS)),
    updateGuardian: sqlite.prepare(updateSql('guardians', GUARDIAN_COLUMNS)),
    guardianFacets: sqlite.prepare('UPDATE guardians SET facets_json = @facets_json WHERE id = @id'),
    insertLink: sqlite.prepare('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, ?)'),
    deleteLink: sqlite.prepare('DELETE FROM guardian_children WHERE guardian_id = ? AND player_id = ?'),
    countPlayers: sqlite.prepare('SELECT COUNT(*) AS n FROM players'),
    countGuardians: sqlite.prepare('SELECT COUNT(*) AS n FROM guardians'),
    countLinks: sqlite.prepare('SELECT COUNT(*) AS n FROM guardian_children'),
    meta: sqlite.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    sub: prepareSubrecordStatements(sqlite),
  };

  // ------------------------------------------------------------ in-memory state
  // One domain each: plain records (the view targets), their views in the same
  // order, the id index, and the facet tracking (committed-only, S3 correction 1).
  const makeDomain = (name) => ({ name, records: [], proxies: [], byId: new Map(), committed: new Map(), pending: new Map() });
  const P = makeDomain('players');
  const G = makeDomain('guardians');

  const refuse = (what) => { throw new TypeError(`${what} is written through the identity repositories (players.insert / players.update / players.restore / players.addItem / players.setItems / players.patchItem / guardians.insert / guardians.update / link / unlink / ageUp), never directly on the in-memory view.`); };
  const refuseNested = (domain, key) => refuse(`a ${domain} record (field "${String(key)}", including its nested values)`);
  const SUB_LABEL = (key) => `a player's ${key} (S5: rows of ${SUBRECORD_SPECS[key]?.table ?? 'their table'}; use players.addItem / setItems / patchItem)`;
  const isSubKey = (key) => typeof key === 'string' && PLAYER_SUBRECORD_KEYS.includes(key);
  const isDerivedKey = (key) => typeof key === 'string' && PLAYER_DERIVED_KEYS.includes(key);

  // Whole guards (every nested write refused): location, stats, notificationPrefs. Stable identity per object.
  const guards = new WeakMap();
  const guard = (value, domain, key) => {
    if (value === null || typeof value !== 'object') return value;
    let g = guards.get(value);
    if (!g) {
      g = markView(new Proxy(value, {
        get(t, prop, receiver) { return guard(Reflect.get(t, prop, receiver), domain, key); },
        set() { return refuseNested(domain, key); },
        deleteProperty() { return refuseNested(domain, key); },
        defineProperty() { return refuseNested(domain, key); },
        setPrototypeOf() { return refuseNested(domain, key); },
      }));
      guards.set(value, g);
    }
    return g;
  };
  // Split guards (medical, programme): the column-backed sub-keys are refused, the
  // table-backed sub-keys (records, completed — S5) are served read-only, the
  // remainder (an unknown sub-key) stays a plain mutable facet.
  const splitGuards = new WeakMap();
  const splitGuard = (value, domain, key, columnSubs) => {
    if (!isPlainObject(value)) return value;
    let g = splitGuards.get(value);
    if (!g) {
      const columnBacked = (prop) => hasOwn(columnSubs, prop);
      const tableBacked = (prop) => (PLAYER_COMPOSITE_SUBRECORDS[key] ?? []).includes(prop);
      g = markView(new Proxy(value, {
        get(t, prop, receiver) { const v = Reflect.get(t, prop, receiver); return tableBacked(prop) ? readonlyView(v, SUB_LABEL(`${key}.${String(prop)}`)) : v; },
        set(t, prop, v) { if (columnBacked(prop)) return refuseNested(domain, `${key}.${String(prop)}`); if (tableBacked(prop)) return refuse(SUB_LABEL(`${key}.${String(prop)}`)); setOwn(t, prop, v); return true; },
        deleteProperty(t, prop) { if (columnBacked(prop) || tableBacked(prop)) return refuseNested(domain, `${key}.${String(prop)}`); delete t[prop]; return true; },
        defineProperty(t, prop, desc) { if (columnBacked(prop) || tableBacked(prop)) return refuseNested(domain, `${key}.${String(prop)}`); return Reflect.defineProperty(t, prop, desc); },
        setPrototypeOf() { return refuseNested(domain, key); },
      }));
      splitGuards.set(value, g);
    }
    return g;
  };

  const recordView = (target, domain) => {
    const migrated = domain === 'players' ? PLAYER_MIGRATED_KEYS : GUARDIAN_MIGRATED_KEYS;
    const composites = domain === 'players' ? PLAYER_COMPOSITES : GUARDIAN_COMPOSITES;
    const protectedKey = (key) => migrated.has(key) || (domain === 'guardians' && key === 'childIds') || (domain === 'players' && (isSubKey(key) || isDerivedKey(key))) || RESERVED_KEYS.includes(key);
    const hidden = (t, key) => domain === 'players' && hiddenDerived(t, key);
    return markView(new Proxy(target, {
      // The derived key of a record that never had it: hidden while no report names the player (the record's shape), shown — enumerable — once one does. The target property is configurable, so the view may report both.
      has(t, key) { return !hidden(t, key) && Reflect.has(t, key); },
      ownKeys(t) { const keys = Reflect.ownKeys(t); return domain === 'players' ? keys.filter((k) => !hidden(t, k)) : keys; },
      getOwnPropertyDescriptor(t, key) {
        const d = Reflect.getOwnPropertyDescriptor(t, key);
        if (!d || domain !== 'players' || !isDerivedKey(key)) return d;
        if (hidden(t, key)) return undefined;
        return d.enumerable ? d : { ...d, enumerable: true };
      },
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver);
        if (domain === 'guardians' && key === 'childIds') return Array.isArray(value) ? readonlyView(value, 'a guardian\'s childIds (use link / unlink / ageUp)') : value;
        // S5: the arrays (rows of the child tables) and the derived trial reports are served read-only, items included.
        if (domain === 'players' && isSubKey(key)) return readonlyView(value, SUB_LABEL(key));
        if (domain === 'players' && isDerivedKey(key)) return readonlyView(value, `a player's ${key} (derived from the trials collection; written nowhere)`);
        if (typeof key === 'string' && hasOwn(composites, key)) {
          return domain === 'players' && PLAYER_SPLIT_COMPOSITES.includes(key) ? splitGuard(value, domain, key, composites[key]) : guard(value, domain, key);
        }
        return value;
      },
      set(t, key, value) { if (protectedKey(key)) return refuse(`a ${domain} record (field "${String(key)}")`); setOwn(t, key, value); return true; },
      deleteProperty(t, key) { if (protectedKey(key)) return refuse(`a ${domain} record (field "${String(key)}")`); delete t[key]; return true; },
      defineProperty(t, key, desc) { if (protectedKey(key)) return refuse(`a ${domain} record (field "${String(key)}")`); return Reflect.defineProperty(t, key, desc); },
      setPrototypeOf() { return refuse(`a ${domain} record`); },
    }));
  };
  const collectionView = (domain) => markView(new Proxy(domain.proxies, {
    set(_t, key) { return refuse(`the ${domain.name} collection (index "${String(key)}")`); },
    deleteProperty(_t, key) { return refuse(`the ${domain.name} collection (index "${String(key)}")`); },
    defineProperty(_t, key) { return refuse(`the ${domain.name} collection (index "${String(key)}")`); },
  }));
  const playersView = collectionView(P);
  const guardiansView = collectionView(G);

  /** The empty-state shape of `trialReports` on a plain record (data, not the accessor): `absent`, `null` or `array`. */
  const shapeOf = (rec) => (!hasOwn(rec, 'trialReports') ? 'absent' : rec.trialReports === null ? 'null' : 'array');
  const trialShape = new Map(); // player id → the shape the record keeps while no report names it (repository state: captured and restored with the unit of work)
  // Players render in the S5 layout: the arrays are rows, the facets keep unknown
  // fields and shape metadata only. `trialReports` renders as its SHAPE (absent /
  // null / []), never as content: the row records where the key was and whether
  // it was null; the reports live on the trials. `shape` overrides the record's
  // (a restore adopting the restored record's shape).
  const toRowOf = (domain, rec, { shape = null } = {}) => {
    if (domain !== P) return guardianToRow(rec);
    const s = shape ?? trialShape.get(rec.id) ?? shapeOf(rec);
    const forRow = { ...rec }; // a non-enumerable accessor (the absent shape) is not copied; an enumerable one is replaced below
    if (s === 'absent') delete forRow.trialReports; else forRow.trialReports = s === 'null' ? null : [];
    return playerToRow(forRow, { subrecords: 'tables' });
  };
  /**
   * `trialReports` on an in-memory player record is an ACCESSOR over the trials
   * collection (S5 decision 5; review of 132eda2, finding 2), installed on EVERY
   * record so a report filed later is visible at once on every held view, spread
   * and serialisation — whatever shape the record had. The empty-state shape is
   * kept: an array stays an enumerable array (empty or not); a null reads null
   * until a report names the player, then the list; an absent key stays hidden
   * — a non-enumerable accessor the record view hides entirely — until a report
   * exists, then shows the list. The row written for the record carries the
   * shape (toRowOf), so a reopen restores it; the same decoder rule puts the
   * reports back where the record had the key or appends them.
   */
  const deriveTrialReports = (rec, shape = shapeOf(rec)) => {
    trialShape.set(rec.id, shape);
    const id = rec.id;
    Object.defineProperty(rec, 'trialReports', {
      get() { const d = derivedTrialReports(id); return shape === 'array' || d.length ? d : shape === 'null' ? null : undefined; },
      enumerable: shape !== 'absent', configurable: true,
    });
    return rec;
  };
  /** A derived key the record never had while no report names the player: hidden from the view (not `in`, not enumerable, no descriptor). */
  const hiddenDerived = (t, key) => isDerivedKey(key) && trialShape.get(t.id) === 'absent' && Reflect.get(t, key) === undefined;
  /** Row written by this operation: committed when autocommit, pending while a unit of work is open. */
  const noteRow = (domain, id, facetsJson) => { if (inUnit()) domain.pending.set(id, facetsJson); else { domain.committed.set(id, facetsJson); domain.pending.delete(id); } };
  const remember = (domain, rec, facetsJson) => {
    domain.records.push(rec); domain.byId.set(rec.id, rec);
    noteRow(domain, rec.id, facetsJson);
    const view = recordView(rec, domain.name); domain.proxies.push(view); return view;
  };
  const forget = (domain, rec) => {
    const i = domain.records.indexOf(rec);
    if (i >= 0) { domain.records.splice(i, 1); domain.proxies.splice(i, 1); }
    domain.byId.delete(rec.id); domain.committed.delete(rec.id); domain.pending.delete(rec.id);
    if (domain === P) trialShape.delete(rec.id);
  };
  const viewOf = (domain, rec) => domain.proxies[domain.records.indexOf(rec)] ?? null;
  const clear = (domain) => { domain.records.length = 0; domain.proxies.length = 0; domain.byId.clear(); domain.committed.clear(); domain.pending.clear(); if (domain === P) trialShape.clear(); };

  /** Read everything from the tables: guardians with their childIds from the link rows (rowid order), then players with their arrays from the child tables (position order). */
  const load = () => {
    clear(P); clear(G);
    const links = new Map();
    for (const l of stmt.allLinks.all()) { if (!links.has(l.guardian_id)) links.set(l.guardian_id, []); links.get(l.guardian_id).push(l.player_id); }
    for (const r of stmt.allGuardians.all()) remember(G, guardianFromRow(r, links.get(r.id) ?? []), r.facets_json);
    const children = readAllChildren(stmt.sub);
    // Decoded with an EMPTY derived list so the data value is exactly the record's empty-state shape (absent / null / []); the accessor then serves the live reports. A row whose shape hides existing child rows is refused by the decoder (INCONSISTENT_ROWS): the boot does not attach to it.
    for (const r of stmt.allPlayers.all()) remember(P, deriveTrialReports(playerFromRow(r, { children: children.get(r.id) ?? emptyChildren(), trialReports: [] })), r.facets_json);
  };
  const readInitState = () => {
    const row = stmt.meta.get(CORE_IDENTITY_INIT_META);
    if (!row) return 'done';
    if (row.value !== 'pending' && row.value !== 'done') throw new Error(`core identity: meta.${CORE_IDENTITY_INIT_META} holds ${JSON.stringify(row.value)}, which is neither "pending" nor "done"`);
    return row.value;
  };

  // ------------------------------------------------------------ write discipline
  const requireAutocommit = (what) => {
    if (sqlite.isTransaction && !inUnit()) throw new Error(`${what} writes in a transaction of its own and cannot run inside an open transaction (use the store's unit of work)`);
  };
  /**
   * The ONE transactional boundary of every write operation (review of e4a7c53,
   * findings 1 and 2). An operation is two halves: `sql`, the statements, and
   * `apply`, the memory bookkeeping (records, link arrays, indexes, views,
   * facet tracking), which never throws. Outside a unit of work the statements
   * run in a transaction of their own and `apply` runs only once COMMIT has
   * returned: a failure anywhere — a statement, a trigger, COMMIT itself —
   * leaves memory exactly as it was, held references included. Inside a unit
   * both halves run through `unit.join`, so a failure after the first statement
   * poisons the unit even when the operation's caller catches the error (the
   * unit cannot commit the fragment; its rollback restores memory through the
   * save hook's `restoreState`). No nested BEGIN, no savepoint.
   */
  const atomically = (sql, apply) => {
    if (inUnit()) return unit.join(() => { sql(); return apply(); });
    transaction(sqlite, sql);
    return apply();
  };
  const childIdsOf = (g) => (Array.isArray(g.childIds) ? g.childIds : null);
  const ensureChildIds = (g) => { if (!Array.isArray(g.childIds)) setOwn(g, 'childIds', []); return g.childIds; };
  const emailKey = (email) => String(email).toLowerCase();
  const emailTakenBy = (email, exceptId = null) => { const k = emailKey(email); for (const g of G.records) if (g.id !== exceptId && emailKey(g.email) === k) return g.id; return null; };

  /** Merge a patch into a record IN PLACE (held references to the record and to split composites stay valid). */
  const applyPatch = (rec, patch, { split = [] } = {}) => {
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if (v === undefined) continue;
      if (split.includes(key) && isPlainObject(v) && isPlainObject(rec[key])) { for (const sub of Object.keys(v)) setOwn(rec[key], sub, clone(v[sub])); continue; }
      setOwn(rec, key, clone(v));
    }
  };
  /** Replace a record's content IN PLACE (the signing rollback's Object.assign, made whole: removed keys go away). The derived accessor is re-installed with the restored record's shape, never overwritten with data. */
  const replaceContent = (rec, next) => {
    const shape = shapeOf(next);
    for (const key of Object.keys(rec)) if (!hasOwn(next, key)) delete rec[key];
    if (shape === 'absent') delete rec.trialReports; // a non-enumerable accessor is not listed above
    for (const key of Object.keys(next)) setOwn(rec, key, isDerivedKey(key) ? (shape === 'null' ? null : []) : clone(next[key]));
    deriveTrialReports(rec, shape);
  };
  const nextRecord = (rec, patch, { split = [] } = {}) => {
    const next = clone(rec);
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if (v === undefined) continue;
      if (split.includes(key) && isPlainObject(v) && isPlainObject(next[key])) { for (const sub of Object.keys(v)) setOwn(next[key], sub, clone(v[sub])); continue; }
      setOwn(next, key, clone(v));
    }
    return next;
  };

  // ------------------------------------------------------------ sub-record helpers (S5)
  const checkSubKey = (key) => { if (!SUBRECORD_KEYS.includes(key)) throw new TypeError(`"${key}" is not a player sub-record; the keys are ${SUBRECORD_KEYS.join(', ')}`); };
  /** The record and its current array for `key` (undefined when absent, null when null); refuses a missing player, an unknown key or a split composite that is not an object. */
  const subTarget = (id, key) => {
    checkSubKey(key);
    const rec = P.byId.get(id);
    if (!rec) throw new Error(`player ${id} does not exist`);
    if (key.includes('.')) {
      const [k] = key.split('.');
      if (!isPlainObject(rec[k])) throw new Error(`player ${id}: ${k} is ${rec[k] === null ? 'null' : rec[k] === undefined ? 'absent' : typeof rec[k]}, so ${key} cannot be written (set ${k} first with players.update)`);
    }
    const current = getSubrecords(rec, key);
    if (current !== undefined && current !== null && !Array.isArray(current)) throw new Error(`player ${id}: ${key} is not an array in memory`);
    return { rec, current };
  };
  /** The array object for `key` on the record, created in place when absent or null (the key appears where a new key appears: at the end, recorded by the facets' shape metadata). */
  const ensureSubArray = (rec, key) => {
    if (!key.includes('.')) { if (!Array.isArray(rec[key])) setOwn(rec, key, []); return rec[key]; }
    const [k, sub] = key.split('.');
    if (!Array.isArray(rec[k][sub])) setOwn(rec[k], sub, []);
    return rec[k][sub];
  };
  /** The facets_json the record will have once `key` holds `items`, or null when it does not change (the key already existed as an array). */
  const facetsAfter = (rec, key, items) => {
    const next = clone(rec);
    if (!key.includes('.')) setOwn(next, key, items);
    else { const [k, sub] = key.split('.'); setOwn(next[k], sub, items); }
    const after = toRowOf(P, next).facets_json;
    return after === toRowOf(P, rec).facets_json ? null : after;
  };

  // ------------------------------------------------------------ link operations (both sides, one transaction)
  function link(guardianId, playerId, role = 'co') {
    requireAutocommit('link');
    if (role !== 'primary' && role !== 'co') throw new TypeError(`a link role is "primary" or "co", not ${JSON.stringify(role)}`);
    const g = G.byId.get(guardianId); const p = P.byId.get(playerId);
    if (!g) throw new Error(`guardian ${guardianId} does not exist`);
    if (!p) throw new Error(`player ${playerId} does not exist`);
    if ((childIdsOf(g) ?? []).includes(playerId)) throw new Error(`guardian ${guardianId} already lists player ${playerId}`);
    if (role === 'primary' && present(p.guardianId)) throw new Error(`player ${playerId} already has a primary guardian (${p.guardianId}); a second primary is refused — unlink or ageUp first`);
    const row = role === 'primary' ? toRowOf(P, nextRecord(p, { guardianId })) : null;
    atomically(() => {
      stmt.insertLink.run(guardianId, playerId, role);
      if (row) stmt.setPlayerGuardian.run({ id: playerId, guardian_id: guardianId, facets_json: row.facets_json });
    }, () => {
      ensureChildIds(g).push(playerId);
      if (row) { setOwn(p, 'guardianId', guardianId); noteRow(P, p.id, row.facets_json); }
    });
    return { guardianId, playerId, role };
  }
  function unlink(guardianId, playerId) {
    requireAutocommit('unlink');
    const g = G.byId.get(guardianId); const p = P.byId.get(playerId);
    if (!g) throw new Error(`guardian ${guardianId} does not exist`);
    if (!p) throw new Error(`player ${playerId} does not exist`);
    const ids = childIdsOf(g) ?? [];
    if (!ids.includes(playerId)) throw new Error(`guardian ${guardianId} does not list player ${playerId}`);
    const wasPrimary = p.guardianId === guardianId;
    const row = wasPrimary ? toRowOf(P, nextRecord(p, { guardianId: null })) : null;
    atomically(() => {
      if (stmt.deleteLink.run(guardianId, playerId).changes !== 1) throw new Error(`the link ${guardianId}/${playerId} is not in the table although the view lists it`);
      if (row) stmt.setPlayerGuardian.run({ id: playerId, guardian_id: null, facets_json: row.facets_json });
    }, () => {
      ids.splice(ids.indexOf(playerId), 1);
      if (row) { setOwn(p, 'guardianId', null); noteRow(P, p.id, row.facets_json); }
    });
    return { guardianId, playerId, role: wasPrimary ? 'primary' : 'co' };
  }

  // ------------------------------------------------------------ players
  const players = {
    view: playersView,
    byId: (id) => (id && P.byId.has(id) ? viewOf(P, P.byId.get(id)) : null),
    /** Players whose PRIMARY guardian is this guardian (players.guardian_id). */
    byGuardian: (guardianId) => P.records.filter((p) => p.guardianId === guardianId).map((p) => viewOf(P, p)),
    count: () => P.records.length,
    uncommitted: () => P.records.filter((rec) => toRowOf(P, rec).facets_json !== P.committed.get(rec.id)).length,

    /**
     * Create a player. A record with `guardianId` is created together with its
     * primary link in the same transaction; a MINOR (not adult on `now`) without
     * `guardianId` is refused: a child cannot exist without its primary guardian.
     * (The migration's rule for LEGACY minors is a different, settled question.)
     */
    insert(fields) {
      requireAutocommit('players.insert');
      const rec = clone(fields);
      const v = validatePlayerRecord(rec);
      if (!v.ok) throw new TypeError(`a player record was refused: ${v.problems.join('; ')}`);
      if (P.byId.has(rec.id)) throw new Error(`player ${rec.id} already exists`);
      // A trialReports array given with the record is a claim about the trials (review of 132eda2, finding 1): equal or refused, never dropped.
      const claim = reconcileTrialReportCopy(rec.id, rec.trialReports, derivedTrialReports(rec.id), { hint: 'the record is not created' });
      if (claim.length) throw new TypeError(`a player record was refused: ${claim.join('; ')}`);
      const guardian = present(rec.guardianId) ? G.byId.get(rec.guardianId) : null;
      if (present(rec.guardianId) && !guardian) throw new Error(`player ${rec.id} names guardian ${rec.guardianId}, which does not exist`);
      if (!present(rec.guardianId) && !isAdult(rec, new Date(now()))) throw new Error(`player ${rec.id} is a minor and has no guardianId: a child is created with its primary guardian and the link in the same transaction, never without`);
      if (guardian && (childIdsOf(guardian) ?? []).includes(rec.id)) throw new Error(`guardian ${guardian.id} already lists player ${rec.id}`);
      const row = toRowOf(P, rec);
      return atomically(() => {
        stmt.insertPlayer.run(row);
        writeChildRows(stmt.sub, rec); // S5: the record's arrays, as rows, in the same transaction
        if (guardian) stmt.insertLink.run(guardian.id, rec.id, 'primary');
      }, () => {
        if (guardian) ensureChildIds(guardian).push(rec.id);
        return remember(P, deriveTrialReports(rec), row.facets_json);
      });
    },

    /**
     * Change column-backed fields. Composites `location`, `stats` and
     * `notificationPrefs` are replaced whole (as today's writers do); the split
     * composites `medical` and `programme` are merged sub-key by sub-key and only
     * their column-backed sub-keys may appear (`records`/`completed` are rows,
     * written through addItem / setItems / patchItem); a whole-null `medical` or
     * `programme` is refused while its rows exist (review of 132eda2, finding 3).
     * `guardianId` changes only through link/unlink/ageUp.
     */
    update(id, patch) {
      requireAutocommit('players.update');
      const rec = P.byId.get(id);
      if (!rec) throw new Error(`player ${id} does not exist`);
      if (!isPlainObject(patch)) throw new TypeError('players.update needs a patch object');
      if (hasOwn(patch, 'id') && patch.id !== id) throw new TypeError('a player id never changes');
      if (hasOwn(patch, 'guardianId')) throw new TypeError('guardianId changes only through link / unlink / ageUp (both sides of the relationship are written together)');
      for (const key of Object.keys(patch)) {
        if (key === 'id' || patch[key] === undefined) continue;
        if (isSubKey(key)) throw new TypeError(`"${key}" is a player sub-record (rows of ${SUBRECORD_SPECS[key].table}); players.update does not change it — use players.addItem / setItems / patchItem`);
        if (isDerivedKey(key)) throw new TypeError(`"${key}" is derived from the trials collection and is written nowhere`);
        if (!PLAYER_MIGRATED_KEYS.has(key)) throw new TypeError(`"${key}" is not a column-backed player field; write it on the record (it is kept in the facets)`);
        if (PLAYER_SPLIT_COMPOSITES.includes(key) && isPlainObject(patch[key])) {
          for (const sub of Object.keys(patch[key])) {
            if ((PLAYER_COMPOSITE_SUBRECORDS[key] ?? []).includes(sub)) throw new TypeError(`"${key}.${sub}" is a player sub-record (rows of ${SUBRECORD_SPECS[`${key}.${sub}`].table}); players.update does not change it — use players.addItem / setItems / patchItem`);
            if (!hasOwn(PLAYER_COMPOSITES[key], sub)) throw new TypeError(`"${key}.${sub}" is a facet (mutate it on the record); players.update changes only ${Object.keys(PLAYER_COMPOSITES[key]).join('/')}`);
          }
        }
        // A whole-null split composite while its child rows exist would hide them from every view, export and rollback (review of 132eda2, finding 3): refused; clearing the rows is an explicit, separate operation.
        if (PLAYER_SPLIT_COMPOSITES.includes(key) && patch[key] === null) {
          for (const sub of PLAYER_COMPOSITE_SUBRECORDS[key] ?? []) {
            const rows = getSubrecords(rec, `${key}.${sub}`);
            if (Array.isArray(rows) && rows.length) throw new TypeError(`players.update: ${key} of player ${id} cannot be set to null while ${rows.length} ${key}.${sub} row(s) exist in ${SUBRECORD_SPECS[`${key}.${sub}`].table}; a whole-null ${key} would hide them — clear them first with players.setItems(id, '${key}.${sub}', []) (an explicit operation; no deletion policy is implied), then set ${key} to null`);
          }
        }
      }
      const next = nextRecord(rec, patch, { split: PLAYER_SPLIT_COMPOSITES });
      const v = validatePlayerRecord(next);
      if (!v.ok) throw new TypeError(`a player update was refused: ${v.problems.join('; ')}`);
      const row = toRowOf(P, next);
      atomically(() => stmt.updatePlayer.run(row), () => { applyPatch(rec, patch, { split: PLAYER_SPLIT_COMPOSITES }); noteRow(P, id, row.facets_json); });
      return viewOf(P, rec);
    },

    /** The signing rollback's whole-record write: the record's content is replaced in place, its arrays rewritten as rows (S5); the guardian link cannot change here. */
    restore(id, record) {
      requireAutocommit('players.restore');
      const rec = P.byId.get(id);
      if (!rec) throw new Error(`player ${id} does not exist`);
      const next = clone(record);
      if (!isPlainObject(next) || next.id !== id) throw new TypeError('players.restore needs the record of the same player');
      if ((next.guardianId ?? null) !== (rec.guardianId ?? null)) throw new TypeError('players.restore cannot change the guardian link; use link / unlink / ageUp');
      const v = validatePlayerRecord(next);
      if (!v.ok) throw new TypeError(`a player restore was refused: ${v.problems.join('; ')}`);
      // A trialReports array on the restored record is a claim about the trials (review of 132eda2, finding 1): equal or refused; an absent key or a null adopts that shape and the trials stand.
      const claim = reconcileTrialReportCopy(id, next.trialReports, derivedTrialReports(id), { hint: 'the restore is refused' });
      if (claim.length) throw new TypeError(`a player restore was refused: ${claim.join('; ')}`);
      const row = toRowOf(P, next, { shape: shapeOf(next) });
      atomically(() => { stmt.updatePlayer.run(row); deleteChildRows(stmt.sub, id); writeChildRows(stmt.sub, next); }, () => { replaceContent(rec, next); noteRow(P, id, row.facets_json); });
      return viewOf(P, rec);
    },

    // ------------------------------------------------------------ sub-records (S5): the one write path of the arrays
    /**
     * Append one item to a player's `key` array (`media`, `attendance`, …,
     * `medical.records`, `programme.completed`): validated as part of the whole
     * array (types, required fields, the natural key the code enforces), one row
     * inserted at the next position (and the clip's tag rows), the record's
     * shape metadata rewritten when the key appears for the first time — in one
     * transaction, memory updated in place once it committed. Returns the
     * read-only array.
     */
    addItem(id, key, item) {
      requireAutocommit('players.addItem');
      const { rec, current } = subTarget(id, key);
      const items = [...(current ?? []), clone(item)];
      const problems = validateSubrecordArray(key, items);
      if (problems.length) throw new TypeError(`adding to ${key} of player ${id} was refused: ${problems.join('; ')}`);
      const position = items.length - 1;
      const { row, tags } = itemRows(key, items[position], position, id);
      const facets = facetsAfter(rec, key, items);
      atomically(() => {
        stmt.sub[key].insert.run(row);
        if (tags) for (const t of tags) stmt.sub.tags.insert.run(t);
        if (facets) stmt.playerFacets.run({ id, facets_json: facets });
      }, () => {
        ensureSubArray(rec, key).push(items[position]);
        if (facets) noteRow(P, id, facets);
      });
      return readonlyView(getSubrecords(rec, key), SUB_LABEL(key));
    },

    /** Replace a player's whole `key` array (the client-set badge list, the sorted season history, the programme reset): every row of it rewritten. */
    setItems(id, key, items) {
      requireAutocommit('players.setItems');
      const { rec } = subTarget(id, key);
      if (!Array.isArray(items)) throw new TypeError(`players.setItems needs an array for ${key} (got ${items === null ? 'null' : typeof items})`);
      const next = clone(items);
      const problems = validateSubrecordArray(key, next);
      if (problems.length) throw new TypeError(`replacing ${key} of player ${id} was refused: ${problems.join('; ')}`);
      const facets = facetsAfter(rec, key, next);
      atomically(() => {
        stmt.sub[key].deleteAll.run(id); // the clips' tag rows cascade with the clips
        writeArrayRows(stmt.sub, key, id, next);
        if (facets) stmt.playerFacets.run({ id, facets_json: facets });
      }, () => {
        const arr = ensureSubArray(rec, key);
        arr.length = 0; for (const it of next) arr.push(it);
        if (facets) noteRow(P, id, facets);
      });
      return readonlyView(getSubrecords(rec, key), SUB_LABEL(key));
    },

    /**
     * Change fields of ONE item of a player's `key` array, found by `where` (an
     * object of equality tests: `{ id }` for a clip, `{ season }` for a season
     * row); exactly one item must match. `patch` merges key by key (undefined
     * leaves a key alone; nested values are replaced whole). The row is updated
     * in place (a clip's tags rewritten when they change). Returns the item.
     */
    patchItem(id, key, where, patch) {
      requireAutocommit('players.patchItem');
      const { rec, current } = subTarget(id, key);
      if (SUBRECORD_SPECS[key].primitive) throw new TypeError(`${key} holds plain values; replace the array with players.setItems`);
      if (!isPlainObject(where) || !Object.keys(where).length) throw new TypeError('players.patchItem needs a where object ({ id } or another equality test)');
      if (!isPlainObject(patch)) throw new TypeError('players.patchItem needs a patch object');
      const list = Array.isArray(current) ? current : [];
      const matches = list.map((it, i) => i).filter((i) => isPlainObject(list[i]) && Object.keys(where).every((k) => list[i][k] === where[k]));
      if (matches.length !== 1) throw new Error(`players.patchItem: ${matches.length} item(s) of ${key} of player ${id} match ${JSON.stringify(where)}; exactly one must`);
      const index = matches[0];
      const merged = clone(list[index]);
      for (const k of Object.keys(patch)) if (patch[k] !== undefined) setOwn(merged, k, clone(patch[k]));
      const items = list.map((it, i) => (i === index ? merged : it));
      const problems = validateSubrecordArray(key, items);
      if (problems.length) throw new TypeError(`changing ${key} of player ${id} was refused: ${problems.join('; ')}`);
      const { row, tags } = itemRows(key, merged, index, id);
      const tagsChanged = SUBRECORD_SPECS[key].children === 'tags' && hasOwn(patch, 'tags');
      atomically(() => {
        if (stmt.sub[key].update.run(row).changes !== 1) throw new Error(`players.patchItem: the ${key} row of player ${id} at position ${index} is not in the table although the view lists it`);
        if (tagsChanged) { stmt.sub.tags.deleteMedia.run(merged.id); for (const t of tags ?? []) stmt.sub.tags.insert.run(t); }
      }, () => {
        const target = list[index];
        for (const k of Object.keys(patch)) if (patch[k] !== undefined) setOwn(target, k, clone(patch[k]));
      });
      return readonlyView(list[index], SUB_LABEL(key));
    },

    /** Rows per child table (counts only), for reports. */
    subrecordRows: () => countChildRows(stmt.sub),

    /** Aging-up as today: the PRIMARY link goes and `guardianId` becomes null, in one transaction; co-guardians keep listing the player (today's behaviour, recorded as a gap). */
    ageUp(id) {
      requireAutocommit('players.ageUp');
      const p = P.byId.get(id);
      if (!p) throw new Error(`player ${id} does not exist`);
      if (!present(p.guardianId)) throw new Error(`player ${id} has no primary guardian; nothing to age up`);
      const guardianId = p.guardianId;
      unlink(guardianId, id);
      return { playerId: id, guardianId };
    },

    /** Today's hard delete of a player row (links cascade; every guardian stops listing the id). Not an erasure or retention policy: O1 is open. */
    remove(id) {
      requireAutocommit('players.remove');
      const p = P.byId.get(id);
      if (!p) throw new Error(`player ${id} does not exist`);
      return atomically(() => {
        if (stmt.deletePlayer.run(id).changes !== 1) throw new Error(`player ${id} is not in the table although the view lists it`);
      }, () => {
        for (const g of G.records) { const ids = childIdsOf(g); if (ids) { const i = ids.indexOf(id); if (i >= 0) ids.splice(i, 1); } }
        forget(P, p);
        return true;
      });
    },

    link: (guardianId, playerId, role) => link(guardianId, playerId, role),
    unlink,
  };

  // ------------------------------------------------------------ guardians
  const guardians = {
    view: guardiansView,
    byId: (id) => (id && G.byId.has(id) ? viewOf(G, G.byId.get(id)) : null),
    /** Case-insensitive, like the signup's uniqueness check (login compares case-sensitively today; the repository is the one rule). */
    byEmail: (email) => { const id = typeof email === 'string' ? emailTakenBy(email) : null; return id ? viewOf(G, G.byId.get(id)) : null; },
    emailTaken: (email, exceptId = null) => emailTakenBy(email, exceptId) !== null,
    /** The guardians listing this player, with their role. */
    linksOf: (playerId) => G.records.filter((g) => (childIdsOf(g) ?? []).includes(playerId)).map((g) => ({ guardianId: g.id, role: P.byId.get(playerId)?.guardianId === g.id ? 'primary' : 'co' })),
    childIds: (id) => (childIdsOf(G.byId.get(id) ?? {}) ?? []).slice(),
    count: () => G.records.length,
    uncommitted: () => G.records.filter((rec) => guardianToRow(rec).facets_json !== G.committed.get(rec.id)).length,

    /**
     * Create a guardian. `childIds` given here become link rows in the same
     * transaction (`co` links: a guardian created now cannot already be a child's
     * primary — the co-guardian route copies the primary's list); the e-mail must
     * be unique case-insensitively and `coGuardianOf` must name an existing guardian.
     */
    insert(fields) {
      requireAutocommit('guardians.insert');
      const rec = clone(fields);
      const v = validateGuardianRecord(rec);
      if (!v.ok) throw new TypeError(`a guardian record was refused: ${v.problems.join('; ')}`);
      if (G.byId.has(rec.id)) throw new Error(`guardian ${rec.id} already exists`);
      const taken = emailTakenBy(rec.email);
      if (taken) throw new Error(`EMAIL_IN_USE: another guardian (${taken}) already uses this e-mail (compared case-insensitively)`);
      if (present(rec.coGuardianOf)) { if (rec.coGuardianOf === rec.id) throw new Error('coGuardianOf cannot name the guardian itself'); if (!G.byId.has(rec.coGuardianOf)) throw new Error(`coGuardianOf names guardian ${rec.coGuardianOf}, which does not exist`); }
      const kids = childIdsOf(rec) ?? [];
      const seen = new Set();
      for (const childId of kids) {
        if (seen.has(childId)) throw new Error(`childIds lists ${childId} more than once`);
        seen.add(childId);
        if (!P.byId.has(childId)) throw new Error(`childIds names player ${childId}, which does not exist`);
      }
      const row = guardianToRow(rec);
      return atomically(() => {
        stmt.insertGuardian.run(row);
        for (const childId of kids) stmt.insertLink.run(rec.id, childId, P.byId.get(childId).guardianId === rec.id ? 'primary' : 'co');
      }, () => remember(G, rec, row.facets_json));
    },

    /** Change column-backed fields (`childIds` only through link/unlink/ageUp; `notificationPrefs` replaced whole). */
    update(id, patch) {
      requireAutocommit('guardians.update');
      const rec = G.byId.get(id);
      if (!rec) throw new Error(`guardian ${id} does not exist`);
      if (!isPlainObject(patch)) throw new TypeError('guardians.update needs a patch object');
      if (hasOwn(patch, 'id') && patch.id !== id) throw new TypeError('a guardian id never changes');
      if (hasOwn(patch, 'childIds')) throw new TypeError('childIds changes only through link / unlink / ageUp');
      for (const key of Object.keys(patch)) {
        if (key === 'id' || patch[key] === undefined) continue;
        if (!GUARDIAN_MIGRATED_KEYS.has(key)) throw new TypeError(`"${key}" is not a column-backed guardian field; write it on the record (it is kept in the facets)`);
      }
      const next = nextRecord(rec, patch);
      const v = validateGuardianRecord(next);
      if (!v.ok) throw new TypeError(`a guardian update was refused: ${v.problems.join('; ')}`);
      if (hasOwn(patch, 'email')) { const taken = emailTakenBy(next.email, id); if (taken) throw new Error(`EMAIL_IN_USE: another guardian (${taken}) already uses this e-mail (compared case-insensitively)`); }
      if (hasOwn(patch, 'coGuardianOf') && present(next.coGuardianOf)) { if (next.coGuardianOf === id) throw new Error('coGuardianOf cannot name the guardian itself'); if (!G.byId.has(next.coGuardianOf)) throw new Error(`coGuardianOf names guardian ${next.coGuardianOf}, which does not exist`); }
      const row = guardianToRow(next);
      atomically(() => stmt.updateGuardian.run(row), () => { applyPatch(rec, patch); noteRow(G, id, row.facets_json); });
      return viewOf(G, rec);
    },

    link,
    unlink,
  };

  // ------------------------------------------------------------ save hook (both domains, one participant)
  const flushDomain = (domain, facetsStmt) => {
    let changed = 0;
    for (const rec of domain.records) {
      const row = toRowOf(domain, rec);
      // Compare with what the transaction already wrote (an insert/update inside a unit), else with the committed value (review correction 3 of the foundation).
      const stored = domain.pending.has(rec.id) ? domain.pending.get(rec.id) : domain.committed.get(rec.id);
      if (row.facets_json === stored) continue;
      facetsStmt.run({ id: rec.id, facets_json: row.facets_json });
      domain.pending.set(rec.id, row.facets_json);
      changed += 1;
    }
    return changed;
  };
  const hook = {
    flush() {
      if (!sqlite.isTransaction) throw new Error('identity.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      return flushDomain(G, stmt.guardianFacets) + flushDomain(P, stmt.playerFacets);
    },
    commit() { for (const d of [P, G]) { for (const [id, json] of d.pending) d.committed.set(id, json); d.pending.clear(); } },
    rollback() { P.pending.clear(); G.pending.clear(); },
    snapshotState: () => ({
      graph: captureGraph([P.records, G.records]),
      P: { proxies: P.proxies.slice(), byId: new Map(P.byId), committed: new Map(P.committed), pending: new Map(P.pending) },
      G: { proxies: G.proxies.slice(), byId: new Map(G.byId), committed: new Map(G.committed), pending: new Map(G.pending) },
      shapes: new Map(trialShape),
    }),
    restoreState(state) {
      if (!state) return;
      restoreGraph(state.graph); // data properties only: the derived accessors are not data the memento owns
      for (const [d, s] of [[P, state.P], [G, state.G]]) {
        d.proxies.length = 0; for (const p of s.proxies) d.proxies.push(p);
        d.byId.clear(); for (const [id, rec] of s.byId) d.byId.set(id, rec);
        d.committed.clear(); for (const [id, json] of s.committed) d.committed.set(id, json);
        d.pending.clear(); for (const [id, json] of s.pending) d.pending.set(id, json);
      }
      // The empty-state shapes go back with the records (a restore inside the failed unit may have adopted another); the accessor is re-installed with the captured shape.
      trialShape.clear(); for (const [id, shape] of state.shapes ?? []) trialShape.set(id, shape);
      for (const rec of P.records) if (trialShape.has(rec.id)) deriveTrialReports(rec, trialShape.get(rec.id));
    },
  };

  // ------------------------------------------------------------ boot
  const identity = {
    players,
    guardians,
    link,
    unlink,
    initState: () => readInitState(),
    cutOver: () => migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION),

    /**
     * Boot on a database that is past initialisation: load the tables and nothing
     * else. Whatever arrays the caller holds (the seed, a superseded blob copy)
     * are never imported; records they name that the tables do not hold are
     * reported as ignored.
     */
    attach(givenPlayers = null, givenGuardians = null) {
      if (readInitState() === 'pending') throw new Error(`core identity: initialisation is pending (meta.${CORE_IDENTITY_INIT_META}); call initialize() with the first installation's records instead of attach()`);
      load();
      for (const [name, given, domain] of [['players', givenPlayers, P], ['guardians', givenGuardians, G]]) {
        if (!Array.isArray(given) || !given.length) continue;
        const unknown = given.filter((r) => isPlainObject(r) && typeof r.id === 'string' && !domain.byId.has(r.id)).length;
        if (unknown) warn(`core identity: the ${name} table holds ${domain.records.length} row(s) and is authoritative; an in-memory array with ${unknown} record(s) the table does not hold was ignored`);
      }
      return { engine: 'sqlite', players: P.records.length, guardians: G.records.length, links: stmt.countLinks.get().n, imported: 0 };
    },

    /**
     * First-installation initialisation: validate the given records with the
     * preflight (the Founder's legacy-minor rule included) and, only when it is
     * `complete`, write every row and link and record `done` in ONE transaction.
     * Refused when the state is not `pending` or the tables already hold rows.
     * A refused snapshot writes nothing (the error lists ids and reasons, never a
     * record) and the state stays `pending`, so the next boot retries.
     *
     * The given snapshot is validated AS GIVEN, by the preflight's own shape
     * contract (review of e4a7c53, finding 3): a collection that is absent,
     * null, an object, a string or a number is a refusal like any other — never
     * read as an empty import — while an explicitly empty array is a valid,
     * empty collection. The caller's object is never modified.
     */
    initialize(given, { now: at = now() } = {}) {
      if (readInitState() !== 'pending') throw new Error(`core identity: already initialised (meta.${CORE_IDENTITY_INIT_META} is "done"); the tables are authoritative and nothing is imported`);
      const stored = stmt.countPlayers.get().n + stmt.countGuardians.get().n + stmt.countLinks.get().n;
      if (stored) throw new Error(`core identity: initialisation is pending but the tables already hold ${stored} row(s) written outside the repositories; refusing to initialise over them`);
      if (sqlite.isTransaction) throw new Error('core identity: initialize() runs in a transaction of its own and cannot start inside an open transaction');
      const report = validateCoreIdentity(given, { now: at });
      if (report.status !== 'complete') {
        const err = new Error(`CORE_IDENTITY_CUTOVER_BLOCKED: ${report.refusals.length} refusal(s); nothing was written and initialisation stays pending — ${report.refusals.slice(0, 20).map((r) => `${r.collection} ${r.id ?? '(collection)'}: ${r.reason}`).join('; ')}${report.legacyMinorsWithoutLink.length ? `; legacy minors without any guardian link (resolve by hand before the cutover): ${report.legacyMinorsWithoutLink.join(', ')}` : ''}`);
        err.code = 'CORE_IDENTITY_CUTOVER_BLOCKED';
        err.report = publicReport(report);
        throw err;
      }
      // The trialReports claims of the first installation's records, judged against the trials the data layer holds (review of 132eda2, finding 1): equal or refused, never dropped.
      const claims = report.candidate.players.flatMap((row) => reconcileTrialReportCopy(row.id, playerFromRow(row).trialReports, derivedTrialReports(row.id), { hint: 'resolve the record before the first installation' }));
      if (claims.length) {
        const err = new Error(`CORE_IDENTITY_CUTOVER_BLOCKED: ${claims.length} trialReports claim(s) disagree with the trials collection; nothing was written and initialisation stays pending — ${claims.slice(0, 20).join('; ')}${claims.length > 20 ? '; …' : ''}`);
        err.code = 'CORE_IDENTITY_CUTOVER_BLOCKED';
        err.report = publicReport(report);
        throw err;
      }
      let counts;
      try {
        counts = transaction(sqlite, () => { const c = writeCandidate(sqlite, report.candidate); stmt.setMeta.run(CORE_IDENTITY_INIT_META, 'done'); return c; });
      } catch (err) {
        throw new Error(`core identity: initialisation failed and was rolled back (${sqlReason(err)}); the state stays pending and the next boot retries`, { cause: err });
      }
      log(`core identity: initialised ${counts.players} player(s), ${counts.guardians} guardian(s) and ${counts.links} link(s) from the in-memory records (first installation)`);
      load();
      return { engine: 'sqlite', ...counts, imported: counts.players + counts.guardians };
    },

    saveHook: () => ({ flush: () => hook.flush(), commit: () => hook.commit(), rollback: () => hook.rollback(), snapshotState: () => hook.snapshotState(), restoreState: (s) => hook.restoreState(s) }),
    report: () => ({ players: P.records.length, guardians: G.records.length, links: stmt.countLinks.get().n, initState: readInitState(), uncommittedFacets: players.uncommitted() + guardians.uncommitted() }),
  };
  return identity;
}
