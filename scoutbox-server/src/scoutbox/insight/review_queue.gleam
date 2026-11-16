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
import scoutbox/platform/store.{type Fail, type Read}
import sqlight
import wisp.{type Response}

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
  org_id: String,
  player_id: String,
  kind: Kind,
) -> Nil {
  let at = clock.now_ms()
  let _ =
    store.unit(ctx.store, fn(tx) {
      use seen <- result.try(store.query(
        store.reading(tx),
        "SELECT 1 FROM exposure_events WHERE org_id = ? AND player_id = ? AND kind = ? AND day_index = ?",
        [
          sqlight.text(org_id),
          sqlight.text(player_id),
          sqlight.text(kind_text(kind)),
          sqlight.int(at / day_ms),
        ],
        decode.success(Nil),
      ))
      case seen {
        [_] -> Ok(#(Nil, []))
        _ -> {
          use id <- result.try(ids.next(tx, "exp"))
          use _ <- result.map(
            store.run(
              tx,
              "INSERT INTO exposure_events (id, org_id, player_id, kind, day_index, at) VALUES (?, ?, ?, ?, ?, ?)",
              [
                sqlight.text(id),
                sqlight.text(org_id),
                sqlight.text(player_id),
                sqlight.text(kind_text(kind)),
                sqlight.int(at / day_ms),
                sqlight.int(at),
              ],
            ),
          )
          #(Nil, [])
        }
      }
    })
  Nil
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
        sqlight.text(org.id),
        sqlight.int(today - window_days),
        sqlight.text(org.id),
      ],
      {
        use player_id <- decode.field(0, decode.string)
        use first_day <- decode.field(1, decode.int)
        decode.success(#(player_id, first_day))
      },
    ),
  )
  use later <- result.try(
    store.query(
      read,
      "SELECT player_id, due_at FROM review_later WHERE org_id = ? AND due_at > ?",
      [sqlight.text(org.id), sqlight.int(now)],
      {
        use player_id <- decode.field(0, decode.string)
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
        sqlight.text(a.org.id),
        sqlight.int(cut),
        sqlight.text(a.org.id),
        sqlight.int(cut),
      ],
      {
        use player_id <- decode.field(0, decode.string)
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

fn stale_item(player_id: String, name: Option(String), at: Int) -> Json {
  json.object([
    #("playerId", json.string(player_id)),
    #("playerName", json.nullable(name, json.string)),
    #("lastAssessedAt", json.int(at)),
    #("note", json.string("last assessed over 180 days ago")),
  ])
}
