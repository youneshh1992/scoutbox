//// The match engine (domains/discovery/matching/match.mjs): does a player satisfy every required criterion, and
//// which preferred ones are met? Nothing is graded, so no caller can derive a score. Matching, the watchlists and
//// Nobody Missed all use it; a brief's criteria are all required.
////
//// Fail closed: a missing fact does not satisfy a criterion about it.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/discovery/briefs
import scoutbox/discovery/matching/criteria.{
  type AgeBound, type Criteria, type Criterion, AnyEvidence, AtLeast,
  AtLeastValue, AtMost, AtMostValue, Between, Criteria, Required,
}
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/distance.{At, Columns}
import scoutbox/platform/sql.{type Fragment}
import scoutbox/rows/id
import scoutbox/rows/recruitment_briefs as brief_row
import scoutbox/rules/age
import scoutbox/vocab/playing_level.{type PlayingLevel}
import scoutbox/vocab/position
import scoutbox/vocab/trust_band.{type TrustBand}
import sqlight

const day_ms = 86_400_000

pub const match_note =
  "Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored."

// ------------------------------------------------------------------------------------------------------ facts

/// A candidate's facts, as the explanation reads them (match.mjs `factsOfRow`).
pub type Facts {
  Facts(
    player_id: id.PlayerId,
    name: String,
    age: Option(Int),
    position: Option(String),
    secondary: List(String),
    level: Option(PlayingLevel),
    foot: Option(String),
    availability: Option(String),
    distance_km: Option(Float),
    trust_band: Option(TrustBand),
    /// The protocols with a Combine Verified result.
    combine: List(String),
    /// Each protocol's best measured value, where it has one.
    combine_measurements: List(#(String, Float)),
    /// The evidence requirements the player's record meets (`evidenceFlags`), by key.
    evidence: List(String),
    last_evidence_at: Option(Int),
    last_footage_at: Option(Int),
  )
}

/// One criterion evaluated: which fact it read (`key`), whether it was met, and why in words.
pub type Check {
  Check(
    criterion_id: String,
    type_: String,
    key: String,
    met: Bool,
    text: String,
  )
}

fn level_rank(l: PlayingLevel) -> Int {
  case l {
    playing_level.Amateur -> 0
    playing_level.SemiPro -> 1
    playing_level.Pro -> 2
  }
}

pub fn band_rank(b: TrustBand) -> Int {
  case b {
    trust_band.LimitedEvidence -> 0
    trust_band.DevelopingEvidence -> 1
    trust_band.EstablishedEvidence -> 2
    trust_band.StrongEvidence -> 3
    trust_band.VeryStrongEvidence -> 4
  }
}

fn option_list(o: Option(a)) -> List(a) {
  case o {
    Some(a) -> [a]
    None -> []
  }
}

/// Does the player satisfy the criterion? `now` is passed in rather than read, so an explanation is reproducible.
pub fn evaluate(c: Criterion, f: Facts, now: Int) -> Check {
  let say = fn(key, met, text) {
    Check(c.id, criteria.type_name(c.check), key, met, text)
  }
  case c.check {
    criteria.PositionIn(values, primary_only) -> {
      let has = case primary_only {
        True -> option_list(f.position)
        False -> list.append(option_list(f.position), f.secondary)
      }
      case list.filter(has, list.contains(values, _)) {
        [] -> say("position", False, "Does not match the position criteria")
        hit ->
          say(
            "position",
            True,
            "Matches position criteria (" <> string.join(hit, ", ") <> ")",
          )
      }
    }
    criteria.Age(bound) ->
      case f.age {
        None -> say("age", False, "Age is not on record")
        Some(a) -> {
          let #(lo, hi) = bounds(bound)
          let n = int.to_string(a)
          case lo, hi {
            Some(l), _ if a < l ->
              say("age", False, "Age " <> n <> " is below the criteria")
            _, Some(h) if a > h ->
              say("age", False, "Age " <> n <> " is above the criteria")
            _, _ -> say("age", True, "Matches age criteria (" <> n <> ")")
          }
        }
      }
    criteria.WithinRadius(km) ->
      case f.distance_km {
        None -> say("location", False, "Distance could not be established")
        Some(d) if d >. km ->
          say("location", False, "Outside the permitted search area")
        // No number: explaining a match must not become a way to learn where a player (often a child) lives.
        Some(_) ->
          say("location", True, "Within the club’s permitted search area")
      }
    criteria.LevelIn(levels) ->
      case f.level {
        None -> say("level", False, "Level is not on record")
        Some(l) ->
          case list.contains(levels, l) {
            True -> say("level", True, "Within the level criteria")
            False ->
              say("level", False, "Plays at a level outside the criteria")
          }
      }
    criteria.LevelAtMost(max) -> {
      let max_rank = level_rank(max)
      // An unknown level does not block.
      case option.map(f.level, level_rank) {
        Some(rank) if rank > max_rank ->
          say("level", False, "Plays at a level above the criteria")
        _ -> say("level", True, "Within the level criteria")
      }
    }
    criteria.FootIn(values) ->
      case f.foot {
        None -> say("foot", False, "Preferred foot is not on record")
        Some(have) -> {
          // Case-insensitive: the vocabulary is written "Right" and the stored fact "right".
          let have_lower = string.lowercase(have)
          case
            list.contains(list.map(values, string.lowercase), have_lower)
            || have_lower == "both"
          {
            True -> say("foot", True, "Matches foot criteria (" <> have <> ")")
            False -> say("foot", False, "Does not match the foot criteria")
          }
        }
      }
    criteria.AvailabilityIs(value) ->
      case f.availability {
        None -> say("availability", False, "Availability is not on record")
        Some(a) if a == value ->
          say("availability", True, "Matches the availability criteria")
        Some(_) ->
          say("availability", False, "Does not match the availability criteria")
      }
    criteria.EvidenceExists(key) -> {
      let label = criteria.evidence_label(key)
      case list.contains(f.evidence, key) {
        True -> say("evidence:" <> key, True, label)
        False -> say("evidence:" <> key, False, label <> " — not on record")
      }
    }
    criteria.EvidenceWithin(days, kind) -> {
      let at = case kind {
        AnyEvidence -> f.last_evidence_at
        criteria.Footage -> f.last_footage_at
      }
      let key =
        "recency:"
        <> criteria.evidence_kind_to_string(kind)
        <> ":"
        <> int.to_string(days)
      let d = int.to_string(days)
      case at {
        None | Some(0) -> say(key, False, "No dated evidence on record")
        Some(at) -> {
          let ago = int.floor_divide(now - at, day_ms) |> result.unwrap(0)
          case ago <= days {
            True -> say(key, True, "Evidence within the last " <> d <> " days")
            False ->
              say(
                key,
                False,
                "Most recent evidence is older than " <> d <> " days",
              )
          }
        }
      }
    }
    criteria.TrustBandAtLeast(need) ->
      case f.trust_band {
        None ->
          say("minTrustBand", False, "Evidence confidence is not available")
        Some(have) -> {
          let name = trust_band.to_string(have)
          case band_rank(have) >= band_rank(need) {
            True ->
              say(
                "minTrustBand",
                True,
                "Evidence confidence meets the criteria (" <> name <> ")",
              )
            False ->
              say(
                "minTrustBand",
                False,
                "Evidence confidence is below the criteria (" <> name <> ")",
              )
          }
        }
      }
    criteria.CombineResult(protocol) ->
      case list.contains(f.combine, protocol) {
        True ->
          say(
            "combine:" <> protocol,
            True,
            protocol <> " Combine Verified result available",
          )
        False ->
          say(
            "combine:" <> protocol,
            False,
            "No " <> protocol <> " Combine Verified result",
          )
      }
    criteria.CombineMeasurement(protocol, threshold, value) -> {
      let key = "combineValue:" <> protocol
      // Simulated results never reach the facts projection.
      case list.key_find(f.combine_measurements, protocol) {
        Error(Nil) ->
          say(key, False, "No " <> protocol <> " Combine Verified measurement")
        Ok(v) -> {
          let #(met, sign) = case threshold {
            AtLeastValue -> #(v >=. value, "≥")
            AtMostValue -> #(v <=. value, "≤")
          }
          let tail =
            " the club’s threshold ("
            <> sign
            <> " "
            <> criteria.number_text(value)
            <> ")"
          let head = protocol <> " " <> criteria.number_text(v)
          case met {
            True -> say(key, True, head <> " meets" <> tail)
            False -> say(key, False, head <> " does not meet" <> tail)
          }
        }
      }
    }
  }
}

fn bounds(b: AgeBound) -> #(Option(Int), Option(Int)) {
  case b {
    Between(lo, hi) -> #(Some(lo), Some(hi))
    AtLeast(n) -> #(Some(n), None)
    AtMost(n) -> #(None, Some(n))
  }
}

// ------------------------------------------------------------------------------------------------------- match

/// matchPlayerToCriteria's answer.
pub type Match {
  Match(
    matches_required: Bool,
    required: List(Check),
    preferred: List(Check),
    preferred_met: Int,
    criteria_version: String,
  )
}

pub fn match(f: Facts, c: Criteria, now: Int) -> Match {
  let required = list.map(c.required, evaluate(_, f, now))
  let preferred = list.map(c.preferred, evaluate(_, f, now))
  Match(
    matches_required: list.all(required, fn(r) { r.met }),
    required:,
    preferred:,
    preferred_met: list.count(preferred, fn(r) { r.met }),
    criteria_version: criteria.version(c),
  )
}

fn check_json(r: Check) -> Json {
  json.object([
    #("criterionId", json.string(r.criterion_id)),
    #("type", json.string(r.type_)),
    #("key", json.string(r.key)),
    #("met", json.bool(r.met)),
    #("text", json.string(r.text)),
  ])
}

pub fn match_json(m: Match) -> Json {
  json.object([
    #("matchesRequired", json.bool(m.matches_required)),
    #("required", json.array(m.required, check_json)),
    #("preferred", json.array(m.preferred, check_json)),
    #("preferredMet", json.int(m.preferred_met)),
    #("preferredTotal", json.int(list.length(m.preferred))),
    #("policyVersion", json.int(criteria.policy_version)),
    #("criteriaVersion", json.string(m.criteria_version)),
    #("note", json.string(match_note)),
  ])
}

// ------------------------------------------------------------------------------------------------------ briefs

/// briefCriteriaToCanonical: everything a brief carries is required.
pub fn brief_criteria(c: briefs.Criteria) -> Criteria {
  let required =
    list.flatten([
      case c.positions {
        [] -> []
        ps -> [criteria.PositionIn(list.map(ps, position.to_string), False)]
      },
      case c.min_age, c.max_age {
        Some(lo), Some(hi) -> [criteria.Age(Between(lo, hi))]
        Some(lo), None -> [criteria.Age(AtLeast(lo))]
        None, Some(hi) -> [criteria.Age(AtMost(hi))]
        None, None -> []
      },
      option.map(c.max_level, criteria.LevelAtMost) |> option_list,
      option.map(c.radius_km, criteria.WithinRadius) |> option_list,
      option.map(c.foot, fn(f) {
        criteria.FootIn([brief_row.foot_to_string(f)])
      })
        |> option_list,
      option.map(c.availability, criteria.AvailabilityIs) |> option_list,
      list.map(c.evidence_requirements, criteria.EvidenceExists),
      option.map(c.min_trust_band, criteria.TrustBandAtLeast) |> option_list,
      list.map(c.combine_protocols, criteria.CombineResult),
    ])
    |> list.map(criteria.criterion(_, Required))
  Criteria(required:, preferred: [])
}

pub type Reason {
  Reason(key: String, met: Bool, text: String)
}

/// matchBrief (playerMatchesBrief): does the player meet every criterion the brief carries, and why (or why not).
pub fn match_brief(
  f: Facts,
  c: briefs.Criteria,
  now: Int,
) -> #(Bool, List(Reason)) {
  let m = match(f, brief_criteria(c), now)
  #(
    m.matches_required,
    list.map(m.required, fn(r) { Reason(r.key, r.met, r.text) }),
  )
}

pub fn reason_json(r: Reason) -> Json {
  json.object([
    #("key", json.string(r.key)),
    #("met", json.bool(r.met)),
    #("text", json.string(r.text)),
  ])
}

pub fn match_brief_json(m: #(Bool, List(Reason))) -> Json {
  json.object([
    #("matched", json.bool(m.0)),
    #("reasons", json.array(m.1, reason_json)),
  ])
}

// --------------------------------------------------------------------------------------------------------- SQL

/// The band's index, as the facts' band index stores it: -1 for none.
pub const band_rank_sql =
  "COALESCE(CASE f.trust_band WHEN 'limited_evidence' THEN 0 WHEN 'developing_evidence' THEN 1 WHEN 'established_evidence' THEN 2 WHEN 'strong_evidence' THEN 3 WHEN 'very_strong_evidence' THEN 4 END, -1)"

const level_rank_sql =
  "COALESCE(CASE p.level WHEN 'amateur' THEN 0 WHEN 'semi_pro' THEN 1 WHEN 'pro' THEN 2 END, -1)"

fn texts(values: List(String)) -> sqlight.Value {
  json.array(values, json.string) |> json.to_string |> sqlight.text
}

/// Only a Grassroots club with a ground may see distance.
pub fn ground(org: Org) -> Option(#(Float, Float)) {
  case orgs.is_grassroots(org), org.lat, org.lng {
    True, Some(lat), Some(lng) -> Some(#(lat, lng))
    _, _, _ -> None
  }
}

/// The same test as `evaluate`, as an SQL condition over `players p` joined to `player_match_facts f`.
pub fn criterion_sql(c: Criterion, org: Org, now: Int) -> Fragment {
  let today = age.day_of(now)
  case c.check {
    criteria.PositionIn(values, True) ->
      sql.concat([
        sql.text("f.position IN (SELECT value FROM json_each("),
        sql.arg(texts(values)),
        sql.text("))"),
      ])
    criteria.PositionIn(values, False) ->
      sql.concat([
        sql.text(
          "p.id IN (SELECT player_id FROM player_match_facts WHERE position IN (SELECT value FROM json_each(",
        ),
        sql.arg(texts(values)),
        sql.text(
          ")) UNION SELECT player_id FROM player_match_fact_positions WHERE code IN (SELECT value FROM json_each(",
        ),
        sql.arg(texts(values)),
        sql.text(")))"),
      ])
    // Age ≥ n exactly when the birth day is on or before n years before today, so the index can serve it.
    criteria.Age(bound) -> {
      let #(lo, hi) = bounds(bound)
      sql.concat([
        sql.text("p.birth_date IS NOT NULL"),
        case lo {
          Some(n) ->
            sql.concat([
              sql.text(" AND p.birth_date <= "),
              sql.arg(sqlight.text(age.born_by(today, n))),
            ])
          None -> sql.text("")
        },
        case hi {
          Some(n) ->
            sql.concat([
              sql.text(" AND p.birth_date > "),
              sql.arg(sqlight.text(age.born_by(today, n + 1))),
            ])
          None -> sql.text("")
        },
      ])
    }
    criteria.LevelIn(levels) ->
      sql.concat([
        sql.text("p.level IN (SELECT value FROM json_each("),
        sql.arg(texts(list.map(levels, playing_level.to_string))),
        sql.text("))"),
      ])
    // An unknown level does not block.
    criteria.LevelAtMost(level) ->
      sql.concat([
        sql.text(level_rank_sql <> " <= "),
        sql.arg(sqlight.int(level_rank(level))),
      ])
    criteria.WithinRadius(km) ->
      case ground(org) {
        None -> sql.text("0")
        Some(#(lat, lng)) -> {
          let tenths = distance.tenths(At(lat, lng), Columns("p.lat", "p.lng"))
          sql.concat([
            tenths,
            sql.text(" IS NOT NULL AND "),
            tenths,
            sql.text(" / 10.0 <= "),
            sql.arg(sqlight.float(km)),
          ])
        }
      }
    criteria.FootIn(values) ->
      sql.concat([
        sql.text(
          "p.foot IS NOT NULL AND (lower(p.foot) IN (SELECT value FROM json_each(",
        ),
        sql.arg(texts(list.map(values, string.lowercase))),
        sql.text(")) OR lower(p.foot) = 'both')"),
      ])
    criteria.AvailabilityIs(value) ->
      sql.concat([sql.text("f.availability = "), sql.arg(sqlight.text(value))])
    criteria.EvidenceExists(key) ->
      case key {
        "recent_full_match" ->
          sql.concat([
            sql.text("f.last_footage_at > "),
            sql.arg(sqlight.int(now - 180 * day_ms)),
          ])
        "coach_reference" -> sql.text("f.coach_reference = 1")
        "confirmed_current_club" -> sql.text("f.club_confirmed = 1")
        "combine_verified" ->
          sql.text(
            "EXISTS (SELECT 1 FROM player_match_fact_combine mc WHERE mc.player_id = p.id)",
          )
        _ -> sql.text("0")
      }
    // floor((now - at) / day) <= days  ⇔  at > now - (days + 1) · day
    criteria.EvidenceWithin(days, kind) ->
      sql.concat([
        sql.text(case kind {
          AnyEvidence -> "f.last_evidence_at > "
          criteria.Footage -> "f.last_footage_at > "
        }),
        sql.arg(sqlight.int(now - { days + 1 } * day_ms)),
      ])
    criteria.TrustBandAtLeast(band) ->
      sql.concat([
        sql.text("f.trust_band IS NOT NULL AND " <> band_rank_sql <> " >= "),
        sql.arg(sqlight.int(band_rank(band))),
      ])
    criteria.CombineResult(protocol) ->
      sql.concat([
        sql.text(
          "EXISTS (SELECT 1 FROM player_match_fact_combine mc WHERE mc.player_id = p.id AND mc.protocol_id = ",
        ),
        sql.arg(sqlight.text(protocol)),
        sql.text(")"),
      ])
    criteria.CombineMeasurement(protocol, threshold, value) ->
      sql.concat([
        sql.text(
          "EXISTS (SELECT 1 FROM player_match_fact_combine mc WHERE mc.player_id = p.id AND mc.protocol_id = ",
        ),
        sql.arg(sqlight.text(protocol)),
        sql.text(case threshold {
          AtLeastValue -> " AND mc.best_value IS NOT NULL AND mc.best_value >= "
          AtMostValue -> " AND mc.best_value IS NOT NULL AND mc.best_value <= "
        }),
        sql.arg(sqlight.float(value)),
        sql.text(")"),
      ])
  }
}
