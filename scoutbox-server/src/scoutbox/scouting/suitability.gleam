//// Player-controlled suitability (domains/scouting/suitability.mjs). A player's preferences are private to them, or
//// to the guardian for an under-18: a club sees only the verdict summary the player or guardian approved onto one
//// application. Suitability is guidance: it never overrides eligibility.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/zones
import scoutbox/rows/application_suitability as verdict_row
import scoutbox/rows/id
import scoutbox/rows/opportunity_training_slots as opp_slot_row
import scoutbox/rows/player_pref_slots as slot_row
import scoutbox/rows/player_pref_texts as text_row
import scoutbox/rows/player_prefs as prefs_row
import scoutbox/scouting/opportunities.{type Opportunity}
import scoutbox/scouting/opportunity_applications as applies
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

// OPPORTUNITIES_CAMPAIGNS_LIMITS (repositories/opportunitiesCampaigns.ts).
const training_slots_max = 10

const tag_max = 40

const tags_max = 8

const accommodation_max = 80

const accommodations_max = 8

const slots_max = 20

const label_max = 60

const ambitions_max = 300

const accessibility_max = 80

const travel_limit_km_max = 500

const tz_max = 40

/// JavaScript's largest safe integer: `wholeNumber()`'s default bound.
const max_safe_integer = 9_007_199_254_740_991

// ------------------------------------------------------------------------------------------------- slots

/// A weekly slot as sent or stored: the day as its stored text (`mon`…).
pub type Slot {
  Slot(
    day: String,
    start: String,
    end: String,
    tz: String,
    label: Option(String),
  )
}

const week = 10_080

/// slots.mjs `tzOffsetMinutes`: the offset at one fixed instant, so a comparison is stable whatever the date.
const offset_reference_ms = 1_768_478_400_000

fn day_index(day: String) -> Result(Int, Nil) {
  case day {
    "sun" -> Ok(0)
    "mon" -> Ok(1)
    "tue" -> Ok(2)
    "wed" -> Ok(3)
    "thu" -> Ok(4)
    "fri" -> Ok(5)
    "sat" -> Ok(6)
    _ -> Error(Nil)
  }
}

fn minutes_of(hhmm: String) -> Result(Int, Nil) {
  case string.split(hhmm, ":") {
    [h, m] -> {
      use h <- result.try(int.parse(h))
      use m <- result.map(int.parse(m))
      h * 60 + m
    }
    _ -> Error(Nil)
  }
}

/// slots.mjs `slotToUtcRange`: minutes from the start of the week in UTC.
fn utc_range(s: Slot) -> Result(#(Int, Int), Nil) {
  use day <- result.try(day_index(s.day))
  use start <- result.try(minutes_of(s.start))
  use end <- result.try(minutes_of(s.end))
  case zones.parse(s.tz) {
    Error(Nil) -> Error(Nil)
    Ok(zone) -> {
      let off = zones.offset_minutes(zone, offset_reference_ms)
      let from = { { day * 1440 + start - off } % week + week } % week
      let to = from + end - start
      case to > from {
        True -> Ok(#(from, to))
        False -> Error(Nil)
      }
    }
  }
}

/// slots.mjs `slotsOverlap`: compared on the week's circle, since a zone's shift can wrap a slot past its end. A
/// slot it can't read is `None`: unknown, not "no overlap".
pub fn slots_overlap(a: Slot, b: Slot) -> Option(Bool) {
  case utc_range(a), utc_range(b) {
    Ok(#(a_start, a_end)), Ok(#(b_start, b_end)) ->
      Some(
        list.any([-week, 0, week], fn(shift) {
          a_start < b_end + shift && b_start + shift < a_end
        }),
      )
    _, _ -> None
  }
}

/// Only a known overlap counts.
fn overlap(a: Slot, b: Slot) -> Bool {
  slots_overlap(a, b) == Some(True)
}

fn opportunity_slot(s: opp_slot_row.Row) -> Slot {
  Slot(
    day: opp_slot_row.day_to_string(s.day),
    start: s.start_time,
    end: s.end_time,
    tz: s.tz,
    label: None,
  )
}

// ------------------------------------------------------------------------------------------------- preferences

pub type Prefs {
  Prefs(
    commitments: List(Slot),
    available: List(Slot),
    travel_limit_km: Option(Float),
    transport: Option(prefs_row.Transport),
    relocation: Option(prefs_row.Relocation),
    ambitions: Option(String),
    environment: List(String),
    accessibility: List(String),
    max_fee_minor: Option(Int),
    currency: String,
    expenses_needed: Bool,
    /// None until the player or guardian first saves: reading writes nothing.
    updated_at: Option(Int),
  )
}

const blank =
  Prefs(
    commitments: [],
    available: [],
    travel_limit_km: None,
    transport: None,
    relocation: None,
    ambitions: None,
    environment: [],
    accessibility: [],
    max_fee_minor: None,
    currency: "GBP",
    expenses_needed: False,
    updated_at: None,
  )

fn prefs_of(read: Read, pid: id.PlayerId) -> Result(Prefs, Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> prefs_row.columns <> " FROM player_prefs WHERE player_id = ?",
    [id.player_sql(pid)],
    prefs_row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(blank)
    Ok(r) -> {
      use slots <- result.try(store.query(
        read,
        "SELECT "
          <> slot_row.columns
          <> " FROM player_pref_slots WHERE player_id = ? ORDER BY kind, ordinal",
        [id.player_sql(pid)],
        slot_row.decoder(),
      ))
      use texts <- result.map(store.query(
        read,
        "SELECT "
          <> text_row.columns
          <> " FROM player_pref_texts WHERE player_id = ? ORDER BY kind, ordinal",
        [id.player_sql(pid)],
        text_row.decoder(),
      ))
      let slots_of = fn(kind) {
        list.filter(slots, fn(s) { s.kind == kind })
        |> list.map(fn(s) {
          Slot(
            day: slot_row.day_to_string(s.day),
            start: s.start_time,
            end: s.end_time,
            tz: s.tz,
            label: s.label,
          )
        })
      }
      let texts_of = fn(kind) {
        list.filter(texts, fn(t) { t.kind == kind })
        |> list.map(fn(t) { t.text })
      }
      Prefs(
        commitments: slots_of(slot_row.Commitment),
        available: slots_of(slot_row.Available),
        travel_limit_km: r.travel_limit_km,
        transport: r.transport,
        relocation: r.relocation,
        ambitions: r.ambitions,
        environment: texts_of(text_row.Environment),
        accessibility: texts_of(text_row.Accessibility),
        max_fee_minor: r.max_fee_minor,
        currency: r.currency,
        expenses_needed: r.expenses_needed,
        updated_at: Some(r.updated_at),
      )
    }
  }
}

/// One row of preferences per player: saving again replaces it, its slots and its texts.
fn save(tx: Tx, pid: id.PlayerId, p: Prefs, at: Int) -> Result(Nil, Fail(e)) {
  let pid_sql = id.player_sql(pid)
  use _ <- result.try(store.run(
    tx,
    "INSERT INTO player_prefs ("
      <> prefs_row.columns
      <> ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (player_id) DO UPDATE SET travel_limit_km = excluded.travel_limit_km, transport = excluded.transport, relocation = excluded.relocation, ambitions = excluded.ambitions, max_fee_minor = excluded.max_fee_minor, currency = excluded.currency, expenses_needed = excluded.expenses_needed, updated_at = excluded.updated_at",
    prefs_row.values(prefs_row.Row(
      player_id: pid,
      travel_limit_km: p.travel_limit_km,
      transport: p.transport,
      relocation: p.relocation,
      ambitions: p.ambitions,
      max_fee_minor: p.max_fee_minor,
      currency: p.currency,
      expenses_needed: p.expenses_needed,
      updated_at: at,
    )),
  ))
  use _ <- result.try(
    store.run(tx, "DELETE FROM player_pref_slots WHERE player_id = ?", [pid_sql]),
  )
  use _ <- result.try(
    store.run(tx, "DELETE FROM player_pref_texts WHERE player_id = ?", [pid_sql]),
  )
  let slots =
    list.append(
      list.index_map(p.commitments, fn(s, i) { #(slot_row.Commitment, s, i) }),
      list.index_map(p.available, fn(s, i) { #(slot_row.Available, s, i) }),
    )
  use _ <- result.try(
    list.try_each(slots, fn(entry) {
      let #(kind, s, ordinal) = entry
      let assert Ok(day) = slot_row.day_from_string(s.day)
        as "a slot's day was checked against the vocabulary"
      slot_row.insert(
        tx,
        slot_row.Row(
          player_id: pid,
          kind:,
          ordinal:,
          day:,
          start_time: s.start,
          end_time: s.end,
          tz: s.tz,
          label: s.label,
        ),
      )
    }),
  )
  list.append(
    list.index_map(p.environment, fn(t, i) { #(text_row.Environment, t, i) }),
    list.index_map(p.accessibility, fn(t, i) { #(text_row.Accessibility, t, i) }),
  )
  |> list.try_each(fn(entry) {
    let #(kind, text, ordinal) = entry
    text_row.insert(tx, text_row.Row(player_id: pid, kind:, ordinal:, text:))
  })
}

fn slot_json(s: Slot) -> Json {
  json.object([
    #("day", json.string(s.day)),
    #("start", json.string(s.start)),
    #("end", json.string(s.end)),
    #("tz", json.string(s.tz)),
    #("label", json.nullable(s.label, json.string)),
  ])
}

fn prefs_json(p: Prefs) -> Json {
  json.object([
    #("commitments", json.array(p.commitments, slot_json)),
    #("availableSlots", json.array(p.available, slot_json)),
    #("travelLimitKm", json.nullable(p.travel_limit_km, json_text.number)),
    #("transport", json.nullable(p.transport, prefs_row.transport_to_json)),
    #("relocation", json.nullable(p.relocation, prefs_row.relocation_to_json)),
    #("ambitions", json.nullable(p.ambitions, json.string)),
    #("environment", json.array(p.environment, json.string)),
    #("accessibility", json.array(p.accessibility, json.string)),
    #(
      "compensation",
      json.object([
        #("maxFeeMinor", json.nullable(p.max_fee_minor, json.int)),
        #("currency", json.string(p.currency)),
        #("expensesNeeded", json.bool(p.expenses_needed)),
      ]),
    ),
    #("updatedAt", json.nullable(p.updated_at, json.int)),
  ])
}

// ------------------------------------------------------------------------------------------------- input

/// What a save sends: an absent field keeps the stored value, and null clears a nullable one.
type PrefsInput {
  PrefsInput(
    commitments: Option(List(Slot)),
    available: Option(List(Slot)),
    travel_limit_km: Option(Option(Float)),
    transport: Option(Option(prefs_row.Transport)),
    ambitions: Option(Option(String)),
    environment: Option(List(String)),
    accessibility: Option(List(String)),
    compensation: Option(CompensationInput),
    relocation: Option(Option(prefs_row.Relocation)),
  )
}

type CompensationInput {
  CompensationInput(
    max_fee_minor: Option(Option(Int)),
    currency: Option(String),
    expenses_needed: Option(Bool),
  )
}

/// The schema checks shape, vocabulary and length; the times, the zone and the currency are judged after, as the
/// TypeScript repository's typer judges them.
fn slot_shape(labelled: Bool) -> input.Check(Slot) {
  input.object({
    use day <- input.field(
      "day",
      input.required(input.one_of(slot_row.day_pairs)),
    )
    use start <- input.field("start", input.required(input.text(1_000_000)))
    use end <- input.field("end", input.required(input.text(1_000_000)))
    use tz <- input.field("tz", input.required(input.text(1_000_000)))
    case labelled {
      True -> {
        use label <- input.field("label", input.nullish(input.text(label_max)))
        input.done(Slot(
          day: slot_row.day_to_string(day),
          start:,
          end:,
          tz:,
          // An empty label is none at all.
          label: input.filled(label),
        ))
      }
      False ->
        input.done(Slot(
          day: slot_row.day_to_string(day),
          start:,
          end:,
          tz:,
          label: None,
        ))
    }
  })
}

fn tags(max: Int) -> input.Check(List(String)) {
  input.items_between(input.required_text(max), 0, tags_max)
}

fn prefs_shape(adult: Bool) -> input.Shape(PrefsInput) {
  let slots = input.items_between(slot_shape(True), 0, slots_max)
  use commitments <- input.field("commitments", input.optional(slots))
  use available <- input.field("availableSlots", input.optional(slots))
  use travel_limit_km <- input.field(
    "travelLimitKm",
    input.clearable(input.number(0, travel_limit_km_max)),
  )
  use transport <- input.field(
    "transport",
    input.clearable(input.one_of(prefs_row.transport_pairs)),
  )
  use ambitions <- input.field(
    "ambitions",
    input.clearable(input.text(ambitions_max)),
  )
  use environment <- input.field("environment", input.optional(tags(tag_max)))
  use accessibility <- input.field(
    "accessibility",
    input.optional(tags(accessibility_max)),
  )
  use compensation <- input.field(
    "compensation",
    input.optional(
      input.object({
        use max_fee_minor <- input.field(
          "maxFeeMinor",
          input.clearable(input.whole_number(0, max_safe_integer)),
        )
        use currency <- input.field(
          "currency",
          input.optional(input.text(1_000_000)),
        )
        use expenses_needed <- input.field(
          "expensesNeeded",
          input.optional(input.boolean()),
        )
        input.done(CompensationInput(
          max_fee_minor:,
          currency:,
          expenses_needed:,
        ))
      }),
    ),
  )
  let read = fn(relocation) {
    PrefsInput(
      commitments:,
      available:,
      travel_limit_km:,
      transport:,
      ambitions:,
      environment:,
      accessibility:,
      compensation:,
      relocation:,
    )
  }
  // Relocation is an adult field: a minor's preferences never collect it.
  case adult {
    True -> {
      use relocation <- input.field(
        "relocation",
        input.clearable(input.one_of(prefs_row.relocation_pairs)),
      )
      input.done(read(relocation))
    }
    False -> input.done(read(None))
  }
}

fn or_keep(sent: Option(a), stored: a) -> a {
  option.unwrap(sent, stored)
}

/// The fields sent replace the stored ones.
fn merged(was: Prefs, sent: PrefsInput, at: Int) -> Prefs {
  Prefs(
    commitments: or_keep(sent.commitments, was.commitments),
    available: or_keep(sent.available, was.available),
    travel_limit_km: or_keep(sent.travel_limit_km, was.travel_limit_km),
    transport: or_keep(sent.transport, was.transport),
    relocation: or_keep(sent.relocation, was.relocation),
    ambitions: case sent.ambitions {
      Some(a) -> input.filled(a)
      None -> was.ambitions
    },
    environment: or_keep(sent.environment, was.environment),
    accessibility: or_keep(sent.accessibility, was.accessibility),
    max_fee_minor: case sent.compensation {
      Some(c) -> or_keep(c.max_fee_minor, was.max_fee_minor)
      None -> was.max_fee_minor
    },
    currency: case sent.compensation {
      Some(c) -> or_keep(c.currency, was.currency)
      None -> was.currency
    },
    expenses_needed: case sent.compensation {
      Some(c) -> option.unwrap(c.expenses_needed, False)
      None -> was.expenses_needed
    },
    updated_at: Some(at),
  )
}

/// The repository typer's judgement of what the schema let through, as `#(field, what)`: the first problem in its
/// order.
type Problem =
  #(String, String)

fn is_time(s: String) -> Bool {
  let assert Ok(re) = regexp.from_string("^([01]\\d|2[0-3]):[0-5]\\d$")
  regexp.check(re, s)
}

fn is_currency(s: String) -> Bool {
  let assert Ok(re) = regexp.from_string("^[A-Z]{3}$")
  regexp.check(re, s)
}

/// repositories `knownTimeZone`: a zone this runtime knows, of at most 40 characters.
fn known_zone(tz: String) -> Bool {
  input.utf16_length(tz) <= tz_max && result.is_ok(zones.parse(tz))
}

/// repositories `typeSlot`'s checks past the schema's. Every value the schema passes is text, which the typer
/// describes as "a string".
fn slot_problem(at: String, s: Slot) -> Result(Nil, Problem) {
  let time = fn(field, value) {
    case is_time(value) {
      True -> Ok(Nil)
      False ->
        Error(#(
          at <> "." <> field,
          "must be a 24-hour time HH:MM (got a string)",
        ))
    }
  }
  use _ <- result.try(time("start", s.start))
  use _ <- result.try(time("end", s.end))
  use _ <- result.try(case string.compare(s.start, s.end) {
    order.Lt -> Ok(Nil)
    _ -> Error(#(at <> ".end", "must be after start (a slot within one day)"))
  })
  case known_zone(s.tz) {
    True -> Ok(Nil)
    False ->
      Error(#(
        at <> ".tz",
        "must be an IANA time zone such as Europe/London (got a string)",
      ))
  }
}

fn slots_problem(at: String, slots: List(Slot)) -> Result(Nil, Problem) {
  list.index_map(slots, fn(s, i) { #(s, i) })
  |> list.try_each(fn(pair) {
    slot_problem(at <> "[" <> int.to_string(pair.1) <> "]", pair.0)
  })
}

fn currency_problem(field: String, currency: String) -> Result(Nil, Problem) {
  case is_currency(currency) {
    True -> Ok(Nil)
    False ->
      Error(#(
        field,
        "must be a three-letter currency code such as GBP (got a string)",
      ))
  }
}

fn prefs_problem(p: Prefs) -> Result(Nil, Problem) {
  use _ <- result.try(slots_problem("commitments", p.commitments))
  use _ <- result.try(slots_problem("availableSlots", p.available))
  currency_problem("compensation.currency", p.currency)
}

/// The 400 for a typer's problem: `<Label>: <field> <what>.`
fn field_invalid(label: String, problem: Problem) -> Response {
  let #(field, what) = problem
  http.json(
    400,
    json.object([
      #("error", json.string("FIELD_INVALID")),
      #("field", json.string(field)),
      #("message", json.string(label <> ": " <> field <> " " <> what <> ".")),
    ]),
  )
}

// ------------------------------------------------------------------------------------------------- answers

fn finished(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn guardian_managed(message: String) -> Response {
  http.error_message(403, "GUARDIAN_MANAGED", message)
}

fn own_child(
  g: Guardian,
  child: id.PlayerId,
  next: fn() -> Response,
) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True -> next()
  }
}

fn preferences_answer(p: Prefs, extra: List(#(String, Json))) -> Response {
  http.json(200, json.object([#("preferences", prefs_json(p)), ..extra]))
}

// ------------------------------------------------------------------------------------------------- preference routes

/// `GET /player/preferences`.
pub fn show(ctx: Ctx, p: PlayerAccess) -> Response {
  case store.read(ctx.store, prefs_of(_, p.player.row.id)) {
    Error(failure) -> http.internal(failure)
    Ok(prefs) ->
      preferences_answer(prefs, [
        #("private", json.bool(True)),
        #(
          "note",
          json.string(
            "Clubs never see this — only summaries you approve on an application.",
          ),
        ),
      ])
  }
}

/// `PUT /player/preferences`. An under-18's are set by the guardian.
pub fn update(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      guardian_managed(
        "Suitability preferences for under-18s are set by your parent/guardian.",
      )
    False -> save_route(ctx, req, p.player.row.id, True)
  }
}

/// `GET /guardian/children/:id/preferences`.
pub fn child_show(ctx: Ctx, g: Guardian, child: id.PlayerId) -> Response {
  use <- own_child(g, child)
  case store.read(ctx.store, prefs_of(_, child)) {
    Error(failure) -> http.internal(failure)
    Ok(prefs) -> preferences_answer(prefs, [#("private", json.bool(True))])
  }
}

/// `PUT /guardian/children/:id/preferences`: a minor's shape, whatever the child's age.
pub fn child_update(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
) -> Response {
  use <- own_child(g, child)
  save_route(ctx, req, child, False)
}

fn save_route(
  ctx: Ctx,
  req: Request,
  pid: id.PlayerId,
  adult: Bool,
) -> Response {
  use sent <- http.body(req, prefs_shape(adult), [])
  let at = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use was <- result.try(prefs_of(store.reading(tx), pid))
    let next = merged(was, sent, at)
    case prefs_problem(next) {
      Error(problem) -> store.refuse(field_invalid("Preferences", problem))
      Ok(Nil) -> {
        use _ <- result.try(save(tx, pid, next, at))
        use saved <- result.map(prefs_of(store.reading(tx), pid))
        preferences_answer(saved, [])
      }
    }
  })
  |> finished
}

// ------------------------------------------------------------------------------------------------- structured requirements

type StructuredInput {
  StructuredInput(
    training_slots: List(Slot),
    relocation_required: Bool,
    fee_minor: Option(Int),
    currency: String,
    expenses_covered: Bool,
    environment: List(String),
    accommodations: List(String),
  )
}

fn structured_shape() -> input.Shape(StructuredInput) {
  use training_slots <- input.field(
    "trainingSlots",
    input.nullish(input.items_between(slot_shape(False), 0, training_slots_max)),
  )
  use relocation_required <- input.field(
    "relocationRequired",
    input.nullish(input.boolean()),
  )
  use fee_minor <- input.field(
    "feeMinor",
    input.nullish(input.whole_number(0, max_safe_integer)),
  )
  use currency <- input.field("currency", input.nullish(input.text(1_000_000)))
  use expenses_covered <- input.field(
    "expensesCovered",
    input.nullish(input.boolean()),
  )
  use environment <- input.field("environment", input.nullish(tags(tag_max)))
  use accommodations <- input.field(
    "accommodations",
    input.nullish(input.items_between(
      input.required_text(accommodation_max),
      0,
      accommodations_max,
    )),
  )
  input.done(StructuredInput(
    training_slots: option.unwrap(training_slots, []),
    relocation_required: option.unwrap(relocation_required, False),
    fee_minor:,
    currency: option.unwrap(currency, "GBP"),
    expenses_covered: option.unwrap(expenses_covered, False),
    environment: option.unwrap(environment, []),
    accommodations: option.unwrap(accommodations, []),
  ))
}

/// `PUT /org/opportunities/:id/structured-requirements`: the record is replaced whole. The free-text `schedule` and
/// `requirements` stay as they are.
pub fn set_structured(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  oid: id.OpportunityId,
) -> Response {
  case store.read(ctx.store, applies.opportunity_by_id(_, oid)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(o)) if o.row.org_id == a.org.id -> {
      use s <- http.body(req, structured_shape(), [])
      let problem = {
        use _ <- result.try(currency_problem("currency", s.currency))
        slots_problem("trainingSlots", s.training_slots)
      }
      case problem {
        Error(problem) -> field_invalid("Structured requirements", problem)
        Ok(Nil) ->
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(write_structured(tx, oid, s))
            use found <- result.try(applies.opportunity_by_id(
              store.reading(tx),
              oid,
            ))
            case found {
              None ->
                store.stale("opportunity " <> id.opportunity_to_string(oid))
              Some(o) ->
                Ok(http.json(
                  200,
                  json.object([
                    #(
                      "opportunity",
                      json.object([
                        #("id", id.opportunity_json(o.row.id)),
                        #("structured", opportunities.structured_json(o)),
                      ]),
                    ),
                  ]),
                ))
            }
          })
          |> finished
      }
    }
    Ok(_) -> http.error(404, "OPPORTUNITY_NOT_FOUND")
  }
}

fn write_structured(
  tx: Tx,
  oid: id.OpportunityId,
  s: StructuredInput,
) -> Result(Nil, Fail(e)) {
  let oid_sql = id.opportunity_sql(oid)
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE opportunities SET structured_declared = 1, relocation_required = ?, fee_minor = ?, currency = ?, expenses_covered = ? WHERE id = ?",
      [
        sqlight.bool(s.relocation_required),
        sqlight.nullable(sqlight.int, s.fee_minor),
        sqlight.text(s.currency),
        sqlight.bool(s.expenses_covered),
        oid_sql,
      ],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM opportunity_training_slots WHERE opportunity_id = ?",
      [oid_sql],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM opportunity_texts WHERE opportunity_id = ? AND kind <> 'requirement'",
      [oid_sql],
    ),
  )
  use _ <- result.try(
    list.index_map(s.training_slots, fn(slot, i) { #(slot, i) })
    |> list.try_each(fn(pair) {
      let #(slot, ordinal) = pair
      store.run(
        tx,
        "INSERT INTO opportunity_training_slots (opportunity_id, ordinal, day, start_time, end_time, tz) VALUES (?, ?, ?, ?, ?, ?)",
        [
          oid_sql,
          sqlight.int(ordinal),
          sqlight.text(slot.day),
          sqlight.text(slot.start),
          sqlight.text(slot.end),
          sqlight.text(slot.tz),
        ],
      )
    }),
  )
  list.append(
    list.index_map(s.environment, fn(t, i) { #("environment", t, i) }),
    list.index_map(s.accommodations, fn(t, i) { #("accommodation", t, i) }),
  )
  |> list.try_each(fn(entry) {
    let #(kind, text, ordinal) = entry
    store.run(
      tx,
      "INSERT INTO opportunity_texts (opportunity_id, kind, ordinal, text) VALUES (?, ?, ?, ?)",
      [oid_sql, sqlight.text(kind), sqlight.int(ordinal), sqlight.text(text)],
    )
  })
}

// ------------------------------------------------------------------------------------------------- the comparison

pub type Verdict {
  Verdict(
    dimension: verdict_row.Dimension,
    verdict: verdict_row.Verdict,
    reason: String,
    source: String,
  )
}

/// Where the club is, for the travel dimension: the distance from the player, and the club's coarse area.
type Place {
  Place(km: Float, area: String)
}

fn place(
  read: Read,
  o: Opportunity,
  p: Player,
) -> Result(Option(Place), Fail(e)) {
  use km <- result.try(opportunities.km_from_club(read, o.row.org_id, p))
  case km {
    None -> Ok(None)
    Some(km) -> {
      use org <- result.map(orgs.by_id(read, o.row.org_id))
      // routeHelpers.mjs `coarseArea`.
      let area = case option.then(org, fn(org) { org.city }) {
        Some(city) if city != "" -> city
        _ -> "area withheld"
      }
      Some(Place(km:, area:))
    }
  }
}

fn number_text(f: Float) -> String {
  json.to_string(json_text.number(f))
}

fn verdicts(
  prefs: Prefs,
  o: Opportunity,
  place: Option(Place),
  adult: Bool,
) -> List(Verdict) {
  let declared = o.row.structured_declared
  let training = list.map(o.slots, opportunity_slot)
  [
    schedule(prefs, declared, training),
    travel(prefs, place),
    relocation(prefs, declared && o.row.relocation_required, adult),
    compensation(prefs, o, declared),
    environment(prefs, case declared {
      True -> o.environment
      False -> []
    }),
    accessibility(prefs, case declared {
      True -> o.accommodations
      False -> []
    }),
  ]
}

fn schedule(prefs: Prefs, declared: Bool, training: List(Slot)) -> Verdict {
  let v = fn(verdict, reason, source) {
    Verdict(verdict_row.Schedule, verdict, reason, source)
  }
  case declared && training != [], prefs.commitments, prefs.available {
    False, _, _ ->
      v(
        verdict_row.Unknown,
        "the club has not published structured training times",
        "opportunity",
      )
    True, [], [] ->
      v(
        verdict_row.Unknown,
        "no commitments or availability recorded yet",
        "your preferences",
      )
    True, commitments, available -> {
      let conflict =
        list.find_map(training, fn(t) {
          list.find(commitments, overlap(t, _)) |> result.map(fn(c) { #(t, c) })
        })
      let all_fit =
        available != []
        && list.all(training, fn(t) { list.any(available, overlap(t, _)) })
      case conflict, all_fit {
        Ok(#(t, c)), _ ->
          v(
            verdict_row.Conflict,
            "training "
              <> t.day
              <> " "
              <> t.start
              <> "–"
              <> t.end
              <> " ("
              <> t.tz
              <> ") overlaps your commitment “"
              <> option.unwrap(c.label, c.day)
              <> "” ("
              <> c.tz
              <> ")",
            "your commitments vs the club’s training times",
          )
        Error(Nil), True ->
          v(
            verdict_row.Compatible,
            "every published training slot falls inside your available times",
            "your availability vs the club’s training times",
          )
        Error(Nil), False ->
          v(
            verdict_row.Unknown,
            "no overlap with a recorded commitment, but availability is incomplete",
            "your preferences",
          )
      }
    }
  }
}

fn travel(prefs: Prefs, place: Option(Place)) -> Verdict {
  let v = fn(verdict, reason, source) {
    Verdict(verdict_row.Travel, verdict, reason, source)
  }
  case place {
    None ->
      v(
        verdict_row.Unknown,
        "location missing on one side (never guessed)",
        "locations",
      )
    Some(Place(km:, area:)) -> {
      let km = float.round(km)
      let note =
        int.to_string(km)
        <> " km from your area to "
        <> area
        <> " — travel time unavailable (no routing provider configured)"
      case prefs.travel_limit_km {
        None ->
          v(
            verdict_row.Unknown,
            note <> "; you have not set a travel limit",
            "distance",
          )
        Some(limit) -> {
          let source = "distance vs your " <> number_text(limit) <> " km limit"
          case int.to_float(km) <=. limit {
            True -> v(verdict_row.Compatible, note, source)
            False ->
              v(
                verdict_row.Conflict,
                note <> "; beyond your " <> number_text(limit) <> " km limit",
                source,
              )
          }
        }
      }
    }
  }
}

fn relocation(prefs: Prefs, required: Bool, adult: Bool) -> Verdict {
  let v = fn(verdict, reason, source) {
    Verdict(verdict_row.Relocation, verdict, reason, source)
  }
  case required, adult, prefs.relocation {
    False, _, _ ->
      v(verdict_row.Compatible, "no relocation required", "opportunity")
    True, False, _ ->
      v(
        verdict_row.Conflict,
        "this opportunity expects relocation — not applicable to under-18 players",
        "safeguarding",
      )
    True, True, Some(prefs_row.No) ->
      v(
        verdict_row.Conflict,
        "the role expects relocation and your preference is not to relocate",
        "your preferences",
      )
    True, True, Some(r) ->
      v(
        verdict_row.Compatible,
        "relocation expected — your preference: "
          <> prefs_row.relocation_to_string(r),
        "your preferences",
      )
    True, True, None ->
      v(
        verdict_row.Unknown,
        "relocation expected — you have not set a preference",
        "your preferences",
      )
  }
}

fn compensation(prefs: Prefs, o: Opportunity, declared: Bool) -> Verdict {
  let v = fn(verdict, reason) {
    Verdict(verdict_row.Compensation, verdict, reason, "fees")
  }
  let fee = case declared, o.row.fee_minor {
    True, Some(fee) if fee > 0 -> Some(fee)
    _, _ -> None
  }
  case fee {
    Some(fee) -> {
      let currency = option.unwrap(o.row.currency, "GBP")
      case prefs.max_fee_minor {
        None ->
          v(
            verdict_row.Unknown,
            "the opportunity has a participation fee and you have not set a maximum",
          )
        Some(_) if currency != prefs.currency ->
          v(
            verdict_row.Unknown,
            "fee is in "
              <> currency
              <> ", your limit is in "
              <> prefs.currency
              <> " — no conversion is assumed",
          )
        Some(max) if fee <= max ->
          v(verdict_row.Compatible, "the fee is within your stated maximum")
        Some(_) ->
          v(
            verdict_row.Conflict,
            "the participation fee is above your stated maximum",
          )
      }
    }
    None ->
      case prefs.expenses_needed && declared && !o.row.expenses_covered {
        True ->
          v(
            verdict_row.Conflict,
            "you need expenses covered and this opportunity does not cover them",
          )
        False ->
          v(verdict_row.Compatible, case declared {
            True -> "no fee; expense needs met"
            False -> "no fee declared"
          })
      }
  }
}

fn environment(prefs: Prefs, club: List(String)) -> Verdict {
  let v = fn(verdict, reason, source) {
    Verdict(verdict_row.Environment, verdict, reason, source)
  }
  case prefs.environment, club {
    [], _ | _, [] ->
      v(
        verdict_row.Unknown,
        "environment preferences or club tags not set",
        "preferences",
      )
    wanted, club ->
      case list.filter(wanted, list.contains(club, _)) {
        [] ->
          v(
            verdict_row.Unknown,
            "no declared overlap — worth a conversation",
            "your preferences vs club tags",
          )
        hit ->
          v(
            verdict_row.Compatible,
            "matches: " <> string.join(hit, ", "),
            "your preferences vs club tags",
          )
      }
  }
}

/// Needs against the club's declared accommodations only: nothing is assumed either way.
fn accessibility(prefs: Prefs, declared: List(String)) -> Verdict {
  let v = fn(verdict, reason, source) {
    Verdict(verdict_row.Accessibility, verdict, reason, source)
  }
  case prefs.accessibility, declared {
    [], _ ->
      v(
        verdict_row.Compatible,
        "no accessibility requirements recorded",
        "your preferences",
      )
    _, [] ->
      v(
        verdict_row.Unknown,
        "you listed requirements; the club has not declared its accommodations — nothing is assumed either way",
        "club declaration",
      )
    needs, declared -> {
      let declared = list.map(declared, string.lowercase)
      case
        list.filter(needs, fn(n) {
          !list.any(declared, string.contains(_, string.lowercase(n)))
        })
      {
        [] ->
          v(
            verdict_row.Compatible,
            "declared accommodations cover your listed requirements",
            "club declaration",
          )
        unmet ->
          v(
            verdict_row.Unknown,
            "not yet declared by the club: " <> string.join(unmet, ", "),
            "club declaration",
          )
      }
    }
  }
}

fn verdicts_of(
  read: Read,
  p: Player,
  o: Opportunity,
  now: Int,
) -> Result(List(Verdict), Fail(e)) {
  use prefs <- result.try(prefs_of(read, p.row.id))
  use place <- result.map(place(read, o, p))
  verdicts(prefs, o, place, players.is_adult(p, now))
}

fn verdict_json(v: Verdict) -> Json {
  json.object([
    #("dimension", verdict_row.dimension_to_json(v.dimension)),
    #("verdict", verdict_row.verdict_to_json(v.verdict)),
    #("reason", json.string(v.reason)),
    #("source", json.string(v.source)),
  ])
}

// ------------------------------------------------------------------------------------------------- verdict routes

/// `GET /player/suitability/:oppId`.
pub fn player_verdicts(
  ctx: Ctx,
  p: PlayerAccess,
  oid: id.OpportunityId,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use o <- result.try(applies.opportunity_by_id(read, oid))
      case o {
        None -> Ok(None)
        Some(o) ->
          verdicts_of(read, p.player, o, now)
          |> result.map(fn(vs) { Some(#(o, vs)) })
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "OPPORTUNITY_NOT_FOUND")
    Ok(Some(#(o, vs))) ->
      http.json(
        200,
        json.object([
          #("opportunityId", id.opportunity_json(o.row.id)),
          #("verdicts", json.array(vs, verdict_json)),
          #(
            "note",
            json.string(
              "Suitability is guidance from YOUR private preferences. Eligibility rules (age, level, distance for grassroots) are separate and always apply.",
            ),
          ),
        ]),
      )
  }
}

/// `GET /guardian/children/:id/suitability/:oppId`.
pub fn child_verdicts(
  ctx: Ctx,
  g: Guardian,
  child: id.PlayerId,
  oid: id.OpportunityId,
) -> Response {
  use <- own_child(g, child)
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use c <- result.try(players.by_id(read, child))
      use o <- result.try(applies.opportunity_by_id(read, oid))
      case c, o {
        Some(c), Some(o) ->
          verdicts_of(read, c, o, now)
          |> result.map(fn(vs) { Some(#(o, vs)) })
        _, _ -> Ok(None)
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "NOT_FOUND")
    Ok(Some(#(o, vs))) ->
      http.json(
        200,
        json.object([
          #("opportunityId", id.opportunity_json(o.row.id)),
          #("verdicts", json.array(vs, verdict_json)),
        ]),
      )
  }
}

// ------------------------------------------------------------------------------------------------- the summary a club sees

type ShareAnswer {
  ShareAnswer(application_id: String, share: Bool)
}

/// Sharing is an explicit answer: a missing one is not consent.
fn share_shape() -> input.Shape(ShareAnswer) {
  use application_id <- input.field("applicationId", input.required(input.id()))
  use share <- input.field("share", input.required(input.boolean()))
  input.done(ShareAnswer(application_id:, share:))
}

/// `POST /player/suitability/share`. Sharing anything with a club is the guardian's decision for an under-18.
pub fn player_share(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      guardian_managed(
        "Sharing anything with a club is a guardian decision for under-18s.",
      )
    False -> share(ctx, req, p.player.row.id, party.Player)
  }
}

/// `POST /guardian/children/:id/suitability/share`.
pub fn child_share(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child: id.PlayerId,
) -> Response {
  use <- own_child(g, child)
  share(ctx, req, child, party.Guardian)
}

type Sharing {
  Unshare(id.ApplicationId)
  Share(id.ApplicationId, List(Verdict))
  Refuse(Response)
}

fn share(
  ctx: Ctx,
  req: Request,
  pid: id.PlayerId,
  by: party.Party,
) -> Response {
  use answer <- http.body(req, share_shape(), [])
  let aid = id.application(answer.application_id)
  let now = clock.now_ms()
  let sharing =
    store.read(ctx.store, fn(read) {
      use a <- result.try(applies.by_id(read, aid))
      case a {
        Some(a) if a.row.player_id == pid -> {
          use p <- result.try(players.by_id(read, pid))
          case p, answer.share {
            None, _ -> Ok(Refuse(http.error(404, "PLAYER_NOT_FOUND")))
            Some(_), False -> Ok(Unshare(aid))
            Some(p), True -> {
              use o <- result.try(applies.opportunity_by_id(
                read,
                a.row.opportunity_id,
              ))
              let assert Some(o) = o
                as "an application's opportunity is never deleted"
              verdicts_of(read, p, o, now)
              |> result.map(Share(aid, _))
            }
          }
        }
        _ -> Ok(Refuse(http.error(404, "APPLICATION_NOT_FOUND")))
      }
    })
  case sharing {
    Error(failure) -> http.internal(failure)
    Ok(Refuse(answer)) -> answer
    Ok(Unshare(aid)) ->
      store.unit(ctx.store, fn(tx) {
        use _ <- result.map(write_summary(tx, aid, None))
        http.json(200, json.object([#("shared", json.bool(False))]))
      })
      |> finished
    Ok(Share(aid, vs)) ->
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(write_summary(tx, aid, Some(#(now, by, vs))))
        use a <- result.try(applies.by_id(store.reading(tx), aid))
        case a {
          None -> store.stale("application " <> id.application_to_string(aid))
          Some(a) ->
            Ok(http.json(
              200,
              json.object([
                #("shared", json.bool(True)),
                #("summary", summary_json(a)),
              ]),
            ))
        }
      })
      |> finished
  }
}

/// Replaces the application's summary, or takes it back with `None`. Dimension and verdict only: a reason can name
/// a commitment, a need or a limit.
fn write_summary(
  tx: Tx,
  aid: id.ApplicationId,
  summary: Option(#(Int, party.Party, List(Verdict))),
) -> Result(Nil, Fail(e)) {
  let aid_sql = id.application_sql(aid)
  let #(at, by, vs) = case summary {
    Some(#(at, by, vs)) -> #(
      sqlight.int(at),
      sqlight.text(party.to_string(by)),
      vs,
    )
    None -> #(sqlight.null(), sqlight.null(), [])
  }
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE applications SET suitability_approved_at = ?, suitability_approved_by = ? WHERE id = ?",
      [at, by, aid_sql],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM application_suitability WHERE application_id = ?",
      [aid_sql],
    ),
  )
  list.index_map(vs, fn(v, ordinal) {
    verdict_row.Row(
      application_id: aid,
      ordinal:,
      dimension: v.dimension,
      verdict: v.verdict,
    )
  })
  |> list.try_each(verdict_row.insert(tx, _))
}

/// The approved summary as a club sees it; null when none is shared.
fn summary_json(a: applies.Application) -> Json {
  case a.row.suitability_approved_at, a.row.suitability_approved_by {
    Some(at), Some(by) ->
      json.object([
        #("approvedAt", json.int(at)),
        #("approvedBy", party.to_json(by)),
        #(
          "verdicts",
          json.array(a.verdicts, fn(v) {
            json.object([
              #("dimension", verdict_row.dimension_to_json(v.dimension)),
              #("verdict", verdict_row.verdict_to_json(v.verdict)),
            ])
          }),
        ),
      ])
    _, _ -> json.null()
  }
}

/// `GET /org/applications/:id/suitability`: the only way suitability reaches a club.
pub fn for_club(ctx: Ctx, a: OrgAccess, aid: id.ApplicationId) -> Response {
  case store.read(ctx.store, applies.by_id(_, aid)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(app)) if app.row.org_id == a.org.id ->
      case app.row.suitability_approved_at {
        None ->
          http.json(
            200,
            json.object([
              #("summary", json.null()),
              #(
                "note",
                json.string(
                  "The player/guardian has not shared a suitability summary for this application.",
                ),
              ),
            ]),
          )
        Some(_) ->
          http.json(
            200,
            json.object([
              #("summary", summary_json(app)),
              #(
                "note",
                json.string(
                  "Verdict summary approved by the player/guardian. Underlying preferences are private.",
                ),
              ),
            ]),
          )
      }
    Ok(_) -> http.error(404, "APPLICATION_NOT_FOUND")
  }
}
