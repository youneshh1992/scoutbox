//// The recruitment journey projection for the club (domains/recruitment/lifecycle/journey.mjs and
//// journeyModel.mjs): one case's records arranged for its organisation, computed on read. There is no score,
//// probability or progress percentage: how far a case has travelled is a fact about a club's process, not a
//// measurement of a person.
////
//// TypeScript's projection has a Trust & Safety viewer too, but no route builds that viewer, so it isn't here.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/identity/orgs
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/contact_rules.{type Contact}
import scoutbox/recruitment/contacts
import scoutbox/recruitment/decisions
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/recruitment/offers
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/recruitment/signing_packages
import scoutbox/recruitment/signing_rules
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/orgs as org_row
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/recruitment_contacts as contact_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/signing_packages as signing_pkg_row
import scoutbox/rows/signing_revision_parties as signing_party_row
import scoutbox/rows/signings as signing_row
import scoutbox/rows/trials as trial_row
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/offer_status
import scoutbox/vocab/party
import scoutbox/vocab/recruitment_actor_kind
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/signing_party_type
import scoutbox/vocab/trial_actor_kind
import scoutbox/vocab/trial_workflow_state

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
    /// The assessments the journey counts: never one in the context of another case's Trial (an ended case keeps
    /// its own, a later case inherits nothing).
    case_assessments: List(assessment_row.Row),
    offers: List(Offer),
    signings: List(signing_row.Row),
    /// The signing packages opened on this case for its club and player.
    packages: List(signing_rules.Package),
    requests: List(request_row.Row),
    /// The organisation's trials of the player, and the trials naming this case.
    trials: List(Trial),
    case_trials: List(Trial),
    /// The contacts naming this case.
    contacts: List(Contact),
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
  use rec <- result.try(load(read, room, blocked, player_present))
  use actions <- result.map(case_lifecycle.available(
    read,
    room,
    viewer.role,
    now,
  ))
  club(rec, viewer, paging, actions, now)
}

/// A Room's records, read once.
fn load(
  read: Read,
  room: Room,
  blocked: Bool,
  player_present: Bool,
) -> Result(Records, Fail(e)) {
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
  use player_trials <- result.try(trials.for_org_player(
    read,
    r.org_id,
    r.player_id,
  ))
  use case_trials <- result.try(trials.for_case(read, r.id))
  use case_contacts <- result.try(contacts.for_case(read, r.id))
  use case_packages <- result.try(signing_packages.for_case(read, r.id))
  // The TypeScript rule also compares the assessment's time with each sibling case's span, which never holds (see
  // owned_elsewhere): only a Trial context gives an assessment to another case.
  let case_assessments =
    list.filter(assessments, fn(a) {
      let trial_case =
        option.then(a.context_trial_id, fn(tid) {
          list.find(player_trials, fn(t) { id.trial_to_string(t.row.id) == tid })
          |> option.from_result
          |> option.then(fn(t) { t.row.case_id })
        })
      case trial_case {
        Some(c) -> c == r.id
        None -> True
      }
    })
  Ok(Records(
    room:,
    decisions: list.filter(all, fn(d) { d.base.row.org_id == r.org_id }),
    draft:,
    assessments:,
    case_assessments:,
    offers: list.filter(case_offers, fn(o) { o.row.org_id == r.org_id }),
    signings:,
    packages: list.filter(case_packages, fn(p) {
      p.row.org_id == r.org_id && p.row.player_id == r.player_id
    }),
    requests:,
    trials: player_trials,
    case_trials:,
    contacts: case_contacts,
    blocked:,
    player_present:,
  ))
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
  // Milestones only: never instructions, an address, a note, an observation or an assessment. A corrupt row is
  // omitted and counted.
  let #(listed_trials, trials_omitted) =
    list.fold(rec.trials, #([], 0), fn(acc, t) {
      case trial_rules.integrity(t, Some(r.org_id), t.row.case_id) {
        [] -> #([t, ..acc.0], acc.1)
        _ -> #(acc.0, acc.1 + 1)
      }
    })
  let listed_trials = list.reverse(listed_trials)
  // The model and timeline read this case's Trials only, the evidence provider's scope: a Trial from an earlier,
  // ended case is that case's history.
  let trial_rows =
    list.filter(listed_trials, fn(t) { t.row.case_id == Some(r.id) })
  let trial_ids = list.map(trial_rows, fn(t) { id.trial_to_string(t.row.id) })
  let trial_assessments =
    list.filter(rec.assessments, fn(a) {
      case a.context_trial_id {
        Some(tid) -> list.contains(trial_ids, tid)
        None -> False
      }
    })
  let corrupt_trials =
    list.count(rec.case_trials, fn(t) {
      t.row.case_id == Some(r.id)
      && t.row.org_id == r.org_id
      && trial_rules.integrity(t, Some(r.org_id), Some(r.id)) != []
    })
  // Milestones only: never a body, a summary or a reply. A corrupt record is omitted and counted.
  let #(sound_contacts, contacts_omitted) =
    list.fold(rec.contacts, #([], 0), fn(acc, c) {
      case c.row.case_id == r.id && c.row.org_id == r.org_id {
        False -> acc
        True ->
          case contact_rules.integrity(c, Some(r.org_id), Some(r.id)) {
            [] -> #([c, ..acc.0], acc.1)
            _ -> #(acc.0, acc.1 + 1)
          }
      }
    })
  let sound_contacts = list.reverse(sound_contacts)
  let contact_records =
    list.sort(sound_contacts, fn(a, b) {
      string.compare(
        id.contact_to_string(a.row.id),
        id.contact_to_string(b.row.id),
      )
    })
  let signing = supporting_signing(rec)
  let #(sound_packages, packages_corrupt) =
    list.partition(rec.packages, fn(p) {
      signing_rules.integrity(p, Some(r.org_id)) == []
    })
  let packages_corrupt = list.length(packages_corrupt)
  let assessed =
    list.any(rec.assessments, fn(a) { a.state != assessment_row.Draft })
  let total_history =
    timeline(
      rec,
      lines,
      trial_requests,
      trial_rows,
      trial_assessments,
      sound_offers,
      sound_packages,
      contact_records,
      now,
    )
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
        #(
          "trialActive",
          json.bool(
            status == room_status.TrialScheduled
            && list.any(listed_trials, fn(t) {
              t.row.status == trial_row.AwaitingReport
            }),
          ),
        ),
        #(
          "offerAwaitingResponse",
          json.bool(status == room_status.OfferMade && offer_awaiting),
        ),
        #("onHold", json.bool(status == room_status.OnHold)),
        #("terminal", json.bool(terminal)),
        #("reopenable", json.bool(reopenable)),
        #(
          "decisionOutstanding",
          json.bool(
            !terminal
            && current_formal == None
            && {
              assessed
              || list.any(listed_trials, fn(t) {
                trial_rules.workflow_state(t) == trial_workflow_state.Completed
              })
            },
          ),
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
        trial_rows,
        sound_contacts,
        sound_packages,
        signing,
        corrupt_offers + corrupt_trials + contacts_omitted + packages_corrupt,
        // The journey counts this case's assessments only; the workflow fact above counts the player's.
        list.any(rec.case_assessments, fn(a) { a.state != assessment_row.Draft }),
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
        #("contacts", json.array(contact_records, contact_rules.milestone)),
        #("omitted", json.int(contacts_omitted)),
      ]),
    ),
    #(
      "trials",
      json.array(listed_trials, fn(t) {
        json.object([
          #("id", id.trial_json(t.row.id)),
          #("status", trial_row.status_to_json(t.row.status)),
          #("proposedDate", json.nullable(t.row.proposed_date, json.string)),
          #("hasReport", json.bool(t.report != None)),
          #("workflow", json.object(trial_rules.milestone(t))),
        ])
      }),
    ),
    #("trialsOmitted", json.int(trials_omitted)),
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
                json.nullable(s.signing_package_id, id.signing_package_json),
              ),
            ])
          None -> json.null()
        }),
        // A case at `signed` with no package has none, and none is invented.
        #(
          "signingPackages",
          sound_packages
            |> json.array(fn(p) {
              json.object([
                #("id", id.signing_package_json(p.row.id)),
                #(
                  "status",
                  json.string(
                    signing_rules.status_name(signing_rules.effective_status(
                      p,
                      now,
                    )),
                  ),
                ),
                #(
                  "revisionNumber",
                  json.nullable(
                    signing_rules.current_revision(p)
                      |> option.map(fn(r) { r.row.revision_number }),
                    json.int,
                  ),
                ),
                #("offerId", id.offer_json(p.row.offer_id)),
                #(
                  "signingId",
                  json.nullable(p.row.completion_signing_id, id.signing_json),
                ),
              ])
            }),
        ),
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

/// The row a completed package of this case wrote and names back, or else the club's un-packaged signing row for
/// this player (supportingSigningRow).
fn supporting_signing(rec: Records) -> Option(signing_row.Row) {
  let packaged =
    list.find_map(rec.packages, fn(p) {
      case p.row.status, p.row.completion_signing_id {
        signing_pkg_row.Completed, Some(sid) -> {
          let mine = Some(p.row.id)
          list.find(rec.signings, fn(s) {
            s.id == sid && s.signing_package_id == mine
          })
        }
        _, _ -> Error(Nil)
      }
    })
  case packaged {
    Ok(s) -> Some(s)
    Error(Nil) ->
      list.find(rec.signings, fn(s) { s.signing_package_id == None })
      |> option.from_result
  }
}

fn stage_of(
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
fn current_contact(rows: List(Contact)) -> Option(Contact) {
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
fn current_trial(rows: List(Trial)) -> Option(Trial) {
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

fn ids(values: List(String)) -> Json {
  json.array(values, json.string)
}

fn journey_block(
  rec: Records,
  viewer: Viewer,
  status: RoomStatus,
  offers: List(Offer),
  trial_requests: List(request_row.Row),
  case_trials: List(Trial),
  case_contacts: List(Contact),
  packages: List(signing_rules.Package),
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
      list.filter(rec.case_assessments, fn(a) {
        a.state != assessment_row.Draft
      }),
      fn(a) { option.unwrap(a.submitted_at, a.created_at) },
      fn(a) { id.assessment_to_string(a.id) },
    )
    |> option.lazy_or(fn() {
      newest(
        list.filter(rec.case_assessments, fn(a) {
          a.state == assessment_row.Draft
        }),
        fn(a) { a.created_at },
        fn(a) { id.assessment_to_string(a.id) },
      )
    })
  let contact = current_contact(case_contacts)
  let trial = current_trial(case_trials)
  let head = current_decision(case_decisions)
  let decision = case head {
    Some(d) if d.base.row.kind == Some(decision_row.Formal) -> Some(d)
    _ -> None
  }
  let offer = current_offer(offers, now)
  let package = current_signing(packages, now)
  let opened = case package {
    Some(p) -> signing_rules.is_live(p, now)
    None -> False
  }
  let subject_removed = r.subject_removed_at != None || !rec.player_present
  let problems =
    validate(
      rec,
      status,
      offers,
      trial_requests,
      case_trials,
      case_contacts,
      case_decisions,
      packages,
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
      contact,
      trial,
      pending_trial_request,
      assessed,
      decision,
      offer,
      package,
      signing,
      classification == "integrity_error",
      now,
    )
  json.object([
    #("policyVersion", json.int(policy_version)),
    #("stage", json.string(stage_of(status, assessed, opened))),
    #(
      "completedStages",
      json.preprocessed_array(completed_stages(
        rec,
        status,
        case_contacts,
        case_trials,
        offers,
        case_decisions,
        packages,
        signing,
        now,
      )),
    ),
    #(
      "resources",
      json.object([
        #(
          "contactId",
          json.nullable(
            option.map(contact, fn(c) { c.row.id }),
            id.contact_json,
          ),
        ),
        #(
          "trialRequestId",
          json.nullable(
            option.map(pending_trial_request, fn(q) { q.id }),
            id.request_json,
          ),
        ),
        #(
          "trialId",
          json.nullable(option.map(trial, fn(t) { t.row.id }), id.trial_json),
        ),
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
        #(
          "signingPackageId",
          json.nullable(
            option.map(package, fn(p) { p.row.id }),
            id.signing_package_json,
          ),
        ),
        #(
          "completedSigningId",
          json.nullable(completed_signing_id(signing, package), id.signing_json),
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

/// The signing row the case's outcome rests on, else the one its current package names.
fn completed_signing_id(
  signing: Option(signing_row.Row),
  package: Option(signing_rules.Package),
) -> Option(id.SigningId) {
  option.map(signing, fn(s) { s.id })
  |> option.lazy_or(fn() {
    option.then(package, fn(p) { p.row.completion_signing_id })
  })
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
  case_contacts: List(Contact),
  case_trials: List(Trial),
  offers: List(Offer),
  case_decisions: List(decisions.Decision),
  packages: List(signing_rules.Package),
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
  let evidence_contact =
    case_contacts
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
      list.filter(case_trials, fn(t) {
        trial_rules.workflow_state(t) == trial_workflow_state.Completed
      }),
      fn(t) { option.unwrap(t.row.completion_at, 0) },
      fn(t) { id.trial_to_string(t.row.id) },
    )
  let assessed =
    newest(
      list.filter(rec.case_assessments, fn(a) {
        a.state != assessment_row.Draft
      }),
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
  let completed_package =
    newest(
      list.filter(packages, fn(p) {
        signing_rules.effective_status(p, now) == signing_rules.Completed
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
  case_trials: List(Trial),
  case_contacts: List(Contact),
  case_decisions: List(decisions.Decision),
  packages: List(signing_rules.Package),
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
  let contact_ids =
    list.map(case_contacts, fn(c) { id.contact_to_string(c.row.id) })
  let trial_ids = list.map(case_trials, fn(t) { id.trial_to_string(t.row.id) })
  let package_ids =
    list.map(packages, fn(p) { id.signing_package_to_string(p.row.id) })
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
    #(
      "contacted",
      list.any(case_contacts, fn(c) {
        contact_rules.is_evidence(c.row.status) && c.row.cancelled_at == None
      }),
    ),
    #("trial_requested", trial_requests != [] || case_trials != []),
    #(
      "trial_scheduled",
      list.any(case_trials, fn(t) {
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
      list.any(case_trials, fn(t) {
        trial_rules.workflow_state(t) == trial_workflow_state.Completed
      }),
    ),
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
  // The TypeScript reader hands each package at most one row (`signings.forPackage`), so a duplicate is never seen
  // here. Ported as it behaves.
  let domain =
    list.append(
      list.flat_map(offers, fn(o) {
        offer_rules.case_consistency(o, Some(status), now)
        |> list.filter(fn(c) { offer_rules.case_corrupt([c]) })
      }),
      list.flat_map(packages, fn(p) {
        let rows =
          list.find(rec.signings, fn(s) {
            s.signing_package_id == Some(p.row.id)
          })
          |> result.map(fn(s) { [s] })
          |> result.unwrap([])
        signing_rules.consistency(
          p,
          list.find(offers, fn(o) { o.row.id == p.row.offer_id })
            |> option.from_result,
          Some(room),
          rows,
          None,
          now,
        )
        |> list.filter(fn(c) { signing_rules.corrupt([c]) })
      }),
    )
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
      case
        {
          option.is_some(signing)
          || list.any(packages, fn(p) {
            signing_rules.effective_status(p, now) == signing_rules.Completed
          })
        }
        && status != room_status.Signed
        && live
      {
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
    "PRESENT_SIGNING" -> club_permission("signing", "signing", 2)
    "SIGN_FOR_CLUB" -> club_permission("signing", "signing", 3)
    "AWAIT_RECIPIENT_SIGNATURE" -> wait("signing", "signing")
    "COMPLETE_SIGNING" -> club_permission("signing", "signing", 3)
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
  contact: Option(Contact),
  trial: Option(Trial),
  trial_request: Option(request_row.Row),
  assessed: Bool,
  decision: Option(decisions.Decision),
  offer: Option(CurrentOffer),
  package: Option(signing_rules.Package),
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
  let trial_ref = #(
    "trialId",
    json.nullable(option.map(trial, fn(t) { t.row.id }), id.trial_json),
  )
  let decision_ref = #(
    "decisionId",
    json.nullable(
      option.map(decision, fn(d) { d.base.row.id }),
      id.room_decision_json,
    ),
  )
  let package_ref = fn(p: Option(signing_rules.Package)) {
    #(
      "signingPackageId",
      json.nullable(option.map(p, fn(p) { p.row.id }), id.signing_package_json),
    )
  }
  let offer_refs = case offer {
    Some(o) -> offer_ref(o)
    None -> [#("offerId", json.null()), #("offerRevisionId", json.null())]
  }
  let #(code, refs) = case status {
    room_status.Signed -> #("RECRUITMENT_COMPLETE", [
      #(
        "completedSigningId",
        json.nullable(completed_signing_id(signing, package), id.signing_json),
      ),
      package_ref(package),
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
    room_status.ContactPlanned -> #("SEND_CONTACT", [
      #("contactId", case contact {
        Some(c) if c.row.status == contact_row.Draft -> id.contact_json(c.row.id)
        _ -> json.null()
      }),
    ])
    room_status.Contacted ->
      case contact {
        Some(c) if c.row.status == contact_row.Delivered -> #(
          "AWAIT_CONTACT_RESPONSE",
          [#("contactId", id.contact_json(c.row.id))],
        )
        _ -> #("CONTINUE_EVALUATION", [
          #(
            "contactId",
            json.nullable(
              option.map(contact, fn(c) { c.row.id }),
              id.contact_json,
            ),
          ),
        ])
      }
    room_status.TrialRequested -> #("AWAIT_TRIAL_RESPONSE", [
      #(
        "trialRequestId",
        json.nullable(
          option.map(trial_request, fn(q) { q.id }),
          id.request_json,
        ),
      ),
    ])
    room_status.TrialScheduled -> {
      let last_end = case trial {
        Some(t) ->
          list.fold(t.sessions, 0, fn(m, x) { int.max(m, x.row.ends_at) })
        None -> 0
      }
      #(
        case last_end > 0 && last_end <= now {
          True -> "COMPLETE_TRIAL"
          False -> "CONDUCT_TRIAL"
        },
        [trial_ref],
      )
    }
    room_status.TrialCompleted ->
      case assessed, decision {
        False, _ -> #("COMPLETE_ASSESSMENT", [trial_ref])
        True, None -> #("RECORD_DECISION", [trial_ref])
        True, Some(_) -> #("RECORD_DECISION", [trial_ref, decision_ref])
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
    room_status.OfferAccepted -> {
      let live = case package {
        Some(p) -> signing_rules.is_live(p, now)
        None -> False
      }
      let refs = list.append(offer_refs, [package_ref(package)])
      case live, package {
        False, _ | _, None -> #(
          "START_SIGNING",
          list.append(offer_refs, [package_ref(None)]),
        )
        True, Some(p) -> {
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
          case signing_rules.effective_status(p, now) {
            signing_rules.Draft -> #("PRESENT_SIGNING", refs)
            _ ->
              case pending(True), pending(False) {
                True, _ -> #("SIGN_FOR_CLUB", refs)
                False, True -> #("AWAIT_RECIPIENT_SIGNATURE", refs)
                False, False -> #("COMPLETE_SIGNING", refs)
              }
          }
        }
      }
    }
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

/// Trial history actions that are milestones. Unlinking is housekeeping.
const trial_timeline_actions = [
  "trial_accepted", "trial_schedule_proposed", "trial_rescheduled",
  "trial_schedule_confirmed", "trial_schedule_declined",
  "trial_attendance_recorded", "trial_cancelled", "trial_completed",
  "trial_evidence_linked",
]

/// Signing history actions that are milestones.
const signing_timeline_actions = [
  "signing_created", "signing_ready", "signing_party_completed",
  "signing_completed", "signing_cancelled", "signing_voided",
  "signing_superseded",
]

/// The trial history detail fields a milestone carries.
type TrialDetail {
  TrialDetail(
    session_id: Option(String),
    trial_session_id: Option(String),
    state: Option(String),
    revision: Option(Int),
    session_count: Option(Int),
    phase: Option(String),
    cancelled_by: Option(String),
    attended_sessions: Option(Int),
  )
}

fn trial_detail(text: Option(String)) -> TrialDetail {
  let s = fn(name, next) {
    decode.optional_field(name, None, decode.optional(decode.string), next)
  }
  let n = fn(name, next) {
    decode.optional_field(name, None, decode.optional(decode.int), next)
  }
  let decoder = {
    use session_id <- s("sessionId")
    use trial_session_id <- s("trialSessionId")
    use state <- s("state")
    use revision <- n("revision")
    use session_count <- n("sessionCount")
    use phase <- s("phase")
    use cancelled_by <- s("cancelledBy")
    use attended_sessions <- n("attendedSessions")
    decode.success(TrialDetail(
      session_id:,
      trial_session_id:,
      state:,
      revision:,
      session_count:,
      phase:,
      cancelled_by:,
      attended_sessions:,
    ))
  }
  text
  |> option.then(fn(t) { json.parse(t, decoder) |> option.from_result })
  |> option.unwrap(TrialDetail(None, None, None, None, None, None, None, None))
}

fn opt_field(
  name: String,
  value: Option(a),
  to_json: fn(a) -> Json,
) -> List(#(String, Json)) {
  case value {
    Some(v) -> [#(name, to_json(v))]
    None -> []
  }
}

fn timeline(
  rec: Records,
  lines: List(DecisionLine),
  invitations: List(request_row.Row),
  case_trials: List(Trial),
  trial_assessments: List(assessment_row.Row),
  offers: List(Offer),
  packages: List(signing_rules.Package),
  contact_records: List(Contact),
  now: Int,
) -> List(Json) {
  timeline_lines(
    rec,
    lines,
    invitations,
    case_trials,
    trial_assessments,
    offers,
    packages,
    contact_records,
    now,
  )
  |> list.map(fn(l) { json.object(l.fields) })
}

/// The kind a timeline line names.
fn line_kind(l: Line) -> String {
  case list.key_find(l.fields, "kind") {
    Ok(k) -> json.parse(json.to_string(k), decode.string) |> result.unwrap("")
    Error(Nil) -> ""
  }
}

fn timeline_lines(
  rec: Records,
  lines: List(DecisionLine),
  invitations: List(request_row.Row),
  case_trials: List(Trial),
  trial_assessments: List(assessment_row.Row),
  offers: List(Offer),
  packages: List(signing_rules.Package),
  contact_records: List(Contact),
  now: Int,
) -> List(Line) {
  let room = rec.room
  let trial_lines =
    list.flat_map(case_trials, fn(t) {
      let tid = id.trial_to_string(t.row.id)
      list.filter_map(t.history, fn(h) {
        case list.contains(trial_timeline_actions, h.action) {
          False -> Error(Nil)
          True -> {
            let d = trial_detail(h.detail_json)
            Ok(Line(
              h.at,
              h.action <> ":" <> tid <> ":" <> id.trial_event_to_string(h.id),
              list.flatten([
                [
                  #("kind", json.string(h.action)),
                  #("at", json.int(h.at)),
                  #("by", case h.by_kind {
                    Some(trial_actor_kind.Org) ->
                      json.nullable(h.by_name, json.string)
                    _ -> json.null()
                  }),
                  #(
                    "byKind",
                    json.nullable(h.by_kind, trial_actor_kind.to_json),
                  ),
                  #("trialId", id.trial_json(t.row.id)),
                ],
                case option.or(d.trial_session_id, d.session_id) {
                  Some(sid) -> [#("sessionId", json.string(sid))]
                  None -> []
                },
                opt_field("state", d.state, json.string),
                opt_field("revision", d.revision, json.int),
                opt_field("sessionCount", d.session_count, json.int),
                opt_field("phase", d.phase, json.string),
                opt_field("cancelledBy", d.cancelled_by, json.string),
                opt_field("attendedSessions", d.attended_sessions, json.int),
              ]),
            ))
          }
        }
      })
    })
  let assessment_lines =
    list.map(trial_assessments, fn(a) {
      let at = option.unwrap(a.submitted_at, a.created_at)
      Line(at, "trial_assessment_recorded:" <> id.assessment_to_string(a.id), [
        #("kind", json.string("trial_assessment_recorded")),
        #("at", json.int(at)),
        #("by", json.null()),
        #("trialId", json.nullable(a.context_trial_id, json.string)),
        #("assessmentId", id.assessment_json(a.id)),
        #("state", assessment_row.state_to_json(a.state)),
      ])
    })
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
                      Some(recruitment_actor_kind.Org) ->
                        json.nullable(h.by_name, json.string)
                      _ -> json.null()
                    }),
                    #(
                      "byKind",
                      json.nullable(h.by_kind, recruitment_actor_kind.to_json),
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
  // Document attachments carry a digest and are not milestones.
  let signing_lines =
    list.flat_map(packages, fn(p) {
      list.filter_map(p.history, fn(h) {
        case list.contains(signing_timeline_actions, h.action) {
          False -> Error(Nil)
          True -> {
            let text = fn(name, next) {
              decode.optional_field(
                name,
                None,
                decode.optional(decode.string),
                next,
              )
            }
            let d =
              h.detail_json
              |> option.then(fn(t) {
                json.parse(t, {
                  use revision <- text("revisionId")
                  use party_type <- text("partyType")
                  use signing <- text("signingId")
                  decode.success(#(revision, party_type, signing))
                })
                |> option.from_result
              })
              |> option.unwrap(#(None, None, None))
            let present = fn(name, value: Option(String)) {
              case value {
                Some(v) if v != "" -> [#(name, json.string(v))]
                _ -> []
              }
            }
            Ok(Line(
              h.at,
              h.action
                <> ":"
                <> id.signing_package_to_string(p.row.id)
                <> ":"
                <> id.signing_event_to_string(h.id),
              list.flatten([
                [
                  #("kind", json.string(h.action)),
                  #("at", json.int(h.at)),
                  #("by", case h.by_kind {
                    Some(recruitment_actor_kind.Org) ->
                      json.nullable(h.by_name, json.string)
                    _ -> json.null()
                  }),
                  #(
                    "byKind",
                    json.nullable(h.by_kind, recruitment_actor_kind.to_json),
                  ),
                  #("signingPackageId", id.signing_package_json(p.row.id)),
                ],
                present("signingRevisionId", d.0),
                present("partyType", d.1),
                present("completedSigningId", d.2),
              ]),
            ))
          }
        }
      })
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
  // Keyed by the contact id so two in the same millisecond keep a stable order.
  let contact_lines =
    list.flat_map(contact_records, fn(c) {
      let cid = id.contact_to_string(c.row.id)
      list.flatten([
        case contact_rules.initiated_at(c.row) {
          Some(at) -> [
            Line(at, "contact:" <> cid, [
              #("kind", json.string("contact_initiated")),
              #("at", json.int(at)),
              #("by", json.null()),
              #("channel", contact_row.channel_to_json(c.row.channel)),
              #(
                "recipientType",
                json.nullable(c.row.recipient_type, party.to_json),
              ),
              #("contactId", id.contact_json(c.row.id)),
            ]),
          ]
          None -> []
        },
        case c.row.responded_at {
          Some(at) -> [
            Line(at, "contact_response:" <> cid, [
              #("kind", json.string("contact_response_received")),
              #("at", json.int(at)),
              #("by", json.null()),
              #(
                "responseKind",
                json.nullable(
                  c.row.response_kind,
                  contact_row.response_kind_to_json,
                ),
              ),
              #("contactId", id.contact_json(c.row.id)),
            ]),
          ]
          None -> []
        },
      ])
    })
  list.flatten([
    invited,
    trial_lines,
    assessment_lines,
    contact_lines,
    offer_lines,
    signing_lines,
    case_lines,
    handoff_lines,
    decision_lines,
  ])
  |> list.sort(fn(a, b) {
    case int.compare(a.at, b.at) {
      order.Eq -> string.compare(a.key, b.key)
      other -> other
    }
  })
}

// --------------------------------------------------------------------------------------------- audiences

/// Who a timeline line may be shown to (journeyModel.mjs TIMELINE_VISIBILITY). The club sees everything on its own
/// case; the player, guardian and an authorised agent only events that involved them.
const timeline_visibility = [
  #("contact_initiated", ["player", "guardian", "agent"]),
  #("contact_response_received", ["player", "guardian", "agent"]),
  #("trial_invited", ["player", "guardian", "agent"]),
  #("trial_declined", ["player", "guardian", "agent"]),
  #("trial_accepted", ["player", "guardian", "agent"]),
  #("trial_schedule_proposed", ["player", "guardian", "agent"]),
  #("trial_rescheduled", ["player", "guardian", "agent"]),
  #("trial_schedule_confirmed", ["player", "guardian", "agent"]),
  #("trial_schedule_declined", ["player", "guardian", "agent"]),
  #("trial_attendance_recorded", ["player", "guardian"]),
  #("trial_cancelled", ["player", "guardian", "agent"]),
  #("trial_completed", ["player", "guardian", "agent"]),
  #("offer_issued", ["player", "guardian", "agent"]),
  #("offer_superseded", ["player", "guardian", "agent"]),
  #("offer_withdrawn", ["player", "guardian", "agent"]),
  #("offer_accepted", ["player", "guardian", "agent"]),
  #("offer_declined", ["player", "guardian", "agent"]),
  #("offer_expired", ["player", "guardian", "agent"]),
  #("signing_ready", ["player", "guardian", "agent"]),
  #("signing_party_completed", ["player", "guardian", "agent"]),
  #("signing_completed", ["player", "guardian", "agent"]),
  #("signing_cancelled", ["player", "guardian", "agent"]),
  #("signing_voided", ["player", "guardian", "agent"]),
  #("signing_superseded", ["player", "guardian", "agent"]),
]

fn visible_to(kind: String, audience: String) -> Bool {
  case list.key_find(timeline_visibility, kind) {
    Ok(audiences) -> list.contains(audiences, audience)
    Error(Nil) -> False
  }
}

/// The timeline for an audience: only the kinds it may see, without the fields named in `drop`.
fn audience_timeline(
  lines: List(Line),
  audience: String,
  drop: List(String),
) -> Json {
  lines
  |> list.filter(fn(l) { visible_to(line_kind(l), audience) })
  |> json.array(fn(l) {
    json.object(list.filter(l.fields, fn(f) { !list.contains(drop, f.0) }))
  })
}

/// The person a journey is read for: the player themselves, or a guardian for their child.
pub type Recipient {
  PlayerSelf(player_id: id.PlayerId)
  GuardianOf(player_id: id.PlayerId, guardian_id: id.GuardianId)
}

fn recipient_audience(r: Recipient) -> String {
  case r {
    PlayerSelf(_) -> "player"
    GuardianOf(..) -> "guardian"
  }
}

/// A record the TypeScript server would give to an ended case of this club and player. A row that names its case
/// belongs to that case. (The TypeScript rule also compares a row's time with each sibling case's span, but a
/// case record carries no room creation time, so that comparison never holds. Ported as it behaves.)
fn owned_elsewhere(
  read: Read,
  room: Room,
  case_id: Option(id.RecruitmentCaseId),
  contact_id: Option(id.ContactId),
) -> Result(Bool, Fail(e)) {
  case case_id, contact_id {
    Some(c), _ -> Ok(c != room.row.id)
    None, Some(cid) -> {
      use found <- result.map(contacts.by_id(read, cid))
      case found {
        Some(c) -> c.row.case_id != room.row.id
        None -> False
      }
    }
    None, None -> Ok(False)
  }
}

/// What crossed the share boundary to this recipient on one case.
type Shared {
  Shared(
    requests: List(request_row.Row),
    trials: List(Trial),
    offers: List(CurrentOffer),
    packages: List(signing_rules.Package),
  )
}

fn shared_with(
  read: Read,
  rec: Records,
  who: Recipient,
  now: Int,
) -> Result(Shared, Fail(e)) {
  let room = rec.room
  use requests <- result.try(
    list.try_fold(rec.requests, [], fn(acc, r) {
      use elsewhere <- result.map(owned_elsewhere(
        read,
        room,
        r.case_id,
        r.contact_id,
      ))
      let for_them = case who {
        PlayerSelf(_) -> r.routed_to != party.Guardian
        GuardianOf(guardian_id:, ..) ->
          r.routed_to == party.Guardian && r.guardian_id == Some(guardian_id)
      }
      case !elsewhere && for_them {
        True -> [r, ..acc]
        False -> acc
      }
    }),
  )
  let trials =
    list.filter(rec.trials, fn(t) {
      let r = t.row
      let elsewhere = case r.case_id {
        Some(c) -> c != room.row.id
        None -> False
      }
      let accepted_by = fn(p) {
        case r.recipient_type {
          Some(_) -> r.recipient_type == Some(p)
          None -> r.accepted_by == Some(p)
        }
      }
      r.subject_removed_at == None
      && !elsewhere
      && case who {
        PlayerSelf(_) -> accepted_by(party.Player)
        GuardianOf(guardian_id:, ..) ->
          case r.recipient_type {
            Some(_) ->
              r.recipient_type == Some(party.Guardian)
              && r.recipient_guardian_id == Some(guardian_id)
            None -> r.accepted_by == Some(party.Guardian)
          }
      }
    })
  Ok(Shared(
    requests: list.reverse(requests),
    trials:,
    offers: offers_shared_with(rec, who, now),
    packages: packages_shared_with(rec, who),
  ))
}

/// Packages presented (ready or later; a draft never reached anyone) with a required party for this recipient.
fn packages_shared_with(
  rec: Records,
  who: Recipient,
) -> List(signing_rules.Package) {
  let room = rec.room
  list.filter(rec.packages, fn(p) {
    let party = case who {
      PlayerSelf(player_id:) -> #(
        signing_party_type.Player,
        id.player_to_string(player_id),
      )
      GuardianOf(guardian_id:, ..) -> #(
        signing_party_type.Guardian,
        id.guardian_to_string(guardian_id),
      )
    }
    p.row.case_id == room.row.id
    && p.row.org_id == room.row.org_id
    && p.row.player_id == room.row.player_id
    && signing_rules.integrity(p, Some(room.row.org_id)) == []
    && case signing_rules.current_revision(p) {
      Some(rev) ->
        option.is_some(rev.row.ready_at)
        && option.is_some(signing_rules.find_party(rev, party.0, Some(party.1)))
      None -> False
    }
  })
}

/// Offers whose live revision's recipient snapshot names this recipient.
fn offers_shared_with(
  rec: Records,
  who: Recipient,
  now: Int,
) -> List(CurrentOffer) {
  let room = rec.room
  list.filter_map(rec.offers, fn(o) {
    let sound =
      o.row.case_id == room.row.id
      && o.row.org_id == room.row.org_id
      && o.row.player_id == room.row.player_id
      && offer_rules.integrity(o, Some(room.row.org_id), Some(room.row.id))
      == []
    use <- bool_or(!sound, Error(Nil))
    case current_offer([o], now) {
      Some(CurrentOffer(revision: Some(rev), ..) as cur) -> {
        let r = rev.row
        let mine = case who {
          PlayerSelf(player_id:) ->
            r.recipient_type == Some(party.Player)
            && r.recipient_player_id == Some(player_id)
          GuardianOf(guardian_id:, ..) ->
            r.recipient_type == Some(party.Guardian)
            && r.recipient_guardian_id == Some(guardian_id)
        }
        case option.is_some(r.issued_at) && mine {
          True -> Ok(cur)
          False -> Error(Nil)
        }
      }
      _ -> Error(Nil)
    }
  })
}

fn bool_or(condition: Bool, value: a, next: fn() -> a) -> a {
  case condition {
    True -> value
    False -> next()
  }
}

fn shared_json(s: Shared, now: Int) -> Json {
  let requests =
    list.map(s.requests, fn(r) {
      json.object([
        #("kind", json.string("contact_request")),
        #("id", id.request_json(r.id)),
        #("type", request_row.type_to_json(r.type_)),
        #("status", request_row.status_to_json(r.status)),
        #("at", json.int(r.created_at)),
      ])
    })
  let trials =
    list.map(s.trials, fn(t) {
      let m = trial_rules.milestone(t)
      let field = fn(k) { list.key_find(m, k) |> result.unwrap(json.null()) }
      json.object([
        #("kind", json.string("trial")),
        #("id", id.trial_json(t.row.id)),
        #("workflowState", field("workflowState")),
        #("at", json.int(t.row.accepted_at)),
        #("scheduledAt", field("scheduledAt")),
        #("revision", field("revision")),
        #("sessionCount", json.int(list.length(t.sessions))),
        #("completion", field("completion")),
      ])
    })
  let offers =
    list.map(s.offers, fn(cur) {
      let rev = option.map(cur.revision, fn(r) { r.row })
      json.object([
        #("kind", json.string("offer")),
        #("id", id.offer_json(cur.offer.row.id)),
        #(
          "revisionId",
          json.nullable(option.map(rev, fn(r) { r.id }), id.offer_revision_json),
        ),
        #(
          "revisionNumber",
          json.nullable(option.map(rev, fn(r) { r.revision_number }), json.int),
        ),
        #(
          "status",
          json.nullable(
            offer_rules.live_status(cur.offer, now),
            offer_status.to_json,
          ),
        ),
        #(
          "at",
          json.int(
            option.then(rev, fn(r) { r.issued_at })
            |> option.unwrap(cur.offer.row.created_at),
          ),
        ),
        #(
          "respondedAt",
          json.nullable(option.then(rev, fn(r) { r.responded_at }), json.int),
        ),
      ])
    })
  let signings =
    list.map(s.packages, fn(p) {
      let rev = signing_rules.current_revision(p)
      json.object([
        #("kind", json.string("signing")),
        #("id", id.signing_package_json(p.row.id)),
        #(
          "status",
          json.string(
            signing_rules.status_name(signing_rules.effective_status(p, now)),
          ),
        ),
        #(
          "revisionNumber",
          json.nullable(
            option.map(rev, fn(r) { r.row.revision_number }),
            json.int,
          ),
        ),
        #(
          "at",
          json.int(
            option.then(rev, fn(r) { r.row.ready_at })
            |> option.unwrap(p.row.created_at),
          ),
        ),
        #("completedAt", json.nullable(p.row.completion_completed_at, json.int)),
      ])
    })
  json.preprocessed_array(list.flatten([requests, trials, offers, signings]))
}

/// The recipient's stage: only stages that involve them, never the club's pipeline.
fn player_stage(
  contacted: Bool,
  trial_invited: Bool,
  trials: List(Trial),
  offer: Option(CurrentOffer),
  signing: Option(signing_rules.Package),
  signed: Bool,
  now: Int,
) -> String {
  let st = option.map(signing, signing_rules.effective_status(_, now))
  let live = case signing {
    Some(p) -> signing_rules.is_live(p, now)
    None -> False
  }
  use <- bool_or(signed || st == Some(signing_rules.Completed), "signed")
  use <- bool_or(
    live
      && {
      st == Some(signing_rules.Ready) || st == Some(signing_rules.InProgress)
    },
    "signing",
  )
  let offer_stage =
    offer
    |> option.then(fn(o) { offer_rules.live_status(o.offer, now) })
    |> option.then(fn(st) {
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
  offer_stage
  |> option.lazy_or(fn() { trial_stage })
  |> option.lazy_unwrap(fn() {
    case trial_invited, contacted {
      True, _ -> "trial_invited"
      False, True -> "contacted"
      False, False -> "none"
    }
  })
}

const player_next_weight = [
  #("SIGN", 5),
  #("RESPOND_TO_OFFER", 4),
  #("CONFIRM_TRIAL_SCHEDULE", 3),
  #("RESPOND_TO_TRIAL_INVITATION", 2),
  #("RESPOND_TO_CONTACT", 1),
  #("NONE", 0),
]

/// Only what the player or guardian can answer themselves.
fn player_next(
  contact_requests: List(request_row.Row),
  trial_requests: List(request_row.Row),
  trials: List(Trial),
  offer: Option(CurrentOffer),
  signing_pending: Option(signing_rules.Package),
  now: Int,
) -> #(String, List(#(String, Json))) {
  let pending = fn(rows: List(request_row.Row)) {
    list.find(rows, fn(r) { r.status == request_row.Pending })
  }
  let issued = case offer {
    Some(o) ->
      case offer_rules.live_status(o.offer, now) {
        Some(offer_status.Issued) -> Some(o)
        _ -> None
      }
    None -> None
  }
  let awaiting =
    list.find(trials, fn(t) {
      t.row.schedule_revision != None
      && t.row.schedule_confirmed_at == None
      && t.sessions != []
      && t.row.completion_state == None
    })
  use <- bool_or(
    option.is_some(signing_pending),
    #("SIGN", [
      #(
        "signingPackageId",
        json.nullable(
          option.map(signing_pending, fn(p) { p.row.id }),
          id.signing_package_json,
        ),
      ),
    ]),
  )
  case issued, awaiting, pending(trial_requests), pending(contact_requests) {
    Some(o), _, _, _ -> #("RESPOND_TO_OFFER", [
      #("offerId", id.offer_json(o.offer.row.id)),
      #(
        "offerRevisionId",
        json.nullable(
          option.map(o.revision, fn(r) { r.row.id }),
          id.offer_revision_json,
        ),
      ),
    ])
    None, Ok(t), _, _ -> #("CONFIRM_TRIAL_SCHEDULE", [
      #("trialId", id.trial_json(t.row.id)),
    ])
    None, Error(Nil), Ok(r), _ -> #("RESPOND_TO_TRIAL_INVITATION", [
      #("requestId", id.request_json(r.id)),
    ])
    None, Error(Nil), Error(Nil), Ok(r) -> #("RESPOND_TO_CONTACT", [
      #("requestId", id.request_json(r.id)),
    ])
    None, Error(Nil), Error(Nil), Error(Nil) -> #("NONE", [])
  }
}

/// One case's journey for the player or a guardian, if anything on it was shared with them. No case id,
/// lifecycle state, priority, decision or note; no club member's name, no Contact record id.
fn recipient_journey(
  read: Read,
  rec: Records,
  who: Recipient,
  now: Int,
) -> Result(Option(#(String, Json, Json)), Fail(e)) {
  use s <- result.map(shared_with(read, rec, who, now))
  case s.requests, s.trials, s.offers, s.packages {
    [], [], [], [] -> None
    _, _, _, _ -> {
      let room = rec.room
      let audience = recipient_audience(who)
      let contact_requests =
        list.filter(s.requests, fn(r) { r.type_ == request_row.Contact })
      let trial_requests =
        list.filter(s.requests, fn(r) { r.type_ == request_row.Trial })
      let offer = current_offer(list.map(s.offers, fn(o) { o.offer }), now)
      let signing = current_signing(s.packages, now)
      let #(party_type, party_id) = case who {
        PlayerSelf(player_id:) -> #(
          signing_party_type.Player,
          id.player_to_string(player_id),
        )
        GuardianOf(guardian_id:, ..) -> #(
          signing_party_type.Guardian,
          id.guardian_to_string(guardian_id),
        )
      }
      let signing_pending =
        option.then(signing, fn(p) {
          let st = signing_rules.effective_status(p, now)
          let pending =
            signing_rules.current_revision(p)
            |> option.then(signing_rules.find_party(
              _,
              party_type,
              Some(party_id),
            ))
            |> option.map(fn(q) { q.status == signing_party_row.Pending })
          case
            { st == signing_rules.Ready || st == signing_rules.InProgress }
            && pending == Some(True)
          {
            True -> Some(p)
            False -> None
          }
        })
      let #(code, refs) =
        player_next(
          contact_requests,
          trial_requests,
          s.trials,
          offer,
          signing_pending,
          now,
        )
      let wanted = case who {
        PlayerSelf(_) -> party.Player
        GuardianOf(..) -> party.Guardian
      }
      let contact_records =
        list.filter(rec.contacts, fn(c) {
          c.row.case_id == room.row.id
          && c.row.org_id == room.row.org_id
          && {
            c.row.status == contact_row.Delivered
            || c.row.status == contact_row.Responded
          }
          && contact_rules.integrity(
            c,
            Some(room.row.org_id),
            Some(room.row.id),
          )
          == []
          && c.row.recipient_type == Some(wanted)
        })
      let invitations =
        list.filter(rec.requests, fn(r) {
          r.type_ == request_row.Trial
          && r.case_id == Some(room.row.id)
          && list.any(trial_requests, fn(x) { x.id == r.id })
        })
      let lines =
        timeline_lines(
          rec,
          [],
          invitations,
          s.trials,
          [],
          list.map(s.offers, fn(o) { o.offer }),
          s.packages,
          contact_records,
          now,
        )
      let pending_contact =
        list.find(contact_requests, fn(r) { r.status == request_row.Pending })
        |> result.lazy_or(fn() { list.last(contact_requests) })
      let journey =
        json.object([
          #("policyVersion", json.int(policy_version)),
          #(
            "stage",
            json.string(player_stage(
              contact_requests != [],
              list.any(trial_requests, fn(r) { r.status == request_row.Pending }),
              s.trials,
              offer,
              signing,
              completed_row(rec, signing),
              now,
            )),
          ),
          #(
            "nextAction",
            json.object([
              #("code", json.string(code)),
              #("resources", json.object(refs)),
            ]),
          ),
          #(
            "resources",
            json.object([
              #("contactRequestId", case pending_contact {
                Ok(r) -> id.request_json(r.id)
                Error(Nil) -> json.null()
              }),
              #(
                "trialRequestId",
                case
                  list.find(trial_requests, fn(r) {
                    r.status == request_row.Pending
                  })
                {
                  Ok(r) -> id.request_json(r.id)
                  Error(Nil) -> json.null()
                },
              ),
              #(
                "trialId",
                json.nullable(
                  option.map(current_trial(s.trials), fn(t) { t.row.id }),
                  id.trial_json,
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
                    option.map(o.revision, fn(r) { r.row.id })
                  }),
                  id.offer_revision_json,
                ),
              ),
              #(
                "signingPackageId",
                json.nullable(
                  option.map(signing, fn(p) { p.row.id }),
                  id.signing_package_json,
                ),
              ),
            ]),
          ),
          #("timeline", audience_timeline(lines, audience, ["by", "contactId"])),
        ])
      Some(#(code, shared_json(s, now), journey))
    }
  }
}

/// Whether a stored-completed package's row exists and names it back (`completedRowOf`).
fn completed_row(rec: Records, signing: Option(signing_rules.Package)) -> Bool {
  case signing {
    Some(p) ->
      case p.row.status, p.row.completion_signing_id {
        signing_pkg_row.Completed, Some(sid) ->
          list.any(rec.signings, fn(s) {
            s.id == sid && s.signing_package_id == Some(p.row.id)
          })
        _, _ -> False
      }
    None -> False
  }
}

fn club_json(read: Read, org_id: id.OrgId) -> Result(#(String, Json), Fail(e)) {
  use found <- result.map(orgs.by_id(read, org_id))
  case found {
    Some(o) -> #(
      o.name,
      json.object([
        #("id", id.org_json(o.id)),
        #("name", json.string(o.name)),
        #("level", json.nullable(o.level, org_row.level_to_json)),
        #("verified", json.bool(o.verified)),
      ]),
    )
    None -> #(
      "",
      json.object([
        #("id", id.org_json(org_id)),
        #("name", json.null()),
        #("level", json.null()),
        #("verified", json.bool(False)),
      ]),
    )
  }
}

/// Every case on which something was shared with this recipient, the most consequential pending act first, then
/// by club name, then by club id.
pub fn for_recipient(
  read: Read,
  who: Recipient,
  now: Int,
) -> Result(List(Json), Fail(e)) {
  use rooms <- result.try(cases.rooms_of_player(read, who.player_id))
  use found <- result.map(
    list.try_map(rooms, fn(room) {
      use rec <- result.try(load(read, room, False, True))
      use journey <- result.try(recipient_journey(read, rec, who, now))
      case journey {
        None -> Ok(None)
        Some(#(code, shared, journey)) -> {
          use #(name, club) <- result.map(club_json(read, room.row.org_id))
          Some(#(
            code,
            name,
            id.org_to_string(room.row.org_id),
            json.object([
              #("club", club),
              #("shared", shared),
              #("journey", journey),
            ]),
          ))
        }
      }
    }),
  )
  let weight = fn(code) {
    list.key_find(player_next_weight, code) |> result.unwrap(0)
  }
  found
  |> option.values
  |> list.sort(fn(a, b) {
    int.compare(weight(b.0), weight(a.0))
    |> order.lazy_break_tie(fn() { string.compare(a.1, b.1) })
    |> order.lazy_break_tie(fn() { string.compare(a.2, b.2) })
  })
  |> list.map(fn(x) { x.3 })
}

/// One case's journey for an agent: only the records the client's own act routed or shared to them, and only the
/// kinds `grants` permits. An ungranted kind reads as absent, not refused, so the projection does not disclose
/// what it hides.
fn agent_journey(
  rec: Records,
  agent: id.OrgUserId,
  grants: List(String),
  now: Int,
) -> #(String, List(Line), Json) {
  let room = rec.room
  let r = room.row
  let granted = fn(kind) { list.contains(grants, kind) }
  let contact_records = case granted("contacts") {
    False -> []
    True ->
      list.filter(rec.contacts, fn(c) {
        c.row.case_id == r.id
        && c.row.org_id == r.org_id
        && {
          c.row.status == contact_row.Delivered
          || c.row.status == contact_row.Responded
        }
        && c.row.routing_agent_user_id == Some(agent)
        && contact_rules.integrity(c, Some(r.org_id), Some(r.id)) == []
      })
  }
  let trial_rows = case granted("trials") {
    False -> []
    True ->
      list.filter(rec.case_trials, fn(t) {
        t.row.case_id == Some(r.id)
        && t.row.org_id == r.org_id
        && t.row.player_id == r.player_id
        && t.row.subject_removed_at == None
        && trial_rules.integrity(t, Some(r.org_id), Some(r.id)) == []
      })
  }
  let invitations = case granted("trials") {
    False -> []
    True ->
      list.filter(rec.requests, fn(q) {
        q.type_ == request_row.Trial && q.case_id == Some(r.id)
      })
  }
  let offer_rows = case granted("offers") {
    False -> []
    True ->
      list.filter(rec.offers, fn(o) {
        o.row.case_id == r.id
        && o.row.org_id == r.org_id
        && o.row.player_id == r.player_id
        && o.row.agent_share_user_id == Some(agent)
        && offer_rules.integrity(o, Some(r.org_id), Some(r.id)) == []
        && list.any(o.revisions, fn(v) {
          v.row.status != offer_status.Draft && option.is_some(v.row.issued_at)
        })
      })
  }
  let shared_offers = list.map(offer_rows, fn(o) { o.row.id })
  let packages = case granted("signings") {
    False -> []
    True ->
      list.filter(rec.packages, fn(p) {
        p.row.case_id == r.id
        && p.row.org_id == r.org_id
        && p.row.player_id == r.player_id
        && list.contains(shared_offers, p.row.offer_id)
        && signing_rules.integrity(p, Some(r.org_id)) == []
        && case signing_rules.current_revision(p) {
          Some(rev) -> option.is_some(rev.row.ready_at)
          None -> False
        }
      })
  }
  let offer = current_offer(offer_rows, now)
  let signing = current_signing(packages, now)
  let stage =
    player_stage(
      contact_records != [],
      list.any(invitations, fn(q) { q.status == request_row.Pending }),
      trial_rows,
      offer,
      signing,
      completed_row(rec, signing),
      now,
    )
  let lines =
    timeline_lines(
      rec,
      [],
      invitations,
      trial_rows,
      [],
      offer_rows,
      packages,
      contact_records,
      now,
    )
    |> list.filter(fn(l) { visible_to(line_kind(l), "agent") })
  let journey =
    json.object([
      #("policyVersion", json.int(policy_version)),
      #("stage", json.string(stage)),
      #(
        "resources",
        json.object([
          #(
            "contactId",
            json.nullable(
              option.map(current_contact(contact_records), fn(c) { c.row.id }),
              id.contact_json,
            ),
          ),
          #(
            "trialId",
            json.nullable(
              option.map(current_trial(trial_rows), fn(t) { t.row.id }),
              id.trial_json,
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
          #(
            "signingPackageId",
            json.nullable(
              option.map(signing, fn(p) { p.row.id }),
              id.signing_package_json,
            ),
          ),
        ]),
      ),
      #("timeline", audience_timeline(lines, "agent", ["by"])),
      #("grants", json.array(grants, json.string)),
    ])
  #(stage, lines, journey)
}

/// Every club's journey with the agent's client, as far as the grants open it. A club that shared nothing with
/// this agent is not a club the agent learns about. Sorted by club name, then club id.
pub fn for_agent(
  read: Read,
  client: id.PlayerId,
  agent: id.OrgUserId,
  grants: List(String),
  now: Int,
) -> Result(List(Json), Fail(e)) {
  use rooms <- result.try(cases.rooms_of_player(read, client))
  use found <- result.map(
    list.try_map(rooms, fn(room) {
      use rec <- result.try(load(read, room, False, True))
      let #(stage, lines, journey) = agent_journey(rec, agent, grants, now)
      case stage, lines {
        "none", [] -> Ok(None)
        _, _ -> {
          use #(name, club) <- result.map(club_json(read, room.row.org_id))
          Some(#(
            name,
            id.org_to_string(room.row.org_id),
            json.object([#("club", club), #("journey", journey)]),
          ))
        }
      }
    }),
  )
  found
  |> option.values
  |> list.sort(fn(a, b) {
    string.compare(a.0, b.0)
    |> order.lazy_break_tie(fn() { string.compare(a.1, b.1) })
  })
  |> list.map(fn(x) { x.2 })
}
