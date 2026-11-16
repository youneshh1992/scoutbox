//// The unit of work: one writer connection owned by one process, and a pool of read-only connections.
////
//// - Writes need a `Tx` and only `unit` makes one, so a write outside a transaction does not compile.
//// - Reads take a `Read`: a unit's own connection (it sees the unit's writes) or a pooled read-only connection
////   (it sees the last commit, and SQLite refuses a write on it).
//// - Work returns its side effects as data. They are dispatched in the caller's process after COMMIT, so a slow
////   provider never holds the writer, and a refused unit sends nothing.
//// - Each unit runs in a fresh process the writer monitors. If the work crashes (a `panic`, a failed
////   `let assert`), the writer sees the process go down, rolls back and carries on with the next unit.

import gleam/dynamic/decode.{type Decoder}
import gleam/erlang/process.{type Pid, type Subject}
import gleam/int
import gleam/list
import gleam/otp/actor
import gleam/result
import gleam/string
import sqlight

pub opaque type Tx {
  Tx(conn: sqlight.Connection, should_fail: fn(String) -> Bool)
}

pub opaque type Read {
  Read(conn: sqlight.Connection)
}

/// Why an operation inside a unit (or a read) did not finish: the storage refused it, or the act did.
pub type Fail(e) {
  Storage(sqlight.Error)
  Refuse(e)
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
  }
}

pub type UnitError(e) {
  /// The work returned an error: rolled back.
  Refused(e)
  /// SQLite refused something (a CHECK, a key, a decode): rolled back.
  Database(sqlight.Error)
  /// The work's process crashed: rolled back, and the writer carries on.
  Crashed(String)
  /// No answer in time. The unit may still commit: its outcome is unknown, not failed.
  TimedOut
}

pub opaque type Store(effect) {
  Store(
    writer: Subject(Job),
    writer_pid: Pid,
    readers: List(Subject(Job)),
    dispatch: fn(effect) -> Nil,
    timeout: Int,
    /// The development fault layer's `internal:<step>` rules: whether a named step fails now.
    should_fail: fn(String) -> Bool,
  )
}

type Job {
  Job(run: fn(sqlight.Connection) -> Nil)
}

/// Opens the database file at `path`: one writer and `readers` read-only connections. `dispatch` sends an effect
/// a committed unit returned. Migrations must already have run (`migrate` on the writer's `Tx`).
pub fn open(
  path path: String,
  readers readers: Int,
  dispatch dispatch: fn(effect) -> Nil,
) -> Result(Store(effect), String) {
  use #(writer_pid, writer) <- result.try(start_connection("file:" <> path))
  use readers <- result.try(
    list.repeat(Nil, readers)
    |> list.try_map(fn(_) {
      start_connection("file:" <> path <> "?mode=ro")
      |> result.map(fn(started) { started.1 })
    }),
  )
  Ok(
    Store(
      writer:,
      writer_pid:,
      readers:,
      dispatch:,
      timeout: 5000,
      should_fail: fn(_) { False },
    ),
  )
}

/// The same store with effects sent somewhere else: the dispatcher usually needs the store itself.
pub fn with_dispatch(
  store: Store(effect),
  dispatch: fn(effect) -> Nil,
) -> Store(effect) {
  Store(..store, dispatch:)
}

fn start_connection(uri: String) -> Result(#(Pid, Subject(Job)), String) {
  actor.new_with_initialiser(5000, fn(subject) {
    use conn <- result.try(
      sqlight.open(uri) |> result.map_error(string.inspect),
    )
    use _ <- result.try(
      sqlight.exec(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        conn,
      )
      |> result.map_error(string.inspect),
    )
    actor.initialised(conn) |> actor.returning(subject) |> Ok
  })
  |> actor.on_message(fn(conn, job: Job) {
    job.run(conn)
    actor.continue(conn)
  })
  |> actor.start
  |> result.map(fn(started) { #(started.pid, started.data) })
  |> result.map_error(string.inspect)
}

/// The same store with the fault layer's seams: `should_fail(step)` says whether a named step inside a unit
/// fails now (always false in production).
pub fn with_seams(
  store: Store(effect),
  should_fail: fn(String) -> Bool,
) -> Store(effect) {
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
/// effects it returned are dispatched, in order, after COMMIT.
pub fn unit(
  store: Store(effect),
  work: fn(Tx) -> Result(#(a, List(effect)), Fail(e)),
) -> Result(a, UnitError(e)) {
  // A unit started inside a unit would wait on its own writer forever. Joining a unit is passing its Tx.
  case process.self() == store.writer_pid {
    True -> panic as "unit() called inside a unit: pass the Tx instead"
    False -> Nil
  }
  let reply = process.new_subject()
  process.send(
    store.writer,
    Job(fn(conn) {
      process.send(reply, supervise_unit(conn, store.should_fail, work))
    }),
  )
  case process.receive(reply, store.timeout) {
    Error(Nil) -> Error(TimedOut)
    Ok(Error(e)) -> Error(e)
    Ok(Ok(#(value, effects))) -> {
      // `internal:unit.after_commit`: the unit's first after-commit step fails after its data committed; the
      // act's own effects still go out, as each after-commit step is isolated.
      let _ = store.should_fail("unit.after_commit")
      list.each(effects, store.dispatch)
      Ok(value)
    }
  }
}

/// In the writer: runs the unit in a monitored process and waits for it, so the next unit starts only once this
/// one has committed or rolled back.
fn supervise_unit(
  conn: sqlight.Connection,
  should_fail: fn(String) -> Bool,
  work: fn(Tx) -> Result(#(a, List(effect)), Fail(e)),
) -> Result(#(a, List(effect)), UnitError(e)) {
  let done = process.new_subject()
  let pid =
    process.spawn_unlinked(fn() {
      process.send(done, run_unit(conn, should_fail, work))
    })
  let monitor = process.monitor(pid)
  let outcome =
    process.new_selector()
    |> process.select_map(done, Ok)
    |> process.select_specific_monitor(monitor, fn(down) {
      Error(string.inspect(down))
    })
    |> process.selector_receive_forever
  process.demonitor_process(monitor)
  case outcome {
    Ok(result) -> result
    Error(reason) -> {
      let _ = sqlight.exec("ROLLBACK", conn)
      Error(Crashed(reason))
    }
  }
}

fn run_unit(
  conn: sqlight.Connection,
  should_fail: fn(String) -> Bool,
  work: fn(Tx) -> Result(#(a, List(effect)), Fail(e)),
) -> Result(#(a, List(effect)), UnitError(e)) {
  use _ <- result.try(
    sqlight.exec("BEGIN IMMEDIATE", conn) |> result.map_error(Database),
  )
  let outcome = case work(Tx(conn, should_fail)) {
    Error(Refuse(e)) -> Error(Refused(e))
    Error(Storage(e)) -> Error(Database(e))
    Ok(done) -> {
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
      |> result.replace(done)
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

/// Runs `f` on a read-only connection. It sees the last commit and cannot write.
pub fn read(store: Store(effect), f: fn(Read) -> a) -> a {
  let index = int.random(list.length(store.readers))
  let assert Ok(reader) = store.readers |> list.drop(index) |> list.first
  let reply = process.new_subject()
  process.send(reader, Job(fn(conn) { process.send(reply, f(Read(conn))) }))
  let assert Ok(value) = process.receive(reply, store.timeout)
    as "a read did not answer in time"
  value
}

/// A unit's reads see its own writes.
pub fn reading(tx: Tx) -> Read {
  Read(tx.conn)
}

/// The rows `sql` returns, each decoded. A row that does not decode is an error, never a guess.
pub fn query(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
  decoder: Decoder(a),
) -> Result(List(a), Fail(e)) {
  sqlight.query(sql, on: read.conn, with: args, expecting: decoder)
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
  sqlight.query(sql, on: tx.conn, with: args, expecting: decoder)
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
pub fn writer_pragma(store: Store(effect), sql: String) -> Result(Nil, String) {
  let reply = process.new_subject()
  process.send(
    store.writer,
    Job(fn(conn) {
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
