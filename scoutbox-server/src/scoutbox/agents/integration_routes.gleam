//// The agent's reads across the integration seam, and the opportunity share (domains/agents/integration/index.mjs):
//// a client's contacts a club routed to the agent, the client's trials as scheduling only, and opportunities the
//// agent brings to a client's attention. Every read asks `integration.decide` again, so authority is re-derived on
//// each request rather than remembered.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules.{type Agreement}
import scoutbox/agents/agent_store
import scoutbox/agents/core_routes.{type Member, Own, Summary}
import scoutbox/agents/integration
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/contact_rules
import scoutbox/recruitment/contacts
import scoutbox/recruitment/trial_rules
import scoutbox/recruitment/trials
import scoutbox/rows/agreement_history as event_row
import scoutbox/rows/agreement_opportunity_shares as share_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as contact_row
import scoutbox/rows/trials as trial_row
import scoutbox/scouting/opportunity_board
import scoutbox/vocab/audience
import scoutbox/vocab/contact_mode
import scoutbox/vocab/share_via
import scoutbox/vocab/trial_workflow_state
import sqlight
import wisp.{type Request, type Response}

/// Shares belong to the relationship they were made under. At the cap a share is refused by name rather than
/// dropping the oldest, so the audit trail never silently forgets.
const max_shares = 200

const share_note_max = 300

const share_honest =
  "Your agent brought this to your attention. Applying is your own action — nobody can apply for you."

// ------------------------------------------------------------------------------------------------- helpers

fn forbidden(code: String, rule: String, message: String) -> Response {
  http.json(
    403,
    json.object([
      #("error", json.string(code)),
      #("rule", json.string(rule)),
      #("message", json.string(message)),
    ]),
  )
}

fn not_permitted(message: Option(String)) -> Response {
  http.json(
    403,
    json.object([
      #("error", json.string("AGENT_ACTION_NOT_PERMITTED")),
      ..case message {
        Some(m) -> [#("message", json.string(m))]
        None -> []
      }
    ]),
  )
}

/// The caller's own agreement that `agreement_id` names: a staff summary row opens nothing here.
fn own(
  ctx: Ctx,
  m: Member,
  agreement_id: id.AgreementId,
  summary_message: Option(String),
  next: fn(Agreement) -> Response,
) -> Response {
  use found <- core_routes.own_agreement(ctx, m, agreement_id)
  case found {
    Summary(_) -> not_permitted(summary_message)
    Own(a) -> next(a)
  }
}

fn decided(
  ctx: Ctx,
  surface: integration.Surface,
  a: Agreement,
  agent: id.OrgUserId,
  now: Int,
  next: fn(integration.Decision) -> Response,
) -> Response {
  use decision <- core_routes.reading(ctx, integration.decide(
    _,
    surface,
    a.row.client_id,
    agent,
    None,
    now,
  ))
  next(decision)
}

fn org_name(read: Read, org: id.OrgId) -> Result(Option(String), Fail(e)) {
  use found <- result.map(orgs.by_id(read, org))
  option.map(found, fn(o) { o.name })
}

fn club(org: id.OrgId, name: Option(String)) -> Json {
  json.object([
    #("id", id.org_json(org)),
    #("name", json.nullable(name, json.string)),
  ])
}

// ------------------------------------------------------------------------------------------------ contacts

/// `GET /org/agent/clients/:id/contacts`: filtered by the routing snapshot, so revoking `contactRouting` stops new
/// contacts without erasing ones already received. Nothing of the club's recruitment case crosses.
pub fn client_contacts(
  ctx: Ctx,
  a: OrgAccess,
  agreement_id: id.AgreementId,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use x <- own(
    ctx,
    m,
    agreement_id,
    Some("A summary row does not open a client's contacts."),
  )
  let now = clock.now_ms()
  use decision <- decided(ctx, integration.ClientPrivate, x, a.user.id, now)
  case decision {
    integration.Denied(code:, rule:) ->
      forbidden(
        code,
        rule,
        "This client's record is not open to you right now.",
      )
    integration.Allowed(_) -> {
      use items <- core_routes.reading(ctx, fn(r) {
        use routed <- result.try(contacts.for_routed_agent(r, a.user.id))
        routed
        |> list.filter(fn(c) {
          id.player_to_string(c.row.player_id) == x.row.client_id
        })
        |> list.try_map(fn(c) {
          use name <- result.map(org_name(r, c.row.org_id))
          #(c.row, name)
        })
      })
      let items =
        list.sort(items, fn(p, q) {
          case
            int.compare(
              option.unwrap({ q.0 }.routing_at, 0),
              option.unwrap({ p.0 }.routing_at, 0),
            )
          {
            order.Eq ->
              string.compare(
                id.contact_to_string({ q.0 }.id),
                id.contact_to_string({ p.0 }.id),
              )
            o -> o
          }
        })
      http.json(
        200,
        json.object([
          #("items", json.array(items, fn(p) { contact_view(p.0, p.1) })),
          #("clientId", json.string(x.row.client_id)),
          #(
            "note",
            json.string(
              "Contacts a club routed to you as well as to your client. The club's own recruitment case, its internal notes and its assessment of your client are not here and never will be. Answering is your client's act, not yours.",
            ),
          ),
        ]),
      )
    }
  }
}

fn contact_view(c: contact_row.Row, club_name: Option(String)) -> Json {
  json.object([
    #("id", id.contact_json(c.id)),
    #("club", club(c.org_id, club_name)),
    #("status", contact_row.status_to_json(c.status)),
    #("channel", contact_row.channel_to_json(c.channel)),
    #("subject", json.nullable(c.subject, json.string)),
    // Routed means the club addressed this to the agent as well as the player.
    #("body", json.nullable(c.body, json.string)),
    #("routedAt", json.nullable(c.routing_at, json.int)),
    #("routedMode", json.nullable(c.routing_mode, contact_mode.to_json)),
    #("deliveredAt", json.nullable(c.delivered_at, json.int)),
    #("respondedAt", json.nullable(c.responded_at, json.int)),
    // The kind of answer only; the client's free-text reply stays theirs.
    #(
      "responseKind",
      json.nullable(c.response_kind, contact_row.response_kind_to_json),
    ),
  ])
}

// -------------------------------------------------------------------------------------------------- trials

/// `GET /org/agent/clients/:id/trials`: that a trial exists and its scheduling, without the assessment, report,
/// footage, venue address or joining instructions. An agent cannot act on a trial for the player.
pub fn client_trials(
  ctx: Ctx,
  a: OrgAccess,
  agreement_id: id.AgreementId,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use x <- own(
    ctx,
    m,
    agreement_id,
    Some("A summary row does not open a client's trials."),
  )
  let now = clock.now_ms()
  use decision <- decided(ctx, integration.TrialProjection, x, a.user.id, now)
  case decision {
    integration.Denied(code:, rule:) ->
      forbidden(code, rule, case code {
        "DISCLOSURE_WITHHELD" ->
          "Your client has not chosen to share their trial schedule with you. That choice is theirs and they can change it at any time in My Agent."
        _ -> "This client's trials are not open to you right now."
      })
    integration.Allowed(_) -> {
      let player_id = id.player(x.row.client_id)
      use #(found, client) <- core_routes.reading(ctx, fn(r) {
        use found <- result.try(trials.for_player(r, player_id))
        use found <- result.try(
          found
          |> list.filter(fn(t) { t.row.subject_removed_at == None })
          |> list.map(fn(t) { #(t, Some(t.row.org_name)) })
          |> Ok,
        )
        use client <- result.map(players.for_org(r, player_id, a.org, now))
        #(found, client)
      })
      let items =
        list.sort(found, fn(p, q) {
          case int.compare({ q.0 }.row.accepted_at, { p.0 }.row.accepted_at) {
            order.Eq ->
              string.compare(
                id.trial_to_string({ q.0 }.row.id),
                id.trial_to_string({ p.0 }.row.id),
              )
            o -> o
          }
        })
      http.json(
        200,
        json.object([
          #("items", json.array(items, fn(p) { trial_view(p.0, p.1) })),
          #("clientId", json.string(x.row.client_id)),
          #("clientName", case client {
            Some(#(p, seen)) if seen.visible -> json.string(p.row.name)
            _ -> json.null()
          }),
          #(
            "note",
            json.string(
              "Your client's trials as the club and your client have recorded them. The club's assessment, its trial report and any Box Cam footage are not here. Confirming, rescheduling and attending are your client's acts and the club's; ScoutBox does not let you do them on your client's behalf.",
            ),
          ),
          #(
            "honest",
            json.string(
              "Nothing here is an offer, a negotiation or a fee. A trial is an assessment opportunity.",
            ),
          ),
        ]),
      )
    }
  }
}

fn trial_view(t: trial_rules.Trial, club_name: Option(String)) -> Json {
  let state = trial_rules.workflow_state(t)
  json.object([
    #("id", id.trial_json(t.row.id)),
    #("club", club(t.row.org_id, club_name)),
    #("workflowState", trial_workflow_state.to_json(state)),
    #("workflowLabel", json.string(trial_rules.label(state))),
    #("legacy", json.bool(trial_rules.is_legacy(t))),
    #("acceptedAt", json.int(t.row.accepted_at)),
    // As the agent viewer: address, instructions and evidence are absent, not redacted.
    #("schedule", trial_rules.schedule_view(t, trial_rules.AgentViewer)),
    #(
      "awaitingClientConfirmation",
      json.bool(
        trial_rules.has_schedule(t) && t.row.schedule_confirmed_at == None,
      ),
    ),
    #("completion", case t.row.completion_state, t.row.completion_at {
      Some(state), at ->
        json.object([
          #("state", trial_row.completion_state_to_json(state)),
          #("at", json.nullable(at, json.int)),
        ])
      None, _ -> json.null()
    }),
    // Whether a report obligation exists, never what it says.
    #("reportObligation", case t.row.status {
      trial_row.AwaitingReport -> json.string("outstanding")
      trial_row.Reported -> json.string("filed")
    }),
  ])
}

// -------------------------------------------------------------------------------------------------- shares

fn shares_of(
  read: Read,
  agreement_id: id.AgreementId,
) -> Result(List(share_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> share_row.columns
      <> " FROM agreement_opportunity_shares WHERE agreement_id = ? ORDER BY ord",
    [id.agreement_sql(agreement_id)],
    share_row.decoder(),
  )
}

fn share_fields(s: share_row.Row) -> List(#(String, Json)) {
  [
    #("id", id.opportunity_share_json(s.id)),
    #("opportunityId", json.string(s.opportunity_id)),
    #("via", json.nullable(s.via, share_via.to_json)),
    #("title", json.nullable(s.title, json.string)),
    #("orgName", json.nullable(s.org_name, json.string)),
    #("deadline", json.nullable(s.deadline, json.string)),
    #("note", json.nullable(s.note, json.string)),
    #("sharedAt", json.int(s.shared_at)),
    #("sharedByName", json.nullable(s.shared_by_name, json.string)),
    #("withdrawnAt", json.nullable(s.withdrawn_at, json.int)),
    #("rev", json.int(s.rev)),
    #("honest", json.string(share_honest)),
  ]
}

fn share_view(s: share_row.Row) -> Json {
  json.object(share_fields(s))
}

fn newest_first(shares: List(share_row.Row)) -> List(share_row.Row) {
  list.sort(shares, fn(x, y) { int.compare(y.shared_at, x.shared_at) })
}

/// `GET /org/agent/clients/:id/opportunities/shares`: closes when the mandate does. `client_private`, because this
/// reads the relationship rather than making a suggestion.
pub fn client_shares(
  ctx: Ctx,
  a: OrgAccess,
  agreement_id: id.AgreementId,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use x <- own(ctx, m, agreement_id, None)
  let now = clock.now_ms()
  use decision <- decided(ctx, integration.ClientPrivate, x, a.user.id, now)
  case decision {
    integration.Denied(code:, rule:) ->
      forbidden(
        code,
        rule,
        "This client's record is not open to you right now.",
      )
    integration.Allowed(_) -> {
      use shares <- core_routes.reading(ctx, shares_of(_, x.row.id))
      http.json(
        200,
        json.object([
          #("items", json.array(newest_first(shares), share_view)),
        ]),
      )
    }
  }
}

type ShareInput {
  ShareInput(note: Option(String), client_key: Option(String))
}

fn share_shape() -> input.Shape(ShareInput) {
  use note <- input.field("note", input.nullish(input.text(share_note_max)))
  use client_key <- core_routes.client_key_field
  input.done(ShareInput(note:, client_key:))
}

fn client_key(
  raw: Option(String),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(option.map(raw, dynamic.string)) {
    Ok(key) -> next(key)
    Error(message) ->
      http.error_message(400, "AGENT_CLIENT_KEY_INVALID", message)
  }
}

fn share_fingerprint(opportunity_id: String, note: String) -> String {
  core_routes.fingerprint([
    #("opportunityId", canonical.Str(opportunity_id)),
    #("note", canonical.Str(note)),
  ])
}

/// `POST /org/agent/clients/:id/opportunities/:oppId/share`. The opportunity must already be on the client's own
/// board, rebuilt as the player's screen builds it, so an agent cannot surface anything the client could not find.
/// Applying stays the player's own act.
pub fn share(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  agreement_id: id.AgreementId,
  opportunity_id: String,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "clients.opportunities.share")
  use x <- own(
    ctx,
    m,
    agreement_id,
    Some("A summary row does not permit sharing."),
  )
  use b <- core_routes.plain_body(req, share_shape())
  use key <- client_key(b.client_key)
  let note =
    contact_rules.plain_shared(option.unwrap(b.note, ""), share_note_max)
  let fp = share_fingerprint(opportunity_id, note)
  use shares <- core_routes.reading(ctx, shares_of(_, x.row.id))
  let replayed = case key {
    Some(k) -> list.find(shares, fn(s) { s.share_key == Some(k) })
    None -> Error(Nil)
  }
  case replayed {
    Ok(hit) if hit.share_fp == Some(fp) ->
      http.json(
        200,
        json.object([
          #("share", share_view(hit)),
          #("idempotent", json.bool(True)),
        ]),
      )
    Ok(_) ->
      http.json(
        409,
        json.object([
          #("error", json.string("AGENT_IDEMPOTENCY_CONFLICT")),
          #("message", json.string("That key was used for a different share.")),
        ]),
      )
    Error(Nil) -> {
      let now = clock.now_ms()
      use decision <- decided(
        ctx,
        integration.OpportunityShare,
        x,
        a.user.id,
        now,
      )
      case decision {
        integration.Denied(code:, rule:) ->
          forbidden(code, rule, case code {
            "SCOPE_INSUFFICIENT" ->
              "Your agreement with this client does not cover employment or transfer work, which is what sharing an opportunity is."
            _ -> "You cannot share an opportunity with this client right now."
          })
        // Before the board is searched: unlimited attempts could probe the board one id at a time, and the
        // uniform 404 hides only the answer, not the count. Sharing and withdrawing share one budget.
        integration.Allowed(_) -> {
          use <- core_routes.limited(
            ctx,
            limits.OpportunityShare,
            id.org_user_to_string(a.user.id),
          )
          share_from_board(
            ctx,
            a,
            x,
            shares,
            opportunity_id,
            note,
            key,
            fp,
            now,
          )
        }
      }
    }
  }
}

fn share_from_board(
  ctx: Ctx,
  a: OrgAccess,
  x: Agreement,
  shares: List(share_row.Row),
  opportunity_id: String,
  note: String,
  key: Option(String),
  fp: String,
  now: Int,
) -> Response {
  use #(board, shared_by) <- core_routes.reading(ctx, fn(r) {
    use player <- result.try(players.by_id(r, id.player(x.row.client_id)))
    use board <- result.try(case player {
      Some(p) -> opportunity_board.for_player(r, p, now)
      None -> Ok([])
    })
    use profile <- result.map(agent_store.profile_for_user(r, a.user.id))
    #(board, case profile {
      Some(p) -> p.row.display_name
      None -> a.user.name
    })
  })
  let opp =
    list.find(board, fn(o) { opportunity_board.item_id(o) == opportunity_id })
  let already =
    list.find(shares, fn(s) {
      s.opportunity_id == opportunity_id && s.withdrawn_at == None
    })
  case opp, already {
    // Missing, closed and ineligible answer alike, or this is an existence oracle over the board.
    Error(Nil), _ ->
      http.json(
        404,
        json.object([
          #("error", json.string("OPPORTUNITY_NOT_AVAILABLE")),
          #(
            "message",
            json.string("That opportunity is not on this client's board."),
          ),
        ]),
      )
    Ok(_), Ok(s) ->
      http.json(
        409,
        json.object([
          #("error", json.string("OPPORTUNITY_ALREADY_SHARED")),
          #("shareId", id.opportunity_share_json(s.id)),
          #(
            "message",
            json.string(
              "You have already shared this opportunity with this client.",
            ),
          ),
        ]),
      )
    Ok(item), Error(Nil) ->
      case list.length(shares) >= max_shares {
        True ->
          http.json(
            409,
            json.object([
              #("error", json.string("OPPORTUNITY_SHARE_LIMIT")),
              #(
                "message",
                json.string(
                  "This relationship already holds "
                  <> int.to_string(max_shares)
                  <> " shares, which is the most one record keeps.",
                ),
              ),
            ]),
          )
        False -> {
          let #(via, title, org, deadline) = board_facts(item)
          use made <- core_routes.act(ctx, fn(tx) {
            write_share(
              tx,
              a,
              x,
              opportunity_id,
              via,
              title,
              org,
              deadline,
              note,
              shared_by,
              key,
              fp,
              now,
            )
            |> core_routes.storage
          })
          http.json(
            201,
            json.object([
              #("share", share_view(made)),
              #(
                "note",
                json.string(
                  "Shared. Your client decides whether to apply, on their own screen, in their own name.",
                ),
              ),
            ]),
          )
        }
      }
  }
}

/// What a share keeps of the board row it was made from.
fn board_facts(
  item: opportunity_board.Item,
) -> #(share_via.ShareVia, String, String, String) {
  case item {
    opportunity_board.ClubOpportunity(opportunity:, ..) -> #(
      share_via.Opportunity,
      opportunity.row.title,
      opportunity.row.org_name,
      opportunity.row.deadline,
    )
    opportunity_board.OpenDay(trial:, org_name:, ..) -> #(
      share_via.OpenTrial,
      trial.title,
      org_name,
      trial.trial_date,
    )
  }
}

fn write_share(
  tx: Tx,
  a: OrgAccess,
  x: Agreement,
  opportunity_id: String,
  via: share_via.ShareVia,
  title: String,
  org: String,
  deadline: String,
  note: String,
  shared_by: String,
  key: Option(String),
  fp: String,
  now: Int,
) -> Result(share_row.Row, Fail(e)) {
  use share_id <- result.try(id.next_opportunity_share(tx))
  use ord <- result.try(next_share_ord(tx, x.row.id))
  let s =
    share_row.Row(
      ..share_row.new(
        agreement_id: x.row.id,
        ord:,
        id: share_id,
        opportunity_id:,
        shared_at: now,
        shared_by_kind: share_row.Org,
        shared_by_user_id: a.user.id,
        rev: 1,
        rev_at: now,
      ),
      via: Some(via),
      title: Some(title),
      org_name: Some(org),
      deadline: Some(deadline),
      note: case note {
        "" -> None
        n -> Some(n)
      },
      shared_by_name: Some(shared_by),
      share_key: key,
      share_fp: option.map(key, fn(_) { fp }),
    )
  use _ <- result.try(share_row.insert(tx, s))
  // No agreement rev: a share changes no term.
  use _ <- result.try(agent_store.agreement_event(
    tx,
    x.row.id,
    now,
    core_routes.by_org(a),
    fn(e) {
      event_row.Row(..e, detail_share_id: Some(share_id), detail_via: Some(via))
    },
    event_row.OpportunityShared,
  ))
  store.emit(
    tx,
    effect.Live(live_event.AgentOpportunityShared(
      org_id: id.org_to_string(x.row.agency_org_id),
      agreement_id: id.agreement_to_string(x.row.id),
      agent_user_id: id.org_user_to_string(a.user.id),
    )),
  )
  use _ <- result.map(notifications.notify(
    tx,
    to: audience.Player,
    id: x.row.client_id,
    type_: "representation_opportunity",
    text: shared_by
      <> " shared an opportunity with you"
      <> case org {
      "" -> ""
      o -> " at " <> o
    }
      <> ". Applying is your own decision — nobody can apply on your behalf.",
    ref_id: Some(id.opportunity_share_to_string(share_id)),
    at: now,
  ))
  s
}

fn next_share_ord(
  tx: Tx,
  agreement_id: id.AgreementId,
) -> Result(Int, Fail(e)) {
  use found <- result.map(store.one(
    store.reading(tx),
    "SELECT COALESCE(MAX(ord), -1) + 1 FROM agreement_opportunity_shares WHERE agreement_id = ?",
    [id.agreement_sql(agreement_id)],
    decode.at([0], decode.int),
  ))
  result.unwrap(found, 0)
}

/// `POST /org/agent/clients/:id/opportunities/shares/:shareId/withdraw`. The record stays, marked withdrawn. No live
/// basis check: an agent whose relationship ended can still take back a share, which widens nobody's access.
pub fn withdraw_share(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  agreement_id: id.AgreementId,
  share_id: id.OpportunityShareId,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "clients.opportunities.share")
  use x <- own(ctx, m, agreement_id, None)
  use shares <- core_routes.reading(ctx, shares_of(_, x.row.id))
  case list.find(shares, fn(s) { s.id == share_id }) {
    Error(Nil) -> http.error(404, "OPPORTUNITY_SHARE_NOT_FOUND")
    Ok(s) -> {
      use _ <- core_routes.plain_body(req, input.done(Nil))
      case s.withdrawn_at {
        Some(_) ->
          http.json(
            200,
            json.object([
              #("share", share_view(s)),
              #("idempotent", json.bool(True)),
            ]),
          )
        // The other half of the share/withdraw loop, on the sharing budget.
        None -> {
          use <- core_routes.limited(
            ctx,
            limits.OpportunityShare,
            id.org_user_to_string(a.user.id),
          )
          let now = clock.now_ms()
          use fresh <- core_routes.act(ctx, fn(tx) {
            use rows <- result.try(
              store.write(
                tx,
                "UPDATE agreement_opportunity_shares SET withdrawn_at = ?, rev = rev + 1, rev_at = ? WHERE agreement_id = ? AND id = ? AND withdrawn_at IS NULL RETURNING "
                  <> share_row.columns,
                [
                  sqlight.int(now),
                  sqlight.int(now),
                  id.agreement_sql(x.row.id),
                  id.opportunity_share_sql(s.id),
                ],
                share_row.decoder(),
              )
              |> core_routes.storage,
            )
            case rows {
              [] -> store.stale("the share was withdrawn")
              [fresh, ..] -> {
                use _ <- result.map(
                  agent_store.agreement_event(
                    tx,
                    x.row.id,
                    now,
                    core_routes.by_org(a),
                    fn(e) { event_row.Row(..e, detail_share_id: Some(s.id)) },
                    event_row.OpportunityShareWithdrawn,
                  )
                  |> core_routes.storage,
                )
                fresh
              }
            }
          })
          http.json(200, json.object([#("share", share_view(fresh))]))
        }
      }
    }
  }
}

/// `GET /player/agent/shared-opportunities`: only the shares of agreements in force, so one made under a
/// relationship that has ended stops appearing.
pub fn player_shared(ctx: Ctx, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.json(
        200,
        json.object([
          #("items", json.array([], json.object)),
          #("minor", json.bool(True)),
        ]),
      )
    False -> {
      let now = clock.now_ms()
      use items <- core_routes.reading(ctx, fn(r) {
        use agreements <- result.try(agent_store.agreements_for_client(
          r,
          id.player_to_string(p.player.row.id),
        ))
        agreements
        |> list.filter(fn(x) {
          agent_rules.grants_access(x.row, x.row.agent_user_id, now)
        })
        |> list.try_map(fn(x) {
          use shares <- result.map(shares_of(r, x.row.id))
          shares
          |> list.filter(fn(s) { s.withdrawn_at == None })
          |> list.map(fn(s) { #(s, x) })
        })
        |> result.map(list.flatten)
      })
      let items =
        list.sort(items, fn(p, q) {
          int.compare({ q.0 }.shared_at, { p.0 }.shared_at)
        })
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(items, fn(pair) {
              let #(s, x) = pair
              json.object(
                list.append(share_fields(s), [
                  #("agreementId", id.agreement_json(x.row.id)),
                  #("agencyOrgId", id.org_json(x.row.agency_org_id)),
                ]),
              )
            }),
          ),
          #(
            "note",
            json.string(
              "Opportunities your agent brought to your attention. Each one is still yours to apply for, or not: your agent cannot apply for you and ScoutBox will not do it on their word.",
            ),
          ),
        ]),
      )
    }
  }
}
