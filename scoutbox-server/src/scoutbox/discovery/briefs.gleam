//// Recruitment Briefs (domains/discovery/shared.mjs and repositories/discovery.mjs `briefs`): a club's own
//// criteria for Nobody Missed. Boolean rules only, with no weights and no hidden criteria, and never a protected
//// characteristic.

import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/development/combine_protocols
import scoutbox/platform/json_text
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/recruitment_brief_history as history_row
import scoutbox/rows/recruitment_brief_values as value_row
import scoutbox/rows/recruitment_briefs as row
import scoutbox/vocab/brief_status.{type BriefStatus}
import scoutbox/vocab/playing_level.{type PlayingLevel}
import scoutbox/vocab/position.{type Position}
import scoutbox/vocab/trust_band.{type TrustBand}
import sqlight

pub const coverage_policy_version = 1

pub const title_max = 120

pub const availability_max = 40

pub const per_org = 40

pub const evidence_requirements = [
  #("recent_full_match", "Recent full match available"),
  #("coach_reference", "Verified coach reference available"),
  #("confirmed_current_club", "Current club confirmed"),
  #("combine_verified", "Combine Verified result available"),
]

/// Protected characteristics, plus the proxies a brief could smuggle one through.
pub const prohibited_fields = [
  "race", "ethnicity", "skin_colour", "skin_color", "religion", "faith", "caste",
  "disability", "medical_condition", "mental_health", "gender_identity",
  "sexuality", "sexual_orientation", "socioeconomic", "social_background",
  "family_income", "school_type", "postcode_deprivation", "deprivation",
  "maturity", "biological_age", "physical_maturity", "immigration_status",
  "national_origin",
]

pub fn position_group(p: Position) -> String {
  case p {
    position.GK -> "GK"
    position.CB | position.RB | position.LB | position.RWB | position.LWB ->
      "DEF"
    position.CDM | position.CM | position.CAM -> "MID"
    position.RW | position.LW | position.ST | position.CF -> "ATT"
  }
}

pub fn can_transition(from: BriefStatus, to: BriefStatus) -> Bool {
  case from, to {
    brief_status.Draft, brief_status.Active
    | brief_status.Draft, brief_status.Archived
    | brief_status.Active, brief_status.Paused
    | brief_status.Active, brief_status.Closed
    | brief_status.Active, brief_status.Archived
    | brief_status.Paused, brief_status.Active
    | brief_status.Paused, brief_status.Closed
    | brief_status.Paused, brief_status.Archived
    | brief_status.Closed, brief_status.Active
    | brief_status.Closed, brief_status.Archived
    -> True
    _, _ -> False
  }
}

// ------------------------------------------------------------------------------------------------------ criteria

pub type Criteria {
  Criteria(
    positions: List(Position),
    min_age: Option(Int),
    max_age: Option(Int),
    radius_km: Option(Float),
    max_level: Option(PlayingLevel),
    foot: Option(row.Foot),
    availability: Option(String),
    evidence_requirements: List(String),
    min_trust_band: Option(TrustBand),
    combine_protocols: List(String),
  )
}

/// A JavaScript number as JavaScript prints it: 50, not 50.0.
fn number(f: Float) -> Json {
  json_text.number(f)
}

fn number_text(f: Float) -> String {
  json.to_string(number(f))
}

pub fn criteria_json(c: Criteria) -> Json {
  json.object([
    #("positions", json.array(c.positions, position.to_json)),
    #(
      "positionGroups",
      json.array(
        list.unique(list.map(c.positions, position_group)),
        json.string,
      ),
    ),
    #("minAge", json.nullable(c.min_age, json.int)),
    #("maxAge", json.nullable(c.max_age, json.int)),
    #("radiusKm", json.nullable(c.radius_km, number)),
    #("maxLevel", json.nullable(c.max_level, playing_level.to_json)),
    #("foot", json.nullable(c.foot, row.foot_to_json)),
    #("availability", json.nullable(c.availability, json.string)),
    #("evidenceRequirements", json.array(c.evidence_requirements, json.string)),
    #("minTrustBand", json.nullable(c.min_trust_band, trust_band.to_json)),
    #("combineProtocols", json.array(c.combine_protocols, json.string)),
  ])
}

/// explainBriefCriteria: the criteria as the brief's own page states them.
pub fn explain(c: Criteria) -> Json {
  let item = fn(key, label, value) {
    json.object([
      #("key", json.string(key)),
      #("label", json.string(label)),
      #("value", json.string(value)),
    ])
  }
  let any = fn(n: Option(Int)) {
    option.map(n, int.to_string) |> option.unwrap("any")
  }
  list.flatten([
    case c.positions {
      [] -> []
      ps -> [
        item(
          "positions",
          "Position",
          string.join(list.map(ps, position.to_string), ", "),
        ),
      ]
    },
    case c.min_age, c.max_age {
      None, None -> []
      lo, hi -> [item("age", "Age", any(lo) <> "–" <> any(hi))]
    },
    case c.radius_km {
      Some(r) -> [item("radius", "Within", number_text(r) <> " km")]
      None -> []
    },
    case c.max_level {
      Some(l) -> [item("maxLevel", "Up to level", playing_level.to_string(l))]
      None -> []
    },
    case c.foot {
      Some(f) -> [item("foot", "Foot", row.foot_to_string(f))]
      None -> []
    },
    case c.availability {
      Some(a) -> [item("availability", "Availability", a)]
      None -> []
    },
    list.map(c.evidence_requirements, fn(e) {
      item(
        "evidence:" <> e,
        "Evidence",
        list.key_find(evidence_requirements, e) |> result.unwrap(e),
      )
    }),
    case c.min_trust_band {
      Some(b) -> [
        item(
          "minTrustBand",
          "Minimum evidence confidence",
          trust_band.to_string(b),
        ),
      ]
      None -> []
    },
    list.map(c.combine_protocols, fn(p) {
      item("combine:" <> p, "Combine", p <> " result available")
    }),
  ])
  |> json.preprocessed_array
}

// ---------------------------------------------------------------------------------------------------- validation

/// A brief naming a protected characteristic is refused under its own code, whatever else is wrong with it. The
/// body's keys, folded as `k.toLowerCase().replace(/[^a-z]+/g, '_')`, are matched whole or in part.
pub fn prohibited(body: Dynamic) -> Option(List(String)) {
  decode.run(body, decode.dict(decode.string, decode.dynamic))
  |> result.map(dict.keys)
  |> result.unwrap([])
  |> prohibited_keys
}

/// The prohibited fields among a body's keys, folded.
pub fn prohibited_keys(keys: List(String)) -> Option(List(String)) {
  let keys = list.map(keys, fold_key)
  case
    list.filter(keys, fn(k) {
      list.any(prohibited_fields, fn(p) { k == p || string.contains(k, p) })
    })
  {
    [] -> None
    found -> Some(found)
  }
}

fn fold_key(k: String) -> String {
  let assert Ok(not_letters) = regexp.from_string("[^a-z]+")
  regexp.replace(not_letters, string.lowercase(k), "_")
}

pub fn prohibited_json(found: List(String)) -> Json {
  json.object([
    #("ok", json.bool(False)),
    #("error", json.string("BRIEF_CRITERION_PROHIBITED")),
    #("prohibited", json.array(found, json.string)),
    #(
      "message",
      json.string(
        "A recruitment brief can never filter players by a protected characteristic.",
      ),
    ),
  ])
}

/// A brief's fields as the routes' shapes read them (types and lengths checked), or as a stored brief holds them
/// for an edit to be judged against. `validate` judges the vocabularies and ranges.
pub type Fields {
  Fields(
    title: Option(String),
    positions: Option(List(String)),
    min_age: Option(Float),
    max_age: Option(Float),
    radius_km: Option(Float),
    max_level: Option(String),
    foot: Option(String),
    availability: Option(String),
    evidence_requirements: Option(List(String)),
    min_trust_band: Option(String),
    combine_protocols: Option(List(String)),
    active_from: Option(String),
    active_until: Option(String),
  )
}

pub type Valid {
  Valid(
    title: String,
    criteria: Criteria,
    active_from: Option(String),
    active_until: Option(String),
  )
}

/// One refused field, as `details` lists it.
pub type Detail {
  Detail(field: String, error: String, unknown: List(String))
}

fn detail_json(d: Detail) -> Json {
  json.object(
    list.append(
      [#("field", json.string(d.field)), #("error", json.string(d.error))],
      case d.unknown {
        [] -> []
        u -> [#("unknown", json.array(u, json.string))]
      },
    ),
  )
}

pub fn invalid_json(details: List(Detail)) -> Json {
  json.object([
    #("ok", json.bool(False)),
    #("error", json.string("BRIEF_INVALID")),
    #("details", json.array(details, detail_json)),
    #(
      "message",
      json.string("This recruitment brief cannot be saved as written."),
    ),
  ])
}

pub fn valid_json(v: Valid) -> Json {
  json.object([
    #("ok", json.bool(True)),
    #("title", json.string(v.title)),
    #("criteria", criteria_json(v.criteria)),
    #("activeFrom", json.nullable(v.active_from, json.string)),
    #("activeUntil", json.nullable(v.active_until, json.string)),
  ])
}

/// validateRecruitmentBrief whole: a protected criterion is refused under its own code, whatever else is wrong;
/// then the vocabularies and ranges. `keys` are the body's keys as sent.
pub fn validate_body(keys: List(String), f: Fields, grassroots: Bool) -> Json {
  case prohibited_keys(keys) {
    Some(found) -> prohibited_json(found)
    None ->
      case validate(f, grassroots) {
        Ok(v) -> valid_json(v)
        Error(details) -> invalid_json(details)
      }
  }
}

pub fn fields_of(b: row.Row, c: Criteria) -> Fields {
  Fields(
    title: Some(b.title),
    positions: Some(list.map(c.positions, position.to_string)),
    min_age: option.map(c.min_age, int.to_float),
    max_age: option.map(c.max_age, int.to_float),
    radius_km: c.radius_km,
    max_level: option.map(c.max_level, playing_level.to_string),
    foot: option.map(c.foot, row.foot_to_string),
    availability: c.availability,
    evidence_requirements: Some(c.evidence_requirements),
    min_trust_band: option.map(c.min_trust_band, trust_band.to_string),
    combine_protocols: Some(c.combine_protocols),
    active_from: b.active_from_date,
    active_until: b.active_until_date,
  )
}

fn whole(f: Float) -> Option(Int) {
  case float.floor(f) == f {
    True -> Some(float.truncate(f))
    False -> None
  }
}

/// validateRecruitmentBrief, after the shape: the vocabularies, ranges and windows, every problem listed.
pub fn validate(f: Fields, grassroots: Bool) -> Result(Valid, List(Detail)) {
  let title = option.unwrap(f.title, "") |> string.trim
  let distinct = fn(xs: Option(List(String))) {
    option.unwrap(xs, []) |> list.unique
  }
  let positions = distinct(f.positions)
  let known_positions = list.filter_map(positions, position.from_string)
  let unknown_positions =
    list.filter(positions, fn(p) { position.from_string(p) |> result.is_error })
  let age = fn(v: Option(Float)) {
    option.then(v, fn(n) {
      case whole(n) {
        Some(i) if i >= 5 && i <= 60 -> Some(Ok(i))
        _ -> Some(Error(Nil))
      }
    })
  }
  let min_age = age(f.min_age)
  let max_age = age(f.max_age)
  let evidence = distinct(f.evidence_requirements)
  let unknown_evidence =
    list.filter(evidence, fn(e) {
      list.key_find(evidence_requirements, e) |> result.is_error
    })
  let protocols = distinct(f.combine_protocols)
  let protocol_ids = list.map(combine_protocols.protocols, fn(p) { p.id })
  let unknown_protocols =
    list.filter(protocols, fn(p) { !list.contains(protocol_ids, p) })
  let level = option.map(f.max_level, playing_level.from_string)
  let band = option.map(f.min_trust_band, trust_band.from_string)
  let foot = option.map(f.foot, row.foot_from_string)
  let day = fn(d: Option(String)) {
    option.map(d, fn(s) { temporal.date_only(s) |> result.is_ok })
  }
  let errors =
    list.flatten([
      case title {
        "" -> [Detail("title", "BRIEF_TITLE_REQUIRED", [])]
        _ -> []
      },
      case unknown_positions {
        [] -> []
        u -> [Detail("positions", "BRIEF_POSITION_UNKNOWN", u)]
      },
      case min_age {
        Some(Error(Nil)) -> [Detail("minAge", "BRIEF_AGE_INVALID", [])]
        _ -> []
      },
      case max_age {
        Some(Error(Nil)) -> [Detail("maxAge", "BRIEF_AGE_INVALID", [])]
        _ -> []
      },
      case f.min_age, f.max_age {
        Some(lo), Some(hi) if lo >. hi -> [
          Detail("ageRange", "BRIEF_AGE_RANGE_INVALID", []),
        ]
        _, _ -> []
      },
      case f.radius_km {
        Some(r) if r <=. 0.0 || r >. 20_000.0 -> [
          Detail("radiusKm", "BRIEF_RADIUS_INVALID", []),
        ]
        // Only a Grassroots club may see distance, so for anyone else the radius would match nobody.
        Some(_) if !grassroots -> [
          Detail("radiusKm", "BRIEF_RADIUS_NOT_AVAILABLE", []),
        ]
        _ -> []
      },
      case level {
        Some(Error(Nil)) -> [Detail("maxLevel", "BRIEF_LEVEL_UNKNOWN", [])]
        _ -> []
      },
      case unknown_evidence {
        [] -> []
        u -> [
          Detail(
            "evidenceRequirements",
            "BRIEF_EVIDENCE_REQUIREMENT_UNKNOWN",
            u,
          ),
        ]
      },
      case band {
        Some(Error(Nil)) -> [
          Detail("minTrustBand", "BRIEF_TRUST_BAND_UNKNOWN", []),
        ]
        _ -> []
      },
      case unknown_protocols {
        [] -> []
        u -> [Detail("combineProtocols", "BRIEF_COMBINE_PROTOCOL_UNKNOWN", u)]
      },
      case foot {
        Some(Error(Nil)) -> [Detail("foot", "BRIEF_FOOT_UNKNOWN", [])]
        _ -> []
      },
      // An unreadable `activeUntil` must not compare as "never passed" and keep a brief live for ever.
      case day(f.active_from) {
        Some(False) -> [Detail("activeFrom", "DATE_INVALID", [])]
        _ -> []
      },
      case day(f.active_until) {
        Some(False) -> [Detail("activeUntil", "DATE_INVALID", [])]
        _ -> []
      },
      case f.active_from, f.active_until {
        Some(from), Some(until) ->
          case string.compare(from, until) {
            order.Gt -> [
              Detail("activeWindow", "BRIEF_WINDOW_INVALID", []),
            ]
            _ -> []
          }
        _, _ -> []
      },
    ])
  case errors {
    [_, ..] -> Error(errors)
    [] ->
      Ok(Valid(
        title:,
        criteria: Criteria(
          positions: known_positions,
          min_age: option.then(min_age, option.from_result),
          max_age: option.then(max_age, option.from_result),
          radius_km: case grassroots {
            True -> Some(float.min(option.unwrap(f.radius_km, 50.0), 50.0))
            False -> f.radius_km
          },
          max_level: case grassroots {
            True -> Some(playing_level.SemiPro)
            False -> option.then(level, option.from_result)
          },
          foot: option.then(foot, option.from_result),
          availability: case f.availability {
            Some("") -> None
            a -> a
          },
          evidence_requirements: evidence,
          min_trust_band: option.then(band, option.from_result),
          combine_protocols: protocols,
        ),
        active_from: f.active_from,
        active_until: f.active_until,
      ))
  }
}

/// `active_from` / `active_until` are UTC calendar days, inclusive. Unreadable bounds close the window.
pub fn is_live_on(b: row.Row, today: String) -> Bool {
  let within = fn(bound: Option(String), ok: fn(String) -> Bool) {
    case bound {
      None -> True
      Some(d) ->
        case temporal.date_only(d) {
          Ok(d) -> ok(d)
          Error(_) -> False
        }
    }
  }
  b.status == brief_status.Active
  && within(b.active_from_date, fn(from) {
    string.compare(today, from) != order.Lt
  })
  && within(b.active_until_date, fn(until) {
    string.compare(today, until) != order.Gt
  })
}

// ------------------------------------------------------------------------------------------------------ store

pub type Brief {
  Brief(row: row.Row, criteria: Criteria)
}

fn values_of(
  read: Read,
  brief_id: id.BriefId,
) -> Result(List(value_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> value_row.columns
      <> " FROM recruitment_brief_values WHERE brief_id = ? ORDER BY kind, ord",
    [id.brief_sql(brief_id)],
    value_row.decoder(),
  )
}

fn load(read: Read, r: row.Row) -> Result(Brief, Fail(e)) {
  use values <- result.map(values_of(read, r.id))
  let of = fn(kind) {
    list.filter(values, fn(v) { v.kind == kind }) |> list.map(fn(v) { v.value })
  }
  Brief(
    row: r,
    criteria: Criteria(
      positions: list.filter_map(of(value_row.Position), position.from_string),
      min_age: r.min_age,
      max_age: r.max_age,
      radius_km: r.radius_km,
      max_level: r.max_level,
      foot: r.foot,
      availability: r.availability,
      evidence_requirements: of(value_row.EvidenceRequirement),
      min_trust_band: r.min_trust_band,
      combine_protocols: of(value_row.CombineProtocol),
    ),
  )
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Brief), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM recruitment_briefs WHERE " <> where,
    args,
    row.decoder(),
  ))
  list.try_map(rows, load(read, _))
}

/// The organisation's briefs, most recently updated first, then id. At most `per_org`, so offset paging is enough.
pub fn for_org(read: Read, org_id: id.OrgId) -> Result(List(Brief), Fail(e)) {
  select(read, "org_id = ? ORDER BY updated_at DESC, id", [id.org_sql(org_id)])
}

/// This organisation's brief, or None: another organisation's id is no brief.
pub fn for_org_by_id(
  read: Read,
  brief_id: id.BriefId,
  org_id: id.OrgId,
) -> Result(Option(Brief), Fail(e)) {
  select(read, "id = ? AND org_id = ?", [
    id.brief_sql(brief_id),
    id.org_sql(org_id),
  ])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

pub fn count_for_org(read: Read, org_id: id.OrgId) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM recruitment_briefs WHERE org_id = ?",
    [id.org_sql(org_id)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

fn write_values(
  tx: Tx,
  brief_id: id.BriefId,
  c: Criteria,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM recruitment_brief_values WHERE brief_id = ?", [
      id.brief_sql(brief_id),
    ]),
  )
  [
    #(value_row.Position, list.map(c.positions, position.to_string)),
    #(value_row.EvidenceRequirement, c.evidence_requirements),
    #(value_row.CombineProtocol, c.combine_protocols),
  ]
  |> list.try_each(fn(group) {
    list.index_map(group.1, fn(value, ord) {
      value_row.Row(brief_id:, kind: group.0, ord:, value:)
    })
    |> list.try_each(value_row.insert(tx, _))
  })
}

/// One trail entry, as auditEntry records it for a club user.
pub type Event {
  Event(
    action: history_row.Action,
    version: Option(Int),
    from: Option(BriefStatus),
    to: Option(BriefStatus),
    criteria_changed: Option(Bool),
  )
}

fn append(
  tx: Tx,
  brief_id: id.BriefId,
  by: #(id.OrgUserId, String),
  at: Int,
  e: Event,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_brief_event(tx))
  history_row.insert(
    tx,
    history_row.Row(
      id: event_id,
      brief_id:,
      at:,
      by_kind: history_row.Org,
      by_id: by.0,
      by_name: Some(by.1),
      action: e.action,
      detail_version: e.version,
      detail_from: e.from,
      detail_to: e.to,
      detail_criteria_changed: e.criteria_changed,
    ),
  )
}

pub type NewBrief {
  NewBrief(
    org_id: id.OrgId,
    valid: Valid,
    role_id: Option(String),
    vacancy_id: Option(String),
    by: #(id.OrgUserId, String),
    at: Int,
  )
}

/// A new brief at version 1, in draft.
pub fn create(tx: Tx, n: NewBrief) -> Result(Brief, Fail(e)) {
  use brief_id <- result.try(id.next_brief(tx))
  let c = n.valid.criteria
  let r =
    row.Row(
      ..row.new(
        id: brief_id,
        org_id: n.org_id,
        title: n.valid.title,
        version: 1,
        status: brief_status.Draft,
        created_by_user_id: n.by.0,
        created_at: n.at,
        updated_at: n.at,
        rev: 1,
      ),
      active_from_date: n.valid.active_from,
      active_until_date: n.valid.active_until,
      role_id: n.role_id,
      vacancy_id: n.vacancy_id,
      created_by_name: Some(n.by.1),
      rev_at: Some(n.at),
      rev_by_user_id: Some(n.by.0),
      rev_by_name: Some(n.by.1),
      min_age: c.min_age,
      max_age: c.max_age,
      radius_km: c.radius_km,
      max_level: c.max_level,
      foot: c.foot,
      availability: c.availability,
      min_trust_band: c.min_trust_band,
    )
  use _ <- result.try(row.insert(tx, r))
  use _ <- result.try(write_values(tx, brief_id, c))
  use _ <- result.map(append(
    tx,
    brief_id,
    n.by,
    n.at,
    Event(history_row.RecruitmentBriefCreated, Some(1), None, None, None),
  ))
  Brief(r, c)
}

pub type Revision {
  Revision(
    status: Option(BriefStatus),
    /// The title and window an edit leaves, when it judged them.
    valid: Option(Valid),
    /// A new criteria version.
    criteria: Option(Criteria),
    events: List(Event),
    by: #(id.OrgUserId, String),
    at: Int,
  )
}

/// Revises the brief: its status, title and window, and, when given, a new criteria version (the version Nobody
/// Missed points at moves on). Every accepted write moves `rev`.
pub fn revise(tx: Tx, b: Brief, r: Revision) -> Result(Brief, Fail(e)) {
  let old = b.row
  let criteria = option.unwrap(r.criteria, b.criteria)
  let next =
    row.Row(
      ..old,
      status: option.unwrap(r.status, old.status),
      title: option.map(r.valid, fn(v) { v.title }) |> option.unwrap(old.title),
      active_from_date: case r.valid {
        Some(v) -> v.active_from
        None -> old.active_from_date
      },
      active_until_date: case r.valid {
        Some(v) -> v.active_until
        None -> old.active_until_date
      },
      version: case r.criteria {
        Some(_) -> old.version + 1
        None -> old.version
      },
      updated_at: r.at,
      rev: old.rev + 1,
      rev_at: Some(r.at),
      rev_by_user_id: Some(r.by.0),
      rev_by_name: Some(r.by.1),
      min_age: criteria.min_age,
      max_age: criteria.max_age,
      radius_km: criteria.radius_km,
      max_level: criteria.max_level,
      foot: criteria.foot,
      availability: criteria.availability,
      min_trust_band: criteria.min_trust_band,
    )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE recruitment_briefs SET status = ?, title = ?, active_from_date = ?, active_until_date = ?, version = ?, updated_at = ?, rev = ?, rev_at = ?, rev_by_user_id = ?, rev_by_name = ?, min_age = ?, max_age = ?, radius_km = ?, max_level = ?, foot = ?, availability = ?, min_trust_band = ? WHERE id = ? AND rev = ?",
      [
        sqlight.text(brief_status.to_string(next.status)),
        sqlight.text(next.title),
        sqlight.nullable(sqlight.text, next.active_from_date),
        sqlight.nullable(sqlight.text, next.active_until_date),
        sqlight.int(next.version),
        sqlight.int(next.updated_at),
        sqlight.int(next.rev),
        sqlight.nullable(sqlight.int, next.rev_at),
        sqlight.nullable(id.org_user_sql, next.rev_by_user_id),
        sqlight.nullable(sqlight.text, next.rev_by_name),
        sqlight.nullable(sqlight.int, next.min_age),
        sqlight.nullable(sqlight.int, next.max_age),
        sqlight.nullable(sqlight.float, next.radius_km),
        sqlight.nullable(
          sqlight.text,
          option.map(next.max_level, playing_level.to_string),
        ),
        sqlight.nullable(
          sqlight.text,
          option.map(next.foot, row.foot_to_string),
        ),
        sqlight.nullable(sqlight.text, next.availability),
        sqlight.nullable(
          sqlight.text,
          option.map(next.min_trust_band, trust_band.to_string),
        ),
        id.brief_sql(old.id),
        sqlight.int(old.rev),
      ],
    ),
  )
  use _ <- result.try(case r.criteria {
    Some(c) -> write_values(tx, old.id, c)
    None -> Ok(Nil)
  })
  use _ <- result.map(
    list.try_each(r.events, append(tx, old.id, r.by, r.at, _)),
  )
  Brief(next, criteria)
}

// ------------------------------------------------------------------------------------------------------ views

pub fn view(b: Brief) -> Json {
  let r = b.row
  json.object(
    list.flatten([
      [
        #("id", id.brief_json(r.id)),
        #("title", json.string(r.title)),
        #("status", brief_status.to_json(r.status)),
        #("version", json.int(r.version)),
      ],
      // `version` is the criteria version historical coverage points at; `rev` moves on every accepted write.
      rev.meta(rev_of(b)),
      [
        #("criteria", criteria_json(b.criteria)),
        #("criteriaExplained", explain(b.criteria)),
        #("activeFrom", json.nullable(r.active_from_date, json.string)),
        #("activeUntil", json.nullable(r.active_until_date, json.string)),
        #("roleId", json.nullable(r.role_id, json.string)),
        #("vacancyId", json.nullable(r.vacancy_id, json.string)),
        #(
          "createdBy",
          json.object([
            #("userId", id.org_user_json(r.created_by_user_id)),
            #("name", json.nullable(r.created_by_name, json.string)),
          ]),
        ),
        #("createdAt", json.int(r.created_at)),
        #("updatedAt", json.int(r.updated_at)),
        #(
          "note",
          json.string(
            "These are the only criteria used. There are no hidden criteria, no weights and no ranking.",
          ),
        ),
      ],
    ]),
  )
}

pub fn rev_of(b: Brief) -> rev.Rev {
  rev.Rev(rev: b.row.rev, at: b.row.rev_at, by_name: b.row.rev_by_name)
}
