//// Regulatory consents as repositories/complianceRecords.mjs keeps them (`consents`): a party's prior written
//// consent to an agent acting for more than one party in one compliance context. A revocation is a row of its
//// own; the granted row keeps its grant.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/compliance_store.{type By}
import scoutbox/agents/conflict
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/regulatory_consent_history as event_row
import scoutbox/rows/regulatory_consent_policy_versions as pv_row
import scoutbox/rows/regulatory_consent_regarding as regarding_row
import scoutbox/rows/regulatory_consent_revocations as revocation_row
import scoutbox/rows/regulatory_consent_rule_ids as rule_row
import scoutbox/rows/regulatory_consents as row
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/subject_kind.{type SubjectKind}
import sqlight

pub type Consent {
  Consent(
    row: row.Row,
    regarding: List(PartyRole),
    policy_versions: List(id.PolicyId),
    rule_ids: List(String),
    revocation: Option(revocation_row.Row),
  )
}

/// `requested`, `granted`, `declined` or `revoked`: a revocation outranks the grant it ends.
pub fn status(k: Consent) -> String {
  case k.revocation {
    Some(_) -> "revoked"
    None -> row.status_to_string(k.row.status)
  }
}

pub fn revoked_at(k: Consent) -> Option(Int) {
  option.map(k.revocation, fn(r) { r.revoked_at })
}

fn load(read: Read, r: row.Row) -> Result(Consent, Fail(e)) {
  let cid = id.consent_sql(r.id)
  use regarding <- result.try(store.query(
    read,
    "SELECT party_role FROM regulatory_consent_regarding WHERE consent_id = ? ORDER BY ord",
    [cid],
    decode.at([0], party_role.decoder()),
  ))
  use pvs <- result.try(store.query(
    read,
    "SELECT policy_version_id FROM regulatory_consent_policy_versions WHERE consent_id = ? ORDER BY ord",
    [cid],
    decode.at([0], id.policy_decoder()),
  ))
  use rules <- result.try(store.query(
    read,
    "SELECT rule_id FROM regulatory_consent_rule_ids WHERE consent_id = ? ORDER BY ord",
    [cid],
    decode.at([0], decode.string),
  ))
  use revocation <- result.map(store.one(
    read,
    "SELECT "
      <> revocation_row.columns
      <> " FROM regulatory_consent_revocations WHERE consent_id = ?",
    [cid],
    revocation_row.decoder(),
  ))
  Consent(r, regarding, pvs, rules, option.from_result(revocation))
}

fn where(
  read: Read,
  condition: String,
  args: List(sqlight.Value),
) -> Result(List(Consent), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM regulatory_consents WHERE " <> condition,
    args,
    row.decoder(),
  ))
  list.try_map(rows, load(read, _))
}

pub fn by_id(
  read: Read,
  consent_id: id.ConsentId,
) -> Result(Option(Consent), Fail(e)) {
  where(read, "id = ?", [id.consent_sql(consent_id)])
  |> result.map(fn(ks) { list.first(ks) |> option.from_result })
}

/// The context's consents, oldest first.
pub fn for_context(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(List(Consent), Fail(e)) {
  where(read, "context_id = ? ORDER BY rowid", [
    id.compliance_context_sql(context_id),
  ])
}

/// The agent's consents in the agency, oldest first.
pub fn for_agent(
  read: Read,
  agency: id.OrgId,
  agent: id.OrgUserId,
) -> Result(List(Consent), Fail(e)) {
  where(read, "agency_org_id = ? AND agent_user_id = ? ORDER BY rowid", [
    id.org_sql(agency),
    id.org_user_sql(agent),
  ])
}

/// The consents asked of a party, oldest first.
pub fn for_subject(
  read: Read,
  kind: SubjectKind,
  subject_id: String,
) -> Result(List(Consent), Fail(e)) {
  where(read, "subject_kind = ? AND subject_id = ? ORDER BY rowid", [
    sqlight.text(subject_kind.to_string(kind)),
    sqlight.text(subject_id),
  ])
}

pub fn by_request_key(
  read: Read,
  context_id: id.ComplianceContextId,
  agent: id.OrgUserId,
  key: String,
) -> Result(Option(Consent), Fail(e)) {
  where(read, "context_id = ? AND agent_user_id = ? AND request_key = ?", [
    id.compliance_context_sql(context_id),
    id.org_user_sql(agent),
    sqlight.text(key),
  ])
  |> result.map(fn(ks) { list.first(ks) |> option.from_result })
}

/// The engine's reading of a context's consents.
pub fn engine_consents(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(List(conflict.Consent), Fail(e)) {
  use ks <- result.map(for_context(read, context_id))
  list.map(ks, fn(k) {
    let r = k.row
    conflict.Consent(
      kind: row.kind_to_string(r.kind),
      status: status(k),
      revoked_at: revoked_at(k),
      granted_at: r.granted_at,
      context_id: id.compliance_context_to_string(r.context_id),
      agent_user_id: id.org_user_to_string(r.agent_user_id),
      party_role: Some(r.party_role),
      subject_id: Some(r.subject_id),
      signatory: option.map(r.granted_by_signatory, fn(n) { n == 1 }),
      policy_versions: k.policy_versions,
      full_particulars: r.full_particulars_provided,
      legal_advice: r.legal_advice_offered,
    )
  })
}

fn history(
  tx: Tx,
  consent_id: id.ConsentId,
  action: event_row.Action,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_consent_event(tx))
  use ord <- result.try(
    store.one(
      store.reading(tx),
      "SELECT COALESCE(MAX(ord) + 1, 0) FROM regulatory_consent_history WHERE consent_id = ?",
      [id.consent_sql(consent_id)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        consent_id:,
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

/// A new request, whole, with the parties it regards, the policy versions and the rule it rests on.
pub fn create(
  tx: Tx,
  k: row.Row,
  regarding: List(PartyRole),
  policy_versions: List(id.PolicyId),
  rule_ids: List(String),
  by: By,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(row.insert(tx, k))
  use _ <- result.try(
    list.index_map(regarding, fn(r, i) {
      regarding_row.insert(
        tx,
        regarding_row.new(consent_id: k.id, ord: i, party_role: r),
      )
    })
    |> result.all,
  )
  use _ <- result.try(
    list.index_map(policy_versions, fn(p, i) {
      pv_row.insert(
        tx,
        pv_row.new(consent_id: k.id, ord: i, policy_version_id: p),
      )
    })
    |> result.all,
  )
  use _ <- result.try(
    list.index_map(rule_ids, fn(r, i) {
      rule_row.insert(tx, rule_row.new(consent_id: k.id, ord: i, rule_id: r))
    })
    |> result.all,
  )
  history(tx, k.id, event_row.RegulatoryConsentRequested, by, k.requested_at)
}

/// The party's answer, by a player or a club user.
pub type Answer {
  Grant(signatory: Bool)
  Decline
}

fn bump(
  tx: Tx,
  consent_id: id.ConsentId,
  by: By,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE regulatory_consents SET rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ?",
    [
      sqlight.int(at),
      sqlight.nullable(sqlight.text, by.id),
      sqlight.nullable(sqlight.text, by.name),
      id.consent_sql(consent_id),
    ],
  )
}

fn party_kind(by: By) -> String {
  case by.kind {
    compliance_actor_kind.Player -> "player"
    _ -> "club_user"
  }
}

/// A requested consent is granted or declined, once.
pub fn answer(
  tx: Tx,
  k: Consent,
  answer: Answer,
  by: By,
  key: Option(#(String, String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  let text = sqlight.nullable(sqlight.text, _)
  let org = text(option.map(by.org_id, id.org_to_string))
  let #(sql, args) = case answer {
    Grant(signatory:) -> #(
      "UPDATE regulatory_consents SET status = 'granted', granted_at = ?, granted_by_kind = ?, granted_by_id = ?, granted_by_name = ?, granted_by_org_id = ?, granted_by_signatory = ?, acknowledged_at = ?, grant_key = ?, grant_fp = ? WHERE id = ? AND status = 'requested'",
      [
        sqlight.int(at),
        sqlight.text(party_kind(by)),
        text(by.id),
        text(by.name),
        org,
        case signatory {
          True -> sqlight.int(1)
          False -> sqlight.null()
        },
        sqlight.int(at),
        text(option.map(key, fn(x) { x.0 })),
        text(option.map(key, fn(x) { x.1 })),
        id.consent_sql(k.row.id),
      ],
    )
    Decline -> #(
      "UPDATE regulatory_consents SET status = 'declined', declined_at = ?, declined_by_kind = ?, declined_by_id = ?, declined_by_name = ?, declined_by_org_id = ?, decline_key = ?, decline_fp = ? WHERE id = ? AND status = 'requested'",
      [
        sqlight.int(at),
        sqlight.text(party_kind(by)),
        text(by.id),
        text(by.name),
        org,
        text(option.map(key, fn(x) { x.0 })),
        text(option.map(key, fn(x) { x.1 })),
        id.consent_sql(k.row.id),
      ],
    )
  }
  use rows <- result.try(store.write(
    tx,
    sql <> " RETURNING 1",
    args,
    decode.at([0], decode.int),
  ))
  case rows {
    [] -> store.stale("the consent is no longer requested")
    _ -> {
      use _ <- result.try(bump(tx, k.row.id, by, at))
      history(
        tx,
        k.row.id,
        case answer {
          Grant(..) -> event_row.RegulatoryConsentGranted
          Decline -> event_row.RegulatoryConsentDeclined
        },
        by,
        at,
      )
    }
  }
}

/// The revocation is its own row; the granted row changes only its key, history and rev.
pub fn revoke(
  tx: Tx,
  k: Consent,
  by: By,
  key: Option(#(String, String)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use revocation_id <- result.try(id.next_consent_revocation(tx))
  use _ <- result.try(revocation_row.insert(
    tx,
    revocation_row.Row(
      ..revocation_row.new(
        id: revocation_id,
        consent_id: k.row.id,
        revoked_at: at,
        by_kind: case by.kind {
          compliance_actor_kind.Player -> revocation_row.Player
          _ -> revocation_row.ClubUser
        },
      ),
      by_id: by.id,
      by_name: by.name,
      by_org_id: by.org_id,
    ),
  ))
  use _ <- result.try(case key {
    Some(#(kk, fp)) ->
      store.run(
        tx,
        "UPDATE regulatory_consents SET revoke_key = ?, revoke_fp = ? WHERE id = ?",
        [sqlight.text(kk), sqlight.text(fp), id.consent_sql(k.row.id)],
      )
    None -> Ok(Nil)
  })
  use _ <- result.try(bump(tx, k.row.id, by, at))
  history(tx, k.row.id, event_row.RegulatoryConsentRevoked, by, at)
}
