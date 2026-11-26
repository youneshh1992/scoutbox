//// The trial rules' calls the generated cases can't make (scripts/rules/recruitment/trials.mjs,
//// trialDatesMinorsAndErasure.mjs and platform/dates.mjs), ported by hand.
////
//// The TypeScript rules judge values no request or stored row here can carry, so none reaches a rule:
////
//// - a trial date, a timezone or instructions that aren't text are refused by the route's shape (`words`, and the
////   request's `anything` fields read by validate_details), under the rule's own code. NaN, ±Infinity, symbols and
////   functions can't be written in JSON at all, and a body is JSON;
//// - a trial request body that isn't an object, or that names a field its shape doesn't know (`constructor`,
////   `toString`, …), is refused by the shape before validateTrialDetails (strictObject on both servers);
//// - a trial is accepted from a stored request, which always has its days, so chooseTrialSlot is never handed null
////   or text for one;
//// - a trial row's workflow state, completion state and attendance are typed columns and child rows of STRICT
////   tables: trialIntegrity's "flying", "done" and attendance "yes" can't be stored;
//// - a Room role is derived from a membership, never read from text, so "admin" is no role; the acts are a closed
////   type, so "assess" and "constructor" are no acts.
////
//// validateScheduleInput is called with a `mintId` closure the recorder can't keep. Here the store mints a new
//// session's id inside the act, so its calls run as the route runs them: the shape, validate_schedule, ids minted
//// in order, then order_sessions. The views' fixture leaves out the request every trial names; they run over a
//// complete trial with the TypeScript views' answers for it.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/battery/base
import scoutbox/platform/input
import scoutbox/recruitment/request_routes
import scoutbox/recruitment/trial_rules.{type ValidSession}
import scoutbox/rows/id
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rows/trial_history as history_row
import scoutbox/rows/trial_keys as key_row
import scoutbox/rows/trial_schedule_sessions as session_row
import scoutbox/rows/trial_session_evidence as evidence_row
import scoutbox/rows/trials as trial_row
import scoutbox/vocab/party
import scoutbox/vocab/trial_actor_kind
import scoutbox/vocab/trial_session_kind
import scoutbox/vocab/trial_workflow_state

// ------------------------------------------------------------------------------------------- at the route's shape

/// The values the suite hands parseTrialDate that aren't text, as JSON.
const not_text = [
  "{}", "[]", "0", "true", "false", "1000000000000", "-1",
  "{\"$date\":1790985600000}", "{\"proposedDate\":\"2026-10-03\"}",
  "[\"2026-10-03\"]",
]

pub fn a_trial_date_that_is_not_text_is_refused_as_not_text_test() {
  list.each(not_text, fn(text) {
    let assert Error(fields) =
      trial_rules.validate_details(Some(base.body(text)), None, None, None)
    assert json.to_string(json.object(fields))
      == "{\"ok\":false,\"error\":\"TRIAL_DATE_INVALID\",\"message\":\"A trial date must be a calendar day written YYYY-MM-DD (not text).\",\"expected\":\"YYYY-MM-DD\",\"field\":\"proposedDate\"}"
  })
}

pub fn no_trial_date_is_no_date_test() {
  let none = fn(v) {
    trial_rules.validate_details(v, None, None, None)
    |> result.map(fn(d) { d.proposed_date })
  }
  assert none(None) == Ok(None)
  assert none(Some(base.body("null"))) == Ok(None)
  assert none(Some(base.body("\"\""))) == Ok(None)
}

pub fn json_has_no_nan_or_infinity_test() {
  assert result.is_error(json.parse("NaN", decode.dynamic))
  assert result.is_error(json.parse("Infinity", decode.dynamic))
}

fn request_body(text: String) -> Result(Nil, #(String, input.Problem)) {
  input.parse_coded(
    request_routes.direct_shape(),
    base.body(text),
    root: "body",
    codes: [],
    default: "FIELD_INVALID",
  )
  |> result.replace(Nil)
  |> result.map_error(fn(r) { #(r.field, r.problem) })
}

pub fn a_trial_request_that_is_not_an_object_is_refused_by_its_shape_test() {
  list.each(["null", "\"text\"", "42"], fn(text) {
    assert request_body(text) == Error(#("body", input.NotObject))
  })
}

pub fn a_trial_request_naming_an_inherited_key_is_refused_by_its_shape_test() {
  list.each(
    ["constructor", "prototype", "toString", "valueOf", "hasOwnProperty"],
    fn(key) {
      assert request_body(
          "{\"type\":\"trial\",\""
          <> key
          <> "\":{\"proposedDate\":\"bad\"},\"proposedDate\":\"2026-10-03\"}",
        )
        == Error(#(key, input.UnknownField))
    },
  )
  assert request_body("{\"type\":\"trial\",\"proposedDate\":\"2026-10-03\"}")
    == Ok(Nil)
}

/// A schedule body's refusal code, read with the schedule route's own checks.
fn schedule_code(body: String) -> Result(Nil, String) {
  let shape = {
    use timezone <- input.field("timezone", trial_rules.words())
    use sessions <- input.field("sessions", trial_rules.sessions_check())
    input.done(#(timezone, sessions))
  }
  input.parse_coded(
    shape,
    base.body(body),
    root: "body",
    codes: trial_rules.input_codes,
    default: trial_rules.input_default,
  )
  |> result.replace(Nil)
  |> result.map_error(fn(r) { r.error })
}

pub fn a_timezone_that_is_not_text_is_refused_by_the_shape_test() {
  list.each(["[]", "{}", "42"], fn(tz) {
    assert schedule_code("{\"timezone\":" <> tz <> "}")
      == Error("TRIAL_TIMEZONE_INVALID")
  })
}

pub fn instructions_that_are_not_text_are_refused_by_the_shape_test() {
  assert schedule_code(
      "{\"sessions\":[{\"startsAt\":1,\"endsAt\":2,\"venue\":{\"name\":\"F\"},\"instructions\":12}]}",
    )
    == Error("TRIAL_SCHEDULE_INVALID")
}

// --------------------------------------------------------------------------------------------- unstorable rows

pub fn values_no_trial_row_can_hold_test() {
  assert trial_workflow_state.from_string("flying") == Error(Nil)
  assert list.key_find(trial_row.completion_state_pairs, "done") == Error(Nil)
}

pub fn a_stored_request_without_days_takes_no_date_test() {
  assert trial_rules.choose_slot(None, [], None) == Ok(None)
}

// --------------------------------------------------------------------------------------------------- schedules

/// 2026-10-01T12:00:00Z, the trials suite's now.
const now = 1_790_856_000_000

fn at(minutes: Int) -> Int {
  now + minutes * 60_000
}

fn dome() -> Json {
  json.object([
    #("name", json.string("Dome")),
    #("town", json.string("Eastport")),
  ])
}

/// A session from `from` to `to` minutes after now, at the Dome.
fn session(from: Int, to: Int, extra: List(#(String, Json))) -> Json {
  json.object(list.append(
    [
      #("startsAt", json.int(at(from))),
      #("endsAt", json.int(at(to))),
      #("venue", dome()),
    ],
    extra,
  ))
}

fn london(sessions: List(Json)) -> String {
  json.to_string(
    json.object([
      #("timezone", json.string("Europe/London")),
      #("sessions", json.preprocessed_array(sessions)),
    ]),
  )
}

/// The schedule route's judgement of `body`: its shape, then validate_schedule, then each new session's id minted
/// in order (`tses-1`, …), then order_sessions. Error: the refusal's code.
fn schedule(
  body: String,
  now: Int,
  existing: List(String),
) -> Result(List(#(String, ValidSession)), String) {
  let shape = {
    use timezone <- input.field("timezone", trial_rules.words())
    use sessions <- input.field("sessions", trial_rules.sessions_check())
    input.done(#(timezone, sessions))
  }
  use #(tz, sessions) <- result.try(
    input.parse_coded(
      shape,
      base.body(body),
      root: "body",
      codes: trial_rules.input_codes,
      default: trial_rules.input_default,
    )
    |> result.map_error(fn(r) { r.error }),
  )
  use #(_, planned) <- result.try(
    trial_rules.validate_schedule(
      tz,
      sessions,
      now,
      list.map(existing, id.trial_session),
    )
    |> result.map_error(fn(r) { r.error }),
  )
  let #(_, with_ids) =
    list.map_fold(planned, 0, fn(minted, p) {
      case p.id {
        Some(sid) -> #(minted, #(sid, p.session))
        None -> #(
          minted + 1,
          #(id.trial_session("tses-" <> int.to_string(minted + 1)), p.session),
        )
      }
    })
  trial_rules.order_sessions(with_ids)
  |> result.map(list.map(_, fn(s) { #(id.trial_session_to_string(s.0), s.1) }))
  |> result.map_error(fn(r) { r.error })
}

fn code(r: Result(a, String)) -> Result(Nil, String) {
  result.replace(r, Nil)
}

pub fn a_valid_schedule_mints_ids_and_defaults_the_kind_test() {
  let assert Ok([#("tses-1", first), #("tses-2", second)]) =
    schedule(
      london([
        session(120, 240, []),
        session(1560, 1680, [#("kind", json.string("match"))]),
      ]),
      now,
      [],
    )
  assert first.kind == trial_session_kind.Training
  assert second.kind == trial_session_kind.Match
}

/// `n` back-to-back hour-long sessions a day apart.
fn daily(n: Int) -> String {
  london(
    list.repeat(Nil, n)
    |> list.index_map(fn(_, i) { session(120 + i * 1440, 240 + i * 1440, []) }),
  )
}

pub fn a_schedule_has_one_to_twenty_sessions_test() {
  assert code(schedule(london([]), now, [])) == Error("TRIAL_SCHEDULE_INVALID")
  assert code(schedule(daily(21), now, [])) == Error("TRIAL_SCHEDULE_INVALID")
  assert code(schedule(daily(20), now, [])) == Ok(Nil)
}

pub fn sessions_may_meet_but_not_overlap_test() {
  assert code(
      schedule(london([session(120, 240, []), session(180, 300, [])]), now, []),
    )
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(
      schedule(london([session(120, 240, []), session(240, 360, [])]), now, []),
    )
    == Ok(Nil)
}

pub fn a_session_is_fifteen_minutes_to_twelve_hours_test() {
  assert code(schedule(london([session(120, 132, [])]), now, []))
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(schedule(london([session(120, 870, [])]), now, []))
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(schedule(london([session(240, 120, [])]), now, []))
    == Error("TRIAL_SCHEDULE_INVALID")
}

pub fn a_new_session_may_not_have_ended_test() {
  assert code(schedule(london([session(-300, -180, [])]), now, []))
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(schedule(london([session(-30, 30, [])]), now, [])) == Ok(Nil)
}

pub fn an_unknown_session_kind_is_refused_test() {
  assert code(
      schedule(
        london([session(120, 240, [#("kind", json.string("sparring"))])]),
        now,
        [],
      ),
    )
    == Error("TRIAL_SCHEDULE_INVALID")
}

pub fn a_revision_names_only_this_trials_sessions_once_test() {
  assert code(
      schedule(
        london([session(120, 240, [#("id", json.string("tses-999"))])]),
        now,
        ["tses-1"],
      ),
    )
    == Error("TRIAL_SESSION_NOT_FOUND")
  assert code(
      schedule(
        london([
          session(120, 240, [#("id", json.string("tses-1"))]),
          session(1560, 1680, [#("id", json.string("tses-1"))]),
        ]),
        now,
        ["tses-1"],
      ),
    )
    == Error("TRIAL_SCHEDULE_INVALID")
}

pub fn wrong_input_types_are_refused_by_the_shape_test() {
  // A numeric id isn't an id; a venue is an object with a name.
  assert code(
      schedule(london([session(120, 240, [#("id", json.int(7))])]), now, [
        "tses-1",
      ]),
    )
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(
      schedule(
        london([
          json.object([
            #("startsAt", json.int(at(120))),
            #("endsAt", json.int(at(240))),
            #("venue", json.string("Dome")),
          ]),
        ]),
        now,
        [],
      ),
    )
    == Error("TRIAL_VENUE_INVALID")
  assert code(
      schedule(
        "{\"timezone\":\"Europe/London\",\"sessions\":\"lots\"}",
        now,
        [],
      ),
    )
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(
      schedule("{\"timezone\":\"Europe/London\",\"sessions\":[null]}", now, []),
    )
    == Error("TRIAL_SCHEDULE_INVALID")
  assert result.is_error(schedule("\"x\"", now, []))
}

/// The dates suite's schedules: from 2026-06-01T09:00Z, hour-long sessions two hours apart.
fn hourly(n: Int, tz: String, from: Int) -> String {
  let hour = 3_600_000
  json.to_string(
    json.object([
      #("timezone", json.string(tz)),
      #(
        "sessions",
        json.preprocessed_array(
          list.repeat(Nil, n)
          |> list.index_map(fn(_, i) {
            json.object([
              #("startsAt", json.int(from + i * 2 * hour)),
              #("endsAt", json.int(from + i * 2 * hour + hour)),
              #("venue", json.object([#("name", json.string("Field"))])),
            ])
          }),
        ),
      ),
    ]),
  )
}

pub fn the_dates_suites_schedules_test() {
  // 2026-01-01, and sessions from 2026-06-01T09:00Z.
  let jan = 1_767_225_600_000
  let june = 1_780_304_400_000
  assert code(schedule(hourly(20, "Europe/London", june), jan, [])) == Ok(Nil)
  assert code(schedule(hourly(21, "Europe/London", june), jan, []))
    == Error("TRIAL_SCHEDULE_INVALID")
  assert code(schedule(hourly(0, "Europe/London", june), jan, []))
    == Error("TRIAL_SCHEDULE_INVALID")
  list.each(["europe/london", "Mars/Olympus", "GMT"], fn(tz) {
    assert code(schedule(hourly(1, tz, june), jan, []))
      == Error("TRIAL_TIMEZONE_INVALID")
  })
  let overlap =
    json.to_string(
      json.object([
        #("timezone", json.string("Europe/London")),
        #(
          "sessions",
          json.preprocessed_array([
            json.object([
              #("startsAt", json.int(june)),
              #("endsAt", json.int(june + 7_200_000)),
              #("venue", json.object([#("name", json.string("A"))])),
            ]),
            json.object([
              #("startsAt", json.int(june + 3_600_000)),
              #("endsAt", json.int(june + 10_800_000)),
              #("venue", json.object([#("name", json.string("B"))])),
            ]),
          ]),
        ),
      ]),
    )
  assert code(schedule(overlap, jan, [])) == Error("TRIAL_SCHEDULE_INVALID")
  // O#15: a 21-session revision from 2026-09-23T12:00Z is refused.
  assert code(schedule(hourly(21, "Europe/London", 1_790_164_800_000), 1, []))
    == Error("TRIAL_SCHEDULE_INVALID")
}

// ------------------------------------------------------------------------------------------------------- views

/// The suite's scheduled trial, as stored: with its request, a key, an emergency contact and a private note.
fn stored() -> trial_rules.Trial {
  let b = base.trial()
  let tid = id.trial("t")
  trial_rules.Trial(
    ..b,
    row: trial_row.Row(
      ..b.row,
      id: tid,
      request_id: id.request("req-1"),
      case_id: Some(id.recruitment_case("k1")),
      player_id: id.player("p"),
      player_name: Some("P"),
      org_id: id.org("o"),
      org_name: "O",
      accepted_at: 1,
      proposed_date: Some("2026-10-01"),
      venue: Some("Dome"),
      workflow_state: trial_workflow_state.Scheduled,
      schedule_timezone: Some("Europe/London"),
      schedule_revision: Some(1),
      schedule_confirmed_at: Some(5),
      recipient_type: Some(party.Player),
      recipient_player_id: Some(id.player("p")),
      recipient_minor: Some(False),
      day_emergency_name: Some("PRIVATE_EMERGENCY_SENTINEL_7713"),
      day_emergency_phone: Some("0777"),
      day_emergency_at: Some(1),
      rev: 3,
    ),
    sessions: [
      trial_rules.Session(
        row: session_row.Row(
          ..base.trial_session(),
          trial_id: tid,
          id: id.trial_session("s1"),
          kind: trial_session_kind.Training,
          starts_at: 10,
          ends_at: 20,
          venue_name: Some("Dome"),
          venue_town: Some("E"),
          venue_address: Some("Gate B"),
          instructions: Some("Ask for Priya"),
        ),
        evidence: [
          evidence_row.new(
            trial_id: tid,
            session_id: id.trial_session("s1"),
            position: 0,
            id: id.trial_evidence("e1"),
            kind: evidence_row.BoxCamSession,
            box_session_id: id.box_session("bx1"),
            linked_at: 1,
          ),
        ],
      ),
    ],
    attendance: [
      attendance_row.Row(
        ..base.trial_attendance(),
        trial_id: tid,
        session_id: id.trial_session("s1"),
        state: attendance_row.Attended,
        source: attendance_row.Manual,
        recorded_at: 12,
        recorded_by_kind: Some(trial_actor_kind.Org),
        recorded_by_user_id: Some("u1"),
        recorded_by_name: Some("Maria"),
        note: Some("PRIVATE_TRIAL_NOTE_SENTINEL_5284"),
      ),
    ],
    history: [
      history_row.Row(
        ..history_row.new(
          trial_id: tid,
          position: 0,
          id: id.trial_event("aud-1"),
          at: 1,
          action: "trial_accepted",
        ),
        by_kind: Some(trial_actor_kind.Player),
        by_actor_id: Some("p"),
        by_name: Some("Kola"),
        detail_json: Some("{\"day\":\"2026-10-01\"}"),
      ),
    ],
    keys: [
      key_row.new(
        trial_id: tid,
        act: key_row.Schedule,
        position: 0,
        key: "secret-key",
        fp: "x",
        at: 1,
      ),
    ],
  )
}

pub fn the_club_view_test() {
  assert json.to_string(trial_rules.club_view(stored()))
    == "{\"id\":\"t\",\"caseId\":\"k1\",\"requestId\":\"req-1\",\"playerId\":\"p\",\"playerName\":\"P\",\"orgId\":\"o\",\"workflowState\":\"scheduled\",\"workflowLabel\":\"Scheduled\",\"legacy\":false,\"reportStatus\":\"awaiting_report\",\"reportDueAt\":null,\"hasReport\":false,\"acceptedAt\":1,\"acceptedBy\":null,\"guardianApproved\":null,\"proposedDate\":\"2026-10-01\",\"venue\":\"Dome\",\"schedule\":{\"legacy\":false,\"timezone\":\"Europe/London\",\"revision\":1,\"confirmedAt\":5,\"confirmedBy\":null,\"proposedAt\":null,\"awaitingConfirmation\":false,\"sessions\":[{\"id\":\"s1\",\"kind\":\"training\",\"startsAt\":10,\"endsAt\":20,\"venue\":{\"name\":\"Dome\",\"town\":\"E\",\"address\":\"Gate B\"},\"instructions\":\"Ask for Priya\",\"attendance\":{\"state\":\"attended\",\"source\":\"manual\",\"recordedAt\":12},\"evidence\":[{\"id\":\"e1\",\"kind\":\"box_cam_session\",\"sessionId\":\"bx1\",\"linkedAt\":1}]}]},\"revisions\":[],\"attendanceHistory\":[{\"sessionId\":\"s1\",\"state\":\"attended\",\"source\":\"manual\",\"recordedAt\":12,\"recordedBy\":{\"name\":\"Maria\"},\"note\":\"PRIVATE_TRIAL_NOTE_SENTINEL_5284\"}],\"completion\":null,\"recipient\":{\"type\":\"player\",\"minor\":false},\"blockedBy\":null,\"subjectRemovedAt\":null,\"evidenceCount\":1,\"history\":[{\"id\":\"aud-1\",\"at\":1,\"action\":\"trial_accepted\",\"by\":{\"kind\":\"player\",\"name\":\"Kola\"},\"detail\":{\"day\":\"2026-10-01\"}}],\"rev\":3,\"revAt\":null,\"policyVersion\":1}"
}

pub fn the_family_view_test() {
  assert json.to_string(trial_rules.family_view(stored()))
    == "{\"id\":\"t\",\"orgId\":\"o\",\"orgName\":\"O\",\"playerId\":\"p\",\"workflowState\":\"scheduled\",\"workflowLabel\":\"Scheduled\",\"legacy\":false,\"acceptedAt\":1,\"proposedDate\":\"2026-10-01\",\"venue\":\"Dome\",\"schedule\":{\"legacy\":false,\"timezone\":\"Europe/London\",\"revision\":1,\"confirmedAt\":5,\"confirmedBy\":null,\"proposedAt\":null,\"awaitingConfirmation\":false,\"sessions\":[{\"id\":\"s1\",\"kind\":\"training\",\"startsAt\":10,\"endsAt\":20,\"venue\":{\"name\":\"Dome\",\"town\":\"E\",\"address\":\"Gate B\"},\"instructions\":\"Ask for Priya\",\"attendance\":{\"state\":\"attended\",\"source\":\"manual\",\"recordedAt\":12}}]},\"awaitingYourConfirmation\":false,\"completion\":null,\"reportStatus\":\"awaiting_report\",\"hasReport\":false,\"rev\":3}"
}

pub fn the_milestone_test() {
  assert json.to_string(json.object(trial_rules.milestone(stored())))
    == "{\"id\":\"t\",\"caseId\":\"k1\",\"requestId\":\"req-1\",\"workflowState\":\"scheduled\",\"legacy\":false,\"reportStatus\":\"awaiting_report\",\"hasReport\":false,\"acceptedAt\":1,\"scheduledAt\":5,\"revision\":1,\"sessions\":[{\"id\":\"s1\",\"kind\":\"training\",\"startsAt\":10,\"endsAt\":20,\"attendance\":\"attended\",\"evidenceCount\":1}],\"completion\":null,\"evidenceCount\":1}"
}

pub fn the_outcome_line_test() {
  assert json.to_string(trial_rules.outcome_line(stored()))
    == "{\"id\":\"t\",\"orgName\":\"O\",\"workflowState\":\"scheduled\",\"workflowLabel\":\"Scheduled\",\"guardianManaged\":true}"
}

pub fn no_view_carries_the_key_emergency_contact_or_note_test() {
  let t = stored()
  let texts = [
    json.to_string(trial_rules.family_view(t)),
    json.to_string(json.object(trial_rules.milestone(t))),
    json.to_string(trial_rules.outcome_line(t)),
  ]
  list.each(texts, fn(text) {
    assert !string.contains(text, "secret-key")
    assert !string.contains(text, "PRIVATE_EMERGENCY_SENTINEL_7713")
    assert !string.contains(text, "PRIVATE_TRIAL_NOTE_SENTINEL_5284")
  })
  let club = json.to_string(trial_rules.club_view(t))
  assert !string.contains(club, "secret-key")
  assert !string.contains(club, "PRIVATE_EMERGENCY_SENTINEL_7713")
}
