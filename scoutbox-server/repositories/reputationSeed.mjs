/**
 * The demo reputation track records, shown beside the live rows the ledger gives (domains/recruitment/ledger.mjs).
 * Empty in production: nothing writes them but the import of a first installation's seed, once, while the table is
 * empty. Never fabricate track records.
 */
import {
  isPlainObject,
  describe,
  text,
  int,
  num,
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

export const REPUTATION_SEED_MIGRATION = '0038_operations';
export const REPUTATION_SEED_COLLECTIONS = Object.freeze(['reputationSeed']);
export const REPUTATION_SEED_TABLES = Object.freeze(['reputation_seed']);

const NAME_MAX = 200;
const req = { req: true };
const REPUTATION_SPEC = [
  text('scoutName', 'scout_name', NAME_MAX, { req: true, nonEmpty: true }),
  text('orgName', 'org_name', NAME_MAX, { req: true, nonEmpty: true }),
  int('discoveries', 'discoveries', req),
  int('successRatePct', 'success_rate_pct', req),
  num('avgResaleMultiple', 'avg_resale_multiple', req),
];

export const REPUTATION_SEED_DDL = tableDdl('reputation_seed', REPUTATION_SPEC, [
  'PRIMARY KEY (scout_name, org_name)',
  'CHECK (discoveries >= 0)',
  'CHECK (success_rate_pct BETWEEN 0 AND 100)',
  'CHECK (avg_resale_multiple >= 0)',
]);

export function typeReputation(raw, at = 'reputationSeed') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { seeded: _derived, ...rest } = raw; // always true for these rows; derived on read
  const t = typeSpec(REPUTATION_SPEC, rest, at);
  if (!t.ok) return t;
  const r = t.record;
  if (r.discoveries < 0) return bad(at, 'discoveries', 'must not be negative');
  if (r.successRatePct < 0 || r.successRatePct > 100) return bad(at, 'successRatePct', 'must be from 0 to 100');
  if (r.avgResaleMultiple < 0) return bad(at, 'avgResaleMultiple', 'must not be negative');
  return t;
}

const decodeReputation = (row) => ({ ...decode(REPUTATION_SPEC, row), seeded: true });
const ALL = 'SELECT * FROM reputation_seed ORDER BY rowid';

export const reputationSeedLive = (sqlite) => migrationApplied(sqlite, REPUTATION_SEED_MIGRATION);
/** The rows read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const REPUTATION_SEED_RECORDS = {
  names: REPUTATION_SEED_COLLECTIONS,
  read: (sqlite) =>
    reputationSeedLive(sqlite) ? { reputationSeed: sqlite.prepare(ALL).all().map(decodeReputation) } : null,
};

/** `createReputationSeedRepository({ sqlite, unit, now, log })`: read only, apart from the first installation's import. */
export function createReputationSeedRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the reputation seed repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const { q, refusal } = writeKit(sqlite, 'REPUTATION');

  const reads = Object.freeze({
    all: () =>
      q(ALL)
        .all()
        .map((r) => deepFreeze(decodeReputation(r))),
    count: () => q('SELECT COUNT(*) AS n FROM reputation_seed').get().n,
  });
  /** The first installation's rows, typed; any junk or a repeated scout and club refuses the whole import. */
  const typed = (list) => {
    const label = "the first installation's seed";
    if (!Array.isArray(list))
      throw refusal(
        'IMPORT_BLOCKED',
        `the reputationSeed collection of ${label} must be an array (got ${describe(list)})`,
      );
    const seen = new Set();
    return list.map((raw, i) => {
      const t = typeReputation(raw, `reputationSeed entry #${i}`);
      if (!t.ok) throw refusal('IMPORT_BLOCKED', `${label}: ${t.reason}`);
      const k = `${t.record.scoutName}|${t.record.orgName}`;
      if (seen.has(k))
        throw refusal('IMPORT_BLOCKED', `${label}: reputationSeed entry #${i} duplicates an earlier entry (${k})`);
      seen.add(k);
      return t.record;
    });
  };
  const counts = () => ({ reputationSeed: reads.count() });
  return {
    ...reads,
    reads,
    /**
     * Attach to the table. `seed` is the first installation's demo track records (handed in only while the
     * installation is being initialised): imported once, when the table is empty.
     */
    attach({ seed = [] } = {}) {
      if (!reputationSeedLive(sqlite))
        throw new Error(`the reputation seed repository needs ${REPUTATION_SEED_MIGRATION} recorded`);
      if (seed.length && reads.count() === 0) {
        const rows = typed(seed);
        operation(() => {
          const ins = q(insertSql('reputation_seed', REPUTATION_SPEC));
          for (const r of rows) ins.run(encode(REPUTATION_SPEC, r));
        });
      }
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll: () => REPUTATION_SEED_RECORDS.read(sqlite),
    log,
    now,
  };
}
