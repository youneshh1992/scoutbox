//// Development objectives (domains/development/objectives.mjs): one or two focused objectives grown from feedback a
//// club chose to publish (never a private assessment), the player's progress against them, and the reassessment the
//// player (a guardian for a child) asks of the club. Sharing progress back with the club is the player's explicit
//// choice, and the club sees only what is shared with it.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/set
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/dev_objective_item_evidence as item_evidence_row
import scoutbox/rows/dev_objective_item_exercises as exercise_row
import scoutbox/rows/dev_objective_items as item_row
import scoutbox/rows/dev_objective_progress as progress_row
import scoutbox/rows/dev_objective_reassessment_evidence as outcome_evidence_row
import scoutbox/rows/dev_objective_reassessments as reassessment_row
import scoutbox/rows/dev_objective_shares as share_row
import scoutbox/rows/dev_objectives as row
import scoutbox/rows/id
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

// DEVELOPMENT_LIMITS (repositories/development.mjs).
const objective_items_max = 2

const objective_text_max = 200

const exercise_refs_max = 4

const exercise_ref_max = 200

const evidence_ids_max = 50

const progress_note_max = 300

const outcome_note_max = 500

/// schemas.mjs `ID_MAX`.
const id_max = 80

/// A list the schema doesn't bound: the route judges how many.
const any_length = 9_007_199_254_740_991

// ---------------------------------------------------------------------------------------------------- records

pub type Item {
  Item(
    row: item_row.Row,
    exercise_refs: List(String),
    baseline_evidence_ids: List(id.ScoutingEvidenceId),
  )
}

pub type Reassessment {
  Reassessment(
    row: reassessment_row.Row,
    evidence_ids: List(id.ScoutingEvidenceId),
  )
}

pub type Objective {
  Objective(
    row: row.Row,
    items: List(Item),
    progress: List(progress_row.Row),
    shared_with: List(id.OrgId),
    reassessments: List(Reassessment),
  )
}

/// Who acted: the player, or a guardian for a child.
type Actor {
  Actor(kind: party.Party, id: String, name: String)
}

fn player_actor(p: Player) -> Actor {
  Actor(party.Player, id.player_to_string(p.row.id), p.row.name)
}

fn guardian_actor(g: Guardian) -> Actor {
  Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name)
}

fn with_children(read: Read, o: row.Row) -> Result(Objective, Fail(e)) {
  use items <- result.try(store.query(
    read,
    "SELECT "
      <> item_row.columns
      <> " FROM dev_objective_items WHERE objective_id = ? ORDER BY ord",
    [id.objective_sql(o.id)],
    item_row.decoder(),
  ))
  use items <- result.try(
    list.try_map(items, fn(i) {
      use refs <- result.try(store.query(
        read,
        "SELECT "
          <> exercise_row.columns
          <> " FROM dev_objective_item_exercises WHERE item_id = ? ORDER BY ord",
        [id.objective_item_sql(i.id)],
        exercise_row.decoder(),
      ))
      use evidence <- result.map(store.query(
        read,
        "SELECT "
          <> item_evidence_row.columns
          <> " FROM dev_objective_item_evidence WHERE item_id = ? ORDER BY ord",
        [id.objective_item_sql(i.id)],
        item_evidence_row.decoder(),
      ))
      Item(
        row: i,
        exercise_refs: list.map(refs, fn(r) { r.ref }),
        baseline_evidence_ids: list.map(evidence, fn(e) { e.evidence_id }),
      )
    }),
  )
  use progress <- result.try(store.query(
    read,
    "SELECT "
      <> progress_row.columns
      <> " FROM dev_objective_progress WHERE objective_id = ? ORDER BY rowid",
    [id.objective_sql(o.id)],
    progress_row.decoder(),
  ))
  use shares <- result.try(shares_of(read, o.id))
  use reassessments <- result.try(store.query(
    read,
    "SELECT "
      <> reassessment_row.columns
      <> " FROM dev_objective_reassessments WHERE objective_id = ? ORDER BY rowid",
    [id.objective_sql(o.id)],
    reassessment_row.decoder(),
  ))
  use reassessments <- result.map(
    list.try_map(reassessments, fn(r) {
      use evidence <- result.map(store.query(
        read,
        "SELECT "
          <> outcome_evidence_row.columns
          <> " FROM dev_objective_reassessment_evidence WHERE reassessment_id = ? ORDER BY ord",
        [id.reassessment_sql(r.id)],
        outcome_evidence_row.decoder(),
      ))
      Reassessment(
        row: r,
        evidence_ids: list.map(evidence, fn(e) { e.evidence_id }),
      )
    }),
  )
  Objective(row: o, items:, progress:, shared_with: shares, reassessments:)
}

fn shares_of(
  read: Read,
  oid: id.ObjectiveId,
) -> Result(List(id.OrgId), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> share_row.columns
      <> " FROM dev_objective_shares WHERE objective_id = ? ORDER BY ord",
    [id.objective_sql(oid)],
    share_row.decoder(),
  )
  |> result.map(list.map(_, fn(s) { s.org_id }))
}

fn by_id(
  read: Read,
  oid: id.ObjectiveId,
) -> Result(Option(Objective), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> row.columns <> " FROM dev_objectives WHERE id = ?",
    [id.objective_sql(oid)],
    row.decoder(),
  ))
  case found {
    Ok(o) -> with_children(read, o) |> result.map(Some)
    Error(Nil) -> Ok(None)
  }
}

/// The player's objectives, oldest first.
fn for_player(
  read: Read,
  pid: id.PlayerId,
) -> Result(List(Objective), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM dev_objectives WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(pid)],
    row.decoder(),
  ))
  list.try_map(rows, with_children(read, _))
}

/// The player's objectives shared with this organisation, oldest first.
fn shared_with(
  read: Read,
  pid: id.PlayerId,
  org_id: id.OrgId,
) -> Result(List(Objective), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM dev_objectives WHERE player_id = ? AND EXISTS (SELECT 1 FROM dev_objective_shares s WHERE s.objective_id = dev_objectives.id AND s.org_id = ?) ORDER BY rowid",
    [id.player_sql(pid), id.org_sql(org_id)],
    row.decoder(),
  ))
  list.try_map(rows, with_children(read, _))
}

/// The objective holding this reassessment.
fn by_reassessment(
  read: Read,
  rid: id.ReassessmentId,
) -> Result(Option(Objective), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT objective_id FROM dev_objective_reassessments WHERE id = ?",
    [id.reassessment_sql(rid)],
    decode.at([0], id.objective_decoder()),
  ))
  case found {
    Ok(oid) -> by_id(read, oid)
    Error(Nil) -> Ok(None)
  }
}

/// The objective `oid` if it belongs to one of these players.
fn objective_of(
  ctx: Ctx,
  oid: id.ObjectiveId,
  player_ids: List(id.PlayerId),
  next: fn(Objective) -> Response,
) -> Response {
  case store.read(ctx.store, by_id(_, oid)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(o)) ->
      case list.contains(player_ids, o.row.player_id) {
        True -> next(o)
        False -> http.error(404, "OBJECTIVE_NOT_FOUND")
      }
    Ok(None) -> http.error(404, "OBJECTIVE_NOT_FOUND")
  }
}

fn open_request(o: Objective) -> Option(Reassessment) {
  list.find(o.reassessments, fn(r) {
    r.row.status == reassessment_row.Requested
  })
  |> option.from_result
}

// ------------------------------------------------------------------------------------------------------ views

fn evidence_ids_json(ids: List(id.ScoutingEvidenceId)) -> Json {
  json.array(ids, id.scouting_evidence_json)
}

fn reassessment_view(r: Reassessment) -> Json {
  let x = r.row
  json.object([
    #("id", id.reassessment_json(x.id)),
    #(
      "requestedBy",
      json.object([
        #("kind", party.to_json(x.requested_by_kind)),
        #("id", json.string(x.requested_by_id)),
        #("name", json.nullable(x.requested_by_name, json.string)),
      ]),
    ),
    #("requestedAt", json.int(x.requested_at)),
    #("status", reassessment_row.status_to_json(x.status)),
    #("outcome", case x.outcome_note, x.outcome_by_user_id, x.outcome_at {
      Some(note), Some(by), Some(at) ->
        json.object([
          #("note", json.string(note)),
          #("evidenceIds", evidence_ids_json(r.evidence_ids)),
          #("byUserId", id.org_user_json(by)),
          #("byName", json.nullable(x.outcome_by_name, json.string)),
          #("at", json.int(at)),
        ])
      _, _, _ -> json.null()
    }),
  ])
}

pub fn view(o: Objective) -> Json {
  let r = o.row
  json.object([
    #("id", id.objective_json(r.id)),
    #("playerId", id.player_json(r.player_id)),
    #("sourceFeedbackId", id.assessment_json(r.source_assessment_id)),
    #("orgId", id.org_json(r.org_id)),
    #(
      "reviewer",
      json.object([
        #("userId", id.org_user_json(r.reviewer_user_id)),
        #("name", json.nullable(r.reviewer_name, json.string)),
        #("orgName", json.nullable(r.reviewer_org_name, json.string)),
      ]),
    ),
    #(
      "objectives",
      json.array(o.items, fn(i) {
        json.object([
          #("id", id.objective_item_json(i.row.id)),
          #("text", json.string(i.row.text)),
          #("exerciseRefs", json.array(i.exercise_refs, json.string)),
          #("baselineEvidenceIds", evidence_ids_json(i.baseline_evidence_ids)),
        ])
      }),
    ),
    #(
      "progress",
      json.array(o.progress, fn(g) {
        json.object([
          #("id", id.objective_progress_json(g.id)),
          #("at", json.int(g.at)),
          #("objectiveId", json.nullable(g.item_id, id.objective_item_json)),
          #("note", json.nullable(g.note, json.string)),
          #(
            "evidenceId",
            json.nullable(g.evidence_id, id.scouting_evidence_json),
          ),
        ])
      }),
    ),
    #(
      "sharing",
      json.object([#("orgIds", json.array(o.shared_with, id.org_json))]),
    ),
    #("reassessments", json.array(o.reassessments, reassessment_view)),
    #("reviewAt", json.nullable(r.review_at, json.int)),
    #("status", row.status_to_json(r.status)),
    #(
      "createdBy",
      json.object([
        #("kind", party.to_json(r.created_by_kind)),
        #("id", json.string(r.created_by_id)),
        #("name", json.nullable(r.created_by_name, json.string)),
      ]),
    ),
    #("createdAt", json.int(r.created_at)),
  ])
}

fn objective_answer(status: Int, o: Objective) -> Response {
  http.json(status, json.object([#("objective", view(o))]))
}

// ---------------------------------------------------------------------------------------------------- refusals

fn field_invalid(field: String, message: String) -> Response {
  http.json(
    400,
    json.object([
      #("error", json.string("FIELD_INVALID")),
      #("field", json.string(field)),
      #("message", json.string(message)),
    ]),
  )
}

fn guardian_managed(message: String) -> Response {
  http.error_message(403, "GUARDIAN_MANAGED", message)
}

fn is_players_evidence(
  read: Read,
  evidence_id: String,
  pid: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM evidence WHERE id = ? AND player_id = ?",
    [
      id.scouting_evidence_sql(id.scouting_evidence(evidence_id)),
      id.player_sql(pid),
    ],
    decode.at([0], decode.int),
  )
  |> result.map(result.is_ok)
}

/// A list of the player's own evidence ids (absent is none), or the 400 that refuses it.
fn own_evidence(
  read: Read,
  ids: Option(List(String)),
  pid: id.PlayerId,
  field: String,
) -> Result(Result(List(id.ScoutingEvidenceId), Response), Fail(e)) {
  let ids = option.unwrap(ids, [])
  case
    list.length(ids) > evidence_ids_max,
    set.size(set.from_list(ids)) != list.length(ids)
  {
    True, _ ->
      Ok(
        Error(field_invalid(
          field,
          field
            <> " is a list of at most "
            <> int.to_string(evidence_ids_max)
            <> " evidence ids.",
        )),
      )
    _, True ->
      Ok(Error(field_invalid(field, field <> " names an evidence item twice.")))
    False, False -> first_not_own(read, ids, 0, pid, field, [])
  }
}

fn first_not_own(
  read: Read,
  ids: List(String),
  i: Int,
  pid: id.PlayerId,
  field: String,
  kept: List(id.ScoutingEvidenceId),
) -> Result(Result(List(id.ScoutingEvidenceId), Response), Fail(e)) {
  case ids {
    [] -> Ok(Ok(list.reverse(kept)))
    [e, ..rest] -> {
      use own <- result.try(is_players_evidence(read, e, pid))
      case own {
        True ->
          first_not_own(read, rest, i + 1, pid, field, [
            id.scouting_evidence(e),
            ..kept
          ])
        False -> {
          let at = field <> "[" <> int.to_string(i) <> "]"
          Ok(
            Error(http.json(
              400,
              json.object([
                #("error", json.string("EVIDENCE_INVALID")),
                #("field", json.string(at)),
                #(
                  "message",
                  json.string(
                    at <> " names evidence that is not this player's.",
                  ),
                ),
              ]),
            )),
          )
        }
      }
    }
  }
}

fn finished(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

/// Stale unless `holds`.
fn guard(
  holds: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case holds {
    True -> next()
    False -> store.stale(what)
  }
}

fn reloaded(
  tx: Tx,
  oid: id.ObjectiveId,
  next: fn(Objective) -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  use found <- result.try(by_id(store.reading(tx), oid))
  case found {
    Some(o) -> next(o)
    None -> store.stale("the objective")
  }
}

// ---------------------------------------------------------------------------------------------------- creating

type NewItem {
  NewItem(
    text: String,
    exercise_refs: Option(List(String)),
    baseline_evidence_ids: Option(List(String)),
  )
}

type NewObjective {
  NewObjective(
    feedback_id: Option(String),
    objectives: Option(List(NewItem)),
    review_at: Option(temporal.Due),
  )
}

fn new_objective_shape() -> input.Shape(NewObjective) {
  let item = {
    use text <- input.field(
      "text",
      input.required(input.required_text(objective_text_max)),
    )
    use exercise_refs <- input.field(
      "exerciseRefs",
      input.nullish(input.items_between(
        input.required_text(exercise_ref_max),
        0,
        exercise_refs_max,
      )),
    )
    // own_evidence judges how many, whether any repeats, and that each is the player's.
    use baseline_evidence_ids <- input.field(
      "baselineEvidenceIds",
      input.nullish(input.items(input.text(id_max), any_length)),
    )
    input.done(NewItem(text:, exercise_refs:, baseline_evidence_ids:))
  }
  use feedback_id <- input.field(
    "feedbackId",
    input.nullish(input.text(id_max)),
  )
  use objectives <- input.field(
    "objectives",
    input.optional(input.items(input.object(item), any_length)),
  )
  use review_at <- input.field("reviewAt", input.optional(input.due_date()))
  input.done(NewObjective(
    feedback_id:,
    objectives:,
    review_at: option.flatten(review_at),
  ))
}

/// `POST /player/objectives`.
pub fn player_create(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      guardian_managed(
        "Your parent/guardian agrees development objectives with clubs.",
      )
    False -> create(ctx, req, p.player, player_actor(p.player))
  }
}

/// `POST /guardian/children/:id/objectives`.
pub fn guardian_create(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  create(ctx, req, child, guardian_actor(g))
}

fn child_of(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
  next: fn(Player) -> Response,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Ok(Some(c)) -> next(c)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
  }
}

/// Published feedback about this player, by its assessment's id.
fn published_feedback(
  read: Read,
  feedback_id: Option(String),
  pid: id.PlayerId,
) -> Result(Option(#(assessment_row.Row, id.OrgUserId)), Fail(e)) {
  case feedback_id {
    None | Some("") -> Ok(None)
    Some(aid) -> {
      use found <- result.map(store.one(
        read,
        "SELECT " <> assessment_row.columns <> " FROM assessments WHERE id = ?",
        [id.assessment_sql(id.assessment(aid))],
        assessment_row.decoder(),
      ))
      case found {
        Ok(a) ->
          case a.player_id == pid, a.published_feedback_by_user_id {
            True, Some(by) -> Some(#(a, by))
            _, _ -> None
          }
        Error(Nil) -> None
      }
    }
  }
}

/// `parseDate` (hub/shared.mjs): an instant beyond the safe range is refused, not stored.
fn review_at_ms(due: Option(temporal.Due)) -> Result(Option(Int), Response) {
  let ms = case due {
    None -> None
    Some(due) -> Some(temporal.start(due))
  }
  case ms {
    Some(ms) if ms > any_length || ms < 0 - any_length ->
      Error(http.json(
        400,
        json.object([
          #("error", json.string("DATE_INVALID")),
          #("field", json.string("reviewAt")),
          #("detail", json.string("reviewAt is not a date (out of range).")),
        ]),
      ))
    _ -> Ok(ms)
  }
}

type Checked {
  Checked(
    feedback: assessment_row.Row,
    reviewer: id.OrgUserId,
    org_name: Option(String),
    items: List(#(String, List(String), List(id.ScoutingEvidenceId))),
  )
}

fn create(ctx: Ctx, req: Request, p: Player, actor: Actor) -> Response {
  use b <- http.body(req, new_objective_shape(), [
    #("objectives", "ONE_OR_TWO_OBJECTIVES"),
  ])
  let checked =
    store.read(ctx.store, fn(read) {
      use found <- result.try(published_feedback(read, b.feedback_id, p.row.id))
      case found {
        None ->
          Ok(
            Error(http.error_message(
              404,
              "PUBLISHED_FEEDBACK_NOT_FOUND",
              "Objectives grow from feedback a club chose to publish — private assessments cannot seed them.",
            )),
          )
        Some(#(a, reviewer)) -> {
          let objectives = option.unwrap(b.objectives, [])
          let count = list.length(objectives)
          case count < 1 || count > objective_items_max {
            True ->
              Ok(
                Error(http.error_message(
                  400,
                  "ONE_OR_TWO_OBJECTIVES",
                  "One or two focused objectives — not a laundry list.",
                )),
              )
            False -> {
              use items <- result.try(checked_items(read, objectives, p, 0, []))
              use org <- result.map(orgs.by_id(read, a.org_id))
              result.map(items, fn(items) {
                Checked(
                  feedback: a,
                  reviewer:,
                  org_name: option.map(org, fn(o) { o.name }),
                  items:,
                )
              })
            }
          }
        }
      }
    })
  case checked {
    Error(failure) -> http.internal(failure)
    Ok(Error(answer)) -> answer
    Ok(Ok(c)) ->
      case review_at_ms(b.review_at) {
        Error(answer) -> answer
        Ok(review_at) -> insert(ctx, p, actor, c, review_at)
      }
  }
}

fn checked_items(
  read: Read,
  items: List(NewItem),
  p: Player,
  i: Int,
  kept: List(#(String, List(String), List(id.ScoutingEvidenceId))),
) -> Result(
  Result(List(#(String, List(String), List(id.ScoutingEvidenceId))), Response),
  Fail(e),
) {
  case items {
    [] -> Ok(Ok(list.reverse(kept)))
    [o, ..rest] -> {
      use evidence <- result.try(own_evidence(
        read,
        o.baseline_evidence_ids,
        p.row.id,
        "objectives[" <> int.to_string(i) <> "].baselineEvidenceIds",
      ))
      case evidence {
        Error(answer) -> Ok(Error(answer))
        Ok(evidence) ->
          checked_items(read, rest, p, i + 1, [
            #(string.trim(o.text), option.unwrap(o.exercise_refs, []), evidence),
            ..kept
          ])
      }
    }
  }
}

fn insert(
  ctx: Ctx,
  p: Player,
  actor: Actor,
  c: Checked,
  review_at: Option(Int),
) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use oid <- result.try(id.next_objective(tx))
    use _ <- result.try(row.insert(
      tx,
      row.Row(
        ..row.new(
          id: oid,
          player_id: p.row.id,
          source_assessment_id: c.feedback.id,
          org_id: c.feedback.org_id,
          reviewer_user_id: c.reviewer,
          status: row.Active,
          created_by_kind: actor.kind,
          created_by_id: actor.id,
          created_at: now,
        ),
        reviewer_name: c.feedback.published_feedback_by_name,
        reviewer_org_name: c.org_name,
        review_at:,
        created_by_name: Some(actor.name),
      ),
    ))
    use _ <- result.try(
      list.index_map(c.items, fn(it, i) { #(i, it) })
      |> list.try_each(fn(entry) {
        let #(i, #(text, refs, evidence)) = entry
        use iid <- result.try(id.next_objective_item(tx))
        use _ <- result.try(item_row.insert(
          tx,
          item_row.Row(id: iid, objective_id: oid, text:, ord: i),
        ))
        use _ <- result.try(
          list.index_map(refs, fn(r, j) { #(j, r) })
          |> list.try_each(fn(e) {
            exercise_row.insert(
              tx,
              exercise_row.Row(item_id: iid, ord: e.0, ref: e.1),
            )
          }),
        )
        list.index_map(evidence, fn(ev, j) { #(j, ev) })
        |> list.try_each(fn(e) {
          item_evidence_row.insert(
            tx,
            item_evidence_row.Row(item_id: iid, ord: e.0, evidence_id: e.1),
          )
        })
      }),
    )
    use o <- reloaded(tx, oid)
    Ok(objective_answer(201, o))
  })
  |> finished
}

// ------------------------------------------------------------------------------------------------------ reading

/// `GET /player/objectives`.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  list_answer(store.read(ctx.store, for_player(_, p.player.row.id)))
}

/// `GET /guardian/children/:id/objectives`.
pub fn guardian_list(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True -> list_answer(store.read(ctx.store, for_player(_, child_id)))
  }
}

fn list_answer(found: Result(List(Objective), Fail(e))) -> Response {
  case found {
    Ok(items) -> http.json(200, json.array(items, view))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /org/players/:id/objectives`: only what the player shared with this club.
pub fn org_list(ctx: Ctx, a: OrgAccess, pid: id.PlayerId) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use seen <- result.try(players.for_org(read, pid, a.org, now))
      case seen {
        Some(#(_, access)) if access.visible && !access.blocked ->
          shared_with(read, pid, a.org.id) |> result.map(Some)
        _ -> Ok(None)
      }
    })
  case found {
    Ok(Some(items)) -> http.json(200, json.array(items, view))
    Ok(None) -> http.error(403, "NOT_VISIBLE")
    Error(failure) -> http.internal(failure)
  }
}

// ----------------------------------------------------------------------------------------------------- progress

type NewProgress {
  NewProgress(
    note: Option(String),
    evidence_id: Option(String),
    objective_id: Option(String),
  )
}

/// `POST /player/objectives/:id/progress`. A minor may log progress: it is football activity.
pub fn progress(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  oid: id.ObjectiveId,
) -> Response {
  let pid = p.player.row.id
  use o <- objective_of(ctx, oid, [pid])
  let shape = {
    use note <- input.field(
      "note",
      input.nullish(input.text(progress_note_max)),
    )
    use evidence_id <- input.field(
      "evidenceId",
      input.nullish(input.text(id_max)),
    )
    use objective_id <- input.field(
      "objectiveId",
      input.nullish(input.text(id_max)),
    )
    input.done(NewProgress(note:, evidence_id:, objective_id:))
  }
  use b <- http.body(req, shape, [])
  let own = case b.evidence_id {
    None -> Ok(True)
    Some(e) -> store.read(ctx.store, is_players_evidence(_, e, pid))
  }
  let item = case b.objective_id {
    None -> Ok(None)
    Some(x) ->
      list.find(o.items, fn(i) { id.objective_item_to_string(i.row.id) == x })
      |> result.map(fn(i) { Some(i.row.id) })
  }
  case own, item {
    Error(failure), _ -> http.internal(failure)
    Ok(False), _ -> http.error(400, "EVIDENCE_INVALID")
    Ok(True), Error(Nil) ->
      field_invalid(
        "objectiveId",
        "objectiveId names one of this objective's items.",
      )
    Ok(True), Ok(item_id) -> {
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use gid <- result.try(id.next_objective_progress(tx))
        use _ <- result.try(progress_row.insert(
          tx,
          progress_row.Row(
            id: gid,
            objective_id: o.row.id,
            at: now,
            item_id:,
            note: case input.filled(b.note) {
              Some(_) -> b.note
              None -> None
            },
            evidence_id: option.map(b.evidence_id, id.scouting_evidence),
          ),
        ))
        use _ <- result.try(activity.record(tx, pid, now))
        use o <- reloaded(tx, o.row.id)
        Ok(objective_answer(201, o))
      })
      |> finished
    }
  }
}

// ------------------------------------------------------------------------------------------------------ sharing

/// `POST /player/objectives/:id/share`.
pub fn player_share(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  oid: id.ObjectiveId,
) -> Response {
  case p.minor {
    True ->
      guardian_managed(
        "Sharing progress with a club is a guardian decision for under-18s.",
      )
    False -> set_sharing(ctx, req, oid, [p.player.row.id])
  }
}

/// `POST /guardian/objectives/:id/share`.
pub fn guardian_share(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  oid: id.ObjectiveId,
) -> Response {
  set_sharing(ctx, req, oid, g.child_ids)
}

fn set_sharing(
  ctx: Ctx,
  req: Request,
  oid: id.ObjectiveId,
  player_ids: List(id.PlayerId),
) -> Response {
  let shape = {
    use org_id <- input.field("orgId", input.nullish(input.text(id_max)))
    use enabled <- input.field("enabled", input.required(input.boolean()))
    input.done(#(org_id, enabled))
  }
  use #(org_id, enabled) <- http.body(req, shape, [])
  use o <- objective_of(ctx, oid, player_ids)
  let org = case org_id {
    None | Some("") -> Ok(None)
    Some(org_id) -> store.read(ctx.store, orgs.by_id(_, id.org(org_id)))
  }
  case org {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "ORG_NOT_FOUND")
    Ok(Some(org)) ->
      store.unit(ctx.store, fn(tx) {
        // Sharing twice keeps one share; the shares are written again in order, as the TypeScript server writes them.
        use current <- result.try(shares_of(store.reading(tx), o.row.id))
        let next = case enabled, list.contains(current, org.id) {
          True, True -> current
          True, False -> list.append(current, [org.id])
          False, _ -> list.filter(current, fn(x) { x != org.id })
        }
        use _ <- result.try(
          store.run(
            tx,
            "DELETE FROM dev_objective_shares WHERE objective_id = ?",
            [id.objective_sql(o.row.id)],
          ),
        )
        use _ <- result.try(
          list.index_map(next, fn(x, i) { #(i, x) })
          |> list.try_each(fn(e) {
            share_row.insert(
              tx,
              share_row.Row(objective_id: o.row.id, ord: e.0, org_id: e.1),
            )
          }),
        )
        use o <- reloaded(tx, o.row.id)
        Ok(objective_answer(200, o))
      })
      |> finished
  }
}

// ------------------------------------------------------------------------------------------------- reassessment

/// `POST /player/objectives/:id/reassessment`.
pub fn player_reassessment(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  oid: id.ObjectiveId,
) -> Response {
  case p.minor {
    True ->
      guardian_managed("Re-engaging a club for you is your guardian’s call.")
    False ->
      request_reassessment(
        ctx,
        req,
        oid,
        [p.player.row.id],
        player_actor(p.player),
      )
  }
}

/// `POST /guardian/objectives/:id/reassessment`.
pub fn guardian_reassessment(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  oid: id.ObjectiveId,
) -> Response {
  request_reassessment(ctx, req, oid, g.child_ids, guardian_actor(g))
}

fn request_reassessment(
  ctx: Ctx,
  req: Request,
  oid: id.ObjectiveId,
  player_ids: List(id.PlayerId),
  actor: Actor,
) -> Response {
  use req <- http.rerun_on_stale(req)
  use _ <- http.body(req, input.nothing(), [])
  use o <- objective_of(ctx, oid, player_ids)
  let shared = list.contains(o.shared_with, o.row.org_id)
  case shared, open_request(o) {
    False, _ ->
      http.error_message(
        409,
        "SHARING_REQUIRED",
        "Share progress with the club before asking them to look again.",
      )
    True, Some(_) -> http.error(409, "ALREADY_REQUESTED")
    True, None -> {
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use fresh <- reloaded(tx, o.row.id)
        use <- guard(
          list.contains(fresh.shared_with, fresh.row.org_id)
            && open_request(fresh) == None,
          "the objective's reassessments",
        )
        use player <- result.try(players.by_id(
          store.reading(tx),
          fresh.row.player_id,
        ))
        use rid <- result.try(id.next_reassessment(tx))
        let r =
          reassessment_row.Row(
            ..reassessment_row.new(
              id: rid,
              objective_id: fresh.row.id,
              requested_by_kind: actor.kind,
              requested_by_id: actor.id,
              requested_at: now,
              status: reassessment_row.Requested,
            ),
            requested_by_name: Some(actor.name),
          )
        use _ <- result.try(reassessment_row.insert(tx, r))
        use _ <- result.try(notifications.notify(
          tx,
          to: audience.OrgUser,
          id: id.org_user_to_string(fresh.row.reviewer_user_id),
          type_: "reassessment",
          text: "🔁 "
            <> case player {
            Some(p) -> p.row.name
            None -> "undefined"
          }
            <> " (via "
            <> actor.name
            <> ") requests a reassessment on: "
            <> string.join(list.map(fresh.items, fn(i) { i.row.text }), " · "),
          ref_id: Some(id.objective_to_string(fresh.row.id)),
          at: now,
        ))
        Ok(http.json(
          201,
          json.object([
            #(
              "reassessment",
              reassessment_view(Reassessment(row: r, evidence_ids: [])),
            ),
          ]),
        ))
      })
      |> finished
    }
  }
}

type Outcome {
  Outcome(note: Option(String), evidence_ids: Option(List(String)))
}

/// `POST /org/reassessments/:id/outcome`: the club answers the open request, citing the player's evidence.
pub fn outcome(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  rid: id.ReassessmentId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, by_reassessment(_, rid)) {
    Error(failure) -> http.internal(failure)
    Ok(found) -> {
      let r =
        option.then(found, fn(o) {
          list.find(o.reassessments, fn(x) { x.row.id == rid })
          |> option.from_result
          |> option.map(fn(r) { #(o, r) })
        })
      case r {
        Some(#(o, r)) if o.row.org_id == a.org.id ->
          case
            list.contains(o.shared_with, a.org.id),
            r.row.status == reassessment_row.Requested
          {
            False, _ -> http.error(403, "SHARING_REVOKED")
            True, False -> http.error(409, "ALREADY_RESOLVED")
            True, True -> answer_outcome(ctx, req, a, o, rid)
          }
        _ -> http.error(404, "REASSESSMENT_NOT_FOUND")
      }
    }
  }
}

fn answer_outcome(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  o: Objective,
  rid: id.ReassessmentId,
) -> Response {
  let shape = {
    use note <- input.field("note", input.nullish(input.text(outcome_note_max)))
    use evidence_ids <- input.field(
      "evidenceIds",
      input.nullish(input.items(input.text(id_max), any_length)),
    )
    input.done(Outcome(note:, evidence_ids:))
  }
  use b <- http.body(req, shape, [])
  case b.note, input.filled(b.note) {
    Some(note), Some(_) -> {
      let pid = o.row.player_id
      case
        store.read(ctx.store, own_evidence(
          _,
          b.evidence_ids,
          pid,
          "evidenceIds",
        ))
      {
        Error(failure) -> http.internal(failure)
        Ok(Error(answer)) -> answer
        Ok(Ok(evidence)) -> {
          use <- moderate.or_refuse(
            ctx,
            note,
            audit.Context(
              kind: "reassessment_outcome",
              player_id: Some(pid),
              org_id: Some(a.org.id),
              user_id: None,
              channel_id: None,
              request_id: None,
            ),
          )
          complete(ctx, a, o, rid, note, evidence)
        }
      }
    }
    _, _ ->
      http.error_message(
        400,
        "NOTE_REQUIRED",
        "Reassessment outcomes point at evidence, not vibes.",
      )
  }
}

fn complete(
  ctx: Ctx,
  a: OrgAccess,
  o: Objective,
  rid: id.ReassessmentId,
  note: String,
  evidence: List(id.ScoutingEvidenceId),
) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use fresh <- reloaded(tx, o.row.id)
    let open =
      list.any(fresh.reassessments, fn(r) {
        r.row.id == rid && r.row.status == reassessment_row.Requested
      })
    use <- guard(
      open && list.contains(fresh.shared_with, a.org.id),
      "the reassessment",
    )
    use changed <- result.try(store.write(
      tx,
      "UPDATE dev_objective_reassessments SET status = ?, outcome_note = ?, outcome_by_user_id = ?, outcome_by_name = ?, outcome_at = ? WHERE id = ? AND status = ? RETURNING id",
      [
        sqlight.text(reassessment_row.status_to_string(
          reassessment_row.Completed,
        )),
        sqlight.text(note),
        id.org_user_sql(a.user.id),
        sqlight.text(a.user.name),
        sqlight.int(now),
        id.reassessment_sql(rid),
        sqlight.text(reassessment_row.status_to_string(
          reassessment_row.Requested,
        )),
      ],
      decode.at([0], decode.string),
    ))
    use <- guard(changed != [], "the reassessment")
    use _ <- result.try(
      list.index_map(evidence, fn(e, i) { #(i, e) })
      |> list.try_each(fn(e) {
        outcome_evidence_row.insert(
          tx,
          outcome_evidence_row.Row(
            reassessment_id: rid,
            ord: e.0,
            evidence_id: e.1,
          ),
        )
      }),
    )
    use player <- result.try(players.by_id(
      store.reading(tx),
      fresh.row.player_id,
    ))
    let text =
      "📝 "
      <> a.org.name
      <> " completed the reassessment: "
      <> input.utf16_take(note, 120)
    let ref_id = Some(id.objective_to_string(fresh.row.id))
    use _ <- result.try(case player {
      Some(p) ->
        case players.is_adult(p, now), p.row.guardian_id {
          False, Some(g) ->
            notifications.notify(
              tx,
              to: audience.Guardian,
              id: id.guardian_to_string(g),
              type_: "reassessment",
              text:,
              ref_id:,
              at: now,
            )
          _, _ ->
            notifications.notify(
              tx,
              to: audience.Player,
              id: id.player_to_string(p.row.id),
              type_: "reassessment",
              text:,
              ref_id:,
              at: now,
            )
        }
      None -> Ok(Nil)
    })
    use done <- reloaded(tx, fresh.row.id)
    case list.find(done.reassessments, fn(r) { r.row.id == rid }) {
      Ok(r) ->
        Ok(http.json(
          200,
          json.object([#("reassessment", reassessment_view(r))]),
        ))
      Error(Nil) -> store.stale("the reassessment")
    }
  })
  |> finished
}
