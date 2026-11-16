//// Record ids. The TypeScript server checks the same refusal in its unit suite (testDataLayer: "id counter: without
//// its counters row the store refuses to mint ids it could not store"), moved there from platform/storeGuarantees.

import gleam/dynamic/decode
import gleam/result
import gleam/string
import scoutbox/platform/ids
import scoutbox/platform/store
import scoutbox/support

fn counter(s: store.Store(e)) -> List(Int) {
  let assert Ok(values) =
    store.read(s, store.query(
      _,
      "SELECT value FROM counters WHERE name = 'id'",
      [],
      decode.at([0], decode.int),
    ))
  values
}

pub fn ids_are_numbered_from_the_counter_row_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert [before] = counter(s)
  let assert Ok(id) =
    store.unit(s, fn(tx) {
      ids.next(tx, "p") |> result.map(fn(id) { #(id, []) })
    })
  assert id == "p-" <> string.inspect(before + 1)
  assert counter(s) == [before + 1]
}

pub fn without_its_counter_row_no_id_is_minted_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(tx, "DELETE FROM counters WHERE name = 'id'", [])
      |> result.map(fn(_) { #(Nil, []) })
    })
  let assert Error(store.Database(e)) =
    store.unit(s, fn(tx) {
      ids.next(tx, "p") |> result.map(fn(id) { #(id, []) })
    })
  assert string.contains(e.message, "COUNTER_MISSING")
  assert counter(s) == []
}
