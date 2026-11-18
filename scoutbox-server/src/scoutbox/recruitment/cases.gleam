//// Recruitment cases and their Room facet (`recruitment_cases` and its ordered child rows: tags, assignments,
//// tasks, history and links), as repositories/recruitmentCases.ts keeps them.
////
//// A Room is a case with a status. The status is written only by `move` (and `create`/`adopt`), which derive the
//// case's stage from it and move the Room's revision.
////
//// Not ported yet: the case's decision draft, transaction handoff and budget.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/clock
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal.{type Due}
import scoutbox/recruitment/room_rules
import scoutbox/rows/case_approvals as approval_row
import scoutbox/rows/case_assignments as assignment_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/case_tasks as task_row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_cases as row
import scoutbox/vocab/case_outcome
import scoutbox/vocab/room_status.{type RoomStatus}
import scoutbox/vocab/source_context.{type SourceContext}
import scoutbox/vocab/task_state.{type TaskState}
import sqlight

/// A case that has a Room, with its child rows.
pub type Room {
  Room(
    row: row.Row,
    status: RoomStatus,
    priority: row.RoomPriority,
    updated_at: Int,
    rev: Int,
    tags: List(String),
    assignments: List(assignment_row.Row),
    tasks: List(task_row.Row),
    history: List(history_row.Row),
    request_ids: List(id.RequestId),
    trial_ids: List(id.TrialId),
  )
}

/// Who wrote a history entry, as auditEntry records them.
pub type By {
  By(kind: history_row.ByKind, id: Option(String), name: Option(String))
}

pub fn by_staff(user_id: id.OrgUserId, name: String) -> By {
  By(history_row.Org, Some(id.org_user_to_string(user_id)), Some(name))
}

/// One history entry to write: an action and its detail, structured or (as the case workspace writes it) text.
pub type Entry {
  Entry(action: String, detail: Option(Json), text: Option(String))
}

pub fn entry(action: String, detail: List(#(String, Json))) -> Entry {
  Entry(action, Some(json.object(detail)), None)
}

/// An entry whose detail is a line of text.
pub fn text_entry(action: String, text: String) -> Entry {
  Entry(action, None, Some(text))
}

// ---------------------------------------------------------------------------------------------------------- reads

fn children(
  read: Read,
  table: String,
  columns: String,
  case_id: id.RecruitmentCaseId,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE case_id = ? ORDER BY position",
    [id.recruitment_case_sql(case_id)],
    decoder,
  )
}

fn with_children(read: Read, r: row.Row) -> Result(Option(Room), Fail(e)) {
  case r.room_status, r.room_priority, r.room_updated_at, r.room_rev {
    Some(status), Some(priority), Some(updated_at), Some(rev) -> {
      use tags <- result.try(children(
        read,
        "case_room_tags",
        "tag",
        r.id,
        decode.at([0], decode.string),
      ))
      use assignments <- result.try(children(
        read,
        assignment_row.table,
        assignment_row.columns,
        r.id,
        assignment_row.decoder(),
      ))
      use tasks <- result.try(children(
        read,
        task_row.table,
        task_row.columns,
        r.id,
        task_row.decoder(),
      ))
      use history <- result.try(children(
        read,
        history_row.table,
        history_row.columns,
        r.id,
        history_row.decoder(),
      ))
      use request_ids <- result.try(children(
        read,
        "case_request_links",
        "request_id",
        r.id,
        decode.at([0], id.request_decoder()),
      ))
      use trial_ids <- result.map(children(
        read,
        "case_trial_links",
        "trial_id",
        r.id,
        decode.at([0], id.trial_decoder()),
      ))
      Some(Room(
        row: r,
        status:,
        priority:,
        updated_at:,
        rev:,
        tags:,
        assignments:,
        tasks:,
        history:,
        request_ids:,
        trial_ids:,
      ))
    }
    _, _, _, _ -> Ok(None)
  }
}

fn rooms_of(read: Read, rows: List(row.Row)) -> Result(List(Room), Fail(e)) {
  list.try_map(rows, with_children(read, _))
  |> result.map(option.values)
}

fn rows(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> row.columns <> " FROM recruitment_cases WHERE " <> where,
    args,
    row.decoder(),
  )
}

/// The Room `id` names, if it is one.
pub fn room(
  read: Read,
  id: id.RecruitmentCaseId,
) -> Result(Option(Room), Fail(e)) {
  use found <- result.try(rows(read, "id = ?", [id.recruitment_case_sql(id)]))
  case found {
    [r] -> with_children(read, r)
    _ -> Ok(None)
  }
}

/// The organisation's Rooms for a player, oldest first.
pub fn rooms_for(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Room), Fail(e)) {
  use found <- result.try(
    rows(
      read,
      "org_id = ? AND player_id = ? AND room_status IS NOT NULL ORDER BY rowid",
      [id.org_sql(org_id), id.player_sql(player_id)],
    ),
  )
  rooms_of(read, found)
}

/// Every organisation's Rooms for a player, oldest first.
pub fn rooms_of_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Room), Fail(e)) {
  use found <- result.try(
    rows(read, "player_id = ? AND room_status IS NOT NULL ORDER BY rowid", [
      id.player_sql(player_id),
    ]),
  )
  rooms_of(read, found)
}

/// The organisation's ended Rooms (archived, closed or withdrawn), oldest first: of one player, or of every player.
pub fn ended_rooms(
  read: Read,
  org_id: id.OrgId,
  player_id: Option(id.PlayerId),
) -> Result(List(Room), Fail(e)) {
  let #(player_sql, player_args) = case player_id {
    Some(p) -> #(" AND player_id = ?", [id.player_sql(p)])
    None -> #("", [])
  }
  use found <- result.try(
    rows(
      read,
      "org_id = ? AND room_status IN ('archived', 'closed', 'withdrawn')"
        <> player_sql
        <> " ORDER BY rowid",
      [id.org_sql(org_id), ..player_args],
    ),
  )
  rooms_of(read, found)
}

/// The organisation's open Room for a player: there is at most one.
pub fn open_room_for(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(Option(Room), Fail(e)) {
  use rooms <- result.map(rooms_for(read, org_id, player_id))
  list.find(rooms, fn(r) { room_rules.is_open(r.status) }) |> option.from_result
}

/// The organisation's open plain case for a player, which a new Room adopts rather than open a second one.
pub fn open_plain_case(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(Option(row.Row), Fail(e)) {
  use found <- result.map(
    rows(
      read,
      "org_id = ? AND player_id = ? AND room_status IS NULL AND stage <> 'closed' ORDER BY rowid LIMIT 1",
      [id.org_sql(org_id), id.player_sql(player_id)],
    ),
  )
  list.first(found) |> option.from_result
}

/// Who is asking, for the Rooms they may open: a recruitment lead opens every Room; anyone else a Room that is not
/// restricted, or one they own, lead or are assigned to.
pub type Viewer {
  Viewer(user_id: id.OrgUserId, is_lead: Bool)
}

fn access(v: Viewer) -> #(String, List(sqlight.Value)) {
  case v.is_lead {
    True -> #("1", [])
    False -> {
      let u = id.org_user_sql(v.user_id)
      #(
        "(c.restricted = 0 OR c.owner_user_id = ? OR c.room_lead_scout_user_id = ? OR EXISTS (SELECT 1 FROM case_assignments a WHERE a.case_id = c.id AND a.user_id = ?))",
        [u, u, u],
      )
    }
  }
}

/// The Rooms list's filters, each optional.
pub type Filter {
  Filter(
    statuses: Option(List(RoomStatus)),
    status: Option(String),
    mine_of: Option(id.OrgUserId),
    assigned_to: Option(id.OrgUserId),
    tag: Option(String),
    assignee: Option(String),
  )
}

pub const no_filter = Filter(None, None, None, None, None, None)

fn filter_sql(v: Viewer, f: Filter) -> #(List(String), List(sqlight.Value)) {
  let #(a, a_args) = access(v)
  let parts = [
    #(a, a_args),
    ..option.values([
      option.map(f.statuses, fn(ss) {
        case ss {
          [] -> #("0", [])
          _ -> #(
            "c.room_status IN ("
              <> string.join(list.map(ss, fn(_) { "?" }), ", ")
              <> ")",
            list.map(ss, fn(s) { sqlight.text(room_status.to_string(s)) }),
          )
        }
      }),
      option.map(f.status, fn(s) { #("c.room_status = ?", [sqlight.text(s)]) }),
      option.map(f.mine_of, fn(u) {
        #("(c.owner_user_id = ? OR c.room_lead_scout_user_id = ?)", [
          id.org_user_sql(u),
          id.org_user_sql(u),
        ])
      }),
      option.map(f.assigned_to, fn(u) {
        #(
          "(EXISTS (SELECT 1 FROM case_assignments a2 WHERE a2.case_id = c.id AND a2.user_id = ?) OR EXISTS (SELECT 1 FROM case_tasks t WHERE t.case_id = c.id AND t.assignee_user_id = ? AND t.status IN ('open', 'in_progress')))",
          [id.org_user_sql(u), id.org_user_sql(u)],
        )
      }),
      option.map(f.tag, fn(t) {
        #(
          "EXISTS (SELECT 1 FROM case_room_tags g WHERE g.case_id = c.id AND g.tag = ?)",
          [sqlight.text(t)],
        )
      }),
      option.map(f.assignee, fn(u) {
        #(
          "(EXISTS (SELECT 1 FROM case_tasks t2 WHERE t2.case_id = c.id AND t2.assignee_user_id = ?) OR c.room_lead_scout_user_id = ? OR c.owner_user_id = ?)",
          [sqlight.text(u), sqlight.text(u), sqlight.text(u)],
        )
      }),
    ])
  ]
  #(list.map(parts, fn(p) { p.0 }), list.flat_map(parts, fn(p) { p.1 }))
}

/// A page of the Rooms `viewer` may open, most recent activity first (`[updatedAt, id]`), filtered in SQL.
/// `accept` is a filter SQL cannot express (the search, which needs the player's visibility): rows are read in
/// chunks until the page is full. `limit + 1` Rooms come back when there is another page.
pub fn page_for_viewer(
  read: Read,
  org_id: id.OrgId,
  viewer: Viewer,
  filter: Filter,
  limit: Int,
  after: Option(#(Int, String)),
  accept: Option(fn(row.Row, List(String)) -> Bool),
) -> Result(List(Room), Fail(e)) {
  let #(where, args) = filter_sql(viewer, filter)
  let chunk = case accept {
    Some(_) -> int_max(limit + 1, 200)
    None -> limit + 1
  }
  page_loop(read, org_id, where, args, chunk, limit, after, accept, [])
}

fn int_max(a: Int, b: Int) -> Int {
  case a > b {
    True -> a
    False -> b
  }
}

fn page_loop(
  read: Read,
  org_id: id.OrgId,
  where: List(String),
  args: List(sqlight.Value),
  chunk: Int,
  limit: Int,
  after: Option(#(Int, String)),
  accept: Option(fn(row.Row, List(String)) -> Bool),
  kept: List(row.Row),
) -> Result(List(Room), Fail(e)) {
  let #(after_sql, after_args) = case after {
    Some(#(at, cid)) -> #(
      [" AND (c.room_updated_at < ? OR (c.room_updated_at = ? AND c.id > ?))"],
      [sqlight.int(at), sqlight.int(at), sqlight.text(cid)],
    )
    None -> #([], [])
  }
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> row.qualified("c")
      <> " FROM recruitment_cases c WHERE c.org_id = ? AND c.room_status IS NOT NULL AND "
      <> string.join(where, " AND ")
      <> string.concat(after_sql)
      <> " ORDER BY c.room_updated_at DESC, c.id ASC LIMIT ?",
    list.flatten([[id.org_sql(org_id)], args, after_args, [sqlight.int(chunk)]]),
    row.decoder(),
  ))
  use kept <- result.try(
    list.try_fold(found, kept, fn(kept, r) {
      case list.length(kept) > limit {
        True -> Ok(kept)
        False ->
          case accept {
            None -> Ok([r, ..kept])
            Some(f) -> {
              use tags <- result.map(children(
                read,
                "case_room_tags",
                "tag",
                r.id,
                decode.at([0], decode.string),
              ))
              case f(r, tags) {
                True -> [r, ..kept]
                False -> kept
              }
            }
          }
      }
    }),
  )
  case
    list.length(kept) > limit || list.length(found) < chunk,
    list.last(found)
  {
    False, Ok(last) ->
      page_loop(
        read,
        org_id,
        where,
        args,
        chunk,
        limit,
        Some(#(
          option.unwrap(last.room_updated_at, 0),
          id.recruitment_case_to_string(last.id),
        )),
        accept,
        kept,
      )
    _, _ -> rooms_of(read, list.reverse(kept))
  }
}

/// The Rooms `viewer` may open, filtered like the list, oldest first, without their child rows.
pub fn rows_for_viewer(
  read: Read,
  org_id: id.OrgId,
  viewer: Viewer,
  filter: Filter,
) -> Result(List(row.Row), Fail(e)) {
  let #(where, args) = filter_sql(viewer, filter)
  store.query(
    read,
    "SELECT "
      <> row.qualified("c")
      <> " FROM recruitment_cases c WHERE c.org_id = ? AND c.room_status IS NOT NULL AND "
      <> string.join(where, " AND ")
      <> " ORDER BY c.rowid",
    [id.org_sql(org_id), ..args],
    row.decoder(),
  )
}

/// The organisation's Rooms counted by status; with a viewer, only the Rooms they may open.
pub fn status_counts(
  read: Read,
  org_id: id.OrgId,
  viewer: Option(Viewer),
) -> Result(List(#(RoomStatus, Int)), Fail(e)) {
  let #(a, a_args) = case viewer {
    Some(v) -> access(v)
    None -> #("1", [])
  }
  store.query(
    read,
    "SELECT c.room_status, COUNT(*) FROM recruitment_cases c WHERE c.org_id = ? AND c.room_status IS NOT NULL AND "
      <> a
      <> " GROUP BY c.room_status",
    [id.org_sql(org_id), ..a_args],
    {
      use s <- decode.field(0, room_status.decoder())
      use n <- decode.field(1, decode.int)
      decode.success(#(s, n))
    },
  )
}

/// How many Rooms there are, across every organisation.
pub fn room_count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM recruitment_cases WHERE room_status IS NOT NULL",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// Open and in-progress tasks of the organisation's cases due (an instant) before `at`, counted by case.
pub fn overdue_task_counts(
  read: Read,
  org_id: id.OrgId,
  at: Int,
) -> Result(List(#(id.RecruitmentCaseId, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT t.case_id, COUNT(*) FROM case_tasks t JOIN recruitment_cases c ON c.id = t.case_id WHERE c.org_id = ? AND t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at <> 0 AND t.due_at < ? GROUP BY t.case_id",
    [id.org_sql(org_id), sqlight.int(at)],
    {
      use c <- decode.field(0, id.recruitment_case_decoder())
      use n <- decode.field(1, decode.int)
      decode.success(#(c, n))
    },
  )
}

// --------------------------------------------------------------------------------------------------------- writes

fn next_position(
  tx: Tx,
  table: String,
  case_id: id.RecruitmentCaseId,
) -> Result(Int, Fail(e)) {
  store.one(
    store.reading(tx),
    "SELECT COALESCE(MAX(position) + 1, 0) FROM "
      <> table
      <> " WHERE case_id = ?",
    [id.recruitment_case_sql(case_id)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// Appends history entries to a case.
pub fn record(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  by: By,
  entries: List(Entry),
  at: Int,
) -> Result(Nil, Fail(e)) {
  list.try_each(entries, fn(e) {
    use event_id <- result.try(id.next_case_event(tx))
    use position <- result.try(next_position(tx, history_row.table, case_id))
    history_row.insert(
      tx,
      history_row.Row(
        ..history_row.new(
          case_id:,
          position:,
          id: event_id,
          at:,
          action: e.action,
        ),
        by_kind: Some(by.kind),
        by_id: by.id,
        by_name: by.name,
        detail_json: option.map(e.detail, json.to_string),
        detail_text: e.text,
      ),
    )
  })
}

/// The Room's last activity moves to `at`.
pub fn touch(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  exactly_one(
    tx,
    "UPDATE recruitment_cases SET room_updated_at = ? WHERE id = ? AND room_status IS NOT NULL RETURNING id",
    [sqlight.int(at), id.recruitment_case_sql(case_id)],
  )
}

/// The Room's revision moves on, by `by`.
pub fn bump(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  at: Int,
  by_id: Option(String),
  by_name: Option(String),
) -> Result(Nil, Fail(e)) {
  exactly_one(
    tx,
    "UPDATE recruitment_cases SET room_rev = room_rev + 1, room_rev_at = ?, room_rev_by_user_id = ?, room_rev_by_name = ? WHERE id = ? AND room_status IS NOT NULL RETURNING id",
    [
      sqlight.int(at),
      sqlight.nullable(sqlight.text, by_id),
      sqlight.nullable(sqlight.text, by_name),
      id.recruitment_case_sql(case_id),
    ],
  )
}

/// An act's guard: a row that is not exactly the one expected means a route let through a move it should have
/// refused, so the unit stops.
fn exactly_one(
  tx: Tx,
  sql: String,
  args: List(sqlight.Value),
) -> Result(Nil, Fail(e)) {
  use changed <- result.map(store.write(tx, sql, args, decode.success(Nil)))
  let assert [_] = changed as "a case act's guard held"
  Nil
}

/// A Room's opening facts.
pub type Opening {
  Opening(
    status: RoomStatus,
    priority: row.RoomPriority,
    lead_scout: id.OrgUserId,
    source_context: SourceContext,
    source_ref: Option(#(String, Option(Int))),
    opened_by: #(id.OrgUserId, String),
    at: Int,
  )
}

fn with_opening(r: row.Row, o: Opening, level: orgs.Level) -> row.Row {
  let is_open = room_rules.is_open(o.status)
  row.Row(
    ..r,
    stage: room_rules.stage_for_room_status(o.status, level),
    room_status: Some(o.status),
    room_priority: Some(o.priority),
    room_lead_scout_user_id: Some(o.lead_scout),
    room_source_context: Some(o.source_context),
    room_source_ref_id: option.map(o.source_ref, fn(s) { s.0 }),
    room_source_ref_version: option.then(o.source_ref, fn(s) { s.1 }),
    room_opened_by_user_id: Some(o.opened_by.0),
    room_opened_by_name: Some(o.opened_by.1),
    room_updated_at: Some(o.at),
    room_archived_at: case o.status, is_open {
      room_status.Archived, _ -> Some(o.at)
      _, _ -> None
    },
    room_closed_at: case o.status {
      room_status.Closed -> Some(o.at)
      _ -> None
    },
    room_rev: Some(1),
    room_rev_at: Some(o.at),
    room_rev_by_user_id: Some(id.org_user_to_string(o.opened_by.0)),
    room_rev_by_name: Some(o.opened_by.1),
  )
}

pub type NewCase {
  NewCase(
    org_id: id.OrgId,
    player_id: id.PlayerId,
    player_name: String,
    owner: #(id.OrgUserId, String),
    restricted: Bool,
    level: orgs.Level,
  )
}

/// A new case with its Room, in one write.
pub fn create(
  tx: Tx,
  new: NewCase,
  opening: Opening,
) -> Result(id.RecruitmentCaseId, Fail(e)) {
  use case_id <- result.try(id.next_recruitment_case(tx))
  let r =
    row.Row(
      ..row.new(
        id: case_id,
        org_id: new.org_id,
        player_id: new.player_id,
        owner_user_id: new.owner.0,
        stage: row.Identified,
        priority: row.Medium,
        restricted: new.restricted,
        created_at: opening.at,
      ),
      player_name: Some(new.player_name),
      owner_name: Some(new.owner.1),
    )
  use _ <- result.map(row.insert(tx, with_opening(r, opening, new.level)))
  case_id
}

/// A plain case: the case workspace's, with no Room.
pub type PlainCase {
  PlainCase(
    org_id: id.OrgId,
    player_id: id.PlayerId,
    player_name: String,
    vacancy_id: Option(String),
    owner: #(id.OrgUserId, String),
    stage: row.Stage,
    priority: row.Priority,
    deadline: Option(Due),
    restricted: Bool,
    at: Int,
  )
}

pub fn create_plain(
  tx: Tx,
  new: PlainCase,
) -> Result(id.RecruitmentCaseId, Fail(e)) {
  use case_id <- result.try(id.next_recruitment_case(tx))
  let #(deadline_day, deadline_at) = due_fields(new.deadline)
  let r =
    row.Row(
      ..row.new(
        id: case_id,
        org_id: new.org_id,
        player_id: new.player_id,
        owner_user_id: new.owner.0,
        stage: new.stage,
        priority: new.priority,
        restricted: new.restricted,
        created_at: new.at,
      ),
      player_name: Some(new.player_name),
      owner_name: Some(new.owner.1),
      vacancy_id: new.vacancy_id,
      deadline_day:,
      deadline_at:,
    )
  use _ <- result.map(row.insert(tx, r))
  case_id
}

/// A plain case's stage. A Room's stage follows its status (`move`) and is never written alone.
pub fn set_stage(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  stage: row.Stage,
) -> Result(Nil, Fail(e)) {
  exactly_one(
    tx,
    "UPDATE recruitment_cases SET stage = ? WHERE id = ? AND room_status IS NULL RETURNING id",
    [sqlight.text(row.stage_to_string(stage)), id.recruitment_case_sql(case_id)],
  )
}

/// The workspace decision on a case, Room or not.
pub type WorkspaceDecision {
  WorkspaceDecision(
    outcome: case_outcome.CaseOutcome,
    reasons: String,
    by: #(id.OrgUserId, String),
    approved_by: Option(String),
    at: Int,
  )
}

pub fn record_decision(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  d: WorkspaceDecision,
) -> Result(Nil, Fail(e)) {
  exactly_one(
    tx,
    "UPDATE recruitment_cases SET decision_outcome = ?, decision_reasons = ?, decision_by_user_id = ?, decision_by_name = ?, decision_approved_by_name = ?, decision_at = ? WHERE id = ? RETURNING id",
    [
      sqlight.text(case_outcome.to_string(d.outcome)),
      sqlight.text(d.reasons),
      id.org_user_sql(d.by.0),
      sqlight.text(d.by.1),
      sqlight.nullable(sqlight.text, d.approved_by),
      sqlight.int(d.at),
      id.recruitment_case_sql(case_id),
    ],
  )
}

/// A sign decision a non-lead asked a recruitment lead to approve.
pub fn request_approval(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  d: WorkspaceDecision,
) -> Result(approval_row.Row, Fail(e)) {
  use approval_id <- result.try(id.next_approval(tx))
  use position <- result.try(next_position(tx, approval_row.table, case_id))
  let r =
    approval_row.Row(
      case_id:,
      position:,
      id: approval_id,
      decision_outcome: d.outcome,
      decision_reasons: Some(d.reasons),
      requested_by_user_id: Some(d.by.0),
      requested_by_name: Some(d.by.1),
      status: approval_row.Pending,
      requested_at: d.at,
      resolved_by_user_id: None,
      resolved_by_name: None,
      resolved_at: None,
    )
  use _ <- result.map(approval_row.insert(tx, r))
  r
}

/// A pending approval's answer, by a recruitment lead.
pub fn resolve_approval(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  approval_id: id.ApprovalId,
  status: approval_row.Status,
  by: #(id.OrgUserId, String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  exactly_one(
    tx,
    "UPDATE case_approvals SET status = ?, resolved_by_user_id = ?, resolved_by_name = ?, resolved_at = ? WHERE case_id = ? AND id = ? AND status = 'pending' RETURNING id",
    [
      sqlight.text(approval_row.status_to_string(status)),
      id.org_user_sql(by.0),
      sqlight.text(by.1),
      sqlight.int(at),
      id.recruitment_case_sql(case_id),
      id.approval_sql(approval_id),
    ],
  )
}

/// Gives a plain case its Room: a Room adopts the club's open case rather than open a second one.
pub fn adopt(
  tx: Tx,
  plain: row.Row,
  opening: Opening,
  level: orgs.Level,
) -> Result(Nil, Fail(e)) {
  let r = with_opening(plain, opening, level)
  exactly_one(
    tx,
    "UPDATE recruitment_cases SET stage = ?, room_status = ?, room_priority = ?, room_lead_scout_user_id = ?, room_source_context = ?, room_source_ref_id = ?, room_source_ref_version = ?, room_opened_by_user_id = ?, room_opened_by_name = ?, room_updated_at = ?, room_archived_at = ?, room_closed_at = ?, room_rev = ?, room_rev_at = ?, room_rev_by_user_id = ?, room_rev_by_name = ? WHERE id = ? AND room_status IS NULL RETURNING id",
    [
      sqlight.text(row.stage_to_string(r.stage)),
      sqlight.text(room_status.to_string(opening.status)),
      sqlight.text(row.room_priority_to_string(opening.priority)),
      id.org_user_sql(opening.lead_scout),
      sqlight.text(source_context.to_string(opening.source_context)),
      sqlight.nullable(sqlight.text, r.room_source_ref_id),
      sqlight.nullable(sqlight.int, r.room_source_ref_version),
      id.org_user_sql(opening.opened_by.0),
      sqlight.text(opening.opened_by.1),
      sqlight.int(opening.at),
      sqlight.nullable(sqlight.int, r.room_archived_at),
      sqlight.nullable(sqlight.int, r.room_closed_at),
      sqlight.int(1),
      sqlight.int(opening.at),
      sqlight.nullable(sqlight.text, r.room_rev_by_user_id),
      sqlight.nullable(sqlight.text, r.room_rev_by_name),
      id.recruitment_case_sql(plain.id),
    ],
  )
}

/// A move of a Room's status (statusMove): the status, the stage derived from it, the filing instants, the last
/// activity and the revision, together.
pub type Move {
  Move(
    to: RoomStatus,
    at: Int,
    by_id: Option(String),
    by_name: Option(String),
    /// The lifecycle's resume, its own edge out of `on_hold`.
    resume: Bool,
    reopened: Option(Reopened),
    source_context: Option(SourceContext),
  )
}

pub type Reopened {
  Reopened(
    by_id: Option(String),
    by_name: Option(String),
    from: RoomStatus,
    reason_codes: List(String),
    source_context: Option(SourceContext),
    source_ref: Option(#(String, Option(Int))),
  )
}

pub fn move(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  level: orgs.Level,
  m: Move,
) -> Result(Nil, Fail(e)) {
  let is_open = room_rules.is_open(m.to)
  // Filing instants: set when filed there, cleared on return to an open status, kept otherwise.
  let instant = fn(column, filed) {
    case filed, is_open {
      True, _ -> #(column <> " = ?", [sqlight.int(m.at)])
      False, True -> #(column <> " = NULL", [])
      False, False -> #(column <> " = " <> column, [])
    }
  }
  let archived = instant("room_archived_at", m.to == room_status.Archived)
  let closed = instant("room_closed_at", m.to == room_status.Closed)
  let reopened = case m.reopened {
    None -> #([], [])
    Some(r) -> #(
      [
        "room_reopened_at = ?", "room_reopened_by_user_id = ?",
        "room_reopened_by_name = ?", "room_reopened_from = ?",
        "room_reopened_reason_codes_json = ?",
        "room_reopened_source_context = ?", "room_reopened_source_ref_id = ?",
        "room_reopened_source_ref_version = ?",
      ],
      [
        sqlight.int(m.at),
        sqlight.nullable(sqlight.text, r.by_id),
        sqlight.nullable(sqlight.text, r.by_name),
        sqlight.text(room_status.to_string(r.from)),
        sqlight.text(json.to_string(json.array(r.reason_codes, json.string))),
        sqlight.nullable(
          sqlight.text,
          option.map(r.source_context, source_context.to_string),
        ),
        sqlight.nullable(sqlight.text, option.map(r.source_ref, fn(s) { s.0 })),
        sqlight.nullable(sqlight.int, option.then(r.source_ref, fn(s) { s.1 })),
      ],
    )
  }
  let context = case m.source_context {
    Some(s) -> #(["room_source_context = ?"], [
      sqlight.text(source_context.to_string(s)),
    ])
    None -> #([], [])
  }
  let #(from_sql, from_args) = case m.resume {
    True -> #("room_status = 'on_hold'", [])
    False -> {
      let from =
        list.filter(room_rules.statuses(), room_rules.can_transition(_, m.to))
      #(
        "room_status IN ("
          <> string.join(list.map(from, fn(_) { "?" }), ", ")
          <> ")",
        list.map(from, fn(s) { sqlight.text(room_status.to_string(s)) }),
      )
    }
  }
  let sets =
    list.flatten([
      [
        "room_status = ?",
        "stage = ?",
        archived.0,
        closed.0,
        "room_updated_at = ?",
        "room_rev_at = ?",
        "room_rev_by_user_id = ?",
        "room_rev_by_name = ?",
        "room_rev = room_rev + 1",
      ],
      reopened.0,
      context.0,
    ])
  exactly_one(
    tx,
    "UPDATE recruitment_cases SET "
      <> string.join(sets, ", ")
      <> " WHERE id = ? AND "
      <> from_sql
      <> " RETURNING id",
    list.flatten([
      [
        sqlight.text(room_status.to_string(m.to)),
        sqlight.text(
          row.stage_to_string(room_rules.stage_for_room_status(m.to, level)),
        ),
      ],
      archived.1,
      closed.1,
      [
        sqlight.int(m.at),
        sqlight.int(m.at),
        sqlight.nullable(sqlight.text, m.by_id),
        sqlight.nullable(sqlight.text, m.by_name),
      ],
      reopened.1,
      context.1,
      [id.recruitment_case_sql(case_id)],
      from_args,
    ]),
  )
}

/// The Room's settings; an absent one stays.
pub type Edit {
  Edit(
    priority: Option(row.RoomPriority),
    tags: Option(List(String)),
    lead_scout: Option(Option(id.OrgUserId)),
    owner: Option(#(id.OrgUserId, String)),
    restricted: Option(Bool),
    deadline: Option(Option(Due)),
  )
}

pub fn edit(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  e: Edit,
) -> Result(Nil, Fail(e)) {
  let sets =
    option.values([
      option.map(e.priority, fn(p) {
        #("room_priority = ?", [sqlight.text(row.room_priority_to_string(p))])
      }),
      option.map(e.lead_scout, fn(l) {
        #("room_lead_scout_user_id = ?", [
          sqlight.nullable(sqlight.text, option.map(l, id.org_user_to_string)),
        ])
      }),
      option.map(e.owner, fn(o) {
        #("owner_user_id = ?, owner_name = ?", [
          id.org_user_sql(o.0),
          sqlight.text(o.1),
        ])
      }),
      option.map(e.restricted, fn(r) { #("restricted = ?", [sqlight.bool(r)]) }),
      option.map(e.deadline, fn(d) {
        let #(day, at) = due_columns(d)
        #("deadline_day = ?, deadline_at = ?", [day, at])
      }),
    ])
  use _ <- result.try(case sets {
    [] -> Ok(Nil)
    _ ->
      exactly_one(
        tx,
        "UPDATE recruitment_cases SET "
          <> string.join(list.map(sets, fn(s) { s.0 }), ", ")
          <> " WHERE id = ? AND room_status IS NOT NULL RETURNING id",
        list.append(list.flat_map(sets, fn(s) { s.1 }), [
          id.recruitment_case_sql(case_id),
        ]),
      )
  })
  case e.tags {
    None -> Ok(Nil)
    Some(tags) -> {
      use _ <- result.try(
        store.run(tx, "DELETE FROM case_room_tags WHERE case_id = ?", [
          id.recruitment_case_sql(case_id),
        ]),
      )
      list.index_map(tags, fn(t, i) { #(t, i) })
      |> list.try_each(fn(p) {
        store.run(
          tx,
          "INSERT INTO case_room_tags (case_id, position, tag) VALUES (?, ?, ?)",
          [
            id.recruitment_case_sql(case_id),
            sqlight.int(p.1),
            sqlight.text(p.0),
          ],
        )
      })
    }
  }
}

/// A due date's two columns: a calendar day as text, or an instant.
pub fn due_columns(d: Option(Due)) -> #(sqlight.Value, sqlight.Value) {
  case d {
    Some(temporal.Day(ms)) -> #(sqlight.text(clock.iso_day(ms)), sqlight.null())
    Some(temporal.Instant(ms)) -> #(sqlight.null(), sqlight.int(ms))
    None -> #(sqlight.null(), sqlight.null())
  }
}

/// A due date as the TypeScript server returns one: the day's text, or the instant.
pub fn due_json(day: Option(String), at: Option(Int)) -> Json {
  case day, at {
    Some(d), _ -> json.string(d)
    None, Some(ms) -> json.int(ms)
    None, None -> json.null()
  }
}

fn due_fields(d: Option(Due)) -> #(Option(String), Option(Int)) {
  case d {
    Some(temporal.Day(ms)) -> #(Some(clock.iso_day(ms)), None)
    Some(temporal.Instant(ms)) -> #(None, Some(ms))
    None -> #(None, None)
  }
}

pub type NewTask {
  NewTask(
    title: String,
    description: Option(String),
    assignee: Option(#(id.OrgUserId, String)),
    due: Option(Due),
    linked_type: Option(task_row.LinkedResourceType),
    linked_id: Option(String),
    created_by: #(id.OrgUserId, String),
    at: Int,
  )
}

pub fn add_task(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  t: NewTask,
) -> Result(task_row.Row, Fail(e)) {
  use task_id <- result.try(id.next_task(tx))
  use position <- result.try(next_position(tx, task_row.table, case_id))
  let #(due_day, due_at) = due_fields(t.due)
  let r =
    task_row.Row(
      ..task_row.new(
        case_id:,
        position:,
        id: task_id,
        title: t.title,
        status: task_state.Open,
        created_at: t.at,
      ),
      description: t.description,
      due_day:,
      due_at:,
      assignee_user_id: option.map(t.assignee, fn(a) { a.0 }),
      assignee_name: option.map(t.assignee, fn(a) { a.1 }),
      linked_resource_type: t.linked_type,
      linked_resource_id: t.linked_id,
      created_by_user_id: Some(t.created_by.0),
      created_by_name: Some(t.created_by.1),
    )
  use _ <- result.map(task_row.insert(tx, r))
  r
}

/// A plain case's task (`POST /org/cases/:id/tasks`). The workspace keeps only its assignee's id, and no author.
pub fn add_case_task(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  title: String,
  assignee: Option(id.OrgUserId),
  due: Option(Due),
  at: Int,
) -> Result(task_row.Row, Fail(e)) {
  use task_id <- result.try(id.next_task(tx))
  use position <- result.try(next_position(tx, task_row.table, case_id))
  let #(due_day, due_at) = due_fields(due)
  let r =
    task_row.Row(
      ..task_row.new(
        case_id:,
        position:,
        id: task_id,
        title:,
        status: task_state.Open,
        created_at: at,
      ),
      due_day:,
      due_at:,
      assignee_user_id: assignee,
    )
  use _ <- result.map(task_row.insert(tx, r))
  r
}

/// A task's status (with its completion instant), who completed it, or its assignee; `Some(None)` unassigns it.
pub fn update_task(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  task_id: id.TaskId,
  status: Option(#(TaskState, Option(Int))),
  completed_by: Option(String),
  assignee: Option(Option(#(id.OrgUserId, String))),
) -> Result(Nil, Fail(e)) {
  let sets =
    option.values([
      option.map(completed_by, fn(name) {
        #("completed_by_name = ?", [sqlight.text(name)])
      }),
      option.map(status, fn(s) {
        #("status = ?, completed_at = ?", [
          sqlight.text(task_state.to_string(s.0)),
          sqlight.nullable(sqlight.int, s.1),
        ])
      }),
      option.map(assignee, fn(a) {
        #("assignee_user_id = ?, assignee_name = ?", [
          sqlight.nullable(
            sqlight.text,
            option.map(a, fn(x) { id.org_user_to_string(x.0) }),
          ),
          sqlight.nullable(sqlight.text, option.map(a, fn(x) { x.1 })),
        ])
      }),
    ])
  case sets {
    [] -> Ok(Nil)
    _ ->
      exactly_one(
        tx,
        "UPDATE case_tasks SET "
          <> string.join(list.map(sets, fn(s) { s.0 }), ", ")
          <> " WHERE case_id = ? AND id = ? RETURNING id",
        list.append(list.flat_map(sets, fn(s) { s.1 }), [
          id.recruitment_case_sql(case_id),
          id.task_sql(task_id),
        ]),
      )
  }
}

pub fn add_assignment(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  user: #(id.OrgUserId, String),
  task: String,
  due: Option(Due),
  at: Int,
) -> Result(assignment_row.Row, Fail(e)) {
  use assignment_id <- result.try(id.next_assignment(tx))
  use position <- result.try(next_position(tx, assignment_row.table, case_id))
  let #(due_day, due_at) = due_fields(due)
  let r =
    assignment_row.Row(
      ..assignment_row.new(
        case_id:,
        position:,
        id: assignment_id,
        user_id: user.0,
        task:,
        status: task_state.Open,
        created_at: at,
      ),
      user_name: Some(user.1),
      due_day:,
      due_at:,
    )
  use _ <- result.map(assignment_row.insert(tx, r))
  r
}

/// Links a trial or a request (each once) or the signing.
pub fn link(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  trial_id: Option(id.TrialId),
  request_id: Option(id.RequestId),
  signing_id: Option(String),
) -> Result(Nil, Fail(e)) {
  let once = fn(table, column, value) {
    use position <- result.try(next_position(tx, table, case_id))
    store.run(
      tx,
      "INSERT INTO "
        <> table
        <> " (case_id, position, "
        <> column
        <> ") SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM "
        <> table
        <> " WHERE case_id = ? AND "
        <> column
        <> " = ?)",
      [
        id.recruitment_case_sql(case_id),
        sqlight.int(position),
        value,
        id.recruitment_case_sql(case_id),
        value,
      ],
    )
  }
  use _ <- result.try(case request_id {
    Some(r) -> once("case_request_links", "request_id", id.request_sql(r))
    None -> Ok(Nil)
  })
  use _ <- result.try(case trial_id {
    Some(t) -> once("case_trial_links", "trial_id", id.trial_sql(t))
    None -> Ok(Nil)
  })
  case signing_id {
    Some(s) ->
      store.run(
        tx,
        "UPDATE recruitment_cases SET links_signing_id = ? WHERE id = ?",
        [sqlight.text(s), id.recruitment_case_sql(case_id)],
      )
    None -> Ok(Nil)
  }
}

/// The case's sign-off decision.
pub type SignOff {
  SignOff(
    outcome: case_outcome.CaseOutcome,
    reasons: String,
    by: #(id.OrgUserId, String),
    at: Int,
  )
}

pub fn record_sign_off(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  s: SignOff,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE recruitment_cases SET decision_outcome = ?, decision_reasons = ?, decision_by_user_id = ?, decision_by_name = ?, decision_approved_by_name = NULL, decision_at = ? WHERE id = ?",
    [
      sqlight.text(case_outcome.to_string(s.outcome)),
      sqlight.text(s.reasons),
      id.org_user_sql(s.by.0),
      sqlight.text(s.by.1),
      sqlight.int(s.at),
      id.recruitment_case_sql(case_id),
    ],
  )
}

/// The parts of a Room its roles are decided from.
pub fn membership(r: Room) -> room_rules.Membership {
  room_rules.Membership(
    owner: r.row.owner_user_id,
    lead_scout: r.row.room_lead_scout_user_id,
    assignees: list.map(r.assignments, fn(a) { a.user_id }),
    restricted: r.row.restricted,
    status: r.status,
  )
}

/// The Room's history as the activity feed reads it.
pub fn events(r: Room) -> List(room_rules.Event) {
  list.map(r.history, fn(h) {
    room_rules.Event(
      id: id.case_event_to_string(h.id),
      at: h.at,
      action: h.action,
      by_kind: h.by_kind,
      by_id: h.by_id,
      by_name: h.by_name,
      detail: case h.detail_json, h.detail_text {
        Some(text), _ -> option.from_result(json_text.parse(text))
        None, Some(text) -> Some(json.string(text))
        None, None -> None
      },
    )
  })
}
