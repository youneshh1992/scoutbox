//// The recruitment journey model (domains/recruitment/lifecycle/journeyModel.mjs): pure rules over the records
//// the projection (`journey`) gathers, which works out the facts each rule reads. A decision is not an Offer, an Offer is not an acceptance, an acceptance is
//// not a signing, and a signing in progress is not `signed`. A next action is a suggestion of what a person could do
//// now, never an act the server performs.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/string
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/contact_rules.{type Contact}
import scoutbox/recruitment/decisions
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/recruitment/signing_rules
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as contact_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/signing_revision_parties as signing_party_row
import scoutbox/rows/signings as signing_row
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/offer_status.{type OfferStatus}
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/signing_party_type
import scoutbox/vocab/trial_workflow_state

// ------------------------------------------------------------------------------------------ current records

pub fn stage_of(
  status: RoomStatus,
  assessed: Bool,
  signing_opened: Bool,
) -> String {
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
    room_status.OfferAccepted ->
      case signing_opened {
        True -> "signing"
        False -> "acceptance"
      }
    room_status.Signed -> "signed"
    room_status.OnHold -> "paused"
    room_status.Withdrawn | room_status.Archived | room_status.Closed -> "ended"
  }
}

pub fn newest(
  rows: List(a),
  at: fn(a) -> Int,
  key: fn(a) -> String,
) -> Option(a) {
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

pub type CurrentOffer {
  CurrentOffer(offer: Offer, revision: Option(offer_rules.Revision))
}

/// The current Offer: a live one, then the newest accepted, then the newest of any status.
pub fn current_offer(offers: List(Offer), now: Int) -> Option(CurrentOffer) {
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

/// The current package: a live one, then a completed one, then the newest of any status, so an expired package
/// never masks a live one.
pub fn current_signing(
  packages: List(signing_rules.Package),
  now: Int,
) -> Option(signing_rules.Package) {
  let tier = fn(pred) {
    newest(list.filter(packages, pred), fn(p) { p.row.created_at }, fn(p) {
      id.signing_package_to_string(p.row.id)
    })
  }
  tier(signing_rules.is_live(_, now))
  |> option.lazy_or(fn() {
    tier(fn(p) {
      signing_rules.effective_status(p, now) == signing_rules.Completed
    })
  })
  |> option.lazy_or(fn() { tier(fn(_) { True }) })
}

/// The current Contact, newest first within each tier: delivered and awaiting a response, then responded or
/// recorded, then a draft, then failed. Cancelled is never current.
pub fn current_contact(rows: List(Contact)) -> Option(Contact) {
  let key = fn(c: Contact) { id.contact_to_string(c.row.id) }
  let tier = fn(pred, at) { newest(list.filter(rows, pred), at, key) }
  let st = fn(c: Contact) { c.row.status }
  tier(fn(c) { st(c) == contact_row.Delivered }, fn(c) {
    option.unwrap(c.row.delivered_at, c.row.created_at)
  })
  |> option.lazy_or(fn() {
    tier(
      fn(c) { st(c) == contact_row.Responded || st(c) == contact_row.Recorded },
      fn(c) {
        c.row.responded_at
        |> option.or(c.row.occurred_at)
        |> option.or(c.row.recorded_at)
        |> option.or(c.row.delivered_at)
        |> option.unwrap(c.row.created_at)
      },
    )
  })
  |> option.lazy_or(fn() {
    tier(fn(c) { st(c) == contact_row.Draft }, fn(c) { c.row.updated_at })
  })
  |> option.lazy_or(fn() {
    tier(fn(c) { st(c) == contact_row.StatusFailed }, fn(c) {
      option.unwrap(c.row.failed_at, c.row.created_at)
    })
  })
}

/// The current Trial: live (accepted or scheduled), then completed, then cancelled, then a legacy acceptance.
pub fn current_trial(rows: List(Trial)) -> Option(Trial) {
  let key = fn(t: Trial) { id.trial_to_string(t.row.id) }
  let tier = fn(states, at) {
    newest(
      list.filter(rows, fn(t) {
        list.contains(states, trial_rules.workflow_state(t))
      }),
      at,
      key,
    )
  }
  let ended = fn(t: Trial) {
    option.unwrap(t.row.completion_at, t.row.accepted_at)
  }
  tier([trial_workflow_state.Accepted, trial_workflow_state.Scheduled], fn(t) {
    option.unwrap(t.row.schedule_confirmed_at, t.row.accepted_at)
  })
  |> option.lazy_or(fn() { tier([trial_workflow_state.Completed], ended) })
  |> option.lazy_or(fn() { tier([trial_workflow_state.Cancelled], ended) })
  |> option.lazy_or(fn() {
    tier([trial_workflow_state.LegacyAccepted], fn(t) { t.row.accepted_at })
  })
}

/// The latest submitted assessment, else the latest draft (currentAssessmentForCase). A row has no update time, so a
/// draft is as new as its creation.
pub fn current_assessment(
  rows: List(assessment_row.Row),
) -> Option(assessment_row.Row) {
  let key = fn(a: assessment_row.Row) { id.assessment_to_string(a.id) }
  newest(
    list.filter(rows, fn(a) { a.state != assessment_row.Draft }),
    fn(a) { option.unwrap(a.submitted_at, a.created_at) },
    key,
  )
  |> option.lazy_or(fn() {
    newest(
      list.filter(rows, fn(a) { a.state == assessment_row.Draft }),
      fn(a) { a.created_at },
      key,
    )
  })
}

/// The formal chain head, else the advisory head. Never a draft.
pub fn current_decision(
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

// ------------------------------------------------------------------------------------------- next action

/// What the next action reads of a case's current records, each reduced to the facts the rule looks at. The
/// projection works these out from the records (the current contact, trial, Offer and package).
pub type NextFacts {
  NextFacts(
    /// An assessment was submitted.
    assessed: Bool,
    /// The current formal decision.
    decision: Option(id.RoomDecisionId),
    contact: Option(NextContact),
    trial: Option(NextTrial),
    /// The pending trial invitation.
    trial_request: Option(id.RequestId),
    offer: Option(NextOffer),
    signing: Option(NextSigning),
    /// The signing row that records the player joining.
    signing_row: Option(id.SigningId),
  )
}

pub type NextContact {
  NextContact(id: id.ContactId, status: contact_row.Status)
}

pub type NextTrial {
  /// `last_end`: when its last session ends, 0 when it has none.
  NextTrial(id: id.TrialId, last_end: Int)
}

pub type NextOffer {
  NextOffer(
    id: id.OfferId,
    /// The live revision, else the current draft.
    revision: Option(id.OfferRevisionId),
    status: Option(OfferStatus),
    /// The status of the revision the recipient was sent.
    live_status: Option(OfferStatus),
  )
}

pub type NextSigning {
  NextSigning(
    id: id.SigningPackageId,
    status: signing_rules.Status,
    /// On the current revision: the club signatory, or another party, is still to sign.
    club_pending: Bool,
    others_pending: Bool,
    completed_signing: Option(id.SigningId),
  )
}

type Next {
  Next(
    stage: Option(String),
    kind: String,
    tab: String,
    action: Option(String),
    min_rank: Option(Int),
  )
}

/// NEXT_ACTIONS: a club act names its lifecycle action, so the permission rule is the lifecycle's own, or the least
/// role rank it needs (PERMISSION_MIN_ROLE). Only says whether to offer the act; the domain routes remain the
/// authority.
fn next_def(code: String) -> Next {
  let club = fn(stage, tab, action) {
    Next(Some(stage), "club", tab, Some(action), None)
  }
  let ranked = fn(stage, tab, rank) {
    Next(Some(stage), "club", tab, None, Some(rank))
  }
  let wait = fn(stage, tab) { Next(Some(stage), "await", tab, None, None) }
  case code {
    "REVIEW_PLAYER" -> club("watching", "overview", "startReview")
    "DECIDE_APPROACH" -> club("review", "overview", "planContact")
    "SEND_CONTACT" -> ranked("contact", "contact", 2)
    "AWAIT_CONTACT_RESPONSE" -> wait("contact", "contact")
    "CONTINUE_EVALUATION" -> club("contact", "overview", "shortlist")
    "AWAIT_TRIAL_RESPONSE" -> wait("trial", "trial")
    "CONDUCT_TRIAL" -> ranked("trial", "trial", 2)
    "COMPLETE_TRIAL" -> ranked("trial", "trial", 2)
    "COMPLETE_ASSESSMENT" -> ranked("assessment", "assessments", 1)
    "RECORD_DECISION" -> ranked("decision", "decision", 2)
    "PREPARE_OFFER" -> ranked("offer", "offer", 2)
    "ISSUE_OFFER" -> ranked("offer", "offer", 2)
    "AWAIT_OFFER_RESPONSE" -> wait("offer", "offer")
    "REVISE_OR_WITHDRAW_OFFER" -> ranked("offer", "offer", 2)
    "REVIEW_DECLINED_OFFER" -> club("offer", "offer", "considerOffer")
    "START_SIGNING" -> ranked("acceptance", "signing", 2)
    "PRESENT_SIGNING" -> ranked("signing", "signing", 2)
    "SIGN_FOR_CLUB" -> ranked("signing", "signing", 3)
    "AWAIT_RECIPIENT_SIGNATURE" -> wait("signing", "signing")
    "COMPLETE_SIGNING" -> ranked("signing", "signing", 3)
    "RECRUITMENT_COMPLETE" ->
      Next(Some("signed"), "none", "signing", None, None)
    "RESUME_CASE" -> club("paused", "overview", "resumeCase")
    "CASE_ENDED" -> Next(Some("ended"), "none", "overview", None, None)
    _ -> Next(None, "none", "overview", None, None)
  }
}

/// The next action at `status` (nextActionFor): `pick`, then `finish`.
pub fn next_action(
  status: RoomStatus,
  facts: NextFacts,
  role: Option(RoomRole),
  blocked: Bool,
  subject_removed: Bool,
  integrity_error: Bool,
  now: Int,
) -> Json {
  let #(code, refs) = pick(status, facts, now)
  finish(code, refs, role, blocked, subject_removed, integrity_error)
}

/// The code and the records it concerns.
pub fn pick(
  status: RoomStatus,
  f: NextFacts,
  now: Int,
) -> #(String, List(#(String, Json))) {
  let offer_id = #(
    "offerId",
    json.nullable(option.map(f.offer, fn(o) { o.id }), id.offer_json),
  )
  let offer_refs = [
    offer_id,
    #(
      "offerRevisionId",
      json.nullable(
        option.then(f.offer, fn(o) { o.revision }),
        id.offer_revision_json,
      ),
    ),
  ]
  let trial_ref = #(
    "trialId",
    json.nullable(option.map(f.trial, fn(t) { t.id }), id.trial_json),
  )
  let decision_ref = #(
    "decisionId",
    json.nullable(f.decision, id.room_decision_json),
  )
  let package_ref = fn(p: Option(NextSigning)) {
    #(
      "signingPackageId",
      json.nullable(option.map(p, fn(p) { p.id }), id.signing_package_json),
    )
  }
  case status {
    room_status.Signed -> #("RECRUITMENT_COMPLETE", [
      #(
        "completedSigningId",
        json.nullable(
          option.lazy_or(f.signing_row, fn() {
            option.then(f.signing, fn(p) { p.completed_signing })
          }),
          id.signing_json,
        ),
      ),
      package_ref(f.signing),
    ])
    room_status.Withdrawn | room_status.Archived | room_status.Closed -> #(
      "CASE_ENDED",
      [],
    )
    room_status.OnHold -> #("RESUME_CASE", [])
    room_status.Watching -> #("REVIEW_PLAYER", [])
    room_status.UnderReview | room_status.Shortlisted | room_status.Priority ->
      case f.assessed && f.decision == None {
        True -> #("RECORD_DECISION", [])
        False -> #("DECIDE_APPROACH", [])
      }
    room_status.ContactPlanned -> #("SEND_CONTACT", [
      #("contactId", case f.contact {
        Some(c) if c.status == contact_row.Draft -> id.contact_json(c.id)
        _ -> json.null()
      }),
    ])
    room_status.Contacted ->
      case f.contact {
        Some(c) if c.status == contact_row.Delivered -> #(
          "AWAIT_CONTACT_RESPONSE",
          [#("contactId", id.contact_json(c.id))],
        )
        _ -> #("CONTINUE_EVALUATION", [
          #(
            "contactId",
            json.nullable(
              option.map(f.contact, fn(c) { c.id }),
              id.contact_json,
            ),
          ),
        ])
      }
    room_status.TrialRequested -> #("AWAIT_TRIAL_RESPONSE", [
      #("trialRequestId", json.nullable(f.trial_request, id.request_json)),
    ])
    room_status.TrialScheduled -> {
      let last_end =
        option.map(f.trial, fn(t) { t.last_end }) |> option.unwrap(0)
      #(
        case last_end > 0 && last_end <= now {
          True -> "COMPLETE_TRIAL"
          False -> "CONDUCT_TRIAL"
        },
        [trial_ref],
      )
    }
    room_status.TrialCompleted ->
      case f.assessed, f.decision {
        False, _ -> #("COMPLETE_ASSESSMENT", [trial_ref])
        True, None -> #("RECORD_DECISION", [trial_ref])
        True, Some(_) -> #("RECORD_DECISION", [trial_ref, decision_ref])
      }
    room_status.OfferConsideration ->
      case f.offer {
        Some(o) if o.status == Some(offer_status.Draft) -> #(
          "ISSUE_OFFER",
          offer_refs,
        )
        _ -> #("PREPARE_OFFER", [decision_ref])
      }
    room_status.OfferMade ->
      case f.offer {
        Some(o) if o.live_status == Some(offer_status.Issued) -> #(
          "AWAIT_OFFER_RESPONSE",
          offer_refs,
        )
        _ -> #("REVISE_OR_WITHDRAW_OFFER", offer_refs)
      }
    room_status.OfferDeclined -> #("REVIEW_DECLINED_OFFER", [offer_id])
    room_status.OfferAccepted -> {
      let refs = list.append(offer_refs, [package_ref(f.signing)])
      case f.signing {
        Some(p) ->
          case signing_rules.live(p.status), p.status, p.club_pending {
            False, _, _ -> #(
              "START_SIGNING",
              list.append(offer_refs, [package_ref(None)]),
            )
            True, signing_rules.Draft, _ -> #("PRESENT_SIGNING", refs)
            True, _, True -> #("SIGN_FOR_CLUB", refs)
            True, _, False ->
              case p.others_pending {
                True -> #("AWAIT_RECIPIENT_SIGNATURE", refs)
                False -> #("COMPLETE_SIGNING", refs)
              }
          }
        None -> #("START_SIGNING", list.append(offer_refs, [package_ref(None)]))
      }
    }
  }
}

/// The act's envelope: its stage, kind and tab, whether `role` may take it, and what blocks it. A journey whose
/// lifecycle and records disagree fails closed: the act is named but not offered until the record is put right.
pub fn finish(
  code: String,
  refs: List(#(String, Json)),
  role: Option(RoomRole),
  blocked: Bool,
  subject_removed: Bool,
  integrity_error: Bool,
) -> Json {
  let def = next_def(code)
  let club = def.kind == "club"
  let blocked_by =
    [
      #(blocked, "BLOCKED"),
      #(subject_removed, "SUBJECT_REMOVED"),
      #(integrity_error, "INTEGRITY_ERROR"),
    ]
    |> list.filter_map(fn(b) {
      case club && b.0 {
        True -> Ok(b.1)
        False -> Error(Nil)
      }
    })
  let rank = option.map(role, room_rules.role_rank) |> option.unwrap(-1)
  let permitted = case club, def.action, def.min_rank {
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
    #("blockedBy", json.array(blocked_by, json.string)),
    #("resources", json.object(refs)),
  ])
}

/// The facts of the current Offer the next action reads.
pub fn next_offer(o: CurrentOffer, now: Int) -> NextOffer {
  NextOffer(
    id: o.offer.row.id,
    revision: option.map(o.revision, fn(r) { r.row.id }),
    status: offer_rules.status(o.offer, now),
    live_status: offer_rules.live_status(o.offer, now),
  )
}

/// The facts of the current signing package the next action reads.
pub fn next_signing(p: signing_rules.Package, now: Int) -> NextSigning {
  let parties = case signing_rules.current_revision(p) {
    Some(rev) -> rev.parties
    None -> []
  }
  let pending = fn(club) {
    list.any(parties, fn(x) {
      { x.party_type == signing_party_type.ClubSignatory } == club
      && x.status == signing_party_row.Pending
    })
  }
  NextSigning(
    id: p.row.id,
    status: signing_rules.effective_status(p, now),
    club_pending: pending(True),
    others_pending: pending(False),
    completed_signing: p.row.completion_signing_id,
  )
}

/// The facts of the current trial the next action reads.
pub fn next_trial(t: Trial) -> NextTrial {
  NextTrial(
    id: t.row.id,
    last_end: list.fold(t.sessions, 0, fn(m, x) { int.max(m, x.row.ends_at) }),
  )
}

// --------------------------------------------------------------------------------------------- the journey

/// What the journey's check and its completed stages read: the case, and the records naming it that are sound and
/// its own (a corrupt one is counted, a foreign one named).
pub type JourneyFacts {
  JourneyFacts(
    status: RoomStatus,
    created_at: Int,
    history: List(history_row.Row),
    /// The case's link to the signing row its outcome rests on.
    links_signing_id: Option(String),
    contacts: List(Contact),
    trials: List(Trial),
    trial_requests: List(request_row.Row),
    assessments: List(assessment_row.Row),
    decisions: List(decisions.Decision),
    offers: List(Offer),
    packages: List(signing_rules.Package),
    signing_row: Option(signing_row.Row),
    /// The club's signing rows for the player, which the link must name one of.
    signing_row_ids: List(id.SigningId),
    /// Records naming the case that failed their integrity check.
    corrupt: Int,
    /// CLUB_MISMATCH or PLAYER_MISMATCH: records that name the case but another club or player.
    foreign: List(String),
    /// The Offers' and packages' own consistency problems that mean corruption.
    domain_problems: List(String),
    now: Int,
  )
}

/// The journey's classification and problems (sorted), and how many evidence-bearing states it reached with a
/// record behind them and without one.
pub type Verdict {
  Verdict(
    classification: String,
    problems: List(String),
    backed: Int,
    unbacked: Int,
  )
}

/// validateRecruitmentJourney's answer.
pub fn verdict_json(v: Verdict) -> Json {
  json.object([
    #("ok", json.bool(v.problems == [])),
    #("classification", json.string(v.classification)),
    #("problems", json.array(v.problems, json.string)),
    #("backed", json.int(v.backed)),
    #("unbacked", json.int(v.unbacked)),
  ])
}

/// The case history detail fields the journey reads.
pub type Detail {
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

pub fn detail_of(h: history_row.Row) -> Detail {
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

/// The first instant the history reached one of `statuses`.
pub fn first_reach(
  history: List(history_row.Row),
  statuses: List(String),
) -> Option(Int) {
  list.fold(history, None, fn(best, h) {
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

pub fn stage_json(
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

/// The pipeline stages a case completed, each with its basis (completedStagesFor): `canonical`, a domain record,
/// or `lifecycle`, the history reached the state with no record behind it, a legacy fact reported as such.
pub fn completed_stages(f: JourneyFacts) -> List(Json) {
  let all = list.map(room_rules.statuses(), room_status.to_string)
  let opened = first_reach(f.history, all) |> option.or(Some(f.created_at))
  let review_statuses =
    room_rules.statuses()
    |> list.filter(fn(s) {
      s != room_status.Watching
      && s != room_status.OnHold
      && !list.contains(room_rules.terminal, s)
    })
    |> list.map(room_status.to_string)
  let lifecycle_only = fn(stage, statuses) {
    case first_reach(f.history, statuses) {
      Some(at) -> [stage_json(stage, "lifecycle", Some(at), [])]
      None -> []
    }
  }
  let evidence_contact =
    f.contacts
    |> list.filter_map(fn(c) {
      let at =
        c.row.delivered_at
        |> option.or(c.row.occurred_at)
        |> option.or(c.row.recorded_at)
      case contact_rules.is_evidence(c.row.status), c.row.cancelled_at, at {
        True, None, Some(at) -> Ok(#(c, at))
        _, _, _ -> Error(Nil)
      }
    })
    |> newest(fn(x) { x.1 }, fn(x) { id.contact_to_string({ x.0 }.row.id) })
  let done_trial =
    newest(
      list.filter(f.trials, fn(t) {
        trial_rules.workflow_state(t) == trial_workflow_state.Completed
      }),
      fn(t) { option.unwrap(t.row.completion_at, 0) },
      fn(t) { id.trial_to_string(t.row.id) },
    )
  let assessed =
    newest(
      list.filter(f.assessments, fn(a) { a.state != assessment_row.Draft }),
      fn(a) { option.unwrap(a.submitted_at, a.created_at) },
      fn(a) { id.assessment_to_string(a.id) },
    )
  let decided =
    newest(
      list.filter(f.decisions, fn(d) {
        decisions.is_formal(d)
        && d.base.row.state != Some(decision_row.Draft)
        && d.base.row.superseded_by_id == None
      }),
      fn(d) { d.base.row.created_at },
      fn(d) { id.room_decision_to_string(d.base.row.id) },
    )
  let issued =
    list.filter_map(f.offers, fn(o) {
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
      offer_rules.effective({ x.1 }.row, f.now) == offer_status.Accepted
    })
    |> list.sort(fn(a, b) {
      int.compare(
        option.unwrap({ a.1 }.row.responded_at, 0),
        option.unwrap({ b.1 }.row.responded_at, 0),
      )
    })
    |> list.first
  let completed_package =
    newest(
      list.filter(f.packages, fn(p) {
        signing_rules.effective_status(p, f.now) == signing_rules.Completed
      }),
      fn(p) { option.unwrap(p.row.completion_completed_at, 0) },
      fn(p) { id.signing_package_to_string(p.row.id) },
    )
  let offer_refs = fn(x: #(Offer, offer_rules.Revision)) {
    [
      #("offerId", id.offer_json({ x.0 }.row.id)),
      #("offerRevisionId", id.offer_revision_json({ x.1 }.row.id)),
    ]
  }
  list.flatten([
    [stage_json("watching", "lifecycle", opened, [])],
    lifecycle_only("review", review_statuses),
    case evidence_contact {
      Some(#(c, at)) -> [
        stage_json("contact", "canonical", Some(at), [
          #("contactId", id.contact_json(c.row.id)),
        ]),
      ]
      None -> lifecycle_only("contact", ["contacted"])
    },
    case done_trial {
      Some(t) -> [
        stage_json("trial", "canonical", t.row.completion_at, [
          #("trialId", id.trial_json(t.row.id)),
        ]),
      ]
      None -> lifecycle_only("trial", ["trial_completed"])
    },
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
    case completed_package {
      Some(p) -> [
        stage_json("signing", "canonical", p.row.completion_completed_at, [
          #("signingPackageId", id.signing_package_json(p.row.id)),
          #(
            "completedSigningId",
            json.nullable(p.row.completion_signing_id, id.signing_json),
          ),
        ]),
      ]
      None -> []
    },
    case first_reach(f.history, ["signed"]), f.status == room_status.Signed {
      None, False -> []
      at, _ ->
        case f.signing_row {
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

/// Detects, never repairs, impossible combinations of lifecycle and records (validateRecruitmentJourney).
pub fn validate(f: JourneyFacts) -> Verdict {
  let request_ids =
    list.map(f.trial_requests, fn(q) { id.request_to_string(q.id) })
  let decision_ids =
    list.map(f.decisions, fn(d) { id.room_decision_to_string(d.base.row.id) })
  let offer_ids = list.map(f.offers, fn(o) { id.offer_to_string(o.row.id) })
  let contact_ids =
    list.map(f.contacts, fn(c) { id.contact_to_string(c.row.id) })
  let trial_ids = list.map(f.trials, fn(t) { id.trial_to_string(t.row.id) })
  let package_ids =
    list.map(f.packages, fn(p) { id.signing_package_to_string(p.row.id) })
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
      f.history,
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
              stale(d.contact_id, contact_ids)
              || stale(d.trial_id, trial_ids)
              || stale(d.request_id, request_ids)
              || stale(d.decision_id, decision_ids)
              || stale(d.offer_id, offer_ids)
              || stale(d.signing_package_id, package_ids)
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
  let signing_ids = list.map(f.signing_row_ids, id.signing_to_string)
  let live_with = fn(want) {
    list.any(f.offers, fn(o) {
      case offer_rules.live_revision(o) {
        Some(rv) -> offer_rules.effective(rv.row, f.now) == want
        None -> False
      }
    })
  }
  let evidence = [
    #(
      "contacted",
      list.any(f.contacts, fn(c) {
        contact_rules.is_evidence(c.row.status) && c.row.cancelled_at == None
      }),
    ),
    #("trial_requested", f.trial_requests != [] || f.trials != []),
    #(
      "trial_scheduled",
      list.any(f.trials, fn(t) {
        list.contains(
          [
            trial_workflow_state.Scheduled,
            trial_workflow_state.Completed,
            trial_workflow_state.Cancelled,
          ],
          trial_rules.workflow_state(t),
        )
        && trial_rules.has_schedule(t)
      }),
    ),
    #(
      "trial_completed",
      list.any(f.trials, fn(t) {
        trial_rules.workflow_state(t) == trial_workflow_state.Completed
      }),
    ),
    #(
      "offer_consideration",
      list.any(f.decisions, fn(d) {
        decisions.is_formal(d)
        && d.base.row.state != Some(decision_row.Draft)
        && d.base.row.outcome == Some(decision_outcome.Progress)
      }),
    ),
    #(
      "offer_made",
      list.any(f.offers, fn(o) { offer_rules.live_revision(o) != None }),
    ),
    #("offer_accepted", live_with(offer_status.Accepted)),
    #("offer_declined", live_with(offer_status.Declined)),
    #("signed", option.is_some(f.signing_row)),
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
  let current = room_status.to_string(f.status)
  let unbacked = case
    list.key_find(evidence, current),
    list.any(reached, fn(x) { x.0 == current })
  {
    Ok(False), False -> unbacked + 1
    _, _ -> unbacked
  }
  let live =
    !list.contains(room_rules.terminal, f.status)
    && f.status != room_status.OnHold
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
  // A malformed instant is corruption; out-of-order instants (a test clock, a clock step) are not.
  let temporal = case list.any(f.history, fn(h) { h.at <= 0 }) {
    True -> ["TEMPORAL_ORDER"]
    False -> []
  }
  let problems =
    list.flatten([
      temporal,
      history_problems,
      f.foreign,
      case ahead_claims {
        True -> ["LIFECYCLE_AHEAD_OF_EVIDENCE"]
        False -> []
      },
      case f.corrupt > 0 {
        True -> ["RECORD_CORRUPT"]
        False -> []
      },
      case f.links_signing_id {
        Some(s) if s != "" ->
          case list.contains(signing_ids, s) {
            True -> []
            False -> ["STALE_POINTER"]
          }
        _ -> []
      },
      case
        {
          option.is_some(f.signing_row)
          || list.any(f.packages, fn(p) {
            signing_rules.effective_status(p, f.now) == signing_rules.Completed
          })
        }
        && f.status != room_status.Signed
        && live
      {
        True -> ["LIFECYCLE_BEHIND_TERMINAL_EVIDENCE"]
        False -> []
      },
      case ahead {
        True -> ["EVIDENCE_AHEAD_OF_LIFECYCLE"]
        False -> []
      },
      f.domain_problems,
    ])
    |> list.unique
    |> list.sort(string.compare)
  let classification = case problems, unbacked, backed {
    [_, ..], _, _ -> "integrity_error"
    [], 0, _ -> "canonical"
    [], _, 0 -> "legacy"
    [], _, _ -> "partially_canonical"
  }
  Verdict(classification:, problems:, backed:, unbacked:)
}

// ------------------------------------------------------------------------------------------------- audiences

/// Who a timeline line may be shown to (TIMELINE_VISIBILITY). The club sees everything on its own case; the player,
/// guardian and an authorised agent see only events that involved them; Trust & Safety sees ids-only milestones.
pub const timeline_visibility = [
  #("room_created", ["club", "trust_safety"]),
  #("room_status_changed", ["club", "trust_safety"]),
  #("room_reopened", ["club", "trust_safety"]),
  #("case_created", ["club"]),
  #("case_stage_changed", ["club"]),
  #("room_decision_recorded", ["club"]),
  #("decision", ["club"]),
  #("decision_recorded", ["club"]),
  #("decision_superseded", ["club"]),
  #("transaction_handoff_invited", ["club"]),
  #("transaction_handoff_withdrawn", ["club"]),
  #("contact_initiated", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("contact_response_received", [
    "club",
    "player",
    "guardian",
    "agent",
    "trust_safety",
  ]),
  #("trial_invited", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("trial_declined", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("trial_accepted", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("trial_schedule_proposed", ["club", "player", "guardian", "agent"]),
  #("trial_rescheduled", ["club", "player", "guardian", "agent"]),
  #("trial_schedule_confirmed", [
    "club",
    "player",
    "guardian",
    "agent",
    "trust_safety",
  ]),
  #("trial_schedule_declined", ["club", "player", "guardian", "agent"]),
  #("trial_attendance_recorded", ["club", "player", "guardian"]),
  #("trial_cancelled", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("trial_completed", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("trial_evidence_linked", ["club"]),
  #("trial_assessment_recorded", ["club"]),
  #("offer_draft_created", ["club"]),
  #("offer_issued", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("offer_superseded", ["club", "player", "guardian", "agent"]),
  #("offer_withdrawn", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("offer_accepted", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("offer_declined", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("offer_expired", ["club", "player", "guardian", "agent"]),
  #("signing_created", ["club"]),
  #("signing_ready", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("signing_party_completed", ["club", "player", "guardian", "agent"]),
  #("signing_completed", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("signing_cancelled", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("signing_voided", ["club", "player", "guardian", "agent", "trust_safety"]),
  #("signing_superseded", ["club", "player", "guardian", "agent"]),
]

/// May `audience` see a timeline line of this kind (timelineVisibleTo)?
pub fn visible_to(kind: String, audience: String) -> Bool {
  case list.key_find(timeline_visibility, kind) {
    Ok(audiences) -> list.contains(audiences, audience)
    Error(Nil) -> False
  }
}

// ------------------------------------------------------------------------------------------- the recipient

/// The recipient's stage (playerStageFor): only stages that involve them, never the club's pipeline. `offer_live` is
/// the status of the current Offer's live revision.
pub fn player_stage(
  contacts: List(a),
  trial_requests: List(request_row.Row),
  trials: List(Trial),
  offer_live: Option(OfferStatus),
  signing: Option(signing_rules.Package),
  signed: Bool,
  now: Int,
) -> String {
  let st = option.map(signing, signing_rules.effective_status(_, now))
  let live = case signing {
    Some(p) -> signing_rules.is_live(p, now)
    None -> False
  }
  let offer_stage =
    option.then(offer_live, fn(st) {
      case st {
        offer_status.Accepted -> Some("offer_accepted")
        offer_status.Declined -> Some("offer_declined")
        offer_status.Issued -> Some("offer_received")
        _ -> None
      }
    })
  let trial_stage =
    current_trial(trials)
    |> option.then(fn(t) {
      case trial_rules.workflow_state(t) {
        trial_workflow_state.Completed -> Some("trial_completed")
        trial_workflow_state.Scheduled
        | trial_workflow_state.Accepted
        | trial_workflow_state.LegacyAccepted -> Some("trial_scheduled")
        _ -> None
      }
    })
  let invited =
    list.any(trial_requests, fn(r) { r.status == request_row.Pending })
  case
    signed || st == Some(signing_rules.Completed),
    live
    && {
      st == Some(signing_rules.Ready) || st == Some(signing_rules.InProgress)
    }
  {
    True, _ -> "signed"
    False, True -> "signing"
    False, False ->
      offer_stage
      |> option.lazy_or(fn() { trial_stage })
      |> option.lazy_unwrap(fn() {
        case invited, contacts {
          True, _ -> "trial_invited"
          False, [_, ..] -> "contacted"
          False, [] -> "none"
        }
      })
  }
}

/// How far along a recipient's next action is, to pick one across their cases.
pub const player_next_weight = [
  #("SIGN", 5),
  #("RESPOND_TO_OFFER", 4),
  #("CONFIRM_TRIAL_SCHEDULE", 3),
  #("RESPOND_TO_TRIAL_INVITATION", 2),
  #("RESPOND_TO_CONTACT", 1),
  #("NONE", 0),
]

/// The recipient's next action (playerNextActionFor), from what the projection found waiting for them: only what
/// the player or guardian can answer themselves, nothing about the club's process.
pub fn player_next(
  signing_pending: Option(id.SigningPackageId),
  issued_offer: Option(#(id.OfferId, Option(id.OfferRevisionId))),
  trial_awaiting_confirmation: Option(id.TrialId),
  pending_trial_request: Option(id.RequestId),
  pending_contact_request: Option(id.RequestId),
) -> #(String, List(#(String, Json))) {
  case
    signing_pending,
    issued_offer,
    trial_awaiting_confirmation,
    pending_trial_request,
    pending_contact_request
  {
    Some(p), _, _, _, _ -> #("SIGN", [
      #("signingPackageId", id.signing_package_json(p)),
    ])
    None, Some(#(o, rev)), _, _, _ -> #("RESPOND_TO_OFFER", [
      #("offerId", id.offer_json(o)),
      #("offerRevisionId", json.nullable(rev, id.offer_revision_json)),
    ])
    None, None, Some(t), _, _ -> #("CONFIRM_TRIAL_SCHEDULE", [
      #("trialId", id.trial_json(t)),
    ])
    None, None, None, Some(r), _ -> #("RESPOND_TO_TRIAL_INVITATION", [
      #("requestId", id.request_json(r)),
    ])
    None, None, None, None, Some(r) -> #("RESPOND_TO_CONTACT", [
      #("requestId", id.request_json(r)),
    ])
    None, None, None, None, None -> #("NONE", [])
  }
}
