//// Football Passport sharing (domains/passport/sharing.mjs). A share's token is stored only as its SHA-256 hash,
//// and its secret exists only in the response that creates it. A share can only narrow what a viewer would see: a
//// public share resolves to the public projection, a recruitment share only inside an organisation's session,
//// which re-runs the standing gates. A minor's shares are the guardian's to manage.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/passport/football_passport
import scoutbox/passport/passport_rules as rules
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/wisp_ewe
import scoutbox/rows/id
import scoutbox/rows/passport_shares as share_row
import scoutbox/safety/ledger
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import scoutbox/vocab/party.{type Party}
import sqlight
import wisp.{type Request, type Response}

const day_ms = 86_400_000

// PASSPORT_LIMITS.shareDays.
const share_days_min = 1

const share_days_max = 90

const share_days_default = 30

fn share_view(s: share_row.Row) -> List(#(String, Json)) {
  [
    #("id", id.passport_share_json(s.id)),
    #("mode", share_row.mode_to_json(s.mode)),
    #("createdAt", json.int(s.created_at)),
    #("expiresAt", json.int(s.expires_at)),
    #("revokedAt", json.nullable(s.revoked_at, json.int)),
    #("views", json.int(s.views)),
    #("createdBy", party.to_json(s.created_by_kind)),
  ]
}

fn shares_for(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(share_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> share_row.columns
      <> " FROM passport_shares WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player_id)],
    share_row.decoder(),
  )
}

fn share_by(
  read: Read,
  column: String,
  value: sqlight.Value,
) -> Result(Option(share_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> share_row.columns
      <> " FROM passport_shares WHERE "
      <> column
      <> " = ?",
    [value],
    share_row.decoder(),
  )
  |> result.map(option.from_result)
}

// ------------------------------------------------------------------------------------------------ creating

type NewShare {
  NewShare(mode: share_row.Mode, days: Int)
}

fn create_share(
  ctx: Ctx,
  req: Request,
  p: Player,
  by: Party,
  by_id: String,
) -> Response {
  let shape = {
    use mode <- input.field(
      "mode",
      input.optional(input.one_of(share_row.mode_pairs)),
    )
    use days <- input.field(
      "expiresDays",
      input.nullish(input.whole_number(share_days_min, share_days_max)),
    )
    // A lifetime outside the range is refused, not clamped.
    input.done(NewShare(
      option.unwrap(mode, share_row.Public),
      option.unwrap(days, share_days_default),
    ))
  }
  use body <- http.body(req, shape, [#("mode", "MODE_INVALID")])
  let secret = rules.mint_share_secret()
  let now = clock.now_ms()
  let mode = share_row.mode_to_string(body.mode)
  let created =
    store.unit(ctx.store, fn(tx) {
      use share_id <- result.try(id.next_passport_share(tx))
      let share =
        share_row.Row(
          id: share_id,
          player_id: p.row.id,
          mode: body.mode,
          token_hash: rules.sha256(secret),
          created_by_kind: by,
          created_by_id: by_id,
          created_at: now,
          expires_at: now + body.days * day_ms,
          revoked_at: None,
          revoked_by_kind: None,
          revoked_by_id: None,
          views: 0,
        )
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO passport_shares (id, player_id, mode, token_hash, created_by_kind, created_by_id, created_at, expires_at, views) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
          [
            id.passport_share_sql(share.id),
            id.player_sql(p.row.id),
            sqlight.text(share_row.mode_to_string(body.mode)),
            sqlight.text(share.token_hash),
            sqlight.text(party.to_string(by)),
            sqlight.text(by_id),
            sqlight.int(now),
            sqlight.int(share.expires_at),
          ],
        ),
      )
      use entry <- result.try(ledger.append(
        tx,
        ledger.Entry(
          event: ledger.PassportShareCreated(body.mode, share.id),
          player_id: Some(p.row.id),
          org_id: None,
          org_name: None,
          user_id: None,
          actor_name: None,
        ),
        now,
      ))
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE ledger SET detail_mode = ?, detail_share_id = ? WHERE id = ?",
          [
            sqlight.text(mode),
            id.passport_share_sql(share.id),
            id.ledger_entry_sql(entry),
          ],
        ),
      )
      use _ <- result.try(notifications.notify(
        tx,
        to: audience.Player,
        id: id.player_to_string(p.row.id),
        type_: "passport",
        text: "A "
          <> mode
          <> " Football Passport share link was created"
          <> case by {
          party.Guardian -> " by your guardian"
          party.Player -> ""
        }
          <> ". It expires in "
          <> int.to_string(body.days)
          <> " days and can be revoked any time.",
        ref_id: Some(id.passport_share_to_string(share.id)),
        at: now,
      ))
      use _ <- result.map(football_passport.count(tx, "share_created"))
      share
    })
  case created {
    Error(e) -> http.internal(e)
    Ok(share) ->
      http.json(
        201,
        json.object([
          #("share", json.object(share_view(share))),
          // A QR code should encode exactly this URL.
          #(
            "url",
            json.string(case body.mode {
              share_row.Public -> "/passport/shared/" <> secret
              share_row.Recruitment -> "/org/passport/shared/" <> secret
            }),
          ),
          #(
            "note",
            json.string(case body.mode {
              share_row.Public ->
                "Anyone with the link sees the SAFE PUBLIC projection only."
              share_row.Recruitment ->
                "The link opens only inside an authenticated club session, and every standing visibility rule still applies — a share never widens access."
            }),
          ),
        ]),
      )
  }
}

/// `POST /player/football-passport/shares`: an adult's own; a minor's are guardian-managed.
pub fn player_create(ctx: Ctx, req: Request, a: PlayerAccess) -> Response {
  case players.is_adult(a.player, clock.now_ms()) {
    False ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your parent or guardian manages Passport sharing.",
      )
    True ->
      create_share(
        ctx,
        req,
        a.player,
        party.Player,
        id.player_to_string(a.player.row.id),
      )
  }
}

fn child_of(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
  refusal: Response,
  next: fn(Player) -> Response,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> refusal
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Ok(Some(c)) -> next(c)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Error(e) -> http.internal(e)
      }
  }
}

/// `POST /guardian/children/:id/football-passport/shares`.
pub fn guardian_create(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- child_of(ctx, g, child_id, http.error(403, "NOT_YOUR_CHILD"))
  create_share(ctx, req, child, party.Guardian, id.guardian_to_string(g.row.id))
}

// ------------------------------------------------------------------------------------------------ listing

fn list_answer(found: Result(List(share_row.Row), Fail(e))) -> Response {
  case found {
    Ok(shares) ->
      http.json(
        200,
        json.object([
          #("items", json.array(shares, fn(s) { json.object(share_view(s)) })),
        ]),
      )
    Error(e) -> http.internal(e)
  }
}

/// `GET /player/football-passport/shares`.
pub fn player_list(ctx: Ctx, a: PlayerAccess) -> Response {
  list_answer(store.read(ctx.store, shares_for(_, a.player.row.id)))
}

/// `GET /guardian/children/:id/football-passport/shares`.
pub fn guardian_list(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True -> list_answer(store.read(ctx.store, shares_for(_, child_id)))
  }
}

/// `GET /admin/passport/shares`: every share, newest first, by cursor.
pub fn admin_list(ctx: Ctx, req: Request) -> Response {
  use query <- http.query(req, paging.query_shape(), [])
  case paging.read(query, [paging.IntKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let #(after, args) = case page.after {
        Some([paging.IntKey(rid)]) -> #(" WHERE rowid < ?", [sqlight.int(rid)])
        _ -> #("", [])
      }
      let found =
        store.read(ctx.store, fn(read) {
          store.query(
            read,
            "SELECT "
              <> share_row.columns
              <> ", rowid FROM passport_shares"
              <> after
              <> " ORDER BY rowid DESC LIMIT ?",
            list.append(args, [sqlight.int(page.limit + 1)]),
            {
              use r <- decode.then(share_row.decoder())
              use rid <- decode.field(share_row.width, decode.int)
              decode.success(#(rid, r))
            },
          )
        })
      case found {
        Error(e) -> http.internal(e)
        Ok(rows) -> {
          let #(items, next) =
            paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.0)] })
          http.json(
            200,
            json.object([
              #(
                "items",
                json.array(items, fn(r) {
                  json.object(
                    list.append(share_view(r.1), [
                      #("playerId", id.player_json({ r.1 }.player_id)),
                    ]),
                  )
                }),
              ),
              #("nextCursor", json.nullable(next, json.string)),
            ]),
          )
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ revoking

type RevokeRefusal {
  ShareNotFound
  AlreadyRevoked
}

/// Revokes the share `find` reads inside the unit (None when it is not the caller's): immediately, so the next
/// request with its link fails.
fn revoke(
  ctx: Ctx,
  find: fn(Read) -> Result(Option(share_row.Row), Fail(RevokeRefusal)),
  by: share_row.RevokedByKind,
  by_id: String,
) -> Response {
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx: Tx) {
      use found <- result.try(find(store.reading(tx)))
      case found {
        None -> store.refuse(ShareNotFound)
        Some(s) if s.revoked_at != None -> store.refuse(AlreadyRevoked)
        Some(s) -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE passport_shares SET revoked_at = ?, revoked_by_kind = ?, revoked_by_id = ? WHERE id = ?",
              [
                sqlight.int(now),
                sqlight.text(share_row.revoked_by_kind_to_string(by)),
                sqlight.text(by_id),
                id.passport_share_sql(s.id),
              ],
            ),
          )
          use entry <- result.try(ledger.append(
            tx,
            ledger.Entry(
              event: ledger.PassportShareRevoked(s.id, by),
              player_id: Some(s.player_id),
              org_id: None,
              org_name: None,
              user_id: None,
              actor_name: None,
            ),
            now,
          ))
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE ledger SET detail_share_id = ?, detail_by = ? WHERE id = ?",
              [
                id.passport_share_sql(s.id),
                sqlight.text(share_row.revoked_by_kind_to_string(by)),
                id.ledger_entry_sql(entry),
              ],
            ),
          )
          use _ <- result.map(football_passport.count(tx, "share_revoked"))
          share_row.Row(
            ..s,
            revoked_at: Some(now),
            revoked_by_kind: Some(by),
            revoked_by_id: Some(by_id),
          )
        }
      }
    })
  case done {
    Ok(s) ->
      http.json(
        200,
        json.object([
          #("share", json.object(share_view(s))),
          #(
            "note",
            json.string(
              "Revocation is immediate — the next request with this link fails.",
            ),
          ),
        ]),
      )
    Error(store.Refused(ShareNotFound)) -> http.error(404, "SHARE_NOT_FOUND")
    Error(store.Refused(AlreadyRevoked)) -> http.error(409, "ALREADY_REVOKED")
    Error(e) -> http.internal(e)
  }
}

fn owned_by(
  player_id: id.PlayerId,
  share_id: id.PassportShareId,
) -> fn(Read) -> Result(Option(share_row.Row), Fail(e)) {
  fn(read) {
    share_by(read, "id", id.passport_share_sql(share_id))
    |> result.map(
      option.then(_, fn(s) {
        case s.player_id == player_id {
          True -> Some(s)
          False -> None
        }
      }),
    )
  }
}

/// `POST /player/football-passport/shares/:id/revoke`.
pub fn player_revoke(
  ctx: Ctx,
  a: PlayerAccess,
  share_id: id.PassportShareId,
) -> Response {
  case players.is_adult(a.player, clock.now_ms()) {
    False -> http.error(403, "GUARDIAN_MANAGED")
    True ->
      revoke(
        ctx,
        owned_by(a.player.row.id, share_id),
        share_row.Player,
        id.player_to_string(a.player.row.id),
      )
  }
}

/// `POST /guardian/children/:id/football-passport/shares/:sid/revoke`.
pub fn guardian_revoke(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
  share_id: id.PassportShareId,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      revoke(
        ctx,
        owned_by(child_id, share_id),
        share_row.Guardian,
        id.guardian_to_string(g.row.id),
      )
  }
}

/// `POST /admin/passport/shares/:id/revoke`: Trust & Safety revokes any share.
pub fn admin_revoke(ctx: Ctx, share_id: id.PassportShareId) -> Response {
  revoke(
    ctx,
    share_by(_, "id", id.passport_share_sql(share_id)),
    share_row.TrustSafety,
    "admin",
  )
}

// ------------------------------------------------------------------------------------------------ opening

/// The share a secret names, and its player, when it can be opened (resolveShare). Unknown, revoked, expired and a
/// removed subject are all the same from outside.
fn resolve(
  read: Read,
  secret: String,
  now: Int,
) -> Result(Option(#(share_row.Row, Player)), Fail(e)) {
  use share <- result.try(share_by(
    read,
    "token_hash",
    sqlight.text(rules.sha256(secret)),
  ))
  use player <- result.map(case share {
    Some(s) -> players.by_id(read, s.player_id)
    None -> Ok(None)
  })
  let problem =
    rules.share_problem(
      option.map(share, fn(s) { #(s.revoked_at, Some(s.expires_at)) }),
      now,
      player == None,
    )
  case problem, share, player {
    None, Some(s), Some(p) -> Some(#(s, p))
    _, _, _ -> None
  }
}

fn not_found() -> Response {
  http.error(404, "PASSPORT_NOT_FOUND")
}

fn record_view(tx: Tx, share: share_row.Row) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE passport_shares SET views = views + 1 WHERE id = ?", [
    id.passport_share_sql(share.id),
  ])
}

/// `GET /passport/shared/:token`: anyone with a public link sees the public projection. Enumeration is refused
/// with 429 long before the keyspace (24 random bytes) matters.
pub fn open_public(ctx: Ctx, req: Request, secret: String) -> Response {
  let now = clock.now_ms()
  let address = http.header(req, wisp_ewe.peer_header) |> result.unwrap("?")
  let answer = case
    limits.limited(ctx.limits, limits.PassportShareRead, address, now)
  {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(limits.PassportShareRead), fn(f) {
            #(f.0, json.string(f.1))
          }),
        ),
      )
    False ->
      case store.read(ctx.store, resolve(_, secret, now)) {
        Error(e) -> http.internal(e)
        Ok(Some(#(share, p))) if share.mode == share_row.Public -> {
          let opened =
            store.unit(ctx.store, fn(tx) {
              use _ <- result.try(record_view(tx, share))
              football_passport.count(tx, "share_opened_public")
            })
          case opened {
            Error(e) -> http.internal(e)
            Ok(Nil) ->
              case
                store.read(ctx.store, football_passport.shared_projection(
                  _,
                  p,
                  rules.PublicViewer,
                  rules.Opts(org_id: None, share_mode: Some("public")),
                  now,
                ))
              {
                Ok(body) -> http.json(200, body)
                Error(e) -> http.internal(e)
              }
          }
        }
        Ok(_) -> not_found()
      }
  }
  wisp.set_header(answer, "x-robots-tag", "noindex, nofollow")
}

/// `GET /org/passport/shared/:token`: the link locates, it never authorises. A recruitment share opens only for an
/// organisation that may see the player, and the Discovery Ledger records who opened it.
pub fn open_recruitment(ctx: Ctx, a: OrgAccess, secret: String) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, resolve(_, secret, now)) {
    Error(e) -> http.internal(e)
    Ok(Some(#(share, p))) if share.mode == share_row.Recruitment ->
      case store.read(ctx.store, players.for_org(_, p.row.id, a.org, now)) {
        Error(e) -> http.internal(e)
        Ok(Some(#(_, seen))) if seen.visible && !seen.blocked -> {
          let opened =
            store.unit(ctx.store, fn(tx) {
              use _ <- result.try(record_view(tx, share))
              use entry <- result.try(ledger.append(
                tx,
                ledger.Entry(
                  event: ledger.PassportRecruitmentView(through_share: True),
                  player_id: Some(p.row.id),
                  org_id: Some(a.org.id),
                  org_name: Some(a.org.name),
                  user_id: Some(a.user.id),
                  actor_name: Some(a.user.name),
                ),
                now,
              ))
              use _ <- result.try(
                store.run(
                  tx,
                  "UPDATE ledger SET detail_via = 'share' WHERE id = ?",
                  [id.ledger_entry_sql(entry)],
                ),
              )
              football_passport.count(tx, "share_opened_recruitment")
            })
          case opened {
            Error(e) -> http.internal(e)
            Ok(Nil) ->
              case
                store.read(ctx.store, football_passport.shared_projection(
                  _,
                  p,
                  football_passport.org_viewer(a.org),
                  rules.Opts(
                    org_id: Some(a.org.id),
                    share_mode: Some("recruitment"),
                  ),
                  now,
                ))
              {
                Ok(body) -> http.json(200, body)
                Error(e) -> http.internal(e)
              }
          }
        }
        Ok(_) ->
          http.error(403, case a.org.type_, players.is_adult(p, now) {
            org_type.Agency, False -> "UNDER_18_WALL"
            _, _ -> "NOT_VISIBLE"
          })
      }
    Ok(_) -> not_found()
  }
}
