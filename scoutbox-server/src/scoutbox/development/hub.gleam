//// The Development Hub's records (repositories/development.mjs, its plans, goals, actions, links and reviews):
//// each plan, goal, action and review keeps an append-only history in `development_history`, whose rows name
//// their plan, so a plan's timeline is one indexed query. An act writes its record's new columns and appends its
//// history entries; nothing is rewritten in place.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/development_actions as action_row
import scoutbox/rows/development_evidence_links as link_row
import scoutbox/rows/development_goals as goal_row
import scoutbox/rows/development_history as history_row
import scoutbox/rows/development_plan_shares as share_row
import scoutbox/rows/development_plans as plan_row
import scoutbox/rows/development_review_snapshot_refs as ref_row
import scoutbox/rows/development_review_snapshots as snapshot_row
import scoutbox/rows/development_reviews as review_row
import scoutbox/rows/id
import scoutbox/vocab/goal_status.{type GoalStatus}
import scoutbox/vocab/plan_visibility
import sqlight

// ---------------------------------------------------------------------------------------------------- records

pub type Plan {
  Plan(
    row: plan_row.Row,
    shared_with: List(id.OrgId),
    history: List(history_row.Row),
  )
}

pub type Goal {
  Goal(row: goal_row.Row, history: List(history_row.Row))
}

pub type Action {
  Action(row: action_row.Row, history: List(history_row.Row))
}

pub type Snapshot {
  Snapshot(row: snapshot_row.Row, refs: List(ref_row.Row))
}

pub type Review {
  Review(
    row: review_row.Row,
    snapshots: List(Snapshot),
    superseded_by: Option(id.DevReviewId),
    history: List(history_row.Row),
  )
}

/// Everything one plan holds: goals oldest first, actions, links and reviews in insertion order.
pub type Bundle {
  Bundle(
    plan: Plan,
    goals: List(Goal),
    actions: List(Action),
    links: List(link_row.Row),
    reviews: List(Review),
  )
}

/// Who wrote a Hub record. `org` carries a staff id.
pub type Actor {
  ActorPlayer(id: String, name: String)
  ActorGuardian(id: String, name: String)
  ActorStaff(id: String, name: String)
}

pub fn actor_kind(a: Actor) -> String {
  case a {
    ActorPlayer(..) -> "player"
    ActorGuardian(..) -> "guardian"
    ActorStaff(..) -> "org"
  }
}

pub fn history_kind(a: Actor) -> history_row.ByKind {
  case a {
    ActorPlayer(..) -> history_row.ByKindPlayer
    ActorGuardian(..) -> history_row.Guardian
    ActorStaff(..) -> history_row.ByKindOrg
  }
}

pub fn plan_creator_kind(a: Actor) -> plan_row.CreatedByKind {
  case a {
    ActorPlayer(..) -> plan_row.CreatedByKindPlayer
    ActorGuardian(..) -> plan_row.Guardian
    ActorStaff(..) -> plan_row.CreatedByKindOrg
  }
}

pub fn goal_creator_kind(a: Actor) -> goal_row.CreatedByKind {
  case a {
    ActorPlayer(..) -> goal_row.Player
    ActorGuardian(..) -> goal_row.Guardian
    ActorStaff(..) -> goal_row.Org
  }
}

pub fn action_creator_kind(a: Actor) -> action_row.CreatedByKind {
  case a {
    ActorPlayer(..) -> action_row.Player
    ActorGuardian(..) -> action_row.Guardian
    ActorStaff(..) -> action_row.Org
  }
}

pub fn link_kind(a: Actor) -> link_row.LinkedByKind {
  case a {
    ActorPlayer(..) -> link_row.Player
    ActorGuardian(..) -> link_row.Guardian
    ActorStaff(..) -> link_row.Org
  }
}

pub fn review_kind(a: Actor) -> review_row.ReviewedByKind {
  case a {
    ActorPlayer(..) -> review_row.Player
    ActorGuardian(..) -> review_row.Guardian
    ActorStaff(..) -> review_row.Org
  }
}

// ---------------------------------------------------------------------------------------------------- history

/// A history entry's server-written detail: a status, a kind or an id, never free text.
pub type Detail {
  Detail(
    from: Option(String),
    to: Option(String),
    visibility: Option(plan_visibility.PlanVisibility),
    owner: Option(history_row.DetailOwner),
    kind: Option(String),
    protocol_id: Option(String),
    note: Option(Bool),
  )
}

pub const no_detail = Detail(None, None, None, None, None, None, None)

/// What a history entry belongs to.
pub type Owner {
  OfPlan(id.DevPlanId)
  OfGoal(id.DevPlanId, id.DevGoalId)
  OfAction(id.DevPlanId, id.DevActionId)
  OfReview(id.DevPlanId, id.DevReviewId)
}

/// Appends one history entry, minted now.
pub fn record(
  tx: Tx,
  owner: Owner,
  actor: Actor,
  action: history_row.Action,
  detail: Detail,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use eid <- result.try(id.next_dev_event(tx))
  let plan_id = case owner {
    OfPlan(p) | OfGoal(p, _) | OfAction(p, _) | OfReview(p, _) -> p
  }
  let base =
    history_row.Row(
      ..history_row.new(
        id: eid,
        plan_id:,
        at:,
        by_kind: history_kind(actor),
        by_id: actor.id,
        action:,
      ),
      by_name: Some(actor.name),
      detail_from: detail.from,
      detail_to: detail.to,
      detail_visibility: detail.visibility,
      detail_owner: detail.owner,
      detail_kind: detail.kind,
      detail_protocol_id: detail.protocol_id,
      detail_note: detail.note,
    )
  history_row.insert(tx, case owner {
    OfPlan(_) -> base
    OfGoal(_, g) -> history_row.Row(..base, goal_id: Some(g))
    OfAction(_, a) -> history_row.Row(..base, action_id: Some(a))
    OfReview(_, r) -> history_row.Row(..base, review_id: Some(r))
  })
}

fn history_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(history_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> history_row.columns
      <> " FROM development_history WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    history_row.decoder(),
  )
}

// ------------------------------------------------------------------------------------------------------ reads

fn shares_of(read: Read, pid: id.DevPlanId) -> Result(List(id.OrgId), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> share_row.columns
      <> " FROM development_plan_shares WHERE plan_id = ? ORDER BY ord",
    [id.dev_plan_sql(pid)],
    share_row.decoder(),
  )
  |> result.map(list.map(_, fn(s) { s.org_id }))
}

fn plan_of(
  read: Read,
  row: plan_row.Row,
  with_history: Bool,
) -> Result(Plan, Fail(e)) {
  use shared_with <- result.try(shares_of(read, row.id))
  use history <- result.map(case with_history {
    True ->
      history_where(
        read,
        "plan_id = ? AND goal_id IS NULL AND action_id IS NULL AND review_id IS NULL",
        [id.dev_plan_sql(row.id)],
      )
    False -> Ok([])
  })
  Plan(row:, shared_with:, history:)
}

pub fn plan_by_id(
  read: Read,
  pid: id.DevPlanId,
) -> Result(Option(Plan), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> plan_row.columns <> " FROM development_plans WHERE id = ?",
    [id.dev_plan_sql(pid)],
    plan_row.decoder(),
  ))
  case found {
    Ok(row) -> plan_of(read, row, True) |> result.map(Some)
    Error(Nil) -> Ok(None)
  }
}

pub fn goal_by_id(
  read: Read,
  gid: id.DevGoalId,
) -> Result(Option(goal_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> goal_row.columns <> " FROM development_goals WHERE id = ?",
    [id.dev_goal_sql(gid)],
    goal_row.decoder(),
  )
  |> result.map(option.from_result)
}

pub fn action_by_id(
  read: Read,
  aid: id.DevActionId,
) -> Result(Option(action_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> action_row.columns <> " FROM development_actions WHERE id = ?",
    [id.dev_action_sql(aid)],
    action_row.decoder(),
  )
  |> result.map(option.from_result)
}

pub fn link_by_id(
  read: Read,
  lid: id.DevLinkId,
) -> Result(Option(link_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> link_row.columns
      <> " FROM development_evidence_links WHERE id = ?",
    [id.dev_link_sql(lid)],
    link_row.decoder(),
  )
  |> result.map(option.from_result)
}

pub fn review_by_id(
  read: Read,
  rid: id.DevReviewId,
) -> Result(Option(review_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> review_row.columns <> " FROM development_reviews WHERE id = ?",
    [id.dev_review_sql(rid)],
    review_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// The plan with everything it holds, or `None`.
pub fn collect(
  read: Read,
  pid: id.DevPlanId,
) -> Result(Option(Bundle), Fail(e)) {
  use found <- result.try(plan_by_id(read, pid))
  case found {
    None -> Ok(None)
    Some(plan) -> {
      let arg = [id.dev_plan_sql(pid)]
      use goal_rows <- result.try(store.query(
        read,
        "SELECT "
          <> goal_row.columns
          <> " FROM development_goals WHERE plan_id = ? ORDER BY created_at, id",
        arg,
        goal_row.decoder(),
      ))
      use goals <- result.try(
        list.try_map(goal_rows, fn(g) {
          history_where(read, "goal_id = ?", [id.dev_goal_sql(g.id)])
          |> result.map(Goal(g, _))
        }),
      )
      use action_rows <- result.try(store.query(
        read,
        "SELECT "
          <> action_row.columns
          <> " FROM development_actions WHERE plan_id = ? ORDER BY rowid",
        arg,
        action_row.decoder(),
      ))
      use actions <- result.try(
        list.try_map(action_rows, fn(a) {
          history_where(read, "action_id = ?", [id.dev_action_sql(a.id)])
          |> result.map(Action(a, _))
        }),
      )
      use links <- result.try(store.query(
        read,
        "SELECT "
          <> link_row.columns
          <> " FROM development_evidence_links WHERE plan_id = ? ORDER BY rowid",
        arg,
        link_row.decoder(),
      ))
      use review_rows <- result.try(store.query(
        read,
        "SELECT "
          <> review_row.columns
          <> " FROM development_reviews WHERE plan_id = ? ORDER BY rowid",
        arg,
        review_row.decoder(),
      ))
      use reviews <- result.map(
        list.try_map(review_rows, fn(r) { review_of(read, r, review_rows) }),
      )
      Some(Bundle(plan:, goals:, actions:, links:, reviews:))
    }
  }
}

fn review_of(
  read: Read,
  r: review_row.Row,
  all: List(review_row.Row),
) -> Result(Review, Fail(e)) {
  let rid = [id.dev_review_sql(r.id)]
  use snaps <- result.try(store.query(
    read,
    "SELECT "
      <> snapshot_row.columns
      <> " FROM development_review_snapshots WHERE review_id = ? ORDER BY ord",
    rid,
    snapshot_row.decoder(),
  ))
  use refs <- result.try(store.query(
    read,
    "SELECT "
      <> ref_row.columns
      <> " FROM development_review_snapshot_refs WHERE review_id = ? ORDER BY ord",
    rid,
    ref_row.decoder(),
  ))
  use history <- result.map(history_where(read, "review_id = ?", rid))
  let me = Some(r.id)
  Review(
    row: r,
    snapshots: list.map(snaps, fn(s) {
      Snapshot(s, list.filter(refs, fn(x) { x.goal_id == s.goal_id }))
    }),
    superseded_by: list.find(all, fn(x) { x.supersedes_review_id == me })
      |> result.map(fn(x) { x.id })
      |> option.from_result,
    history:,
  )
}

fn ids_json(ids: List(String)) -> sqlight.Value {
  sqlight.text(json.to_string(json.array(ids, json.string)))
}

fn status_arg(status: Option(plan_row.Status)) -> sqlight.Value {
  case status {
    Some(s) -> sqlight.text(plan_row.status_to_string(s))
    None -> sqlight.null()
  }
}

fn plans_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Plan), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> plan_row.columns
      <> " FROM development_plans WHERE "
      <> where
      <> " ORDER BY updated_at DESC, id",
    args,
    plan_row.decoder(),
  ))
  list.try_map(rows, plan_of(read, _, False))
}

/// A player's or a guardian's children's plans, most recently updated first then id, without their history.
/// The caller applies the access rule.
pub fn for_players(
  read: Read,
  players: List(id.PlayerId),
  status: Option(plan_row.Status),
) -> Result(List(Plan), Fail(e)) {
  plans_where(
    read,
    "player_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR status = ?)",
    [
      ids_json(list.map(players, id.player_to_string)),
      status_arg(status),
      status_arg(status),
    ],
  )
}

/// The plans an organisation owns or was shared, in list order.
pub fn for_org(
  read: Read,
  org: id.OrgId,
  player: Option(id.PlayerId),
  status: Option(plan_row.Status),
) -> Result(List(Plan), Fail(e)) {
  let player_arg = case player {
    Some(p) -> id.player_sql(p)
    None -> sqlight.null()
  }
  plans_where(
    read,
    "(owner_org_id = ? OR id IN (SELECT plan_id FROM development_plan_shares WHERE org_id = ?)) AND (? IS NULL OR player_id = ?) AND (? IS NULL OR status = ?)",
    [
      id.org_sql(org),
      id.org_sql(org),
      player_arg,
      player_arg,
      status_arg(status),
      status_arg(status),
    ],
  )
}

/// A plan's goal statuses and its actions' statuses and due dates, for its list row.
pub fn list_counts(
  read: Read,
  pid: id.DevPlanId,
) -> Result(
  #(List(GoalStatus), List(#(action_row.Status, Option(Int)))),
  Fail(e),
) {
  use goals <- result.try(store.query(
    read,
    "SELECT status FROM development_goals WHERE plan_id = ? ORDER BY rowid",
    [id.dev_plan_sql(pid)],
    decode.at([0], goal_status.decoder()),
  ))
  use actions <- result.map(
    store.query(
      read,
      "SELECT status, due_at FROM development_actions WHERE plan_id = ? ORDER BY rowid",
      [id.dev_plan_sql(pid)],
      {
        use s <- decode.field(0, action_row.status_decoder())
        use d <- decode.field(1, decode.optional(decode.int))
        decode.success(#(s, d))
      },
    ),
  )
  #(goals, actions)
}

fn owner_org_arg(org: Option(id.OrgId)) -> sqlight.Value {
  case org {
    Some(o) -> id.org_sql(o)
    None -> sqlight.null()
  }
}

/// How many of the player's plans this owner has that are not completed or archived.
pub fn open_count(
  read: Read,
  player: id.PlayerId,
  owner: plan_row.OwnerKind,
  owner_org: Option(id.OrgId),
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM development_plans WHERE player_id = ? AND owner_kind = ? AND owner_org_id IS ? AND status NOT IN ('completed','archived')",
    [
      id.player_sql(player),
      sqlight.text(plan_row.owner_kind_to_string(owner)),
      owner_org_arg(owner_org),
    ],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// The plan this create repeats: the same author made one with this title and owner for this player since
/// `since`.
pub fn recent_create(
  read: Read,
  player: id.PlayerId,
  title: String,
  created_by: String,
  owner: plan_row.OwnerKind,
  owner_org: Option(id.OrgId),
  since: Int,
) -> Result(Option(id.DevPlanId), Fail(e)) {
  store.one(
    read,
    "SELECT id FROM development_plans WHERE player_id = ? AND title = ? AND created_by_id = ? AND owner_kind = ? AND owner_org_id IS ? AND created_at > ? ORDER BY rowid LIMIT 1",
    [
      id.player_sql(player),
      sqlight.text(title),
      sqlight.text(created_by),
      sqlight.text(plan_row.owner_kind_to_string(owner)),
      owner_org_arg(owner_org),
      sqlight.int(since),
    ],
    decode.at([0], id.dev_plan_decoder()),
  )
  |> result.map(option.from_result)
}

/// An entry of an organisation's audit feed: one of its own plans' lifecycle entries, or one of its reviews'.
pub type FeedEntry {
  PlanEntry(
    entry: history_row.Row,
    plan_id: id.DevPlanId,
    title: String,
    player_id: id.PlayerId,
  )
  ReviewEntry(entry: history_row.Row, review_id: id.DevReviewId)
}

/// The history entries an organisation's audit feed shows: those of the plans it owns, then those of the reviews
/// it wrote, each in insertion order.
pub fn org_feed(
  read: Read,
  org: id.OrgId,
  actions: List(String),
) -> Result(List(FeedEntry), Fail(e)) {
  let wanted = ids_json(actions)
  use plans <- result.try(
    store.query(
      read,
      "SELECT "
        <> history_row.qualified("h")
        <> ", p.title, p.player_id FROM development_history h JOIN development_plans p ON p.id = h.plan_id WHERE p.owner_org_id = ? AND h.goal_id IS NULL AND h.action_id IS NULL AND h.review_id IS NULL AND h.action IN (SELECT value FROM json_each(?)) ORDER BY h.rowid",
      [id.org_sql(org), wanted],
      {
        use h <- decode.then(history_row.decoder())
        use title <- decode.field(history_row.width, decode.string)
        use player <- decode.field(history_row.width + 1, id.player_decoder())
        decode.success(PlanEntry(h, h.plan_id, title, player))
      },
    ),
  )
  use reviews <- result.map(store.query(
    read,
    "SELECT "
      <> history_row.qualified("h")
      <> " FROM development_history h JOIN development_reviews r ON r.id = h.review_id WHERE r.org_id = ? AND h.action IN (SELECT value FROM json_each(?)) ORDER BY h.rowid",
    [id.org_sql(org), wanted],
    history_row.decoder(),
  ))
  list.append(
    plans,
    list.filter_map(reviews, fn(h) {
      case h.review_id {
        Some(r) -> Ok(ReviewEntry(h, r))
        None -> Error(Nil)
      }
    }),
  )
}

// ----------------------------------------------------------------------------------------------------- writes

/// `UPDATE table SET <every column> = ? WHERE id = ?`: a record is written whole, its key unchanged.
fn rewrite(
  tx: Tx,
  table: String,
  columns: String,
  values: List(sqlight.Value),
  key: sqlight.Value,
) -> Result(Nil, Fail(e)) {
  let sets =
    string.split(columns, ", ")
    |> list.map(fn(c) { c <> " = ?" })
    |> string.join(", ")
  store.run(
    tx,
    "UPDATE " <> table <> " SET " <> sets <> " WHERE id = ?",
    list.append(values, [key]),
  )
}

pub fn insert_plan(tx: Tx, row: plan_row.Row) -> Result(Nil, Fail(e)) {
  plan_row.insert(tx, row)
}

pub fn update_plan(tx: Tx, row: plan_row.Row) -> Result(Nil, Fail(e)) {
  rewrite(
    tx,
    "development_plans",
    plan_row.columns,
    plan_row.values(row),
    id.dev_plan_sql(row.id),
  )
}

/// The organisations the plan is shared with, in order.
pub fn set_shares(
  tx: Tx,
  pid: id.DevPlanId,
  orgs: List(id.OrgId),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM development_plan_shares WHERE plan_id = ?", [
      id.dev_plan_sql(pid),
    ]),
  )
  list.index_map(orgs, fn(o, i) { #(o, i) })
  |> list.try_each(fn(p) {
    share_row.insert(tx, share_row.Row(plan_id: pid, ord: p.1, org_id: p.0))
  })
}

pub fn insert_goal(tx: Tx, row: goal_row.Row) -> Result(Nil, Fail(e)) {
  goal_row.insert(tx, row)
}

pub fn update_goal(tx: Tx, row: goal_row.Row) -> Result(Nil, Fail(e)) {
  rewrite(
    tx,
    "development_goals",
    goal_row.columns,
    goal_row.values(row),
    id.dev_goal_sql(row.id),
  )
}

pub fn insert_action(tx: Tx, row: action_row.Row) -> Result(Nil, Fail(e)) {
  action_row.insert(tx, row)
}

pub fn update_action(tx: Tx, row: action_row.Row) -> Result(Nil, Fail(e)) {
  rewrite(
    tx,
    "development_actions",
    action_row.columns,
    action_row.values(row),
    id.dev_action_sql(row.id),
  )
}

pub fn insert_link(tx: Tx, row: link_row.Row) -> Result(Nil, Fail(e)) {
  link_row.insert(tx, row)
}

/// Unlinking deletes the link; the holder's history records it.
pub fn delete_link(tx: Tx, lid: id.DevLinkId) -> Result(Nil, Fail(e)) {
  store.run(tx, "DELETE FROM development_evidence_links WHERE id = ?", [
    id.dev_link_sql(lid),
  ])
}

pub fn insert_review(
  tx: Tx,
  row: review_row.Row,
  snapshots: List(Snapshot),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(review_row.insert(tx, row))
  list.try_each(snapshots, fn(s) {
    use _ <- result.try(snapshot_row.insert(tx, s.row))
    list.try_each(s.refs, ref_row.insert(tx, _))
  })
}

pub fn update_review(tx: Tx, row: review_row.Row) -> Result(Nil, Fail(e)) {
  rewrite(
    tx,
    "development_reviews",
    review_row.columns,
    review_row.values(row),
    id.dev_review_sql(row.id),
  )
}
