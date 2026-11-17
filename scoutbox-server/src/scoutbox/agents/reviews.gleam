//// Regulatory review items (repositories/complianceRecords.mjs `reviews`, opened by domains/agents/compliance/
//// shared.mjs): the attributed Trust & Safety lane's queue. The agent core opens one when a facet submission needs
//// a named reviewer, when a client disputes a relationship, and when an approach's deciding rule is uncertain.
//// Nothing here decides one.
////
//// Not ported yet: the reviewer routes (`/ts/…`) that start, resolve, cancel or supersede an item, and compliance
//// contexts' reviews.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/approach_policy.{type Reason}
import scoutbox/messaging/notifications
import scoutbox/platform/effect
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/regulatory_review_history as event_row
import scoutbox/rows/regulatory_review_reasons as reason_row
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/vocab/agent_facet.{type AgentFacet}
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind.{type ComplianceActorKind}
import scoutbox/vocab/context_outcome
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction.{type Jurisdiction}
import scoutbox/vocab/review_status
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
          jurisdiction: option.map(r.jurisdiction, jurisdiction.to_string),
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
