//// The recruitment journey projection for the club (domains/recruitment/lifecycle/journey.mjs and
//// journeyModel.mjs): one case's records arranged for its organisation, computed on read. There is no score,
//// probability or progress percentage: how far a case has travelled is a fact about a club's process, not a
//// measurement of a person.
////
//// Not ported yet: contacts, trials and signing packages (no route here records one, so they read as none), and
//// the player's, guardian's, agent's and Trust & Safety's projections.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/decisions
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/recruitment/offers
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/offer_history as event_row
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/signings as signing_row
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/offer_status
import scoutbox/vocab/party
import scoutbox/vocab/room_status.{type RoomStatus}

pub const policy_version = 1

const history_page_default = 50

const history_page_max = 200

// ---------------------------------------------------------------------------------------------------- facts

/// The case history detail fields the journey reads.
type Detail {
  Detail(
    to: Option(String),
    from: Option(String),
    status: Option(String),
    trigger: Option(String),
    reason_codes: List(String),
    contact_id: Option(String),
    trial_id: Option(String),
    request_id: Option(String),
    decision_id: Option(String),
    offer_id: Option(String),
    signing_package_id: Option(String),
    handoff_id: Option(String),
    represented: Option(Bool),
  )
}

fn detail_of(h: history_row.Row) -> Detail {
  let decoder = {
    use to <- decode.optional_field("to", None, decode.optional(decode.string))
    use from <- decode.optional_field(
      "from",
      None,
      decode.optional(decode.string),
    )
    use status <- decode.optional_field(
      "status",
      None,
      decode.optional(decode.string),
    )
    use trigger <- decode.optional_field(
      "trigger",
      None,
      decode.optional(decode.string),
    )
    use reason_codes <- decode.optional_field(
      "reasonCodes",
      [],
      decode.one_of(decode.list(decode.string), [decode.success([])]),
    )
    use contact_id <- decode.optional_field(
      "contactId",
      None,
      decode.optional(decode.string),
    )
    use trial_id <- decode.optional_field(
      "trialId",
      None,
      decode.optional(decode.string),
    )
    use request_id <- decode.optional_field(
      "requestId",
      None,
      decode.optional(decode.string),
    )
    use decision_id <- decode.optional_field(
      "decisionId",
      None,
      decode.optional(decode.string),
    )
    use offer_id <- decode.optional_field(
      "offerId",
      None,
      decode.optional(decode.string),
    )
    use signing_package_id <- decode.optional_field(
      "signingPackageId",
      None,
      decode.optional(decode.string),
    )
    use handoff_id <- decode.optional_field(
      "handoffId",
      None,
      decode.optional(decode.string),
    )
    use represented <- decode.optional_field(
      "represented",
      None,
      decode.optional(decode.bool),
    )
    decode.success(Detail(
      to:,
      from:,
      status:,
      trigger:,
      reason_codes:,
      contact_id:,
      trial_id:,
      request_id:,
      decision_id:,
      offer_id:,
      signing_package_id:,
      handoff_id:,
      represented:,
    ))
  }
  h.detail_json
  |> option.then(fn(t) { json.parse(t, decoder) |> option.from_result })
  |> option.unwrap(Detail(
    None,
    None,
    None,
    None,
    [],
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
  ))
}

/// Everything the projection reads, once.
type Records {
  Records(
    room: Room,
    decisions: List(decisions.Decision),
    draft: Option(decisions.Draft),
    assessments: List(assessment_row.Row),
    offers: List(Offer),
    signings: List(signing_row.Row),
    requests: List(request_row.Row),
    blocked: Bool,
    player_present: Bool,
  )
}

/// The viewer: the organisation's staff member and their role in the Room.
pub type Viewer {
  Viewer(grassroots: Bool, role: Option(RoomRole))
}

pub type Paging {
  Paging(limit: Option(String), cursor: Option(String))
}

/// The club's journey for a Room the route has already found and authorised.
pub fn build(
  read: Read,
  room: Room,
  viewer: Viewer,
  paging: Paging,
  blocked: Bool,
  player_present: Bool,
  now: Int,
) -> Result(Json, Fail(e)) {
  let r = room.row
  use all <- result.try(decisions.all(read, r.id))
  use draft <- result.try(decisions.draft(read, r.id))
  use assessments <- result.try(store.query(
    read,
    "SELECT "
      <> assessment_row.columns
      <> " FROM assessments WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(r.org_id), id.player_sql(r.player_id)],
    assessment_row.decoder(),
  ))
  use case_offers <- result.try(offers.for_case(read, r.id))
  use signings <- result.try(store.query(
    read,
    "SELECT "
      <> signing_row.columns
      <> " FROM signings WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(r.org_id), id.player_sql(r.player_id)],
    signing_row.decoder(),
  ))
  use requests <- result.try(store.query(
    read,
    "SELECT "
      <> request_row.columns
      <> " FROM recruitment_requests WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(r.org_id), id.player_sql(r.player_id)],
    request_row.decoder(),
  ))
  let rec =
    Records(
      room:,
      decisions: list.filter(all, fn(d) { d.base.row.org_id == r.org_id }),
      draft:,
      assessments:,
      offers: list.filter(case_offers, fn(o) { o.row.org_id == r.org_id }),
      signings:,
      requests:,
      blocked:,
      player_present:,
    )
  use actions <- result.map(case_lifecycle.available(
    read,
    room,
    viewer.role,
    now,
  ))
  club(rec, viewer, paging, actions, now)
}

// --------------------------------------------------------------------------------------------- projection

type DecisionLine {
  DecisionLine(
    id: id.RoomDecisionId,
    recommendation: decision_row.Recommendation,
    reason_codes: List(String),
    at: Int,
    by: Option(String),
    superseded_by: Option(id.RoomDecisionId),
    has_note: Bool,
    formal: Bool,
    outcome: Option(Json),
    evidence_count: Int,
  )
}

fn decision_line(d: decisions.Decision) -> DecisionLine {
  let r = d.base.row
  let formal = decisions.is_formal(d)
  DecisionLine(
    id: r.id,
    recommendation: r.recommendation,
    reason_codes: d.base.reason_codes,
    at: r.created_at,
    by: r.by_name,
    superseded_by: r.superseded_by_id,
    has_note: option.is_some(r.note) && r.note != Some(""),
    formal:,
    outcome: case formal {
      True -> option.map(r.outcome, decision_outcome.to_json)
      False -> None
    },
    evidence_count: case formal {
      True -> list.length(d.refs)
      False -> 0
    },
  )
}

fn decision_line_json(d: DecisionLine) -> Json {
  json.object([
    #("id", id.room_decision_json(d.id)),
    #("recommendation", decision_row.recommendation_to_json(d.recommendation)),
    #("reasonCodes", json.array(d.reason_codes, json.string)),
    #("at", json.int(d.at)),
    #("by", json.nullable(d.by, json.string)),
    #("supersededById", json.nullable(d.superseded_by, id.room_decision_json)),
    #("hasNote", json.bool(d.has_note)),
    #(
      "kind",
      json.string(case d.formal {
        True -> "formal"
        False -> "recommendation"
      }),
    ),
    #("outcome", option.unwrap(d.outcome, json.null())),
    #("evidenceCount", json.int(d.evidence_count)),
  ])
}

fn club(
  rec: Records,
  viewer: Viewer,
  paging: Paging,
  actions: List(String),
  now: Int,
) -> Json {
  let room = rec.room
  let r = room.row
  let status = room.status
  let lines = list.map(rec.decisions, decision_line)
  let current =
    lines
    |> list.filter(fn(d) { d.superseded_by == None })
    |> list.last
    |> option.from_result
  let current_formal = case current {
    Some(d) if d.formal -> Some(d)
    _ -> None
  }
  let sound_offers =
    list.filter(rec.offers, fn(o) {
      o.row.player_id == r.player_id
      && offer_rules.integrity(o, Some(r.org_id), Some(r.id)) == []
    })
  let listed_offers =
    list.filter(sound_offers, fn(o) {
      !offer_rules.case_corrupt(offer_rules.case_consistency(
        o,
        Some(status),
        now,
      ))
    })
  let corrupt_offers =
    list.count(rec.offers, fn(o) {
      offer_rules.integrity(o, Some(r.org_id), Some(r.id)) != []
    })
  let trial_requests =
    list.filter(rec.requests, fn(q) {
      q.type_ == request_row.Trial && q.case_id == Some(r.id)
    })
  let signing = supporting_signing(rec)
  let assessed =
    list.any(rec.assessments, fn(a) { a.state != assessment_row.Draft })
  let total_history = timeline(rec, lines, trial_requests, sound_offers, now)
  let limit =
    paging.limit
    |> option.then(fn(t) { int.parse(t) |> option.from_result })
    |> option.unwrap(history_page_default)
    |> fn(n) {
      case n {
        0 -> history_page_default
        n -> int.clamp(n, 1, history_page_max)
      }
    }
  let cursor =
    paging.cursor
    |> option.then(fn(t) { int.parse(t) |> option.from_result })
    |> option.unwrap(0)
    |> int.max(0)
  let page = total_history |> list.drop(cursor) |> list.take(limit)
  let total = list.length(total_history)
  let offer_awaiting =
    list.any(listed_offers, fn(o) {
      offer_rules.live_status(o, now) == Some(offer_status.Issued)
    })
  let terminal = list.contains(room_rules.terminal, status)
  let reopenable = list.contains(room_rules.reopened_from, status)
  json.object([
    #("ok", json.bool(True)),
    #(
      "viewer",
      json.string(case viewer.grassroots {
        True -> "grassroots_staff"
        False -> "org_staff"
      }),
    ),
    #(
      "case",
      json.object([
        #("id", id.recruitment_case_json(r.id)),
        #("orgId", id.org_json(r.org_id)),
        #("playerId", id.player_json(r.player_id)),
        #("priority", case_row.room_priority_to_json(room.priority)),
        #(
          "leadScoutUserId",
          json.nullable(r.room_lead_scout_user_id, id.org_user_json),
        ),
        #("createdAt", json.int(r.created_at)),
        #("rev", json.int(room.rev)),
      ]),
    ),
    #(
      "lifecycle",
      json.object([
        #("currentStage", room_status.to_json(status)),
        #("label", json.string(room_rules.status_label(status))),
        #("stage", case_row.stage_to_json(r.stage)),
        #("terminal", json.bool(terminal)),
        #("reopenable", json.bool(reopenable)),
        #(
          "allowedNext",
          json.array(room_rules.transitions(status), room_status.to_json),
        ),
        #("policyVersion", json.int(lifecycle.policy_version)),
      ]),
    ),
    #(
      "conditions",
      json.object([
        #(
          "decisionPending",
          json.bool(status == room_status.TrialCompleted && current == None),
        ),
        // Not ported yet: trials, so no trial is awaiting its report.
        #("trialActive", json.bool(False)),
        #(
          "offerAwaitingResponse",
          json.bool(status == room_status.OfferMade && offer_awaiting),
        ),
        #("onHold", json.bool(status == room_status.OnHold)),
        #("terminal", json.bool(terminal)),
        #("reopenable", json.bool(reopenable)),
        #(
          "decisionOutstanding",
          json.bool(!terminal && current_formal == None && assessed),
        ),
        #("hasFormalDecision", json.bool(current_formal != None)),
      ]),
    ),
    #("nextActions", json.array(actions, json.string)),
    #(
      "journey",
      journey_block(
        rec,
        viewer,
        status,
        sound_offers,
        trial_requests,
        signing,
        corrupt_offers,
        assessed,
        now,
      ),
    ),
    #(
      "contact",
      json.object([
        #(
          "records",
          json.array(rec.requests, fn(q) {
            json.object([
              #("id", id.request_json(q.id)),
              #("type", request_row.type_to_json(q.type_)),
              #("status", request_row.status_to_json(q.status)),
              #("routedTo", party.to_json(q.routed_to)),
              #("createdAt", json.int(q.created_at)),
            ])
          }),
        ),
        // Not ported yet: Contact records.
        #("contacts", json.preprocessed_array([])),
        #("omitted", json.int(0)),
      ]),
    ),
    // Not ported yet: Trials.
    #("trials", json.preprocessed_array([])),
    #("trialsOmitted", json.int(0)),
    #(
      "assessments",
      json.array(rec.assessments, fn(a) {
        json.object([
          #("id", id.assessment_json(a.id)),
          #("state", assessment_row.state_to_json(a.state)),
          #("at", json.int(option.unwrap(a.submitted_at, a.created_at))),
        ])
      }),
    ),
    #(
      "decisions",
      json.object([
        #("all", json.array(lines, decision_line_json)),
        #("current", json.nullable(current, decision_line_json)),
        #("formal", json.nullable(current_formal, decision_line_json)),
        #("draft", case rec.draft {
          Some(dr) ->
            json.object([
              #("id", id.decision_draft_json(dr.row.id)),
              #(
                "outcome",
                json.nullable(dr.row.outcome, decision_outcome.to_json),
              ),
              #("by", json.nullable(dr.row.by_name, json.string)),
              #("updatedAt", json.int(dr.row.updated_at)),
            ])
          None -> json.null()
        }),
      ]),
    ),
    #(
      "offer",
      json.object([
        #("available", json.bool(True)),
        #(
          "records",
          json.array(listed_offers, fn(o) {
            json.object([
              #("id", id.offer_json(o.row.id)),
              #("type", json.string("direct_recruitment")),
              #(
                "status",
                json.nullable(offer_rules.status(o, now), offer_status.to_json),
              ),
              #(
                "liveStatus",
                json.nullable(
                  offer_rules.live_status(o, now),
                  offer_status.to_json,
                ),
              ),
            ])
          }),
        ),
      ]),
    ),
    #(
      "outcome",
      json.object([
        #("available", json.bool(True)),
        #("signing", case signing {
          Some(s) ->
            json.object([
              #("id", id.signing_json(s.id)),
              #("at", json.int(s.ts)),
              #("method", signing_row.method_to_json(s.method)),
              #(
                "signingPackageId",
                json.nullable(s.signing_package_id, json.string),
              ),
            ])
          None -> json.null()
        }),
        // Not ported yet: signing packages.
        #("signingPackages", json.preprocessed_array([])),
      ]),
    ),
    #(
      "history",
      json.object([
        #("entries", json.preprocessed_array(page)),
        #("total", json.int(total)),
        #("cursor", json.int(cursor)),
        #("nextCursor", case cursor + list.length(page) < total {
          True -> json.int(cursor + list.length(page))
          False -> json.null()
        }),
      ]),
    ),
    #("generatedAt", json.int(now)),
  ])
}

/// The club's un-packaged signing row for this player. Not ported yet: a completed package naming its row.
fn supporting_signing(rec: Records) -> Option(signing_row.Row) {
  list.find(rec.signings, fn(s) { s.signing_package_id == None })
  |> option.from_result
}

fn stage_of(status: RoomStatus, assessed: Bool) -> String {
  case status {
    room_status.Watching -> "watching"
    room_status.UnderReview | room_status.Shortlisted | room_status.Priority ->
      "review"
    room_status.ContactPlanned | room_status.Contacted -> "contact"
    room_status.TrialRequested | room_status.TrialScheduled -> "trial"
    room_status.TrialCompleted ->
      case assessed {
        True -> "decision"
        False -> "assessment"
      }
    room_status.OfferConsideration
    | room_status.OfferMade
    | room_status.OfferDeclined -> "offer"
    // Not ported yet: a signing package opened over the acceptance (`signing`).
    room_status.OfferAccepted -> "acceptance"
    room_status.Signed -> "signed"
    room_status.OnHold -> "paused"
    room_status.Withdrawn | room_status.Archived | room_status.Closed -> "ended"
  }
}

/// The first instant the history reached one of `statuses`.
fn first_reach(room: Room, statuses: List(String)) -> Option(Int) {
  list.fold(room.history, None, fn(best, h) {
    let d = detail_of(h)
    let to = case h.action {
      "room_created" -> d.status
      "room_status_changed" -> d.to
      _ -> None
    }
    case to {
      Some(t) ->
        case list.contains(statuses, t), best {
          False, _ -> best
          True, None -> Some(h.at)
          True, Some(b) -> Some(int.min(b, h.at))
        }
      None -> best
    }
  })
}

fn newest(rows: List(a), at: fn(a) -> Int, key: fn(a) -> String) -> Option(a) {
  rows
  |> list.sort(fn(a, b) {
    case int.compare(at(b), at(a)) {
      order.Eq -> string.compare(key(b), key(a))
      other -> other
    }
  })
  |> list.first
  |> option.from_result
}

type CurrentOffer {
  CurrentOffer(offer: Offer, revision: Option(offer_rules.Revision))
}

/// The current Offer: a live one, then the newest accepted, then the newest of any status.
fn current_offer(offers: List(Offer), now: Int) -> Option(CurrentOffer) {
  let at = fn(o: Offer) { o.row.updated_at }
  let key = fn(o: Offer) { id.offer_to_string(o.row.id) }
  let tier = fn(pred) { newest(list.filter(offers, pred), at, key) }
  let st = fn(o) { offer_rules.status(o, now) }
  let found =
    tier(fn(o) {
      st(o) == Some(offer_status.Draft) || st(o) == Some(offer_status.Issued)
    })
    |> option.lazy_or(fn() {
      tier(fn(o) { st(o) == Some(offer_status.Accepted) })
    })
    |> option.lazy_or(fn() { tier(fn(_) { True }) })
  use o <- option.map(found)
  CurrentOffer(
    o,
    offer_rules.live_revision(o) |> option.or(offer_rules.current_revision(o)),
  )
}

fn ids(values: List(String)) -> Json {
  json.array(values, json.string)
}

fn journey_block(
  rec: Records,
  viewer: Viewer,
  status: RoomStatus,
  offers: List(Offer),
  trial_requests: List(request_row.Row),
  signing: Option(signing_row.Row),
  corrupt: Int,
  assessed: Bool,
  now: Int,
) -> Json {
  let room = rec.room
  let r = room.row
  let case_decisions =
    list.filter(rec.decisions, fn(d) { d.base.row.room_id == r.id })
  let pending_trial_request =
    trial_requests
    |> list.filter(fn(q) {
      q.status == request_row.Pending && q.subject_removed_at == None
    })
    |> newest(fn(q) { q.created_at }, fn(q) { id.request_to_string(q.id) })
  let current_assessment =
    newest(
      list.filter(rec.assessments, fn(a) { a.state != assessment_row.Draft }),
      fn(a) { option.unwrap(a.submitted_at, a.created_at) },
      fn(a) { id.assessment_to_string(a.id) },
    )
    |> option.lazy_or(fn() {
      newest(
        list.filter(rec.assessments, fn(a) { a.state == assessment_row.Draft }),
        fn(a) { a.created_at },
        fn(a) { id.assessment_to_string(a.id) },
      )
    })
  let head = current_decision(case_decisions)
  let decision = case head {
    Some(d) if d.base.row.kind == Some(decision_row.Formal) -> Some(d)
    _ -> None
  }
  let offer = current_offer(offers, now)
  let subject_removed = r.subject_removed_at != None || !rec.player_present
  let problems =
    validate(
      rec,
      status,
      offers,
      trial_requests,
      case_decisions,
      signing,
      corrupt,
      now,
    )
  let classification = problems.0
  let next =
    next_action(
      status,
      viewer.role,
      rec.blocked,
      subject_removed,
      pending_trial_request,
      assessed,
      decision,
      offer,
      signing,
      classification == "integrity_error",
      now,
    )
  json.object([
    #("policyVersion", json.int(policy_version)),
    #("stage", json.string(stage_of(status, assessed))),
    #(
      "completedStages",
      json.preprocessed_array(completed_stages(
        rec,
        status,
        offers,
        case_decisions,
        signing,
        now,
      )),
    ),
    #(
      "resources",
      json.object([
        #("contactId", json.null()),
        #(
          "trialRequestId",
          json.nullable(
            option.map(pending_trial_request, fn(q) { q.id }),
            id.request_json,
          ),
        ),
        #("trialId", json.null()),
        #(
          "assessmentId",
          json.nullable(
            option.map(current_assessment, fn(a) { a.id }),
            id.assessment_json,
          ),
        ),
        #(
          "decisionId",
          json.nullable(
            option.map(decision, fn(d) { d.base.row.id }),
            id.room_decision_json,
          ),
        ),
        #(
          "offerId",
          json.nullable(
            option.map(offer, fn(o) { o.offer.row.id }),
            id.offer_json,
          ),
        ),
        #(
          "offerRevisionId",
          json.nullable(
            option.then(offer, fn(o) {
              option.map(o.revision, fn(v) { v.row.id })
            }),
            id.offer_revision_json,
          ),
        ),
        #("signingPackageId", json.null()),
        #(
          "completedSigningId",
          json.nullable(option.map(signing, fn(s) { s.id }), id.signing_json),
        ),
      ]),
    ),
    #("nextAction", next),
    #("classification", json.string(classification)),
    #("integrity", ids(problems.1)),
    #("blocked", json.bool(rec.blocked)),
    #("subjectRemoved", json.bool(subject_removed)),
  ])
}

/// The formal chain head, else the advisory head. Never a draft.
fn current_decision(
  rows: List(decisions.Decision),
) -> Option(decisions.Decision) {
  let live =
    list.filter(rows, fn(d) {
      d.base.row.superseded_by_id == None
      && d.base.row.state != Some(decision_row.Draft)
    })
  let oldest_last = fn(a: decisions.Decision, b: decisions.Decision) {
    case int.compare(a.base.row.created_at, b.base.row.created_at) {
      order.Eq ->
        string.compare(
          id.room_decision_to_string(a.base.row.id),
          id.room_decision_to_string(b.base.row.id),
        )
      other -> other
    }
  }
  let formal =
    list.filter(live, decisions.is_formal)
    |> list.sort(oldest_last)
    |> list.last
  case formal {
    Ok(d) -> Some(d)
    Error(Nil) ->
      list.filter(live, fn(d) { !decisions.is_formal(d) })
      |> list.sort(oldest_last)
      |> list.last
      |> option.from_result
  }
}

fn stage_json(
  stage: String,
  basis: String,
  at: Option(Int),
  refs: List(#(String, Json)),
) -> Json {
  json.object([
    #("stage", json.string(stage)),
    #("basis", json.string(basis)),
    #(
      "at",
      json.nullable(
        option.then(at, fn(a) {
          case a > 0 {
            True -> Some(a)
            False -> None
          }
        }),
        json.int,
      ),
    ),
    ..refs
  ])
}

fn completed_stages(
  rec: Records,
  status: RoomStatus,
  offers: List(Offer),
  case_decisions: List(decisions.Decision),
  signing: Option(signing_row.Row),
  now: Int,
) -> List(Json) {
  let room = rec.room
  let all = list.map(room_rules.statuses(), room_status.to_string)
  let opened = first_reach(room, all) |> option.or(Some(room.row.created_at))
  let review_statuses =
    room_rules.statuses()
    |> list.filter(fn(s) {
      s != room_status.Watching
      && s != room_status.OnHold
      && !list.contains(room_rules.terminal, s)
    })
    |> list.map(room_status.to_string)
  let lifecycle_only = fn(stage, statuses) {
    case first_reach(room, statuses) {
      Some(at) -> [stage_json(stage, "lifecycle", Some(at), [])]
      None -> []
    }
  }
  let assessed =
    newest(
      list.filter(rec.assessments, fn(a) { a.state != assessment_row.Draft }),
      fn(a) { option.unwrap(a.submitted_at, a.created_at) },
      fn(a) { id.assessment_to_string(a.id) },
    )
  let decided =
    newest(
      list.filter(case_decisions, fn(d) {
        decisions.is_formal(d)
        && d.base.row.state != Some(decision_row.Draft)
        && d.base.row.superseded_by_id == None
      }),
      fn(d) { d.base.row.created_at },
      fn(d) { id.room_decision_to_string(d.base.row.id) },
    )
  let issued =
    list.filter_map(offers, fn(o) {
      case offer_rules.live_revision(o) {
        Some(rv) -> Ok(#(o, rv))
        None -> Error(Nil)
      }
    })
  let first_issued =
    issued
    |> list.sort(fn(a, b) {
      int.compare(
        option.unwrap({ a.1 }.row.issued_at, 0),
        option.unwrap({ b.1 }.row.issued_at, 0),
      )
    })
    |> list.first
  let accepted =
    issued
    |> list.filter(fn(x) {
      offer_rules.effective({ x.1 }.row, now) == offer_status.Accepted
    })
    |> list.sort(fn(a, b) {
      int.compare(
        option.unwrap({ a.1 }.row.responded_at, 0),
        option.unwrap({ b.1 }.row.responded_at, 0),
      )
    })
    |> list.first
  let offer_refs = fn(x: #(Offer, offer_rules.Revision)) {
    [
      #("offerId", id.offer_json({ x.0 }.row.id)),
      #("offerRevisionId", id.offer_revision_json({ x.1 }.row.id)),
    ]
  }
  list.flatten([
    [stage_json("watching", "lifecycle", opened, [])],
    lifecycle_only("review", review_statuses),
    // Not ported yet: Contact records, so contact is the lifecycle's word alone.
    lifecycle_only("contact", ["contacted"]),
    // Not ported yet: Trials.
    lifecycle_only("trial", ["trial_completed"]),
    case assessed {
      Some(a) -> [
        stage_json(
          "assessment",
          "canonical",
          Some(option.unwrap(a.submitted_at, a.created_at)),
          [
            #("assessmentId", id.assessment_json(a.id)),
          ],
        ),
      ]
      None -> []
    },
    case decided {
      Some(d) -> [
        stage_json("decision", "canonical", Some(d.base.row.created_at), [
          #("decisionId", id.room_decision_json(d.base.row.id)),
        ]),
      ]
      None -> lifecycle_only("decision", ["offer_consideration"])
    },
    case first_issued {
      Ok(x) -> [
        stage_json("offer", "canonical", { x.1 }.row.issued_at, offer_refs(x)),
      ]
      Error(Nil) -> lifecycle_only("offer", ["offer_made"])
    },
    case accepted {
      Ok(x) -> [
        stage_json(
          "acceptance",
          "canonical",
          { x.1 }.row.responded_at,
          offer_refs(x),
        ),
      ]
      Error(Nil) -> lifecycle_only("acceptance", ["offer_accepted"])
    },
    case first_reach(room, ["signed"]), status == room_status.Signed {
      None, False -> []
      at, _ ->
        case signing {
          Some(s) -> [
            stage_json("signed", "canonical", at |> option.or(Some(s.ts)), [
              #("completedSigningId", id.signing_json(s.id)),
            ]),
          ]
          None -> [stage_json("signed", "lifecycle", at, [])]
        }
    },
  ])
}

/// Detects, never repairs, impossible combinations of lifecycle and records (validateRecruitmentJourney):
/// the classification and the problems, sorted.
fn validate(
  rec: Records,
  status: RoomStatus,
  offers: List(Offer),
  trial_requests: List(request_row.Row),
  case_decisions: List(decisions.Decision),
  signing: Option(signing_row.Row),
  corrupt: Int,
  now: Int,
) -> #(String, List(String)) {
  let room = rec.room
  let request_ids =
    list.map(trial_requests, fn(q) { id.request_to_string(q.id) })
  let decision_ids =
    list.map(case_decisions, fn(d) { id.room_decision_to_string(d.base.row.id) })
  let offer_ids = list.map(offers, fn(o) { id.offer_to_string(o.row.id) })
  let stale = fn(value: Option(String), known: List(String)) {
    case value {
      Some(v) -> !list.contains(known, v)
      None -> False
    }
  }
  let tracked = [
    "contacted", "trial_requested", "trial_scheduled", "trial_completed",
    "offer_consideration", "offer_made", "offer_accepted", "offer_declined",
    "signed",
  ]
  let #(reached, history_problems) =
    list.fold(
      room.history,
      #([], []),
      fn(acc: #(List(#(String, Bool)), List(String)), h) {
        let #(reached, problems) = acc
        case h.action {
          "room_status_changed" -> {
            let d = detail_of(h)
            let claimed =
              option.is_some(d.contact_id)
              || option.is_some(d.trial_id)
              || option.is_some(d.request_id)
              || option.is_some(d.decision_id)
              || option.is_some(d.offer_id)
              || option.is_some(d.signing_package_id)
              || case d.trigger {
                Some(t) ->
                  list.any(
                    ["contact:", "trial:", "offer:", "signing:", "decision:"],
                    fn(p) { string.starts_with(t, p) },
                  )
                None -> False
              }
            let reached = case d.to {
              Some(to) ->
                case list.contains(tracked, to) {
                  True -> [
                    #(to, claimed),
                    ..list.filter(reached, fn(x) { x.0 != to })
                  ]
                  False -> reached
                }
              None -> reached
            }
            let problems = case
              option.is_some(d.contact_id)
              || option.is_some(d.trial_id)
              || stale(d.request_id, request_ids)
              || stale(d.decision_id, decision_ids)
              || stale(d.offer_id, offer_ids)
              || option.is_some(d.signing_package_id)
            {
              True -> ["STALE_POINTER", ..problems]
              False -> problems
            }
            #(reached, problems)
          }
          _ -> acc
        }
      },
    )
  let signing_ids = list.map(rec.signings, fn(s) { id.signing_to_string(s.id) })
  let live_with = fn(want) {
    list.any(offers, fn(o) {
      case offer_rules.live_revision(o) {
        Some(rv) -> offer_rules.effective(rv.row, now) == want
        None -> False
      }
    })
  }
  let evidence = [
    #("contacted", False),
    #("trial_requested", trial_requests != []),
    #("trial_scheduled", False),
    #("trial_completed", False),
    #(
      "offer_consideration",
      list.any(case_decisions, fn(d) {
        decisions.is_formal(d)
        && d.base.row.state != Some(decision_row.Draft)
        && d.base.row.outcome == Some(decision_outcome.Progress)
      }),
    ),
    #(
      "offer_made",
      list.any(offers, fn(o) { offer_rules.live_revision(o) != None }),
    ),
    #("offer_accepted", live_with(offer_status.Accepted)),
    #("offer_declined", live_with(offer_status.Declined)),
    #("signed", option.is_some(signing)),
  ]
  let proved = fn(state) { list.key_find(evidence, state) == Ok(True) }
  let #(backed, unbacked, ahead_claims) =
    list.fold(reached, #(0, 0, False), fn(acc, x) {
      let #(b, u, claims) = acc
      case proved(x.0), x.1 {
        True, _ -> #(b + 1, u, claims)
        False, True -> #(b, u, True)
        False, False -> #(b, u + 1, claims)
      }
    })
  let current = room_status.to_string(status)
  let unbacked = case
    list.key_find(evidence, current),
    list.any(reached, fn(x) { x.0 == current })
  {
    Ok(False), False -> unbacked + 1
    _, _ -> unbacked
  }
  let live =
    !list.contains(room_rules.terminal, status) && status != room_status.OnHold
  let ahead =
    live
    && list.any(
      [
        "contacted",
        "trial_scheduled",
        "trial_completed",
        "offer_made",
        "offer_accepted",
      ],
      fn(s) {
        proved(s) && !list.any(reached, fn(x) { x.0 == s }) && current != s
      },
    )
  let domain =
    list.flat_map(offers, fn(o) {
      offer_rules.case_consistency(o, Some(status), now)
      |> list.filter(fn(c) { offer_rules.case_corrupt([c]) })
    })
  let problems =
    list.flatten([
      history_problems,
      case ahead_claims {
        True -> ["LIFECYCLE_AHEAD_OF_EVIDENCE"]
        False -> []
      },
      case corrupt > 0 {
        True -> ["RECORD_CORRUPT"]
        False -> []
      },
      case room.row.links_signing_id {
        Some(s) if s != "" ->
          case list.contains(signing_ids, s) {
            True -> []
            False -> ["STALE_POINTER"]
          }
        _ -> []
      },
      case option.is_some(signing) && status != room_status.Signed && live {
        True -> ["LIFECYCLE_BEHIND_TERMINAL_EVIDENCE"]
        False -> []
      },
      case ahead {
        True -> ["EVIDENCE_AHEAD_OF_LIFECYCLE"]
        False -> []
      },
      domain,
    ])
    |> list.unique
    |> list.sort(string.compare)
  let classification = case problems, unbacked, backed {
    [_, ..], _, _ -> "integrity_error"
    [], 0, _ -> "canonical"
    [], _, 0 -> "legacy"
    [], _, _ -> "partially_canonical"
  }
  #(classification, problems)
}

// ------------------------------------------------------------------------------------------- next action

type Next {
  Next(
    code: String,
    stage: Option(String),
    kind: String,
    tab: String,
    action: Option(String),
    permission: Option(Int),
  )
}

fn next_def(code: String) -> Next {
  let club = fn(stage, tab, action) {
    Next(code, Some(stage), "club", tab, Some(action), None)
  }
  let club_permission = fn(stage, tab, rank) {
    Next(code, Some(stage), "club", tab, None, Some(rank))
  }
  let wait = fn(stage, tab) {
    Next(code, Some(stage), "await", tab, None, None)
  }
  case code {
    "REVIEW_PLAYER" -> club("watching", "overview", "startReview")
    "DECIDE_APPROACH" -> club("review", "overview", "planContact")
    "SEND_CONTACT" -> club_permission("contact", "contact", 2)
    "AWAIT_CONTACT_RESPONSE" -> wait("contact", "contact")
    "CONTINUE_EVALUATION" -> club("contact", "overview", "shortlist")
    "AWAIT_TRIAL_RESPONSE" -> wait("trial", "trial")
    "CONDUCT_TRIAL" -> club_permission("trial", "trial", 2)
    "COMPLETE_TRIAL" -> club_permission("trial", "trial", 2)
    "COMPLETE_ASSESSMENT" -> club_permission("assessment", "assessments", 1)
    "RECORD_DECISION" -> club_permission("decision", "decision", 2)
    "PREPARE_OFFER" -> club_permission("offer", "offer", 2)
    "ISSUE_OFFER" -> club_permission("offer", "offer", 2)
    "AWAIT_OFFER_RESPONSE" -> wait("offer", "offer")
    "REVISE_OR_WITHDRAW_OFFER" -> club_permission("offer", "offer", 2)
    "REVIEW_DECLINED_OFFER" -> club("offer", "offer", "considerOffer")
    "START_SIGNING" -> club_permission("acceptance", "signing", 2)
    "RECRUITMENT_COMPLETE" ->
      Next(code, Some("signed"), "none", "signing", None, None)
    "RESUME_CASE" -> club("paused", "overview", "resumeCase")
    "CASE_ENDED" -> Next(code, Some("ended"), "none", "overview", None, None)
    _ -> Next(code, None, "none", "overview", None, None)
  }
}

fn next_action(
  status: RoomStatus,
  role: Option(RoomRole),
  blocked: Bool,
  subject_removed: Bool,
  trial_request: Option(request_row.Row),
  assessed: Bool,
  decision: Option(decisions.Decision),
  offer: Option(CurrentOffer),
  signing: Option(signing_row.Row),
  integrity_error: Bool,
  now: Int,
) -> Json {
  let offer_ref = fn(o: CurrentOffer) {
    [
      #("offerId", id.offer_json(o.offer.row.id)),
      #(
        "offerRevisionId",
        json.nullable(
          option.map(o.revision, fn(r) { r.row.id }),
          id.offer_revision_json,
        ),
      ),
    ]
  }
  let decision_ref = #(
    "decisionId",
    json.nullable(
      option.map(decision, fn(d) { d.base.row.id }),
      id.room_decision_json,
    ),
  )
  let #(code, refs) = case status {
    room_status.Signed -> #("RECRUITMENT_COMPLETE", [
      #(
        "completedSigningId",
        json.nullable(option.map(signing, fn(s) { s.id }), id.signing_json),
      ),
      #("signingPackageId", json.null()),
    ])
    room_status.Withdrawn | room_status.Archived | room_status.Closed -> #(
      "CASE_ENDED",
      [],
    )
    room_status.OnHold -> #("RESUME_CASE", [])
    room_status.Watching -> #("REVIEW_PLAYER", [])
    room_status.UnderReview | room_status.Shortlisted | room_status.Priority ->
      case assessed && decision == None {
        True -> #("RECORD_DECISION", [])
        False -> #("DECIDE_APPROACH", [])
      }
    // Not ported yet: Contact records, so there is never a draft or delivered contact to name.
    room_status.ContactPlanned -> #("SEND_CONTACT", [
      #("contactId", json.null()),
    ])
    room_status.Contacted -> #("CONTINUE_EVALUATION", [
      #("contactId", json.null()),
    ])
    room_status.TrialRequested -> #("AWAIT_TRIAL_RESPONSE", [
      #(
        "trialRequestId",
        json.nullable(
          option.map(trial_request, fn(q) { q.id }),
          id.request_json,
        ),
      ),
    ])
    // Not ported yet: Trials.
    room_status.TrialScheduled -> #("CONDUCT_TRIAL", [#("trialId", json.null())])
    room_status.TrialCompleted ->
      case assessed, decision {
        False, _ -> #("COMPLETE_ASSESSMENT", [#("trialId", json.null())])
        True, None -> #("RECORD_DECISION", [#("trialId", json.null())])
        True, Some(_) -> #("RECORD_DECISION", [
          #("trialId", json.null()),
          decision_ref,
        ])
      }
    room_status.OfferConsideration ->
      case offer {
        Some(o) ->
          case o.revision {
            Some(_) ->
              case
                offer_rules.status(o.offer, now) == Some(offer_status.Draft)
              {
                True -> #("ISSUE_OFFER", offer_ref(o))
                False -> #("PREPARE_OFFER", [decision_ref])
              }
            None -> #("PREPARE_OFFER", [decision_ref])
          }
        None -> #("PREPARE_OFFER", [decision_ref])
      }
    room_status.OfferMade ->
      case offer {
        Some(o) ->
          case
            offer_rules.live_status(o.offer, now) == Some(offer_status.Issued)
          {
            True -> #("AWAIT_OFFER_RESPONSE", offer_ref(o))
            False -> #("REVISE_OR_WITHDRAW_OFFER", offer_ref(o))
          }
        None -> #("REVISE_OR_WITHDRAW_OFFER", [
          #("offerId", json.null()),
          #("offerRevisionId", json.null()),
        ])
      }
    room_status.OfferDeclined -> #("REVIEW_DECLINED_OFFER", [
      #(
        "offerId",
        json.nullable(
          option.map(offer, fn(o) { o.offer.row.id }),
          id.offer_json,
        ),
      ),
    ])
    // Not ported yet: signing packages, so an acceptance always waits for one to start.
    room_status.OfferAccepted -> #("START_SIGNING", case offer {
      Some(o) -> list.append(offer_ref(o), [#("signingPackageId", json.null())])
      None -> [
        #("offerId", json.null()),
        #("offerRevisionId", json.null()),
        #("signingPackageId", json.null()),
      ]
    })
  }
  let def = next_def(code)
  let club = def.kind == "club"
  let blocked_by =
    list.flatten([
      case club && blocked {
        True -> ["BLOCKED"]
        False -> []
      },
      case club && subject_removed {
        True -> ["SUBJECT_REMOVED"]
        False -> []
      },
      case club && integrity_error {
        True -> ["INTEGRITY_ERROR"]
        False -> []
      },
    ])
  let rank = case role {
    Some(r) -> room_rules.role_rank(r)
    None -> -1
  }
  let permitted = case club, def.action, def.permission {
    False, _, _ -> json.null()
    True, Some(name), _ ->
      json.bool(case case_lifecycle.action_named(name) {
        Some(a) -> case_lifecycle.permitted(a, role)
        None -> False
      })
    True, None, Some(min) -> json.bool(rank >= min)
    True, None, None -> json.bool(True)
  }
  json.object([
    #("code", json.string(code)),
    #("stage", json.nullable(def.stage, json.string)),
    #("kind", json.string(def.kind)),
    #("tab", json.string(def.tab)),
    #("lifecycleAction", json.nullable(def.action, json.string)),
    #("permitted", permitted),
    #("blockedBy", ids(blocked_by)),
    #("resources", json.object(refs)),
  ])
}

// --------------------------------------------------------------------------------------------------- timeline

type Line {
  Line(at: Int, key: String, fields: List(#(String, Json)))
}

fn timeline(
  rec: Records,
  lines: List(DecisionLine),
  invitations: List(request_row.Row),
  offers: List(Offer),
  now: Int,
) -> List(Json) {
  let room = rec.room
  let invited =
    list.flat_map(invitations, fn(q) {
      let qid = id.request_to_string(q.id)
      list.flatten([
        [
          Line(q.created_at, "trial_invited:" <> qid, [
            #("kind", json.string("trial_invited")),
            #("at", json.int(q.created_at)),
            #("by", json.nullable(q.scout_name, json.string)),
            #("requestId", id.request_json(q.id)),
            #("recipientType", case q.recipient_type {
              Some(t) -> party.to_json(t)
              None -> party.to_json(q.routed_to)
            }),
          ]),
        ],
        case q.status, q.responded_at {
          request_row.Declined, Some(at) -> [
            Line(at, "trial_declined:" <> qid, [
              #("kind", json.string("trial_declined")),
              #("at", json.int(at)),
              #("by", json.null()),
              #("requestId", id.request_json(q.id)),
            ]),
          ]
          _, _ -> []
        },
      ])
    })
  let offer_lines =
    list.flat_map(offers, fn(o) {
      let entries =
        list.filter_map(o.history, fn(h) {
          case
            list.contains(
              [
                "offer_draft_created", "offer_issued", "offer_superseded",
                "offer_withdrawn", "offer_accepted", "offer_declined",
              ],
              h.action,
            )
          {
            False -> Error(Nil)
            True -> {
              let d =
                h.detail_json
                |> option.then(fn(t) {
                  json.parse(t, {
                    use rid <- decode.optional_field(
                      "revisionId",
                      None,
                      decode.optional(decode.string),
                    )
                    use n <- decode.optional_field(
                      "revisionNumber",
                      None,
                      decode.optional(decode.int),
                    )
                    decode.success(#(rid, n))
                  })
                  |> option.from_result
                })
                |> option.unwrap(#(None, None))
              Ok(Line(
                h.at,
                h.action
                  <> ":"
                  <> id.offer_to_string(o.row.id)
                  <> ":"
                  <> id.offer_event_to_string(h.id),
                list.flatten([
                  [
                    #("kind", json.string(h.action)),
                    #("at", json.int(h.at)),
                    #("by", case h.by_kind {
                      Some(event_row.Org) ->
                        json.nullable(h.by_name, json.string)
                      _ -> json.null()
                    }),
                    #(
                      "byKind",
                      json.nullable(h.by_kind, event_row.by_kind_to_json),
                    ),
                    #("offerId", id.offer_json(o.row.id)),
                  ],
                  case d.0 {
                    Some(r) if r != "" -> [#("offerRevisionId", json.string(r))]
                    _ -> []
                  },
                  case d.1 {
                    Some(n) -> [#("revisionNumber", json.int(n))]
                    None -> []
                  },
                ]),
              ))
            }
          }
        })
      let expired = case offer_rules.live_status(o, now) {
        Some(offer_status.Expired) ->
          o.revisions
          |> list.filter(fn(r) { option.is_some(r.row.issued_at) })
          |> list.sort(fn(a, b) {
            int.compare(b.row.revision_number, a.row.revision_number)
          })
          |> list.first
          |> result.map(fn(r) {
            case r.row.expires_at {
              Some(at) -> [
                Line(
                  at,
                  "offer_expired:"
                    <> id.offer_to_string(o.row.id)
                    <> ":"
                    <> id.offer_revision_to_string(r.row.id),
                  [
                    #("kind", json.string("offer_expired")),
                    #("at", json.int(at)),
                    #("by", json.null()),
                    #("byKind", json.null()),
                    #("offerId", id.offer_json(o.row.id)),
                    #("offerRevisionId", id.offer_revision_json(r.row.id)),
                  ],
                ),
              ]
              None -> []
            }
          })
          |> result.unwrap([])
        _ -> []
      }
      list.append(entries, expired)
    })
  let case_lines =
    list.filter_map(room.history, fn(h) {
      case
        list.contains(
          [
            "room_created", "room_status_changed", "room_reopened",
            "case_created", "case_stage_changed", "room_decision_recorded",
          ],
          h.action,
        )
      {
        False -> Error(Nil)
        True -> {
          let d = detail_of(h)
          // The TypeScript projector reads `h.by?.name`, but a case history entry carries `byName`, not `by`, so
          // its line never names anyone. Ported as it behaves.
          Ok(
            Line(h.at, h.action <> ":" <> option.unwrap(d.to, ""), [
              #("kind", json.string(h.action)),
              #("at", json.int(h.at)),
              #("by", json.null()),
              #("from", json.nullable(d.from, json.string)),
              #("to", json.nullable(d.to, json.string)),
              #("reasonCodes", ids(d.reason_codes)),
            ]),
          )
        }
      }
    })
  let handoff_lines =
    list.filter_map(room.history, fn(h) {
      case
        h.action == "transaction_handoff_invited"
        || h.action == "transaction_handoff_withdrawn"
      {
        False -> Error(Nil)
        True -> {
          let d = detail_of(h)
          Ok(
            Line(h.at, h.action <> ":" <> option.unwrap(d.handoff_id, ""), [
              #("kind", json.string(h.action)),
              #("at", json.int(h.at)),
              #("by", json.null()),
              #("handoffId", json.nullable(d.handoff_id, json.string)),
              ..case d.represented {
                Some(r) -> [#("represented", json.bool(r))]
                None -> []
              }
            ]),
          )
        }
      }
    })
  let decision_lines =
    list.map(lines, fn(d) {
      Line(d.at, "decision:" <> id.room_decision_to_string(d.id), [
        #(
          "kind",
          json.string(case d.formal, d.superseded_by {
            True, Some(_) -> "decision_superseded"
            True, None -> "decision_recorded"
            False, _ -> "decision"
          }),
        ),
        #("at", json.int(d.at)),
        #("by", json.nullable(d.by, json.string)),
        #(
          "recommendation",
          decision_row.recommendation_to_json(d.recommendation),
        ),
        #("reasonCodes", ids(d.reason_codes)),
        #(
          "decisionKind",
          json.string(case d.formal {
            True -> "formal"
            False -> "recommendation"
          }),
        ),
        #("outcome", option.unwrap(d.outcome, json.null())),
        #("decisionId", id.room_decision_json(d.id)),
      ])
    })
  list.flatten([invited, offer_lines, case_lines, handoff_lines, decision_lines])
  |> list.sort(fn(a, b) {
    case int.compare(a.at, b.at) {
      order.Eq -> string.compare(a.key, b.key)
      other -> other
    }
  })
  |> list.map(fn(l) { json.object(l.fields) })
}
