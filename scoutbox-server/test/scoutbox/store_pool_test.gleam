//// The read-only connections share one queue (`platform/store`): a read goes to the next free reader, a read still
//// queued when its caller stops waiting is dropped unrun, and a read nobody answered in time crashes as
//// `is_overloaded`, which the router answers as a retryable 503.

import exception
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/time/duration
import gleam/time/timestamp
import scoutbox/platform/secrets
import scoutbox/platform/store
import simplifile

fn store_with(readers readers: Int, timeout_ms timeout_ms: Int) -> store.Store {
  let dir = "build/test-dbs"
  let assert Ok(_) = simplifile.create_directory_all(dir)
  let assert Ok(s) =
    store.open(
      path: dir <> "/" <> secrets.random_hex(8) <> ".db",
      readers:,
      dispatch: fn(_) { Nil },
    )
  store.with_timeout(s, timeout_ms)
}

fn one(s: store.Store) -> Result(List(Int), store.Fail(Nil)) {
  store.read(s, store.query(_, "SELECT 1", [], decode.at([0], decode.int)))
}

/// Holds the store's readers for `ms` from another process, as a slow read would.
fn hold_reader(s: store.Store, ms: Int) -> Nil {
  process.spawn_unlinked(fn() {
    exception.rescue(fn() { store.read(s, fn(_) { process.sleep(ms) }) })
  })
  // Let the slow read reach its reader first.
  process.sleep(20)
}

fn millis_since(started: timestamp.Timestamp) -> Int {
  timestamp.difference(started, timestamp.system_time())
  |> duration.to_milliseconds
}

pub fn a_read_no_reader_answers_in_time_is_overloaded_and_never_runs_test() {
  let s = store_with(readers: 1, timeout_ms: 100)
  hold_reader(s, 300)
  let ran = process.new_subject()
  let assert Error(crash) =
    exception.rescue(fn() { store.read(s, fn(_) { process.send(ran, Nil) }) })
  assert store.is_overloaded(crash)
  // The reader comes free after its caller stopped waiting: the queued read is dropped, not run.
  process.sleep(400)
  assert process.receive(ran, 0) == Error(Nil)
  assert one(s) == Ok([1])
}

pub fn a_slow_read_holds_up_only_its_own_reader_test() {
  let s = store_with(readers: 2, timeout_ms: 5000)
  hold_reader(s, 500)
  let started = timestamp.system_time()
  // With a reader picked at random, about half of these would wait behind the slow read.
  assert one(s) == Ok([1])
  assert one(s) == Ok([1])
  assert one(s) == Ok([1])
  assert one(s) == Ok([1])
  assert one(s) == Ok([1])
  assert one(s) == Ok([1])
  assert millis_since(started) < 200
}

pub fn a_crashing_read_crashes_its_caller_and_the_reader_carries_on_test() {
  let s = store_with(readers: 1, timeout_ms: 1000)
  let assert Error(crash) =
    exception.rescue(fn() { store.read(s, fn(_) { panic as "broken read" }) })
  assert !store.is_overloaded(crash)
  assert one(s) == Ok([1])
}

pub fn a_read_that_finishes_late_leaves_no_message_behind_test() {
  let s = store_with(readers: 1, timeout_ms: 100)
  let assert Error(crash) =
    exception.rescue(fn() { store.read(s, fn(_) { process.sleep(200) }) })
  assert store.is_overloaded(crash)
  // The read ran on past its deadline; its answer must not land in this process's mailbox.
  process.sleep(200)
  let anything = process.new_selector() |> process.select_other(fn(m) { m })
  assert process.selector_receive(anything, 0) == Error(Nil)
}
