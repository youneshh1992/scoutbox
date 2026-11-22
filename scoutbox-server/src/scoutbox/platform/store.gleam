//// The unit of work: one writer connection owned by one process, and a pool of read-only connections.
////
//// - Writes need a `Tx` and only `unit` makes one, so a write outside a transaction does not compile.
//// - Reads take a `Read`: a unit's own connection (it sees the unit's writes) or a pooled read-only connection
////   (it sees the last commit, and SQLite refuses a write on it).
//// - Side effects are data (`effect.Effect`), asked for with `emit` from anywhere inside a unit, at any depth.
////   The unit collects them like its writes: they are dispatched in order, in the caller's process, after COMMIT
////   (so a slow provider never holds the writer), and a refused or crashed unit sends none. Nothing has to pass
////   them up, so nothing can drop one. A `Read` has no collector: a read cannot ask for an effect.
//// - Each unit runs in a fresh process the writer monitors. If the work crashes (a `panic`, a failed
////   `let assert`), the writer sees the process go down, rolls back and carries on with the next unit. A read on
////   a pooled connection runs the same way, so a crashing read never takes its reader down.
//// - Queries go through `scoutbox_store_ffi`, not sqlight's `query`: each connection's statements are prepared once
////   and kept, and fetched in short batches on a normal scheduler unless a batch met a step slower than a
////   millisecond (see that module, and `vendor/esqlite.patch`). Statements without parameters (`exec`: BEGIN, COMMIT, migrations) go through sqlight,
////   on a dirty scheduler, so a COMMIT's fsync never holds a normal one.

import exception
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode.{type Decoder}
import gleam/erlang/atom
import gleam/erlang/process.{type Pid, type Subject}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import gleam/string
import gleam/time/timestamp
import scoutbox/platform/effect.{type Effect}
import simplifile
import sqlight

pub opaque type Tx {
  Tx(
    conn: sqlight.Connection,
    cache: Cache,
    should_fail: fn(String) -> Bool,
    /// The unit's effects, in the order asked for. Owned by the unit's process, which drains it on success.
    effects: Subject(Effect),
  )
}

/// Asks for `effect` once this unit commits. A refused or crashed unit sends none.
pub fn emit(tx: Tx, effect: Effect) -> Nil {
  process.send(tx.effects, effect)
}

pub opaque type Read {
  Read(conn: sqlight.Connection, cache: Cache)
}

/// The prepared statements of every connection of one store (an ETS table, owned by the writer's process).
type Cache

/// Why an operation inside a unit (or a read) did not finish: the storage refused it, or the act did.
pub type Fail(e) {
  Storage(sqlight.Error)
  Refuse(e)
  /// What the act read before its unit no longer holds: another request changed it first. The unit rolls back,
  /// and the route runs again from the top (`http.rerun_on_stale`), so it answers from the new state.
  Stale(String)
}

/// The act lost a race: what it checked before the unit has changed. `what` names the check, for the log.
pub fn stale(what: String) -> Result(a, Fail(e)) {
  Error(Stale(what))
}

/// Refuses the act with `e`: the unit rolls back.
pub fn refuse(e: e) -> Result(a, Fail(e)) {
  Error(Refuse(e))
}

/// Gives a refusal another act's meaning: how one act's repository refusals join another's.
pub fn map_refusal(r: Result(a, Fail(e)), f: fn(e) -> f) -> Result(a, Fail(f)) {
  case r {
    Ok(v) -> Ok(v)
    Error(Storage(e)) -> Error(Storage(e))
    Error(Refuse(e)) -> Error(Refuse(f(e)))
    Error(Stale(what)) -> Error(Stale(what))
  }
}

pub type UnitError(e) {
  /// The work returned an error: rolled back.
  Refused(e)
  /// SQLite refused something (a CHECK, a key, a decode): rolled back.
  Database(sqlight.Error)
  /// The act lost a race (`stale`): rolled back, to be run again.
  Lost(String)
  /// The work's process crashed: rolled back, and the writer carries on.
  Crashed(String)
  /// No answer in time. The unit may still commit: its outcome is unknown, not failed.
  TimedOut
}

pub opaque type Store {
  Store(
    writer: Subject(Job),
    writer_pid: Pid,
    readers: Subject(PoolMessage),
    dispatch: fn(Effect) -> Nil,
    timeout: Int,
    /// The development fault layer's `internal:<step>` rules: whether a named step fails now.
    should_fail: fn(String) -> Bool,
    /// Runs inside every unit whose work succeeded, just before COMMIT (`with_before_commit`).
    before_commit: fn(Tx) -> Result(Nil, sqlight.Error),
  )
}

type Job {
  Job(run: fn(sqlight.Connection, Cache) -> Nil)
}

/// The read-only connections share one queue: a job goes to the next reader that is free, so one slow read never
/// holds others up behind it while another reader sits idle. A job carries the moment its caller stops waiting
/// (`deadline`, ms since the epoch); one still queued then is dropped, never run, so an overloaded pool doesn't
/// spend itself on answers nobody will read.
type PoolMessage {
  Submit(job: Job, deadline: Int)
  /// A reader finished its job (or just started) and can take the next.
  Free(reader: Subject(Job))
}

type Pool {
  Pool(
    idle: List(Subject(Job)),
    /// The waiting jobs, oldest first: `front`, then `back` reversed.
    front: List(#(Job, Int)),
    back: List(#(Job, Int)),
  )
}

fn start_pool() -> Result(Subject(PoolMessage), String) {
  actor.new(Pool(idle: [], front: [], back: []))
  |> actor.on_message(fn(pool, message) {
    case message {
      Submit(job:, deadline:) ->
        case pool.idle {
          [reader, ..idle] -> {
            process.send(reader, job)
            actor.continue(Pool(..pool, idle:))
          }
          [] ->
            actor.continue(Pool(..pool, back: [#(job, deadline), ..pool.back]))
        }
      Free(reader) ->
        case next_live(pool, now_ms()) {
          Ok(#(job, pool)) -> {
            process.send(reader, job)
            actor.continue(pool)
          }
          Error(pool) ->
            actor.continue(Pool(..pool, idle: [reader, ..pool.idle]))
        }
    }
  })
  |> actor.start
  |> result.map(fn(started) { started.data })
  |> result.map_error(string.inspect)
}

/// The oldest waiting job whose caller is still waiting; the expired ones before it are dropped.
fn next_live(pool: Pool, now: Int) -> Result(#(Job, Pool), Pool) {
  case pool.front, pool.back {
    [], [] -> Error(pool)
    [], back ->
      next_live(Pool(..pool, front: list.reverse(back), back: []), now)
    [#(job, deadline), ..front], _ ->
      case deadline > now {
        True -> Ok(#(job, Pool(..pool, front:)))
        False -> next_live(Pool(..pool, front:), now)
      }
  }
}

fn now_ms() -> Int {
  let #(seconds, nanoseconds) =
    timestamp.system_time() |> timestamp.to_unix_seconds_and_nanoseconds
  seconds * 1000 + nanoseconds / 1_000_000
}

/// Runs `job` on the next free reader, or drops it if none is free before `timeout_ms` from now.
fn submit(store: Store, job: Job, timeout_ms: Int) -> Nil {
  process.send(store.readers, Submit(job:, deadline: now_ms() + timeout_ms))
}

/// Opens the database file at `path`: one writer and `readers` read-only connections. `dispatch` sends an effect
/// a committed unit returned. Migrations must already have run (`migrate` on the writer's `Tx`).
pub fn open(
  path path: String,
  readers readers: Int,
  dispatch dispatch: fn(Effect) -> Nil,
) -> Result(Store, String) {
  // The writer's process owns the cache, so it lives as long as the store.
  use #(writer_pid, writer, cache) <- result.try(start_connection(
    "file:" <> path,
    5000,
    None,
    None,
  ))
  use pool <- result.try(start_pool())
  use _ <- result.try(
    list.repeat(Nil, readers)
    |> list.try_map(fn(_) {
      // A reader never waits for a lock inside SQLite: on a normal scheduler that would hold the scheduler. It
      // answers BUSY at once and the query retries in Erlang. With one writer and WAL, readers meet a lock only
      // in edge cases (recovery after a crash). The writer waits only in BEGIN and COMMIT, on a dirty scheduler.
      start_connection(
        "file:" <> path <> "?mode=ro",
        0,
        Some(cache),
        Some(pool),
      )
    }),
  )
  Ok(
    Store(
      writer:,
      writer_pid:,
      readers: pool,
      dispatch:,
      timeout: 5000,
      should_fail: fn(_) { False },
      before_commit: fn(_) { Ok(Nil) },
    ),
  )
}

/// The same store with effects sent somewhere else: the dispatcher usually needs the store itself.
pub fn with_dispatch(store: Store, dispatch: fn(Effect) -> Nil) -> Store {
  Store(..store, dispatch:)
}

/// The same store with `hook` run inside every unit whose work succeeded, just before its COMMIT: for projections
/// the unit's own writes must leave current (the match facts). The hook writes in the unit, so its writes commit or
/// roll back with the act's, and a failing hook rolls the whole unit back as a storage error.
pub fn with_before_commit(
  store: Store,
  hook: fn(Tx) -> Result(Nil, sqlight.Error),
) -> Store {
  Store(..store, before_commit: hook)
}

/// A connection in its own process. With no `cache`, the process makes one and owns it. A reader of a `pool` tells
/// the pool it is free once it starts and after every job.
fn start_connection(
  uri: String,
  busy_timeout_ms: Int,
  cache: Option(Cache),
  pool: Option(Subject(PoolMessage)),
) -> Result(#(Pid, Subject(Job), Cache), String) {
  let free = fn(subject) {
    case pool {
      Some(pool) -> process.send(pool, Free(subject))
      None -> Nil
    }
  }
  actor.new_with_initialiser(5000, fn(subject) {
    use conn <- result.try(
      sqlight.open(uri) |> result.map_error(string.inspect),
    )
    use _ <- result.try(
      sqlight.exec(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = "
          <> int.to_string(busy_timeout_ms)
          <> ";",
        conn,
      )
      |> result.map_error(string.inspect),
    )
    let cache = option.lazy_unwrap(cache, new_cache)
    free(subject)
    actor.initialised(#(conn, cache, subject))
    |> actor.returning(#(subject, cache))
    |> Ok
  })
  |> actor.on_message(fn(state, job: Job) {
    job.run(state.0, state.1)
    free(state.2)
    actor.continue(state)
  })
  |> actor.start
  |> result.map(fn(started) {
    #(started.pid, { started.data }.0, { started.data }.1)
  })
  |> result.map_error(string.inspect)
}

@external(erlang, "scoutbox_store_ffi", "new_cache")
fn new_cache() -> Cache

@external(erlang, "scoutbox_store_ffi", "query")
fn cached_query(
  cache: Cache,
  conn: sqlight.Connection,
  sql: String,
  args: List(sqlight.Value),
) -> Result(List(Dynamic), sqlight.Error)

@external(erlang, "scoutbox_store_ffi", "runs_dirty")
fn ffi_runs_dirty(cache: Cache, conn: sqlight.Connection, sql: String) -> Bool

/// sqlight's `query` through the cache, with sqlight's own decode error.
fn run_query(
  cache: Cache,
  conn: sqlight.Connection,
  sql: String,
  args: List(sqlight.Value),
  decoder: Decoder(a),
) -> Result(List(a), sqlight.Error) {
  use rows <- result.try(cached_query(cache, conn, sql, args))
  list.try_map(rows, decode.run(_, decoder))
  |> result.map_error(fn(errors) {
    let assert [decode.DecodeError(expected, found, path), ..] = errors
    sqlight.SqlightError(
      sqlight.GenericError,
      "Decoder failed, expected "
        <> expected
        <> ", got "
        <> found
        <> " in "
        <> string.join(path, "."),
      -1,
    )
  })
}

/// For tests: whether `sql` now runs on a dirty scheduler on this read's connection, its last batch having met a
/// step slower than a millisecond.
pub fn runs_dirty(read: Read, sql: String) -> Bool {
  ffi_runs_dirty(read.cache, read.conn, sql)
}

/// The same store with the fault layer's seams: `should_fail(step)` says whether a named step inside a unit
/// fails now (always false in production).
pub fn with_seams(store: Store, should_fail: fn(String) -> Bool) -> Store {
  Store(..store, should_fail:)
}

/// A named step inside a unit that the fault layer can fail, to prove the unit's rollback with a real failure
/// after a real write. It fails as storage does, so the act answers 500.
pub fn seam(tx: Tx, step: String) -> Result(Nil, Fail(e)) {
  case tx.should_fail(step) {
    False -> Ok(Nil)
    True ->
      Error(
        Storage(sqlight.SqlightError(
          sqlight.GenericError,
          "simulated failure at " <> step <> " (development fault layer)",
          -1,
        )),
      )
  }
}

/// Runs `work` as one write transaction: everything it writes commits together or not at all. On success the
/// effects it asked for (`emit`) are dispatched, in order, after COMMIT.
pub fn unit(
  store: Store,
  work: fn(Tx) -> Result(a, Fail(e)),
) -> Result(a, UnitError(e)) {
  use #(value, effects) <- result.map(attempt(store, work))
  // `internal:unit.after_commit`: the unit's first after-commit step fails after its data committed; the act's
  // own effects still go out, as each after-commit step is isolated.
  let _ = store.should_fail("unit.after_commit")
  list.each(effects, store.dispatch)
  value
}

/// `unit`, but the effects the committed unit asked for are returned instead of dispatched: what a test asserts.
pub fn unit_effects(
  store: Store,
  work: fn(Tx) -> Result(a, Fail(e)),
) -> Result(#(a, List(Effect)), UnitError(e)) {
  attempt(store, work)
}

fn attempt(
  store: Store,
  work: fn(Tx) -> Result(a, Fail(e)),
) -> Result(#(a, List(Effect)), UnitError(e)) {
  // A unit started inside a unit would wait on its own writer forever. Joining a unit is passing its Tx.
  case process.self() == store.writer_pid {
    True -> panic as "unit() called inside a unit: pass the Tx instead"
    False -> Nil
  }
  let reply = process.new_subject()
  process.send(
    store.writer,
    Job(fn(conn, cache) {
      process.send(
        reply,
        supervise_unit(
          conn,
          cache,
          store.should_fail,
          store.before_commit,
          work,
        ),
      )
    }),
  )
  case process.receive(reply, store.timeout) {
    Error(Nil) -> Error(TimedOut)
    Ok(outcome) -> outcome
  }
}

/// In the writer: runs the unit in a monitored process and waits for it, so the next unit starts only once this
/// one has committed or rolled back.
fn supervise_unit(
  conn: sqlight.Connection,
  cache: Cache,
  should_fail: fn(String) -> Bool,
  before_commit: fn(Tx) -> Result(Nil, sqlight.Error),
  work: fn(Tx) -> Result(a, Fail(e)),
) -> Result(#(a, List(Effect)), UnitError(e)) {
  case
    isolated(fn() { run_unit(conn, cache, should_fail, before_commit, work) })
  {
    Ok(result) -> result
    Error(reason) -> {
      let _ = sqlight.exec("ROLLBACK", conn)
      Error(Crashed(reason))
    }
  }
}

/// Runs `f` in a fresh process and waits for it: `Error` with the reason when it crashes, so the connection's own
/// process (the writer, or a reader) carries on. A crash is not caught; the process dies and is seen to.
fn isolated(f: fn() -> a) -> Result(a, String) {
  let done = process.new_subject()
  let pid = process.spawn_unlinked(fn() { process.send(done, f()) })
  let monitor = process.monitor(pid)
  let outcome =
    process.new_selector()
    |> process.select_map(done, Ok)
    |> process.select_specific_monitor(monitor, fn(down) {
      Error(string.inspect(down))
    })
    |> process.selector_receive_forever
  process.demonitor_process(monitor)
  outcome
}

fn run_unit(
  conn: sqlight.Connection,
  cache: Cache,
  should_fail: fn(String) -> Bool,
  before_commit: fn(Tx) -> Result(Nil, sqlight.Error),
  work: fn(Tx) -> Result(a, Fail(e)),
) -> Result(#(a, List(Effect)), UnitError(e)) {
  use _ <- result.try(
    sqlight.exec("BEGIN IMMEDIATE", conn) |> result.map_error(Database),
  )
  let effects = process.new_subject()
  let tx = Tx(conn, cache, should_fail, effects)
  let worked = case work(tx) {
    Ok(value) ->
      before_commit(tx) |> result.map_error(Storage) |> result.replace(value)
    failed -> failed
  }
  let outcome = case worked {
    Error(Refuse(e)) -> Error(Refused(e))
    Error(Storage(e)) -> Error(Database(e))
    Error(Stale(what)) -> Error(Lost(what))
    Ok(value) -> {
      // `internal:unit.sqlite_commit`: the real COMMIT fails, on a deferred foreign key left dangling on purpose.
      case should_fail("unit.sqlite_commit") {
        True -> {
          let _ =
            sqlight.exec(
              "PRAGMA defer_foreign_keys = ON;
               CREATE TABLE fault_commit_parent (id TEXT PRIMARY KEY);
               CREATE TABLE fault_commit_child (parent_id TEXT NOT NULL REFERENCES fault_commit_parent(id));
               INSERT INTO fault_commit_child (parent_id) VALUES ('missing-on-purpose');",
              conn,
            )
          Nil
        }
        False -> Nil
      }
      sqlight.exec("COMMIT", conn)
      |> result.map_error(Database)
      |> result.replace(#(value, drain(effects, [])))
    }
  }
  case outcome {
    Ok(_) -> Nil
    Error(_) -> {
      let _ = sqlight.exec("ROLLBACK", conn)
      Nil
    }
  }
  outcome
}

/// The effects a unit asked for, in order. Only the unit's own process may drain them.
fn drain(effects: Subject(Effect), acc: List(Effect)) -> List(Effect) {
  case process.receive(effects, 0) {
    Ok(e) -> drain(effects, [e, ..acc])
    Error(Nil) -> list.reverse(acc)
  }
}

/// The message of the crash a read raises when no reader answered in time (`is_overloaded`).
const overloaded = "store overloaded: no reader answered in time"

/// Runs `f` on a read-only connection. It sees the last commit and cannot write.
///
/// When the readers are too busy to answer within the store's timeout, the read crashes with `overloaded`, which
/// the router answers as a retryable 503 (`is_overloaded`): every caller would answer the same, and the request
/// can only give up. If `f` crashes, the read crashes in the caller's process too, and the reader carries on.
pub fn read(store: Store, f: fn(Read) -> a) -> a {
  let reply = process.new_subject()
  let deadline = now_ms() + store.timeout
  process.send(
    store.readers,
    Submit(
      job: Job(fn(conn, cache) {
        let answer = isolated(fn() { f(Read(conn, cache)) })
        // A caller that stopped waiting would only find the answer in its mailbox later, as a stray message.
        case now_ms() < deadline {
          True -> process.send(reply, answer)
          False -> Nil
        }
      }),
      deadline:,
    ),
  )
  case process.receive(reply, int.max(0, deadline - now_ms())) {
    Ok(Ok(value)) -> value
    Ok(Error(reason)) -> panic as { "a read crashed: " <> reason }
    Error(Nil) -> panic as overloaded
  }
}

/// Whether `crash` is a read that no reader answered in time: the server is overloaded, not broken.
pub fn is_overloaded(crash: exception.Exception) -> Bool {
  case crash {
    exception.Errored(detail) ->
      decode.run(
        detail,
        decode.field(atom.create("message"), decode.string, decode.success),
      )
      == Ok(overloaded)
    _ -> False
  }
}

/// The same store with units and reads waiting `ms` for an answer (5 s by default). For tests.
pub fn with_timeout(store: Store, ms: Int) -> Store {
  Store(..store, timeout: ms)
}

/// Writes a consistent copy of the whole database, as last committed, to a new file at `file` (VACUUM INTO): the
/// backup format. It runs on a read-only connection, so units carry on committing while it copies; the copy is that
/// connection's snapshot. Through sqlight rather than the cache: the statement runs once, on a dirty scheduler. A
/// large database can take longer than a read's usual wait, so the caller gives `timeout_ms`.
pub fn copy_to(
  store: Store,
  file: String,
  timeout_ms timeout_ms: Int,
) -> Result(Nil, String) {
  use _ <- result.try(case simplifile.is_file(file) {
    Ok(False) -> Ok(Nil)
    _ -> Error("copy_to: " <> file <> " already exists")
  })
  let reply = process.new_subject()
  submit(
    store,
    Job(fn(conn, _) {
      process.send(
        reply,
        sqlight.query(
          "VACUUM INTO ?",
          on: conn,
          with: [sqlight.text(file)],
          expecting: decode.success(Nil),
        )
          |> result.replace(Nil)
          |> result.map_error(fn(e) { e.message }),
      )
    }),
    timeout_ms,
  )
  case process.receive(reply, timeout_ms) {
    Ok(r) -> r
    Error(Nil) -> Error("copy_to: the copy did not finish in time")
  }
}

/// A unit's reads see its own writes.
pub fn reading(tx: Tx) -> Read {
  Read(tx.conn, tx.cache)
}

/// The rows `sql` returns, each decoded. A row that does not decode is an error, never a guess.
pub fn query(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
  decoder: Decoder(a),
) -> Result(List(a), Fail(e)) {
  run_query(read.cache, read.conn, sql, args, decoder)
  |> result.map_error(Storage)
}

/// The first row `sql` returns, if any.
pub fn one(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
  decoder: Decoder(a),
) -> Result(Result(a, Nil), Fail(e)) {
  query(read, sql, args, decoder) |> result.map(list.first)
}

/// A write. With `RETURNING`, the rows it changed; a guarded UPDATE that matched nothing returns none.
pub fn write(
  tx: Tx,
  sql: String,
  args: List(sqlight.Value),
  decoder: Decoder(a),
) -> Result(List(a), Fail(e)) {
  run_query(tx.cache, tx.conn, sql, args, decoder)
  |> result.map_error(Storage)
}

/// A write whose rows are not wanted.
pub fn run(
  tx: Tx,
  sql: String,
  args: List(sqlight.Value),
) -> Result(Nil, Fail(e)) {
  write(tx, sql, args, decode.success(Nil)) |> result.replace(Nil)
}

/// Statements with no parameters and no result (several may be separated by `;`): migrations.
pub fn exec(tx: Tx, sql: String) -> Result(Nil, Fail(e)) {
  sqlight.exec(sql, tx.conn) |> result.map_error(Storage)
}

/// A connection setting on the writer, between units: SQLite ignores `PRAGMA foreign_keys` inside a
/// transaction. Only the migration runner needs this, around a step that rebuilds a referenced table.
pub fn writer_pragma(store: Store, sql: String) -> Result(Nil, String) {
  let reply = process.new_subject()
  process.send(
    store.writer,
    Job(fn(conn, _) {
      process.send(
        reply,
        sqlight.exec(sql, conn) |> result.map_error(string.inspect),
      )
    }),
  )
  case process.receive(reply, store.timeout) {
    Ok(r) -> r
    Error(Nil) -> Error("the writer did not answer in time")
  }
}
