//// Exposure insight (domains/insight/insight.mjs): the players a club's searches rendered, the funnel from
//// impression to outcome, a deterministic weekly discovery rotation, the coarse counts a player sees about
//// themselves, and the decision review. No inference of protected characteristics, no public rankings, nothing
//// pays its way in, and small aggregates are suppressed. Every count carries its window and denominators instead of
//// a claim about discrimination.
////
//// Not ported yet: the insight sweep (review-later reminders, and deleting exposure events older than the window).

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/players
import scoutbox/insight/review_queue
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/id
import scoutbox/rules/visibility
import scoutbox/scouting/assessments
import sqlight
import wisp.{type Request, type Response}

const window_days = 90

const day_ms = 86_400_000

const impressions_max = 50

/// Fewer assessed players than this and the birth-quarter distribution is withheld (routeHelpers.mjs `suppress`).
const suppress_min = 3

const rotation_size = 6

fn impressions_shape() -> input.Shape(List(String)) {
  use ids <- input.field(
    "playerIds",
    input.required(input.items_between(input.id(), 0, impressions_max)),
  )
  input.done(ids)
}

/// `POST /org/exposure/impressions`: the players a search actually rendered. One this club cannot see is skipped,
/// never refused: a refusal would say who is hidden.
pub fn impressions(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use player_ids <- http.body(req, impressions_shape(), [])
  let now = clock.now_ms()
  let recorded =
    store.unit(ctx.store, fn(tx) {
      list.try_fold(player_ids, 0, fn(n, pid) {
        use found <- result.try(players.for_org(
          store.reading(tx),
          id.player(pid),
          a.org,
          now,
        ))
        case found {
          Some(#(p, access)) if access.visible && !access.blocked -> {
            use fresh <- result.map(review_queue.record(
              tx,
              a.org.id,
              p.row.id,
              review_queue.Impression,
              now,
            ))
            case fresh {
              True -> n + 1
              False -> n
            }
          }
          _ -> Ok(n)
        }
      })
    })
  case recorded {
    Ok(n) -> http.json(200, json.object([#("recorded", json.int(n))]))
    Error(e) -> http.internal(e)
  }
}

/// `GET /org/exposure/report`: lead-only.
pub fn report(ctx: Ctx, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let now = clock.now_ms()
  case store.read(ctx.store, read_report(_, a, now)) {
    Ok(body) -> http.json(200, body)
    Error(e) -> http.internal(e)
  }
}

fn read_report(read: Read, a: OrgAccess, now: Int) -> Result(Json, Fail(e)) {
  let org_id = id.org_sql(a.org.id)
  let since_day = now / day_ms - window_days
  let since = now - window_days * day_ms
  use seen <- result.try(
    store.query(
      read,
      "SELECT kind, COUNT(DISTINCT player_id) FROM exposure_events WHERE org_id = ? AND day_index >= ? GROUP BY kind",
      [org_id, sqlight.int(since_day)],
      {
        use kind <- decode.field(0, decode.string)
        use n <- decode.field(1, decode.int)
        decode.success(#(kind, n))
      },
    ),
  )
  let seen = fn(kind) { list.key_find(seen, kind) |> result.unwrap(0) }
  let count = fn(sql, args) {
    store.one(read, sql, args, decode.at([0], decode.int))
    |> result.map(result.unwrap(_, 0))
  }
  use invited <- result.try(
    count(
      "SELECT COUNT(DISTINCT player_id) FROM recruitment_requests WHERE org_id = ? AND created_at >= ?",
      [org_id, sqlight.int(since)],
    ),
  )
  use outcomes <- result.try(
    count(
      "SELECT COUNT(DISTINCT player_id) FROM signings WHERE org_id = ? AND ts >= ?",
      [org_id, sqlight.int(since)],
    ),
  )
  // Every submitted assessment in the window counts towards the total; one whose player has no readable birth
  // date counts in no quarter.
  use births <- result.try(store.query(
    read,
    "SELECT p.birth_date FROM assessments a LEFT JOIN players p ON p.id = a.player_id AND p.deleted_at IS NULL
     WHERE a.org_id = ? AND a.state <> 'draft' AND a.created_at >= ? ORDER BY a.rowid",
    [org_id, sqlight.int(since)],
    decode.at([0], decode.optional(decode.string)),
  ))
  use not_yet_reviewed <- result.map(review_queue.not_yet_reviewed(read, a, now))
  let impressions = seen("impression")
  let profiles = seen("profile_view")
  let evidence = seen("evidence_view")
  let stage = fn(key, players, of) {
    json.object([
      #("key", json.string(key)),
      #("players", json.int(players)),
      ..case of {
        Some(n) -> [#("of", json.int(n))]
        None -> []
      }
    ])
  }
  let total = list.length(births)
  json.object([
    #(
      "funnel",
      json.object([
        #("windowDays", json.int(window_days)),
        #(
          "definition",
          json.string(
            "Unique players per stage within the window; events deduplicated per (player, kind, day). Denominator for each rate is the previous stage.",
          ),
        ),
        #(
          "stages",
          json.preprocessed_array([
            stage("eligible_impression", impressions, None),
            stage("profile_review", profiles, Some(impressions)),
            stage("evidence_review", evidence, Some(profiles)),
            stage("invitation", invited, Some(evidence)),
            stage("outcome", outcomes, Some(invited)),
          ]),
        ),
      ]),
    ),
    #("birthQuarter", case total < suppress_min {
      True ->
        json.object([
          #("suppressed", json.bool(True)),
          #(
            "note",
            json.string(
              "Fewer than 3 assessed players in the window — the distribution is withheld to protect individuals.",
            ),
          ),
        ])
      False -> {
        let quarters = list.filter_map(births, quarter)
        let in = fn(q) { list.count(quarters, fn(x) { x == q }) }
        json.object([
          #("total", json.int(total)),
          #(
            "quarters",
            json.object([
              #("Q1", json.int(in(1))),
              #("Q2", json.int(in(2))),
              #("Q3", json.int(in(3))),
              #("Q4", json.int(in(4))),
            ]),
          ),
          #(
            "note",
            json.string(
              "Distribution of assessed players by birth quarter (relative-age lens). An aggregate pattern is a prompt to look again — it does not prove discrimination, and nothing here infers ethnicity, socioeconomic status, disability or biological maturity.",
            ),
          ),
        ])
      }
    }),
    #(
      "absentEvidence",
      json.object([
        #(
          "note",
          json.string(
            "Players with NO evidence reviewed are counted as “not yet reviewed”, never as poor performers.",
          ),
        ),
        #("notYetReviewed", json.int(not_yet_reviewed)),
      ]),
    ),
  ])
}

/// The quarter of a birth date's calendar month, when it is a real day.
fn quarter(birth: option.Option(String)) -> Result(Int, Nil) {
  use day <- result.try(option.to_result(birth, Nil))
  use day <- result.try(temporal.date_only(day) |> result.replace_error(Nil))
  use month <- result.map(int.parse(string.slice(day, 5, 2)))
  { month - 1 } / 3 + 1
}

/// `GET /org/discovery-rotation`: a deterministic weekly slice of the players this club can see and has not
/// assessed. Visibility comes first, so an ineligible player can never enter through the rotation.
pub fn rotation(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let week = now / day_ms / 7
  let found =
    store.read(ctx.store, fn(read) {
      let query =
        sql.concat([
          sql.text("SELECT p.id FROM players p WHERE p.deleted_at IS NULL AND "),
          visibility.can_see_sql(a.org, now),
          sql.text(
            " AND p.id NOT IN (SELECT player_id FROM assessments WHERE org_id = ",
          ),
          sql.arg(id.org_sql(a.org.id)),
          sql.text(" AND state <> 'draft') ORDER BY p.rowid"),
        ])
      use ids <- result.try(store.query(
        read,
        query.sql,
        query.args,
        decode.at([0], decode.string),
      ))
      // The six with the smallest weekly hash byte win; ties keep creation order.
      let org = id.org_to_string(a.org.id)
      let best =
        ids
        |> list.index_map(fn(pid, i) { #(weekly_byte(pid, org, week), i, pid) })
        |> list.sort(fn(x, y) {
          case int.compare(x.0, y.0) {
            order.Eq -> int.compare(x.1, y.1)
            other -> other
          }
        })
        |> list.take(rotation_size)
        |> list.map(fn(b) { id.player(b.2) })
      players.for_org_many(read, best, a.org, now)
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(found) ->
      http.json(
        200,
        json.object([
          #("week", json.int(week)),
          #(
            "items",
            json.preprocessed_array(
              list.filter_map(found, fn(f) {
                let #(p, access) = f
                case access.visible && !access.blocked {
                  True ->
                    players.org_view(p, a.org, access, now)
                    |> option.to_result(Nil)
                  False -> Error(Nil)
                }
              }),
            ),
          ),
          #(
            "note",
            json.string(
              "A rotating slice of eligible players you have not assessed — same pool as search, different order each week. Rotation never includes anyone outside your standing visibility rules, and nothing can pay its way in.",
            ),
          ),
        ]),
      )
  }
}

fn weekly_byte(player_id: String, org_id: String, week: Int) -> Int {
  let digest =
    crypto.hash(
      crypto.Sha256,
      bit_array.from_string(
        player_id <> ":" <> org_id <> ":" <> int.to_string(week),
      ),
    )
  case digest {
    <<first, _:bits>> -> first
    _ -> 0
  }
}

/// `GET /player/exposure`: coarse counts only, and never which club looked.
pub fn player_view(ctx: Ctx, me: PlayerAccess) -> Response {
  let now = clock.now_ms()
  let player_id = id.player_sql(me.player.row.id)
  let since_day = sqlight.int(now / day_ms - window_days)
  let found =
    store.read(ctx.store, fn(read) {
      use by_kind <- result.try(
        store.query(
          read,
          "SELECT kind, COUNT(*) FROM exposure_events WHERE player_id = ? AND day_index >= ? GROUP BY kind",
          [player_id, since_day],
          {
            use kind <- decode.field(0, decode.string)
            use n <- decode.field(1, decode.int)
            decode.success(#(kind, n))
          },
        ),
      )
      use clubs <- result.map(store.one(
        read,
        "SELECT COUNT(DISTINCT org_id) FROM exposure_events WHERE player_id = ? AND day_index >= ?",
        [player_id, since_day],
        decode.at([0], decode.int),
      ))
      #(by_kind, result.unwrap(clubs, 0))
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(#(by_kind, clubs)) -> {
      let of = fn(kind) { list.key_find(by_kind, kind) |> result.unwrap(0) }
      http.json(
        200,
        json.object([
          #("windowDays", json.int(window_days)),
          #("appearedInSearches", json.string(band(of("impression")))),
          #("profileViews", json.string(band(of("profile_view")))),
          #("clubs", json.string(band(clubs))),
          #(
            "note",
            json.string(
              "Coarse ranges over the last 90 days. Which club looked is not shown — interest becomes visible when a club actually contacts you through the proper channel.",
            ),
          ),
        ]),
      )
    }
  }
}

fn band(n: Int) -> String {
  case n {
    0 -> "0"
    _ if n <= 5 -> "1–5"
    _ if n <= 20 -> "6–20"
    _ -> "20+"
  }
}

const decision_review_max = 50

/// `GET /org/decision-review`: lead-only. The club's last 50 submitted recommendations next to what happened since,
/// with the causal disclaimer in the payload.
pub fn decision_review(ctx: Ctx, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> assessment_row.qualified("a")
          <> ", EXISTS (SELECT 1 FROM signings s WHERE s.player_id = a.player_id AND s.ts > a.created_at),
          (SELECT COUNT(*) FROM assessments x WHERE x.org_id = a.org_id AND x.state <> 'draft'
             AND x.player_id = a.player_id AND x.created_at > a.created_at)
         FROM assessments a WHERE a.org_id = ? AND a.state <> 'draft' AND a.recommendation_verdict IS NOT NULL
         ORDER BY a.rowid",
        [id.org_sql(a.org.id)],
        {
          use r <- decode.then(assessment_row.decoder())
          use signed <- decode.field(
            assessment_row.width,
            sqlight.decode_bool(),
          )
          use further <- decode.field(assessment_row.width + 1, decode.int)
          decode.success(#(r, signed, further))
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let rows = list.drop(rows, list.length(rows) - decision_review_max)
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(rows, fn(x) {
              let #(r, signed, further) = x
              json.object([
                #("assessmentId", id.assessment_json(r.id)),
                #("playerName", json.nullable(r.player_name, json.string)),
                #("scoutName", json.string(r.scout_name)),
                #("recommendation", assessments.recommendation_json(r)),
                #("at", json.int(r.created_at)),
                #(
                  "since",
                  json.object([
                    #("signedSomewhere", json.bool(signed)),
                    #("furtherAssessments", json.int(further)),
                  ]),
                ),
              ])
            }),
          ),
          #(
            "disclaimer",
            json.string(
              "What happened after a recommendation reflects hundreds of factors. This view supports reflective review of evidence quality — it does not measure whether a scout “caused” an outcome, and it is never published or ranked.",
            ),
          ),
        ]),
      )
    }
  }
}
