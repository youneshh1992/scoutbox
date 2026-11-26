//// Compliance contexts as repositories/complianceRecords.mjs keeps them: a transaction workspace's, opened with the
//// transaction and its parties projected from the transaction's, and the agent's own (`agents/context_routes`).
//// Each evaluation is recorded append-only with the reasons, outstanding consents, policy versions and the parties it saw.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/conflict
import scoutbox/agents/reviews
import scoutbox/agents/transaction_rules
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/platform/canonical.{type Value}
import scoutbox/platform/effect
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/compliance_context_history as event_row
import scoutbox/rows/compliance_context_history_policy_versions as event_pv_row
import scoutbox/rows/compliance_context_jurisdictions as jurisdiction_row
import scoutbox/rows/compliance_context_parties as context_party_row
import scoutbox/rows/compliance_context_representations as context_rep_row
import scoutbox/rows/compliance_contexts as context_row
import scoutbox/rows/compliance_evaluation_consents_outstanding as consent_row
import scoutbox/rows/compliance_evaluation_policy_versions as evaluation_pv_row
import scoutbox/rows/compliance_evaluation_reason_items as item_row
import scoutbox/rows/compliance_evaluation_reasons as reason_row
import scoutbox/rows/compliance_evaluation_snapshot_parties as snapshot_party_row
import scoutbox/rows/compliance_evaluation_snapshot_representations as snapshot_rep_row
import scoutbox/rows/compliance_evaluations as evaluation_row
import scoutbox/rows/id
import scoutbox/rows/transaction_parties as party_row
import scoutbox/rows/transaction_representations as rep_row
import scoutbox/vocab/agent_facet.{
  DomesticAuthorisation, FifaLicence, MinorsAuthorisation, NationalRegistration,
}
import scoutbox/vocab/compliance_actor_kind.{type ComplianceActorKind}
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/party_role
import scoutbox/vocab/subject_kind
import sqlight

/// Who acted, as the history rows record them.
pub type By {
  By(
    kind: ComplianceActorKind,
    id: Option(String),
    name: Option(String),
    role: Option(String),
    org_id: Option(id.OrgId),
  )
}

pub type Context {
  Context(
    row: context_row.Row,
    jurisdictions: List(String),
    parties: List(context_party_row.Row),
    representations: List(context_rep_row.Row),
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

fn history(
  tx: Tx,
  context_id: id.ComplianceContextId,
  action: event_row.Action,
  by: By,
  at: Int,
  evaluation_id: Option(id.EvaluationId),
  policy_versions: List(id.PolicyId),
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_context_event(tx))
  use ord <- result.try(next_ord(
    tx,
    event_row.table,
    "context_id",
    id.compliance_context_sql(context_id),
  ))
  use _ <- result.try(event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        context_id:,
        ord:,
        at:,
        by_kind: by.kind,
        action:,
      ),
      by_id: by.id,
      by_name: by.name,
      by_role: by.role,
      by_org_id: by.org_id,
      detail_evaluation_id: evaluation_id,
    ),
  ))
  list.index_map(policy_versions, fn(pv, i) {
    event_pv_row.insert(
      tx,
      event_pv_row.new(history_id: event_id, ord: i, policy_version_id: pv),
    )
  })
  |> result.all
  |> result.replace(Nil)
}

/// What a history entry records beyond its action.
pub type Detail {
  Detail(
    party_role: Option(party_role.PartyRole),
    subject_kind: Option(subject_kind.SubjectKind),
    status: Option(declared_representation_status.DeclaredRepresentationStatus),
    evaluation_id: Option(id.EvaluationId),
    review_id: Option(id.RegulatoryReviewId),
    review_outcome: Option(event_row.DetailReviewOutcome),
    policy_version: Option(id.PolicyId),
  )
}

pub const no_detail = Detail(None, None, None, None, None, None, None)

/// One history entry of an agent's act on a context.
pub fn event(
  tx: Tx,
  context_id: id.ComplianceContextId,
  action: event_row.Action,
  by: By,
  at: Int,
  detail: Detail,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_context_event(tx))
  use ord <- result.try(next_ord(
    tx,
    event_row.table,
    "context_id",
    id.compliance_context_sql(context_id),
  ))
  event_row.insert(
    tx,
    event_row.Row(
      ..event_row.new(
        id: event_id,
        context_id:,
        ord:,
        at:,
        by_kind: by.kind,
        action:,
      ),
      by_id: by.id,
      by_name: by.name,
      by_role: by.role,
      by_org_id: by.org_id,
      detail_party_role: detail.party_role,
      detail_subject_kind: detail.subject_kind,
      detail_status: detail.status,
      detail_evaluation_id: detail.evaluation_id,
      detail_review_id: detail.review_id,
      detail_review_outcome: detail.review_outcome,
      detail_policy_version_id: detail.policy_version,
    ),
  )
}

/// The agent moved the context: its revision and who moved it.
pub fn bump(
  tx: Tx,
  context_id: id.ComplianceContextId,
  user_id: id.OrgUserId,
  name: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE compliance_contexts SET rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ?",
    [
      sqlight.int(at),
      id.org_user_sql(user_id),
      sqlight.text(name),
      id.compliance_context_sql(context_id),
    ],
  )
}

/// The agent's own open contexts and closed ones, oldest first.
pub fn for_agent(
  read: Read,
  agency: id.OrgId,
  agent: id.OrgUserId,
) -> Result(List(Context), Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT id FROM compliance_contexts WHERE agency_org_id = ? AND agent_user_id = ? ORDER BY rowid",
    [id.org_sql(agency), id.org_user_sql(agent)],
    decode.at([0], id.compliance_context_decoder()),
  ))
  list.try_map(ids, by_id(read, _)) |> result.map(option.values)
}

/// The agent's context created under `key`.
pub fn by_create_key(
  read: Read,
  agency: id.OrgId,
  agent: id.OrgUserId,
  key: String,
) -> Result(Option(Context), Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT id FROM compliance_contexts WHERE agency_org_id = ? AND agent_user_id = ? AND create_key = ?",
    [id.org_sql(agency), id.org_user_sql(agent), sqlight.text(key)],
    decode.at([0], id.compliance_context_decoder()),
  ))
  case ids {
    [] -> Ok(None)
    [cid, ..] -> by_id(read, cid)
  }
}

/// A transaction's context, opened with it. Its history names the policy versions that applied.
pub fn open(
  tx: Tx,
  agency_org_id: id.OrgId,
  agent_user_id: id.OrgUserId,
  type_: ContextType,
  jurisdictions: List(String),
  transaction_id: id.TransactionId,
  policy_versions: List(id.PolicyId),
  by: By,
  at: Int,
) -> Result(id.ComplianceContextId, Fail(e)) {
  open_context(
    tx,
    agency_org_id,
    agent_user_id,
    type_,
    jurisdictions,
    Some(transaction_id),
    None,
    policy_versions,
    by,
    at,
  )
}

/// A context: a transaction's (`transaction_id`), or the agent's own, with the client key it was created under.
pub fn open_context(
  tx: Tx,
  agency_org_id: id.OrgId,
  agent_user_id: id.OrgUserId,
  type_: ContextType,
  jurisdictions: List(String),
  transaction_id: Option(id.TransactionId),
  create_key: Option(#(String, String)),
  policy_versions: List(id.PolicyId),
  by: By,
  at: Int,
) -> Result(id.ComplianceContextId, Fail(e)) {
  use context_id <- result.try(id.next_compliance_context(tx))
  use _ <- result.try(context_row.insert(
    tx,
    context_row.Row(
      ..context_row.new(
        id: context_id,
        agency_org_id:,
        agent_user_id:,
        type_:,
        status: context_row.Open,
        re_evaluation_pending: False,
        opened_at: at,
        rev: 1,
      ),
      origin: option.map(transaction_id, fn(_) { "transaction" }),
      transaction_id:,
      create_key: option.map(create_key, fn(k) { k.0 }),
      create_fp: option.map(create_key, fn(k) { k.1 }),
      rev_at: Some(at),
    ),
  ))
  use _ <- result.try(
    list.index_map(jurisdictions, fn(ma, i) {
      jurisdiction_row.insert(
        tx,
        jurisdiction_row.new(context_id:, ord: i, member_association: ma),
      )
    })
    |> result.all,
  )
  use _ <- result.map(history(
    tx,
    context_id,
    event_row.ComplianceContextOpened,
    by,
    at,
    None,
    policy_versions,
  ))
  context_id
}

pub fn by_id(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(Option(Context), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> context_row.columns <> " FROM compliance_contexts WHERE id = ?",
    [id.compliance_context_sql(context_id)],
    context_row.decoder(),
  ))
  case rows {
    [] -> Ok(None)
    [row, ..] -> {
      use jurisdictions <- result.try(store.query(
        read,
        "SELECT member_association FROM compliance_context_jurisdictions WHERE context_id = ? ORDER BY ord",
        [id.compliance_context_sql(context_id)],
        decode.at([0], decode.string),
      ))
      use parties <- result.try(store.query(
        read,
        "SELECT "
          <> context_party_row.columns
          <> " FROM compliance_context_parties WHERE context_id = ? ORDER BY ord",
        [id.compliance_context_sql(context_id)],
        context_party_row.decoder(),
      ))
      use reps <- result.map(store.query(
        read,
        "SELECT "
          <> context_rep_row.columns
          <> " FROM compliance_context_representations WHERE context_id = ? ORDER BY ord",
        [id.compliance_context_sql(context_id)],
        context_rep_row.decoder(),
      ))
      Some(Context(row, jurisdictions, parties, reps))
    }
  }
}

/// The engine's input is rebuilt from the transaction's own parties and live bindings every time, so it cannot go
/// stale.
pub fn project(
  tx: Tx,
  context_id: id.ComplianceContextId,
  parties: List(party_row.Row),
  reps: List(rep_row.Row),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(project_parties(tx, context_id, parties))
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM compliance_context_representations WHERE context_id = ?",
      [id.compliance_context_sql(context_id)],
    ),
  )
  list.index_map(reps, fn(r, i) {
    context_rep_row.insert(
      tx,
      context_rep_row.Row(
        ..context_rep_row.new(
          context_id:,
          ord: i,
          id: r.id,
          agent_user_id: r.agent_user_id,
          party_role: r.party_role,
          status: r.status,
          declared_only: r.declared_only,
        ),
        agreement_id: r.agreement_id,
        review_id: r.review_id,
        first_act_at: r.first_act_at,
      ),
    )
  })
  |> result.all
  |> result.replace(Nil)
}

fn project_parties(
  tx: Tx,
  context_id: id.ComplianceContextId,
  parties: List(party_row.Row),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM compliance_context_parties WHERE context_id = ?",
      [
        id.compliance_context_sql(context_id),
      ],
    ),
  )
  list.index_map(parties, fn(p, i) {
    context_party_row.insert(
      tx,
      context_party_row.Row(
        ..context_party_row.new(
          context_id:,
          ord: i,
          id: p.id,
          party_role: p.party_role,
          subject_kind: p.subject_kind,
          subject_id: p.subject_id,
          removed: p.removed,
        ),
        added_at: Some(p.added_at),
        removed_at: case p.removed {
          True -> p.removed_at
          False -> None
        },
      ),
    )
  })
  |> result.all
  |> result.replace(Nil)
}

/// An agent's effective facet states, as `facetStatesOf` gives them: the FIFA licence, and each national facet
/// by member association. A licence change moves the party revision.
pub fn facet_states(p: agent_rules.Profile, now: Int) -> Value {
  let state = fn(row) {
    canonical.Str(
      facet_state.to_string(agent_rules.effective_facet_state(row, now)),
    )
  }
  let by_ma = fn(facet) {
    canonical.Object(
      agent_rules.facets_by_association(p, facet)
      |> list.map(fn(f) { #(jurisdiction.to_string(f.0), state(Some(f.1))) }),
    )
  }
  canonical.Object([
    #("fifa_licence", state(agent_rules.facet_of(p, FifaLicence, None))),
    #("national_registration", by_ma(NationalRegistration)),
    #("domestic_authorisation", by_ma(DomesticAuthorisation)),
    #("minors_authorisation", by_ma(MinorsAuthorisation)),
  ])
}

fn rep_input(
  r: context_rep_row.Row,
  via_colleague: Bool,
) -> conflict.Representation {
  let pending = r.status == declared_representation_status.PendingReview
  conflict.Representation(
    agent_user_id: id.org_user_to_string(r.agent_user_id),
    party_role: r.party_role,
    agreement_id: option.map(r.agreement_id, id.agreement_to_string),
    declared_only: pending,
    status: case pending {
      True -> "declared"
      False -> declared_representation_status.to_string(r.status)
    },
    first_act_at: r.first_act_at,
    via_colleague:,
  )
}

/// Two contexts describe the same real-world transaction when they name the same individual and the same
/// entities.
fn same_transaction(a: Context, b: Context) -> Bool {
  let live = fn(c: Context) { list.filter(c.parties, fn(p) { !p.removed }) }
  let key = fn(c) {
    live(c)
    |> list.map(fn(p) {
      party_role.to_string(p.party_role) <> ":" <> p.subject_id
    })
    |> list.sort(string.compare)
    |> string.join("|")
  }
  let individual = fn(c) {
    list.find(live(c), fn(p) { p.party_role == party_role.Individual })
    |> result.map(fn(p) { p.subject_id })
  }
  case individual(a), individual(b) {
    Ok(ia), Ok(ib) if ia == ib ->
      key(a) == key(b)
      || list.all(live(a), fn(p) {
        list.any(live(b), fn(q) {
          q.party_role == p.party_role && q.subject_id == p.subject_id
        })
      })
    _, _ -> False
  }
}

fn open_for_agency_except(
  read: Read,
  agency: id.OrgId,
  except: id.ComplianceContextId,
) -> Result(List(Context), Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT id FROM compliance_contexts WHERE agency_org_id = ? AND status = 'open' AND id <> ? ORDER BY rowid",
    [id.org_sql(agency), id.compliance_context_sql(except)],
    decode.at([0], id.compliance_context_decoder()),
  ))
  list.try_map(ids, by_id(read, _))
  |> result.map(option.values)
}

/// The engine's input for a context, from live records. A party who left, or whom the agency can no longer see,
/// is removed from the evaluation, so a regulatory clear never overrides safety. A colleague's verified
/// representation in the same transaction (another open context of the agency naming the same parties) is
/// attributed to the opener (connected agents); reasons never name the colleague.
pub fn engine_input(
  read: Read,
  c: Context,
  policies: List(approach_policy.Policy),
  now: Int,
  proposed: Option(conflict.Representation),
  consents: List(conflict.Consent),
) -> Result(conflict.Input, Fail(e)) {
  let opener = c.row.agent_user_id
  use agency <- result.try(orgs.by_id(read, c.row.agency_org_id))
  use members <- result.try(agent_store.affiliations_for_agency(
    read,
    c.row.agency_org_id,
  ))
  let colleagues =
    members
    |> list.filter(fn(a) {
      a.row.user_id != opener && agent_rules.active(a, now)
    })
    |> list.map(fn(a) { id.org_user_to_string(a.row.user_id) })
  let own =
    c.representations
    |> list.filter(fn(r) {
      r.status != declared_representation_status.Withdrawn
    })
    |> list.map(rep_input(_, False))
    |> list.append(option.values([proposed]))
  use others <- result.try(open_for_agency_except(
    read,
    c.row.agency_org_id,
    c.row.id,
  ))
  let attributed =
    others
    |> list.filter(fn(o) {
      list.contains(colleagues, id.org_user_to_string(o.row.agent_user_id))
      && same_transaction(c, o)
    })
    |> list.flat_map(fn(o) {
      o.representations
      |> list.filter(fn(r) {
        r.status == declared_representation_status.Verified
        && r.agent_user_id != opener
      })
      |> list.map(rep_input(_, True))
    })
  let reps = list.append(own, attributed)
  let opener_text = id.org_user_to_string(opener)
  let agent_ids =
    list.unique([opener_text, ..list.map(reps, fn(r) { r.agent_user_id })])
  use agents <- result.try(
    list.try_map(agent_ids, fn(agent_id) {
      let user = id.org_user(agent_id)
      use affiliation <- result.try(agent_store.active_affiliation(
        read,
        user,
        c.row.agency_org_id,
        now,
      ))
      use profile <- result.map(agent_store.profile_for_user(read, user))
      let licence = case affiliation, profile {
        Some(_), Some(p) ->
          facet_state.to_string(agent_rules.effective_facet_state(
            agent_rules.facet_of(p, FifaLicence, None),
            now,
          ))
        Some(_), None -> facet_state.to_string(facet_state.Unverified)
        None, _ -> "NO_AFFILIATION"
      }
      let connected =
        list.filter(colleagues, fn(x) { x != agent_id })
        |> list.append(case agent_id == opener_text {
          True -> []
          False -> [opener_text]
        })
      #(agent_id, conflict.Agent(licence, connected))
    }),
  )
  use parties <- result.try(
    list.try_map(c.parties, fn(p) {
      case p.subject_kind {
        subject_kind.Player -> {
          use found <- result.map(case agency {
            Some(org) ->
              players.for_org(read, id.player(p.subject_id), org, now)
            None -> Ok(None)
          })
          let #(gone, minor) = case found {
            Some(#(player, access)) -> #(
              !access.visible || access.blocked,
              !players.is_adult(player, now),
            )
            None -> #(True, False)
          }
          conflict.Party(
            p.party_role,
            p.subject_kind,
            p.subject_id,
            p.removed || gone,
            minor,
          )
        }
        subject_kind.Club -> {
          use org <- result.map(orgs.by_id(read, id.org(p.subject_id)))
          conflict.Party(
            p.party_role,
            p.subject_kind,
            p.subject_id,
            p.removed || org == None,
            False,
          )
        }
      }
    }),
  )
  let set = approach_policy.applicable(policies, c.jurisdictions, now)
  Ok(conflict.Input(
    context_id: id.compliance_context_to_string(c.row.id),
    context_type: c.row.type_,
    jurisdictions: c.jurisdictions,
    parties:,
    representations: reps,
    evaluate_agent_user_ids: [opener_text],
    agents:,
    consents:,
    policies: set.policies,
    missing: set.missing,
    now:,
  ))
}

/// The context closes, and its open review items are cancelled with it.
pub fn close(tx: Tx, c: Context, by: By, at: Int) -> Result(Nil, Fail(e)) {
  case c.row.status {
    context_row.Closed -> Ok(Nil)
    context_row.Open -> {
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE compliance_contexts SET status = 'closed', closed_at = ? WHERE id = ?",
          [sqlight.int(at), id.compliance_context_sql(c.row.id)],
        ),
      )
      use _ <- result.try(
        history(
          tx,
          c.row.id,
          event_row.ComplianceContextClosed,
          by,
          at,
          None,
          [],
        ),
      )
      use open <- result.try(store.query(
        store.reading(tx),
        "SELECT id FROM regulatory_reviews WHERE subject_context_id = ? AND status IN ('PENDING','IN_REVIEW') ORDER BY rowid",
        [id.compliance_context_sql(c.row.id)],
        decode.at([0], id.regulatory_review_decoder()),
      ))
      list.try_each(open, fn(review_id) {
        reviews.cancel(tx, review_id, by.kind, by.id, by.name, at)
      })
    }
  }
}

/// Records an evaluation of the context (append-only), with the parties it saw and the history entry that says
/// so; the re-evaluation flag clears. Returns its id (`<context>#<position>`).
pub fn record_evaluation(
  tx: Tx,
  c: Context,
  e: conflict.Evaluation,
  proposed: Option(#(party_role.PartyRole, id.OrgUserId)),
  by: By,
  at: Int,
) -> Result(id.EvaluationId, Fail(e)) {
  let context_id = c.row.id
  use position <- result.try(
    store.one(
      store.reading(tx),
      "SELECT COALESCE(MAX(position), 0) + 1 FROM compliance_evaluations WHERE context_id = ?",
      [id.compliance_context_sql(context_id)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 1)),
  )
  let evaluation_id =
    id.evaluation(
      id.compliance_context_to_string(context_id)
      <> "#"
      <> int.to_string(position),
    )
  use _ <- result.try(evaluation_row.insert(
    tx,
    evaluation_row.Row(
      ..evaluation_row.new(
        id: evaluation_id,
        context_id:,
        position:,
        outcome: e.outcome,
        evaluated_at: e.evaluated_at,
        input_hash: e.input_hash,
      ),
      proposed_party_role: option.map(proposed, fn(p) { p.0 }),
      proposed_agent_user_id: option.map(proposed, fn(p) { p.1 }),
    ),
  ))
  use _ <- result.try(
    list.index_map(e.reasons, fn(r, ord) { reason(tx, evaluation_id, ord, r) })
    |> result.all,
  )
  use _ <- result.try(
    list.index_map(e.consents_outstanding, fn(o, ord) {
      consent_row.insert(
        tx,
        consent_row.Row(
          ..consent_row.new(
            evaluation_id:,
            ord:,
            party_role: o.party_role,
            consent_kind: consent_row.DualRepresentation,
            reason_code: o.reason_code,
          ),
          agent_user_id: Some(id.org_user(o.agent_user_id)),
        ),
      )
    })
    |> result.all,
  )
  use _ <- result.try(
    list.index_map(e.policy_versions, fn(pv, ord) {
      evaluation_pv_row.insert(
        tx,
        evaluation_pv_row.new(evaluation_id:, ord:, policy_version_id: pv),
      )
    })
    |> result.all,
  )
  use _ <- result.try(
    list.index_map(c.parties, fn(p, ord) {
      snapshot_party_row.insert(
        tx,
        snapshot_party_row.new(
          evaluation_id:,
          ord:,
          party_role: p.party_role,
          subject_kind: p.subject_kind,
          subject_id: p.subject_id,
        ),
      )
    })
    |> result.all,
  )
  use _ <- result.try(
    list.index_map(c.representations, fn(r, ord) {
      snapshot_rep_row.insert(
        tx,
        snapshot_rep_row.new(
          evaluation_id:,
          ord:,
          agent_user_id: r.agent_user_id,
          party_role: r.party_role,
          status: r.status,
        ),
      )
    })
    |> result.all,
  )
  use _ <- result.try(
    history(
      tx,
      context_id,
      event_row.ComplianceContextEvaluated,
      by,
      at,
      Some(evaluation_id),
      [],
    ),
  )
  use _ <- result.map(
    store.run(
      tx,
      "UPDATE compliance_contexts SET re_evaluation_pending = 0 WHERE id = ?",
      [id.compliance_context_sql(context_id)],
    ),
  )
  store.emit(
    tx,
    effect.Live(live_event.ConflictEvaluated(
      org_id: id.org_to_string(c.row.agency_org_id),
      ctx_id: id.compliance_context_to_string(context_id),
      outcome: context_outcome.to_string(e.outcome),
    )),
  )
  evaluation_id
}

fn reason(
  tx: Tx,
  evaluation_id: id.EvaluationId,
  ord: Int,
  r: conflict.Reason,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(reason_row.insert(
    tx,
    reason_row.Row(
      ..reason_row.new(evaluation_id:, ord:, code: r.code),
      rule_id: r.rule_id,
      rule_status: Some(r.rule_status),
      regulator: r.regulator,
      jurisdiction: r.jurisdiction,
      policy_version_id: r.policy_version,
      state: r.state,
      agent_user_id: option.map(r.agent_user_id, id.org_user),
      party_role: option.map(r.party_role, party_role.to_string),
      override_rule_id: r.override_rule_id,
      via_connected_agent: case r.via_connected_agent {
        True -> Some(1)
        False -> None
      },
      has_party_roles: option.is_some(r.party_roles),
      has_jurisdictions: option.is_some(r.jurisdictions),
    ),
  ))
  let items = fn(which, values: List(String)) {
    list.index_map(values, fn(v, i) {
      item_row.insert(
        tx,
        item_row.new(
          evaluation_id:,
          reason_ord: ord,
          list: which,
          ord: i,
          value: v,
        ),
      )
    })
  }
  [
    items(
      item_row.Partyroles,
      option.unwrap(r.party_roles, []) |> list.map(party_role.to_string),
    ),
    items(item_row.Jurisdictions, option.unwrap(r.jurisdictions, [])),
  ]
  |> list.flatten
  |> result.all
  |> result.replace(Nil)
}

/// What a transaction's snapshot names, read back from the evaluation row.
pub fn evaluated(
  read: Read,
  evaluation_id: id.EvaluationId,
) -> Result(Option(transaction_rules.Evaluated), Fail(e)) {
  let eid = id.evaluation_sql(evaluation_id)
  use found <- result.try(store.query(
    read,
    "SELECT outcome FROM compliance_evaluations WHERE id = ?",
    [eid],
    decode.at([0], context_outcome.decoder()),
  ))
  case found {
    [] -> Ok(None)
    [outcome, ..] -> {
      use codes <- result.try(store.query(
        read,
        "SELECT code FROM compliance_evaluation_reasons WHERE evaluation_id = ? ORDER BY ord",
        [eid],
        decode.at([0], decode.string),
      ))
      use consents <- result.try(
        store.query(
          read,
          "SELECT party_role, agent_user_id, consent_kind, reason_code FROM compliance_evaluation_consents_outstanding WHERE evaluation_id = ? ORDER BY ord",
          [eid],
          {
            use role <- decode.field(0, party_role.decoder())
            use agent <- decode.field(1, decode.optional(decode.string))
            use kind <- decode.field(2, decode.string)
            use code <- decode.field(3, decode.string)
            decode.success(conflict.ConsentOutstanding(
              role,
              option.unwrap(agent, ""),
              kind,
              code,
            ))
          },
        ),
      )
      use versions <- result.map(store.query(
        read,
        "SELECT policy_version_id FROM compliance_evaluation_policy_versions WHERE evaluation_id = ? ORDER BY ord",
        [eid],
        decode.at([0], id.policy_decoder()),
      ))
      Some(transaction_rules.Evaluated(outcome, codes, consents, versions))
    }
  }
}

/// The policy versions the context's latest evaluation applied, which the party revision hashes.
pub fn last_policy_versions(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(List(id.PolicyId), Fail(e)) {
  store.query(
    read,
    "SELECT v.policy_version_id FROM compliance_evaluation_policy_versions v WHERE v.evaluation_id = (SELECT id FROM compliance_evaluations WHERE context_id = ? ORDER BY position DESC LIMIT 1) ORDER BY v.ord",
    [id.compliance_context_sql(context_id)],
    decode.at([0], id.policy_decoder()),
  )
}

pub fn re_evaluation_pending(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT re_evaluation_pending FROM compliance_contexts WHERE id = ?",
    [id.compliance_context_sql(context_id)],
    decode.at([0], decode.int),
  )
  |> result.map(fn(r) { r == Ok(1) })
}

// ------------------------------------------------------------------------------------------------- the seam

/// Why the facet gate refuses a regulated act before the engine runs.
pub type GateProblem {
  /// The agent has no profile (AGENT_VERIFICATION_REQUIRED).
  NoProfile
  /// A facet the policy makes mandatory is not VERIFIED.
  FacetMissing(approach_policy.FacetGap)
  /// No encoded policy covers a jurisdiction (JURISDICTION_UNSUPPORTED).
  Unsupported(
    reasons: List(approach_policy.Reason),
    policy_versions: List(id.PolicyId),
  )
}

fn declare(
  read: Read,
  agent: id.OrgUserId,
  mas: List(String),
  now: Int,
) -> Result(Option(#(approach_policy.Decision, List(id.PolicyId))), Fail(e)) {
  use profile <- result.try(agent_store.profile_for_user(read, agent))
  use policies <- result.map(approach_policy.published(read))
  use p <- option.map(profile)
  let set = approach_policy.applicable(policies, mas, now)
  #(
    approach_policy.declare_representation(
      set,
      mas,
      fn(facet, ma) {
        agent_rules.effective_facet_state(
          agent_rules.facet_of(p, facet, ma),
          now,
        )
      },
      now,
    ),
    list.map(set.policies, approach_policy.policy_id),
  )
}

/// `facetGateProblem`: the first refusal declaring a representation in these jurisdictions would meet, or none.
pub fn facet_gate(
  read: Read,
  agent: id.OrgUserId,
  mas: List(String),
  now: Int,
) -> Result(Option(GateProblem), Fail(e)) {
  use decided <- result.map(declare(read, agent, mas, now))
  case decided {
    None -> Some(NoProfile)
    Some(#(d, versions)) ->
      case d.facet_gaps {
        [gap, ..] -> Some(FacetMissing(gap))
        [] -> {
          let unencoded =
            list.filter(d.reasons, fn(r) { r.code == "POLICY_NOT_ENCODED" })
          case d.requires_manual_review && unencoded != [] {
            True -> Some(Unsupported(unencoded, versions))
            False -> None
          }
        }
      }
  }
}

/// `clearFor` with `declare_representation`: may this agent, under the policy in force now, declare a
/// representation in this jurisdiction? No profile, or no jurisdiction, is not clear.
pub fn clear_to_declare(
  read: Read,
  agent: id.OrgUserId,
  ma: String,
  now: Int,
) -> Result(Bool, Fail(e)) {
  case ma {
    "" -> Ok(False)
    _ -> {
      use decided <- result.map(declare(read, agent, [ma], now))
      case decided {
        Some(#(d, _)) -> approach_policy.allowed(d)
        None -> False
      }
    }
  }
}

/// A player's account removal: every context naming them keeps the party as an id-only removed party (with its
/// history entry) and loses the player's name from its history; every consent asking them, its answers, revocation
/// and history lose the person.
pub fn forget_player(
  tx: Tx,
  player_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let p = sqlight.text(player_id)
  use touched <- result.try(store.query(
    store.reading(tx),
    "SELECT DISTINCT context_id FROM compliance_context_parties WHERE subject_kind = 'player' AND subject_id = ? AND removed = 0 ORDER BY context_id",
    [p],
    decode.at([0], id.compliance_context_decoder()),
  ))
  use _ <- result.try(
    list.try_each(touched, fn(context_id) {
      let c = id.compliance_context_sql(context_id)
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE compliance_context_parties SET removed = 1, removed_at = ? WHERE context_id = ? AND subject_kind = 'player' AND subject_id = ? AND removed = 0",
          [sqlight.int(at), c, p],
        ),
      )
      use event_id <- result.try(id.next_context_event(tx))
      use ord <- result.try(next_ord(tx, event_row.table, "context_id", c))
      use _ <- result.try(event_row.insert(
        tx,
        event_row.Row(
          ..event_row.new(
            id: event_id,
            context_id:,
            ord:,
            at:,
            by_kind: compliance_actor_kind.System,
            action: event_row.ComplianceContextPartyRemoved,
          ),
          by_name: Some("account deletion"),
          detail_party_role: Some(party_role.Individual),
        ),
      ))
      store.run(
        tx,
        "UPDATE compliance_context_history SET by_id = NULL, by_name = NULL WHERE context_id = ? AND by_kind = 'player'",
        [c],
      )
    }),
  )
  let sub =
    "SELECT id FROM regulatory_consents WHERE subject_kind = 'player' AND subject_id = ?"
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE regulatory_consents SET granted_by_id = CASE WHEN granted_by_kind = 'player' THEN NULL ELSE granted_by_id END, granted_by_name = CASE WHEN granted_by_kind = 'player' THEN NULL ELSE granted_by_name END, declined_by_id = CASE WHEN declined_by_kind = 'player' THEN NULL ELSE declined_by_id END, declined_by_name = CASE WHEN declined_by_kind = 'player' THEN NULL ELSE declined_by_name END WHERE id IN ("
        <> sub
        <> ")",
      [p],
    ),
  )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE regulatory_consent_revocations SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND consent_id IN ("
        <> sub
        <> ")",
      [p],
    ),
  )
  store.run(
    tx,
    "UPDATE regulatory_consent_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND consent_id IN ("
      <> sub
      <> ")",
    [p],
  )
}
