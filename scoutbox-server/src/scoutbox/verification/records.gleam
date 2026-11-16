//// The verification tables (repositories/verification.ts): claims with their codes and evidence links, events,
//// tokens, the administrator hierarchy, evidence, an organisation's verified domains and disputes.
////
//// A claim's status moves only from the status its caller read, guarded in SQL, so two moves of one claim can't
//// both win. Events are only inserted. Risk flags only gain codes. A token is used once.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/org_verified_domains as domain_row
import scoutbox/rows/ver_admins as admin_row
import scoutbox/rows/ver_claim_codes as code_row
import scoutbox/rows/ver_claim_evidence as link_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_disputes as dispute_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/rows/ver_tokens as token_row
import scoutbox/vocab/attribution
import scoutbox/vocab/ver_code.{type VerCode}
import sqlight

pub type Claim =
  claim_row.Row

pub type Evidence =
  evidence_row.Row

pub type Token =
  token_row.Row

pub type Admin =
  admin_row.Row

pub type Dispute =
  dispute_row.Row

/// VERIFICATION_LIMITS.detail
const detail_max = 1000

// ------------------------------------------------------------------------------------------------ helpers

fn inserted(
  tx: Tx,
  sql: String,
  values: List(sqlight.Value),
  columns: String,
  decoder: decode.Decoder(a),
) -> Result(a, Fail(e)) {
  use rows <- result.try(store.write(
    tx,
    sql <> " RETURNING " <> columns,
    values,
    decoder,
  ))
  let assert [row] = rows as "an INSERT … RETURNING returns its row"
  Ok(row)
}

/// `UPDATE <table> SET (<columns>) = (…) WHERE id = ? AND <guard>`: the whole row written back. False when the
/// guard matched nothing.
fn replace(
  tx: Tx,
  table: String,
  columns: String,
  values: List(sqlight.Value),
  id: String,
  guard: String,
  guard_args: List(sqlight.Value),
) -> Result(Bool, Fail(e)) {
  let marks = list.map(values, fn(_) { "?" }) |> string.join(", ")
  store.write(
    tx,
    "UPDATE "
      <> table
      <> " SET ("
      <> columns
      <> ") = ("
      <> marks
      <> ") WHERE id = ?"
      <> guard
      <> " RETURNING 1",
    list.flatten([values, [sqlight.text(id)], guard_args]),
    decode.success(Nil),
  )
  |> result.map(fn(rows) { rows != [] })
}

// ------------------------------------------------------------------------------------------------ claims

pub fn claim(read: Read, id: String) -> Result(Option(Claim), Fail(e)) {
  store.one(
    read,
    "SELECT " <> claim_row.columns <> " FROM ver_claims WHERE id = ?",
    [sqlight.text(id)],
    claim_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// A subject's claims, in the order they were made.
pub fn claims_for(
  read: Read,
  kind: claim_row.SubjectKind,
  subject_id: String,
) -> Result(List(Claim), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> claim_row.columns
      <> " FROM ver_claims WHERE subject_kind = ? AND subject_id = ? ORDER BY rowid",
    [
      sqlight.text(claim_row.subject_kind_to_string(kind)),
      sqlight.text(subject_id),
    ],
    claim_row.decoder(),
  )
}

/// An organisation's claims about its staff, in the order they were made.
pub fn staff_claims(
  read: Read,
  org_id: String,
) -> Result(List(Claim), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> claim_row.columns
      <> " FROM ver_claims WHERE organisation_id = ? AND subject_kind = 'user' ORDER BY rowid",
    [sqlight.text(org_id)],
    claim_row.decoder(),
  )
}

pub fn claims_by_pair(
  read: Read,
  pair_id: String,
) -> Result(List(Claim), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> claim_row.columns
      <> " FROM ver_claims WHERE pair_id = ? ORDER BY rowid",
    [sqlight.text(pair_id)],
    claim_row.decoder(),
  )
}

/// Claims in any of `statuses`, in the order they were made.
pub fn claims_in(
  read: Read,
  statuses: List(claim_row.Status),
) -> Result(List(Claim), Fail(e)) {
  let marks = list.map(statuses, fn(_) { "?" }) |> string.join(", ")
  store.query(
    read,
    "SELECT "
      <> claim_row.columns
      <> " FROM ver_claims WHERE status IN ("
      <> marks
      <> ") ORDER BY rowid",
    list.map(statuses, fn(s) { sqlight.text(claim_row.status_to_string(s)) }),
    claim_row.decoder(),
  )
}

/// Claims an administrator confirmed (their authority), in the order they were made.
pub fn claims_by_authority(
  read: Read,
  authority_id: String,
) -> Result(List(Claim), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> claim_row.columns
      <> " FROM ver_claims WHERE authority_id = ? ORDER BY rowid",
    [sqlight.text(authority_id)],
    claim_row.decoder(),
  )
}

pub fn has_open_identity(read: Read, user_id: String) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM ver_claims WHERE subject_kind = 'user' AND subject_id = ? AND claim_type = 'PERSON_IDENTITY'
       AND status IN ('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified')",
    [sqlight.text(user_id)],
    decode.success(Nil),
  )
  |> result.map(result.is_ok)
}

pub fn create_claim(tx: Tx, claim: Claim) -> Result(Claim, Fail(e)) {
  inserted(
    tx,
    claim_row.insert_sql,
    claim_row.values(claim),
    claim_row.columns,
    claim_row.decoder(),
  )
}

/// Writes `claim` back over the stored one, whose status must still be `from`. False when it moved meanwhile.
pub fn move_claim(
  tx: Tx,
  claim: Claim,
  from: claim_row.Status,
) -> Result(Bool, Fail(e)) {
  replace(
    tx,
    "ver_claims",
    claim_row.columns,
    claim_row.values(claim),
    claim.id,
    " AND status = ?",
    [sqlight.text(claim_row.status_to_string(from))],
  )
}

/// Writes `claim` back over the stored one, its status unchanged.
pub fn update_claim(tx: Tx, claim: Claim) -> Result(Nil, Fail(e)) {
  use moved <- result.try(move_claim(tx, claim, claim.status))
  let assert True = moved
    as "a claim is rewritten only in the status it was read in"
  Ok(Nil)
}

pub type CodeList {
  ReviewReasons
  RiskFlags
}

fn list_value(l: CodeList) -> code_row.ListValue {
  case l {
    ReviewReasons -> code_row.ReviewReason
    RiskFlags -> code_row.RiskFlag
  }
}

/// A claim's review reasons or risk flags, in the order they were added.
pub fn codes(
  read: Read,
  claim_id: String,
  l: CodeList,
) -> Result(List(VerCode), Fail(e)) {
  store.query(
    read,
    "SELECT code FROM ver_claim_codes WHERE claim_id = ? AND list = ? ORDER BY position",
    [
      sqlight.text(claim_id),
      sqlight.text(code_row.list_value_to_string(list_value(l))),
    ],
    decode.at([0], ver_code.decoder()),
  )
}

/// Adds the codes the claim doesn't have yet, after its others.
pub fn add_codes(
  tx: Tx,
  claim_id: String,
  l: CodeList,
  new: List(VerCode),
) -> Result(Nil, Fail(e)) {
  use have <- result.try(codes(store.reading(tx), claim_id, l))
  let #(_, fresh) =
    list.fold(new, #(have, []), fn(acc, c) {
      case list.contains(acc.0, c) {
        True -> acc
        False -> #([c, ..acc.0], [c, ..acc.1])
      }
    })
  list.reverse(fresh)
  |> list.index_map(fn(c, i) { #(c, list.length(have) + i) })
  |> list.try_each(fn(pair) {
    store.run(
      tx,
      code_row.insert_sql,
      code_row.values(code_row.Row(
        claim_id:,
        list: list_value(l),
        position: pair.1,
        code: pair.0,
      )),
    )
  })
}

/// Replaces the claim's codes.
pub fn set_codes(
  tx: Tx,
  claim_id: String,
  l: CodeList,
  new: List(VerCode),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM ver_claim_codes WHERE claim_id = ? AND list = ?",
      [
        sqlight.text(claim_id),
        sqlight.text(code_row.list_value_to_string(list_value(l))),
      ],
    ),
  )
  add_codes(tx, claim_id, l, new)
}

/// The evidence linked to a claim, in the order it was linked.
pub fn evidence_ids(
  read: Read,
  claim_id: String,
) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    "SELECT evidence_id FROM ver_claim_evidence WHERE claim_id = ? ORDER BY position",
    [sqlight.text(claim_id)],
    decode.at([0], decode.string),
  )
}

// ------------------------------------------------------------------------------------------------ events

/// What an event records besides its type: who, about what, and the change.
pub type Event {
  Event(
    actor_kind: event_row.ActorKind,
    actor_id: Option(String),
    actor_name: Option(String),
    actor_org_id: Option(String),
    request_id: Option(String),
    attribution: Option(attribution.Attribution),
    claim_id: Option(String),
    subject_id: Option(String),
    org_id: Option(String),
    detail: Option(String),
    reason: Option(String),
  )
}

pub const system_event =
  Event(
    actor_kind: event_row.System,
    actor_id: None,
    actor_name: None,
    actor_org_id: None,
    request_id: None,
    attribution: None,
    claim_id: None,
    subject_id: None,
    org_id: None,
    detail: None,
    reason: None,
  )

pub fn append_event(
  tx: Tx,
  id: String,
  at: Int,
  type_: event_row.Type,
  e: Event,
) -> Result(Nil, Fail(e)) {
  let cut = fn(v: Option(String), max: Int) {
    option.map(v, input.utf16_take(_, max))
  }
  store.run(
    tx,
    event_row.insert_sql,
    event_row.values(event_row.Row(
      id:,
      occurred_at: at,
      type_:,
      actor_kind: e.actor_kind,
      actor_id: cut(e.actor_id, 80),
      actor_name: cut(e.actor_name, 200),
      actor_org_id: e.actor_org_id,
      request_id: cut(e.request_id, 120),
      attribution: e.attribution,
      claim_id: e.claim_id,
      subject_id: e.subject_id,
      org_id: e.org_id,
      detail: e.detail,
      reason: cut(e.reason, 600),
    )),
  )
}

/// A change in an event's words (eventDetail): `key: before → after` for a key on both sides, `key: after` for a
/// new one, `key: before (before)` for one that went. A missing value reads `—`.
pub fn detail(
  before: List(#(String, Option(String))),
  after: List(#(String, Option(String))),
) -> Option(String) {
  let show = fn(v: Option(String)) { option.unwrap(v, "—") }
  let keys =
    list.append(list.map(before, fn(p) { p.0 }), list.map(after, fn(p) { p.0 }))
    |> list.unique
  let parts =
    list.map(keys, fn(k) {
      case list.key_find(before, k), list.key_find(after, k) {
        Ok(b), Ok(a) -> k <> ": " <> show(b) <> " → " <> show(a)
        Error(Nil), Ok(a) -> k <> ": " <> show(a)
        Ok(b), Error(Nil) -> k <> ": " <> show(b) <> " (before)"
        Error(Nil), Error(Nil) -> k
      }
    })
  case string.join(parts, "; ") {
    "" -> None
    line ->
      case input.utf16_length(line) > detail_max {
        True -> Some(input.utf16_take(line, detail_max - 1) <> "…")
        False -> Some(line)
      }
  }
}

pub fn events_for_claim(
  read: Read,
  claim_id: String,
) -> Result(List(event_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> event_row.columns
      <> " FROM ver_events WHERE claim_id = ? ORDER BY rowid",
    [sqlight.text(claim_id)],
    event_row.decoder(),
  )
}

// ------------------------------------------------------------------------------------------------ evidence

/// Stores an evidence record and links it to `claim_ids`, each after the evidence it already has.
pub fn add_evidence(
  tx: Tx,
  evidence: Evidence,
  claim_ids: List(String),
) -> Result(Evidence, Fail(e)) {
  use stored <- result.try(inserted(
    tx,
    evidence_row.insert_sql,
    evidence_row.values(evidence),
    evidence_row.columns,
    evidence_row.decoder(),
  ))
  use _ <- result.try(
    list.try_each(claim_ids, fn(claim_id) {
      use have <- result.try(evidence_ids(store.reading(tx), claim_id))
      store.run(
        tx,
        link_row.insert_sql,
        link_row.values(link_row.Row(
          claim_id:,
          position: list.length(have),
          evidence_id: stored.id,
        )),
      )
    }),
  )
  Ok(stored)
}

pub fn evidence(read: Read, id: String) -> Result(Option(Evidence), Fail(e)) {
  store.one(
    read,
    "SELECT " <> evidence_row.columns <> " FROM ver_evidence WHERE id = ?",
    [sqlight.text(id)],
    evidence_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// The evidence linked to a claim, in the order it was linked.
pub fn claim_evidence(
  read: Read,
  claim_id: String,
) -> Result(List(Evidence), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> evidence_row.qualified("e")
      <> " FROM ver_claim_evidence l JOIN ver_evidence e ON e.id = l.evidence_id
       WHERE l.claim_id = ? ORDER BY l.position",
    [sqlight.text(claim_id)],
    evidence_row.decoder(),
  )
}

/// Whether anyone but `except_supplier` supplied a file with this digest.
pub fn digest_seen(
  read: Read,
  sha: String,
  except_supplier: Option(String),
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM ver_evidence WHERE sha256 = ? AND (? IS NULL OR supplied_by_id IS NULL OR supplied_by_id <> ?)",
    [
      sqlight.text(sha),
      sqlight.nullable(sqlight.text, except_supplier),
      sqlight.nullable(sqlight.text, except_supplier),
    ],
    decode.success(Nil),
  )
  |> result.map(result.is_ok)
}

// ------------------------------------------------------------------------------------------------ tokens

pub fn create_token(tx: Tx, token: Token) -> Result(Nil, Fail(e)) {
  store.run(tx, token_row.insert_sql, token_row.values(token))
}

pub fn token_by_hash(
  read: Read,
  hash: String,
) -> Result(Option(Token), Fail(e)) {
  store.one(
    read,
    "SELECT " <> token_row.columns <> " FROM ver_tokens WHERE token_hash = ?",
    [sqlight.text(hash)],
    token_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// Spends a token. False when it was already spent.
pub fn use_token(tx: Tx, id: String, at: Int) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE ver_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING 1",
    [sqlight.int(at), sqlight.text(id)],
    decode.success(Nil),
  )
  |> result.map(fn(rows) { rows != [] })
}

/// A wrong code counts against every open token of the subject for that purpose.
pub fn record_failed_attempts(
  tx: Tx,
  subject_id: String,
  purpose: token_row.Purpose,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE ver_tokens SET attempts_failed = attempts_failed + 1 WHERE subject_id = ? AND purpose = ? AND used_at IS NULL",
    [
      sqlight.text(subject_id),
      sqlight.text(token_row.purpose_to_string(purpose)),
    ],
  )
}

pub fn failed_attempts(
  read: Read,
  subject_id: String,
  purpose: token_row.Purpose,
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COALESCE(SUM(attempts_failed), 0) FROM ver_tokens WHERE subject_id = ? AND purpose = ?",
    [
      sqlight.text(subject_id),
      sqlight.text(token_row.purpose_to_string(purpose)),
    ],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

// ------------------------------------------------------------------------------------------------ administrators

pub fn create_admin(tx: Tx, admin: Admin) -> Result(Admin, Fail(e)) {
  inserted(
    tx,
    admin_row.insert_sql,
    admin_row.values(admin),
    admin_row.columns,
    admin_row.decoder(),
  )
}

pub fn admin(read: Read, id: String) -> Result(Option(Admin), Fail(e)) {
  store.one(
    read,
    "SELECT " <> admin_row.columns <> " FROM ver_admins WHERE id = ?",
    [sqlight.text(id)],
    admin_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// An organisation's grants, active or not, in the order they were made.
pub fn admins_of(read: Read, org_id: String) -> Result(List(Admin), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> admin_row.columns
      <> " FROM ver_admins WHERE org_id = ? ORDER BY rowid",
    [sqlight.text(org_id)],
    admin_row.decoder(),
  )
}

pub fn active_admins_of(
  read: Read,
  org_id: String,
) -> Result(List(Admin), Fail(e)) {
  admins_of(read, org_id)
  |> result.map(list.filter(_, fn(a) { a.status == admin_row.Active }))
}

/// Revokes an active grant. False when it was not active.
pub fn revoke_admin(
  tx: Tx,
  id: String,
  at: Int,
  by: String,
) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE ver_admins SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ? AND status = 'active' RETURNING 1",
    [sqlight.int(at), sqlight.text(by), sqlight.text(id)],
    decode.success(Nil),
  )
  |> result.map(fn(rows) { rows != [] })
}

// ------------------------------------------------------------------------------------------------ domains

/// An organisation's verified domains, in the order they were added.
pub fn domains_of(
  read: Read,
  org_id: String,
) -> Result(List(domain_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> domain_row.columns
      <> " FROM org_verified_domains WHERE org_id = ? ORDER BY rowid",
    [sqlight.text(org_id)],
    domain_row.decoder(),
  )
}

/// How a domain was verified.
pub type DomainMethod {
  DomainByEmail
  DomainByReview
}

pub fn verified_domain(
  org_id: String,
  domain: String,
  method: DomainMethod,
  at: Int,
  added_by: String,
) -> domain_row.Row {
  domain_row.Row(
    org_id:,
    domain:,
    status: domain_row.Verified,
    method: case method {
      DomainByEmail -> domain_row.OfficialDomainEmail
      DomainByReview -> domain_row.ScoutboxManualReview
    },
    verified_at: at,
    added_by:,
  )
}

pub fn add_domain(tx: Tx, d: domain_row.Row) -> Result(Nil, Fail(e)) {
  store.run(tx, domain_row.insert_sql, domain_row.values(d))
}

/// The organisation other than `except_org` that verified `domain`.
pub fn domain_verified_elsewhere(
  read: Read,
  domain: String,
  except_org: Option(String),
) -> Result(Option(String), Fail(e)) {
  store.one(
    read,
    "SELECT org_id FROM org_verified_domains WHERE domain = ? AND (? IS NULL OR org_id <> ?) ORDER BY rowid LIMIT 1",
    [
      sqlight.text(domain),
      sqlight.nullable(sqlight.text, except_org),
      sqlight.nullable(sqlight.text, except_org),
    ],
    decode.at([0], decode.string),
  )
  |> result.map(option.from_result)
}

// ------------------------------------------------------------------------------------------------ disputes

pub fn create_dispute(tx: Tx, d: Dispute) -> Result(Dispute, Fail(e)) {
  inserted(
    tx,
    dispute_row.insert_sql,
    dispute_row.values(d),
    dispute_row.columns,
    dispute_row.decoder(),
  )
}

pub fn dispute(read: Read, id: String) -> Result(Option(Dispute), Fail(e)) {
  store.one(
    read,
    "SELECT " <> dispute_row.columns <> " FROM ver_disputes WHERE id = ?",
    [sqlight.text(id)],
    dispute_row.decoder(),
  )
  |> result.map(option.from_result)
}

pub fn has_open_dispute(read: Read, claim_id: String) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM ver_disputes WHERE claim_id = ? AND status = 'open'",
    [sqlight.text(claim_id)],
    decode.success(Nil),
  )
  |> result.map(result.is_ok)
}

/// Every dispute, in the order they were opened.
pub fn disputes(read: Read) -> Result(List(Dispute), Fail(e)) {
  store.query(
    read,
    "SELECT " <> dispute_row.columns <> " FROM ver_disputes ORDER BY rowid",
    [],
    dispute_row.decoder(),
  )
}

pub fn update_dispute(
  tx: Tx,
  d: Dispute,
  from: dispute_row.Status,
) -> Result(Bool, Fail(e)) {
  replace(
    tx,
    "ver_disputes",
    dispute_row.columns,
    dispute_row.values(d),
    d.id,
    " AND status = ?",
    [sqlight.text(dispute_row.status_to_string(from))],
  )
}

/// Claims matching `where` (SQL over ver_claims' columns), in the order they were made.
pub fn claims_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Claim), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> claim_row.columns
      <> " FROM ver_claims WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    claim_row.decoder(),
  )
}

pub fn disputes_for_claim(
  read: Read,
  claim_id: String,
) -> Result(List(Dispute), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> dispute_row.columns
      <> " FROM ver_disputes WHERE claim_id = ? ORDER BY rowid",
    [sqlight.text(claim_id)],
    dispute_row.decoder(),
  )
}
