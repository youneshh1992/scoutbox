//// Checking a rule over a whole matrix of inputs (the fixtures dev/matrix_cases.mjs writes): every row is
//// answered and compared, and the test fails once, naming every row that differs, rather than at the first.

import gleam/int
import gleam/list
import gleam/string

/// One input: how to name it, the TypeScript rule's answer, and how to get this server's.
pub type Row {
  Row(what: String, expected: String, actual: fn() -> String)
}

/// Fails, listing the first twenty rows whose answer differs from the TypeScript rule's (`rule`).
pub fn check(rows: List(Row), rule: String) -> Nil {
  let mismatches =
    list.filter_map(rows, fn(row) {
      let actual = row.actual()
      case actual == row.expected {
        True -> Error(Nil)
        False ->
          Ok(
            row.what
            <> "\n    expected "
            <> row.expected
            <> "\n    got      "
            <> actual,
          )
      }
    })
  case mismatches {
    [] -> Nil
    _ ->
      panic as {
        int.to_string(list.length(mismatches))
        <> " of "
        <> int.to_string(list.length(rows))
        <> " answers differ from "
        <> rule
        <> ":\n  "
        <> string.join(list.take(mismatches, 20), "\n  ")
      }
  }
}
