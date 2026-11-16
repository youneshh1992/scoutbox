//// The Football Passport's player self view (domains/passport/passport.mjs `buildFor(player, 'self')`): one
//// projection per player, describing evidence and provenance, never a rating.
////
//// A trial is not employment: it stands on the timeline as `trial_attended`, keyed on a recorded attendance (a
//// legacy row stands for its accepted day and says so), and its report as a private `trial_outcome`. An assessment
//// is an existence fact only.
////
//// Not ported yet: every other source of the Passport (verification claims, references, footage evidence,
//// squads, signings and career entries, achievements, development objectives, applications, transitions, agents,
//// Box Cam's sessions, challenges and Combine results, position history and the Passport preferences), its
//// revision fingerprint, completeness, status and conflicts, and every viewer but the player.

import gleam/dict
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/orgs as org_store
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/recruitment/room_view
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/id
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rules/age
import scoutbox/vocab/playing_level
import scoutbox/vocab/position
import wisp.{type Response}

/// A day-precision date on the timeline (normWhen of an instant or a calendar day).
type When {
  When(t: Int)
}

type Event {
  Event(
    id: String,
    type_: String,
    when: When,
    org_id: Option(String),
    org_name: Option(String),
    provenance: String,
    source_type: String,
    source_id: String,
    trial: Option(#(Bool, Option(Int))),
  )
}

fn ev_id(source_type: String, source_id: String, semantic: String) -> String {
  "pev:" <> source_type <> ":" <> source_id <> ":" <> semantic
}

fn day_of(s: Option(String)) -> Option(When) {
  case s {
    Some(text) ->
      case temporal.day_start_ms(string.slice(text, 0, 10)) {
        Ok(ms) -> Some(When(ms))
        Error(Nil) -> None
      }
    None -> None
  }
}

fn trial_events(t: Trial) -> List(Event) {
  let r = t.row
  let tid = id.trial_to_string(r.id)
  let attended = fn(when, legacy, sessions) {
    Event(
      id: ev_id("trial", tid, "trial_attended"),
      type_: "trial_attended",
      when:,
      org_id: Some(id.org_to_string(r.org_id)),
      org_name: Some(r.org_name),
      provenance: "verified_club_confirmed",
      source_type: "trial",
      source_id: tid,
      trial: Some(#(legacy, sessions)),
    )
  }
  let participation = case trial_rules.is_legacy(t) {
    // A legacy row has no attendance records, so it stands for its accepted day.
    True ->
      case day_of(r.proposed_date) {
        Some(w) -> [attended(w, True, None)]
        None ->
          case r.proposed_date {
            None -> [attended(When(r.accepted_at), True, None)]
            Some(_) -> []
          }
      }
    False -> {
      let current =
        trial_rules.current_attendance(t)
        |> dict.values
        |> list.filter(fn(a) {
          a.state == attendance_row.Attended
          || a.state == attendance_row.Partial
        })
      let first =
        current
        |> list.filter_map(fn(a) {
          list.find(t.sessions, fn(s) { s.row.id == a.session_id })
          |> result.map(fn(s) { s.row.starts_at })
        })
        |> list.sort(int.compare)
        |> list.first
      case current {
        [] -> []
        [one, ..] -> [
          attended(
            When(result.unwrap(first, one.recorded_at)),
            False,
            Some(list.length(current)),
          ),
        ]
      }
    }
  }
  let outcome = case t.report {
    Some(rep) -> [
      Event(
        id: ev_id("trial", tid, "trial_outcome"),
        type_: "trial_outcome",
        when: When(rep.filed_at),
        org_id: Some(id.org_to_string(r.org_id)),
        org_name: Some(r.org_name),
        provenance: "verified_club_confirmed",
        source_type: "trial",
        source_id: tid,
        trial: None,
      ),
    ]
    None -> []
  }
  list.append(participation, outcome)
}

fn assessment_event(a: assessment_row.Row, org_name: Option(String)) -> Event {
  Event(
    id: ev_id(
      "assessment",
      id.assessment_to_string(a.id),
      "assessment_completed",
    ),
    type_: "assessment_completed",
    when: When(option.unwrap(a.submitted_at, a.created_at)),
    org_id: Some(id.org_to_string(a.org_id)),
    org_name:,
    provenance: "verified_club_confirmed",
    source_type: "assessment",
    source_id: id.assessment_to_string(a.id),
    trial: None,
  )
}

fn event_json(e: Event) -> Json {
  json.object(
    list.flatten([
      [
        #("id", json.string(e.id)),
        #("type", json.string(e.type_)),
        #(
          "when",
          json.object([
            #("display", json.string(clock.iso_day(e.when.t))),
            #("precision", json.string("day")),
          ]),
        ),
        #(
          "title",
          json.object([#("org", json.nullable(e.org_name, json.string))]),
        ),
        #("org", case e.org_id, e.org_name {
          None, None -> json.null()
          oid, name ->
            json.object([
              #("id", json.nullable(oid, json.string)),
              #("name", json.nullable(name, json.string)),
            ])
        }),
        #("provenance", json.string(e.provenance)),
        #(
          "provenanceCopy",
          json.nullable(room_view.provenance_copy(e.provenance), json.string),
        ),
        #("assurance", json.null()),
        #("current", json.null()),
        #(
          "source",
          json.object([
            #("type", json.string(e.source_type)),
            #("id", json.string(e.source_id)),
          ]),
        ),
      ],
      case e.trial {
        Some(#(legacy, sessions)) -> [
          #("legacy", json.bool(legacy)),
          #("attendedSessions", json.nullable(sessions, json.int)),
        ]
        None -> []
      },
    ]),
  )
}

fn timeline(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Event), Fail(e)) {
  use all_trials <- result.try(trials.for_player(read, player_id))
  use assessments <- result.try(store.query(
    read,
    "SELECT "
      <> assessment_row.columns
      <> " FROM assessments WHERE player_id = ? AND state <> 'draft' ORDER BY rowid",
    [id.player_sql(player_id)],
    assessment_row.decoder(),
  ))
  use assessed <- result.map(
    list.try_map(assessments, fn(a) {
      use org <- result.map(org_store.by_id(read, a.org_id))
      assessment_event(a, option.map(org, fn(o) { o.name }))
    }),
  )
  list.flatten([list.flat_map(all_trials, trial_events), assessed])
  |> list.unique
  // Newest first, then id.
  |> list.sort(fn(a, b) {
    case int.compare(b.when.t, a.when.t) {
      order.Eq -> string.compare(a.id, b.id)
      other -> other
    }
  })
}

/// `GET /player/football-passport`.
pub fn player_view(ctx: Ctx, a: PlayerAccess) -> Response {
  let p = a.player
  let found =
    store.read(ctx.store, fn(read) {
      use events <- result.try(timeline(read, p.row.id))
      use all_trials <- result.map(trials.for_player(read, p.row.id))
      #(events, all_trials)
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(#(events, all_trials)) ->
      http.json(
        200,
        json.object([
          #("passportVersion", json.int(1)),
          #(
            "player",
            json.object([
              #("id", id.player_json(p.row.id)),
              #("name", json.string(p.row.name)),
              #(
                "age",
                json.nullable(
                  age.age_on(p.row.birth_date, clock.now_ms()),
                  json.int,
                ),
              ),
              #(
                "position",
                json.nullable(
                  option.map(p.row.position, position.to_string),
                  json.string,
                ),
              ),
              #("location", json.nullable(p.row.city, json.string)),
              #("level", playing_level.to_json(p.row.level)),
            ]),
          ),
          #(
            "note",
            json.string(
              "A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement.",
            ),
          ),
          #("viewer", json.string("self")),
          #("timeline", json.array(events, event_json)),
          #(
            "trials",
            json.object([
              #("total", json.int(list.length(all_trials))),
              #(
                "withReport",
                json.int(list.count(all_trials, fn(t) { t.report != None })),
              ),
            ]),
          ),
        ]),
      )
  }
}
