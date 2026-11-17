//// Agent transaction workspaces as repositories/agentTransactions.mjs keeps them: `agent_transactions` with its
//// jurisdictions, parties, notes and history.
////
//// Not ported yet: representations, documents, terms, linked threads and the per-act keys (the routes that write
//// them), so a workspace here has none.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/transaction_rules
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/agent_transaction_jurisdictions as jurisdiction_row
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/id
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_history_policy_versions as event_pv_row
import scoutbox/rows/transaction_history_reason_codes as event_code_row
import scoutbox/rows/transaction_notes as note_row
import scoutbox/rows/transaction_parties as party_row
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome.{type ContextOutcome}
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/document_visibility.{type DocumentVisibility}
import scoutbox/vocab/facet_state.{type FacetState}
import scoutbox/vocab/party_role
import scoutbox/vocab/pending_reason.{type PendingReason}
import scoutbox/vocab/transaction_status.{type TransactionStatus}
import sqlight

pub type Transaction {
  Transaction(
    row: tx_row.Row,
    jurisdictions: List(String),
    parties: List(party_row.Row),
    notes: List(note_row.Row),
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
  use notes <- result.map(store.query(
    read,
    "SELECT "
      <> note_row.columns
      <> " FROM transaction_notes WHERE transaction_id = ? ORDER BY ord",
    [tid],
    note_row.decoder(),
  ))
  Transaction(row, jurisdictions, parties, notes)
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
    outcome: Option(ContextOutcome),
    pending_reason: Option(PendingReason),
    visibility: Option(DocumentVisibility),
    count: Option(Int),
    reason_codes: Option(List(String)),
    policy_versions: Option(List(String)),
  )
}

pub const no_detail = Detail(None, None, None, None, None, None, None, None)

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
      detail_outcome: detail.outcome,
      detail_pending_reason: detail.pending_reason,
      detail_visibility: detail.visibility,
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
      event_pv_row.new(
        history_id: event_id,
        ord: i,
        policy_version_id: id.policy(pv),
      ),
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
