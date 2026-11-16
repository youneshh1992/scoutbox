//// The Combine's records (domains/development/boxcam/combine.mjs): the standardised protocol registry, a club's
//// request that a player complete some of its tests, and who may see a player's Combine results.
////
//// Box Cam's analysis, which produces Combine Verified attempts, is moving to a service of its own, so this server
//// keeps only the records. Not ported yet: results from verified attempts (the personal bests, their display and
//// a request's completion), which wait on how that service hands results over; the player's and guardian's request
//// lists, `POST /org/combine/requests` and cancelling a request.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/combine_protocols
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff.{type Staff}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/combine_requests as row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/orgs
import scoutbox/safety/ledger
import scoutbox/vocab/audience
import sqlight
import wisp.{type Response}

pub type Request {
  Request(row: row.Row, protocol_ids: List(String))
}

/// The protocol's latest version is active in the registry: a club can only select from it, never invent one.
pub fn protocol_active(protocol_id: String) -> Bool {
  case latest(protocol_id) {
    Some(p) -> p.active
    None -> False
  }
}

fn latest(protocol_id: String) -> Option(combine_protocols.Protocol) {
  combine_protocols.protocols
  |> list.filter(fn(p) { p.id == protocol_id })
  |> list.sort(fn(a, b) { int.compare(b.version, a.version) })
  |> list.first
  |> option.from_result
}

/// `GET /org/combine/protocols`.
pub fn protocols(_ctx: Ctx) -> Response {
  wisp.json_response(combine_protocols.response, 200)
}

fn with_protocols(read: Read, r: row.Row) -> Result(Request, Fail(e)) {
  use ids <- result.map(store.query(
    read,
    "SELECT protocol_id FROM combine_request_protocols WHERE request_id = ? ORDER BY ord",
    [id.combine_request_sql(r.id)],
    decode.at([0], decode.string),
  ))
  Request(r, ids)
}

/// The organisation's requests to a player, newest first.
pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Request), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM combine_requests WHERE org_id = ? AND player_id = ? ORDER BY rowid DESC",
    [id.org_sql(org_id), id.player_sql(player_id)],
    row.decoder(),
  ))
  list.try_map(rows, with_protocols(read, _))
}

/// The players with a completed request from the organisation.
pub fn completed_players(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT DISTINCT player_id FROM combine_requests WHERE org_id = ? AND state = 'completed'",
    [id.org_sql(org_id)],
    decode.at([0], id.player_decoder()),
  )
}

/// Results need the standing gates (checked by the caller) and either the player's recruitment opt-in or a live
/// request from this organisation: answering a request implies consent. A Room is not consent.
pub fn org_may_see_results(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT 1 FROM box_cam_prefs WHERE player_id = ? AND share_development_activity = 'recruitment' UNION ALL SELECT 1 FROM combine_requests WHERE org_id = ? AND player_id = ? AND state <> 'cancelled' LIMIT 1",
    [id.player_sql(player_id), id.org_sql(org_id), id.player_sql(player_id)],
    decode.at([0], decode.int),
  ))
  rows != []
}

/// Whether the player shares development activity for recruitment (their Box Cam preference).
pub fn shares_development(
  read: Read,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT 1 FROM box_cam_prefs WHERE player_id = ? AND share_development_activity = 'recruitment'",
    [id.player_sql(player_id)],
    decode.at([0], decode.int),
  ))
  rows != []
}

pub const projection_note =
  "Combine Verified: measured from a standardized ScoutBox protocol during a live Box Cam session. Powered by Box Cam. Real numbers, not a talent score."

/// The recruitment-safe projection of a player's Combine results: no raw video, date of birth, private notes or
/// integrity internals. Not ported yet: the results themselves, from verified attempts.
pub fn projection_fields() -> List(#(String, Json)) {
  [
    #("results", json.preprocessed_array([])),
    #("hasCombineVerifiedResults", json.bool(False)),
    #("note", json.string(projection_note)),
  ]
}

pub fn request_view(r: Request) -> Json {
  json.object([
    #("id", id.combine_request_json(r.row.id)),
    #("orgId", id.org_json(r.row.org_id)),
    #("orgName", json.nullable(r.row.org_name, json.string)),
    #("title", json.nullable(r.row.title, json.string)),
    #(
      "requestedBy",
      json.object([
        #("userId", id.org_user_json(r.row.requested_by_user_id)),
        #("name", json.nullable(r.row.requested_by_name, json.string)),
        #("role", json.nullable(r.row.requested_by_role, json.string)),
        #("at", json.int(r.row.requested_at)),
      ]),
    ),
    #("playerId", id.player_json(r.row.player_id)),
    #(
      "protocols",
      json.array(r.protocol_ids, fn(pid) {
        json.object([
          #("protocolId", json.string(pid)),
          #(
            "protocolTitle",
            json.string(case latest(pid) {
              Some(p) -> p.title
              None -> pid
            }),
          ),
          // Not ported yet: completion, from verified attempts.
          #("completed", json.bool(False)),
        ])
      }),
    ),
    #("deadline", json.nullable(r.row.deadline_date, json.string)),
    #("instructions", json.nullable(r.row.instructions, json.string)),
    #(
      "state",
      json.string(case r.row.state {
        row.Cancelled -> "cancelled"
        _ -> "requested"
      }),
    ),
    #("createdAt", json.int(r.row.created_at)),
    #("completedCount", json.int(0)),
    #("requiredCount", json.int(list.length(r.protocol_ids))),
    #(
      "note",
      json.string(
        "Completing a Club Combine means the standardized tests were completed and Combine Verified. It does not mean the club has selected, endorsed or rejected the player.",
      ),
    ),
  ])
}

pub type NewRequest {
  NewRequest(
    protocol_ids: List(String),
    title: Option(String),
    deadline: Option(String),
    instructions: Option(String),
  )
}

/// Creates the request for a player the organisation may already see (the caller has checked), with its ledger
/// row and the player's notice (a minor's guardian's), inside the caller's unit.
pub fn create(
  tx: Tx,
  org: orgs.Row,
  user: Staff,
  p: Player,
  new: NewRequest,
  now: Int,
) -> Result(Request, Fail(e)) {
  use request_id <- result.try(id.next_combine_request(tx))
  let r =
    row.Row(
      id: request_id,
      org_id: org.id,
      org_name: Some(org.name),
      requested_by_user_id: user.id,
      requested_by_name: Some(user.name),
      requested_by_role: Some(user.role),
      requested_at: now,
      player_id: p.row.id,
      title: new.title,
      deadline_date: new.deadline,
      instructions: new.instructions,
      state: row.Requested,
      created_at: now,
      completed_at: None,
    )
  use _ <- result.try(row.insert(tx, r))
  use _ <- result.try(
    list.index_map(new.protocol_ids, fn(pid, i) { #(pid, i) })
    |> list.try_each(fn(pair) {
      store.run(
        tx,
        "INSERT INTO combine_request_protocols (request_id, ord, protocol_id) VALUES (?, ?, ?)",
        [
          id.combine_request_sql(request_id),
          sqlight.int(pair.1),
          sqlight.text(pair.0),
        ],
      )
    }),
  )
  // Not ported yet: the ledger entry's detail (the request and its protocols).
  use _ <- result.try(ledger.append(
    tx,
    ledger.Entry(
      entry_type: ledger_row.CombineRequestCreated,
      player_id: Some(p.row.id),
      org_id: Some(org.id),
      org_name: Some(org.name),
      user_id: Some(user.id),
      actor_name: Some(user.name),
    ),
    now,
  ))
  let n = list.length(new.protocol_ids)
  let msg =
    org.name
    <> " requested an At-Home Combine"
    <> case new.title {
      Some(t) -> ": " <> t
      None -> ""
    }
    <> " ("
    <> int.to_string(n)
    <> " test"
    <> case n > 1 {
      True -> "s"
      False -> ""
    }
    <> "). Powered by Box Cam."
  use _ <- result.map(case players.is_adult(p, now), p.row.guardian_id {
    False, Some(g) ->
      notifications.notify(
        tx,
        to: audience.Guardian,
        id: id.guardian_to_string(g),
        type_: "combine",
        text: p.row.name <> ": " <> msg,
        ref_id: Some(id.combine_request_to_string(request_id)),
        at: now,
      )
    _, _ ->
      notifications.notify(
        tx,
        to: audience.Player,
        id: id.player_to_string(p.row.id),
        type_: "combine",
        text: msg,
        ref_id: Some(id.combine_request_to_string(request_id)),
        at: now,
      )
  })
  Request(r, new.protocol_ids)
}

/// `GET /org/combine/players/:id`.
pub fn player_results(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use found <- result.try(players.for_org(read, player_id, a.org, now))
      case found {
        Some(#(p, access)) if access.visible && !access.blocked -> {
          use may <- result.map(org_may_see_results(read, a.org.id, p.row.id))
          Ok(#(p, may))
        }
        Some(_) -> Ok(Error(403))
        None -> Ok(Error(404))
      }
    })
  case found {
    Ok(Ok(#(p, False))) ->
      http.json(
        200,
        json.object([
          #("playerId", id.player_json(p.row.id)),
          #("results", json.preprocessed_array([])),
          #("shared", json.bool(False)),
          #(
            "note",
            json.string(
              "This player has not shared Combine results with your organisation. Request an At-Home Combine or ask them to share development activity.",
            ),
          ),
        ]),
      )
    Ok(Ok(#(p, True))) ->
      http.json(
        200,
        json.object([
          #("playerId", id.player_json(p.row.id)),
          #("playerName", json.string(p.row.name)),
          #("shared", json.bool(True)),
          ..projection_fields()
        ]),
      )
    Ok(Error(403)) -> http.error(403, "NOT_VISIBLE")
    Ok(Error(_)) -> http.error(404, "PLAYER_NOT_FOUND")
    Error(e) -> http.internal(e)
  }
}
