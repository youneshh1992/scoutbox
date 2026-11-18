//// Agent transaction workspaces as repositories/agentTransactions.mjs keeps them: `agent_transactions` with its
//// jurisdictions, parties, notes, linked threads, terms versions, per-act keys and history; the representation
//// bindings and the documents, each with its own history.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/transaction_rules
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/agent_transaction_jurisdictions as jurisdiction_row
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/id
import scoutbox/rows/transaction_document_history as doc_event_row
import scoutbox/rows/transaction_documents as doc_row
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_history_policy_versions as event_pv_row
import scoutbox/rows/transaction_history_reason_codes as event_code_row
import scoutbox/rows/transaction_keys as key_row
import scoutbox/rows/transaction_linked_threads as thread_row
import scoutbox/rows/transaction_notes as note_row
import scoutbox/rows/transaction_parties as party_row
import scoutbox/rows/transaction_representation_history as rep_event_row
import scoutbox/rows/transaction_representation_history_policy_versions as rep_event_pv_row
import scoutbox/rows/transaction_representation_scopes as scope_row
import scoutbox/rows/transaction_representations as rep_row
import scoutbox/rows/transaction_terms_versions as terms_row
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome.{type ContextOutcome}
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/declared_representation_status.{
  type DeclaredRepresentationStatus,
}
import scoutbox/vocab/document_visibility.{type DocumentVisibility}
import scoutbox/vocab/facet_state.{type FacetState}
import scoutbox/vocab/party_role
import scoutbox/vocab/pending_reason.{type PendingReason}
import scoutbox/vocab/staleness.{type Staleness}
import scoutbox/vocab/subject_kind.{type SubjectKind}
import scoutbox/vocab/transaction_status.{type TransactionStatus}
import sqlight

pub type Transaction {
  Transaction(
    row: tx_row.Row,
    jurisdictions: List(String),
    parties: List(party_row.Row),
    notes: List(note_row.Row),
    threads: List(thread_row.Row),
    terms: List(terms_row.Row),
    keys: List(key_row.Row),
  )
}

fn next_ord(
  tx: Tx,
  table: String,
  owner: String,
  owner_id: sqlight.Value,
) -> Result(Int, Fail(e)) {
  store.one(
    store.reading(tx),
    "SELECT COALESCE(MAX(ord) + 1, 0) FROM "
      <> table
      <> " WHERE "
      <> owner
      <> " = ?",
    [owner_id],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

fn load(read: Read, row: tx_row.Row) -> Result(Transaction, Fail(e)) {
  let tid = id.transaction_sql(row.id)
  use jurisdictions <- result.try(store.query(
    read,
    "SELECT member_association FROM agent_transaction_jurisdictions WHERE transaction_id = ? ORDER BY ord",
    [tid],
    decode.at([0], decode.string),
  ))
  use parties <- result.try(store.query(
    read,
    "SELECT "
      <> party_row.columns
      <> " FROM transaction_parties WHERE transaction_id = ? ORDER BY ord",
    [tid],
    party_row.decoder(),
  ))
  use notes <- result.try(store.query(
    read,
    "SELECT "
      <> note_row.columns
      <> " FROM transaction_notes WHERE transaction_id = ? ORDER BY ord",
    [tid],
    note_row.decoder(),
  ))
  use threads <- result.try(store.query(
    read,
    "SELECT "
      <> thread_row.columns
      <> " FROM transaction_linked_threads WHERE transaction_id = ? ORDER BY ord",
    [tid],
    thread_row.decoder(),
  ))
  use terms <- result.try(store.query(
    read,
    "SELECT "
      <> terms_row.columns
      <> " FROM transaction_terms_versions WHERE transaction_id = ? ORDER BY version",
    [tid],
    terms_row.decoder(),
  ))
  use keys <- result.map(store.query(
    read,
    "SELECT "
      <> key_row.columns
      <> " FROM transaction_keys WHERE transaction_id = ? ORDER BY rowid",
    [tid],
    key_row.decoder(),
  ))
  Transaction(row, jurisdictions, parties, notes, threads, terms, keys)
}

fn where(
  read: Read,
  condition: String,
  args: List(sqlight.Value),
) -> Result(List(Transaction), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> tx_row.columns
      <> " FROM agent_transactions WHERE "
      <> condition,
    args,
    tx_row.decoder(),
  ))
  list.try_map(rows, load(read, _))
}

fn first(r: Result(List(a), Fail(e))) -> Result(Option(a), Fail(e)) {
  result.map(r, fn(xs) { list.first(xs) |> option.from_result })
}

pub fn by_id(
  read: Read,
  transaction_id: id.TransactionId,
) -> Result(Option(Transaction), Fail(e)) {
  where(read, "id = ?", [id.transaction_sql(transaction_id)]) |> first
}

/// The agent's transaction opened under this client key.
pub fn by_create_key(
  read: Read,
  agency: id.OrgId,
  agent: id.OrgUserId,
  key: String,
) -> Result(Option(Transaction), Fail(e)) {
  where(
    read,
    "agency_org_id = ? AND agent_user_id = ? AND create_key = ? LIMIT 1",
    [id.org_sql(agency), id.org_user_sql(agent), sqlight.text(key)],
  )
  |> first
}

/// The live transactions of this type naming the individual as a party, oldest first.
pub fn live_for_individual(
  read: Read,
  player_id: String,
  type_: ContextType,
) -> Result(List(Transaction), Fail(e)) {
  where(
    read,
    "type = ? AND status NOT IN ('CANCELLED', 'CLOSED', 'ARCHIVED') AND id IN (SELECT transaction_id FROM transaction_parties WHERE subject_kind = 'player' AND subject_id = ? AND removed = 0) ORDER BY rowid",
    [sqlight.text(context_type.to_string(type_)), sqlight.text(player_id)],
  )
}

/// `duplicateTransactionOf`: a live workspace of this type for the same individual and the same clubs. A loan beside
/// a transfer, or two clubs competing for one player, are separate workspaces.
pub fn duplicate_of(
  read: Read,
  individual: String,
  type_: ContextType,
  engaging: Option(String),
  releasing: Option(String),
) -> Result(Option(Transaction), Fail(e)) {
  use live <- result.map(live_for_individual(read, individual, type_))
  let subject = fn(t: Transaction, role) {
    list.find(t.parties, fn(p) { !p.removed && p.party_role == role })
    |> option.from_result
    |> option.map(fn(p) { p.subject_id })
  }
  list.find(live, fn(t) {
    subject(t, party_role.Individual) == Some(individual)
    && subject(t, party_role.EngagingEntity) == engaging
    && subject(t, party_role.ReleasingEntity) == releasing
  })
  |> option.from_result
}

/// A history entry's details, beyond the action itself.
pub type Detail {
  Detail(
    from: Option(TransactionStatus),
    to: Option(TransactionStatus),
    party_role: Option(party_role.PartyRole),
    subject_kind: Option(SubjectKind),
    status: Option(DeclaredRepresentationStatus),
    outcome: Option(ContextOutcome),
    pending_reason: Option(PendingReason),
    document_type: Option(event_row.DetailDocumentType),
    visibility: Option(DocumentVisibility),
    staleness: Option(Staleness),
    reason_code: Option(event_row.DetailReasonCode),
    version: Option(Int),
    count: Option(Int),
    reason_codes: Option(List(String)),
    policy_versions: Option(List(id.PolicyId)),
  )
}

pub const no_detail =
  Detail(
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None,
  )

pub fn history(
  tx: Tx,
  transaction_id: id.TransactionId,
  action: event_row.Action,
  by: By,
  detail: Detail,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let owner = id.transaction_to_string(transaction_id)
  use event_id <- result.try(id.next_transaction_event(tx))
  use ord <- result.try(next_ord(
    tx,
    event_row.table,
    "transaction_id",
    sqlight.text(owner),
  ))
  use _ <- result.try(event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        transaction_id: owner,
        ord:,
        at:,
        by_kind: by.kind,
        action:,
        has_reason_codes: option.is_some(detail.reason_codes),
        has_policy_versions: option.is_some(detail.policy_versions),
      ),
      by_id: by.id,
      by_name: by.name,
      by_role: by.role,
      by_org_id: by.org_id,
      detail_from: detail.from,
      detail_to: detail.to,
      detail_party_role: detail.party_role,
      detail_subject_kind: detail.subject_kind,
      detail_status: detail.status,
      detail_outcome: detail.outcome,
      detail_pending_reason: detail.pending_reason,
      detail_document_type: detail.document_type,
      detail_visibility: detail.visibility,
      detail_staleness: detail.staleness,
      detail_reason_code: detail.reason_code,
      detail_version: detail.version,
      detail_count: detail.count,
    ),
  ))
  use _ <- result.try(
    list.index_map(option.unwrap(detail.reason_codes, []), fn(code, i) {
      event_code_row.insert(
        tx,
        event_code_row.new(history_id: event_id, ord: i, code:),
      )
    })
    |> result.all,
  )
  list.index_map(option.unwrap(detail.policy_versions, []), fn(pv, i) {
    event_pv_row.insert(
      tx,
      event_pv_row.new(history_id: event_id, ord: i, policy_version_id: pv),
    )
  })
  |> result.all
  |> result.replace(Nil)
}

pub type New {
  New(
    id: id.TransactionId,
    agency_org_id: id.OrgId,
    agent_user_id: id.OrgUserId,
    agent_name: String,
    type_: ContextType,
    jurisdictions: List(String),
    context_id: id.ComplianceContextId,
    recruitment_case_id: Option(id.RecruitmentCaseId),
    parties: List(party_row.Row),
    create_key: Option(#(String, String)),
  )
}

/// A new workspace, at DRAFT, with its parties named but not confirmed, and its opening history.
pub fn create(tx: Tx, t: New, by: By, at: Int) -> Result(Nil, Fail(e)) {
  use _ <- result.try(tx_row.insert(
    tx,
    tx_row.Row(
      ..tx_row.new(
        id: t.id,
        agency_org_id: t.agency_org_id,
        agent_user_id: t.agent_user_id,
        type_: t.type_,
        status: transaction_status.Draft,
        context_id: t.context_id,
        re_evaluation_pending: False,
        created_at: at,
        updated_at: at,
        rev: 1,
      ),
      link_recruitment_case_id: t.recruitment_case_id,
      initiated_by_name: Some(t.agent_name),
      create_key: option.map(t.create_key, fn(k) { k.0 }),
      create_fp: option.map(t.create_key, fn(k) { k.1 }),
      rev_at: Some(at),
    ),
  ))
  use _ <- result.try(
    list.index_map(t.jurisdictions, fn(ma, i) {
      jurisdiction_row.insert(
        tx,
        jurisdiction_row.new(
          transaction_id: id.transaction_to_string(t.id),
          ord: i,
          member_association: ma,
        ),
      )
    })
    |> result.all,
  )
  use _ <- result.try(list.try_each(t.parties, party_row.insert(tx, _)))
  history(
    tx,
    t.id,
    event_row.TransactionCreated,
    by,
    Detail(..no_detail, count: Some(list.length(t.parties))),
    at,
  )
}

/// A compliance snapshot: the evaluation it names (or the gate that refused first), and the status the compliance
/// layer moved the workspace to, if any. The workspace is touched, not bumped.
pub fn record_compliance(
  tx: Tx,
  transaction_id: id.TransactionId,
  stored: transaction_rules.Stored,
  freshness: Option(FacetState),
  to: Option(TransactionStatus),
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE agent_transactions SET compliance_evaluation_id = ?, compliance_gate = ?, compliance_evaluated_at = ?, compliance_pending_reason = ?, compliance_verification_freshness = ?, compliance_party_revision = ?, re_evaluation_pending = 0, status = COALESCE(?, status), updated_at = ? WHERE id = ?",
    [
      sqlight.nullable(id.evaluation_sql, stored.evaluation_id),
      sqlight.nullable(
        sqlight.text,
        option.map(stored.gate, tx_row.compliance_gate_to_string),
      ),
      sqlight.int(stored.evaluated_at),
      sqlight.nullable(
        sqlight.text,
        option.map(stored.pending_reason, pending_reason.to_string),
      ),
      sqlight.nullable(
        sqlight.text,
        option.map(freshness, facet_state.to_string),
      ),
      sqlight.text(stored.party_revision),
      sqlight.nullable(
        sqlight.text,
        option.map(to, transaction_status.to_string),
      ),
      sqlight.int(at),
      id.transaction_sql(transaction_id),
    ],
  )
}

/// A note, appended; the workspace is touched and its rev moves, labelled with the writer's role.
pub fn add_note(
  tx: Tx,
  transaction_id: id.TransactionId,
  visibility: note_row.Visibility,
  text: String,
  by: By,
  by_kind: note_row.ByKind,
  at: Int,
) -> Result(note_row.Row, Fail(e)) {
  use note_id <- result.try(id.next_transaction_note(tx))
  use ord <- result.try(next_ord(
    tx,
    note_row.table,
    "transaction_id",
    id.transaction_sql(transaction_id),
  ))
  let note =
    note_row.Row(
      ..note_row.new(
        id: note_id,
        transaction_id: id.transaction_to_string(transaction_id),
        ord:,
        visibility:,
        text:,
        by_kind:,
        at:,
      ),
      by_id: by.id,
      by_name: by.name,
      by_org_id: by.org_id,
    )
  use _ <- result.try(note_row.insert(tx, note))
  use _ <- result.try(history(
    tx,
    transaction_id,
    event_row.TransactionNoteAdded,
    by,
    Detail(..no_detail, visibility: event_visibility(visibility)),
    at,
  ))
  use _ <- result.map(
    store.run(
      tx,
      "UPDATE agent_transactions SET updated_at = ?, rev = rev + 1, rev_at = ?, rev_by_label = ? WHERE id = ?",
      [
        sqlight.int(at),
        sqlight.int(at),
        sqlight.text(role_label(by)),
        id.transaction_sql(transaction_id),
      ],
    ),
  )
  note
}

/// A note's class as its history entry records it.
fn event_visibility(v: note_row.Visibility) -> Option(DocumentVisibility) {
  document_visibility.from_string(note_row.visibility_to_string(v))
  |> option.from_result
}

/// The role a rev is labelled with (`roleRev`), never the person.
pub fn role_label(by: By) -> String {
  transaction_rules.actor(compliance_actor_kind.to_string(by.kind), by.name).1
}

// ------------------------------------------------------------------------------------------------- bookkeeping

/// The rev moves, labelled with the actor's role, never the person: every party sees it.
pub fn bump(
  tx: Tx,
  transaction_id: id.TransactionId,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE agent_transactions SET rev = rev + 1, rev_at = ?, rev_by_label = ? WHERE id = ?",
    [
      sqlight.int(at),
      sqlight.text(role_label(by)),
      id.transaction_sql(transaction_id),
    ],
  )
}

pub fn touch(
  tx: Tx,
  transaction_id: id.TransactionId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE agent_transactions SET updated_at = ? WHERE id = ?", [
    sqlight.int(at),
    id.transaction_sql(transaction_id),
  ])
}

fn add_key(
  tx: Tx,
  transaction_id: id.TransactionId,
  action: key_row.Action,
  key: Option(#(String, String)),
) -> Result(Nil, Fail(e)) {
  case key {
    Some(#(k, fp)) ->
      key_row.insert(tx, key_row.new(transaction_id:, action:, key: k, fp:))
    None -> Ok(Nil)
  }
}

/// The fingerprint a request's key was first used with, if the key was.
pub fn key_fp(
  t: Transaction,
  action: key_row.Action,
  key: String,
) -> Option(String) {
  list.find(t.keys, fn(k) { k.action == action && k.key == key })
  |> option.from_result
  |> option.map(fn(k) { k.fp })
}

/// A guarded move: the rows it changed, so a move that no longer applies is a lost race, never a write.
fn moved(
  tx: Tx,
  sql: String,
  args: List(sqlight.Value),
  what: String,
) -> Result(Nil, Fail(e)) {
  use rows <- result.try(store.write(
    tx,
    sql <> " RETURNING 1",
    args,
    decode.at([0], decode.int),
  ))
  case rows {
    [] -> store.stale(what)
    _ -> Ok(Nil)
  }
}

const live_statuses =
  "status IN ('DRAFT','PARTIES_CONFIRMED','COMPLIANCE_PENDING','COMPLIANCE_BLOCKED','READY','ACTIVE','ON_HOLD')"

// ------------------------------------------------------------------------------------------------- parties

/// A new party row (a party is removed, never replaced), with the request's replay key.
pub fn add_party(
  tx: Tx,
  t: Transaction,
  p: party_row.Row,
  key: Option(#(String, String)),
) -> Result(Nil, Fail(e)) {
  use ord <- result.try(next_ord(
    tx,
    party_row.table,
    "transaction_id",
    id.transaction_sql(t.row.id),
  ))
  use _ <- result.try(party_row.insert(tx, party_row.Row(..p, ord:)))
  add_key(tx, t.row.id, key_row.Party, key)
}

pub fn remove_party(
  tx: Tx,
  transaction_id: id.TransactionId,
  party_id: id.TransactionPartyId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  moved(
    tx,
    "UPDATE transaction_parties SET removed = 1, removed_at = ? WHERE id = ? AND transaction_id = ? AND removed = 0",
    [
      sqlight.int(at),
      id.transaction_party_sql(party_id),
      id.transaction_sql(transaction_id),
    ],
    "the party is already removed",
  )
}

/// The party confirms its own participation, once.
pub fn confirm_party(
  tx: Tx,
  transaction_id: id.TransactionId,
  party_id: id.TransactionPartyId,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let kind = case by.kind {
    compliance_actor_kind.Player -> "player"
    _ -> "club_user"
  }
  moved(
    tx,
    "UPDATE transaction_parties SET confirmed_at = ?, confirmed_by_kind = ?, confirmed_by_id = ?, confirmed_by_name = ?, confirmed_by_org_id = ? WHERE id = ? AND transaction_id = ? AND removed = 0 AND confirmed_at IS NULL",
    [
      sqlight.int(at),
      sqlight.text(kind),
      sqlight.nullable(sqlight.text, by.id),
      sqlight.nullable(sqlight.text, by.name),
      sqlight.nullable(sqlight.text, option.map(by.org_id, id.org_to_string)),
      id.transaction_party_sql(party_id),
      id.transaction_sql(transaction_id),
    ],
    "the party is removed or already confirmed",
  )
}

// ------------------------------------------------------------------------------------------------- status

fn status_in(statuses: List(TransactionStatus)) -> String {
  "status IN ("
  <> list.map(statuses, fn(s) { "'" <> transaction_status.to_string(s) <> "'" })
  |> string.join(",")
  <> ")"
}

/// A party change moves a workspace out of any compliance claim, or a draft whose parties all confirmed, to
/// PARTIES_CONFIRMED.
pub fn move_on_party_change(
  tx: Tx,
  transaction_id: id.TransactionId,
) -> Result(Nil, Fail(e)) {
  moved(
    tx,
    "UPDATE agent_transactions SET status = 'PARTIES_CONFIRMED' WHERE id = ? AND status IN ('DRAFT','READY','ACTIVE','COMPLIANCE_PENDING','COMPLIANCE_BLOCKED')",
    [id.transaction_sql(transaction_id)],
    "the transaction cannot move to PARTIES_CONFIRMED from where it is",
  )
}

/// An actor's move, with its reason and replay key; leaving a hold clears it.
pub fn move_by_actor(
  tx: Tx,
  t: Transaction,
  to: TransactionStatus,
  reason_code: Option(String),
  reason: Option(String),
  key: Option(#(String, String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  let from = transaction_rules.leading_to(to)
  let text = sqlight.nullable(sqlight.text, _)
  let #(cols, args) = case to {
    transaction_status.OnHold -> #(
      ", hold_reason_code = ?, hold_reason = ?, held_at = ?",
      [text(reason_code), text(reason), sqlight.int(at)],
    )
    transaction_status.Active -> #(
      ", hold_reason_code = NULL, hold_reason = NULL, held_at = NULL",
      [],
    )
    transaction_status.Cancelled -> #(
      ", cancel_reason_code = ?, cancelled_at = ?",
      [text(reason_code), sqlight.int(at)],
    )
    transaction_status.Closed -> #(", close_reason_code = ?, closed_at = ?", [
      text(reason_code),
      sqlight.int(at),
    ])
    transaction_status.Archived -> #(", archived_at = ?", [sqlight.int(at)])
    _ -> #("", [])
  }
  use _ <- result.try(moved(
    tx,
    "UPDATE agent_transactions SET status = ?"
      <> cols
      <> " WHERE id = ? AND "
      <> status_in(from),
    list.flatten([
      [sqlight.text(transaction_status.to_string(to))],
      args,
      [id.transaction_sql(t.row.id)],
    ]),
    "the transaction cannot move to "
      <> transaction_status.to_string(to)
      <> " from where it is",
  ))
  add_key(tx, t.row.id, key_row.Status, key)
}

/// The snapshot no longer matches the facts: it authorises nothing until re-evaluated.
pub fn flag_stale(
  tx: Tx,
  transaction_id: id.TransactionId,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE agent_transactions SET re_evaluation_pending = 1 WHERE id = ?",
    [id.transaction_sql(transaction_id)],
  )
}

fn live_guard(
  tx: Tx,
  transaction_id: id.TransactionId,
  what: String,
) -> Result(Nil, Fail(e)) {
  moved(
    tx,
    "UPDATE agent_transactions SET id = id WHERE id = ? AND " <> live_statuses,
    [id.transaction_sql(transaction_id)],
    "the transaction has ended; " <> what <> " is refused",
  )
}

pub fn link_opportunity(
  tx: Tx,
  transaction_id: id.TransactionId,
  opportunity_id: String,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(live_guard(tx, transaction_id, "a link"))
  store.run(
    tx,
    "UPDATE agent_transactions SET link_opportunity_id = ? WHERE id = ?",
    [sqlight.text(opportunity_id), id.transaction_sql(transaction_id)],
  )
}

pub fn link_trial(
  tx: Tx,
  transaction_id: id.TransactionId,
  trial_id: id.TrialId,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(live_guard(tx, transaction_id, "a link"))
  store.run(tx, "UPDATE agent_transactions SET link_trial_id = ? WHERE id = ?", [
    id.trial_sql(trial_id),
    id.transaction_sql(transaction_id),
  ])
}

/// The next terms version, counted from 1.
pub fn record_terms(
  tx: Tx,
  t: Transaction,
  v: terms_row.Row,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(live_guard(tx, t.row.id, "a terms version"))
  terms_row.insert(tx, v)
}

pub fn link_thread(
  tx: Tx,
  t: Transaction,
  thread: thread_row.Row,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(live_guard(tx, t.row.id, "a linked conversation"))
  use ord <- result.try(next_ord(
    tx,
    thread_row.table,
    "transaction_id",
    id.transaction_sql(t.row.id),
  ))
  thread_row.insert(tx, thread_row.Row(..thread, ord:))
}

/// A transaction's history, oldest first, with each entry's reason codes and policy versions.
pub type Event {
  Event(
    row: event_row.Row,
    reason_codes: List(String),
    policy_versions: List(id.PolicyId),
  )
}

pub fn events(
  read: Read,
  transaction_id: id.TransactionId,
) -> Result(List(Event), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> event_row.columns
      <> " FROM transaction_history WHERE transaction_id = ? ORDER BY ord",
    [id.transaction_sql(transaction_id)],
    event_row.decoder(),
  ))
  list.try_map(rows, fn(h) {
    use codes <- result.try(case h.has_reason_codes {
      True ->
        store.query(
          read,
          "SELECT code FROM transaction_history_reason_codes WHERE history_id = ? ORDER BY ord",
          [id.transaction_event_sql(h.id)],
          decode.at([0], decode.string),
        )
      False -> Ok([])
    })
    use pvs <- result.map(case h.has_policy_versions {
      True ->
        store.query(
          read,
          "SELECT policy_version_id FROM transaction_history_policy_versions WHERE history_id = ? ORDER BY ord",
          [id.transaction_event_sql(h.id)],
          id.policy_decoder() |> decode.at([0], _),
        )
      False -> Ok([])
    })
    Event(h, codes, pvs)
  })
}

// ------------------------------------------------------------------------------------------------- representations

pub type Representation {
  Representation(row: rep_row.Row, scope: List(scope_row.Scope))
}

fn load_representation(
  read: Read,
  row: rep_row.Row,
) -> Result(Representation, Fail(e)) {
  use scopes <- result.map(store.query(
    read,
    "SELECT scope FROM transaction_representation_scopes WHERE representation_id = ? ORDER BY ord",
    [id.representation_sql(row.id)],
    decode.at([0], scope_row.scope_decoder()),
  ))
  Representation(row, scopes)
}

fn representations_where(
  read: Read,
  condition: String,
  args: List(sqlight.Value),
) -> Result(List(Representation), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> rep_row.columns
      <> " FROM transaction_representations WHERE "
      <> condition,
    args,
    rep_row.decoder(),
  ))
  list.try_map(rows, load_representation(read, _))
}

/// The transaction's bindings, oldest first.
pub fn representations(
  read: Read,
  transaction_id: id.TransactionId,
) -> Result(List(Representation), Fail(e)) {
  representations_where(read, "transaction_id = ? ORDER BY rowid", [
    id.transaction_sql(transaction_id),
  ])
}

pub fn representation_by_attach_key(
  read: Read,
  transaction_id: id.TransactionId,
  key: String,
) -> Result(Option(Representation), Fail(e)) {
  representations_where(read, "transaction_id = ? AND attach_key = ?", [
    id.transaction_sql(transaction_id),
    sqlight.text(key),
  ])
  |> first
}

pub fn representation_by_id(
  read: Read,
  representation_id: id.RepresentationId,
) -> Result(Option(Representation), Fail(e)) {
  representations_where(read, "id = ?", [
    id.representation_sql(representation_id),
  ])
  |> first
}

/// A binding's history entry: its party role and status, and the policy versions it rested on.
pub type RepDetail {
  RepDetail(
    party_role: Option(party_role.PartyRole),
    status: Option(DeclaredRepresentationStatus),
    policy_versions: Option(List(id.PolicyId)),
  )
}

fn rep_history(
  tx: Tx,
  representation_id: id.RepresentationId,
  action: rep_event_row.Action,
  by: By,
  detail: RepDetail,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_representation_event(tx))
  use ord <- result.try(next_ord(
    tx,
    rep_event_row.table,
    "representation_id",
    id.representation_sql(representation_id),
  ))
  use _ <- result.try(rep_event_row.insert(
    tx,
    rep_event_row.Row(
      ..rep_event_row.new(
        id: event_id,
        representation_id:,
        ord:,
        at:,
        by_kind: by.kind,
        action:,
        has_policy_versions: option.is_some(detail.policy_versions),
      ),
      by_id: by.id,
      by_name: by.name,
      by_role: by.role,
      by_org_id: by.org_id,
      detail_party_role: detail.party_role,
      detail_status: detail.status,
    ),
  ))
  list.index_map(option.unwrap(detail.policy_versions, []), fn(pv, i) {
    rep_event_pv_row.insert(
      tx,
      rep_event_pv_row.new(history_id: event_id, ord: i, policy_version_id: pv),
    )
  })
  |> result.all
  |> result.replace(Nil)
}

/// A new binding, whole, with its opening history entry.
pub fn create_representation(
  tx: Tx,
  r: rep_row.Row,
  scope: List(scope_row.Scope),
  by: By,
  policy_versions: List(id.PolicyId),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(rep_row.insert(tx, r))
  use _ <- result.try(
    list.index_map(scope, fn(s, i) {
      scope_row.insert(
        tx,
        scope_row.new(representation_id: r.id, ord: i, scope: s),
      )
    })
    |> result.all,
  )
  rep_history(
    tx,
    r.id,
    rep_event_row.TransactionRepresentationAttached,
    by,
    RepDetail(Some(r.party_role), Some(r.status), Some(policy_versions)),
    r.created_at,
  )
}

/// A binding's rev bump: labelled with the person when given, else with the role.
fn bump_representation(
  tx: Tx,
  representation_id: id.RepresentationId,
  by: By,
  person: Option(#(id.OrgUserId, String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  let #(uid, name) = case person {
    Some(#(u, n)) -> #(Some(u), n)
    None -> #(None, role_label(by))
  }
  store.run(
    tx,
    "UPDATE transaction_representations SET rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ?",
    [
      sqlight.int(at),
      sqlight.nullable(id.org_user_sql, uid),
      sqlight.text(name),
      id.representation_sql(representation_id),
    ],
  )
}

/// A withdrawal is final.
pub fn withdraw_representation(
  tx: Tx,
  r: rep_row.Row,
  reason: rep_row.WithdrawnReason,
  by: By,
  detail_status: Option(DeclaredRepresentationStatus),
  person: Option(#(id.OrgUserId, String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(moved(
    tx,
    "UPDATE transaction_representations SET status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = ? WHERE id = ? AND status <> 'withdrawn'",
    [
      sqlight.int(at),
      sqlight.text(rep_row.withdrawn_reason_to_string(reason)),
      id.representation_sql(r.id),
    ],
    "the representation is already withdrawn",
  ))
  use _ <- result.try(bump_representation(tx, r.id, by, person, at))
  rep_history(
    tx,
    r.id,
    rep_event_row.TransactionRepresentationWithdrawn,
    by,
    RepDetail(Some(r.party_role), detail_status, None),
    at,
  )
}

/// An attributed reviewer confirmed a declared binding: it is verified by that review.
pub fn verify_representation(
  tx: Tx,
  r: rep_row.Row,
  review_id: id.RegulatoryReviewId,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(moved(
    tx,
    "UPDATE transaction_representations SET status = 'verified', declared_only = 0, verified_at = ?, verified_by_review_id = ? WHERE id = ? AND status = 'pending_review'",
    [
      sqlight.int(at),
      id.regulatory_review_sql(review_id),
      id.representation_sql(r.id),
    ],
    "the representation is not awaiting review",
  ))
  use _ <- result.try(bump_representation(tx, r.id, by, None, at))
  rep_history(
    tx,
    r.id,
    rep_event_row.TransactionRepresentationAttached,
    by,
    RepDetail(
      Some(r.party_role),
      Some(declared_representation_status.Verified),
      None,
    ),
    at,
  )
}

// ------------------------------------------------------------------------------------------------- documents

/// A document version, and the version that names it as superseded, if any.
pub type Document {
  Document(row: doc_row.Row, superseded_by: Option(id.TransactionDocumentId))
}

fn documents_where(
  read: Read,
  condition: String,
  args: List(sqlight.Value),
) -> Result(List(Document), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> doc_row.qualified("d")
      <> ", (SELECT n.id FROM transaction_documents n WHERE n.supersedes_id = d.id) FROM transaction_documents d WHERE "
      <> condition,
    args,
    {
      use row <- decode.then(doc_row.decoder())
      use next <- decode.field(
        doc_row.width,
        decode.optional(id.transaction_document_decoder()),
      )
      decode.success(Document(row, next))
    },
  )
}

/// Every live (not removed) version of the transaction's documents, oldest first.
pub fn documents(
  read: Read,
  transaction_id: id.TransactionId,
) -> Result(List(Document), Fail(e)) {
  documents_where(
    read,
    "d.transaction_id = ? AND d.removed_at IS NULL ORDER BY d.rowid",
    [id.transaction_sql(transaction_id)],
  )
}

pub fn document_by_add_key(
  read: Read,
  transaction_id: id.TransactionId,
  key: String,
) -> Result(Option(Document), Fail(e)) {
  documents_where(read, "d.transaction_id = ? AND d.add_key = ?", [
    id.transaction_sql(transaction_id),
    sqlight.text(key),
  ])
  |> first
}

pub fn document_by_id(
  read: Read,
  document_id: id.TransactionDocumentId,
) -> Result(Option(Document), Fail(e)) {
  documents_where(read, "d.id = ?", [id.transaction_document_sql(document_id)])
  |> first
}

fn doc_history(
  tx: Tx,
  document_id: id.TransactionDocumentId,
  action: doc_event_row.Action,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_transaction_document_event(tx))
  use ord <- result.try(next_ord(
    tx,
    doc_event_row.table,
    "document_id",
    id.transaction_document_sql(document_id),
  ))
  doc_event_row.insert(
    tx,
    doc_event_row.Row(
      ..doc_event_row.new(
        id: event_id,
        document_id:,
        ord:,
        at:,
        by_kind: by.kind,
        action:,
      ),
      by_id: by.id,
      by_name: by.name,
      by_role: by.role,
      by_org_id: by.org_id,
    ),
  )
}

pub fn create_document(tx: Tx, d: doc_row.Row, by: By) -> Result(Nil, Fail(e)) {
  use _ <- result.try(doc_row.insert(tx, d))
  doc_history(
    tx,
    d.id,
    doc_event_row.TransactionDocumentAdded,
    by,
    d.created_at,
  )
}

/// `next` is the next version of `old`, a live version not yet superseded; the old row keeps everything but its
/// rev, which moves with a superseded entry.
pub fn supersede_document(
  tx: Tx,
  old: doc_row.Row,
  next: doc_row.Row,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(create_document(tx, next, by))
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE transaction_documents SET rev = rev + 1, rev_at = ?, rev_by_id = NULL, rev_by_name = ? WHERE id = ?",
      [
        sqlight.int(at),
        sqlight.text(role_label(by)),
        id.transaction_document_sql(old.id),
      ],
    ),
  )
  doc_history(tx, old.id, doc_event_row.TransactionDocumentSuperseded, by, at)
}

// ------------------------------------------------------------------------------------------------- lists

/// Up to `limit + 1` transactions newest first, each with its rowid (the cursor key).
fn page_where(
  read: Read,
  condition: String,
  args: List(sqlight.Value),
  after: Option(Int),
  limit: Int,
) -> Result(List(#(Int, Transaction)), Fail(e)) {
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> tx_row.qualified("t")
        <> ", t.rowid FROM agent_transactions t WHERE "
        <> condition
        <> " AND (? IS NULL OR t.rowid < ?) ORDER BY t.rowid DESC LIMIT ?",
      list.append(args, [
        sqlight.nullable(sqlight.int, after),
        sqlight.nullable(sqlight.int, after),
        sqlight.int(limit + 1),
      ]),
      {
        use row <- decode.then(tx_row.decoder())
        use rid <- decode.field(tx_row.width, decode.int)
        decode.success(#(rid, row))
      },
    ),
  )
  list.try_map(rows, fn(r) {
    load(read, r.1) |> result.map(fn(t) { #(r.0, t) })
  })
}

/// The agent's own transactions in the agency, newest first, by cursor.
pub fn agent_page(
  read: Read,
  agency: id.OrgId,
  agent: id.OrgUserId,
  status: Option(TransactionStatus),
  after: Option(Int),
  limit: Int,
) -> Result(List(#(Int, Transaction)), Fail(e)) {
  page_where(
    read,
    "t.agency_org_id = ? AND t.agent_user_id = ? AND (? IS NULL OR t.status = ?)",
    [
      id.org_sql(agency),
      id.org_user_sql(agent),
      sqlight.nullable(
        sqlight.text,
        option.map(status, transaction_status.to_string),
      ),
      sqlight.nullable(
        sqlight.text,
        option.map(status, transaction_status.to_string),
      ),
    ],
    after,
    limit,
  )
}

/// Every transaction (the attributed Trust & Safety read), newest first, by cursor.
pub fn all_page(
  read: Read,
  status: Option(TransactionStatus),
  after: Option(Int),
  limit: Int,
) -> Result(List(#(Int, Transaction)), Fail(e)) {
  let s =
    sqlight.nullable(
      sqlight.text,
      option.map(status, transaction_status.to_string),
    )
  page_where(read, "(? IS NULL OR t.status = ?)", [s, s], after, limit)
}

/// The transactions a club is a live party to, newest first, by cursor.
pub fn club_page(
  read: Read,
  org: id.OrgId,
  after: Option(Int),
  limit: Int,
) -> Result(List(#(Int, Transaction)), Fail(e)) {
  page_where(
    read,
    "EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = t.id AND p.subject_kind = 'club' AND p.subject_id = ? AND p.removed = 0)",
    [id.org_sql(org)],
    after,
    limit,
  )
}

/// The transactions a player is the live individual party to, oldest first.
pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Transaction), Fail(e)) {
  where(
    read,
    "id IN (SELECT transaction_id FROM transaction_parties WHERE subject_kind = 'player' AND subject_id = ? AND removed = 0) ORDER BY rowid",
    [id.player_sql(player_id)],
  )
}

/// The live transactions, oldest first.
pub fn live(read: Read) -> Result(List(Transaction), Fail(e)) {
  where(read, live_statuses <> " ORDER BY rowid", [])
}

pub type Counts {
  Counts(
    live: Int,
    blocked: Int,
    pending: Int,
    ready: Int,
    awaiting_confirmation: Int,
  )
}

const unconfirmed =
  "EXISTS (SELECT 1 FROM (SELECT 'individual' AS r UNION ALL SELECT 'engaging_entity' UNION ALL SELECT 'releasing_entity' WHERE t.type IN ('transfer','loan')) need WHERE NOT EXISTS (SELECT 1 FROM transaction_parties p WHERE p.transaction_id = t.id AND p.party_role = need.r AND p.removed = 0 AND p.confirmed_at IS NOT NULL))"

/// The agent's figures over every transaction of theirs, not one page.
pub fn agent_counts(
  read: Read,
  agency: id.OrgId,
  agent: id.OrgUserId,
) -> Result(Counts, Fail(e)) {
  store.one(
    read,
    "SELECT COALESCE(SUM(CASE WHEN "
      <> live_statuses
      <> " THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN status = 'COMPLIANCE_BLOCKED' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN status = 'COMPLIANCE_PENDING' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN "
      <> live_statuses
      <> " AND "
      <> unconfirmed
      <> " THEN 1 ELSE 0 END), 0) FROM agent_transactions t WHERE agency_org_id = ? AND agent_user_id = ?",
    [id.org_sql(agency), id.org_user_sql(agent)],
    {
      use a <- decode.field(0, decode.int)
      use b <- decode.field(1, decode.int)
      use c <- decode.field(2, decode.int)
      use d <- decode.field(3, decode.int)
      use e <- decode.field(4, decode.int)
      decode.success(Counts(a, b, c, d, e))
    },
  )
  |> result.map(result.unwrap(_, Counts(0, 0, 0, 0, 0)))
}

// ------------------------------------------------------------------------------------------------- the audit

/// Every document version's history entries (removed versions included), with the version they belong to.
pub fn document_events(
  read: Read,
  transaction_id: id.TransactionId,
) -> Result(List(#(doc_row.Row, doc_event_row.Row)), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> doc_row.qualified("d")
      <> ", "
      <> doc_event_row.qualified("h")
      <> " FROM transaction_document_history h JOIN transaction_documents d ON d.id = h.document_id WHERE d.transaction_id = ? ORDER BY d.rowid, h.ord",
    [id.transaction_sql(transaction_id)],
    {
      use d <- decode.then(doc_row.decoder())
      use h <- decode.then(event_at(doc_row.width))
      decode.success(#(d, h))
    },
  )
}

fn event_at(offset: Int) -> decode.Decoder(doc_event_row.Row) {
  use id_ <- decode.field(offset, id.transaction_document_event_decoder())
  use document_id <- decode.field(offset + 1, id.transaction_document_decoder())
  use ord <- decode.field(offset + 2, decode.int)
  use at <- decode.field(offset + 3, decode.int)
  use by_kind <- decode.field(offset + 4, compliance_actor_kind.decoder())
  use by_id <- decode.field(offset + 5, decode.optional(decode.string))
  use by_name <- decode.field(offset + 6, decode.optional(decode.string))
  use by_role <- decode.field(offset + 7, decode.optional(decode.string))
  use by_org_id <- decode.field(offset + 8, decode.optional(id.org_decoder()))
  use action <- decode.field(offset + 9, doc_event_row.action_decoder())
  decode.success(doc_event_row.Row(
    id: id_,
    document_id:,
    ord:,
    at:,
    by_kind:,
    by_id:,
    by_name:,
    by_role:,
    by_org_id:,
    action:,
  ))
}

/// Every binding's history entries, with the binding and the policy versions each entry rested on.
pub fn representation_events(
  read: Read,
  transaction_id: id.TransactionId,
) -> Result(List(#(rep_row.Row, rep_event_row.Row, List(id.PolicyId))), Fail(e)) {
  use reps <- result.try(representations(read, transaction_id))
  list.try_map(reps, fn(r) {
    use events <- result.try(store.query(
      read,
      "SELECT "
        <> rep_event_row.columns
        <> " FROM transaction_representation_history WHERE representation_id = ? ORDER BY ord",
      [id.representation_sql(r.row.id)],
      rep_event_row.decoder(),
    ))
    list.try_map(events, fn(h) {
      use pvs <- result.map(case h.has_policy_versions {
        True ->
          store.query(
            read,
            "SELECT policy_version_id FROM transaction_representation_history_policy_versions WHERE history_id = ? ORDER BY ord",
            [id.representation_event_sql(h.id)],
            decode.at([0], id.policy_decoder()),
          )
        False -> Ok([])
      })
      #(r.row, h, pvs)
    })
  })
  |> result.map(list.flatten)
}
