//// The calls to `ageOn` and `isAdult` the battery recorder can't keep: a date of birth that isn't a day, whose
//// age is NaN in the TypeScript server and which is never an adult there. Here such text is no `Day`, so neither
//// rule can be asked: every write reads a date of birth with `parse_dob`, which refuses it, and a stored one fails
//// its read (`players.birth_date` is decoded with `temporal.day_decoder`), so it is never age 0 and never an adult
//// by accident.
////
//// The suites also pass `null`, `undefined`, `0`, `false`, `[]`, `{}` and the numbers 12, 20100101 and 19900101
//// as a date of birth. None can be
//// a `Day`, and `players.birth_date` is never NULL.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/list
import gleam/result
import scoutbox/platform/temporal
import scoutbox/rules/age

/// 2026-09-14T12:00:00Z and 2026-09-18T12:00:00Z, the instants the suites ask at.
const instants = [1_789_862_400_000, 1_790_164_800_000]

pub fn a_date_of_birth_that_isnt_a_day_is_never_read_test() {
  let unreadable = [
    // platform/contracts
    "garbage", "2004-13-45",
    // agents/adversarial AD8b and platform/dates C1: days the calendar doesn't have
    "2010-02-30", "2011-04-31", "2019-02-29", "2023-02-29", "2023-13-01",
    "2023-00-10", "2023-01-00", "2023-01-32",
    // the contract, dates and lifecycle suites' isAdult calls
    "2026-02-30", "2026-02-31", "0000-00-00",
    // not a YYYY-MM-DD day at all
    "02/03/2010", "", "not-a-date", "NaN", "yesterday",
  ]
  list.each(unreadable, fn(dob) {
    assert decode.run(dynamic.string(dob), temporal.day_decoder())
      |> result.is_error
    list.each(instants, fn(now) {
      assert age.parse_dob(dob, now) |> result.is_error
    })
  })
}
