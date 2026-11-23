//// Offer routes for the club, the recipient (player or guardian) and the client's agent
//// (domains/recruitment/offers/index.mjs). A case's status moves only through the lifecycle writer, after the
//// lifecycle validator agreed with the real evidence provider. An Offer is not a signing: nothing here signs.
////
//// Every route reads "now" from the request clock (`clock.request_ms`), so the batteries can pin an expiry.
////
//// An Offer may cite the case's transaction workspace (agents/transactions); its readiness is re-read at issue,
//// never taken from the draft.

import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/core_routes as agent_core
import scoutbox/agents/integration
import scoutbox/agents/representation
import scoutbox/agents/transaction_routes
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs as org_store
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/faults
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/media
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/domain_errors
import scoutbox/recruitment/offer_rules.{type Offer, type Revision}
import scoutbox/recruitment/offers
import scoutbox/recruitment/recipients
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/room_view
import scoutbox/recruitment/signing_reads
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/offer_keys as key_row
import scoutbox/rows/offer_responses as response_row
import scoutbox/rows/orgs
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/offer_status.{Accepted, Draft, Issued}
import scoutbox/vocab/party
import scoutbox/vocab/room_status
import scoutbox/vocab/transaction_status
import wisp.{type Request, type Response}

// --------------------------------------------------------------------------------------------------- helpers

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(domain_errors.offer, code, message, fields)
}

fn fail(r: offer_rules.Refusal) -> Response {
  err(r.error, r.message, r.fields)
}

fn not_found() -> Response {
  err(
    "OFFER_NOT_FOUND",
    "No Offer with that reference is available to you.",
    [],
  )
}

fn state_unknown() -> Response {
  err("OFFER_STATE_UNKNOWN", "This Offer cannot be read.", [])
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

/// A re-run after a lost race was charged on its first run.
fn limited(
  ctx: Ctx,
  req: Request,
  action: limits.Action,
  owner: String,
  now: Int,
  next: fn() -> Response,
) -> Response {
  case
    !http.rerun(req)
    && limits.limited(ctx.limits, action, owner, clock.now_ms())
  {
    True -> rate_limited(action)
    False -> {
      let _ = now
      next()
    }
  }
}

fn read(ctx: Ctx, f: fn(Read) -> Result(a, Fail(e))) -> Result(a, Response) {
  store.read(ctx.store, f) |> result.map_error(http.internal)
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn status_label(s: room_status.RoomStatus) -> String {
  room_rules.status_label(s)
}

fn body(
  req: Request,
  shape: input.Shape(a),
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw, order <- http.json_body_in_order(req)
  case
    input.parse_in_order(
      shape,
      raw,
      order,
      root: "body",
      codes: offer_rules.input_codes,
      default: "OFFER_INPUT_INVALID",
    )
  {
    Error(r) ->
      domain_errors.send(domain_errors.offer, r.error, input.refusal_fields(r))
    Ok(v) -> next(v, raw)
  }
}

fn client_key(
  raw: Option(Dynamic),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(raw) {
    Ok(k) -> next(k)
    Error(m) -> err("OFFER_CLIENT_KEY_INVALID", m, [])
  }
}

fn subject_removed(read: Read, room: Room) -> Result(Bool, Fail(e)) {
  use found <- result.map(players.by_id(read, room.row.player_id))
  room.row.subject_removed_at != None || found == None
}

fn blocked(read: Read, room: Room) -> Result(Bool, Fail(e)) {
  audit.is_blocked(read, room.row.player_id, room.row.org_id)
}

fn org_of(read: Read, org_id: id.OrgId) -> Result(Option(orgs.Row), Fail(e)) {
  org_store.by_id(read, org_id)
}

/// The case's sound Offers of this organisation.
fn offers_of_case(read: Read, room: Room) -> Result(List(Offer), Fail(e)) {
  offers.for_case(read, room.row.id)
  |> result.map(list.filter(_, fn(o) { o.row.org_id == room.row.org_id }))
}

/// At most one Offer of a case is live (a draft or issued).
fn live_offer(all: List(Offer), now: Int) -> Option(Offer) {
  list.find(all, fn(o) {
    let st = offer_rules.status(o, now)
    st == Some(Draft) || st == Some(Issued)
  })
  |> option.from_result
}

fn refused_permission(need: room_rules.RoomAction) -> Response {
  err(
    "OFFER_NOT_PERMITTED",
    case need {
      room_rules.OfferView -> "Your role cannot read Offers on this case."
      _ ->
        "Only a room lead or recruitment lead can draft, issue or withdraw an Offer."
    },
    [],
  )
}

/// A Room of this organisation the member may act on for `need`.
fn room_for(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  need: room_rules.RoomAction,
  next: fn(Room, Option(room_rules.RoomRole)) -> Response,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  let role = room_view.role(a, room)
  case room_rules.room_can(role, need) {
    True -> next(room, role)
    False -> refused_permission(need)
  }
}

/// An Offer of this organisation, whose case is one of its Rooms; anything else is concealed.
fn offer_for(
  ctx: Ctx,
  a: OrgAccess,
  offer_id: id.OfferId,
  need: room_rules.RoomAction,
  now: Int,
  next: fn(Offer, Room, Option(room_rules.RoomRole)) -> Response,
) -> Response {
  let found =
    read(ctx, fn(r) {
      use o <- result.try(offers.by_id(r, offer_id))
      case o {
        Some(o) if o.row.org_id == a.org.id -> {
          use room <- result.map(cases.room(r, o.row.case_id))
          Some(#(o, room))
        }
        _ -> Ok(None)
      }
    })
  case found {
    Error(response) -> response
    Ok(None) -> not_found()
    Ok(Some(#(o, room))) ->
      case offer_rules.integrity(o, Some(a.org.id), None), room {
        [_, ..], _ -> state_unknown()
        [], None -> not_found()
        [], Some(room) if room.row.org_id != a.org.id -> not_found()
        [], Some(room) ->
          case o.row.player_id == room.row.player_id {
            False -> state_unknown()
            True ->
              case
                offer_rules.case_corrupt(offer_rules.case_consistency(
                  o,
                  Some(room.status),
                  now,
                ))
              {
                True -> state_unknown()
                False -> {
                  let role = room_view.role(a, room)
                  case room_rules.room_can(role, need) {
                    True -> next(o, room, role)
                    False -> refused_permission(need)
                  }
                }
              }
          }
      }
  }
}

/// `expectedRev` is required on every club change to an existing Offer and is never coerced. There is one rev,
/// the Offer's: every revision change and every recipient answer moves it.
fn rev_gate(raw: Dynamic, o: Offer, next: fn() -> Response) -> Response {
  let named = fn(key) {
    case decode.run(raw, decode.at([key], decode.dynamic)) {
      Ok(v) ->
        case dynamic.classify(v) {
          "Nil" -> None
          _ -> Some(v)
        }
      Error(_) -> None
    }
  }
  case option.or(named("expectedRev"), named("expectedVersion")) {
    None ->
      err(
        "OFFER_REV_REQUIRED",
        "expectedRev is required: send the rev you were looking at.",
        [],
      )
    Some(v) ->
      case decode.run(v, decode.int) {
        Ok(n) if n >= 0 -> guard(n, o, offer_status.to_json(o.row.status), next)
        _ ->
          err(
            "OFFER_REV_REQUIRED",
            "expectedRev must be a non-negative integer.",
            [
              #("field", json.string("expectedRev")),
              #("expected", json.string("integer")),
            ],
          )
      }
  }
}

fn guard(n: Int, o: Offer, status: Json, next: fn() -> Response) -> Response {
  rev.guard(
    rev.Expected(n),
    rev.Rev(o.row.rev, o.row.rev_at, o.row.rev_by_name),
    "OFFER_REV_CONFLICT",
    [#("rev", json.int(o.row.rev)), #("status", status)],
    next,
  )
}

fn by_staff(a: OrgAccess) -> #(id.OrgUserId, String, Option(String)) {
  #(a.user.id, a.user.name, Some(a.user.role))
}

fn staff_actor(a: OrgAccess) -> offers.Actor {
  offers.Staff(a.user.id, a.user.name, Some(a.user.role))
}

fn case_audit(
  tx: Tx,
  room: Room,
  by: cases.By,
  action: String,
  detail: List(#(String, Json)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  cases.record(tx, room.row.id, by, [cases.entry(action, detail)], at)
}

fn reread(tx: Tx, offer_id: id.OfferId) -> Result(Offer, Fail(Response)) {
  use found <- result.try(offers.by_id(store.reading(tx), offer_id) |> storage)
  case found {
    Some(o) -> Ok(o)
    None -> store.refuse(state_unknown())
  }
}

fn moderated(
  ctx: Ctx,
  text: Option(String),
  context: audit.Context,
  next: fn() -> Response,
) -> Response {
  case text {
    Some(t) -> moderate.or_refuse(ctx, t, context, next)
    None -> next()
  }
}

fn org_context(a: OrgAccess, kind: String) -> audit.Context {
  audit.Context(
    kind:,
    player_id: None,
    org_id: Some(a.org.id),
    user_id: Some(a.user.id),
    channel_id: None,
    request_id: None,
  )
}

// ------------------------------------------------------------------------------------------- lifecycle

/// What the case did with an Offer act's step.
type Moved {
  Moved(lifecycle: offers.Lifecycle, json: Json)
}

/// Validates with the real evidence provider, then writes through the lifecycle writer (case_lifecycle.advance).
fn advance(
  tx: Tx,
  room: Room,
  level: orgs.Level,
  action_name: String,
  role: Option(room_rules.RoomRole),
  mover: case_lifecycle.Mover,
  trigger: String,
  key_detail: List(#(String, Json)),
  at: Int,
) -> Result(Moved, Fail(e)) {
  use a <- result.map(case_lifecycle.advance(
    tx,
    room,
    level,
    action_name,
    role,
    mover,
    trigger,
    key_detail,
    at,
  ))
  Moved(
    offers.Lifecycle(
      a.applied,
      Some(a.action),
      Some(a.from),
      a.to,
      a.at,
      a.reason,
      a.message,
      a.allowed,
    ),
    case_lifecycle.advanced_json(a),
  )
}

// ---------------------------------------------------------------------------------------- notifications

fn notify(
  tx: Tx,
  to: audience.Audience,
  who: String,
  text: String,
  offer_id: id.OfferId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to:,
    id: who,
    type_: "recruitment_offer",
    text:,
    ref_id: Some(id.offer_to_string(offer_id)),
    at:,
  )
}

fn notify_recipient(
  tx: Tx,
  r: Option(Revision),
  text: String,
  offer_id: id.OfferId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  case r {
    None -> Ok(Nil)
    Some(rev) ->
      case
        rev.row.recipient_type,
        rev.row.recipient_guardian_id,
        rev.row.recipient_player_id
      {
        Some(party.Guardian), Some(g), _ ->
          notify(
            tx,
            audience.Guardian,
            id.guardian_to_string(g),
            text,
            offer_id,
            at,
          )
        Some(_), _, Some(p) ->
          notify(
            tx,
            audience.Player,
            id.player_to_string(p),
            text,
            offer_id,
            at,
          )
        _, _, _ -> Ok(Nil)
      }
  }
}

/// Only while the client has shared the Offer and the agent's basis still holds.
fn notify_agent(
  tx: Tx,
  o: Offer,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  case o.row.agent_share_user_id {
    None -> Ok(Nil)
    Some(agent) -> {
      use basis <- result.try(representation.basis(
        store.reading(tx),
        agent,
        id.player_to_string(o.row.player_id),
        clock.now_ms(),
      ))
      case basis.ok {
        True ->
          notify(
            tx,
            audience.OrgUser,
            id.org_user_to_string(agent),
            text,
            o.row.id,
            at,
          )
        False -> Ok(Nil)
      }
    }
  }
}

fn notify_club(
  tx: Tx,
  o: Offer,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use room <- result.try(cases.room(store.reading(tx), o.row.case_id))
  let issuer =
    offer_rules.current_revision(o)
    |> option.then(fn(r) { r.row.issued_by_user_id })
  [
    option.map(room, fn(r) { r.row.owner_user_id }),
    option.then(room, fn(r) { r.row.room_lead_scout_user_id }),
    issuer,
  ]
  |> option.values
  |> list.unique
  |> list.try_each(fn(u) {
    notify(tx, audience.OrgUser, id.org_user_to_string(u), text, o.row.id, at)
  })
}

// ------------------------------------------------------------------------------------------------- blockers

fn blockers_for(
  read: Read,
  room: Room,
  role: Option(room_rules.RoomRole),
  org: orgs.Row,
  now: Int,
  for_issue: Bool,
  all: List(Offer),
  offer: Option(Offer),
) -> Result(List(String), Fail(e)) {
  use removed <- result.try(subject_removed(read, room))
  use is_blocked <- result.try(blocked(read, room))
  use rest <- result.map(case for_issue {
    False -> {
      use dp <- result.map(case_lifecycle.evidence(
        read,
        room,
        room_rules.DecisionProgress,
        now,
      ))
      list.flatten([
        case room.status == room_status.OfferConsideration {
          True -> []
          False -> ["CASE_STATE"]
        },
        case dp {
          case_lifecycle.Holds(..) -> []
          case_lifecycle.Lacks(..) -> ["DECISION_REQUIRED"]
        },
        case live_offer(all, now) {
          Some(_) -> ["OFFER_LIVE"]
          None -> []
        },
      ])
    }
    True -> {
      use rec <- result.try(recipients.resolve(
        read,
        room.row.player_id,
        org,
        now,
      ))
      use workspace <- result.map(
        case option.then(offer, fn(o) { o.row.transaction_id }) {
          Some(tid) ->
            transaction_routes.offer_readiness_for(
              read,
              tid,
              room.row.org_id,
              room.row.id,
              now,
            )
            |> result.map(fn(found) {
              case found {
                None -> ["TRANSACTION_MISSING"]
                Some(#(_, r)) if !r.can_start -> ["TRANSACTION_NOT_READY"]
                Some(_) -> []
              }
            })
          None -> Ok([])
        },
      )
      list.flatten([
        case
          room.status == room_status.OfferConsideration
          || room.status == room_status.OfferMade
        {
          True -> []
          False -> ["CASE_STATE"]
        },
        case rec {
          Error(recipients.Blocked) -> ["BLOCKED"]
          Error(_) -> ["RECIPIENT"]
          Ok(r) ->
            case
              r.minor
              && !offer_rules.minor_pathway_open(option.unwrap(
                org.country,
                "GB",
              ))
            {
              True -> ["MINOR_PATHWAY_CLOSED"]
              False -> []
            }
        },
        workspace,
      ])
    }
  })
  list.unique(
    list.flatten([
      case room_rules.room_can(role, room_rules.OfferDraft) {
        True -> []
        False -> ["OFFER_ROLE"]
      },
      case removed {
        True -> ["SUBJECT_REMOVED"]
        False -> []
      },
      case is_blocked {
        True -> ["BLOCKED"]
        False -> []
      },
      rest,
    ]),
  )
}

// ======================================================================================================= club

/// `GET /org/rooms/:id/offers`.
pub fn surface(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room, role <- room_for(ctx, a, room_id, room_rules.OfferView)
  let now = clock.request_ms(ctx.config, req)
  let gathered =
    read(ctx, fn(r) {
      use all <- result.try(offers_of_case(r, room))
      let live = live_offer(all, now)
      use draft_blockers <- result.try(blockers_for(
        r,
        room,
        role,
        a.org,
        now,
        False,
        all,
        None,
      ))
      use issue_blockers <- result.try(case live {
        Some(l) ->
          case offer_rules.status(l, now) == Some(Draft) {
            True -> blockers_for(r, room, role, a.org, now, True, all, live)
            False -> Ok([])
          }
        None -> Ok([])
      })
      use is_blocked <- result.try(blocked(r, room))
      use removed <- result.try(subject_removed(r, room))
      use summaries <- result.map(
        list.try_map(all, fn(o) {
          signing_reads.summary_for_offer(r, o.row.id, o.row.org_id, now)
          |> result.map(fn(j) { #(o.row.id, j) })
        }),
      )
      #(
        all,
        live,
        draft_blockers,
        issue_blockers,
        is_blocked,
        removed,
        summaries,
      )
    })
  case gathered {
    Error(response) -> response
    Ok(#(
      all,
      live,
      draft_blockers,
      issue_blockers,
      is_blocked,
      removed,
      summaries,
    )) -> {
      let listed =
        all
        |> list.sort(fn(x, y) {
          int.compare(y.row.created_at, x.row.created_at)
        })
        |> list.map(fn(o) {
          json.object(
            list.append(
              signing_reads.with_signing(
                offer_rules.club_view(o, now),
                list.key_find(summaries, o.row.id) |> result.unwrap(json.null()),
              ),
              [
                #(
                  "integrity",
                  json.array(
                    list.append(
                      offer_rules.integrity(
                        o,
                        Some(room.row.org_id),
                        Some(room.row.id),
                      ),
                      offer_rules.case_consistency(o, Some(room.status), now),
                    ),
                    json.string,
                  ),
                ),
              ],
            ),
          )
        })
      http.json(
        200,
        json.object([
          #("offers", json.preprocessed_array(listed)),
          #(
            "liveOfferId",
            json.nullable(option.map(live, fn(o) { o.row.id }), id.offer_json),
          ),
          #(
            "requirements",
            json.object([
              #(
                "role",
                json.nullable(
                  option.map(role, room_rules.role_code),
                  json.string,
                ),
              ),
              #(
                "canDraft",
                json.bool(room_rules.room_can(role, room_rules.OfferDraft)),
              ),
              #(
                "canIssue",
                json.bool(room_rules.room_can(role, room_rules.OfferIssue)),
              ),
              #("status", room_status.to_json(room.status)),
              #("statusLabel", json.string(status_label(room.status))),
              #("draftBlockers", json.array(draft_blockers, json.string)),
              #("issueBlockers", json.array(issue_blockers, json.string)),
              #("blocked", json.bool(is_blocked)),
              #("subjectRemoved", json.bool(removed)),
            ]),
          ),
          #(
            "vocabulary",
            json.object([
              #(
                "statuses",
                json.array(offer_rules.statuses, offer_status.to_json),
              ),
              #("statusLabels", offer_rules.status_labels_json()),
              #("types", json.array(offer_rules.types, json.string)),
              #(
                "responseTypes",
                json.array(offer_rules.response_types, json.string),
              ),
            ]),
          ),
          #("limits", offer_rules.limits_json()),
          #("policyVersion", json.int(offer_rules.policy_version)),
          #(
            "note",
            json.string(
              "An Offer is created only by an explicit act here. A positive recruitment decision opens the door; it never walks through it. Issuing an Offer moves the case to Offer made; the recipient's own acceptance or decline moves it on. Nothing here is a signing.",
            ),
          ),
        ]),
      )
    }
  }
}

/// The content every Offer write may carry. `None` is absent; `Some(None)` is null.
type ContentInput {
  ContentInput(
    terms: Option(Option(offer_rules.TermsInput)),
    recipient_message: Option(Option(String)),
    internal_note: Option(Option(String)),
    expires_at: Option(Dynamic),
    documents: Option(List(offer_rules.DocumentRef)),
  )
}

fn content_fields(next: fn(ContentInput) -> input.Shape(a)) -> input.Shape(a) {
  use terms <- input.field("terms", offer_rules.terms_check())
  use recipient_message <- input.field(
    "recipientMessage",
    offer_rules.message_check(),
  )
  use internal_note <- input.field("internalNote", offer_rules.message_check())
  use expires_at <- input.field("expiresAt", input.optional(input.anything()))
  use documents <- input.field("documents", offer_rules.documents_check())
  next(ContentInput(
    terms:,
    recipient_message:,
    internal_note:,
    expires_at:,
    documents:,
  ))
}

type NewBody {
  NewBody(
    content: ContentInput,
    client_key: Option(Dynamic),
    transaction_id: Option(String),
  )
}

/// The vault records a revision names, each the organisation's own.
fn resolve_documents(
  read: Read,
  refs: List(offer_rules.DocumentRef),
  org_id: id.OrgId,
) -> Result(Result(List(offers.Document), Response), Fail(e)) {
  list.try_fold(refs, Ok([]), fn(acc, d) {
    case acc {
      Error(_) -> Ok(acc)
      Ok(out) -> {
        // A document ref is the request's: its text names a vault record.
        use found <- result.map(vault_record(read, id.evidence(d.evidence_id)))
        let mine = Some(org_id)
        case found {
          Some(ev) if ev.org_id == mine ->
            Ok([
              offers.Document(
                evidence_id: ev.id,
                label: option.or(d.label, ev.filename),
                mime: option.map(ev.mime, evidence_row.mime_to_string),
                bytes: ev.bytes,
              ),
              ..out
            ])
          _ ->
            Error(
              err(
                "OFFER_DOCUMENT_INVALID",
                "No evidence record of yours matches that reference.",
                [#("field", json.string("documents"))],
              ),
            )
        }
      }
    }
  })
  |> result.map(result.map(_, list.reverse))
}

fn vault_record(
  read: Read,
  evidence_id: id.EvidenceId,
) -> Result(Option(evidence_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> evidence_row.columns <> " FROM ver_evidence WHERE id = ?",
    [id.evidence_sql(evidence_id)],
    evidence_row.decoder(),
  )
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

fn fingerprint(
  terms: offer_rules.Terms,
  m: offer_rules.Messages,
  expires: Option(Int),
  documents: List(String),
) -> String {
  canonical.Object([
    #(
      "terms",
      canonical.Object([
        #("offerType", canonical.Str("direct_recruitment")),
        #("role", canonical.text(terms.role)),
        #("squad", canonical.text(terms.squad)),
        #("conditions", canonical.text(terms.conditions)),
        #("startDate", canonical.text(terms.start_date)),
        #("endDate", canonical.text(terms.end_date)),
      ]),
    ),
    #("recipientMessage", canonical.text(m.recipient_message)),
    #("internalNote", canonical.text(m.internal_note)),
    #("expiresAt", canonical.int(expires)),
    #("documents", canonical.strings(documents)),
  ])
  |> canonical.to_string
}

fn terms_or_none(
  t: Option(Option(offer_rules.TermsInput)),
) -> offer_rules.TermsInput {
  t |> option.flatten |> option.unwrap(offer_rules.no_terms)
}

/// `POST /org/rooms/:id/offers`: a draft, an explicit act from `offer_consideration`, after a finalized decision,
/// once.
pub fn create(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  use room, _ <- room_for(ctx, a, room_id, room_rules.OfferDraft)
  let now = clock.request_ms(ctx.config, req)
  let shape = {
    use content <- content_fields
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use transaction_id <- input.field(
      "transactionId",
      input.nullish(input.text(1_000_000)),
    )
    input.done(NewBody(content:, client_key:, transaction_id:))
  }
  use b, _ <- body(req, shape)
  use key <- client_key(b.client_key)
  let validated = {
    use terms <- result.try(offer_rules.validate_terms(
      terms_or_none(b.content.terms),
      False,
    ))
    use m <- result.try(offer_rules.validate_messages(
      option.flatten(b.content.recipient_message),
      option.flatten(b.content.internal_note),
    ))
    use expires <- result.try(offer_rules.validate_expiry(
      b.content.expires_at,
      Some(now),
      False,
    ))
    use docs <- result.map(offer_rules.validate_documents(b.content.documents))
    #(terms, m, expires, option.unwrap(docs, []))
  }
  case validated {
    Error(r) -> fail(r)
    Ok(#(terms, m, expires, doc_refs)) -> {
      let fp =
        fingerprint(
          terms,
          m,
          expires,
          list.map(doc_refs, fn(d) { d.evidence_id }),
        )
      let r = room.row
      case
        read(ctx, fn(rd) {
          use all <- result.try(offers_of_case(rd, room))
          use removed <- result.try(subject_removed(rd, room))
          use is_blocked <- result.try(blocked(rd, room))
          use dp <- result.map(case_lifecycle.evidence(
            rd,
            room,
            room_rules.DecisionProgress,
            now,
          ))
          #(all, removed, is_blocked, dp)
        })
      {
        Error(response) -> response
        Ok(#(all, removed, is_blocked, dp)) -> {
          let prior = case key {
            Some(k) ->
              list.find(all, fn(o) { o.row.create_key == Some(k) })
              |> option.from_result
            None -> None
          }
          case prior {
            Some(p) ->
              case p.row.create_fp == Some(fp) {
                True ->
                  http.json(
                    200,
                    json.object([
                      #("offer", json.object(offer_rules.club_view(p, now))),
                      #("idempotent", json.bool(True)),
                    ]),
                  )
                False ->
                  err(
                    "OFFER_IDEMPOTENCY_CONFLICT",
                    "This clientKey was already used for a different Offer.",
                    [],
                  )
              }
            None ->
              case
                removed,
                is_blocked,
                room.status == room_status.OfferConsideration,
                dp,
                live_offer(all, now)
              {
                True, _, _, _, _ ->
                  err(
                    "OFFER_SUBJECT_REMOVED",
                    "This player removed their ScoutBox account. No Offer is written about a person who left.",
                    [],
                  )
                _, True, _, _, _ ->
                  err(
                    "OFFER_BLOCKED",
                    "This player (or their guardian) has blocked your organisation. No Offer is drafted while the block stands.",
                    [],
                  )
                _, _, False, _, _ ->
                  err(
                    "OFFER_STATE_INVALID",
                    "An Offer is drafted from Offer consideration; this case is at \""
                      <> status_label(room.status)
                      <> "\".",
                    [
                      #(
                        "current",
                        json.object([
                          #("status", room_status.to_json(room.status)),
                        ]),
                      ),
                    ],
                  )
                _, _, _, case_lifecycle.Lacks(_), _ ->
                  err(
                    "OFFER_ISSUE_NOT_ALLOWED",
                    "A finalized recruitment decision to progress must stand on this case before an Offer is drafted.",
                    [
                      #(
                        "reasons",
                        json.array(["DECISION_REQUIRED"], json.string),
                      ),
                    ],
                  )
                _, _, _, _, Some(live) ->
                  err(
                    "OFFER_STATE_INVALID",
                    "This case already has a live Offer. Edit, issue or withdraw it; a changed Offer is a new revision, not a second Offer.",
                    [
                      #(
                        "current",
                        json.object([
                          #("offerId", id.offer_json(live.row.id)),
                          #(
                            "status",
                            json.nullable(
                              offer_rules.status(live, now),
                              offer_status.to_json,
                            ),
                          ),
                        ]),
                      ),
                    ],
                  )
                _, _, _, case_lifecycle.Holds(_, decision_id), None -> {
                  use <- limited(
                    ctx,
                    req,
                    limits.OfferDraftWrite,
                    id.org_to_string(a.org.id),
                    now,
                  )
                  let workspace = case input.filled(b.transaction_id) {
                    Some(tid) ->
                      read(ctx, transaction_routes.offer_readiness_for(
                        _,
                        tid,
                        r.org_id,
                        r.id,
                        now,
                      ))
                      |> result.map(option.map(_, fn(found) { found.0.row.id }))
                      |> result.map(Some)
                    None -> Ok(None)
                  }
                  case workspace {
                    Error(response) -> response
                    Ok(Some(None)) ->
                      err(
                        "OFFER_INPUT_INVALID",
                        "No transaction workspace of yours for this case matches that reference.",
                        [#("field", json.string("transactionId"))],
                      )
                    Ok(workspace) -> {
                      let transaction_id =
                        option.flatten(workspace)
                        |> option.map(id.transaction_to_string)
                      case read(ctx, resolve_documents(_, doc_refs, r.org_id)) {
                        Error(response) -> response
                        Ok(Error(response)) -> response
                        Ok(Ok(docs)) -> {
                          use <- moderated(
                            ctx,
                            m.recipient_message,
                            org_context(a, "recruitment_offer"),
                          )
                          store.unit(ctx.store, fn(tx) {
                            use _ <- result.try(
                              offers.case_unchanged(tx, r.id, all) |> storage,
                            )
                            use offer_id <- result.try(
                              offers.create(
                                tx,
                                offers.NewOffer(
                                  org_id: r.org_id,
                                  case_id: r.id,
                                  player_id: r.player_id,
                                  decision_id: Some(id.room_decision(
                                    decision_id,
                                  )),
                                  transaction_id:,
                                  content: offers.Content(
                                    terms,
                                    m.recipient_message,
                                    m.internal_note,
                                    expires,
                                  ),
                                  documents: docs,
                                  by: by_staff(a),
                                  create_key: option.map(key, fn(k) { #(k, fp) }),
                                  at: now,
                                ),
                              )
                              |> storage,
                            )
                            use stored <- result.try(reread(tx, offer_id))
                            let assert Some(rev) =
                              offer_rules.current_revision(stored)
                              as "a new Offer has its draft"
                            use _ <- result.map(
                              case_audit(
                                tx,
                                room,
                                cases.by_staff(a.user.id, a.user.name),
                                "offer_draft_created",
                                [
                                  #("offerId", id.offer_json(offer_id)),
                                  #(
                                    "revisionId",
                                    id.offer_revision_json(rev.row.id),
                                  ),
                                ],
                                now,
                              )
                              |> storage,
                            )
                            store.emit(
                              tx,
                              effect.Live(offer_event(
                                live_event.OfferDraftCreated,
                                stored,
                              )),
                            )
                            http.json(
                              201,
                              json.object([
                                #(
                                  "offer",
                                  json.object(offer_rules.club_view(stored, now)),
                                ),
                              ]),
                            )
                          })
                          |> room_routes.answer
                        }
                      }
                    }
                  }
                }
              }
          }
        }
      }
    }
  }
}

/// The club's view of an Offer with its signing summary.
fn club_json(read: Read, o: Offer, now: Int) -> Result(Json, Fail(e)) {
  use summary <- result.map(signing_reads.summary_for_offer(
    read,
    o.row.id,
    o.row.org_id,
    now,
  ))
  json.object(signing_reads.with_signing(offer_rules.club_view(o, now), summary))
}

fn club_json_now(
  ctx: Ctx,
  o: Offer,
  now: Int,
  next: fn(Json) -> Response,
) -> Response {
  case read(ctx, club_json(_, o, now)) {
    Ok(view) -> next(view)
    Error(response) -> response
  }
}

/// `GET /org/offers/:id`.
pub fn get(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o, _, _ <- offer_for(ctx, a, offer_id, room_rules.OfferView, now)
  use view <- club_json_now(ctx, o, now)
  http.json(200, json.object([#("offer", view)]))
}

/// `GET /org/offers/:id/history`.
pub fn history(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o, _, _ <- offer_for(ctx, a, offer_id, room_rules.OfferView, now)
  let items = offer_rules.history_view(o, False)
  let n = list.length(items)
  http.json(
    200,
    json.object([
      #(
        "items",
        json.preprocessed_array(list.drop(
          items,
          int.max(0, n - offer_rules.history_page),
        )),
      ),
      #("offerId", id.offer_json(o.row.id)),
    ]),
  )
}

type EditBody {
  EditBody(content: ContentInput)
}

/// `PATCH /org/offers/:id/draft`.
pub fn edit_draft(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o, room, _ <- offer_for(ctx, a, offer_id, room_rules.OfferDraft, now)
  let assert Some(rev) = offer_rules.current_revision(o)
    as "a sound Offer has its revision"
  let st = offer_rules.effective(rev.row, now)
  case st == Draft, read(ctx, subject_removed(_, room)) {
    False, _ ->
      err(
        "OFFER_STATE_INVALID",
        "Only a draft revision can be edited. Issued terms are immutable; open a new revision to change them.",
        [#("current", json.object([#("status", offer_status.to_json(st))]))],
      )
    _, Error(response) -> response
    True, Ok(True) ->
      err(
        "OFFER_SUBJECT_REMOVED",
        "This player removed their ScoutBox account. The draft can no longer be changed.",
        [],
      )
    True, Ok(False) -> {
      let shape = {
        use content <- content_fields
        use <- rev.fields
        input.done(EditBody(content:))
      }
      use b, raw <- body(req, shape)
      let c = b.content
      let validated = {
        use terms <- result.try(case c.terms {
          Some(t) ->
            offer_rules.validate_terms(
              option.unwrap(t, offer_rules.no_terms),
              False,
            )
            |> result.map(Some)
          None -> Ok(None)
        })
        use m <- result.try(
          offer_rules.validate_messages(
            case c.recipient_message {
              Some(v) -> v
              None -> rev.row.recipient_message
            },
            case c.internal_note {
              Some(v) -> v
              None -> rev.row.internal_note
            },
          ),
        )
        use expires <- result.try(case c.expires_at {
          Some(_) ->
            offer_rules.validate_expiry(c.expires_at, Some(now), False)
            |> result.map(Some)
          None -> Ok(None)
        })
        use docs <- result.map(offer_rules.validate_documents(c.documents))
        #(terms, m, expires, docs)
      }
      case validated {
        Error(r) -> fail(r)
        Ok(#(terms, m, expires, doc_refs)) -> {
          use <- rev_gate(raw, o)
          use <- limited(
            ctx,
            req,
            limits.OfferDraftWrite,
            id.org_to_string(a.org.id),
            now,
          )
          let docs = case doc_refs {
            Some(refs) ->
              read(ctx, resolve_documents(_, refs, room.row.org_id))
              |> result.map(result.map(_, Some))
            None -> Ok(Ok(None))
          }
          case docs {
            Error(response) -> response
            Ok(Error(response)) -> response
            Ok(Ok(docs)) -> {
              let given = case c.recipient_message {
                Some(_) -> m.recipient_message
                None -> None
              }
              use <- moderated(ctx, given, org_context(a, "recruitment_offer"))
              store.unit(ctx.store, fn(tx) {
                use _ <- result.try(offers.unchanged(tx, o) |> storage)
                use _ <- result.try(
                  offers.edit_draft(
                    tx,
                    o.row.id,
                    rev.row.id,
                    offers.Content(
                      option.unwrap(terms, offer_rules.terms_of(rev.row)),
                      m.recipient_message,
                      m.internal_note,
                      option.unwrap(expires, rev.row.expires_at),
                    ),
                    docs,
                    by_staff(a),
                    now,
                  )
                  |> storage,
                )
                use e <- result.try(
                  offers.entry(
                    tx,
                    "offer_draft_updated",
                    staff_actor(a),
                    [#("revisionId", id.offer_revision_json(rev.row.id))],
                    now,
                  )
                  |> storage,
                )
                use _ <- result.try(
                  offers.record_act(
                    tx,
                    o.row.id,
                    offers.Bookkeeping(
                      ..offers.bookkeeping(now),
                      rev_by: Some(#(a.user.id, a.user.name)),
                      touch: True,
                      bump: True,
                      bump_revision: Some(rev.row.id),
                      history: [e],
                    ),
                  )
                  |> storage,
                )
                use stored <- result.map(reread(tx, o.row.id))
                store.emit(
                  tx,
                  effect.Live(offer_event(live_event.OfferDraftUpdated, stored)),
                )
                http.json(
                  200,
                  json.object([
                    #("offer", json.object(offer_rules.club_view(stored, now))),
                  ]),
                )
              })
              |> room_routes.answer
            }
          }
        }
      }
    }
  }
}

type KeyBody {
  KeyBody(client_key: Option(Dynamic), reason: Option(String))
}

fn used_key(
  o: Offer,
  act: key_row.Act,
  key: Option(String),
) -> Option(key_row.Row) {
  case key {
    None -> None
    Some(k) ->
      list.find(o.keys, fn(x) { x.act == act && x.key == k })
      |> option.from_result
  }
}

fn replay_json(ctx: Ctx, o: Offer, now: Int) -> Response {
  use view <- club_json_now(ctx, o, now)
  http.json(
    200,
    json.object([
      #("offer", view),
      #("lifecycle", offer_rules.lifecycle_json(o.row)),
      #("idempotent", json.bool(True)),
    ]),
  )
}

/// `POST /org/offers/:id/issue`. Everything is re-resolved at issue: role, ownership, state, rev, subject, block,
/// recipient (adult, guardian route, minor pathway), expiry and document ownership. The revision and the case move
/// persist together or not at all.
pub fn issue(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o, room, role <- offer_for(ctx, a, offer_id, room_rules.OfferIssue, now)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev.fields
    input.done(KeyBody(client_key:, reason: None))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let assert Some(rev) = offer_rules.current_revision(o)
    as "a sound Offer has its revision"
  case used_key(o, key_row.Issue, key) {
    Some(used) ->
      case used.revision_id == rev.row.id {
        True -> replay_json(ctx, o, now)
        False ->
          err(
            "OFFER_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used to issue a different revision.",
            [],
          )
      }
    None -> {
      let st = offer_rules.effective(rev.row, now)
      let live_now = offer_rules.live_status(o, now)
      case st, live_now {
        _, _ if st != Draft ->
          err(
            "OFFER_STATE_INVALID",
            case st {
              Issued -> "This revision is already issued."
              _ -> "Only a draft revision can be issued."
            },
            [#("current", json.object([#("status", offer_status.to_json(st))]))],
          )
        _, Some(Accepted) ->
          err(
            "OFFER_STATE_INVALID",
            "The recipient accepted the revision that is out. A new revision is not issued over an acceptance.",
            [
              #(
                "current",
                json.object([#("status", offer_status.to_json(Accepted))]),
              ),
            ],
          )
        _, _ -> {
          use <- rev_gate(raw, o)
          issue_checked(ctx, req, a, o, room, role, rev, key, now)
        }
      }
    }
  }
}

fn issue_checked(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  o: Offer,
  room: Room,
  role: Option(room_rules.RoomRole),
  rev: Revision,
  key: Option(String),
  now: Int,
) -> Response {
  let r = room.row
  case
    read(ctx, fn(rd) {
      use removed <- result.try(subject_removed(rd, room))
      use is_blocked <- result.try(blocked(rd, room))
      use org <- result.try(org_of(rd, r.org_id))
      let org = option.unwrap(org, a.org)
      use rec <- result.try(recipients.resolve(rd, r.player_id, org, now))
      use docs_ok <- result.map(
        list.try_map(rev.documents, fn(d) {
          vault_record(rd, d.evidence_id)
          |> result.map(fn(ev) {
            case ev {
              Some(ev) -> ev.org_id == Some(r.org_id)
              None -> False
            }
          })
        }),
      )
      #(removed, is_blocked, org, rec, list.all(docs_ok, fn(x) { x }))
    })
  {
    Error(response) -> response
    Ok(#(True, _, _, _, _)) ->
      err(
        "OFFER_SUBJECT_REMOVED",
        "This player removed their ScoutBox account. No Offer is issued to a person who left.",
        [],
      )
    Ok(#(_, True, _, _, _)) ->
      err(
        "OFFER_BLOCKED",
        "This player (or their guardian) has blocked your organisation. An Offer is not issued while the block stands.",
        [],
      )
    Ok(#(_, _, org, rec, docs_ok)) ->
      case
        room.status == room_status.OfferConsideration
        || room.status == room_status.OfferMade
      {
        False ->
          err(
            "OFFER_LIFECYCLE_CONFLICT",
            "The case at \""
              <> status_label(room.status)
              <> "\" cannot take an issued Offer.",
            [
              #(
                "current",
                json.object([#("status", room_status.to_json(room.status))]),
              ),
            ],
          )
        True ->
          case
            offer_rules.validate_terms(
              offer_rules.stored_terms_input(rev.row),
              True,
            ),
            offer_rules.validate_expiry(
              option.map(rev.row.expires_at, dynamic.int),
              Some(now),
              True,
            )
          {
            Error(t), _ ->
              err(
                t.error,
                t.message,
                list.filter(t.fields, fn(f) { f.0 == "field" }),
              )
            _, Error(x) ->
              err(x.error, x.message, [#("field", json.string("expiresAt"))])
            Ok(terms), Ok(_) ->
              case docs_ok {
                False ->
                  err(
                    "OFFER_DOCUMENT_INVALID",
                    "A document on this draft no longer belongs to your organisation.",
                    [#("field", json.string("documents"))],
                  )
                True ->
                  case rec {
                    Error(recipients.Blocked) ->
                      err(
                        "OFFER_BLOCKED",
                        "This player (or their guardian) has blocked your organisation.",
                        [],
                      )
                    Error(recipients.GuardianRequired) ->
                      err(
                        "OFFER_RECIPIENT_INVALID",
                        "This player is under the age of majority and no valid guardian route exists.",
                        [],
                      )
                    Error(recipients.Unavailable(message)) ->
                      err("OFFER_RECIPIENT_INVALID", message, [])
                    Ok(recipient) ->
                      case
                        recipient.minor
                        && !offer_rules.minor_pathway_open(option.unwrap(
                          org.country,
                          "GB",
                        ))
                      {
                        True ->
                          err(
                            "OFFER_RECIPIENT_INVALID",
                            "This player is under the age of majority. No jurisdiction policy for an Offer to a minor is encoded in this build, so the Offer is not issued.",
                            [
                              #(
                                "reasons",
                                json.array(
                                  ["MINOR_PATHWAY_CLOSED"],
                                  json.string,
                                ),
                              ),
                            ],
                          )
                        False -> {
                          // The workspace's readiness is re-evaluated now, not taken from the draft.
                          use readiness <- workspace_ready(ctx, o, room, now)
                          use <- limited(
                            ctx,
                            req,
                            limits.OfferIssue,
                            id.org_to_string(a.org.id),
                            now,
                          )
                          issue_write(
                            ctx,
                            a,
                            o,
                            room,
                            role,
                            rev,
                            terms,
                            recipient,
                            org,
                            key,
                            readiness,
                            now,
                          )
                        }
                      }
                  }
              }
          }
      }
  }
}

/// The workspace the Offer cites, ready now, as the revision records it; none when it cites none.
fn workspace_ready(
  ctx: Ctx,
  o: Offer,
  room: Room,
  now: Int,
  next: fn(Option(offers.Readiness)) -> Response,
) -> Response {
  case o.row.transaction_id {
    None -> next(None)
    Some(tid) ->
      case
        read(ctx, transaction_routes.offer_readiness_for(
          _,
          tid,
          room.row.org_id,
          room.row.id,
          now,
        ))
      {
        Error(response) -> response
        Ok(None) ->
          err(
            "OFFER_COMPLIANCE_BLOCKED",
            "The transaction workspace this Offer references is no longer available to you.",
            [#("blockers", json.array(["TRANSACTION_MISSING"], json.string))],
          )
        Ok(Some(#(_, r))) if !r.can_start ->
          err(
            "OFFER_COMPLIANCE_BLOCKED",
            "The transaction workspace does not currently permit an Offer.",
            [#("blockers", json.array(r.blockers, json.string))],
          )
        Ok(Some(#(t, _))) ->
          next(
            Some(offers.Readiness(
              transaction_id: id.transaction_to_string(t.row.id),
              status: transaction_status.to_string(t.row.status),
              at: now,
            )),
          )
      }
  }
}

fn issue_write(
  ctx: Ctx,
  a: OrgAccess,
  o: Offer,
  room: Room,
  role: Option(room_rules.RoomRole),
  rev: Revision,
  terms: offer_rules.Terms,
  recipient: recipients.Recipient,
  org: orgs.Row,
  key: Option(String),
  readiness: Option(offers.Readiness),
  now: Int,
) -> Response {
  let prev_issued =
    list.find(o.revisions, fn(x) {
      Some(x.row.id) == rev.row.supersedes_revision_id && x.row.status == Issued
    })
    |> option.from_result
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(offers.unchanged(tx, o) |> storage)
    use _ <- result.try(
      offers.issue_revision(
        tx,
        o.row.id,
        rev.row.id,
        terms,
        offers.RecipientSnapshot(
          kind: recipient.kind,
          player_id: recipient.player_id,
          guardian_id: recipient.guardian_id,
          minor: recipient.minor,
          at: now,
        ),
        option.map(prev_issued, fn(p) { p.row.id }),
        readiness,
        by_staff(a),
        now,
      )
      |> storage,
    )
    use moved <- result.try(
      advance(
        tx,
        room,
        room_view.level(a.org),
        "sendOffer",
        role,
        case_lifecycle.StaffMover(a.user.id, a.user.name),
        "offer:issue:" <> id.offer_to_string(o.row.id),
        [
          #("offerId", id.offer_json(o.row.id)),
          #("revisionId", id.offer_revision_json(rev.row.id)),
        ],
        now,
      )
      |> storage,
    )
    let l = moved.lifecycle
    use _ <- result.try(case l.applied || l.reason == Some("already_there") {
      True -> Ok(Nil)
      False ->
        store.refuse(
          err(
            "OFFER_LIFECYCLE_CONFLICT",
            string.trim(
              "The case at \""
              <> status_label(room.status)
              <> "\" cannot take the step an issued Offer asks for (sendOffer). "
              <> option.unwrap(l.message, ""),
            ),
            [
              #("lifecycle", json.nullable(l.reason, json.string)),
              #(
                "allowed",
                json.array(option.unwrap(l.allowed, []), json.string),
              ),
              #(
                "current",
                json.object([#("status", room_status.to_json(room.status))]),
              ),
            ],
          ),
        )
    })
    let detail = [
      #("revisionId", id.offer_revision_json(rev.row.id)),
      #("revisionNumber", json.int(rev.row.revision_number)),
    ]
    use first <- result.try(
      offers.entry(
        tx,
        case prev_issued {
          Some(_) -> "offer_superseded"
          None -> "offer_issued"
        },
        staff_actor(a),
        list.append(detail, [
          #(
            "supersedes",
            json.nullable(
              option.map(prev_issued, fn(p) { p.row.id }),
              id.offer_revision_json,
            ),
          ),
          #("expiresAt", json.nullable(rev.row.expires_at, json.int)),
        ]),
        now,
      )
      |> storage,
    )
    use history <- result.try(case prev_issued {
      Some(_) -> {
        use e <- result.map(
          offers.entry(
            tx,
            "offer_issued",
            staff_actor(a),
            list.append(detail, [
              #("expiresAt", json.nullable(rev.row.expires_at, json.int)),
            ]),
            now,
          )
          |> storage,
        )
        [first, e]
      }
      None -> Ok([first])
    })
    use _ <- result.try(
      offers.record_act(
        tx,
        o.row.id,
        offers.Bookkeeping(
          ..offers.bookkeeping(now),
          rev_by: Some(#(a.user.id, a.user.name)),
          touch: True,
          bump: True,
          bump_revision: Some(rev.row.id),
          lifecycle: Some(l),
          key: option.map(key, fn(k) { #(key_row.Issue, k, rev.row.id) }),
          history:,
        ),
      )
      |> storage,
    )
    use _ <- result.try(
      case_audit(
        tx,
        room,
        cases.by_staff(a.user.id, a.user.name),
        case prev_issued {
          Some(_) -> "offer_superseded"
          None -> "offer_issued"
        },
        list.flatten([
          [
            #("offerId", id.offer_json(o.row.id)),
            #("revisionId", id.offer_revision_json(rev.row.id)),
            #(
              "supersedes",
              json.nullable(
                option.map(prev_issued, fn(p) { p.row.id }),
                id.offer_revision_json,
              ),
            ),
          ],
          case l.applied, l.to {
            True, Some(to) -> [#("to", json.string(to))]
            _, _ -> []
          },
        ]),
        now,
      )
      |> storage,
    )
    use fresh <- result.try(reread(tx, o.row.id))
    case prev_issued {
      Some(_) ->
        store.emit(
          tx,
          effect.Live(offer_event(live_event.OfferSuperseded, fresh)),
        )
      None -> Nil
    }
    store.emit(tx, effect.Live(offer_event(live_event.OfferIssued, fresh)))
    let revised = case prev_issued {
      Some(_) -> " (a revised one)"
      None -> ""
    }
    use _ <- result.try(
      notify_recipient(
        tx,
        offer_rules.current_revision(fresh),
        org.name
          <> " has issued you an Offer"
          <> revised
          <> ". Read the exact terms in ScoutBox and answer before it expires. Accepting is not a signing.",
        o.row.id,
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      notify_agent(
        tx,
        fresh,
        squash(
          "Your client "
          <> option.unwrap(room.row.player_name, "")
          <> " received a"
          <> case prev_issued {
            Some(_) -> " revised"
            None -> "n"
          }
          <> " Offer from "
          <> org.name
          <> ". Their answer is their own act.",
        ),
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      [Some(room.row.owner_user_id), room.row.room_lead_scout_user_id]
      |> option.values
      |> list.unique
      |> list.filter(fn(u) { u != a.user.id })
      |> list.try_each(fn(u) {
        notify(
          tx,
          audience.OrgUser,
          id.org_user_to_string(u),
          "Recruitment Room — "
            <> option.unwrap(room.row.player_name, "a removed player")
            <> ": Offer revision "
            <> int.to_string(rev.row.revision_number)
            <> " issued.",
          o.row.id,
          now,
        )
      })
      |> storage,
    )
    Ok(http.json(
      200,
      json.object([
        #("offer", json.object(offer_rules.club_view(fresh, now))),
        #("lifecycle", moved.json),
        #("case", case l.applied, l.from, l.to {
          True, Some(from), Some(to) ->
            json.object([#("from", json.string(from)), #("to", json.string(to))])
          _, _, _ ->
            json.object([
              #("unchanged", json.bool(True)),
              #("status", room_status.to_json(room.status)),
            ])
        }),
        #("rev", json.int(room.rev)),
      ]),
    ))
  })
  |> room_routes.answer
}

/// `\s+` becomes one space, as the TypeScript notices tidy a missing name.
fn squash(s: String) -> String {
  s
  |> string.split(" ")
  |> list.filter(fn(w) { w != "" })
  |> string.join(" ")
}

/// `POST /org/offers/:id/withdraw`. A draft goes quietly; an issued Offer steps the case back to
/// `offer_consideration`, because the decision still stands. A block does not stop a withdrawal.
pub fn withdraw(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o, room, role <- offer_for(ctx, a, offer_id, room_rules.OfferIssue, now)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev.fields
    use reason <- input.field(
      "reason",
      input.nullish(input.text(offer_rules.limit_withdraw_reason)),
    )
    input.done(KeyBody(client_key:, reason:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let assert Some(current) = offer_rules.current_revision(o)
    as "a sound Offer has its revision"
  case used_key(o, key_row.Withdraw, key) {
    Some(used) ->
      case used.revision_id == current.row.id {
        True -> replay_json(ctx, o, now)
        False ->
          err(
            "OFFER_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used to withdraw a different revision.",
            [],
          )
      }
    None ->
      case offer_rules.can_withdraw(o, now) {
        Error(r) -> fail(r)
        Ok(#(rev, from)) -> {
          let reason = case option.map(b.reason, string.trim) {
            Some("") | None -> None
            other -> other
          }
          use <- rev_gate(raw, o)
          use <- limited(
            ctx,
            req,
            limits.OfferWithdraw,
            id.org_to_string(a.org.id),
            now,
          )
          let was_issued = from == Issued
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(offers.unchanged(tx, o) |> storage)
            use _ <- result.try(
              offers.withdraw_revision(
                tx,
                o.row.id,
                rev.row.id,
                reason,
                by_staff(a),
                now,
              )
              |> storage,
            )
            let from_text = room_status.to_string(room.status)
            use moved <- result.try(
              case was_issued && room.status == room_status.OfferMade {
                True ->
                  advance(
                    tx,
                    room,
                    room_view.level(a.org),
                    "considerOffer",
                    role,
                    case_lifecycle.StaffMover(a.user.id, a.user.name),
                    "offer:withdraw:" <> id.offer_to_string(o.row.id),
                    [
                      #("offerId", id.offer_json(o.row.id)),
                      #("revisionId", id.offer_revision_json(rev.row.id)),
                    ],
                    now,
                  )
                  |> storage
                False ->
                  Ok(Moved(
                    offers.Lifecycle(
                      False,
                      None,
                      Some(from_text),
                      Some(from_text),
                      now,
                      Some("draft"),
                      None,
                      None,
                    ),
                    json.object([
                      #("applied", json.bool(False)),
                      #("action", json.null()),
                      #("reason", json.string("draft")),
                      #("from", json.string(from_text)),
                      #("to", json.string(from_text)),
                      #("at", json.int(now)),
                    ]),
                  ))
              },
            )
            let l = moved.lifecycle
            use e <- result.try(
              offers.entry(
                tx,
                "offer_withdrawn",
                staff_actor(a),
                [
                  #("revisionId", id.offer_revision_json(rev.row.id)),
                  #("wasIssued", json.bool(was_issued)),
                  #("hadReason", json.bool(reason != None)),
                ],
                now,
              )
              |> storage,
            )
            use _ <- result.try(
              offers.record_act(
                tx,
                o.row.id,
                offers.Bookkeeping(
                  ..offers.bookkeeping(now),
                  rev_by: Some(#(a.user.id, a.user.name)),
                  touch: True,
                  bump: True,
                  bump_revision: Some(rev.row.id),
                  lifecycle: Some(l),
                  key: option.map(key, fn(k) {
                    #(key_row.Withdraw, k, rev.row.id)
                  }),
                  history: [e],
                ),
              )
              |> storage,
            )
            use _ <- result.try(
              case_audit(
                tx,
                room,
                cases.by_staff(a.user.id, a.user.name),
                "offer_withdrawn",
                list.flatten([
                  [
                    #("offerId", id.offer_json(o.row.id)),
                    #("revisionId", id.offer_revision_json(rev.row.id)),
                    #("wasIssued", json.bool(was_issued)),
                  ],
                  case l.applied, l.to {
                    True, Some(to) -> [#("to", json.string(to))]
                    _, _ -> []
                  },
                ]),
                now,
              )
              |> storage,
            )
            use fresh <- result.try(reread(tx, o.row.id))
            store.emit(
              tx,
              effect.Live(offer_event(live_event.OfferWithdrawn, fresh)),
            )
            use _ <- result.try(case was_issued {
              True -> {
                use org <- result.try(
                  org_of(store.reading(tx), room.row.org_id) |> storage,
                )
                use _ <- result.try(
                  notify_recipient(
                    tx,
                    offer_rules.current_revision(fresh),
                    option.map(org, fn(x) { x.name })
                    |> option.unwrap("The club")
                      <> " has withdrawn its Offer. Nothing further is needed from you.",
                    o.row.id,
                    now,
                  )
                  |> storage,
                )
                notify_agent(
                  tx,
                  fresh,
                  squash(
                    "The Offer to your client "
                    <> option.unwrap(room.row.player_name, "")
                    <> " was withdrawn by the club.",
                  ),
                  now,
                )
                |> storage
              }
              False -> Ok(Nil)
            })
            Ok(http.json(
              200,
              json.object([
                #("offer", json.object(offer_rules.club_view(fresh, now))),
                #("lifecycle", moved.json),
              ]),
            ))
          })
          |> room_routes.answer
        }
      }
  }
}

type ReviseBody {
  ReviseBody(content: ContentInput, client_key: Option(Dynamic))
}

/// `POST /org/offers/:id/revise`: a change is a new revision; the old one is history.
pub fn revise(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o, room, _ <- offer_for(ctx, a, offer_id, room_rules.OfferDraft, now)
  let shape = {
    use content <- content_fields
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev.fields
    input.done(ReviseBody(content:, client_key:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let replayed = case used_key(o, key_row.Revise, key) {
    Some(used) -> list.any(o.revisions, fn(r) { r.row.id == used.revision_id })
    None -> False
  }
  case replayed {
    True -> {
      use view <- club_json_now(ctx, o, now)
      http.json(
        200,
        json.object([#("offer", view), #("idempotent", json.bool(True))]),
      )
    }
    False ->
      case offer_rules.can_revise(o, now) {
        Error(r) -> fail(r)
        Ok(from) ->
          case
            read(ctx, fn(rd) {
              use removed <- result.try(subject_removed(rd, room))
              use is_blocked <- result.map(blocked(rd, room))
              #(removed, is_blocked)
            })
          {
            Error(response) -> response
            Ok(#(True, _)) ->
              err(
                "OFFER_SUBJECT_REMOVED",
                "This player removed their ScoutBox account. No new revision is written.",
                [],
              )
            Ok(#(_, True)) ->
              err(
                "OFFER_BLOCKED",
                "This player (or their guardian) has blocked your organisation. No new revision is drafted while the block stands.",
                [],
              )
            Ok(#(False, False)) ->
              case
                room.status == room_status.OfferConsideration
                || room.status == room_status.OfferMade
              {
                False ->
                  err(
                    "OFFER_LIFECYCLE_CONFLICT",
                    "The case at \""
                      <> status_label(room.status)
                      <> "\" cannot take a new Offer revision.",
                    [
                      #(
                        "current",
                        json.object([
                          #("status", room_status.to_json(room.status)),
                        ]),
                      ),
                    ],
                  )
                True -> {
                  let assert Some(prev) = offer_rules.current_revision(o)
                    as "a sound Offer has its revision"
                  use <- rev_gate(raw, o)
                  revise_checked(ctx, req, a, o, room, prev, from, b, key, now)
                }
              }
          }
      }
  }
}

fn revise_checked(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  o: Offer,
  room: Room,
  prev: Revision,
  from: offer_status.OfferStatus,
  b: ReviseBody,
  key: Option(String),
  now: Int,
) -> Response {
  let c = b.content
  let validated = {
    use terms <- result.try(offer_rules.validate_terms(
      case c.terms {
        Some(t) -> option.unwrap(t, offer_rules.no_terms)
        None -> offer_rules.stored_terms_input(prev.row)
      },
      False,
    ))
    use m <- result.try(
      offer_rules.validate_messages(
        case c.recipient_message {
          Some(v) -> v
          None -> prev.row.recipient_message
        },
        case c.internal_note {
          Some(v) -> v
          None -> prev.row.internal_note
        },
      ),
    )
    use expires <- result.try(offer_rules.validate_expiry(
      c.expires_at,
      Some(now),
      False,
    ))
    use docs <- result.map(offer_rules.validate_documents(c.documents))
    #(terms, m, expires, docs)
  }
  case validated {
    Error(r) -> fail(r)
    Ok(#(terms, m, expires, doc_refs)) -> {
      use <- limited(
        ctx,
        req,
        limits.OfferDraftWrite,
        id.org_to_string(a.org.id),
        now,
      )
      let docs = case doc_refs {
        Some(refs) -> read(ctx, resolve_documents(_, refs, room.row.org_id))
        None ->
          Ok(
            Ok(
              list.map(prev.documents, fn(d) {
                offers.Document(d.evidence_id, d.label, d.mime, d.bytes)
              }),
            ),
          )
      }
      case docs {
        Error(response) -> response
        Ok(Error(response)) -> response
        Ok(Ok(docs)) -> {
          let given = case c.recipient_message {
            Some(_) -> m.recipient_message
            None -> None
          }
          use <- moderated(ctx, given, org_context(a, "recruitment_offer"))
          let supersedes = case from {
            Issued -> Some(prev.row.id)
            _ -> None
          }
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(offers.unchanged(tx, o) |> storage)
            use revision_id <- result.try(
              offers.add_revision(
                tx,
                o.row.id,
                offer_rules.next_revision_number(o),
                offers.Content(
                  terms,
                  m.recipient_message,
                  m.internal_note,
                  expires,
                ),
                docs,
                by_staff(a),
                supersedes,
                now,
              )
              |> storage,
            )
            use e <- result.try(
              offers.entry(
                tx,
                "offer_draft_created",
                staff_actor(a),
                [
                  #("revisionId", id.offer_revision_json(revision_id)),
                  #(
                    "revisionNumber",
                    json.int(offer_rules.next_revision_number(o)),
                  ),
                  #(
                    "supersedes",
                    json.nullable(supersedes, id.offer_revision_json),
                  ),
                ],
                now,
              )
              |> storage,
            )
            use _ <- result.try(
              offers.record_act(
                tx,
                o.row.id,
                offers.Bookkeeping(
                  ..offers.bookkeeping(now),
                  rev_by: Some(#(a.user.id, a.user.name)),
                  touch: True,
                  bump: True,
                  key: option.map(key, fn(k) {
                    #(key_row.Revise, k, revision_id)
                  }),
                  history: [e],
                ),
              )
              |> storage,
            )
            use _ <- result.try(
              case_audit(
                tx,
                room,
                cases.by_staff(a.user.id, a.user.name),
                "offer_draft_created",
                [
                  #("offerId", id.offer_json(o.row.id)),
                  #("revisionId", id.offer_revision_json(revision_id)),
                  #("revises", id.offer_revision_json(prev.row.id)),
                ],
                now,
              )
              |> storage,
            )
            use fresh <- result.map(reread(tx, o.row.id))
            store.emit(
              tx,
              effect.Live(offer_event(live_event.OfferDraftCreated, fresh)),
            )
            http.json(
              201,
              json.object([
                #("offer", json.object(offer_rules.club_view(fresh, now))),
              ]),
            )
          })
          |> room_routes.answer
        }
      }
    }
  }
}

/// `GET /org/recruitment/offer-policy`.
pub fn policy() -> Response {
  http.json(
    200,
    json.object([
      #("policyVersion", json.int(offer_rules.policy_version)),
      #("statuses", json.array(offer_rules.statuses, offer_status.to_json)),
      #("statusLabels", offer_rules.status_labels_json()),
      #("types", json.array(offer_rules.types, json.string)),
      #("responseTypes", json.array(offer_rules.response_types, json.string)),
      #("limits", offer_rules.limits_json()),
      #(
        "minorPathway",
        json.object(
          list.map(offer_rules.minor_pathway, fn(p) { #(p.0, json.bool(p.1)) }),
        ),
      ),
      #(
        "lifecycle",
        json.object([
          #("issue", json.string("offer_made")),
          #("accept", json.string("offer_accepted")),
          #("decline", json.string("offer_declined")),
          #("withdraw", json.string("offer_consideration")),
        ]),
      ),
      #(
        "note",
        json.string(
          "A recruitment decision authorises considering an Offer and creates none. Only an issued revision reaches Offer made; only the recipient's own act reaches accepted or declined; an acceptance is not a signing and P6 writes no signing.",
        ),
      ),
    ]),
  )
}

// ================================================================================================== recipient

/// Who is answering: the player themself, or a guardian for their children.
pub type Recipient {
  PlayerRecipient(p: PlayerAccess)
  GuardianRecipient(g: Guardian)
}

fn kind_of(r: Recipient) -> party.Party {
  case r {
    PlayerRecipient(_) -> party.Player
    GuardianRecipient(_) -> party.Guardian
  }
}

fn actor_id(r: Recipient) -> String {
  case r {
    PlayerRecipient(p) -> id.player_to_string(p.player.row.id)
    GuardianRecipient(g) -> id.guardian_to_string(g.row.id)
  }
}

fn actor_name(r: Recipient) -> String {
  case r {
    PlayerRecipient(p) -> p.player.row.name
    GuardianRecipient(g) -> g.row.name
  }
}

fn player_ids(r: Recipient) -> List(id.PlayerId) {
  case r {
    PlayerRecipient(p) -> [p.player.row.id]
    GuardianRecipient(g) -> g.child_ids
  }
}

fn where(r: Recipient) -> String {
  case r {
    PlayerRecipient(_) -> "player"
    GuardianRecipient(_) -> "guardian"
  }
}

/// A row shown to a recipient or agent only if it is sound and its case does not contradict it.
fn sound(read: Read, o: Offer, now: Int) -> Result(Bool, Fail(e)) {
  case offer_rules.integrity(o, None, None) {
    [_, ..] -> Ok(False)
    [] -> {
      use room <- result.map(cases.room(read, o.row.case_id))
      case room {
        Some(k) if k.row.org_id == o.row.org_id ->
          k.row.player_id == o.row.player_id
          && !offer_rules.case_corrupt(offer_rules.case_consistency(
            o,
            Some(k.status),
            now,
          ))
        _ -> True
      }
    }
  }
}

/// Offers issued to this recipient (never-issued ones are invisible, not redacted), newest first.
fn recipient_offers(
  read: Read,
  r: Recipient,
  now: Int,
) -> Result(List(Offer), Fail(e)) {
  use all <- result.try(offers.for_players(read, player_ids(r)))
  use kept <- result.map(
    list.try_fold(all, [], fn(out, o) {
      use ok <- result.map(sound(read, o, now))
      let keep =
        ok
        && case offer_rules.live_revision(o) {
          None -> False
          Some(live) ->
            case live.row.recipient_type, r {
              Some(party.Player), PlayerRecipient(_) -> True
              Some(party.Guardian), GuardianRecipient(g) ->
                live.row.recipient_guardian_id == Some(g.row.id)
              _, _ -> False
            }
        }
      case keep {
        True -> [o, ..out]
        False -> out
      }
    })
    |> result.map(list.reverse),
  )
  list.sort(kept, fn(a: Offer, b: Offer) {
    int.compare(b.row.updated_at, a.row.updated_at)
  })
}

fn case_open(read: Read, o: Offer) -> Result(Bool, Fail(e)) {
  use room <- result.map(cases.room(read, o.row.case_id))
  case room {
    Some(k) if k.row.org_id == o.row.org_id -> k.status == room_status.OfferMade
    _ -> True
  }
}

fn recipient_view(
  read: Read,
  o: Offer,
  now: Int,
) -> Result(List(#(String, Json)), Fail(e)) {
  use org <- result.try(org_of(read, o.row.org_id))
  use open <- result.try(case_open(read, o))
  use summary <- result.map(signing_reads.summary_for_offer(
    read,
    o.row.id,
    o.row.org_id,
    now,
  ))
  offer_rules.recipient_view(o, now, option.map(org, fn(x) { x.name }), open)
  |> signing_reads.with_signing(summary)
}

fn receipt_due(o: Offer, r: Recipient) -> Bool {
  case offer_rules.live_revision(o) {
    None -> False
    Some(live) ->
      !list.any(o.receipts, fn(x) {
        x.revision_id == live.row.id
        && x.viewer_kind == kind_of(r)
        && x.viewer_id == actor_id(r)
      })
  }
}

fn mark_viewed(
  tx: Tx,
  o: Offer,
  r: Recipient,
  at: Int,
) -> Result(Nil, Fail(e)) {
  case receipt_due(o, r), offer_rules.live_revision(o) {
    True, Some(live) -> {
      use _ <- result.try(offers.add_read_receipt(
        tx,
        o.row.id,
        live.row.id,
        kind_of(r),
        actor_id(r),
        at,
      ))
      use e <- result.try(offers.entry(
        tx,
        "offer_viewed",
        offers.Recipient(kind_of(r), actor_id(r), None),
        [#("revisionId", id.offer_revision_json(live.row.id))],
        at,
      ))
      offers.record_act(
        tx,
        o.row.id,
        offers.Bookkeeping(..offers.bookkeeping(at), history: [e]),
      )
    }
    _, _ -> Ok(Nil)
  }
}

/// `GET /player/offers`, `GET /guardian/offers`. Listing shows the full terms, so it counts as the recipient's
/// first sight of each live revision.
pub fn list_for(ctx: Ctx, req: Request, r: Recipient) -> Response {
  let now = clock.request_ms(ctx.config, req)
  let listed = read(ctx, recipient_offers(_, r, now))
  case listed {
    Error(response) -> response
    Ok(listed) -> {
      let unseen = list.filter(listed, receipt_due(_, r))
      let marked = case unseen {
        [] -> Ok(Nil)
        _ ->
          store.unit(ctx.store, fn(tx) {
            list.try_each(unseen, mark_viewed(tx, _, r, now))
          })
          |> result.map_error(http.internal)
      }
      case marked {
        Error(response) -> response
        Ok(Nil) ->
          case
            read(ctx, fn(rd) {
              use fresh <- result.try(recipient_offers(rd, r, now))
              list.try_map(fresh, fn(o) {
                use view <- result.try(recipient_view(rd, o, now))
                use p <- result.map(players.by_id(rd, o.row.player_id))
                json.object(
                  list.append(view, [
                    #(
                      "playerName",
                      json.nullable(
                        option.map(p, fn(x) { x.row.name }),
                        json.string,
                      ),
                    ),
                  ]),
                )
              })
            })
          {
            Error(response) -> response
            Ok(items) ->
              http.json(
                200,
                json.object([
                  #("items", json.preprocessed_array(items)),
                  #(
                    "note",
                    json.string(
                      "Offers issued to you, as the club issued them. Read the exact revision; accept or decline before it expires. Accepting in ScoutBox is not a signing.",
                    ),
                  ),
                ]),
              )
          }
      }
    }
  }
}

fn recipient_offer(
  ctx: Ctx,
  r: Recipient,
  offer_id: id.OfferId,
  now: Int,
  next: fn(Offer) -> Response,
) -> Response {
  case read(ctx, recipient_offers(_, r, now)) {
    Error(response) -> response
    Ok(all) ->
      case list.find(all, fn(o) { o.row.id == offer_id }) {
        Ok(o) -> next(o)
        Error(Nil) -> not_found()
      }
  }
}

/// `GET /player/offers/:id`, `GET /guardian/offers/:id`.
pub fn read_one(
  ctx: Ctx,
  req: Request,
  r: Recipient,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o <- recipient_offer(ctx, r, offer_id, now)
  let marked = case receipt_due(o, r) {
    True ->
      store.unit(ctx.store, mark_viewed(_, o, r, now))
      |> result.map_error(http.internal)
    False -> Ok(Nil)
  }
  case marked {
    Error(response) -> response
    Ok(Nil) ->
      case
        read(ctx, fn(rd) {
          use seen <- result.try(offers.by_id(rd, offer_id))
          let assert Some(seen) = seen as "the Offer was just read"
          use view <- result.map(recipient_view(rd, seen, now))
          #(view, offer_rules.history_view(seen, True))
        })
      {
        Error(response) -> response
        Ok(#(view, history)) ->
          http.json(
            200,
            json.object([
              #("offer", json.object(view)),
              #("history", json.preprocessed_array(history)),
            ]),
          )
      }
  }
}

type Answer {
  Answer(
    client_key: Option(Dynamic),
    revision_id: String,
    reason: Option(String),
  )
}

/// `POST /player/offers/:id/accept|decline`, `POST /guardian/offers/:id/accept|decline`: one exact revision
/// answered as the recipient's own act. A block allows a decline (a closure) but not an acceptance. The case moves
/// through the lifecycle validator with the recipient as actor.
pub fn respond(
  ctx: Ctx,
  req: Request,
  r: Recipient,
  offer_id: id.OfferId,
  accepted: Bool,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o <- recipient_offer(ctx, r, offer_id, now)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev.fields
    use revision_id <- input.field("revisionId", input.required(input.id()))
    use reason <- input.field(
      "reason",
      input.nullish(input.text(offer_rules.limit_decline_reason)),
    )
    input.done(Answer(client_key:, revision_id:, reason:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let response_type = case accepted {
    True -> "accepted"
    False -> "declined"
  }
  let prior = case key {
    Some(k) ->
      list.find(o.responses, fn(x) { x.client_key == Some(k) })
      |> option.from_result
    None -> None
  }
  case prior {
    Some(p) ->
      case
        id.offer_revision_to_string(p.revision_id) == b.revision_id
        && { p.response_type == response_type_row(accepted) }
        && p.actor_id == actor_id(r)
      {
        True ->
          case read(ctx, recipient_view(_, o, now)) {
            Error(response) -> response
            Ok(view) ->
              http.json(
                200,
                json.object([
                  #("offer", json.object(view)),
                  #("lifecycle", offer_rules.lifecycle_json(o.row)),
                  #("idempotent", json.bool(True)),
                ]),
              )
          }
        False ->
          err(
            "OFFER_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used for a different answer.",
            [],
          )
      }
    None ->
      case
        read(ctx, fn(rd) {
          use org <- result.try(org_of(rd, o.row.org_id))
          case org {
            None -> Ok(#(None, Error(recipients.Unavailable(""))))
            Some(org) -> {
              use rec <- result.map(recipients.resolve(
                rd,
                o.row.player_id,
                org,
                now,
              ))
              #(Some(org), rec)
            }
          }
        })
      {
        Error(response) -> response
        Ok(#(org, rec)) -> {
          let by_guardian = kind_of(r) == party.Guardian
          let is_blocked = rec == Error(recipients.Blocked)
          let invalid = fn(player_message, guardian_message) {
            err(
              "OFFER_RECIPIENT_INVALID",
              case by_guardian {
                True -> guardian_message
                False -> player_message
              },
              [],
            )
          }
          let gate = case rec {
            Error(recipients.Blocked) -> Ok(Nil)
            Error(_) ->
              Error(invalid(
                "This Offer is not yours to answer.",
                "You are no longer the verified guardian route for this player.",
              ))
            Ok(recipient) ->
              case recipient.kind == kind_of(r) {
                False ->
                  Error(invalid(
                    "This Offer is answered by your parent or guardian.",
                    "This player now answers their own Offers.",
                  ))
                True ->
                  case
                    by_guardian
                    && option.map(recipient.guardian_id, id.guardian_to_string)
                    != Some(actor_id(r))
                  {
                    True ->
                      Error(
                        err(
                          "OFFER_RECIPIENT_INVALID",
                          "You are no longer the verified guardian route for this player.",
                          [],
                        ),
                      )
                    False ->
                      case
                        recipient.minor
                        && !offer_rules.minor_pathway_open(
                          option.then(org, fn(x) { x.country })
                          |> option.unwrap("GB"),
                        )
                      {
                        True ->
                          Error(
                            err(
                              "OFFER_RECIPIENT_INVALID",
                              "No jurisdiction policy for an Offer to a minor is encoded in this build.",
                              [],
                            ),
                          )
                        False -> Ok(Nil)
                      }
                  }
              }
          }
          case gate {
            Error(response) -> response
            Ok(Nil) ->
              case is_blocked && accepted {
                True ->
                  err(
                    "OFFER_BLOCKED",
                    "You have blocked this organisation. Lift the block before accepting an Offer from it; you may decline it.",
                    [],
                  )
                False ->
                  case offer_rules.can_respond(o, b.revision_id, now) {
                    Error(refusal) -> fail(refusal)
                    Ok(rev) ->
                      case
                        offer_rules.responder_matches(
                          rev.row,
                          offer_rules.Responder(
                            kind_of(r),
                            actor_id(r),
                            o.row.player_id,
                          ),
                        )
                      {
                        False ->
                          err(
                            "OFFER_RECIPIENT_INVALID",
                            "This revision was not addressed to you.",
                            [],
                          )
                        True -> {
                          let st = offer_rules.effective(rev.row, now)
                          use <- answer_rev(raw, o, st)
                          let reason = case
                            accepted,
                            option.map(b.reason, string.trim)
                          {
                            False, Some(t) if t != "" -> Some(t)
                            _, _ -> None
                          }
                          use <- moderated(
                            ctx,
                            reason,
                            audit.Context(
                              kind: "offer_decline",
                              player_id: Some(o.row.player_id),
                              org_id: None,
                              user_id: None,
                              channel_id: None,
                              request_id: None,
                            ),
                          )
                          use <- limited(
                            ctx,
                            req,
                            limits.OfferResponse,
                            where(r) <> ":" <> actor_id(r),
                            now,
                          )
                          respond_write(
                            ctx,
                            r,
                            o,
                            rev,
                            accepted,
                            response_type,
                            reason,
                            key,
                            org,
                            now,
                          )
                        }
                      }
                  }
              }
          }
        }
      }
  }
}

fn response_type_row(accepted: Bool) -> response_row.ResponseType {
  case accepted {
    True -> response_row.Accepted
    False -> response_row.Declined
  }
}

/// A recipient's `expectedRev` is optional; when sent, it guards the answer.
fn answer_rev(
  raw: Dynamic,
  o: Offer,
  st: offer_status.OfferStatus,
  next: fn() -> Response,
) -> Response {
  let sent =
    option.or(
      decode.run(raw, decode.at(["expectedRev"], decode.int))
        |> option.from_result,
      decode.run(raw, decode.at(["expectedVersion"], decode.int))
        |> option.from_result,
    )
  case sent {
    Some(n) -> guard(n, o, offer_status.to_json(st), next)
    None -> next()
  }
}

fn respond_write(
  ctx: Ctx,
  r: Recipient,
  o: Offer,
  rev: Revision,
  accepted: Bool,
  response_type: String,
  reason: Option(String),
  key: Option(String),
  org: Option(orgs.Row),
  now: Int,
) -> Response {
  // The answer to the live revision discards any unissued draft beside it.
  let discard = case offer_rules.current_revision(o) {
    Some(d) if d.row.id != rev.row.id && d.row.status == Draft -> Some(d.row.id)
    _ -> None
  }
  let who = offers.Recipient(kind_of(r), actor_id(r), Some(actor_name(r)))
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(offers.unchanged(tx, o) |> storage)
    let rd = store.reading(tx)
    use response_id <- result.try(
      offers.record_response(
        tx,
        o.row.id,
        offers.Response(
          revision_id: rev.row.id,
          accepted:,
          kind: kind_of(r),
          actor_id: actor_id(r),
          actor_name: Some(actor_name(r)),
          player_id: o.row.player_id,
          reason:,
          client_key: key,
          at: now,
        ),
        discard,
      )
      |> storage,
    )
    use room <- result.try(cases.room(rd, o.row.case_id) |> storage)
    let room = case room {
      Some(k) if k.row.org_id == o.row.org_id -> Some(k)
      _ -> None
    }
    use moved <- result.try(case room {
      None ->
        Ok(Moved(
          offers.Lifecycle(
            False,
            None,
            None,
            None,
            now,
            Some("no_case"),
            None,
            None,
          ),
          json.object([
            #("applied", json.bool(False)),
            #("action", json.null()),
            #("reason", json.string("no_case")),
            #("at", json.int(now)),
          ]),
        ))
      Some(k) -> {
        use level <- result.try(org_level(rd, k) |> storage)
        use moved <- result.try(
          advance(
            tx,
            k,
            level,
            case accepted {
              True -> "recordOfferAccepted"
              False -> "recordOfferDeclined"
            },
            Some(room_rules.RecruitmentAdmin),
            case_lifecycle.RecipientMover(
              case kind_of(r) {
                party.Player -> history_row.Player
                party.Guardian -> history_row.Guardian
              },
              actor_id(r),
              Some(actor_name(r)),
            ),
            "offer:" <> response_type <> ":" <> id.offer_to_string(o.row.id),
            [
              #("offerId", id.offer_json(o.row.id)),
              #("revisionId", id.offer_revision_json(rev.row.id)),
            ],
            now,
          )
          |> storage,
        )
        let l = moved.lifecycle
        // On hold, withdrawn and so on: the Offer is not answered into a state the case cannot record.
        case l.applied || l.reason == Some("already_there") {
          True -> Ok(moved)
          False ->
            store.refuse(
              err(
                "OFFER_LIFECYCLE_CONFLICT",
                "This Offer cannot be answered right now; the club has paused or ended the case. Nothing was recorded.",
                [#("lifecycle", json.nullable(l.reason, json.string))],
              ),
            )
        }
      }
    })
    let l = moved.lifecycle
    use history <- result.try(
      {
        use discarded <- result.try(case discard {
          Some(d) -> {
            use e <- result.map(offers.entry(
              tx,
              "offer_draft_discarded",
              who,
              [
                #("revisionId", id.offer_revision_json(d)),
                #("byResponseId", id.offer_response_json(response_id)),
              ],
              now,
            ))
            [e]
          }
          None -> Ok([])
        })
        use e <- result.map(offers.entry(
          tx,
          "offer_" <> response_type,
          who,
          [
            #("revisionId", id.offer_revision_json(rev.row.id)),
            #("responseId", id.offer_response_json(response_id)),
            #("hadReason", json.bool(reason != None)),
          ],
          now,
        ))
        list.append(discarded, [e])
      }
      |> storage,
    )
    use _ <- result.try(
      offers.record_act(
        tx,
        o.row.id,
        offers.Bookkeeping(
          ..offers.bookkeeping(now),
          touch: True,
          bump: True,
          bump_revision: Some(rev.row.id),
          lifecycle: Some(l),
          history:,
        ),
      )
      |> storage,
    )
    use _ <- result.try(case room {
      Some(k) ->
        case_audit(
          tx,
          k,
          cases.By(
            case kind_of(r) {
              party.Player -> history_row.Player
              party.Guardian -> history_row.Guardian
            },
            Some(actor_id(r)),
            Some(actor_name(r)),
          ),
          "offer_" <> response_type,
          list.flatten([
            [
              #("offerId", id.offer_json(o.row.id)),
              #("revisionId", id.offer_revision_json(rev.row.id)),
            ],
            case l.applied, l.to {
              True, Some(to) -> [#("to", json.string(to))]
              _, _ -> []
            },
          ]),
          now,
        )
        |> storage
      None -> Ok(Nil)
    })
    use fresh <- result.try(reread(tx, o.row.id))
    case room {
      Some(k) ->
        store.emit(
          tx,
          effect.Live(live_event.OfferResponded(
            org_id: id.org_to_string(o.row.org_id),
            room_id: id.recruitment_case_to_string(k.row.id),
            offer_id: id.offer_to_string(o.row.id),
            status: offer_rules.current_revision(fresh)
              |> option.map(fn(r) { offer_status.to_string(r.row.status) }),
          )),
        )
      None -> Nil
    }
    use player <- result.try(players.by_id(rd, o.row.player_id) |> storage)
    let player_name = option.map(player, fn(p) { p.row.name })
    let room_name = option.then(room, fn(k) { k.row.player_name })
    use _ <- result.try(
      notify_club(
        tx,
        o,
        actor_name(r)
          <> " "
          <> response_type
          <> " Offer revision "
          <> int.to_string(rev.row.revision_number)
          <> " for "
          <> option.or(room_name, player_name) |> option.unwrap("the player")
          <> case accepted {
          True -> " — accepted in ScoutBox; signing pending"
          False -> ""
        }
          <> ".",
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      notify_agent(
        tx,
        fresh,
        squash(
          "Your client "
          <> option.unwrap(player_name, "")
          <> " "
          <> response_type
          <> " the Offer from "
          <> option.map(org, fn(x) { x.name }) |> option.unwrap("the club")
          <> ".",
        ),
        now,
      )
      |> storage,
    )
    use view <- result.map(
      recipient_view(store.reading(tx), fresh, now) |> storage,
    )
    http.json(
      200,
      json.object([
        #("offer", json.object(view)),
        #("lifecycle", moved.json),
        #(
          "signing",
          json.object([
            #("created", json.bool(False)),
            #(
              "note",
              json.string(
                "Accepting an Offer in ScoutBox is not a signing. Nothing was signed and no contract exists.",
              ),
            ),
          ]),
        ),
      ]),
    )
  })
  |> room_routes.answer
  |> after_persist(ctx)
}

/// `internal:offer.respond.after_persist`: the answer has committed, then the request fails, so a retry with the same
/// clientKey replays it without a second move or notification. Development only.
fn after_persist(resp: Response, ctx: Ctx) -> Response {
  let step = "offer.respond.after_persist"
  case resp.status == 200 && faults.should_fail(ctx.faults, step) {
    True ->
      http.internal(
        "simulated failure after the answer was persisted (development fault layer)",
      )
    False -> resp
  }
}

fn org_level(read: Read, room: Room) -> Result(orgs.Level, Fail(e)) {
  use org <- result.map(org_of(read, room.row.org_id))
  case org {
    Some(o) -> room_view.level(o)
    None -> orgs.LevelPro
  }
}

type Share {
  Share(share: Option(Bool), agreement_id: Option(String))
}

/// `POST /player/offers/:id/share-agent`: an adult client shares one Offer with their representing agent. A
/// guardian route cannot share. A share changes no term, so it does not move the rev.
pub fn share_agent(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  let r = PlayerRecipient(p)
  use o <- recipient_offer(ctx, r, offer_id, now)
  case p.minor {
    True ->
      err(
        "OFFER_NOT_PERMITTED",
        "Sharing an Offer with an agent is an adult client's own act.",
        [],
      )
    False -> {
      let shape = {
        use share <- input.field("share", input.nullish(input.boolean()))
        use agreement_id <- input.field(
          "agreementId",
          input.nullish(input.id()),
        )
        input.done(Share(share:, agreement_id:))
      }
      use b, _ <- body(req, shape)
      let who = offers.Recipient(party.Player, actor_id(r), Some(actor_name(r)))
      case b.share {
        // Un-sharing needs no agent, so a client whose mandate ended can still clear the share.
        Some(False) ->
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(offers.unchanged(tx, o) |> storage)
            use _ <- result.try(
              offers.set_agent_share(tx, o.row.id, None) |> storage,
            )
            use history <- result.try(case o.row.agent_share_user_id {
              Some(_) ->
                offers.entry(tx, "offer_agent_share_withdrawn", who, [], now)
                |> result.map(fn(e) { [offers.Entry(..e, detail: None)] })
                |> storage
              None -> Ok([])
            })
            use _ <- result.try(
              offers.record_act(
                tx,
                o.row.id,
                offers.Bookkeeping(
                  ..offers.bookkeeping(now),
                  touch: True,
                  history:,
                ),
              )
              |> storage,
            )
            use fresh <- result.try(reread(tx, o.row.id))
            use view <- result.map(
              recipient_view(store.reading(tx), fresh, now) |> storage,
            )
            http.json(200, json.object([#("offer", json.object(view))]))
          })
          |> room_routes.answer
        _ -> {
          let client = id.player_to_string(p.player.row.id)
          let found =
            read(ctx, fn(rd) {
              use #(sole, ambiguous) <- result.try(representation.sole_active(
                rd,
                client,
                now,
              ))
              case b.agreement_id {
                None -> Ok(#(sole, ambiguous))
                Some(named) -> {
                  use a <- result.try(representation.by_id(
                    rd,
                    id.agreement(named),
                  ))
                  case a {
                    Some(a) if a.row.client_id == client -> {
                      use basis <- result.map(representation.basis(
                        rd,
                        a.row.agent_user_id,
                        client,
                        now,
                      ))
                      case basis.ok {
                        True -> #(Some(a), ambiguous)
                        False -> #(None, ambiguous)
                      }
                    }
                    _ -> Ok(#(None, ambiguous))
                  }
                }
              }
            })
          case found {
            Error(response) -> response
            Ok(#(None, ambiguous)) ->
              err(
                "OFFER_INPUT_INVALID",
                case ambiguous {
                  True ->
                    "You have more than one active agent. Name the agreement (agreementId) you are sharing with."
                  False -> "No active representation agreement to share with."
                },
                [#("field", json.string("agreementId"))],
              )
            Ok(#(Some(agreement), _)) ->
              store.unit(ctx.store, fn(tx) {
                use _ <- result.try(offers.unchanged(tx, o) |> storage)
                use _ <- result.try(
                  offers.set_agent_share(
                    tx,
                    o.row.id,
                    Some(#(
                      agreement.row.agent_user_id,
                      agreement.row.id,
                      p.player.row.id,
                      now,
                    )),
                  )
                  |> storage,
                )
                use e <- result.try(
                  offers.entry(
                    tx,
                    "offer_agent_shared",
                    who,
                    [
                      #("agreementId", id.agreement_json(agreement.row.id)),
                    ],
                    now,
                  )
                  |> storage,
                )
                use _ <- result.try(
                  offers.record_act(
                    tx,
                    o.row.id,
                    offers.Bookkeeping(
                      ..offers.bookkeeping(now),
                      touch: True,
                      history: [e],
                    ),
                  )
                  |> storage,
                )
                use _ <- result.try(
                  notify(
                    tx,
                    audience.OrgUser,
                    id.org_user_to_string(agreement.row.agent_user_id),
                    p.player.row.name
                      <> " shared an Offer with you to read. Their answer is their own act.",
                    o.row.id,
                    now,
                  )
                  |> storage,
                )
                use fresh <- result.try(reread(tx, o.row.id))
                use view <- result.map(
                  recipient_view(store.reading(tx), fresh, now) |> storage,
                )
                http.json(200, json.object([#("offer", json.object(view))]))
              })
              |> room_routes.answer
          }
        }
      }
    }
  }
}

/// `GET /player/offers/:id/documents/:docId` (and the guardian's): a document on an issued (or answered)
/// revision, never a draft's.
pub fn document(
  ctx: Ctx,
  req: Request,
  r: Recipient,
  offer_id: id.OfferId,
  doc_id: String,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use o <- recipient_offer(ctx, r, offer_id, now)
  let gone =
    err(
      "OFFER_DOCUMENT_NOT_FOUND",
      "No document with that reference is available to you.",
      [],
    )
  let doc =
    o.revisions
    |> list.filter(fn(x) { offer_rules.was_issued(x.row) })
    |> list.flat_map(fn(x) { x.documents })
    |> list.find(fn(d) { id.offer_document_to_string(d.id) == doc_id })
  case doc {
    Error(Nil) -> gone
    Ok(d) -> {
      let owner = Some(o.row.org_id)
      case read(ctx, vault_record(_, d.evidence_id)) {
        Error(response) -> response
        Ok(Some(ev)) if ev.org_id == owner -> {
          let blob = case ev.media_id {
            Some(m) -> media.read(ctx.config.data_dir, m) |> option.from_result
            None -> None
          }
          let mime = option.map(ev.mime, evidence_row.mime_to_string)
          http.json(
            200,
            json.object([
              #(
                "document",
                json.object([
                  #("id", id.offer_document_json(d.id)),
                  #("label", json.nullable(d.label, json.string)),
                  #(
                    "mime",
                    json.nullable(
                      option.or(mime, option.map(blob, fn(b) { b.0 })),
                      json.string,
                    ),
                  ),
                  #(
                    "bytes",
                    json.nullable(
                      option.or(
                        ev.bytes,
                        option.map(blob, fn(b) { bit_size(b.1) }),
                      ),
                      json.int,
                    ),
                  ),
                  #("filename", json.nullable(ev.filename, json.string)),
                ]),
              ),
              #("file", case blob {
                Some(#(content_type, bits)) ->
                  json.object([
                    #("mime", json.string(option.unwrap(mime, content_type))),
                    #("base64", json.string(base64(bits))),
                  ])
                None -> json.null()
              }),
            ]),
          )
        }
        Ok(_) -> gone
      }
    }
  }
}

fn bit_size(b: BitArray) -> Int {
  bit_array.byte_size(b)
}

fn base64(b: BitArray) -> String {
  bit_array.base64_encode(b, True)
}

// ---------------------------------------------------------------------------------------------- live events

fn offer_event(change: live_event.OfferChange, o: Offer) -> live_event.Event {
  live_event.OfferChanged(
    change:,
    org_id: id.org_to_string(o.row.org_id),
    room_id: id.recruitment_case_to_string(o.row.case_id),
    offer_id: id.offer_to_string(o.row.id),
  )
}

// ---------------------------------------------------------------------------------------------------- agent

/// `GET /org/agent/clients/:id/offers`: only the Offers the client shared with this agent, and only while the
/// agent's basis, employment or transfer scope and licence hold now. Anyone else sees nothing, including whether
/// an Offer exists.
pub fn agent_offers(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  agreement_id: id.AgreementId,
) -> Response {
  use m <- agent_core.membership(ctx, a)
  use found <- agent_core.own_agreement(ctx, m, agreement_id)
  case found {
    agent_core.Summary(_) ->
      http.error_message(
        403,
        "AGENT_ACTION_NOT_PERMITTED",
        "A summary row does not open a client's Offers.",
      )
    agent_core.Own(agreement) -> {
      let now = clock.request_ms(ctx.config, req)
      let client_id = agreement.row.client_id
      let closed = fn(code, rule) {
        http.json(
          403,
          json.object([
            #("error", json.string(code)),
            #("rule", json.nullable(rule, json.string)),
            #(
              "message",
              json.string("This client's Offers are not open to you right now."),
            ),
          ]),
        )
      }
      let checked =
        read(ctx, fn(rd) {
          use decision <- result.try(integration.decide(
            rd,
            integration.ClientPrivate,
            client_id,
            a.user.id,
            None,
            now,
          ))
          use licence <- result.map(integration.licence_current(
            rd,
            a.user.id,
            agreement.row.jurisdiction,
            now,
          ))
          #(decision, licence)
        })
      case checked {
        Error(response) -> response
        Ok(#(integration.Denied(code:, rule:), _)) -> closed(code, Some(rule))
        Ok(#(integration.Allowed(basis), licence)) ->
          case
            list.any(basis.scope, fn(s) {
              s == scope_row.Employment || s == scope_row.Transfer
            }),
            licence
          {
            False, _ ->
              http.error_message(
                403,
                "SCOPE_INSUFFICIENT",
                "Your representation scope with this client does not cover employment or transfer.",
              )
            True, False -> closed("LICENCE_NOT_CURRENT", Some("LICENCE"))
            True, True ->
              case
                read(ctx, fn(rd) {
                  use all <- result.try(offers.for_player(
                    rd,
                    id.player(client_id),
                  ))
                  use kept <- result.try(
                    list.try_fold(all, [], fn(out, o) {
                      use ok <- result.map(sound(rd, o, now))
                      case
                        ok
                        && o.row.agent_share_user_id == Some(a.user.id)
                        && option.is_some(offer_rules.live_revision(o))
                      {
                        True -> [o, ..out]
                        False -> out
                      }
                    }),
                  )
                  use items <- result.try(
                    kept
                    |> list.sort(fn(x, y) {
                      int.compare(
                        option.unwrap(y.row.agent_share_at, 0),
                        option.unwrap(x.row.agent_share_at, 0),
                      )
                    })
                    |> list.try_map(fn(o) {
                      use org <- result.try(org_of(rd, o.row.org_id))
                      use summary <- result.map(signing_reads.summary_for_offer(
                        rd,
                        o.row.id,
                        o.row.org_id,
                        now,
                      ))
                      offer_rules.agent_view(
                        o,
                        now,
                        option.map(org, fn(x) { x.name }),
                      )
                      |> signing_reads.with_signing(summary)
                      |> json.object
                    }),
                  )
                  use seen <- result.map(players.for_org(
                    rd,
                    id.player(client_id),
                    a.org,
                    now,
                  ))
                  #(items, case seen {
                    Some(#(p, access)) if access.visible && !access.blocked ->
                      json.string(p.row.name)
                    _ -> json.null()
                  })
                })
              {
                Error(response) -> response
                Ok(#(items, name)) ->
                  http.json(
                    200,
                    json.object([
                      #("items", json.preprocessed_array(items)),
                      #("clientId", json.string(client_id)),
                      #("clientName", name),
                      #(
                        "note",
                        json.string(
                          "Only the Offers your client chose to share with you, as the club issued them. Accepting or declining is your client's own act; ScoutBox does not let you do it on their behalf.",
                        ),
                      ),
                      #(
                        "honest",
                        json.string(
                          "Nothing here is a negotiation, a fee or a signing. An accepted Offer is not a signed contract.",
                        ),
                      ),
                    ]),
                  )
              }
          }
      }
    }
  }
}
