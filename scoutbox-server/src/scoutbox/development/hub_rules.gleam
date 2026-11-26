//// The Development Hub's vocabulary, limits and pure rules (domains/development/hub/shared.mjs, targets.mjs and
//// permissions.mjs). ScoutBox documents and coordinates development; it does not rate a player, so nothing here
//// combines counts into one figure, and meeting a target never marks a goal achieved: a person decides that.

import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/set
import gleam/string
import scoutbox/development/box_cam_rules as box_rules
import scoutbox/development/combine_rules.{type Protocol}
import scoutbox/development/hub.{type Review}
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/development_actions as action_row
import scoutbox/rows/development_evidence_links as link_row
import scoutbox/rows/development_goals as goal_row
import scoutbox/rows/development_history as history_row
import scoutbox/rows/development_plans as plan_row
import scoutbox/rows/development_review_snapshot_refs as ref_row
import scoutbox/rows/development_review_snapshots as snapshot_row
import scoutbox/rows/development_reviews as review_row
import scoutbox/rows/id
import scoutbox/vocab/box_provider.{type BoxProvider}
import scoutbox/vocab/evidence_source.{type EvidenceSource}
import scoutbox/vocab/goal_category.{type GoalCategory}
import scoutbox/vocab/goal_status.{type GoalStatus}
import scoutbox/vocab/plan_visibility.{type PlanVisibility}

pub const policy_version = 1

/// Sent on the wire so clients render the server's sentence, not a paraphrase.
pub const principle =
  "Document and coordinate development. ScoutBox does not measure a player’s worth, ceiling or future."

pub const achieved_meaning =
  "Achieved means the plan owner or reviewer marked this agreed objective complete. It is not a ScoutBox finding that the player permanently possesses this ability."

pub const plan_limitation =
  "A Development Plan records what was agreed, what was done and what evidence was cited. It is a record of work, not a measurement of the player."

/// Names the Hub refuses: a single blended figure invites a decision about a person that the figure cannot
/// support.
pub const forbidden_development_names = [
  "Development Score", "Potential Score", "Improvement Score", "Readiness Score",
  "Growth Score", "Academy Score", "Player Progress Rating", "Player Rating",
  "Development Rating", "Development Ranking", "Coach Ranking",
]

/// The same refusal as payload keys.
pub const forbidden_field_names = [
  "developmentScore", "development_score", "potentialScore", "potential_score",
  "improvementScore", "improvement_score", "readinessScore", "readiness_score",
  "growthScore", "growth_score", "academyScore", "academy_score",
  "playerProgressRating", "player_progress_rating", "playerRating",
  "player_rating", "developmentRating", "developmentRanking", "coachRanking",
  "progressPercent", "progress_percent", "developmentPercent",
  "percentDeveloped", "ceiling", "projectedCeiling", "talentScore",
]

/// Keys a client-supplied body may never carry, whatever it is called.
pub const refused_client_field_names = [
  "targetState", "target_met", "targetMet", "progress", "progressPercent",
  "evidenceConfidence", "trustScore", "verified", "verifiedEvidence",
  "developmentScore", "potentialScore", "score", "rating", "rank",
]

// ------------------------------------------------------------------------------------------------------ limits

pub const active_plans_per_owner = 5

pub const goals_per_plan = 20

pub const actions_per_goal = 20

pub const evidence_links_per_target = 30

pub const reviews_page_max = 50

pub const history_page_max = 100

pub const list_page_max = 50

pub const title_max = 120

pub const description_max = 1000

pub const note_max = 2000

pub const summary_max = 2000

pub const block_note_max = 300

pub fn limits_json() -> Json {
  json.object([
    #("activePlansPerOwner", json.int(active_plans_per_owner)),
    #("goalsPerPlan", json.int(goals_per_plan)),
    #("actionsPerGoal", json.int(actions_per_goal)),
    #("evidenceLinksPerTarget", json.int(evidence_links_per_target)),
    #("reviewsPageMax", json.int(reviews_page_max)),
    #("historyPageMax", json.int(history_page_max)),
    #("listPageMax", json.int(list_page_max)),
    #("titleMax", json.int(title_max)),
    #("descriptionMax", json.int(description_max)),
    #("noteMax", json.int(note_max)),
    #("summaryMax", json.int(summary_max)),
    #("blockNoteMax", json.int(block_note_max)),
  ])
}

// ------------------------------------------------------------------------------------------------------ labels

pub fn category_label(c: GoalCategory) -> String {
  case c {
    goal_category.Technical -> "Technical"
    goal_category.Tactical -> "Tactical"
    goal_category.Physical -> "Physical"
    goal_category.Psychological -> "Psychological"
    goal_category.MatchUnderstanding -> "Match understanding"
    goal_category.PositionSpecific -> "Position-specific"
    goal_category.Other -> "Other"
  }
}

pub fn source_label(s: EvidenceSource) -> String {
  case s {
    evidence_source.PassportEvidence -> "Passport evidence"
    evidence_source.Assessment -> "Assessment"
    evidence_source.BoxCamSession -> "Box Cam session"
    evidence_source.CombineAttempt -> "Combine result"
    evidence_source.TrialReport -> "Trial report"
  }
}

pub fn reviewer_kind_label(k: review_row.ReviewerKind) -> String {
  case k {
    review_row.PlayerReflection -> "Player reflection"
    review_row.GuardianReflection -> "Guardian reflection"
    review_row.CoachReview -> "Coach review"
  }
}

pub const reviewer_kind_pairs = review_row.reviewer_kind_pairs

pub const share_scopes = ["summary", "goals", "actions"]

// ------------------------------------------------------------------------------------- library and templates

pub type LibraryItem {
  LibraryItem(id: String, category: GoalCategory, title: String)
}

/// The same for every player, so it cannot read as a personalised suggestion.
pub const goal_library = [
  LibraryItem(
    "first_touch",
    goal_category.Technical,
    "First touch under pressure",
  ),
  LibraryItem(
    "scanning",
    goal_category.MatchUnderstanding,
    "Scanning before receiving possession",
  ),
  LibraryItem(
    "weak_foot_passing",
    goal_category.Technical,
    "Weak-foot passing consistency",
  ),
  LibraryItem("defending_1v1", goal_category.Tactical, "1v1 defending"),
  LibraryItem(
    "finishing",
    goal_category.Technical,
    "Finishing from inside the box",
  ),
  LibraryItem("aerial_timing", goal_category.Physical, "Aerial timing"),
  LibraryItem("acceleration", goal_category.Physical, "Acceleration mechanics"),
]

pub const goal_library_note =
  "Common development themes. The same list is shown to everyone — it is not a recommendation and it does not read this player’s record."

pub type Template {
  Template(id: plan_row.TemplateId, title: String, goals: List(GoalCategory))
}

/// Structure only: headings, not advice.
pub const templates = [
  Template(
    plan_row.TechnicalDevelopment,
    "Technical Development",
    [goal_category.Technical, goal_category.Technical],
  ),
  Template(
    plan_row.PositionalDevelopment,
    "Positional Development",
    [goal_category.PositionSpecific, goal_category.Tactical],
  ),
  Template(
    plan_row.TrialFollowUp,
    "Trial Follow-up",
    [goal_category.MatchUnderstanding, goal_category.Technical],
  ),
]

pub const template_note =
  "A template is empty structure: a title and a category for each goal. ScoutBox does not know what a good development plan for this player contains, and does not claim to."

// --------------------------------------------------------------------------------------------- transitions

pub fn plan_transitions(from: plan_row.Status) -> List(plan_row.Status) {
  case from {
    plan_row.Draft -> [plan_row.Active, plan_row.Archived]
    plan_row.Active -> [plan_row.Paused, plan_row.Completed, plan_row.Archived]
    plan_row.Paused -> [plan_row.Active, plan_row.Completed, plan_row.Archived]
    // Reopening a plan is legitimate; erasing it is not.
    plan_row.Completed -> [plan_row.Active, plan_row.Archived]
    plan_row.Archived -> []
  }
}

/// `not_started → achieved` is refused: a goal nobody started was not achieved through this plan.
pub fn goal_transitions(from: GoalStatus) -> List(GoalStatus) {
  case from {
    goal_status.NotStarted -> [
      goal_status.InProgress,
      goal_status.Blocked,
      goal_status.Stopped,
    ]
    goal_status.InProgress -> [
      goal_status.Blocked,
      goal_status.Achieved,
      goal_status.Stopped,
      goal_status.NotStarted,
    ]
    goal_status.Blocked -> [
      goal_status.InProgress,
      goal_status.Stopped,
      goal_status.NotStarted,
    ]
    goal_status.Achieved -> [goal_status.InProgress]
    goal_status.Stopped -> [goal_status.InProgress, goal_status.NotStarted]
  }
}

pub fn action_transitions(from: action_row.Status) -> List(action_row.Status) {
  case from {
    action_row.Todo -> [
      action_row.InProgress,
      action_row.Done,
      action_row.Blocked,
      action_row.Cancelled,
    ]
    action_row.InProgress -> [
      action_row.Todo,
      action_row.Done,
      action_row.Blocked,
      action_row.Cancelled,
    ]
    action_row.Blocked -> [
      action_row.Todo,
      action_row.InProgress,
      action_row.Cancelled,
    ]
    // Undo a mistaken tick.
    action_row.Done -> [action_row.InProgress]
    action_row.Cancelled -> []
  }
}

pub fn allowed(table: fn(a) -> List(a), from: a, to: a) -> Bool {
  from == to || list.contains(table(from), to)
}

/// A transition table as JSON: each status with the statuses it may become.
pub fn transitions_json(
  pairs: List(#(String, a)),
  table: fn(a) -> List(a),
  to_string: fn(a) -> String,
) -> Json {
  json.object(
    list.map(pairs, fn(p) {
      #(p.0, json.array(table(p.1), fn(s) { json.string(to_string(s)) }))
    }),
  )
}

// ------------------------------------------------------------------------------------------------- due dates

const day_ms = 86_400_000

pub fn utc_day(ms: Int) -> Int {
  let d = ms / day_ms
  case ms < 0 && d * day_ms != ms {
    True -> { d - 1 } * day_ms
    False -> d * day_ms
  }
}

/// Whole days between two instants, by UTC calendar day.
pub fn days_between(a: Int, b: Int) -> Int {
  { utc_day(b) - utc_day(a) } / day_ms
}

pub type Due {
  Due(state: String, days: Option(Int))
}

/// Derived at read time: there is no scheduler and no reminders.
pub fn due_state(due: Option(Int), now: Int) -> Due {
  case due {
    None -> Due("no_due_date", None)
    Some(at) -> {
      let days = days_between(now, at)
      case days {
        d if d < 0 -> Due("overdue", Some(-d))
        0 -> Due("due_today", Some(0))
        d if d <= 7 -> Due("due_soon", Some(d))
        d -> Due("upcoming", Some(d))
      }
    }
  }
}

pub fn review_due_state(next_review: Option(Int), now: Int) -> Due {
  let d = due_state(next_review, now)
  case d.state {
    "no_due_date" -> Due("no_review_scheduled", None)
    "overdue" -> Due("review_overdue", d.days)
    "due_today" | "due_soon" -> Due("review_due", d.days)
    _ -> Due("review_upcoming", d.days)
  }
}

pub fn due_json(d: Due) -> Json {
  json.object([
    #("state", json.string(d.state)),
    #("days", json.nullable(d.days, json.int)),
  ])
}

// ------------------------------------------------------------------------------------------------------ text

/// Trimmed text, `None` for empty; over-long text is refused, never truncated.
pub fn bounded_text(
  raw: Option(String),
  max: Int,
  field: String,
) -> Result(Option(String), List(#(String, Json))) {
  case raw {
    None -> Ok(None)
    Some(s) ->
      case string.trim(s) {
        "" -> Ok(None)
        t -> {
          let length = input.utf16_length(t)
          case length > max {
            True ->
              Error([
                #("error", json.string("TEXT_TOO_LONG")),
                #("field", json.string(field)),
                #("max", json.int(max)),
                #("length", json.int(length)),
                #(
                  "detail",
                  json.string(
                    field
                    <> " may be at most "
                    <> int.to_string(max)
                    <> " characters.",
                  ),
                ),
              ])
            False -> Ok(Some(t))
          }
        }
      }
  }
}

/// The body keys a client may not send because the server derives them, in the order sent. The caller answers
/// 400 rather than stripping them, so the client learns it is not authoritative.
pub fn refused_client_fields(keys: List(String)) -> List(String) {
  let lower =
    list.append(refused_client_field_names, forbidden_field_names)
    |> list.map(string.lowercase)
    |> set.from_list
  list.filter(keys, fn(k) { set.contains(lower, string.lowercase(k)) })
}

// ------------------------------------------------------------------------------------------------- counts

/// Counts only, no ratio: nothing here should read as a percentage of a player.
pub type Counts {
  Counts(
    total: Int,
    to_do: Int,
    in_progress: Int,
    done: Int,
    blocked: Int,
    cancelled: Int,
    overdue: Int,
  )
}

pub fn action_counts(statuses: List(action_row.Status)) -> Counts {
  list.fold(statuses, Counts(0, 0, 0, 0, 0, 0, 0), fn(c, s) {
    let c = Counts(..c, total: c.total + 1)
    case s {
      action_row.Todo -> Counts(..c, to_do: c.to_do + 1)
      action_row.InProgress -> Counts(..c, in_progress: c.in_progress + 1)
      action_row.Done -> Counts(..c, done: c.done + 1)
      action_row.Blocked -> Counts(..c, blocked: c.blocked + 1)
      action_row.Cancelled -> Counts(..c, cancelled: c.cancelled + 1)
    }
  })
}

pub fn counts_json(c: Counts) -> Json {
  json.object([
    #("total", json.int(c.total)),
    #("todo", json.int(c.to_do)),
    #("in_progress", json.int(c.in_progress)),
    #("done", json.int(c.done)),
    #("blocked", json.int(c.blocked)),
    #("cancelled", json.int(c.cancelled)),
    #("overdue", json.int(c.overdue)),
  ])
}

/// Cancelled actions leave the denominator.
pub fn completion_json(done: Int, total: Int, cancelled: Int) -> Json {
  let of = total - cancelled
  json.object([
    #("done", json.int(done)),
    #("of", json.int(of)),
    #(
      "phrase",
      json.string(
        int.to_string(done)
        <> " of "
        <> int.to_string(of)
        <> " actions completed",
      ),
    ),
  ])
}

/// A plan's summary: counts of agreed work, never an overall figure. `actions` are the plan's actions with their
/// due state, `evidence_available` the goals' available linked evidence, `reviews` when each review was made.
pub fn plan_summary_json(
  goals: List(GoalStatus),
  actions: List(#(action_row.Status, Due)),
  evidence_available: Int,
  reviews: List(Int),
  next_review_at: Option(Int),
  now: Int,
) -> Json {
  let #(by_status, active) = goal_statuses_json(goals)
  let open =
    list.filter(actions, fn(a) {
      a.0 != action_row.Done && a.0 != action_row.Cancelled
    })
  let in_state = fn(states) {
    list.count(open, fn(a) { list.contains(states, { a.1 }.state) })
  }
  json.object([
    #("goalsByStatus", by_status),
    #("activeGoals", json.int(active)),
    #("actionsDue", json.int(in_state(["due_today", "due_soon"]))),
    #("actionsOverdue", json.int(in_state(["overdue"]))),
    #("linkedEvidenceAvailable", json.int(evidence_available)),
    #(
      "lastReviewAt",
      json.nullable(
        list.max(reviews, int.compare) |> option.from_result,
        json.int,
      ),
    ),
    #("nextReviewAt", json.nullable(next_review_at, json.int)),
    #("reviewDue", due_json(review_due_state(next_review_at, now))),
    #(
      "note",
      json.string(
        "These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.",
      ),
    ),
  ])
}

pub fn goal_statuses_json(statuses: List(GoalStatus)) -> #(Json, Int) {
  let n = fn(s) { list.count(statuses, fn(x) { x == s }) }
  #(
    json.object(list.map(goal_status.pairs, fn(p) { #(p.0, json.int(n(p.1))) })),
    n(goal_status.InProgress)
      + n(goal_status.NotStarted)
      + n(goal_status.Blocked),
  )
}

// ----------------------------------------------------------------------------------------------- targets

/// Box Cam sessions record observed training, and assessment scales are not comparable across templates, so only
/// Combine attempts can satisfy a target.
pub const target_sources = ["combine_attempt"]

pub const target_operators = ["gte", "gt", "lte", "lt", "eq"]

pub const target_states = [
  "target_met", "target_not_met", "no_current_valid_measurement",
]

pub const target_limitation =
  "A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed."

const max_target_value = 100_000

/// A target as the request sent it, its shape already checked.
pub type TargetInput {
  TargetInput(
    source_type: Option(String),
    protocol_id: Option(String),
    protocol_version: Option(Int),
    metric_type: Option(String),
    operator: Option(String),
    value: Option(Float),
  )
}

/// A goal's target, frozen at creation so a later protocol revision cannot change what was agreed.
pub type Target {
  Target(
    protocol_id: String,
    protocol_version: Int,
    metric_type: goal_row.TargetMetricType,
    metric_unit: String,
    operator: goal_row.TargetOperator,
    value: Float,
    protocol_title: String,
    direction: goal_row.TargetDirection,
    precision: goal_row.TargetPrecision,
  )
}

pub fn operator_symbol(op: goal_row.TargetOperator) -> String {
  case op {
    goal_row.Gte -> "≥"
    goal_row.Gt -> ">"
    goal_row.Lte -> "≤"
    goal_row.Lt -> "<"
    goal_row.Eq -> "="
  }
}

fn detail(text: String) -> #(String, Json) {
  #("detail", json.string(text))
}

fn strings(values: List(String)) -> Json {
  json.array(values, json.string)
}

/// A number as JavaScript writes it in text.
pub fn number_text(f: Float) -> String {
  json.to_string(json_text.number(f))
}

/// Nothing is repaired: each mismatch is a 400 with its reason.
pub fn validate_target(
  raw: TargetInput,
) -> Result(Target, List(#(String, Json))) {
  let source = option.unwrap(raw.source_type, "")
  let protocol_id = option.unwrap(raw.protocol_id, "")
  let version = case raw.protocol_version {
    None ->
      combine_rules.latest_protocol(protocol_id)
      |> option.map(fn(p) { p.version })
    Some(v) -> Some(v)
  }
  let known = list.any(combine_rules.protocols, fn(p) { p.id == protocol_id })
  case list.contains(target_sources, source), known {
    False, _ ->
      Error([
        #("error", json.string("TARGET_SOURCE_UNSUPPORTED")),
        #("allowed", strings(target_sources)),
        detail(
          "Only a standardized At-Home Combine measurement can satisfy an objective target. Box Cam records observed training and an assessment records an opinion — neither is a comparable number.",
        ),
      ])
    True, False ->
      Error([
        #("error", json.string("TARGET_PROTOCOL_UNKNOWN")),
        #("protocolId", json.string(protocol_id)),
        #(
          "allowed",
          strings(
            list.unique(list.map(combine_rules.protocols, fn(p) { p.id })),
          ),
        ),
        detail(
          "\"" <> protocol_id <> "\" is not a standardized Combine protocol.",
        ),
      ])
    True, True ->
      case option.then(version, combine_rules.protocol(protocol_id, _)) {
        None ->
          Error([
            #("error", json.string("TARGET_PROTOCOL_VERSION_UNKNOWN")),
            #("protocolId", json.string(protocol_id)),
            #("protocolVersion", json.nullable(version, json.int)),
            detail(
              "Protocol "
              <> protocol_id
              <> " has no version "
              <> option.unwrap(
                option.map(raw.protocol_version, int.to_string),
                "",
              )
              <> ".",
            ),
          ])
        Some(p) -> validate_against(raw, p)
      }
  }
}

fn validate_against(
  raw: TargetInput,
  p: Protocol,
) -> Result(Target, List(#(String, Json))) {
  let metric = attempt_row.metric_type_to_string(p.metric_type)
  let direction = attempt_row.direction_to_string(p.direction)
  let precision = combine_rules.precision_to_string(p.precision)
  let metric_type = case raw.metric_type {
    None | Some("") -> metric
    Some(m) -> m
  }
  let operator = option.unwrap(raw.operator, "")
  let op = list.key_find(goal_row.target_operator_pairs, operator)
  use <- guard(metric_type != metric, [
    #("error", json.string("TARGET_METRIC_MISMATCH")),
    #("protocolId", json.string(p.id)),
    #("expected", json.string(metric)),
    #("received", json.string(metric_type)),
    detail(p.title <> " measures " <> metric <> ", not " <> metric_type <> "."),
  ])
  case op {
    Error(Nil) ->
      Error([
        #("error", json.string("TARGET_OPERATOR_UNKNOWN")),
        #("allowed", strings(target_operators)),
        detail("Unknown operator \"" <> operator <> "\"."),
      ])
    Ok(op) -> {
      let wants_more = op == goal_row.Gte || op == goal_row.Gt
      let wants_less = op == goal_row.Lte || op == goal_row.Lt
      let against = fn(way) {
        [
          #("error", json.string("TARGET_OPERATOR_INCOMPATIBLE")),
          #("operator", json.string(operator)),
          #("direction", json.string(direction)),
          detail(
            p.title
            <> " improves as the number "
            <> way
            <> ", so a \""
            <> operator_symbol(op)
            <> "\" target would set out to get worse.",
          ),
        ]
      }
      use <- guard(
        p.direction == attempt_row.Higher && wants_less,
        against("rises"),
      )
      use <- guard(
        p.direction == attempt_row.Lower && wants_more,
        against("falls"),
      )
      use <- guard(op == goal_row.Eq && precision != "integer", [
        #("error", json.string("TARGET_OPERATOR_INCOMPATIBLE")),
        #("operator", json.string(operator)),
        detail(
          p.title
          <> " is measured to "
          <> precision
          <> ", so an exact-equality target could never be reached.",
        ),
      ])
      let invalid = fn(text) {
        [#("error", json.string("TARGET_VALUE_INVALID")), detail(text)]
      }
      case raw.value {
        None -> Error(invalid("A target value must be a number."))
        Some(value) -> {
          use <- guard(
            value <=. 0.0,
            invalid("A target value must be greater than zero."),
          )
          use <- guard(value >. int.to_float(max_target_value), [
            #("error", json.string("TARGET_VALUE_OUT_OF_RANGE")),
            #("max", json.int(max_target_value)),
            detail(
              "A target value must be at most "
              <> int.to_string(max_target_value)
              <> ".",
            ),
          ])
          let whole = float.floor(value) == value
          use <- guard(
            precision == "integer" && !whole,
            invalid(
              p.title
              <> " is counted in whole "
              <> p.metric_unit
              <> ", so the target must be a whole number.",
            ),
          )
          // A fixed-window protocol cannot measure a duration longer than its window.
          let ceiling = int.to_float(p.protocol_window_ms) /. 1000.0
          use <- guard(
            p.metric_type == attempt_row.Duration
              && p.protocol_window_ms > 0
              && value >. ceiling,
            [
              #("error", json.string("TARGET_VALUE_OUT_OF_RANGE")),
              #("max", json_text.number(ceiling)),
              detail(
                p.title
                <> " measures at most "
                <> number_text(ceiling)
                <> " "
                <> p.metric_unit
                <> ".",
              ),
            ],
          )
          let assert Ok(metric_type) =
            goal_row.target_metric_type_from_string(metric)
          let assert Ok(direction) =
            goal_row.target_direction_from_string(direction)
          let assert Ok(precision) =
            goal_row.target_precision_from_string(precision)
          Ok(Target(
            protocol_id: p.id,
            protocol_version: p.version,
            metric_type:,
            metric_unit: p.metric_unit,
            operator: op,
            value:,
            protocol_title: p.title,
            direction:,
            precision:,
          ))
        }
      }
    }
  }
}

fn guard(
  refused: Bool,
  body: List(#(String, Json)),
  next: fn() -> Result(a, List(#(String, Json))),
) -> Result(a, List(#(String, Json))) {
  case refused {
    True -> Error(body)
    False -> next()
  }
}

pub fn target_json(t: Target) -> Json {
  json.object([
    #("sourceType", json.string("combine_attempt")),
    #("protocolId", json.string(t.protocol_id)),
    #("protocolVersion", json.int(t.protocol_version)),
    #("metricType", goal_row.target_metric_type_to_json(t.metric_type)),
    #("metricUnit", json.string(t.metric_unit)),
    #("operator", goal_row.target_operator_to_json(t.operator)),
    #("value", json_text.number(t.value)),
    #("protocolTitle", json.string(t.protocol_title)),
    #("direction", goal_row.target_direction_to_json(t.direction)),
    #("precision", goal_row.target_precision_to_json(t.precision)),
  ])
}

/// A goal row's target, when it has one.
pub fn target_of(g: goal_row.Row) -> Option(Target) {
  case
    g.target_protocol_id,
    g.target_protocol_version,
    g.target_metric_type,
    g.target_metric_unit,
    g.target_operator,
    g.target_value,
    g.target_protocol_title,
    g.target_direction,
    g.target_precision
  {
    Some(pid),
      Some(version),
      Some(mt),
      Some(unit),
      Some(op),
      Some(value),
      Some(title),
      Some(dir),
      Some(prec)
    ->
      Some(Target(
        protocol_id: pid,
        protocol_version: version,
        metric_type: mt,
        metric_unit: unit,
        operator: op,
        value:,
        protocol_title: title,
        direction: dir,
        precision: prec,
      ))
    _, _, _, _, _, _, _, _, _ -> None
  }
}

/// A goal row with `target` written into its target columns.
pub fn with_target(g: goal_row.Row, target: Option(Target)) -> goal_row.Row {
  case target {
    None ->
      goal_row.Row(
        ..g,
        target_source_type: None,
        target_protocol_id: None,
        target_protocol_version: None,
        target_metric_type: None,
        target_metric_unit: None,
        target_operator: None,
        target_value: None,
        target_protocol_title: None,
        target_direction: None,
        target_precision: None,
      )
    Some(t) ->
      goal_row.Row(
        ..g,
        target_source_type: Some(goal_row.CombineAttempt),
        target_protocol_id: Some(t.protocol_id),
        target_protocol_version: Some(t.protocol_version),
        target_metric_type: Some(t.metric_type),
        target_metric_unit: Some(t.metric_unit),
        target_operator: Some(t.operator),
        target_value: Some(t.value),
        target_protocol_title: Some(t.protocol_title),
        target_direction: Some(t.direction),
        target_precision: Some(t.precision),
      )
  }
}

pub fn compare(
  measured: Float,
  op: goal_row.TargetOperator,
  target: Float,
) -> Bool {
  case op {
    goal_row.Gte -> measured >=. target
    goal_row.Gt -> measured >. target
    goal_row.Lte -> measured <=. target
    goal_row.Lt -> measured <. target
    goal_row.Eq -> measured == target
  }
}

/// What a target reads of one Combine attempt.
pub type Measured {
  Measured(
    id: id.CombineAttemptId,
    protocol_id: String,
    protocol_version: Int,
    measured_value: Option(Float),
    completed_at: Option(Int),
    stored_state: attempt_row.CombineState,
    live_state: attempt_row.CombineState,
    test_only: Bool,
  )
}

/// Evidence a real target may rely on: Combine Verified now, a measured value, and not from a test-only provider.
pub fn production_valid(m: Measured) -> Bool {
  m.measured_value != None
  && !m.test_only
  && m.live_state == attempt_row.CombineVerified
}

/// Best in the protocol's direction; ties go to the earliest completion.
pub fn best_valid(attempts: List(Measured), t: Target) -> Option(Measured) {
  let value = fn(m: Measured) { option.unwrap(m.measured_value, 0.0) }
  let better = fn(x, y) {
    case t.direction {
      goal_row.Lower -> value(x) <. value(y)
      goal_row.Higher -> value(x) >. value(y)
    }
  }
  attempts
  |> list.filter(fn(a) {
    a.protocol_id == t.protocol_id
    && a.protocol_version == t.protocol_version
    && production_valid(a)
  })
  |> list.fold(None, fn(best, a) {
    case best {
      None -> Some(a)
      Some(b) ->
        case
          better(a, b)
          || value(a) == value(b)
          && option.unwrap(a.completed_at, 0) < option.unwrap(b.completed_at, 0)
        {
          True -> Some(a)
          False -> best
        }
    }
  })
}

pub type Evaluation {
  Evaluation(
    state: snapshot_row.TargetState,
    reason: Option(snapshot_row.TargetReason),
    best: Option(Measured),
  )
}

/// "Not met" and "not measured" are different facts. A target whose supporting result was invalidated returns
/// to `no_current_valid_measurement`.
pub fn evaluate_target(t: Target, attempts: List(Measured)) -> Evaluation {
  case best_valid(attempts, t) {
    Some(best) ->
      Evaluation(
        state: case
          compare(option.unwrap(best.measured_value, 0.0), t.operator, t.value)
        {
          True -> snapshot_row.TargetMet
          False -> snapshot_row.TargetNotMet
        },
        reason: None,
        best: Some(best),
      )
    None -> {
      let for_protocol =
        list.filter(attempts, fn(a) { a.protocol_id == t.protocol_id })
      let same_version =
        list.filter(for_protocol, fn(a) {
          a.protocol_version == t.protocol_version
        })
      let reason = case for_protocol, same_version {
        [], _ -> snapshot_row.NoAttempts
        _, [] -> snapshot_row.ProtocolVersionMismatch
        _, _ ->
          case
            list.any(same_version, fn(a) {
              a.live_state == attempt_row.CombineStateInvalidated
              && {
                a.stored_state == attempt_row.CombineVerified
                || a.stored_state == attempt_row.CombineStatePartiallyMeasured
              }
            })
          {
            True -> snapshot_row.MeasurementInvalidated
            False -> snapshot_row.NoProductionValidAttempt
          }
      }
      Evaluation(
        state: snapshot_row.NoCurrentValidMeasurement,
        reason: Some(reason),
        best: None,
      )
    }
  }
}

fn no_measurement_note(r: snapshot_row.TargetReason) -> String {
  case r {
    snapshot_row.NoAttempts ->
      "No Combine attempt has been recorded for this protocol yet."
    snapshot_row.NoProductionValidAttempt ->
      "There is no Combine Verified result for this protocol. A simulated or test result cannot satisfy a target."
    snapshot_row.ProtocolVersionMismatch ->
      "Results exist for this protocol, but under a different version of it. Measurements are not compared across protocol versions."
    snapshot_row.MeasurementInvalidated ->
      "The supporting Combine result was invalidated after review, so there is no current valid measurement. The link and its history are kept."
  }
}

pub fn evaluation_json(t: Target, e: Evaluation) -> Json {
  let value = number_text(t.value)
  json.object([
    #("sourceType", json.string("combine_attempt")),
    #("protocolId", json.string(t.protocol_id)),
    #("protocolVersion", json.int(t.protocol_version)),
    #("protocolTitle", json.string(t.protocol_title)),
    #("operator", goal_row.target_operator_to_json(t.operator)),
    #("operatorSymbol", json.string(operator_symbol(t.operator))),
    #("value", json_text.number(t.value)),
    #("metricUnit", json.string(t.metric_unit)),
    #(
      "statement",
      json.string(
        t.protocol_title
        <> " "
        <> operator_symbol(t.operator)
        <> " "
        <> value
        <> " "
        <> t.metric_unit,
      ),
    ),
    #("limitation", json.string(target_limitation)),
    #("state", snapshot_row.target_state_to_json(e.state)),
    #("reason", json.nullable(e.reason, snapshot_row.target_reason_to_json)),
    #("measured", case e.best {
      None -> json.null()
      Some(b) ->
        json.object([
          #("value", json.nullable(b.measured_value, json_text.number)),
          #("attemptId", id.combine_attempt_json(b.id)),
          #("completedAt", json.nullable(b.completed_at, json.int)),
          #("protocolVersion", json.int(b.protocol_version)),
          #("combineVerified", json.bool(True)),
        ])
    }),
    #(
      "note",
      json.string(case e.reason, e.state {
        Some(r), _ -> no_measurement_note(r)
        None, snapshot_row.TargetMet ->
          "The stated measurement has been reached. Whether the wider development goal is achieved is a decision for the plan owner or reviewer — one measurement is not the whole objective."
        None, _ -> "The stated measurement has not been reached yet."
      }),
    ),
  ])
}

// -------------------------------------------------------------------------------------------- permissions

/// Who is looking. There is no Trust & Safety or agency viewer: plans are not a moderation surface.
pub type Viewer {
  PlayerSelf(player_id: id.PlayerId, minor: Bool)
  GuardianOf(guardian_id: id.GuardianId, child_ids: List(id.PlayerId))
  StaffOf(org_id: id.OrgId, lead: Bool)
}

pub type Caps {
  Caps(
    read: Bool,
    read_internal: Bool,
    write_goals: Bool,
    manage: Bool,
    review: Bool,
    reflect: Bool,
    link_evidence: Bool,
  )
}

pub const no_caps = Caps(False, False, False, False, False, False, False)

pub fn caps_json(c: Caps) -> Json {
  json.object([
    #("read", json.bool(c.read)),
    #("readInternal", json.bool(c.read_internal)),
    #("writeGoals", json.bool(c.write_goals)),
    #("manage", json.bool(c.manage)),
    #("review", json.bool(c.review)),
    #("reflect", json.bool(c.reflect)),
    #("linkEvidence", json.bool(c.link_evidence)),
  ])
}

/// What a plan says about who may see it.
pub type PlanFacts {
  PlanFacts(
    player_id: id.PlayerId,
    owner_org_id: Option(id.OrgId),
    visibility: PlanVisibility,
    shared_with: List(id.OrgId),
  )
}

/// A viewer with no access gets the answer a nonexistent record would give. `org_can_see` is the live gate
/// search and Rooms use, so a block removes access everywhere at once.
pub fn plan_access(
  viewer: Viewer,
  plan: PlanFacts,
  player_minor: Bool,
  org_can_see: Bool,
) -> Caps {
  let shown_to_player = plan.visibility == plan_visibility.PlayerGuardian
  case viewer, plan.owner_org_id {
    // A minor only reads their own plan: their record-changing actions run through the guardian.
    PlayerSelf(pid, _), None if pid == plan.player_id ->
      case player_minor {
        True -> Caps(..no_caps, read: True)
        False ->
          Caps(
            ..no_caps,
            read: True,
            write_goals: True,
            manage: True,
            reflect: True,
            link_evidence: True,
          )
      }
    PlayerSelf(pid, _), Some(_) if pid == plan.player_id && shown_to_player ->
      Caps(..no_caps, read: True, reflect: !player_minor)
    GuardianOf(_, children), owner ->
      // An adult's guardian has no access, whatever the stored child list says.
      case list.contains(children, plan.player_id) && player_minor, owner {
        False, _ -> no_caps
        True, None ->
          Caps(
            ..no_caps,
            read: True,
            write_goals: True,
            manage: True,
            reflect: True,
            link_evidence: True,
          )
        True, Some(_) if shown_to_player ->
          Caps(..no_caps, read: True, reflect: True)
        True, Some(_) -> no_caps
      }
    StaffOf(org, lead), Some(owner) if org_can_see && owner == org ->
      Caps(
        read: True,
        read_internal: True,
        write_goals: True,
        manage: lead,
        review: True,
        reflect: False,
        link_evidence: True,
      )
    // A player's plan shared with this club: read-only.
    StaffOf(org, _), None if org_can_see ->
      case
        plan.visibility == plan_visibility.SharedWithOrg
        && list.contains(plan.shared_with, org)
      {
        True -> Caps(..no_caps, read: True)
        False -> no_caps
      }
    _, _ -> no_caps
  }
}

pub fn caps_has(c: Caps, cap: String) -> Bool {
  case cap {
    "read" -> c.read
    "readInternal" -> c.read_internal
    "writeGoals" -> c.write_goals
    "manage" -> c.manage
    "review" -> c.review
    "reflect" -> c.reflect
    _ -> c.link_evidence
  }
}

pub const viewer_kinds = [
  "player_self",
  "guardian",
  "org_staff",
  "grassroots_staff",
]

pub const capabilities = [
  "read", "readInternal", "writeGoals", "manage", "review", "reflect",
  "linkEvidence",
]

// -------------------------------------------------------------------------------------------------- timeline

/// An allowlist: history actions not listed never reach a timeline. Internal entries stay inside the owning
/// organisation.
pub fn timeline_entry(a: history_row.Action) -> Option(#(String, Bool)) {
  case a {
    history_row.PlanCreated -> Some(#("Plan created", False))
    history_row.PlanActivated -> Some(#("Plan activated", False))
    history_row.PlanPaused -> Some(#("Plan paused", False))
    history_row.PlanCompleted -> Some(#("Plan completed", False))
    history_row.PlanArchived -> Some(#("Plan archived", False))
    history_row.PlanShared -> Some(#("Plan shared", False))
    history_row.PlanUnshared -> Some(#("Sharing withdrawn", False))
    // A club decision; stays internal even when the plan is shared.
    history_row.PlanVisibilityChanged -> Some(#("Visibility changed", True))
    history_row.GoalCreated -> Some(#("Goal created", False))
    history_row.GoalUpdated -> Some(#("Goal updated", False))
    history_row.GoalStatusChanged -> Some(#("Goal status changed", False))
    history_row.GoalTargetSet -> Some(#("Objective target set", False))
    history_row.ActionCreated -> Some(#("Action created", False))
    history_row.ActionStatusChanged -> Some(#("Action status changed", False))
    history_row.ActionCompleted -> Some(#("Action completed", False))
    history_row.EvidenceLinked -> Some(#("Evidence linked", False))
    history_row.EvidenceUnlinked -> Some(#("Evidence link removed", False))
    history_row.ReviewSubmitted -> Some(#("Review submitted", True))
    history_row.ReviewShared -> Some(#("Review shared", False))
    history_row.ReviewSuperseded -> Some(#("Review corrected", True))
    history_row.PlanUpdated -> None
  }
}

pub fn timeline_actions() -> List(String) {
  list.filter_map(history_row.action_pairs, fn(p) {
    case timeline_entry(p.1) {
      Some(_) -> Ok(p.0)
      None -> Error(Nil)
    }
  })
}

// ------------------------------------------------------------------------------------------------- catalogue

/// Served so clients render the server's vocabulary rather than a copy.
pub fn catalogue() -> Json {
  let names = fn(pairs: List(#(String, a))) {
    strings(list.map(pairs, fn(p) { p.0 }))
  }
  json.object([
    #("policyVersion", json.int(policy_version)),
    #("principle", json.string(principle)),
    #("limitation", json.string(plan_limitation)),
    #(
      "plan",
      json.object([
        #("ownerKinds", names(plan_row.owner_kind_pairs)),
        #("visibility", names(plan_visibility.pairs)),
        #(
          "visibilityByOwner",
          json.object([
            #(
              "player",
              strings(["private", "player_guardian", "shared_with_org"]),
            ),
            #("org", strings(["org_private", "player_guardian"])),
          ]),
        ),
        #("statuses", names(plan_row.status_pairs)),
        #(
          "transitions",
          transitions_json(
            plan_row.status_pairs,
            plan_transitions,
            plan_row.status_to_string,
          ),
        ),
      ]),
    ),
    #(
      "goal",
      json.object([
        #("categories", names(goal_category.pairs)),
        #(
          "categoryLabels",
          json.object(
            list.map(goal_category.pairs, fn(p) {
              #(p.0, json.string(category_label(p.1)))
            }),
          ),
        ),
        #("statuses", names(goal_status.pairs)),
        #(
          "transitions",
          transitions_json(
            goal_status.pairs,
            goal_transitions,
            goal_status.to_string,
          ),
        ),
        #("blockReasons", names(goal_row.block_reason_pairs)),
        #("achievedMeaning", json.string(achieved_meaning)),
        #(
          "omitted",
          json.object([
            #("categories", strings(["availability_rehabilitation"])),
            #("blockReasons", strings(["injury_or_unavailable"])),
            #(
              "reason",
              json.string(
                "ScoutBox has no safe vocabulary, consent model or retention rule for health information, so it does not offer a structured field that invites one. A blocked goal can say “other” in the author’s own words.",
              ),
            ),
          ]),
        ),
      ]),
    ),
    #(
      "action",
      json.object([
        #("types", names(action_row.type_pairs)),
        #("statuses", names(action_row.status_pairs)),
        #(
          "transitions",
          // In the table's own order, which puts `blocked` before `done`.
          transitions_json(
            [
              #("todo", action_row.Todo),
              #("in_progress", action_row.InProgress),
              #("blocked", action_row.Blocked),
              #("done", action_row.Done),
              #("cancelled", action_row.Cancelled),
            ],
            action_transitions,
            action_row.status_to_string,
          ),
        ),
      ]),
    ),
    #(
      "evidence",
      json.object([
        #("sources", names(evidence_source.pairs)),
        #(
          "sourceLabels",
          json.object(
            list.map(evidence_source.pairs, fn(p) {
              #(p.0, json.string(source_label(p.1)))
            }),
          ),
        ),
      ]),
    ),
    #(
      "target",
      json.object([
        #("sources", strings(target_sources)),
        #("operators", strings(target_operators)),
        #("states", strings(target_states)),
        #("limitation", json.string(target_limitation)),
      ]),
    ),
    #(
      "review",
      json.object([
        #("reviewerKinds", names(review_row.reviewer_kind_pairs)),
        #(
          "reviewerKindLabels",
          json.object(
            list.map(review_row.reviewer_kind_pairs, fn(p) {
              #(p.0, json.string(reviewer_kind_label(p.1)))
            }),
          ),
        ),
        #("shareScopes", strings(share_scopes)),
        #("appendOnly", json.bool(True)),
      ]),
    ),
    #("timeline", json.object([#("actions", strings(timeline_actions()))])),
    #(
      "goalLibrary",
      json.object([
        #(
          "items",
          json.array(goal_library, fn(g) {
            json.object([
              #("id", json.string(g.id)),
              #("category", goal_category.to_json(g.category)),
              #("title", json.string(g.title)),
            ])
          }),
        ),
        #("note", json.string(goal_library_note)),
      ]),
    ),
    #(
      "templates",
      json.object([
        #(
          "items",
          json.array(templates, fn(t) {
            json.object([
              #("id", plan_row.template_id_to_json(t.id)),
              #("title", json.string(t.title)),
              #(
                "goals",
                json.array(t.goals, fn(c) {
                  json.object([#("category", goal_category.to_json(c))])
                }),
              ),
            ])
          }),
        ),
        #("note", json.string(template_note)),
      ]),
    ),
    #("limits", limits_json()),
    #("viewerKinds", strings(viewer_kinds)),
    #("capabilities", strings(capabilities)),
    #(
      "reminders",
      json.object([
        #("scheduler", json.string("none")),
        #(
          "note",
          json.string(
            "Due and overdue are worked out when you open the page. ScoutBox has no background scheduler in this build and does not send reminders while the app is closed.",
          ),
        ),
      ]),
    ),
    #(
      "neverBuilt",
      json.object([
        #("names", strings(forbidden_development_names)),
        #(
          "note",
          json.string(
            "These do not exist in ScoutBox and are not planned. Development here is objective-specific, or it is nothing.",
          ),
        ),
      ]),
    ),
    #("vocabularyCheck", vocabulary_counts()),
  ])
}

// ------------------------------------------------------------------------------------------------ the views

fn text_pair(key: String, value: String) -> #(String, Json) {
  #(key, json.string(value))
}

/// What was true of each goal at the review: its state and evidence ids, never a copy of the Passport.
pub fn goal_snapshots(
  rid: id.DevReviewId,
  goals: List(goal_row.Row),
  actions: List(action_row.Row),
  links: List(link_row.Row),
  attempts: List(Measured),
) -> List(hub.Snapshot) {
  goals
  |> list.sort(fn(a, c) {
    case int.compare(a.created_at, c.created_at) {
      order.Eq ->
        string.compare(id.dev_goal_to_string(a.id), id.dev_goal_to_string(c.id))
      other -> other
    }
  })
  |> list.index_map(fn(g, i) {
    let me = g.id
    let counts =
      list.filter(actions, fn(a) { a.goal_id == me })
      |> list.map(fn(a) { a.status })
      |> action_counts
    let gid = Some(me)
    let refs =
      list.filter(links, fn(l) { l.goal_id == gid })
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
      target_of(g)
      |> option.map(evaluate_target(_, attempts))
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

pub fn snapshot_json(s: hub.Snapshot) -> Json {
  let r = s.row
  json.object([
    #("goalId", id.dev_goal_json(r.goal_id)),
    text_pair("title", r.title),
    #("category", goal_category.to_json(r.category)),
    #("status", goal_status.to_json(r.status)),
    #(
      "actionCounts",
      json.object([
        #("total", json.int(r.actions_total)),
        #("done", json.int(r.actions_done)),
        #("blocked", json.int(r.actions_blocked)),
        #("cancelled", json.int(r.actions_cancelled)),
      ]),
    ),
    #(
      "completion",
      completion_json(r.actions_done, r.actions_total, r.actions_cancelled),
    ),
    #(
      "evidenceRefs",
      json.array(s.refs, fn(x) {
        json.object([
          #("sourceType", evidence_source.to_json(x.source_type)),
          text_pair("sourceId", x.source_id),
        ])
      }),
    ),
    #("targetStateAtReview", case r.target_state {
      Some(state) ->
        json.object([
          #("state", snapshot_row.target_state_to_json(state)),
          #(
            "reason",
            json.nullable(r.target_reason, snapshot_row.target_reason_to_json),
          ),
          #("measured", json.nullable(r.target_measured, json_text.number)),
        ])
      None -> json.null()
    }),
  ])
}

/// The internal note is a club talking to itself about a player who may read the same record, so it is stripped
/// here, never in a client.
pub fn review_json(r: Review, caps: Caps) -> Json {
  let x = r.row
  let base = [
    #("id", id.dev_review_json(x.id)),
    #("planId", id.dev_plan_json(x.plan_id)),
    #("reviewerKind", review_row.reviewer_kind_to_json(x.reviewer_kind)),
    #("reviewedByName", json.nullable(x.reviewed_by_name, json.string)),
    #("orgId", json.nullable(x.org_id, id.org_json)),
    #("reviewedAt", json.int(x.reviewed_at)),
    #("nextReviewAt", json.nullable(x.next_review_at, json.int)),
    #("goalSnapshots", json.array(r.snapshots, snapshot_json)),
    #("supersedes", json.nullable(x.supersedes_review_id, id.dev_review_json)),
    #("supersededBy", json.nullable(r.superseded_by, id.dev_review_json)),
    #("hasInternalNote", json.bool(x.internal_note != None)),
  ]
  case caps.read_internal {
    True ->
      json.object(
        list.append(base, [
          #("summary", json.nullable(x.shared_summary, json.string)),
          #("internalNote", json.nullable(x.internal_note, json.string)),
        ]),
      )
    False ->
      json.object(
        list.append(base, [
          #("summary", json.nullable(shared_summary(x), json.string)),
          #("internalNote", json.null()),
          // Admits a private note exists without revealing it.
          #("internalNoteNote", case x.internal_note {
            Some(_) ->
              json.string(
                "This review also contains notes kept inside the club. They are not shared.",
              )
            None -> json.null()
          }),
        ]),
      )
  }
}

fn shared_summary(x: review_row.Row) -> Option(String) {
  case x.shared_with_player_at {
    Some(_) -> x.shared_summary
    None -> None
  }
}

/// `review_json`, or `None` for an unshared coach review outside the club: even an empty row would disclose that
/// the club wrote one.
pub fn review_view(r: Review, caps: Caps) -> Option(Json) {
  case caps.read_internal, shared_summary(r.row), r.row.reviewer_kind {
    False, None, review_row.CoachReview -> None
    _, _, _ -> Some(review_json(r, caps))
  }
}

/// Counts only, never a confidence or strength figure: each linked item as (available, simulated).
pub fn summarise_evidence(items: List(#(Bool, Bool))) -> Json {
  let total = list.length(items)
  let available = list.count(items, fn(i) { i.0 })
  json.object([
    #("total", json.int(total)),
    #("available", json.int(available)),
    #("unavailable", json.int(total - available)),
    #("simulated", json.int(list.count(items, fn(i) { i.1 }))),
    #(
      "note",
      json.string(case total {
        0 -> "No evidence linked yet."
        _ ->
          int.to_string(available)
          <> " of "
          <> int.to_string(total)
          <> " linked items are currently available."
      }),
    ),
  ])
}

/// What a target reads of one stored attempt: its live state shows the bound session's invalidation through.
pub fn measured_of(
  id: id.CombineAttemptId,
  protocol_id: String,
  protocol_version: Int,
  measured_value: Option(Float),
  completed_at: Option(Int),
  state: attempt_row.CombineState,
  session: Option(session_row.VerificationState),
  provider: BoxProvider,
) -> Measured {
  Measured(
    id:,
    protocol_id:,
    protocol_version:,
    measured_value:,
    completed_at:,
    stored_state: state,
    live_state: combine_rules.live_state(state, session),
    test_only: box_rules.provider(provider).test_only,
  )
}

/// `{ value }` or the refusal, as `validateTarget` answers.
pub fn validate_target_json(raw: TargetInput) -> Json {
  case validate_target(raw) {
    Ok(t) -> json.object([#("value", target_json(t))])
    Error(fields) -> json.object(fields)
  }
}

/// `{ value }` or the refusal, as `boundedText` answers.
pub fn bounded_text_json(raw: Option(String), max: Int, field: String) -> Json {
  case bounded_text(raw, max, field) {
    Ok(v) -> json.object([#("value", json.nullable(v, json.string))])
    Error(fields) -> json.object(fields)
  }
}

/// Reviews newest first then id, `limit` of them (25 by default, at most `reviews_page_max`) after the one named
/// `cursor`; a cursor naming no review is refused. Each review is (id, reviewed at).
pub fn page_reviews(
  reviews: List(#(String, Int)),
  limit: Option(Int),
  cursor: Option(String),
) -> Result(#(List(#(String, Int)), Int, Option(String)), Nil) {
  let all =
    list.sort(reviews, fn(a, b) {
      case int.compare(b.1, a.1) {
        order.Eq -> string.compare(b.0, a.0)
        other -> other
      }
    })
  let size = case limit {
    Some(n) if n != 0 -> int.min(int.max(n, 1), reviews_page_max)
    _ -> 25
  }
  use rest <- result.map(case cursor {
    None | Some("") -> Ok(all)
    Some(c) ->
      case list.split_while(all, fn(x) { x.0 != c }) {
        #(_, [_, ..rest]) -> Ok(rest)
        #(_, []) -> Error(Nil)
      }
  })
  let page = list.take(rest, size)
  #(page, list.length(all), case list.length(rest) > size, list.last(page) {
    True, Ok(last) -> Some(last.0)
    _, _ -> None
  })
}

/// The copy that names a forbidden product name, each as `where: contains forbidden name "<name>"`.
pub fn scan_copy(pairs: List(#(String, String))) -> List(String) {
  let forbidden = list.map(forbidden_development_names, string.lowercase)
  list.flat_map(pairs, fn(p) {
    let t = string.lowercase(p.1)
    list.filter_map(forbidden, fn(f) {
      case string.contains(t, f) {
        True -> Ok(p.0 <> ": contains forbidden name \"" <> f <> "\"")
        False -> Error(Nil)
      }
    })
  })
}

/// The boot assertion's report: the copy this server serves scanned for forbidden names, and the vocabulary's
/// sizes. Its types already refuse a transition naming an unknown status.
pub fn vocabulary_check() -> Json {
  let copy =
    list.flatten([
      list.map(goal_category.pairs, fn(p) {
        #("GOAL_CATEGORY_LABELS." <> p.0, category_label(p.1))
      }),
      list.map(evidence_source.pairs, fn(p) {
        #("EVIDENCE_SOURCE_LABELS." <> p.0, source_label(p.1))
      }),
      list.map(review_row.reviewer_kind_pairs, fn(p) {
        #("REVIEWER_KIND_LABELS." <> p.0, reviewer_kind_label(p.1))
      }),
      list.map(goal_library, fn(g) { #("GOAL_LIBRARY." <> g.id, g.title) }),
      list.map(templates, fn(t) {
        #("PLAN_TEMPLATES." <> plan_row.template_id_to_string(t.id), t.title)
      }),
      [
        #("DEVELOPMENT_PRINCIPLE", principle),
        #("ACHIEVED_MEANING", achieved_meaning),
      ],
    ])
  json.object([
    #("policyVersion", json.int(policy_version)),
    #("problems", json.array(scan_copy(copy), json.string)),
    #("counts", vocabulary_counts()),
  ])
}

pub fn vocabulary_counts() -> Json {
  json.object([
    #("planStatuses", json.int(list.length(plan_row.status_pairs))),
    #("goalStatuses", json.int(list.length(goal_status.pairs))),
    #("goalCategories", json.int(list.length(goal_category.pairs))),
    #("actionTypes", json.int(list.length(action_row.type_pairs))),
    #("actionStatuses", json.int(list.length(action_row.status_pairs))),
    #("evidenceSources", json.int(list.length(evidence_source.pairs))),
    #("forbiddenNames", json.int(list.length(forbidden_development_names))),
    #("forbiddenFields", json.int(list.length(forbidden_field_names))),
  ])
}
