//// Squad invitations (domains/verification/claims/inviteRoutes.mjs): a verified club invites a player to join. An
//// invitation creates no identity claim and never bypasses guardianship: a minor's is accepted by their guardian.

import gleam/bool
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx, SendMail}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_player_invites as row
import scoutbox/rows/ver_tokens as token_row
import scoutbox/rules/visibility
import scoutbox/verification/claims
import scoutbox/verification/core.{act, reply, stop}
import scoutbox/verification/records
import scoutbox/vocab/audience
import sqlight
import wisp.{type Request, type Response}

const per_day = 20

const day_ms = 86_400_000

const validity_ms = 1_209_600_000

pub type Invite =
  row.Row

pub fn record(i: Invite) -> Json {
  json.object([
    #("id", json.string(i.id)),
    #("orgId", json.string(i.org_id)),
    #("byUserId", json.string(i.by_user_id)),
    #("byName", json.nullable(i.by_name, json.string)),
    #("name", json.string(i.invitee_name)),
    #("squad", json.string(i.squad)),
    #("status", json.string(row.status_to_string(i.status))),
    #("playerId", json.nullable(i.player_id, json.string)),
    #("targetPlayerId", json.nullable(i.target_player_id, json.string)),
    #("guardianApproved", case i.guardian_approved_id, i.guardian_approved_at {
      Some(id), Some(at) ->
        json.object([#("guardianId", json.string(id)), #("at", json.int(at))])
      _, _ -> json.null()
    }),
    #("createdAt", json.int(i.created_at)),
    #("expiresAt", json.int(i.expires_at)),
    #("acceptedAt", json.nullable(i.accepted_at, json.int)),
  ])
}

fn invites_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Invite), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM ver_player_invites WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    row.decoder(),
  )
}

/// Whether `org` may reach the player, by the standing visibility rule and the player's blocks.
pub fn reachable(
  read: Read,
  org: orgs.Org,
  player_id: String,
  now: Int,
) -> Result(Bool, Fail(e)) {
  let q =
    sql.concat([
      sql.text("SELECT 1 FROM players p WHERE p.deleted_at IS NULL AND p.id = "),
      sql.arg(sqlight.text(player_id)),
      sql.text(" AND "),
      visibility.visible_sql(org, now),
      sql.text(" AND NOT "),
      visibility.blocked_sql(org),
    ])
  store.one(read, q.sql, q.args, decode.success(Nil))
  |> result.map(result.is_ok)
}

type NewInvite {
  NewInvite(
    name: Option(String),
    squad: Option(String),
    email: Option(String),
    player_id: Option(String),
  )
}

/// `POST /org/verification/player-invites`. An invitation to an existing player binds the code to them.
pub fn create(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let shape = {
    use name <- input.field("name", input.nullish(input.text(80)))
    use squad <- input.field("squad", input.nullish(input.text(60)))
    use email <- input.field("email", input.nullish(input.text(254)))
    // '' is the form's "no player".
    use player_id <- input.field("playerId", input.nullish(input.text(80)))
    input.done(NewInvite(name:, squad:, email:, player_id:))
  }
  let parsed = http.parse_body(req, shape, [#("email", "EMAIL_SYNTAX")])
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use status <- result.try(core.org_status(read, Some(access.org)))
  use <- bool.lazy_guard(status != claims.OrgVerified, fn() {
    stop(http.error_message(
      403,
      "ORG_NOT_ELIGIBLE",
      "Only a verified organisation can send squad invitations.",
    ))
  })
  use today <- result.try(
    invites_where(read, "org_id = ? AND created_at > ?", [
      sqlight.text(access.org.id),
      sqlight.int(now - day_ms),
    ]),
  )
  use <- bool.lazy_guard(list.length(today) >= per_day, fn() {
    stop(http.error_message(
      429,
      "INVITE_RATE_LIMIT",
      "Deterministic limit: 20 invitations per organisation per day.",
    ))
  })
  case parsed {
    Error(response) -> stop(response)
    Ok(body) ->
      case input.filled(body.name) {
        None -> stop(http.required("NAME_REQUIRED", "name"))
        Some(name) -> {
          let email = input.filled(body.email)
          use <- bool.lazy_guard(
            case email {
              Some(e) -> claims.email_problem(e) != None
              None -> False
            },
            fn() {
              stop(http.json(
                400,
                json.object([
                  #("error", json.string("EMAIL_SYNTAX")),
                  #("field", json.string("email")),
                ]),
              ))
            },
          )
          // Targeting uses the standing visibility rules, so an invitation is not a discovery bypass.
          use target <- result.try(case body.player_id {
            Some(id) if id != "" -> {
              use found <- result.try(players.by_id(read, id))
              case found {
                None -> stop(http.error(404, "PLAYER_NOT_FOUND"))
                Some(p) -> {
                  use ok <- result.try(reachable(
                    read,
                    access.org,
                    p.row.id,
                    now,
                  ))
                  case ok {
                    True -> Ok(Some(p))
                    // No probing for hidden players.
                    False -> stop(http.error(404, "PLAYER_NOT_FOUND"))
                  }
                }
              }
            }
            _ -> Ok(None)
          })
          use id <- result.try(ids.next(tx, "vpin"))
          let invite =
            row.Row(
              id:,
              org_id: access.org.id,
              by_user_id: access.user.id,
              by_name: Some(input.utf16_take(access.user.name, 200)),
              invitee_name: name,
              squad: option.unwrap(body.squad, ""),
              status: row.Pending,
              player_id: None,
              target_player_id: option.map(target, fn(p) { p.row.id }),
              guardian_approved_id: None,
              guardian_approved_at: None,
              created_at: now,
              expires_at: now + validity_ms,
              accepted_at: None,
            )
          use _ <- result.try(store.run(tx, row.insert_sql, row.values(invite)))
          use secret <- result.try(core.mint_token(
            tx,
            token_row.PlayerInvite,
            email,
            option.map(target, fn(_) { token_row.Player }),
            option.map(target, fn(p) { p.row.id }),
            Some(access.org.id),
            Some(id),
            validity_ms,
            now,
          ))
          let body_fields = case email {
            Some(_) -> [#("invite", record(invite))]
            None -> [
              #("invite", record(invite)),
              #("code", json.string(secret)),
              #(
                "note",
                json.string(
                  "No email supplied — hand the single-use code to the player (or their guardian) directly.",
                ),
              ),
            ]
          }
          Ok(
            #(http.json(201, json.object(body_fields)), case email {
              Some(to) -> [
                SendMail(
                  to:,
                  subject: access.org.name <> " invited you to ScoutBox",
                  text: "Hi "
                    <> name
                    <> ",\n\n"
                    <> access.user.name
                    <> " at "
                    <> access.org.name
                    <> " invites you to join ScoutBox"
                    <> case invite.squad {
                    "" -> ""
                    squad -> " (" <> squad <> ")"
                  }
                    <> ".\n\nInvitation code: "
                    <> secret
                    <> "\n\nJoining is your choice — an invitation gives the club no control over your profile. Under-18s join through a parent or guardian.",
                ),
              ]
              None -> []
            }),
          )
        }
      }
  }
}

/// `GET /org/verification/player-invites`.
pub fn list_invites(ctx: Ctx, access: OrgAccess) -> Response {
  use read <- core.look(ctx)
  use items <- result.map(
    invites_where(read, "org_id = ?", [sqlight.text(access.org.id)]),
  )
  http.json(200, json.object([#("items", json.array(items, record))]))
}

/// `POST /player/invites/accept`: an adult accepts for themselves.
pub fn player_accept(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your guardian accepts club invitations for you.",
      )
    False -> {
      let shape = {
        use code <- input.field("code", input.nullish(input.text(64)))
        use email <- input.field("email", input.nullish(input.text(254)))
        input.done(#(code, email))
      }
      use #(code, email) <- http.body(req, shape, [])
      accept(ctx, code, p.player, None, email)
    }
  }
}

/// `POST /guardian/invites/accept`: a guardian accepts for their child.
pub fn guardian_accept(ctx: Ctx, req: Request, g: Guardian) -> Response {
  let shape = {
    use code <- input.field("code", input.nullish(input.text(64)))
    use child_id <- input.field("childId", input.required(input.id()))
    input.done(#(code, child_id))
  }
  use #(code, child_id) <- http.body(req, shape, [])
  case list.contains(g.child_ids, child_id) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Ok(Some(child)) -> accept(ctx, code, child, Some(g), None)
        Ok(None) -> http.error(404, "CHILD_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
  }
}

/// Peek, check every binding, then spend: a wrong-recipient attempt must not burn the rightful recipient's code.
fn accept(
  ctx: Ctx,
  code: Option(String),
  player: Player,
  guardian: Option(Guardian),
  claimed_email: Option(String),
) -> Response {
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use peek <- result.try(core.peek_token(
    read,
    token_row.PlayerInvite,
    code,
    None,
    None,
    now,
  ))
  case peek {
    Error(code) ->
      stop(http.error(
        case code {
          "TOKEN_EXPIRED" -> 410
          _ -> 404
        },
        code,
      ))
    Ok(token) -> {
      use found <- result.try(
        invites_where(read, "id = ?", [
          sqlight.text(option.unwrap(token.ref_id, "")),
        ]),
      )
      case found {
        [inv] if inv.status == row.Pending && inv.player_id == None -> {
          use org <- result.try(orgs.by_id(read, inv.org_id))
          case org {
            Some(o) if !o.suspended -> {
              let recipient = Some(player.row.id)
              case token.subject_id {
                // An identity-bound invitation: only the named player, or that child through their guardian.
                Some(_) if token.subject_id != recipient -> {
                  use _ <- result.try(core.event(
                    tx,
                    event_row.SecuritySelfVerificationBlocked,
                    core.system_actor(None),
                    core.About(
                      ..core.nothing,
                      org_id: Some(inv.org_id),
                      subject_id: Some(player.row.id),
                      reason: Some("invite recipient mismatch (identity-bound)"),
                      detail: records.detail([], [#("invite", Some(inv.id))]),
                    ),
                    now,
                  ))
                  reply(http.error_message(
                    403,
                    "INVITE_RECIPIENT_MISMATCH",
                    "This invitation names a different recipient. Codes cannot be transferred.",
                  ))
                }
                _ ->
                  address_check(
                    tx,
                    token,
                    inv,
                    player,
                    guardian,
                    claimed_email,
                    now,
                  )
              }
            }
            _ -> stop(http.error(403, "ORG_UNAVAILABLE"))
          }
        }
        _ -> stop(http.error(404, "INVITE_NOT_FOUND"))
      }
    }
  }
}

/// An address-bound invitation: a guardian's account e-mail must match. Player accounts carry no e-mail, so an
/// adult confirms the address the invitation went to.
fn address_check(
  tx: store.Tx,
  token: records.Token,
  inv: Invite,
  player: Player,
  guardian: Option(Guardian),
  claimed_email: Option(String),
  now: Int,
) -> core.Done {
  let supplied =
    case guardian {
      Some(g) -> Some(g.row.email)
      None -> claimed_email
    }
    |> option.unwrap("")
    |> string.trim
    |> string.lowercase
  case token.email {
    Some(addressed) if addressed != supplied ->
      stop(
        http.error_message(403, "INVITE_RECIPIENT_MISMATCH", case guardian {
          Some(_) ->
            "This invitation was addressed to a different guardian email."
          None -> "Confirm the email address the invitation was sent to."
        }),
      )
    _ -> {
      use _ <- result.try(records.use_token(tx, token.id, now))
      let accepted =
        row.Row(
          ..inv,
          status: row.Accepted,
          player_id: Some(player.row.id),
          accepted_at: Some(now),
          guardian_approved_id: option.map(guardian, fn(g) { g.row.id }),
          guardian_approved_at: option.map(guardian, fn(_) { now }),
        )
      use rows <- result.try(store.write(
        tx,
        "UPDATE ver_player_invites SET status = 'accepted', player_id = ?, accepted_at = ?, guardian_approved_id = ?, guardian_approved_at = ? WHERE id = ? AND status = 'pending' AND player_id IS NULL RETURNING 1",
        [
          sqlight.text(player.row.id),
          sqlight.int(now),
          sqlight.nullable(sqlight.text, accepted.guardian_approved_id),
          sqlight.nullable(sqlight.int, accepted.guardian_approved_at),
          sqlight.text(inv.id),
        ],
        decode.success(Nil),
      ))
      let assert [_] = rows as "a pending invitation is accepted once"
      use _ <- result.try(core.event(
        tx,
        event_row.ClaimCreated,
        core.system_actor(None),
        core.About(
          ..core.nothing,
          org_id: Some(inv.org_id),
          subject_id: Some(player.row.id),
          detail: records.detail([], [
            #("invite", Some(inv.id)),
            #(
              "guardianApproved",
              Some(case guardian {
                Some(_) -> "true"
                None -> "false"
              }),
            ),
          ]),
        ),
        now,
      ))
      use _ <- result.try(notifications.notify(
        tx,
        to: audience.OrgUser,
        id: inv.by_user_id,
        type_: "verification",
        text: player.row.name
          <> " accepted your squad invitation"
          <> case guardian {
          Some(_) -> " (guardian-approved)"
          None -> ""
        }
          <> ".",
        ref_id: Some(inv.id),
        at: now,
      ))
      reply(http.json(
        200,
        json.object([
          #("invite", record(accepted)),
          #(
            "note",
            json.string(
              "Joining links nothing else: club visibility, contact and consent all still follow the standing safeguarding rules.",
            ),
          ),
        ]),
      ))
    }
  }
}
