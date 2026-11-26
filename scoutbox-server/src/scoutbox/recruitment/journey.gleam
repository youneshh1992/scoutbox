//// The recruitment journey projection (domains/recruitment/lifecycle/journey.mjs): one case's records arranged for
//// its organisation, computed on read; `journey_model` holds the rules it applies. There is no score, probability or
//// progress percentage: how far a case has travelled is a fact about a club's process, not a
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
import scoutbox/recruitment/journey_model.{
  type CurrentOffer, CurrentOffer, current_contact, current_decision,
  current_offer, current_signing, current_trial, detail_of, newest,
  player_next_weight, stage_of, visible_to,
}
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/recruitment/offers
import scoutbox/recruitment/room_rules.{type RoomRole}
import scoutbox/recruitment/signing_packages
import scoutbox/recruitment/signing_rules
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/assessments as assessment_row
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
    /// CLUB_MISMATCH or PLAYER_MISMATCH: records that name this case but another club or player, which the
    /// lists above leave out.
    foreign: List(String),
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
    room,
    viewer.role,
    case_lifecycle.provider(read, room, now),
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
  use case_requests <- result.try(store.query(
    read,
    "SELECT "
      <> request_row.columns
      <> " FROM recruitment_requests WHERE case_id = ? ORDER BY rowid",
    [id.recruitment_case_sql(r.id)],
    request_row.decoder(),
  ))
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
    foreign: foreign_references(
      r,
      list.flatten([
        list.map(case_contacts, fn(c) { #(c.row.org_id, c.row.player_id) }),
        list.map(case_trials, fn(t) { #(t.row.org_id, t.row.player_id) }),
        list.map(case_requests, fn(q) { #(q.org_id, q.player_id) }),
        list.map(case_offers, fn(o) { #(o.row.org_id, o.row.player_id) }),
        list.map(case_packages, fn(p) { #(p.row.org_id, p.row.player_id) }),
      ]),
      list.map(all, fn(d) { #(d.base.row.org_id, d.base.row.player_id) }),
    ),
  ))
}

/// Which of the records naming this case name another club or player (foreignReferences): reported, never used.
/// Each record is its organisation and player; a decision names one mismatch, its club's if both differ.
fn foreign_references(
  r: case_row.Row,
  records: List(#(id.OrgId, id.PlayerId)),
  decisions: List(#(id.OrgId, id.PlayerId)),
) -> List(String) {
  let club = fn(x: #(id.OrgId, id.PlayerId)) { x.0 != r.org_id }
  let player = fn(x: #(id.OrgId, id.PlayerId)) { x.1 != r.player_id }
  [
    #("CLUB_MISMATCH", list.any(records, club) || list.any(decisions, club)),
    #(
      "PLAYER_MISMATCH",
      list.any(records, player)
        || list.any(decisions, fn(d) { !club(d) && player(d) }),
    ),
  ]
  |> list.filter_map(fn(x) {
    case x.1 {
      True -> Ok(x.0)
      False -> Error(Nil)
    }
  })
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
      json.object(
        list.append(
          case_lifecycle.conditions(
            status,
            current != None,
            list.any(listed_trials, fn(t) {
              t.row.status == trial_row.AwaitingReport
            }),
            offer_awaiting,
          ),
          [
            #(
              "decisionOutstanding",
              json.bool(
                !terminal
                && current_formal == None
                && {
                  assessed
                  || list.any(listed_trials, fn(t) {
                    trial_rules.workflow_state(t)
                    == trial_workflow_state.Completed
                  })
                },
              ),
            ),
            #("hasFormalDecision", json.bool(current_formal != None)),
          ],
        ),
      ),
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
    journey_model.current_assessment(rec.case_assessments)
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
  let facts =
    journey_model.JourneyFacts(
      status:,
      created_at: r.created_at,
      history: room.history,
      links_signing_id: r.links_signing_id,
      contacts: case_contacts,
      trials: case_trials,
      trial_requests:,
      assessments: rec.case_assessments,
      decisions: case_decisions,
      offers:,
      packages:,
      signing_row: signing,
      signing_row_ids: list.map(rec.signings, fn(s) { s.id }),
      corrupt:,
      foreign: rec.foreign,
      domain_problems: domain_problems(rec, status, offers, packages, now),
      now:,
    )
  let verdict = journey_model.validate(facts)
  let classification = verdict.classification
  let next =
    journey_model.next_action(
      status,
      journey_model.NextFacts(
        assessed:,
        decision: option.map(decision, fn(d) { d.base.row.id }),
        contact: option.map(contact, fn(c) {
          journey_model.NextContact(c.row.id, c.row.status)
        }),
        trial: option.map(trial, journey_model.next_trial),
        trial_request: option.map(pending_trial_request, fn(q) { q.id }),
        offer: option.map(offer, journey_model.next_offer(_, now)),
        signing: option.map(package, journey_model.next_signing(_, now)),
        signing_row: option.map(signing, fn(s) { s.id }),
      ),
      viewer.role,
      rec.blocked,
      subject_removed,
      classification == "integrity_error",
      now,
    )
  json.object([
    #("policyVersion", json.int(policy_version)),
    #("stage", json.string(stage_of(status, assessed, opened))),
    #(
      "completedStages",
      json.preprocessed_array(journey_model.completed_stages(facts)),
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
    #("integrity", ids(verdict.problems)),
    #("blocked", json.bool(rec.blocked)),
    #("subjectRemoved", json.bool(subject_removed)),
  ])
}

/// The Offers' and packages' own consistency problems that mean corruption. The TypeScript reader hands each package
/// at most one row (`signings.forPackage`), so a duplicate is never seen here. Ported as it behaves.
fn domain_problems(
  rec: Records,
  status: RoomStatus,
  offers: List(Offer),
  packages: List(signing_rules.Package),
  now: Int,
) -> List(String) {
  list.append(
    list.flat_map(offers, fn(o) {
      offer_rules.case_consistency(o, Some(status), now)
      |> list.filter(fn(c) { offer_rules.case_corrupt([c]) })
    }),
    list.flat_map(packages, fn(p) {
      let rows =
        list.find(rec.signings, fn(s) { s.signing_package_id == Some(p.row.id) })
        |> result.map(fn(s) { [s] })
        |> result.unwrap([])
      signing_rules.consistency(
        p,
        list.find(offers, fn(o) { o.row.id == p.row.offer_id })
          |> option.from_result,
        Some(rec.room),
        rows,
        None,
        now,
      )
      |> list.filter(fn(c) { signing_rules.corrupt([c]) })
    }),
  )
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

// ------------------------------------------------------------------------------------------- next action

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
      let pending = fn(rows: List(request_row.Row)) {
        list.find(rows, fn(r) { r.status == request_row.Pending })
        |> option.from_result
        |> option.map(fn(r) { r.id })
      }
      let issued =
        option.then(offer, fn(o) {
          case offer_rules.live_status(o.offer, now) {
            Some(offer_status.Issued) ->
              Some(#(o.offer.row.id, option.map(o.revision, fn(r) { r.row.id })))
            _ -> None
          }
        })
      let awaiting =
        list.find(s.trials, fn(t) {
          t.row.schedule_revision != None
          && t.row.schedule_confirmed_at == None
          && t.sessions != []
          && t.row.completion_state == None
        })
        |> option.from_result
        |> option.map(fn(t) { t.row.id })
      let #(code, refs) =
        journey_model.player_next(
          option.map(signing_pending, fn(p) { p.row.id }),
          issued,
          awaiting,
          pending(trial_requests),
          pending(contact_requests),
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
            json.string(journey_model.player_stage(
              contact_requests,
              trial_requests,
              s.trials,
              option.then(offer, fn(o) { offer_rules.live_status(o.offer, now) }),
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
    journey_model.player_stage(
      contact_records,
      invitations,
      trial_rows,
      option.then(offer, fn(o) { offer_rules.live_status(o.offer, now) }),
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
