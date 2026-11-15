//// The ported safeguarding rules agree with domain.ts on every case in test/fixtures/rule_cases.json (written
//// by `node dev/rule_cases.mjs` from the TypeScript rules themselves).

import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import scoutbox/rows/moderation_flags
import scoutbox/rows/moderation_log
import scoutbox/rows/orgs as org_row
import scoutbox/rules/age
import scoutbox/rules/moderation
import scoutbox/rules/visibility
import scoutbox/vocab/org_type
import simplifile
import sqlight

type VisibilityCase {
  VisibilityCase(
    now: Int,
    dob: String,
    country: String,
    level: String,
    location: Option(#(Float, Float)),
    org: String,
    visible: Bool,
  )
}

type ModerationCase {
  ModerationCase(text: String, flags: List(String), severity: Option(String))
}

fn number() -> decode.Decoder(Float) {
  decode.one_of(decode.float, [decode.int |> decode.map(int.to_float)])
}

fn cases() -> #(List(VisibilityCase), List(ModerationCase)) {
  let assert Ok(text) = simplifile.read("test/fixtures/rule_cases.json")
  let point = {
    use lat <- decode.field("lat", number())
    use lng <- decode.field("lng", number())
    decode.success(#(lat, lng))
  }
  let assert Ok(cases) =
    json.parse(text, {
      use visibility <- decode.field(
        "visibility",
        decode.list({
          use now <- decode.field("now", decode.int)
          use dob <- decode.field("dob", decode.string)
          use country <- decode.field("country", decode.string)
          use level <- decode.field("level", decode.string)
          use location <- decode.field("location", decode.optional(point))
          use org <- decode.field("org", decode.string)
          use visible <- decode.field("visible", decode.bool)
          decode.success(VisibilityCase(
            now:,
            dob:,
            country:,
            level:,
            location:,
            org:,
            visible:,
          ))
        }),
      )
      use moderation <- decode.field(
        "moderation",
        decode.list({
          use text <- decode.field("text", decode.string)
          use flags <- decode.field("flags", decode.list(decode.string))
          use severity <- decode.field(
            "severity",
            decode.optional(decode.string),
          )
          decode.success(ModerationCase(text:, flags:, severity:))
        }),
      )
      decode.success(#(visibility, moderation))
    })
  cases
}

/// The organisations dev/rule_cases.mjs names.
fn org(name: String) -> org_row.Row {
  let base =
    org_row.new(
      id: "org-" <> name,
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

pub fn visibility_agrees_with_domain_ts_test() {
  use conn <- sqlight.with_connection(":memory:")
  let #(all, _) = cases()
  let wrong =
    list.filter(all, fn(c) {
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
            sqlight.nullable(
              sqlight.float,
              option.map(c.location, fn(l) { l.0 }),
            ),
            sqlight.nullable(
              sqlight.float,
              option.map(c.location, fn(l) { l.1 }),
            ),
          ]),
          decode.at([0], sqlight.decode_bool()),
        )
      visible != c.visible
    })
  assert list.length(all) > 5000
  assert list.take(wrong, 5) == []
}

/// The Gleam form of adulthood agrees with the SQL form the visibility rule uses.
pub fn adulthood_in_gleam_agrees_with_sql_test() {
  use conn <- sqlight.with_connection(":memory:")
  let #(all, _) = cases()
  let wrong =
    list.filter(all, fn(c) {
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
      adult != age.is_adult(c.dob, c.country, c.now)
    })
  assert wrong == []
}

pub fn moderation_agrees_with_domain_ts_test() {
  let #(_, all) = cases()
  let wrong =
    list.filter(all, fn(c) {
      let got = case moderation.check(c.text) {
        Ok(Nil) -> #([], None)
        Error(hit) -> #(
          list.map(hit.flags, moderation_flags.flag_to_string),
          Some(moderation_log.severity_to_string(hit.severity)),
        )
      }
      got != #(c.flags, c.severity)
    })
  assert list.length(all) > 40
  assert wrong == []
}

/// A 29 February birthday counts on 1 March in other years.
pub fn a_leap_day_birthday_counts_on_the_first_of_march_test() {
  let on = fn(day) {
    let assert Ok(d) = age.parse_day(day)
    age.age("2012-02-29", d)
  }
  assert on("2030-02-28") == Some(17)
  assert on("2030-03-01") == Some(18)
  assert on("2032-02-29") == Some(20)
}
