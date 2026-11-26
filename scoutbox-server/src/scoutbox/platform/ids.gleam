//// Record ids: `<prefix>-<n>`, numbered from one counter row (`counters`, name 'id').
////
//// An id is minted inside the unit that uses it, so a refused act hands out no id. (The TypeScript server mints
//// ids outside the unit and writes the counter through, so a rolled-back act there still spends one.)

import gleam/dynamic/decode
import gleam/int
import scoutbox/platform/store.{type Fail, type Tx}
import sqlight

pub fn next(tx: Tx, prefix: String) -> Result(String, Fail(e)) {
  case
    store.write(
      tx,
      "UPDATE counters SET value = value + 1 WHERE name = 'id' RETURNING value",
      [],
      decode.at([0], decode.int),
    )
  {
    Ok([n]) -> Ok(prefix <> "-" <> int.to_string(n))
    Ok(_) ->
      Error(
        store.Storage(sqlight.SqlightError(
          sqlight.GenericError,
          "COUNTER_MISSING: the counters table has no 'id' row",
          -1,
        )),
      )
    Error(e) -> Error(e)
  }
}
