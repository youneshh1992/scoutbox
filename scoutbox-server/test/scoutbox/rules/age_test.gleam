//// The calls to `ageOn` the battery recorder can't keep: an unreadable date of birth, whose age is NaN in the
//// TypeScript server, has no age here (None), so it is never age 0 and never an adult by accident.
////
//// The suites also pass `null`, `undefined`, `0`, `false` and the number 20100101 as a date of birth. None can
//// reach `age_on` here: it takes text, and `players.birth_date` is text that is never NULL.

import gleam/list
import gleam/option.{None}
import scoutbox/rules/age

/// 2026-09-14T12:00:00Z and 2026-09-18T12:00:00Z, the instants the suites ask at.
const instants = [1_789_862_400_000, 1_790_164_800_000]

pub fn an_unreadable_date_of_birth_has_no_age_test() {
  let unreadable = [
    // platform/contracts
    "garbage", "2004-13-45",
    // agents/adversarial AD8b and platform/dates C1: days the calendar doesn't have
    "2010-02-30", "2011-04-31", "2019-02-29", "2023-02-29", "2023-13-01",
    "2023-00-10", "2023-01-00", "2023-01-32",
    // not a YYYY-MM-DD day at all
    "02/03/2010", "",
  ]
  list.each(unreadable, fn(dob) {
    list.each(instants, fn(now) {
      assert age.age_on(dob, now) == None
      assert !age.is_adult(dob, "GB", now)
    })
  })
}
