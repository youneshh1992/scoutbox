//// Compliance contexts as repositories/complianceRecords.mjs keeps them, as far as a transaction workspace uses
//// one: opened with the transaction, its parties projected from the transaction's, and each evaluation recorded
//// append-only with the reasons, outstanding consents, policy versions and the parties it saw.
////
//// Not ported yet: representations in a context (`/agent/transactions/:id/representations`), regulatory consents
//// (the consent routes) and the agent's own context routes, so a context here has no representation or consent.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/conflict
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
import scoutbox/rows/compliance_contexts as context_row
import scoutbox/rows/compliance_evaluation_consents_outstanding as consent_row
import scoutbox/rows/compliance_evaluation_policy_versions as evaluation_pv_row
import scoutbox/rows/compliance_evaluation_reason_items as item_row
import scoutbox/rows/compliance_evaluation_reasons as reason_row
import scoutbox/rows/compliance_evaluation_snapshot_parties as snapshot_party_row
import scoutbox/rows/compliance_evaluations as evaluation_row
import scoutbox/rows/id
import scoutbox/rows/transaction_parties as party_row
import scoutbox/vocab/agent_facet.{
  DomesticAuthorisation, FifaLicence, MinorsAuthorisation, NationalRegistration,
}
import scoutbox/vocab/compliance_actor_kind.{type ComplianceActorKind}
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type.{type ContextType}
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
  policy_versions: List(String),
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

/// A transaction's context, opened with it. Its history names the policy versions that applied.
pub fn open(
  tx: Tx,
  agency_org_id: id.OrgId,
  agent_user_id: id.OrgUserId,
  type_: ContextType,
  jurisdictions: List(String),
  transaction_id: id.TransactionId,
  policy_versions: List(String),
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
      origin: Some("transaction"),
      transaction_id: Some(transaction_id),
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
      use parties <- result.map(store.query(
        read,
        "SELECT "
          <> context_party_row.columns
          <> " FROM compliance_context_parties WHERE context_id = ? ORDER BY ord",
        [id.compliance_context_sql(context_id)],
        context_party_row.decoder(),
      ))
      Some(Context(row, jurisdictions, parties))
    }
  }
}

/// The engine's input is rebuilt from the transaction's own parties every time, so it cannot go stale.
pub fn project(
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

/// The engine's input for a context, from live records. A party who left, or whom the agency can no longer see,
/// is removed from the evaluation, so a regulatory clear never overrides safety. Colleagues in the agency are the
/// opener's connected agents; their own contexts carry no representations here, so none is attributed.
pub fn engine_input(
  read: Read,
  c: Context,
  policies: List(approach_policy.Policy),
  now: Int,
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
  use affiliation <- result.try(agent_store.active_affiliation(
    read,
    opener,
    c.row.agency_org_id,
    now,
  ))
  use profile <- result.try(agent_store.profile_for_user(read, opener))
  let licence = case affiliation, profile {
    Some(_), Some(p) ->
      facet_state.to_string(agent_rules.effective_facet_state(
        agent_rules.facet_of(p, FifaLicence, None),
        now,
      ))
    Some(_), None -> facet_state.to_string(facet_state.Unverified)
    None, _ -> "NO_AFFILIATION"
  }
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
              !access.visible,
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
    representations: [],
    evaluate_agent_user_ids: [id.org_user_to_string(opener)],
    agents: [
      #(id.org_user_to_string(opener), conflict.Agent(licence, colleagues)),
    ],
    consents: [],
    policies: set.policies,
    missing: set.missing,
    now:,
  ))
}

/// Records an evaluation of the context (append-only), with the parties it saw and the history entry that says
/// so; the re-evaluation flag clears. Returns its id (`<context>#<position>`).
pub fn record_evaluation(
  tx: Tx,
  c: Context,
  e: conflict.Evaluation,
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
    evaluation_row.new(
      id: evaluation_id,
      context_id:,
      position:,
      outcome: e.outcome,
      evaluated_at: e.evaluated_at,
      input_hash: e.input_hash,
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
        evaluation_pv_row.new(
          evaluation_id:,
          ord:,
          policy_version_id: id.policy(pv),
        ),
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
      policy_version_id: option.map(r.policy_version, id.policy),
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
        decode.at([0], decode.string),
      ))
      Some(transaction_rules.Evaluated(outcome, codes, consents, versions))
    }
  }
}

/// The policy versions the context's latest evaluation applied, which the party revision hashes.
pub fn last_policy_versions(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    "SELECT v.policy_version_id FROM compliance_evaluation_policy_versions v WHERE v.evaluation_id = (SELECT id FROM compliance_evaluations WHERE context_id = ? ORDER BY position DESC LIMIT 1) ORDER BY v.ord",
    [id.compliance_context_sql(context_id)],
    decode.at([0], decode.string),
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
    policy_versions: List(String),
  )
}

fn declare(
  read: Read,
  agent: id.OrgUserId,
  mas: List(String),
  now: Int,
) -> Result(Option(#(approach_policy.Decision, List(String))), Fail(e)) {
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
