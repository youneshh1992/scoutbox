//// Recruitment Briefs and Nobody Missed (domains/discovery/nobodyMissed.mjs): which eligible players match the
//// club's own criteria but never entered its evaluation workflow. Nothing is scored or ranked: every candidate is
//// a list of plain facts, each saying which criterion it meets.
////
//// Hidden players never enter the candidate set. Every query starts from the players the organisation may see
//// (identity's visibility rule and the blocks, in SQL), then applies the brief, then the evaluation history, so a
//// player is never matched and then concealed: concealment after matching is how side channels are born.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/discovery/briefs.{type Brief}
import scoutbox/discovery/matching/engine
import scoutbox/discovery/matching/query
import scoutbox/discovery/second_look
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/keyset.{Asc, OrderKey}
import scoutbox/platform/limits
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/rev
import scoutbox/platform/sql.{type Fragment}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/room_routes
import scoutbox/rows/id
import scoutbox/rows/nobody_missed_review_history as review_history_row
import scoutbox/rows/nobody_missed_reviews as review_row
import scoutbox/rows/recruitment_brief_history as brief_history_row
import scoutbox/rules/visibility
import scoutbox/vocab/brief_status

import scoutbox/vocab/position
import scoutbox/vocab/review_state
import scoutbox/vocab/source_context
import scoutbox/vocab/trust_band.{type TrustBand}
import sqlight
import wisp.{type Request, type Response}

const day_ms = 86_400_000

/// Small groups are suppressed, as elsewhere on the platform.
const suppress_min = 3

/// A recently decided player is not "missed"; Second Look handles them if evidence changes.
const recent_decision_days = 90

const coverage_note =
  "Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias."

pub const sorts = [
  "newest_evidence", "last_reviewed", "name", "distance", "evidence_confidence",
]

const evaluation_signals = [
  #("room_open", "An open Recruitment Room exists"),
  #("room_decided", "A Recruitment Room reached a recorded decision"),
  #("case_open", "An open recruitment case exists"),
  #("assessment_submitted", "A submitted assessment exists"),
  #("trial", "A trial exists"),
  #("signing", "The player was signed"),
  #("shortlisted", "The player was shortlisted"),
  #("review_deferred", "A reviewer explicitly deferred the player"),
  #("squad", "The player is on the squad or shadow squad"),
]

/// Recorded so the exclusion is auditable.
const non_evaluation_signals = [
  #("profile_view", "Opening a profile is not an evaluation."),
  #("search_impression", "Appearing in a result list is not an evaluation."),
  #("passport_view", "Reading a Passport is not an evaluation."),
]

// --------------------------------------------------------------------------------------------------- candidates

/// buildNobodyMissedCandidate: None when the player does not match, or already entered the workflow.
pub fn card(
  f: engine.Facts,
  brief_id: id.BriefId,
  brief_version: Int,
  matched: #(Bool, List(engine.Reason)),
  evaluated: Bool,
  room_open: Bool,
) -> Option(List(#(String, Json))) {
  case matched.0 && !room_open && !evaluated {
    False -> None
    True ->
      Some([
        #("playerId", id.player_json(f.player_id)),
        #("briefId", id.brief_json(brief_id)),
        #("briefVersion", json.int(brief_version)),
        #("policyVersion", json.int(briefs.coverage_policy_version)),
        #("name", json.string(f.name)),
        #("position", json.nullable(f.position, json.string)),
        #("age", json.nullable(f.age, json.int)),
        #("trustBand", json.nullable(f.trust_band, trust_band.to_json)),
        #(
          "trustNote",
          json.string("Evidence confidence — not football ability."),
        ),
        #(
          "reasons",
          json.array(
            list.append(matched.1, [
              engine.Reason(
                "no_room",
                True,
                "No Recruitment Room in your organisation",
              ),
            ]),
            engine.reason_json,
          ),
        ),
        #(
          "note",
          json.string(
            "Eligible under your own criteria and not yet evaluated. This is workflow coverage, not a judgement of the player.",
          ),
        ),
      ])
  }
}

/// isMeaningfullyEvaluated: which evaluation signals hold, and whether a decision is recent. The routes ask the
/// same of the database (`evaluated_sql`); passive impressions are never signals.
pub fn evaluation(
  signals: List(String),
  last_decision_at: Option(Int),
  now: Int,
) -> Json {
  let hits =
    list.filter_map(evaluation_signals, fn(s) {
      case list.contains(signals, s.0) {
        True -> Ok(s.0)
        False -> Error(Nil)
      }
    })
  json.object([
    #("evaluated", json.bool(hits != [])),
    #("signals", json.array(hits, json.string)),
    #(
      "recentlyDecided",
      json.bool(case last_decision_at {
        Some(at) -> now - at < recent_decision_days * day_ms
        None -> False
      }),
    ),
    #("policyVersion", json.int(briefs.coverage_policy_version)),
  ])
}

/// A queue entry, as orderNobodyMissed sorts it.
pub type Orderable {
  Orderable(
    player_id: String,
    name: Option(String),
    distance_km: Option(Float),
    trust_band: Option(TrustBand),
    last_evidence_at: Option(Int),
    reviewed_at: Option(Int),
  )
}

/// orderNobodyMissed, the order the queue's SQL keys implement: none of them is a quality rank. Ties fall back to
/// the player id; an unknown band and an unknown distance sort last.
pub fn order(items: List(Orderable), sort: String) -> List(Orderable) {
  let by = fn(a: Orderable, b: Orderable) {
    case sort {
      "name" ->
        string.compare(option.unwrap(a.name, ""), option.unwrap(b.name, ""))
      "distance" ->
        float.compare(
          option.unwrap(a.distance_km, 1.0e308),
          option.unwrap(b.distance_km, 1.0e308),
        )
      "evidence_confidence" ->
        int.compare(
          option.map(b.trust_band, engine.band_rank) |> option.unwrap(-1),
          option.map(a.trust_band, engine.band_rank) |> option.unwrap(-1),
        )
      "newest_evidence" ->
        int.compare(
          option.unwrap(b.last_evidence_at, 0),
          option.unwrap(a.last_evidence_at, 0),
        )
      "last_reviewed" ->
        int.compare(
          option.unwrap(a.reviewed_at, 0),
          option.unwrap(b.reviewed_at, 0),
        )
      _ -> order.Eq
    }
  }
  list.sort(items, fn(a, b) {
    by(a, b)
    |> order.lazy_break_tie(fn() { string.compare(a.player_id, b.player_id) })
  })
}

/// clampPage: a page size within bounds, or the default. The routes refuse a bad limit instead.
pub fn clamp_page(n: Float, fallback: Int) -> Int {
  case n >. 0.0 {
    True -> int.min(float.truncate(float.floor(n)), 100)
    False -> fallback
  }
}

// ------------------------------------------------------------------------------------------------------ queries

/// The players this organisation has evaluated, as SQL over the signals in `evaluation_signals` (a Room, open or
/// ended, is a case with a room; a deferral counts until it is due). NULLs are filtered out: one NULL in the set
/// would make every NOT IN unknown, and hide every candidate.
fn evaluated_sql(org_id: id.OrgId, at: Int) -> Fragment {
  let o = sql.arg(id.org_sql(org_id))
  sql.concat([
    sql.text(
      "p.id IN (SELECT player_id FROM (SELECT player_id FROM recruitment_cases WHERE org_id = ",
    ),
    o,
    sql.text(
      " AND (room_status IS NOT NULL OR stage <> 'closed') UNION SELECT player_id FROM room_decisions WHERE org_id = ",
    ),
    o,
    sql.text(" UNION SELECT player_id FROM assessments WHERE org_id = "),
    o,
    sql.text(
      " AND state <> 'draft' UNION SELECT player_id FROM trials WHERE org_id = ",
    ),
    o,
    sql.text(" UNION SELECT player_id FROM signings WHERE org_id = "),
    o,
    sql.text(" UNION SELECT player_id FROM ledger WHERE org_id = "),
    o,
    sql.text(
      " AND type = 'shortlist' UNION SELECT player_id FROM review_later WHERE org_id = ",
    ),
    o,
    sql.text(" AND due_at > "),
    sql.arg(sqlight.int(at)),
    sql.text(" UNION SELECT player_id FROM org_squad_members WHERE org_id = "),
    o,
    sql.text(" UNION SELECT player_id FROM org_shadow_players WHERE org_id = "),
    o,
    sql.text(") WHERE player_id IS NOT NULL)"),
  ])
}

/// The players the club already closed for this brief: dismissed, or added to a Room.
fn closed_sql(org_id: id.OrgId, brief_id: id.BriefId) -> Fragment {
  sql.concat([
    sql.text(
      "p.id IN (SELECT player_id FROM nobody_missed_reviews WHERE org_id = ",
    ),
    sql.arg(id.org_sql(org_id)),
    sql.text(" AND brief_id = "),
    sql.arg(id.brief_sql(brief_id)),
    sql.text(
      " AND state IN ('dismissed', 'added_to_room') AND player_id IS NOT NULL)",
    ),
  ])
}

fn negated(f: Fragment) -> Fragment {
  sql.concat([sql.text("NOT ("), f, sql.text(")")])
}

pub type Coverage {
  Coverage(eligible: Int, evaluated: Int)
}

fn coverage(
  read: Read,
  org: Org,
  b: Brief,
  at: Int,
) -> Result(Coverage, Fail(e)) {
  let required = engine.brief_criteria(b.criteria).required
  use eligible <- result.try(query.count(
    read,
    query.from(org, required, at, []),
  ))
  use evaluated <- result.map(query.count(
    read,
    query.from(org, required, at, [evaluated_sql(org.id, at)]),
  ))
  Coverage(eligible:, evaluated:)
}

/// evaluationCoverageState. Groups smaller than `suppress_min` are suppressed.
pub fn coverage_state(c: Coverage, suppress_min: Int) -> Json {
  let not_yet = int.max(0, c.eligible - c.evaluated)
  case c.eligible > 0 && c.eligible < suppress_min {
    True ->
      json.object([
        #("eligible", json.int(c.eligible)),
        #("evaluated", json.null()),
        #("notYetEvaluated", json.null()),
        #("coveragePercent", json.null()),
        #("suppressed", json.bool(True)),
        #(
          "note",
          json.string(
            "Fewer than "
            <> int.to_string(suppress_min)
            <> " eligible players match this brief — the breakdown is suppressed.",
          ),
        ),
        #("policyVersion", json.int(briefs.coverage_policy_version)),
      ])
    False ->
      json.object([
        #("eligible", json.int(c.eligible)),
        #("evaluated", json.int(c.evaluated)),
        #("notYetEvaluated", json.int(not_yet)),
        #("coveragePercent", case c.eligible {
          0 -> json.null()
          e ->
            json.int(float.round(
              int.to_float(c.evaluated) /. int.to_float(e) *. 100.0,
            ))
        }),
        #("suppressed", json.bool(False)),
        #("complete", json.bool(c.eligible > 0 && not_yet == 0)),
        #("note", json.string(coverage_note)),
        #("policyVersion", json.int(briefs.coverage_policy_version)),
      ])
  }
}

/// The queue's order: matching's sorts, and the last time the club reviewed the player for this brief.
fn order_for(
  sort: String,
  org: Org,
  brief_id: id.BriefId,
  now: Int,
) -> List(keyset.OrderKey) {
  query.order(case sort {
    "last_reviewed" ->
      OrderKey(
        sql.concat([
          sql.text(
            "COALESCE((SELECT nr.reviewed_at FROM nobody_missed_reviews nr WHERE nr.org_id = ",
          ),
          sql.arg(id.org_sql(org.id)),
          sql.text(" AND nr.brief_id = "),
          sql.arg(id.brief_sql(brief_id)),
          sql.text(" AND nr.player_id = p.id), 0)"),
        ]),
        Asc,
        IntKind,
      )
    _ -> query.lead(sort, org, now)
  })
}

// ------------------------------------------------------------------------------------------------------ reviews

pub type Review {
  Review(row: review_row.Row, history: List(review_history_row.Row))
}

fn reviews_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Review), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> review_row.columns
      <> " FROM nobody_missed_reviews WHERE "
      <> where,
    args,
    review_row.decoder(),
  ))
  list.try_map(rows, fn(r) {
    use history <- result.map(store.query(
      read,
      "SELECT "
        <> review_history_row.columns
        <> " FROM nobody_missed_review_history WHERE review_id = ? ORDER BY ord",
      [id.nobody_missed_review_sql(r.id)],
      review_history_row.decoder(),
    ))
    Review(r, history)
  })
}

fn review_by_key(
  read: Read,
  org_id: id.OrgId,
  brief_id: id.BriefId,
  player_id: id.PlayerId,
) -> Result(Option(Review), Fail(e)) {
  reviews_where(read, "org_id = ? AND brief_id = ? AND player_id = ?", [
    id.org_sql(org_id),
    id.brief_sql(brief_id),
    id.player_sql(player_id),
  ])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

fn reviews_for_brief(
  read: Read,
  org_id: id.OrgId,
  brief_id: id.BriefId,
) -> Result(List(Review), Fail(e)) {
  reviews_where(read, "org_id = ? AND brief_id = ? ORDER BY rowid", [
    id.org_sql(org_id),
    id.brief_sql(brief_id),
  ])
}

/// What the organisation did next with the player for this brief: reviewed, dismissed (with a reason) or added
/// to a Room. Each appends its trail entry; what earlier acts recorded is kept.
pub type Act {
  Reviewed
  Dismissed(reason: Option(review_row.DismissReason))
  AddedToRoom(room_id: id.RecruitmentCaseId)
}

fn set_review(
  tx: Tx,
  a: OrgAccess,
  b: Brief,
  player_id: id.PlayerId,
  act: Act,
  at: Int,
) -> Result(Review, Fail(e)) {
  let read = store.reading(tx)
  use existing <- result.try(review_by_key(read, a.org.id, b.row.id, player_id))
  let state = case act {
    Reviewed -> review_state.Reviewed
    Dismissed(_) -> review_state.Dismissed
    AddedToRoom(_) -> review_state.AddedToRoom
  }
  use base <- result.try(case existing {
    Some(r) -> Ok(r.row)
    None -> {
      use review_id <- result.map(id.next_nobody_missed_review(tx))
      review_row.new(
        id: review_id,
        org_id: a.org.id,
        brief_id: b.row.id,
        brief_version: b.row.version,
        player_id:,
        state:,
        created_at: at,
        updated_at: at,
      )
    }
  })
  let by_id = Some(a.user.id)
  let by_name = Some(a.user.name)
  let next = case act {
    Reviewed ->
      review_row.Row(
        ..base,
        reviewed_by_user_id: by_id,
        reviewed_by_name: by_name,
        reviewed_at: Some(at),
      )
    Dismissed(reason) ->
      review_row.Row(
        ..base,
        dismiss_reason: reason,
        dismissed_by_user_id: by_id,
        dismissed_by_name: by_name,
        dismissed_at: Some(at),
      )
    AddedToRoom(room_id) ->
      review_row.Row(
        ..base,
        room_id: Some(room_id),
        reviewed_by_user_id: by_id,
        reviewed_by_name: by_name,
        reviewed_at: Some(at),
      )
  }
  let next =
    review_row.Row(..next, state:, brief_version: b.row.version, updated_at: at)
  use _ <- result.try(case existing {
    None -> review_row.insert(tx, next)
    Some(_) ->
      store.run(
        tx,
        "UPDATE nobody_missed_reviews SET state = ?, brief_version = ?, updated_at = ?, reviewed_by_user_id = ?, reviewed_by_name = ?, reviewed_at = ?, dismiss_reason = ?, dismissed_by_user_id = ?, dismissed_by_name = ?, dismissed_at = ?, room_id = ? WHERE id = ?",
        [
          sqlight.text(review_state.to_string(next.state)),
          sqlight.int(next.brief_version),
          sqlight.int(at),
          sqlight.nullable(id.org_user_sql, next.reviewed_by_user_id),
          sqlight.nullable(sqlight.text, next.reviewed_by_name),
          sqlight.nullable(sqlight.int, next.reviewed_at),
          sqlight.nullable(
            sqlight.text,
            option.map(next.dismiss_reason, review_row.dismiss_reason_to_string),
          ),
          sqlight.nullable(id.org_user_sql, next.dismissed_by_user_id),
          sqlight.nullable(sqlight.text, next.dismissed_by_name),
          sqlight.nullable(sqlight.int, next.dismissed_at),
          sqlight.nullable(id.recruitment_case_sql, next.room_id),
          id.nobody_missed_review_sql(next.id),
        ],
      )
  })
  let ord = case existing {
    Some(r) -> list.length(r.history)
    None -> 0
  }
  let entry =
    review_history_row.Row(
      review_id: next.id,
      ord:,
      at:,
      state:,
      by_user_id: a.user.id,
      by_name:,
    )
  use _ <- result.map(review_history_row.insert(tx, entry))
  Review(next, case existing {
    Some(r) -> list.append(r.history, [entry])
    None -> [entry]
  })
}

fn person(user: Option(id.OrgUserId), name: Option(String)) -> Json {
  case user {
    Some(u) ->
      json.object([
        #("userId", id.org_user_json(u)),
        #("name", json.nullable(name, json.string)),
      ])
    None -> json.null()
  }
}

fn review_view(r: Review) -> Json {
  let x = r.row
  json.object([
    #("id", id.nobody_missed_review_json(x.id)),
    #("orgId", id.org_json(x.org_id)),
    #("briefId", id.brief_json(x.brief_id)),
    #("briefVersion", json.int(x.brief_version)),
    #("playerId", id.player_json(x.player_id)),
    #("state", review_state.to_json(x.state)),
    #("createdAt", json.int(x.created_at)),
    #("updatedAt", json.int(x.updated_at)),
    #("reviewedBy", person(x.reviewed_by_user_id, x.reviewed_by_name)),
    #("reviewedAt", json.nullable(x.reviewed_at, json.int)),
    #(
      "dismissReason",
      json.nullable(x.dismiss_reason, review_row.dismiss_reason_to_json),
    ),
    #("dismissedBy", person(x.dismissed_by_user_id, x.dismissed_by_name)),
    #("dismissedAt", json.nullable(x.dismissed_at, json.int)),
    #("roomId", json.nullable(x.room_id, id.recruitment_case_json)),
    #(
      "history",
      json.array(r.history, fn(h) {
        json.object([
          #("at", json.int(h.at)),
          #("state", review_state.to_json(h.state)),
          #("by", person(Some(h.by_user_id), h.by_name)),
        ])
      }),
    ),
  ])
}

// ------------------------------------------------------------------------------------------------- brief routes

fn answer(r: Result(Response, Fail(Response))) -> Response {
  case r {
    Ok(resp) -> resp
    Error(store.Refuse(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

fn limited(
  ctx: Ctx,
  a: OrgAccess,
  action: limits.Action,
  next: fn() -> Response,
) -> Response {
  case
    limits.limited(
      ctx.limits,
      action,
      id.org_to_string(a.org.id),
      clock.now_ms(),
    )
  {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(action), fn(f) {
            #(f.0, json.string(f.1))
          }),
        ),
      )
    False -> next()
  }
}

fn not_found() -> Response {
  http.error(404, "BRIEF_NOT_FOUND")
}

fn find_brief(
  read: Read,
  a: OrgAccess,
  brief_id: String,
) -> Result(Brief, Fail(Response)) {
  use found <- result.try(
    briefs.for_org_by_id(read, id.brief(brief_id), a.org.id)
    |> room_routes.storage,
  )
  case found {
    Some(b) -> Ok(b)
    None -> store.refuse(not_found())
  }
}

type Page {
  Page(limit: Option(Int), offset: Option(Int))
}

/// `GET /org/recruitment-briefs`.
pub fn list_briefs(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use limit <- input.field(
      "limit",
      input.optional(input.whole_number_text(1, 100)),
    )
    use offset <- input.field(
      "offset",
      input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
    )
    input.done(Page(limit:, offset:))
  }
  use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
  case store.read(ctx.store, briefs.for_org(_, a.org.id)) {
    Error(e) -> http.internal(e)
    Ok(all) -> {
      let limit = option.unwrap(q.limit, 25)
      let offset = option.unwrap(q.offset, 0)
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(
              all |> list.drop(offset) |> list.take(limit),
              briefs.view,
            ),
          ),
          #("total", json.int(list.length(all))),
          #("limit", json.int(limit)),
          #("offset", json.int(offset)),
          #(
            "statuses",
            json.array(brief_status.pairs, fn(p) { json.string(p.0) }),
          ),
          #(
            "vocabulary",
            json.object([
              #(
                "positions",
                json.array(position.pairs, fn(p) { json.string(p.0) }),
              ),
              #(
                "evidenceRequirements",
                json.array(briefs.evidence_requirements, fn(e) {
                  json.object([
                    #("key", json.string(e.0)),
                    #("label", json.string(e.1)),
                  ])
                }),
              ),
              #(
                "trustBands",
                json.array(trust_band.pairs, fn(p) { json.string(p.0) }),
              ),
            ]),
          ),
          #("policyVersion", json.int(briefs.coverage_policy_version)),
        ]),
      )
    }
  }
}

fn text_list(max: Int) -> input.Check(List(String)) {
  input.list_of(input.text(1000), max)
}

const any_number = 9_007_199_254_740_991

/// The brief's own fields, as the routes' shapes read them. `rule` is how a field reads: `nullish` for a new
/// brief, `clearable` for an edit, where null clears it and absence leaves it.
fn brief_fields(
  rule: fn(input.Check(Dynamic)) -> input.Rule(r),
  next: fn(List(#(String, r))) -> input.Shape(a),
) -> input.Shape(a) {
  let field = fn(name, check: input.Check(Dynamic), k) {
    input.field(name, rule(check), fn(x) { k(#(name, x)) })
  }
  use title <- field(
    "title",
    as_dynamic(input.text(briefs.title_max), dynamic.string),
  )
  use positions <- field("positions", as_dynamic(text_list(13), strings))
  use min_age <- field(
    "minAge",
    as_dynamic(input.number(-any_number, any_number), dynamic.float),
  )
  use max_age <- field(
    "maxAge",
    as_dynamic(input.number(-any_number, any_number), dynamic.float),
  )
  use radius <- field(
    "radiusKm",
    as_dynamic(input.number(-any_number, any_number), dynamic.float),
  )
  use max_level <- field(
    "maxLevel",
    as_dynamic(input.text(1000), dynamic.string),
  )
  use foot <- field("foot", as_dynamic(input.text(1000), dynamic.string))
  use availability <- field(
    "availability",
    as_dynamic(input.text(briefs.availability_max), dynamic.string),
  )
  use evidence <- field(
    "evidenceRequirements",
    as_dynamic(text_list(4), strings),
  )
  use band <- field(
    "minTrustBand",
    as_dynamic(input.text(1000), dynamic.string),
  )
  use protocols <- field("combineProtocols", as_dynamic(text_list(50), strings))
  use from <- field("activeFrom", as_dynamic(input.day_or_blank(), day))
  use until <- field("activeUntil", as_dynamic(input.day_or_blank(), day))
  next([
    title, positions, min_age, max_age, radius, max_level, foot, availability,
    evidence, band, protocols, from, until,
  ])
}

fn as_dynamic(
  check: input.Check(b),
  to: fn(b) -> Dynamic,
) -> input.Check(Dynamic) {
  fn(v) { check(v) |> result.map(to) }
}

fn strings(xs: List(String)) -> Dynamic {
  dynamic.list(list.map(xs, dynamic.string))
}

fn day(d: Option(temporal.Day)) -> Dynamic {
  case d {
    Some(d) -> dynamic.string(temporal.day_text(d))
    None -> dynamic.nil()
  }
}

fn read_as(v: Option(Dynamic), decoder: decode.Decoder(a)) -> Option(a) {
  option.then(v, fn(v) { decode.run(v, decoder) |> option.from_result })
}

/// The fields a shape read, as `briefs.Fields`: each value already passed its check, so it decodes.
fn to_fields(values: List(#(String, Option(Dynamic)))) -> briefs.Fields {
  let get = fn(name) { list.key_find(values, name) |> result.unwrap(None) }
  briefs.Fields(
    title: read_as(get("title"), decode.string),
    positions: read_as(get("positions"), decode.list(decode.string)),
    min_age: read_as(get("minAge"), decode.float),
    max_age: read_as(get("maxAge"), decode.float),
    radius_km: read_as(get("radiusKm"), decode.float),
    max_level: read_as(get("maxLevel"), decode.string),
    foot: read_as(get("foot"), decode.string),
    availability: read_as(get("availability"), decode.string),
    evidence_requirements: read_as(
      get("evidenceRequirements"),
      decode.list(decode.string),
    ),
    min_trust_band: read_as(get("minTrustBand"), decode.string),
    combine_protocols: read_as(
      get("combineProtocols"),
      decode.list(decode.string),
    ),
    active_from: read_as(get("activeFrom"), decode.string),
    active_until: read_as(get("activeUntil"), decode.string),
  )
}

type NewBriefBody {
  NewBriefBody(
    fields: briefs.Fields,
    role_id: Option(String),
    vacancy_id: Option(String),
  )
}

/// `POST /org/recruitment-briefs`: a new brief, in draft.
pub fn create_brief(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use <- limited(ctx, a, limits.BriefWrite)
  case store.read(ctx.store, briefs.count_for_org(_, a.org.id)) {
    Error(e) -> http.internal(e)
    Ok(n) if n >= briefs.per_org -> http.error(409, "BRIEFS_FULL")
    Ok(_) -> {
      use raw <- http.json_body(req)
      case briefs.prohibited(raw) {
        Some(found) -> http.json(400, briefs.prohibited_json(found))
        None -> {
          let shape = {
            use values <- brief_fields(input.nullish)
            use role_id <- input.field("roleId", input.nullish(input.text(64)))
            use vacancy_id <- input.field(
              "vacancyId",
              input.nullish(input.text(64)),
            )
            input.done(NewBriefBody(to_fields(values), role_id:, vacancy_id:))
          }
          case input.parse(shape, raw, root: "body", codes: []) {
            Error(refusal) -> http.refused(refusal)
            Ok(body) ->
              case briefs.validate(body.fields, orgs.is_grassroots(a.org)) {
                Error(details) -> http.json(400, briefs.invalid_json(details))
                Ok(valid) -> {
                  let now = clock.now_ms()
                  store.unit(ctx.store, fn(tx) {
                    use b <- result.try(briefs.create(
                      tx,
                      briefs.NewBrief(
                        org_id: a.org.id,
                        valid:,
                        role_id: input.filled(body.role_id),
                        vacancy_id: input.filled(body.vacancy_id),
                        by: #(a.user.id, a.user.name),
                        at: now,
                      ),
                    ))
                    use _ <- result.map(second_look.count(
                      tx,
                      "recruitment_brief_created",
                    ))
                    http.json(201, json.object([#("brief", briefs.view(b))]))
                  })
                  |> room_routes.answer
                }
              }
          }
        }
      }
    }
  }
}

/// `GET /org/recruitment-briefs/:id`.
pub fn get_brief(ctx: Ctx, a: OrgAccess, brief_id: String) -> Response {
  store.read(ctx.store, fn(read) {
    use b <- result.map(find_brief(read, a, brief_id))
    http.json(200, json.object([#("brief", briefs.view(b))]))
  })
  |> answer
}

type BriefEdit {
  BriefEdit(
    values: List(#(String, Option(Option(Dynamic)))),
    status: Option(String),
  )
}

/// `PATCH /org/recruitment-briefs/:id`. Everything is checked before anything is written, so a refused criteria
/// change does not half-apply the status change that came with it.
pub fn edit_brief(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  brief_id: String,
) -> Response {
  case store.read(ctx.store, find_brief(_, a, brief_id)) {
    Error(e) -> answer(Error(e))
    Ok(b) -> {
      use <- access.require_lead(a)
      use <- limited(ctx, a, limits.BriefWrite)
      case b.row.status == brief_status.Archived {
        True -> http.error(409, "BRIEF_ARCHIVED")
        False -> {
          use raw <- http.json_body(req)
          case briefs.prohibited(raw) {
            Some(found) -> http.json(400, briefs.prohibited_json(found))
            None -> edit_body(ctx, a, b, raw)
          }
        }
      }
    }
  }
}

fn edit_body(ctx: Ctx, a: OrgAccess, b: Brief, raw: Dynamic) -> Response {
  let shape = {
    use values <- brief_fields(input.clearable)
    use status <- input.field("status", input.optional(input.text(1000)))
    use <- rev.fields
    input.done(BriefEdit(values:, status:))
  }
  case input.parse(shape, raw, root: "body", codes: rev.codes) {
    Error(refusal) -> http.refused(refusal)
    Ok(body) -> {
      use expected <- result_or(rev.expected(raw))
      // The conflict carries the brief's current version and status beside the guard's own fields, as the
      // TypeScript guard spreads its `current` into the body.
      use <- rev.guard(expected, briefs.rev_of(b), "BRIEF_VERSION_CONFLICT", [
        #("currentVersion", json.int(b.row.version)),
        #("status", brief_status.to_json(b.row.status)),
      ])
      let status = case body.status {
        None -> Ok(None)
        Some(s) ->
          case brief_status.from_string(s) {
            Error(Nil) -> Error(http.error(400, "BRIEF_STATUS_UNKNOWN"))
            Ok(to) ->
              case briefs.can_transition(b.row.status, to) {
                True -> Ok(Some(to))
                False ->
                  Error(http.json(
                    409,
                    json.object([
                      #("error", json.string("BRIEF_TRANSITION_INVALID")),
                      #("from", brief_status.to_json(b.row.status)),
                      #("to", brief_status.to_json(to)),
                    ]),
                  ))
              }
          }
      }
      use status <- result_or(status)
      let given = list.filter(body.values, fn(v) { option.is_some(v.1) })
      let valid = case given {
        [] -> Ok(None)
        _ -> {
          // The stored brief, with what the edit gives over it.
          let stored = briefs.fields_of(b.row, b.criteria)
          let merged = merge(stored, given)
          briefs.validate(merged, orgs.is_grassroots(a.org))
          |> result.map(Some)
          |> result.map_error(fn(d) { http.json(400, briefs.invalid_json(d)) })
        }
      }
      use valid <- result_or(valid)
      // Historical coverage keeps pointing at the version it was computed against.
      let changed = case valid {
        Some(v) if v.criteria != b.criteria -> Some(v.criteria)
        _ -> None
      }
      let events =
        list.flatten([
          case status {
            Some(to) -> [
              briefs.Event(
                action: case to {
                  brief_status.Active ->
                    brief_history_row.RecruitmentBriefActivated
                  _ -> brief_history_row.RecruitmentBriefUpdated
                },
                version: None,
                from: Some(b.row.status),
                to: Some(to),
                criteria_changed: None,
              ),
            ]
            None -> []
          },
          case changed {
            Some(_) -> [
              briefs.Event(
                action: brief_history_row.RecruitmentBriefUpdated,
                version: Some(b.row.version + 1),
                from: None,
                to: None,
                criteria_changed: Some(True),
              ),
            ]
            None -> []
          },
        ])
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use current <- result.try(find_brief(store.reading(tx), a, briefs_id(b)))
        use _ <- result.try(case current.row.rev == b.row.rev {
          True -> Ok(Nil)
          False -> store.stale("recruitment brief")
        })
        use stored <- result.try(
          briefs.revise(
            tx,
            current,
            briefs.Revision(
              status:,
              valid:,
              criteria: changed,
              events:,
              by: #(a.user.id, a.user.name),
              at: now,
            ),
          )
          |> room_routes.storage,
        )
        use _ <- result.map(case status {
          Some(brief_status.Active) ->
            second_look.count(tx, "recruitment_brief_activated")
            |> room_routes.storage
          _ -> Ok(Nil)
        })
        http.json(200, json.object([#("brief", briefs.view(stored))]))
      })
      |> room_routes.answer
    }
  }
}

fn briefs_id(b: Brief) -> String {
  id.brief_to_string(b.row.id)
}

fn result_or(r: Result(a, Response), next: fn(a) -> Response) -> Response {
  case r {
    Ok(a) -> next(a)
    Error(resp) -> resp
  }
}

fn override(
  given: List(#(String, Option(Option(Dynamic)))),
  name: String,
  current: Option(a),
  decoder: decode.Decoder(a),
) -> Option(a) {
  case list.key_find(given, name) {
    Ok(Some(Some(v))) -> decode.run(v, decoder) |> option.from_result
    Ok(Some(None)) -> None
    _ -> current
  }
}

/// The stored fields with the edit's over them: null clears a field.
fn merge(
  stored: briefs.Fields,
  given: List(#(String, Option(Option(Dynamic)))),
) -> briefs.Fields {
  briefs.Fields(
    title: override(given, "title", stored.title, decode.string),
    positions: override(
      given,
      "positions",
      stored.positions,
      decode.list(decode.string),
    ),
    min_age: override(given, "minAge", stored.min_age, decode.float),
    max_age: override(given, "maxAge", stored.max_age, decode.float),
    radius_km: override(given, "radiusKm", stored.radius_km, decode.float),
    max_level: override(given, "maxLevel", stored.max_level, decode.string),
    foot: override(given, "foot", stored.foot, decode.string),
    availability: override(
      given,
      "availability",
      stored.availability,
      decode.string,
    ),
    evidence_requirements: override(
      given,
      "evidenceRequirements",
      stored.evidence_requirements,
      decode.list(decode.string),
    ),
    min_trust_band: override(
      given,
      "minTrustBand",
      stored.min_trust_band,
      decode.string,
    ),
    combine_protocols: override(
      given,
      "combineProtocols",
      stored.combine_protocols,
      decode.list(decode.string),
    ),
    active_from: override(
      given,
      "activeFrom",
      stored.active_from,
      decode.string,
    ),
    active_until: override(
      given,
      "activeUntil",
      stored.active_until,
      decode.string,
    ),
  )
}

// ----------------------------------------------------------------------------------------- Nobody Missed routes

type QueueQuery {
  QueueQuery(
    brief_id: Option(String),
    sort: Option(String),
    page: paging.Query,
    offset: Bool,
  )
}

fn evaluation_policy() -> Json {
  json.object([
    #("version", json.int(briefs.coverage_policy_version)),
    #(
      "counts",
      json.array(evaluation_signals, fn(s) {
        json.object([#("key", json.string(s.0)), #("label", json.string(s.1))])
      }),
    ),
    #(
      "doesNotCount",
      json.array(non_evaluation_signals, fn(s) {
        json.object([#("key", json.string(s.0)), #("why", json.string(s.1))])
      }),
    ),
    #("recentDecisionDays", json.int(recent_decision_days)),
  ])
}

fn number(f: Float) -> Json {
  json_text.number(f)
}

/// `GET /org/nobody-missed?briefId=`: the brief's eligible players who never entered the club's workflow.
pub fn queue(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use brief_id <- input.field("briefId", input.optional(input.text(64)))
    use sort <- input.field(
      "sort",
      input.optional(input.one_of(list.map(sorts, fn(s) { #(s, s) }))),
    )
    use limit <- input.field("limit", input.nullish(input.text(1000)))
    use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
    use offset <- input.field("offset", input.optional(input.anything()))
    input.done(QueueQuery(
      brief_id:,
      sort:,
      page: paging.Query(limit:, cursor:),
      offset: option.is_some(offset),
    ))
  }
  use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
  let now = clock.now_ms()
  store.read(ctx.store, fn(read) {
    use b <- result.try(case q.brief_id {
      Some(bid) -> find_brief(read, a, bid)
      None -> store.refuse(not_found())
    })
    case briefs.is_live_on(b.row, temporal.day_of(now)) {
      False ->
        Ok(http.json(
          200,
          json.object([
            #("brief", briefs.view(b)),
            #("live", json.bool(False)),
            #("items", json.preprocessed_array([])),
            #("total", json.int(0)),
            #("coverage", json.null()),
            #(
              "note",
              json.string(
                "Only an active brief inside its date window produces candidates.",
              ),
            ),
          ]),
        ))
      True -> {
        let sort = option.unwrap(q.sort, "newest_evidence")
        let order = order_for(sort, a.org, b.row.id, now)
        use page <- result.try(case q.offset {
          True ->
            store.refuse(http.error_message(
              400,
              "PAGE_OFFSET_UNSUPPORTED",
              "page with cursor, the previous response's nextCursor",
            ))
          False ->
            case paging.read(q.page, keyset.kinds(order)) {
              Ok(p) -> Ok(p)
              Error(e) -> {
                let #(code, message) = paging.error_body(e)
                store.refuse(http.error_message(400, code, message))
              }
            }
        })
        let required = engine.brief_criteria(b.criteria).required
        let evaluated = evaluated_sql(a.org.id, now)
        let closed = closed_sql(a.org.id, b.row.id)
        use cov <- result.try(
          coverage(read, a.org, b, now) |> room_routes.storage,
        )
        use closed_count <- result.try(
          query.count(
            read,
            query.from(a.org, required, now, [
              sql.concat([
                sql.text("("),
                evaluated,
                sql.text(") OR ("),
                closed,
                sql.text(")"),
              ]),
            ]),
          )
          |> room_routes.storage,
        )
        use found <- result.try(
          query.page(
            read,
            query.from(a.org, required, now, [
              negated(evaluated),
              negated(closed),
            ]),
            order,
            page,
          )
          |> room_routes.storage,
        )
        let #(shown, next_cursor) =
          paging.page_of(found, page.limit, fn(x) { x.1 })
        use facts <- result.try(
          query.facts_of(read, a.org, list.map(shown, fn(x) { x.0 }), now)
          |> room_routes.storage,
        )
        use reviews <- result.map(
          reviews_for_brief(read, a.org.id, b.row.id) |> room_routes.storage,
        )
        let cards =
          list.filter_map(facts, fn(f) {
            // Explained from the same facts, at the same instant, as the query that found them.
            card(
              f,
              b.row.id,
              b.row.version,
              engine.match_brief(f, b.criteria, now),
              False,
              False,
            )
            |> option.map(fn(fields) {
              let review =
                list.find(reviews, fn(r) { r.row.player_id == f.player_id })
              json.object(
                list.append(fields, [
                  #("distanceKm", json.nullable(f.distance_km, number)),
                  #(
                    "lastEvidenceAt",
                    json.nullable(f.last_evidence_at, json.int),
                  ),
                  #("state", case review {
                    Ok(r) -> review_state.to_json(r.row.state)
                    Error(Nil) -> json.string("open")
                  }),
                  #("reviewedAt", case review {
                    Ok(r) -> json.nullable(r.row.reviewed_at, json.int)
                    Error(Nil) -> json.null()
                  }),
                ]),
              )
            })
            |> option.to_result(Nil)
          })
        http.json(
          200,
          json.object([
            #("brief", briefs.view(b)),
            #("live", json.bool(True)),
            #("briefVersion", json.int(b.row.version)),
            #("items", json.preprocessed_array(cards)),
            #("nextCursor", json.nullable(next_cursor, json.string)),
            #("total", json.int(cov.eligible - closed_count)),
            #("limit", json.int(page.limit)),
            #("coverage", coverage_state(cov, suppress_min)),
            #("sorts", json.array(sorts, json.string)),
            #("sort", json.string(sort)),
            #("evaluationPolicy", evaluation_policy()),
            #(
              "note",
              json.string(
                "Eligible under your own criteria and not yet in your evaluation workflow. This is workflow coverage, not a judgement of any player, and nothing here is ranked by quality.",
              ),
            ),
          ]),
        )
      }
    }
  })
  |> answer
}

type BriefAndPlayer {
  BriefAndPlayer(
    brief_id: Option(String),
    player_id: Option(String),
    reason: Option(review_row.DismissReason),
  )
}

/// The brief (another organisation's is no brief) and a player the organisation may see, inside the unit.
fn brief_and_player(
  read: Read,
  a: OrgAccess,
  body: BriefAndPlayer,
  now: Int,
) -> Result(#(Brief, id.PlayerId), Fail(Response)) {
  use b <- result.try(case body.brief_id {
    Some(bid) -> find_brief(read, a, bid)
    None -> store.refuse(not_found())
  })
  let not_visible = http.error(403, "NOT_VISIBLE")
  case body.player_id {
    None -> store.refuse(not_visible)
    Some(pid) -> {
      use found <- result.try(
        visibility_of(read, a.org, id.player(pid), now) |> room_routes.storage,
      )
      case found {
        True -> Ok(#(b, id.player(pid)))
        False -> store.refuse(not_visible)
      }
    }
  }
}

fn visibility_of(
  read: Read,
  org: Org,
  player_id: id.PlayerId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  let q =
    sql.concat([
      sql.text("SELECT 1 FROM players p WHERE p.id = "),
      sql.arg(id.player_sql(player_id)),
      sql.text(" AND p.deleted_at IS NULL AND "),
      visibility.can_see_sql(org, now),
    ])
  store.query(read, q.sql, q.args, decode.at([0], decode.int))
  |> result.map(fn(rows) { rows != [] })
}

fn pair_shape(with_reason: Bool) -> input.Shape(BriefAndPlayer) {
  use brief_id <- input.field("briefId", input.nullish(input.text(64)))
  use player_id <- input.field("playerId", input.nullish(input.text(64)))
  case with_reason {
    True -> {
      use reason <- input.field(
        "reason",
        input.nullish(input.one_of(review_row.dismiss_reason_pairs)),
      )
      input.done(BriefAndPlayer(brief_id:, player_id:, reason:))
    }
    False -> input.done(BriefAndPlayer(brief_id:, player_id:, reason: None))
  }
}

/// Answers the body's refusal, then the brief and player checks, then the limit, as the TypeScript routes do.
fn review_act(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  with_reason: Bool,
  act: fn(Tx, Brief, id.PlayerId, BriefAndPlayer, Int) ->
    Result(Response, Fail(Response)),
) -> Response {
  use body <- http.body(req, pair_shape(with_reason), [
    #("reason", "NM_REASON_UNKNOWN"),
  ])
  let now = clock.now_ms()
  case store.read(ctx.store, brief_and_player(_, a, body, now)) {
    Error(e) -> answer(Error(e))
    Ok(_) -> {
      use <- limited(ctx, a, limits.NobodyMissedAction)
      store.unit(ctx.store, fn(tx) {
        use #(b, pid) <- result.try(brief_and_player(
          store.reading(tx),
          a,
          body,
          now,
        ))
        act(tx, b, pid, body, now)
      })
      |> room_routes.answer
    }
  }
}

/// `POST /org/nobody-missed/review`: records nothing on the player's own record.
pub fn review(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use tx, b, pid, _, now <- review_act(ctx, req, a, False)
  use r <- result.try(
    set_review(tx, a, b, pid, Reviewed, now) |> room_routes.storage,
  )
  use _ <- result.map(
    second_look.count(tx, "nobody_missed_player_reviewed")
    |> room_routes.storage,
  )
  http.json(
    200,
    json.object([
      #("review", review_view(r)),
      #(
        "note",
        json.string(
          "Reviewing a candidate records nothing on the player’s own record.",
        ),
      ),
    ]),
  )
}

/// `POST /org/nobody-missed/dismiss`: for this brief only.
pub fn dismiss(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use tx, b, pid, body, now <- review_act(ctx, req, a, True)
  use r <- result.try(
    set_review(tx, a, b, pid, Dismissed(body.reason), now)
    |> room_routes.storage,
  )
  use _ <- result.map(
    second_look.count(tx, "nobody_missed_player_dismissed")
    |> room_routes.storage,
  )
  http.json(
    200,
    json.object([
      #("review", review_view(r)),
      #(
        "note",
        json.string(
          "Dismissed for this brief only. Nothing is written to the player’s record.",
        ),
      ),
    ]),
  )
}

/// `POST /org/nobody-missed/add-to-room`, through the Rooms' own creator. A double click adds the candidate once:
/// the creator answers the open Room there already is.
pub fn add_to_room(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use tx, b, pid, _, now <- review_act(ctx, req, a, False)
  use created <- result.try(room_routes.create_for_player(
    tx,
    a,
    pid,
    source_context.NobodyMissed,
    Some(#(id.brief_to_string(b.row.id), Some(b.row.version))),
    now,
    ctx.config.box_cam_test_provider,
  ))
  use r <- result.try(
    set_review(tx, a, b, pid, AddedToRoom(created.room_id), now)
    |> room_routes.storage,
  )
  use _ <- result.map(
    second_look.count(tx, "nobody_missed_player_added_to_room")
    |> room_routes.storage,
  )
  http.json(
    case created.existed {
      True -> 200
      False -> 201
    },
    json.object([
      #("review", review_view(r)),
      #("roomId", id.recruitment_case_json(created.room_id)),
      #("room", created.view),
      #("idempotent", json.bool(created.existed)),
    ]),
  )
}

/// `GET /org/evaluation-coverage`: the coverage of every live brief, never attributed to anyone.
pub fn evaluation_coverage(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  store.read(ctx.store, fn(read) {
    use all <- result.try(briefs.for_org(read, a.org.id) |> room_routes.storage)
    let live =
      list.filter(all, fn(b) { briefs.is_live_on(b.row, temporal.day_of(now)) })
    use items <- result.map(
      list.try_map(live, fn(b) {
        use cov <- result.map(coverage(read, a.org, b, now))
        json.object([
          #("briefId", id.brief_json(b.row.id)),
          #("title", json.string(b.row.title)),
          #("briefVersion", json.int(b.row.version)),
          #("coverage", coverage_state(cov, suppress_min)),
        ])
      })
      |> room_routes.storage,
    )
    http.json(
      200,
      json.object([
        #("items", json.preprocessed_array(items)),
        #("policyVersion", json.int(briefs.coverage_policy_version)),
        #("note", json.string(coverage_note)),
      ]),
    )
  })
  |> answer
}
