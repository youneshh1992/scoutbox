//// The safeguarding rules give the blessed answers on every case in test/fixtures/rule_cases.json (first blessed
//// from the TypeScript server's domain.ts): who may see a player, and what moderation flags in a text.

import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/blessed
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/moderation_flags
import scoutbox/rows/moderation_log
import scoutbox/rows/orgs as org_row
import scoutbox/rules/age
import scoutbox/rules/moderation
import scoutbox/rules/visibility
import scoutbox/vocab/org_type
import sqlight

type VisibilityCase {
  VisibilityCase(
    now: Int,
    dob: String,
    country: String,
    level: String,
    location: Option(#(Float, Float)),
    org: String,
  )
}

type ModerationCase {
  ModerationCase(text: String)
}

fn number() -> decode.Decoder(Float) {
  decode.one_of(decode.float, [decode.int |> decode.map(int.to_float)])
}

fn fixture() -> blessed.Fixture {
  blessed.load("rule_cases")
}

/// Each case's input, with the item that holds it.
fn cases(
  f: blessed.Fixture,
) -> #(
  List(#(VisibilityCase, blessed.Item)),
  List(#(ModerationCase, blessed.Item)),
) {
  let point = {
    use lat <- decode.field("lat", number())
    use lng <- decode.field("lng", number())
    decode.success(#(lat, lng))
  }
  let visibility =
    blessed.items(blessed.field(blessed.root(f), "visibility"))
    |> list.map(fn(item) {
      #(
        blessed.read(item, {
          use now <- decode.field("now", decode.int)
          use dob <- decode.field("dob", decode.string)
          use country <- decode.field("country", decode.string)
          use level <- decode.field("level", decode.string)
          use location <- decode.field("location", decode.optional(point))
          use org <- decode.field("org", decode.string)
          decode.success(VisibilityCase(
            now:,
            dob:,
            country:,
            level:,
            location:,
            org:,
          ))
        }),
        item,
      )
    })
  let moderation =
    blessed.items(blessed.field(blessed.root(f), "moderation"))
    |> list.map(fn(item) {
      #(
        blessed.read(item, {
          use text <- decode.field("text", decode.string)
          decode.success(ModerationCase(text:))
        }),
        item,
      )
    })
  #(visibility, moderation)
}

/// The organisations the fixture names.
fn org(name: String) -> org_row.Row {
  let base =
    org_row.new(
      id: id.org("org-" <> name),
      name:,
      type_: org_type.Club,
      plan: org_row.PlanPro,
      created_at: 0,
    )
  let at = fn(lat, lng) { #(Some(lat), Some(lng)) }
  let #(type_, verified, level, #(lat, lng)) = case name {
    "agency" -> #(org_type.Agency, True, org_row.LevelAgency, #(None, None))
    "verified club" -> #(
      org_type.Club,
      True,
      org_row.LevelPro,
      at(51.889, 1.02),
    )
    "unverified club" -> #(
      org_type.Club,
      False,
      org_row.LevelAcademy,
      at(53.408, -2.983),
    )
    "verified grassroots" -> #(
      org_type.Club,
      True,
      org_row.LevelGrassroots,
      at(51.552, -0.022),
    )
    "unverified grassroots" -> #(
      org_type.Club,
      False,
      org_row.LevelGrassroots,
      at(53.451, -2.24),
    )
    "grassroots without a ground" -> #(
      org_type.Club,
      True,
      org_row.LevelGrassroots,
      #(None, None),
    )
    _ -> panic as { "unknown organisation in the fixture: " <> name }
  }
  org_row.Row(..base, type_:, verified:, level: Some(level), lat:, lng:)
}

pub fn visibility_is_blessed_test() {
  use conn <- sqlight.with_connection(":memory:")
  let f = fixture()
  let #(all, _) = cases(f)
  assert list.length(all) > 5000
  list.index_map(all, fn(pair, i) {
    let #(c, item) = pair
    let rule = visibility.visible_sql(org(c.org), c.now)
    let assert Ok([visible]) =
      sqlight.query(
        "SELECT "
          <> rule.sql
          <> " FROM (SELECT ? AS birth_date, ? AS country, ? AS level, ? AS lat, ? AS lng) p",
        conn,
        list.append(rule.args, [
          sqlight.text(c.dob),
          sqlight.text(c.country),
          sqlight.text(c.level),
          sqlight.nullable(sqlight.float, option.map(c.location, fn(l) { l.0 })),
          sqlight.nullable(sqlight.float, option.map(c.location, fn(l) { l.1 })),
        ]),
        decode.at([0], sqlight.decode_bool()),
      )
    blessed.answer(
      blessed.field(item, "visible"),
      "visibility " <> int.to_string(i) <> ": " <> c.org <> " sees " <> c.dob,
      json.bool(visible),
    )
  })
  |> blessed.check(f, _)
}

/// The Gleam form of adulthood agrees with the SQL form the visibility rule uses, over every case whose birth
/// date is a day (a stored one always is).
pub fn adulthood_in_gleam_agrees_with_sql_test() {
  use conn <- sqlight.with_connection(":memory:")
  let #(all, _) = cases(fixture())
  let days =
    list.filter_map(all, fn(pair) {
      let #(c, _) = pair
      temporal.parse_day(c.dob) |> result.map(fn(birth) { #(c, birth) })
    })
  assert list.length(days) > 5000
  let wrong =
    list.filter(days, fn(pair) {
      let #(c, birth) = pair
      let rule = age.adult_sql("p.birth_date", "p.country", c.now)
      let assert Ok([adult]) =
        sqlight.query(
          "SELECT "
            <> rule.sql
            <> " FROM (SELECT ? AS birth_date, ? AS country) p",
          conn,
          list.append(rule.args, [sqlight.text(c.dob), sqlight.text(c.country)]),
          decode.at([0], sqlight.decode_bool()),
        )
      adult != age.is_adult(birth, c.country, c.now)
    })
  assert wrong == []
}

pub fn moderation_is_blessed_test() {
  let f = fixture()
  let #(_, all) = cases(f)
  assert list.length(all) > 40
  list.flat_map(all, fn(pair) {
    let #(c, item) = pair
    let #(flags, severity) = case moderation.check(c.text) {
      Ok(Nil) -> #([], None)
      Error(hit) -> #(
        list.map(hit.flags, moderation_flags.flag_to_string),
        Some(moderation_log.severity_to_string(hit.severity)),
      )
    }
    [
      blessed.answer(
        blessed.field(item, "flags"),
        "flags of " <> json.to_string(json.string(c.text)),
        json.array(flags, json.string),
      ),
      blessed.answer(
        blessed.field(item, "severity"),
        "severity of " <> json.to_string(json.string(c.text)),
        json.nullable(severity, json.string),
      ),
    ]
  })
  |> blessed.check(f, _)
}

/// A 29 February birthday counts on 1 March in other years.
pub fn a_leap_day_birthday_counts_on_the_first_of_march_test() {
  let assert Ok(birth) = temporal.parse_day("2012-02-29")
  let on = fn(day) {
    let assert Ok(d) = temporal.parse_day(day)
    age.years_on(birth, d)
  }
  assert on("2030-02-28") == 17
  assert on("2030-03-01") == 18
  assert on("2032-02-29") == 20
}
