//// The Room rules' checks that the recorder can't turn into generated cases, ported by hand from the TypeScript rules
//// suite of recruitment/rooms (scripts/rules/). Two kinds:
////
//// - The snapshot (buildRoomSnapshot) depends on the clock; here it runs against `room_snapshots`.
//// - The other calls pass values Gleam's types can't hold (an unknown status, recommendation or capability, a
////   reason list that isn't a list, a note that isn't text). Here those are refused where the request is read, so
////   the checks run against the input shapes the routes use, and against the closed types themselves.

import gleam/dynamic
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/identity/staff
import scoutbox/platform/input
import scoutbox/platform/store
import scoutbox/recruitment/cases
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_rules.{
  ManageAnyRoom, Read, RecruitmentAdmin, RoomLead, SummaryPlayer, SummaryRoom,
  SummaryTrust, Viewer,
}
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/support
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context

const now = 1_800_000_000_000

fn room_with_snapshot(
  trust: option.Option(room_records.SnapshotTrust),
  evidence_ids: List(String),
) {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(snap) =
    store.unit(s, fn(tx) {
      let assert Ok(u) =
        staff.create(
          tx,
          staff.NewStaff(
            org_id: id.org("org-eastport"),
            name: "Snapshot Scout",
            role: "Head of Recruitment",
            email: None,
            provenance: None,
            created_at: now,
          ),
        )
      let assert Ok(case_id) =
        cases.create(
          tx,
          cases.NewCase(
            org_id: id.org("org-eastport"),
            player_id: id.player("pl-adeyemi"),
            player_name: "Kola Adeyemi",
            owner: #(u.id, u.name),
            restricted: False,
            level: orgs.LevelPro,
          ),
          cases.Opening(
            status: room_status.Watching,
            priority: case_row.Normal,
            lead_scout: u.id,
            source_context: source_context.Direct,
            source_ref: None,
            opened_by: #(u.id, u.name),
            at: now,
          ),
        )
      room_records.add_snapshot(
        tx,
        room_records.NewSnapshot(
          room_id: case_id,
          org_id: id.org("org-eastport"),
          player_id: id.player("pl-adeyemi"),
          trigger: "status:shortlisted",
          trust:,
          passport_version: Some(3),
          passport_revision: None,
          evidence_ids:,
          assessment_ids: ["ass-1"],
          combine_results: ["box_touch_60@1"],
          trial_ids: [],
          at: now,
        ),
      )
    })
  json.to_string(room_records.snapshot_json(snap))
}

// buildRoomSnapshot — the snapshot preserves the score and its policy version; keeps component LEVELS; carries no
// coverage, gaps or assessment content; keeps minimal source references; says it is not a record of ability
pub fn the_snapshot_keeps_the_score_and_levels_only_test() {
  let text =
    room_with_snapshot(
      Some(room_records.SnapshotTrust(
        score: 78.0,
        band: "strong_evidence",
        policy_version: 1,
        component_levels: [
          #("identity", json.string("established")),
          #("combine", json.string("none")),
        ],
        hash: "abc",
      )),
      ["evd-1"],
    )
  assert string.contains(
    text,
    "\"trust\":{\"score\":78,\"band\":\"strong_evidence\",\"policyVersion\":1,\"componentLevels\":{\"identity\":\"established\",\"combine\":\"none\"},\"hash\":\"abc\"}",
  )
  assert !string.contains(text, "coverage")
  assert !string.contains(text, "gaps")
  assert string.contains(
    text,
    "\"sourceRefs\":{\"passportVersion\":3,\"passportRevision\":null,\"evidenceIds\":[\"evd-1\"]",
  )
  assert string.contains(
    text,
    "\"note\":\"Evidence confidence at the time of the decision. It is not a record of the player’s ability.\"",
  )
}

// buildRoomSnapshot — source references are bounded: no giant frozen JSON
pub fn source_references_are_bounded_test() {
  let text = room_with_snapshot(None, list.repeat("e", 200))
  assert string.contains(text, "\"trust\":null")
  assert string.contains(
    text,
    "\"evidenceIds\":[" <> string.join(list.repeat("\"e\"", 40), ",") <> "]",
  )
}

fn parse(check: input.Check(a), value: dynamic.Dynamic, code: String) {
  input.parse(
    {
      use v <- input.field("x", input.required(check))
      input.done(v)
    },
    dynamic.properties([#(dynamic.string("x"), value)]),
    root: "body",
    codes: [#("x", code)],
  )
}

// validateTransition — an unknown target status is refused, and the refusal names itself
pub fn an_unknown_status_is_refused_where_it_is_read_test() {
  let assert Error(r) =
    parse(
      input.one_of(room_status.pairs),
      dynamic.string("not_a_status"),
      "ROOM_STATUS_UNKNOWN",
    )
  assert r.error == "ROOM_STATUS_UNKNOWN"
}

// validateDecision — an invented recommendation is refused; a note that is not text is refused
pub fn an_invented_recommendation_or_a_non_text_note_is_refused_test() {
  let assert Error(r) =
    parse(
      input.one_of(decision_row.recommendation_pairs),
      dynamic.string("sign_immediately"),
      "ROOM_RECOMMENDATION_UNKNOWN",
    )
  assert r.error == "ROOM_RECOMMENDATION_UNKNOWN"
  let assert Error(note) =
    parse(
      input.text(1_000_000_000),
      dynamic.properties([#(dynamic.string("toString"), dynamic.int(1))]),
      "FIELD_INVALID",
    )
  assert input.problem_name(note.problem) == "not_text"
}

// validateReasonCodes — a non-array reason list is refused
pub fn a_reason_list_that_is_not_a_list_is_refused_test() {
  let assert Error(r) =
    parse(
      input.items(input.text(1_000_000), 1_000_000),
      dynamic.string("budget"),
      "ROOM_REASONS_INVALID",
    )
  assert r.error == "ROOM_REASONS_INVALID"
}

// roomCan — an unknown action is refused rather than allowed: the actions are a closed type, and even a room lead
// holds no capability reserved above it
pub fn no_capability_exists_beyond_the_closed_list_test() {
  assert !room_rules.room_can(Some(RoomLead), ManageAnyRoom)
  assert room_rules.room_can(Some(RecruitmentAdmin), ManageAnyRoom)
  assert room_rules.room_can(Some(Viewer), Read)
  assert !room_rules.room_can(None, Read)
}

// roomSummary — an invisible player leaks neither name nor score into a list row
pub fn an_invisible_player_leaks_nothing_into_a_list_row_test() {
  let row =
    room_rules.room_summary(
      SummaryRoom(
        room_id: id.recruitment_case("c"),
        player_id: id.player("p"),
        player_name: Some("A Player"),
        status: room_status.Watching,
        stage: case_row.Identified,
        priority: case_row.Normal,
        tags: [],
        owner_user_id: id.org_user("u"),
        owner_name: Some("M"),
        lead_scout_user_id: None,
        updated_at: 1,
        created_at: 1,
      ),
      player: Some(SummaryPlayer(Some("CM"), Some(17), None)),
      trust: Some(SummaryTrust(
        99,
        "very_strong_evidence",
        "Very strong evidence",
      )),
      open_tasks: 0,
      health: None,
      last_activity_at: None,
      visible: False,
    )
    |> json.to_string
  assert string.contains(row, "\"playerName\":null")
  assert string.contains(row, "\"playerAvailable\":false")
  assert string.contains(row, "\"position\":null")
  assert string.contains(row, "\"trust\":null")
}
