//// Guardians (`guardians`, `guardian_children`). A guardian's `childIds` are their link rows, in order; their
//// `coGuardians` are worked out from the guardians whose `co_guardian_of` names them. Neither is stored on the
//// guardian's row. The password and e-mail code hashes are never in a view.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/identity/players
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/guardian_children as link_row
import scoutbox/rows/guardians as row
import scoutbox/rows/id
import scoutbox/rows/idv_queue as idv_row
import sqlight

pub type CoGuardian {
  CoGuardian(id: id.GuardianId, name: String, email: String)
}

pub type Guardian {
  Guardian(
    row: row.Row,
    child_ids: List(id.PlayerId),
    co_guardians: List(CoGuardian),
  )
}

pub type GuardianError {
  EmailInUse
}

fn select(where: String) -> String {
  "SELECT " <> row.columns <> " FROM guardians " <> where
}

fn complete(read: Read, r: row.Row) -> Result(Guardian, Fail(e)) {
  use child_ids <- result.try(store.query(
    read,
    "SELECT player_id FROM guardian_children WHERE guardian_id = ? ORDER BY rowid",
    [id.guardian_sql(r.id)],
    decode.at([0], id.player_decoder()),
  ))
  use co_guardians <- result.map(
    store.query(
      read,
      "SELECT id, name, email FROM guardians WHERE co_guardian_of = ? ORDER BY rowid",
      [id.guardian_sql(r.id)],
      {
        use id <- decode.field(0, id.guardian_decoder())
        use name <- decode.field(1, decode.string)
        use email <- decode.field(2, decode.string)
        decode.success(CoGuardian(id:, name:, email:))
      },
    ),
  )
  Guardian(row: r, child_ids:, co_guardians:)
}

fn first(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(Option(Guardian), Fail(e)) {
  use found <- result.try(store.one(read, select(where), args, row.decoder()))
  case found {
    Ok(r) -> complete(read, r) |> result.map(Some)
    Error(Nil) -> Ok(None)
  }
}

pub fn by_id(
  read: Read,
  id: id.GuardianId,
) -> Result(Option(Guardian), Fail(e)) {
  first(read, "WHERE id = ?", [id.guardian_sql(id)])
}

/// By e-mail, compared case-insensitively (the table's unique index is on `lower(email)`).
pub fn by_email(
  read: Read,
  email: String,
) -> Result(Option(Guardian), Fail(e)) {
  first(read, "WHERE lower(email) = lower(?)", [sqlight.text(email)])
}

pub fn count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM guardians",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// Oldest first, keyed by rowid.
pub fn page(
  read: Read,
  page: Page,
) -> Result(#(List(Guardian), Option(String)), Fail(e)) {
  let after = case page.after {
    Some([IntKey(rid)]) -> rid
    _ -> 0
  }
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> ", rowid FROM guardians WHERE rowid > ? ORDER BY rowid LIMIT ?",
      [sqlight.int(after), sqlight.int(page.limit + 1)],
      {
        use r <- decode.then(row.decoder())
        use rid <- decode.field(row.width, decode.int)
        decode.success(#(rid, r))
      },
    ),
  )
  let #(items, next) = paging.page_of(rows, page.limit, fn(p) { [IntKey(p.0)] })
  use guardians <- result.map(
    list.try_map(items, fn(p) { complete(read, p.1) }),
  )
  #(guardians, next)
}

/// Creates a co-guardian of `primary`, linked to each of the primary's children in the same unit (`co` links).
/// Refuses an e-mail any guardian already has, compared case-insensitively.
pub fn create_co_guardian(
  tx: Tx,
  id id: id.GuardianId,
  primary primary: Guardian,
  name name: String,
  email email: String,
  at at: Int,
) -> Result(Guardian, Fail(GuardianError)) {
  use taken <- result.try(by_email(store.reading(tx), email))
  case taken {
    Some(_) -> store.refuse(EmailInUse)
    None -> {
      use _ <- result.try(row.insert(
        tx,
        row.Row(
          ..row.new(id:, name:, email:),
          co_guardian_of: Some(primary.row.id),
          created_at: Some(at),
        ),
      ))
      use _ <- result.try(
        list.try_each(primary.child_ids, fn(child) {
          link_row.insert(
            tx,
            link_row.Row(guardian_id: id, player_id: child, role: link_row.Co),
          )
        }),
      )
      use found <- result.map(by_id(store.reading(tx), id))
      let assert Some(g) = found as "a guardian reads back once inserted"
      g
    }
  }
}

/// The guardian's own record (SELF_GUARDIAN_FIELDS).
pub fn self_view(g: Guardian) -> Json {
  let r = g.row
  json.object([
    #("id", id.guardian_json(r.id)),
    #("name", json.string(r.name)),
    #("email", json.string(r.email)),
    #("emailVerified", json.bool(r.email_verified)),
    #("idVerified", json.bool(r.id_verified)),
    #("idvReference", json.nullable(r.idv_reference, json.string)),
    #("disclaimerAccepted", json.bool(r.disclaimer_accepted)),
    #("disclaimerAcceptedAt", json.nullable(r.disclaimer_accepted_at, json.int)),
    #("coGuardianOf", json.nullable(r.co_guardian_of, id.guardian_json)),
    #("notificationPrefs", prefs(r)),
    #("createdAt", json.nullable(r.created_at, json.int)),
    #("childIds", json.array(g.child_ids, id.player_json)),
    #("coGuardians", co_guardians_json(g)),
  ])
}

/// What Trust & Safety sees (ADMIN_GUARDIAN_FIELDS): never a hash.
pub fn admin_view(g: Guardian) -> Json {
  let r = g.row
  json.object([
    #("id", id.guardian_json(r.id)),
    #("name", json.string(r.name)),
    #("email", json.string(r.email)),
    #("emailVerified", json.bool(r.email_verified)),
    #("idVerified", json.bool(r.id_verified)),
    #("idvReference", json.nullable(r.idv_reference, json.string)),
    #("disclaimerAccepted", json.bool(r.disclaimer_accepted)),
    #("childIds", json.array(g.child_ids, id.player_json)),
    #("coGuardianOf", json.nullable(r.co_guardian_of, id.guardian_json)),
    #("coGuardians", co_guardians_json(g)),
    #("notificationPrefs", prefs(r)),
    #("createdAt", json.nullable(r.created_at, json.int)),
  ])
}

fn prefs(r: row.Row) -> Json {
  players.prefs_json(
    r.prefs_quiet_start,
    r.prefs_quiet_end,
    r.prefs_school_hours_mute,
    r.prefs_timezone,
  )
}

fn co_guardians_json(g: Guardian) -> Json {
  json.array(g.co_guardians, fn(c) {
    json.object([
      #("id", id.guardian_json(c.id)),
      #("name", json.string(c.name)),
      #("email", json.string(c.email)),
    ])
  })
}

/// Trust & Safety's decision on a guardian's ID check, recorded on their first queue entry.
pub fn review_id_check(
  tx: Tx,
  id: id.GuardianId,
  approved: Bool,
) -> Result(Guardian, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "UPDATE guardians SET id_verified = ? WHERE id = ?", [
      sqlight.bool(approved),
      id.guardian_sql(id),
    ]),
  )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE idv_queue SET status = ? WHERE seq = (SELECT MIN(seq) FROM idv_queue WHERE guardian_id = ?)",
      [
        sqlight.text(case approved {
          True -> "approved"
          False -> "revoked"
        }),
        id.guardian_sql(id),
      ],
    ),
  )
  use found <- result.map(by_id(store.reading(tx), id))
  let assert Some(g) = found as "a reviewed guardian exists"
  g
}

/// Every ID check, in the order they happened.
pub fn idv_queue(read: Read) -> Result(List(idv_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> idv_row.columns <> " FROM idv_queue ORDER BY seq",
    [],
    idv_row.decoder(),
  )
}

pub fn idv_view(q: idv_row.Row) -> Json {
  json.object([
    #("id", id.idv_case_json(q.id)),
    #("guardianId", id.guardian_json(q.guardian_id)),
    #("guardianName", json.nullable(q.guardian_name, json.string)),
    #("documentType", json.string(q.document_type)),
    #("documentRef", json.string(q.document_ref_last4)),
    #("provider", json.string(q.provider)),
    #("reference", json.string(q.reference)),
    #("ts", json.int(q.created_at)),
    #("status", idv_row.status_to_json(q.status)),
  ])
}
