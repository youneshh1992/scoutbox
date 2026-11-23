//// An agent's own compliance contexts (domains/agents/compliance/contextRoutes.mjs): the parties, the
//// representations declared in them and their conflict evaluation. A context is a minimal record for conflict
//// evaluation, never a Transaction Room. Another agent's context is concealed: it answers CONTEXT_NOT_FOUND.

import gleam/bool
import gleam/dynamic.{type Dynamic}
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_routes as compliance
import scoutbox/agents/compliance_store.{type By, type Context}
import scoutbox/agents/conflict
import scoutbox/agents/consent_store
import scoutbox/agents/context_view
import scoutbox/agents/core_routes
import scoutbox/agents/reviews
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/agreement_scopes as agreement_scope_row
import scoutbox/rows/compliance_context_history as event_row
import scoutbox/rows/compliance_context_parties as party_row
import scoutbox/rows/compliance_context_representations as rep_row
import scoutbox/rows/compliance_contexts as context_row
import scoutbox/rows/id
import scoutbox/rows/regulatory_reviews as review_row
import scoutbox/vocab/agreement_status
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type.{type ContextType}
import scoutbox/vocab/declared_representation_status as rep_status
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/org_type
import scoutbox/vocab/party_role.{type PartyRole}
import scoutbox/vocab/subject_kind.{type SubjectKind}
import sqlight
import wisp.{type Request, type Response}

const jurisdictions_max = 10

const parties_max = 6

fn by_agent(a: OrgAccess) -> By {
  compliance_store.By(
    kind: compliance_actor_kind.Org,
    id: Some(id.org_user_to_string(a.user.id)),
    name: Some(a.user.name),
    role: None,
    org_id: None,
  )
}

fn context_json(read: Read, c: Context, now: Int) -> Result(Json, Fail(e)) {
  context_view.for_agent(read, c, now)
}

/// `ownContext`: the member's own context, with the capability the act needs; anyone else's is concealed.
fn own_context(
  ctx: Ctx,
  a: OrgAccess,
  context_id: String,
  write: Bool,
  next: fn(core_routes.Member, Context) -> Response,
) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, case write {
    True -> "compliance.contexts.write"
    False -> "compliance.read"
  })
  use found <- compliance.reading(ctx, compliance_store.by_id(
    _,
    id.compliance_context(context_id),
  ))
  case found {
    Some(c)
      if c.row.agency_org_id == a.org.id && c.row.agent_user_id == a.user.id
    -> next(m, c)
    _ -> compliance.bare("CONTEXT_NOT_FOUND", [])
  }
}

/// The context as stored now, inside the unit; a context another request moved first re-runs the route.
fn fresh(tx: Tx, c: Context) -> Result(Context, Fail(Response)) {
  use found <- result.try(
    compliance_store.by_id(store.reading(tx), c.row.id) |> compliance.storage,
  )
  case found {
    Some(now) if now.row.rev == c.row.rev && now.row.status == c.row.status ->
      Ok(now)
    _ -> store.stale("a compliance context")
  }
}

/// Re-evaluates the context and records it; the stored evaluation.
fn evaluate_and_record(
  tx: Tx,
  c: Context,
  by: By,
  proposed: Option(conflict.Representation),
  now: Int,
) -> Result(#(conflict.Evaluation, context_view.Evaluation), Fail(Response)) {
  let read = store.reading(tx)
  use found <- result.try(
    compliance_store.by_id(read, c.row.id) |> compliance.storage,
  )
  let c = option.unwrap(found, c)
  use policies <- result.try(
    approach_policy.published(read) |> compliance.storage,
  )
  use consents <- result.try(
    consent_store.engine_consents(read, c.row.id) |> compliance.storage,
  )
  use input <- result.try(
    compliance_store.engine_input(read, c, policies, now, proposed, consents)
    |> compliance.storage,
  )
  let result = conflict.evaluate(input)
  use evaluation_id <- result.try(
    compliance_store.record_evaluation(
      tx,
      c,
      result,
      option.map(proposed, fn(p) {
        #(p.party_role, id.org_user(p.agent_user_id))
      }),
      by,
      now,
    )
    |> compliance.storage,
  )
  use stored <- result.try(
    context_view.evaluation(read, evaluation_id) |> compliance.storage,
  )
  let assert Some(stored) = stored as "an evaluation just recorded"
  Ok(#(result, stored))
}

fn bump(tx: Tx, c: Context, a: OrgAccess, now: Int) -> Result(Nil, Fail(e)) {
  compliance_store.bump(tx, c.row.id, a.user.id, a.user.name, now)
}

/// The context and an evaluation, as the routes answer them.
fn answer(
  tx: Tx,
  status: Int,
  context_id: id.ComplianceContextId,
  evaluation: Option(context_view.Evaluation),
  extra: List(#(String, Json)),
  now: Int,
) -> Result(Response, Fail(Response)) {
  let read = store.reading(tx)
  use found <- result.try(
    compliance_store.by_id(read, context_id) |> compliance.storage,
  )
  let assert Some(c) = found as "the context acted on"
  use view <- result.map(context_json(read, c, now) |> compliance.storage)
  http.json(
    status,
    json.object(
      list.flatten([
        [#("context", view)],
        extra,
        case evaluation {
          Some(e) -> [#("evaluation", context_view.evaluation_json(e))]
          None -> []
        },
      ]),
    ),
  )
}

fn rev_of(c: Context) -> rev.Rev {
  rev.Rev(c.row.rev, c.row.rev_at, c.row.rev_by_name)
}

// ------------------------------------------------------------------------------------------------- parties

type PartyInput {
  PartyInput(role: PartyRole, kind: SubjectKind, subject_id: String)
}

fn party_fields(next: fn(PartyInput) -> input.Shape(a)) -> input.Shape(a) {
  use role <- input.field(
    "partyRole",
    input.required(input.one_of(party_role.pairs)),
  )
  use kind <- input.field(
    "subjectKind",
    input.required(input.one_of(subject_kind.pairs)),
  )
  use subject_id <- input.field("subjectId", input.required(input.id()))
  next(PartyInput(role, kind, subject_id))
}

/// A party resolved to a subject this agency may name: an adult player it can see and is not blocked by, or a
/// club. A missing, minor, invisible and blocked player answer alike.
fn resolve_party(
  read: Read,
  a: OrgAccess,
  p: PartyInput,
  now: Int,
) -> Result(Result(PartyInput, Response), Fail(e)) {
  case p.kind, p.role {
    subject_kind.Player, party_role.Individual -> {
      use found <- result.map(players.for_org(
        read,
        id.player(p.subject_id),
        a.org,
        now,
      ))
      case found {
        Some(#(pl, seen)) if seen.visible && !seen.blocked ->
          case players.is_adult(pl, now) {
            True ->
              Ok(PartyInput(..p, subject_id: id.player_to_string(pl.row.id)))
            False -> Error(compliance.bare("PARTY_NOT_FOUND", []))
          }
        _ -> Error(compliance.bare("PARTY_NOT_FOUND", []))
      }
    }
    subject_kind.Player, _ ->
      Ok(
        Error(
          compliance.refusal(
            "CONTEXT_INPUT_INVALID",
            "A player is the individual party.",
            [#("field", json.string("parties"))],
          ),
        ),
      )
    subject_kind.Club, party_role.Individual ->
      Ok(
        Error(
          compliance.refusal(
            "CONTEXT_INPUT_INVALID",
            "A club is an engaging or releasing entity.",
            [#("field", json.string("parties"))],
          ),
        ),
      )
    subject_kind.Club, _ -> {
      use org <- result.map(orgs.by_id(read, id.org(p.subject_id)))
      case org {
        Some(o) if o.type_ == org_type.Club ->
          Ok(PartyInput(..p, subject_id: id.org_to_string(o.id)))
        _ -> Error(compliance.bare("PARTY_NOT_FOUND", []))
      }
    }
  }
}

fn insert_party(
  tx: Tx,
  context_id: id.ComplianceContextId,
  ord: Int,
  p: PartyInput,
  now: Int,
) -> Result(Nil, Fail(e)) {
  // A context's party is minted `cpt`, unlike a transaction's.
  use party_id <- result.try(ids.next(tx, "cpt"))
  party_row.insert(
    tx,
    party_row.Row(
      ..party_row.new(
        context_id:,
        ord:,
        id: id.transaction_party(party_id),
        party_role: p.role,
        subject_kind: p.kind,
        subject_id: p.subject_id,
        removed: False,
      ),
      added_at: Some(now),
    ),
  )
}

// ------------------------------------------------------------------------------------------------- reads

/// `GET /org/agent/compliance/contexts`: the agent's own, oldest first.
pub fn list_contexts(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "compliance.read")
  let now = clock.now_ms()
  use items <- compliance.reading(ctx, fn(r) {
    use all <- result.try(compliance_store.for_agent(r, a.org.id, a.user.id))
    list.try_map(all, context_json(r, _, now))
  })
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(items)),
      #("types", json.array(context_type.pairs, fn(x) { json.string(x.0) })),
      #("partyRoles", json.array(party_role.pairs, fn(x) { json.string(x.0) })),
    ]),
  )
}

/// `GET /org/agent/compliance/contexts/:id`.
pub fn get_context(ctx: Ctx, a: OrgAccess, context_id: String) -> Response {
  use _, c <- own_context(ctx, a, context_id, False)
  let now = clock.now_ms()
  use view <- compliance.reading(ctx, context_json(_, c, now))
  http.json(200, json.object([#("context", view)]))
}

// ------------------------------------------------------------------------------------------------- create

type NewContext {
  NewContext(
    type_: ContextType,
    jurisdictions: List(String),
    parties: List(PartyInput),
    client_key: Option(String),
  )
}

fn party_value(p: PartyInput) -> canonical.Value {
  canonical.Object([
    #("partyRole", canonical.Str(party_role.to_string(p.role))),
    #("subjectKind", canonical.Str(subject_kind.to_string(p.kind))),
    #("subjectId", canonical.Str(p.subject_id)),
  ])
}

/// `POST /org/agent/compliance/contexts`: opened with its parties and evaluated at once.
pub fn create_context(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "compliance.contexts.write")
  let shape = {
    use type_ <- input.field(
      "type",
      input.required(input.one_of(context_type.pairs)),
    )
    use jurisdictions <- input.field(
      "jurisdictions",
      input.required(input.items_between(
        input.matching_said("[A-Za-z]{3}", "must be a three-letter code"),
        1,
        jurisdictions_max,
      )),
    )
    use parties <- input.field(
      "parties",
      input.nullish(input.items_between(
        input.object({
          use p <- party_fields
          input.done(p)
        }),
        0,
        parties_max,
      )),
    )
    use client_key <- input.field(
      "clientKey",
      input.nullish(input.text(1_000_000)),
    )
    input.done(NewContext(
      type_:,
      jurisdictions:,
      parties: option.unwrap(parties, []),
      client_key:,
    ))
  }
  use b, _ <- compliance.body(req, shape, "CONTEXT_INPUT_INVALID")
  use key <- compliance.client_key(b.client_key)
  let mas = b.jurisdictions |> list.map(string.uppercase) |> list.unique
  let fp =
    compliance.fingerprint([
      #("type", canonical.Str(context_type.to_string(b.type_))),
      #("jurisdictions", canonical.Array(list.map(mas, canonical.Str))),
      #("parties", canonical.Array(list.map(b.parties, party_value))),
    ])
  let now = clock.now_ms()
  use hit <- compliance.reading(ctx, fn(r) {
    case key {
      Some(k) -> compliance_store.by_create_key(r, a.org.id, a.user.id, k)
      None -> Ok(None)
    }
  })
  case hit {
    Some(c) ->
      case c.row.create_fp == Some(fp) {
        True -> {
          use view <- compliance.reading(ctx, context_json(_, c, now))
          http.json(
            200,
            json.object([#("context", view), #("idempotent", json.bool(True))]),
          )
        }
        False -> compliance.bare("CONTEXT_IDEMPOTENCY_CONFLICT", [])
      }
    None -> {
      use profile <- compliance.reading(ctx, agent_store.profile_for_user(
        _,
        a.user.id,
      ))
      use <- bool.lazy_guard(profile == None, fn() {
        compliance.refusal(
          "AGENT_VERIFICATION_REQUIRED",
          "Create your agent profile first.",
          [],
        )
      })
      use <- compliance.limited(
        ctx,
        req,
        limits.ComplianceContextWrite,
        id.org_user_to_string(a.user.id),
      )
      use gate <- compliance.reading(ctx, compliance_store.facet_gate(
        _,
        a.user.id,
        mas,
        now,
      ))
      case gate {
        Some(problem) -> compliance.gate_refusal(problem)
        None -> {
          use resolved <- compliance.reading(ctx, fn(r) {
            resolve_all(r, a, b.parties, [], now)
          })
          case resolved {
            Error(refused) -> refused
            Ok(parties) -> open(ctx, a, b, mas, key, fp, parties, now)
          }
        }
      }
    }
  }
}

fn resolve_all(
  read: Read,
  a: OrgAccess,
  pending: List(PartyInput),
  done: List(PartyInput),
  now: Int,
) -> Result(Result(List(PartyInput), Response), Fail(e)) {
  case pending {
    [] -> Ok(Ok(list.reverse(done)))
    [p, ..rest] -> {
      use resolved <- result.try(resolve_party(read, a, p, now))
      case resolved {
        Error(refused) -> Ok(Error(refused))
        Ok(party) ->
          case list.any(done, fn(x) { x.role == party.role }) {
            True ->
              Ok(
                Error(
                  compliance.refusal(
                    "CONTEXT_PARTY_EXISTS",
                    "A "
                      <> party_role.to_string(party.role)
                      <> " party is already named.",
                    [],
                  ),
                ),
              )
            False -> resolve_all(read, a, rest, [party, ..done], now)
          }
      }
    }
  }
}

fn open(
  ctx: Ctx,
  a: OrgAccess,
  b: NewContext,
  mas: List(String),
  key: Option(String),
  fp: String,
  parties: List(PartyInput),
  now: Int,
) -> Response {
  let by = by_agent(a)
  compliance.answer_unit(
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use policies <- result.try(
        approach_policy.published(read) |> compliance.storage,
      )
      let versions =
        approach_policy.applicable(policies, mas, now).policies
        |> list.map(approach_policy.policy_id)
      use context_id <- result.try(
        compliance_store.open_context(
          tx,
          a.org.id,
          a.user.id,
          b.type_,
          mas,
          None,
          option.map(key, fn(k) { #(k, fp) }),
          versions,
          by,
          now,
        )
        |> compliance.storage,
      )
      use _ <- result.try(
        list.index_map(parties, fn(p, i) { #(i, p) })
        |> list.try_each(fn(x) { insert_party(tx, context_id, x.0, x.1, now) })
        |> compliance.storage,
      )
      use found <- result.try(
        compliance_store.by_id(read, context_id) |> compliance.storage,
      )
      let assert Some(c) = found as "the context just opened"
      use _ <- result.try(evaluate_and_record(tx, c, by, None, now))
      answer(tx, 201, context_id, None, [], now)
    }),
  )
}

// ------------------------------------------------------------------------------------------------- acts

/// `POST /org/agent/compliance/contexts/:id/evaluate`.
pub fn evaluate(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  context_id: String,
) -> Response {
  use _, c <- own_context(ctx, a, context_id, False)
  use _, _ <- compliance.body(req, input.nothing(), "CONTEXT_INPUT_INVALID")
  case c.row.status {
    context_row.Closed -> compliance.bare("CONTEXT_CLOSED", [])
    context_row.Open -> {
      let now = clock.now_ms()
      compliance.answer_unit(
        store.unit(ctx.store, fn(tx) {
          use c <- result.try(fresh(tx, c))
          use #(_, e) <- result.try(evaluate_and_record(
            tx,
            c,
            by_agent(a),
            None,
            now,
          ))
          use _ <- result.try(bump(tx, c, a, now) |> compliance.storage)
          answer(tx, 200, c.row.id, Some(e), [], now)
        }),
      )
    }
  }
}

/// `POST /org/agent/compliance/contexts/:id/parties`: a party joins, and the context is evaluated again.
pub fn add_party(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  context_id: String,
) -> Response {
  use _, c <- own_context(ctx, a, context_id, True)
  case c.row.status {
    context_row.Closed -> compliance.bare("CONTEXT_CLOSED", [])
    context_row.Open -> {
      let shape = {
        use p <- party_fields
        use <- rev.fields
        input.done(p)
      }
      use p, raw <- compliance.body(req, shape, "CONTEXT_INPUT_INVALID")
      use <- compliance.limited(
        ctx,
        req,
        limits.ComplianceContextWrite,
        id.org_user_to_string(a.user.id),
      )
      let now = clock.now_ms()
      use resolved <- compliance.reading(ctx, resolve_party(_, a, p, now))
      case resolved {
        Error(refused) -> refused
        Ok(party) ->
          case
            list.any(c.parties, fn(x) {
              x.party_role == party.role && !x.removed
            })
          {
            True -> compliance.bare("CONTEXT_PARTY_EXISTS", [])
            False -> {
              use <- compliance.guard_rev(
                raw,
                rev_of(c),
                "CONTEXT_VERSION_CONFLICT",
                [],
              )
              let by = by_agent(a)
              compliance.answer_unit(
                store.unit(ctx.store, fn(tx) {
                  use c <- result.try(fresh(tx, c))
                  use _ <- result.try(
                    insert_party(tx, c.row.id, next_ord(c.parties), party, now)
                    |> compliance.storage,
                  )
                  use _ <- result.try(
                    compliance_store.event(
                      tx,
                      c.row.id,
                      event_row.ComplianceContextPartyAdded,
                      by,
                      now,
                      compliance_store.Detail(
                        ..compliance_store.no_detail,
                        party_role: Some(party.role),
                        subject_kind: Some(party.kind),
                      ),
                    )
                    |> compliance.storage,
                  )
                  use #(_, e) <- result.try(evaluate_and_record(
                    tx,
                    c,
                    by,
                    None,
                    now,
                  ))
                  use _ <- result.try(bump(tx, c, a, now) |> compliance.storage)
                  answer(tx, 201, c.row.id, Some(e), [], now)
                }),
              )
            }
          }
      }
    }
  }
}

fn next_ord(parties: List(party_row.Row)) -> Int {
  list.fold(parties, 0, fn(acc, p) {
    case p.ord >= acc {
      True -> p.ord + 1
      False -> acc
    }
  })
}

// ------------------------------------------------------------------------------------------------- declaring

type Declaration {
  Declaration(
    role: PartyRole,
    agreement_id: Option(String),
    client_key: Option(String),
  )
}

/// The stored representation, as the repository decodes it.
fn representation_record(r: rep_row.Row) -> Json {
  json.object([
    #("id", id.representation_json(r.id)),
    #("agentUserId", id.org_user_json(r.agent_user_id)),
    #("partyRole", party_role.to_json(r.party_role)),
    #("agreementId", json.nullable(r.agreement_id, id.agreement_json)),
    #("status", rep_status.to_json(r.status)),
    #("declaredOnly", json.bool(r.declared_only)),
    #("reviewId", json.nullable(r.review_id, id.regulatory_review_json)),
    #("declaredAt", json.nullable(r.declared_at, json.int)),
    #("firstActAt", json.nullable(r.first_act_at, json.int)),
    #("withdrawnAt", json.nullable(r.withdrawn_at, json.int)),
    #(
      "verifiedByReviewId",
      json.nullable(r.verified_by_review_id, id.regulatory_review_json),
    ),
    #("verifiedAt", json.nullable(r.verified_at, json.int)),
    #("keys", case r.declare_key, r.declare_fp {
      Some(k), Some(f) ->
        json.object([
          #(
            "declare",
            json.object([#("key", json.string(k)), #("fp", json.string(f))]),
          ),
        ])
      _, _ -> json.object([])
    }),
  ])
}

const context_type_scopes = [
  #(context_type.EmploymentContract, ["employment"]),
  #(context_type.Transfer, ["transfer", "employment"]),
  #(context_type.Loan, ["transfer", "employment"]),
  #(context_type.OtherServices, ["other_services", "commercial"]),
]

/// policy.mjs `representationScopeProblem`, as the refusal it answers.
fn scope_problem(
  ag: agent_rules.Agreement,
  agent: id.OrgUserId,
  c: Context,
  now: Int,
) -> Option(Response) {
  let status = agent_rules.effective_status(ag.row, now)
  let confirmed =
    ag.row.confirmed_at != None && agent_rules.grants_access(ag.row, agent, now)
  let agreement = #("agreementId", id.agreement_json(ag.row.id))
  let scope_refusal = fn(required) {
    compliance.refusal(
      "REPRESENTATION_SCOPE_INSUFFICIENT",
      "The relationship does not cover this action's scope or jurisdiction.",
      [agreement, #("required", required)],
    )
  }
  let required_message =
    "No active, client-confirmed relationship covers this party."
  case status, confirmed {
    agreement_status.Expired, _ ->
      Some(
        compliance.refusal("REPRESENTATION_EXPIRED", required_message, [
          agreement,
        ]),
      )
    agreement_status.Active, True -> {
      let needed =
        list.key_find(context_type_scopes, c.row.type_) |> result.unwrap([])
      let scope = list.map(ag.scope, agreement_scope_row.scope_to_string)
      let ma = jurisdiction.to_string(ag.row.jurisdiction)
      case list.any(needed, list.contains(scope, _)) {
        False -> Some(scope_refusal(json.array(needed, json.string)))
        True ->
          case
            list.any(c.jurisdictions, fn(m) {
              m != "INT" && ma != "INT" && m != ma
            })
          {
            True ->
              Some(scope_refusal(json.array(c.jurisdictions, json.string)))
            False -> None
          }
      }
    }
    _, _ ->
      Some(
        compliance.refusal("REPRESENTATION_REQUIRED", required_message, [
          agreement,
          #("status", agreement_status.to_json(status)),
        ]),
      )
  }
}

/// `POST /org/agent/compliance/contexts/:id/representations`: the agent records that they act for a party here.
/// The engine decides with the declaration included; a refusal records the evaluation, never the declaration.
pub fn declare(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  context_id: String,
) -> Response {
  use _, c <- own_context(ctx, a, context_id, True)
  case c.row.status {
    context_row.Closed -> compliance.bare("CONTEXT_CLOSED", [])
    context_row.Open -> {
      let shape = {
        use role <- input.field(
          "partyRole",
          input.required(input.one_of(party_role.pairs)),
        )
        use agreement_id <- input.field(
          "agreementId",
          input.nullish(input.id()),
        )
        use client_key <- input.field(
          "clientKey",
          input.nullish(input.text(1_000_000)),
        )
        use <- rev.fields
        input.done(Declaration(role, agreement_id, client_key))
      }
      use b, raw <- compliance.body(req, shape, "COMPLIANCE_INPUT_INVALID")
      use key <- compliance.client_key(b.client_key)
      case
        list.find(c.parties, fn(p) { p.party_role == b.role && !p.removed })
      {
        Error(Nil) -> compliance.bare("PARTY_NOT_FOUND", [])
        Ok(party) -> {
          let fp =
            compliance.fingerprint([
              #("partyRole", canonical.Str(party_role.to_string(b.role))),
              #("agreementId", case b.agreement_id {
                Some(x) -> canonical.Str(x)
                None -> canonical.Null
              }),
            ])
          let hit = case key {
            Some(k) ->
              list.find(c.representations, fn(r) { r.declare_key == Some(k) })
            None -> Error(Nil)
          }
          case hit {
            Ok(r) ->
              case r.declare_fp == Some(fp) {
                True -> {
                  let now = clock.now_ms()
                  use view <- compliance.reading(ctx, context_json(_, c, now))
                  http.json(
                    200,
                    json.object([
                      #("context", view),
                      #("representation", representation_record(r)),
                      #("idempotent", json.bool(True)),
                    ]),
                  )
                }
                False -> compliance.bare("CONTEXT_IDEMPOTENCY_CONFLICT", [])
              }
            Error(Nil) -> {
              use <- compliance.limited(
                ctx,
                req,
                limits.ComplianceContextWrite,
                id.org_user_to_string(a.user.id),
              )
              declare_checked(ctx, a, c, party, b, raw, key, fp)
            }
          }
        }
      }
    }
  }
}

fn declare_checked(
  ctx: Ctx,
  a: OrgAccess,
  c: Context,
  party: party_row.Row,
  b: Declaration,
  raw: Dynamic,
  key: Option(String),
  fp: String,
) -> Response {
  let now = clock.now_ms()
  use profile <- compliance.reading(ctx, agent_store.profile_for_user(
    _,
    a.user.id,
  ))
  use <- bool.lazy_guard(profile == None, fn() {
    compliance.refusal(
      "AGENT_VERIFICATION_REQUIRED",
      "Create your agent profile first.",
      [],
    )
  })
  // An entity client has no ScoutBox agreement: declared only, pending attributed review, never CLEAR.
  let agreement = case party.subject_kind {
    subject_kind.Club -> Ok(None)
    subject_kind.Player -> {
      use found <- compliance_result(ctx, fn(r) {
        use ag <- result.try(case b.agreement_id {
          Some(x) -> agent_store.agreement_by_id(r, id.agreement(x))
          None -> Ok(None)
        })
        use seen <- result.map(players.for_org(
          r,
          id.player(party.subject_id),
          a.org,
          now,
        ))
        #(ag, seen)
      })
      let #(ag, seen) = found
      let client = party.subject_id
      let ag = case ag {
        Some(ag)
          if ag.row.agent_user_id == a.user.id
          && ag.row.agency_org_id == a.org.id
          && ag.row.client_id == client
        -> Some(ag)
        _ -> None
      }
      // Safeguarding before scope, so it cannot be told apart from "no such party" by a later refusal.
      case seen {
        Some(#(pl, access)) if access.visible && !access.blocked ->
          case players.is_adult(pl, now) {
            False -> Error(compliance.bare("PARTY_NOT_FOUND", []))
            True ->
              case ag {
                None ->
                  Error(
                    compliance.refusal(
                      "REPRESENTATION_REQUIRED",
                      "A client-confirmed, active relationship with this party is required (agreementId).",
                      [],
                    ),
                  )
                Some(ag) ->
                  case scope_problem(ag, a.user.id, c, now) {
                    Some(refused) -> Error(refused)
                    None -> Ok(Some(ag))
                  }
              }
          }
        _ -> Error(compliance.bare("PARTY_NOT_FOUND", []))
      }
    }
  }
  case agreement {
    Error(refused) -> refused
    Ok(agreement) -> {
      let mine =
        list.any(c.representations, fn(r) {
          r.party_role == b.role
          && r.status != rep_status.Withdrawn
          && r.agent_user_id == a.user.id
        })
      use <- bool.lazy_guard(mine, fn() {
        compliance.refusal(
          "CONTEXT_PARTY_EXISTS",
          "You already represent this party in this context.",
          [],
        )
      })
      use gate <- compliance.reading(ctx, compliance_store.facet_gate(
        _,
        a.user.id,
        c.jurisdictions,
        now,
      ))
      case gate {
        Some(problem) -> compliance.gate_refusal(problem)
        None -> declare_in_unit(ctx, a, c, b, raw, key, fp, agreement, now)
      }
    }
  }
}

/// `use` for a read whose failure is the whole answer.
fn compliance_result(
  ctx: Ctx,
  f: fn(Read) -> Result(a, Fail(e)),
  next: fn(a) -> Result(b, Response),
) -> Result(b, Response) {
  case store.read(ctx.store, f) {
    Ok(v) -> next(v)
    Error(e) -> Error(http.internal(e))
  }
}

fn declare_in_unit(
  ctx: Ctx,
  a: OrgAccess,
  c: Context,
  b: Declaration,
  raw: Dynamic,
  key: Option(String),
  fp: String,
  agreement: Option(agent_rules.Agreement),
  now: Int,
) -> Response {
  let declared_only = agreement == None
  let by = by_agent(a)
  case rev.expected(raw) {
    Error(refused) -> refused
    Ok(expected) ->
      compliance.answer_unit(
        store.unit(ctx.store, fn(tx) {
          use c <- result.try(fresh(tx, c))
          let proposed =
            conflict.Representation(
              agent_user_id: id.org_user_to_string(a.user.id),
              party_role: b.role,
              agreement_id: option.map(agreement, fn(ag) {
                id.agreement_to_string(ag.row.id)
              }),
              declared_only:,
              status: case declared_only {
                True -> "declared"
                False -> "verified"
              },
              first_act_at: Some(now),
              via_colleague: False,
            )
          use #(engine, e) <- result.try(evaluate_and_record(
            tx,
            c,
            by,
            Some(proposed),
            now,
          ))
          let filtered = fn(codes) {
            list.filter(e.reasons, fn(r) { list.contains(codes, r.row.code) })
          }
          let reasons = fn(rs) {
            #("reasons", json.array(rs, context_view.public_reason_json))
          }
          let policy_versions = #(
            "policyVersions",
            json.array(e.policy_versions, id.policy_json),
          )
          let outcome = #("outcome", context_outcome.to_json(e.row.outcome))
          let context_ref = #("contextId", id.compliance_context_json(c.row.id))
          // A refusal keeps the evaluation it recorded, and the revision moves.
          let refuse_kept = fn(code, message, fields) {
            use _ <- result.map(bump(tx, c, a, now) |> compliance.storage)
            compliance.refusal(code, message, fields)
          }
          let rev_guard = fn() {
            case
              rev.check(expected, rev_of(c), "CONTEXT_VERSION_CONFLICT", [])
            {
              Ok(Nil) -> Ok(Nil)
              Error(conflict) -> store.refuse(conflict)
            }
          }
          case e.row.outcome {
            context_outcome.ProhibitedConflict ->
              refuse_kept(
                "REPRESENTATION_CONFLICT",
                "An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.",
                [
                  reasons(
                    filtered([
                      "PROHIBITED_COMBINATION", "COMBINATION_NOT_PERMITTED",
                      "CONNECTED_AGENT_ATTRIBUTION",
                    ]),
                  ),
                  policy_versions,
                  outcome,
                ],
              )
            context_outcome.PermittedDualRepresentationConsentRequired ->
              refuse_kept(
                "CONSENT_REQUIRED",
                "Prior, party-specific written consent is outstanding. Request it; nothing was recorded.",
                [
                  #(
                    "consentsOutstanding",
                    json.array(
                      e.outstanding,
                      context_view.public_outstanding_json,
                    ),
                  ),
                  reasons(filtered(["CONSENT_REQUIRED"])),
                  policy_versions,
                  outcome,
                  context_ref,
                ],
              )
            context_outcome.InsufficientData if !declared_only ->
              refuse_kept(
                "COMPLIANCE_INSUFFICIENT_DATA",
                "A fact the evaluation needs is missing. Nothing was recorded.",
                [
                  reasons(filtered(missing_codes(e))),
                  policy_versions,
                  outcome,
                ],
              )
            context_outcome.ManualRegulatoryReviewRequired
            | context_outcome.InsufficientData -> {
              use _ <- result.try(rev_guard())
              use rep_id <- result.try(case declared_only {
                True ->
                  ids.next(tx, "crp")
                  |> result.map(fn(x) { Some(id.representation(x)) })
                  |> compliance.storage
                False -> Ok(None)
              })
              let review_reasons =
                list.filter(e.reasons, fn(r) { r.row.code != "FACET_VERIFIED" })
              use review_id <- result.try(
                reviews.create_for_context(
                  tx,
                  case declared_only {
                    True -> review_row.RepresentationDeclared
                    False -> review_row.ConflictEvaluation
                  },
                  c.row.agency_org_id,
                  a.user.id,
                  reviews.ContextSubject(
                    context_id: c.row.id,
                    transaction_id: None,
                    representation_id: option.map(
                      rep_id,
                      id.representation_to_string,
                    ),
                    party_role: b.role,
                  ),
                  list.filter(engine.reasons, fn(r) {
                    r.code != "FACET_VERIFIED"
                  }),
                  e.policy_versions,
                  #(e.row.outcome, Some(e.row.id), e.row.evaluated_at),
                  reviews.RequestedBy(
                    kind: compliance_actor_kind.Org,
                    id: Some(id.org_user_to_string(a.user.id)),
                    name: Some(a.user.name),
                  ),
                  now,
                )
                |> compliance.storage,
              )
              use _ <- result.try(case rep_id {
                Some(rep_id) -> {
                  use _ <- result.try(
                    rep_row.insert(
                      tx,
                      rep_row.Row(
                        ..rep_row.new(
                          context_id: c.row.id,
                          ord: next_rep_ord(c),
                          id: rep_id,
                          agent_user_id: a.user.id,
                          party_role: b.role,
                          status: rep_status.PendingReview,
                          declared_only: True,
                        ),
                        review_id: Some(review_id),
                        declared_at: Some(now),
                        declare_key: key,
                        declare_fp: option.map(key, fn(_) { fp }),
                      ),
                    )
                    |> compliance.storage,
                  )
                  compliance_store.event(
                    tx,
                    c.row.id,
                    event_row.ComplianceRepresentationDeclared,
                    by,
                    now,
                    compliance_store.Detail(
                      ..compliance_store.no_detail,
                      party_role: Some(b.role),
                      status: Some(rep_status.PendingReview),
                    ),
                  )
                  |> compliance.storage
                }
                None -> Ok(Nil)
              })
              use _ <- result.map(bump(tx, c, a, now) |> compliance.storage)
              compliance.refusal(
                "REGULATORY_REVIEW_REQUIRED",
                case declared_only {
                  True ->
                    "Representation of an entity without a ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it."
                  False ->
                    "The deciding rule's operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version."
                },
                [
                  #("reviewId", id.regulatory_review_json(review_id)),
                  context_ref,
                  reasons(review_reasons),
                  policy_versions,
                  outcome,
                ],
              )
            }
            context_outcome.Clear -> {
              use _ <- result.try(rev_guard())
              use rep_id <- result.try(
                ids.next(tx, "crp")
                |> result.map(id.representation)
                |> compliance.storage,
              )
              use _ <- result.try(
                rep_row.insert(
                  tx,
                  rep_row.Row(
                    ..rep_row.new(
                      context_id: c.row.id,
                      ord: next_rep_ord(c),
                      id: rep_id,
                      agent_user_id: a.user.id,
                      party_role: b.role,
                      status: rep_status.Verified,
                      declared_only: False,
                    ),
                    agreement_id: option.map(agreement, fn(ag) { ag.row.id }),
                    declared_at: Some(now),
                    first_act_at: Some(now),
                    declare_key: key,
                    declare_fp: option.map(key, fn(_) { fp }),
                  ),
                )
                |> compliance.storage,
              )
              use _ <- result.try(
                compliance_store.event(
                  tx,
                  c.row.id,
                  event_row.ComplianceRepresentationDeclared,
                  by,
                  now,
                  compliance_store.Detail(
                    ..compliance_store.no_detail,
                    party_role: Some(b.role),
                    status: Some(rep_status.Verified),
                    evaluation_id: Some(e.row.id),
                  ),
                )
                |> compliance.storage,
              )
              use _ <- result.try(bump(tx, c, a, now) |> compliance.storage)
              answer(
                tx,
                201,
                c.row.id,
                Some(e),
                [
                  #(
                    "representation",
                    json.object([
                      #("id", id.representation_json(rep_id)),
                      #("partyRole", party_role.to_json(b.role)),
                      #("status", rep_status.to_json(rep_status.Verified)),
                    ]),
                  ),
                ],
                now,
              )
            }
          }
        }),
      )
  }
}

fn missing_codes(e: context_view.Evaluation) -> List(String) {
  let all = [
    "POLICY_NOT_ENCODED", "SCOPE_UNRESOLVED", "TYPE_UNKNOWN", "PARTY_REMOVED",
    "MINOR_PARTY", "REPRESENTATION_UNVERIFIED", "AGENT_STATE_INVALID",
    "INSUFFICIENT_DATA",
  ]
  list.filter(context_view.reason_codes(e), list.contains(all, _))
}

fn next_rep_ord(c: Context) -> Int {
  list.fold(c.representations, 0, fn(acc, r) {
    case r.ord >= acc {
      True -> r.ord + 1
      False -> acc
    }
  })
}

// ------------------------------------------------------------------------------------------------- withdraw, close

/// `POST /org/agent/compliance/contexts/:id/representations/:repId/withdraw`: final.
pub fn withdraw(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  context_id: String,
  rep_id: String,
) -> Response {
  use _, c <- own_context(ctx, a, context_id, True)
  case
    list.find(c.representations, fn(r) {
      id.representation_to_string(r.id) == rep_id
      && r.agent_user_id == a.user.id
    })
  {
    Error(Nil) -> compliance.bare("CONTEXT_NOT_FOUND", [])
    Ok(r) -> {
      let shape = {
        use <- rev.fields
        input.done(Nil)
      }
      use _, raw <- compliance.body(req, shape, "CONTEXT_INPUT_INVALID")
      let now = clock.now_ms()
      case r.status {
        rep_status.Withdrawn -> {
          use view <- compliance.reading(ctx, context_json(_, c, now))
          http.json(
            200,
            json.object([#("context", view), #("idempotent", json.bool(True))]),
          )
        }
        _ -> {
          use <- compliance.guard_rev(
            raw,
            rev_of(c),
            "CONTEXT_VERSION_CONFLICT",
            [],
          )
          let by = by_agent(a)
          compliance.answer_unit(
            store.unit(ctx.store, fn(tx) {
              use c <- result.try(fresh(tx, c))
              use _ <- result.try(
                store.run(
                  tx,
                  "UPDATE compliance_context_representations SET status = 'withdrawn', withdrawn_at = ? WHERE context_id = ? AND id = ? AND status <> 'withdrawn'",
                  [
                    sqlight.int(now),
                    id.compliance_context_sql(c.row.id),
                    id.representation_sql(r.id),
                  ],
                )
                |> compliance.storage,
              )
              use _ <- result.try(
                compliance_store.event(
                  tx,
                  c.row.id,
                  event_row.ComplianceRepresentationWithdrawn,
                  by,
                  now,
                  compliance_store.Detail(
                    ..compliance_store.no_detail,
                    party_role: Some(r.party_role),
                  ),
                )
                |> compliance.storage,
              )
              use #(_, e) <- result.try(evaluate_and_record(
                tx,
                c,
                by,
                None,
                now,
              ))
              use _ <- result.try(bump(tx, c, a, now) |> compliance.storage)
              answer(tx, 200, c.row.id, Some(e), [], now)
            }),
          )
        }
      }
    }
  }
}

/// `POST /org/agent/compliance/contexts/:id/close`: its open review items are cancelled with it.
pub fn close(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  context_id: String,
) -> Response {
  use _, c <- own_context(ctx, a, context_id, True)
  let shape = {
    use <- rev.fields
    input.done(Nil)
  }
  use _, raw <- compliance.body(req, shape, "CONTEXT_INPUT_INVALID")
  let now = clock.now_ms()
  case c.row.status {
    context_row.Closed -> {
      use view <- compliance.reading(ctx, context_json(_, c, now))
      http.json(
        200,
        json.object([#("context", view), #("idempotent", json.bool(True))]),
      )
    }
    context_row.Open -> {
      use <- compliance.guard_rev(
        raw,
        rev_of(c),
        "CONTEXT_VERSION_CONFLICT",
        [],
      )
      compliance.answer_unit(
        store.unit(ctx.store, fn(tx) {
          use c <- result.try(fresh(tx, c))
          use _ <- result.try(
            compliance_store.close(tx, c, by_agent(a), now)
            |> compliance.storage,
          )
          use _ <- result.try(bump(tx, c, a, now) |> compliance.storage)
          answer(tx, 200, c.row.id, None, [], now)
        }),
      )
    }
  }
}

/// `POST /org/agent/compliance/contexts/:id/consents/request`.
pub fn request_consent(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  context_id: String,
) -> Response {
  use _, c <- own_context(ctx, a, context_id, True)
  compliance.request_consent(ctx, req, a, c)
}
