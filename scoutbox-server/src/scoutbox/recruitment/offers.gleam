//// Recruitment Offers as repositories/recruitmentContactsOffers.ts keeps them: `recruitment_offers` and its
//// ordered child rows (revisions and their documents, responses, read receipts, history, per-act keys).
////
//// An Offer is created whole, then changes only through named acts, each guarded by the revision status it may
//// move from: a row anywhere else means a route's gate let through a move it should have refused, so the unit
//// stops. An act's bookkeeping (`Bookkeeping`) is written with it.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/offer_rules.{type Offer, Offer, Revision}
import scoutbox/rows/id
import scoutbox/rows/offer_history as event_row
import scoutbox/rows/offer_keys as key_row
import scoutbox/rows/offer_read_receipts as receipt_row
import scoutbox/rows/offer_responses as response_row
import scoutbox/rows/offer_revision_documents as document_row
import scoutbox/rows/offer_revisions as revision_row
import scoutbox/rows/recruitment_offers as offer_row
import scoutbox/vocab/offer_status.{type OfferStatus}
import scoutbox/vocab/party
import scoutbox/vocab/recruitment_actor_kind
import sqlight

// ---------------------------------------------------------------------------------------------------- reads

fn children(
  read: Read,
  table: String,
  columns: String,
  owner: String,
  owner_id: sqlight.Value,
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
      <> owner
      <> " = ? ORDER BY "
      <> order,
    [owner_id],
    decoder,
  )
}

fn assemble(read: Read, row: offer_row.Row) -> Result(Offer, Fail(e)) {
  let oid = id.offer_sql(row.id)
  use revisions <- result.try(children(
    read,
    revision_row.table,
    revision_row.columns,
    "offer_id",
    oid,
    "position",
    revision_row.decoder(),
  ))
  use revisions <- result.try(
    list.try_map(revisions, fn(r) {
      use documents <- result.map(children(
        read,
        document_row.table,
        document_row.columns,
        "revision_id",
        id.offer_revision_sql(r.id),
        "position",
        document_row.decoder(),
      ))
      Revision(r, documents)
    }),
  )
  use responses <- result.try(children(
    read,
    response_row.table,
    response_row.columns,
    "offer_id",
    oid,
    "position",
    response_row.decoder(),
  ))
  use receipts <- result.try(children(
    read,
    receipt_row.table,
    receipt_row.columns,
    "offer_id",
    oid,
    "position",
    receipt_row.decoder(),
  ))
  use history <- result.try(children(
    read,
    event_row.table,
    event_row.columns,
    "offer_id",
    oid,
    "position",
    event_row.decoder(),
  ))
  use keys <- result.map(children(
    read,
    key_row.table,
    key_row.columns,
    "offer_id",
    oid,
    "act, position",
    key_row.decoder(),
  ))
  Offer(row:, revisions:, responses:, receipts:, history:, keys:)
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Offer), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> offer_row.columns
      <> " FROM recruitment_offers WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    offer_row.decoder(),
  ))
  list.try_map(rows, assemble(read, _))
}

pub fn by_id(read: Read, offer_id: String) -> Result(Option(Offer), Fail(e)) {
  use found <- result.map(select(read, "id = ?", [sqlight.text(offer_id)]))
  list.first(found) |> option.from_result
}

pub fn for_case(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(List(Offer), Fail(e)) {
  select(read, "case_id = ?", [id.recruitment_case_sql(case_id)])
}

pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Offer), Fail(e)) {
  select(read, "player_id = ?", [id.player_sql(player_id)])
}

/// The offers of several players (a guardian's children), in insertion order.
pub fn for_players(
  read: Read,
  players: List(id.PlayerId),
) -> Result(List(Offer), Fail(e)) {
  case players {
    [] -> Ok([])
    _ ->
      select(
        read,
        "player_id IN ("
          <> string.join(list.map(players, fn(_) { "?" }), ", ")
          <> ")",
        list.map(players, id.player_sql),
      )
  }
}

// --------------------------------------------------------------------------------------------------- writes

/// Who did something to an Offer: a club member (with their role), or the recipient.
pub type Actor {
  Staff(user_id: id.OrgUserId, name: String, role: Option(String))
  Recipient(kind: party.Party, id: String, name: Option(String))
}

/// One history entry: an action, who, and its detail.
pub type Entry {
  Entry(
    id: id.OfferEventId,
    at: Int,
    action: String,
    by: Actor,
    detail: Option(Json),
  )
}

pub fn entry(
  tx: Tx,
  action: String,
  by: Actor,
  detail: List(#(String, Json)),
  at: Int,
) -> Result(Entry, Fail(e)) {
  use event <- result.map(id.next_offer_event(tx))
  Entry(event, at, action, by, Some(json.object(detail)))
}

/// What the case's lifecycle did with an act's step, as it is stored on the Offer.
pub type Lifecycle {
  Lifecycle(
    applied: Bool,
    action: Option(String),
    from: Option(String),
    to: Option(String),
    at: Int,
    reason: Option(String),
    message: Option(String),
    allowed: Option(List(String)),
  )
}

/// The bookkeeping an act leaves on its record.
pub type Bookkeeping {
  Bookkeeping(
    at: Int,
    rev_by: Option(#(id.OrgUserId, String)),
    touch: Bool,
    bump: Bool,
    bump_revision: Option(id.OfferRevisionId),
    lifecycle: Option(Lifecycle),
    key: Option(#(key_row.Act, String, id.OfferRevisionId)),
    history: List(Entry),
  )
}

pub fn bookkeeping(at: Int) -> Bookkeeping {
  Bookkeeping(
    at:,
    rev_by: None,
    touch: False,
    bump: False,
    bump_revision: None,
    lifecycle: None,
    key: None,
    history: [],
  )
}

fn next_position(
  tx: Tx,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
  extra: List(#(String, sqlight.Value)),
) -> Result(Int, Fail(e)) {
  let where =
    list.map(extra, fn(e) { " AND " <> e.0 <> " = ?" }) |> string.concat
  store.query(
    store.reading(tx),
    "SELECT COALESCE(MAX(position) + 1, 0) FROM "
      <> table
      <> " WHERE "
      <> owner
      <> " = ?"
      <> where,
    [owner_id, ..list.map(extra, fn(e) { e.1 })],
    decode.at([0], decode.int),
  )
  |> result.map(fn(rows) { list.first(rows) |> result.unwrap(0) })
}

fn actor_parts(
  by: Actor,
) -> #(
  recruitment_actor_kind.RecruitmentActorKind,
  Option(String),
  Option(String),
) {
  case by {
    Staff(user, name, _) -> #(
      recruitment_actor_kind.Org,
      Some(id.org_user_to_string(user)),
      Some(name),
    )
    Recipient(party.Player, who, name) -> #(
      recruitment_actor_kind.Player,
      Some(who),
      name,
    )
    Recipient(party.Guardian, who, name) -> #(
      recruitment_actor_kind.Guardian,
      Some(who),
      name,
    )
  }
}

fn write_entry(tx: Tx, offer_id: id.OfferId, e: Entry) -> Result(Nil, Fail(e)) {
  use position <- result.try(
    next_position(tx, event_row.table, "offer_id", id.offer_sql(offer_id), []),
  )
  let #(kind, by_id, by_name) = actor_parts(e.by)
  event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: e.id,
        offer_id:,
        position:,
        at: e.at,
        action: e.action,
      ),
      by_kind: Some(kind),
      by_id:,
      by_name:,
      detail_json: option.map(e.detail, json.to_string),
    ),
  )
}

fn exactly_one(
  tx: Tx,
  sql: String,
  args: List(sqlight.Value),
  what: String,
) -> Result(Nil, Fail(e)) {
  use changed <- result.try(store.write(tx, sql, args, decode.success(Nil)))
  case changed {
    [_] -> Ok(Nil)
    _ -> store.stale("an Offer act's guard held: " <> what)
  }
}

/// Inside a unit: the Offer is still at the rev the route read it at, or the act lost a race. Every act on an
/// Offer moves its rev, so this is the one check that makes the route's earlier checks still true.
pub fn unchanged(tx: Tx, o: Offer) -> Result(Nil, Fail(e)) {
  use found <- result.try(store.one(
    store.reading(tx),
    "SELECT rev FROM recruitment_offers WHERE id = ?",
    [id.offer_sql(o.row.id)],
    decode.at([0], decode.int),
  ))
  case found {
    Ok(rev) if rev == o.row.rev -> Ok(Nil)
    _ -> store.stale("the Offer moved from rev " <> int.to_string(o.row.rev))
  }
}

/// Inside a unit: the case's Offers are still the ones the route read, each at the same rev, or the act lost a
/// race (a second draft created beside this one, say).
pub fn case_unchanged(
  tx: Tx,
  case_id: id.RecruitmentCaseId,
  seen: List(Offer),
) -> Result(Nil, Fail(e)) {
  use now <- result.try(
    store.query(
      store.reading(tx),
      "SELECT id, rev FROM recruitment_offers WHERE case_id = ? ORDER BY id",
      [id.recruitment_case_sql(case_id)],
      {
        use oid <- decode.field(0, decode.string)
        use rev <- decode.field(1, decode.int)
        decode.success(#(oid, rev))
      },
    ),
  )
  let then =
    seen
    |> list.map(fn(o) { #(id.offer_to_string(o.row.id), o.row.rev) })
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  case now == then {
    True -> Ok(Nil)
    False -> store.stale("the case's Offers changed")
  }
}

/// The act's bookkeeping: revisions, the touch, the lifecycle record, the key and the history.
pub fn record_act(
  tx: Tx,
  offer_id: id.OfferId,
  b: Bookkeeping,
) -> Result(Nil, Fail(e)) {
  let rev_args = [
    sqlight.int(b.at),
    sqlight.nullable(
      sqlight.text,
      option.map(b.rev_by, fn(r) { id.org_user_to_string(r.0) }),
    ),
    sqlight.nullable(sqlight.text, option.map(b.rev_by, fn(r) { r.1 })),
  ]
  use _ <- result.try(case b.bump_revision {
    Some(rid) ->
      store.run(
        tx,
        "UPDATE offer_revisions SET rev = rev + 1, rev_at = ?, rev_by_user_id = ?, rev_by_name = ? WHERE id = ? AND offer_id = ?",
        list.append(rev_args, [
          id.offer_revision_sql(rid),
          id.offer_sql(offer_id),
        ]),
      )
    None -> Ok(Nil)
  })
  use _ <- result.try(case b.bump {
    True ->
      store.run(
        tx,
        "UPDATE recruitment_offers SET rev = rev + 1, rev_at = ?, rev_by_user_id = ?, rev_by_name = ? WHERE id = ?",
        list.append(rev_args, [id.offer_sql(offer_id)]),
      )
    False -> Ok(Nil)
  })
  use _ <- result.try(case b.touch {
    True ->
      store.run(
        tx,
        "UPDATE recruitment_offers SET updated_at = ? WHERE id = ?",
        [
          sqlight.int(b.at),
          id.offer_sql(offer_id),
        ],
      )
    False -> Ok(Nil)
  })
  use _ <- result.try(case b.lifecycle {
    Some(l) ->
      store.run(
        tx,
        "UPDATE recruitment_offers SET lifecycle_applied = ?, lifecycle_action = ?, lifecycle_reason = ?, lifecycle_message = ?, lifecycle_allowed_json = ?, lifecycle_from = ?, lifecycle_to = ?, lifecycle_at = ? WHERE id = ?",
        [
          sqlight.bool(l.applied),
          sqlight.nullable(sqlight.text, l.action),
          sqlight.nullable(sqlight.text, l.reason),
          sqlight.nullable(sqlight.text, l.message),
          sqlight.nullable(
            sqlight.text,
            option.map(l.allowed, fn(a) {
              json.to_string(json.array(a, json.string))
            }),
          ),
          sqlight.nullable(sqlight.text, l.from),
          sqlight.nullable(sqlight.text, l.to),
          sqlight.int(l.at),
          id.offer_sql(offer_id),
        ],
      )
    None -> Ok(Nil)
  })
  use _ <- result.try(case b.key {
    Some(#(act, key, revision_id)) -> {
      use position <- result.try(
        next_position(tx, key_row.table, "offer_id", id.offer_sql(offer_id), [
          #("act", sqlight.text(key_row.act_to_string(act))),
        ]),
      )
      key_row.insert(
        tx,
        key_row.new(offer_id:, act:, position:, key:, revision_id:),
      )
    }
    None -> Ok(Nil)
  })
  list.try_each(b.history, write_entry(tx, offer_id, _))
}

/// A new revision's content.
pub type Content {
  Content(
    terms: offer_rules.Terms,
    recipient_message: Option(String),
    internal_note: Option(String),
    expires_at: Option(Int),
  )
}

/// A document resolved from the vault: what the revision keeps of it.
pub type Document {
  Document(
    evidence_id: id.EvidenceId,
    label: Option(String),
    mime: Option(String),
    bytes: Option(Int),
  )
}

fn set_terms(r: revision_row.Row, c: Content) -> revision_row.Row {
  revision_row.Row(
    ..r,
    term_role: c.terms.role,
    term_squad: c.terms.squad,
    term_start_date: c.terms.start_date,
    term_end_date: c.terms.end_date,
    term_conditions: c.terms.conditions,
    recipient_message: c.recipient_message,
    internal_note: c.internal_note,
    expires_at: c.expires_at,
  )
}

fn replace_documents(
  tx: Tx,
  revision_id: id.OfferRevisionId,
  documents: List(Document),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM offer_revision_documents WHERE revision_id = ?", [
      id.offer_revision_sql(revision_id),
    ]),
  )
  list.index_map(documents, fn(d, i) { #(d, i) })
  |> list.try_each(fn(p) {
    let #(d, position) = p
    use doc_id <- result.try(id.next_offer_document(tx))
    document_row.insert(
      tx,
      document_row.Row(
        ..document_row.new(
          id: doc_id,
          revision_id:,
          position:,
          evidence_id: d.evidence_id,
        ),
        label: d.label,
        mime: d.mime,
        bytes: d.bytes,
      ),
    )
  })
}

fn insert_revision(
  tx: Tx,
  offer_id: id.OfferId,
  revision_id: id.OfferRevisionId,
  number: Int,
  content: Content,
  documents: List(Document),
  by: #(id.OrgUserId, String, Option(String)),
  supersedes: Option(id.OfferRevisionId),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use position <- result.try(
    next_position(
      tx,
      revision_row.table,
      "offer_id",
      id.offer_sql(offer_id),
      [],
    ),
  )
  let r =
    revision_row.Row(
      ..revision_row.new(
        id: revision_id,
        offer_id:,
        position:,
        revision_number: number,
        status: offer_status.Draft,
        term_offer_type: revision_row.DirectRecruitment,
        created_at: at,
        updated_at: at,
        rev: 1,
      ),
      created_by_user_id: Some(by.0),
      created_by_name: Some(by.1),
      created_by_role: by.2,
      updated_by_user_id: Some(by.0),
      updated_by_name: Some(by.1),
      updated_by_role: by.2,
      rev_at: Some(at),
      supersedes_revision_id: supersedes,
    )
  use _ <- result.try(revision_row.insert(tx, set_terms(r, content)))
  replace_documents(tx, revision_id, documents)
}

pub type NewOffer {
  NewOffer(
    org_id: id.OrgId,
    case_id: id.RecruitmentCaseId,
    player_id: id.PlayerId,
    decision_id: Option(id.RoomDecisionId),
    transaction_id: Option(String),
    content: Content,
    documents: List(Document),
    by: #(id.OrgUserId, String, Option(String)),
    create_key: Option(#(String, String)),
    at: Int,
  )
}

/// A new Offer, whole: the club's first draft, with its history entry.
pub fn create(tx: Tx, n: NewOffer) -> Result(id.OfferId, Fail(e)) {
  use offer_id <- result.try(id.next_offer(tx))
  use revision_id <- result.try(id.next_offer_revision(tx))
  use _ <- result.try(offer_row.insert(
    tx,
    offer_row.Row(
      ..offer_row.new(
        id: offer_id,
        org_id: n.org_id,
        case_id: n.case_id,
        player_id: n.player_id,
        type_: offer_row.DirectRecruitment,
        status: offer_status.Draft,
        current_revision_id: revision_id,
        created_at: n.at,
        created_by_user_id: n.by.0,
        updated_at: n.at,
        rev: 1,
        policy_version: offer_rules.policy_version,
      ),
      decision_id: n.decision_id,
      transaction_id: n.transaction_id,
      create_key: option.map(n.create_key, fn(k) { k.0 }),
      create_fp: option.map(n.create_key, fn(k) { k.1 }),
      created_by_name: Some(n.by.1),
      created_by_role: n.by.2,
      rev_at: Some(n.at),
    ),
  ))
  use _ <- result.try(insert_revision(
    tx,
    offer_id,
    revision_id,
    1,
    n.content,
    n.documents,
    n.by,
    None,
    n.at,
  ))
  use e <- result.try(entry(
    tx,
    "offer_draft_created",
    Staff(n.by.0, n.by.1, n.by.2),
    [
      #("revisionId", id.offer_revision_json(revision_id)),
      #("revisionNumber", json.int(1)),
    ],
    n.at,
  ))
  use _ <- result.map(write_entry(tx, offer_id, e))
  offer_id
}

fn move_revision(
  tx: Tx,
  offer_id: id.OfferId,
  revision_id: id.OfferRevisionId,
  to: OfferStatus,
  sets: List(#(String, sqlight.Value)),
) -> Result(Nil, Fail(e)) {
  let from = offer_rules.leading_to(to)
  exactly_one(
    tx,
    "UPDATE offer_revisions SET status = ?"
      <> string.concat(list.map(sets, fn(s) { ", " <> s.0 <> " = ?" }))
      <> " WHERE id = ? AND offer_id = ? AND status IN ("
      <> string.join(list.map(from, fn(_) { "?" }), ", ")
      <> ") RETURNING id",
    list.flatten([
      [sqlight.text(offer_status.to_string(to))],
      list.map(sets, fn(s) { s.1 }),
      [id.offer_revision_sql(revision_id), id.offer_sql(offer_id)],
      list.map(from, fn(s) { sqlight.text(offer_status.to_string(s)) }),
    ]),
    "revision "
      <> id.offer_revision_to_string(revision_id)
      <> " to "
      <> offer_status.to_string(to),
  )
}

fn set_status(
  tx: Tx,
  offer_id: id.OfferId,
  to: OfferStatus,
) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE recruitment_offers SET status = ? WHERE id = ?", [
    sqlight.text(offer_status.to_string(to)),
    id.offer_sql(offer_id),
  ])
}

fn actor_columns(
  prefix: String,
  by: Option(#(id.OrgUserId, String, Option(String))),
) -> List(#(String, sqlight.Value)) {
  [
    #(
      prefix <> "_user_id",
      sqlight.nullable(id.org_user_sql, option.map(by, fn(b) { b.0 })),
    ),
    #(
      prefix <> "_name",
      sqlight.nullable(sqlight.text, option.map(by, fn(b) { b.1 })),
    ),
    #(
      prefix <> "_role",
      sqlight.nullable(sqlight.text, option.then(by, fn(b) { b.2 })),
    ),
  ]
}

fn term_columns(c: Content) -> List(#(String, sqlight.Value)) {
  let t = c.terms
  [
    #("term_role", sqlight.nullable(sqlight.text, t.role)),
    #("term_squad", sqlight.nullable(sqlight.text, t.squad)),
    #("term_start_date", sqlight.nullable(sqlight.text, t.start_date)),
    #("term_end_date", sqlight.nullable(sqlight.text, t.end_date)),
    #("term_conditions", sqlight.nullable(sqlight.text, t.conditions)),
  ]
}

/// Changes a DRAFT revision's content (`documents` None keeps them). There is no other write of a revision's
/// terms, so an issued revision is frozen by construction.
pub fn edit_draft(
  tx: Tx,
  offer_id: id.OfferId,
  revision_id: id.OfferRevisionId,
  content: Content,
  documents: Option(List(Document)),
  by: #(id.OrgUserId, String, Option(String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  let sets =
    list.flatten([
      term_columns(content),
      [
        #(
          "recipient_message",
          sqlight.nullable(sqlight.text, content.recipient_message),
        ),
        #(
          "internal_note",
          sqlight.nullable(sqlight.text, content.internal_note),
        ),
        #("expires_at", sqlight.nullable(sqlight.int, content.expires_at)),
        #("updated_at", sqlight.int(at)),
      ],
      actor_columns("updated_by", Some(by)),
    ])
  use _ <- result.try(exactly_one(
    tx,
    "UPDATE offer_revisions SET "
      <> string.join(list.map(sets, fn(s) { s.0 <> " = ?" }), ", ")
      <> " WHERE id = ? AND offer_id = ? AND status = 'DRAFT' RETURNING id",
    list.append(list.map(sets, fn(s) { s.1 }), [
      id.offer_revision_sql(revision_id),
      id.offer_sql(offer_id),
    ]),
    "a draft is edited",
  ))
  case documents {
    Some(docs) -> replace_documents(tx, revision_id, docs)
    None -> Ok(Nil)
  }
}

/// The recipient an issued revision is addressed to, as snapshotted at issue.
pub type RecipientSnapshot {
  RecipientSnapshot(
    kind: party.Party,
    player_id: id.PlayerId,
    guardian_id: Option(id.GuardianId),
    minor: Bool,
    at: Int,
  )
}

/// The workspace an issued revision cited, ready at the instant of issue.
pub type Readiness {
  Readiness(transaction_id: String, status: String, at: Int)
}

/// Issues a DRAFT revision with its final terms and the recipient it was issued to; it supersedes the issued
/// revision it names.
pub fn issue_revision(
  tx: Tx,
  offer_id: id.OfferId,
  revision_id: id.OfferRevisionId,
  terms: offer_rules.Terms,
  recipient: RecipientSnapshot,
  supersedes: Option(id.OfferRevisionId),
  readiness: Option(Readiness),
  by: #(id.OrgUserId, String, Option(String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(move_revision(
    tx,
    offer_id,
    revision_id,
    offer_status.Issued,
    list.flatten([
      term_columns(Content(terms, None, None, None)),
      [#("issued_at", sqlight.int(at))],
      actor_columns("issued_by", Some(by)),
      [
        #("recipient_type", sqlight.text(party.to_string(recipient.kind))),
        #("recipient_player_id", id.player_sql(recipient.player_id)),
        #(
          "recipient_guardian_id",
          sqlight.nullable(id.guardian_sql, recipient.guardian_id),
        ),
        #("recipient_minor", sqlight.bool(recipient.minor)),
        #("recipient_at", sqlight.int(recipient.at)),
      ],
      case readiness {
        Some(r) -> [
          #("readiness_transaction_id", sqlight.text(r.transaction_id)),
          #("readiness_evaluated_at", sqlight.int(r.at)),
          #("readiness_status", sqlight.text(r.status)),
          #("readiness_blockers_json", sqlight.text("[]")),
        ]
        None -> []
      },
    ]),
  ))
  use _ <- result.try(case supersedes {
    Some(prev) ->
      move_revision(tx, offer_id, prev, offer_status.Superseded, [
        #("superseded_by_revision_id", id.offer_revision_sql(revision_id)),
        #("superseded_at", sqlight.int(at)),
      ])
    None -> Ok(Nil)
  })
  set_status(tx, offer_id, offer_status.Issued)
}

pub fn withdraw_revision(
  tx: Tx,
  offer_id: id.OfferId,
  revision_id: id.OfferRevisionId,
  reason: Option(String),
  by: #(id.OrgUserId, String, Option(String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(move_revision(
    tx,
    offer_id,
    revision_id,
    offer_status.Withdrawn,
    list.flatten([
      [#("withdrawn_at", sqlight.int(at))],
      actor_columns("withdrawn_by", Some(by)),
      [#("withdraw_reason", sqlight.nullable(sqlight.text, reason))],
    ]),
  ))
  set_status(tx, offer_id, offer_status.Withdrawn)
}

/// A new DRAFT revision, which becomes the current one.
pub fn add_revision(
  tx: Tx,
  offer_id: id.OfferId,
  number: Int,
  content: Content,
  documents: List(Document),
  by: #(id.OrgUserId, String, Option(String)),
  supersedes: Option(id.OfferRevisionId),
  at: Int,
) -> Result(id.OfferRevisionId, Fail(e)) {
  use revision_id <- result.try(id.next_offer_revision(tx))
  use _ <- result.try(insert_revision(
    tx,
    offer_id,
    revision_id,
    number,
    content,
    documents,
    by,
    supersedes,
    at,
  ))
  use _ <- result.map(
    store.run(
      tx,
      "UPDATE recruitment_offers SET current_revision_id = ?, status = 'DRAFT' WHERE id = ?",
      [id.offer_revision_sql(revision_id), id.offer_sql(offer_id)],
    ),
  )
  revision_id
}

pub type Response {
  Response(
    revision_id: id.OfferRevisionId,
    accepted: Bool,
    kind: party.Party,
    actor_id: String,
    actor_name: Option(String),
    player_id: id.PlayerId,
    reason: Option(String),
    client_key: Option(String),
    at: Int,
  )
}

/// The recipient's answer to an ISSUED revision. A draft open beside it is discarded (recorded WITHDRAWN, naming
/// the answer), and the answered revision becomes the current one.
pub fn record_response(
  tx: Tx,
  offer_id: id.OfferId,
  r: Response,
  discard: Option(id.OfferRevisionId),
) -> Result(id.OfferResponseId, Fail(e)) {
  use response_id <- result.try(id.next_offer_response(tx))
  use position <- result.try(
    next_position(
      tx,
      response_row.table,
      "offer_id",
      id.offer_sql(offer_id),
      [],
    ),
  )
  use _ <- result.try(response_row.insert(
    tx,
    response_row.Row(
      ..response_row.new(
        id: response_id,
        offer_id:,
        position:,
        revision_id: r.revision_id,
        response_type: case r.accepted {
          True -> response_row.Accepted
          False -> response_row.Declined
        },
        actor_type: r.kind,
        actor_id: r.actor_id,
        for_player_id: r.player_id,
        occurred_at: r.at,
      ),
      actor_name: r.actor_name,
      reason: r.reason,
      client_key: r.client_key,
    ),
  ))
  let to = case r.accepted {
    True -> offer_status.Accepted
    False -> offer_status.Declined
  }
  use _ <- result.try(
    move_revision(tx, offer_id, r.revision_id, to, [
      #("responded_at", sqlight.int(r.at)),
      #("response_id", id.offer_response_sql(response_id)),
    ]),
  )
  use _ <- result.try(case discard {
    Some(draft) -> {
      use _ <- result.try(move_revision(
        tx,
        offer_id,
        draft,
        offer_status.Withdrawn,
        list.flatten([
          [#("withdrawn_at", sqlight.int(r.at))],
          actor_columns("withdrawn_by", None),
          [
            #("withdraw_reason", sqlight.null()),
            #("discarded_by_response_id", id.offer_response_sql(response_id)),
          ],
        ]),
      ))
      store.run(
        tx,
        "UPDATE recruitment_offers SET current_revision_id = ? WHERE id = ?",
        [id.offer_revision_sql(r.revision_id), id.offer_sql(offer_id)],
      )
    }
    None -> Ok(Nil)
  })
  use _ <- result.map(set_status(tx, offer_id, to))
  response_id
}

pub fn add_read_receipt(
  tx: Tx,
  offer_id: id.OfferId,
  revision_id: id.OfferRevisionId,
  kind: party.Party,
  viewer_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use position <- result.try(
    next_position(tx, receipt_row.table, "offer_id", id.offer_sql(offer_id), []),
  )
  receipt_row.insert(
    tx,
    receipt_row.new(
      offer_id:,
      position:,
      revision_id:,
      viewer_kind: kind,
      viewer_id:,
      first_viewed_at: at,
    ),
  )
}

/// The client's share with their agent; None clears it.
pub fn set_agent_share(
  tx: Tx,
  offer_id: id.OfferId,
  share: Option(#(id.OrgUserId, id.AgreementId, id.PlayerId, Int)),
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE recruitment_offers SET agent_share_user_id = ?, agent_share_agreement_id = ?, agent_share_at = ?, agent_share_by_kind = ?, agent_share_by_id = ? WHERE id = ?",
    [
      sqlight.nullable(id.org_user_sql, option.map(share, fn(s) { s.0 })),
      sqlight.nullable(id.agreement_sql, option.map(share, fn(s) { s.1 })),
      sqlight.nullable(sqlight.int, option.map(share, fn(s) { s.3 })),
      sqlight.nullable(sqlight.text, option.map(share, fn(_) { "player" })),
      sqlight.nullable(
        sqlight.text,
        option.map(share, fn(s) { id.player_to_string(s.2) }),
      ),
      id.offer_sql(offer_id),
    ],
  )
}

/// A deletion: ids, states and times stay; the player's name and words go, and the Offer records that its
/// subject left.
pub fn redact_player(
  tx: Tx,
  player_id: id.PlayerId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let p = id.player_sql(player_id)
  let mine =
    "offer_id IN (SELECT id FROM recruitment_offers WHERE player_id = ?)"
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE offer_responses SET actor_name = NULL, reason = NULL WHERE actor_type = 'player' AND "
        <> mine,
      [p],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE offer_history SET by_name = NULL WHERE by_kind = 'player' AND "
        <> mine,
      [p],
    ),
  )
  store.run(
    tx,
    "UPDATE recruitment_offers SET subject_removed_at = ? WHERE player_id = ?",
    [sqlight.int(at), p],
  )
}
