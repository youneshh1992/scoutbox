//// The Offer domain's rules (domains/recruitment/offers/offer.mjs): pure functions over one stored Offer and a
//// clock.
////
//// A recruitment decision, an offer, an offer acceptance and a signing are four different things: an accepted
//// Offer is not a signing. An issued revision is immutable; changed terms are a new revision, and an answer names
//// one exact issued revision. `effective` reads an issued revision whose expiry has passed, or is missing, as
//// EXPIRED without any job having run.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/temporal
import scoutbox/rows/id
import scoutbox/rows/offer_history as event_row
import scoutbox/rows/offer_keys as key_row
import scoutbox/rows/offer_read_receipts as receipt_row
import scoutbox/rows/offer_responses as response_row
import scoutbox/rows/offer_revision_documents as document_row
import scoutbox/rows/offer_revisions as revision_row
import scoutbox/rows/recruitment_offers as offer_row
import scoutbox/vocab/offer_status.{
  type OfferStatus, Accepted, Declined, Draft, Expired, Issued, Superseded,
  Withdrawn,
}
import scoutbox/vocab/party
import scoutbox/vocab/room_status.{type RoomStatus}

pub const policy_version = 1

const day_ms = 86_400_000

// ------------------------------------------------------------------------------------------------- records

/// One stored Offer, with its ordered child rows.
pub type Offer {
  Offer(
    row: offer_row.Row,
    revisions: List(Revision),
    responses: List(response_row.Row),
    receipts: List(receipt_row.Row),
    history: List(event_row.Row),
    keys: List(key_row.Row),
  )
}

pub type Revision {
  Revision(row: revision_row.Row, documents: List(document_row.Row))
}

/// The narrow terms an Offer carries. There is no compensation field; days are calendar days.
pub type Terms {
  Terms(
    role: Option(String),
    squad: Option(String),
    start_date: Option(String),
    end_date: Option(String),
    conditions: Option(String),
  )
}

pub fn terms_of(r: revision_row.Row) -> Terms {
  Terms(
    role: r.term_role,
    squad: r.term_squad,
    start_date: r.term_start_date,
    end_date: r.term_end_date,
    conditions: r.term_conditions,
  )
}

// ---------------------------------------------------------------------------------------------- vocabulary

pub const statuses = [
  Draft,
  Issued,
  Accepted,
  Declined,
  Withdrawn,
  Expired,
  Superseded,
]

pub fn status_label(s: OfferStatus) -> String {
  case s {
    Draft -> "Draft — not issued"
    Issued -> "Issued — awaiting response"
    Accepted -> "Offer accepted — signing pending"
    Declined -> "Declined by the recipient"
    Withdrawn -> "Withdrawn by the club"
    Expired -> "Expired"
    Superseded -> "Superseded by a later revision"
  }
}

/// No edge out of ACCEPTED: a later contract workflow or an explicit restart owns that.
pub fn transitions(from: OfferStatus) -> List(OfferStatus) {
  case from {
    Draft -> [Issued, Withdrawn]
    Issued -> [Accepted, Declined, Withdrawn, Expired, Superseded]
    _ -> []
  }
}

/// The statuses a revision may move into `to` from.
pub fn leading_to(to: OfferStatus) -> List(OfferStatus) {
  list.filter(statuses, fn(s) { list.contains(transitions(s), to) })
}

pub const types = ["direct_recruitment"]

pub const response_types = ["accepted", "declined"]

pub const limit_role = 80

pub const limit_squad = 80

pub const limit_conditions = 1000

pub const limit_recipient_message = 2000

pub const limit_internal_note = 2000

pub const limit_withdraw_reason = 400

pub const limit_decline_reason = 400

pub const limit_document_label = 120

pub const limit_documents = 10

pub const limit_revisions = 20

pub const min_expiry_ms = 3_600_000

pub const max_expiry_ms = 15_552_000_000

pub const history_page = 200

/// OFFER_LIMITS, as the policy and the room surface print it.
pub fn limits_json() -> Json {
  json.object([
    #("role", json.int(limit_role)),
    #("squad", json.int(limit_squad)),
    #("conditions", json.int(limit_conditions)),
    #("recipientMessage", json.int(limit_recipient_message)),
    #("internalNote", json.int(limit_internal_note)),
    #("withdrawReason", json.int(limit_withdraw_reason)),
    #("declineReason", json.int(limit_decline_reason)),
    #("documentLabel", json.int(limit_document_label)),
    #("documents", json.int(limit_documents)),
    #("revisions", json.int(limit_revisions)),
    #("clientKey", json.int(64)),
    #("minExpiryMs", json.int(min_expiry_ms)),
    #("maxExpiryMs", json.int(max_expiry_ms)),
    #("historyPage", json.int(history_page)),
  ])
}

pub fn status_labels_json() -> Json {
  json.object(
    list.map(statuses, fn(s) {
      #(offer_status.to_string(s), json.string(status_label(s)))
    }),
  )
}

/// MINOR_OFFER_PATHWAY_ENABLED: no jurisdiction's policy for an Offer to a minor is encoded, so the pathway is
/// closed everywhere. Opening one is a change to this table.
pub const minor_pathway = [
  #("GB", False),
  #("ENG", False),
  #("INT", False),
  #("USA", False),
  #("DEFAULT", False),
]

pub fn minor_pathway_open(jurisdiction: String) -> Bool {
  case list.key_find(minor_pathway, jurisdiction) {
    Ok(open) -> open
    Error(Nil) -> list.key_find(minor_pathway, "DEFAULT") == Ok(True)
  }
}

// --------------------------------------------------------------------------------------------------- status

/// Stored ISSUED with a passed or missing expiry reads EXPIRED.
pub fn effective(r: revision_row.Row, now: Int) -> OfferStatus {
  case r.status {
    Issued ->
      case r.expires_at {
        None -> Expired
        Some(until) if now >= until -> Expired
        Some(_) -> Issued
      }
    other -> other
  }
}

pub fn current_revision(o: Offer) -> Option(Revision) {
  list.find(o.revisions, fn(r) { r.row.id == o.row.current_revision_id })
  |> option.from_result
}

/// A withdrawn draft was never issued.
pub fn was_issued(r: revision_row.Row) -> Bool {
  r.status != Draft && option.is_some(r.issued_at)
}

/// The latest revision ever issued: the one the recipient sees and may answer. While N+1 is drafted N stays
/// answerable; issuing N+1 supersedes N, and an answer to N discards the draft.
pub fn live_revision(o: Offer) -> Option(Revision) {
  list.fold(o.revisions, None, fn(best, r) {
    case was_issued(r.row), best {
      False, _ -> best
      True, None -> Some(r)
      True, Some(b) ->
        case r.row.revision_number > b.row.revision_number {
          True -> Some(r)
          False -> best
        }
    }
  })
}

pub fn live_status(o: Offer, now: Int) -> Option(OfferStatus) {
  live_revision(o) |> option.map(fn(r) { effective(r.row, now) })
}

pub fn status(o: Offer, now: Int) -> Option(OfferStatus) {
  current_revision(o) |> option.map(fn(r) { effective(r.row, now) })
}

/// A refusal of the Offer contract: its code, message and the public fields it carries.
pub type Refusal {
  Refusal(error: String, message: String, fields: List(#(String, Json)))
}

fn refusal(error: String, message: String) -> Refusal {
  Refusal(error, message, [])
}

pub fn can_revise(o: Offer, now: Int) -> Result(OfferStatus, Refusal) {
  case status(o, now) {
    None ->
      Error(refusal("OFFER_STATE_UNKNOWN", "This Offer cannot be revised."))
    Some(Draft) ->
      Error(refusal(
        "OFFER_STATE_INVALID",
        "This Offer already has a draft revision. Edit it or withdraw it.",
      ))
    Some(Accepted) ->
      Error(refusal(
        "OFFER_STATE_INVALID",
        "An accepted Offer is not revised. A contract workflow, or an explicit withdrawal and restart, owns what happens next.",
      ))
    Some(st) ->
      case list.length(o.revisions) >= limit_revisions {
        True ->
          Error(refusal(
            "OFFER_STATE_INVALID",
            "An Offer carries at most "
              <> int.to_string(limit_revisions)
              <> " revisions.",
          ))
        False -> Ok(st)
      }
  }
}

pub fn can_respond(
  o: Offer,
  revision_id: String,
  now: Int,
) -> Result(Revision, Refusal) {
  case
    list.find(o.revisions, fn(r) {
      id.offer_revision_to_string(r.row.id) == revision_id
    })
  {
    Error(Nil) ->
      Error(refusal("OFFER_NOT_FOUND", "This revision cannot be answered."))
    Ok(rev) ->
      case was_issued(rev.row) {
        False ->
          Error(refusal(
            "OFFER_STATE_INVALID",
            "This Offer has not been issued.",
          ))
        True -> {
          let st = effective(rev.row, now)
          case st {
            _ if st == Superseded || rev.row.superseded_by_revision_id != None ->
              Error(refusal(
                "OFFER_SUPERSEDED",
                "This revision was replaced by a later one. Answer the current revision.",
              ))
            Withdrawn ->
              Error(refusal("OFFER_WITHDRAWN", "The club withdrew this Offer."))
            Expired ->
              Error(refusal("OFFER_EXPIRED", "This Offer has expired."))
            _
              if st == Accepted || st == Declined || rev.row.response_id != None
            ->
              Error(refusal(
                "OFFER_ALREADY_RESPONDED",
                "This revision already has an answer.",
              ))
            _ ->
              case live_revision(o) {
                Some(live) if live.row.id == rev.row.id -> Ok(rev)
                _ ->
                  Error(refusal(
                    "OFFER_SUPERSEDED",
                    "This revision is not the current one.",
                  ))
              }
          }
        }
      }
  }
}

pub fn can_withdraw(
  o: Offer,
  now: Int,
) -> Result(#(Revision, OfferStatus), Refusal) {
  case current_revision(o) {
    None ->
      Error(refusal("OFFER_STATE_UNKNOWN", "This Offer cannot be withdrawn."))
    Some(rev) ->
      case effective(rev.row, now) {
        Draft -> Ok(#(rev, Draft))
        Issued -> Ok(#(rev, Issued))
        Accepted ->
          Error(refusal(
            "OFFER_ALREADY_RESPONDED",
            "The recipient has already accepted this Offer; it cannot be withdrawn as if unanswered.",
          ))
        Declined ->
          Error(refusal(
            "OFFER_ALREADY_RESPONDED",
            "The recipient has already declined this Offer.",
          ))
        st ->
          Error(
            Refusal(
              "OFFER_STATE_INVALID",
              "A revision that is " <> status_label(st) <> " is not withdrawn.",
              [
                #(
                  "current",
                  json.object([#("status", offer_status.to_json(st))]),
                ),
              ],
            ),
          )
      }
  }
}

/// Who answered. A guardian is never written as the player.
pub type Responder {
  Responder(kind: party.Party, actor_id: String, player_id: id.PlayerId)
}

/// Matches the recipient snapshotted at issue; the route re-checks the live recipient rule.
pub fn responder_matches(r: revision_row.Row, who: Responder) -> Bool {
  case r.recipient_type, r.recipient_player_id {
    Some(kind), Some(player) if player == who.player_id && kind == who.kind ->
      case kind {
        party.Guardian ->
          option.map(r.recipient_guardian_id, id.guardian_to_string)
          == Some(who.actor_id)
        party.Player -> who.actor_id == id.player_to_string(who.player_id)
      }
    _, _ -> False
  }
}

pub fn next_revision_number(o: Offer) -> Int {
  list.fold(o.revisions, 0, fn(m, r) { int.max(m, r.row.revision_number) }) + 1
}

// ------------------------------------------------------------------------------------------------ integrity

/// Structural integrity of a stored Offer, so a route refuses a corrupt row. Never repairs. The tables' types
/// and CHECKs rule out most of what the TypeScript rule checks (an unknown status, a missing id); what remains
/// is the relations between rows.
pub fn integrity(
  o: Offer,
  org_id: Option(id.OrgId),
  case_id: Option(id.RecruitmentCaseId),
) -> List(String) {
  let issued_like = fn(s) {
    list.contains([Issued, Accepted, Declined, Superseded, Expired], s)
  }
  let revision_problems =
    list.flat_map(o.revisions, fn(rev) {
      let r = rev.row
      let issued = issued_like(r.status)
      let before = fn(a: Option(Int), b: Option(Int)) {
        case a, b {
          Some(a), Some(b) -> a < b
          _, _ -> False
        }
      }
      list.flatten([
        case r.revision_number < 1 {
          True -> ["revision_number"]
          False -> []
        },
        case issued && r.issued_at == None {
          True -> ["issued_at"]
          False -> []
        },
        case issued && r.expires_at == None {
          True -> ["expires_at"]
          False -> []
        },
        case r.status == Withdrawn && r.withdrawn_at == None {
          True -> ["withdrawn_at"]
          False -> []
        },
        case before(r.issued_at, Some(r.created_at)) {
          True -> ["issued_before_created"]
          False -> []
        },
        case r.issued_at, r.responded_at {
          Some(_), Some(_) ->
            case before(r.responded_at, r.issued_at) {
              True -> ["responded_before_issued"]
              False -> []
            }
          _, _ -> []
        },
        case before(r.withdrawn_at, Some(r.created_at)) {
          True -> ["withdrawn_before_created"]
          False -> []
        },
        case issued, r.issued_at, r.expires_at {
          True, Some(i), Some(x) if x > i + max_expiry_ms + day_ms -> [
            "expiry_out_of_bounds",
          ]
          _, _, _ -> []
        },
        case issued, r.issued_at, r.expires_at {
          True, Some(i), Some(x) if x < i -> ["expired_before_issued"]
          _, _, _ -> []
        },
        case r.status == Accepted || r.status == Declined {
          True ->
            case list.any(o.responses, fn(x) { x.revision_id == r.id }) {
              True -> []
              False -> ["response"]
            }
          False -> []
        },
      ])
    })
  let numbers = list.map(o.revisions, fn(r) { r.row.revision_number })
  let current_problems = case current_revision(o) {
    None -> ["current_revision"]
    Some(cur) ->
      case
        list.any(o.revisions, fn(r) {
          r.row.id != cur.row.id
          && r.row.revision_number > cur.row.revision_number
          && r.row.status != Withdrawn
        })
      {
        True -> ["current_revision_not_latest"]
        False -> []
      }
  }
  let response_ids = list.map(o.responses, fn(x) { x.revision_id })
  list.flatten([
    case mismatch(org_id, o.row.org_id) {
      True -> ["org_mismatch"]
      False -> []
    },
    case mismatch(case_id, o.row.case_id) {
      True -> ["case_mismatch"]
      False -> []
    },
    case o.revisions {
      [] -> ["revisions"]
      _ -> []
    },
    case list.length(list.unique(numbers)) != list.length(numbers) {
      True -> ["revision_number"]
      False -> []
    },
    revision_problems,
    current_problems,
    case list.length(list.unique(response_ids)) != list.length(response_ids) {
      True -> ["duplicate_response"]
      False -> []
    },
  ])
}

fn mismatch(want: Option(a), have: a) -> Bool {
  case want {
    Some(w) -> w != have
    None -> False
  }
}

/// Readings of the case and the Offer that cannot both be true are corruption; a case moved away from offer_made
/// while a revision is out is only a warning.
pub fn case_consistency(
  o: Offer,
  case_status: Option(RoomStatus),
  now: Int,
) -> List(String) {
  let live = live_status(o, now)
  list.flatten([
    case live, case_status {
      Some(Accepted), Some(room_status.OfferDeclined) -> [
        "ACCEPTED_BUT_CASE_DECLINED",
      ]
      _, _ -> []
    },
    case live, case_status {
      Some(Declined), Some(room_status.OfferAccepted) -> [
        "DECLINED_BUT_CASE_ACCEPTED",
      ]
      _, _ -> []
    },
    case live, case_status {
      Some(Issued), Some(room_status.OfferMade) -> []
      Some(Issued), _ -> ["LIVE_OFFER_CASE_NOT_AT_OFFER_MADE"]
      _, _ -> []
    },
  ])
}

pub fn case_corrupt(problems: List(String)) -> Bool {
  list.any(problems, fn(p) {
    p == "ACCEPTED_BUT_CASE_DECLINED" || p == "DECLINED_BUT_CASE_ACCEPTED"
  })
}

// ------------------------------------------------------------------------------------------------- evidence

/// What the evidence provider answers for an Offer kind.
pub type Evidence {
  Satisfied(source_id: id.OfferId, revision_id: id.OfferRevisionId)
  Unsatisfied(reason: String)
}

pub type EvidenceKind {
  OfferSent
  AcceptedByRecipient
  DeclinedByRecipient
}

/// offer_sent: the live revision is ISSUED and unexpired, or was answered. accepted / declined by recipient: the
/// live revision is ACCEPTED / DECLINED with a response row from the snapshotted recipient.
pub fn evidence(
  offers: List(Offer),
  org_id: id.OrgId,
  case_id: id.RecruitmentCaseId,
  player_id: id.PlayerId,
  kind: EvidenceKind,
  now: Int,
) -> Evidence {
  let own =
    list.filter_map(offers, fn(o) {
      case
        o.row.case_id == case_id
        && o.row.org_id == org_id
        && o.row.player_id == player_id
        && integrity(o, Some(org_id), Some(case_id)) == []
      {
        False -> Error(Nil)
        True ->
          case live_revision(o) {
            Some(rev) -> Ok(#(o, rev, effective(rev.row, now)))
            None -> Error(Nil)
          }
      }
    })
  let hit = fn(found: Result(#(Offer, Revision, OfferStatus), Nil), reason) {
    case found {
      Ok(#(o, rev, _)) -> Satisfied(o.row.id, rev.row.id)
      Error(Nil) -> Unsatisfied(reason)
    }
  }
  case kind {
    OfferSent ->
      list.find(own, fn(x) { list.contains([Issued, Accepted, Declined], x.2) })
      |> hit("no_issued_offer")
    AcceptedByRecipient | DeclinedByRecipient -> {
      let #(want, response, reason) = case kind {
        AcceptedByRecipient -> #(
          Accepted,
          response_row.Accepted,
          "no_recipient_acceptance",
        )
        _ -> #(Declined, response_row.Declined, "no_recipient_decline")
      }
      list.find(own, fn(x) {
        let #(o, rev, st) = x
        st == want
        && list.any(o.responses, fn(r) {
          r.revision_id == rev.row.id
          && r.response_type == response
          && responder_matches(
            rev.row,
            Responder(r.actor_type, r.actor_id, o.row.player_id),
          )
        })
      })
      |> hit(reason)
    }
  }
}

// ---------------------------------------------------------------------------------------------------- views

fn actor_json(
  user: Option(id.OrgUserId),
  name: Option(String),
  role: Option(String),
) -> Json {
  case user, name, role {
    None, None, None -> json.null()
    _, _, _ ->
      json.object([
        #("kind", json.string("org")),
        #("name", json.nullable(name, json.string)),
      ])
  }
}

pub fn terms_json(r: revision_row.Row) -> Json {
  json.object([
    #("offerType", revision_row.term_offer_type_to_json(r.term_offer_type)),
    #("role", json.nullable(r.term_role, json.string)),
    #("squad", json.nullable(r.term_squad, json.string)),
    #("startDate", json.nullable(r.term_start_date, json.string)),
    #("endDate", json.nullable(r.term_end_date, json.string)),
    #("conditions", json.nullable(r.term_conditions, json.string)),
  ])
}

fn revision_base(
  rev: Revision,
  now: Int,
  documents: Bool,
) -> List(#(String, Json)) {
  let r = rev.row
  let st = effective(r, now)
  [
    #("id", id.offer_revision_json(r.id)),
    #("revisionNumber", json.int(r.revision_number)),
    #("status", offer_status.to_json(st)),
    #("storedStatus", offer_status.to_json(r.status)),
    #("statusLabel", json.string(status_label(st))),
    #("terms", terms_json(r)),
    #("recipientMessage", json.nullable(r.recipient_message, json.string)),
    #(
      "documents",
      json.array(
        case documents {
          True -> rev.documents
          False -> []
        },
        fn(d) {
          json.object([
            #("id", id.offer_document_json(d.id)),
            #("label", json.nullable(d.label, json.string)),
          ])
        },
      ),
    ),
    #("expiresAt", json.nullable(r.expires_at, json.int)),
    #("issuedAt", json.nullable(r.issued_at, json.int)),
    #("createdAt", json.int(r.created_at)),
    #(
      "supersedesRevisionId",
      json.nullable(r.supersedes_revision_id, id.offer_revision_json),
    ),
    #(
      "supersededByRevisionId",
      json.nullable(r.superseded_by_revision_id, id.offer_revision_json),
    ),
    #("withdrawnAt", json.nullable(r.withdrawn_at, json.int)),
    #("respondedAt", json.nullable(r.responded_at, json.int)),
    #("rev", json.int(r.rev)),
  ]
}

fn club_revision_extra(r: revision_row.Row) -> List(#(String, Json)) {
  [
    #("internalNote", json.nullable(r.internal_note, json.string)),
    #(
      "issuedBy",
      actor_json(r.issued_by_user_id, r.issued_by_name, r.issued_by_role),
    ),
    #(
      "createdBy",
      actor_json(r.created_by_user_id, r.created_by_name, r.created_by_role),
    ),
    #(
      "withdrawnBy",
      actor_json(
        r.withdrawn_by_user_id,
        r.withdrawn_by_name,
        r.withdrawn_by_role,
      ),
    ),
    #("withdrawReason", json.nullable(r.withdraw_reason, json.string)),
  ]
}

pub fn readiness_json(r: revision_row.Row) -> Json {
  case
    r.readiness_transaction_id,
    r.readiness_evaluated_at,
    r.readiness_status,
    r.readiness_blockers_json
  {
    None, None, None, None -> json.null()
    tx, at, st, blockers ->
      json.object([
        #("transactionId", json.nullable(tx, json.string)),
        #("evaluatedAt", json.nullable(at, json.int)),
        #("status", json.nullable(st, json.string)),
        #(
          "blockers",
          blockers
            |> option.then(fn(t) { json_text.parse(t) |> option.from_result })
            |> option.unwrap(json.preprocessed_array([])),
        ),
      ])
  }
}

/// The lifecycle record an Offer act left, as stored.
pub fn lifecycle_json(row: offer_row.Row) -> Json {
  case row.lifecycle_applied {
    None -> json.null()
    Some(applied) ->
      json.object(
        list.flatten([
          [
            #("applied", json.bool(applied)),
            #("action", json.nullable(row.lifecycle_action, json.string)),
            #("from", json.nullable(row.lifecycle_from, json.string)),
            #("to", json.nullable(row.lifecycle_to, json.string)),
            #("at", json.nullable(row.lifecycle_at, json.int)),
          ],
          case row.lifecycle_reason {
            Some(r) -> [#("reason", json.string(r))]
            None -> []
          },
          case row.lifecycle_message {
            Some(m) -> [#("message", json.string(m))]
            None -> []
          },
          case row.lifecycle_allowed_json {
            Some(text) ->
              case json_text.parse(text) {
                Ok(v) -> [#("allowed", v)]
                Error(Nil) -> []
              }
            None -> []
          },
        ]),
      )
  }
}

fn by_number(a: Revision, b: Revision) -> order.Order {
  int.compare(a.row.revision_number, b.row.revision_number)
}

fn nullable_status(s: Option(OfferStatus)) -> Json {
  json.nullable(s, offer_status.to_json)
}

fn label_of(s: Option(OfferStatus)) -> Json {
  json.nullable(option.map(s, status_label), json.string)
}

const club_honest =
  "An Offer is the club's proposal, issued as an exact revision. An acceptance in ScoutBox is the recipient saying yes to that revision; it is not a signing, not a registration and not an executed contract."

/// The club's view, including the internal note and provenance references. Not ported yet: the signing package
/// an accepted Offer opens, so `signing` is always null (nothing is inferred).
pub fn club_view(o: Offer, now: Int) -> List(#(String, Json)) {
  let st = status(o, now)
  let live = live_status(o, now)
  [
    #("id", id.offer_json(o.row.id)),
    #("caseId", id.recruitment_case_json(o.row.case_id)),
    #("playerId", id.player_json(o.row.player_id)),
    #("orgId", id.org_json(o.row.org_id)),
    #("type", offer_row.type_to_json(o.row.type_)),
    #("status", nullable_status(st)),
    #("statusLabel", label_of(st)),
    #("currentRevisionId", id.offer_revision_json(o.row.current_revision_id)),
    #(
      "liveRevisionId",
      json.nullable(
        live_revision(o) |> option.map(fn(r) { r.row.id }),
        id.offer_revision_json,
      ),
    ),
    #("liveStatus", nullable_status(live)),
    #("awaitingResponse", json.bool(live == Some(Issued))),
    #("currentRevision", case current_revision(o) {
      None -> json.null()
      Some(cur) ->
        json.object(
          list.flatten([
            revision_base(cur, now, True),
            club_revision_extra(cur.row),
            [
              #("recipient", case cur.row.recipient_type {
                None -> json.null()
                Some(t) ->
                  json.object([
                    #("type", party.to_json(t)),
                    #("minor", json.bool(cur.row.recipient_minor == Some(True))),
                  ])
              }),
              #("readiness", readiness_json(cur.row)),
            ],
          ]),
        )
    }),
    #(
      "revisions",
      json.array(list.sort(o.revisions, by_number), fn(r) {
        json.object(list.append(
          revision_base(r, now, True),
          club_revision_extra(r.row),
        ))
      }),
    ),
    #(
      "responses",
      json.array(o.responses, fn(x) {
        json.object([
          #("id", id.offer_response_json(x.id)),
          #("revisionId", id.offer_revision_json(x.revision_id)),
          #("responseType", response_row.response_type_to_json(x.response_type)),
          #("actorType", party.to_json(x.actor_type)),
          #("forPlayerId", id.player_json(x.for_player_id)),
          #("occurredAt", json.int(x.occurred_at)),
          #("reason", json.nullable(x.reason, json.string)),
        ])
      }),
    ),
    #("firstViewedAt", json.nullable(first_viewed(o), json.int)),
    #("agentShared", json.bool(o.row.agent_share_user_id != None)),
    #("decisionId", json.nullable(o.row.decision_id, id.room_decision_json)),
    #("transactionId", json.nullable(o.row.transaction_id, json.string)),
    #("lifecycle", lifecycle_json(o.row)),
    #("createdAt", json.int(o.row.created_at)),
    #("updatedAt", json.int(o.row.updated_at)),
    #("rev", json.int(o.row.rev)),
    #("policyVersion", json.int(policy_version)),
    #("honest", json.string(club_honest)),
    #("signing", json.null()),
  ]
}

fn first_viewed(o: Offer) -> Option(Int) {
  list.fold(o.receipts, None, fn(m, r) {
    case m {
      None -> Some(r.first_viewed_at)
      Some(m) -> Some(int.min(m, r.first_viewed_at))
    }
  })
}

fn issued_sorted(o: Offer) -> List(Revision) {
  o.revisions
  |> list.filter(fn(r) { was_issued(r.row) })
  |> list.sort(by_number)
}

const recipient_honest =
  "Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here."

/// The recipient's view: never the internal note, a draft, the decision or transaction reference, or readiness.
/// A paused or moved case cannot be answered; the recipient is told so instead of hitting a 409.
pub fn recipient_view(
  o: Offer,
  now: Int,
  org_name: Option(String),
  case_open: Bool,
) -> List(#(String, Json)) {
  let live = live_revision(o)
  let st = live |> option.map(fn(r) { effective(r.row, now) })
  let answerable = st == Some(Issued) && case_open
  [
    #("id", id.offer_json(o.row.id)),
    #("playerId", id.player_json(o.row.player_id)),
    #(
      "club",
      json.object([
        #("id", id.org_json(o.row.org_id)),
        #("name", json.nullable(org_name, json.string)),
      ]),
    ),
    #("type", offer_row.type_to_json(o.row.type_)),
    #("status", nullable_status(st)),
    #("statusLabel", label_of(st)),
    #(
      "currentRevisionId",
      json.nullable(
        live |> option.map(fn(r) { r.row.id }),
        id.offer_revision_json,
      ),
    ),
    #("currentRevision", case live {
      Some(r) -> json.object(revision_base(r, now, True))
      None -> json.null()
    }),
    #(
      "revisions",
      json.array(issued_sorted(o), fn(r) {
        json.object(revision_base(r, now, True))
      }),
    ),
    #("awaitingYourResponse", json.bool(answerable)),
    #("answerable", json.bool(answerable)),
    #("notAnswerableReason", case st == Some(Issued) && !case_open {
      True -> json.string("CASE_PAUSED")
      False -> json.null()
    }),
    #("responses", recipient_responses(o)),
    #("agentShared", json.bool(o.row.agent_share_user_id != None)),
    #("policyVersion", json.int(policy_version)),
    #("honest", json.string(recipient_honest)),
    #("signing", json.null()),
  ]
}

fn recipient_responses(o: Offer) -> Json {
  json.array(o.responses, fn(x) {
    json.object([
      #("id", id.offer_response_json(x.id)),
      #("revisionId", id.offer_revision_json(x.revision_id)),
      #("responseType", response_row.response_type_to_json(x.response_type)),
      #("actorType", party.to_json(x.actor_type)),
      #("occurredAt", json.int(x.occurred_at)),
    ])
  })
}

const agent_honest =
  "Your client shared this Offer with you. Accepting or declining is your client's own act; ScoutBox does not let you answer on their behalf, and nothing here is a negotiation, a fee or a signing."

/// The agent's view of an Offer the client shared: never the internal note or documents.
pub fn agent_view(
  o: Offer,
  now: Int,
  org_name: Option(String),
) -> List(#(String, Json)) {
  let live = live_revision(o)
  let st = live |> option.map(fn(r) { effective(r.row, now) })
  [
    #("id", id.offer_json(o.row.id)),
    #("clientId", id.player_json(o.row.player_id)),
    #(
      "club",
      json.object([
        #("id", id.org_json(o.row.org_id)),
        #("name", json.nullable(org_name, json.string)),
      ]),
    ),
    #("type", offer_row.type_to_json(o.row.type_)),
    #("status", nullable_status(st)),
    #("statusLabel", label_of(st)),
    #("currentRevision", case live {
      Some(r) -> json.object(revision_base(r, now, False))
      None -> json.null()
    }),
    #(
      "revisions",
      json.array(issued_sorted(o), fn(r) {
        json.object(revision_base(r, now, False))
      }),
    ),
    #("awaitingClientResponse", json.bool(st == Some(Issued))),
    #("responses", recipient_responses(o)),
    #("sharedAt", json.nullable(o.row.agent_share_at, json.int)),
    #("honest", json.string(agent_honest)),
    #("signing", json.null()),
  ]
}

/// The numeric suffix of an id (`aud-1042` → 1042) breaks ties within a millisecond.
fn seq(text: String) -> Int {
  string.split(text, "-")
  |> list.last
  |> result.try(int.parse)
  |> result.unwrap(0)
}

/// The history, oldest first: ids, states, times, actor kind and name only. A recipient never sees draft or
/// internal entries.
pub fn history_view(o: Offer, for_recipient: Bool) -> List(Json) {
  o.history
  |> list.sort(fn(a, b) {
    case int.compare(a.at, b.at) {
      order.Eq ->
        int.compare(
          seq(id.offer_event_to_string(a.id)),
          seq(id.offer_event_to_string(b.id)),
        )
      other -> other
    }
  })
  |> list.filter(fn(h) {
    !for_recipient
    || !{
      string.contains(h.action, "draft")
      || string.contains(h.action, "internal")
    }
  })
  |> list.map(fn(h) {
    json.object([
      #("id", id.offer_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("by", case h.by_kind, h.by_id, h.by_name {
        None, None, None -> json.null()
        kind, _, name ->
          json.object([
            #("kind", json.nullable(kind, event_row.by_kind_to_json)),
            #("name", json.nullable(name, json.string)),
          ])
      }),
      #("revisionId", detail_text(h.detail_json, "revisionId")),
    ])
  })
}

fn detail_text(detail: Option(String), key: String) -> Json {
  detail
  |> option.then(fn(text) {
    json.parse(text, decode.at([key], decode.string)) |> option.from_result
  })
  |> json.nullable(json.string)
}

// ---------------------------------------------------------------------------------------------------- input

/// Text as an Offer stores it: control, directional and zero-width characters stripped (they let a message read
/// differently from what was typed), line breaks folded for a one-line field, trimmed; empty is nothing.
pub fn clean_text(raw: Option(String), one_line: Bool) -> Option(String) {
  case raw {
    None -> None
    Some(s) -> {
      let kept =
        string.to_utf_codepoints(s)
        |> list.filter(fn(cp) { !stripped(string.utf_codepoint_to_int(cp)) })
        |> string.from_utf_codepoints
      let folded = case one_line {
        True -> fold_lines(kept)
        False -> kept
      }
      case js_trim(folded) {
        "" -> None
        t -> Some(t)
      }
    }
  }
}

fn stripped(c: Int) -> Bool {
  { c >= 0x00 && c <= 0x08 }
  || c == 0x0B
  || c == 0x0C
  || { c >= 0x0E && c <= 0x1F }
  || c == 0x7F
  || { c >= 0x200B && c <= 0x200F }
  || { c >= 0x202A && c <= 0x202E }
  || { c >= 0x2060 && c <= 0x2064 }
  || { c >= 0x2066 && c <= 0x2069 }
  || c == 0xFEFF
}

/// `[\r\n]+` becomes one space.
fn fold_lines(s: String) -> String {
  string.to_graphemes(s)
  |> list.fold(#("", False), fn(acc, g) {
    let #(out, in_break) = acc
    case g == "\r" || g == "\n" || g == "\r\n" {
      True ->
        case in_break {
          True -> #(out, True)
          False -> #(out <> " ", True)
        }
      False -> #(out <> g, False)
    }
  })
  |> fn(acc) { acc.0 }
}

/// JavaScript's `trim`: whitespace and line terminators at both ends.
pub fn js_trim(s: String) -> String {
  string.trim(s)
}

/// The cleaned text of a field, or the refusal for one that is too long.
fn clean_field(
  error: String,
  field: String,
  raw: Option(String),
  max: Int,
  one_line: Bool,
) -> Result(Option(String), Refusal) {
  let cleaned = clean_text(raw, one_line)
  case cleaned {
    Some(t) ->
      case input.utf16_length(t) > max {
        True ->
          Error(
            Refusal(
              error,
              field
                <> " must be at most "
                <> int.to_string(max)
                <> " characters.",
              [
                #("field", json.string(field)),
                #("problem", json.string("too_long")),
                #("max", json.int(max)),
              ],
            ),
          )
        False -> Ok(cleaned)
      }
    None -> Ok(None)
  }
}

/// The terms as sent: each field's shape is already judged by the route's schema.
pub type TermsInput {
  TermsInput(
    role: Option(String),
    squad: Option(String),
    conditions: Option(String),
    start_date: Option(String),
    end_date: Option(String),
  )
}

pub const no_terms = TermsInput(None, None, None, None, None)

/// The terms' schema (`OfferTerms`): a strict object, each field nullish; `offerType` is the one type there is.
pub fn terms_shape() -> input.Shape(TermsInput) {
  use _ <- input.field(
    "offerType",
    input.nullish(input.one_of([#("direct_recruitment", Nil)])),
  )
  use role <- input.field("role", input.nullish(input.text(1_000_000)))
  use squad <- input.field("squad", input.nullish(input.text(1_000_000)))
  use conditions <- input.field(
    "conditions",
    input.nullish(input.text(1_000_000)),
  )
  use start_date <- input.field(
    "startDate",
    input.nullish(input.day_or_blank()),
  )
  use end_date <- input.field("endDate", input.nullish(input.day_or_blank()))
  input.done(TermsInput(
    role:,
    squad:,
    conditions:,
    start_date: option.flatten(start_date),
    end_date: option.flatten(end_date),
  ))
}

/// The terms cleaned and checked (validateTerms): text lengths, the end after the start, and at issue a start day.
pub fn validate_terms(
  t: TermsInput,
  require_complete: Bool,
) -> Result(Terms, Refusal) {
  let code = "OFFER_TERMS_INVALID"
  use role <- result.try(clean_field(
    code,
    "terms.role",
    t.role,
    limit_role,
    True,
  ))
  use squad <- result.try(clean_field(
    code,
    "terms.squad",
    t.squad,
    limit_squad,
    True,
  ))
  use conditions <- result.try(clean_field(
    code,
    "terms.conditions",
    t.conditions,
    limit_conditions,
    False,
  ))
  let field_refusal = fn(field, problem, message) {
    Error(
      Refusal(code, message, [
        #("field", json.string(field)),
        #("problem", json.string(problem)),
      ]),
    )
  }
  let ends_first = case t.start_date, t.end_date {
    Some(s), Some(e) -> string.compare(s, e) != order.Lt
    _, _ -> False
  }
  case t.start_date, t.end_date {
    Some(_), Some(_) if ends_first ->
      field_refusal(
        "terms.endDate",
        "invalid",
        "The end date must be after the start date.",
      )
    None, _ if require_complete ->
      field_refusal(
        "terms.startDate",
        "required",
        "An issued Offer names the day it would start.",
      )
    _, _ ->
      Ok(Terms(
        role:,
        squad:,
        start_date: t.start_date,
        end_date: t.end_date,
        conditions:,
      ))
  }
}

/// A stored revision's terms, as validateTerms would read them back.
pub fn stored_terms_input(r: revision_row.Row) -> TermsInput {
  TermsInput(
    role: r.term_role,
    squad: r.term_squad,
    conditions: r.term_conditions,
    start_date: r.term_start_date,
    end_date: r.term_end_date,
  )
}

pub type Messages {
  Messages(recipient_message: Option(String), internal_note: Option(String))
}

pub fn validate_messages(
  recipient_message: Option(String),
  internal_note: Option(String),
) -> Result(Messages, Refusal) {
  let code = "OFFER_INPUT_INVALID"
  use m <- result.try(clean_field(
    code,
    "recipientMessage",
    recipient_message,
    limit_recipient_message,
    False,
  ))
  use n <- result.map(clean_field(
    code,
    "internalNote",
    internal_note,
    limit_internal_note,
    False,
  ))
  Messages(m, n)
}

/// An instant with an explicit offset, or milliseconds; never the client's clock. `raw` is the value as sent
/// (absent, null and '' are no expiry).
pub fn validate_expiry(
  raw: Option(Dynamic),
  now: Option(Int),
  required: Bool,
) -> Result(Option(Int), Refusal) {
  let bad = fn(problem, message, extra) {
    Error(
      Refusal("OFFER_EXPIRY_INVALID", message, [
        #("field", json.string("expiresAt")),
        #("problem", json.string(problem)),
        ..extra
      ]),
    )
  }
  let absent = case raw {
    None -> True
    Some(v) ->
      dynamic.classify(v) == "Nil" || decode.run(v, decode.string) == Ok("")
  }
  case absent, raw {
    True, _ ->
      case required {
        True -> bad("required", "An issued Offer needs an expiry.", [])
        False -> Ok(None)
      }
    False, None -> Ok(None)
    False, Some(v) ->
      case parse_instant(v) {
        Error(why) ->
          bad(
            "not_a_timestamp",
            "expiresAt must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp ("
              <> why
              <> ").",
            [
              #(
                "expected",
                json.string(
                  "ISO 8601 with offset or Z, or integer milliseconds",
                ),
              ),
            ],
          )
        Ok(ms) ->
          case now {
            Some(now) if ms < now + min_expiry_ms ->
              bad(
                "too_small",
                "An Offer must stay open for at least an hour after it is issued.",
                [#("min", json.int(now + min_expiry_ms))],
              )
            Some(now) if ms > now + max_expiry_ms ->
              bad(
                "too_large",
                "An Offer cannot stay open for more than 180 days.",
                [#("max", json.int(now + max_expiry_ms))],
              )
            _ -> Ok(Some(ms))
          }
      }
  }
}

/// parseInstant: a whole number of milliseconds, or ISO 8601 text with an offset.
fn parse_instant(v: Dynamic) -> Result(Int, String) {
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> Ok(n)
    _, Ok(_) -> Error("not a whole number")
    _, _ ->
      case decode.run(v, decode.string) {
        Ok(s) -> temporal.instant_ms(s)
        Error(_) -> Error("wrong shape")
      }
  }
}

/// A document reference as sent: an evidence vault record by id, with a label.
pub type DocumentRef {
  DocumentRef(evidence_id: String, label: Option(String))
}

pub fn document_shape() -> input.Check(DocumentRef) {
  input.object({
    use evidence_id <- input.field(
      "evidenceId",
      input.required(input.required_text(80)),
    )
    use label <- input.field("label", input.nullish(input.text(1_000_000)))
    input.done(DocumentRef(evidence_id:, label:))
  })
}

/// References trimmed, each named once, with labels cleaned.
pub fn validate_documents(
  refs: Option(List(DocumentRef)),
) -> Result(Option(List(DocumentRef)), Refusal) {
  case refs {
    None -> Ok(None)
    Some(refs) ->
      list.index_fold(refs, Ok([]), fn(acc, d, i) {
        use out <- result.try(acc)
        let doc_id = js_trim(d.evidence_id)
        let at = "documents[" <> int.to_string(i) <> "]"
        case list.any(out, fn(x: DocumentRef) { x.evidence_id == doc_id }) {
          True ->
            Error(
              Refusal("OFFER_DOCUMENT_INVALID", "A document appears twice.", [
                #("field", json.string(at <> ".evidenceId")),
                #("problem", json.string("invalid")),
              ]),
            )
          False -> {
            use label <- result.map(clean_field(
              "OFFER_DOCUMENT_INVALID",
              at <> ".label",
              d.label,
              limit_document_label,
              True,
            ))
            [DocumentRef(doc_id, label), ..out]
          }
        }
      })
      |> result.map(fn(out) { Some(list.reverse(out)) })
  }
}
