// SQLite-backed snapshot store (node:sqlite, no native deps). The working set
// stays in memory — the API's data model is unchanged — but every save is an
// atomic transaction into data/scoutbox.db, one row per collection, so a crash
// mid-write can never corrupt state the way a half-written JSON file could.
// A legacy data/db.json snapshot is imported once and then set aside.
//
// node:sqlite is REQUIRED, with its transaction state (`isTransaction`):
// Node.js 22.16 or later on the 22 line, or 24.0 or later (runtime.mjs is the
// one definition of that contract). There is no JSON fallback: `openStore`
// throws a compatibility error (SQLITE_REQUIRED / NODE_UNSUPPORTED) before
// touching the data directory, and server.mjs lets that error end the process.
// Sessions (plan step S2) are stored only as token hashes in a table, which a
// JSON snapshot could not hold without keeping plain tokens again.
//
// The data layer under repositories/ moves collections out of this blob store
// one domain at a time, into real tables in the same database file. The store
// has two modes for them:
//
//   server mode   openStore(dir, { tableBacked: [...] }) — the running server.
//                 Those collections belong to their repositories: `save` skips
//                 them (and deletes any blob row left from before the move)
//                 and `load` hands back only what is still a blob, so the
//                 repository can import a legacy blob on the first boot after
//                 the move.
//   snapshot mode openStore(dir) — backups, restores, fixtures and the
//                 persistence suites, which treat the file as one snapshot.
//                 `load` merges each table-backed collection in from its table
//                 and `save` writes it back into that table, so the database
//                 reads and writes as the single shape the server sees.
//
// Whether a table-backed collection is read from and written to its table is
// decided by the domain's cutover record in `data_migrations`
// (repositories/*.mjs, `migrationApplied`), never by whether the table exists:
// before the record the blob is authoritative and the table (an S1 shadow, or a
// rollback copy's emptied table) is left alone; after it the blob is gone.

import fs from 'node:fs';
import path from 'node:path';
import { readTableBacked, writeTableBacked, checkTableBackedShapes } from './repositories/index.mjs';
import { captureGraph, restoreGraph } from './repositories/memento.mjs';
import { requireRuntime, CONTRACT } from './runtime.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Reported by openStore, which refuses to run without it.
}

function legacyImportError(detail, cause) {
  const err = new Error(`LEGACY_IMPORT_FAILED: ${detail}. db.json was left in place and the database was not changed; the server must not start from seed over it.`);
  err.code = 'LEGACY_IMPORT_FAILED';
  if (cause) err.cause = cause;
  return err;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read and validate a legacy db.json envelope. Returns null only when the file
 * does not exist. Anything else that stops the file from being imported as it
 * is — unreadable, not JSON, not an object, no `db` object, a collection that
 * is neither an array nor an object, a table-backed collection that is not an
 * array — throws LEGACY_IMPORT_FAILED before a byte is written or renamed.
 */
function readLegacySnapshot(legacyFile) {
  let raw;
  try { raw = fs.readFileSync(legacyFile, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw legacyImportError(`db.json exists but could not be read (${err?.code ?? err?.message ?? err})`, err);
  }
  let legacy;
  try { legacy = JSON.parse(raw); } catch (err) { throw legacyImportError(`db.json is not valid JSON (${err?.message ?? err})`, err); }
  if (!isPlainObject(legacy)) throw legacyImportError('db.json is not a JSON object (a snapshot is { savedAt, idCounter, db })');
  if (!isPlainObject(legacy.db)) throw legacyImportError('db.json has no "db" object (a snapshot is { savedAt, idCounter, db: { <collection>: [...] } })');
  // Every ScoutBox snapshot has had a `players` array since the first
  // milestone, and server.mjs refuses to run from a snapshot without one; a
  // file that lacks it is refused here, before it could be imported and then
  // mistaken for "no snapshot". Other blob collections may hold any JSON value
  // (modules keep scalars such as a timestamp under their own keys).
  if (!Array.isArray(legacy.db.players)) throw legacyImportError(`db.json collection "players" must be an array (got ${legacy.db.players === null ? 'null' : Array.isArray(legacy.db.players) ? 'an array' : typeof legacy.db.players})`);
  try { checkTableBackedShapes(legacy.db); } catch (err) { throw legacyImportError(`db.json ${err.message}`, err); }
  return legacy;
}

export function openStore(dataDir, { tableBacked = null } = {}) {
  if (!DatabaseSync) {
    const err = new Error(`SQLITE_REQUIRED: ScoutBox needs the node:sqlite module (${CONTRACT}, enabled by default; this is ${process.version}${process.execArgv.some((a) => /no-experimental-sqlite/.test(a)) ? ', started with --no-experimental-sqlite' : ''}). There is no JSON fallback. The data directory was not touched.`);
    err.code = 'SQLITE_REQUIRED';
    throw err;
  }
  // The runtime contract (runtime.mjs) is checked before the directory is
  // created or the file opened: an older Node.js has no transaction state
  // (`isTransaction`), and on it every save would fail after the database was
  // opened. Refused here with NODE_UNSUPPORTED and nothing touched.
  requireRuntime();
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyFile = path.join(dataDir, 'db.json');
  const serverMode = Array.isArray(tableBacked);
  const skip = new Set(serverMode ? tableBacked : []);

  const sqlite = new DatabaseSync(path.join(dataDir, 'scoutbox.db'));
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  // A second connection on the same file (backup tooling, the validation
  // command's read-only open, a persistence suite) waits for a writer to
  // finish instead of failing with SQLITE_BUSY.
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const upsertCollection = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
  const deleteCollection = sqlite.prepare('DELETE FROM collections WHERE name = ?');
  const upsertMeta = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const readSaveSeq = sqlite.prepare('SELECT value FROM meta WHERE key = ?');

  // Server mode only: save hooks the data layer registers. `flush` runs inside
  // every save transaction, before the blob rows are written, so a repository
  // that keeps part of its records in memory between saves (the organisations'
  // transitional facets, S3) persists them atomically with the rest of the
  // snapshot. A flush failure fails the save: nothing half-written. After the
  // transaction ends the outcome is reported to every hook — `commit` once
  // COMMIT returned, `rollback` once ROLLBACK ran (for a failure after the
  // flush, in a later write or in COMMIT itself) — so a hook's change tracking
  // reflects committed state only and a rolled-back change is flushed again.
  const hooks = [];
  const report = (phase) => { for (const hook of hooks) hook[phase]?.(); };

  // Server mode only: the unit of work (see `unitOfWork` below). While one is
  // open, repository row writes are allowed inside the store's transaction,
  // `save()` is absorbed into the unit's commit, and side effects registered
  // with `afterCommit` wait until COMMIT returned.
  let unit = null; // { afterCommit: [], failure: null } while a unit of work is open
  let afterCommitFailures = 0;
  let afterCommitDelivered = 0;
  let lastAfterCommitError = null;
  let restoreFailures = 0;
  let lastRestoreError = null;
  // Thenables a unit's work returned although it must be synchronous: their
  // continuations run later, OUTSIDE any unit, and nothing here can cancel them.
  const strayAsyncWork = { escaped: 0, rejected: 0, lastError: null };
  const brief = (err) => ({ at: Date.now(), message: String(err?.message ?? err).slice(0, 200) });
  const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
  // An `async function` (or async generator) is identifiable BEFORE it runs:
  // refusing it then means none of its body executes. A plain function that
  // returns a promise can only be recognised afterwards (see `unitOfWork`).
  const asyncKind = (fn) => { const k = Object.prototype.toString.call(fn); return k === '[object AsyncFunction]' || k === '[object AsyncGeneratorFunction]' ? k.slice(8, -1) : null; };

  /**
   * Run one side effect (an after-commit callback). It never throws into the
   * caller: a synchronous failure is counted and logged, and a returned promise
   * is observed so an asynchronous failure is counted and logged the same way
   * instead of becoming an unhandled rejection. The data stays committed.
   */
  function runSideEffect(fn) {
    const failed = (err) => {
      afterCommitFailures += 1;
      lastAfterCommitError = brief(err);
      console.error(`unit of work: an after-commit side effect failed (the data is committed): ${lastAfterCommitError.message}`);
    };
    let result;
    try { result = fn(); } catch (err) { failed(err); return; }
    if (isThenable(result)) Promise.resolve(result).then(() => { afterCommitDelivered += 1; }, failed);
    else afterCommitDelivered += 1;
  }

  /** The work of a unit returned a thenable: observe it (its rejection must never be unhandled) and count the escape. */
  function observeStrayAsync(thenable) {
    strayAsyncWork.escaped += 1;
    Promise.resolve(thenable).then(undefined, (err) => {
      strayAsyncWork.rejected += 1;
      strayAsyncWork.lastError = brief(err);
      console.error(`unit of work: asynchronous work that escaped a rolled-back unit rejected later (whatever it did ran outside any unit): ${strayAsyncWork.lastError.message}`);
    });
  }

  /** Everything a save transaction writes between BEGIN and COMMIT (flush hooks, blobs, meta, optional projection). */
  function writeBody(snapshot, { asSnapshot }) {
    if (!asSnapshot) for (const hook of hooks) hook.flush();
    const inTables = new Set(asSnapshot ? writeTableBacked(sqlite, snapshot.db) : []);
    for (const [name, value] of Object.entries(snapshot.db)) {
      if ((!asSnapshot && skip.has(name)) || inTables.has(name)) { deleteCollection.run(name); continue; }
      upsertCollection.run(name, JSON.stringify(value));
    }
    upsertMeta.run('idCounter', String(snapshot.idCounter));
    upsertMeta.run('savedAt', String(snapshot.savedAt ?? Date.now()));
    // The save revision is what ties a shadow projection to the snapshot
    // it was taken from: wall-clock savedAt can repeat, this cannot.
    const saveSeq = (Number(readSaveSeq.get('saveSeq')?.value) || 0) + 1;
    upsertMeta.run('saveSeq', String(saveSeq));
  }

  /**
   * One save transaction. `asSnapshot` writes every collection the way snapshot
   * mode does — into its table when the domain has cut over, as a blob
   * otherwise — regardless of the mode the store was opened in. Server-mode
   * saves pass false and skip table-backed collections (their repositories
   * write their tables row by row).
   *
   * Contract of an ORDINARY save (unchanged since S3): memory is the intended
   * state. A failed save leaves memory as it is, the hooks discard what they
   * wrote, and the next save retries everything that is still different from
   * the committed state. Nothing is undone in memory.
   */
  function write(snapshot, { asSnapshot }) {
    // IMMEDIATE (S8a-core): a save is a write transaction and takes the write lock
    // at BEGIN, through the busy handler. A deferred BEGIN whose first statements
    // are reads (the save hooks' final-state assertions read before they write)
    // holds a read snapshot; if another process commits in between, the later
    // upgrade to a write fails at once with "database is locked" (SQLITE_BUSY_SNAPSHOT,
    // which the busy handler never retries). The S2 busy-timeout test proves the wait.
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      writeBody(snapshot, { asSnapshot });
      sqlite.exec('COMMIT');
    } catch (err) {
      // A failure anywhere above — a flush, a blob write, COMMIT itself — ends
      // the transaction; the hooks learn that nothing they wrote exists.
      try { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); } finally { if (!asSnapshot) report('rollback'); }
      throw err;
    }
    if (!asSnapshot) report('commit');
  }

  /**
   * An explicit UNIT OF WORK: run `work()` so that every repository row write
   * it performs, every facet change, every in-memory blob mutation and the
   * snapshot save commit or roll back TOGETHER, in one SQLite transaction.
   *
   * Contract (different from an ordinary save, on purpose):
   *  - On any failure — inside `work`, in a flush, in a blob write, at COMMIT —
   *    the transaction is rolled back AND memory is restored to the state it had
   *    when the unit began: every blob collection, every record, every nested
   *    array and object is put back IN PLACE (repositories/memento.mjs), so
   *    references callers hold stay valid and show the pre-operation values;
   *    each participating repository restores its own records, views and
   *    change tracking. A later ordinary save therefore persists NO fragment of
   *    the failed operation. Retrying means calling `unitOfWork` again with the
   *    whole operation. The error carries `unitOfWork = 'rolled_back'`.
   *  - Edits that were pending BEFORE the unit began (an unsaved facet change,
   *    an unsaved blob edit) are part of the restored state: they stay in
   *    memory, still pending, exactly as an ordinary save failure leaves them.
   *  - `work` must be synchronous: a SQLite transaction never spans an await
   *    or a network call. An `async function` is identifiable and is REFUSED
   *    BEFORE IT IS INVOKED — none of its body runs (top-level or nested). A
   *    plain function that returns a promise cannot be told apart beforehand:
   *    its synchronous part has run and is rolled back with the unit, the unit
   *    refuses, and the promise is observed (a rejection is counted, never
   *    unhandled). Its continuation is NOT cancelled — nothing can cancel it —
   *    and runs later OUTSIDE any unit; the escape is counted in
   *    `unitOfWorkState().strayAsyncWork` so it is visible. Do not write
   *    asynchronous work; the store cannot make it safe.
   *  - A unit started inside a unit JOINS it (one transaction). An inner
   *    failure marks the WHOLE unit unable to commit, even when the inner
   *    caller catches the error: the outer unit then fails at its end with the
   *    inner error as `cause`, and everything is rolled back and restored.
   *    A unit cannot start inside a foreign open transaction.
   *  - `save()` called inside a unit is absorbed: the unit's commit writes the
   *    blobs once. `afterCommit(fn)` defers a side effect (a broadcast, a push)
   *    until COMMIT returned; a side effect never fails the operation: a
   *    synchronous throw or a rejected returned promise is counted and
   *    reported (`unitOfWorkState()`), and is NOT a rollback — the data is
   *    committed. Later callbacks still run. Outside a unit `afterCommit`
   *    runs the callback immediately, observed the same way.
   *  - Setup and teardown are exception-safe: a failed BEGIN opens no unit and
   *    runs no work; a failing cleanup step (ROLLBACK, the memento, a
   *    participant's restore) is recorded (`restoreFailures`, attached to the
   *    error as `unitOfWorkCleanup`) and still closes the unit.
   *  - Participants are the registered save hooks that implement
   *    `snapshotState()` / `restoreState()`; a repository without them must
   *    refuse writes while a unit is open (`store.unit.active()`), or its
   *    bookkeeping would survive a rollback.
   * `snapshot()` supplies `{ savedAt, idCounter, db }` for the blob write and
   * `db` is the root of the memento (table-backed collections on it are views
   * and are skipped; their repositories restore themselves).
   */
  const asyncRefusal = (kind, nested) => new TypeError(`a unit of work must be synchronous: the ${nested ? 'nested ' : ''}work is an ${kind} and was not invoked (a SQLite transaction never spans an await; nothing of it ran)`);
  const thenableRefusal = () => new Error('a unit of work must be synchronous: the work returned a promise/thenable, so the unit was rolled back; its continuation is not cancelled and whatever it does later happens outside any unit (counted in unitOfWorkState().strayAsyncWork)');

  /** Run `work` inside the already-open unit. Any failure — thrown, or a refused asynchronous shape — poisons the unit. */
  function runJoined(work) {
    try {
      const kind = asyncKind(work);
      if (kind) throw asyncRefusal(kind, true);
      const result = work();
      if (isThenable(result)) { observeStrayAsync(result); throw thenableRefusal(); }
      return result;
    } catch (err) {
      if (!unit.failure) unit.failure = err;
      throw err;
    }
  }

  /** Close a failed unit: ROLLBACK, restore memory and the participants, tell the hooks — each step attempted even when another fails, and the unit is closed whatever happens. */
  function abort(memento, states, err) {
    const cleanup = [];
    const attempt = (label, fn) => { try { fn(); } catch (e) { cleanup.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`); } };
    try {
      attempt('ROLLBACK', () => { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); });
      attempt('memento', () => restoreGraph(memento));
      hooks.forEach((hook, i) => { if (hook.restoreState) attempt(`participant ${i} restoreState`, () => hook.restoreState(states[i])); });
      attempt('hooks rollback', () => report('rollback'));
    } finally {
      unit = null;
    }
    if (cleanup.length) {
      restoreFailures += cleanup.length;
      lastRestoreError = { at: Date.now(), message: cleanup.join('; ').slice(0, 400) };
      console.error(`unit of work: rollback cleanup failed in ${cleanup.length} step(s) (the unit is closed; memory may not match the database until the next restart): ${lastRestoreError.message}`);
    }
    if (err && typeof err === 'object') {
      err.unitOfWork = 'rolled_back';
      if (cleanup.length) err.unitOfWorkCleanup = cleanup;
    }
  }

  function unitOfWork(work, { snapshot } = {}) {
    if (!serverMode) throw new Error('unitOfWork is a server mode operation; a snapshot tool writes whole snapshots with save()');
    if (typeof work !== 'function' || typeof snapshot !== 'function') throw new TypeError('unitOfWork(work, { snapshot }) needs a synchronous work function and a snapshot provider');
    if (unit) return runJoined(work); // nested: join the enclosing unit
    if (sqlite.isTransaction) throw new Error('a unit of work cannot start inside an open transaction');
    const kind = asyncKind(work);
    if (kind) throw asyncRefusal(kind, false); // before anything is captured or begun: nothing to undo
    const before = snapshot();
    const memento = captureGraph([before.db]);
    const states = hooks.map((hook) => (hook.snapshotState ? hook.snapshotState() : null));
    // BEGIN first: if it fails, no unit was ever open, the work does not run and
    // the error propagates as it is (nothing to roll back or restore). IMMEDIATE,
    // for the reason given in write(): a unit of work is a write transaction.
    sqlite.exec('BEGIN IMMEDIATE');
    unit = { afterCommit: [], failure: null };
    let result;
    try {
      result = work();
      if (isThenable(result)) { observeStrayAsync(result); throw thenableRefusal(); }
      if (unit.failure) throw new Error(`the unit of work cannot commit: a nested (joined) unit failed inside it and its caller swallowed the error — ${String(unit.failure?.message ?? unit.failure).slice(0, 200)}`, { cause: unit.failure });
      writeBody(snapshot(), { asSnapshot: false });
      sqlite.exec('COMMIT');
    } catch (err) {
      abort(memento, states, err);
      throw err;
    }
    const deferred = unit.afterCommit;
    unit = null;
    report('commit');
    for (const fn of deferred) runSideEffect(fn);
    return result;
  }

  const store = {
    engine: 'sqlite',
    sqlite,
    /** Register a save hook `{ flush, commit?, rollback? }` (or a bare flush function) for every server-mode save transaction (see `hooks`). */
    setSaveHook(hook) {
      if (typeof hook === 'function') hooks.push({ flush: hook });
      else if (hook && typeof hook.flush === 'function') hooks.push(hook);
      else throw new TypeError('a save hook is { flush, commit?, rollback? } or a flush function');
    },
    load() {
      const rows = sqlite.prepare('SELECT name, value FROM collections').all();
      // "Never saved" is the absence of blob rows AND of a save record: since
      // S4a every core collection can live in a table, so a database whose
      // only collections are table-backed has no blob row at all yet was saved.
      const everSaved = !!sqlite.prepare('SELECT 1 FROM meta WHERE key IN (?, ?) LIMIT 1').get('savedAt', 'saveSeq');
      if (rows.length === 0 && !everSaved) {
        // One-time import of the pre-SQLite JSON snapshot, then retire the
        // file. EVERY collection the JSON holds is written into the database
        // first — table-backed ones included, as blobs when their domain has
        // not cut over yet (the cutover migration then imports them from the
        // file, which is its one authoritative input), into their tables when
        // it has. Only after that commit is db.json renamed. A failure leaves
        // db.json in place, writes nothing, and is fatal to the caller: it must
        // never be mistaken for "no snapshot, run from seed".
        //
        // Only a GENUINELY ABSENT db.json means "first installation". A file
        // that exists but cannot be read, is not valid JSON, or is not a
        // snapshot envelope (`{ db: { <collection>: [] | {} } }`) is a snapshot
        // the operator meant to keep, and it is refused with the same fatal
        // error — never turned into "no snapshot".
        const legacy = readLegacySnapshot(legacyFile);
        if (legacy === null) return null;
        try {
          write(legacy, { asSnapshot: true });
        } catch (err) {
          throw legacyImportError(`db.json could not be imported into scoutbox.db (${err?.message ?? err})`, err);
        }
        fs.renameSync(legacyFile, `${legacyFile}.migrated`);
        return legacy;
      }
      const db = {};
      for (const row of rows) db[row.name] = JSON.parse(row.value);
      if (!serverMode) Object.assign(db, readTableBacked(sqlite));
      const idCounter = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('idCounter')?.value) || 0;
      const savedAt = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('savedAt')?.value) || null;
      const saveSeq = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('saveSeq')?.value) || 0;
      return { db, idCounter, savedAt, saveSeq };
    },
    /** The persisted save revision: incremented by every save of the snapshot, in either mode. */
    revision() { return Number(readSaveSeq.get('saveSeq')?.value) || 0; },
    /**
     * TEST SEAM (reached only through the development fault layer, see
     * server.mjs `unit`): make the REAL COMMIT of the open transaction fail. A
     * foreign key whose check SQLite defers to COMMIT is violated inside the
     * transaction, so the COMMIT statement itself is refused with "FOREIGN KEY
     * constraint failed" — the engine's genuine failure path, not a throw placed
     * before the statement. The two helper tables are created inside the same
     * transaction and vanish with its rollback. Refused when no transaction is open.
     */
    failCommitOfOpenTransaction() {
      if (!sqlite.isTransaction) throw new Error('failCommitOfOpenTransaction: no transaction is open');
      sqlite.exec('PRAGMA defer_foreign_keys = ON');
      sqlite.exec('CREATE TABLE fault_commit_parent (id TEXT PRIMARY KEY); CREATE TABLE fault_commit_child (parent_id TEXT NOT NULL REFERENCES fault_commit_parent(id))');
      sqlite.prepare('INSERT INTO fault_commit_child (parent_id) VALUES (?)').run('missing-on-purpose');
    },
    /** An ordinary save. Inside an open unit of work it is absorbed: the unit's commit writes the blobs once. */
    save(snapshot) { if (unit) return; write(snapshot, { asSnapshot: !serverMode }); },
    unitOfWork,
    /**
     * The participant API for repositories. `active()`: whether a unit of work
     * is open on this store (their row writes are then allowed inside the
     * transaction). `join(work)`: run one repository operation INSIDE the open
     * unit through the same boundary a nested unit uses — a throw (or a refused
     * asynchronous shape) poisons the unit even when the operation's caller
     * catches the error, so a statement that already ran cannot be committed
     * by the enclosing unit; the error is rethrown unchanged. No BEGIN, no
     * savepoint: the unit's one transaction and one rollback. Refused outside a
     * unit (a standalone operation runs its own transaction instead).
     */
    unit: {
      active: () => unit !== null,
      join(work) {
        if (typeof work !== 'function') throw new TypeError('unit.join needs a synchronous work function');
        if (!unit) throw new Error('unit.join needs an open unit of work (outside a unit a repository operation runs a transaction of its own)');
        return runJoined(work);
      },
    },
    inUnitOfWork: () => unit !== null,
    /**
     * Defer a side effect until the open unit of work committed; outside a unit,
     * run it now. Either way it never throws into the caller: a synchronous
     * failure or a rejected returned promise is counted and logged.
     */
    afterCommit(fn) {
      if (typeof fn !== 'function') throw new TypeError('afterCommit needs a function');
      if (unit) unit.afterCommit.push(fn); else runSideEffect(fn);
    },
    unitOfWorkState: () => ({
      active: unit !== null,
      afterCommitFailures, afterCommitDelivered, lastAfterCommitError,
      restoreFailures, lastRestoreError,
      strayAsyncWork: { ...strayAsyncWork },
    }),
  };
  return store;
}
