// The SQLite store (node:sqlite, no native deps): one database file, data/scoutbox.db, holding every domain's tables.
// Since S14a there is no blob: the `collections` table (one JSON row per collection) is gone, and the id counter is a
// row of `counters`.
//
// node:sqlite is REQUIRED, with its transaction state (`isTransaction`):
// Node.js 22.16 or later on the 22 line, or 24.0 or later (runtime.mjs is the
// one definition of that contract). There is no JSON fallback: `openStore`
// throws a compatibility error (SQLITE_REQUIRED / NODE_UNSUPPORTED) before
// touching the data directory, and server.mjs lets that error end the process.
//
// Two modes:
//
//   server mode   openStore(dir, { tableBacked: [...] }) — the running server. The repositories own their tables;
//                 the store gives them the unit of work and runs the save hooks of the repositories that still stage
//                 their writes (`save()`).
//   snapshot mode openStore(dir) — tools, fixtures and the persistence suites, which treat the file as one
//                 snapshot. The file is brought up to the current table schema when it is opened; `load` reads every
//                 table-backed collection from its table and `save` writes it into that table (validated: junk is
//                 refused and nothing is written). A collection with no table is refused: there is nowhere to put it.
//
// A backup is a copy of the database file (`copyTo`, VACUUM INTO); a restore
// boots a new, empty DATA_DIR holding the copy.

import fs from 'node:fs';
import path from 'node:path';
import { readTableBacked, writeTableBacked, migrateForSnapshot, TABLE_BACKED } from './repositories/index.mjs';
import { requireRuntime, CONTRACT } from './runtime.mjs';
import { runBeforeCommit } from './repositories/database.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Reported by openStore, which refuses to run without it.
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
  const serverMode = Array.isArray(tableBacked);

  const databaseFile = path.join(dataDir, 'scoutbox.db');
  // SQLite treats an empty file as a new database, so a backup emptied in
  // transit would boot as a first installation and load the seed. A missing
  // file is a first installation; an empty one is refused. (Switching to WAL
  // writes the header at once, so a real database is never 0 bytes.)
  if (fs.existsSync(databaseFile) && fs.statSync(databaseFile).size === 0) {
    const err = new Error(`DATABASE_EMPTY: ${databaseFile} exists but is empty (0 bytes). It is not opened as a new installation. Restore a verified backup, or delete the file to start from the seed. Nothing was changed.`);
    err.code = 'DATABASE_EMPTY';
    throw err;
  }
  const sqlite = new DatabaseSync(databaseFile);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  // A second connection on the same file (backup tooling, the validation
  // command's read-only open, a persistence suite) waits for a writer to
  // finish instead of failing with SQLITE_BUSY.
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  // Snapshot mode: the file is brought up to the current table schema first (see migrateForSnapshot). In server
  // mode the data layer runs the migrations when it attaches.
  if (!serverMode) migrateForSnapshot(sqlite);
  const knownCollections = new Set(TABLE_BACKED);

  // Server mode only: save hooks the data layer registers. `flush` runs inside
  // every save transaction, so a repository that keeps part of its records in
  // memory between saves (the organisations' transitional facets, S3) persists
  // them atomically. A flush failure fails the save: nothing half-written. After the
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

  /**
   * Everything a save transaction writes between BEGIN and COMMIT. Server mode: the staged repositories' flush hooks.
   * Snapshot mode: every collection into its table (a collection with no table is refused before anything is
   * written), and the id counter.
   */
  function writeBody(snapshot, { asSnapshot }) {
    if (!asSnapshot) { for (const hook of hooks) hook.flush?.(); return; }
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.db || typeof snapshot.db !== 'object') throw new TypeError('a snapshot-mode save needs { db, idCounter? } with db an object of collections; nothing was written');
    const unknown = Object.keys(snapshot.db ?? {}).filter((name) => snapshot.db[name] !== undefined && !knownCollections.has(name));
    if (unknown.length) throw Object.assign(new Error(`SNAPSHOT_COLLECTION_UNKNOWN: ${unknown.join(', ')} ${unknown.length === 1 ? 'has' : 'have'} no table (the blob store is retired, S14a); the save was rolled back and nothing was written`), { code: 'SNAPSHOT_COLLECTION_UNKNOWN' });
    writeTableBacked(sqlite, snapshot.db ?? {});
    if (snapshot.idCounter !== undefined) sqlite.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'id'").run(Number(snapshot.idCounter) || 0);
  }

  /**
   * One save transaction. `asSnapshot` writes every collection into its table
   * (snapshot mode); a server-mode save passes false and runs only the staged
   * repositories' flush hooks (every other repository writes its rows at once).
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
      runBeforeCommit(sqlite);
      sqlite.exec('COMMIT');
    } catch (err) {
      // A failure anywhere above — a flush, a table write, COMMIT itself — ends
      // the transaction; the hooks learn that nothing they wrote exists.
      try { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); } finally { if (!asSnapshot) report('rollback'); }
      throw err;
    }
    if (!asSnapshot) report('commit');
  }

  /**
   * An explicit UNIT OF WORK: run `work()` so that every repository row write
   * it performs, and the staged repositories' flush, commit or roll back
   * TOGETHER, in one SQLite transaction.
   *
   * Contract (different from an ordinary save, on purpose):
   *  - On any failure — inside `work`, in a flush, at COMMIT — the transaction
   *    is rolled back and each participating repository restores its own
   *    in-memory records, views and change tracking to the state they had when
   *    the unit began. A later ordinary save therefore persists NO fragment of
   *    the failed operation. Retrying means calling `unitOfWork` again with the
   *    whole operation. The error carries `unitOfWork = 'rolled_back'`.
   *  - Edits that were pending BEFORE the unit began (an unsaved facet change,
   *    a staged write) are part of the restored state: they stay in
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
   *  - `save()` called inside a unit is absorbed: the unit's commit flushes
   *    once. `afterCommit(fn)` defers a side effect (a broadcast, a push)
   *    until COMMIT returned; a side effect never fails the operation: a
   *    synchronous throw or a rejected returned promise is counted and
   *    reported (`unitOfWorkState()`), and is NOT a rollback — the data is
   *    committed. Later callbacks still run. Outside a unit `afterCommit`
   *    runs the callback immediately, observed the same way.
   *  - Setup and teardown are exception-safe: a failed BEGIN opens no unit and
   *    runs no work; a failing cleanup step (ROLLBACK, a participant's
   *    restore) is recorded (`restoreFailures`, attached to the
   *    error as `unitOfWorkCleanup`) and still closes the unit.
   *  - Participants are the registered save hooks that implement
   *    `snapshotState()` / `restoreState()`; a repository without them must
   *    refuse writes while a unit is open (`store.unit.active()`), or its
   *    bookkeeping would survive a rollback.
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
  function abort(states, err) {
    const cleanup = [];
    const attempt = (label, fn) => { try { fn(); } catch (e) { cleanup.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`); } };
    try {
      attempt('ROLLBACK', () => { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); });
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

  function unitOfWork(work) {
    if (!serverMode) throw new Error('unitOfWork is a server mode operation; a snapshot tool writes whole snapshots with save()');
    if (typeof work !== 'function') throw new TypeError('unitOfWork(work) needs a synchronous work function');
    if (unit) return runJoined(work); // nested: join the enclosing unit
    if (sqlite.isTransaction) throw new Error('a unit of work cannot start inside an open transaction');
    const kind = asyncKind(work);
    if (kind) throw asyncRefusal(kind, false); // before anything is captured or begun: nothing to undo
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
      writeBody(null, { asSnapshot: false });
      runBeforeCommit(sqlite);
      sqlite.exec('COMMIT');
    } catch (err) {
      abort(states, err);
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
    /** Register a save hook `{ flush?, commit?, rollback?, snapshotState?, restoreState? }` (or a bare flush function) for every server-mode save transaction and unit of work (see `hooks`). */
    setSaveHook(hook) {
      if (typeof hook === 'function') hooks.push({ flush: hook });
      else if (hook && (typeof hook.flush === 'function' || typeof hook.snapshotState === 'function')) hooks.push(hook);
      else throw new TypeError('a save hook is { flush?, commit?, rollback?, snapshotState?, restoreState? } with a flush or a snapshotState, or a flush function');
    },
    /** Snapshot mode: every table-backed collection, as plain arrays in the shape the server sees, and the id counter. */
    load() {
      if (serverMode) throw new Error('load is a snapshot mode operation; the server reads through its repositories');
      const idCounter = Number(sqlite.prepare("SELECT value FROM counters WHERE name = 'id'").get()?.value) || 0;
      return { db: readTableBacked(sqlite), idCounter };
    },
    /**
     * Write a consistent copy of the whole database to `file` (VACUUM INTO): every
     * table, as committed. This is the backup format; a
     * restore boots a new, empty DATA_DIR holding the copy. Refused inside an open
     * transaction (a unit of work), whose writes are not committed yet.
     */
    copyTo(file) {
      if (sqlite.isTransaction) throw new Error('copyTo: a transaction is open; copy the database after it commits');
      if (fs.existsSync(file)) throw new Error(`copyTo: ${file} already exists`);
      sqlite.prepare('VACUUM INTO ?').run(file);
    },
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
    /**
     * Server mode: flush the staged repositories (no argument). Snapshot mode: write `{ db, idCounter }` into the
     * tables. Inside an open unit of work it is absorbed: the unit's commit flushes once.
     */
    save(snapshot = null) { if (unit) return; write(snapshot, { asSnapshot: !serverMode }); },
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
