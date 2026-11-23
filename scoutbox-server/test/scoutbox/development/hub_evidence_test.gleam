//// Which source records a Development evidence link shows (`hub_evidence.judge`), hand-ported from the
//// `resolveEvidenceLink` and `recordBelongsToPlayer` calls of the TypeScript rules suite
//// (scripts/rules/development/hub.mjs §4), which pass the records as a database of closures. Here each record is
//// the row the route would have fetched for the link.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/development/hub_evidence.{
  type Ev, type Found, FoundAssessment, FoundBoxSession, FoundEvidence,
  FoundTrial, Looker,
}
import scoutbox/development/hub_rules.{PlayerSelf, StaffOf}
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/trials as trial_row
import scoutbox/vocab/box_provider
import scoutbox/vocab/box_target_type
import scoutbox/vocab/evidence_source.{
  type EvidenceSource, Assessment, BoxCamSession, PassportEvidence, TrialReport,
}
import scoutbox/vocab/trial_workflow_state

const now = 1_781_524_800_000

const day = 86_400_000

fn evidence(
  sid: String,
  player: String,
  status: evidence_row.VerificationStatus,
) -> evidence_row.Row {
  evidence_row.new(
    id: id.scouting_evidence(sid),
    player_id: id.player(player),
    claim_type: evidence_row.Statistic,
    label: "Season goals",
    source_kind: evidence_row.Player,
    source_id: player,
    source_name: "A Player",
    recorded_at: now - day,
    verification_status: status,
  )
}

/// The suite's records, each as the row fetched for its id.
fn record(sid: String) -> Found {
  case sid {
    "evd-ok" ->
      FoundEvidence(Some(evidence(sid, "p1", evidence_row.CoachConfirmed)))
    "evd-sup" ->
      FoundEvidence(Some(
        evidence_row.Row(
          ..evidence(sid, "p1", evidence_row.SelfReported),
          superseded_by_id: Some(id.scouting_evidence("evd-ok")),
        ),
      ))
    "evd-exp" ->
      FoundEvidence(Some(
        evidence_row.Row(
          ..evidence(sid, "p1", evidence_row.SelfReported),
          expires_at: Some(now - day),
        ),
      ))
    "evd-theirs" ->
      FoundEvidence(Some(evidence(sid, "p2", evidence_row.ClubAssessed)))
    "ass-pub" | "ass-priv" ->
      FoundAssessment(Some(
        assessment_row.Row(
          ..assessment_row.new(
            id: id.assessment(sid),
            org_id: id.org("org-a"),
            player_id: id.player("p1"),
            scout_user_id: id.org_user("u1"),
            scout_name: "A Scout",
            template_id: "t",
            template_version: 1,
            state: assessment_row.Submitted,
            created_at: now - 3 * day,
          ),
          submitted_at: Some(now - 2 * day),
          published_feedback_text: case sid {
            "ass-pub" -> Some("Good week.")
            _ -> None
          },
        ),
      ))
    "boxs-1" ->
      FoundBoxSession(Some(
        session_row.Row(
          ..session_row.new(
            id: id.box_session(sid),
            player_id: id.player("p1"),
            drill_id: "box-touches",
            drill_version: 1,
            target_type: box_target_type.Repetitions,
            target_value: 10.0,
            nonce_hash: "",
            liveness_challenge: session_row.ShowBall,
            provider_id: box_provider.LocalTest,
            provider_version: 1,
            status: session_row.Recording,
            created_at: now - 2 * day,
            expires_at: now,
            last_seq: 0,
            batches: 0,
          ),
          ended_at: Some(now - day),
        ),
      ))
    "trial-1" ->
      FoundTrial(
        Some(trial_row.new(
          id: id.trial(sid),
          request_id: id.request("req-1"),
          player_id: id.player("p1"),
          org_id: id.org("org-a"),
          org_name: "Org A",
          accepted_at: now - 5 * day,
          status: trial_row.Reported,
          reminder_sent: False,
          workflow_state: trial_workflow_state.LegacyAccepted,
          rev: 1,
        )),
      )
    _ -> panic as { "no record " <> sid }
  }
}

fn self() {
  PlayerSelf(id.player("p1"), False)
}

fn org_a() {
  StaffOf(id.org("org-a"), False)
}

fn org_b() {
  StaffOf(id.org("org-b"), False)
}

/// The suite's `R`: the link as `viewer` sees it, on p1's plan, the gate open (`orgCanSee` is always yes).
fn r(source: EvidenceSource, sid: String, viewer) -> Ev {
  hub_evidence.judge(
    Looker(viewer:, player: id.player("p1"), may_see: True, now:),
    source,
    sid,
    record(sid),
  )
}

fn text(ev: Ev) -> String {
  json.to_string(json.object(ev.fields))
}

fn keys(ev: Ev) -> List(String) {
  list.map(ev.fields, fn(f) { f.0 })
}

pub fn live_passport_evidence_resolves_with_canonical_provenance_test() {
  let ev = r(PassportEvidence, "evd-ok", self())
  assert ev.available
  assert ev.provenance == Some("verified_coach_confirmed")
}

pub fn another_players_evidence_is_not_found_and_not_theirs_test() {
  let ev = r(PassportEvidence, "evd-theirs", self())
  assert ev.reason == Some("evidence_not_found")
  // recordBelongsToPlayer: the ownership check says no.
  assert !ev.owned
}

pub fn superseded_and_expired_evidence_read_as_they_are_now_test() {
  assert r(PassportEvidence, "evd-sup", self()).reason
    == Some("evidence_superseded")
  assert r(PassportEvidence, "evd-exp", self()).reason
    == Some("evidence_expired")
}

pub fn an_unavailable_item_leaks_no_title_provenance_or_date_test() {
  let gone = r(PassportEvidence, "evd-sup", self())
  assert gone.title == None
  assert gone.provenance == None
  assert gone.occurred_at == None
  assert !list.contains(keys(gone), "title")
}

pub fn the_player_reads_only_published_assessments_test() {
  assert r(Assessment, "ass-priv", self()).reason
    == Some("evidence_not_visible")
  assert r(Assessment, "ass-pub", self()).available
}

pub fn another_org_never_reads_this_clubs_assessment_test() {
  assert r(Assessment, "ass-pub", org_b()).reason
    == Some("evidence_not_visible")
}

pub fn the_owning_club_reads_its_own_assessment_test() {
  assert r(Assessment, "ass-priv", org_a()).available
}

pub fn an_assessment_link_carries_no_ratings_recommendation_or_feedback_test() {
  let k = keys(r(Assessment, "ass-pub", org_a()))
  assert !list.contains(k, "ratings")
  assert !list.contains(k, "recommendation")
  assert !list.contains(k, "publishedFeedback")
}

pub fn a_trial_report_is_the_clubs_alone_test() {
  assert r(TrialReport, "trial-1", self()).reason
    == Some("evidence_not_visible")
  assert r(TrialReport, "trial-1", org_a()).available
}

pub fn a_fixture_box_cam_session_is_simulated_and_reports_no_volume_test() {
  let ev = r(BoxCamSession, "boxs-1", self())
  assert ev.simulated
  let t = string.lowercase(text(ev))
  assert !list.any(
    ["hours", "streak", "volume", "totalminutes"],
    string.contains(t, _),
  )
}

/// The suite resolves a source type that doesn't exist to unavailable; here a link's source type is typed, and an
/// unknown one is refused where the link is read.
pub fn an_unknown_source_type_is_not_a_source_test() {
  assert evidence_source.from_string("made_up") == Error(Nil)
}
