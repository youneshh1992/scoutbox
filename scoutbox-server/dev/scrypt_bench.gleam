//// How long a password hash takes at the server's parameters (Node's defaults), one at a time and eight at once,
//// and whether other work keeps its latency meanwhile. `gleam run -m scrypt_bench`.

import gleam/erlang/process
import gleam/float
import gleam/int
import gleam/io
import gleam/list
import gleam/time/duration
import gleam/time/timestamp
import scoutbox/platform/scrypt

fn ms(f: fn() -> a) -> Float {
  let start = timestamp.system_time()
  let _ = f()
  timestamp.difference(start, timestamp.system_time())
  |> duration.to_seconds
  |> float.multiply(1000.0)
}

fn hash(i: Int) -> BitArray {
  scrypt.derive_key(
    <<"club-secret-":utf8, i:32>>,
    <<"0123456789abcdef0123456789abcdef":utf8>>,
    scrypt.node_defaults,
    32,
  )
}

fn show(label: String, value: Float) -> Nil {
  io.println(
    label <> ": " <> float.to_string(float.to_precision(value, 1)) <> " ms",
  )
}

pub fn main() -> Nil {
  let _ = hash(0)
  let one = list.map(list.repeat(Nil, 10), fn(_) { ms(fn() { hash(1) }) })
  show("one hash (mean of 10)", float.sum(one) /. 10.0)
  let done = process.new_subject()
  let eight =
    ms(fn() {
      list.each(list.repeat(Nil, 8), fn(_) {
        process.spawn(fn() { process.send(done, hash(2)) })
      })
      list.each(list.repeat(Nil, 8), fn(_) { process.receive(done, 60_000) })
    })
  show("eight at once, wall clock", eight)
  // A 1 ms sleep measured while eight hashes run: what a request waiting on a scheduler would see.
  list.each(list.repeat(Nil, 8), fn(_) {
    process.spawn(fn() { process.send(done, hash(3)) })
  })
  let waits =
    list.map(list.repeat(Nil, 50), fn(_) { ms(fn() { process.sleep(1) }) })
  list.each(list.repeat(Nil, 8), fn(_) { process.receive(done, 60_000) })
  show(
    "a 1 ms sleep during them (worst of 50)",
    list.fold(waits, 0.0, float.max),
  )
  io.println("schedulers: " <> int.to_string(schedulers()))
}

@external(erlang, "erlang", "system_info")
fn system_info(item: SchedulersOnline) -> Int

type SchedulersOnline {
  SchedulersOnline
}

fn schedulers() -> Int {
  system_info(SchedulersOnline)
}
