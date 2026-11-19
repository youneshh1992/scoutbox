//// The Development Hub's routes (domains/development/hub/index.mjs), one surface mounted on the player, guardian
//// and organisation routers so all three share one authorisation path (`hub_rules.plan_access`). A viewer with no
//// access gets the 404 a nonexistent plan gives, so plan ids cannot be probed.
////
//// Evidence is a reference resolved live from its source on every read; the Hub copies no facts from other
//// stores. A retried create (same actor, same content, within a minute) returns the existing record.
////
//// Not ported yet: the live events (`development_plan_created` and the rest, each to one organisation's stream).

import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/http as method
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/box_cam_rules as box_rules
import scoutbox/development/box_training
import scoutbox/development/combine
import scoutbox/development/combine_rules
import scoutbox/development/hub.{
  type Actor, type Bundle, type Detail, ActorGuardian, ActorPlayer, ActorStaff,
  Detail,
}
import scoutbox/development/hub_rules.{
  type Caps, type Target, type TargetInput, type Viewer, GuardianOf, PlayerSelf,
  StaffOf, TargetInput,
}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input.{type Shape}
import scoutbox/platform/json_text
import scoutbox/platform/key_order
import scoutbox/platform/limits
import scoutbox/platform/metrics
import scoutbox/platform/paging
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/trial_rules
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/dev_objectives as objective_row
import scoutbox/rows/development_actions as action_row
import scoutbox/rows/development_evidence_links as link_row
import scoutbox/rows/development_goals as goal_row
import scoutbox/rows/development_history as history_row
import scoutbox/rows/development_plans as plan_row
import scoutbox/rows/development_review_snapshot_refs as ref_row
import scoutbox/rows/development_review_snapshots as snapshot_row
import scoutbox/rows/development_reviews as review_row
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/trials as trial_row
import scoutbox/vocab/audience
import scoutbox/vocab/evidence_source.{type EvidenceSource}
import scoutbox/vocab/goal_category.{type GoalCategory}
import scoutbox/vocab/goal_status.{type GoalStatus}
import scoutbox/vocab/plan_visibility.{type PlanVisibility}
import sqlight
import wisp.{type Request, type Response}

/// How close together two identical creates must be to count as one retry.
const idempotency_window_ms = 60_000

/// A list no schema bounds: the route judges how many.
const any_length = 9_007_199_254_740_991

const id_max = 80

const metric_group = "development"

fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, metric_group, name)
}

/// The `development` group of `/admin/metrics`.
pub fn metrics_json(tx: Tx) -> Result(Json, Fail(e)) {
  use fields <- result.map(
    metrics.fields(tx, metric_group, [
      "development_plan_created",
      "development_goal_created",
      "development_action_completed",
      "development_review_submitted",
      "development_evidence_linked",
      "development_idempotent_retries",
    ]),
  )
  json.object(
    list.append(fields, [#("policyVersion", json.int(hub_rules.policy_version))]),
  )
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn respond(status: Int, fields: List(#(String, Json))) -> Response {
  http.json(status, json.object(fields))
}

fn refuse(
  status: Int,
  fields: List(#(String, Json)),
) -> Result(a, Fail(Response)) {
  store.refuse(respond(status, fields))
}

fn code(c: String) -> #(String, Json) {
  #("error", json.string(c))
}

fn text_field(key: String, value: String) -> #(String, Json) {
  #(key, json.string(value))
}

/// Proceeds unless `refused`, which answers `response`.
fn unless(
  refused: Bool,
  response: fn() -> Result(b, Fail(Response)),
  next: fn() -> Result(b, Fail(Response)),
) -> Result(b, Fail(Response)) {
  case refused {
    True -> response()
    False -> next()
  }
}

fn read(ctx: Ctx, f: fn(Read) -> Result(Response, Fail(Response))) -> Response {
  store.read(ctx.store, f) |> room_routes.read_answer
}

fn write(ctx: Ctx, f: fn(Tx) -> Result(Response, Fail(Response))) -> Response {
  store.unit(ctx.store, f) |> room_routes.answer
}

// ---------------------------------------------------------------------------------------------------- surfaces

/// Which router the request came through.
pub type Surface {
  AsPlayer(PlayerAccess)
  AsGuardian(Guardian)
  AsOrg(OrgAccess)
}

fn viewer_of(s: Surface) -> Viewer {
  case s {
    AsPlayer(p) -> PlayerSelf(p.player.row.id, p.minor)
    AsGuardian(g) -> GuardianOf(g.row.id, g.child_ids)
    AsOrg(a) -> StaffOf(a.org.id, access.is_lead(a.user))
  }
}

fn actor_of(s: Surface) -> Actor {
  case s {
    AsPlayer(p) ->
      ActorPlayer(id.player_to_string(p.player.row.id), p.player.row.name)
    AsGuardian(g) -> ActorGuardian(id.guardian_to_string(g.row.id), g.row.name)
    AsOrg(a) -> ActorStaff(id.org_user_to_string(a.user.id), a.user.name)
  }
}

fn rate_key(s: Surface) -> String {
  case s {
    AsPlayer(p) -> "player:" <> id.player_to_string(p.player.row.id)
    AsGuardian(g) -> "guardian:" <> id.guardian_to_string(g.row.id)
    AsOrg(a) -> "org:" <> id.org_to_string(a.org.id)
  }
}

fn limited(
  ctx: Ctx,
  s: Surface,
  action: limits.Action,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case limits.limited(ctx.limits, action, rate_key(s), clock.now_ms()) {
    True ->
      refuse(
        429,
        list.map(limits.limited_body(action), fn(kv) {
          #(kv.0, json.string(kv.1))
        }),
      )
    False -> next()
  }
}

/// The live gate search and Rooms use: visible to the organisation and not blocked.
fn org_can_see(
  read: Read,
  org: orgs.Org,
  player: id.PlayerId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  players.for_org(read, player, org, now)
  |> result.map(fn(found) {
    case found {
      Some(#(_, a)) -> a.visible && !a.blocked
      None -> False
    }
  })
}

// ------------------------------------------------------------------------------------------------ resolution

/// A plan this viewer may read, with its player and the viewer's capabilities on it.
type Seen {
  Seen(
    bundle: Bundle,
    player: Player,
    minor: Bool,
    caps: Caps,
    viewer: Viewer,
    /// For staff: the live visibility gate. Unused for a player or guardian.
    org_sees_player: Bool,
  )
}

fn plan_facts(p: hub.Plan) -> hub_rules.PlanFacts {
  hub_rules.PlanFacts(
    player_id: p.row.player_id,
    owner_org_id: p.row.owner_org_id,
    visibility: p.row.visibility,
    shared_with: p.shared_with,
  )
}

fn seen(
  read: Read,
  s: Surface,
  pid: id.DevPlanId,
  now: Int,
) -> Result(Option(Seen), Fail(e)) {
  use found <- result.try(hub.collect(read, pid))
  case found {
    None -> Ok(None)
    Some(bundle) -> {
      use player <- result.try(players.by_id(read, bundle.plan.row.player_id))
      case player {
        None -> Ok(None)
        Some(player) -> {
          let minor = !players.is_adult(player, now)
          use sees <- result.map(case s {
            AsOrg(a) -> org_can_see(read, a.org, player.row.id, now)
            _ -> Ok(False)
          })
          let viewer = viewer_of(s)
          let caps =
            hub_rules.plan_access(viewer, plan_facts(bundle.plan), minor, sees)
          case caps.read {
            True ->
              Some(Seen(
                bundle:,
                player:,
                minor:,
                caps:,
                viewer:,
                org_sees_player: sees,
              ))
            False -> None
          }
        }
      }
    }
  }
}

fn plan_not_found() -> Response {
  respond(404, [
    code("DEVELOPMENT_PLAN_NOT_FOUND"),
    text_field("message", "No such development plan."),
  ])
}

/// The plan, or the 404 a nonexistent one gives.
fn resolve(
  read: Read,
  s: Surface,
  pid: id.DevPlanId,
  now: Int,
  next: fn(Seen) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  use found <- result.try(seen(read, s, pid, now) |> storage)
  case found {
    Some(x) -> next(x)
    None -> store.refuse(plan_not_found())
  }
}

fn require(
  caps: Caps,
  cap: String,
  message: String,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case hub_rules.caps_has(caps, cap) {
    True -> next()
    False ->
      refuse(403, [
        code("DEVELOPMENT_NOT_PERMITTED"),
        text_field("capability", cap),
        text_field("message", message),
      ])
  }
}

fn editable(
  plan: plan_row.Row,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case plan.status {
    plan_row.Archived | plan_row.Completed ->
      refuse(409, [
        code("PLAN_NOT_EDITABLE"),
        #("status", plan_row.status_to_json(plan.status)),
      ])
    _ -> next()
  }
}

// ---------------------------------------------------------------------------------------------------- input

/// A date field: absent or null keeps what is stored, "" clears it.
type DateIn {
  DateAbsent
  DateNull
  DateBlank
  DateAt(Int)
  /// An integer instant beyond JavaScript's safe range: refused, not stored.
  DateUnsafe
}

const max_safe = 9_007_199_254_740_991

const min_safe = -9_007_199_254_740_991

fn date_rule() -> input.Rule(DateIn) {
  let check = input.due_date()
  fn(value: Option(Dynamic)) {
    case value {
      None -> Ok(DateAbsent)
      Some(v) ->
        case dynamic.classify(v) {
          "Nil" | "Null" -> Ok(DateNull)
          _ ->
            case check(v) {
              Ok(None) -> Ok(DateBlank)
              Ok(Some(d)) ->
                case temporal.start(d) {
                  ms if ms > max_safe || ms < min_safe -> Ok(DateUnsafe)
                  ms -> Ok(DateAt(ms))
                }
              Error(e) -> Error(e)
            }
        }
    }
  }
}

/// `body.x ?? existing.x`, then parsed: absent or null keeps `existing`, "" clears.
fn date_or(d: DateIn, existing: Option(Int)) -> Option(Int) {
  case d {
    DateAbsent | DateNull -> existing
    DateBlank | DateUnsafe -> None
    DateAt(ms) -> Some(ms)
  }
}

/// `date_or`, refusing an instant beyond the safe range.
fn date_value(
  d: DateIn,
  existing: Option(Int),
  field: String,
) -> Result(Option(Int), List(#(String, Json))) {
  case d {
    DateUnsafe ->
      Error([
        code("DATE_INVALID"),
        text_field("field", field),
        text_field("detail", field <> " is not a date (out of range)."),
      ])
    _ -> Ok(date_or(d, existing))
  }
}

fn date_sent(d: DateIn) -> Bool {
  d != DateAbsent
}

fn words() -> input.Rule(Option(String)) {
  input.nullish(input.text(any_length))
}

fn opt_id() -> input.Rule(Option(String)) {
  input.nullish(input.text(id_max))
}

fn target_check() -> input.Check(TargetInput) {
  input.object({
    use source_type <- input.field(
      "sourceType",
      input.optional(input.text(any_length)),
    )
    use protocol_id <- input.field(
      "protocolId",
      input.optional(input.text(any_length)),
    )
    use protocol_version <- input.field(
      "protocolVersion",
      input.nullish(input.whole_number(1, any_length)),
    )
    use metric_type <- input.field(
      "metricType",
      input.nullish(input.text(any_length)),
    )
    use operator <- input.field(
      "operator",
      input.optional(input.text(any_length)),
    )
    use value <- input.field("value", input.optional(input.any_number()))
    input.done(TargetInput(
      source_type:,
      protocol_id:,
      protocol_version:,
      metric_type:,
      operator:,
      value:,
    ))
  })
}

/// A goal as a create or an edit sends it. `target` is `None` when the body has no `target` key.
type GoalIn {
  GoalIn(
    title: Option(String),
    description: Option(String),
    category: Option(GoalCategory),
    target_date: DateIn,
    target: Option(Option(TargetInput)),
    origin_objective_id: Option(String),
  )
}

fn goal_fields(with_origin: Bool, next: fn(GoalIn) -> Shape(a)) -> Shape(a) {
  use title <- input.field("title", words())
  use description <- input.field("description", words())
  use category <- input.field(
    "category",
    input.nullish(input.one_of(goal_category.pairs)),
  )
  use target_date <- input.field("targetDate", date_rule())
  use target <- input.field("target", input.clearable(target_check()))
  let rest = fn(origin) {
    next(GoalIn(
      title:,
      description:,
      category:,
      target_date:,
      target:,
      origin_objective_id: origin,
    ))
  }
  case with_origin {
    True -> {
      use origin <- input.field("originObjectiveId", opt_id())
      rest(origin)
    }
    False -> rest(None)
  }
}

fn goal_create_check() -> input.Check(GoalIn) {
  input.object({
    use g <- goal_fields(True)
    input.done(g)
  })
}

type PlanIn {
  PlanIn(
    title: Option(String),
    visibility: Option(String),
    start_date: DateIn,
    next_review_at: DateIn,
    end_date: DateIn,
    template_id: Option(String),
  )
}

fn plan_fields(next: fn(PlanIn) -> Shape(a)) -> Shape(a) {
  use title <- input.field("title", words())
  use visibility <- input.field("visibility", words())
  use start_date <- input.field("startDate", date_rule())
  use next_review_at <- input.field("nextReviewAt", date_rule())
  use end_date <- input.field("endDate", date_rule())
  use template_id <- input.field("templateId", opt_id())
  next(PlanIn(
    title:,
    visibility:,
    start_date:,
    next_review_at:,
    end_date:,
    template_id:,
  ))
}

type PlanCreate {
  PlanCreate(
    fields: PlanIn,
    status: Option(plan_row.Status),
    goals: List(GoalIn),
    origin_objective_id: Option(String),
    player_id: Option(String),
  )
}

fn plan_create_shape(for_someone: Bool) -> Shape(PlanCreate) {
  use fields <- plan_fields
  use status <- input.field(
    "status",
    input.optional(
      input.one_of_these(plan_row.status_pairs, [
        plan_row.Draft,
        plan_row.Active,
      ]),
    ),
  )
  use goals <- input.field(
    "goals",
    input.optional(input.items(goal_create_check(), any_length)),
  )
  use origin <- input.field("originObjectiveId", opt_id())
  let finish = fn(player_id) {
    input.done(PlanCreate(
      fields:,
      status:,
      goals: option.unwrap(goals, []),
      origin_objective_id: origin,
      player_id:,
    ))
  }
  case for_someone {
    True -> {
      use player_id <- input.field(
        "playerId",
        input.optional(input.text(any_length)),
      )
      finish(player_id)
    }
    False -> finish(None)
  }
}

const plan_create_codes = [
  #("status", "PLAN_STATUS_UNKNOWN"),
  #("goals.category", "GOAL_CATEGORY_UNKNOWN"),
  #("goals.target", "TARGET_MALFORMED"),
  #("goals.target.*", "TARGET_MALFORMED"),
]

const goal_codes = [
  #("category", "GOAL_CATEGORY_UNKNOWN"),
  #("target", "TARGET_MALFORMED"),
  #("target.*", "TARGET_MALFORMED"),
]

/// The body read as sent: fields a client may not assert are refused first, then the shape is judged. `next`
/// gets the raw body too, for the revision `rev.expected` reads.
fn body(
  req: Request,
  shape: Shape(a),
  codes: List(#(String, String)),
  next: fn(Dynamic, a) -> Response,
) -> Response {
  use raw, order <- http.json_body_in_order(req)
  let keys = case key_order.keys(order, []) {
    Some(keys) -> keys
    None ->
      decode.run(raw, decode.dict(decode.string, decode.dynamic))
      |> result.map(dict.keys)
      |> result.unwrap([])
      |> list.sort(string.compare)
  }
  case hub_rules.refused_client_fields(keys) {
    [_, ..] as bad ->
      respond(400, [
        code("CLIENT_CANNOT_ASSERT"),
        #("fields", json.array(bad, json.string)),
        text_field(
          "detail",
          "These are derived by ScoutBox from the records themselves and cannot be sent by a client.",
        ),
      ])
    [] ->
      case
        input.parse_in_order(
          shape,
          raw,
          order,
          root: "body",
          codes:,
          default: "FIELD_INVALID",
        )
      {
        Ok(value) -> next(raw, value)
        Error(refusal) -> http.refused(refusal)
      }
  }
}

fn expected_rev(raw: Dynamic, next: fn(rev.Expected) -> Response) -> Response {
  case rev.expected(raw) {
    Ok(e) -> next(e)
    Error(response) -> response
  }
}

// ------------------------------------------------------------------------------------------------ validation

fn bounded(
  raw: Option(String),
  max: Int,
  field: String,
  next: fn(Option(String)) -> Result(b, Fail(Response)),
) -> Result(b, Fail(Response)) {
  case hub_rules.bounded_text(raw, max, field) {
    Ok(v) -> next(v)
    Error(body) -> refuse(400, body)
  }
}

fn or_else(value: Option(a), fallback: Option(a)) -> Option(a) {
  case value {
    Some(_) -> value
    None -> fallback
  }
}

fn visibility_allowed(owner: plan_row.OwnerKind) -> List(PlanVisibility) {
  case owner {
    plan_row.OwnerKindPlayer -> [
      plan_visibility.Private,
      plan_visibility.PlayerGuardian,
      plan_visibility.SharedWithOrg,
    ]
    plan_row.OwnerKindOrg -> [
      plan_visibility.OrgPrivate,
      plan_visibility.PlayerGuardian,
    ]
  }
}

type PlanValues {
  PlanValues(
    title: String,
    visibility: PlanVisibility,
    start: Option(Int),
    next_review_at: Option(Int),
    end: Option(Int),
    template_id: Option(plan_row.TemplateId),
  )
}

fn validate_plan(
  b: PlanIn,
  owner: plan_row.OwnerKind,
  existing: Option(plan_row.Row),
  next: fn(PlanValues) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  let ex_title = option.map(existing, fn(p) { p.title })
  use title <- bounded(or_else(b.title, ex_title), hub_rules.title_max, "title")
  use <- unless(title == None, fn() {
    refuse(400, [
      code("TITLE_REQUIRED"),
      text_field("detail", "A development plan needs a title."),
    ])
  })
  let assert Some(title) = title
  let allowed = visibility_allowed(owner)
  let names = list.map(allowed, plan_visibility.to_string)
  let wanted = case b.visibility, existing {
    Some(v), _ -> v
    None, Some(p) -> plan_visibility.to_string(p.visibility)
    None, None -> list.first(names) |> result.unwrap("")
  }
  case plan_visibility.from_string(wanted) {
    Ok(v) ->
      case list.contains(allowed, v) {
        True -> validate_plan_dates(b, existing, title, v, next)
        False -> visibility_invalid(owner, names, wanted)
      }
    Error(Nil) -> visibility_invalid(owner, names, wanted)
  }
}

fn visibility_invalid(
  owner: plan_row.OwnerKind,
  names: List(String),
  wanted: String,
) -> Result(a, Fail(Response)) {
  refuse(400, [
    code("PLAN_VISIBILITY_INVALID"),
    #("allowed", json.array(names, json.string)),
    text_field("received", wanted),
    text_field("detail", case owner {
      plan_row.OwnerKindOrg ->
        "A club plan is either kept inside the club or made visible to the player. It cannot be shared with another club."
      plan_row.OwnerKindPlayer ->
        "A player’s plan is private, visible to the guardian, or shared with named clubs. It cannot be marked club-private."
    }),
  ])
}

fn interval_invalid(detail: String) -> Result(a, Fail(Response)) {
  refuse(400, [code("DATE_INTERVAL_INVALID"), text_field("detail", detail)])
}

fn validate_plan_dates(
  b: PlanIn,
  existing: Option(plan_row.Row),
  title: String,
  visibility: PlanVisibility,
  next: fn(PlanValues) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  use start <- from_values(date_value(
    b.start_date,
    option.map(existing, fn(p) { p.start_at }),
    "startDate",
  ))
  use next_review <- from_values(date_value(
    b.next_review_at,
    option.then(existing, fn(p) { p.next_review_at }),
    "nextReviewAt",
  ))
  use end <- from_values(date_value(
    b.end_date,
    option.then(existing, fn(p) { p.end_at }),
    "endDate",
  ))
  let before = fn(a: Option(Int), b: Option(Int)) {
    case a, b {
      Some(x), Some(y) -> x < y
      _, _ -> False
    }
  }
  use <- unless(before(end, start), fn() {
    interval_invalid("The end date cannot be before the start date.")
  })
  use <- unless(before(next_review, start), fn() {
    interval_invalid(
      "The next review cannot be scheduled before the plan starts.",
    )
  })
  let template = case b.template_id {
    Some(t) -> Some(t)
    None ->
      option.then(existing, fn(p) { p.template_id })
      |> option.map(plan_row.template_id_to_string)
  }
  case template {
    None -> next(PlanValues(title, visibility, start, next_review, end, None))
    Some(t) ->
      case plan_row.template_id_from_string(t) {
        Ok(tid) ->
          next(PlanValues(title, visibility, start, next_review, end, Some(tid)))
        Error(Nil) ->
          refuse(400, [
            code("TEMPLATE_UNKNOWN"),
            #(
              "allowed",
              json.array(plan_row.template_id_pairs, fn(p) { json.string(p.0) }),
            ),
            text_field("detail", "Unknown template \"" <> t <> "\"."),
          ])
      }
  }
}

type GoalValues {
  GoalValues(
    title: String,
    description: Option(String),
    category: GoalCategory,
    target_date: Option(Int),
    target: Option(Target),
  )
}

fn validate_goal(
  b: GoalIn,
  existing: Option(goal_row.Row),
) -> Result(GoalValues, List(#(String, Json))) {
  use title <- result.try(hub_rules.bounded_text(
    or_else(b.title, option.map(existing, fn(g) { g.title })),
    hub_rules.title_max,
    "title",
  ))
  use title <- result.try(case title {
    Some(t) -> Ok(t)
    None ->
      Error([
        code("TITLE_REQUIRED"),
        text_field("detail", "A development goal needs a title."),
      ])
  })
  use description <- result.try(hub_rules.bounded_text(
    or_else(b.description, option.then(existing, fn(g) { g.description })),
    hub_rules.description_max,
    "description",
  ))
  use category <- result.try(
    case or_else(b.category, option.map(existing, fn(g) { g.category })) {
      Some(c) -> Ok(c)
      None ->
        Error([
          code("GOAL_CATEGORY_UNKNOWN"),
          #(
            "allowed",
            json.array(goal_category.pairs, fn(p) { json.string(p.0) }),
          ),
          #("received", json.null()),
          text_field("detail", "Unknown goal category \"\"."),
        ])
    },
  )
  use target_date <- result.try(date_value(
    b.target_date,
    option.then(existing, fn(g) { g.target_at }),
    "targetDate",
  ))
  use target <- result.map(case b.target {
    None -> Ok(option.then(existing, hub_rules.target_of))
    Some(None) -> Ok(None)
    Some(Some(t)) -> hub_rules.validate_target(t) |> result.map(Some)
  })
  GoalValues(title:, description:, category:, target_date:, target:)
}

// ---------------------------------------------------------------------------------------------------- notify

fn tell(
  tx: Tx,
  to: audience.Audience,
  who: String,
  text: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to:,
    id: who,
    type_: "development",
    text:,
    ref_id: None,
    at: now,
  )
}

/// A minor's notifications go to the guardian.
fn tell_player(
  tx: Tx,
  player: Player,
  text: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  case players.is_adult(player, now), player.row.guardian_id {
    True, _ ->
      tell(tx, audience.Player, id.player_to_string(player.row.id), text, now)
    False, Some(g) ->
      tell(tx, audience.Guardian, id.guardian_to_string(g), text, now)
    False, None -> Ok(Nil)
  }
}

fn tell_org(
  tx: Tx,
  org: id.OrgId,
  text: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use users <- result.try(staff.for_org(
    store.reading(tx),
    org,
    active_only: True,
  ))
  list.try_each(users, fn(u) {
    tell(tx, audience.OrgUser, id.org_user_to_string(u.id), text, now)
  })
}

// ------------------------------------------------------------------------------------------------ bookkeeping

/// The plan's change instant and revision move: something in it changed.
fn touch_plan(
  tx: Tx,
  pid: id.DevPlanId,
  actor: Actor,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use found <- result.try(hub.plan_by_id(store.reading(tx), pid))
  case found {
    Some(p) -> hub.update_plan(tx, bumped(p.row, actor, at))
    None -> store.stale("development plan " <> id.dev_plan_to_string(pid))
  }
}

fn bumped(p: plan_row.Row, actor: Actor, at: Int) -> plan_row.Row {
  plan_row.Row(
    ..p,
    updated_at: at,
    rev: p.rev + 1,
    rev_at: Some(at),
    rev_by_user_id: Some(actor.id),
    rev_by_name: Some(actor.name),
  )
}

fn detail_kind(kind: String) -> Detail {
  Detail(..hub.no_detail, kind: Some(kind))
}

fn detail_move(from: String, to: String) -> Detail {
  Detail(..hub.no_detail, from: Some(from), to: Some(to))
}

// ---------------------------------------------------------------------------------------------------- evidence

/// Who is resolving a link: the viewer, the plan's player, and whether the viewer may see that player at all.
type Looker {
  Looker(viewer: Viewer, player: id.PlayerId, may_see: Bool, now: Int)
}

fn looker(x: Seen, now: Int) -> Looker {
  let pid = x.player.row.id
  Looker(
    viewer: x.viewer,
    player: pid,
    may_see: case x.viewer {
      PlayerSelf(me, _) -> me == pid
      GuardianOf(_, children) -> list.contains(children, pid)
      StaffOf(..) -> x.org_sees_player
    },
    now:,
  )
}

/// A link resolved from its source record. `owned` is whether the record exists and is this player's.
type Ev {
  Ev(
    source_id: String,
    owned: Bool,
    available: Bool,
    reason: Option(String),
    note: String,
    occurred_at: Option(Int),
    simulated: Bool,
    title: Option(String),
    provenance: Option(String),
    label: String,
    fields: List(#(String, Json)),
  )
}

fn unavailable_note(reason: String) -> String {
  case reason {
    "evidence_not_found" -> "This evidence is no longer available."
    "evidence_superseded" -> "This evidence was replaced by a corrected record."
    "evidence_expired" -> "This evidence has passed its validity period."
    "evidence_withdrawn" -> "This evidence was invalidated after review."
    _ -> "This evidence is not available to you."
  }
}

/// No title, date or organisation: an unavailable item must not leak its subject.
fn unavailable(
  source: EvidenceSource,
  source_id: String,
  owned: Bool,
  reason: String,
) -> Ev {
  let label = hub_rules.source_label(source)
  Ev(
    source_id:,
    owned:,
    available: False,
    reason: Some(reason),
    note: unavailable_note(reason),
    occurred_at: None,
    simulated: False,
    title: None,
    provenance: None,
    label:,
    fields: [
      #("sourceType", evidence_source.to_json(source)),
      text_field("sourceId", source_id),
      text_field("sourceLabel", label),
      #("available", json.bool(False)),
      text_field("reason", reason),
      text_field("note", unavailable_note(reason)),
      #("provenance", json.null()),
      #("occurredAt", json.null()),
      #("simulated", json.bool(False)),
    ],
  )
}

fn available(
  source: EvidenceSource,
  source_id: String,
  title: String,
  provenance: String,
  occurred_at: Option(Int),
  simulated: Bool,
  middle: List(#(String, Json)),
  after: List(#(String, Json)),
) -> Ev {
  let label = hub_rules.source_label(source)
  Ev(
    source_id:,
    owned: True,
    available: True,
    reason: None,
    note: "",
    occurred_at:,
    simulated:,
    title: Some(title),
    provenance: Some(provenance),
    label:,
    fields: list.flatten([
      [
        #("sourceType", evidence_source.to_json(source)),
        text_field("sourceId", source_id),
        text_field("sourceLabel", label),
        #("available", json.bool(True)),
        #("reason", json.null()),
        text_field("title", title),
      ],
      middle,
      [
        text_field("provenance", provenance),
        #("occurredAt", json.nullable(occurred_at, json.int)),
        #("simulated", json.bool(simulated)),
      ],
      after,
    ]),
  )
}

fn one_row(
  read: Read,
  sql: String,
  key: sqlight.Value,
  decoder: decode.Decoder(a),
) -> Result(Option(a), Fail(e)) {
  store.one(read, sql, [key], decoder)
  |> result.map(option.from_result)
}

/// Access is checked before existence, so a caller cannot tell "no such id" from "not yours".
fn resolve_source(
  read: Read,
  l: Looker,
  source: EvidenceSource,
  sid: String,
) -> Result(Ev, Fail(e)) {
  let missing = Ok(unavailable(source, sid, False, "evidence_not_found"))
  let staff_org = case l.viewer {
    StaffOf(org, _) -> Some(org)
    _ -> None
  }
  case l.may_see, source {
    False, _ -> Ok(unavailable(source, sid, False, "evidence_not_visible"))
    True, evidence_source.PassportEvidence -> {
      use found <- result.try(one_row(
        read,
        "SELECT " <> evidence_row.columns <> " FROM evidence WHERE id = ?",
        id.scouting_evidence_sql(id.scouting_evidence(sid)),
        evidence_row.decoder(),
      ))
      case found {
        Some(e) if e.player_id == l.player ->
          case e.superseded_by_id, e.expires_at {
            Some(_), _ ->
              Ok(unavailable(source, sid, True, "evidence_superseded"))
            None, Some(exp) if exp < l.now ->
              Ok(unavailable(source, sid, True, "evidence_expired"))
            _, _ ->
              Ok(
                available(
                  source,
                  sid,
                  e.label,
                  case e.verification_status {
                    evidence_row.SelfReported -> "player_submitted"
                    evidence_row.CoachConfirmed -> "verified_coach_confirmed"
                    evidence_row.ClubAssessed -> "verified_club_confirmed"
                  },
                  Some(option.unwrap(e.observed_at, e.recorded_at)),
                  False,
                  [],
                  [],
                ),
              )
          }
        _ -> missing
      }
    }
    // The player sees an assessment only if the club published feedback; other clubs never do.
    True, evidence_source.Assessment -> {
      use found <- result.try(one_row(
        read,
        "SELECT " <> assessment_row.columns <> " FROM assessments WHERE id = ?",
        id.assessment_sql(id.assessment(sid)),
        assessment_row.decoder(),
      ))
      case found {
        Some(a) if a.player_id == l.player -> {
          let owning = staff_org == Some(a.org_id)
          let subject = staff_org == None
          case owning || subject && a.published_feedback_text != None, a.state {
            False, _ ->
              Ok(unavailable(source, sid, True, "evidence_not_visible"))
            True, assessment_row.Draft ->
              Ok(unavailable(source, sid, True, "evidence_not_found"))
            True, _ ->
              Ok(
                available(
                  source,
                  sid,
                  case a.context_fixture {
                    Some(f) if f != "" -> "Assessment — " <> f
                    _ -> "Assessment"
                  },
                  "verified_club_confirmed",
                  Some(option.unwrap(a.submitted_at, a.created_at)),
                  False,
                  [
                    #(
                      "org",
                      json.object([
                        #("id", id.org_json(a.org_id)),
                        #("name", json.null()),
                      ]),
                    ),
                  ],
                  [],
                ),
              )
          }
        }
        _ -> missing
      }
    }
    True, evidence_source.BoxCamSession -> {
      use found <- result.try(one_row(
        read,
        "SELECT " <> session_row.columns <> " FROM box_sessions WHERE id = ?",
        id.box_session_sql(id.box_session(sid)),
        session_row.decoder(),
      ))
      case found {
        Some(s) if s.player_id == l.player ->
          case s.verification_state {
            Some(session_row.VerificationStateInvalidated) ->
              Ok(unavailable(source, sid, True, "evidence_withdrawn"))
            _ ->
              Ok(available(
                source,
                sid,
                s.drill_id,
                "box_cam_observed",
                Some(option.unwrap(
                  s.ended_at,
                  option.unwrap(s.started_at, s.created_at),
                )),
                box_rules.provider(s.provider_id).test_only,
                [],
                // No number or hours: volume is not progress.
                [
                  text_field(
                    "note",
                    "Observed training. ScoutBox recorded activity consistent with the selected drill; it does not measure how much the player improved.",
                  ),
                ],
              ))
          }
        _ -> missing
      }
    }
    True, evidence_source.CombineAttempt -> {
      use found <- result.try(combine.attempt_by_id(
        read,
        id.combine_attempt(sid),
      ))
      case found {
        Some(a) if a.row.player_id == l.player -> {
          let state = combine.live_state(a)
          case state {
            attempt_row.CombineStateInvalidated ->
              Ok(unavailable(source, sid, True, "evidence_withdrawn"))
            _ -> {
              let m = measured(a)
              let proto =
                or_else(
                  combine_rules.protocol(
                    a.row.protocol_id,
                    a.row.protocol_version,
                  ),
                  combine_rules.latest_protocol(a.row.protocol_id),
                )
              let verified = state == attempt_row.CombineVerified
              Ok(
                available(
                  source,
                  sid,
                  option.map(proto, fn(p) { p.title })
                    |> option.unwrap(a.row.protocol_id),
                  case m.test_only, verified {
                    True, _ -> "simulated_demo"
                    False, True -> "combine_verified"
                    False, False -> "box_cam_observed"
                  },
                  Some(option.unwrap(a.row.completed_at, a.row.created_at)),
                  m.test_only,
                  [
                    text_field("protocolId", a.row.protocol_id),
                    #("protocolVersion", json.int(a.row.protocol_version)),
                    #("measuredValue", case verified {
                      True ->
                        json.nullable(a.row.measured_value, json_text.number)
                      False -> json.null()
                    }),
                    text_field("metricUnit", a.row.metric_unit),
                    #("combineState", attempt_row.combine_state_to_json(state)),
                  ],
                  [
                    #(
                      "productionValid",
                      json.bool(hub_rules.production_valid(m)),
                    ),
                  ],
                ),
              )
            }
          }
        }
        _ -> missing
      }
    }
    // A trial report is a recruitment record: only the trial's organisation sees the link, never its content.
    True, evidence_source.TrialReport -> {
      use found <- result.try(one_row(
        read,
        "SELECT " <> trial_row.columns <> " FROM trials WHERE id = ?",
        id.trial_sql(id.trial(sid)),
        trial_row.decoder(),
      ))
      case found {
        Some(t) if t.player_id == l.player ->
          case staff_org == Some(t.org_id), t.status {
            False, _ ->
              Ok(unavailable(source, sid, True, "evidence_not_visible"))
            True, trial_row.Reported ->
              Ok(
                available(
                  source,
                  sid,
                  "Trial report",
                  "verified_club_confirmed",
                  Some(
                    option.then(t.proposed_date, trial_rules.trial_date_ms)
                    |> option.unwrap(t.accepted_at),
                  ),
                  False,
                  [],
                  [],
                ),
              )
            True, _ -> Ok(unavailable(source, sid, True, "evidence_not_found"))
          }
        _ -> missing
      }
    }
  }
}

fn measured(a: combine.Attempt) -> hub_rules.Measured {
  hub_rules.measured_of(
    a.row.id,
    a.row.protocol_id,
    a.row.protocol_version,
    a.row.measured_value,
    a.row.completed_at,
    a.row.combine_state,
    a.session_state,
    a.row.provider_id,
  )
}

/// Whether a link may be made: the record is the player's, visible to the viewer, and currently valid.
/// Evidence that becomes invalid later keeps its link.
fn validate_link(
  read: Read,
  l: Looker,
  source: Option(EvidenceSource),
  sid: Option(String),
) -> Result(Result(#(EvidenceSource, String), List(#(String, Json))), Fail(e)) {
  case source, sid {
    None, _ ->
      Ok(
        Error([
          code("EVIDENCE_SOURCE_UNKNOWN"),
          #(
            "allowed",
            json.array(evidence_source.pairs, fn(p) { json.string(p.0) }),
          ),
          text_field("detail", "Unknown evidence source \"undefined\"."),
        ]),
      )
    Some(_), None | Some(_), Some("") ->
      Ok(
        Error([
          code("EVIDENCE_ID_REQUIRED"),
          text_field(
            "detail",
            "An evidence link needs the id of an existing record.",
          ),
        ]),
      )
    Some(src), Some(sid) -> {
      use ev <- result.map(resolve_source(read, l, src, sid))
      let not_found = Error(evidence_not_found())
      // Missing and not-this-player's get the same answer, so ids cannot be probed.
      case ev.owned, ev.available, ev.reason {
        False, _, _ -> not_found
        True, False, Some("evidence_not_visible") -> not_found
        True, False, reason ->
          Error([
            code("EVIDENCE_NOT_LINKABLE"),
            #("reason", json.nullable(reason, json.string)),
            text_field("detail", ev.note),
          ])
        True, True, _ -> Ok(#(src, sid))
      }
    }
  }
}

fn newest_first(a: Ev, b: Ev) -> order.Order {
  case
    int.compare(
      option.unwrap(b.occurred_at, 0),
      option.unwrap(a.occurred_at, 0),
    )
  {
    order.Eq -> string.compare(a.source_id, b.source_id)
    other -> other
  }
}

// -------------------------------------------------------------------------------------------------- projection

fn actor_json(kind: String, name: Option(String)) -> Json {
  json.object([
    #("kind", json.string(kind)),
    #("name", json.nullable(name, json.string)),
  ])
}

fn origin_json(objective: Option(id.ObjectiveId)) -> Json {
  case objective {
    Some(o) ->
      json.object([
        text_field("kind", "development_objective"),
        #("id", id.objective_json(o)),
      ])
    None -> json.null()
  }
}

fn detail_json(h: history_row.Row) -> Json {
  let fields =
    list.flatten([
      option.map(h.detail_from, fn(v) { [text_field("from", v)] })
        |> option.unwrap([]),
      option.map(h.detail_to, fn(v) { [text_field("to", v)] })
        |> option.unwrap([]),
      option.map(h.detail_visibility, fn(v) {
        [#("visibility", plan_visibility.to_json(v))]
      })
        |> option.unwrap([]),
      option.map(h.detail_owner, fn(v) {
        [#("owner", history_row.detail_owner_to_json(v))]
      })
        |> option.unwrap([]),
      option.map(h.detail_kind, fn(v) { [text_field("kind", v)] })
        |> option.unwrap([]),
      option.map(h.detail_protocol_id, fn(v) { [text_field("protocolId", v)] })
        |> option.unwrap([]),
      option.map(h.detail_note, fn(v) { [#("note", json.bool(v))] })
        |> option.unwrap([]),
    ])
  case fields {
    [] -> json.null()
    _ -> json.object(fields)
  }
}

fn by_kind(k: history_row.ByKind) -> String {
  case k {
    history_row.ByKindPlayer -> "player"
    history_row.Guardian -> "guardian"
    history_row.ByKindOrg -> "org"
  }
}

type TimelineEntry {
  TimelineEntry(at: Int, id: String, json: Json)
}

/// Projected from each record's append-only history; there is no separate event log.
fn timeline(b: Bundle, caps: Caps) -> List(TimelineEntry) {
  let push = fn(
    history: List(history_row.Row),
    kind,
    subject_id: Json,
    title: Json,
  ) {
    list.filter_map(history, fn(h) {
      case hub_rules.timeline_entry(h.action) {
        None -> Error(Nil)
        Some(#(_, True)) if !caps.read_internal -> Error(Nil)
        Some(#(label, internal)) ->
          Ok(TimelineEntry(
            h.at,
            id.dev_event_to_string(h.id),
            json.object([
              #("id", id.dev_event_json(h.id)),
              #("at", json.int(h.at)),
              #("action", history_row.action_to_json(h.action)),
              text_field("label", label),
              #("internal", json.bool(internal)),
              #(
                "subject",
                json.object([
                  text_field("kind", kind),
                  #("id", subject_id),
                  #("title", title),
                ]),
              ),
              text_field("byKind", by_kind(h.by_kind)),
              #("byName", json.nullable(h.by_name, json.string)),
              #("detail", detail_json(h)),
            ]),
          ))
      }
    })
  }
  let p = b.plan
  list.flatten([
    push(
      p.history,
      "plan",
      id.dev_plan_json(p.row.id),
      json.string(p.row.title),
    ),
    list.flat_map(b.goals, fn(g) {
      push(
        g.history,
        "goal",
        id.dev_goal_json(g.row.id),
        json.string(g.row.title),
      )
    }),
    list.flat_map(b.actions, fn(a) {
      push(
        a.history,
        "action",
        id.dev_action_json(a.row.id),
        json.string(a.row.title),
      )
    }),
    list.flat_map(b.reviews, fn(r) {
      push(r.history, "review", id.dev_review_json(r.row.id), json.null())
    }),
  ])
  |> list.sort(fn(x, y) {
    case int.compare(y.at, x.at) {
      order.Eq -> string.compare(y.id, x.id)
      other -> other
    }
  })
}

fn not_finished(s: action_row.Status) -> Bool {
  s != action_row.Done && s != action_row.Cancelled
}

/// The plan projection every route returns. Derived fields are worked out now; counts are never combined.
fn project(
  read: Read,
  x: Seen,
  now: Int,
) -> Result(List(#(String, Json)), Fail(e)) {
  let b = x.bundle
  let l = looker(x, now)
  use attempts <- result.try(combine.attempts_for_player(read, x.player.row.id))
  let attempts = list.map(attempts, measured)
  let resolve_links = fn(holder: fn(link_row.Row) -> Bool) {
    list.filter(b.links, holder)
    |> list.try_map(fn(link) {
      resolve_source(read, l, link.source_type, link.source_id)
      |> result.map(fn(ev) { #(link, ev) })
    })
    |> result.map(list.sort(_, fn(a, b) { newest_first(a.1, b.1) }))
  }
  let link_json = fn(pair: #(link_row.Row, Ev)) {
    json.object([
      #("linkId", id.dev_link_json({ pair.0 }.id)),
      ..{ pair.1 }.fields
    ])
  }
  let goals =
    list.sort(b.goals, fn(a, c) {
      case int.compare(a.row.created_at, c.row.created_at) {
        order.Eq ->
          string.compare(
            id.dev_goal_to_string(a.row.id),
            id.dev_goal_to_string(c.row.id),
          )
        other -> other
      }
    })
  use goal_views <- result.try(
    list.try_map(goals, fn(goal) {
      let g = goal.row
      let me = g.id
      let actions =
        list.filter(b.actions, fn(a) { a.row.goal_id == me })
        |> list.sort(fn(p, q) {
          let due = fn(a: hub.Action) {
            option.unwrap(a.row.due_at, any_length)
          }
          case int.compare(due(p), due(q)) {
            order.Eq ->
              case int.compare(p.row.created_at, q.row.created_at) {
                order.Eq ->
                  string.compare(
                    id.dev_action_to_string(p.row.id),
                    id.dev_action_to_string(q.row.id),
                  )
                other -> other
              }
            other -> other
          }
        })
      let counts =
        hub_rules.action_counts(list.map(actions, fn(a) { a.row.status }))
      use action_views <- result.try(
        list.try_map(actions, fn(action) {
          let a = action.row
          let aid = Some(a.id)
          use evidence <- result.map(
            resolve_links(fn(link) { link.action_id == aid }),
          )
          let due = hub_rules.due_state(a.due_at, now)
          #(
            due.state == "overdue" && not_finished(a.status),
            json.object([
              #("id", id.dev_action_json(a.id)),
              #("goalId", id.dev_goal_json(a.goal_id)),
              #("type", action_row.type_to_json(a.type_)),
              text_field("title", a.title),
              #("status", action_row.status_to_json(a.status)),
              #("dueAt", json.nullable(a.due_at, json.int)),
              // Overdue describes a date and is never attributed to a person.
              #("due", case not_finished(a.status) {
                True -> hub_rules.due_json(due)
                False ->
                  hub_rules.due_json(hub_rules.Due("not_applicable", None))
              }),
              #("assignee", case a.assignee_kind {
                Some(k) ->
                  json.object([
                    #("kind", audience.to_json(k)),
                    #("name", json.nullable(a.assignee_name, json.string)),
                  ])
                None -> json.null()
              }),
              #("completedAt", json.nullable(a.completed_at, json.int)),
              #("evidence", json.array(evidence, link_json)),
              #("createdAt", json.int(a.created_at)),
              #("updatedAt", json.int(a.updated_at)),
            ]),
          )
        }),
      )
      let counts =
        hub_rules.Counts(
          ..counts,
          overdue: list.count(action_views, fn(v) { v.0 }),
        )
      let gid = Some(me)
      use evidence <- result.map(
        resolve_links(fn(link) { link.goal_id == gid }),
      )
      let avail = list.count(evidence, fn(e) { { e.1 }.available })
      let target = hub_rules.target_of(g)
      let blocked = g.status == goal_status.Blocked
      let view =
        json.object([
          #("id", id.dev_goal_json(g.id)),
          #("planId", id.dev_plan_json(g.plan_id)),
          text_field("title", g.title),
          #("description", json.nullable(g.description, json.string)),
          #("category", goal_category.to_json(g.category)),
          text_field("categoryLabel", hub_rules.category_label(g.category)),
          #("status", goal_status.to_json(g.status)),
          #("statusMeaning", case g.status {
            goal_status.Achieved -> json.string(hub_rules.achieved_meaning)
            _ -> json.null()
          }),
          #("blockReason", case blocked {
            True -> json.nullable(g.block_reason, goal_row.block_reason_to_json)
            False -> json.null()
          }),
          #("blockNote", case blocked {
            True -> json.nullable(g.block_note, json.string)
            False -> json.null()
          }),
          #("targetDate", json.nullable(g.target_at, json.int)),
          #(
            "targetDue",
            hub_rules.due_json(hub_rules.due_state(g.target_at, now)),
          ),
          #("target", json.nullable(target, hub_rules.target_json)),
          #("targetState", case target {
            Some(t) ->
              hub_rules.evaluation_json(
                t,
                hub_rules.evaluate_target(t, attempts),
              )
            None -> json.null()
          }),
          #("origin", origin_json(g.origin_objective_id)),
          #(
            "createdBy",
            actor_json(
              goal_row.created_by_kind_to_string(g.created_by_kind),
              g.created_by_name,
            ),
          ),
          #("createdAt", json.int(g.created_at)),
          #("updatedAt", json.int(g.updated_at)),
          #("completedAt", json.nullable(g.completed_at, json.int)),
          ..rev.meta(rev.Rev(g.rev, g.rev_at, g.rev_by_name))
        ])
      let view_rest = [
        #("actions", json.array(action_views, fn(v) { v.1 })),
        #("actionCounts", hub_rules.counts_json(counts)),
        #(
          "completion",
          hub_rules.completion_json(counts.done, counts.total, counts.cancelled),
        ),
        #("evidence", json.array(evidence, link_json)),
        #(
          "evidenceSummary",
          hub_rules.summarise_evidence(
            list.map(evidence, fn(e) { #({ e.1 }.available, { e.1 }.simulated) }),
          ),
        ),
      ]
      #(goal, counts, action_views, avail, view, view_rest)
    }),
  )
  let reviews =
    list.sort(b.reviews, fn(p, q) {
      case int.compare(q.row.reviewed_at, p.row.reviewed_at) {
        order.Eq ->
          string.compare(
            id.dev_review_to_string(q.row.id),
            id.dev_review_to_string(p.row.id),
          )
        other -> other
      }
    })
  let review_views =
    list.filter_map(reviews, fn(r) {
      hub_rules.review_view(r, x.caps) |> option.to_result(Nil)
    })
  let p = b.plan.row
  let #(by_status, active) =
    hub_rules.goal_statuses_json(list.map(goals, fn(g) { g.row.status }))
  let #(due_soon, overdue) =
    list.fold(b.actions, #(0, 0), fn(acc, a) {
      case not_finished(a.row.status) {
        False -> acc
        True ->
          case hub_rules.due_state(a.row.due_at, now).state {
            "overdue" -> #(acc.0, acc.1 + 1)
            "due_today" | "due_soon" -> #(acc.0 + 1, acc.1)
            _ -> acc
          }
      }
    })
  let last_review =
    list.first(reviews) |> result.map(fn(r) { r.row.reviewed_at })
  let owner_kind = plan_row.owner_kind_to_string(p.owner_kind)
  Ok([
    #("policyVersion", json.int(hub_rules.policy_version)),
    text_field("principle", hub_rules.principle),
    text_field("limitation", hub_rules.plan_limitation),
    #(
      "plan",
      json.object(
        list.flatten([
          [
            #("id", id.dev_plan_json(p.id)),
            #("playerId", id.player_json(p.player_id)),
            text_field("playerName", x.player.row.name),
            text_field("title", p.title),
            #("status", plan_row.status_to_json(p.status)),
            #("visibility", plan_visibility.to_json(p.visibility)),
            #(
              "owner",
              json.object([
                text_field("kind", owner_kind),
                #("orgId", json.nullable(p.owner_org_id, id.org_json)),
                #("orgName", json.nullable(p.owner_org_name, json.string)),
              ]),
            ),
            #(
              "createdBy",
              actor_json(
                plan_row.created_by_kind_to_string(p.created_by_kind),
                p.created_by_name,
              ),
            ),
            #("startDate", json.int(p.start_at)),
            #("nextReviewAt", json.nullable(p.next_review_at, json.int)),
            #("endDate", json.nullable(p.end_at, json.int)),
            #(
              "reviewDue",
              hub_rules.due_json(hub_rules.review_due_state(
                p.next_review_at,
                now,
              )),
            ),
            #(
              "templateId",
              json.nullable(p.template_id, plan_row.template_id_to_json),
            ),
            #("origin", origin_json(p.origin_objective_id)),
          ],
          // Shown only to those who may change it.
          case x.caps.manage {
            True -> [
              #("sharedWithOrgIds", json.array(b.plan.shared_with, id.org_json)),
            ]
            False -> []
          },
          [
            #("sharedWithOrgCount", json.int(list.length(b.plan.shared_with))),
            #("createdAt", json.int(p.created_at)),
            #("updatedAt", json.int(p.updated_at)),
            #("completedAt", json.nullable(p.completed_at, json.int)),
            #("archivedAt", json.nullable(p.archived_at, json.int)),
          ],
          rev.meta(rev.Rev(p.rev, p.rev_at, p.rev_by_name)),
        ]),
      ),
    ),
    #(
      "summary",
      json.object([
        #("goalsByStatus", by_status),
        #("activeGoals", json.int(active)),
        #("actionsDue", json.int(due_soon)),
        #("actionsOverdue", json.int(overdue)),
        #(
          "linkedEvidenceAvailable",
          json.int(int.sum(list.map(goal_views, fn(v) { v.3 }))),
        ),
        #("lastReviewAt", http.nullable(last_review, json.int)),
        #("nextReviewAt", json.nullable(p.next_review_at, json.int)),
        #(
          "reviewDue",
          hub_rules.due_json(hub_rules.review_due_state(p.next_review_at, now)),
        ),
        text_field(
          "note",
          "These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.",
        ),
      ]),
    ),
    #("goals", json.array(goal_views, fn(v) { join_object(v.4, v.5) })),
    #("reviews", json.preprocessed_array(review_views)),
    #(
      "timeline",
      json.preprocessed_array(list.map(timeline(b, x.caps), fn(e) { e.json })),
    ),
    #("access", hub_rules.caps_json(x.caps)),
    #(
      "neverBuilt",
      json.object([
        text_field(
          "note",
          "These do not exist in ScoutBox and are not planned.",
        ),
        #(
          "names",
          json.array(hub_rules.forbidden_development_names, json.string),
        ),
        text_field(
          "reason",
          "A single figure would invite a decision about a person that the figure cannot support. Development here is objective-specific, or it is nothing.",
        ),
      ]),
    ),
  ])
}

/// An object's text with more fields after its own.
fn join_object(head: Json, tail: List(#(String, Json))) -> Json {
  let a = json.to_string(head)
  let b = json.to_string(json.object(tail))
  case tail {
    [] -> head
    _ ->
      json_text.parse(string.drop_end(a, 1) <> "," <> string.drop_start(b, 1))
      |> result.unwrap(head)
  }
}

/// The plan as this viewer sees it now, re-read.
fn plan_answer(
  read: Read,
  s: Surface,
  pid: id.DevPlanId,
  status: Int,
  extra: List(#(String, Json)),
) -> Result(Response, Fail(Response)) {
  let now = clock.now_ms()
  use x <- resolve(read, s, pid, now)
  use fields <- result.map(project(read, x, now) |> storage)
  respond(status, list.append(fields, extra))
}

fn idempotent(
  tx: Tx,
  s: Surface,
  pid: id.DevPlanId,
  counted: Bool,
) -> Result(Response, Fail(Response)) {
  use _ <- result.try(case counted {
    True -> count(tx, "development_idempotent_retries")
    False -> Ok(Nil)
  })
  plan_answer(store.reading(tx), s, pid, 200, [#("idempotent", json.bool(True))])
}

// ------------------------------------------------------------------------------------------------------ routes

/// `/development/...` on the player, guardian or organisation router.
pub fn handle(
  ctx: Ctx,
  req: Request,
  s: Surface,
  path: List(String),
) -> Response {
  let m = req.method
  case path, m {
    ["catalogue"], method.Get -> http.json(200, hub_rules.catalogue())
    ["linkable-evidence"], method.Get -> linkable(ctx, req, s)
    ["plans"], method.Get -> list_plans(ctx, req, s)
    ["plans"], method.Post -> create_plan(ctx, req, s)
    ["plans", pid], method.Get -> get_plan(ctx, s, id.dev_plan(pid))
    ["plans", pid], method.Patch -> edit_plan(ctx, req, s, id.dev_plan(pid))
    ["plans", pid, "status"], method.Post ->
      plan_status(ctx, req, s, id.dev_plan(pid))
    ["plans", pid, "share"], method.Post ->
      share_plan(ctx, req, s, id.dev_plan(pid))
    ["plans", pid, "goals"], method.Post ->
      create_goal(ctx, req, s, id.dev_plan(pid))
    ["goals", gid], method.Patch -> edit_goal(ctx, req, s, id.dev_goal(gid))
    ["goals", gid, "actions"], method.Post ->
      create_action(ctx, req, s, id.dev_goal(gid))
    ["actions", aid], method.Patch ->
      edit_action(ctx, req, s, id.dev_action(aid))
    ["goals", gid, "evidence"], method.Post ->
      link_evidence(ctx, req, s, GoalHolder(id.dev_goal(gid)))
    ["actions", aid, "evidence"], method.Post ->
      link_evidence(ctx, req, s, ActionHolder(id.dev_action(aid)))
    ["evidence", lid], method.Delete -> unlink(ctx, s, id.dev_link(lid))
    ["plans", pid, "reviews"], method.Get ->
      list_reviews(ctx, req, s, id.dev_plan(pid))
    ["plans", pid, "reviews"], method.Post ->
      create_review(ctx, req, s, id.dev_plan(pid))
    ["reviews", rid, "share"], method.Post ->
      share_review(ctx, req, s, id.dev_review(rid))
    ["plans", pid, "history"], method.Get ->
      history(ctx, req, s, id.dev_plan(pid))
    _, _ -> http.error(404, "NOT_FOUND")
  }
}

fn ordered(response: Response, ordering: String) -> Response {
  wisp.set_header(response, "x-scoutbox-ordering", ordering)
}

// ---- linkable evidence

/// Built with the links' own resolver, so nothing offered resolves as unavailable.
fn linkable(ctx: Ctx, req: Request, s: Surface) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.optional(input.text(id_max)))
    input.done(player_id)
  }
  use q <- http.query(req, shape, [])
  let now = clock.now_ms()
  let viewer = viewer_of(s)
  let wanted = case q, viewer {
    Some(p), _ -> p
    None, PlayerSelf(me, _) -> id.player_to_string(me)
    None, _ -> ""
  }
  use r <- read(ctx)
  let not_found = fn() { refuse(404, [code("PLAYER_NOT_FOUND")]) }
  use found <- result.try(players.by_id(r, id.player(wanted)) |> storage)
  use player <- unless_none(found, not_found)
  let pid = player.row.id
  use sees <- result.try(case s {
    AsOrg(a) -> org_can_see(r, a.org, pid, now) |> storage
    _ -> Ok(False)
  })
  let may_see = case viewer {
    PlayerSelf(me, _) -> me == pid
    GuardianOf(_, children) -> list.contains(children, pid)
    StaffOf(..) -> sees
  }
  use <- unless(!may_see, not_found)
  let l = Looker(viewer:, player: pid, may_see:, now:)
  let ids = fn(sql, decoder) {
    store.query(r, sql, [id.player_sql(pid)], decode.at([0], decoder))
    |> storage
  }
  use evidence <- result.try(ids(
    "SELECT id FROM evidence WHERE player_id = ? ORDER BY rowid",
    decode.string,
  ))
  use assessments <- result.try(ids(
    "SELECT id FROM assessments WHERE player_id = ? ORDER BY rowid",
    decode.string,
  ))
  use sessions <- result.try(ids(
    "SELECT id FROM box_sessions WHERE player_id = ? ORDER BY rowid",
    decode.string,
  ))
  use attempts <- result.try(ids(
    "SELECT id FROM combine_attempts WHERE player_id = ? ORDER BY rowid DESC",
    decode.string,
  ))
  use trials <- result.try(ids(
    "SELECT id FROM trials WHERE player_id = ? ORDER BY rowid",
    decode.string,
  ))
  let candidates =
    list.flatten([
      list.map(evidence, fn(x) { #(evidence_source.PassportEvidence, x) }),
      list.map(assessments, fn(x) { #(evidence_source.Assessment, x) }),
      list.map(sessions, fn(x) { #(evidence_source.BoxCamSession, x) }),
      list.map(attempts, fn(x) { #(evidence_source.CombineAttempt, x) }),
      list.map(trials, fn(x) { #(evidence_source.TrialReport, x) }),
    ])
  use items <- result.try(
    list.try_map(candidates, fn(c) {
      use ok <- result.try(validate_link(r, l, Some(c.0), Some(c.1)))
      case ok {
        Error(_) -> Ok(Error(Nil))
        Ok(_) ->
          resolve_source(r, l, c.0, c.1)
          |> result.map(fn(ev) { Ok(#(c.0, ev)) })
      }
    })
    |> storage,
  )
  let items =
    list.filter_map(items, fn(x) { x })
    |> list.sort(fn(a, b) { newest_first(a.1, b.1) })
    |> list.take(hub_rules.list_page_max)
  Ok(
    respond(200, [
      #(
        "items",
        json.array(items, fn(pair) {
          let #(src, ev) = pair
          json.object([
            #("sourceType", evidence_source.to_json(src)),
            text_field("sourceId", ev.source_id),
            text_field("sourceLabel", ev.label),
            text_field("title", option.unwrap(ev.title, ev.label)),
            #("provenance", json.nullable(ev.provenance, json.string)),
            #("occurredAt", json.nullable(ev.occurred_at, json.int)),
            #("simulated", json.bool(ev.simulated)),
          ])
        }),
      ),
      text_field(
        "note",
        "Canonical records you can cite. Linking one stores a reference — the evidence itself stays where it lives, and is read live every time.",
      ),
    ])
    |> ordered("newest_first_then_id"),
  )
}

fn unless_none(
  value: Option(a),
  otherwise: fn() -> Result(b, Fail(Response)),
  next: fn(a) -> Result(b, Fail(Response)),
) -> Result(b, Fail(Response)) {
  case value {
    Some(v) -> next(v)
    None -> otherwise()
  }
}

// ---- list

type PlansQuery {
  PlansQuery(
    page: paging.Query,
    status: Option(plan_row.Status),
    player_id: Option(String),
  )
}

/// The access rule is applied in code, so the page is cut from the filtered list and the total counts only plans
/// this viewer may read.
fn list_plans(ctx: Ctx, req: Request, s: Surface) -> Response {
  let shape = {
    use limit <- input.field("limit", input.optional(input.text(any_length)))
    use cursor <- input.field("cursor", input.optional(input.text(any_length)))
    use status <- input.field(
      "status",
      input.optional(input.one_of(plan_row.status_pairs)),
    )
    use player_id <- input.field("playerId", opt_id())
    input.done(PlansQuery(paging.Query(limit:, cursor:), status, player_id))
  }
  use q <- http.query(req, shape, [
    #("status", "PLAN_STATUS_UNKNOWN"),
    #("limit", "PAGE_LIMIT_INVALID"),
  ])
  case paging.read(q.page, [paging.IntKind, paging.TextKind]) {
    Error(e) -> box_training.page_refusal(e)
    Ok(page) -> {
      let now = clock.now_ms()
      let filter = case q.player_id {
        Some("") -> None
        other -> other
      }
      use r <- read(ctx)
      use candidates <- result.try(
        case s {
          AsPlayer(p) -> {
            let me = id.player_to_string(p.player.row.id)
            case filter {
              Some(f) if f != me -> Ok([])
              _ -> hub.for_players(r, [p.player.row.id], q.status)
            }
          }
          AsGuardian(g) ->
            hub.for_players(
              r,
              list.filter(g.child_ids, fn(c) {
                case filter {
                  Some(f) -> id.player_to_string(c) == f
                  None -> True
                }
              }),
              q.status,
            )
          AsOrg(a) ->
            hub.for_org(r, a.org.id, option.map(filter, id.player), q.status)
        }
        |> storage,
      )
      use readable <- result.try(
        list.try_map(candidates, fn(plan) {
          use found <- result.try(players.by_id(r, plan.row.player_id))
          case found {
            None -> Ok(Error(Nil))
            Some(player) -> {
              let minor = !players.is_adult(player, now)
              use sees <- result.map(case s {
                AsOrg(a) -> org_can_see(r, a.org, player.row.id, now)
                _ -> Ok(False)
              })
              case
                hub_rules.plan_access(
                  viewer_of(s),
                  plan_facts(plan),
                  minor,
                  sees,
                ).read
              {
                True -> Ok(#(plan, player))
                False -> Error(Nil)
              }
            }
          }
        })
        |> storage,
      )
      let readable = list.filter_map(readable, fn(x) { x })
      let #(items, next_cursor) =
        box_training.page_newest_first(page, readable, fn(pair) {
          let p = { pair.0 }.row
          #(p.updated_at, id.dev_plan_to_string(p.id))
        })
      use views <- result.try(
        list.try_map(items, fn(pair) {
          let #(plan, player) = pair
          let p = plan.row
          use #(goals, actions) <- result.map(hub.list_counts(r, p.id))
          let #(by_status, active) = hub_rules.goal_statuses_json(goals)
          let overdue =
            list.count(actions, fn(a) {
              not_finished(a.0)
              && hub_rules.due_state(a.1, now).state == "overdue"
            })
          json.object([
            #("id", id.dev_plan_json(p.id)),
            #("playerId", id.player_json(p.player_id)),
            text_field("playerName", player.row.name),
            text_field("title", p.title),
            #("status", plan_row.status_to_json(p.status)),
            #("visibility", plan_visibility.to_json(p.visibility)),
            #(
              "owner",
              json.object([
                #("kind", plan_row.owner_kind_to_json(p.owner_kind)),
                #("orgId", json.nullable(p.owner_org_id, id.org_json)),
              ]),
            ),
            #("goalsByStatus", by_status),
            #("activeGoals", json.int(active)),
            #("actionsOverdue", json.int(overdue)),
            #("nextReviewAt", json.nullable(p.next_review_at, json.int)),
            #(
              "reviewDue",
              hub_rules.due_json(hub_rules.review_due_state(
                p.next_review_at,
                now,
              )),
            ),
            #("updatedAt", json.int(p.updated_at)),
            #("rev", json.int(p.rev)),
          ])
        })
        |> storage,
      )
      Ok(
        respond(200, [
          #("total", json.int(list.length(readable))),
          #("items", json.preprocessed_array(views)),
          #("nextCursor", json.nullable(next_cursor, json.string)),
          text_field(
            "note",
            "Plans you can see. ScoutBox does not report how many other plans exist.",
          ),
        ])
        |> ordered("recently_updated_then_id"),
      )
    }
  }
}

// ---- create

fn origin_objective(
  read: Read,
  raw: Option(String),
  player: id.PlayerId,
  next: fn(Option(id.ObjectiveId)) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case raw {
    None | Some("") -> next(None)
    Some(oid) -> {
      use found <- result.try(
        store.one(
          read,
          "SELECT "
            <> objective_row.columns
            <> " FROM dev_objectives WHERE id = ?",
          [id.objective_sql(id.objective(oid))],
          objective_row.decoder(),
        )
        |> storage,
      )
      case found {
        Ok(o) if o.player_id == player -> next(Some(o.id))
        _ ->
          refuse(404, [
            code("DEVELOPMENT_OBJECTIVE_NOT_FOUND"),
            text_field(
              "detail",
              "No such development objective exists for this player.",
            ),
          ])
      }
    }
  }
}

/// The player a create names, as this surface may name one.
fn subject(
  read: Read,
  s: Surface,
  named: Option(String),
  now: Int,
  next: fn(Player) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case s {
    AsPlayer(p) ->
      case p.minor {
        // Safeguarding: a minor's records are created by their guardian.
        True ->
          refuse(403, [
            code("GUARDIAN_MANAGED"),
            text_field(
              "message",
              "A guardian creates and manages development plans for a player under 18. You can read the plan here.",
            ),
          ])
        False -> next(p.player)
      }
    AsGuardian(g) -> {
      let pid = id.player(option.unwrap(named, ""))
      use found <- result.try(players.by_id(read, pid) |> storage)
      case found {
        Some(player) ->
          case list.contains(g.child_ids, player.row.id) {
            False -> guardian_not_found()
            True ->
              case players.is_adult(player, now) {
                True ->
                  refuse(403, [
                    code("PLAYER_IS_ADULT"),
                    text_field(
                      "message",
                      "This player manages their own development plans.",
                    ),
                  ])
                False -> next(player)
              }
          }
        None -> guardian_not_found()
      }
    }
    AsOrg(a) -> {
      let pid = id.player(option.unwrap(named, ""))
      use found <- result.try(players.by_id(read, pid) |> storage)
      // Not visible is not found, so plan creation cannot probe for players.
      let refused = fn() {
        refuse(404, [
          code("PLAYER_NOT_FOUND"),
          text_field(
            "message",
            "No such player is available to your organisation.",
          ),
        ])
      }
      case found {
        Some(player) -> {
          use sees <- result.try(
            org_can_see(read, a.org, player.row.id, now) |> storage,
          )
          case sees {
            True -> next(player)
            False -> refused()
          }
        }
        None -> refused()
      }
    }
  }
}

fn guardian_not_found() -> Result(a, Fail(Response)) {
  refuse(404, [
    code("PLAYER_NOT_FOUND"),
    text_field("message", "No such player is in your care."),
  ])
}

fn new_goal(
  tx: Tx,
  plan: plan_row.Row,
  v: GoalValues,
  origin: Option(id.ObjectiveId),
  actor: Actor,
  at: Int,
) -> Result(goal_row.Row, Fail(e)) {
  use gid <- result.try(id.next_dev_goal(tx))
  let g =
    goal_row.Row(
      ..goal_row.new(
        id: gid,
        plan_id: plan.id,
        player_id: plan.player_id,
        title: v.title,
        category: v.category,
        status: goal_status.NotStarted,
        created_by_kind: hub.goal_creator_kind(actor),
        created_by_id: actor.id,
        created_at: at,
        updated_at: at,
        rev: 1,
      ),
      description: v.description,
      target_at: v.target_date,
      origin_objective_id: origin,
      created_by_name: Some(actor.name),
      rev_at: Some(at),
      rev_by_user_id: Some(actor.id),
      rev_by_name: Some(actor.name),
    )
    |> hub_rules.with_target(v.target)
  use _ <- result.try(hub.insert_goal(tx, g))
  let owner = hub.OfGoal(plan.id, gid)
  let stamp = clock.now_ms()
  use _ <- result.try(hub.record(
    tx,
    owner,
    actor,
    history_row.GoalCreated,
    detail_kind(goal_category.to_string(v.category)),
    stamp,
  ))
  use _ <- result.map(case v.target {
    Some(t) ->
      hub.record(
        tx,
        owner,
        actor,
        history_row.GoalTargetSet,
        Detail(..hub.no_detail, protocol_id: Some(t.protocol_id)),
        stamp,
      )
    None -> Ok(Nil)
  })
  g
}

fn create_plan(ctx: Ctx, req: Request, s: Surface) -> Response {
  let for_someone = case s {
    AsPlayer(_) -> False
    _ -> True
  }
  use _, b <- body(req, plan_create_shape(for_someone), plan_create_codes)
  let owner = case s {
    AsOrg(_) -> plan_row.OwnerKindOrg
    _ -> plan_row.OwnerKindPlayer
  }
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use <- limited(ctx, s, limits.DevelopmentPlanWrite)
  use player <- subject(r, s, b.player_id, now)
  use v <- validate_plan(b.fields, owner, None)
  let wants_active = b.status == Some(plan_row.Active)
  use <- unless(wants_active && b.goals == [], fn() {
    refuse(400, [
      code("ACTIVE_PLAN_NEEDS_A_GOAL"),
      text_field(
        "detail",
        "An active plan needs at least one goal. Save it as a draft if you are not ready.",
      ),
    ])
  })
  use <- unless(list.length(b.goals) > hub_rules.goals_per_plan, fn() {
    refuse(400, [
      code("TOO_MANY_GOALS"),
      #("max", json.int(hub_rules.goals_per_plan)),
    ])
  })
  let owner_org = case s {
    AsOrg(a) -> Some(a.org)
    _ -> None
  }
  let owner_org_id = option.map(owner_org, fn(o) { o.id })
  use open <- result.try(
    hub.open_count(r, player.row.id, owner, owner_org_id) |> storage,
  )
  use <- unless(open >= hub_rules.active_plans_per_owner, fn() {
    refuse(400, [
      code("TOO_MANY_ACTIVE_PLANS"),
      #("max", json.int(hub_rules.active_plans_per_owner)),
      text_field("detail", "Complete or archive an existing plan first."),
    ])
  })
  let actor = actor_of(s)
  let at = now
  use dup <- result.try(
    hub.recent_create(
      r,
      player.row.id,
      v.title,
      actor.id,
      owner,
      owner_org_id,
      at - idempotency_window_ms,
    )
    |> storage,
  )
  case dup {
    Some(pid) -> idempotent(tx, s, pid, True)
    None -> {
      use prepared <- result.try(
        list.try_map(b.goals, fn(g) {
          validate_goal(g, None) |> result.map_error(fn(e) { respond(400, e) })
        })
        |> result.map_error(store.Refuse),
      )
      // Records where the idea came from; the objective itself is untouched.
      use origin <- origin_objective(r, b.origin_objective_id, player.row.id)
      use pid <- result.try(id.next_dev_plan(tx) |> storage)
      let row =
        plan_row.Row(
          ..plan_row.new(
            id: pid,
            player_id: player.row.id,
            owner_kind: owner,
            created_by_kind: hub.plan_creator_kind(actor),
            created_by_id: actor.id,
            title: v.title,
            status: case wants_active {
              True -> plan_row.Active
              False -> plan_row.Draft
            },
            visibility: v.visibility,
            start_at: option.unwrap(v.start, at),
            created_at: at,
            updated_at: at,
            rev: 1,
          ),
          owner_org_id:,
          owner_org_name: option.map(owner_org, fn(o) { o.name }),
          created_by_name: Some(actor.name),
          next_review_at: v.next_review_at,
          end_at: v.end,
          template_id: v.template_id,
          origin_objective_id: origin,
          rev_at: Some(at),
          rev_by_user_id: Some(actor.id),
          rev_by_name: Some(actor.name),
        )
      use _ <- result.try(hub.insert_plan(tx, row) |> storage)
      let stamp = clock.now_ms()
      use _ <- result.try(
        hub.record(
          tx,
          hub.OfPlan(pid),
          actor,
          history_row.PlanCreated,
          Detail(
            ..hub.no_detail,
            visibility: Some(v.visibility),
            owner: Some(case owner {
              plan_row.OwnerKindOrg -> history_row.DetailOwnerOrg
              plan_row.OwnerKindPlayer -> history_row.DetailOwnerPlayer
            }),
          ),
          stamp,
        )
        |> storage,
      )
      use _ <- result.try(
        case wants_active {
          True ->
            hub.record(
              tx,
              hub.OfPlan(pid),
              actor,
              history_row.PlanActivated,
              hub.no_detail,
              stamp,
            )
          False -> Ok(Nil)
        }
        |> storage,
      )
      use _ <- result.try(
        list.try_each(prepared, fn(g) { new_goal(tx, row, g, None, actor, at) })
        |> storage,
      )
      use _ <- result.try(
        case owner_org, v.visibility {
          Some(org), plan_visibility.PlayerGuardian ->
            tell_player(
              tx,
              player,
              org.name <> " shared a development plan with you: " <> v.title,
              now,
            )
          _, _ -> Ok(Nil)
        }
        |> storage,
      )
      use _ <- result.try(count(tx, "development_plan_created") |> storage)
      plan_answer(r, s, pid, 201, [])
    }
  }
}

// ---- read

fn get_plan(ctx: Ctx, s: Surface, pid: id.DevPlanId) -> Response {
  use r <- read(ctx)
  use response <- result.map(plan_answer(r, s, pid, 200, []))
  ordered(response, "created_then_id")
}

// ---- edit

fn plan_conflict(p: plan_row.Row) -> List(#(String, Json)) {
  [
    #("planId", id.dev_plan_json(p.id)),
    #("status", plan_row.status_to_json(p.status)),
  ]
}

fn guard_rev(
  expected: rev.Expected,
  current: rev.Rev,
  code: String,
  fields: List(#(String, Json)),
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case rev.check(expected, current, code, fields) {
    Ok(Nil) -> next()
    Error(conflict) -> store.refuse(conflict)
  }
}

fn edit_plan(
  ctx: Ctx,
  req: Request,
  s: Surface,
  pid: id.DevPlanId,
) -> Response {
  let shape = {
    use fields <- plan_fields
    use <- rev.fields
    input.done(fields)
  }
  use raw, b <- body(req, shape, rev.codes)
  use expected <- expected_rev(raw)
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let plan = x.bundle.plan
  let p = plan.row
  use <- require(x.caps, "manage", "You cannot change this plan.")
  use <- unless(p.status == plan_row.Archived, fn() {
    refuse(409, [
      code("PLAN_ARCHIVED"),
      text_field(
        "detail",
        "An archived plan is a historical record and cannot be changed. Its history is preserved.",
      ),
    ])
  })
  use <- limited(ctx, s, limits.DevelopmentPlanWrite)
  use <- guard_rev(
    expected,
    rev.Rev(p.rev, p.rev_at, p.rev_by_name),
    "DEVELOPMENT_PLAN_VERSION_CONFLICT",
    plan_conflict(p),
  )
  use v <- validate_plan(b, p.owner_kind, Some(p))
  let actor = actor_of(s)
  let at = clock.now_ms()
  let changed = v.visibility != p.visibility
  // Narrowing a player-owned plan's visibility withdraws every share.
  let withdrawn =
    changed
    && p.owner_kind == plan_row.OwnerKindPlayer
    && v.visibility != plan_visibility.SharedWithOrg
    && plan.shared_with != []
  let row =
    plan_row.Row(
      ..p,
      title: v.title,
      visibility: v.visibility,
      start_at: option.unwrap(v.start, p.start_at),
      next_review_at: v.next_review_at,
      end_at: v.end,
      template_id: v.template_id,
    )
    |> bumped(actor, at)
  use _ <- result.try(hub.update_plan(tx, row) |> storage)
  use _ <- result.try(
    case changed {
      True ->
        hub.record(
          tx,
          hub.OfPlan(pid),
          actor,
          history_row.PlanVisibilityChanged,
          Detail(
            ..hub.no_detail,
            to: Some(plan_visibility.to_string(v.visibility)),
          ),
          clock.now_ms(),
        )
      False -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(
    case withdrawn {
      True -> {
        use _ <- result.try(hub.set_shares(tx, pid, []))
        hub.record(
          tx,
          hub.OfPlan(pid),
          actor,
          history_row.PlanUnshared,
          hub.no_detail,
          clock.now_ms(),
        )
      }
      False -> Ok(Nil)
    }
    |> storage,
  )
  plan_answer(r, s, pid, 200, [])
}

// ---- status

fn plan_status(
  ctx: Ctx,
  req: Request,
  s: Surface,
  pid: id.DevPlanId,
) -> Response {
  let shape = {
    use status <- input.field(
      "status",
      input.required(input.one_of(plan_row.status_pairs)),
    )
    use <- rev.fields
    input.done(status)
  }
  use raw, to <- body(req, shape, [
    #("status", "PLAN_STATUS_UNKNOWN"),
    ..rev.codes
  ])
  use expected <- expected_rev(raw)
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let p = x.bundle.plan.row
  use <- require(x.caps, "manage", "You cannot change this plan’s status.")
  use <- limited(ctx, s, limits.DevelopmentPlanWrite)
  let from = plan_row.status_to_string(p.status)
  let to_s = plan_row.status_to_string(to)
  use <- unless(
    !hub_rules.allowed(hub_rules.plan_transitions, p.status, to),
    fn() {
      refuse(409, [
        code("PLAN_TRANSITION_INVALID"),
        text_field("from", from),
        text_field("to", to_s),
        #(
          "allowed",
          json.array(
            hub_rules.plan_transitions(p.status),
            plan_row.status_to_json,
          ),
        ),
        text_field(
          "detail",
          "A " <> from <> " plan cannot become " <> to_s <> ".",
        ),
      ])
    },
  )
  use <- unless(to == plan_row.Active && x.bundle.goals == [], fn() {
    refuse(400, [
      code("ACTIVE_PLAN_NEEDS_A_GOAL"),
      text_field("detail", "An active plan needs at least one goal."),
    ])
  })
  use <- guard_rev(
    expected,
    rev.Rev(p.rev, p.rev_at, p.rev_by_name),
    "DEVELOPMENT_PLAN_VERSION_CONFLICT",
    plan_conflict(p),
  )
  let actor = actor_of(s)
  let at = clock.now_ms()
  let row =
    plan_row.Row(
      ..p,
      status: to,
      completed_at: case to {
        plan_row.Completed -> Some(at)
        _ -> p.completed_at
      },
      archived_at: case to {
        plan_row.Archived -> Some(at)
        _ -> p.archived_at
      },
    )
    |> bumped(actor, at)
  use _ <- result.try(hub.update_plan(tx, row) |> storage)
  use _ <- result.try(
    hub.record(
      tx,
      hub.OfPlan(pid),
      actor,
      case to {
        plan_row.Active -> history_row.PlanActivated
        plan_row.Paused -> history_row.PlanPaused
        plan_row.Completed -> history_row.PlanCompleted
        plan_row.Archived -> history_row.PlanArchived
        plan_row.Draft -> history_row.PlanUpdated
      },
      detail_move(from, to_s),
      clock.now_ms(),
    )
    |> storage,
  )
  plan_answer(r, s, pid, 200, [])
}

// ---- share with a named organisation (player-owned plans only)

type ShareIn {
  ShareIn(org_id: String, revoke: Option(Bool))
}

fn share_plan(
  ctx: Ctx,
  req: Request,
  s: Surface,
  pid: id.DevPlanId,
) -> Response {
  let shape = {
    use org_id <- input.field("orgId", input.required(input.text(id_max)))
    use revoke <- input.field("revoke", input.optional(input.boolean()))
    input.done(ShareIn(org_id, revoke))
  }
  use _, b <- body(req, shape, [])
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let plan = x.bundle.plan
  let p = plan.row
  use <- require(
    x.caps,
    "manage",
    "You cannot change who this plan is shared with.",
  )
  use <- unless(p.owner_kind == plan_row.OwnerKindOrg, fn() {
    refuse(400, [
      code("SHARE_NOT_APPLICABLE"),
      text_field(
        "detail",
        "A club plan is shared with the player by changing its visibility, not by sharing it with another club.",
      ),
    ])
  })
  use <- limited(ctx, s, limits.DevelopmentPlanWrite)
  let oid = id.org(b.org_id)
  use org <- result.try(orgs.by_id(r, oid) |> storage)
  use sees <- result.try(
    case org {
      Some(o) -> org_can_see(r, o, p.player_id, now)
      None -> Ok(False)
    }
    |> storage,
  )
  // Sharing with a club that cannot see the player would grant access the visibility rules deny.
  use <- unless(!sees, fn() {
    refuse(404, [
      code("ORG_NOT_FOUND"),
      text_field("detail", "No such organisation is available to share with."),
    ])
  })
  let actor = actor_of(s)
  let at = clock.now_ms()
  let shared = list.contains(plan.shared_with, oid)
  case b.revoke == Some(True) {
    True ->
      case shared {
        False -> idempotent(tx, s, pid, False)
        True -> {
          use _ <- result.try(
            hub.set_shares(
              tx,
              pid,
              list.filter(plan.shared_with, fn(o) { o != oid }),
            )
            |> storage,
          )
          use _ <- result.try(
            hub.update_plan(tx, bumped(p, actor, at)) |> storage,
          )
          use _ <- result.try(
            hub.record(
              tx,
              hub.OfPlan(pid),
              actor,
              history_row.PlanUnshared,
              detail_kind("org"),
              clock.now_ms(),
            )
            |> storage,
          )
          plan_answer(r, s, pid, 200, [])
        }
      }
    False -> {
      use <- unless(p.visibility != plan_visibility.SharedWithOrg, fn() {
        refuse(400, [
          code("PLAN_NOT_SHAREABLE"),
          text_field(
            "detail",
            "Set this plan’s visibility to “shared with clubs” before choosing which clubs can read it.",
          ),
        ])
      })
      case shared {
        True -> idempotent(tx, s, pid, True)
        False -> {
          use _ <- result.try(
            hub.set_shares(tx, pid, list.append(plan.shared_with, [oid]))
            |> storage,
          )
          use _ <- result.try(
            hub.update_plan(tx, bumped(p, actor, at)) |> storage,
          )
          use _ <- result.try(
            hub.record(
              tx,
              hub.OfPlan(pid),
              actor,
              history_row.PlanShared,
              detail_kind("org"),
              clock.now_ms(),
            )
            |> storage,
          )
          use _ <- result.try(
            tell_org(
              tx,
              oid,
              x.player.row.name <> " shared a development plan with your club.",
              now,
            )
            |> storage,
          )
          plan_answer(r, s, pid, 200, [])
        }
      }
    }
  }
}

// ---- goals

fn create_goal(
  ctx: Ctx,
  req: Request,
  s: Surface,
  pid: id.DevPlanId,
) -> Response {
  let shape = {
    use g <- goal_fields(True)
    input.done(g)
  }
  use _, b <- body(req, shape, goal_codes)
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let p = x.bundle.plan.row
  use <- require(x.caps, "writeGoals", "You cannot add goals to this plan.")
  use <- unless(
    p.status == plan_row.Archived || p.status == plan_row.Completed,
    fn() {
      let st = plan_row.status_to_string(p.status)
      refuse(409, [
        code("PLAN_NOT_EDITABLE"),
        text_field("status", st),
        text_field("detail", "A " <> st <> " plan cannot take new goals."),
      ])
    },
  )
  use <- limited(ctx, s, limits.DevelopmentItemWrite)
  use <- unless(list.length(x.bundle.goals) >= hub_rules.goals_per_plan, fn() {
    refuse(400, [
      code("TOO_MANY_GOALS"),
      #("max", json.int(hub_rules.goals_per_plan)),
      text_field(
        "detail",
        "A plan with twenty goals is a plan nobody will work through.",
      ),
    ])
  })
  use v <- from_values(validate_goal(b, None))
  let actor = actor_of(s)
  let at = clock.now_ms()
  let dup =
    list.any(x.bundle.goals, fn(g) {
      at - g.row.created_at < idempotency_window_ms
      && g.row.title == v.title
      && g.row.created_by_id == actor.id
    })
  case dup {
    True -> idempotent(tx, s, pid, True)
    False -> {
      use origin <- origin_objective(r, b.origin_objective_id, p.player_id)
      use g <- result.try(new_goal(tx, p, v, origin, actor, at) |> storage)
      use _ <- result.try(touch_plan(tx, pid, actor, clock.now_ms()) |> storage)
      use _ <- result.try(
        case p.owner_kind, p.visibility {
          plan_row.OwnerKindOrg, plan_visibility.PlayerGuardian ->
            tell_player(
              tx,
              x.player,
              "A new development goal was shared with you: " <> g.title,
              now,
            )
          _, _ -> Ok(Nil)
        }
        |> storage,
      )
      use _ <- result.try(count(tx, "development_goal_created") |> storage)
      plan_answer(r, s, pid, 201, [])
    }
  }
}

fn from_values(
  r: Result(a, List(#(String, Json))),
  next: fn(a) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case r {
    Ok(v) -> next(v)
    Error(body) -> refuse(400, body)
  }
}

type GoalEdit {
  GoalEdit(
    goal: GoalIn,
    status: Option(GoalStatus),
    block_reason: Option(goal_row.BlockReason),
    block_note: Option(String),
  )
}

fn edit_goal(
  ctx: Ctx,
  req: Request,
  s: Surface,
  gid: id.DevGoalId,
) -> Response {
  let shape = {
    use g <- goal_fields(False)
    use status <- input.field(
      "status",
      input.nullish(input.one_of(goal_status.pairs)),
    )
    use block_reason <- input.field(
      "blockReason",
      input.nullish(input.one_of(goal_row.block_reason_pairs)),
    )
    use block_note <- input.field("blockNote", words())
    use <- rev.fields
    input.done(GoalEdit(g, status, block_reason, block_note))
  }
  use raw, b <- body(
    req,
    shape,
    list.flatten([
      goal_codes,
      [
        #("status", "GOAL_STATUS_UNKNOWN"),
        #("blockReason", "BLOCK_REASON_UNKNOWN"),
      ],
      rev.codes,
    ]),
  )
  use expected <- expected_rev(raw)
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use found <- result.try(hub.goal_by_id(r, gid) |> storage)
  use goal <- unless_none(found, fn() {
    refuse(404, [code("DEVELOPMENT_GOAL_NOT_FOUND")])
  })
  use x <- resolve(r, s, goal.plan_id, now)
  let p = x.bundle.plan.row
  use <- require(x.caps, "writeGoals", "You cannot change this goal.")
  use <- editable(p)
  use <- limited(ctx, s, limits.DevelopmentItemWrite)
  // The conflict body omits the title: the other person's edit is content, which the caller reloads.
  use <- guard_rev(
    expected,
    rev.Rev(goal.rev, goal.rev_at, goal.rev_by_name),
    "DEVELOPMENT_GOAL_VERSION_CONFLICT",
    [
      #("goalId", id.dev_goal_json(goal.id)),
      #("status", goal_status.to_json(goal.status)),
    ],
  )
  let actor = actor_of(s)
  let at = clock.now_ms()
  use moved <- goal_move(b, goal, at)
  let changed = case moved {
    Some(row) -> row
    None -> goal
  }
  use v <- from_values(validate_goal(b.goal, Some(changed)))
  let before = hub_rules.target_of(goal)
  let target_changed = v.target != before
  let row =
    goal_row.Row(
      ..changed,
      title: v.title,
      description: v.description,
      category: v.category,
      target_at: v.target_date,
      updated_at: at,
      rev: goal.rev + 1,
      rev_at: Some(at),
      rev_by_user_id: Some(actor.id),
      rev_by_name: Some(actor.name),
    )
    |> hub_rules.with_target(v.target)
  use _ <- result.try(hub.update_goal(tx, row) |> storage)
  let owner = hub.OfGoal(p.id, gid)
  let stamp = clock.now_ms()
  use _ <- result.try(
    case moved {
      Some(m) ->
        hub.record(
          tx,
          owner,
          actor,
          history_row.GoalStatusChanged,
          detail_move(
            goal_status.to_string(goal.status),
            goal_status.to_string(m.status),
          ),
          stamp,
        )
      None -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(
    case target_changed, v.target {
      True, Some(t) ->
        hub.record(
          tx,
          owner,
          actor,
          history_row.GoalTargetSet,
          Detail(..hub.no_detail, protocol_id: Some(t.protocol_id)),
          stamp,
        )
      _, _ -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(
    case moved == None && !target_changed {
      True ->
        hub.record(
          tx,
          owner,
          actor,
          history_row.GoalUpdated,
          hub.no_detail,
          stamp,
        )
      False -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(touch_plan(tx, p.id, actor, clock.now_ms()) |> storage)
  use _ <- result.try(
    case row.status, p.owner_kind, p.visibility, moved {
      goal_status.Achieved,
        plan_row.OwnerKindOrg,
        plan_visibility.PlayerGuardian,
        Some(_)
      ->
        tell_player(
          tx,
          x.player,
          "A development goal was marked achieved: " <> row.title,
          now,
        )
      _, _, _, _ -> Ok(Nil)
    }
    |> storage,
  )
  plan_answer(r, s, p.id, 200, [])
}

/// The goal with its new status, block reason and completion, when the body moves it.
fn goal_move(
  b: GoalEdit,
  goal: goal_row.Row,
  at: Int,
  next: fn(Option(goal_row.Row)) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case b.status {
    Some(to) if to != goal.status -> {
      let from = goal.status
      case hub_rules.allowed(hub_rules.goal_transitions, from, to) {
        False ->
          refuse(409, [
            code("GOAL_TRANSITION_INVALID"),
            #("from", goal_status.to_json(from)),
            #("to", goal_status.to_json(to)),
            #(
              "allowed",
              json.array(hub_rules.goal_transitions(from), goal_status.to_json),
            ),
            text_field("detail", case from, to {
              goal_status.NotStarted, goal_status.Achieved ->
                "A goal nobody started cannot have been achieved through this plan. Move it to in progress first."
              _, _ ->
                "A "
                <> goal_status.to_string(from)
                <> " goal cannot become "
                <> goal_status.to_string(to)
                <> "."
            }),
          ])
        True -> {
          let completed_at = case to {
            goal_status.Achieved -> Some(at)
            _ -> None
          }
          case to, b.block_reason {
            goal_status.Blocked, None ->
              refuse(400, [
                code("BLOCK_REASON_UNKNOWN"),
                #(
                  "allowed",
                  json.array(goal_row.block_reason_pairs, fn(p) {
                    json.string(p.0)
                  }),
                ),
                text_field(
                  "detail",
                  "A blocked goal needs a reason from the list. ScoutBox does not offer a health reason and does not record one.",
                ),
              ])
            goal_status.Blocked, Some(reason) -> {
              use note <- bounded(
                b.block_note,
                hub_rules.block_note_max,
                "blockNote",
              )
              next(Some(
                goal_row.Row(
                  ..goal,
                  status: to,
                  block_reason: Some(reason),
                  block_note: note,
                  completed_at:,
                ),
              ))
            }
            _, _ ->
              next(Some(
                goal_row.Row(
                  ..goal,
                  status: to,
                  block_reason: None,
                  block_note: None,
                  completed_at:,
                ),
              ))
          }
        }
      }
    }
    _ -> next(None)
  }
}

// ---- actions

type AssigneeIn {
  AssigneeIn(kind: Option(String), id: Option(String))
}

type ActionIn {
  ActionIn(
    title: Option(Option(String)),
    type_: Option(Option(action_row.Type)),
    due_at: DateIn,
    assignee: Option(Option(AssigneeIn)),
    status: Option(action_row.Status),
  )
}

fn action_shape(with_status: Bool) -> Shape(ActionIn) {
  use title <- input.field("title", input.clearable(input.text(any_length)))
  use type_ <- input.field(
    "type",
    input.clearable(input.one_of(action_row.type_pairs)),
  )
  use due_at <- input.field("dueAt", date_rule())
  use assignee <- input.field(
    "assignee",
    input.clearable(
      input.object({
        use kind <- input.field("kind", input.optional(input.text(any_length)))
        use who <- input.field("id", input.optional(input.text(any_length)))
        input.done(AssigneeIn(kind, who))
      }),
    ),
  )
  case with_status {
    True -> {
      use status <- input.field(
        "status",
        input.nullish(input.one_of(action_row.status_pairs)),
      )
      input.done(ActionIn(title:, type_:, due_at:, assignee:, status:))
    }
    False ->
      input.done(ActionIn(title:, type_:, due_at:, assignee:, status: None))
  }
}

const action_codes = [
  #("type", "ACTION_TYPE_UNKNOWN"),
  #("assignee", "ASSIGNEE_INVALID"),
  #("assignee.*", "ASSIGNEE_INVALID"),
]

type Assignee {
  Assignee(kind: audience.Audience, id: String, name: Option(String))
}

type ActionValues {
  ActionValues(
    title: String,
    type_: action_row.Type,
    due_at: Option(Int),
    assignee: Option(Assignee),
  )
}

fn assignee_invalid(detail: String) -> Result(a, Fail(Response)) {
  refuse(400, [code("ASSIGNEE_INVALID"), text_field("detail", detail)])
}

/// Staff may only be assigned on their own organisation's plan, while still staff.
fn can_assign(
  read: Read,
  raw: AssigneeIn,
  x: Seen,
  next: fn(Option(Assignee)) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  let p = x.bundle.plan.row
  let who = option.unwrap(raw.id, "")
  case option.unwrap(raw.kind, "") {
    "player" ->
      case raw.id == Some(id.player_to_string(p.player_id)) {
        False ->
          assignee_invalid(
            "Only this plan’s player can be assigned as the player.",
          )
        True ->
          next(
            Some(Assignee(
              audience.Player,
              id.player_to_string(x.player.row.id),
              Some(x.player.row.name),
            )),
          )
      }
    "guardian" -> {
      use found <- result.try(
        case raw.id {
          Some(g) -> guardians.by_id(read, id.guardian(g))
          None -> Ok(None)
        }
        |> storage,
      )
      case found {
        Some(g) ->
          case list.contains(g.child_ids, p.player_id), x.minor {
            False, _ ->
              assignee_invalid("That guardian does not manage this player.")
            True, False ->
              assignee_invalid(
                "This player is an adult; a guardian cannot be assigned their actions.",
              )
            True, True ->
              next(
                Some(Assignee(
                  audience.Guardian,
                  id.guardian_to_string(g.row.id),
                  Some(g.row.name),
                )),
              )
          }
        None -> assignee_invalid("That guardian does not manage this player.")
      }
    }
    "org_user" ->
      case p.owner_org_id {
        None ->
          assignee_invalid(
            "Club staff can only be assigned actions on a club-owned plan.",
          )
        Some(owner) -> {
          use found <- result.try(
            staff.by_id(read, id.org_user(who)) |> storage,
          )
          case found {
            Some(u) if u.org_id == owner && u.removed_at == None ->
              next(
                Some(Assignee(
                  audience.OrgUser,
                  id.org_user_to_string(u.id),
                  Some(u.name),
                )),
              )
            _ ->
              assignee_invalid(
                "That person is not current staff of the organisation that owns this plan.",
              )
          }
        }
      }
    kind -> assignee_invalid("Unknown assignee kind \"" <> kind <> "\".")
  }
}

fn validate_action(
  read: Read,
  b: ActionIn,
  x: Seen,
  existing: Option(action_row.Row),
  next: fn(ActionValues) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  let sent_title = option.flatten(b.title)
  use title <- bounded(
    or_else(sent_title, option.map(existing, fn(a) { a.title })),
    hub_rules.title_max,
    "title",
  )
  use title <- unless_none(title, fn() {
    refuse(400, [
      code("TITLE_REQUIRED"),
      text_field("detail", "An action needs a title."),
    ])
  })
  let type_ =
    or_else(option.flatten(b.type_), option.map(existing, fn(a) { a.type_ }))
  use type_ <- unless_none(type_, fn() {
    refuse(400, [
      code("ACTION_TYPE_UNKNOWN"),
      #(
        "allowed",
        json.array(action_row.type_pairs, fn(p) { json.string(p.0) }),
      ),
      #("received", json.null()),
      text_field("detail", "Unknown action type \"\"."),
    ])
  })
  use due_at <- from_values(date_value(
    b.due_at,
    option.then(existing, fn(a) { a.due_at }),
    "dueAt",
  ))
  let start = x.bundle.plan.row.start_at
  use <- unless(
    case due_at {
      Some(d) -> d < start
      None -> False
    },
    fn() { interval_invalid("An action cannot be due before the plan starts.") },
  )
  let kept =
    option.then(existing, fn(a) {
      case a.assignee_kind, a.assignee_id {
        Some(k), Some(i) -> Some(Assignee(k, i, a.assignee_name))
        _, _ -> None
      }
    })
  let finish = fn(assignee) {
    next(ActionValues(title:, type_:, due_at:, assignee:))
  }
  case b.assignee {
    None -> finish(kept)
    Some(None) -> finish(None)
    Some(Some(raw)) -> can_assign(read, raw, x, finish)
  }
}

fn with_assignee(a: action_row.Row, who: Option(Assignee)) -> action_row.Row {
  case who {
    Some(w) ->
      action_row.Row(
        ..a,
        assignee_kind: Some(w.kind),
        assignee_id: Some(w.id),
        assignee_name: w.name,
      )
    None ->
      action_row.Row(
        ..a,
        assignee_kind: None,
        assignee_id: None,
        assignee_name: None,
      )
  }
}

fn create_action(
  ctx: Ctx,
  req: Request,
  s: Surface,
  gid: id.DevGoalId,
) -> Response {
  use _, b <- body(req, action_shape(False), action_codes)
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use found <- result.try(hub.goal_by_id(r, gid) |> storage)
  use goal <- unless_none(found, fn() {
    refuse(404, [code("DEVELOPMENT_GOAL_NOT_FOUND")])
  })
  use x <- resolve(r, s, goal.plan_id, now)
  let p = x.bundle.plan.row
  use <- require(x.caps, "writeGoals", "You cannot add actions to this plan.")
  use <- editable(p)
  use <- limited(ctx, s, limits.DevelopmentItemWrite)
  let mine = list.filter(x.bundle.actions, fn(a) { a.row.goal_id == gid })
  use <- unless(list.length(mine) >= hub_rules.actions_per_goal, fn() {
    refuse(400, [
      code("TOO_MANY_ACTIONS"),
      #("max", json.int(hub_rules.actions_per_goal)),
    ])
  })
  use v <- validate_action(r, b, x, None)
  let actor = actor_of(s)
  let at = clock.now_ms()
  let dup =
    list.any(mine, fn(a) {
      at - a.row.created_at < idempotency_window_ms
      && a.row.title == v.title
      && a.row.created_by_id == actor.id
    })
  case dup {
    True -> idempotent(tx, s, p.id, True)
    False -> {
      use aid <- result.try(id.next_dev_action(tx) |> storage)
      let row =
        action_row.Row(
          ..action_row.new(
            id: aid,
            plan_id: p.id,
            goal_id: gid,
            player_id: p.player_id,
            type_: v.type_,
            title: v.title,
            status: action_row.Todo,
            created_by_kind: hub.action_creator_kind(actor),
            created_by_id: actor.id,
            created_at: at,
            updated_at: at,
          ),
          due_at: v.due_at,
          created_by_name: Some(actor.name),
        )
        |> with_assignee(v.assignee)
      use _ <- result.try(hub.insert_action(tx, row) |> storage)
      use _ <- result.try(
        hub.record(
          tx,
          hub.OfAction(p.id, aid),
          actor,
          history_row.ActionCreated,
          detail_kind(action_row.type_to_string(v.type_)),
          clock.now_ms(),
        )
        |> storage,
      )
      use _ <- result.try(
        touch_plan(tx, p.id, actor, clock.now_ms()) |> storage,
      )
      plan_answer(r, s, p.id, 201, [])
    }
  }
}

fn edit_action(
  ctx: Ctx,
  req: Request,
  s: Surface,
  aid: id.DevActionId,
) -> Response {
  use _, b <- body(req, action_shape(True), [
    #("status", "ACTION_STATUS_UNKNOWN"),
    ..action_codes
  ])
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use found <- result.try(hub.action_by_id(r, aid) |> storage)
  use action <- unless_none(found, fn() {
    refuse(404, [code("DEVELOPMENT_ACTION_NOT_FOUND")])
  })
  use x <- resolve(r, s, action.plan_id, now)
  let p = x.bundle.plan.row
  use <- editable(p)
  use <- limited(ctx, s, limits.DevelopmentItemWrite)
  // An assignee may tick their own action on a plan they cannot otherwise edit.
  let assigned = case x.viewer, action.assignee_kind, action.assignee_id {
    PlayerSelf(me, _), Some(audience.Player), Some(who) ->
      who == id.player_to_string(me)
    GuardianOf(me, _), Some(audience.Guardian), Some(who) ->
      who == id.guardian_to_string(me)
    _, _, _ -> False
  }
  use <- unless(!x.caps.write_goals && !assigned, fn() {
    refuse(403, [
      code("DEVELOPMENT_NOT_PERMITTED"),
      text_field("capability", "writeGoals"),
      text_field("message", "You cannot change this action."),
    ])
  })
  let actor = actor_of(s)
  let at = clock.now_ms()
  let from = action.status
  use moved <- action_move(b.status, from, at)
  let changed = case moved {
    Some(#(to, completed_at)) ->
      action_row.Row(..action, status: to, completed_at:)
    None -> action
  }
  let finish = fn(row: action_row.Row) {
    let row = action_row.Row(..row, updated_at: at)
    use _ <- result.try(hub.update_action(tx, row) |> storage)
    let done = case moved {
      Some(#(action_row.Done, _)) -> True
      _ -> False
    }
    use _ <- result.try(
      case moved {
        Some(#(to, _)) ->
          hub.record(
            tx,
            hub.OfAction(p.id, aid),
            actor,
            case done {
              True -> history_row.ActionCompleted
              False -> history_row.ActionStatusChanged
            },
            detail_move(
              action_row.status_to_string(from),
              action_row.status_to_string(to),
            ),
            clock.now_ms(),
          )
        None -> Ok(Nil)
      }
      |> storage,
    )
    // Completing an action never moves its goal's status.
    use _ <- result.try(
      case done, p.owner_org_id, actor {
        True, Some(org), ActorPlayer(..) | True, Some(org), ActorGuardian(..) ->
          tell_org(
            tx,
            org,
            x.player.row.name
              <> " completed a development action: "
              <> row.title,
            now,
          )
        _, _, _ -> Ok(Nil)
      }
      |> storage,
    )
    use _ <- result.try(touch_plan(tx, p.id, actor, clock.now_ms()) |> storage)
    use _ <- result.try(
      case done {
        True -> count(tx, "development_action_completed")
        False -> Ok(Nil)
      }
      |> storage,
    )
    plan_answer(r, s, p.id, 200, [])
  }
  case x.caps.write_goals {
    False -> {
      let editing =
        b.title != None
        || b.type_ != None
        || date_sent(b.due_at)
        || b.assignee != None
      use <- unless(editing, fn() {
        refuse(403, [
          code("DEVELOPMENT_NOT_PERMITTED"),
          text_field("capability", "writeGoals"),
          text_field(
            "message",
            "You can mark this action done, but not change it.",
          ),
        ])
      })
      finish(changed)
    }
    True -> {
      use v <- validate_action(r, b, x, Some(changed))
      finish(
        action_row.Row(
          ..changed,
          title: v.title,
          type_: v.type_,
          due_at: v.due_at,
        )
        |> with_assignee(v.assignee),
      )
    }
  }
}

fn action_move(
  status: Option(action_row.Status),
  from: action_row.Status,
  at: Int,
  next: fn(Option(#(action_row.Status, Option(Int)))) ->
    Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case status {
    Some(to) if to != from ->
      case hub_rules.allowed(hub_rules.action_transitions, from, to) {
        False ->
          refuse(409, [
            code("ACTION_TRANSITION_INVALID"),
            #("from", action_row.status_to_json(from)),
            #("to", action_row.status_to_json(to)),
            #(
              "allowed",
              json.array(
                hub_rules.action_transitions(from),
                action_row.status_to_json,
              ),
            ),
          ])
        True ->
          next(
            Some(
              #(to, case to {
                action_row.Done -> Some(at)
                _ -> None
              }),
            ),
          )
      }
    _ -> next(None)
  }
}

// ---- evidence links

type Holder {
  GoalHolder(id.DevGoalId)
  ActionHolder(id.DevActionId)
}

type LinkIn {
  LinkIn(source_type: Option(EvidenceSource), source_id: Option(String))
}

fn link_evidence(
  ctx: Ctx,
  req: Request,
  s: Surface,
  holder: Holder,
) -> Response {
  let shape = {
    use source_type <- input.field(
      "sourceType",
      input.optional(input.one_of(evidence_source.pairs)),
    )
    use source_id <- input.field("sourceId", input.nullish(input.text(id_max)))
    input.done(LinkIn(source_type, source_id))
  }
  use _, b <- body(req, shape, [#("sourceType", "EVIDENCE_SOURCE_UNKNOWN")])
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use plan_id <- result.try(
    case holder {
      GoalHolder(gid) ->
        hub.goal_by_id(r, gid) |> result.map(option.map(_, fn(g) { g.plan_id }))
      ActionHolder(aid) ->
        hub.action_by_id(r, aid)
        |> result.map(option.map(_, fn(a) { a.plan_id }))
    }
    |> storage,
  )
  use plan_id <- unless_none(plan_id, fn() {
    refuse(404, [
      code(case holder {
        GoalHolder(_) -> "DEVELOPMENT_GOAL_NOT_FOUND"
        ActionHolder(_) -> "DEVELOPMENT_ACTION_NOT_FOUND"
      }),
    ])
  })
  use x <- resolve(r, s, plan_id, now)
  let p = x.bundle.plan.row
  use <- require(
    x.caps,
    "linkEvidence",
    "You cannot link evidence to this plan.",
  )
  use <- editable(p)
  use <- limited(ctx, s, limits.DevelopmentItemWrite)
  let mine =
    list.filter(x.bundle.links, fn(l) {
      case holder {
        GoalHolder(gid) -> l.goal_id == Some(gid)
        ActionHolder(aid) -> l.action_id == Some(aid)
      }
    })
  use <- unless(list.length(mine) >= hub_rules.evidence_links_per_target, fn() {
    refuse(400, [
      code("TOO_MANY_EVIDENCE_LINKS"),
      #("max", json.int(hub_rules.evidence_links_per_target)),
    ])
  })
  use checked <- result.try(
    validate_link(r, looker(x, now), b.source_type, b.source_id) |> storage,
  )
  case checked {
    Error(fields) -> refuse(link_refusal_status(fields), fields)
    Ok(#(src, sid)) ->
      case
        list.any(mine, fn(l) { l.source_type == src && l.source_id == sid })
      {
        True -> idempotent(tx, s, p.id, True)
        False -> {
          let actor = actor_of(s)
          let at = clock.now_ms()
          use lid <- result.try(id.next_dev_link(tx) |> storage)
          let link =
            link_row.Row(
              id: lid,
              plan_id: p.id,
              goal_id: case holder {
                GoalHolder(g) -> Some(g)
                ActionHolder(_) -> None
              },
              action_id: case holder {
                ActionHolder(a) -> Some(a)
                GoalHolder(_) -> None
              },
              player_id: p.player_id,
              source_type: src,
              source_id: sid,
              linked_by_kind: hub.link_kind(actor),
              linked_by_id: actor.id,
              linked_by_name: Some(actor.name),
              linked_at: at,
            )
          use _ <- result.try(hub.insert_link(tx, link) |> storage)
          use _ <- result.try(
            hub.record(
              tx,
              holder_owner(p.id, holder),
              actor,
              history_row.EvidenceLinked,
              detail_kind(evidence_source.to_string(src)),
              clock.now_ms(),
            )
            |> storage,
          )
          use _ <- result.try(
            touch_plan(tx, p.id, actor, clock.now_ms()) |> storage,
          )
          use _ <- result.try(
            count(tx, "development_evidence_linked") |> storage,
          )
          plan_answer(r, s, p.id, 201, [])
        }
      }
  }
}

/// EVIDENCE_NOT_FOUND is a 404, so a link cannot probe for ids; any other refusal is a 400.
fn link_refusal_status(fields: List(#(String, Json))) -> Int {
  case fields == evidence_not_found() {
    True -> 404
    False -> 400
  }
}

fn evidence_not_found() -> List(#(String, Json)) {
  [
    code("EVIDENCE_NOT_FOUND"),
    text_field("detail", "That evidence does not exist for this player."),
  ]
}

fn holder_owner(pid: id.DevPlanId, holder: Holder) -> hub.Owner {
  case holder {
    GoalHolder(g) -> hub.OfGoal(pid, g)
    ActionHolder(a) -> hub.OfAction(pid, a)
  }
}

fn unlink(ctx: Ctx, s: Surface, lid: id.DevLinkId) -> Response {
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use found <- result.try(hub.link_by_id(r, lid) |> storage)
  use link <- unless_none(found, fn() {
    refuse(404, [code("EVIDENCE_LINK_NOT_FOUND")])
  })
  use x <- resolve(r, s, link.plan_id, now)
  let p = x.bundle.plan.row
  use <- require(
    x.caps,
    "linkEvidence",
    "You cannot change this plan’s evidence.",
  )
  use <- editable(p)
  let actor = actor_of(s)
  use _ <- result.try(hub.delete_link(tx, lid) |> storage)
  let holder = case link.goal_id, link.action_id {
    Some(g), _ ->
      case list.any(x.bundle.goals, fn(x) { x.row.id == g }) {
        True -> Some(GoalHolder(g))
        False -> None
      }
    None, Some(a) ->
      case list.any(x.bundle.actions, fn(x) { x.row.id == a }) {
        True -> Some(ActionHolder(a))
        False -> None
      }
    None, None -> None
  }
  use _ <- result.try(
    case holder {
      Some(h) ->
        hub.record(
          tx,
          holder_owner(p.id, h),
          actor,
          history_row.EvidenceUnlinked,
          detail_kind(evidence_source.to_string(link.source_type)),
          clock.now_ms(),
        )
      None -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(touch_plan(tx, p.id, actor, clock.now_ms()) |> storage)
  plan_answer(r, s, p.id, 200, [])
}

// ---- reviews

type PageQuery {
  PageQuery(limit: Option(Int), cursor: Option(String))
}

fn page_shape(max: Int) -> Shape(PageQuery) {
  use limit <- input.field(
    "limit",
    input.optional(input.whole_number_text(1, max)),
  )
  use cursor <- input.field("cursor", input.optional(input.text(id_max)))
  input.done(PageQuery(limit, cursor))
}

/// `limit` items after the one named `cursor`, of `all` in order.
fn page_after(
  all: List(#(String, Json)),
  limit: Int,
  cursor: Option(String),
) -> Result(#(List(Json), Option(String)), Nil) {
  use rest <- result.map(case cursor {
    None | Some("") -> Ok(all)
    Some(c) ->
      case list.split_while(all, fn(x) { x.0 != c }) {
        #(_, [_, ..rest]) -> Ok(rest)
        #(_, []) -> Error(Nil)
      }
  })
  let page = list.take(rest, limit)
  #(
    list.map(page, fn(x) { x.1 }),
    case list.length(rest) > limit, list.last(page) {
      True, Ok(last) -> Some(last.0)
      _, _ -> None
    },
  )
}

fn list_reviews(
  ctx: Ctx,
  req: Request,
  s: Surface,
  pid: id.DevPlanId,
) -> Response {
  use q <- http.query(req, page_shape(hub_rules.reviews_page_max), [
    #("limit", "PAGE_LIMIT_INVALID"),
  ])
  use r <- read(ctx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let views =
    x.bundle.reviews
    |> list.sort(fn(p, q) {
      case int.compare(q.row.reviewed_at, p.row.reviewed_at) {
        order.Eq ->
          string.compare(
            id.dev_review_to_string(q.row.id),
            id.dev_review_to_string(p.row.id),
          )
        other -> other
      }
    })
    |> list.filter_map(fn(rv) {
      hub_rules.review_view(rv, x.caps)
      |> option.map(fn(j) { #(id.dev_review_to_string(rv.row.id), j) })
      |> option.to_result(Nil)
    })
  let size =
    int.min(int.max(option.unwrap(q.limit, 25), 1), hub_rules.reviews_page_max)
  case page_after(views, size, q.cursor) {
    Error(Nil) ->
      refuse(400, [
        code("REVIEW_CURSOR_INVALID"),
        text_field(
          "detail",
          "That page no longer exists — start again from the first page.",
        ),
      ])
    Ok(#(items, next_cursor)) ->
      Ok(
        respond(200, [
          #("items", json.preprocessed_array(items)),
          #("total", json.int(list.length(views))),
          #("nextCursor", json.nullable(next_cursor, json.string)),
          text_field(
            "note",
            "Reviews are append-only. A correction appears as a new review that names the one it replaces.",
          ),
        ]),
      )
  }
}

type ReviewIn {
  ReviewIn(
    summary: Option(String),
    internal_note: Option(String),
    next_review_at: DateIn,
    share_with_player: Option(Bool),
    share_scopes: Option(List(String)),
    supersedes: Option(String),
  )
}

fn scopes_check() -> input.Check(List(String)) {
  input.items(
    input.one_of(list.map(hub_rules.share_scopes, fn(s) { #(s, s) })),
    any_length,
  )
}

fn create_review(
  ctx: Ctx,
  req: Request,
  s: Surface,
  pid: id.DevPlanId,
) -> Response {
  let shape = {
    use summary <- input.field("summary", words())
    use internal_note <- input.field("internalNote", words())
    use next_review_at <- input.field("nextReviewAt", date_rule())
    use share <- input.field("shareWithPlayer", input.optional(input.boolean()))
    use scopes <- input.field("shareScopes", input.optional(scopes_check()))
    use supersedes <- input.field(
      "supersedes",
      input.nullish(input.id_of(id_max)),
    )
    input.done(ReviewIn(
      summary,
      internal_note,
      next_review_at,
      share,
      scopes,
      supersedes,
    ))
  }
  use _, b <- body(req, shape, [#("shareScopes", "SHARE_SCOPE_UNKNOWN")])
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let p = x.bundle.plan.row
  use <- unless(p.status == plan_row.Archived, fn() {
    refuse(409, [
      code("PLAN_ARCHIVED"),
      text_field("detail", "An archived plan cannot take a new review."),
    ])
  })
  use <- limited(ctx, s, limits.DevelopmentReviewWrite)
  use v <- validate_review(b, x, now)
  use superseded <- supersession(b.supersedes, x)
  let actor = actor_of(s)
  let at = clock.now_ms()
  let dup =
    list.any(x.bundle.reviews, fn(rv) {
      at - rv.row.created_at < idempotency_window_ms
      && rv.row.reviewed_by_id == actor.id
      && rv.row.shared_summary == v.summary
      && rv.row.internal_note == v.internal_note
    })
  use <- unless(dup, fn() { idempotent(tx, s, pid, True) })
  use attempts <- result.try(
    combine.attempts_for_player(r, p.player_id) |> storage,
  )
  let attempts = list.map(attempts, measured)
  use rid <- result.try(id.next_dev_review(tx) |> storage)
  let coach = v.kind == review_row.CoachReview
  let shared_at = case v.share_scopes != [] || !coach {
    True -> Some(at)
    False -> None
  }
  let row =
    review_row.Row(
      ..review_row.new(
        id: rid,
        plan_id: pid,
        player_id: p.player_id,
        reviewer_kind: v.kind,
        reviewed_by_kind: hub.review_kind(actor),
        reviewed_by_id: actor.id,
        reviewed_at: at,
        created_at: at,
        share_summary: list.contains(v.share_scopes, "summary"),
        share_goals: list.contains(v.share_scopes, "goals"),
        share_actions: list.contains(v.share_scopes, "actions"),
      ),
      reviewed_by_name: Some(actor.name),
      org_id: case s {
        AsOrg(a) -> Some(a.org.id)
        _ -> None
      },
      shared_summary: v.summary,
      internal_note: v.internal_note,
      next_review_at: v.next_review_at,
      shared_with_player_at: shared_at,
      supersedes_review_id: superseded,
    )
  let snapshots = goal_snapshots(rid, x.bundle, attempts)
  use _ <- result.try(hub.insert_review(tx, row, snapshots) |> storage)
  let stamp = clock.now_ms()
  use _ <- result.try(
    hub.record(
      tx,
      hub.OfReview(pid, rid),
      actor,
      history_row.ReviewSubmitted,
      Detail(
        ..hub.no_detail,
        kind: Some(review_row.reviewer_kind_to_string(v.kind)),
        note: Some(v.internal_note != None),
      ),
      stamp,
    )
    |> storage,
  )
  use _ <- result.try(
    case coach && shared_at != None {
      True ->
        hub.record(
          tx,
          hub.OfReview(pid, rid),
          actor,
          history_row.ReviewShared,
          hub.no_detail,
          stamp,
        )
      False -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(
    case superseded {
      Some(old) ->
        hub.record(
          tx,
          hub.OfReview(pid, old),
          actor,
          history_row.ReviewSuperseded,
          hub.no_detail,
          clock.now_ms(),
        )
      None -> Ok(Nil)
    }
    |> storage,
  )
  let at = clock.now_ms()
  use _ <- result.try(
    case v.next_review_at {
      Some(next) -> {
        use found <- result.try(hub.plan_by_id(store.reading(tx), pid))
        case found {
          Some(plan) ->
            hub.update_plan(
              tx,
              bumped(
                plan_row.Row(..plan.row, next_review_at: Some(next)),
                actor,
                at,
              ),
            )
          None -> store.stale("development plan " <> id.dev_plan_to_string(pid))
        }
      }
      None -> touch_plan(tx, pid, actor, at)
    }
    |> storage,
  )
  use _ <- result.try(
    case coach, shared_at, p.owner_org_id {
      True, Some(_), _ ->
        tell_player(
          tx,
          x.player,
          "A development review was shared with you.",
          now,
        )
      False, _, Some(org) ->
        tell_org(
          tx,
          org,
          x.player.row.name <> " added a development reflection.",
          now,
        )
      _, _, _ -> Ok(Nil)
    }
    |> storage,
  )
  use _ <- result.try(count(tx, "development_review_submitted") |> storage)
  plan_answer(r, s, pid, 201, [])
}

type ReviewValues {
  ReviewValues(
    kind: review_row.ReviewerKind,
    summary: Option(String),
    internal_note: Option(String),
    next_review_at: Option(Int),
    share_scopes: List(String),
  )
}

/// `reviewerKind` is provenance, so it follows from the viewer, not the body.
fn validate_review(
  b: ReviewIn,
  x: Seen,
  now: Int,
  next: fn(ReviewValues) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  let kind = case x.viewer {
    PlayerSelf(..) -> review_row.PlayerReflection
    GuardianOf(..) -> review_row.GuardianReflection
    StaffOf(..) -> review_row.CoachReview
  }
  let coach = kind == review_row.CoachReview
  let not_permitted = fn(detail) {
    refuse(403, [code("REVIEW_NOT_PERMITTED"), text_field("detail", detail)])
  }
  use <- unless(coach && !x.caps.review, fn() {
    not_permitted(
      "Only staff of the organisation that owns this plan can submit a coach review.",
    )
  })
  use <- unless(!coach && !x.caps.reflect, fn() {
    not_permitted("You cannot add a reflection to this plan.")
  })
  use summary <- bounded(b.summary, hub_rules.summary_max, "summary")
  let note_sent = case b.internal_note {
    Some("") | None -> False
    Some(_) -> True
  }
  use <- unless(note_sent && !x.caps.read_internal, fn() {
    refuse(400, [
      code("INTERNAL_NOTE_NOT_PERMITTED"),
      text_field(
        "detail",
        "Only the organisation that owns this plan can record an internal note.",
      ),
    ])
  })
  use note <- bounded(
    case note_sent {
      True -> b.internal_note
      False -> None
    },
    hub_rules.note_max,
    "internalNote",
  )
  use <- unless(summary == None && note == None, fn() {
    refuse(400, [
      code("REVIEW_EMPTY"),
      text_field(
        "detail",
        "A review needs a summary, an internal note, or both.",
      ),
    ])
  })
  use next_review <- from_values(date_value(
    b.next_review_at,
    None,
    "nextReviewAt",
  ))
  use <- unless(
    case next_review {
      Some(d) -> d < now
      None -> False
    },
    fn() {
      refuse(400, [
        code("DATE_IN_PAST"),
        text_field("field", "nextReviewAt"),
        text_field("detail", "The next review date cannot be in the past."),
      ])
    },
  )
  let finish = fn(scopes) {
    next(ReviewValues(kind, summary, note, next_review, scopes))
  }
  case b.share_with_player {
    Some(True) -> {
      use <- unless(!x.caps.read_internal, fn() {
        refuse(400, [
          code("SHARE_NOT_APPLICABLE"),
          text_field(
            "detail",
            "Only a club review can be shared with the player.",
          ),
        ])
      })
      use <- unless(summary == None, fn() {
        refuse(400, [
          code("SHARE_NEEDS_SUMMARY"),
          text_field(
            "detail",
            "A review shared with the player needs a summary. The internal note is never shared.",
          ),
        ])
      })
      finish(case b.share_scopes {
        Some([_, ..] as asked) -> list.unique(asked)
        _ -> ["summary"]
      })
    }
    _ -> finish([])
  }
}

/// A club corrects its own review, a player or guardian their own reflection.
fn supersession(
  raw: Option(String),
  x: Seen,
  next: fn(Option(id.DevReviewId)) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case raw {
    None | Some("") -> next(None)
    Some(rid) ->
      case
        list.find(x.bundle.reviews, fn(r) {
          id.dev_review_to_string(r.row.id) == rid
        })
      {
        Error(Nil) -> refuse(404, [code("REVIEW_NOT_FOUND")])
        Ok(target) ->
          case target.superseded_by {
            Some(by) ->
              refuse(409, [
                code("REVIEW_ALREADY_SUPERSEDED"),
                #("supersededBy", id.dev_review_json(by)),
                text_field(
                  "detail",
                  "That review has already been corrected. Correct the current version instead.",
                ),
              ])
            None -> {
              let club_side = x.caps.read_internal
              let target_is_club =
                target.row.reviewer_kind == review_row.CoachReview
              let me = case x.viewer {
                PlayerSelf(p, _) -> id.player_to_string(p)
                GuardianOf(g, _) -> id.guardian_to_string(g)
                StaffOf(..) -> ""
              }
              case
                club_side != target_is_club,
                !club_side && target.row.reviewed_by_id != me
              {
                True, _ ->
                  refuse(409, [
                    code("REVIEW_NOT_CORRECTABLE"),
                    text_field(
                      "detail",
                      "A club review is corrected by the club, and a reflection by the person who wrote it.",
                    ),
                  ])
                False, True ->
                  refuse(409, [
                    code("REVIEW_NOT_CORRECTABLE"),
                    text_field(
                      "detail",
                      "You can only correct a reflection you wrote.",
                    ),
                  ])
                False, False -> next(Some(target.row.id))
              }
            }
          }
      }
  }
}

/// What was true of each goal at the review: its state and evidence ids, never a copy of the Passport.
fn goal_snapshots(
  rid: id.DevReviewId,
  b: Bundle,
  attempts: List(hub_rules.Measured),
) -> List(hub.Snapshot) {
  b.goals
  |> list.sort(fn(a, c) {
    case int.compare(a.row.created_at, c.row.created_at) {
      order.Eq ->
        string.compare(
          id.dev_goal_to_string(a.row.id),
          id.dev_goal_to_string(c.row.id),
        )
      other -> other
    }
  })
  |> list.index_map(fn(goal, i) {
    let g = goal.row
    let me = g.id
    let counts =
      list.filter(b.actions, fn(a) { a.row.goal_id == me })
      |> list.map(fn(a) { a.row.status })
      |> hub_rules.action_counts
    let gid = Some(me)
    let refs =
      list.filter(b.links, fn(l) { l.goal_id == gid })
      |> list.index_map(fn(l, j) {
        ref_row.Row(
          review_id: rid,
          goal_id: me,
          ord: j,
          source_type: l.source_type,
          source_id: l.source_id,
        )
      })
    let evaluation =
      hub_rules.target_of(g)
      |> option.map(hub_rules.evaluate_target(_, attempts))
    hub.Snapshot(
      row: snapshot_row.Row(
        review_id: rid,
        ord: i,
        goal_id: me,
        title: g.title,
        category: g.category,
        status: g.status,
        actions_total: counts.total,
        actions_done: counts.done,
        actions_blocked: counts.blocked,
        actions_cancelled: counts.cancelled,
        target_state: option.map(evaluation, fn(e) { e.state }),
        target_reason: option.then(evaluation, fn(e) { e.reason }),
        target_measured: option.then(evaluation, fn(e) {
          option.then(e.best, fn(m) { m.measured_value })
        }),
      ),
      refs:,
    )
  })
}

/// Shares the summary only; the internal note is never shared.
fn share_review(
  ctx: Ctx,
  req: Request,
  s: Surface,
  rid: id.DevReviewId,
) -> Response {
  let shape = {
    use scopes <- input.field("scopes", input.optional(scopes_check()))
    input.done(scopes)
  }
  use _, scopes <- body(req, shape, [#("scopes", "SHARE_SCOPE_UNKNOWN")])
  use tx <- write(ctx)
  let r = store.reading(tx)
  let now = clock.now_ms()
  use found <- result.try(hub.review_by_id(r, rid) |> storage)
  use review <- unless_none(found, fn() {
    refuse(404, [code("REVIEW_NOT_FOUND")])
  })
  use x <- resolve(r, s, review.plan_id, now)
  let pid = review.plan_id
  use <- unless(!x.caps.read_internal, fn() {
    refuse(403, [
      code("DEVELOPMENT_NOT_PERMITTED"),
      text_field(
        "message",
        "Only the organisation that wrote this review can share it.",
      ),
    ])
  })
  use <- unless(review.shared_summary == None, fn() {
    refuse(400, [
      code("SHARE_NEEDS_SUMMARY"),
      text_field(
        "detail",
        "This review has no summary to share. The internal note is never shared.",
      ),
    ])
  })
  use <- unless(review.shared_with_player_at != None, fn() {
    idempotent(tx, s, pid, True)
  })
  let asked = case scopes {
    Some([_, ..] as a) -> list.unique(a)
    _ -> ["summary"]
  }
  let actor = actor_of(s)
  let at = clock.now_ms()
  use _ <- result.try(
    hub.update_review(
      tx,
      review_row.Row(
        ..review,
        shared_with_player_at: Some(at),
        share_summary: list.contains(asked, "summary"),
        share_goals: list.contains(asked, "goals"),
        share_actions: list.contains(asked, "actions"),
      ),
    )
    |> storage,
  )
  use _ <- result.try(
    hub.record(
      tx,
      hub.OfReview(pid, rid),
      actor,
      history_row.ReviewShared,
      hub.no_detail,
      clock.now_ms(),
    )
    |> storage,
  )
  use _ <- result.try(touch_plan(tx, pid, actor, clock.now_ms()) |> storage)
  use _ <- result.try(
    tell_player(tx, x.player, "A development review was shared with you.", now)
    |> storage,
  )
  plan_answer(r, s, pid, 200, [])
}

// ---- history

fn history(ctx: Ctx, req: Request, s: Surface, pid: id.DevPlanId) -> Response {
  use q <- http.query(req, page_shape(hub_rules.history_page_max), [
    #("limit", "PAGE_LIMIT_INVALID"),
  ])
  use r <- read(ctx)
  let now = clock.now_ms()
  use x <- resolve(r, s, pid, now)
  let all = list.map(timeline(x.bundle, x.caps), fn(e) { #(e.id, e.json) })
  case page_after(all, option.unwrap(q.limit, 50), q.cursor) {
    Error(Nil) ->
      refuse(400, [
        code("HISTORY_CURSOR_INVALID"),
        text_field(
          "detail",
          "That page no longer exists — start again from the first page.",
        ),
      ])
    Ok(#(items, next_cursor)) ->
      Ok(
        respond(200, [
          #("items", json.preprocessed_array(items)),
          #("total", json.int(list.length(all))),
          #("nextCursor", json.nullable(next_cursor, json.string)),
          text_field(
            "note",
            "Meaningful development events only. Reads and saves that changed nothing are not recorded.",
          ),
        ])
        |> ordered("newest_first_then_id"),
      )
  }
}
