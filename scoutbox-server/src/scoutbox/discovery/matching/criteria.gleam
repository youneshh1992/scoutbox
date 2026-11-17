//// The criteria schema (domains/discovery/matching/criteria.mjs). `required` criteria decide whether a player is in
//// the match set; `preferred` ones add context and are counted ("2 of 3 met"), never turned into a percentage, rank
//// or score: a count of the club's own criteria is a fact, a score would be a judgement.

import gleam/bool
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/discovery/briefs
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/vocab/playing_level.{type PlayingLevel}
import scoutbox/vocab/position
import scoutbox/vocab/trust_band.{type TrustBand}

/// Bump when the meaning of a criterion changes, even if its shape does not: a stored explanation is only
/// comparable to a new one at the same policy version.
pub const policy_version = 1

pub const schema_version = 1

/// Published so a club picks a value instead of guessing a spelling that matches nobody. Not enforced: stored data
/// may carry a value this list has not caught up with.
pub const availability_values = [
  "available_now", "end_of_season", "loan_open", "overseas_open", "not_seeking",
]

/// The pathological-input bounds (LIMITS), in the TypeScript order.
pub const limits = [
  #("maxCriteria", 24),
  #("maxRequired", 16),
  #("maxPreferred", 16),
  #("maxPositions", 13),
  #("maxRadiusKm", 20_000),
  #("maxRecencyDays", 3650),
  #("maxNameLength", 80),
  #("maxAvailabilityLength", 40),
  #("watchlistsPerOrg", 60),
]

pub const max_criteria = 24

const max_required = 16

const max_preferred = 16

pub const max_positions = 13

const max_radius_km = 20_000.0

const max_recency_days = 3650

pub const max_name_length = 80

const max_availability_length = 40

pub const watchlists_per_org = 60

/// The operators (OPERATORS): id, arity and what each tests.
pub const operators = [
  #("in", "list", "the fact is one of the listed values"),
  #("equals", "scalar", "the fact equals the value"),
  #("between", "range", "the fact is within the inclusive range"),
  #("gte", "scalar", "the fact is at least the value"),
  #("lte", "scalar", "the fact is at most the value"),
  #(
    "within_radius",
    "scalar",
    "the player is inside the permitted area at this radius",
  ),
  #("within_days", "scalar", "the fact is dated within this many days"),
  #("exists", "key", "the named fact is present and current"),
]

/// The criterion types (CRITERION_TYPES): type, label and the operators it takes. Only facts ScoutBox already
/// holds: nothing inferred from video, and no training-volume proxy for ability.
pub const types = [
  #("position", "Position", ["in"]),
  #("age", "Age", ["between", "gte", "lte"]),
  #("geography", "Recruitment area", ["within_radius"]),
  #("level", "Level", ["lte", "in"]),
  #("foot", "Preferred foot", ["in"]),
  #("availability", "Availability", ["equals"]),
  #("evidence", "Evidence", ["exists"]),
  #("evidence_recency", "Evidence recency", ["within_days"]),
  #("trust_band", "Evidence confidence", ["gte"]),
  #("combine_result", "Combine result", ["exists"]),
  #("combine_measurement", "Combine measurement", ["gte", "lte"]),
]

const feet = ["Left", "Right", "Both"]

// ------------------------------------------------------------------------------------------------------ criteria

pub type Class {
  Required
  Preferred
}

pub fn class_to_string(c: Class) -> String {
  case c {
    Required -> "required"
    Preferred -> "preferred"
  }
}

pub type AgeBound {
  Between(lo: Int, hi: Int)
  AtLeast(Int)
  AtMost(Int)
}

pub type EvidenceKind {
  AnyEvidence
  Footage
}

pub fn evidence_kind_to_string(k: EvidenceKind) -> String {
  case k {
    AnyEvidence -> "any"
    Footage -> "footage"
  }
}

/// A Combine measurement's threshold: at least (`gte`) or at most (`lte`) the value.
pub type Threshold {
  AtLeastValue
  AtMostValue
}

/// What a criterion tests, with its operator.
pub type Test {
  PositionIn(values: List(String), primary_only: Bool)
  Age(AgeBound)
  WithinRadius(km: Float)
  LevelAtMost(PlayingLevel)
  LevelIn(List(PlayingLevel))
  FootIn(List(String))
  AvailabilityIs(String)
  EvidenceExists(String)
  EvidenceWithin(days: Int, kind: EvidenceKind)
  TrustBandAtLeast(TrustBand)
  CombineResult(String)
  CombineMeasurement(protocol: String, threshold: Threshold, value: Float)
}

pub type Criterion {
  Criterion(id: String, class: Class, check: Test)
}

pub type Criteria {
  Criteria(required: List(Criterion), preferred: List(Criterion))
}

pub const no_criteria = Criteria(required: [], preferred: [])

pub fn type_name(t: Test) -> String {
  case t {
    PositionIn(..) -> "position"
    Age(_) -> "age"
    WithinRadius(_) -> "geography"
    LevelAtMost(_) | LevelIn(_) -> "level"
    FootIn(_) -> "foot"
    AvailabilityIs(_) -> "availability"
    EvidenceExists(_) -> "evidence"
    EvidenceWithin(..) -> "evidence_recency"
    TrustBandAtLeast(_) -> "trust_band"
    CombineResult(_) -> "combine_result"
    CombineMeasurement(..) -> "combine_measurement"
  }
}

pub fn operator_name(t: Test) -> String {
  case t {
    PositionIn(..) | LevelIn(_) | FootIn(_) -> "in"
    Age(Between(..)) -> "between"
    Age(AtLeast(_)) | TrustBandAtLeast(_) -> "gte"
    Age(AtMost(_)) | LevelAtMost(_) -> "lte"
    WithinRadius(_) -> "within_radius"
    AvailabilityIs(_) -> "equals"
    EvidenceExists(_) | CombineResult(_) -> "exists"
    EvidenceWithin(..) -> "within_days"
    CombineMeasurement(threshold: AtLeastValue, ..) -> "gte"
    CombineMeasurement(threshold: AtMostValue, ..) -> "lte"
  }
}

/// A number as JavaScript prints it in text: `30`, not `30.0`.
pub fn number_text(f: Float) -> String {
  json.to_string(json_text.number(f))
}

/// A criterion's body (`normalise`'s output), each value as JSON, in the order the TypeScript record holds them.
pub type Value {
  One(String, Json)
  Many(List(String), Json)
}

fn body(t: Test) -> List(#(String, Value)) {
  let one = fn(s) { One(s, json.string(s)) }
  let many = fn(xs) { Many(xs, json.array(xs, json.string)) }
  let int_one = fn(n) { One(int.to_string(n), json.int(n)) }
  case t {
    PositionIn(values, primary_only) -> [
      #("values", many(values)),
      #(
        "primaryOnly",
        One(
          bool.to_string(primary_only) |> string.lowercase,
          json.bool(primary_only),
        ),
      ),
    ]
    Age(Between(lo, hi)) -> [
      #(
        "values",
        Many(
          [int.to_string(lo), int.to_string(hi)],
          json.array([lo, hi], json.int),
        ),
      ),
    ]
    Age(AtLeast(n)) | Age(AtMost(n)) -> [#("value", int_one(n))]
    WithinRadius(km) -> [#("value", One(number_text(km), json_text.number(km)))]
    LevelAtMost(l) -> [#("value", one(playing_level.to_string(l)))]
    LevelIn(ls) -> [#("values", many(list.map(ls, playing_level.to_string)))]
    FootIn(values) -> [#("values", many(values))]
    AvailabilityIs(v) | EvidenceExists(v) | CombineResult(v) -> [
      #("value", one(v)),
    ]
    EvidenceWithin(days, kind) -> [
      #("value", int_one(days)),
      #("evidenceKind", one(evidence_kind_to_string(kind))),
    ]
    TrustBandAtLeast(b) -> [#("value", one(trust_band.to_string(b)))]
    CombineMeasurement(protocol, _, value) -> [
      #("protocol", one(protocol)),
      #("value", One(number_text(value), json_text.number(value))),
    ]
  }
}

/// criterionId: the same test has the same id, whatever the key order. A list's values are sorted as text.
pub fn criterion_id(t: Test) -> String {
  let parts =
    body(t)
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
    |> list.map(fn(kv) {
      kv.0
      <> "="
      <> case kv.1 {
        One(s, _) -> s
        Many(xs, _) -> list.sort(xs, utf16_compare) |> string.join("|")
      }
    })
  type_name(t)
  <> ":"
  <> operator_name(t)
  <> case parts {
    [] -> ""
    _ -> ":" <> string.join(parts, ",")
  }
}

pub fn criterion(t: Test, class: Class) -> Criterion {
  Criterion(id: criterion_id(t), class:, check: t)
}

pub fn criterion_json(c: Criterion) -> Json {
  json.object([
    #("id", json.string(c.id)),
    #("type", json.string(type_name(c.check))),
    #("operator", json.string(operator_name(c.check))),
    #("class", json.string(class_to_string(c.class))),
    ..list.map(body(c.check), fn(kv) {
      #(kv.0, case kv.1 {
        One(_, j) | Many(_, j) -> j
      })
    })
  ])
}

pub fn criteria_json(c: Criteria) -> Json {
  json.object([
    #("required", json.array(c.required, criterion_json)),
    #("preferred", json.array(c.preferred, criterion_json)),
    #("schemaVersion", json.int(schema_version)),
  ])
}

// ------------------------------------------------------------------------------------------------------ version

/// criteriaVersion: lets a watchlist tell "the criteria changed" from "the criteria were re-saved".
pub fn version(c: Criteria) -> String {
  let line = fn(cs: List(Criterion)) {
    list.map(cs, fn(c) { c.id }) |> list.sort(utf16_compare) |> string.join(";")
  }
  "cv1:" <> hash32(line(c.required) <> "#" <> line(c.preferred))
}

/// FNV-1a over the UTF-16 code units, as `hash32` reads `charCodeAt`.
fn hash32(s: String) -> String {
  let h =
    list.fold(utf16_units(s), 0x811c9dc5, fn(h, unit) {
      int.bitwise_and(
        int.bitwise_exclusive_or(h, unit) * 0x01000193,
        0xFFFFFFFF,
      )
    })
  int.to_base16(h) |> string.lowercase |> string.pad_start(8, "0")
}

fn utf16_units(s: String) -> List(Int) {
  string.to_utf_codepoints(s)
  |> list.flat_map(fn(cp) {
    let n = string.utf_codepoint_to_int(cp)
    case n > 0xFFFF {
      True -> {
        let m = n - 0x10000
        [0xD800 + m / 0x400, 0xDC00 + m % 0x400]
      }
      False -> [n]
    }
  })
}

/// JavaScript's default sort order: by UTF-16 code unit.
pub fn utf16_compare(a: String, b: String) -> order.Order {
  compare_units(utf16_units(a), utf16_units(b))
}

fn compare_units(a: List(Int), b: List(Int)) -> order.Order {
  case a, b {
    [], [] -> order.Eq
    [], _ -> order.Lt
    _, [] -> order.Gt
    [x, ..xs], [y, ..ys] ->
      case int.compare(x, y) {
        order.Eq -> compare_units(xs, ys)
        o -> o
      }
  }
}

// ----------------------------------------------------------------------------------------------------- describe

fn describe_one(c: Criterion) -> String {
  let sign = fn(t: Threshold) {
    case t {
      AtLeastValue -> "≥"
      AtMostValue -> "≤"
    }
  }
  case c.check {
    PositionIn(values, primary_only) ->
      string.join(values, " / ")
      <> case primary_only {
        True -> " (primary)"
        False -> ""
      }
    Age(Between(lo, hi)) -> int.to_string(lo) <> "–" <> int.to_string(hi)
    Age(AtLeast(n)) -> "age ≥ " <> int.to_string(n)
    Age(AtMost(n)) -> "age ≤ " <> int.to_string(n)
    WithinRadius(km) -> "within " <> number_text(km) <> " km"
    LevelIn(ls) -> list.map(ls, playing_level.to_string) |> string.join(" / ")
    LevelAtMost(l) -> "up to " <> playing_level.to_string(l)
    FootIn(values) -> string.join(values, " / ")
    AvailabilityIs(v) -> v
    EvidenceExists(key) -> evidence_label(key)
    EvidenceWithin(days, _) ->
      "evidence within " <> int.to_string(days) <> " days"
    TrustBandAtLeast(b) ->
      string.replace(trust_band.to_string(b), "_", " ") <> " or higher"
    CombineResult(p) -> p <> " result available"
    CombineMeasurement(protocol, t, value) ->
      protocol <> " " <> sign(t) <> " " <> number_text(value)
  }
}

pub fn evidence_label(key: String) -> String {
  list.key_find(briefs.evidence_requirements, key) |> result.unwrap(key)
}

/// describeCriteria: each criterion in words, by class.
pub fn describe(c: Criteria) -> Json {
  json.object([
    #("required", json.array(list.map(c.required, describe_one), json.string)),
    #("preferred", json.array(list.map(c.preferred, describe_one), json.string)),
  ])
}

// ----------------------------------------------------------------------------------------------------- validate

/// A value a criterion carries as written: text or a number.
pub type Scalar {
  Text(String)
  Number(Float)
}

/// One criterion as the editor writes it. The fields a type does not use are absent.
pub type Raw {
  Raw(
    type_: Option(String),
    operator: Option(String),
    value: Option(Scalar),
    values: Option(List(Scalar)),
    primary_only: Option(Bool),
    evidence_kind: Option(String),
    protocol: Option(String),
  )
}

pub const blank =
  Raw(
    type_: None,
    operator: None,
    value: None,
    values: None,
    primary_only: None,
    evidence_kind: None,
    protocol: None,
  )

/// Who is writing the criteria: only a Grassroots club may write a distance criterion, and a Combine protocol must
/// be one the registry knows when `protocols` is given.
pub type Context {
  Context(grassroots: Bool, protocols: Option(List(String)))
}

pub type Detail {
  Detail(
    index: Int,
    class: Class,
    type_: Option(String),
    error: String,
    supported: Option(List(String)),
  )
}

pub type Refusal {
  TooMany
  TooManyInClass
  Prohibited(List(String))
  Invalid(List(Detail))
}

fn scalar_text(s: Scalar) -> String {
  case s {
    Text(t) -> t
    Number(n) -> number_text(n)
  }
}

/// `String(v)` of a value that may be absent.
fn js_string(v: Option(Scalar)) -> String {
  case v {
    Some(s) -> scalar_text(s)
    None -> "undefined"
  }
}

fn uniq_strings(values: Option(List(Scalar))) -> List(String) {
  option.unwrap(values, []) |> list.map(scalar_text) |> list.unique
}

/// `Number.isInteger`: a number with no fraction.
fn whole(v: Option(Scalar)) -> Result(Int, Nil) {
  case v {
    Some(Number(n)) ->
      case float.floor(n) == n && float.absolute_value(n) <. 9.0e15 {
        True -> Ok(float.truncate(n))
        False -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

/// isProhibitedCriterion: a protected characteristic, matched as a brief's field names are.
pub fn is_prohibited(type_: String) -> Bool {
  let assert Ok(not_letters) = regexp.from_string("[^a-z]+")
  let k = regexp.replace(not_letters, string.lowercase(type_), "_")
  list.any(briefs.prohibited_fields, fn(p) { k == p || string.contains(k, p) })
}

/// validateCriteria: the criteria as typed tests, or why they cannot be saved as written.
pub fn validate(
  required: List(Raw),
  preferred: List(Raw),
  ctx: Context,
) -> Result(Criteria, Refusal) {
  let raw =
    list.append(
      list.map(required, fn(r) { #(r, Required) }),
      list.map(preferred, fn(r) { #(r, Preferred) }),
    )
  use <- bool.guard(list.length(raw) > max_criteria, Error(TooMany))
  let prohibited =
    list.filter_map(raw, fn(r) {
      case { r.0 }.type_ {
        Some(t) ->
          case is_prohibited(t) {
            True -> Ok(t)
            False -> Error(Nil)
          }
        None -> Error(Nil)
      }
    })
  use <- bool.guard(
    prohibited != [],
    Error(Prohibited(list.unique(prohibited))),
  )
  let #(details, out, _) =
    list.index_fold(raw, #([], #([], []), []), fn(acc, r, i) {
      let #(details, #(req, pref), seen) = acc
      let #(c, class) = r
      case judge(c, ctx) {
        Error(#(error, supported)) -> #(
          [Detail(i, class, c.type_, error, supported), ..details],
          #(req, pref),
          seen,
        )
        Ok(t) -> {
          let crit = criterion(t, class)
          let key = class_to_string(class) <> ":" <> crit.id
          // A duplicate would double-count in the preferred coverage.
          case list.contains(seen, key), class {
            True, _ -> acc
            False, Required -> #(details, #([crit, ..req], pref), [key, ..seen])
            False, Preferred -> #(details, #(req, [crit, ..pref]), [key, ..seen])
          }
        }
      }
    })
  let required = list.reverse(out.0)
  let preferred = list.reverse(out.1)
  case details {
    [_, ..] -> Error(Invalid(list.reverse(details)))
    [] ->
      case
        list.length(required) > max_required
        || list.length(preferred) > max_preferred
      {
        True -> Error(TooManyInClass)
        False -> Ok(Criteria(required:, preferred:))
      }
  }
}

fn supported_by(type_: String) -> Result(List(String), Nil) {
  list.find(types, fn(t) { t.0 == type_ }) |> result.map(fn(t) { t.2 })
}

/// One criterion's test, or its refusal code (with the supported operators, for an unsupported one).
fn judge(
  c: Raw,
  ctx: Context,
) -> Result(Test, #(String, Option(List(String)))) {
  let refuse = fn(code) { Error(#(code, None)) }
  let type_ = option.unwrap(c.type_, "")
  case supported_by(type_) {
    Error(Nil) -> refuse("CRITERION_TYPE_UNKNOWN")
    Ok(supported) -> {
      let op = option.unwrap(c.operator, "")
      case
        list.any(operators, fn(o) { o.0 == op }),
        list.contains(supported, op)
      {
        False, _ -> refuse("CRITERION_OPERATOR_UNKNOWN")
        True, False ->
          Error(#("CRITERION_OPERATOR_NOT_SUPPORTED", Some(supported)))
        True, True ->
          judge_type(type_, op, c, ctx)
          |> result.map_error(fn(code) { #(code, None) })
      }
    }
  }
}

fn judge_type(
  type_: String,
  op: String,
  c: Raw,
  ctx: Context,
) -> Result(Test, String) {
  case type_ {
    "position" -> {
      let values = uniq_strings(c.values)
      let known = list.map(position.pairs, fn(p) { p.0 })
      use <- bool.guard(values == [], Error("CRITERION_VALUES_REQUIRED"))
      use <- bool.guard(
        list.length(values) > max_positions,
        Error("CRITERION_TOO_MANY_VALUES"),
      )
      use <- bool.guard(
        !list.all(values, list.contains(known, _)),
        Error("CRITERION_VALUE_UNKNOWN"),
      )
      Ok(PositionIn(values, c.primary_only == Some(True)))
    }
    "age" -> {
      let in_range = fn(v) {
        case whole(v) {
          Ok(n) if n >= 5 && n <= 60 -> Ok(n)
          _ -> Error("CRITERION_VALUE_OUT_OF_RANGE")
        }
      }
      case op {
        "between" -> {
          let values = option.unwrap(c.values, [])
          use nums <- result.try(
            list.try_map(values, fn(v) { in_range(Some(v)) }),
          )
          case nums {
            [lo, hi] if lo <= hi -> Ok(Age(Between(lo, hi)))
            _ -> Error("CRITERION_RANGE_INVALID")
          }
        }
        "gte" -> in_range(c.value) |> result.map(fn(n) { Age(AtLeast(n)) })
        _ -> in_range(c.value) |> result.map(fn(n) { Age(AtMost(n)) })
      }
    }
    "geography" ->
      case c.value {
        // Refused rather than clamped to something the club did not ask for.
        Some(Number(km)) if km >. 0.0 && km <=. max_radius_km ->
          case ctx.grassroots {
            // Only a Grassroots club may see distance, so for anyone else the criterion would match nobody.
            False -> Error("CRITERION_NOT_AVAILABLE")
            True -> Ok(WithinRadius(float_min(km, 50.0)))
          }
        _ -> Error("CRITERION_VALUE_OUT_OF_RANGE")
      }
    "level" ->
      case op {
        "in" -> {
          let values = uniq_strings(c.values)
          use <- bool.guard(values == [], Error("CRITERION_VALUES_REQUIRED"))
          use levels <- result.map(
            list.try_map(values, playing_level.from_string)
            |> result.replace_error("CRITERION_VALUE_UNKNOWN"),
          )
          LevelIn(case ctx.grassroots {
            True -> list.filter(levels, fn(l) { l != playing_level.Pro })
            False -> levels
          })
        }
        _ ->
          case playing_level.from_string(js_string(c.value)) {
            Error(Nil) -> Error("CRITERION_VALUE_UNKNOWN")
            Ok(playing_level.Pro) if ctx.grassroots ->
              Ok(LevelAtMost(playing_level.SemiPro))
            Ok(l) -> Ok(LevelAtMost(l))
          }
      }
    "foot" -> {
      let values = uniq_strings(c.values)
      use <- bool.guard(values == [], Error("CRITERION_VALUES_REQUIRED"))
      use <- bool.guard(
        !list.all(values, list.contains(feet, _)),
        Error("CRITERION_VALUE_UNKNOWN"),
      )
      Ok(FootIn(values))
    }
    "availability" ->
      case c.value {
        Some(Text(t)) ->
          case string.trim(t) {
            "" -> Error("CRITERION_VALUES_REQUIRED")
            // Refused rather than cut to a value the club did not write.
            trimmed ->
              case input.utf16_length(trimmed) > max_availability_length {
                True -> Error("CRITERION_VALUE_OUT_OF_RANGE")
                False -> Ok(AvailabilityIs(trimmed))
              }
          }
        _ -> Error("CRITERION_VALUES_REQUIRED")
      }
    "evidence" ->
      case c.value {
        Some(Text(key)) ->
          case list.key_find(briefs.evidence_requirements, key) {
            Ok(_) -> Ok(EvidenceExists(key))
            Error(Nil) -> Error("CRITERION_VALUE_UNKNOWN")
          }
        _ -> Error("CRITERION_VALUE_UNKNOWN")
      }
    "evidence_recency" ->
      case whole(c.value) {
        Ok(d) if d >= 1 && d <= max_recency_days ->
          case c.evidence_kind {
            None | Some("") | Some("footage") -> Ok(EvidenceWithin(d, Footage))
            Some("any") -> Ok(EvidenceWithin(d, AnyEvidence))
            Some(_) -> Error("CRITERION_VALUE_UNKNOWN")
          }
        _ -> Error("CRITERION_VALUE_OUT_OF_RANGE")
      }
    "trust_band" ->
      case c.value {
        Some(Text(t)) ->
          trust_band.from_string(t)
          |> result.map(TrustBandAtLeast)
          |> result.replace_error("CRITERION_VALUE_UNKNOWN")
        _ -> Error("CRITERION_VALUE_UNKNOWN")
      }
    "combine_result" -> {
      let p = option.map(c.value, scalar_text) |> option.unwrap("")
      use <- bool.guard(
        string.trim(p) == "",
        Error("CRITERION_VALUES_REQUIRED"),
      )
      use <- bool.guard(
        !known_protocol(ctx, p),
        Error("CRITERION_VALUE_UNKNOWN"),
      )
      Ok(CombineResult(p))
    }
    _ -> {
      let p = option.unwrap(c.protocol, "")
      use <- bool.guard(
        string.trim(p) == "",
        Error("CRITERION_VALUES_REQUIRED"),
      )
      use <- bool.guard(
        !known_protocol(ctx, p),
        Error("CRITERION_VALUE_UNKNOWN"),
      )
      case c.value {
        Some(Number(v)) ->
          Ok(CombineMeasurement(
            p,
            case op {
              "gte" -> AtLeastValue
              _ -> AtMostValue
            },
            v,
          ))
        _ -> Error("CRITERION_VALUE_OUT_OF_RANGE")
      }
    }
  }
}

fn known_protocol(ctx: Context, p: String) -> Bool {
  case ctx.protocols {
    Some(known) -> list.contains(known, p)
    None -> True
  }
}

fn float_min(a: Float, b: Float) -> Float {
  case a <. b {
    True -> a
    False -> b
  }
}

fn detail_json(d: Detail) -> Json {
  json.object(
    list.append(
      [
        #("index", json.int(d.index)),
        #("class", json.string(class_to_string(d.class))),
        #("type", json.nullable(d.type_, json.string)),
        #("error", json.string(d.error)),
      ],
      case d.supported {
        Some(ops) -> [#("supported", json.array(ops, json.string))]
        None -> []
      },
    ),
  )
}

/// The refusal as the TypeScript validator returns it, and the route sends it whole.
pub fn refusal_json(r: Refusal) -> Json {
  json.object(case r {
    TooMany -> [
      #("ok", json.bool(False)),
      #("error", json.string("CRITERIA_TOO_MANY")),
      #("limit", json.int(max_criteria)),
      #(
        "message",
        json.string(
          "A criteria set may hold at most "
          <> int.to_string(max_criteria)
          <> " criteria.",
        ),
      ),
    ]
    Prohibited(found) -> [
      #("ok", json.bool(False)),
      #("error", json.string("CRITERION_PROHIBITED")),
      #("prohibited", json.array(found, json.string)),
      #(
        "message",
        json.string(
          "Players can never be matched on a protected characteristic.",
        ),
      ),
    ]
    Invalid(details) -> [
      #("ok", json.bool(False)),
      #("error", json.string("CRITERIA_INVALID")),
      #("details", json.array(details, detail_json)),
      #("message", json.string("These criteria cannot be saved as written.")),
    ]
    TooManyInClass -> [
      #("ok", json.bool(False)),
      #("error", json.string("CRITERIA_TOO_MANY")),
      #("message", json.string("Too many criteria in one class.")),
    ]
  })
}

/// validateCriteria's whole answer: `{ ok: true, criteria }` or the refusal.
pub fn validation_json(r: Result(Criteria, Refusal)) -> Json {
  case r {
    Ok(c) ->
      json.object([#("ok", json.bool(True)), #("criteria", criteria_json(c))])
    Error(refusal) -> refusal_json(refusal)
  }
}

// -------------------------------------------------------------------------------------------------------- input

/// A value as the editor sends it: text or a number.
fn scalar_check() -> input.Check(Scalar) {
  let either = input.number_or_text(1_000_000)
  fn(v) {
    case either(v) {
      Ok(input.Number(n)) -> Ok(Number(n))
      Ok(input.Text(t)) -> Ok(Text(t))
      Error(e) -> Error(e)
    }
  }
}

/// One criterion as the editor writes it (schemas.mjs `Criterion`). The fields a type does not use are absent; the
/// type, operator and values are judged by `validate`, which names the criterion it refuses.
fn raw_check() -> input.Check(Raw) {
  input.object({
    use type_ <- input.field("type", input.required(input.text(1_000_000)))
    use operator <- input.field(
      "operator",
      input.nullish(input.text(1_000_000)),
    )
    use value <- input.field("value", input.nullish(scalar_check()))
    use values <- input.field(
      "values",
      input.nullish(input.items(scalar_check(), max_positions)),
    )
    use primary_only <- input.field(
      "primaryOnly",
      input.nullish(input.boolean()),
    )
    use evidence_kind <- input.field(
      "evidenceKind",
      input.nullish(input.text(1_000_000)),
    )
    use protocol <- input.field(
      "protocol",
      input.nullish(input.text(1_000_000)),
    )
    input.done(Raw(
      type_: Some(type_),
      operator:,
      value:,
      values:,
      primary_only:,
      evidence_kind:,
      protocol:,
    ))
  })
}

/// A criteria set as the editor sends it (schemas.mjs `Criteria`): its required and preferred criteria. `validate`
/// counts them, refusing too many.
pub fn raw_criteria() -> input.Check(#(List(Raw), List(Raw))) {
  input.object({
    use required <- input.field(
      "required",
      input.nullish(input.items(raw_check(), 1_000_000)),
    )
    use preferred <- input.field(
      "preferred",
      input.nullish(input.items(raw_check(), 1_000_000)),
    )
    input.done(#(option.unwrap(required, []), option.unwrap(preferred, [])))
  })
}

/// The criteria a club sends, validated for `org`'s level and the Combine registry.
pub fn validate_raw(
  raw: #(List(Raw), List(Raw)),
  grassroots: Bool,
  protocols: List(String),
) -> Result(Criteria, Refusal) {
  validate(raw.0, raw.1, Context(grassroots:, protocols: Some(protocols)))
}
