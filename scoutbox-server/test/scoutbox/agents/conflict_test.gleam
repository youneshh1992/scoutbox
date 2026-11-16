//// The ported conflict engine agrees with domains/agents/compliance/conflict.mjs on every case in
//// test/fixtures/conflict_cases.json (written by `node dev/conflict_cases.mjs`), over the seeded policy versions
//// as this server stores them: the outcome, every reason, the outstanding consents, the policy versions and the
//// input hash.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/agents/approach_policy.{type Policy, Policy}
import scoutbox/agents/conflict.{
  Agent, Consent, ConsentOutstanding, Input, Party, Reason, Representation,
}
import scoutbox/platform/store
import scoutbox/support
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/party_role
import scoutbox/vocab/rule_status
import scoutbox/vocab/subject_kind
import simplifile

type Case {
  Case(
    statuses: List(#(String, rule_status.RuleStatus)),
    jurisdictions: List(String),
    input: fn(List(Policy), List(String)) -> conflict.Input,
    missing: List(String),
    expected: conflict.Evaluation,
    hash: Option(String),
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
  use versions <- decode.field("policyVersions", decode.list(decode.string))
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

fn reason() -> decode.Decoder(conflict.Reason) {
  let text = decode.optional(decode.string)
  use code <- decode.field("code", decode.string)
  use rule_id <- decode.field("ruleId", text)
  use status <- decode.field("ruleStatus", rule_status.decoder())
  use regulator <- decode.field("regulator", text)
  use jurisdiction <- decode.field("jurisdiction", text)
  use version <- decode.field("policyVersion", text)
  use override <- decode.field("overrideRuleId", text)
  use agent <- decode.field("agentUserId", text)
  use role <- decode.field("partyRole", decode.optional(party_role.decoder()))
  use state <- decode.field("state", text)
  use roles <- decode.field(
    "partyRoles",
    decode.optional(decode.list(party_role.decoder())),
  )
  use mas <- decode.field(
    "jurisdictions",
    decode.optional(decode.list(decode.string)),
  )
  use via <- decode.field("viaConnectedAgent", decode.bool)
  decode.success(Reason(
    code,
    rule_id,
    status,
    regulator,
    jurisdiction,
    version,
    override,
    agent,
    role,
    state,
    roles,
    mas,
    via,
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
  use outcome <- decode.field("outcome", context_outcome.decoder())
  use reasons <- decode.field("reasons", decode.list(reason()))
  use outstanding <- decode.field(
    "consentsOutstanding",
    decode.list({
      use role <- decode.field("partyRole", party_role.decoder())
      use agent <- decode.field("agentUserId", decode.string)
      use kind <- decode.field("consentKind", decode.string)
      use code <- decode.field("reasonCode", decode.string)
      decode.success(ConsentOutstanding(role, agent, kind, code))
    }),
  )
  use versions <- decode.field("policyVersions", decode.list(decode.string))
  use missing <- decode.field("missing", decode.list(decode.string))
  use hash <- decode.field("inputHash", decode.optional(decode.string))
  // A dict loses the object's key order; the hash sorts keys and the engine looks agents up, so it doesn't matter.
  let agents = dict.to_list(agents)
  decode.success(Case(
    statuses:,
    jurisdictions:,
    input: fn(policies, missing) {
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
    },
    missing:,
    expected: conflict.Evaluation(
      outcome:,
      reasons:,
      consents_outstanding: outstanding,
      policy_versions: versions,
      evaluated_at: now,
      input_hash: option.unwrap(hash, ""),
    ),
    hash:,
  ))
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

pub fn the_ported_engine_agrees_with_typescript_on_every_case_test() {
  let assert Ok(text) = simplifile.read("test/fixtures/conflict_cases.json")
  let assert Ok(cases) = json.parse(text, decode.list(case_decoder()))
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(published) = store.read(s, approach_policy.published)
  let failures =
    list.index_map(cases, fn(c, i) {
      let set =
        approach_policy.applicable(
          with_statuses(published, c.statuses),
          c.jurisdictions,
          now,
        )
      let got = conflict.evaluate(c.input(set.policies, set.missing))
      let want = c.expected
      let checks = [
        #("missing", set.missing == c.missing),
        #("outcome", got.outcome == want.outcome),
        #("reasons", got.reasons == want.reasons),
        #("consents", got.consents_outstanding == want.consents_outstanding),
        #("versions", got.policy_versions == want.policy_versions),
        #("hash", c.hash == None || Some(got.input_hash) == c.hash),
      ]
      list.filter_map(checks, fn(check) {
        case check.1 {
          True -> Error(Nil)
          False ->
            Ok(
              "case "
              <> int.to_string(i)
              <> ": "
              <> check.0
              <> "\n  got:  "
              <> string.inspect(got)
              <> "\n  want: "
              <> string.inspect(want),
            )
        }
      })
    })
    |> list.flatten
  case failures {
    [] -> Nil
    [first, ..] ->
      panic as {
        int.to_string(list.length(failures)) <> " mismatches; first " <> first
      }
  }
}
