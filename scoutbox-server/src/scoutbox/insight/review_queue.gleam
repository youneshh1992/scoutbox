//// The review queue (domains/insight/insight.mjs): the players a club has seen in the last 90 days but not yet
//// assessed, the ones it put off for later, and the players whose last assessment is over 180 days old. Absent
//// evidence is "not yet reviewed", never a poor rating. Exposure is what the club's own views record.

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/review_later
import sqlight
import wisp.{type Request, type Response}

const window_days = 90

const stale_days = 180

const day_ms = 86_400_000

pub type Kind {
  Impression
  ProfileView
  EvidenceView
}

fn kind_text(kind: Kind) -> String {
  case kind {
    Impression -> "impression"
    ProfileView -> "profile_view"
    EvidenceView -> "evidence_view"
  }
}

/// One exposure event per organisation, player, kind and day (the table's unique key). Recorded after the view
/// answered, as the TypeScript server's response hook does: a failure here never fails the view.
pub fn record_exposure(
  ctx: Ctx,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  kind: Kind,
) -> Nil {
  let at = clock.now_ms()
  let _ = store.unit(ctx.store, record(_, org_id, player_id, kind, at))
  Nil
}

/// Records the event inside the caller's unit: `False` when the day already has it.
pub fn record(
  tx: Tx,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  kind: Kind,
  at: Int,
) -> Result(Bool, Fail(e)) {
  use seen <- result.try(store.query(
    store.reading(tx),
    "SELECT 1 FROM exposure_events WHERE org_id = ? AND player_id = ? AND kind = ? AND day_index = ?",
    [
      id.org_sql(org_id),
      id.player_sql(player_id),
      sqlight.text(kind_text(kind)),
      sqlight.int(at / day_ms),
    ],
    decode.success(Nil),
  ))
  case seen {
    [_] -> Ok(False)
    _ -> {
      use id <- result.try(ids.next(tx, "exp"))
      use _ <- result.map(
        store.run(
          tx,
          "INSERT INTO exposure_events (id, org_id, player_id, kind, day_index, at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            sqlight.text(id),
            id.org_sql(org_id),
            id.player_sql(player_id),
            sqlight.text(kind_text(kind)),
            sqlight.int(at / day_ms),
            sqlight.int(at),
          ],
        ),
      )
      True
    }
  }
}

/// `GET /org/review-queue`.
pub fn review_queue(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, read_queue(_, a, now)) {
    Error(failure) -> http.internal(failure)
    Ok(#(queue, deferred, stale)) ->
      http.json(
        200,
        json.object([
          #("queue", json.preprocessed_array(queue)),
          #("deferred", json.preprocessed_array(deferred)),
          #("staleEvaluations", json.preprocessed_array(stale)),
        ]),
      )
  }
}

fn read_queue(
  read: Read,
  a: OrgAccess,
  now: Int,
) -> Result(#(List(Json), List(Json), List(Json)), Fail(e)) {
  let org = a.org
  let today = now / day_ms
  // Visible players with exposure but no submitted assessment from this club, oldest exposure first.
  use first_seen <- result.try(
    store.query(
      read,
      "SELECT player_id, MIN(day_index) AS first_day FROM exposure_events
     WHERE org_id = ? AND day_index >= ?
       AND player_id NOT IN (SELECT player_id FROM assessments WHERE org_id = ? AND state <> 'draft')
     GROUP BY player_id ORDER BY first_day, player_id",
      [
        id.org_sql(org.id),
        sqlight.int(today - window_days),
        id.org_sql(org.id),
      ],
      {
        use player_id <- decode.field(0, id.player_decoder())
        use first_day <- decode.field(1, decode.int)
        decode.success(#(player_id, first_day))
      },
    ),
  )
  use later <- result.try(
    store.query(
      read,
      "SELECT player_id, due_at FROM review_later WHERE org_id = ? AND due_at > ?",
      [id.org_sql(org.id), sqlight.int(now)],
      {
        use player_id <- decode.field(0, id.player_decoder())
        use due_at <- decode.field(1, decode.int)
        decode.success(#(player_id, due_at))
      },
    ),
  )
  let later = dict.from_list(later)
  use seen <- result.try(players.for_org_many(
    read,
    list.map(first_seen, fn(s) { s.0 }),
    org,
    now,
  ))
  let first_day = dict.from_list(first_seen)
  let items =
    list.filter_map(seen, fn(found) {
      let #(p, access) = found
      use view <- result.try(
        players.org_view(p, org, access, now) |> option.to_result(Nil),
      )
      let deferred_until = dict.get(later, p.row.id) |> option.from_result
      let assert Ok(day) = dict.get(first_day, p.row.id)
      Ok(#(
        deferred_until,
        json.object([
          #("player", view),
          #("firstSeenDaysAgo", json.int(today - day)),
          #("deferredUntil", json.nullable(deferred_until, json.int)),
          #("staleAssessment", json.null()),
        ]),
      ))
    })
  let #(deferred, queue) = list.partition(items, fn(i) { i.0 != None })
  use stale <- result.map(stale_evaluations(read, a, now))
  #(list.map(queue, fn(i) { i.1 }), list.map(deferred, fn(i) { i.1 }), stale)
}

/// Players whose latest submitted assessment from this club is over 180 days old, in the order their first such
/// assessment was written.
fn stale_evaluations(
  read: Read,
  a: OrgAccess,
  now: Int,
) -> Result(List(Json), Fail(e)) {
  let cut = now - stale_days * day_ms
  use stale <- result.try(
    store.query(
      read,
      "SELECT player_id, MAX(created_at) FROM assessments
     WHERE org_id = ? AND state <> 'draft' AND created_at < ?
       AND player_id NOT IN (SELECT player_id FROM assessments WHERE org_id = ? AND state <> 'draft' AND created_at >= ?)
     GROUP BY player_id ORDER BY MIN(rowid)",
      [
        id.org_sql(a.org.id),
        sqlight.int(cut),
        id.org_sql(a.org.id),
        sqlight.int(cut),
      ],
      {
        use player_id <- decode.field(0, id.player_decoder())
        use last <- decode.field(1, decode.int)
        decode.success(#(player_id, last))
      },
    ),
  )
  use seen <- result.map(players.for_org_many(
    read,
    list.map(stale, fn(s) { s.0 }),
    a.org,
    now,
  ))
  let last = dict.from_list(stale)
  list.filter_map(seen, fn(found) {
    let #(p, access) = found
    case access.visible && !access.blocked {
      False -> Error(Nil)
      True -> {
        let assert Ok(at) = dict.get(last, p.row.id)
        Ok(stale_item(p.row.id, Some(p.row.name), at))
      }
    }
  })
}

fn stale_item(player_id: id.PlayerId, name: Option(String), at: Int) -> Json {
  json.object([
    #("playerId", id.player_json(player_id)),
    #("playerName", json.nullable(name, json.string)),
    #("lastAssessedAt", json.int(at)),
    #("note", json.string("last assessed over 180 days ago")),
  ])
}

/// How many players sit in the not-yet-assessed queue, deferred ones included: the exposure report's
/// "not yet reviewed".
pub fn not_yet_reviewed(
  read: Read,
  a: OrgAccess,
  now: Int,
) -> Result(Int, Fail(e)) {
  use #(queue, deferred, _) <- result.map(read_queue(read, a, now))
  list.length(queue) + list.length(deferred)
}

const later_min = 1

const later_max = 60

const later_default = 7

fn later_shape() -> input.Shape(Option(Int)) {
  use days <- input.field(
    "days",
    input.nullish(input.whole_number(later_min, later_max)),
  )
  input.done(days)
}

/// `POST /org/review-queue/:playerId/later`: only a player the club can see now can be deferred. Deferring again
/// replaces the earlier deferral.
pub fn defer(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Response {
  use days <- http.body(req, later_shape(), [])
  let days = option.unwrap(days, later_default)
  let now = clock.now_ms()
  let deferred =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(players.for_org(
        store.reading(tx),
        player_id,
        a.org,
        now,
      ))
      case found {
        Some(#(p, access)) if access.visible && !access.blocked -> {
          use _ <- result.try(
            store.run(
              tx,
              "DELETE FROM review_later WHERE org_id = ? AND player_id = ?",
              [id.org_sql(a.org.id), id.player_sql(p.row.id)],
            ),
          )
          use deferral_id <- result.try(id.next_deferral(tx))
          review_later.insert(
            tx,
            review_later.new(
              id: deferral_id,
              org_id: a.org.id,
              player_id: p.row.id,
              by_user_id: a.user.id,
              due_at: now + days * day_ms,
            ),
          )
          |> result.replace(True)
        }
        _ -> Ok(False)
      }
    })
  case deferred {
    Ok(True) -> http.json(200, json.object([#("deferredDays", json.int(days))]))
    Ok(False) -> http.error(403, "NOT_VISIBLE")
    Error(e) -> http.internal(e)
  }
}
