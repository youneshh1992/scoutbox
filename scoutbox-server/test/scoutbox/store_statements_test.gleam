//// `platform/store`'s queries run through `scoutbox_store_ffi` (a statement cache, and a normal or dirty scheduler
//// per statement) on the NIFs `vendor/esqlite.patch` adds. The type checker can't see across that FFI, so its
//// behaviour is tested here directly, and its results are compared with sqlight's own.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/int
import gleam/list
import gleam/time/duration
import gleam/time/timestamp
import scoutbox/platform/secrets
import scoutbox/platform/store
import simplifile
import sqlight

/// Long enough (about 100 ms) that it must not hold a normal scheduler.
const slow =
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000) SELECT count(*) FROM n"

fn fresh_path() -> String {
  let dir = "build/test-dbs"
  let assert Ok(_) = simplifile.create_directory_all(dir)
  dir <> "/" <> secrets.random_hex(8) <> ".db"
}

/// A store with one table and no migrations.
fn bare_store() -> store.Store {
  let assert Ok(s) =
    store.open(path: fresh_path(), readers: 1, dispatch: fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.exec(
        tx,
        "CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
         INSERT INTO counters VALUES ('hits', 1);",
      )
    })
  s
}

fn int_of(s: store.Store, sql: String, args: List(sqlight.Value)) {
  store.read(s, store.query(_, sql, args, decode.at([0], decode.int)))
}

fn millis_since(started: timestamp.Timestamp) -> Int {
  timestamp.difference(started, timestamp.system_time())
  |> duration.to_milliseconds
}

pub fn a_cached_statement_takes_each_calls_arguments_test() {
  let s = bare_store()
  assert int_of(s, "SELECT ? + 1", [sqlight.int(1)]) == Ok([2])
  assert int_of(s, "SELECT ? + 1", [sqlight.int(41)]) == Ok([42])
  assert int_of(s, "SELECT ? + 1", [sqlight.int(41)]) == Ok([42])
}

pub fn a_statement_called_with_another_argument_count_is_refused_test() {
  // A reset statement keeps its last bindings, so a shorter call would otherwise reuse them.
  let s = bare_store()
  assert int_of(s, "SELECT coalesce(?, 0)", [sqlight.int(7)]) == Ok([7])
  let assert Error(store.Storage(sqlight.SqlightError(
    sqlight.GenericError,
    "expected 1 arguments, got 0",
    -1,
  ))) = int_of(s, "SELECT coalesce(?, 0)", [])
}

pub fn errors_and_decode_failures_are_sqlights_own_test() {
  let s = bare_store()
  use conn <- sqlight.with_connection(":memory:")
  let compare = fn(sql, decoder) {
    let assert Error(store.Storage(ours)) =
      store.read(s, store.query(_, sql, [], decoder))
    let assert Error(theirs) = sqlight.query(sql, conn, [], decoder)
    assert ours == theirs
  }
  compare("SELEC 1", decode.at([0], decode.int))
  compare("SELECT 'text'", decode.at([0], decode.int))
  compare("SELECT * FROM nowhere", decode.at([0], decode.int))
}

pub fn a_write_refused_by_the_schema_keeps_sqlights_error_test() {
  let s = bare_store()
  let assert Error(store.Database(sqlight.SqlightError(
    sqlight.ConstraintPrimarykey,
    _,
    _,
  ))) =
    store.unit(s, fn(tx) {
      store.run(tx, "INSERT INTO counters VALUES (?, 2)", [sqlight.text("hits")])
    })
  assert int_of(s, "SELECT value FROM counters WHERE name = ?", [
      sqlight.text("hits"),
    ])
    == Ok([1])
}

pub fn a_statement_that_ran_long_moves_to_the_dirty_scheduler_test() {
  let s = bare_store()
  let #(fast, long) =
    store.read(s, fn(read) {
      let assert Ok([1]) =
        store.query(read, "SELECT 1", [], decode.at([0], decode.int))
      let assert Ok([1_000_000]) =
        store.query(read, slow, [], decode.at([0], decode.int))
      #(store.runs_dirty(read, "SELECT 1"), store.runs_dirty(read, slow))
    })
  assert fast == False
  assert long == True
}

pub fn reads_carry_on_while_a_unit_runs_a_long_statement_test() {
  let s = bare_store()
  let long_write = fn() {
    store.unit(s, fn(tx) {
      let assert Ok(_) =
        store.run(tx, "UPDATE counters SET value = value + 1", [])
      let assert Ok(_) = store.write(tx, slow, [], decode.success(Nil))
      Ok(Nil)
    })
  }
  // The first run is on a normal scheduler, and is what moves the statement.
  let assert Ok(Nil) = long_write()
  let finished = process.new_subject()
  process.spawn(fn() {
    let started = timestamp.system_time()
    let assert Ok(Nil) = long_write()
    process.send(finished, millis_since(started))
  })
  process.sleep(10)
  let reads =
    list.map(list.repeat(Nil, 20), fn(_) {
      let started = timestamp.system_time()
      let assert Ok([value]) =
        int_of(s, "SELECT value FROM counters WHERE name = 'hits'", [])
      #(value, millis_since(started))
    })
  let assert Ok(unit_ms) = process.receive(finished, 30_000)
  // The readers see the last commit, not the running unit's write, and none waits on it.
  assert list.all(reads, fn(r) { r.0 == 2 })
  let worst = list.fold(reads, 0, fn(worst, r) { int.max(worst, r.1) })
  assert worst * 10 < unit_ms
}

@external(erlang, "scoutbox_store_ffi", "new_cache")
fn new_cache() -> Dynamic

@external(erlang, "scoutbox_store_ffi", "query")
fn ffi_query(
  cache: Dynamic,
  conn: sqlight.Connection,
  sql: String,
  args: List(sqlight.Value),
) -> Result(List(Dynamic), sqlight.Error)

pub fn a_query_that_meets_a_lock_retries_until_it_is_released_test() {
  // A rollback-journal database, where another connection's exclusive lock refuses every reader; the store's own
  // databases are WAL, where a reader meets a lock only in edge cases. With busy_timeout 0 SQLite answers BUSY at
  // once, and the query waits in Erlang.
  let path = fresh_path()
  use reader <- sqlight.with_connection(path)
  let assert Ok(Nil) =
    sqlight.exec(
      "PRAGMA busy_timeout = 0; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);",
      reader,
    )
  let locked = process.new_subject()
  process.spawn(fn() {
    use holder <- sqlight.with_connection(path)
    let assert Ok(Nil) = sqlight.exec("BEGIN EXCLUSIVE", holder)
    process.send(locked, Nil)
    process.sleep(100)
    let assert Ok(Nil) = sqlight.exec("COMMIT", holder)
  })
  let assert Ok(Nil) = process.receive(locked, 5000)
  let started = timestamp.system_time()
  let assert Ok([_]) = ffi_query(new_cache(), reader, "SELECT x FROM t", [])
  assert millis_since(started) >= 50
}

pub fn copy_to_writes_the_last_commit_to_a_new_file_and_refuses_an_existing_one_test() {
  let s = bare_store()
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(tx, "UPDATE counters SET value = 2 WHERE name = 'hits'", [])
    })
  let file = fresh_path()
  let assert Ok(Nil) = store.copy_to(s, file, timeout_ms: 5000)
  let assert Ok(copy) =
    store.open(path: file, readers: 1, dispatch: fn(_) { Nil })
  assert int_of(copy, "SELECT value FROM counters", []) == Ok([2])
  // Never over a file that is there already: a backup never replaces another.
  let assert Error(_) = store.copy_to(s, file, timeout_ms: 5000)
  // Units commit as usual afterwards; the copy held no lock.
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(tx, "UPDATE counters SET value = 3 WHERE name = 'hits'", [])
    })
  assert int_of(s, "SELECT value FROM counters", []) == Ok([3])
}
