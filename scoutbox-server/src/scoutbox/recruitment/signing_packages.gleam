//// Signing packages as repositories/signingsFollowUps.ts keeps them: `signing_packages` and its ordered child rows
//// (revisions with their documents and required parties, the history, and the per-act keys in the shared
//// `idempotency_keys` table, owner `signing_packages`).
////
//// A write replaces a whole stored row from its typed value: an act edits the record it read and saves it, so a
//// value a column cannot hold never reaches the file.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/signing_rules.{type Package, Package, Revision}
import scoutbox/rows/id
import scoutbox/rows/idempotency_keys as key_row
import scoutbox/rows/signing_documents as doc_row
import scoutbox/rows/signing_history as event_row
import scoutbox/rows/signing_packages as pkg_row
import scoutbox/rows/signing_revision_parties as party_row
import scoutbox/rows/signing_revisions as rev_row
import scoutbox/vocab/recruitment_actor_kind.{type RecruitmentActorKind}
import scoutbox/vocab/signing_party_type
import sqlight

// ---------------------------------------------------------------------------------------------------- reads

fn children(
  read: Read,
  table: String,
  columns: String,
  where: String,
  args: List(sqlight.Value),
  order: String,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> where
      <> " ORDER BY "
      <> order,
    args,
    decoder,
  )
}

fn assemble(read: Read, row: pkg_row.Row) -> Result(Package, Fail(e)) {
  let pid = id.signing_package_sql(row.id)
  use revisions <- result.try(children(
    read,
    rev_row.table,
    rev_row.columns,
    "package_id = ?",
    [pid],
    "position",
    rev_row.decoder(),
  ))
  use revisions <- result.try(
    list.try_map(revisions, fn(r) {
      let rid = id.signing_revision_sql(r.id)
      use docs <- result.try(children(
        read,
        doc_row.table,
        doc_row.columns,
        "revision_id = ?",
        [rid],
        "rowid",
        doc_row.decoder(),
      ))
      use parties <- result.map(children(
        read,
        party_row.table,
        party_row.columns,
        "revision_id = ?",
        [rid],
        "position",
        party_row.decoder(),
      ))
      let of = fn(kind) {
        list.find(docs, fn(d) { d.kind == kind }) |> option.from_result
      }
      Revision(r, of(doc_row.Signing), of(doc_row.Executed), parties)
    }),
  )
  use history <- result.try(children(
    read,
    event_row.table,
    event_row.columns,
    "package_id = ?",
    [pid],
    "position",
    event_row.decoder(),
  ))
  use keys <- result.map(children(
    read,
    key_row.table,
    key_row.columns,
    "owner_table = 'signing_packages' AND owner_id = ?",
    [pid],
    "position",
    key_row.decoder(),
  ))
  Package(row:, revisions:, history:, keys:)
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Package), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> pkg_row.columns
      <> " FROM signing_packages WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    pkg_row.decoder(),
  ))
  list.try_map(rows, assemble(read, _))
}

pub fn by_id(
  read: Read,
  package_id: String,
) -> Result(Option(Package), Fail(e)) {
  use found <- result.map(select(read, "id = ?", [sqlight.text(package_id)]))
  list.first(found) |> option.from_result
}

pub fn for_offer(
  read: Read,
  offer_id: id.OfferId,
) -> Result(List(Package), Fail(e)) {
  select(read, "offer_id = ?", [id.offer_sql(offer_id)])
}

pub fn for_case(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(List(Package), Fail(e)) {
  select(read, "case_id = ?", [id.recruitment_case_sql(case_id)])
}

pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Package), Fail(e)) {
  select(read, "player_id = ?", [id.player_sql(player_id)])
}

pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Package), Fail(e)) {
  select(read, "org_id = ? AND player_id = ?", [
    id.org_sql(org_id),
    id.player_sql(player_id),
  ])
}

/// Inside a unit: the package as it now stands.
pub fn reread(
  tx: Tx,
  package_id: id.SigningPackageId,
) -> Result(Package, Fail(e)) {
  use found <- result.try(by_id(
    store.reading(tx),
    id.signing_package_to_string(package_id),
  ))
  case found {
    Some(p) -> Ok(p)
    None -> store.stale("the signing package is gone")
  }
}

/// Inside a unit: the package is still at the rev the route read it at, or the act lost a race. Every act on a
/// package moves its rev.
pub fn unchanged(tx: Tx, p: Package) -> Result(Nil, Fail(e)) {
  use found <- result.try(store.one(
    store.reading(tx),
    "SELECT rev FROM signing_packages WHERE id = ?",
    [id.signing_package_sql(p.row.id)],
    decode.at([0], decode.int),
  ))
  case found {
    Ok(rev) if rev == p.row.rev -> Ok(Nil)
    _ ->
      store.stale(
        "the signing package moved from rev " <> int.to_string(p.row.rev),
      )
  }
}

// ---------------------------------------------------------------------------------------------------- writes

/// Rewrites the row of `table` whose `key` columns hold `key_values`, every column from `values` (`columns`
/// order). Exactly one row must match.
fn replace(
  tx: Tx,
  table: String,
  columns: String,
  values: List(sqlight.Value),
  key: List(String),
  key_values: List(sqlight.Value),
) -> Result(Nil, Fail(e)) {
  let set =
    string.split(columns, ", ")
    |> list.map(fn(c) { c <> " = ?" })
    |> string.join(", ")
  let where = list.map(key, fn(c) { c <> " = ?" }) |> string.join(" AND ")
  use changed <- result.try(store.write(
    tx,
    "UPDATE " <> table <> " SET " <> set <> " WHERE " <> where <> " RETURNING 1",
    list.append(values, key_values),
    decode.success(Nil),
  ))
  case changed {
    [_] -> Ok(Nil)
    _ -> store.stale("a signing row an act rewrites is gone: " <> table)
  }
}

pub fn save(tx: Tx, row: pkg_row.Row) -> Result(Nil, Fail(e)) {
  replace(tx, pkg_row.table, pkg_row.columns, pkg_row.values(row), ["id"], [
    id.signing_package_sql(row.id),
  ])
}

pub fn save_revision(tx: Tx, row: rev_row.Row) -> Result(Nil, Fail(e)) {
  replace(tx, rev_row.table, rev_row.columns, rev_row.values(row), ["id"], [
    id.signing_revision_sql(row.id),
  ])
}

pub fn save_party(tx: Tx, row: party_row.Row) -> Result(Nil, Fail(e)) {
  replace(
    tx,
    party_row.table,
    party_row.columns,
    party_row.values(row),
    ["revision_id", "party_type"],
    [
      id.signing_revision_sql(row.revision_id),
      sqlight.text(signing_party_type.to_string(row.party_type)),
    ],
  )
}

/// A new package with its first revision and that revision's required parties.
pub fn insert(
  tx: Tx,
  row: pkg_row.Row,
  first: rev_row.Row,
  parties: List(party_row.Row),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(pkg_row.insert(tx, row))
  add_revision(tx, first, parties)
}

/// A revision with its required parties.
pub fn add_revision(
  tx: Tx,
  rev: rev_row.Row,
  parties: List(party_row.Row),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(rev_row.insert(tx, rev))
  list.try_each(parties, party_row.insert(tx, _))
}

/// The revision's document of its kind (one each).
pub fn add_document(tx: Tx, row: doc_row.Row) -> Result(Nil, Fail(e)) {
  doc_row.insert(tx, row)
}

fn next_position(
  tx: Tx,
  table: String,
  where: String,
  args: List(sqlight.Value),
) -> Result(Int, Fail(e)) {
  store.query(
    store.reading(tx),
    "SELECT COALESCE(MAX(position) + 1, 0) FROM " <> table <> " WHERE " <> where,
    args,
    decode.at([0], decode.int),
  )
  |> result.map(fn(rows) { list.first(rows) |> result.unwrap(0) })
}

/// Who an entry or a write names.
pub type By {
  By(kind: RecruitmentActorKind, id: Option(String), name: Option(String))
}

/// Appends a history entry.
pub fn add_history(
  tx: Tx,
  package_id: id.SigningPackageId,
  action: String,
  by: By,
  detail: List(#(String, Json)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event <- result.try(id.next_signing_event(tx))
  use position <- result.try(
    next_position(tx, event_row.table, "package_id = ?", [
      id.signing_package_sql(package_id),
    ]),
  )
  event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(id: event, package_id:, position:, at:, action:),
      by_kind: Some(by.kind),
      by_id: by.id,
      by_name: by.name,
      detail_json: Some(json.to_string(json.object(detail))),
    ),
  )
}

/// Records an act's idempotency key: `start` holds one value, every other act a list. `extra` are the entry's
/// fields after the key and fingerprint (`revisionId`, `actorId`, `signingId`), then `at`.
pub fn add_key(
  tx: Tx,
  package_id: id.SigningPackageId,
  act: String,
  key: String,
  fp: String,
  extra: List(#(String, Json)),
  at: Option(Int),
) -> Result(Nil, Fail(e)) {
  let owner = id.signing_package_to_string(package_id)
  use position <- result.try(
    next_position(
      tx,
      key_row.table,
      "owner_table = 'signing_packages' AND owner_id = ?",
      [sqlight.text(owner)],
    ),
  )
  let entry =
    json.object(
      list.flatten([
        [#("key", json.string(key)), #("fp", json.string(fp))],
        extra,
        case at {
          Some(at) -> [#("at", json.int(at))]
          None -> []
        },
      ]),
    )
  key_row.insert(
    tx,
    key_row.Row(
      ..key_row.new(
        owner_table: key_row.SigningPackages,
        owner_id: owner,
        position:,
        act:,
        shape: case act {
          "start" -> key_row.Value
          _ -> key_row.List
        },
        entry_json: json.to_string(entry),
      ),
      key: Some(key),
      fp: Some(fp),
      at:,
    ),
  )
}

/// bumpRev's rule: the rev moves on by one, with who and when.
pub fn touch(
  row: pkg_row.Row,
  at: Int,
  by: Option(#(String, Option(String))),
) -> pkg_row.Row {
  pkg_row.Row(
    ..row,
    rev: row.rev + 1,
    rev_at: Some(at),
    rev_by_user_id: option.map(by, fn(b) { b.0 }),
    rev_by_name: option.then(by, fn(b) { b.1 }),
    updated_at: at,
  )
}

/// A player's erasure: their names are nulled on the packages, the records kept.
pub fn redact_player(
  tx: Tx,
  player_id: id.PlayerId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let pid = id.player_sql(player_id)
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE signing_packages SET subject_removed_at = ? WHERE player_id = ?",
      [sqlight.int(at), pid],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE signing_revision_parties SET completed_by_name = NULL WHERE completed_by_kind = 'player' AND revision_id IN (SELECT r.id FROM signing_revisions r JOIN signing_packages p ON p.id = r.package_id WHERE p.player_id = ?)",
      [pid],
    ),
  )
  store.run(
    tx,
    "UPDATE signing_history SET by_name = NULL WHERE by_kind = 'player' AND package_id IN (SELECT id FROM signing_packages WHERE player_id = ?)",
    [pid],
  )
}
