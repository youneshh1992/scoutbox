import gleam/dynamic/decode
import gleam/erlang/process
import gleam/list
import gleam/result
import scoutbox/platform/effect.{type Effect, SendMail}
import scoutbox/platform/store
import scoutbox/support
import sqlight

fn count(s: store.Store, sql: String) -> Int {
  let assert Ok([n]) =
    store.read(s, store.query(_, sql, [], decode.at([0], decode.int)))
  n
}

fn mail(subject: String) -> Effect {
  SendMail(to: "someone@example.com", subject:, text: "", secrets: [])
}

fn insert_counter(tx: store.Tx, name: String) -> Result(Nil, store.Fail(e)) {
  store.run(tx, "INSERT INTO counters (name, value) VALUES (?, 0)", [
    sqlight.text(name),
  ])
}

pub fn a_refused_unit_writes_nothing_and_sends_nothing_test() {
  let sent = process.new_subject()
  let s = support.fresh_store(process.send(sent, _))
  let outcome =
    store.unit(s, fn(tx) {
      use _ <- result.try(insert_counter(tx, "refused"))
      store.emit(tx, mail("never"))
      store.refuse("no")
    })
  assert outcome == Error(store.Refused("no"))
  assert count(s, "SELECT COUNT(*) FROM counters WHERE name = 'refused'") == 0
  assert process.receive(sent, 50) == Error(Nil)
}

pub fn effects_are_sent_after_commit_in_order_test() {
  let sent = process.new_subject()
  let s = support.fresh_store(process.send(sent, _))
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.emit(tx, mail("first"))
      use _ <- result.try(insert_counter(tx, "kept"))
      store.emit(tx, mail("second"))
      Ok(Nil)
    })
  assert process.receive(sent, 100) == Ok(mail("first"))
  assert process.receive(sent, 100) == Ok(mail("second"))
  assert process.receive(sent, 50) == Error(Nil)
  assert count(s, "SELECT COUNT(*) FROM counters WHERE name = 'kept'") == 1
}

pub fn unit_effects_returns_the_effects_instead_of_sending_them_test() {
  let sent = process.new_subject()
  let s = support.fresh_store(process.send(sent, _))
  let assert Ok(#(7, effects)) =
    store.unit_effects(s, fn(tx) {
      store.emit(tx, mail("first"))
      store.emit(tx, mail("second"))
      Ok(7)
    })
  assert effects == [mail("first"), mail("second")]
  assert process.receive(sent, 50) == Error(Nil)
}

pub fn a_unit_starts_with_no_effects_of_an_earlier_one_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Error(store.Refused(Nil)) =
    store.unit(s, fn(tx) {
      store.emit(tx, mail("refused"))
      store.refuse(Nil)
    })
  let assert Ok(#(Nil, [])) = store.unit_effects(s, fn(_) { Ok(Nil) })
}

pub fn a_crashing_unit_rolls_back_sends_nothing_and_the_writer_carries_on_test() {
  let sent = process.new_subject()
  let s = support.fresh_store(process.send(sent, _))
  let crashed =
    store.unit(s, fn(tx) {
      let assert Ok(_) = insert_counter(tx, "crashed")
      store.emit(tx, mail("never"))
      panic as "boom"
    })
  let assert Error(store.Crashed(_)) = crashed
  assert process.receive(sent, 50) == Error(Nil)
  assert count(s, "SELECT COUNT(*) FROM counters WHERE name = 'crashed'") == 0
  let assert Ok(Nil) =
    store.unit(s, fn(tx) { insert_counter(tx, "after") |> result.replace(Nil) })
  assert count(s, "SELECT COUNT(*) FROM counters WHERE name = 'after'") == 1
}

pub fn a_storage_refusal_rolls_back_the_whole_unit_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let outcome =
    store.unit(s, fn(tx) {
      use _ <- result.try(insert_counter(tx, "first"))
      // The CHECK refuses a negative value.
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO counters (name, value) VALUES ('bad', -1)",
          [],
        ),
      )
      Ok(Nil)
    })
  let assert Error(store.Database(sqlight.SqlightError(
    sqlight.ConstraintCheck,
    _,
    _,
  ))) = outcome
  assert count(s, "SELECT COUNT(*) FROM counters WHERE name = 'first'") == 0
}

pub fn units_are_serialised_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let start = count(s, "SELECT value FROM counters WHERE name = 'id'")
  let done = process.new_subject()
  // 20 processes each read-modify-write the same row, yielding between the read and the write.
  list.repeat(Nil, 20)
  |> list.each(fn(_) {
    process.spawn(fn() {
      let assert Ok(Nil) =
        store.unit(s, fn(tx) {
          let assert Ok([n]) =
            store.query(
              store.reading(tx),
              "SELECT value FROM counters WHERE name = 'id'",
              [],
              decode.at([0], decode.int),
            )
          process.sleep(1)
          store.run(tx, "UPDATE counters SET value = ? WHERE name = 'id'", [
            sqlight.int(n + 1),
          ])
          |> result.replace(Nil)
        })
      process.send(done, Nil)
    })
  })
  list.each(list.repeat(Nil, 20), fn(_) {
    let assert Ok(Nil) = process.receive(done, 5000)
  })
  assert count(s, "SELECT value FROM counters WHERE name = 'id'") == start + 20
}

pub fn a_read_connection_cannot_write_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Error(store.Storage(sqlight.SqlightError(sqlight.Readonly, _, _))) =
    store.read(s, fn(read) {
      store.query(read, "DELETE FROM counters", [], decode.success(Nil))
    })
}
