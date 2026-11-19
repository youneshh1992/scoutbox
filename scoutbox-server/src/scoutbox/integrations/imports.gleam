//// CSV prospect imports, prospects and identity reviews (domains/integrations/imports.mjs, repositories/
//// integrations.mjs). A bulk import creates organisation-private prospects, never platform player accounts, so a
//// CSV can never mint a discoverable minor. Identity is provider + external id: a name that matches a player only
//// queues a review for a lead, never a merge.
////
//// An upload is validated into a dry run (the batch, every row's record, its errors and disposition) and written
//// nowhere else; a lead's commit then creates the prospects and queues the reviews, at once.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/set
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/integrations/webhooks
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/identity_reviews as review_row
import scoutbox/rows/import_batch_columns as column_row
import scoutbox/rows/import_batch_created_prospects as created_row
import scoutbox/rows/import_batch_history as history_row
import scoutbox/rows/import_batch_row_errors as error_row
import scoutbox/rows/import_batch_rows as rows_row
import scoutbox/rows/import_batches as batch_row
import scoutbox/rows/prospects as prospect_row
import scoutbox/rows/webhook_deliveries as delivery_row
import scoutbox/rules/age
import scoutbox/vocab/position
import sqlight
import wisp.{type Request, type Response}

/// A prospect field, as a CSV column maps to it.
pub type Field =
  column_row.Field

/// The mapped fields of one CSV row, in field order, each trimmed text (a mapped empty cell is "").
type Record =
  List(#(Field, String))

const max_rows = 2000

const max_columns = 60

const max_header = 200

fn fields() -> List(Field) {
  list.map(column_row.field_pairs, fn(p) { p.1 })
}

fn field_name(f: Field) -> String {
  column_row.field_to_string(f)
}

/// The longest text each record field may hold; a longer cell is a row error, kept cut to this length.
fn field_limit(f: Field) -> Int {
  case f {
    column_row.Name -> 200
    column_row.Dob -> 40
    column_row.Position -> 20
    column_row.Foot -> 20
    column_row.Heightcm -> 20
    column_row.Provider -> 80
    column_row.Externalid -> 80
    column_row.Notes -> 2000
  }
}

fn get(rec: Record, f: Field) -> String {
  list.key_find(rec, f) |> result.unwrap("")
}

// ------------------------------------------------------------------------------------------------- the CSV

/// A quote-aware CSV parser (RFC 4180 subset: quoted fields, "" escape), as imports.mjs `parseCsv` reads it: a
/// row whose cells are all empty is dropped.
pub fn parse_csv(text: String) -> List(List(String)) {
  let points =
    string.to_utf_codepoints(text) |> list.map(string.utf_codepoint_to_int)
  csv_loop(points, False, [], [], [])
}

fn csv_loop(
  points: List(Int),
  quoted: Bool,
  field: List(Int),
  row: List(String),
  rows: List(List(String)),
) -> List(List(String)) {
  case quoted, points {
    _, [] -> {
      let row = [text_of(field), ..row]
      list.reverse(keep_row(row, rows))
    }
    True, [34, 34, ..rest] -> csv_loop(rest, True, [34, ..field], row, rows)
    True, [34, ..rest] -> csv_loop(rest, False, field, row, rows)
    True, [c, ..rest] -> csv_loop(rest, True, [c, ..field], row, rows)
    False, [34, ..rest] -> csv_loop(rest, True, field, row, rows)
    False, [44, ..rest] ->
      csv_loop(rest, False, [], [text_of(field), ..row], rows)
    False, [13, 10, ..rest] | False, [13, ..rest] | False, [10, ..rest] ->
      csv_loop(rest, False, [], [], keep_row([text_of(field), ..row], rows))
    False, [c, ..rest] -> csv_loop(rest, False, [c, ..field], row, rows)
  }
}

fn text_of(field: List(Int)) -> String {
  list.reverse(field)
  |> list.filter_map(string.utf_codepoint)
  |> string.from_utf_codepoints
}

fn keep_row(row: List(String), rows: List(List(String))) -> List(List(String)) {
  case list.any(row, fn(c) { c != "" }) {
    True -> [list.reverse(row), ..rows]
    False -> rows
  }
}

// ------------------------------------------------------------------------------------------------- validation

type Checked {
  Checked(
    row: Int,
    record: Record,
    errors: List(String),
    disposition: rows_row.Disposition,
    match: Option(id.PlayerId),
  )
}

/// The column each field is read from: a mapping entry names it, else a column named like the field. A later
/// column for the same field wins, and a mapping to null falls back to the column's own name, as JavaScript's
/// `mapping?.[h] ?? …` reads it.
fn columns_for(
  header: List(String),
  mapping: List(#(String, Option(Field))),
) -> dict.Dict(Field, Int) {
  list.index_fold(header, dict.new(), fn(acc, h, i) {
    let field = case list.key_find(mapping, h) {
      Ok(Some(f)) -> Some(f)
      _ -> column_row.field_from_string(h) |> option.from_result
    }
    case field {
      Some(f) -> dict.insert(acc, f, i)
      None -> acc
    }
  })
}

fn record_errors(rec: Record, now: Int) -> List(String) {
  let name = case get(rec, column_row.Name) {
    "" -> ["name is required"]
    _ -> []
  }
  let identity = case
    get(rec, column_row.Provider),
    get(rec, column_row.Externalid)
  {
    "", _ | _, "" -> [
      "provider and externalId are required — identity is never name-only",
    ]
    _, _ -> []
  }
  let dob = case get(rec, column_row.Dob) {
    "" -> []
    dob ->
      case age.dob_problem(dob, now) {
        Error("wrong shape") -> ["dob must be YYYY-MM-DD"]
        Error(why) -> ["dob out of range (" <> why <> ")"]
        Ok(Nil) ->
          case string.compare(dob, "1940-01-01") {
            order.Lt -> ["dob out of range"]
            _ -> []
          }
      }
  }
  let position_error = case get(rec, column_row.Position) {
    "" -> []
    p ->
      case position.from_string(p) {
        Ok(_) -> []
        Error(Nil) -> [
          "position must be one of "
          <> string.join(list.map(position.pairs, fn(x) { x.0 }), "/"),
        ]
      }
  }
  let height = case get(rec, column_row.Heightcm) {
    "" -> []
    h ->
      case all_digits(h), int.parse(h) {
        True, Ok(n) if n >= 100 && n <= 230 -> []
        _, _ -> ["heightCm must be 100–230"]
      }
  }
  list.flatten([name, identity, dob, position_error, height])
}

fn all_digits(s: String) -> Bool {
  s != ""
  && list.all(string.to_graphemes(s), fn(g) { string.contains("0123456789", g) })
}

/// Every data row's record, errors and disposition. Rows are numbered as the CSV's lines: 2 is the first after
/// the header.
fn validate(
  read: Read,
  org: Org,
  columns: dict.Dict(Field, Int),
  data: List(List(String)),
  now: Int,
) -> Result(List(Checked), Fail(e)) {
  let #(checked, _) =
    list.index_map(data, fn(cells, i) { #(cells, i) })
    |> list.fold(#(Ok([]), set.new()), fn(acc, pair) {
      let #(so_far, seen) = acc
      case so_far {
        Error(e) -> #(Error(e), seen)
        Ok(done) -> {
          let #(cells, i) = pair
          let #(rec, cut) = record_of(cells, columns)
          let errors = list.append(cut, record_errors(rec, now))
          case
            classify(read, org, rec, errors, seen, now)
            |> result.map(fn(r) {
              #(Checked(i + 2, rec, errors, r.0, r.1), r.2)
            })
          {
            Error(e) -> #(Error(e), seen)
            Ok(#(c, seen)) -> #(Ok([c, ..done]), seen)
          }
        }
      }
    })
  result.map(checked, list.reverse)
}

/// The row's mapped fields, each trimmed and cut to its limit, and an error for each that was cut.
fn record_of(
  cells: List(String),
  columns: dict.Dict(Field, Int),
) -> #(Record, List(String)) {
  let #(rec, errors) =
    list.fold(fields(), #([], []), fn(acc, f) {
      case dict.get(columns, f) {
        Error(Nil) -> acc
        Ok(i) -> {
          let cell =
            list.drop(cells, i)
            |> list.first
            |> result.unwrap("")
            |> string.trim
          let limit = field_limit(f)
          case input.utf16_length(cell) > limit {
            True -> #([#(f, input.utf16_take(cell, limit)), ..acc.0], [
              field_name(f)
                <> " exceeds "
                <> int.to_string(limit)
                <> " characters",
              ..acc.1
            ])
            False -> #([#(f, cell), ..acc.0], acc.1)
          }
        }
      }
    })
  #(list.reverse(rec), list.reverse(errors))
}

fn classify(
  read: Read,
  org: Org,
  rec: Record,
  errors: List(String),
  seen: set.Set(#(String, String)),
  now: Int,
) -> Result(
  #(rows_row.Disposition, Option(id.PlayerId), set.Set(#(String, String))),
  Fail(e),
) {
  let provider = get(rec, column_row.Provider)
  let external = get(rec, column_row.Externalid)
  let key = #(provider, external)
  case errors, set.contains(seen, key) {
    [_, ..], _ -> Ok(#(rows_row.DispositionError, None, seen))
    [], True -> Ok(#(rows_row.DuplicateInFile, None, seen))
    [], False -> {
      let seen = set.insert(seen, key)
      use taken <- result.try(live_key_taken(read, org.id, provider, external))
      use linked <- result.try(player_by_external_id(read, provider, external))
      case taken, linked, get(rec, column_row.Dob) {
        True, _, _ -> Ok(#(rows_row.AlreadyImported, None, seen))
        False, Some(p), _ -> Ok(#(rows_row.LinkedPlayerExists, Some(p), seen))
        False, None, "" -> Ok(#(rows_row.Create, None, seen))
        False, None, dob -> {
          use candidate <- result.try(player_by_name_and_dob(
            read,
            get(rec, column_row.Name),
            dob,
          ))
          use visible <- result.map(case candidate {
            None -> Ok(False)
            Some(p) -> org_can_see(read, org, p, now)
          })
          case candidate, visible {
            Some(p), True -> #(rows_row.AmbiguousIdentity, Some(p), seen)
            _, _ -> #(rows_row.Create, None, seen)
          }
        }
      }
    }
  }
}

fn org_can_see(
  read: Read,
  org: Org,
  player: id.PlayerId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  use found <- result.map(players.for_org(read, player, org, now))
  case found {
    Some(#(_, a)) -> a.visible && !a.blocked
    None -> False
  }
}

/// The first player (creation order) linked to this external id; a deleted account's is no one's.
fn player_by_external_id(
  read: Read,
  provider: String,
  external_id: String,
) -> Result(Option(id.PlayerId), Fail(e)) {
  use found <- result.map(
    store.one(
      read,
      "SELECT e.player_id, p.deleted_at IS NULL FROM player_external_ids e JOIN players p ON p.id = e.player_id WHERE e.provider = ? AND e.external_id = ? ORDER BY p.rowid LIMIT 1",
      [sqlight.text(provider), sqlight.text(external_id)],
      {
        use pid <- decode.field(0, id.player_decoder())
        use live <- decode.field(1, sqlight.decode_bool())
        decode.success(#(pid, live))
      },
    ),
  )
  case found {
    Ok(#(pid, True)) -> Some(pid)
    _ -> None
  }
}

/// The first live player (creation order) with this name, ignoring case, and date of birth.
fn player_by_name_and_dob(
  read: Read,
  name: String,
  dob: String,
) -> Result(Option(id.PlayerId), Fail(e)) {
  use found <- result.map(
    store.query(
      read,
      "SELECT id, name FROM players WHERE birth_date = ? AND deleted_at IS NULL ORDER BY rowid",
      [sqlight.text(dob)],
      {
        use pid <- decode.field(0, id.player_decoder())
        use n <- decode.field(1, decode.string)
        decode.success(#(pid, n))
      },
    ),
  )
  let key = string.lowercase(name)
  list.find(found, fn(p) { string.lowercase(p.1) == key })
  |> result.map(fn(p) { p.0 })
  |> option.from_result
}

fn live_key_taken(
  read: Read,
  org_id: id.OrgId,
  provider: String,
  external_id: String,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM prospects WHERE org_id = ? AND provider = ? AND external_id = ? AND reversed_at IS NULL",
    [id.org_sql(org_id), sqlight.text(provider), sqlight.text(external_id)],
    decode.at([0], decode.int),
  )
  |> result.map(result.is_ok)
}

// ------------------------------------------------------------------------------------------------- reading batches

/// A batch with everything it holds.
type Batch {
  Batch(
    row: batch_row.Row,
    columns: List(column_row.Row),
    rows: List(#(rows_row.Row, List(String))),
    created: List(id.ProspectId),
    history: List(history_row.Row),
  )
}

fn load(
  read: Read,
  batch_id: id.ImportBatchId,
) -> Result(Option(Batch), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT " <> batch_row.columns <> " FROM import_batches WHERE id = ?",
    [id.import_batch_sql(batch_id)],
    batch_row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(b) -> {
      let arg = [id.import_batch_sql(batch_id)]
      use columns <- result.try(store.query(
        read,
        "SELECT "
          <> column_row.columns
          <> " FROM import_batch_columns WHERE batch_id = ? ORDER BY ord",
        arg,
        column_row.decoder(),
      ))
      use rows <- result.try(store.query(
        read,
        "SELECT "
          <> rows_row.columns
          <> " FROM import_batch_rows WHERE batch_id = ? ORDER BY row_no",
        arg,
        rows_row.decoder(),
      ))
      use errors <- result.try(store.query(
        read,
        "SELECT "
          <> error_row.columns
          <> " FROM import_batch_row_errors WHERE batch_id = ? ORDER BY row_no, ord",
        arg,
        error_row.decoder(),
      ))
      use created <- result.try(store.query(
        read,
        "SELECT prospect_id FROM import_batch_created_prospects WHERE batch_id = ? ORDER BY ord",
        arg,
        decode.at([0], id.prospect_decoder()),
      ))
      use history <- result.map(store.query(
        read,
        "SELECT "
          <> history_row.columns
          <> " FROM import_batch_history WHERE batch_id = ? ORDER BY at, rowid",
        arg,
        history_row.decoder(),
      ))
      let errors_of = list.group(errors, fn(e) { e.row_no })
      let rows =
        list.map(rows, fn(r) {
          #(
            r,
            dict.get(errors_of, r.row_no)
              |> result.unwrap([])
              |> list.reverse
              |> list.map(fn(e) { e.message }),
          )
        })
      Some(Batch(row: b, columns:, rows:, created:, history:))
    }
  }
}

/// The batch when it is `org`'s.
fn load_for_org(
  read: Read,
  org_id: id.OrgId,
  batch_id: String,
) -> Result(Option(Batch), Fail(e)) {
  use found <- result.map(load(read, id.import_batch(batch_id)))
  case found {
    Some(b) if b.row.org_id == org_id -> Some(b)
    _ -> None
  }
}

/// A batch in a list: no rows, their count instead, and how many prospects its commit created.
type Listed {
  Listed(
    row: batch_row.Row,
    columns: List(column_row.Row),
    row_count: Int,
    created: Int,
    rowid: Int,
  )
}

fn listed(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Listed), Fail(e)) {
  use found <- result.try(
    store.query(
      read,
      "SELECT "
        <> batch_row.qualified("b")
        <> ", b.rowid, (SELECT COUNT(*) FROM import_batch_rows r WHERE r.batch_id = b.id), (SELECT COUNT(*) FROM import_batch_created_prospects c WHERE c.batch_id = b.id) FROM import_batches b "
        <> where,
      args,
      {
        use b <- decode.then(batch_row.decoder())
        use rowid <- decode.field(batch_row.width, decode.int)
        use row_count <- decode.field(batch_row.width + 1, decode.int)
        use created <- decode.field(batch_row.width + 2, decode.int)
        decode.success(#(b, rowid, row_count, created))
      },
    ),
  )
  use columns <- result.map(store.query(
    read,
    "SELECT "
      <> column_row.columns
      <> " FROM import_batch_columns WHERE batch_id IN (SELECT value FROM json_each(?)) ORDER BY batch_id, ord",
    [
      json.array(found, fn(f) {
        let #(b, _, _, _) = f
        id.import_batch_json(b.id)
      })
      |> json.to_string
      |> sqlight.text,
    ],
    column_row.decoder(),
  ))
  let columns_of = list.group(columns, fn(c) { c.batch_id })
  list.map(found, fn(f) {
    let #(b, rowid, row_count, created) = f
    Listed(
      row: b,
      columns: dict.get(columns_of, b.id) |> result.unwrap([]) |> list.reverse,
      row_count:,
      created:,
      rowid:,
    )
  })
}

// ------------------------------------------------------------------------------------------------- views

fn summary_json(b: batch_row.Row) -> Json {
  json.object([
    #("total", json.int(b.summary_total)),
    #("creatable", json.int(b.summary_creatable)),
    #("errors", json.int(b.summary_errors)),
    #("duplicatesInFile", json.int(b.summary_duplicates_in_file)),
    #("alreadyImported", json.int(b.summary_already_imported)),
    #("linkedExisting", json.int(b.summary_linked_existing)),
    #("ambiguous", json.int(b.summary_ambiguous)),
  ])
}

fn core_fields(
  b: batch_row.Row,
  columns: List(column_row.Row),
) -> List(#(String, Json)) {
  [
    #("id", id.import_batch_json(b.id)),
    #("orgId", id.org_json(b.org_id)),
    #("kind", batch_row.kind_to_json(b.kind)),
    #("createdBy", id.org_user_json(b.created_by_user_id)),
    #("createdByName", json.nullable(b.created_by_name, json.string)),
    #("createdAt", json.int(b.created_at)),
    #("status", batch_row.status_to_json(b.status)),
    #("summary", summary_json(b)),
    #("committedAt", json.nullable(b.committed_at, json.int)),
    #("reversedAt", json.nullable(b.reversed_at, json.int)),
    #("header", json.array(columns, fn(c) { json.string(c.header) })),
    #("mapping", case b.mapped {
      False -> json.null()
      True -> mapping_json(columns)
    }),
  ]
}

/// A column name maps to the field its last column names, in the place its first column holds (JavaScript's
/// `Object.fromEntries`).
fn mapping_json(columns: List(column_row.Row)) -> Json {
  list.fold(columns, [], fn(acc, c) {
    case c.field {
      None -> acc
      Some(f) ->
        case list.key_find(acc, c.header) {
          Ok(_) -> list.key_set(acc, c.header, f)
          Error(Nil) -> list.append(acc, [#(c.header, f)])
        }
    }
  })
  |> list.map(fn(p) { #(p.0, column_row.field_to_json(p.1)) })
  |> json.object
}

/// Which of a batch's rows a view shows.
type RowsShown {
  AllRows
  FirstRows(Int)
  NoRows
}

fn batch_json(b: Batch, shown: RowsShown) -> Json {
  let rows = case shown {
    AllRows -> [#("rows", json.array(b.rows, row_json))]
    FirstRows(n) -> [#("rows", json.array(list.take(b.rows, n), row_json))]
    NoRows -> []
  }
  json.object(
    list.flatten([
      core_fields(b.row, b.columns),
      rows,
      [
        #("createdProspectIds", json.array(b.created, id.prospect_json)),
        #("history", json.array(b.history, history_json(b.row, _))),
      ],
    ]),
  )
}

fn listed_json(l: Listed) -> Json {
  json.object(
    list.append(core_fields(l.row, l.columns), [
      #("rowCount", json.int(l.row_count)),
      #("created", json.int(l.created)),
    ]),
  )
}

fn record_from_row(r: rows_row.Row) -> Record {
  record_from_columns([
    r.record_name,
    r.record_dob,
    r.record_position,
    r.record_foot,
    r.record_height_cm,
    r.record_provider,
    r.record_external_id,
    r.record_notes,
  ])
}

/// The record columns in field order; NULL is a field the CSV did not map.
fn record_from_columns(values: List(Option(String))) -> Record {
  list.zip(fields(), values)
  |> list.filter_map(fn(p) {
    case p.1 {
      Some(v) -> Ok(#(p.0, v))
      None -> Error(Nil)
    }
  })
}

fn record_json(rec: Record) -> Json {
  json.object(list.map(rec, fn(p) { #(field_name(p.0), json.string(p.1)) }))
}

fn row_json(pair: #(rows_row.Row, List(String))) -> Json {
  let #(r, errors) = pair
  json.object([
    #("row", json.int(r.row_no)),
    #("record", record_json(record_from_row(r))),
    #("errors", json.array(errors, json.string)),
    #("disposition", rows_row.disposition_to_json(r.disposition)),
    #("matchPlayerId", json.nullable(r.match_player_id, id.player_json)),
  ])
}

fn history_json(b: batch_row.Row, h: history_row.Row) -> Json {
  let detail = case h.action {
    history_row.Validated -> summary_json(b)
    history_row.Committed ->
      json.object([#("created", json.nullable(h.created_count, json.int))])
    history_row.Reversed ->
      json.object([
        #("removed", json.nullable(h.removed_count, json.int)),
        #("kept", json.nullable(h.kept_count, json.int)),
      ])
  }
  json.object([
    #("id", id.import_event_json(h.id)),
    #("at", json.int(h.at)),
    #("byKind", history_row.by_kind_to_json(h.by_kind)),
    #("byId", id.org_user_json(h.by_user_id)),
    #("byName", json.nullable(h.by_name, json.string)),
    #("action", history_row.action_to_json(h.action)),
    #("detail", detail),
  ])
}

pub fn prospect_json(p: prospect_row.Row) -> Json {
  json.object([
    #("id", id.prospect_json(p.id)),
    #("orgId", id.org_json(p.org_id)),
    #("batchId", id.import_batch_json(p.batch_id)),
    #("name", json.string(p.name)),
    #("dob", json.nullable(p.dob, json.string)),
    #("position", json.nullable(p.position, position.to_json)),
    #("foot", json.nullable(p.foot, json.string)),
    #("heightCm", json.nullable(p.height_cm, json.int)),
    #("provider", json.string(p.provider)),
    #("externalId", json.string(p.external_id)),
    #("notes", json.nullable(p.notes, json.string)),
    #("minor", json.nullable(p.minor, json.bool)),
    #("createdAt", json.int(p.created_at)),
    #("reversedAt", json.nullable(p.reversed_at, json.int)),
  ])
}

fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn batch_not_found() -> Response {
  http.error(404, "BATCH_NOT_FOUND")
}

// ------------------------------------------------------------------------------------------------- routes

/// `GET /org/imports/template`.
pub fn template() -> Response {
  wisp.response(200)
  |> wisp.set_header("content-type", "text/csv; charset=utf-8")
  |> wisp.string_body(
    string.join(list.map(fields(), field_name), ",")
    <> "\nJordan Example,2004-03-12,ST,right,181,statsprovider,SP-1001,left-sided forward\n",
  )
}

type Upload {
  Upload(csv: Option(String), mapping: Option(List(#(String, Option(Field)))))
}

/// `POST /org/imports`: the dry run. Only the batch record is written.
pub fn validate_upload(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let shape = {
    use csv <- input.field("csv", input.nullish(input.text(1_000_000_000)))
    use mapping <- input.field(
      "mapping",
      input.nullish(input.record(
        input.text(1_000_000_000),
        null_or(input.one_of(column_row.field_pairs)),
      )),
    )
    input.done(Upload(csv:, mapping:))
  }
  use body <- http.body(req, shape, [])
  let rows = parse_csv(option.unwrap(body.csv, ""))
  let mapping = option.unwrap(body.mapping, [])
  case rows {
    [] | [_] ->
      http.error_message(
        400,
        "CSV_EMPTY",
        "Need a header row plus at least one data row.",
      )
    [header, ..data] -> {
      case
        list.length(rows) > max_rows + 1,
        list.length(header) > max_columns
        || list.any(header, fn(h) { input.utf16_length(h) > max_header }),
        list.find(mapping, fn(m) { !list.contains(header, m.0) })
      {
        True, _, _ ->
          http.error_message(
            400,
            "CSV_TOO_LARGE",
            "Max " <> int.to_string(max_rows) <> " rows per batch.",
          )
        _, True, _ ->
          field_invalid(
            "csv",
            "The header row holds at most "
              <> int.to_string(max_columns)
              <> " column names of at most "
              <> int.to_string(max_header)
              <> " characters each.",
          )
        _, _, Ok(#(col, _)) ->
          field_invalid(
            "mapping",
            "mapping names a column the CSV does not have ("
              <> input.utf16_take(col, 40)
              <> ").",
          )
        False, False, Error(Nil) -> {
          let columns = columns_for(header, mapping)
          let missing =
            [column_row.Name, column_row.Provider, column_row.Externalid]
            |> list.filter(fn(f) { !dict.has_key(columns, f) })
          case missing {
            [_, ..] ->
              http.json(
                400,
                json.object([
                  #("error", json.string("COLUMNS_MISSING")),
                  #(
                    "message",
                    json.string(
                      "Map these required columns: "
                      <> string.join(list.map(missing, field_name), ", "),
                    ),
                  ),
                  #(
                    "missingCols",
                    json.array(missing, column_row.field_to_json),
                  ),
                ]),
              )
            [] -> dry_run(ctx, a, header, body.mapping, columns, data)
          }
        }
      }
    }
  }
}

/// A mapping's value: a field, or null to leave the column out.
fn null_or(check: input.Check(a)) -> input.Check(Option(a)) {
  fn(v) {
    case decode.run(v, decode.optional(decode.dynamic)) {
      Ok(None) -> Ok(None)
      _ -> check(v) |> result.map(Some)
    }
  }
}

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

fn dry_run(
  ctx: Ctx,
  a: OrgAccess,
  header: List(String),
  mapping: Option(List(#(String, Option(Field)))),
  columns: dict.Dict(Field, Int),
  data: List(List(String)),
) -> Response {
  let now = clock.now_ms()
  let checked =
    store.read(ctx.store, fn(read) { validate(read, a.org, columns, data, now) })
  case checked {
    Error(e) -> http.internal(e)
    Ok(checked) ->
      store.unit(ctx.store, fn(tx) {
        use batch_id <- result.try(id.next_import_batch(tx))
        let count = fn(d) {
          list.count(checked, fn(c: Checked) { c.disposition == d })
        }
        let b =
          batch_row.Row(
            ..batch_row.new(
              id: batch_id,
              org_id: a.org.id,
              kind: batch_row.Prospects,
              created_by_user_id: a.user.id,
              created_at: now,
              mapped: option.is_some(mapping),
              status: batch_row.Validated,
              summary_total: list.length(checked),
              summary_creatable: count(rows_row.Create),
              summary_errors: count(rows_row.DispositionError),
              summary_duplicates_in_file: count(rows_row.DuplicateInFile),
              summary_already_imported: count(rows_row.AlreadyImported),
              summary_linked_existing: count(rows_row.LinkedPlayerExists),
              summary_ambiguous: count(rows_row.AmbiguousIdentity),
            ),
            created_by_name: Some(a.user.name),
          )
        use _ <- result.try(batch_row.insert(tx, b))
        let given = option.unwrap(mapping, [])
        use _ <- result.try(
          list.index_map(header, fn(h, ord) { #(h, ord) })
          |> list.try_each(fn(p) {
            let field = case list.key_find(given, p.0) {
              Ok(Some(f)) -> Some(f)
              _ -> None
            }
            column_row.insert(
              tx,
              column_row.Row(batch_id:, ord: p.1, header: p.0, field:),
            )
          }),
        )
        use _ <- result.try(
          list.try_each(checked, fn(c) { insert_row(tx, batch_id, c) }),
        )
        use event_id <- result.try(id.next_import_event(tx))
        use _ <- result.try(history_row.insert(
          tx,
          history_row.Row(
            ..history_row.new(
              id: event_id,
              batch_id:,
              at: now,
              by_kind: history_row.OrgUser,
              by_user_id: a.user.id,
              action: history_row.Validated,
            ),
            by_name: Some(a.user.name),
          ),
        ))
        use loaded <- result.map(load(store.reading(tx), batch_id))
        let assert Some(batch) = loaded as "the batch was just written"
        http.json(
          201,
          json.object([
            #("batch", batch_json(batch, FirstRows(200))),
            #("dryRun", json.bool(True)),
            #(
              "note",
              json.string(
                "Nothing imported yet — review the report, then POST /imports/:id/commit with {confirm:true}.",
              ),
            ),
          ]),
        )
      })
      |> answer
  }
}

fn insert_row(
  tx: Tx,
  batch_id: id.ImportBatchId,
  c: Checked,
) -> Result(Nil, Fail(e)) {
  let value = fn(f) { list.key_find(c.record, f) |> option.from_result }
  use _ <- result.try(rows_row.insert(
    tx,
    rows_row.Row(
      batch_id:,
      row_no: c.row,
      record_name: value(column_row.Name),
      record_dob: value(column_row.Dob),
      record_position: value(column_row.Position),
      record_foot: value(column_row.Foot),
      record_height_cm: value(column_row.Heightcm),
      record_provider: value(column_row.Provider),
      record_external_id: value(column_row.Externalid),
      record_notes: value(column_row.Notes),
      disposition: c.disposition,
      match_player_id: c.match,
    ),
  ))
  list.index_map(c.errors, fn(m, ord) { #(m, ord) })
  |> list.try_each(fn(p) {
    error_row.insert(
      tx,
      error_row.Row(batch_id:, row_no: c.row, ord: p.1, message: p.0),
    )
  })
}

/// `GET /org/imports`: the organisation's batches, newest first, without their rows.
pub fn page(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [paging.IntKind])
  let after = case page.after {
    Some([paging.IntKey(n)]) -> Some(n)
    _ -> None
  }
  let found =
    store.read(ctx.store, fn(read) {
      listed(
        read,
        "WHERE b.org_id = ? AND (? IS NULL OR b.rowid < ?) ORDER BY b.rowid DESC LIMIT ?",
        [
          id.org_sql(a.org.id),
          sqlight.nullable(sqlight.int, after),
          sqlight.nullable(sqlight.int, after),
          sqlight.int(page.limit + 1),
        ],
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(l) { [paging.IntKey(l.rowid)] })
      pages.respond(items, next, listed_json)
    }
  }
}

/// `GET /admin/imports`: the newest batches of every organisation.
pub fn admin_recent(ctx: Ctx) -> Response {
  case
    store.read(ctx.store, fn(read) {
      listed(read, "ORDER BY b.rowid DESC LIMIT ?", [sqlight.int(50)])
    })
  {
    Error(e) -> http.internal(e)
    Ok(rows) ->
      http.json(200, json.object([#("items", json.array(rows, listed_json))]))
  }
}

/// `GET /org/imports/:id`.
pub fn show(ctx: Ctx, a: OrgAccess, batch_id: String) -> Response {
  case
    store.read(ctx.store, fn(read) { load_for_org(read, a.org.id, batch_id) })
  {
    Error(e) -> http.internal(e)
    Ok(None) -> batch_not_found()
    Ok(Some(b)) ->
      http.json(200, json.object([#("batch", batch_json(b, AllRows))]))
  }
}

fn identity_taken(provider: String, external_id: String) -> Response {
  http.error_message(
    409,
    "ALREADY_IMPORTED",
    provider
      <> " "
      <> external_id
      <> " is already one of your live prospects. Validate the file again for a fresh report.",
  )
}

/// `POST /org/imports/:id/commit`: the prospects, the identity reviews, the status and the history entry, at once.
pub fn commit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  batch_id: String,
) -> Response {
  use <- access.require_lead(a)
  case
    store.read(ctx.store, fn(read) { load_for_org(read, a.org.id, batch_id) })
  {
    Error(e) -> http.internal(e)
    Ok(None) -> batch_not_found()
    Ok(Some(b)) -> {
      let shape = {
        use confirm <- input.field("confirm", input.nullish(input.boolean()))
        input.done(confirm)
      }
      use confirm <- http.body(req, shape, [#("confirm", "CONFIRM_REQUIRED")])
      case confirm, b.row.status {
        Some(True), batch_row.Committed ->
          http.json(
            200,
            json.object([
              #("batch", batch_json(b, AllRows)),
              #("note", json.string("Already committed (idempotent).")),
            ]),
          )
        Some(True), batch_row.Validated -> commit_validated(ctx, a, b.row.id)
        Some(True), status ->
          http.json(
            409,
            json.object([
              #("error", json.string("BATCH_NOT_COMMITTABLE")),
              #("status", batch_row.status_to_json(status)),
            ]),
          )
        _, _ ->
          http.error_message(
            400,
            "CONFIRM_REQUIRED",
            "Committing writes records — send {confirm:true} after reviewing the dry run.",
          )
      }
    }
  }
}

fn commit_validated(
  ctx: Ctx,
  a: OrgAccess,
  batch_id: id.ImportBatchId,
) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(load(read, batch_id))
    let assert Some(b) = found as "a batch is never deleted"
    use <- stale_unless(
      b.row.status == batch_row.Validated,
      "the batch's status",
    )
    let creatable =
      list.filter(b.rows, fn(r) { { r.0 }.disposition == rows_row.Create })
    use _ <- result.try(
      list.index_map(creatable, fn(r, ord) { #(r.0, ord) })
      |> list.try_each(fn(p) {
        use prospect <- result.try(insert_prospect(
          tx,
          a.org.id,
          batch_id,
          record_from_row(p.0),
          now,
        ))
        created_row.insert(
          tx,
          created_row.Row(batch_id:, ord: p.1, prospect_id: prospect.id),
        )
      }),
    )
    use _ <- result.try(
      b.rows
      |> list.filter(fn(r) { { r.0 }.disposition == rows_row.AmbiguousIdentity })
      |> list.try_each(fn(r) {
        let row = r.0
        use review_id <- result.try(id.next_identity_review(tx))
        let assert Some(candidate) = row.match_player_id
          as "an ambiguous row names its player"
        review_row.insert(
          tx,
          review_row.new(
            id: review_id,
            org_id: a.org.id,
            batch_id:,
            row_no: row.row_no,
            candidate_player_id: candidate,
            status: review_row.Open,
            created_at: now,
          ),
        )
      }),
    )
    use _ <- result.try(
      store.run(
        tx,
        "UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ?",
        [sqlight.int(now), id.import_batch_sql(batch_id)],
      ),
    )
    use _ <- result.try(append_history(
      tx,
      batch_id,
      a,
      now,
      history_row.Committed,
      Some(list.length(creatable)),
      None,
    ))
    use _ <- result.try(webhooks.emit_import_committed(
      tx,
      a.org.id,
      id.import_batch_to_string(batch_id),
      list.length(creatable),
      now,
    ))
    use loaded <- result.map(load(read, batch_id))
    let assert Some(committed) = loaded as "the batch was just written"
    http.json(
      200,
      json.object([
        #("batch", batch_json(committed, NoRows)),
        #("created", json.int(list.length(creatable))),
        #("reviewsQueued", json.int(committed.row.summary_ambiguous)),
      ]),
    )
  })
  |> answer
}

fn stale_unless(
  holds: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case holds {
    True -> next()
    False -> store.stale(what)
  }
}

fn append_history(
  tx: Tx,
  batch_id: id.ImportBatchId,
  a: OrgAccess,
  at: Int,
  action: history_row.Action,
  created: Option(Int),
  removed: Option(Int),
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_import_event(tx))
  history_row.insert(
    tx,
    history_row.Row(
      ..history_row.new(
        id: event_id,
        batch_id:,
        at:,
        by_kind: history_row.OrgUser,
        by_user_id: a.user.id,
        action:,
      ),
      by_name: Some(a.user.name),
      created_count: created,
      removed_count: removed,
      kept_count: option.map(removed, fn(_) { 0 }),
    ),
  )
}

/// A prospect from a row's record. An empty optional cell is absent. `minor` is a conservative flag for the UI
/// (born fewer than 19 calendar years ago), not a gate.
fn insert_prospect(
  tx: Tx,
  org_id: id.OrgId,
  batch_id: id.ImportBatchId,
  rec: Record,
  now: Int,
) -> Result(prospect_row.Row, Fail(Response)) {
  let provider = get(rec, column_row.Provider)
  let external_id = get(rec, column_row.Externalid)
  use taken <- result.try(live_key_taken(
    store.reading(tx),
    org_id,
    provider,
    external_id,
  ))
  case taken {
    True -> store.refuse(identity_taken(provider, external_id))
    False -> {
      use prospect_id <- result.try(id.next_prospect(tx))
      let optional = fn(f) {
        case get(rec, f) {
          "" -> None
          v -> Some(v)
        }
      }
      let dob = optional(column_row.Dob)
      let p =
        prospect_row.Row(
          ..prospect_row.new(
            id: prospect_id,
            org_id:,
            batch_id:,
            name: get(rec, column_row.Name),
            provider:,
            external_id:,
            created_at: now,
          ),
          dob:,
          position: optional(column_row.Position)
            |> option.then(fn(p) {
              position.from_string(p) |> option.from_result
            }),
          foot: optional(column_row.Foot),
          height_cm: optional(column_row.Heightcm)
            |> option.then(fn(h) { int.parse(h) |> option.from_result }),
          notes: optional(column_row.Notes),
          minor: option.map(dob, fn(d) {
            let born = string.slice(d, 0, 4) |> int.parse |> result.unwrap(0)
            { age.day_of(now) }.year - born < 19
          }),
        )
      use _ <- result.map(prospect_row.insert(tx, p))
      p
    }
  }
}

/// `POST /org/imports/:id/reverse`: the batch's own prospects that are still live are reversed.
pub fn reverse(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  batch_id: String,
) -> Response {
  use <- access.require_lead(a)
  case
    store.read(ctx.store, fn(read) { load_for_org(read, a.org.id, batch_id) })
  {
    Error(e) -> http.internal(e)
    Ok(None) -> batch_not_found()
    Ok(Some(b)) if b.row.status != batch_row.Committed ->
      http.error(409, "NOT_COMMITTED")
    Ok(Some(b)) -> {
      use _ <- http.body(req, input.nothing(), [])
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use status <- result.try(store.one(
          store.reading(tx),
          "SELECT status FROM import_batches WHERE id = ?",
          [id.import_batch_sql(b.row.id)],
          decode.at([0], batch_row.status_decoder()),
        ))
        use <- stale_unless(
          status == Ok(batch_row.Committed),
          "the batch's status",
        )
        use removed <- result.try(store.write(
          tx,
          "UPDATE prospects SET reversed_at = ? WHERE reversed_at IS NULL AND id IN (SELECT prospect_id FROM import_batch_created_prospects WHERE batch_id = ?) RETURNING id",
          [sqlight.int(now), id.import_batch_sql(b.row.id)],
          decode.at([0], decode.string),
        ))
        use _ <- result.try(
          store.run(
            tx,
            "UPDATE import_batches SET status = 'reversed', reversed_at = ? WHERE id = ?",
            [sqlight.int(now), id.import_batch_sql(b.row.id)],
          ),
        )
        use _ <- result.map(append_history(
          tx,
          b.row.id,
          a,
          now,
          history_row.Reversed,
          None,
          Some(list.length(removed)),
        ))
        http.json(
          200,
          json.object([
            #("removed", json.int(list.length(removed))),
            #("kept", json.array([], json.string)),
            #("note", json.string("All records from this batch were reversed.")),
          ]),
        )
      })
      |> answer
    }
  }
}

/// Whether the organisation has committed an import or holds a prospect: onboarding's first task.
pub fn has_imported(read: Read, org_id: id.OrgId) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT EXISTS (SELECT 1 FROM import_batches WHERE org_id = ? AND status = 'committed') OR EXISTS (SELECT 1 FROM prospects WHERE org_id = ?)",
    [id.org_sql(org_id), id.org_sql(org_id)],
    decode.at([0], sqlight.decode_bool()),
  )
  |> result.map(result.unwrap(_, False))
}

/// Every batch's history, oldest batch first (the audit export): `[{ id, history }]`.
pub fn histories_json(read: Read, org_id: id.OrgId) -> Result(Json, Fail(e)) {
  use batches <- result.try(store.query(
    read,
    "SELECT "
      <> batch_row.columns
      <> " FROM import_batches WHERE org_id = ? ORDER BY rowid",
    [id.org_sql(org_id)],
    batch_row.decoder(),
  ))
  use history <- result.map(store.query(
    read,
    "SELECT "
      <> history_row.qualified("h")
      <> " FROM import_batch_history h JOIN import_batches b ON b.id = h.batch_id WHERE b.org_id = ? ORDER BY h.at, h.rowid",
    [id.org_sql(org_id)],
    history_row.decoder(),
  ))
  json.array(batches, fn(b) {
    json.object([
      #("id", id.import_batch_json(b.id)),
      #(
        "history",
        json.array(list.filter(history, fn(h) { h.batch_id == b.id }), fn(h) {
          history_json(b, h)
        }),
      ),
    ])
  })
}

// ------------------------------------------------------------------------------------------------- prospects

/// `GET /org/prospects`: the organisation's live prospects, newest first.
pub fn prospects(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [paging.IntKind])
  let after = case page.after {
    Some([paging.IntKey(n)]) -> Some(n)
    _ -> None
  }
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> prospect_row.columns
          <> ", rowid FROM prospects WHERE org_id = ? AND reversed_at IS NULL AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
        [
          id.org_sql(a.org.id),
          sqlight.nullable(sqlight.int, after),
          sqlight.nullable(sqlight.int, after),
          sqlight.int(page.limit + 1),
        ],
        {
          use p <- decode.then(prospect_row.decoder())
          use rowid <- decode.field(prospect_row.width, decode.int)
          decode.success(#(p, rowid))
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.1)] })
      pages.respond(items, next, fn(r) { prospect_json(r.0) })
    }
  }
}

/// Every live prospect of the organisation, oldest first: the versioned export.
pub fn live_prospects(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(prospect_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> prospect_row.columns
      <> " FROM prospects WHERE org_id = ? AND reversed_at IS NULL ORDER BY rowid",
    [id.org_sql(org_id)],
    prospect_row.decoder(),
  )
}

// ------------------------------------------------------------------------------------------------- identity reviews

/// A review, with its batch row's record (never a copy).
type Review {
  Review(row: review_row.Row, record: Record)
}

fn reviews(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Review), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> review_row.qualified("r")
      <> ", b.record_name, b.record_dob, b.record_position, b.record_foot, b.record_height_cm, b.record_provider, b.record_external_id, b.record_notes FROM identity_reviews r LEFT JOIN import_batch_rows b ON b.batch_id = r.batch_id AND b.row_no = r.row_no "
      <> where,
    args,
    {
      use r <- decode.then(review_row.decoder())
      use values <- decode.then(
        list.repeat(Nil, 8)
        |> list.index_map(fn(_, i) {
          decode.at([review_row.width + i], decode.optional(decode.string))
        })
        |> all_of,
      )
      decode.success(Review(row: r, record: record_from_columns(values)))
    },
  )
}

fn all_of(decoders: List(decode.Decoder(a))) -> decode.Decoder(List(a)) {
  case decoders {
    [] -> decode.success([])
    [d, ..rest] -> {
      use first <- decode.then(d)
      use others <- decode.then(all_of(rest))
      decode.success([first, ..others])
    }
  }
}

fn review_json(r: Review) -> Json {
  let row = r.row
  json.object([
    #("id", id.identity_review_json(row.id)),
    #("orgId", id.org_json(row.org_id)),
    #("batchId", id.import_batch_json(row.batch_id)),
    #("row", json.int(row.row_no)),
    #("record", record_json(r.record)),
    #("candidatePlayerId", id.player_json(row.candidate_player_id)),
    #("status", review_row.status_to_json(row.status)),
    #("resolvedBy", json.nullable(row.resolved_by_name, json.string)),
    #("resolvedAt", json.nullable(row.resolved_at, json.int)),
    #(
      "resolution",
      json.nullable(row.resolution, review_row.resolution_to_json),
    ),
    #("createdAt", json.int(row.created_at)),
  ])
}

/// `GET /org/identity-reviews`: the open reviews.
pub fn open_reviews(ctx: Ctx, a: OrgAccess) -> Response {
  case
    store.read(ctx.store, fn(read) {
      reviews(
        read,
        "WHERE r.org_id = ? AND r.status = 'open' ORDER BY r.rowid",
        [
          id.org_sql(a.org.id),
        ],
      )
    })
  {
    Error(e) -> http.internal(e)
    Ok(items) ->
      http.json(200, json.object([#("items", json.array(items, review_json))]))
  }
}

fn review_by_id(
  read: Read,
  review_id: id.IdentityReviewId,
) -> Result(Option(Review), Fail(e)) {
  reviews(read, "WHERE r.id = ?", [id.identity_review_sql(review_id)])
  |> result.map(fn(rs) { list.first(rs) |> option.from_result })
}

type Action {
  Link
  Separate
}

/// `POST /org/identity-reviews/:id/resolve`: a lead links the external identity to the player, or keeps the
/// record as a prospect of its own.
pub fn resolve(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  review_id: String,
) -> Response {
  use <- access.require_lead(a)
  let review_id = id.identity_review(review_id)
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use found <- result.map(review_by_id(read, review_id))
      case found {
        Some(r) if r.row.org_id == a.org.id -> Some(r)
        _ -> None
      }
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "REVIEW_NOT_FOUND")
    Ok(Some(r)) if r.row.status != review_row.Open ->
      http.error(409, "ALREADY_RESOLVED")
    Ok(Some(r)) -> {
      let shape = {
        use action <- input.field(
          "action",
          input.nullish(
            input.one_of([#("link", Link), #("separate", Separate)]),
          ),
        )
        input.done(action)
      }
      use action <- http.body(req, shape, [#("action", "BAD_ACTION")])
      case action {
        Some(Link) -> link(ctx, a, r, now)
        Some(Separate) -> separate(ctx, a, r, now)
        None ->
          http.error_message(
            400,
            "BAD_ACTION",
            "action must be \"link\" or \"separate\".",
          )
      }
    }
  }
}

fn link(ctx: Ctx, a: OrgAccess, r: Review, now: Int) -> Response {
  let player_id = r.row.candidate_player_id
  case
    store.read(ctx.store, fn(read) { org_can_see(read, a.org, player_id, now) })
  {
    Error(e) -> http.internal(e)
    Ok(False) ->
      http.error_message(
        403,
        "NOT_VISIBLE",
        "You can only link identities on players currently visible to your organisation.",
      )
    Ok(True) ->
      store.unit(ctx.store, fn(tx) {
        let provider = get(r.record, column_row.Provider)
        let external_id = get(r.record, column_row.Externalid)
        use known <- result.try(store.one(
          store.reading(tx),
          "SELECT 1 FROM player_external_ids WHERE player_id = ? AND provider = ? AND external_id = ?",
          [
            id.player_sql(player_id),
            sqlight.text(provider),
            sqlight.text(external_id),
          ],
          decode.at([0], decode.int),
        ))
        use _ <- result.try(case known {
          Ok(_) -> Ok(Nil)
          Error(Nil) ->
            players.add_external_id(
              tx,
              player_id,
              provider:,
              external_id:,
              source: "import:" <> id.import_batch_to_string(r.row.batch_id),
              by_name: a.user.name,
              at: now,
              review_id: id.identity_review_to_string(r.row.id),
            )
        })
        resolve_review(tx, a, r, review_row.Linked, delivery_row.Linked, now)
      })
      |> answer
  }
}

fn separate(ctx: Ctx, a: OrgAccess, r: Review, now: Int) -> Response {
  let provider = get(r.record, column_row.Provider)
  let external_id = get(r.record, column_row.Externalid)
  case
    store.read(ctx.store, fn(read) {
      live_key_taken(read, a.org.id, provider, external_id)
    })
  {
    Error(e) -> http.internal(e)
    Ok(True) ->
      http.error_message(
        409,
        "ALREADY_IMPORTED",
        provider
          <> " "
          <> external_id
          <> " is already one of your live prospects.",
      )
    Ok(False) ->
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(insert_prospect(
          tx,
          a.org.id,
          r.row.batch_id,
          r.record,
          now,
        ))
        resolve_review(
          tx,
          a,
          r,
          review_row.KeptSeparate,
          delivery_row.KeptSeparate,
          now,
        )
      })
      |> answer
  }
}

fn resolve_review(
  tx: Tx,
  a: OrgAccess,
  r: Review,
  resolution: review_row.Resolution,
  announced: delivery_row.Resolution,
  now: Int,
) -> Result(Response, Fail(Response)) {
  use changed <- result.try(store.write(
    tx,
    "UPDATE identity_reviews SET status = 'resolved', resolution = ?, resolved_by_name = ?, resolved_at = ? WHERE id = ? AND status = 'open' RETURNING id",
    [
      sqlight.text(review_row.resolution_to_string(resolution)),
      sqlight.text(a.user.name),
      sqlight.int(now),
      id.identity_review_sql(r.row.id),
    ],
    decode.at([0], decode.string),
  ))
  use <- stale_unless(changed != [], "the review's status")
  use _ <- result.try(webhooks.emit_identity_resolved(
    tx,
    a.org.id,
    id.identity_review_to_string(r.row.id),
    announced,
    now,
  ))
  use found <- result.map(review_by_id(store.reading(tx), r.row.id))
  let assert Some(resolved) = found as "the review was just written"
  http.json(200, json.object([#("review", review_json(resolved))]))
}
