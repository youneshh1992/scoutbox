/**
 * Players, guardians and the guardian–child link cut over (migration plan step
 * S4a; readiness review §7.1). IMPLEMENTED AND TESTED, NOT REGISTERED: this
 * module is not in `DATA_MIGRATIONS` (repositories/index.mjs) and nothing in
 * server boot reaches it. Tests invoke it explicitly through the real runner on
 * temporary S3-shaped databases (`scripts/testCoreIdentityMigration.mjs`).
 *
 * Runs with foreign keys OFF (the runner switches them off before its one
 * transaction and verifies `PRAGMA foreign_key_check` before committing): the
 * three S1 shadow tables are dropped and recreated with the live definitions.
 * Nothing references them — `sessions` carries `kind`/`ref_id` without a
 * foreign key — so no session, staff row or organisation is touched by any
 * statement here, and every token hash stays exactly as it is.
 *
 * Inside the runner's transaction:
 *   1. Decide what kind of database this is, from explicit state and never
 *      from row counts: a database nothing was ever saved to (no collection
 *      row, no save revision, no `savedAt`) is a GENUINELY NEW installation;
 *      anything else holds a saved snapshot. A saved snapshot must carry BOTH
 *      blobs (`players`, `guardians`) as JSON arrays: an absent, unparsable or
 *      non-array collection is a refusal, never an empty import and never a
 *      first installation. The shadow tables' rows are derived data and are
 *      NEVER read — the blobs are the only input.
 *   2. Validate the snapshot with the reviewed preflight (`validateCoreIdentity`:
 *      every record, every reference, duplicate ids and e-mails, both sides of
 *      every link, the Founder's rule that a legacy minor with no guardian
 *      link at all refuses the whole cutover, age evaluated at this run's
 *      `now`). Any refusal aborts with `CORE_IDENTITY_CUTOVER_BLOCKED` listing
 *      ids and reasons (never a record, an e-mail, a hash or a code); the
 *      runner rolls back, the file is byte-identical, the next boot aborts the
 *      same way until the data is resolved by hand on the current build.
 *   3. Replace the shadow definitions with the live ones (`CANDIDATE_DDL`: the
 *      documented identity DDL plus `facets_json`) and import the candidate
 *      through `writeCandidate` — guardians in two passes, players, one link
 *      row per `childIds` entry with its role; key/null/absent shape, child
 *      order, outstanding `emailCode` values and unknown properties ride in
 *      the rows exactly as the mapping renders them.
 *   4. Record `meta.coreIdentityCutover` (counts and findings, no data),
 *      `meta.coreIdentityInit` (`done` for a saved snapshot — an empty one
 *      included, it stays empty; `pending` only for a genuinely new database,
 *      whose first boot imports the seed once, explicitly) and retire the two
 *      blobs. The runner writes the `data_migrations` row and commits;
 *      completion is decided only by that row.
 *
 * Over an initialised live domain this module refuses to run again: the
 * runner never repeats a recorded step, and a direct call finds the live
 * definition and stops before any statement.
 */
import { validateCoreIdentity, publicReport, writeCandidate, CANDIDATE_DDL, CORE_IDENTITY_LIVE_MIGRATION } from '../identityPreflight.mjs';
import { CORE_IDENTITY_INIT_META } from '../identity.mjs';

export const id = CORE_IDENTITY_LIVE_MIGRATION;
export const note = 'players, guardians and guardian_children become live tables (scalars in columns, other fields in facets_json); the two blobs are retired';
export const foreignKeysOff = true;

/** `meta` key holding the cutover record: counts, findings and the kind of database, never data. */
export const CORE_IDENTITY_CUTOVER_META = 'coreIdentityCutover';
/** The three tables this step replaces, in drop order (children first). */
export const IDENTITY_TABLES = Object.freeze(['guardian_children', 'players', 'guardians']);
export const BLOCKED = 'CORE_IDENTITY_CUTOVER_BLOCKED';

const blocked = (detail, extra = {}) => Object.assign(new Error(`${BLOCKED}: ${detail}`), { code: BLOCKED, ...extra });
const describeValue = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/** Which kind of database this is, from explicit state only (no row count anywhere). */
export function describeDatabase(sqlite) {
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const hasCollections = hasTable('collections');
  const hasMeta = hasTable('meta');
  const metaKey = (k) => (hasMeta ? !!sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(k) : false);
  const collectionRows = hasCollections ? sqlite.prepare('SELECT COUNT(*) AS n FROM collections').get().n : 0;
  // A save writes at least one collection row and `savedAt`; every build since
  // the second S1 correction also writes `saveSeq`. Any of the three means a
  // snapshot was saved here. (Migration 0004's own meta rows do not count.)
  const everSaved = collectionRows > 0 || metaKey('savedAt') || metaKey('saveSeq');
  const live = (t) => hasTable(t) && sqlite.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json');
  return { hasCollections, everSaved, liveAlready: live('players') || live('guardians') };
}

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  const kind = describeDatabase(sqlite);
  if (kind.liveAlready) throw blocked('the players/guardians tables already have the live definition (facets_json); this step runs once and never over an initialised live domain');

  // 1. The input: the two blobs, as saved — or, for a genuinely new database, nothing.
  const readBlob = (name) => {
    if (!kind.hasCollections) return { present: false, value: undefined };
    const row = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name);
    if (!row) return { present: false, value: undefined };
    let value;
    try { value = JSON.parse(row.value); } catch { throw blocked(`the saved ${name} blob is not valid JSON; nothing is inferred, repaired or seeded — resolve the snapshot on the current build first`); }
    return { present: true, value };
  };
  const playersBlob = readBlob('players');
  const guardiansBlob = readBlob('guardians');
  const firstInstallation = !kind.everSaved;
  let input;
  if (firstInstallation) {
    // Nothing was ever saved: there is nothing to import. The live tables start
    // empty and `coreIdentityInit` stays `pending` until the data layer imports
    // the seed once, explicitly (repositories/identity.mjs `initialize`).
    input = { players: [], guardians: [] };
  } else {
    const missing = ['players', 'guardians'].filter((n) => !(n === 'players' ? playersBlob : guardiansBlob).present);
    if (missing.length) throw blocked(`this database holds a saved snapshot but no ${missing.join(' or ')} blob; a saved snapshot always carries both collections, so the missing one is not an empty import — resolve the snapshot on the current build first`);
    for (const [name, blob] of [['players', playersBlob], ['guardians', guardiansBlob]]) {
      if (!Array.isArray(blob.value)) throw blocked(`the saved ${name} blob is ${describeValue(blob.value)}, not an array; it is not read as an empty collection — resolve the snapshot on the current build first`);
    }
    input = { players: playersBlob.value, guardians: guardiansBlob.value };
  }

  // 2. Validate everything first; nothing is written until every record and link passes.
  const report = validateCoreIdentity(input, { now });
  if (report.status !== 'complete') {
    const listed = report.refusals.slice(0, 25).map((r) => `${r.collection} ${r.id ?? '(collection)'}: ${r.reason}`).join('; ');
    const more = report.refusals.length > 25 ? `; … ${report.refusals.length - 25} more` : '';
    const minors = report.legacyMinorsWithoutLink.length ? `; legacy minors without any guardian link (the Founder's decision: resolve by hand before the cutover, nothing is omitted, linked, re-dated or deleted): ${report.legacyMinorsWithoutLink.join(', ')}` : '';
    throw blocked(`${report.refusals.length} refusal(s); the blobs stay authoritative and byte-identical, the next boot retries — ${listed}${more}${minors}`, { report: publicReport(report) });
  }

  // 3. Replace the shadow definitions (their rows are derived and are discarded unread) and import.
  const shadowRowsDiscarded = {};
  for (const t of IDENTITY_TABLES) {
    shadowRowsDiscarded[t] = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) ? sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : null;
    sqlite.exec(`DROP TABLE IF EXISTS ${t};`);
  }
  sqlite.exec(CANDIDATE_DDL);
  const imported = writeCandidate(sqlite, report.candidate);

  // 4. Record (counts only), set the initialisation state explicitly, retire the blobs.
  const meta = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const { counts } = report;
  meta.run(CORE_IDENTITY_CUTOVER_META, JSON.stringify({
    at: now, evaluatedAt: report.evaluatedAt, firstInstallation,
    imported,
    findings: { coLinks: counts.coLinks, primaryLinks: counts.primaryLinks, adultsStillLinked: counts.adultsStillLinked, minorsWithCoLinksOnly: counts.minorsWithCoLinksOnly, coGuardianArrangements: counts.coGuardianArrangements },
    blobs: { players: playersBlob.present, guardians: guardiansBlob.present },
    shadowRowsDiscarded,
  }));
  meta.run(CORE_IDENTITY_INIT_META, firstInstallation ? 'pending' : 'done');
  if (kind.hasCollections) {
    const del = sqlite.prepare('DELETE FROM collections WHERE name = ?');
    del.run('players'); del.run('guardians');
  }
  return { ...imported, firstInstallation };
}
