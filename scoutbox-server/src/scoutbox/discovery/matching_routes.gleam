//// Explainable Matching (domains/discovery/matching/index.mjs): which visible players satisfy the criteria this
//// club wrote, and for each, which criteria, one by one. Never who is best: nothing is ranked or scored. Every
//// query starts from the players the organisation may see, so no criterion is ever evaluated against a player the
//// club may not know exists, including through a count.
////
//// Each act counts itself in the `secondLook` group of `/admin/metrics`, as the TypeScript server's discovery counters
//// do (`count`): counts only, naming nothing.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/development/combine_rules
import scoutbox/discovery/briefs
import scoutbox/discovery/matching/criteria.{type Criteria}
import scoutbox/discovery/matching/engine.{type Facts}
import scoutbox/discovery/matching/query
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/keyset
import scoutbox/platform/limits
import scoutbox/platform/metrics
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/vocab/trust_band
import wisp.{type Request, type Response}

/// None of these is a match quality rank; the default is the least suggestive one that is still useful.
pub const sorts = [
  "recent_evidence", "name", "age", "evidence_confidence", "distance",
]

pub const default_sort = "recent_evidence"

pub fn sort_pairs() -> List(#(String, String)) {
  list.map(sorts, fn(s) { #(s, s) })
}

pub fn protocol_ids() -> List(String) {
  list.map(combine_rules.protocols, fn(p) { p.id })
}

/// Over the shared limit: the 429 naming the action.
pub fn limited(
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

/// A page of a match list: an `offset` is refused, so a client cannot walk a large result by position.
pub fn read_page(
  page: paging.Query,
  offset: Bool,
  order: List(keyset.OrderKey),
) -> Result(paging.Page, Response) {
  case offset {
    True ->
      Error(http.error_message(
        400,
        "PAGE_OFFSET_UNSUPPORTED",
        "page with cursor, the previous response's nextCursor",
      ))
    False ->
      paging.read(page, keyset.kinds(order))
      |> result.map_error(fn(e) {
        let #(code, message) = paging.error_body(e)
        http.error_message(400, code, message)
      })
  }
}

/// The ordering a list declares, in its body and its `X-ScoutBox-Ordering` header.
pub fn ordering(sort: String) -> String {
  sort <> ",player_id"
}

fn check_json(c: engine.Check) -> Json {
  json.object([
    #("criterionId", json.string(c.criterion_id)),
    #("met", json.bool(c.met)),
    #("text", json.string(c.text)),
  ])
}

/// A matched player, with every criterion explained.
pub fn match_view(f: Facts, m: engine.Match, org: Org) -> Json {
  json.object([
    #("playerId", id.player_json(f.player_id)),
    #("name", json.string(f.name)),
    #("position", json.nullable(f.position, json.string)),
    #("secondaryPositions", json.array(f.secondary, json.string)),
    #("age", json.nullable(f.age, json.int)),
    #("trustBand", json.nullable(f.trust_band, trust_band.to_json)),
    #("trustNote", json.string("Evidence confidence — not football ability.")),
    #("distanceKm", case orgs.is_grassroots(org) {
      True -> json.nullable(f.distance_km, json_text.number)
      False -> json.null()
    }),
    #("required", json.array(m.required, check_json)),
    #("preferred", json.array(m.preferred, check_json)),
    #("preferredMet", json.int(m.preferred_met)),
    #("preferredTotal", json.int(list.length(m.preferred))),
    #("policyVersion", json.int(criteria.policy_version)),
    #(
      "note",
      json.string(
        "Matches the criteria your organisation wrote. ScoutBox does not rank or score these players.",
      ),
    ),
  ])
}

/// A page of the players `criteria` matches, each explained from the same facts, at the same instant, as the query
/// that found them.
pub fn matched_page(
  read: Read,
  org: Org,
  c: Criteria,
  order: List(keyset.OrderKey),
  page: paging.Page,
  now: Int,
) -> Result(#(List(Json), Option(String)), Fail(e)) {
  use found <- result.try(query.page(
    read,
    query.from(org, c.required, now, []),
    order,
    page,
  ))
  let #(shown, next) = paging.page_of(found, page.limit, fn(x) { x.1 })
  use facts <- result.map(query.facts_of(
    read,
    org,
    list.map(shown, fn(x) { x.0 }),
    now,
  ))
  #(
    list.map(facts, fn(f) { match_view(f, engine.match(f, c, now), org) }),
    next,
  )
}

// ------------------------------------------------------------------------------------------------------ routes

/// `GET /org/matching/vocabulary`: the criteria this club may write. Only a Grassroots club can see distance.
pub fn vocabulary(a: OrgAccess) -> Response {
  let grassroots = orgs.is_grassroots(a.org)
  http.json(
    200,
    json.object([
      #(
        "criterionTypes",
        json.array(
          list.filter(criteria.types, fn(t) { t.0 != "geography" || grassroots }),
          fn(t) {
            json.object([
              #("type", json.string(t.0)),
              #("label", json.string(t.1)),
              #("operators", json.array(t.2, json.string)),
            ])
          },
        ),
      ),
      #(
        "operators",
        json.array(criteria.operators, fn(o) {
          json.object([
            #("id", json.string(o.0)),
            #("arity", json.string(o.1)),
            #("note", json.string(o.2)),
          ])
        }),
      ),
      #("sorts", json.array(sorts, json.string)),
      #("defaultSort", json.string(default_sort)),
      #(
        "limits",
        json.object(list.map(criteria.limits, fn(l) { #(l.0, json.int(l.1)) })),
      ),
      #("policyVersion", json.int(criteria.policy_version)),
      #("schemaVersion", json.int(criteria.schema_version)),
      #("combineProtocols", json.array(protocol_ids(), json.string)),
      // Suggestions, not a whitelist.
      #(
        "availabilityValues",
        json.array(criteria.availability_values, json.string),
      ),
      #(
        "note",
        json.string(
          "Every criterion is a fact test your club writes. There is no hidden criterion, no weighting and no overall match score.",
        ),
      ),
    ]),
  )
}

type MatchBody {
  MatchBody(
    brief_id: Option(String),
    criteria: Option(#(List(criteria.Raw), List(criteria.Raw))),
    sort: Option(String),
    page: paging.Query,
    offset: Bool,
  )
}

fn match_shape() -> input.Shape(MatchBody) {
  use brief_id <- input.field("briefId", input.nullish(input.id()))
  use raw <- input.field("criteria", input.optional(criteria.raw_criteria()))
  use sort <- input.field("sort", input.nullish(input.one_of(sort_pairs())))
  use limit <- input.field(
    "limit",
    input.nullish(input.whole_number(1, paging.max_limit)),
  )
  use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
  use offset <- input.field("offset", input.optional(input.anything()))
  input.done(MatchBody(
    brief_id:,
    criteria: raw,
    sort:,
    page: paging.Query(limit: option.map(limit, int_text), cursor:),
    offset: option.is_some(offset),
  ))
}

fn int_text(n: Int) -> String {
  json.to_string(json.int(n))
}

/// The criteria a request names: a brief of the club's own (another organisation's brief does not exist, rather
/// than being forbidden: anything else is a membership oracle), or criteria it wrote.
fn resolve(
  read: Read,
  a: OrgAccess,
  brief_id: Option(String),
  raw: Option(#(List(criteria.Raw), List(criteria.Raw))),
) -> Result(Result(#(Criteria, Option(id.BriefId)), Response), Fail(e)) {
  case brief_id {
    Some(b) -> {
      use found <- result.map(briefs.for_org_by_id(read, id.brief(b), a.org.id))
      case found {
        Some(brief) ->
          Ok(#(engine.brief_criteria(brief.criteria), Some(brief.row.id)))
        None -> Error(http.error(404, "BRIEF_NOT_FOUND"))
      }
    }
    None ->
      Ok(
        criteria.validate_raw(
          option.unwrap(raw, #([], [])),
          orgs.is_grassroots(a.org),
          protocol_ids(),
        )
        |> result.map(fn(c) { #(c, None) })
        |> result.map_error(fn(r) { http.json(400, criteria.refusal_json(r)) }),
      )
  }
}

/// `POST /org/matching`: the visible players that satisfy the criteria, each with why.
pub fn run(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- limited(ctx, a, limits.MatchingQuery)
  use body <- http.body(req, match_shape(), [#("limit", "PAGE_LIMIT_INVALID")])
  let now = clock.now_ms()
  let answer =
    store.read(ctx.store, fn(read) {
      use resolved <- result.try(resolve(read, a, body.brief_id, body.criteria))
      case resolved {
        Error(refusal) -> Ok(refusal)
        Ok(#(c, brief_id)) -> {
          let sort = option.unwrap(body.sort, default_sort)
          case sort == "distance" && !orgs.is_grassroots(a.org) {
            True ->
              Ok(http.error_message(
                400,
                "SORT_NOT_AVAILABLE",
                "Distance ordering is only available where your organisation is authorised to see distance.",
              ))
            False -> {
              let order = query.order(query.lead(sort, a.org, now))
              case read_page(body.page, body.offset, order) {
                Error(refusal) -> Ok(refusal)
                Ok(page) -> {
                  use #(items, next) <- result.try(matched_page(
                    read,
                    a.org,
                    c,
                    order,
                    page,
                    now,
                  ))
                  use total <- result.map(query.count(
                    read,
                    query.from(a.org, c.required, now, []),
                  ))
                  http.json(
                    200,
                    json.object([
                      #("items", json.preprocessed_array(items)),
                      // Over visible matches only: a "considered" figure would reveal players this club cannot see.
                      #("total", json.int(total)),
                      #("nextCursor", json.nullable(next, json.string)),
                      #("limit", json.int(page.limit)),
                      #("sort", json.string(sort)),
                      #("ordering", json.string(ordering(sort))),
                      #("criteria", criteria.describe(c)),
                      #("criteriaVersion", json.string(criteria.version(c))),
                      #("policyVersion", json.int(criteria.policy_version)),
                      #("briefId", json.nullable(brief_id, id.brief_json)),
                      #("evaluatedAt", json.int(now)),
                      #("truncated", json.bool(False)),
                      #(
                        "note",
                        json.string(
                          "Every player your organisation can currently see was evaluated against these criteria.",
                        ),
                      ),
                      #(
                        "scoreNote",
                        json.string(
                          "There is no match score. Required criteria decide the set; preferred criteria are counted, not scored.",
                        ),
                      ),
                    ]),
                  )
                  |> wisp.set_header("x-scoutbox-ordering", ordering(sort))
                }
              }
            }
          }
        }
      }
    })
  case answer {
    Ok(resp) if resp.status == 200 ->
      case store.unit(ctx.store, count(_, "matching_query_run")) {
        Ok(Nil) -> resp
        Error(e) -> http.internal(e)
      }
    Ok(resp) -> resp
    Error(e) -> http.internal(e)
  }
}

/// One more of a matching or watchlist counter in `/admin/metrics`' `secondLook` group.
pub fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, "secondLook", name)
}
