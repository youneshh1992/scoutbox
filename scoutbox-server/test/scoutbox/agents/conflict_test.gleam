//// The conflict engine gives the blessed answers on every case in test/fixtures/conflict_cases.json (first blessed
//// from the TypeScript server's domains/agents/compliance/conflict.mjs), over the seeded policy versions as this
//// server stores them: the missing policies, the outcome, every reason, the outstanding consents, the policy
//// versions and the input hash.
////
//// Below them, the engine's checks the recorder can't turn into generated cases, ported by hand from the TypeScript
//// rules suites of agents/compliance and platform/dates (scripts/rules/):
////
//// - A grant time that isn't an integer (text, a flag, an object, NaN, ±Infinity; platform/dates K11) can't reach
////   the engine: `consent_store.answer` writes the clock's instant, into an INTEGER column of a STRICT table. A
////   granted consent with no time (K11's null and undefined) is generated: only a CHECK forbids one.
//// - A context type outside the four (`offer`, K4) can't be held (the closed vocabulary): approach_policy_test's
////   J8 shows it. K4's other half, an unresolved scope, is generated.
//// - Other services and declared interests (N5, N6, N7) are no input to the Gleam engine: no route on either
////   server records them, and the TypeScript route hands its engine both empty (compliance/shared.mjs
////   `engineInput`). They have to be ported with the first route that records one.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import scoutbox/agents/approach_policy.{type Policy, Policy}
import scoutbox/agents/conflict.{Agent, Consent, Input, Party, Representation}
import scoutbox/blessed
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/party_role
import scoutbox/vocab/rule_status
import scoutbox/vocab/subject_kind

type Case {
  Case(
    statuses: List(#(String, rule_status.RuleStatus)),
    jurisdictions: List(String),
    input: fn(List(Policy), List(String)) -> conflict.Input,
  )
}

const now = 1_794_830_400_000

fn party() -> decode.Decoder(conflict.Party) {
  use role <- decode.field("partyRole", party_role.decoder())
  use kind <- decode.field("subjectKind", subject_kind.decoder())
  use id <- decode.field("subjectId", decode.string)
  use removed <- decode.field("removed", decode.bool)
  use minor <- decode.field("isMinor", decode.bool)
  decode.success(Party(role, kind, id, removed, minor))
}

fn representation() -> decode.Decoder(conflict.Representation) {
  use agent <- decode.field("agentUserId", decode.string)
  use role <- decode.field("partyRole", party_role.decoder())
  use agreement <- decode.field("agreementId", decode.optional(decode.string))
  use declared_only <- decode.field("declaredOnly", decode.bool)
  use status <- decode.field("status", decode.string)
  use first <- decode.field("firstActAt", decode.optional(decode.int))
  use via <- decode.optional_field("viaColleague", False, decode.bool)
  decode.success(Representation(
    agent,
    role,
    agreement,
    declared_only,
    status,
    first,
    via,
  ))
}

fn consent() -> decode.Decoder(conflict.Consent) {
  use kind <- decode.field("kind", decode.string)
  use status <- decode.field("status", decode.string)
  use revoked_at <- decode.field("revokedAt", decode.optional(decode.int))
  use granted_at <- decode.field("grantedAt", decode.optional(decode.int))
  use context_id <- decode.field("contextId", decode.string)
  use agent <- decode.field("agentUserId", decode.string)
  use role <- decode.field("partyRole", party_role.decoder())
  use subject <- decode.subfield(["subject", "id"], decode.string)
  use signatory <- decode.subfield(["grantedBy", "signatory"], decode.bool)
  use versions <- decode.field(
    "policyVersions",
    decode.list(id.policy_decoder()),
  )
  use full <- decode.subfield(
    ["particulars", "fullParticularsProvided"],
    decode.bool,
  )
  use advice <- decode.subfield(
    ["particulars", "legalAdviceOffered"],
    decode.bool,
  )
  decode.success(Consent(
    kind,
    status,
    revoked_at,
    granted_at,
    context_id,
    agent,
    Some(role),
    Some(subject),
    Some(signatory),
    versions,
    full,
    advice,
  ))
}

fn case_decoder() -> decode.Decoder(Case) {
  use statuses <- decode.field(
    "statuses",
    decode.list({
      use id <- decode.field(0, decode.string)
      use st <- decode.field(1, rule_status.decoder())
      decode.success(#(id, st))
    }),
  )
  use jurisdictions <- decode.field("jurisdictions", decode.list(decode.string))
  use context_id <- decode.subfield(
    ["input", "transaction", "id"],
    decode.string,
  )
  use kind <- decode.subfield(
    ["input", "transaction", "type"],
    context_type.decoder(),
  )
  use parties <- decode.subfield(
    ["input", "transaction", "parties"],
    decode.list(party()),
  )
  use reps <- decode.subfield(
    ["input", "transaction", "representations"],
    decode.list(representation()),
  )
  use evaluated <- decode.subfield(
    ["input", "transaction", "evaluateAgentUserIds"],
    decode.list(decode.string),
  )
  use agents <- decode.subfield(
    ["input", "agents"],
    decode.dict(decode.string, {
      use state <- decode.field("licenceState", decode.string)
      use connected <- decode.field(
        "connectedAgentUserIds",
        decode.list(decode.string),
      )
      decode.success(Agent(state, connected))
    }),
  )
  use consents <- decode.subfield(["input", "consents"], decode.list(consent()))
  // A dict loses the object's key order; the hash sorts keys and the engine looks agents up, so it doesn't matter.
  let agents = dict.to_list(agents)
  decode.success(
    Case(statuses:, jurisdictions:, input: fn(policies, missing) {
      Input(
        context_id:,
        context_type: kind,
        jurisdictions:,
        parties:,
        representations: reps,
        evaluate_agent_user_ids: evaluated,
        agents:,
        consents:,
        policies:,
        missing:,
        now:,
      )
    }),
  )
}

fn with_statuses(
  policies: List(Policy),
  statuses: List(#(String, rule_status.RuleStatus)),
) -> List(Policy) {
  list.map(policies, fn(p) {
    Policy(
      ..p,
      rules: list.map(p.rules, fn(r) {
        list.fold(statuses, r, fn(r, s) {
          case s.0 == r.id {
            True -> approach_policy.Rule(..r, status: s.1)
            False -> r
          }
        })
      }),
    )
  })
}

fn text(v: Option(String)) -> Json {
  json.nullable(v, json.string)
}

fn reason_json(r: conflict.Reason) -> Json {
  json.object([
    #("code", json.string(r.code)),
    #("ruleId", text(r.rule_id)),
    #("ruleStatus", rule_status.to_json(r.rule_status)),
    #("regulator", text(r.regulator)),
    #("jurisdiction", text(r.jurisdiction)),
    #("policyVersion", json.nullable(r.policy_version, id.policy_json)),
    #("overrideRuleId", text(r.override_rule_id)),
    #("agentUserId", text(r.agent_user_id)),
    #("partyRole", json.nullable(r.party_role, party_role.to_json)),
    #("state", text(r.state)),
    #(
      "partyRoles",
      json.nullable(r.party_roles, json.array(_, party_role.to_json)),
    ),
    #(
      "jurisdictions",
      json.nullable(r.jurisdictions, json.array(_, json.string)),
    ),
    #("viaConnectedAgent", json.bool(r.via_connected_agent)),
  ])
}

fn outstanding_json(o: conflict.ConsentOutstanding) -> Json {
  json.object([
    #("partyRole", party_role.to_json(o.party_role)),
    #("agentUserId", json.string(o.agent_user_id)),
    #("consentKind", json.string(o.consent_kind)),
    #("reasonCode", json.string(o.reason_code)),
  ])
}

pub fn the_engine_gives_the_blessed_answers_test() {
  let f = blessed.load("conflict_cases")
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(published) = store.read(s, approach_policy.published)
  blessed.items(blessed.root(f))
  |> list.index_map(fn(item, i) {
    let c = blessed.read(item, case_decoder())
    let set =
      approach_policy.applicable(
        with_statuses(published, c.statuses),
        c.jurisdictions,
        now,
      )
    let got = conflict.evaluate(c.input(set.policies, set.missing))
    let answer = fn(name, actual) {
      blessed.answer(
        blessed.field(item, name),
        "case " <> int.to_string(i) <> " " <> name,
        actual,
      )
    }
    [
      answer("missing", json.array(set.missing, json.string)),
      answer("outcome", context_outcome.to_json(got.outcome)),
      answer("reasons", json.array(got.reasons, reason_json)),
      answer(
        "consentsOutstanding",
        json.array(got.consents_outstanding, outstanding_json),
      ),
      answer("policyVersions", json.array(got.policy_versions, id.policy_json)),
      answer("inputHash", json.string(got.input_hash)),
    ]
  })
  |> list.flatten
  |> blessed.check(f, _)
}

fn read_one(s: store.Store, sql: String, decoder: decode.Decoder(a)) -> a {
  let assert Ok(Ok(v)) =
    store.read(s, fn(read) { store.one(read, sql, [], decoder) })
  v
}

// platform/dates K11: a stored grant time is an integer or nothing.
pub fn a_stored_grant_time_is_always_an_integer_test() {
  let s = support.fresh_store(fn(_) { Nil })
  assert read_one(
      s,
      "SELECT strict FROM pragma_table_list WHERE name = 'regulatory_consents'",
      decode.at([0], decode.int),
    )
    == 1
  assert read_one(
      s,
      "SELECT type FROM pragma_table_info('regulatory_consents') WHERE name = 'granted_at'",
      decode.at([0], decode.string),
    )
    == "INTEGER"
}
