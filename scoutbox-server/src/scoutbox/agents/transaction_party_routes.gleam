//// A party's lanes of a transaction workspace (domains/agents/transactions/clubRoutes.mjs and playerRoutes.mjs):
//// a club's and a player's list, read, confirmation, notes, documents, links and timeline.
////
//// A party sees only its own slice. A club that is not a party, and a player who is not the individual, are told
//// nothing exists.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/transaction_routes as shared
import scoutbox/agents/transaction_rules.{type Viewer}
import scoutbox/agents/transaction_store.{type Transaction}
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_notes as note_row
import scoutbox/rows/transaction_parties as party_row
import scoutbox/verification/claims
import scoutbox/verification/records
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/org_type
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/subject_kind
import scoutbox/vocab/transaction_status
import scoutbox/vocab/ver_level
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------- actors

fn by_club_user(a: OrgAccess) -> By {
  compliance_store.By(
    kind: compliance_actor_kind.ClubUser,
    id: Some(id.org_user_to_string(a.user.id)),
    name: Some(a.user.name),
    role: None,
    org_id: Some(a.org.id),
  )
}

fn by_player(p: PlayerAccess) -> By {
  compliance_store.By(
    kind: compliance_actor_kind.Player,
    id: Some(id.player_to_string(p.player.row.id)),
    name: Some(p.player.row.name),
    role: None,
    org_id: None,
  )
}

/// A recorded club signatory is a verification administrator of the club.
fn signatory(read: Read, a: OrgAccess) -> Result(Bool, Fail(e)) {
  use admins <- result.map(records.admins_of(read, a.org.id))
  claims.has_ver_level(admins, a.org.id, a.user.id, ver_level.VerificationAdmin)
}

fn club_viewer(read: Read, a: OrgAccess) -> Result(Viewer, Fail(e)) {
  use s <- result.map(signatory(read, a))
  transaction_rules.ClubViewer(
    org_id: id.org_to_string(a.org.id),
    user_id: id.org_user_to_string(a.user.id),
    signatory: s,
  )
}

fn player_viewer(p: PlayerAccess) -> Viewer {
  transaction_rules.PlayerViewer(id.player_to_string(p.player.row.id))
}

// ------------------------------------------------------------------------------------------------- resolution

/// A club party's transaction: 404 for any other organisation; with `need_signatory`, only a recorded signatory acts.
fn club_transaction(
  ctx: Ctx,
  a: OrgAccess,
  transaction_id: String,
  need_signatory: Bool,
  next: fn(Transaction, Viewer, PartyRole) -> Response,
) -> Response {
  case a.org.type_ {
    org_type.Club -> {
      use found <- shared.reading(ctx, fn(r) {
        use t <- result.try(transaction_store.by_id(
          r,
          id.transaction(transaction_id),
        ))
        use viewer <- result.map(club_viewer(r, a))
        #(t, viewer)
      })
      let #(t, viewer) = found
      let role = case t {
        Some(t) ->
          transaction_rules.club_party_role(
            t.parties,
            id.org_to_string(a.org.id),
          )
        None -> None
      }
      case t, role, viewer {
        Some(t), Some(role), transaction_rules.ClubViewer(signatory: s, ..) ->
          case need_signatory && !s {
            True ->
              shared.err(
                "SIGNATORY_REQUIRED",
                "Only a recorded club signatory (a verification administrator) may act for the club here.",
                [],
              )
            False -> next(t, viewer, role)
          }
        _, _, _ -> shared.not_found()
      }
    }
    _ -> shared.not_found()
  }
}

/// The individual's own transaction; a minor has none.
fn player_transaction(
  ctx: Ctx,
  p: PlayerAccess,
  transaction_id: String,
  next: fn(Transaction) -> Response,
) -> Response {
  case p.minor {
    True -> shared.not_found()
    False -> {
      use found <- shared.reading(ctx, transaction_store.by_id(
        _,
        id.transaction(transaction_id),
      ))
      let me = id.player_to_string(p.player.row.id)
      case found {
        Some(t) ->
          case
            list.any(t.parties, fn(x) {
              !x.removed
              && x.subject_kind == subject_kind.Player
              && x.subject_id == me
            })
          {
            True -> next(t)
            False -> shared.not_found()
          }
        None -> shared.not_found()
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- the club's lane

/// `GET /org/transactions`: paged, since a club's list grows with every transaction it is named in.
pub fn club_list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  case a.org.type_ {
    org_type.Club -> {
      let shape = {
        use limit <- input.field("limit", input.optional(input.text(1_000_000)))
        use cursor <- input.field(
          "cursor",
          input.optional(input.text(1_000_000)),
        )
        input.done(#(limit, cursor))
      }
      use q <- shared.query(req, shape)
      use p <- shared.page(q.0, q.1)
      let now = clock.now_ms()
      use #(items, next, s) <- shared.reading(ctx, fn(r) {
        use viewer <- result.try(club_viewer(r, a))
        use rows <- result.try(transaction_store.club_page(
          r,
          a.org.id,
          shared.after_of(p),
          p.limit,
        ))
        let #(items, next) = shared.paged(rows, p)
        use views <- result.map(
          list.try_map(items, shared.project(r, _, viewer, now)),
        )
        let assert transaction_rules.ClubViewer(signatory: s, ..) = viewer
        #(views, next, s)
      })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("nextCursor", json.nullable(next, json.string)),
          #("signatory", json.bool(s)),
          #("statuses", shared.codes_json(transaction_status.pairs)),
          #("documentTypes", shared.codes_json(shared.document_type_pairs)),
          #("note", case s {
            True -> json.null()
            False ->
              json.string(
                "You can read the transactions this club is party to. Confirming the club's participation and answering a consent need a recorded club signatory.",
              )
          }),
          #("honest", json.string(transaction_rules.honest)),
        ]),
      )
    }
    _ ->
      http.json(
        200,
        json.object([
          #("items", json.array([], json.string)),
          #("nextCursor", json.null()),
          #(
            "note",
            json.string("Transaction party lanes are for club organisations."),
          ),
        ]),
      )
  }
}

fn signatory_of(viewer: Viewer) -> Bool {
  case viewer {
    transaction_rules.ClubViewer(signatory: s, ..) -> s
    _ -> False
  }
}

/// `GET /org/transactions/:id`.
pub fn club_get(ctx: Ctx, a: OrgAccess, transaction_id: String) -> Response {
  use t, viewer, _ <- club_transaction(ctx, a, transaction_id, False)
  use view <- shared.reading(ctx, shared.project(_, t, viewer, clock.now_ms()))
  http.json(
    200,
    json.object([
      #("transaction", view),
      #("signatory", json.bool(signatory_of(viewer))),
    ]),
  )
}

/// Only the party binds itself: a party confirms its own participation, once.
fn confirm(
  ctx: Ctx,
  req: Request,
  t: Transaction,
  party: party_row.Row,
  viewer: Viewer,
  by: By,
  notice: String,
) -> Response {
  use raw <- shared.rev_only(req)
  let now = clock.now_ms()
  case party.confirmed_at {
    Some(_) -> {
      use view <- shared.reading(ctx, shared.project(_, t, viewer, now))
      http.json(200, shared.idempotent_body(view))
    }
    None -> {
      use <- shared.guard_rev(raw, t)
      use tx <- shared.acting(ctx, t)
      use _ <- result.try(
        transaction_store.confirm_party(tx, t.row.id, party.id, by, now)
        |> shared.storage,
      )
      use _ <- result.try(
        transaction_store.history(
          tx,
          t.row.id,
          event_row.TransactionPartyConfirmed,
          by,
          transaction_store.Detail(
            ..transaction_store.no_detail,
            party_role: Some(party.party_role),
            subject_kind: Some(party.subject_kind),
          ),
          now,
        )
        |> shared.storage,
      )
      use _ <- result.try(
        shared.party_changed(tx, t.row.id, by, now) |> shared.storage,
      )
      use _ <- result.try(
        transaction_store.bump(tx, t.row.id, by, now) |> shared.storage,
      )
      store.emit(
        tx,
        effect.Live(live_event.AgentTransactionPartyChanged(
          org_id: id.org_to_string(t.row.agency_org_id),
          tx_id: id.transaction_to_string(t.row.id),
          party_role: party_role.to_string(party.party_role),
        )),
      )
      use _ <- result.try(
        notifications.notify(
          tx,
          to: audience.OrgUser,
          id: id.org_user_to_string(t.row.agent_user_id),
          type_: "agent_transaction",
          text: notice,
          ref_id: Some(id.transaction_to_string(t.row.id)),
          at: now,
        )
        |> shared.storage,
      )
      use view <- result.map(shared.projected(tx, t.row.id, viewer, now))
      http.json(200, shared.transaction_body(view))
    }
  }
}

/// `POST /org/transactions/:id/confirm`: only a recorded signatory binds the club.
pub fn club_confirm(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use t, viewer, _ <- club_transaction(ctx, a, transaction_id, True)
  use <- shared.writable(ctx, t)
  use <- shared.limited(
    ctx,
    req,
    limits.TransactionStatusWrite,
    id.org_user_to_string(a.user.id),
  )
  let org = id.org_to_string(a.org.id)
  case
    list.find(t.parties, fn(p) {
      !p.removed && p.subject_kind == subject_kind.Club && p.subject_id == org
    })
  {
    Error(Nil) -> shared.not_found()
    Ok(party) ->
      confirm(
        ctx,
        req,
        t,
        party,
        viewer,
        by_club_user(a),
        "A club confirmed its participation as the "
          <> string.replace(party_role.to_string(party.party_role), "_", " ")
          <> " in a transaction.",
      )
  }
}

/// `POST /org/transactions/:id/notes`.
pub fn club_note(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use t, viewer, side <- club_transaction(ctx, a, transaction_id, False)
  shared.note_by(
    ctx,
    req,
    t,
    shared.roles_of(t, viewer),
    Some(side),
    by_club_user(a),
    note_row.ClubUser,
    id.org_user_to_string(a.user.id),
  )
}

fn timeline_response(
  ctx: Ctx,
  t: Transaction,
  viewer: Viewer,
  side: Option(PartyRole),
  note: String,
) -> Response {
  use items <- shared.reading(ctx, shared.timeline(
    _,
    t,
    shared.roles_of(t, viewer),
    side,
  ))
  http.json(200, json.object([#("items", items), #("note", json.string(note))]))
}

/// `GET /org/transactions/:id/timeline`.
pub fn club_timeline(
  ctx: Ctx,
  a: OrgAccess,
  transaction_id: String,
) -> Response {
  use t, viewer, side <- club_transaction(ctx, a, transaction_id, False)
  timeline_response(
    ctx,
    t,
    viewer,
    Some(side),
    "The timeline is what this club may see of what happened.",
  )
}

// ------------------------------------------------------------------------------------------------- the player's lane

/// `GET /player/transactions`: a per-player list, not paged.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.json(
        200,
        json.object([
          #("items", json.array([], json.string)),
          #("minor", json.bool(True)),
          #(
            "note",
            json.string(
              "Agent transactions are not available for under-18 accounts in ScoutBox.",
            ),
          ),
        ]),
      )
    False -> {
      let viewer = player_viewer(p)
      let now = clock.now_ms()
      use items <- shared.reading(ctx, fn(r) {
        use mine <- result.try(transaction_store.for_player(r, p.player.row.id))
        list.try_map(mine, shared.project(r, _, viewer, now))
      })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("statuses", shared.codes_json(transaction_status.pairs)),
          #("honest", json.string(transaction_rules.honest)),
        ]),
      )
    }
  }
}

/// `GET /player/transactions/:id`.
pub fn player_get(
  ctx: Ctx,
  p: PlayerAccess,
  transaction_id: String,
) -> Response {
  use t <- player_transaction(ctx, p, transaction_id)
  use view <- shared.reading(ctx, shared.project(
    _,
    t,
    player_viewer(p),
    clock.now_ms(),
  ))
  http.json(200, shared.transaction_body(view))
}

/// `POST /player/transactions/:id/confirm`: nobody confirms for the individual.
pub fn player_confirm(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  transaction_id: String,
) -> Response {
  use t <- player_transaction(ctx, p, transaction_id)
  use <- shared.writable(ctx, t)
  let me = id.player_to_string(p.player.row.id)
  use <- shared.limited(ctx, req, limits.TransactionStatusWrite, me)
  case
    list.find(t.parties, fn(x) {
      !x.removed && x.subject_kind == subject_kind.Player && x.subject_id == me
    })
  {
    Error(Nil) -> shared.not_found()
    Ok(party) ->
      confirm(
        ctx,
        req,
        t,
        party,
        player_viewer(p),
        by_player(p),
        "Your client confirmed their participation in a transaction.",
      )
  }
}

/// `GET /player/transactions/:id/timeline`.
pub fn player_timeline(
  ctx: Ctx,
  p: PlayerAccess,
  transaction_id: String,
) -> Response {
  use t <- player_transaction(ctx, p, transaction_id)
  timeline_response(
    ctx,
    t,
    player_viewer(p),
    Some(party_role.Individual),
    "The timeline is what you may see of what happened in this transaction.",
  )
}
