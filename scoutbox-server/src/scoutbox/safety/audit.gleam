//// Safety and audit records (repositories/safetyAudit.ts): blocks, reports, the moderation log, club notes and
//// operations events. Each write names its record's id, minted inside the unit.
////
//// Lifting a block deletes its row (Q5, docs/decisions.md). A report is resolved once: the status moves from
//// `pending_review` guarded in SQL.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/ids
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/blocks as block_row
import scoutbox/rows/moderation_flags as flag_row
import scoutbox/rows/moderation_log as moderation_row
import scoutbox/rows/ops_events as ops_row
import scoutbox/rows/org_notes as note_row
import scoutbox/rows/reports as report_row
import scoutbox/rules/moderation
import scoutbox/vocab/party.{type Party}
import sqlight

pub type Block =
  block_row.Row

pub type Report =
  report_row.Row

pub type Note =
  note_row.Row

/// Newest first, keyed by `seq`: `{ items, nextCursor }` before the view.
fn newest_page(
  read: Read,
  table: String,
  columns: String,
  decoder: decode.Decoder(a),
  seq_of: fn(a) -> Int,
  where: String,
  args: List(sqlight.Value),
  page: Page,
) -> Result(#(List(a), Option(String)), Fail(e)) {
  let #(after, after_args) = case page.after {
    Some([IntKey(seq)]) -> #(" AND seq < ?", [sqlight.int(seq)])
    _ -> #("", [])
  }
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> where
      <> after
      <> " ORDER BY seq DESC LIMIT ?",
    list.flatten([args, after_args, [sqlight.int(page.limit + 1)]]),
    decoder,
  ))
  paging.page_of(rows, page.limit, fn(r) { [IntKey(seq_of(r))] })
}

fn count(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
) -> Result(Int, Fail(e)) {
  store.one(read, sql, args, decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

// ---------------------------------------------------------------------------------------------- blocks

pub fn add_block(
  tx: Tx,
  player_id player_id: String,
  org_id org_id: String,
  by by: Party,
  reason reason: String,
  at at: Int,
) -> Result(Block, Fail(e)) {
  use id <- result.try(ids.next(tx, "blk"))
  use rows <- result.map(store.write(
    tx,
    block_row.insert_sql <> " RETURNING " <> block_row.columns,
    block_row.values(block_row.new(
      id:,
      player_id:,
      org_id:,
      by_kind: by,
      reason:,
      created_at: at,
    )),
    block_row.decoder(),
  ))
  let assert [block] = rows as "an INSERT … RETURNING returns its row"
  block
}

/// Deletes the block; returns what it was, or `None` when there is no such block.
pub fn lift_block(tx: Tx, id: String) -> Result(Option(Block), Fail(e)) {
  store.write(
    tx,
    "DELETE FROM blocks WHERE id = ? RETURNING " <> block_row.columns,
    [sqlight.text(id)],
    block_row.decoder(),
  )
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

pub fn block_page(
  read: Read,
  page: Page,
) -> Result(#(List(Block), Option(String)), Fail(e)) {
  newest_page(
    read,
    "blocks",
    block_row.columns,
    block_row.decoder(),
    fn(b) { b.seq },
    "1 = 1",
    [],
    page,
  )
}

/// True when the player (or their guardian) blocked the organisation.
pub fn is_blocked(
  read: Read,
  player_id: String,
  org_id: String,
) -> Result(Bool, Fail(e)) {
  count(read, "SELECT COUNT(*) FROM blocks WHERE player_id = ? AND org_id = ?", [
    sqlight.text(player_id),
    sqlight.text(org_id),
  ])
  |> result.map(fn(n) { n > 0 })
}

pub fn block_count(read: Read) -> Result(Int, Fail(e)) {
  count(read, "SELECT COUNT(*) FROM blocks", [])
}

pub fn block_view(b: Block) -> Json {
  json.object([
    #("id", json.string(b.id)),
    #("playerId", json.string(b.player_id)),
    #("orgId", json.string(b.org_id)),
    #("by", party.to_json(b.by_kind)),
    #("reason", json.string(b.reason)),
    #("ts", json.int(b.created_at)),
  ])
}

// --------------------------------------------------------------------------------------------- reports

pub type ReportError {
  ReportNotFound
  AlreadyResolved
}

/// Files a pending report. `by_org_id` is set exactly for a staff member's report (the table's CHECK).
pub fn file_report(
  tx: Tx,
  by by: report_row.ByKind,
  by_id by_id: String,
  by_org_id by_org_id: Option(String),
  target_kind target_kind: report_row.TargetKind,
  target_org_id target_org_id: Option(String),
  target_scout_name target_scout_name: Option(String),
  target_player_id target_player_id: Option(String),
  reason reason: String,
  urgent urgent: Bool,
  at at: Int,
) -> Result(Report, Fail(e)) {
  use id <- result.try(ids.next(tx, "rep"))
  use rows <- result.map(store.write(
    tx,
    report_row.insert_sql <> " RETURNING " <> report_row.columns,
    report_row.values(
      report_row.New(
        ..report_row.new(
          id:,
          created_at: at,
          by_kind: by,
          by_id:,
          target_kind:,
          reason:,
          urgent:,
          status: report_row.PendingReview,
        ),
        by_org_id:,
        target_org_id:,
        target_scout_name:,
        target_player_id:,
      ),
    ),
    report_row.decoder(),
  ))
  let assert [report] = rows as "an INSERT … RETURNING returns its row"
  report
}

pub fn report_by_id(read: Read, id: String) -> Result(Option(Report), Fail(e)) {
  store.one(
    read,
    "SELECT " <> report_row.columns <> " FROM reports WHERE id = ?",
    [sqlight.text(id)],
    report_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// Resolves a pending report once.
pub fn resolve_report(
  tx: Tx,
  id: String,
  outcome outcome: String,
  at at: Int,
) -> Result(Report, Fail(ReportError)) {
  use changed <- result.try(store.write(
    tx,
    "UPDATE reports SET status = 'resolved', outcome = ?, resolved_at = ? WHERE id = ? AND status = 'pending_review' RETURNING "
      <> report_row.columns,
    [sqlight.text(outcome), sqlight.int(at), sqlight.text(id)],
    report_row.decoder(),
  ))
  case changed {
    [report] -> Ok(report)
    _ -> {
      use found <- result.try(report_by_id(store.reading(tx), id))
      case found {
        Some(_) -> store.refuse(AlreadyResolved)
        None -> store.refuse(ReportNotFound)
      }
    }
  }
}

/// The reports one reporter filed, newest first.
pub fn reports_by(
  read: Read,
  by: report_row.ByKind,
  by_id: String,
) -> Result(List(Report), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> report_row.columns
      <> " FROM reports WHERE by_kind = ? AND by_id = ? ORDER BY seq DESC",
    [sqlight.text(report_row.by_kind_to_string(by)), sqlight.text(by_id)],
    report_row.decoder(),
  )
}

/// Is an urgent report against the organisation still waiting for review?
pub fn open_urgent_against(
  read: Read,
  org_id: String,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM reports WHERE target_org_id = ? AND urgent = 1 AND status = 'pending_review' LIMIT 1",
    [sqlight.text(org_id)],
    decode.success(Nil),
  )
  |> result.map(fn(found) { found == Ok(Nil) })
}

pub fn open_report_count(read: Read) -> Result(Int, Fail(e)) {
  count(
    read,
    "SELECT COUNT(*) FROM reports WHERE status = 'pending_review'",
    [],
  )
}

const rank_sql =
  "CASE WHEN status = 'pending_review' AND urgent = 1 THEN 0 WHEN status = 'pending_review' THEN 1 ELSE 2 END"

const sort_sql =
  "CASE WHEN status = 'pending_review' THEN created_at ELSE -created_at END"

/// Triage order: urgent pending first, then pending, both oldest first; then resolved, newest first. The cursor is
/// the last row's `[rank, sortKey, seq]`.
pub fn triage_page(
  read: Read,
  page: Page,
) -> Result(#(List(Report), Option(String)), Fail(e)) {
  let #(after, args) = case page.after {
    Some([IntKey(rank), IntKey(sort), IntKey(seq)]) -> #(
      " WHERE (" <> rank_sql <> ", " <> sort_sql <> ", seq) > (?, ?, ?)",
      [sqlight.int(rank), sqlight.int(sort), sqlight.int(seq)],
    )
    _ -> #("", [])
  }
  use rows <- result.map(
    store.query(
      read,
      "SELECT "
        <> report_row.columns
        <> ", "
        <> rank_sql
        <> " AS rank_, "
        <> sort_sql
        <> " AS sort_ FROM reports"
        <> after
        <> " ORDER BY rank_, sort_, seq LIMIT ?",
      list.append(args, [sqlight.int(page.limit + 1)]),
      {
        use r <- decode.then(report_row.decoder())
        use rank <- decode.field(report_row.width, decode.int)
        use sort <- decode.field(report_row.width + 1, decode.int)
        decode.success(#(r, rank, sort))
      },
    ),
  )
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(t) {
      [IntKey(t.1), IntKey(t.2), IntKey({ t.0 }.seq)]
    })
  #(list.map(items, fn(t) { t.0 }), next)
}

pub fn report_view(r: Report) -> Json {
  let opt = json.nullable(_, json.string)
  json.object([
    #("id", json.string(r.id)),
    #("ts", json.int(r.created_at)),
    #("by", report_row.by_kind_to_json(r.by_kind)),
    #("byId", json.string(r.by_id)),
    #("byOrgId", opt(r.by_org_id)),
    #("targetKind", report_row.target_kind_to_json(r.target_kind)),
    #("targetOrgId", opt(r.target_org_id)),
    #("targetScoutName", opt(r.target_scout_name)),
    #("targetPlayerId", opt(r.target_player_id)),
    #("reason", json.string(r.reason)),
    #("urgent", json.bool(r.urgent)),
    #("status", report_row.status_to_json(r.status)),
    #("outcome", opt(r.outcome)),
    #("resolvedAt", json.nullable(r.resolved_at, json.int)),
  ])
}

// ------------------------------------------------------------------------------------- the moderation log

/// Where a moderated text was written. Only the ids the context has are stored.
pub type Context {
  Context(
    kind: String,
    player_id: Option(String),
    org_id: Option(String),
    user_id: Option(String),
    channel_id: Option(String),
    request_id: Option(String),
  )
}

pub type ModerationEntry {
  ModerationEntry(row: moderation_row.Row, flags: List(flag_row.Flag))
}

pub fn record_moderation(
  tx: Tx,
  context: Context,
  hit: moderation.Hit,
  excerpt: String,
  at: Int,
) -> Result(String, Fail(e)) {
  use id <- result.try(ids.next(tx, "mod"))
  use _ <- result.try(moderation_row.insert(
    tx,
    moderation_row.New(
      ..moderation_row.new(
        id:,
        created_at: at,
        context_kind: context.kind,
        severity: hit.severity,
        excerpt:,
      ),
      context_player_id: context.player_id,
      context_org_id: context.org_id,
      context_user_id: context.user_id,
      context_channel_id: context.channel_id,
      context_request_id: context.request_id,
    ),
  ))
  use _ <- result.map(
    list.index_map(hit.flags, fn(f, i) { #(f, i) })
    |> list.try_each(fn(pair) {
      flag_row.insert(
        tx,
        flag_row.Row(moderation_id: id, ord: pair.1, flag: pair.0),
      )
    }),
  )
  id
}

pub fn moderation_page(
  read: Read,
  page: Page,
) -> Result(#(List(ModerationEntry), Option(String)), Fail(e)) {
  use #(rows, next) <- result.try(newest_page(
    read,
    "moderation_log",
    moderation_row.columns,
    moderation_row.decoder(),
    fn(m) { m.seq },
    "1 = 1",
    [],
    page,
  ))
  use flags <- result.map(store.query(
    read,
    "SELECT "
      <> flag_row.columns
      <> " FROM moderation_flags WHERE moderation_id IN (SELECT value FROM json_each(?)) ORDER BY moderation_id, ord",
    [
      json.array(rows, fn(r) { json.string(r.id) })
      |> json.to_string
      |> sqlight.text,
    ],
    flag_row.decoder(),
  ))
  #(
    list.map(rows, fn(r) {
      ModerationEntry(
        r,
        list.filter_map(flags, fn(f) {
          case f.moderation_id == r.id {
            True -> Ok(f.flag)
            False -> Error(Nil)
          }
        }),
      )
    }),
    next,
  )
}

/// Every hit, or only those of one severity.
pub fn moderation_count(
  read: Read,
  severity: Option(moderation_row.Severity),
) -> Result(Int, Fail(e)) {
  case severity {
    None -> count(read, "SELECT COUNT(*) FROM moderation_log", [])
    Some(s) ->
      count(read, "SELECT COUNT(*) FROM moderation_log WHERE severity = ?", [
        sqlight.text(moderation_row.severity_to_string(s)),
      ])
  }
}

pub fn moderation_view(m: ModerationEntry) -> Json {
  let r = m.row
  let present = fn(name, v) {
    case v {
      Some(v) -> [#(name, json.string(v))]
      None -> []
    }
  }
  json.object([
    #("id", json.string(r.id)),
    #("ts", json.int(r.created_at)),
    #(
      "context",
      json.object(
        list.flatten([
          [#("kind", json.string(r.context_kind))],
          present("playerId", r.context_player_id),
          present("orgId", r.context_org_id),
          present("userId", r.context_user_id),
          present("channelId", r.context_channel_id),
          present("requestId", r.context_request_id),
          present("trialId", r.context_trial_id),
        ]),
      ),
    ),
    #("flags", json.array(m.flags, flag_row.flag_to_json)),
    #("severity", moderation_row.severity_to_json(r.severity)),
    #("excerpt", json.string(r.excerpt)),
  ])
}

// ----------------------------------------------------------------------------------------------- notes

pub fn add_note(
  tx: Tx,
  org_id org_id: String,
  player_id player_id: String,
  user_id user_id: String,
  scout_name scout_name: String,
  text text: String,
  at at: Int,
) -> Result(Note, Fail(e)) {
  use id <- result.try(ids.next(tx, "note"))
  use rows <- result.map(store.write(
    tx,
    note_row.insert_sql <> " RETURNING " <> note_row.columns,
    note_row.values(note_row.new(
      id:,
      org_id:,
      player_id:,
      user_id:,
      scout_name:,
      text:,
      created_at: at,
    )),
    note_row.decoder(),
  ))
  let assert [note] = rows as "an INSERT … RETURNING returns its row"
  note
}

/// One club's notes on one player, newest first.
pub fn notes_for(
  read: Read,
  org_id: String,
  player_id: String,
) -> Result(List(Note), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> note_row.columns
      <> " FROM org_notes WHERE org_id = ? AND player_id = ? ORDER BY seq DESC",
    [sqlight.text(org_id), sqlight.text(player_id)],
    note_row.decoder(),
  )
}

pub fn note_view(n: Note) -> Json {
  json.object([
    #("id", json.string(n.id)),
    #("orgId", json.string(n.org_id)),
    #("playerId", json.string(n.player_id)),
    #("userId", json.string(n.user_id)),
    #("scoutName", json.string(n.scout_name)),
    #("text", json.string(n.text)),
    #("ts", json.int(n.created_at)),
  ])
}

// ----------------------------------------------------------------------------------------- operations

pub fn ops_count(read: Read, kind: ops_row.Kind) -> Result(Int, Fail(e)) {
  count(read, "SELECT COUNT(*) FROM ops_events WHERE kind = ?", [
    sqlight.text(ops_row.kind_to_string(kind)),
  ])
}

/// The newest `n`, newest first.
pub fn ops_newest(read: Read, n: Int) -> Result(List(ops_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> ops_row.columns <> " FROM ops_events ORDER BY seq DESC LIMIT ?",
    [sqlight.int(n)],
    ops_row.decoder(),
  )
}
