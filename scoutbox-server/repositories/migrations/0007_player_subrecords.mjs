/**
 * Player sub-records become their own tables (migration plan step S5;
 * docs/architecture/s5-player-subrecords.md §4). REGISTERED in DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0005 (the players table is live):
 *   1. Create the twelve `player_*` tables (SUBRECORDS_DDL).
 *   2. Decode every `players` row through the established decoder
 *      (`playerFromRow`: the current facets layout and the legacy `__rest` one),
 *      validate every item of every array (the same validator the repository
 *      uses) and reconcile every `trialReports` copy with the `trials`
 *      collection (`reconcileTrialReports`: an entry with no trial report, a
 *      content difference, a report the copy lacks, a different order).
 *      ANY refusal aborts the whole step with PLAYER_SUBRECORDS_CUTOVER_BLOCKED
 *      listing player ids, fields, indexes and reasons: the runner rolls back,
 *      the file is byte-identical, the next boot refuses the same way until the
 *      record is resolved by hand on the current build. Nothing is coerced,
 *      deduplicated, dropped or repaired.
 *   3. Write every child row; re-read each player through the S5 read path and
 *      compare it with the decoded record byte for byte (the candidate is
 *      verified BEFORE its source fields are retired); then rewrite
 *      `facets_json` without the arrays and without `trialReports`.
 *   4. Record `meta.playerSubrecordsCutover` (counts only).
 * An empty players table (a first installation, initialised afterwards by the
 * data layer) creates the tables and imports nothing. The step never runs
 * twice (recorded) and refuses to run before 0005.
 */
import { playerFromRow, playerToRow, PLAYER_COLUMNS } from '../identityMapping.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from '../identityPreflight.mjs';
import {
  PLAYER_SUBRECORDS_MIGRATION, SUBRECORDS_DDL, SUBRECORD_TABLES, validateSubrecords, prepareSubrecordStatements, writeChildRows, readChildren,
  trialReportsFor, reconcileTrialReports, readTrialsBlob,
} from '../playerSubrecords.mjs';
import { migrationApplied } from '../database.mjs';

export const id = PLAYER_SUBRECORDS_MIGRATION;
export const note = 'player sub-records (media, attendance, timeline, badges, drills, drill results, activity, external ids, season history, medical records, programme completions) become their own tables; trialReports is served from the trials';
/** `meta` key holding the cutover record: counts, never data. */
export const PLAYER_SUBRECORDS_CUTOVER_META = 'playerSubrecordsCutover';
export const BLOCKED = 'PLAYER_SUBRECORDS_CUTOVER_BLOCKED';

const blocked = (detail, extra = {}) => Object.assign(new Error(`${BLOCKED}: ${detail}`), { code: BLOCKED, ...extra });

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, CORE_IDENTITY_LIVE_MIGRATION)) throw new Error(`${id}: ${CORE_IDENTITY_LIVE_MIGRATION} must be recorded first (the players table must be live)`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = SUBRECORD_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);

  // 1. The tables.
  sqlite.exec(SUBRECORDS_DDL);
  const st = prepareSubrecordStatements(sqlite);

  // 2. Decode, validate, reconcile — everything before anything is written.
  const rows = sqlite.prepare(`SELECT ${PLAYER_COLUMNS.join(', ')} FROM players ORDER BY rowid`).all();
  const trials = readTrialsBlob(sqlite);
  const refusals = []; // { id, reason }
  const decoded = [];
  for (const row of rows) {
    let rec;
    try { rec = playerFromRow(row); } catch (err) { refusals.push({ id: row.id, reason: `facets_json cannot be decoded (${String(err?.message ?? err).slice(0, 120)})` }); continue; }
    for (const p of validateSubrecords(rec)) refusals.push({ id: row.id, reason: p });
    if (Object.hasOwn(rec, 'trialReports') || (trials ?? []).some((t) => t && t.playerId === row.id && t.report)) {
      if (trials === null) refusals.push({ id: row.id, reason: 'the trials collection is not a JSON array, so the trialReports copy cannot be reconciled with its source' });
      else for (const p of reconcileTrialReports(rec.trialReports, trialReportsFor(trials, row.id))) refusals.push({ id: row.id, reason: p });
    }
    decoded.push({ row, rec });
  }
  if (refusals.length) {
    const listed = refusals.slice(0, 25).map((r) => `players ${r.id}: ${r.reason}`).join('; ');
    const more = refusals.length > 25 ? `; … ${refusals.length - 25} more` : '';
    throw blocked(`${refusals.length} refusal(s); the players table and its facets stay as they are, byte-identical, and the next boot retries — ${listed}${more}`, { refusals });
  }

  // 3. Write the rows, verify the re-read record, then retire the source fields.
  const setFacets = sqlite.prepare('UPDATE players SET facets_json = @facets_json WHERE id = @id');
  const perTable = {};
  let trialReportsDropped = 0;
  for (const { row, rec } of decoded) {
    const counts = writeChildRows(st, rec);
    for (const [t, n] of Object.entries(counts)) perTable[t] = (perTable[t] ?? 0) + n;
    // The candidate — the row as it will be once the arrays are retired from
    // its facets, plus the rows just written — read back through the S5 path
    // must be the decoded record exactly (the derived trial reports in the
    // same place) BEFORE the facets are rewritten. (An empty derived list
    // reproduces a null or an absent `trialReports`; a stored copy reproduces
    // itself, having been reconciled above.)
    const expected = JSON.stringify(rec);
    const retired = { ...row, facets_json: playerToRow(rec, { subrecords: 'tables' }).facets_json };
    const reread = playerFromRow(retired, { children: readChildren(st, row.id), trialReports: Array.isArray(rec.trialReports) ? rec.trialReports : [] });
    if (JSON.stringify(reread) !== expected) throw new Error(`${id}: players ${row.id}: the record read back from the sub-record tables differs from the decoded record; nothing is retired (rolled back)`);
    if (Array.isArray(rec.trialReports)) trialReportsDropped += rec.trialReports.length;
    setFacets.run({ id: row.id, facets_json: retired.facets_json });
  }
  perTable.player_media_tags = sqlite.prepare('SELECT COUNT(*) AS n FROM player_media_tags').get().n;

  // 4. The record (counts only).
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PLAYER_SUBRECORDS_CUTOVER_META, JSON.stringify({ at: now, players: rows.length, rows: perTable, trialReportsCopiesDropped: trialReportsDropped, trialsBlobPresent: trials !== null && trials.length > 0 }));
  return { players: rows.length, rows: perTable, trialReportsCopiesDropped: trialReportsDropped };
}
