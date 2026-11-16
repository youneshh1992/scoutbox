//// The Trial engine (domains/recruitment/lifecycle/trial.mjs): pure functions over one stored trial. A trial row
//// exists only after acceptance, and its two-valued `status` is the report obligation (`awaiting_report` |
//// `reported`), never a schedule. The operational truth lives in its own fields: the workflow state, the schedule
//// (current sessions and every revision), append-only attendance, the completion, per-act keys, the history and
//// the reminder markers.
////
//// `scheduled` needs a confirmed revision with at least one session; `completed` needs recorded attendance and an
//// ended last session; cancellation is a completion state and never `trial_completed`.

import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/rows/id
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rows/trial_day_checkins as checkin_row
import scoutbox/rows/trial_day_consents as consent_row
import scoutbox/rows/trial_day_staff as staff_row
import scoutbox/rows/trial_day_status_events as status_event_row
import scoutbox/rows/trial_history as history_row
import scoutbox/rows/trial_keys as key_row
import scoutbox/rows/trial_reminders as reminder_row
import scoutbox/rows/trial_reports as report_row
import scoutbox/rows/trial_revision_sessions as revision_session_row
import scoutbox/rows/trial_schedule_revisions as revision_row
import scoutbox/rows/trial_schedule_sessions as session_row
import scoutbox/rows/trial_session_evidence as evidence_row
import scoutbox/rows/trials as row
import scoutbox/rules/time_zones
import scoutbox/vocab/party
import scoutbox/vocab/trial_actor_kind.{type TrialActorKind}
import scoutbox/vocab/trial_session_kind.{type TrialSessionKind}
import scoutbox/vocab/trial_workflow_state.{
  type TrialWorkflowState, Accepted, Cancelled, Completed, LegacyAccepted,
  Scheduled,
}

pub const policy_version = 1

// ------------------------------------------------------------------------------------------------- records

/// One stored trial with its ordered child rows.
pub type Trial {
  Trial(
    row: row.Row,
    /// The current schedule's sessions, in their stored order; empty without a schedule.
    sessions: List(Session),
    revisions: List(Revision),
    attendance: List(attendance_row.Row),
    history: List(history_row.Row),
    keys: List(key_row.Row),
    reminders: List(reminder_row.Row),
    report: Option(report_row.Row),
    day: Day,
  )
}

pub type Session {
  Session(row: session_row.Row, evidence: List(evidence_row.Row))
}

pub type Revision {
  Revision(row: revision_row.Row, sessions: List(revision_session_row.Row))
}

/// The trial-day records (domains/recruitment/trialDay.mjs).
pub type Day {
  Day(
    staff: List(staff_row.Row),
    consents: List(consent_row.Row),
    checkins: List(checkin_row.Row),
    status_events: List(status_event_row.Row),
  )
}

/// A schedule is held when its revision is (the timezone is set with it, a CHECK).
pub fn has_schedule(t: Trial) -> Bool {
  has_schedule_row(t.row)
}

pub fn has_schedule_row(r: row.Row) -> Bool {
  r.schedule_revision != None
}

pub fn session_kind_text(k: TrialSessionKind) -> String {
  trial_session_kind.to_string(k)
}

// ---------------------------------------------------------------------------------------------- vocabulary

pub const workflow_states = [
  LegacyAccepted,
  Accepted,
  Scheduled,
  Completed,
  Cancelled,
]

pub fn label(state: TrialWorkflowState) -> String {
  case state {
    LegacyAccepted -> "Accepted (no schedule recorded)"
    Accepted -> "Accepted — schedule to be confirmed"
    Scheduled -> "Scheduled"
    Completed -> "Completed"
    Cancelled -> "Cancelled"
  }
}

pub fn session_kinds() -> List(String) {
  list.map(trial_session_kind.pairs, fn(p) { p.0 })
}

pub fn attendance_states() -> List(String) {
  list.map(attendance_row.state_pairs, fn(p) { p.0 })
}

pub const cancel_actors = ["club", "player", "guardian", "system"]

pub const limit_sessions = 20

pub const limit_slots = 3

pub const limit_instructions = 500

pub const limit_venue_name = 120

pub const limit_venue_town = 80

pub const limit_venue_address = 200

pub const limit_reason = 300

pub const limit_note = 300

pub const limit_message = 2000

pub const limit_client_key = 64

pub const limit_evidence_per_session = 20

pub const min_session_ms = 900_000

pub const max_session_ms = 43_200_000

pub const limit_revisions = 30

pub const history_page = 100

pub fn limits_json() -> Json {
  json.object([
    #("sessions", json.int(limit_sessions)),
    #("slots", json.int(limit_slots)),
    #("instructions", json.int(limit_instructions)),
    #("venueName", json.int(limit_venue_name)),
    #("venueTown", json.int(limit_venue_town)),
    #("venueAddress", json.int(limit_venue_address)),
    #("reason", json.int(limit_reason)),
    #("note", json.int(limit_note)),
    #("message", json.int(limit_message)),
    #("clientKey", json.int(limit_client_key)),
    #("evidencePerSession", json.int(limit_evidence_per_session)),
    #("minSessionMs", json.int(min_session_ms)),
    #("maxSessionMs", json.int(max_session_ms)),
    #("revisions", json.int(limit_revisions)),
    #("historyPage", json.int(history_page)),
  ])
}

// ---------------------------------------------------------------------------------------------------- roles

/// What a trial act needs of the member's Room role (`roomCan` carries the same three levels).
pub type Need {
  /// Viewer and above.
  TrialView
  /// Contributor and above: a scout may assess in Trial context.
  TrialAssess
  /// Room lead and above: invite, schedule, cancel, attendance, complete, link.
  TrialWrite
}

pub fn role_allows(role: Option(RoomRole), need: Need) -> Bool {
  case role {
    None -> False
    Some(r) -> {
      let rank = case r {
        room_rules.Viewer -> 0
        room_rules.Contributor -> 1
        room_rules.RoomLead -> 2
        room_rules.RecruitmentAdmin -> 3
      }
      let needed = case need {
        TrialView -> 0
        TrialAssess -> 1
        TrialWrite -> 2
      }
      rank >= needed
    }
  }
}

// ----------------------------------------------------------------------------------------------------- time

/// A refusal of a trial input: the code, the message and any extra fields.
pub type Refusal {
  Refusal(error: String, message: String, fields: List(#(String, Json)))
}

fn refusal(error: String, message: String) -> Refusal {
  Refusal(error, message, [])
}

/// An exact IANA name this runtime knows: no case-folding, no fallback to the server's zone.
pub fn valid_timezone(tz: Option(String)) -> Result(String, Refusal) {
  case tz {
    Some(z) ->
      case list.contains(time_zones.names, z) {
        True -> Ok(z)
        False -> Error(timezone_refusal())
      }
    None -> Error(timezone_refusal())
  }
}

fn timezone_refusal() -> Refusal {
  refusal(
    "TRIAL_TIMEZONE_INVALID",
    "timezone must be an IANA time zone name, for example Europe/London.",
  )
}

const instant_year_min = 2000

const instant_year_max = 2100

/// ISO 8601 with an explicit offset or `Z`, or an integer millisecond timestamp, in 2000–2100; a bare local time or
/// a date-only string is refused. Error: why not, in temporal.ts's words.
pub fn instant(v: Dynamic) -> Result(Int, String) {
  let year_ok = fn(ms) {
    let y = zones.local_parts(ms, "UTC").year
    case y < instant_year_min || y > instant_year_max {
      True ->
        Error(
          "year outside "
          <> int.to_string(instant_year_min)
          <> "–"
          <> int.to_string(instant_year_max),
        )
      False -> Ok(ms)
    }
  }
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> year_ok(n)
    _, Ok(f) ->
      case float.floor(f) == f {
        True -> year_ok(float.truncate(f))
        False -> Error("not a whole number")
      }
    _, _ ->
      case decode.run(v, decode.string) {
        Ok(s) -> {
          let year = string.slice(s, 0, 4) |> int.parse
          case year {
            Ok(y) if y < instant_year_min || y > instant_year_max ->
              case temporal.instant_ms(s) {
                Error("wrong shape") -> Error("wrong shape")
                _ -> Error("no such calendar day")
              }
            _ -> result.try(temporal.instant_ms(s), year_ok)
          }
        }
        Error(_) -> Error("not a date-time")
      }
  }
}

fn instant_refusal(why: String, field: String) -> Refusal {
  Refusal(
    "TRIAL_SCHEDULE_INVALID",
    "A session time must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp ("
      <> why
      <> ").",
    [#("field", json.string(field))],
  )
}

fn pad(n: Int, width: Int) -> String {
  string.pad_start(int.to_string(n), width, "0")
}

/// `YYYY-MM-DD` in the organiser zone: the day the family sees.
pub fn local_day(ms: Int, zone: String) -> String {
  let p = zones.local_parts(ms, zone)
  pad(p.year, 4) <> "-" <> pad(p.month, 2) <> "-" <> pad(p.day, 2)
}

/// RFC 5545 local form `YYYYMMDDTHHMMSS` for `DTSTART;TZID=`.
pub fn ics_local(ms: Int, zone: String) -> String {
  let p = zones.local_parts(ms, zone)
  pad(p.year, 4)
  <> pad(p.month, 2)
  <> pad(p.day, 2)
  <> "T"
  <> pad(p.hour, 2)
  <> pad(p.minute, 2)
  <> pad(p.second, 2)
}

/// RFC 5545 text escaping: backslash, semicolon, comma, line breaks.
pub fn ics_text(s: String) -> String {
  s
  |> string.replace("\\", "\\\\")
  |> string.replace(";", "\\;")
  |> string.replace(",", "\\,")
  |> string.replace("\r\n", "\\n")
  |> string.replace("\n", "\\n")
}

/// A trial date: a calendar day `YYYY-MM-DD` in 2000–2100 (domain.ts parseTrialDate). Error: why not.
pub fn trial_date(s: String) -> Result(String, String) {
  case temporal.date_only(s) {
    Error(why) -> Error(why)
    Ok(day) ->
      case string.slice(day, 0, 4) |> int.parse {
        Ok(y) if y < 2000 || y > 2100 -> Error("year outside 2000–2100")
        _ -> Ok(day)
      }
  }
}

/// True only for a stored value that is a valid trial date (never for "no date").
pub fn is_trial_date(v: Option(String)) -> Bool {
  case v {
    Some(s) -> result.is_ok(trial_date(s))
    None -> False
  }
}

/// The start of a trial date's UTC day.
pub fn trial_date_ms(s: String) -> Option(Int) {
  case trial_date(s) {
    Ok(day) -> temporal.day_start_ms(day) |> option.from_result
    Error(_) -> None
  }
}

pub const report_window_ms = 604_800_000

/// The one report-deadline derivation: seven days after the trial day, or after the acceptance.
pub fn report_due_at(day: Option(String), accepted_at: Int) -> Int {
  let base = case option.then(day, trial_date_ms) {
    Some(t) -> t
    None -> accepted_at
  }
  base + report_window_ms
}

// ----------------------------------------------------------------------------------------------------- text

/// Never HTML-interpreted anywhere. Control characters stripped, line breaks folded for a one-line field, trimmed;
/// empty is nothing. Error(True) when too long.
pub fn clean_text(
  raw: Option(String),
  max: Int,
  one_line: Bool,
) -> Result(Option(String), Nil) {
  case raw {
    None | Some("") -> Ok(None)
    Some(s) -> {
      let kept =
        string.to_utf_codepoints(s)
        |> list.filter(fn(cp) {
          let c = string.utf_codepoint_to_int(cp)
          !{
            { c >= 0x00 && c <= 0x08 }
            || c == 0x0B
            || c == 0x0C
            || { c >= 0x0E && c <= 0x1F }
            || c == 0x7F
          }
        })
        |> string.from_utf_codepoints
      let folded = case one_line {
        True -> fold_lines(kept)
        False -> kept
      }
      let t = string.trim(folded)
      case input.utf16_length(t) > max {
        True -> Error(Nil)
        False ->
          case t {
            "" -> Ok(None)
            _ -> Ok(Some(t))
          }
      }
    }
  }
}

fn fold_lines(s: String) -> String {
  string.to_graphemes(s)
  |> list.fold(#("", False), fn(acc, g) {
    let #(out, in_break) = acc
    case g == "\r" || g == "\n" || g == "\r\n" {
      True ->
        case in_break {
          True -> #(out, True)
          False -> #(out <> " ", True)
        }
      False -> #(out <> g, False)
    }
  })
  |> fn(acc) { acc.0 }
}

/// A venue as sent (each field already text or absent).
pub type VenueInput {
  VenueInput(
    name: Option(String),
    town: Option(String),
    address: Option(String),
  )
}

pub type Venue {
  Venue(name: String, town: Option(String), address: Option(String))
}

/// A name (required), a town, and an address.
pub fn validate_venue(raw: Option(VenueInput)) -> Result(Venue, Refusal) {
  let bad = fn(m) { Error(refusal("TRIAL_VENUE_INVALID", m)) }
  case raw {
    None -> bad("venue must be an object with at least a name.")
    Some(v) ->
      case clean_text(v.name, limit_venue_name, True) {
        Error(Nil) ->
          bad(
            "Keep the venue name under "
            <> int.to_string(limit_venue_name)
            <> " characters.",
          )
        Ok(None) -> bad("A venue needs a name.")
        Ok(Some(name)) ->
          case clean_text(v.town, limit_venue_town, True) {
            Error(Nil) ->
              bad(
                "Keep the town under "
                <> int.to_string(limit_venue_town)
                <> " characters.",
              )
            Ok(town) ->
              case clean_text(v.address, limit_venue_address, True) {
                Error(Nil) ->
                  bad(
                    "Keep the address under "
                    <> int.to_string(limit_venue_address)
                    <> " characters.",
                  )
                Ok(address) -> Ok(Venue(name:, town:, address:))
              }
          }
      }
  }
}

// ------------------------------------------------------------------------------------------------- sessions

/// A session as sent: the schema has judged the shapes; times are judged here.
pub type SessionInput {
  SessionInput(
    id: Option(String),
    kind: Option(String),
    starts_at: Option(Dynamic),
    ends_at: Option(Dynamic),
    venue: Option(VenueInput),
    instructions: Option(String),
  )
}

pub type ValidSession {
  ValidSession(
    kind: TrialSessionKind,
    starts_at: Int,
    ends_at: Int,
    venue: Venue,
    instructions: Option(String),
  )
}

fn schedule_refusal(message: String) -> Refusal {
  refusal("TRIAL_SCHEDULE_INVALID", message)
}

/// One session. A session the trial already has may have ended (`allow_past`); only new sessions are refused.
pub fn validate_session(
  raw: SessionInput,
  now: Int,
  allow_past: Bool,
) -> Result(ValidSession, Refusal) {
  let kind_text = option.unwrap(raw.kind, "training")
  use kind <- result.try(
    trial_session_kind.from_string(kind_text)
    |> result.replace_error(
      Refusal(
        "TRIAL_SCHEDULE_INVALID",
        "Session kind must be one of "
          <> string.join(session_kinds(), ", ")
          <> ".",
        [#("allowed", json.array(session_kinds(), json.string))],
      ),
    ),
  )
  let time = fn(v: Option(Dynamic), field) {
    case v {
      None -> Error(instant_refusal("not a date-time", field))
      Some(d) ->
        case dynamic.classify(d) {
          "Nil" -> Error(instant_refusal("not a date-time", field))
          _ -> instant(d) |> result.map_error(instant_refusal(_, field))
        }
    }
  }
  use start <- result.try(time(raw.starts_at, "startsAt"))
  use end <- result.try(time(raw.ends_at, "endsAt"))
  let len = end - start
  use <- guard(
    end <= start,
    schedule_refusal("A session must end after it starts."),
  )
  use <- guard(
    len < min_session_ms,
    schedule_refusal("A session is at least 15 minutes long."),
  )
  use <- guard(
    len > max_session_ms,
    schedule_refusal("A session is at most 12 hours long."),
  )
  use <- guard(
    !allow_past && end <= now,
    schedule_refusal("A session cannot be scheduled entirely in the past."),
  )
  use venue <- result.try(validate_venue(raw.venue))
  use instructions <- result.try(
    clean_text(raw.instructions, limit_instructions, False)
    |> result.replace_error(schedule_refusal(
      "Keep the instructions under "
      <> int.to_string(limit_instructions)
      <> " characters.",
    )),
  )
  Ok(ValidSession(kind:, starts_at: start, ends_at: end, venue:, instructions:))
}

fn guard(
  bad: Bool,
  r: Refusal,
  next: fn() -> Result(a, Refusal),
) -> Result(a, Refusal) {
  case bad {
    True -> Error(r)
    False -> next()
  }
}

/// A validated session with its id: carried from the trial, or minted.
pub type Planned {
  Planned(id: Option(id.TrialSessionId), session: ValidSession)
}

/// One organiser timezone, 1–20 sessions, no overlaps. Existing ids may be carried on a revision; a session
/// without one is new (its id is minted by the store). Sorted by start, then id.
pub fn validate_schedule(
  timezone: Option(String),
  sessions: Option(List(SessionInput)),
  now: Int,
  existing: List(id.TrialSessionId),
) -> Result(#(String, List(Planned)), Refusal) {
  use tz <- result.try(valid_timezone(timezone))
  case sessions {
    None -> Error(schedule_refusal("sessions must be a list."))
    Some([]) ->
      Error(schedule_refusal("A schedule needs at least one session."))
    Some(list_) -> {
      use <- guard(
        list.length(list_) > limit_sessions,
        schedule_refusal(
          "A trial has at most "
          <> int.to_string(limit_sessions)
          <> " sessions.",
        ),
      )
      let existing_text = list.map(existing, id.trial_session_to_string)
      use planned <- result.try(
        list.try_fold(list_, #([], []), fn(acc, s) {
          let #(out, seen) = acc
          let carried = case s.id {
            Some(sid) -> list.contains(existing_text, sid)
            None -> False
          }
          use v <- result.try(validate_session(s, now, carried))
          use sid <- result.try(case s.id {
            None | Some("") -> Ok(None)
            Some(sid) ->
              case list.contains(existing_text, sid) {
                True -> Ok(Some(sid))
                False ->
                  Error(refusal(
                    "TRIAL_SESSION_NOT_FOUND",
                    "A session id on a revision must name a session of this trial.",
                  ))
              }
          })
          case sid {
            Some(t) ->
              case list.contains(seen, t) {
                True -> Error(schedule_refusal("A session id appears twice."))
                False ->
                  Ok(
                    #([Planned(Some(id.trial_session(t)), v), ..out], [
                      t,
                      ..seen
                    ]),
                  )
              }
            None -> Ok(#([Planned(None, v), ..out], seen))
          }
        }),
      )
      Ok(#(tz, list.reverse(planned.0)))
    }
  }
}

/// Sorted by start, then the monotonic id part; and refused when two overlap. Called once every session has its
/// id.
pub fn order_sessions(
  sessions: List(#(id.TrialSessionId, ValidSession)),
) -> Result(List(#(id.TrialSessionId, ValidSession)), Refusal) {
  let sorted =
    list.sort(sessions, fn(a, b) {
      by_starts_then_id(#(a.1.starts_at, id.trial_session_to_string(a.0)), #(
        b.1.starts_at,
        id.trial_session_to_string(b.0),
      ))
    })
  let overlaps =
    list.window_by_2(sorted)
    |> list.any(fn(pair) { pair.1.1.starts_at < pair.0.1.ends_at })
  case overlaps {
    True -> Error(schedule_refusal("Sessions cannot overlap."))
    False -> Ok(sorted)
  }
}

/// The numeric part after the last `-` of an id (0 when there is none).
fn seq(text: String) -> Int {
  case list.last(string.split(text, "-")) {
    Ok(tail) -> result.unwrap(int.parse(tail), 0)
    Error(Nil) -> 0
  }
}

/// Start time, then the monotonic id part, then the id.
pub fn by_starts_then_id(a: #(Int, String), b: #(Int, String)) -> order.Order {
  case int.compare(a.0, b.0) {
    order.Eq ->
      case int.compare(seq(a.1), seq(b.1)) {
        order.Eq -> string.compare(a.1, b.1)
        other -> other
      }
    other -> other
  }
}

/// The current sessions by start, then id.
pub fn sorted_sessions(t: Trial) -> List(Session) {
  list.sort(t.sessions, fn(a, b) {
    by_starts_then_id(
      #(a.row.starts_at, id.trial_session_to_string(a.row.id)),
      #(b.row.starts_at, id.trial_session_to_string(b.row.id)),
    )
  })
}

/// A session compared for a material change: id, times, venue name and town.
pub type Compared {
  Compared(id: String, starts_at: Int, ends_at: Int, name: String, town: String)
}

/// Material: the timezone, the set of sessions, any start or end, a venue name or town. Not material: instructions,
/// the address line, the session kind.
pub fn material_change(
  prev: Option(#(String, List(Compared))),
  next: #(String, List(Compared)),
) -> Bool {
  case prev {
    None -> True
    Some(#(tz, sessions)) -> {
      let key = fn(s: Compared) {
        s.id
        <> "|"
        <> int.to_string(s.starts_at)
        <> "|"
        <> int.to_string(s.ends_at)
        <> "|"
        <> s.name
        <> "|"
        <> s.town
      }
      tz != next.0
      || list.length(sessions) != list.length(next.1)
      || list.sort(list.map(sessions, key), string.compare)
      != list.sort(list.map(next.1, key), string.compare)
    }
  }
}

pub fn compared(t: Trial) -> Option(#(String, List(Compared))) {
  case t.row.schedule_timezone, has_schedule(t) {
    Some(tz), True ->
      Some(#(
        tz,
        list.map(t.sessions, fn(s) {
          Compared(
            id: id.trial_session_to_string(s.row.id),
            starts_at: s.row.starts_at,
            ends_at: s.row.ends_at,
            name: option.unwrap(s.row.venue_name, ""),
            town: option.unwrap(s.row.venue_town, ""),
          )
        }),
      ))
    _, _ -> None
  }
}

// ---------------------------------------------------------------------------------------------------- state

/// A row with no operational containers.
pub fn is_legacy(t: Trial) -> Bool {
  t.row.workflow_state == LegacyAccepted
}

/// Derived from the authoritative fields; integrity checks the stored state against it.
pub fn workflow_state(t: Trial) -> TrialWorkflowState {
  case t.row.completion_state {
    Some(row.Cancelled) -> Cancelled
    Some(row.Completed) -> Completed
    None ->
      case is_legacy(t) && !has_schedule(t) {
        True -> LegacyAccepted
        False ->
          case t.row.schedule_confirmed_at, has_schedule(t), t.sessions {
            Some(_), True, [_, ..] -> Scheduled
            _, _, _ -> Accepted
          }
      }
  }
}

/// The state as derived from a schedule that would be confirmed (or not) with these sessions.
pub fn derive_with(
  t: Trial,
  confirmed: Bool,
  session_count: Int,
) -> TrialWorkflowState {
  case t.row.completion_state {
    Some(row.Cancelled) -> Cancelled
    Some(row.Completed) -> Completed
    None ->
      case confirmed && session_count > 0 {
        True -> Scheduled
        False -> Accepted
      }
  }
}

pub fn is_final(state: TrialWorkflowState) -> Bool {
  state == Completed || state == Cancelled
}

/// The latest attendance record per session.
pub fn current_attendance(
  t: Trial,
) -> Dict(id.TrialSessionId, attendance_row.Row) {
  list.fold(t.attendance, dict.new(), fn(acc, a) {
    dict.insert(acc, a.session_id, a)
  })
}

fn attended(state: attendance_row.State) -> Bool {
  state == attendance_row.Attended || state == attendance_row.Partial
}

/// How many sessions' current attendance says the player took part.
pub fn attended_count(t: Trial) -> Int {
  current_attendance(t)
  |> dict.values
  |> list.count(fn(a) { attended(a.state) })
}

/// The end of the latest-ending session, if any.
pub fn last_session_end(t: Trial) -> Option(Int) {
  list.fold(t.sessions, None, fn(acc, s) {
    case acc {
      Some(m) if m >= s.row.ends_at -> acc
      _ -> Some(s.row.ends_at)
    }
  })
}

/// Every reason is returned so the refusal says what is missing.
pub fn can_complete(t: Trial, now: Int) -> Result(Nil, Refusal) {
  let state = workflow_state(t)
  let att = current_attendance(t)
  let taken =
    list.any(t.sessions, fn(s) {
      case dict.get(att, s.row.id) {
        Ok(a) -> attended(a.state)
        Error(Nil) -> False
      }
    })
  let ended = case last_session_end(t) {
    Some(end) -> end <= now
    None -> False
  }
  let reasons =
    list.flatten([
      case state == Cancelled {
        True -> ["trial_cancelled"]
        False -> []
      },
      case state == Completed {
        True -> ["already_completed"]
        False -> []
      },
      case state != Scheduled && state != Completed && state != Cancelled {
        True -> ["schedule_not_confirmed"]
        False -> []
      },
      case taken {
        True -> []
        False -> ["no_attended_session"]
      },
      case ended {
        True -> []
        False -> ["last_session_not_ended"]
      },
    ])
  let with_reasons = [#("reasons", json.array(reasons, json.string))]
  case state, reasons {
    Completed, _ ->
      Error(Refusal(
        "TRIAL_INVALID_STATE",
        "This trial is already completed.",
        with_reasons,
      ))
    _, [_, ..] ->
      Error(Refusal(
        "TRIAL_COMPLETION_REQUIREMENTS_NOT_MET",
        "A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.",
        with_reasons,
      ))
    _, [] -> Ok(Nil)
  }
}

pub type Act {
  ScheduleAct
  RescheduleAct
  CancelAct
  AttendanceAct
  CompleteAct
  LinkAct
  ConfirmAct
}

/// Independent of role, block or case. Cancellation is possible from every open state.
pub fn state_allows(t: Trial, act: Act) -> Bool {
  let state = workflow_state(t)
  let open = state == Accepted || state == Scheduled || state == LegacyAccepted
  case act {
    ScheduleAct -> open
    RescheduleAct -> open && has_schedule(t)
    CancelAct -> open
    AttendanceAct -> state == Scheduled
    CompleteAct -> state == Scheduled
    LinkAct -> state == Scheduled || state == Completed
    ConfirmAct ->
      { state == Accepted || state == LegacyAccepted }
      && has_schedule(t)
      && t.row.schedule_confirmed_at == None
  }
}

/// Once the player or guardian has blocked the organisation, the club may only cancel an accepted trial (a safety
/// notice, not solicitation) and file the mandatory report.
pub fn blocked_allows(act: Option(Act)) -> Bool {
  act == Some(CancelAct)
}

// ------------------------------------------------------------------------------------------------ integrity

/// A problem list, never a repair: a corrupt row is omitted, counted and never evidence. A typed row can still
/// carry a stored state its facts disagree with, a timezone that is not a zone, an attendance row naming no
/// session, too many sessions or rev 0.
pub fn integrity(
  t: Trial,
  org_id: Option(id.OrgId),
  case_id: Option(id.RecruitmentCaseId),
) -> List(String) {
  let r = t.row
  let session_ids = list.map(t.sessions, fn(s) { s.row.id })
  list.flatten([
    case org_id {
      Some(o) if o != r.org_id -> ["org_mismatch"]
      _ -> []
    },
    case case_id {
      Some(c) if Some(c) != r.case_id -> ["case_mismatch"]
      _ -> []
    },
    case r.workflow_state == workflow_state(t) {
      True -> []
      False -> ["workflowState_mismatch"]
    },
    case has_schedule(t) {
      False -> []
      True ->
        list.flatten([
          case valid_timezone(r.schedule_timezone) {
            Ok(_) -> []
            Error(_) -> ["schedule.timezone"]
          },
          case
            list.any(t.sessions, fn(s) { s.row.ends_at <= s.row.starts_at })
          {
            True -> ["schedule.session_time"]
            False -> []
          },
          case list.length(t.sessions) > limit_sessions {
            True -> ["schedule.session_count"]
            False -> []
          },
        ])
    },
    case
      list.all(t.attendance, fn(a) { list.contains(session_ids, a.session_id) })
    {
      True -> []
      False -> ["attendance.record"]
    },
    case r.rev >= 1 {
      True -> []
      False -> ["rev"]
    },
  ])
}

// ------------------------------------------------------------------------------------------------- evidence

/// A sound trial of this case, confirmed and scheduled with at least one session: `trial_confirmed` evidence.
pub fn confirms(t: Trial) -> Bool {
  workflow_state(t) == Scheduled
  && t.row.schedule_confirmed_at != None
  && t.sessions != []
}

/// An explicitly completed trial: `trial_completed` evidence. A report is not completion.
pub fn completes(t: Trial) -> Bool {
  t.row.completion_state == Some(row.Completed)
  && workflow_state(t) == Completed
}

// ----------------------------------------------------------------------------------------------- projections

fn actor_kind_json(k: TrialActorKind) -> Json {
  trial_actor_kind.to_json(k)
}

/// The latest attendance view of a session.
fn attendance_view(a: Option(attendance_row.Row)) -> Json {
  case a {
    Some(a) ->
      json.object([
        #("state", attendance_row.state_to_json(a.state)),
        #("source", attendance_row.source_to_json(a.source)),
        #("recordedAt", json.int(a.recorded_at)),
      ])
    None ->
      json.object([
        #("state", json.string("not_recorded")),
        #("source", json.null()),
        #("recordedAt", json.null()),
      ])
  }
}

/// Who sees a schedule. An unrecognised viewer gets the narrowest view.
pub type Viewer {
  /// Everything operational, evidence included.
  ClubViewer
  /// The player or guardian who accepted: also the address and instructions held back from the invitation.
  FamilyViewer
  /// Times, kinds, venue name and town, attendance.
  AgentViewer
}

fn session_view(
  s: Session,
  att: Dict(id.TrialSessionId, attendance_row.Row),
  viewer: Viewer,
) -> Json {
  let r = s.row
  let detailed = viewer == ClubViewer || viewer == FamilyViewer
  let venue = case r.venue_name {
    None -> json.null()
    Some(name) ->
      json.object(
        list.flatten([
          [
            #("name", json.string(name)),
            #("town", json.nullable(r.venue_town, json.string)),
          ],
          case detailed {
            True -> [#("address", json.nullable(r.venue_address, json.string))]
            False -> []
          },
        ]),
      )
  }
  json.object(
    list.flatten([
      [
        #("id", id.trial_session_json(r.id)),
        #("kind", trial_session_kind.to_json(r.kind)),
        #("startsAt", json.int(r.starts_at)),
        #("endsAt", json.int(r.ends_at)),
        #("venue", venue),
      ],
      case detailed {
        True -> [#("instructions", json.nullable(r.instructions, json.string))]
        False -> []
      },
      [
        #(
          "attendance",
          attendance_view(option.from_result(dict.get(att, r.id))),
        ),
      ],
      case viewer == ClubViewer {
        True -> [
          #(
            "evidence",
            json.array(s.evidence, fn(e) {
              json.object([
                #("id", id.trial_evidence_json(e.id)),
                #("kind", evidence_row.kind_to_json(e.kind)),
                #("sessionId", id.box_session_json(e.box_session_id)),
                #("linkedAt", json.int(e.linked_at)),
              ])
            }),
          ),
        ]
        False -> []
      },
    ]),
  )
}

/// A legacy row carries a date-only, timezone-less entry, flagged; a row with neither is `null`.
pub fn schedule_view(t: Trial, viewer: Viewer) -> Json {
  let r = t.row
  case has_schedule(t) {
    False ->
      case is_trial_date(r.proposed_date) {
        True ->
          json.object([
            #("legacy", json.bool(True)),
            #("timezone", json.null()),
            #("revision", json.int(0)),
            #("confirmedAt", json.null()),
            #("date", json.nullable(r.proposed_date, json.string)),
            #("sessions", json.preprocessed_array([])),
          ])
        False -> json.null()
      }
    True -> {
      let att = current_attendance(t)
      json.object([
        #("legacy", json.bool(False)),
        #("timezone", json.nullable(r.schedule_timezone, json.string)),
        #("revision", json.nullable(r.schedule_revision, json.int)),
        #("confirmedAt", json.nullable(r.schedule_confirmed_at, json.int)),
        #("confirmedBy", case r.schedule_confirmed_by_kind {
          Some(k) -> json.object([#("kind", actor_kind_json(k))])
          None -> json.null()
        }),
        #("proposedAt", json.nullable(r.schedule_proposed_at, json.int)),
        #("awaitingConfirmation", json.bool(r.schedule_confirmed_at == None)),
        #(
          "sessions",
          json.array(sorted_sessions(t), session_view(_, att, viewer)),
        ),
      ])
    }
  }
}

fn kind_name(kind: Option(TrialActorKind), name: Option(String)) -> Json {
  case kind {
    Some(k) ->
      json.object([
        #("kind", actor_kind_json(k)),
        #("name", json.nullable(name, json.string)),
      ])
    None -> json.null()
  }
}

/// The history, by time then id: ids, states and times only.
pub fn history_view(t: Trial) -> List(Json) {
  t.history
  |> list.sort(fn(a, b) {
    case int.compare(a.at, b.at) {
      order.Eq ->
        int.compare(
          seq(id.trial_event_to_string(a.id)),
          seq(id.trial_event_to_string(b.id)),
        )
      other -> other
    }
  })
  |> list.map(fn(h) {
    json.object([
      #("id", id.trial_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("by", kind_name(h.by_kind, h.by_name)),
      #("detail", detail_json(h.detail_json)),
    ])
  })
}

pub fn detail_json(text: Option(String)) -> Json {
  case text {
    None -> json.null()
    Some(t) -> json_text.parse(t) |> result.unwrap(json.null())
  }
}

/// Live, never-removed evidence links.
pub fn evidence_count(t: Trial) -> Int {
  list.fold(t.sessions, 0, fn(n, s) {
    n + list.count(s.evidence, fn(e) { e.removed_at == None })
  })
}

fn completion_cancelled_by_json(c: row.CompletionCancelledBy) -> Json {
  row.completion_cancelled_by_to_json(c)
}

/// Never the family's emergency contact, never a Box Cam payload.
pub fn club_view(t: Trial) -> Json {
  let r = t.row
  let state = workflow_state(t)
  json.object([
    #("id", id.trial_json(r.id)),
    #("caseId", json.nullable(r.case_id, id.recruitment_case_json)),
    #("requestId", id.request_json(r.request_id)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #("orgId", id.org_json(r.org_id)),
    #("workflowState", trial_workflow_state.to_json(state)),
    #("workflowLabel", json.string(label(state))),
    #("legacy", json.bool(is_legacy(t))),
    #("reportStatus", row.status_to_json(r.status)),
    #("reportDueAt", json.nullable(r.report_due_at, json.int)),
    #("hasReport", json.bool(t.report != None)),
    #("acceptedAt", json.int(r.accepted_at)),
    #("acceptedBy", json.nullable(r.accepted_by, party.to_json)),
    #("guardianApproved", json.nullable(r.guardian_approved, json.bool)),
    #("proposedDate", json.nullable(r.proposed_date, json.string)),
    #("venue", json.nullable(r.venue, json.string)),
    #("schedule", schedule_view(t, ClubViewer)),
    #(
      "revisions",
      json.array(t.revisions, fn(v) {
        let v_ = v.row
        json.object([
          #("revision", json.int(v_.revision)),
          #("proposedAt", json.nullable(v_.proposed_at, json.int)),
          #("proposedBy", kind_name(v_.proposed_by_kind, v_.proposed_by_name)),
          #("confirmedAt", json.nullable(v_.confirmed_at, json.int)),
          #("supersededAt", json.nullable(v_.superseded_at, json.int)),
          #("reason", json.nullable(v_.reason, json.string)),
          #("material", json.nullable(v_.material, json.bool)),
          #("sessionCount", json.int(list.length(v.sessions))),
        ])
      }),
    ),
    #(
      "attendanceHistory",
      json.array(t.attendance, fn(a) {
        json.object([
          #("sessionId", id.trial_session_json(a.session_id)),
          #("state", attendance_row.state_to_json(a.state)),
          #("source", attendance_row.source_to_json(a.source)),
          #("recordedAt", json.int(a.recorded_at)),
          #("recordedBy", case a.recorded_by_kind {
            Some(_) ->
              json.object([
                #("name", json.nullable(a.recorded_by_name, json.string)),
              ])
            None -> json.null()
          }),
          #("note", json.nullable(a.note, json.string)),
        ])
      }),
    ),
    #("completion", case r.completion_state, r.completion_at {
      Some(cs), Some(at) ->
        json.object([
          #("state", row.completion_state_to_json(cs)),
          #("at", json.int(at)),
          #("by", kind_name(r.completion_by_kind, r.completion_by_name)),
          #("reason", json.nullable(r.completion_reason, json.string)),
          #(
            "phase",
            json.nullable(r.completion_phase, trial_workflow_state.to_json),
          ),
          #(
            "cancelledBy",
            json.nullable(
              r.completion_cancelled_by,
              completion_cancelled_by_json,
            ),
          ),
        ])
      _, _ -> json.null()
    }),
    #("recipient", case r.recipient_type {
      Some(rt) ->
        json.object([
          #("type", party.to_json(rt)),
          #("minor", json.bool(r.recipient_minor == Some(True))),
        ])
      None -> json.null()
    }),
    #("blockedBy", json.null()),
    #("subjectRemovedAt", json.nullable(r.subject_removed_at, json.int)),
    #("evidenceCount", json.int(evidence_count(t))),
    #("history", json.preprocessed_array(history_view(t))),
    #("rev", json.int(r.rev)),
    #("revAt", json.nullable(r.rev_at, json.int)),
    #("policyVersion", json.int(policy_version)),
  ])
}

/// No caseId, history, evidence or assessment. The address and instructions are shared because a trial row exists
/// only after acceptance.
pub fn family_view(t: Trial) -> Json {
  let r = t.row
  let state = workflow_state(t)
  json.object([
    #("id", id.trial_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.string(r.org_name)),
    #("playerId", id.player_json(r.player_id)),
    #("workflowState", trial_workflow_state.to_json(state)),
    #("workflowLabel", json.string(label(state))),
    #("legacy", json.bool(is_legacy(t))),
    #("acceptedAt", json.int(r.accepted_at)),
    #("proposedDate", json.nullable(r.proposed_date, json.string)),
    #("venue", json.nullable(r.venue, json.string)),
    #("schedule", schedule_view(t, FamilyViewer)),
    #(
      "awaitingYourConfirmation",
      json.bool(has_schedule(t) && r.schedule_confirmed_at == None),
    ),
    #("completion", case r.completion_state, r.completion_at {
      Some(cs), Some(at) ->
        json.object([
          #("state", row.completion_state_to_json(cs)),
          #("at", json.int(at)),
          #("byKind", json.nullable(r.completion_by_kind, actor_kind_json)),
          #("reason", case cs {
            row.Cancelled -> json.nullable(r.completion_reason, json.string)
            row.Completed -> json.null()
          }),
        ])
      _, _ -> json.null()
    }),
    #("reportStatus", row.status_to_json(r.status)),
    #("hasReport", json.bool(t.report != None)),
    #("rev", json.int(r.rev)),
  ])
}

/// Ids, states, times, counts. Never text.
pub fn milestone(t: Trial) -> List(#(String, Json)) {
  let r = t.row
  let att = current_attendance(t)
  [
    #("id", id.trial_json(r.id)),
    #("caseId", json.nullable(r.case_id, id.recruitment_case_json)),
    #("requestId", id.request_json(r.request_id)),
    #("workflowState", trial_workflow_state.to_json(workflow_state(t))),
    #("legacy", json.bool(is_legacy(t))),
    #("reportStatus", row.status_to_json(r.status)),
    #("hasReport", json.bool(t.report != None)),
    #("acceptedAt", json.int(r.accepted_at)),
    #("scheduledAt", json.nullable(r.schedule_confirmed_at, json.int)),
    #("revision", json.int(option.unwrap(r.schedule_revision, 0))),
    #(
      "sessions",
      json.array(sorted_sessions(t), fn(s) {
        json.object([
          #("id", id.trial_session_json(s.row.id)),
          #("kind", trial_session_kind.to_json(s.row.kind)),
          #("startsAt", json.int(s.row.starts_at)),
          #("endsAt", json.int(s.row.ends_at)),
          #("attendance", case dict.get(att, s.row.id) {
            Ok(a) -> attendance_row.state_to_json(a.state)
            Error(Nil) -> json.string("not_recorded")
          }),
          #(
            "evidenceCount",
            json.int(list.count(s.evidence, fn(e) { e.removed_at == None })),
          ),
        ])
      }),
    ),
    #("completion", completion_milestone(t)),
    #("evidenceCount", json.int(evidence_count(t))),
  ]
}

pub fn completion_milestone(t: Trial) -> Json {
  let r = t.row
  case r.completion_state, r.completion_at {
    Some(cs), Some(at) ->
      json.object([
        #("state", row.completion_state_to_json(cs)),
        #("at", json.int(at)),
        #("byKind", json.nullable(r.completion_by_kind, actor_kind_json)),
      ])
    _, _ -> json.null()
  }
}

/// What a minor's own device may show: state only.
pub fn outcome_line(t: Trial) -> Json {
  let state = workflow_state(t)
  json.object([
    #("id", id.trial_json(t.row.id)),
    #("orgName", json.string(t.row.org_name)),
    #("workflowState", trial_workflow_state.to_json(state)),
    #("workflowLabel", json.string(label(state))),
    #("guardianManaged", json.bool(True)),
  ])
}
