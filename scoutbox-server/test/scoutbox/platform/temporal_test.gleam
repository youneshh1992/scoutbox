//// The platform/dates rules suite's calls the recorder can't keep (dev/battery_cases/report.json), ported by hand.
//// temporal.ts reads `unknown` values and fails closed on ones it can't read; here an instant is an `Int` and a
//// day a `Day`, so each of those values is refused where it arrives, by the reader these tests call, and no rule
//// is ever handed one. NaN and ±Infinity can't be written in JSON at all.

import gleam/dynamic
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/battery/base
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/trial_rules
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts
import scoutbox/rules/age

/// The values the suite hands isExpiredAt, isEffectiveAt, isOrderedInterval and isActiveAt as unreadable instants.
const unreadable_instants = [
  "\"\"", "\"soon\"", "\"x\"", "[]", "{}", "true", "false", "null",
]

pub fn an_unreadable_instant_never_becomes_one_test() {
  let refused = fn(text) {
    case temporal.instant(base.body(text), 1900, 2100) {
      Ok(_) -> False
      Error(_) -> True
    }
  }
  assert list.all(unreadable_instants, refused)
  // Numeric text is text: "1790078400000" is not an instant until someone says what it is.
  assert temporal.instant(base.body("\"1790078400000\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
  // A day is not an instant.
  assert temporal.instant(base.body("\"2020-01-01\""), 1900, 2100)
    == Error(temporal.InstantWrongShape)
}

/// TypeScript reads a stored ISO text as unreadable; here it is read where it arrives, into the instant it names.
pub fn an_instant_written_as_text_is_read_once_test() {
  assert temporal.instant(base.body("\"2020-01-01T00:00:00.000Z\""), 1900, 2100)
    == Ok(1_577_836_800_000)
}

/// No expiry never passes; a window with no end stays open; a start is required.
pub fn absent_bounds_test() {
  assert !temporal.is_expired_at(None, 0)
  assert temporal.is_effective_at(0, None, 1)
  assert !temporal.is_effective_at(2, Some(3), 1)
}

/// isDayWithin's day must itself be a day: text that isn't one never becomes a `Day`.
pub fn an_unreadable_day_never_becomes_one_test() {
  assert temporal.parse_day("garbage") == Error(temporal.DayWrongShape)
  assert temporal.read_day(dynamic.nil()) == Error(temporal.DayNotText)
  assert temporal.read_day(dynamic.int(20_260_501))
    == Error(temporal.DayNotText)
}

/// validateIanaZone over a value that isn't text: the shape refuses it first, and a name the table doesn't know is
/// no zone, so parseLocalDateTimeWithZone's TIMEZONE_INVALID is decided before a wall time is read.
pub fn a_zone_is_a_name_the_table_knows_test() {
  assert zones.parse("Mars/Olympus") == Error(Nil)
  assert zones.parse("europe/london") == Error(Nil)
  assert zones.parse("") == Error(Nil)
  assert result.map(zones.parse("Asia/Kolkata"), zones.name)
    == Ok("Asia/Kolkata")
}

/// ageOn and isAdult over a birth date that isn't a day: no age, never adult.
pub fn an_unreadable_birth_date_has_no_age_test() {
  assert age.age_on("garbage", 0) == None
  assert age.age_on("", 0) == None
  assert !age.is_adult("", "GB", 1_790_164_800_000)
  assert !age.is_adult("20100101", "GB", 1_790_164_800_000)
}

/// A day's text survives JSON as itself.
pub fn a_day_writes_as_its_text_test() {
  assert json.to_string(temporal.day_json(base.day("2000-02-29")))
    == "\"2000-02-29\""
}

/// trialReportDueAt and cooldownFor over an acceptance or delivery instant that can't be read: both are INTEGER
/// columns decoded as an Int, so the only unreadable one is none at all. A trial with no readable day is due a
/// week after its acceptance; a contact with no delivery time cools nothing down.
pub fn a_missing_instant_is_none_test() {
  assert trial_rules.report_due_at(Some("2026-02-30"), 5) == 604_800_005
  assert trial_rules.report_due_at(None, 5) == 604_800_005
  let undelivered =
    contact_rules.Contact(
      ..base.contact(),
      row: recruitment_contacts.Row(
        ..base.contact().row,
        status: recruitment_contacts.Delivered,
        delivered_at: None,
      ),
    )
  assert contact_rules.cooldown_until(
      [undelivered],
      id.org("org-base"),
      id.player("pl-base"),
      1_790_164_800_000,
      None,
    )
    == None
  // The suite's "answered" is a state no contact can be in: an answer moves it to `responded`.
  assert recruitment_contacts.status_from_string("answered") == Error(Nil)
}
