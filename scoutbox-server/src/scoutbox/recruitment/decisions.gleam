//// The formal recruitment decision (domains/recruitment/lifecycle/decision.mjs): its rules, the case's single
//// draft (`case_decision_drafts` and its reason and evidence rows) and the formal row in the Room's append-only
//// decision memory (`room_decisions`, beside the advisory recommendations).
////
//// Every outcome is typed by a human; nothing here derives one from a Trust Score, Box Cam result, attendance
//// or rating.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/box_sessions as box_row
import scoutbox/rows/case_decision_drafts as draft_row
import scoutbox/rows/id
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/room_snapshot_source_refs as ref_row
import scoutbox/vocab/box_provider
import scoutbox/vocab/case_outcome
import scoutbox/vocab/decision_evidence_kind.{type DecisionEvidenceKind}
import scoutbox/vocab/decision_outcome.{
  type DecisionOutcome, Hold, Progress, Reject,
}
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/trial_workflow_state
import sqlight

pub const policy_version = 1

pub const outcomes = [Progress, Hold, Reject]

pub const note_max = 2000

pub const supersession_reason_max = 500

pub const evidence_refs_max = 50

/// DECISION_LIMITS.
pub fn limits_json() -> Json {
  json.object([
    #("note", json.int(note_max)),
    #("supersessionReason", json.int(supersession_reason_max)),
    #("evidenceRefs", json.int(evidence_refs_max)),
    #("clientKey", json.int(64)),
    #("reasonCodes", json.int(6)),
    #("historyPage", json.int(100)),
  ])
}

/// What an outcome maps onto: the recommendation (so Second Look, the journey, analytics and Nobody Missed read
/// one chain), the lifecycle action and its reasons (from the lifecycle taxonomy), and the label.
pub type Mapping {
  Mapping(
    recommendation: decision_row.Recommendation,
    action: String,
    lifecycle_reasons: List(String),
    label: String,
  )
}

pub fn mapping(outcome: DecisionOutcome) -> Mapping {
  case outcome {
    Progress ->
      Mapping(
        decision_row.Offer,
        "considerOffer",
        [],
        "Progress to offer consideration",
      )
    Hold -> Mapping(decision_row.ContinueWatching, "holdCase", [], "Hold")
    Reject ->
      Mapping(decision_row.Archive, "rejectCase", ["rejected"], "Reject")
  }
}

pub const evidence_kinds = [
  decision_evidence_kind.Assessment,
  decision_evidence_kind.Trial,
  decision_evidence_kind.BoxCamSession,
  decision_evidence_kind.PassportEvidence,
]

// ---------------------------------------------------------------------------------------------- validation

/// A refusal of the lifecycle contract: its code, message and the public fields it carries.
pub type Refusal {
  Refusal(error: String, message: String, fields: List(#(String, Json)))
}

/// Tags and angle brackets removed, trimmed, cut to `max` (plainText).
pub fn plain_text(s: String, max: Int) -> String {
  let assert Ok(tags) = regexp.from_string("<[^>]*>")
  let assert Ok(brackets) = regexp.from_string("[<>]")
  regexp.replace(tags, s, "")
  |> regexp.replace(brackets, _, "")
  |> string.trim
  |> input.utf16_take(max)
}

/// A note, checked and cleaned; empty is none.
pub fn validate_note(
  raw: Option(String),
  field: String,
  max: Int,
) -> Result(Option(String), Refusal) {
  case raw {
    None | Some("") -> Ok(None)
    Some(text) ->
      case input.utf16_length(text) > max {
        True ->
          Error(
            Refusal(
              "DECISION_CONTENT_INVALID",
              "Keep the "
                <> field
                <> " under "
                <> int.to_string(max)
                <> " characters.",
              [#("field", json.string(field))],
            ),
          )
        False ->
          case plain_text(text, max) {
            "" -> Ok(None)
            t -> Ok(Some(t))
          }
      }
  }
}

/// Decision reasons are opinions about fit (the decision taxonomy), not case events. A reject needs one.
pub fn validate_reasons(
  raw: List(String),
  outcome: Option(DecisionOutcome),
) -> Result(List(String), Refusal) {
  case room_rules.validate_reason_codes(raw) {
    Error(refusal) -> {
      let fields = room_rules.reason_refusal_fields(refusal)
      let message =
        list.key_find(fields, "message") |> result.unwrap(json.string(""))
      Error(
        Refusal("DECISION_REASON_INVALID", "", [
          #("message", message),
          ..list.filter(fields, fn(f) {
            f.0 == "unknown" || f.0 == "prohibited"
          })
        ]),
      )
    }
    Ok([]) if outcome == Some(Reject) ->
      Error(
        Refusal(
          "DECISION_REASON_INVALID",
          "A rejection needs at least one reason so the decision stays useful later — and so a Second Look can tell whether it still applies.",
          [],
        ),
      )
    Ok(codes) -> Ok(codes)
  }
}

/// A reference as sent: `{ kind, id }` only.
pub type RefShape {
  RefShape(kind: DecisionEvidenceKind, id: String)
}

/// Deduplicated and trimmed, in the order sent.
pub fn ref_shapes(raw: Option(List(RefShape))) -> List(RefShape) {
  option.unwrap(raw, [])
  |> list.fold([], fn(out, r) {
    let r = RefShape(r.kind, string.trim(r.id))
    case list.contains(out, r) {
      True -> out
      False -> [r, ..out]
    }
  })
  |> list.reverse
}

pub fn refs_shape() -> input.Check(RefShape) {
  input.object({
    use kind <- input.field(
      "kind",
      input.required(input.one_of(decision_evidence_kind.pairs)),
    )
    use ref_id <- input.field("id", input.required(input.id()))
    input.done(RefShape(kind, ref_id))
  })
}

/// A reference resolved against the case: the kind, the id and minimal immutable metadata, never a copy.
pub type Ref {
  Ref(kind: DecisionEvidenceKind, id: String, meta: Json)
}

/// The organisation's trials of the player that belong to this case, or to no case (a trial from before cases).
pub fn case_trials(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  case_id: id.RecruitmentCaseId,
) -> Result(List(Trial), Fail(e)) {
  use all <- result.map(trials.for_org_player(read, org_id, player_id))
  let mine = Some(case_id)
  list.filter(all, fn(t) { t.row.case_id == None || t.row.case_id == mine })
}

/// When the trial completed, if it did.
pub fn completed_at(t: Trial) -> Option(Int) {
  case trial_rules.workflow_state(t) {
    trial_workflow_state.Completed -> t.row.completion_at
    _ -> None
  }
}

/// Resolves each reference against this case's own records. Anything outside the case is
/// `DECISION_CASE_MISMATCH`, with the same body whether the record exists elsewhere or not.
///
/// Not ported yet: Box Cam's test provider, so a `local_test` session is never citable here.
pub fn resolve_refs(
  read: Read,
  refs: List(RefShape),
  org_id: id.OrgId,
  player_id: id.PlayerId,
  case_id: id.RecruitmentCaseId,
) -> Result(Result(List(Ref), Refusal), Fail(e)) {
  use case_trials <- result.try(case_trials(read, org_id, player_id, case_id))
  list.try_fold(refs, Ok([]), fn(acc, r) {
    case acc {
      Error(_) -> Ok(acc)
      Ok(out) -> {
        let mismatch = fn(message) {
          Ok(
            Error(
              Refusal("DECISION_CASE_MISMATCH", message, [#("ref", ref_json(r))]),
            ),
          )
        }
        case r.kind {
          decision_evidence_kind.Assessment -> {
            use found <- result.try(store.query(
              read,
              "SELECT "
                <> assessment_row.columns
                <> " FROM assessments WHERE id = ?",
              // The ref's kind says whose id it is.
              [id.assessment_sql(id.assessment(r.id))],
              assessment_row.decoder(),
            ))
            case found {
              [a] if a.org_id == org_id && a.player_id == player_id ->
                case a.state {
                  assessment_row.Draft ->
                    Ok(
                      Error(
                        Refusal(
                          "DECISION_EVIDENCE_INVALID",
                          "Only a submitted assessment can be cited by a decision.",
                          [#("ref", ref_json(r))],
                        ),
                      ),
                    )
                  _ ->
                    Ok(
                      Ok([
                        Ref(
                          r.kind,
                          id.assessment_to_string(a.id),
                          json.object([
                            #("scoutName", json.string(a.scout_name)),
                            #(
                              "submittedAt",
                              json.nullable(a.submitted_at, json.int),
                            ),
                            #(
                              "verdict",
                              json.nullable(
                                a.recommendation_verdict,
                                case_outcome.to_json,
                              ),
                            ),
                            #(
                              "trialId",
                              json.nullable(a.context_trial_id, json.string),
                            ),
                          ]),
                        ),
                        ..out
                      ]),
                    )
                }
              _ -> mismatch("That assessment is not one of this case's.")
            }
          }
          decision_evidence_kind.Trial ->
            case
              list.find(case_trials, fn(t) {
                id.trial_to_string(t.row.id) == r.id
              })
            {
              Error(_) -> mismatch("That trial is not one of this case's.")
              Ok(t) ->
                Ok(
                  Ok([
                    Ref(
                      r.kind,
                      r.id,
                      json.object([
                        #(
                          "workflowState",
                          trial_workflow_state.to_json(
                            trial_rules.workflow_state(t),
                          ),
                        ),
                        #(
                          "completedAt",
                          json.nullable(completed_at(t), json.int),
                        ),
                      ]),
                    ),
                    ..out
                  ]),
                )
            }
          decision_evidence_kind.BoxCamSession -> {
            let link =
              list.find_map(case_trials, fn(t) {
                list.find_map(t.sessions, fn(s) {
                  list.find(s.evidence, fn(e) {
                    id.box_session_to_string(e.box_session_id) == r.id
                    && e.removed_at == None
                  })
                  |> result.map(fn(e) { #(t, s, e) })
                })
              })
            case link {
              Error(_) ->
                mismatch(
                  "That Box Cam session is not cited on any trial of this case.",
                )
              Ok(#(t, s, e)) -> {
                use found <- result.try(store.query(
                  read,
                  "SELECT "
                    <> box_row.columns
                    <> " FROM box_sessions WHERE id = ?",
                  [id.box_session_sql(e.box_session_id)],
                  box_row.decoder(),
                ))
                case found {
                  [b]
                    if b.player_id == player_id
                    && b.provider_id != box_provider.LocalTest
                  ->
                    Ok(
                      Ok([
                        Ref(
                          r.kind,
                          r.id,
                          json.object([
                            #("trialId", id.trial_json(t.row.id)),
                            #("trialSessionId", id.trial_session_json(s.row.id)),
                            #(
                              "verificationState",
                              json.nullable(
                                b.verification_state,
                                box_row.verification_state_to_json,
                              ),
                            ),
                            #("simulated", json.bool(False)),
                          ]),
                        ),
                        ..out
                      ]),
                    )
                  _ ->
                    mismatch(
                      "That Box Cam session is not available to this case.",
                    )
                }
              }
            }
          }
          decision_evidence_kind.PassportEvidence -> {
            use found <- result.try(
              store.query(
                read,
                "SELECT claim_type, verification_status FROM evidence WHERE id = ? AND player_id = ? AND superseded_by_id IS NULL",
                [
                  id.scouting_evidence_sql(id.scouting_evidence(r.id)),
                  id.player_sql(player_id),
                ],
                {
                  use claim <- decode.field(0, decode.string)
                  use status <- decode.field(1, decode.string)
                  decode.success(#(claim, status))
                },
              ),
            )
            case found {
              [#(claim, status)] ->
                Ok(
                  Ok([
                    Ref(
                      r.kind,
                      r.id,
                      json.object([
                        #("claimType", json.string(claim)),
                        #("provenance", json.string(status)),
                      ]),
                    ),
                    ..out
                  ]),
                )
              _ ->
                mismatch(
                  "That evidence record is not one of this player's current records.",
                )
            }
          }
        }
      }
    }
  })
  |> result.map(result.map(_, list.reverse))
}

fn ref_json(r: RefShape) -> Json {
  json.object([
    #("kind", decision_evidence_kind.to_json(r.kind)),
    #("id", json.string(r.id)),
  ])
}

// ---------------------------------------------------------------------------------------------------- reads

/// A decision row with the formal decision's child rows.
pub type Decision {
  Decision(
    base: room_records.Decision,
    refs: List(Ref),
    assessment_ids: List(String),
  )
}

pub fn is_formal(d: Decision) -> Bool {
  d.base.row.kind == Some(decision_row.Formal)
}

fn refs_of(
  read: Read,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
) -> Result(List(Ref), Fail(e)) {
  store.query(
    read,
    "SELECT kind, ref_id, meta_json FROM "
      <> table
      <> " WHERE "
      <> owner
      <> " = ? ORDER BY position",
    [owner_id],
    {
      use kind <- decode.field(0, decision_evidence_kind.decoder())
      use ref_id <- decode.field(1, decode.string)
      use meta <- decode.field(2, decode.optional(decode.string))
      decode.success(Ref(
        kind,
        ref_id,
        meta
          |> option.then(fn(t) { json_text.parse(t) |> option.from_result })
          |> option.unwrap(json.null()),
      ))
    },
  )
}

/// A Room's decisions, oldest first, with each formal one's references and assessment ids.
pub fn all(
  read: Read,
  room_id: id.RecruitmentCaseId,
) -> Result(List(Decision), Fail(e)) {
  use base <- result.try(room_records.decisions(read, room_id))
  list.try_map(base, fn(d) {
    let did = id.room_decision_sql(d.row.id)
    use refs <- result.try(refs_of(
      read,
      "room_decision_evidence_refs",
      "decision_id",
      did,
    ))
    use ids <- result.map(store.query(
      read,
      "SELECT assessment_id FROM room_decision_assessment_ids WHERE decision_id = ? ORDER BY position",
      [did],
      decode.at([0], decode.string),
    ))
    Decision(d, refs, ids)
  })
}

/// Problems with a formal row (decisionIntegrity): it is omitted from decision lists, counted and logged, never
/// repaired. Recommendation rows are judged by the Rooms.
pub fn integrity(
  d: Decision,
  org_id: id.OrgId,
  case_id: id.RecruitmentCaseId,
) -> List(String) {
  let r = d.base.row
  case is_formal(d) {
    False -> []
    True ->
      list.flatten([
        case r.outcome {
          None -> ["unknown_outcome"]
          Some(_) -> []
        },
        case r.by_user_id, r.by_name {
          None, None -> ["missing_actor"]
          _, _ -> []
        },
        case r.room_id == case_id {
          True -> []
          False -> ["missing_case"]
        },
        case r.org_id == org_id {
          True -> []
          False -> ["org_mismatch"]
        },
        case room_rules.validate_reason_codes(d.base.reason_codes) {
          Ok(_) -> []
          Error(_) -> ["invalid_reason_code"]
        },
      ])
  }
}

/// A case's sound decision rows (oldest first), how many corrupt formal rows were omitted, and the duplicate
/// heads: more than one formal row with no successor is corruption, not a tie.
pub type Rows {
  Rows(
    rows: List(Decision),
    omitted: Int,
    duplicate_heads: List(id.RoomDecisionId),
    /// Each omitted row and its problems, for the log.
    problems: List(#(id.RoomDecisionId, List(String))),
  )
}

pub fn rows_of(
  read: Read,
  room_id: id.RecruitmentCaseId,
  org_id: id.OrgId,
) -> Result(Rows, Fail(e)) {
  use found <- result.map(all(read, room_id))
  let mine = list.filter(found, fn(d) { d.base.row.org_id == org_id })
  let good = list.filter(mine, fn(d) { integrity(d, org_id, room_id) == [] })
  let good = list.sort(good, by_created_then_id)
  let heads =
    list.filter(good, fn(d) {
      is_formal(d) && d.base.row.superseded_by_id == None
    })
  Rows(
    problems: list.filter_map(mine, fn(d) {
      case integrity(d, org_id, room_id) {
        [] -> Error(Nil)
        found -> Ok(#(d.base.row.id, found))
      }
    }),
    rows: good,
    omitted: list.length(mine) - list.length(good),
    duplicate_heads: case heads {
      [_, _, ..] -> list.map(heads, fn(d) { d.base.row.id })
      _ -> []
    },
  )
}

fn by_created_then_id(a: Decision, b: Decision) -> order.Order {
  case int.compare(a.base.row.created_at, b.base.row.created_at) {
    order.Eq ->
      string.compare(
        id.room_decision_to_string(a.base.row.id),
        id.room_decision_to_string(b.base.row.id),
      )
    other -> other
  }
}

/// The current head of the chain: the newest row nothing supersedes.
pub fn chain_head(rows: List(Decision)) -> Option(Decision) {
  rows
  |> list.filter(fn(d) { d.base.row.superseded_by_id == None })
  |> list.sort(by_created_then_id)
  |> list.last
  |> option.from_result
}

/// The case's single draft.
pub type Draft {
  Draft(row: draft_row.Row, reason_codes: List(String), refs: List(Ref))
}

pub fn draft(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(Option(Draft), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> draft_row.columns
      <> " FROM case_decision_drafts WHERE case_id = ?",
    [id.recruitment_case_sql(case_id)],
    draft_row.decoder(),
  ))
  case found {
    [row] -> {
      let cid = id.recruitment_case_sql(case_id)
      use codes <- result.try(store.query(
        read,
        "SELECT code FROM case_decision_draft_reason_codes WHERE case_id = ? ORDER BY position",
        [cid],
        decode.at([0], decode.string),
      ))
      use refs <- result.map(refs_of(
        read,
        "case_decision_draft_evidence_refs",
        "case_id",
        cid,
      ))
      Some(Draft(row, codes, refs))
    }
    _ -> Ok(None)
  }
}

// --------------------------------------------------------------------------------------------------- writes

/// Who acted: a club member's id, name and role.
pub type Actor =
  #(id.OrgUserId, String, Option(String))

fn insert_refs(
  tx: Tx,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
  refs: List(Ref),
) -> Result(Nil, Fail(e)) {
  list.index_map(refs, fn(r, i) { #(r, i) })
  |> list.try_each(fn(p) {
    let #(r, i) = p
    store.run(
      tx,
      "INSERT INTO "
        <> table
        <> " ("
        <> owner
        <> ", position, kind, ref_id, meta_json) VALUES (?, ?, ?, ?, ?)",
      [
        owner_id,
        sqlight.int(i),
        sqlight.text(decision_evidence_kind.to_string(r.kind)),
        sqlight.text(r.id),
        sqlight.text(json.to_string(r.meta)),
      ],
    )
  })
}

fn insert_codes(
  tx: Tx,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
  codes: List(String),
) -> Result(Nil, Fail(e)) {
  list.index_map(codes, fn(c, i) { #(c, i) })
  |> list.try_each(fn(p) {
    store.run(
      tx,
      "INSERT INTO "
        <> table
        <> " ("
        <> owner
        <> ", position, code) VALUES (?, ?, ?)",
      [owner_id, sqlight.int(p.1), sqlight.text(p.0)],
    )
  })
}

pub type NewDraft {
  NewDraft(
    outcome: Option(DecisionOutcome),
    reason_codes: List(String),
    note: Option(String),
    refs: List(Ref),
    by: Actor,
    create_key: Option(#(String, String)),
    at: Int,
  )
}

pub fn start_draft(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  n: NewDraft,
) -> Result(id.DecisionDraftId, Fail(e)) {
  use draft_id <- result.try(id.next_decision_draft(tx))
  use _ <- result.try(draft_row.insert(
    tx,
    draft_row.Row(
      ..draft_row.new(
        case_id:,
        id: draft_id,
        created_at: n.at,
        updated_at: n.at,
        rev: 1,
      ),
      outcome: n.outcome,
      note: n.note,
      by_user_id: Some(n.by.0),
      by_name: Some(n.by.1),
      by_role: n.by.2,
      updated_by_user_id: Some(n.by.0),
      updated_by_name: Some(n.by.1),
      updated_by_role: n.by.2,
      rev_at: Some(n.at),
      create_key: option.map(n.create_key, fn(k) { k.0 }),
      create_fp: option.map(n.create_key, fn(k) { k.1 }),
    ),
  ))
  let cid = id.recruitment_case_sql(case_id)
  use _ <- result.try(insert_codes(
    tx,
    "case_decision_draft_reason_codes",
    "case_id",
    cid,
    n.reason_codes,
  ))
  use _ <- result.map(insert_refs(
    tx,
    "case_decision_draft_evidence_refs",
    "case_id",
    cid,
    n.refs,
  ))
  draft_id
}

/// Changes the draft's content (an absent field stays) and moves its rev.
pub fn edit_draft(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  outcome: Option(Option(DecisionOutcome)),
  reason_codes: Option(List(String)),
  note: Option(Option(String)),
  refs: Option(List(Ref)),
  by: Actor,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let sets =
    list.flatten([
      case outcome {
        Some(o) -> [
          #(
            "outcome",
            sqlight.nullable(
              sqlight.text,
              option.map(o, decision_outcome.to_string),
            ),
          ),
        ]
        None -> []
      },
      case note {
        Some(n) -> [#("note", sqlight.nullable(sqlight.text, n))]
        None -> []
      },
      [
        #("updated_at", sqlight.int(at)),
        #("updated_by_user_id", id.org_user_sql(by.0)),
        #("updated_by_name", sqlight.text(by.1)),
        #("updated_by_role", sqlight.nullable(sqlight.text, by.2)),
        #("rev_at", sqlight.int(at)),
      ],
    ])
  let cid = id.recruitment_case_sql(case_id)
  use _ <- result.try(store.run(
    tx,
    "UPDATE case_decision_drafts SET "
      <> string.join(list.map(sets, fn(s) { s.0 <> " = ?" }), ", ")
      <> ", rev = rev + 1 WHERE case_id = ?",
    list.append(list.map(sets, fn(s) { s.1 }), [cid]),
  ))
  use _ <- result.try(case reason_codes {
    Some(codes) -> {
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM case_decision_draft_reason_codes WHERE case_id = ?",
          [cid],
        ),
      )
      insert_codes(
        tx,
        "case_decision_draft_reason_codes",
        "case_id",
        cid,
        codes,
      )
    }
    None -> Ok(Nil)
  })
  case refs {
    Some(refs) -> {
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM case_decision_draft_evidence_refs WHERE case_id = ?",
          [cid],
        ),
      )
      insert_refs(tx, "case_decision_draft_evidence_refs", "case_id", cid, refs)
    }
    None -> Ok(Nil)
  }
}

/// The draft goes: discarded, or become a formal decision.
pub fn discard_draft(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
) -> Result(Nil, Fail(e)) {
  store.run(tx, "DELETE FROM case_decision_drafts WHERE case_id = ?", [
    id.recruitment_case_sql(case_id),
  ])
}

/// What a formal decision summarises of the assessments: counts and ids, never an average.
pub type AssessmentSnapshot {
  AssessmentSnapshot(
    submitted: Int,
    withheld: Int,
    verdicts: List(#(String, Int)),
    ids: List(id.AssessmentId),
  )
}

pub type NewFormal {
  NewFormal(
    room_id: id.RecruitmentCaseId,
    org_id: id.OrgId,
    player_id: id.PlayerId,
    outcome: DecisionOutcome,
    reason_codes: List(String),
    note: Option(String),
    by: Actor,
    client_key: Option(String),
    supersedes: Option(id.RoomDecisionId),
    supersession: Option(#(id.RoomDecisionId, String)),
    refs: List(Ref),
    assessments: AssessmentSnapshot,
    snapshot: Option(id.RoomSnapshotId),
    finalize_key: Option(#(String, String)),
    draft_key: Option(#(String, String)),
    draft_id: String,
    at: Int,
  )
}

pub fn create_formal(
  tx: Tx,
  n: NewFormal,
) -> Result(id.RoomDecisionId, Fail(e)) {
  use decision_id <- result.try(id.next_room_decision(tx))
  let r =
    decision_row.Row(
      ..decision_row.new(
        id: decision_id,
        room_id: n.room_id,
        org_id: n.org_id,
        player_id: n.player_id,
        recommendation: mapping(n.outcome).recommendation,
        created_at: n.at,
      ),
      kind: Some(decision_row.Formal),
      state: Some(decision_row.Final),
      outcome: Some(n.outcome),
      note: n.note,
      by_user_id: Some(n.by.0),
      by_name: Some(n.by.1),
      by_role: n.by.2,
      finalized_at: Some(n.at),
      trigger: Some("decision:finalize"),
      client_key: n.client_key,
      supersedes_id: n.supersedes,
      supersession_of_id: option.map(n.supersession, fn(s) { s.0 }),
      supersession_reason: option.map(n.supersession, fn(s) { s.1 }),
      rev: Some(1),
      rev_at: Some(n.at),
      assessments_submitted: Some(n.assessments.submitted),
      assessments_withheld: Some(n.assessments.withheld),
      assessment_verdicts_json: Some(
        json.to_string(
          json.object(
            list.map(n.assessments.verdicts, fn(v) { #(v.0, json.int(v.1)) }),
          ),
        ),
      ),
      snapshot_id: n.snapshot,
      finalize_key: option.map(n.finalize_key, fn(k) { k.0 }),
      finalize_fp: option.map(n.finalize_key, fn(k) { k.1 }),
      draft_key: option.map(n.draft_key, fn(k) { k.0 }),
      draft_fp: option.map(n.draft_key, fn(k) { k.1 }),
      draft_id: Some(n.draft_id),
      policy_version: Some(policy_version),
    )
  use _ <- result.try(decision_row.insert(tx, r))
  let did = id.room_decision_sql(decision_id)
  use _ <- result.try(insert_codes(
    tx,
    "room_decision_reason_codes",
    "decision_id",
    did,
    n.reason_codes,
  ))
  use _ <- result.try(insert_refs(
    tx,
    "room_decision_evidence_refs",
    "decision_id",
    did,
    n.refs,
  ))
  use _ <- result.map(
    list.index_map(n.assessments.ids, fn(a, i) { #(a, i) })
    |> list.try_each(fn(p) {
      store.run(
        tx,
        "INSERT INTO room_decision_assessment_ids (decision_id, position, assessment_id) VALUES (?, ?, ?)",
        [did, sqlight.int(p.1), id.assessment_sql(p.0)],
      )
    }),
  )
  decision_id
}

pub fn mark_superseded(
  tx: Tx,
  head: id.RoomDecisionId,
  by: id.RoomDecisionId,
) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE room_decisions SET superseded_by_id = ? WHERE id = ?", [
    id.room_decision_sql(by),
    id.room_decision_sql(head),
  ])
}

/// What the decision did to the case.
pub type Lifecycle {
  Lifecycle(
    action: String,
    from: RoomStatus,
    to: RoomStatus,
    applied: Bool,
    reason: Option(String),
    at: Int,
  )
}

pub fn record_lifecycle(
  tx: Tx,
  decision: id.RoomDecisionId,
  l: Lifecycle,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE room_decisions SET lifecycle_action = ?, lifecycle_from = ?, lifecycle_to = ?, lifecycle_applied = ?, lifecycle_reason = ?, lifecycle_at = ? WHERE id = ?",
    [
      sqlight.text(l.action),
      sqlight.text(room_status.to_string(l.from)),
      sqlight.text(room_status.to_string(l.to)),
      sqlight.bool(l.applied),
      sqlight.nullable(sqlight.text, l.reason),
      sqlight.int(l.at),
      id.room_decision_sql(decision),
    ],
  )
}

/// A superseded formal decision's own rev moves.
pub fn bump(
  tx: Tx,
  decision: id.RoomDecisionId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE room_decisions SET rev = COALESCE(rev, 1) + 1, rev_at = ? WHERE id = ?",
    [sqlight.int(at), id.room_decision_sql(decision)],
  )
}

// ---------------------------------------------------------------------------------------------------- views

fn person_json(
  user: Option(id.OrgUserId),
  name: Option(String),
  role: Option(Option(String)),
) -> Json {
  case user, name, role {
    None, None, None | None, None, Some(None) -> json.null()
    _, _, _ ->
      json.object(
        list.flatten([
          [
            #("userId", json.nullable(user, id.org_user_json)),
            #("name", json.nullable(name, json.string)),
          ],
          case role {
            Some(r) -> [#("role", json.nullable(r, json.string))]
            None -> []
          },
        ]),
      )
  }
}

pub fn refs_json(refs: List(Ref)) -> Json {
  json.array(refs, fn(r) {
    json.object([
      #("kind", decision_evidence_kind.to_json(r.kind)),
      #("id", json.string(r.id)),
      #("meta", r.meta),
    ])
  })
}

pub fn lifecycle_json(r: decision_row.Row) -> Json {
  case r.lifecycle_applied {
    None -> json.null()
    Some(applied) ->
      json.object([
        #("action", json.nullable(r.lifecycle_action, json.string)),
        #("from", json.nullable(r.lifecycle_from, room_status.to_json)),
        #("to", json.nullable(r.lifecycle_to, room_status.to_json)),
        #("applied", json.bool(applied)),
        #("reason", json.nullable(r.lifecycle_reason, json.string)),
        #("at", json.nullable(r.lifecycle_at, json.int)),
      ])
  }
}

fn outcome_label(o: Option(DecisionOutcome)) -> Json {
  json.nullable(option.map(o, fn(o) { mapping(o).label }), json.string)
}

/// decisionView: the note is club-private and travels only here.
pub fn view(d: Decision, omit_note: Bool) -> Json {
  let r = d.base.row
  let formal = is_formal(d)
  let when_formal = fn(value: Json) {
    case formal {
      True -> value
      False -> json.null()
    }
  }
  json.object(
    list.flatten([
      [
        #("id", id.room_decision_json(r.id)),
        #(
          "kind",
          json.string(case formal {
            True -> "formal"
            False -> "recommendation"
          }),
        ),
        #(
          "state",
          json.string(case r.state {
            Some(decision_row.Draft) -> "draft"
            _ -> "final"
          }),
        ),
        #(
          "outcome",
          when_formal(json.nullable(r.outcome, decision_outcome.to_json)),
        ),
        #("outcomeLabel", when_formal(outcome_label(r.outcome))),
        #(
          "recommendation",
          decision_row.recommendation_to_json(r.recommendation),
        ),
        #("reasonCodes", json.array(d.base.reason_codes, json.string)),
      ],
      case omit_note {
        True -> []
        False -> [#("note", json.nullable(r.note, json.string))]
      },
      [
        #("hasNote", json.bool(option.is_some(r.note) && r.note != Some(""))),
        #("by", person_json(r.by_user_id, r.by_name, Some(r.by_role))),
        #("createdAt", json.int(r.created_at)),
        #(
          "finalizedAt",
          json.int(case formal {
            True -> option.unwrap(r.finalized_at, r.created_at)
            False -> r.created_at
          }),
        ),
        #("rev", json.int(option.unwrap(r.rev, 1))),
        #("supersedes", json.nullable(r.supersedes_id, id.room_decision_json)),
        #(
          "supersededById",
          json.nullable(r.superseded_by_id, id.room_decision_json),
        ),
        #("supersession", case formal, r.supersession_of_id {
          True, Some(of) ->
            json.object([
              #("reason", json.nullable(r.supersession_reason, json.string)),
              #("of", id.room_decision_json(of)),
            ])
          _, _ -> json.null()
        }),
        #("evidenceRefs", case formal {
          True -> refs_json(d.refs)
          False -> json.preprocessed_array([])
        }),
        #(
          "evidenceCount",
          json.int(case formal, d.base.snapshot {
            True, _ -> list.length(d.refs)
            False, Some(s) ->
              list.count(s.refs, fn(r) { r.kind == ref_row.Evidence })
            False, None -> 0
          }),
        ),
        #("assessmentSummary", case formal, r.assessments_submitted {
          True, Some(submitted) ->
            json.object([
              #("submitted", json.int(submitted)),
              #("withheld", json.int(option.unwrap(r.assessments_withheld, 0))),
              #(
                "verdicts",
                r.assessment_verdicts_json
                  |> option.then(fn(t) {
                    json_text.parse(t) |> option.from_result
                  })
                  |> option.unwrap(json.null()),
              ),
              #("assessmentIds", json.array(d.assessment_ids, json.string)),
            ])
          _, _ -> json.null()
        }),
        #("lifecycle", when_formal(lifecycle_json(r))),
        #("trigger", json.nullable(r.trigger, json.string)),
        #("snapshot", case d.base.snapshot {
          Some(s) ->
            json.object([
              #("at", json.int(s.row.at)),
              #("trust", room_records.snapshot_trust_json(s.row)),
              #("snapshotId", id.room_snapshot_json(s.row.id)),
              #(
                "note",
                json.string(
                  "Evidence confidence at the time of the decision. It is not a record of the player’s ability.",
                ),
              ),
            ])
          None -> json.null()
        }),
        #(
          "policyVersion",
          when_formal(json.int(option.unwrap(r.policy_version, policy_version))),
        ),
      ],
    ]),
  )
}

pub fn draft_view(dr: Option(Draft)) -> Json {
  case dr {
    None -> json.null()
    Some(Draft(r, codes, refs)) ->
      json.object([
        #("id", id.decision_draft_json(r.id)),
        #("state", json.string("draft")),
        #("outcome", json.nullable(r.outcome, decision_outcome.to_json)),
        #("outcomeLabel", outcome_label(r.outcome)),
        #("reasonCodes", json.array(codes, json.string)),
        #("note", json.nullable(r.note, json.string)),
        #("evidenceRefs", refs_json(refs)),
        #("by", person_json(r.by_user_id, r.by_name, None)),
        #("createdAt", json.int(r.created_at)),
        #("updatedAt", json.int(r.updated_at)),
        #(
          "updatedBy",
          person_json(r.updated_by_user_id, r.updated_by_name, None),
        ),
        #("rev", json.int(r.rev)),
        #("label", json.string("Draft — not a formal decision")),
      ])
  }
}

// ------------------------------------------------------------------------------------------- assessments

/// One assessment as the summary counts it.
pub type Counted {
  Counted(
    row: assessment_row.Row,
    rated: Int,
    not_observed: Int,
    confidence: #(Int, Int, Int),
    evidence_refs: Int,
  )
}

/// The organisation's assessments of the player, with their ratings counted.
pub fn assessments_for(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Counted), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> assessment_row.columns
      <> " FROM assessments WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(org_id), id.player_sql(player_id)],
    assessment_row.decoder(),
  ))
  list.try_map(rows, fn(a) {
    let aid = id.assessment_sql(a.id)
    use counts <- result.try(
      store.query(
        read,
        "SELECT COALESCE(SUM(not_observed = 0 AND rating IS NOT NULL), 0), COALESCE(SUM(not_observed = 1), 0), COALESCE(SUM(not_observed = 0 AND confidence = 'low'), 0), COALESCE(SUM(not_observed = 0 AND confidence = 'medium'), 0), COALESCE(SUM(not_observed = 0 AND confidence = 'high'), 0) FROM assessment_ratings WHERE assessment_id = ?",
        [aid],
        {
          use rated <- decode.field(0, decode.int)
          use not_observed <- decode.field(1, decode.int)
          use low <- decode.field(2, decode.int)
          use medium <- decode.field(3, decode.int)
          use high <- decode.field(4, decode.int)
          decode.success(#(rated, not_observed, #(low, medium, high)))
        },
      ),
    )
    use refs <- result.map(store.query(
      read,
      "SELECT COUNT(*) FROM assessment_rating_refs WHERE assessment_id = ?",
      [aid],
      decode.at([0], decode.int),
    ))
    let #(rated, not_observed, confidence) =
      list.first(counts) |> result.unwrap(#(0, 0, #(0, 0, 0)))
    Counted(
      a,
      rated,
      not_observed,
      confidence,
      list.first(refs) |> result.unwrap(0),
    )
  })
}

/// The Room's blind rule: a scout reads a peer's submitted assessment only after submitting their own. Returns
/// the visible assessments and how many submitted ones are withheld.
pub fn visible(
  all: List(Counted),
  user: id.OrgUserId,
  lead: Bool,
) -> #(List(Counted), Int) {
  let submitted = fn(c: Counted) { c.row.state != assessment_row.Draft }
  let own_submitted =
    list.any(all, fn(c) { c.row.scout_user_id == user && submitted(c) })
  let shown =
    list.filter(all, fn(c) {
      lead || c.row.scout_user_id == user || { submitted(c) && own_submitted }
    })
  #(shown, list.count(all, submitted) - list.count(shown, submitted))
}

pub type Summary {
  Summary(
    submitted: List(Counted),
    drafts: Int,
    withheld: Int,
    verdicts: List(#(String, Int)),
  )
}

pub fn summarise(shown: List(Counted), withheld: Int) -> Summary {
  let submitted =
    shown
    |> list.filter(fn(c) { c.row.state != assessment_row.Draft })
    |> list.sort(fn(a, b) {
      case
        int.compare(
          option.unwrap(a.row.submitted_at, 0),
          option.unwrap(b.row.submitted_at, 0),
        )
      {
        order.Eq ->
          string.compare(
            id.assessment_to_string(a.row.id),
            id.assessment_to_string(b.row.id),
          )
        other -> other
      }
    })
  let count = fn(v) {
    list.count(submitted, fn(c) { c.row.recommendation_verdict == v })
  }
  Summary(
    submitted:,
    drafts: list.count(shown, fn(c) { c.row.state == assessment_row.Draft }),
    withheld:,
    verdicts: [
      #("sign", count(Some(case_outcome.Sign))),
      #("monitor", count(Some(case_outcome.Monitor))),
      #("pass", count(Some(case_outcome.Pass))),
      #("none", count(None)),
    ],
  )
}

pub fn snapshot_of(s: Summary) -> AssessmentSnapshot {
  AssessmentSnapshot(
    submitted: list.length(s.submitted),
    withheld: s.withheld,
    verdicts: s.verdicts,
    ids: s.submitted |> list.map(fn(c) { c.row.id }) |> list.take(20),
  )
}

pub fn summary_json(s: Summary) -> Json {
  let distinct =
    s.verdicts
    |> list.filter(fn(v) { v.0 != "none" && v.1 > 0 })
    |> list.map(fn(v) { v.0 })
  json.object([
    #("submitted", json.int(list.length(s.submitted))),
    #("drafts", json.int(s.drafts)),
    #("withheld", json.int(s.withheld)),
    #(
      "verdicts",
      json.object(list.map(s.verdicts, fn(v) { #(v.0, json.int(v.1)) })),
    ),
    #("disagreement", case distinct, s.submitted {
      [_, _, ..], _ ->
        json.object([
          #("kind", json.string("verdicts_differ")),
          #("verdicts", json.array(distinct, json.string)),
        ])
      _, [_, _, ..] ->
        json.object([
          #("kind", json.string("unanimous")),
          #("verdicts", json.array(distinct, json.string)),
        ])
      _, _ -> json.null()
    }),
    #(
      "assessments",
      json.array(s.submitted, fn(c) {
        let a = c.row
        json.object([
          #("id", id.assessment_json(a.id)),
          #("scoutName", json.string(a.scout_name)),
          #("scoutUserId", id.org_user_json(a.scout_user_id)),
          #("state", assessment_row.state_to_json(a.state)),
          #("submittedAt", json.nullable(a.submitted_at, json.int)),
          #(
            "verdict",
            json.nullable(a.recommendation_verdict, case_outcome.to_json),
          ),
          #("trialId", json.nullable(a.context_trial_id, json.string)),
          #(
            "trialSessionId",
            json.nullable(a.context_trial_session_id, json.string),
          ),
          #("rated", json.int(c.rated)),
          #("notObserved", json.int(c.not_observed)),
          #(
            "confidence",
            json.object([
              #("low", json.int({ c.confidence }.0)),
              #("medium", json.int({ c.confidence }.1)),
              #("high", json.int({ c.confidence }.2)),
            ]),
          ),
          #("evidenceRefs", json.int(c.evidence_refs)),
          #("published", json.bool(option.is_some(a.published_feedback_text))),
        ])
      }),
    ),
    #(
      "note",
      json.string(
        "Independent assessments, summarised as counts. ScoutBox does not average them and does not decide.",
      ),
    ),
  ])
}

/// Inside a unit: the case's draft, its decision chain and its subject are as the route read them, or the act lost
/// a race (two finalizations, an edit beside a finalization, the player leaving).
pub fn unchanged(
  read: Read,
  room_id: id.RecruitmentCaseId,
  org_id: id.OrgId,
  dr: Draft,
  head: Option(Decision),
) -> Result(Nil, Fail(e)) {
  use now_draft <- result.try(draft(read, room_id))
  use rows <- result.try(rows_of(read, room_id, org_id))
  use removed <- result.try(store.one(
    read,
    "SELECT subject_removed_at FROM recruitment_cases WHERE id = ?",
    [id.recruitment_case_sql(room_id)],
    decode.at([0], decode.optional(decode.int)),
  ))
  let key = fn(h: Option(Decision)) {
    option.map(h, fn(d) { #(d.base.row.id, d.base.row.rev) })
  }
  let same_draft = case now_draft {
    Some(d) -> d.row.id == dr.row.id && d.row.rev == dr.row.rev
    None -> False
  }
  case same_draft, key(chain_head(rows.rows)) == key(head), removed {
    True, True, Ok(None) -> Ok(Nil)
    _, _, _ -> store.stale("the case's decision draft, chain or subject moved")
  }
}
