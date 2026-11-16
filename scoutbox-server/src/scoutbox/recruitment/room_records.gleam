//// A Room's own records (repositories/recruitmentCases.ts): its discussion (`room_comments`), its decision memory
//// (`room_decisions`, append-only, a revision superseding its predecessor), the evidence confidence it saw at each
//// decision point (`room_snapshots`) and its internal review of each evidence record (`room_evidence_states`).
////
//// Not ported yet: a formal decision's draft, finalisation, evidence refs and assessment summary (the lifecycle's
//// decision routes).

import gleam/dynamic/decode
import gleam/float
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/room_comment_mentions as mention_row
import scoutbox/rows/room_comments as comment_row
import scoutbox/rows/room_decision_reason_codes as code_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/room_evidence_states as evidence_row
import scoutbox/rows/room_snapshot_source_refs as ref_row
import scoutbox/rows/room_snapshots as snapshot_row
import sqlight

// -------------------------------------------------------------------------------------------------------- comments

pub type Comment {
  Comment(row: comment_row.Row, mentions: List(id.OrgUserId))
}

fn with_mentions(read: Read, r: comment_row.Row) -> Result(Comment, Fail(e)) {
  use mentions <- result.map(store.query(
    read,
    "SELECT user_id FROM room_comment_mentions WHERE comment_id = ? ORDER BY position",
    [id.room_comment_sql(r.id)],
    decode.at([0], id.org_user_decoder()),
  ))
  Comment(r, mentions)
}

/// A Room's comments, in the order they were written.
pub fn comments(
  read: Read,
  room_id: id.RecruitmentCaseId,
) -> Result(List(Comment), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> comment_row.columns
      <> " FROM room_comments WHERE room_id = ? ORDER BY rowid",
    [id.recruitment_case_sql(room_id)],
    comment_row.decoder(),
  ))
  list.try_map(rows, with_mentions(read, _))
}

/// The comment `id` names, if it belongs to the Room.
pub fn comment(
  read: Read,
  room_id: id.RecruitmentCaseId,
  comment_id: id.RoomCommentId,
) -> Result(Option(Comment), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> comment_row.columns
      <> " FROM room_comments WHERE id = ? AND room_id = ?",
    [id.room_comment_sql(comment_id), id.recruitment_case_sql(room_id)],
    comment_row.decoder(),
  ))
  case found {
    [r] -> with_mentions(read, r) |> result.map(Some)
    _ -> Ok(None)
  }
}

pub type NewComment {
  NewComment(
    room_id: id.RecruitmentCaseId,
    org_id: id.OrgId,
    author: #(id.OrgUserId, String),
    body: String,
    reply_to: Option(id.RoomCommentId),
    mentions: List(id.OrgUserId),
    at: Int,
  )
}

pub fn add_comment(tx: Tx, c: NewComment) -> Result(Comment, Fail(e)) {
  use comment_id <- result.try(id.next_room_comment(tx))
  let r =
    comment_row.Row(
      ..comment_row.new(
        id: comment_id,
        room_id: c.room_id,
        org_id: c.org_id,
        author_user_id: c.author.0,
        body: c.body,
        created_at: c.at,
        edit_count: 0,
      ),
      author_name: Some(c.author.1),
      reply_to_id: c.reply_to,
    )
  use _ <- result.try(comment_row.insert(tx, r))
  use _ <- result.map(
    list.index_map(c.mentions, fn(u, i) { #(u, i) })
    |> list.try_each(fn(p) {
      mention_row.insert(
        tx,
        mention_row.Row(comment_id: comment_id, position: p.1, user_id: p.0),
      )
    }),
  )
  Comment(r, c.mentions)
}

pub fn edit_comment(
  tx: Tx,
  comment_id: id.RoomCommentId,
  body: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE room_comments SET body = ?, edited_at = ?, edit_count = edit_count + 1 WHERE id = ? AND deleted_at IS NULL",
    [sqlight.text(body), sqlight.int(at), id.room_comment_sql(comment_id)],
  )
}

/// Tombstoned, never erased, so the thread and the audit trail stay intact.
pub fn remove_comment(
  tx: Tx,
  comment_id: id.RoomCommentId,
  by: #(id.OrgUserId, String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE room_comments SET deleted_at = ?, deleted_by_user_id = ?, deleted_by_name = ? WHERE id = ?",
    [
      sqlight.int(at),
      id.org_user_sql(by.0),
      sqlight.text(by.1),
      id.room_comment_sql(comment_id),
    ],
  )
}

// ------------------------------------------------------------------------------------------------------- snapshots

/// What evidence confidence the club could see when the snapshot was taken.
pub type SnapshotTrust {
  SnapshotTrust(
    score: Float,
    band: String,
    policy_version: Int,
    component_levels: List(#(String, Json)),
    hash: String,
  )
}

pub type Snapshot {
  Snapshot(row: snapshot_row.Row, refs: List(ref_row.Row))
}

pub const snapshot_note =
  "Evidence confidence at the time of the decision. It is not a record of the player’s ability."

pub type NewSnapshot {
  NewSnapshot(
    room_id: id.RecruitmentCaseId,
    org_id: id.OrgId,
    player_id: id.PlayerId,
    trigger: String,
    trust: Option(SnapshotTrust),
    passport_version: Option(Int),
    passport_revision: Option(String),
    evidence_ids: List(String),
    assessment_ids: List(String),
    combine_results: List(String),
    trial_ids: List(String),
    at: Int,
  )
}

/// Records references to explain the decision later, never a frozen copy of the Passport: a copy of restricted
/// player data would bypass later access checks. The lists are bounded (buildRoomSnapshot).
pub fn add_snapshot(tx: Tx, s: NewSnapshot) -> Result(Snapshot, Fail(e)) {
  use snapshot_id <- result.try(id.next_room_snapshot(tx))
  let r =
    snapshot_row.Row(
      ..snapshot_row.new(
        id: snapshot_id,
        room_id: s.room_id,
        org_id: s.org_id,
        player_id: s.player_id,
        at: s.at,
        trigger: s.trigger,
      ),
      trust_score: option.map(s.trust, fn(t) { t.score }),
      trust_band: option.map(s.trust, fn(t) { t.band }),
      trust_policy_version: option.map(s.trust, fn(t) { t.policy_version }),
      trust_component_levels_json: option.map(s.trust, fn(t) {
        json.to_string(json.object(t.component_levels))
      }),
      trust_hash: option.map(s.trust, fn(t) { t.hash }),
      source_passport_version: s.passport_version,
      source_passport_revision: s.passport_revision,
      note: Some(snapshot_note),
    )
  let refs =
    list.flatten([
      refs_of(snapshot_id, ref_row.Evidence, list.take(s.evidence_ids, 40)),
      refs_of(snapshot_id, ref_row.Assessment, list.take(s.assessment_ids, 20)),
      refs_of(snapshot_id, ref_row.Combine, list.take(s.combine_results, 20)),
      refs_of(snapshot_id, ref_row.Trial, list.take(s.trial_ids, 10)),
    ])
  use _ <- result.try(snapshot_row.insert(tx, r))
  use _ <- result.map(list.try_each(refs, ref_row.insert(tx, _)))
  Snapshot(r, refs)
}

fn refs_of(
  snapshot_id: id.RoomSnapshotId,
  kind: ref_row.Kind,
  ids: List(String),
) -> List(ref_row.Row) {
  list.index_map(ids, fn(ref_id, i) {
    ref_row.Row(snapshot_id:, kind:, position: i, ref_id:)
  })
}

fn snapshot_of(read: Read, r: snapshot_row.Row) -> Result(Snapshot, Fail(e)) {
  use refs <- result.map(store.query(
    read,
    "SELECT "
      <> ref_row.columns
      <> " FROM room_snapshot_source_refs WHERE snapshot_id = ? ORDER BY kind, position",
    [id.room_snapshot_sql(r.id)],
    ref_row.decoder(),
  ))
  Snapshot(r, refs)
}

/// A Room's snapshots, newest first.
pub fn snapshots(
  read: Read,
  room_id: id.RecruitmentCaseId,
) -> Result(List(Snapshot), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> snapshot_row.columns
      <> " FROM room_snapshots WHERE room_id = ? ORDER BY at DESC, rowid ASC",
    [id.recruitment_case_sql(room_id)],
    snapshot_row.decoder(),
  ))
  list.try_map(rows, snapshot_of(read, _))
}

pub fn snapshot(
  read: Read,
  snapshot_id: id.RoomSnapshotId,
) -> Result(Option(Snapshot), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> snapshot_row.columns <> " FROM room_snapshots WHERE id = ?",
    [id.room_snapshot_sql(snapshot_id)],
    snapshot_row.decoder(),
  ))
  case rows {
    [r] -> snapshot_of(read, r) |> result.map(Some)
    _ -> Ok(None)
  }
}

/// A score as JavaScript writes the number: an integral one without a fraction.
pub fn number_json(f: Float) -> Json {
  case float.floor(f) == f {
    True -> json.int(float.truncate(f))
    False -> json.float(f)
  }
}

pub fn snapshot_trust_json(r: snapshot_row.Row) -> Json {
  case r.trust_hash, r.trust_component_levels_json {
    Some(hash), Some(levels) ->
      json.object([
        #("score", json.nullable(r.trust_score, number_json)),
        #("band", json.nullable(r.trust_band, json.string)),
        #("policyVersion", json.nullable(r.trust_policy_version, json.int)),
        #(
          "componentLevels",
          json_text.parse(levels) |> result.unwrap(json.object([])),
        ),
        #("hash", json.string(hash)),
      ])
    _, _ -> json.null()
  }
}

pub fn source_refs_json(s: Snapshot) -> Json {
  let of = fn(kind) {
    list.filter_map(s.refs, fn(r) {
      case r.kind == kind {
        True -> Ok(r.ref_id)
        False -> Error(Nil)
      }
    })
  }
  json.object([
    #("passportVersion", json.nullable(s.row.source_passport_version, json.int)),
    #(
      "passportRevision",
      json.nullable(s.row.source_passport_revision, json.string),
    ),
    #("evidenceIds", json.array(of(ref_row.Evidence), json.string)),
    #("assessmentIds", json.array(of(ref_row.Assessment), json.string)),
    #("combineResults", json.array(of(ref_row.Combine), json.string)),
    #("trialIds", json.array(of(ref_row.Trial), json.string)),
  ])
}

/// A snapshot as stored.
pub fn snapshot_json(s: Snapshot) -> Json {
  json.object([
    #("id", id.room_snapshot_json(s.row.id)),
    #("roomId", id.recruitment_case_json(s.row.room_id)),
    #("orgId", id.org_json(s.row.org_id)),
    #("playerId", id.player_json(s.row.player_id)),
    #("at", json.int(s.row.at)),
    #("trigger", json.string(s.row.trigger)),
    #("trust", snapshot_trust_json(s.row)),
    #("sourceRefs", source_refs_json(s)),
    #("note", json.nullable(s.row.note, json.string)),
  ])
}

// ------------------------------------------------------------------------------------------------------- decisions

pub type Decision {
  Decision(
    row: decision_row.Row,
    reason_codes: List(String),
    snapshot: Option(Snapshot),
  )
}

/// A Room's decisions, oldest first: the last is the current one.
pub fn decisions(
  read: Read,
  room_id: id.RecruitmentCaseId,
) -> Result(List(Decision), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> decision_row.columns
      <> " FROM room_decisions WHERE room_id = ? ORDER BY created_at, rowid",
    [id.recruitment_case_sql(room_id)],
    decision_row.decoder(),
  ))
  list.try_map(rows, fn(r) {
    use codes <- result.try(store.query(
      read,
      "SELECT code FROM room_decision_reason_codes WHERE decision_id = ? ORDER BY position",
      [id.room_decision_sql(r.id)],
      decode.at([0], decode.string),
    ))
    use snap <- result.map(case r.snapshot_id {
      Some(s) -> snapshot(read, s)
      None -> Ok(None)
    })
    Decision(r, codes, snap)
  })
}

/// The ids of the organisation's Rooms with a decision recorded.
pub fn decided_rooms(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(id.RecruitmentCaseId), Fail(e)) {
  store.query(
    read,
    "SELECT DISTINCT room_id FROM room_decisions WHERE org_id = ?",
    [id.org_sql(org_id)],
    decode.at([0], id.recruitment_case_decoder()),
  )
}

pub type NewDecision {
  NewDecision(
    room_id: id.RecruitmentCaseId,
    org_id: id.OrgId,
    player_id: id.PlayerId,
    recommendation: decision_row.Recommendation,
    reason_codes: List(String),
    note: Option(String),
    by: #(id.OrgUserId, String, String),
    trigger: String,
    client_key: Option(String),
    supersedes: Option(id.RoomDecisionId),
    snapshot: Option(Snapshot),
    at: Int,
  )
}

/// Records an advisory decision; the one it supersedes is marked so.
pub fn add_decision(tx: Tx, d: NewDecision) -> Result(Decision, Fail(e)) {
  use decision_id <- result.try(id.next_room_decision(tx))
  let r =
    decision_row.Row(
      ..decision_row.new(
        id: decision_id,
        room_id: d.room_id,
        org_id: d.org_id,
        player_id: d.player_id,
        recommendation: d.recommendation,
        created_at: d.at,
      ),
      note: d.note,
      by_user_id: Some({ d.by }.0),
      by_name: Some({ d.by }.1),
      by_role: Some({ d.by }.2),
      trigger: Some(d.trigger),
      client_key: d.client_key,
      supersedes_id: d.supersedes,
      snapshot_id: option.map(d.snapshot, fn(s) { s.row.id }),
    )
  use _ <- result.try(decision_row.insert(tx, r))
  use _ <- result.try(
    list.index_map(d.reason_codes, fn(c, i) { #(c, i) })
    |> list.try_each(fn(p) {
      code_row.insert(
        tx,
        code_row.Row(decision_id: decision_id, position: p.1, code: p.0),
      )
    }),
  )
  use _ <- result.map(case d.supersedes {
    Some(prev) ->
      store.run(
        tx,
        "UPDATE room_decisions SET superseded_by_id = ? WHERE id = ?",
        [id.room_decision_sql(decision_id), id.room_decision_sql(prev)],
      )
    None -> Ok(Nil)
  })
  Decision(r, d.reason_codes, d.snapshot)
}

/// The decision as a Room's views show it (decisionView).
pub fn decision_json(d: Decision) -> Json {
  let formal = d.row.kind == Some(decision_row.Formal)
  json.object([
    #("id", id.room_decision_json(d.row.id)),
    #(
      "recommendation",
      decision_row.recommendation_to_json(d.row.recommendation),
    ),
    #("reasonCodes", json.array(d.reason_codes, json.string)),
    #("note", json.nullable(d.row.note, json.string)),
    #("by", case d.row.by_user_id, d.row.by_name, d.row.by_role {
      None, None, None -> json.null()
      user, name, role ->
        json.object([
          #("userId", json.nullable(user, id.org_user_json)),
          #("name", json.nullable(name, json.string)),
          #("role", json.nullable(role, json.string)),
        ])
    }),
    #("createdAt", json.int(d.row.created_at)),
    #(
      "supersededById",
      json.nullable(d.row.superseded_by_id, id.room_decision_json),
    ),
    #("snapshot", case d.snapshot {
      Some(s) ->
        json.object([
          #("at", json.int(s.row.at)),
          #("trust", snapshot_trust_json(s.row)),
          #("sourceRefs", source_refs_json(s)),
          #("snapshotId", id.room_snapshot_json(s.row.id)),
        ])
      None -> json.null()
    }),
    #(
      "kind",
      json.string(case formal {
        True -> "formal"
        False -> "recommendation"
      }),
    ),
    #("outcome", case formal {
      True -> json.nullable(d.row.outcome, decision_row.outcome_to_json)
      False -> json.null()
    }),
    // Not ported yet: a formal decision's lifecycle record.
    #("lifecycle", json.null()),
  ])
}

// --------------------------------------------------------------------------------------------- evidence reviews

pub type Review =
  evidence_row.Row

pub fn reviews(
  read: Read,
  room_id: id.RecruitmentCaseId,
) -> Result(List(Review), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> evidence_row.columns
      <> " FROM room_evidence_states WHERE room_id = ? ORDER BY rowid",
    [id.recruitment_case_sql(room_id)],
    evidence_row.decoder(),
  )
}

/// The Room's review of an evidence record: the player's record itself is never touched.
pub fn review(
  tx: Tx,
  existing: Option(Review),
  room_id: id.RecruitmentCaseId,
  org_id: id.OrgId,
  evidence_id: String,
  state: evidence_row.State,
  note: Option(String),
  by: #(id.OrgUserId, String),
  at: Int,
) -> Result(Review, Fail(e)) {
  case existing {
    Some(e) -> {
      let r =
        evidence_row.Row(
          ..e,
          state:,
          note: option.or(note, e.note),
          by_user_id: Some(by.0),
          by_name: Some(by.1),
          at:,
        )
      use _ <- result.map(
        store.run(
          tx,
          "UPDATE room_evidence_states SET state = ?, note = ?, by_user_id = ?, by_name = ?, at = ? WHERE id = ?",
          [
            sqlight.text(evidence_row.state_to_string(state)),
            sqlight.nullable(sqlight.text, r.note),
            id.org_user_sql(by.0),
            sqlight.text(by.1),
            sqlight.int(at),
            id.room_evidence_state_sql(e.id),
          ],
        ),
      )
      r
    }
    None -> {
      use review_id <- result.try(id.next_room_evidence_state(tx))
      let r =
        evidence_row.Row(
          ..evidence_row.new(
            id: review_id,
            room_id:,
            org_id:,
            evidence_id:,
            state:,
            at:,
          ),
          note:,
          by_user_id: Some(by.0),
          by_name: Some(by.1),
        )
      use _ <- result.map(evidence_row.insert(tx, r))
      r
    }
  }
}

/// Platform counts only: nothing from inside any room.
pub fn counts(read: Read) -> Result(#(Int, Int, Int), Fail(e)) {
  let n = fn(table) {
    store.one(
      read,
      "SELECT COUNT(*) FROM " <> table,
      [],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0))
  }
  use comments <- result.try(n("room_comments"))
  use decisions <- result.try(n("room_decisions"))
  use snapshots <- result.map(n("room_snapshots"))
  #(comments, decisions, snapshots)
}
