//// Regulatory review items (repositories/complianceRecords.mjs `reviews`, opened by domains/agents/compliance/
//// shared.mjs): the attributed Trust & Safety lane's queue. The agent core opens one when a facet submission needs
//// a named reviewer, when a client disputes a relationship, and when an approach's deciding rule is uncertain.
//// The reviewer lane's routes that start, resolve, cancel or supersede one are `agents/review_routes` and
//// `agents/compliance_routes`.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/approach_policy.{type Reason}
import scoutbox/agents/conflict
import scoutbox/messaging/notifications
import scoutbox/platform/effect
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/regulatory_review_history as event_row
import scoutbox/rows/regulatory_review_reasons as reason_row
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/vocab/agent_facet.{type AgentFacet}
import scoutbox/vocab/agreement_status
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind.{type ComplianceActorKind}
import scoutbox/vocab/context_outcome
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction.{type Jurisdiction}
import scoutbox/vocab/party_role
import scoutbox/vocab/review_status
import scoutbox/vocab/reviewer_role
import sqlight

/// Who asked for the review.
pub type RequestedBy {
  RequestedBy(
    kind: ComplianceActorKind,
    id: Option(String),
    name: Option(String),
  )
}

/// What the review is about.
pub type Subject {
  FacetSubject(
    profile_id: id.AgentProfileId,
    user_id: id.OrgUserId,
    facet: AgentFacet,
    member_association: Option(Jurisdiction),
  )
  DisputeSubject(agreement_id: id.AgreementId)
  ApproachSubject(player_id: id.PlayerId, jurisdiction: Jurisdiction)
}

/// An open item already covers this facet.
pub fn open_for_facet(
  read: Read,
  profile_id: id.AgentProfileId,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM regulatory_reviews WHERE kind = 'verification_facet' AND status IN ('PENDING','IN_REVIEW')
       AND subject_profile_id = ? AND subject_facet = ? AND subject_member_association IS ?",
    [
      id.agent_profile_sql(profile_id),
      sqlight.text(agent_facet.to_string(facet)),
      sqlight.nullable(sqlight.text, option.map(ma, jurisdiction.to_string)),
    ],
    decode.at([0], decode.int),
  )
  |> result.map(result.is_ok)
}

/// An open item already covers this agreement's dispute.
pub fn open_for_agreement(
  read: Read,
  agreement_id: id.AgreementId,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM regulatory_reviews WHERE kind = 'representation_dispute' AND status IN ('PENDING','IN_REVIEW')
       AND subject_agreement_id = ?",
    [id.agreement_sql(agreement_id)],
    decode.at([0], decode.int),
  )
  |> result.map(result.is_ok)
}

/// Opens an item, PENDING, with its reasons, policy versions and request entry, and tells the agent.
pub fn create(
  tx: Tx,
  agency: id.OrgId,
  agent: Option(id.OrgUserId),
  subject: Subject,
  reasons: List(Reason),
  policy_versions: List(id.PolicyId),
  requested_by: RequestedBy,
  now: Int,
) -> Result(id.RegulatoryReviewId, Fail(e)) {
  use review_id <- result.try(id.next_regulatory_review(tx))
  let #(kind, base) = case subject {
    FacetSubject(..) -> #(
      review_row.VerificationFacet,
      review_row.Row(
        ..blank(
          review_id,
          review_row.VerificationFacet,
          agency,
          requested_by,
          now,
        ),
        subject_profile_id: Some(subject.profile_id),
        subject_user_id: Some(subject.user_id),
        subject_facet: Some(subject.facet),
        subject_member_association: option.map(
          subject.member_association,
          jurisdiction.to_string,
        ),
      ),
    )
    DisputeSubject(agreement_id:) -> #(
      review_row.RepresentationDispute,
      review_row.Row(
        ..blank(
          review_id,
          review_row.RepresentationDispute,
          agency,
          requested_by,
          now,
        ),
        subject_agreement_id: Some(agreement_id),
      ),
    )
    ApproachSubject(player_id:, jurisdiction: j) -> #(
      review_row.ConflictEvaluation,
      review_row.Row(
        ..blank(
          review_id,
          review_row.ConflictEvaluation,
          agency,
          requested_by,
          now,
        ),
        subject_is_approach: True,
        subject_player_id: Some(player_id),
        subject_jurisdiction: Some(jurisdiction.to_string(j)),
        snapshot_outcome: Some(context_outcome.ManualRegulatoryReviewRequired),
        snapshot_evaluated_at: Some(now),
      ),
    )
  }
  use _ <- result.try(review_row.insert(
    tx,
    review_row.Row(..base, agent_user_id: agent),
  ))
  use _ <- result.try(
    list.index_map(reasons, fn(r, i) { #(i, r) })
    |> list.try_each(fn(p) {
      let r = p.1
      reason_row.insert(
        tx,
        reason_row.Row(
          ..reason_row.new(review_id:, ord: p.0, code: r.code),
          rule_id: r.rule_id,
          rule_status: case r.code {
            "NO_PROVIDER" | "CLIENT_DISPUTE" -> None
            _ -> Some(r.rule_status)
          },
          regulator: r.regulator,
          jurisdiction: r.jurisdiction,
          policy_version_id: r.policy_version,
          facet: option.map(r.facet, agent_facet.to_string),
          member_association: option.map(
            r.member_association,
            jurisdiction.to_string,
          ),
          state: option.map(r.state, facet_state.to_string),
        ),
      )
    }),
  )
  finish(tx, review_id, kind, agency, agent, policy_versions, requested_by, now)
}

/// The policy versions, the request entry and the notices every new item gets.
fn finish(
  tx: Tx,
  review_id: id.RegulatoryReviewId,
  kind: review_row.Kind,
  agency: id.OrgId,
  agent: Option(id.OrgUserId),
  policy_versions: List(id.PolicyId),
  requested_by: RequestedBy,
  now: Int,
) -> Result(id.RegulatoryReviewId, Fail(e)) {
  use _ <- result.try(
    list.index_map(policy_versions, fn(v, i) { #(i, v) })
    |> list.try_each(fn(p) {
      store.run(
        tx,
        "INSERT INTO regulatory_review_policy_versions (review_id, ord, policy_version_id) VALUES (?, ?, ?)",
        [
          id.regulatory_review_sql(review_id),
          sqlight.int(p.0),
          id.policy_sql(p.1),
        ],
      )
    }),
  )
  use event_id <- result.try(id.next_review_event(tx))
  use _ <- result.try(event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        review_id:,
        ord: 0,
        at: now,
        by_kind: requested_by.kind,
        action: event_row.RegulatoryReviewRequested,
      ),
      by_id: requested_by.id,
      by_name: requested_by.name,
    ),
  ))
  store.emit(
    tx,
    effect.Live(live_event.RegulatoryReviewRequested(
      org_id: id.org_to_string(agency),
      review_id: id.regulatory_review_to_string(review_id),
      kind: review_row.kind_to_string(kind),
    )),
  )
  use _ <- result.try(case agent {
    Some(agent) ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(agent),
        type_: "regulatory_review_required",
        text: case kind {
          review_row.VerificationFacet ->
            "A verification submission needs attributed Trust & Safety review. Nothing is verified until a named reviewer decides."
          _ ->
            "A compliance question needs attributed Trust & Safety review. The workflow does not proceed until a named reviewer decides."
        },
        ref_id: Some(id.regulatory_review_to_string(review_id)),
        at: now,
      )
    None -> Ok(Nil)
  })
  Ok(review_id)
}

/// What a conflict review is about: a transaction's context, and the party (and binding) in question.
pub type ContextSubject {
  ContextSubject(
    context_id: id.ComplianceContextId,
    /// None for an agent's own context.
    transaction_id: Option(String),
    representation_id: Option(String),
    party_role: party_role.PartyRole,
  )
}

/// A review of a conflict evaluation or of a declared-only binding, with the engine's reasons and the snapshot it
/// was asked on.
pub fn create_for_context(
  tx: Tx,
  kind: review_row.Kind,
  agency: id.OrgId,
  agent: id.OrgUserId,
  subject: ContextSubject,
  reasons: List(conflict.Reason),
  policy_versions: List(id.PolicyId),
  snapshot: #(context_outcome.ContextOutcome, Option(id.EvaluationId), Int),
  requested_by: RequestedBy,
  now: Int,
) -> Result(id.RegulatoryReviewId, Fail(e)) {
  use review_id <- result.try(id.next_regulatory_review(tx))
  let #(outcome, evaluation_id, evaluated_at) = snapshot
  use _ <- result.try(review_row.insert(
    tx,
    review_row.Row(
      ..blank(review_id, kind, agency, requested_by, now),
      agent_user_id: Some(agent),
      subject_context_id: Some(id.compliance_context_to_string(
        subject.context_id,
      )),
      subject_transaction_id: subject.transaction_id,
      subject_representation_id: subject.representation_id,
      subject_party_role: Some(subject.party_role),
      snapshot_outcome: Some(outcome),
      snapshot_evaluation_id: option.map(evaluation_id, id.evaluation_to_string),
      snapshot_evaluated_at: Some(evaluated_at),
    ),
  ))
  use _ <- result.try(
    list.index_map(reasons, fn(r, i) { #(i, r) })
    |> list.try_each(fn(p) {
      let #(ord, r) = p
      use _ <- result.try(reason_row.insert(
        tx,
        reason_row.Row(
          ..reason_row.new(review_id:, ord:, code: r.code),
          rule_id: r.rule_id,
          rule_status: Some(r.rule_status),
          regulator: r.regulator,
          jurisdiction: r.jurisdiction,
          policy_version_id: r.policy_version,
          state: r.state,
          agent_user_id: option.map(r.agent_user_id, id.org_user),
          party_role: option.map(r.party_role, party_role.to_string),
          override_rule_id: r.override_rule_id,
          via_connected_agent: case r.via_connected_agent {
            True -> Some(1)
            False -> None
          },
          has_party_roles: option.is_some(r.party_roles),
          has_jurisdictions: option.is_some(r.jurisdictions),
        ),
      ))
      let items = fn(which, values: List(String)) {
        list.index_map(values, fn(v, i) {
          store.run(
            tx,
            "INSERT INTO regulatory_review_reason_items (review_id, reason_ord, list, ord, value) VALUES (?, ?, ?, ?, ?)",
            [
              id.regulatory_review_sql(review_id),
              sqlight.int(ord),
              sqlight.text(which),
              sqlight.int(i),
              sqlight.text(v),
            ],
          )
        })
      }
      [
        items(
          "partyRoles",
          option.unwrap(r.party_roles, []) |> list.map(party_role.to_string),
        ),
        items("jurisdictions", option.unwrap(r.jurisdictions, [])),
      ]
      |> list.flatten
      |> result.all
      |> result.replace(Nil)
    }),
  )
  finish(
    tx,
    review_id,
    kind,
    agency,
    Some(agent),
    policy_versions,
    requested_by,
    now,
  )
}

/// An open item is cancelled (its context closed, say).
pub fn cancel(
  tx: Tx,
  review_id: id.RegulatoryReviewId,
  by_kind: ComplianceActorKind,
  by_id: Option(String),
  by_name: Option(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE regulatory_reviews SET status = 'CANCELLED', decided_at = ? WHERE id = ? AND status IN ('PENDING','IN_REVIEW')",
      [sqlight.int(at), id.regulatory_review_sql(review_id)],
    ),
  )
  use ord <- result.try(
    store.one(
      store.reading(tx),
      "SELECT COALESCE(MAX(ord) + 1, 0) FROM regulatory_review_history WHERE review_id = ?",
      [id.regulatory_review_sql(review_id)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  use event_id <- result.try(id.next_review_event(tx))
  event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        review_id:,
        ord:,
        at:,
        by_kind:,
        action: event_row.RegulatoryReviewCancelled,
      ),
      by_id:,
      by_name:,
    ),
  )
}

fn blank(
  review_id: id.RegulatoryReviewId,
  kind: review_row.Kind,
  agency: id.OrgId,
  by: RequestedBy,
  now: Int,
) -> review_row.Row {
  review_row.Row(
    ..review_row.new(
      id: review_id,
      kind:,
      status: review_status.Pending,
      agency_org_id: agency,
      subject_is_approach: False,
      requested_at: now,
      requested_by_kind: by.kind,
      rev: 1,
    ),
    requested_by_id: by.id,
    requested_by_name: by.name,
    rev_at: Some(now),
  )
}

// ------------------------------------------------------------------------------------------------- reading

/// A review item with its reasons, policy versions and the evidence its decision cited.
pub type Review {
  Review(
    row: review_row.Row,
    reasons: List(reason_row.Row),
    policy_versions: List(id.PolicyId),
    evidence_refs: List(String),
    /// Each reason's listed values: its position, the list's name and the value.
    reason_items: List(#(Int, String, String)),
    /// The review that reconsiders this one, worked out on read.
    superseded_by: Option(id.RegulatoryReviewId),
  )
}

fn load(read: Read, r: review_row.Row) -> Result(Review, Fail(e)) {
  let rid = id.regulatory_review_sql(r.id)
  use reasons <- result.try(store.query(
    read,
    "SELECT "
      <> reason_row.columns
      <> " FROM regulatory_review_reasons WHERE review_id = ? ORDER BY ord",
    [rid],
    reason_row.decoder(),
  ))
  use pvs <- result.try(store.query(
    read,
    "SELECT policy_version_id FROM regulatory_review_policy_versions WHERE review_id = ? ORDER BY ord",
    [rid],
    decode.at([0], id.policy_decoder()),
  ))
  use refs <- result.try(store.query(
    read,
    "SELECT ref FROM regulatory_review_evidence_refs WHERE review_id = ? ORDER BY ord",
    [rid],
    decode.at([0], decode.string),
  ))
  use items <- result.try(
    store.query(
      read,
      "SELECT reason_ord, list, value FROM regulatory_review_reason_items WHERE review_id = ? ORDER BY reason_ord, list, ord",
      [rid],
      {
        use ord <- decode.field(0, decode.int)
        use which <- decode.field(1, decode.string)
        use value <- decode.field(2, decode.string)
        decode.success(#(ord, which, value))
      },
    ),
  )
  use by <- result.map(store.query(
    read,
    "SELECT id FROM regulatory_reviews WHERE supersedes_id = ? ORDER BY rowid LIMIT 1",
    [rid],
    decode.at([0], id.regulatory_review_decoder()),
  ))
  Review(r, reasons, pvs, refs, items, list.first(by) |> option.from_result)
}

pub fn by_id(
  read: Read,
  review_id: id.RegulatoryReviewId,
) -> Result(Option(Review), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> review_row.columns <> " FROM regulatory_reviews WHERE id = ?",
    [id.regulatory_review_sql(review_id)],
    review_row.decoder(),
  ))
  case found {
    Ok(r) -> load(read, r) |> result.map(Some)
    Error(Nil) -> Ok(None)
  }
}

/// The agency's review items, oldest first.
pub fn for_agency(
  read: Read,
  agency: id.OrgId,
) -> Result(List(Review), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> review_row.columns
      <> " FROM regulatory_reviews WHERE agency_org_id = ? ORDER BY rowid",
    [id.org_sql(agency)],
    review_row.decoder(),
  ))
  list.try_map(rows, load(read, _))
}

/// Open items first, each part oldest first, by cursor: each row with its `[rank, requested_at, rowid]` key.
pub fn queue_page(
  read: Read,
  status: Option(review_status.ReviewStatus),
  after: Option(#(Int, Int, Int)),
  limit: Int,
) -> Result(List(#(#(Int, Int, Int), Review)), Fail(e)) {
  let open = "CASE WHEN status IN ('PENDING','IN_REVIEW') THEN 0 ELSE 1 END"
  let s =
    sqlight.nullable(sqlight.text, option.map(status, review_status.to_string))
  let key = fn(f) { sqlight.nullable(sqlight.int, option.map(after, f)) }
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> review_row.columns
        <> ", "
        <> open
        <> ", requested_at, rowid FROM regulatory_reviews WHERE (? IS NULL OR status = ?) AND (? IS NULL OR ("
        <> open
        <> ", requested_at, rowid) > (?, ?, ?)) ORDER BY "
        <> open
        <> ", requested_at, rowid LIMIT ?",
      [
        s,
        s,
        key(fn(k) { k.0 }),
        key(fn(k) { k.0 }),
        key(fn(k) { k.1 }),
        key(fn(k) { k.2 }),
        sqlight.int(limit + 1),
      ],
      {
        use r <- decode.then(review_row.decoder())
        use rank <- decode.field(review_row.width, decode.int)
        use at <- decode.field(review_row.width + 1, decode.int)
        use rid <- decode.field(review_row.width + 2, decode.int)
        decode.success(#(#(rank, at, rid), r))
      },
    ),
  )
  list.try_map(rows, fn(x) {
    load(read, x.1) |> result.map(fn(r) { #(x.0, r) })
  })
}

/// What a named reviewer decided, with the state before and after.
pub type Decision {
  Decision(
    reviewer_id: String,
    reviewer_name: String,
    reviewer_role: reviewer_role.ReviewerRole,
    outcome: review_row.DecisionOutcome,
    reason_code: String,
    reason: String,
    evidence_refs: List(String),
    prior_status: review_status.ReviewStatus,
    prior_facet_state: Option(facet_state.FacetState),
    prior_agreement_status: Option(agreement_status.AgreementStatus),
    prior_context_outcome: Option(context_outcome.ContextOutcome),
    prior_representation_status: Option(
      declared_representation_status.DeclaredRepresentationStatus,
    ),
    result_facet_state: Option(facet_state.FacetState),
    result_agreement_status: Option(agreement_status.AgreementStatus),
    result_context_outcome: Option(context_outcome.ContextOutcome),
    result_representation_status: Option(
      declared_representation_status.DeclaredRepresentationStatus,
    ),
    result_note: Option(review_row.ResultNote),
    at: Int,
  )
}

/// An open item is decided, its decision recorded with the evidence it cites and its rev moved by the reviewer.
pub fn resolve(
  tx: Tx,
  r: Review,
  d: Decision,
  key: Option(#(String, String)),
) -> Result(Nil, Fail(e)) {
  let rid = id.regulatory_review_sql(r.row.id)
  let text = sqlight.nullable(sqlight.text, _)
  use rows <- result.try(store.write(
    tx,
    "UPDATE regulatory_reviews SET status = ?, decided_at = ?, decision_reviewer_id = ?, decision_reviewer_name = ?, decision_reviewer_role = ?, decision_outcome = ?, decision_reason_code = ?, decision_reason = ?, decision_at = ?, prior_status = ?, prior_facet_state = ?, prior_agreement_status = ?, prior_context_outcome = ?, prior_representation_status = ?, result_facet_state = ?, result_agreement_status = ?, result_context_outcome = ?, result_representation_status = ?, result_note = ?, resolve_key = ?, resolve_fp = ?, rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ? AND status IN ('PENDING','IN_REVIEW') RETURNING 1",
    [
      sqlight.text(
        review_status.to_string(case d.outcome {
          review_row.Approved -> review_status.Approved
          review_row.Rejected -> review_status.Rejected
          review_row.Cancelled -> review_status.Cancelled
        }),
      ),
      sqlight.int(d.at),
      sqlight.text(d.reviewer_id),
      sqlight.text(d.reviewer_name),
      sqlight.text(reviewer_role.to_string(d.reviewer_role)),
      sqlight.text(review_row.decision_outcome_to_string(d.outcome)),
      sqlight.text(d.reason_code),
      sqlight.text(d.reason),
      sqlight.int(d.at),
      sqlight.text(review_status.to_string(d.prior_status)),
      text(option.map(d.prior_facet_state, facet_state.to_string)),
      text(option.map(d.prior_agreement_status, agreement_status.to_string)),
      text(option.map(d.prior_context_outcome, context_outcome.to_string)),
      text(option.map(
        d.prior_representation_status,
        declared_representation_status.to_string,
      )),
      text(option.map(d.result_facet_state, facet_state.to_string)),
      text(option.map(d.result_agreement_status, agreement_status.to_string)),
      text(option.map(d.result_context_outcome, context_outcome.to_string)),
      text(option.map(
        d.result_representation_status,
        declared_representation_status.to_string,
      )),
      text(option.map(d.result_note, review_row.result_note_to_string)),
      text(option.map(key, fn(k) { k.0 })),
      text(option.map(key, fn(k) { k.1 })),
      sqlight.int(d.at),
      sqlight.text(d.reviewer_id),
      sqlight.text(d.reviewer_name),
      rid,
    ],
    decode.at([0], decode.int),
  ))
  case rows {
    [] -> store.stale("the review is no longer open")
    _ -> {
      use _ <- result.try(
        list.index_map(d.evidence_refs, fn(ref, i) { #(i, ref) })
        |> list.try_each(fn(p) {
          store.run(
            tx,
            "INSERT INTO regulatory_review_evidence_refs (review_id, ord, ref) VALUES (?, ?, ?)",
            [rid, sqlight.int(p.0), sqlight.text(p.1)],
          )
        }),
      )
      use ord <- result.try(
        store.one(
          store.reading(tx),
          "SELECT COALESCE(MAX(ord) + 1, 0) FROM regulatory_review_history WHERE review_id = ?",
          [rid],
          decode.at([0], decode.int),
        )
        |> result.map(result.unwrap(_, 0)),
      )
      use event_id <- result.try(id.next_review_event(tx))
      event_row.insert(
        tx,
        event_row.Row(
          ..event_row.new(
            id: event_id,
            review_id: r.row.id,
            ord:,
            at: d.at,
            by_kind: compliance_actor_kind.TsReviewer,
            action: event_row.RegulatoryReviewResolved,
          ),
          by_id: Some(d.reviewer_id),
          by_name: Some(d.reviewer_name),
          by_role: Some(reviewer_role.to_string(d.reviewer_role)),
          detail_rev: Some(r.row.rev),
        ),
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------- the reviewer's acts

/// A reviewer acting on an item.
pub type Reviewer {
  Reviewer(id: String, name: String, role: reviewer_role.ReviewerRole)
}

fn reviewer_event(
  tx: Tx,
  review_id: id.RegulatoryReviewId,
  by: Reviewer,
  action: event_row.Action,
  rev: Option(Int),
  detail_review_id: Option(id.RegulatoryReviewId),
  prior_status: Option(review_status.ReviewStatus),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use ord <- result.try(
    store.one(
      store.reading(tx),
      "SELECT COALESCE(MAX(ord) + 1, 0) FROM regulatory_review_history WHERE review_id = ?",
      [id.regulatory_review_sql(review_id)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  use event_id <- result.try(id.next_review_event(tx))
  event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        review_id:,
        ord:,
        at:,
        by_kind: compliance_actor_kind.TsReviewer,
        action:,
      ),
      by_id: Some(by.id),
      by_name: Some(by.name),
      by_role: Some(reviewer_role.to_string(by.role)),
      detail_rev: rev,
      detail_review_id:,
      detail_prior_status: prior_status,
    ),
  )
}

/// `UPDATE … WHERE <guard>` with the reviewer's rev bump; another reviewer moving it first is a lost race.
fn moved(
  tx: Tx,
  review_id: id.RegulatoryReviewId,
  set: String,
  args: List(sqlight.Value),
  guard: String,
  by: Reviewer,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use rows <- result.try(store.write(
    tx,
    "UPDATE regulatory_reviews SET "
      <> set
      <> ", rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ? AND "
      <> guard
      <> " RETURNING 1",
    list.append(args, [
      sqlight.int(at),
      sqlight.text(by.id),
      sqlight.text(by.name),
      id.regulatory_review_sql(review_id),
    ]),
    decode.at([0], decode.int),
  ))
  case rows {
    [] -> store.stale("the review moved")
    _ -> Ok(Nil)
  }
}

/// A pending item is taken by a named reviewer.
pub fn start(tx: Tx, r: Review, by: Reviewer, at: Int) -> Result(Nil, Fail(e)) {
  use _ <- result.try(moved(
    tx,
    r.row.id,
    "status = 'IN_REVIEW', started_at = ?, started_by_id = ?, started_by_name = ?, started_by_role = ?",
    [
      sqlight.int(at),
      sqlight.text(by.id),
      sqlight.text(by.name),
      sqlight.text(reviewer_role.to_string(by.role)),
    ],
    "status = 'PENDING'",
    by,
    at,
  ))
  use _ <- result.map(reviewer_event(
    tx,
    r.row.id,
    by,
    event_row.RegulatoryReviewStarted,
    Some(r.row.rev),
    None,
    None,
    at,
  ))
  store.emit(
    tx,
    effect.Live(live_event.RegulatoryReviewStarted(
      org_id: id.org_to_string(r.row.agency_org_id),
      review_id: id.regulatory_review_to_string(r.row.id),
    )),
  )
}

/// A reviewer cancels an open item, with a written reason: a CANCELLED decision.
pub fn cancel_decided(
  tx: Tx,
  r: Review,
  by: Reviewer,
  reason: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(moved(
    tx,
    r.row.id,
    "status = 'CANCELLED', decided_at = ?, decision_reviewer_id = ?, decision_reviewer_name = ?, decision_reviewer_role = ?, decision_outcome = 'CANCELLED', decision_reason_code = 'cancelled', decision_reason = ?, decision_at = ?",
    [
      sqlight.int(at),
      sqlight.text(by.id),
      sqlight.text(by.name),
      sqlight.text(reviewer_role.to_string(by.role)),
      sqlight.text(reason),
      sqlight.int(at),
    ],
    "status IN ('PENDING','IN_REVIEW')",
    by,
    at,
  ))
  reviewer_event(
    tx,
    r.row.id,
    by,
    event_row.RegulatoryReviewCancelled,
    Some(r.row.rev),
    None,
    None,
    at,
  )
}

/// A decided item is reconsidered by a new one naming it; its own decision stays as it was. Returns the new id.
pub fn supersede(
  tx: Tx,
  r: Review,
  by: Reviewer,
  policy_versions: List(id.PolicyId),
  at: Int,
) -> Result(id.RegulatoryReviewId, Fail(e)) {
  use new_id <- result.try(id.next_regulatory_review(tx))
  let old = r.row
  let requested_by =
    RequestedBy(
      kind: compliance_actor_kind.TsReviewer,
      id: Some(by.id),
      name: Some(by.name),
    )
  use _ <- result.try(review_row.insert(
    tx,
    review_row.Row(
      ..blank(new_id, old.kind, old.agency_org_id, requested_by, at),
      agent_user_id: old.agent_user_id,
      subject_profile_id: old.subject_profile_id,
      subject_user_id: old.subject_user_id,
      subject_facet: old.subject_facet,
      subject_member_association: old.subject_member_association,
      subject_agreement_id: old.subject_agreement_id,
      subject_context_id: old.subject_context_id,
      subject_transaction_id: old.subject_transaction_id,
      subject_representation_id: old.subject_representation_id,
      subject_party_role: old.subject_party_role,
      subject_is_approach: old.subject_is_approach,
      subject_player_id: old.subject_player_id,
      subject_jurisdiction: old.subject_jurisdiction,
      snapshot_outcome: old.snapshot_outcome,
      snapshot_evaluation_id: old.snapshot_evaluation_id,
      snapshot_evaluated_at: old.snapshot_evaluated_at,
      requested_by_role: Some(reviewer_role.to_string(by.role)),
      supersedes_id: Some(old.id),
    ),
  ))
  use _ <- result.try(
    list.try_each(r.reasons, fn(x) {
      reason_row.insert(tx, reason_row.Row(..x, review_id: new_id))
    }),
  )
  use _ <- result.try(
    list.index_map(r.reason_items, fn(item, i) { #(i, item) })
    |> list.try_each(fn(p) {
      let #(_, #(reason_ord, which, value)) = p
      store.run(
        tx,
        "INSERT INTO regulatory_review_reason_items (review_id, reason_ord, list, ord, value) VALUES (?, ?, ?, (SELECT COUNT(*) FROM regulatory_review_reason_items WHERE review_id = ? AND reason_ord = ? AND list = ?), ?)",
        [
          id.regulatory_review_sql(new_id),
          sqlight.int(reason_ord),
          sqlight.text(which),
          id.regulatory_review_sql(new_id),
          sqlight.int(reason_ord),
          sqlight.text(which),
          sqlight.text(value),
        ],
      )
    }),
  )
  use _ <- result.try(finish(
    tx,
    new_id,
    old.kind,
    old.agency_org_id,
    old.agent_user_id,
    policy_versions,
    requested_by,
    at,
  ))
  use _ <- result.try(reviewer_event(
    tx,
    new_id,
    by,
    event_row.RegulatoryReviewRequested,
    None,
    Some(old.id),
    None,
    at,
  ))
  use _ <- result.try(moved(
    tx,
    old.id,
    "status = 'SUPERSEDED'",
    [],
    "status IN ('APPROVED','REJECTED')",
    by,
    at,
  ))
  use _ <- result.map(reviewer_event(
    tx,
    old.id,
    by,
    event_row.RegulatoryReviewSuperseded,
    Some(old.rev),
    Some(new_id),
    Some(old.status),
    at,
  ))
  new_id
}
