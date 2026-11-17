//// Missing-evidence suggestions (domains/insight/insight.mjs): deterministic rules over a player's records, each
//// citing the records behind it, kept per organisation and player in `evidence_suggestions`. A club asks for the
//// missing evidence through `request`, the one path that turns a gap into a player-facing ask (the Recruitment Room
//// uses it too), with its anti-pestering window and guardian routing.
////
//// Not ported yet: `attribute_never_observed` and `assessment_disagreement`, which read an assessment's ratings and
//// rubric (the scouting assessments domain).

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/evidence_suggestions as row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/vocab/audience
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

const rules_version = 1

const stale_days = 180

const day_ms = 86_400_000

const records_max = 200

const explanation_max = 1000

pub type Suggestion {
  Suggestion(row: row.Row, records: List(String))
}

/// A rule's hit: the records it cites and why.
type Hit {
  Hit(rule: row.RuleId, records: List(String), explanation: String)
}

pub fn action(rule: row.RuleId) -> String {
  case rule {
    row.NoRecentFootage -> "Ask for a recent clip (through the proper channel)."
    row.SingleMatchSample ->
      "Request footage from a second match before concluding anything."
    row.AttributeNeverObserved ->
      "Plan an observation that covers the unobserved attribute."
    row.AssessmentDisagreement ->
      "A third independent observation would resolve the split."
    row.StaleAssessment ->
      "Schedule a re-observation — the picture is out of date."
    row.UncorroboratedClaims ->
      "Ask a coach or run a club assessment to corroborate the claim."
  }
}

/// The player-visible wording, whitelisted per rule: it refers to the player's own records only, so no club-private
/// observation travels.
fn player_safe_text(rule: row.RuleId) -> String {
  case rule {
    row.NoRecentFootage ->
      "a recent clip would help (the current footage is older than 6 months)."
    row.SingleMatchSample ->
      "a clip from a second match would give a fuller picture."
    row.AttributeNeverObserved ->
      "footage covering more aspects of your game would help."
    row.AssessmentDisagreement ->
      "another opportunity to watch you play would help their review."
    row.StaleAssessment -> "they would like a more recent look at your game."
    row.UncorroboratedClaims ->
      "a coach confirmation on your evidence passport would strengthen it."
  }
}

/// `new Date(uploadedAt).getTime()`, for the forms a clip's upload instant is stored in.
fn uploaded_ms(text: Option(String)) -> Option(Int) {
  case text {
    None -> Some(0)
    Some(t) ->
      case temporal.instant_ms(t), temporal.day_start_ms(t) {
        Ok(ms), _ -> Some(ms)
        _, Ok(ms) -> Some(ms)
        _, _ -> None
      }
  }
}

fn rule_hits(
  read: Read,
  org: orgs.Row,
  p: Player,
  now: Int,
) -> Result(List(Hit), Fail(e)) {
  let media = p.media
  let ids = list.map(media, fn(m) { id.media_to_string(m.clip.id) })
  let n = list.length(media)
  let fresh =
    list.filter(media, fn(m) {
      case uploaded_ms(m.clip.uploaded_at) {
        Some(ms) -> ms > now - stale_days * day_ms
        None -> False
      }
    })
  let footage = case n > 0 && fresh != [] {
    True -> None
    False ->
      Some(
        Hit(row.NoRecentFootage, ids, case n {
          0 -> "No footage on the profile yet."
          _ ->
            "All "
            <> int.to_string(n)
            <> " clips are older than "
            <> int.to_string(stale_days)
            <> " days."
        }),
      )
  }
  let verified =
    list.filter_map(media, fn(m) {
      option.to_result(m.clip.verified_clip_attendance_id, Nil)
    })
  let all_verified = list.length(verified) == n
  let single = case n {
    0 -> None
    1 ->
      Some(Hit(
        row.SingleMatchSample,
        ids,
        "Only one clip available — a single viewing context.",
      ))
    _ ->
      case all_verified && list.length(list.unique(verified)) <= 1 {
        True ->
          Some(Hit(
            row.SingleMatchSample,
            ids,
            "Every clip is linked to the same verified fixture — one match is a thin sample.",
          ))
        False -> None
      }
  }
  use submitted <- result.map(
    store.query(
      read,
      "SELECT id, created_at FROM assessments WHERE org_id = ? AND player_id = ? AND state <> 'draft' ORDER BY rowid",
      [id.org_sql(org.id), id.player_sql(p.row.id)],
      {
        use a <- decode.field(0, decode.string)
        use at <- decode.field(1, decode.int)
        decode.success(#(a, at))
      },
    ),
  )
  let stale = case submitted {
    [] -> None
    _ -> {
      let latest = list.fold(submitted, 0, fn(m, a) { int.max(m, a.1) })
      case latest > now - stale_days * day_ms {
        True -> None
        False ->
          Some(Hit(
            row.StaleAssessment,
            list.map(submitted, fn(a) { a.0 }),
            "The most recent submitted assessment is over "
              <> int.to_string(stale_days)
              <> " days old.",
          ))
      }
    }
  }
  // `uncorroborated_claims` looks for evidence records whose `tier` is self-reported, but a record's tier is its
  // `verification.status`, so the TypeScript rule never fires; this keeps that behaviour.
  option.values([footage, single, stale])
}

/// Bounds a hit to what the store holds, so a player with hundreds of clips does not fail the read.
fn bound(h: Hit) -> Hit {
  let explanation = case input.utf16_length(h.explanation) > explanation_max {
    True -> input.utf16_take(h.explanation, explanation_max - 1) <> "…"
    False -> h.explanation
  }
  Hit(
    ..h,
    records: h.records |> list.unique |> list.take(records_max),
    explanation:,
  )
}

fn with_records(read: Read, r: row.Row) -> Result(Suggestion, Fail(e)) {
  use records <- result.map(store.query(
    read,
    "SELECT record_id FROM evidence_suggestion_records WHERE suggestion_id = ? ORDER BY ord",
    [id.evidence_suggestion_sql(r.id)],
    decode.at([0], decode.string),
  ))
  Suggestion(r, records)
}

pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Suggestion), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM evidence_suggestions WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(org_id), id.player_sql(player_id)],
    row.decoder(),
  ))
  list.try_map(rows, with_records(read, _))
}

fn write_records(
  tx: Tx,
  suggestion_id: id.EvidenceSuggestionId,
  records: List(String),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM evidence_suggestion_records WHERE suggestion_id = ?",
      [id.evidence_suggestion_sql(suggestion_id)],
    ),
  )
  list.index_map(records, fn(r, i) { #(r, i) })
  |> list.try_each(fn(p) {
    store.run(
      tx,
      "INSERT INTO evidence_suggestion_records (suggestion_id, ord, record_id) VALUES (?, ?, ?)",
      [
        id.evidence_suggestion_sql(suggestion_id),
        sqlight.int(p.1),
        sqlight.text(p.0),
      ],
    )
  })
}

fn is_open(s: Suggestion) -> Bool {
  s.row.status == row.Suggested || s.row.status == row.Requested
}

/// Runs the rules and reconciles the stored suggestions with them: an open one that no longer fires is `supplied`,
/// a new hit is `suggested`, and an open one is rewritten only when its records or explanation changed.
pub fn compute(
  tx: Tx,
  org: orgs.Row,
  p: Player,
  now: Int,
) -> Result(List(Suggestion), Fail(e)) {
  let read = store.reading(tx)
  use hits <- result.try(rule_hits(read, org, p, now))
  let hits = list.map(hits, bound)
  use existing <- result.try(for_org_player(read, org.id, p.row.id))
  let open = list.filter(existing, is_open)
  use _ <- result.try(
    list.try_each(open, fn(s) {
      case list.find(hits, fn(h) { h.rule == s.row.rule_id }) {
        Error(_) ->
          store.run(
            tx,
            "UPDATE evidence_suggestions SET status = 'supplied', updated_at = ? WHERE id = ?",
            [sqlight.int(now), id.evidence_suggestion_sql(s.row.id)],
          )
        Ok(h) if h.records == s.records && h.explanation == s.row.explanation ->
          Ok(Nil)
        Ok(h) -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE evidence_suggestions SET explanation = ?, updated_at = ? WHERE id = ?",
              [
                sqlight.text(h.explanation),
                sqlight.int(now),
                id.evidence_suggestion_sql(s.row.id),
              ],
            ),
          )
          write_records(tx, s.row.id, h.records)
        }
      }
    }),
  )
  use _ <- result.try(
    list.try_each(hits, fn(h) {
      case list.any(open, fn(s) { s.row.rule_id == h.rule }) {
        True -> Ok(Nil)
        False -> {
          use suggestion_id <- result.try(id.next_evidence_suggestion(tx))
          use _ <- result.try(row.insert(
            tx,
            row.Row(
              id: suggestion_id,
              org_id: org.id,
              player_id: p.row.id,
              player_name: Some(p.row.name),
              rule_id: h.rule,
              rule_version: rules_version,
              explanation: h.explanation,
              status: row.Suggested,
              requested_at: None,
              created_at: now,
              updated_at: now,
            ),
          ))
          write_records(tx, suggestion_id, h.records)
        }
      }
    }),
  )
  for_org_player(read, org.id, p.row.id)
}

pub fn view(s: Suggestion) -> Json {
  json.object([
    #("id", id.evidence_suggestion_json(s.row.id)),
    #("orgId", id.org_json(s.row.org_id)),
    #("playerId", id.player_json(s.row.player_id)),
    #("playerName", json.nullable(s.row.player_name, json.string)),
    #("ruleId", row.rule_id_to_json(s.row.rule_id)),
    #("ruleVersion", json.int(s.row.rule_version)),
    #("records", json.array(s.records, json.string)),
    #("explanation", json.string(s.row.explanation)),
    #("action", json.string(action(s.row.rule_id))),
    #("status", row.status_to_json(s.row.status)),
    #("requestedAt", json.nullable(s.row.requested_at, json.int)),
    #("createdAt", json.int(s.row.created_at)),
    #("updatedAt", json.int(s.row.updated_at)),
  ])
}

/// `GET /org/players/:id/evidence-gaps`. The read reconciles the stored suggestions, so it runs in a unit.
pub fn gaps(ctx: Ctx, a: OrgAccess, player_id: id.PlayerId) -> Response {
  let now = clock.now_ms()
  let found =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(players.for_org(
        store.reading(tx),
        player_id,
        a.org,
        now,
      ))
      case found {
        Some(#(p, access)) if access.visible && !access.blocked ->
          compute(tx, a.org, p, now) |> result.map(Some)
        _ -> Ok(None)
      }
    })
  case found {
    Ok(None) -> http.error(403, "NOT_VISIBLE")
    Ok(Some(suggestions)) ->
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(
              list.sort(suggestions, fn(x, y) {
                int.compare(y.row.updated_at, x.row.updated_at)
              }),
              view,
            ),
          ),
          #(
            "engine",
            json.object([
              #("kind", json.string("deterministic rules")),
              #("version", json.int(rules_version)),
              #(
                "rules",
                json.array(row.rule_id_pairs, fn(p) { json.string(p.0) }),
              ),
              #(
                "note",
                json.string(
                  "Every suggestion cites its rule and the records behind it. No AI generation is involved.",
                ),
              ),
            ]),
          ),
        ]),
      )
    Error(e) -> http.internal(e)
  }
}

pub type RequestRefusal {
  SuggestionNotFound
  NotOpen(row.Status)
  NotVisible
  RecentlyRequested
}

pub fn refusal_response(r: RequestRefusal) -> Response {
  case r {
    SuggestionNotFound -> http.error(404, "SUGGESTION_NOT_FOUND")
    NotOpen(status) ->
      http.json(
        409,
        json.object([
          #("error", json.string("NOT_OPEN")),
          #("status", row.status_to_json(status)),
        ]),
      )
    NotVisible -> http.error(403, "NOT_VISIBLE")
    RecentlyRequested ->
      http.error_message(
        429,
        "RECENTLY_REQUESTED",
        "You asked for this within the last 14 days — give them time.",
      )
  }
}

/// Asks the player (or a minor's guardian) for the evidence a suggestion names, inside the caller's unit. From a
/// Room, the suggestion must be about that room's player; any other reads as not found.
pub fn request(
  tx: Tx,
  org: orgs.Row,
  suggestion_id: id.EvidenceSuggestionId,
  player_id: Option(id.PlayerId),
  now: Int,
) -> Result(Result(#(Suggestion, party.Party), RequestRefusal), Fail(e)) {
  let read = store.reading(tx)
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM evidence_suggestions WHERE id = ? AND org_id = ?",
    [id.evidence_suggestion_sql(suggestion_id), id.org_sql(org.id)],
    row.decoder(),
  ))
  let found = case rows, player_id {
    [r], Some(pid) if r.player_id != pid -> None
    [r], _ -> Some(r)
    _, _ -> None
  }
  case found {
    None -> Ok(Error(SuggestionNotFound))
    Some(s) if s.status != row.Suggested -> Ok(Error(NotOpen(s.status)))
    Some(s) -> {
      use seen <- result.try(players.for_org(read, s.player_id, org, now))
      case seen {
        Some(#(p, access)) if access.visible && !access.blocked -> {
          // Anti-pestering: none within 14 days of the last request for the same player and rule.
          use recent <- result.try(store.query(
            read,
            "SELECT id FROM evidence_suggestions WHERE org_id = ? AND player_id = ? AND rule_id = ? AND requested_at > ? AND id <> ? LIMIT 1",
            [
              id.org_sql(org.id),
              id.player_sql(s.player_id),
              sqlight.text(row.rule_id_to_string(s.rule_id)),
              sqlight.int(now - 14 * day_ms),
              id.evidence_suggestion_sql(s.id),
            ],
            decode.at([0], decode.string),
          ))
          case recent {
            [_, ..] -> Ok(Error(RecentlyRequested))
            [] -> {
              let #(to, to_id, who) = case
                players.is_adult(p, now),
                p.row.guardian_id
              {
                False, Some(g) -> #(
                  audience.Guardian,
                  id.guardian_to_string(g),
                  p.row.name <> "'s profile",
                )
                _, _ -> #(
                  audience.Player,
                  id.player_to_string(p.row.id),
                  "your profile",
                )
              }
              use _ <- result.try(
                store.run(
                  tx,
                  "UPDATE evidence_suggestions SET status = 'requested', requested_at = ?, updated_at = ? WHERE id = ?",
                  [
                    sqlight.int(now),
                    sqlight.int(now),
                    id.evidence_suggestion_sql(s.id),
                  ],
                ),
              )
              use _ <- result.try(notifications.notify(
                tx,
                to: to,
                id: to_id,
                type_: "evidence_request",
                text: "📎 "
                  <> org.name
                  <> " would find "
                  <> who
                  <> " easier to assess with more evidence: "
                  <> player_safe_text(s.rule_id)
                  <> " You choose what (and whether) to add.",
                ref_id: Some(id.evidence_suggestion_to_string(s.id)),
                at: now,
              ))
              use fresh <- result.map(with_records(
                read,
                row.Row(
                  ..s,
                  status: row.Requested,
                  requested_at: Some(now),
                  updated_at: now,
                ),
              ))
              Ok(
                #(fresh, case to {
                  audience.Guardian -> party.Guardian
                  _ -> party.Player
                }),
              )
            }
          }
        }
        _ -> Ok(Error(NotVisible))
      }
    }
  }
}

/// The players with a suggestion in `status` for the organisation.
pub fn players_with_status(
  read: Read,
  org_id: id.OrgId,
  status: row.Status,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT DISTINCT player_id FROM evidence_suggestions WHERE org_id = ? AND status = ?",
    [id.org_sql(org_id), sqlight.text(row.status_to_string(status))],
    decode.at([0], id.player_decoder()),
  )
}

/// `POST /org/evidence-gaps/:id/request`.
pub fn request_route(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  suggestion_id: id.EvidenceSuggestionId,
) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let out =
    store.unit(ctx.store, fn(tx) {
      request(tx, a.org, suggestion_id, None, now)
    })
  case out {
    Ok(Ok(#(s, _))) -> http.json(200, json.object([#("suggestion", view(s))]))
    Ok(Error(refusal)) -> refusal_response(refusal)
    Error(e) -> http.internal(e)
  }
}

/// `POST /org/evidence-gaps/:id/dismiss` and `…/reviewed`: a gap is marked reviewed only once it shows as
/// supplied.
pub fn set_status_route(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  suggestion_id: id.EvidenceSuggestionId,
  status: row.Status,
) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let out =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(store.one(
        read,
        "SELECT "
          <> row.columns
          <> " FROM evidence_suggestions WHERE id = ? AND org_id = ?",
        [id.evidence_suggestion_sql(suggestion_id), id.org_sql(a.org.id)],
        row.decoder(),
      ))
      case found {
        Error(Nil) -> Ok(http.error(404, "SUGGESTION_NOT_FOUND"))
        Ok(s) if status == row.Reviewed && s.status != row.Supplied ->
          Ok(http.error_message(
            409,
            "NOT_SUPPLIED",
            "Mark reviewed once the gap shows as supplied.",
          ))
        Ok(s) -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE evidence_suggestions SET status = ?, updated_at = ? WHERE id = ?",
              [
                sqlight.text(row.status_to_string(status)),
                sqlight.int(now),
                id.evidence_suggestion_sql(s.id),
              ],
            ),
          )
          use fresh <- result.map(with_records(
            read,
            row.Row(..s, status:, updated_at: now),
          ))
          http.json(200, json.object([#("suggestion", view(fresh))]))
        }
      }
    })
  case out {
    Ok(response) -> response
    Error(e) -> http.internal(e)
  }
}
