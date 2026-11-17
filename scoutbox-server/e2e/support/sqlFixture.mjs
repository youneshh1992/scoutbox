// Test helper: a battery's fixture written as plain rows with plain SQL, so it does not depend on the server's
// language. A new data directory gets the migrated schema from schema.sql (generated from the table migrations by
// scripts/sqlFixtureSchema.mjs); an existing one, left by a stopped server, is opened as it is. Nothing here imports
// the server: every row is spelled out in the stored shape, and a row the schema refuses (a CHECK, a STRICT type,
// a foreign key) throws and the fixture's transaction writes nothing.
//
//   const F = openFixture(dir);          F.session({...}); F.insert('table', { column: value }); F.sql.prepare(…)
//   F.transaction(() => …); F.close();
//   writeFixture(dir, { sessions: [...], rows: { table: [{ column: value }] } })   one transaction, then closed
//   plantCase(F, id, { ...legacyMoves(F, id, chain, { prefix }) })                  a case state no act writes
//
// Reading back what a server left: sqlRows.mjs.
//
// Synthetic data only; temporary directories only.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
export const DAY_MS = 86_400_000;
/** The lifetime a session row is given when the fixture names no expiry (the server's default lifetime). */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** The table migrations' ids in order: the ledger (`data_migrations`) a freshly migrated database holds. */
export const TABLE_MIGRATIONS = [
  ...fs
    .readFileSync(SCHEMA_SQL, 'utf8')
    .matchAll(/^INSERT INTO "data_migrations" \("id", "applied_at"\) VALUES \('([^']+)'/gm),
].map((m) => m[1]);
/** The schema version a server on this schema reports: the latest table migration's number. */
export const SCHEMA_VERSION = Number(TABLE_MIGRATIONS.at(-1).slice(0, 4));
/** The stored form of a bearer token: sessions keep its SHA-256, never the token. */
export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/** The database file of `dataDir`, created from the migrated schema if it does not exist yet. */
function openDatabase(dataDir, now) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'scoutbox.db');
  const fresh = !fs.existsSync(file);
  const sql = new DatabaseSync(file);
  if (fresh) {
    sql.exec('PRAGMA journal_mode = WAL;');
    // The snapshot lists each table's rows in creation order, which is not always parent before child.
    sql.exec('PRAGMA foreign_keys = OFF;');
    sql.exec(fs.readFileSync(SCHEMA_SQL, 'utf8').replaceAll('__NOW__', String(Math.trunc(now))));
    const broken = sql.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`schema.sql: ${broken.length} broken reference(s), first in ${broken[0].table}`);
  }
  sql.exec('PRAGMA foreign_keys = ON;');
  sql.exec('PRAGMA busy_timeout = 5000;');
  return { sql, fresh };
}

/**
 * Open `dataDir` for writing a fixture. `fresh` says whether this call created the database. Returns helpers that
 * write rows exactly as given; `sql` is the raw connection for anything they do not cover.
 */
export function openFixture(dataDir, { now = Date.now() } = {}) {
  const { sql, fresh } = openDatabase(dataDir, now);
  const F = {
    sql,
    fresh,
    now,
    /** Insert one row: `{ column: value }` in the stored names and types (no renaming, no defaults added). */
    insert(table, row) {
      const cols = Object.keys(row);
      if (!cols.length) throw new TypeError(`${table}: a row needs at least one column`);
      const quoted = cols.map((c) => `"${c.replaceAll('"', '""')}"`).join(', ');
      return sql
        .prepare(`INSERT INTO "${table.replaceAll('"', '""')}" (${quoted}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => row[c]));
    },
    /**
     * A session a test signs in with: `{ token, sid, kind: 'org'|'player'|…, refId, userId?, via?, createdAt?,
     * expiresAt? }`. Only the token's hash is stored; the expiry defaults to `createdAt` plus the default lifetime.
     */
    session({ token, sid, kind, refId, userId = null, via = null, createdAt = now, expiresAt }) {
      return F.insert('sessions', {
        token_hash: tokenHash(token),
        sid,
        kind,
        ref_id: refId,
        org_user_id: kind === 'org' ? userId : null,
        via,
        created_at: createdAt,
        expires_at: Number.isFinite(expiresAt) ? expiresAt : createdAt + SESSION_TTL_MS,
      });
    },
    /**
     * Mark the installation as set up, so the server's first boot imports no demo seed: what a first boot does once
     * it has imported its organisations and people.
     */
    markInstalled() {
      sql.prepare("UPDATE meta SET value = 'done' WHERE key IN ('orgsInit', 'coreIdentityInit')").run();
    },
    /** Raise the server's id counter to at least `n` (never lowers it), for fixture ids minted below it. */
    raiseIdCounter(n) {
      sql.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'id'").run(Number(n) || 0);
    },
    /** Run `work` in one transaction: all of it is written, or (if it throws) none of it. */
    transaction(work) {
      sql.exec('BEGIN');
      try {
        const out = work();
        sql.exec('COMMIT');
        return out;
      } catch (err) {
        sql.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => sql.close(),
  };
  return F;
}

/**
 * Plant a case state no act writes (a legacy status jump, a dangling link, a pruned history) on an open fixture `F`
 * (`openFixture`): `status`, `stage`, `rev` and `signingId` set as given, `history` entries appended after the case's
 * last, and the entries whose id `dropHistory(id)` holds removed. Returns the case's stored row. Test databases only.
 */
export function plantCase(F, id, { status, stage, rev, signingId, history = [], dropHistory = null } = {}) {
  if (!F.sql.prepare('SELECT 1 FROM recruitment_cases WHERE id = ?').get(id))
    throw new Error(`plantCase: no recruitment case ${id}`);
  const cols = Object.entries({ room_status: status, stage, room_rev: rev, links_signing_id: signingId }).filter(
    ([, v]) => v !== undefined,
  );
  if (cols.length)
    F.sql
      .prepare(`UPDATE recruitment_cases SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map(([, v]) => v), id);
  if (dropHistory)
    for (const { id: hid } of F.sql.prepare('SELECT id FROM case_history WHERE case_id = ?').all(id))
      if (dropHistory(hid)) F.sql.prepare('DELETE FROM case_history WHERE case_id = ? AND id = ?').run(id, hid);
  const insert = F.sql.prepare(
    'INSERT INTO case_history (case_id, position, id, at, action, by_kind, by_id, by_name, detail_text, detail_json) VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM case_history WHERE case_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const h of history)
    insert.run(
      id,
      id,
      h.id,
      h.at,
      h.action,
      h.byKind ?? null,
      h.byId ?? null,
      h.byName ?? null,
      typeof h.detail === 'string' ? h.detail : null,
      h.detail && typeof h.detail === 'object' ? JSON.stringify(h.detail) : null,
    );
  return F.sql.prepare('SELECT * FROM recruitment_cases WHERE id = ?').get(id);
}

/**
 * A legacy status chain for case `id` on an open fixture `F`: the moves through `chain` as `room_status_changed`
 * entries an hour apart (after the later of now and the case's newest entry), the last one carrying `extraLast`, and
 * the status and rev they leave. Spread into `plantCase`. `now` defaults to the fixture's clock.
 */
export function legacyMoves(
  F,
  id,
  chain,
  { prefix, byName = 'Legacy', extraLast = {}, withReasons = true, now = Date.now() } = {},
) {
  const k = F.sql.prepare('SELECT room_status, room_rev FROM recruitment_cases WHERE id = ?').get(id);
  if (!k) throw new Error(`legacyMoves: no recruitment case ${id}`);
  const newest = F.sql.prepare('SELECT MAX(at) AS at FROM case_history WHERE case_id = ?').get(id).at;
  let prev = k.room_status;
  let at = Math.max(now, Number(newest) || 0);
  const history = chain.map((to, i) => {
    at += 3_600_000;
    const h = {
      id: `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
      at,
      action: 'room_status_changed',
      byKind: 'org',
      byId: 'legacy',
      byName,
      detail: {
        from: prev,
        to,
        ...(withReasons ? { reasonCodes: [] } : {}),
        ...(i === chain.length - 1 ? extraLast : {}),
      },
    };
    prev = to;
    return h;
  });
  return { status: chain[chain.length - 1], rev: (k.room_rev ?? 1) + chain.length, history };
}

/** The collections `writeFixture` can write. */
const WRITERS = {
  sessions: (F, records) => {
    for (const s of records) F.session(s);
  },
  rows: (F, tables) => {
    for (const [table, rows] of Object.entries(tables)) for (const r of rows) F.insert(table, r);
  },
};

/**
 * Write `collections` into `dataDir` in one transaction (all or nothing) and close it. Returns `dataDir`. A new
 * directory is marked installed, as a server leaves one after its first boot, so the fixture is the whole
 * installation. `idCounter` raises the id counter, as `raiseIdCounter`. `rows` is `{ table: [row, …] }` in the stored shape. Any other collection is refused
 * (FIXTURE_COLLECTION_UNSUPPORTED) before anything is opened: add a writer for it here.
 */
export function writeFixture(dataDir, collections = {}, { now = Date.now(), idCounter = null } = {}) {
  const unknown = Object.keys(collections).filter((n) => collections[n] !== undefined && !Object.hasOwn(WRITERS, n));
  if (unknown.length)
    throw Object.assign(
      new Error(`FIXTURE_COLLECTION_UNSUPPORTED: ${unknown.join(', ')} (e2e/support/sqlFixture.mjs has no writer)`),
      { code: 'FIXTURE_COLLECTION_UNSUPPORTED' },
    );
  const F = openFixture(dataDir, { now });
  try {
    F.transaction(() => {
      if (F.fresh) F.markInstalled();
      for (const [name, records] of Object.entries(collections)) if (records !== undefined) WRITERS[name](F, records);
      if (idCounter !== null) F.raiseIdCounter(idCounter);
    });
  } finally {
    F.close();
  }
  return dataDir;
}
