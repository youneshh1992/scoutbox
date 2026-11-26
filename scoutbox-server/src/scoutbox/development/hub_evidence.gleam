//// What a Development evidence link shows: the source record judged for one viewer, now. The routes fetch the
//// record; `judge` decides which records count, so it is tested without a store.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import scoutbox/development/box_cam_rules as box_rules
import scoutbox/development/combine
import scoutbox/development/combine_rules
import scoutbox/development/hub_rules.{type Viewer, StaffOf}
import scoutbox/platform/json_text
import scoutbox/recruitment/trial_rules
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/trials as trial_row
import scoutbox/vocab/evidence_source.{type EvidenceSource}

/// Who is looking, at whose plan, whether the gate lets them see that player at all, and when.
pub type Looker {
  Looker(viewer: Viewer, player: id.PlayerId, may_see: Bool, now: Int)
}

/// A link resolved from its source record. `owned` is whether the record exists and is this player's.
pub type Ev {
  Ev(
    source_id: String,
    owned: Bool,
    available: Bool,
    reason: Option(String),
    note: String,
    occurred_at: Option(Int),
    simulated: Bool,
    title: Option(String),
    provenance: Option(String),
    label: String,
    fields: List(#(String, Json)),
  )
}

/// The source record a link names, as fetched by its id: `None` when there is no such record.
pub type Found {
  FoundEvidence(Option(evidence_row.Row))
  FoundAssessment(Option(assessment_row.Row))
  FoundBoxSession(Option(session_row.Row))
  FoundCombineAttempt(Option(combine.Attempt))
  FoundTrial(Option(trial_row.Row))
}

fn text_field(key: String, value: String) -> #(String, Json) {
  #(key, json.string(value))
}

fn unavailable_note(reason: String) -> String {
  case reason {
    "evidence_not_found" -> "This evidence is no longer available."
    "evidence_superseded" -> "This evidence was replaced by a corrected record."
    "evidence_expired" -> "This evidence has passed its validity period."
    "evidence_withdrawn" -> "This evidence was invalidated after review."
    _ -> "This evidence is not available to you."
  }
}

/// No title, date or organisation: an unavailable item must not leak its subject.
pub fn unavailable(
  source: EvidenceSource,
  source_id: String,
  owned: Bool,
  reason: String,
) -> Ev {
  let label = hub_rules.source_label(source)
  Ev(
    source_id:,
    owned:,
    available: False,
    reason: Some(reason),
    note: unavailable_note(reason),
    occurred_at: None,
    simulated: False,
    title: None,
    provenance: None,
    label:,
    fields: [
      #("sourceType", evidence_source.to_json(source)),
      text_field("sourceId", source_id),
      text_field("sourceLabel", label),
      #("available", json.bool(False)),
      text_field("reason", reason),
      text_field("note", unavailable_note(reason)),
      #("provenance", json.null()),
      #("occurredAt", json.null()),
      #("simulated", json.bool(False)),
    ],
  )
}

fn available(
  source: EvidenceSource,
  source_id: String,
  title: String,
  provenance: String,
  occurred_at: Option(Int),
  simulated: Bool,
  middle: List(#(String, Json)),
  after: List(#(String, Json)),
) -> Ev {
  let label = hub_rules.source_label(source)
  Ev(
    source_id:,
    owned: True,
    available: True,
    reason: None,
    note: "",
    occurred_at:,
    simulated:,
    title: Some(title),
    provenance: Some(provenance),
    label:,
    fields: list.flatten([
      [
        #("sourceType", evidence_source.to_json(source)),
        text_field("sourceId", source_id),
        text_field("sourceLabel", label),
        #("available", json.bool(True)),
        #("reason", json.null()),
        text_field("title", title),
      ],
      middle,
      [
        text_field("provenance", provenance),
        #("occurredAt", json.nullable(occurred_at, json.int)),
        #("simulated", json.bool(simulated)),
      ],
      after,
    ]),
  )
}

pub fn measured(a: combine.Attempt) -> hub_rules.Measured {
  hub_rules.measured_of(
    a.row.id,
    a.row.protocol_id,
    a.row.protocol_version,
    a.row.measured_value,
    a.row.completed_at,
    a.row.combine_state,
    a.session_state,
    a.row.provider_id,
  )
}

/// The link to `sid` as `l` sees it, given the record fetched for it. Access is judged before existence, so a
/// caller cannot tell "no such id" from "not yours".
pub fn judge(
  l: Looker,
  source: EvidenceSource,
  sid: String,
  found: Found,
) -> Ev {
  let missing = unavailable(source, sid, False, "evidence_not_found")
  let staff_org = case l.viewer {
    StaffOf(org, _) -> Some(org)
    _ -> None
  }
  case l.may_see, found {
    False, _ -> unavailable(source, sid, False, "evidence_not_visible")
    True, FoundEvidence(Some(e)) if e.player_id == l.player ->
      case e.superseded_by_id, e.expires_at {
        Some(_), _ -> unavailable(source, sid, True, "evidence_superseded")
        None, Some(exp) if exp < l.now ->
          unavailable(source, sid, True, "evidence_expired")
        _, _ ->
          available(
            source,
            sid,
            e.label,
            case e.verification_status {
              evidence_row.SelfReported -> "player_submitted"
              evidence_row.CoachConfirmed -> "verified_coach_confirmed"
              evidence_row.ClubAssessed -> "verified_club_confirmed"
            },
            Some(option.unwrap(e.observed_at, e.recorded_at)),
            False,
            [],
            [],
          )
      }
    // The player sees an assessment only if the club published feedback; other clubs never do.
    True, FoundAssessment(Some(a)) if a.player_id == l.player -> {
      let owning = staff_org == Some(a.org_id)
      let subject = staff_org == None
      case owning || subject && a.published_feedback_text != None, a.state {
        False, _ -> unavailable(source, sid, True, "evidence_not_visible")
        True, assessment_row.Draft ->
          unavailable(source, sid, True, "evidence_not_found")
        True, _ ->
          available(
            source,
            sid,
            case a.context_fixture {
              Some(f) if f != "" -> "Assessment — " <> f
              _ -> "Assessment"
            },
            "verified_club_confirmed",
            Some(option.unwrap(a.submitted_at, a.created_at)),
            False,
            [
              #(
                "org",
                json.object([
                  #("id", id.org_json(a.org_id)),
                  #("name", json.null()),
                ]),
              ),
            ],
            [],
          )
      }
    }
    True, FoundBoxSession(Some(s)) if s.player_id == l.player ->
      case s.verification_state {
        Some(session_row.VerificationStateInvalidated) ->
          unavailable(source, sid, True, "evidence_withdrawn")
        _ ->
          available(
            source,
            sid,
            s.drill_id,
            "box_cam_observed",
            Some(option.unwrap(
              s.ended_at,
              option.unwrap(s.started_at, s.created_at),
            )),
            box_rules.provider(s.provider_id).test_only,
            [],
            // No number or hours: volume is not progress.
            [
              text_field(
                "note",
                "Observed training. ScoutBox recorded activity consistent with the selected drill; it does not measure how much the player improved.",
              ),
            ],
          )
      }
    True, FoundCombineAttempt(Some(a)) if a.row.player_id == l.player -> {
      let state = combine.live_state(a)
      case state {
        attempt_row.CombineStateInvalidated ->
          unavailable(source, sid, True, "evidence_withdrawn")
        _ -> {
          let m = measured(a)
          let proto = case
            combine_rules.protocol(a.row.protocol_id, a.row.protocol_version)
          {
            Some(p) -> Some(p)
            None -> combine_rules.latest_protocol(a.row.protocol_id)
          }
          let verified = state == attempt_row.CombineVerified
          available(
            source,
            sid,
            option.map(proto, fn(p) { p.title })
              |> option.unwrap(a.row.protocol_id),
            case m.test_only, verified {
              True, _ -> "simulated_demo"
              False, True -> "combine_verified"
              False, False -> "box_cam_observed"
            },
            Some(option.unwrap(a.row.completed_at, a.row.created_at)),
            m.test_only,
            [
              text_field("protocolId", a.row.protocol_id),
              #("protocolVersion", json.int(a.row.protocol_version)),
              #("measuredValue", case verified {
                True -> json.nullable(a.row.measured_value, json_text.number)
                False -> json.null()
              }),
              text_field("metricUnit", a.row.metric_unit),
              #("combineState", attempt_row.combine_state_to_json(state)),
            ],
            [#("productionValid", json.bool(hub_rules.production_valid(m)))],
          )
        }
      }
    }
    // A trial report is a recruitment record: only the trial's organisation sees the link, never its content.
    True, FoundTrial(Some(t)) if t.player_id == l.player ->
      case staff_org == Some(t.org_id), t.status {
        False, _ -> unavailable(source, sid, True, "evidence_not_visible")
        True, trial_row.Reported ->
          available(
            source,
            sid,
            "Trial report",
            "verified_club_confirmed",
            Some(
              option.then(t.proposed_date, trial_rules.trial_date_ms)
              |> option.unwrap(t.accepted_at),
            ),
            False,
            [],
            [],
          )
        True, _ -> unavailable(source, sid, True, "evidence_not_found")
      }
    True, _ -> missing
  }
}
