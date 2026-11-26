//// Squad invitations (domains/scouting/passport.mjs, `squad_invites`). A minor's invitation goes to the guardian,
//// an adult's to the player; nobody joins a squad (or gets an account) without an approval.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/squad_invites as row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/scouting/coaches
import scoutbox/scouting/evidence
import scoutbox/scouting/squad
import scoutbox/vocab/audience
import sqlight
import wisp.{type Request, type Response}

pub type Invite =
  row.Row

const note_max = 200

pub fn by_id(
  read: Read,
  invite_id: id.SquadInviteId,
) -> Result(Option(Invite), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM squad_invites WHERE id = ?",
    [id.squad_invite_sql(invite_id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

fn pending_for(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  store.query(
    read,
    "SELECT id FROM squad_invites WHERE org_id = ? AND player_id = ? AND status IN ('pending_guardian','pending_player')",
    [id.org_sql(org_id), id.player_sql(player_id)],
    decode.at([0], id.squad_invite_decoder()),
  )
  |> result.map(fn(rows) { rows != [] })
}

pub fn view(i: Invite) -> Json {
  json.object([
    #("id", id.squad_invite_json(i.id)),
    #("orgId", id.org_json(i.org_id)),
    #("orgName", json.string(i.org_name)),
    #("playerId", id.player_json(i.player_id)),
    #("playerName", json.nullable(i.player_name, json.string)),
    #("byUserId", id.org_user_json(i.by_user_id)),
    #("byName", json.string(i.by_name)),
    #("note", json.nullable(i.note, json.string)),
    #("status", row.status_to_json(i.status)),
    #("createdAt", json.int(i.created_at)),
    #("respondedAt", json.nullable(i.responded_at, json.int)),
  ])
}

type NewInvite {
  NewInvite(player_id: String, note: Option(String))
}

/// `POST /org/squad/invite`.
pub fn invite(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.required(input.id()))
    use note <- input.field("note", input.nullish(input.text(note_max)))
    input.done(NewInvite(player_id:, note:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let player_id = id.player(body.player_id)
  case store.read(ctx.store, players.for_org(_, player_id, a.org, now)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Ok(Some(#(_, access))) if !access.visible || access.blocked ->
      http.error(403, "NOT_VISIBLE")
    Ok(Some(#(p, _))) -> {
      let note = input.filled(body.note)
      use <- moderate_maybe(
        ctx,
        note,
        audit.Context(
          kind: "squad_invite",
          player_id: Some(p.row.id),
          org_id: Some(a.org.id),
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
      )
      let minor = !players.is_adult(p, now)
      let saved =
        store.unit(ctx.store, fn(tx) {
          use pending <- result.try(pending_for(
            store.reading(tx),
            a.org.id,
            p.row.id,
          ))
          case pending {
            True -> store.refuse(Nil)
            False -> {
              use invite_id <- result.try(id.next_squad_invite(tx))
              let i =
                row.Row(
                  id: invite_id,
                  org_id: a.org.id,
                  org_name: evidence.stored_name(a.org.name),
                  player_id: p.row.id,
                  player_name: Some(evidence.stored_name(p.row.name)),
                  by_user_id: a.user.id,
                  by_name: evidence.stored_name(a.user.name),
                  note:,
                  status: case minor {
                    True -> row.PendingGuardian
                    False -> row.PendingPlayer
                  },
                  created_at: now,
                  responded_at: None,
                )
              use _ <- result.try(row.insert(tx, i))
              let ref_id = Some(id.squad_invite_to_string(invite_id))
              use _ <- result.map(case minor, p.row.guardian_id {
                True, Some(guardian_id) ->
                  notifications.notify(
                    tx,
                    to: audience.Guardian,
                    id: id.guardian_to_string(guardian_id),
                    type_: "squad_invite",
                    text: a.org.name
                      <> " invites "
                      <> p.row.name
                      <> " to join their squad list — your approval is required.",
                    ref_id:,
                    at: now,
                  )
                True, None -> Ok(Nil)
                False, _ ->
                  notifications.notify(
                    tx,
                    to: audience.Player,
                    id: id.player_to_string(p.row.id),
                    type_: "squad_invite",
                    text: a.org.name <> " invites you to join their squad list.",
                    ref_id:,
                    at: now,
                  )
              })
              i
            }
          }
        })
      case saved {
        Ok(i) -> http.json(201, json.object([#("invite", view(i))]))
        Error(store.Refused(Nil)) -> http.error(409, "INVITE_PENDING")
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}

fn moderate_maybe(
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

fn respond(ctx: Ctx, req: Request, i: Invite, approver: String) -> Response {
  let shape = {
    use accept <- input.field("accept", input.required(input.boolean()))
    input.done(accept)
  }
  use accept <- http.body(req, shape, [])
  let now = clock.now_ms()
  let saved =
    store.unit(ctx.store, fn(tx) {
      use rows <- result.try(store.write(
        tx,
        "UPDATE squad_invites SET status = ?, responded_at = ? WHERE id = ? AND status IN ('pending_guardian','pending_player') RETURNING "
          <> row.columns,
        [
          sqlight.text(
            row.status_to_string(case accept {
              True -> row.Approved
              False -> row.Declined
            }),
          ),
          sqlight.int(now),
          id.squad_invite_sql(i.id),
        ],
        row.decoder(),
      ))
      case rows, accept {
        [answered], False -> Ok(answered)
        [answered], True -> {
          use _ <- result.try(squad.join(
            tx,
            i.org_id,
            i.player_id,
            option.unwrap(i.player_name, "Player"),
            None,
            squad_row.InviteApproved,
            Some(evidence.stored_name(approver)),
            now,
          ))
          use _ <- result.map(notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(i.by_user_id),
            type_: "squad_invite",
            text: "✅ "
              <> option.unwrap(i.player_name, "")
              <> " joined your squad list (approved by "
              <> approver
              <> ").",
            ref_id: Some(id.squad_invite_to_string(i.id)),
            at: now,
          ))
          answered
        }
        _, _ -> store.stale("squad invitation")
      }
    })
  case saved {
    Ok(answered) -> http.json(200, json.object([#("invite", view(answered))]))
    Error(failure) -> coaches.failed(failure)
  }
}

fn for_players(
  ctx: Ctx,
  player_ids: List(id.PlayerId),
  status: row.Status,
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> " FROM squad_invites WHERE status = ? AND player_id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
        [
          sqlight.text(row.status_to_string(status)),
          sqlight.text(json.to_string(json.array(player_ids, id.player_json))),
        ],
        row.decoder(),
      )
    })
  case found {
    Ok(rows) -> http.json(200, json.array(rows, view))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/squad-invites`: the ones waiting on the player.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  for_players(ctx, [p.player.row.id], row.PendingPlayer)
}

/// `POST /player/squad-invites/:id/respond`.
pub fn player_respond(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  invite_id: id.SquadInviteId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, by_id(_, invite_id)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(i)) if i.player_id == p.player.row.id ->
      case i.status {
        row.PendingGuardian ->
          http.error_message(
            403,
            "GUARDIAN_MANAGED",
            "Your parent or guardian responds to squad invitations.",
          )
        row.PendingPlayer -> respond(ctx, req, i, "the player")
        _ -> http.error(409, "ALREADY_RESOLVED")
      }
    Ok(_) -> http.error(404, "INVITE_NOT_FOUND")
  }
}

/// `GET /guardian/squad-invites`: the ones waiting on the guardian.
pub fn guardian_list(ctx: Ctx, g: Guardian) -> Response {
  for_players(ctx, g.child_ids, row.PendingGuardian)
}

/// `POST /guardian/squad-invites/:id/respond`.
pub fn guardian_respond(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  invite_id: id.SquadInviteId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, by_id(_, invite_id)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(i)) ->
      case list.contains(g.child_ids, i.player_id), i.status {
        False, _ -> http.error(404, "INVITE_NOT_FOUND")
        True, row.PendingGuardian ->
          respond(ctx, req, i, "guardian " <> g.row.name)
        True, _ -> http.error(409, "ALREADY_RESOLVED")
      }
    Ok(None) -> http.error(404, "INVITE_NOT_FOUND")
  }
}
