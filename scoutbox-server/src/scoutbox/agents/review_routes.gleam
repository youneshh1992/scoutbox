//// A review item's life in the reviewer lane (domains/agents/compliance/reviewRoutes.mjs): its detail, taking it,
//// cancelling it with a reason, and reconsidering a decided one. A final decision is never rewritten: a new review
//// supersedes it. The decision itself is `compliance_routes.resolve_review`.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_routes as compliance
import scoutbox/agents/compliance_store
import scoutbox/agents/context_view
import scoutbox/agents/reviews.{type Review}
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/rows/ts_reviewers as reviewer_row
import scoutbox/vocab/agent_facet
import scoutbox/vocab/agreement_status
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/party_role
import scoutbox/vocab/review_status
import wisp.{type Request, type Response}

fn acting(r: reviewer_row.Row) -> reviews.Reviewer {
  reviews.Reviewer(id.reviewer_to_string(r.id), r.name, r.role)
}

fn found_review(
  ctx: Ctx,
  review_id: String,
  next: fn(Review) -> Response,
) -> Response {
  use found <- compliance.reading(ctx, reviews.by_id(
    _,
    id.regulatory_review(review_id),
  ))
  case found {
    Some(rv) -> next(rv)
    None -> compliance.bare("REVIEW_NOT_FOUND", [])
  }
}

fn rev_of(rv: Review) -> rev.Rev {
  rev.Rev(rv.row.rev, rv.row.rev_at, rv.row.rev_by_name)
}

fn current(rv: Review) -> List(#(String, Json)) {
  [
    #(
      "current",
      json.object([#("status", review_status.to_json(rv.row.status))]),
    ),
  ]
}

fn answer(
  ctx: Ctx,
  status: Int,
  review_id: id.RegulatoryReviewId,
  extra: fn(Read) -> Result(List(#(String, Json)), Fail(e)),
) -> Response {
  use body <- compliance.reading(ctx, fn(r) {
    use found <- result.try(reviews.by_id(r, review_id))
    let assert Some(rv) = found as "the review acted on"
    use view <- result.try(compliance.reviewer_view(r, rv))
    use more <- result.map(extra(r))
    [#("review", view), ..more]
  })
  http.json(status, json.object(body))
}

// ------------------------------------------------------------------------------------------------- detail

/// States and ids, no client data beyond the review's need (`reviewSubjectDetail`).
fn subject_detail(read: Read, rv: Review, now: Int) -> Result(Json, Fail(e)) {
  let r = rv.row
  case r.kind {
    review_row.VerificationFacet ->
      case r.subject_profile_id, r.subject_facet {
        Some(pid), Some(facet) -> {
          use p <- result.map(agent_store.profile_by_id(read, pid))
          let ma =
            option.then(r.subject_member_association, fn(m) {
              jurisdiction.from_string(m) |> option.from_result
            })
          let rec = option.then(p, agent_rules.facet_of(_, facet, ma))
          json.object([
            #(
              "agentDisplayName",
              json.nullable(
                option.map(p, fn(p) { p.row.display_name }),
                json.string,
              ),
            ),
            #("facet", agent_facet.to_json(facet)),
            #(
              "memberAssociation",
              json.nullable(r.subject_member_association, json.string),
            ),
            #(
              "reference",
              json.nullable(
                option.then(rec, fn(f) { f.reference }),
                json.string,
              ),
            ),
            #("state", case rec {
              Some(f) ->
                facet_state.to_json(agent_rules.effective_facet_state(
                  Some(f),
                  now,
                ))
              None -> json.null()
            }),
            #(
              "submittedAt",
              json.nullable(
                option.then(rec, fn(f) { f.submitted_at }),
                json.int,
              ),
            ),
          ])
        }
        _, _ -> Ok(json.null())
      }
    review_row.RepresentationDispute ->
      case r.subject_agreement_id {
        None -> Ok(json.null())
        Some(aid) -> {
          use found <- result.map(agent_store.agreement_by_id(read, aid))
          case found {
            None -> json.null()
            Some(a) ->
              json.object([
                #("agreementId", id.agreement_json(a.row.id)),
                #(
                  "status",
                  agreement_status.to_json(agent_rules.effective_status(
                    a.row,
                    now,
                  )),
                ),
                #("disputedAt", json.nullable(a.row.disputed_at, json.int)),
                #(
                  "hadReason",
                  json.bool(case a.row.dispute_reason {
                    Some("") | None -> False
                    Some(_) -> True
                  }),
                ),
                #("scope", json.array(a.scope, scope_row.scope_to_json)),
                #("jurisdiction", jurisdiction.to_json(a.row.jurisdiction)),
              ])
          }
        }
      }
    _ ->
      case r.subject_context_id {
        None -> Ok(json.null())
        Some(cid) -> {
          use found <- result.try(compliance_store.by_id(
            read,
            id.compliance_context(cid),
          ))
          case found {
            None -> Ok(json.null())
            Some(c) -> {
              use #(last, _) <- result.map(context_view.latest(read, c.row.id))
              json.object([
                #("contextId", id.compliance_context_json(c.row.id)),
                #("type", context_type.to_json(c.row.type_)),
                #("jurisdictions", json.array(c.jurisdictions, json.string)),
                #(
                  "partyRoles",
                  json.array(
                    list.filter(c.parties, fn(p) { !p.removed }),
                    fn(p) { party_role.to_json(p.party_role) },
                  ),
                ),
                #(
                  "representations",
                  json.array(c.representations, fn(x) {
                    json.object([
                      #("partyRole", party_role.to_json(x.party_role)),
                      #(
                        "status",
                        declared_representation_status.to_json(x.status),
                      ),
                    ])
                  }),
                ),
                #(
                  "lastOutcome",
                  json.nullable(
                    option.map(last, fn(e) { e.row.outcome }),
                    context_outcome.to_json,
                  ),
                ),
              ])
            }
          }
        }
      }
  }
}

/// `GET /ts/compliance/reviews/:id`.
pub fn detail(ctx: Ctx, review_id: String) -> Response {
  use rv <- found_review(ctx, review_id)
  let now = clock.now_ms()
  use body <- compliance.reading(ctx, fn(r) {
    use view <- result.try(compliance.reviewer_view(r, rv))
    use subject <- result.map(subject_detail(r, rv, now))
    json.object([#("review", view), #("subjectDetail", subject)])
  })
  http.json(200, body)
}

// ------------------------------------------------------------------------------------------------- acts

/// `POST /ts/compliance/reviews/:id/start`: the reviewer takes a pending item; taking your own again is idempotent.
pub fn start(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
  review_id: String,
) -> Response {
  use rv <- found_review(ctx, review_id)
  let shape = {
    use <- rev.fields
    input.done(Nil)
  }
  use _, raw <- compliance.body(req, shape, "REVIEW_INPUT_INVALID")
  let mine = rv.row.started_by_id == Some(id.reviewer_to_string(reviewer.id))
  case rv.row.status {
    review_status.InReview if mine -> {
      use view <- compliance.reading(ctx, compliance.reviewer_view(_, rv))
      http.json(
        200,
        json.object([#("review", view), #("idempotent", json.bool(True))]),
      )
    }
    review_status.Pending -> {
      use <- compliance.guard_rev(
        raw,
        rev_of(rv),
        "REVIEW_VERSION_CONFLICT",
        current(rv),
      )
      let now = clock.now_ms()
      let started =
        store.unit(ctx.store, fn(tx) {
          reviews.start(tx, rv, acting(reviewer), now)
        })
      case started {
        Ok(Nil) -> answer(ctx, 200, rv.row.id, fn(_) { Ok([]) })
        Error(store.Lost(what)) -> http.stale(what)
        Error(e) -> http.internal(e)
      }
    }
    status ->
      compliance.bare("REVIEW_NOT_PENDING", [
        #("status", review_status.to_json(status)),
      ])
  }
}

fn reason_required() -> Response {
  compliance.refusal("REVIEW_INPUT_INVALID", "A written reason is required.", [
    #("field", json.string("reason")),
    #("problem", json.string("required")),
  ])
}

fn closure_shape() -> input.Shape(Option(String)) {
  use reason <- input.field("reason", input.nullish(input.text(400)))
  use <- rev.fields
  input.done(reason)
}

/// `POST /ts/compliance/reviews/:id/cancel`: an open item, with a written reason.
pub fn cancel(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
  review_id: String,
) -> Response {
  use rv <- found_review(ctx, review_id)
  case rv.row.status {
    review_status.Pending | review_status.InReview -> {
      use reason, raw <- compliance.body(
        req,
        closure_shape(),
        "REVIEW_INPUT_INVALID",
      )
      case input.filled(reason) {
        None -> reason_required()
        Some(reason) -> {
          use <- compliance.guard_rev(
            raw,
            rev_of(rv),
            "REVIEW_VERSION_CONFLICT",
            current(rv),
          )
          let now = clock.now_ms()
          let cancelled =
            store.unit(ctx.store, fn(tx) {
              reviews.cancel_decided(tx, rv, acting(reviewer), reason, now)
            })
          case cancelled {
            Ok(Nil) -> answer(ctx, 200, rv.row.id, fn(_) { Ok([]) })
            Error(store.Lost(what)) -> http.stale(what)
            Error(e) -> http.internal(e)
          }
        }
      }
    }
    status ->
      compliance.bare("REVIEW_NOT_PENDING", [
        #("status", review_status.to_json(status)),
      ])
  }
}

/// `POST /ts/compliance/reviews/:id/supersede`: a decided item is reconsidered by a new one under the policy in force.
pub fn supersede(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
  review_id: String,
) -> Response {
  use rv <- found_review(ctx, review_id)
  case rv.row.status, rv.superseded_by {
    review_status.Approved, None | review_status.Rejected, None -> {
      use reason, raw <- compliance.body(
        req,
        closure_shape(),
        "REVIEW_INPUT_INVALID",
      )
      case input.filled(reason) {
        None -> reason_required()
        Some(_) -> {
          use <- compliance.guard_rev(
            raw,
            rev_of(rv),
            "REVIEW_VERSION_CONFLICT",
            current(rv),
          )
          let now = clock.now_ms()
          let made =
            store.unit(ctx.store, fn(tx) {
              let read = store.reading(tx)
              use policies <- result.try(approach_policy.published(read))
              use mas <- result.try(case rv.row.subject_member_association {
                Some(ma) -> Ok([ma])
                None ->
                  case rv.row.subject_context_id {
                    Some(cid) ->
                      compliance_store.by_id(read, id.compliance_context(cid))
                      |> result.map(fn(c) {
                        option.map(c, fn(c) { c.jurisdictions })
                        |> option.unwrap([])
                      })
                    None -> Ok([])
                  }
              })
              let versions =
                approach_policy.applicable(policies, mas, now).policies
                |> list.map(approach_policy.policy_id)
              reviews.supersede(tx, rv, acting(reviewer), versions, now)
            })
          case made {
            Ok(new_id) ->
              answer(ctx, 201, new_id, fn(r) {
                use old <- result.try(reviews.by_id(r, rv.row.id))
                let assert Some(old) = old
                use view <- result.map(compliance.reviewer_view(r, old))
                [#("superseded", view)]
              })
            Error(store.Lost(what)) -> http.stale(what)
            Error(e) -> http.internal(e)
          }
        }
      }
    }
    review_status.Approved, Some(by) | review_status.Rejected, Some(by) ->
      compliance.bare("REVIEW_ALREADY_EXISTS", [
        #("reviewId", id.regulatory_review_json(by)),
      ])
    status, _ ->
      compliance.refusal(
        "REVIEW_NOT_PENDING",
        "Only a decided review can be superseded.",
        [#("status", review_status.to_json(status))],
      )
  }
}
