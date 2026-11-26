//// Policy versions (domains/agents/compliance/policyRoutes.mjs): proposed by one Trust & Safety administrator and
//// published by a different one (dual control). A version is data, so a rule's status changes without a deploy.
//// Publishing flags the open contexts of its jurisdiction that were last evaluated without it: they are never
//// silently re-verdicted. Publishing pings every stream (`policy_version_published`).

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_routes as compliance
import scoutbox/agents/compliance_store
import scoutbox/agents/core_routes
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/key_order
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/compliance_context_history as context_event_row
import scoutbox/rows/id
import scoutbox/rows/jurisdiction_policies as policy_row
import scoutbox/rows/jurisdiction_policy_history as event_row
import scoutbox/rows/jurisdiction_policy_publishers as publisher_row
import scoutbox/rows/jurisdiction_policy_rule_overrides as override_row
import scoutbox/rows/jurisdiction_policy_rule_param_items as item_row
import scoutbox/rows/jurisdiction_policy_rule_params as param_row
import scoutbox/rows/jurisdiction_policy_rule_sources as source_row
import scoutbox/rows/jurisdiction_policy_rules as rule_row
import scoutbox/rows/ts_reviewers as reviewer_row
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/party_role
import scoutbox/vocab/reviewer_role
import scoutbox/vocab/rule_status
import sqlight
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------- parameters

/// A rule parameter's type (policyVersions.mjs `RULE_PARAMS`).
pub type Kind {
  Flag
  Count
  Text
  Day
  MonthDay
  TextList
  RoleSets
  AgeMap
  OneOf(List(String))
}

/// Each parameter the engine reads, with its type, in the order the schema lists them. A misspelt one would silently
/// change nothing, so it is refused. `test/scoutbox/spec_test.gleam` proves it equals the snapshot.
pub const rule_params = [
  #("licenceRequired", Flag),
  #("licenceHolder", Text),
  #("onlyLicensedAgentPerforms", Flag),
  #("agencyStaffMayNotApproach", Flag),
  #("onlyLicensedAgentApproaches", Flag),
  #("maxTermMonthsIndividual", Count),
  #("oneAgreementPerPair", Flag),
  #("legalAdviceNotice", Flag),
  #("permittedSets", RoleSets),
  #(
    "consentKind",
    OneOf(
      [
        "dual_representation", "agency_performance", "guardian_approach",
        "guardian_agreement", "legal_advice_ack",
      ],
    ),
  ),
  #("consentInAdvance", Flag),
  #(
    "prohibitedWith",
    OneOf(["individual", "engaging_entity", "releasing_entity"]),
  ),
  #("connectedAgentsAreOne", Flag),
  #("sameAgencyConnected", Flag),
  #(
    "formula",
    OneOf(["academic_year_16", "six_months_before_first_contract_age"]),
  ),
  #("firstContractAge", AgeMap),
  #("guardianConsentBeforeApproach", Flag),
  #("minorsAccreditationRequired", Flag),
  #("validityYears", Count),
  #("informational", Flag),
  #("noFeeForMinorWithoutProContract", Flag),
  #("otherServicesPresumptionMonths", Count),
  #("exclusivityWindowMonths", Count),
  #("discloseConflicts", Flag),
  #("effectiveFrom", Day),
  #("nationalRegistrationRequired", Flag),
  #("requiresFifaLicence", Flag),
  #("cascadeFromFifaLicence", Flag),
  #("onlyRegisteredAgentPerforms", Flag),
  #("agencyPartyColleaguePerformance", Flag),
  #("productionEnabled", Flag),
  #("pendingLegalReview", Text),
  #("pfaLmaNotice", Flag),
  #("academicYearStart", MonthDay),
  #("coversIndirectApproach", Flag),
  #("minorsAuthorisationRequired", Flag),
  #("enhancedDbsWithinMonths", Count),
  #("permittedMultiple", Flag),
  #(
    "excludedRole",
    OneOf(["individual", "engaging_entity", "releasing_entity"]),
  ),
  #("fullParticularsRequired", Flag),
  #("legalAdviceOfferRequired", Flag),
  #("prescribedForm", Text),
  #("activeLimbs", TextList),
  #("lodgeWithinDays", Count),
  #("domesticAuthorisationRequired", Flag),
  #("kind", Text),
]

/// policyVersions.mjs `TEXT_STATUSES`.
pub const text_statuses = rule_row.text_status_pairs

pub type Value {
  FlagValue(Bool)
  CountValue(Int)
  TextValue(String)
  ListValue(List(String))
  SetsValue(List(List(String)))
  AgesValue(List(#(String, Int)))
}

const max_safe_integer = 9_007_199_254_740_991

fn check_of(kind: Kind) -> input.Check(Value) {
  let map = fn(check: input.Check(a), f: fn(a) -> Value) -> input.Check(Value) {
    fn(v) { check(v) |> result.map(f) }
  }
  case kind {
    Flag -> map(input.boolean(), FlagValue)
    Count -> map(input.whole_number(0, max_safe_integer), CountValue)
    Text -> map(input.text(200), TextValue)
    Day -> map(input.date_only(), fn(d) { TextValue(temporal.day_text(d)) })
    MonthDay ->
      map(
        input.matching_said(
          "[0-9]{2}-[0-9]{2}",
          "must be a day of the year written MM-DD",
        ),
        TextValue,
      )
    TextList -> map(input.items_between(input.text(200), 0, 50), ListValue)
    RoleSets ->
      map(
        input.items_between(
          input.items_between(
            input.one_of(list.map(party_role.pairs, fn(p) { #(p.0, p.0) })),
            1,
            max_safe_integer,
          ),
          0,
          20,
        ),
        SetsValue,
      )
    AgeMap ->
      map(
        input.entries(
          input.matching_said("[A-Za-z]{3}", "must be a three-letter code"),
          input.whole_number(0, 30),
        ),
        AgesValue,
      )
    OneOf(values) ->
      map(input.one_of(list.map(values, fn(v) { #(v, v) })), TextValue)
  }
}

/// The parameters sent, in the schema's order (as valibot's object reads them), each once.
fn params_shape(
  names: List(#(String, Kind)),
  acc: List(#(String, Value)),
) -> input.Shape(List(#(String, Value))) {
  case names {
    [] -> input.done(list.reverse(acc))
    [#(name, kind), ..rest] -> {
      use v <- input.field(name, input.nullish(check_of(kind)))
      params_shape(rest, case v {
        Some(v) -> [#(name, v), ..acc]
        None -> acc
      })
    }
  }
}

fn value_json(v: Value) -> Json {
  case v {
    FlagValue(b) -> json.bool(b)
    CountValue(n) -> json.int(n)
    TextValue(t) -> json.string(t)
    ListValue(xs) -> json.array(xs, json.string)
    SetsValue(sets) -> json.array(sets, json.array(_, json.string))
    AgesValue(ages) ->
      json.object(list.map(ages, fn(a) { #(a.0, json.int(a.1)) }))
  }
}

// ------------------------------------------------------------------------------------------------- reading

pub type Rule {
  Rule(
    row: rule_row.Row,
    sources: List(source_row.Row),
    params: List(#(String, Value)),
  )
}

pub type Version {
  Version(
    row: policy_row.Row,
    rules: List(Rule),
    publishers: List(publisher_row.Row),
  )
}

fn kind_of(name: String) -> Kind {
  list.key_find(rule_params, name) |> result.unwrap(Text)
}

fn load(read: Read, p: policy_row.Row) -> Result(Version, Fail(e)) {
  let pid = id.policy_sql(p.id)
  use rules <- result.try(store.query(
    read,
    "SELECT "
      <> rule_row.columns
      <> " FROM jurisdiction_policy_rules WHERE policy_id = ? ORDER BY ord",
    [pid],
    rule_row.decoder(),
  ))
  use sources <- result.try(store.query(
    read,
    "SELECT "
      <> source_row.columns
      <> " FROM jurisdiction_policy_rule_sources WHERE policy_id = ? ORDER BY rule_id, ord",
    [pid],
    source_row.decoder(),
  ))
  use params <- result.try(store.query(
    read,
    "SELECT "
      <> param_row.columns
      <> " FROM jurisdiction_policy_rule_params WHERE policy_id = ? ORDER BY rule_id, ord",
    [pid],
    param_row.decoder(),
  ))
  use items <- result.try(store.query(
    read,
    "SELECT "
      <> item_row.columns
      <> " FROM jurisdiction_policy_rule_param_items WHERE policy_id = ? ORDER BY rule_id, name, set_no, ord",
    [pid],
    item_row.decoder(),
  ))
  use publishers <- result.map(store.query(
    read,
    "SELECT "
      <> publisher_row.columns
      <> " FROM jurisdiction_policy_publishers WHERE policy_id = ? ORDER BY ord",
    [pid],
    publisher_row.decoder(),
  ))
  let value = fn(pr: param_row.Row) {
    let name = param_row.name_to_string(pr.name)
    let mine =
      list.filter(items, fn(x) { x.rule_id == pr.rule_id && x.name == name })
    case kind_of(name) {
      Flag -> FlagValue(pr.flag_value == Some(True))
      Count -> CountValue(option.unwrap(pr.count_value, 0))
      TextList ->
        ListValue(
          list.filter_map(mine, fn(x) { option.to_result(x.text_value, Nil) }),
        )
      RoleSets ->
        mine
        |> list.chunk(fn(x) { x.set_no })
        |> list.map(
          list.filter_map(_, fn(x) { option.to_result(x.text_value, Nil) }),
        )
        |> SetsValue
      AgeMap ->
        AgesValue(
          list.filter_map(mine, fn(x) {
            case x.member, x.count_value {
              Some(m), Some(n) -> Ok(#(m, n))
              _, _ -> Error(Nil)
            }
          }),
        )
      _ -> TextValue(option.unwrap(pr.text_value, ""))
    }
  }
  Version(
    row: p,
    rules: list.map(rules, fn(r) {
      Rule(
        row: r,
        sources: list.filter(sources, fn(s) { s.rule_id == r.rule_id }),
        params: list.filter(params, fn(x) { x.rule_id == r.rule_id })
          |> list.map(fn(x) { #(param_row.name_to_string(x.name), value(x)) }),
      )
    }),
    publishers:,
  )
}

fn versions_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Version), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> policy_row.columns <> " FROM jurisdiction_policies " <> where,
    args,
    policy_row.decoder(),
  ))
  list.try_map(rows, load(read, _))
}

fn version_by_id(
  read: Read,
  policy_id: id.PolicyId,
) -> Result(Option(Version), Fail(e)) {
  versions_where(read, "WHERE id = ?", [id.policy_sql(policy_id)])
  |> result.map(fn(vs) { list.first(vs) |> option.from_result })
}

// ------------------------------------------------------------------------------------------------- views

fn stamp(id_: Option(String), name: Option(String), at: Option(Int)) -> Json {
  case id_, at {
    Some(i), Some(at) ->
      json.object([
        #("id", json.string(i)),
        #("name", json.nullable(name, json.string)),
        #("at", json.int(at)),
      ])
    _, _ -> json.null()
  }
}

/// policyRoutes.mjs `policyPublic`.
pub fn version_json(v: Version) -> Json {
  let p = v.row
  json.object([
    #("id", id.policy_json(p.id)),
    #("regulator", json.string(p.regulator)),
    #("jurisdiction", jurisdiction.to_json(p.jurisdiction)),
    #("policyVersion", json.int(p.policy_version)),
    #("supersedes", json.nullable(p.supersedes_id, id.policy_json)),
    #("effectiveFrom", json.string(p.effective_from_date)),
    #("effectiveTo", json.nullable(p.effective_to_date, json.string)),
    #("status", policy_row.status_to_json(p.status)),
    #("publishedAt", json.nullable(p.published_at, json.int)),
    #("proposedBy", stamp(p.proposed_by_id, p.proposed_by_name, p.proposed_at)),
    #("approvedBy", stamp(p.approved_by_id, p.approved_by_name, p.approved_at)),
    #("publishedBy", case p.status {
      policy_row.Published ->
        json.array(v.publishers, fn(x) {
          json.object([
            #("kind", publisher_row.by_kind_to_json(x.by_kind)),
            #("id", json.string(x.by_id)),
            #("name", json.nullable(x.by_name, json.string)),
          ])
        })
      policy_row.Proposed -> json.null()
    }),
    #(
      "rules",
      json.object(
        list.map(v.rules, fn(r) {
          #(
            r.row.rule_id,
            json.object([
              #("ruleStatus", rule_status.to_json(r.row.rule_status)),
              #(
                "textStatus",
                json.nullable(r.row.text_status, rule_row.text_status_to_json),
              ),
              #("note", json.nullable(r.row.note, json.string)),
              #(
                "params",
                json.object(
                  list.map(r.params, fn(x) { #(x.0, value_json(x.1)) }),
                ),
              ),
              #(
                "sourceRef",
                json.array(r.sources, fn(s) {
                  json.object([
                    #("source", json.string(s.source)),
                    #("version", json.nullable(s.version, json.string)),
                    #(
                      "effectiveDate",
                      json.nullable(s.effective_date, json.string),
                    ),
                    #("retrievedDate", json.string(s.retrieved_date)),
                  ])
                }),
              ),
            ]),
          )
        }),
      ),
    ),
    #("rev", json.int(p.rev)),
  ])
}

fn rule_statuses_json() -> Json {
  json.array(rule_status.pairs, fn(x) { json.string(x.0) })
}

// ------------------------------------------------------------------------------------------------- reads

/// `GET /ts/compliance/policies`: every version, oldest first.
pub fn ts_list(ctx: Ctx) -> Response {
  use all <- compliance.reading(ctx, versions_where(_, "ORDER BY rowid", []))
  http.json(
    200,
    json.object([
      #("items", json.array(all, version_json)),
      #("ruleStatuses", rule_statuses_json()),
      #("dualControl", json.bool(True)),
    ]),
  )
}

/// `GET /admin/compliance/policies`: read-only for the shared key.
pub fn admin_list(ctx: Ctx) -> Response {
  use all <- compliance.reading(ctx, versions_where(_, "ORDER BY rowid", []))
  http.json(
    200,
    json.object([
      #("items", json.array(all, version_json)),
      #("readOnly", json.bool(True)),
      #(
        "note",
        json.string(
          "Read-only. Publishing needs two authenticated Trust & Safety administrators (/ts).",
        ),
      ),
    ]),
  )
}

/// `GET /org/agent/compliance/policies`: the versions in effect for the agency's markets and the member's own.
pub fn agent_policies(ctx: Ctx, a: OrgAccess) -> Response {
  use _ <- core_routes.membership(ctx, a)
  let now = clock.now_ms()
  use #(versions, set) <- compliance.reading(ctx, fn(r) {
    use settings <- result.try(agent_store.settings(r, a.org.id))
    use profile <- result.try(agent_store.profile_for_user(r, a.user.id))
    use policies <- result.try(approach_policy.published(r))
    let mas =
      ["INT"]
      |> list.append(list.map(settings.0, jurisdiction.to_string))
      |> list.append(case profile {
        Some(p) -> list.map(p.jurisdictions, jurisdiction.to_string)
        None -> []
      })
      |> list.unique
    let set = approach_policy.applicable(policies, mas, now)
    use versions <- result.map(
      list.try_map(set.policies, fn(p) { load(r, p.row) }),
    )
    #(versions, set)
  })
  http.json(
    200,
    json.object([
      #("inEffect", json.array(versions, version_json)),
      #("missing", json.array(set.missing, json.string)),
      #("ruleStatuses", rule_statuses_json()),
      #(
        "honest",
        json.string(
          "These are ScoutBox's encoded platform rules with their operative status as recorded on the retrieval date. They are not legal advice and a status can change without a deploy.",
        ),
      ),
    ]),
  )
}

// ------------------------------------------------------------------------------------------------- proposing

type Source {
  Source(
    source: String,
    version: Option(String),
    effective_date: Option(temporal.Day),
    retrieved_date: temporal.Day,
  )
}

type Override {
  Override(jurisdiction: jurisdiction.Jurisdiction, override_rule_id: String)
}

type NewRule {
  NewRule(
    status: rule_status.RuleStatus,
    text_status: Option(rule_row.TextStatus),
    sources: List(Source),
    params: List(#(String, Value)),
    note: Option(String),
    overrides: List(Override),
    effective_from: Option(temporal.Day),
  )
}

type NewVersion {
  NewVersion(
    id: String,
    regulator: Option(String),
    jurisdiction: jurisdiction.Jurisdiction,
    policy_version: Int,
    supersedes: Option(String),
    effective_from: temporal.Day,
    effective_to: Option(temporal.Day),
    rules: List(#(String, NewRule)),
  )
}

fn source_shape() -> input.Shape(Source) {
  use source <- input.field("source", input.required(input.required_text(300)))
  use version <- input.field("version", input.nullish(input.text(120)))
  use effective_date <- input.field(
    "effectiveDate",
    input.nullish(input.date_only()),
  )
  use retrieved_date <- input.field(
    "retrievedDate",
    input.required(input.date_only()),
  )
  input.done(Source(source, version, effective_date, retrieved_date))
}

fn override_shape() -> input.Shape(Override) {
  use j <- input.field(
    "jurisdiction",
    input.required(input.one_of(jurisdiction.pairs)),
  )
  use _ <- input.field(
    "scope",
    input.required(input.one_of(override_row.scope_pairs)),
  )
  use rule <- input.field(
    "overrideRuleId",
    input.required(input.text_between(1, 40)),
  )
  input.done(Override(j, rule))
}

fn rule_shape() -> input.Shape(NewRule) {
  use status <- input.field(
    "ruleStatus",
    input.required(input.one_of(rule_status.pairs)),
  )
  use text_status <- input.field(
    "textStatus",
    input.nullish(input.one_of(text_statuses)),
  )
  use sources <- input.field(
    "sourceRef",
    input.required(input.items_between(input.object(source_shape()), 1, 20)),
  )
  use params <- input.field(
    "params",
    input.nullish(input.object(params_shape(rule_params, []))),
  )
  use note <- input.field("note", input.nullish(input.text(1000)))
  use overrides <- input.field(
    "overrides",
    input.nullish(input.items_between(input.object(override_shape()), 0, 10)),
  )
  use effective_from <- input.field(
    "effectiveFrom",
    input.nullish(input.date_only()),
  )
  input.done(NewRule(
    status:,
    text_status:,
    sources:,
    params: option.unwrap(params, []),
    note: case note {
      Some("") -> None
      other -> other
    },
    overrides: option.unwrap(overrides, []),
    effective_from:,
  ))
}

fn version_shape() -> input.Shape(NewVersion) {
  use pid <- input.field(
    "id",
    input.required(input.matching_said(
      "[jJ][pP]-[A-Za-z]{2,6}-[0-9A-Za-z-]{2,20}",
      "must be written jp-<body>-<version>",
    )),
  )
  use regulator <- input.field("regulator", input.nullish(input.text(20)))
  use j <- input.field(
    "jurisdiction",
    input.required(input.one_of(jurisdiction.pairs)),
  )
  use version <- input.field(
    "policyVersion",
    input.required(input.whole_number(1, max_safe_integer)),
  )
  use supersedes <- input.field("supersedes", input.nullish(input.id()))
  use from <- input.field("effectiveFrom", input.required(input.date_only()))
  use to <- input.field("effectiveTo", input.nullish(input.date_only()))
  use rules <- input.field(
    "rules",
    input.required(input.entries(
      input.text_between(1, 40),
      input.object(rule_shape()),
    )),
  )
  input.done(NewVersion(pid, regulator, j, version, supersedes, from, to, rules))
}

fn policy_refusal(field: String, problem: String, message: String) -> Response {
  compliance.refusal("POLICY_INPUT_INVALID", message, [
    #("field", json.string(field)),
    #("problem", json.string(problem)),
  ])
}

fn require_admin(
  reviewer: reviewer_row.Row,
  next: fn() -> Response,
) -> Response {
  case reviewer.role {
    reviewer_role.TrustSafetyAdmin -> next()
    _ ->
      compliance.refusal(
        "REVIEWER_ROLE_REQUIRED",
        "This action needs the trust_safety_admin role.",
        [#("role", json.string("trust_safety_admin"))],
      )
  }
}

/// `POST /ts/compliance/policies`: a proposal. A different administrator must approve it.
pub fn propose(ctx: Ctx, req: Request, reviewer: reviewer_row.Row) -> Response {
  use <- require_admin(reviewer)
  use <- compliance.limited(
    ctx,
    req,
    limits.TsPolicyPublish,
    id.reviewer_to_string(reviewer.id),
  )
  use raw, order <- http.json_body_in_order(req)
  case
    input.parse_in_order(
      version_shape(),
      raw,
      order,
      root: "body",
      codes: [],
      default: "POLICY_INPUT_INVALID",
    )
  {
    Error(r) -> compliance.input_refusal(r, "POLICY_INPUT_INVALID")
    Ok(b) -> {
      // Rules keep the order they were sent in (docs/known-issues.md).
      let rules =
        key_order.sort(b.rules, key_order.keys(order, [key_order.Key("rules")]))
      let count = list.length(rules)
      let ends_too_soon = case b.effective_to {
        Some(to) -> temporal.compare_days(b.effective_from, to) != order.Lt
        None -> False
      }
      case rules, ends_too_soon {
        [], _ ->
          policy_refusal(
            "rules",
            "invalid",
            "rules must name at least one rule.",
          )
        _, _ if count > 200 ->
          policy_refusal(
            "rules",
            "invalid",
            "rules must name at most 200 rules.",
          )
        _, True ->
          policy_refusal(
            "effectiveTo",
            "invalid",
            "effectiveTo must be after effectiveFrom.",
          )
        _, _ -> {
          use existing <- compliance.reading(ctx, version_by_id(
            _,
            id.policy(b.id),
          ))
          case existing {
            Some(_) -> compliance.bare("POLICY_VERSION_EXISTS", [])
            None -> create(ctx, reviewer, b, rules)
          }
        }
      }
    }
  }
}

fn create(
  ctx: Ctx,
  reviewer: reviewer_row.Row,
  b: NewVersion,
  rules: List(#(String, NewRule)),
) -> Response {
  let now = clock.now_ms()
  let created =
    store.unit(ctx.store, fn(tx) {
      use supersedes <- result.try(case b.supersedes {
        None -> Ok(Ok(None))
        Some(s) ->
          version_by_id(store.reading(tx), id.policy(s))
          |> result.map(fn(found) {
            case found {
              Some(v) -> Ok(Some(v.row.id))
              None -> Error(Nil)
            }
          })
      })
      case supersedes {
        Error(Nil) ->
          store.refuse(policy_refusal(
            "supersedes",
            "invalid",
            "supersedes names no policy version.",
          ))
        Ok(supersedes) -> {
          let pid = id.policy(b.id)
          use _ <- result.try(policy_row.insert(
            tx,
            policy_row.Row(
              id: pid,
              regulator: input.filled(b.regulator) |> option.unwrap("UNKNOWN"),
              jurisdiction: b.jurisdiction,
              policy_version: b.policy_version,
              supersedes_id: supersedes,
              effective_from_date: temporal.day_text(b.effective_from),
              effective_to_date: option.map(b.effective_to, temporal.day_text),
              status: policy_row.Proposed,
              proposed_by_id: Some(id.reviewer_to_string(reviewer.id)),
              proposed_by_name: Some(reviewer.name),
              proposed_at: Some(now),
              approved_by_id: None,
              approved_by_name: None,
              approved_at: None,
              published_at: None,
              created_at: now,
              rev: 1,
              rev_at: Some(now),
              rev_by_name: None,
              rev_by_id: None,
            ),
          ))
          use _ <- result.try(write_rules(tx, pid, rules))
          use _ <- result.try(policy_event(
            tx,
            pid,
            reviewer,
            event_row.PolicyVersionProposed,
            now,
          ))
          use found <- result.map(version_by_id(store.reading(tx), pid))
          let assert Some(v) = found
          v
        }
      }
    })
  case created {
    Ok(v) ->
      http.json(
        201,
        json.object([
          #("policy", version_json(v)),
          #(
            "note",
            json.string(
              "Proposed. A DIFFERENT Trust & Safety administrator must approve before it takes effect (dual control, C7).",
            ),
          ),
        ]),
      )
    Error(store.Refused(response)) -> response
    Error(e) -> http.internal(e)
  }
}

fn write_rules(
  tx: Tx,
  pid: id.PolicyId,
  rules: List(#(String, NewRule)),
) -> Result(Nil, Fail(e)) {
  list.index_map(rules, fn(r, ord) { #(ord, r) })
  |> list.try_each(fn(entry) {
    let #(ord, #(rule_id, r)) = entry
    use _ <- result.try(rule_row.insert(
      tx,
      rule_row.Row(
        policy_id: pid,
        rule_id:,
        ord:,
        rule_status: r.status,
        text_status: r.text_status,
        note: r.note,
        effective_from_date: option.map(r.effective_from, temporal.day_text),
      ),
    ))
    use _ <- result.try(
      list.index_map(r.sources, fn(s, i) { #(i, s) })
      |> list.try_each(fn(x) {
        let #(i, s) = x
        source_row.insert(
          tx,
          source_row.Row(
            policy_id: pid,
            rule_id:,
            ord: i,
            source: s.source,
            version: s.version,
            effective_date: option.map(s.effective_date, temporal.day_text),
            retrieved_date: temporal.day_text(s.retrieved_date),
          ),
        )
      }),
    )
    use _ <- result.try(
      list.index_map(r.overrides, fn(o, i) { #(i, o) })
      |> list.try_each(fn(x) {
        let #(i, o) = x
        override_row.insert(
          tx,
          override_row.Row(
            policy_id: pid,
            rule_id:,
            ord: i,
            jurisdiction: o.jurisdiction,
            scope: override_row.National,
            override_rule_id: o.override_rule_id,
          ),
        )
      }),
    )
    list.index_map(r.params, fn(p, i) { #(i, p) })
    |> list.try_each(fn(x) {
      let #(i, #(name, v)) = x
      let assert Ok(n) = param_row.name_from_string(name)
        as "a parameter the schema read"
      let base = param_row.Row(pid, rule_id, n, i, None, None, None)
      use _ <- result.try(
        param_row.insert(tx, case v {
          FlagValue(b) -> param_row.Row(..base, flag_value: Some(b))
          CountValue(c) -> param_row.Row(..base, count_value: Some(c))
          TextValue(t) -> param_row.Row(..base, text_value: Some(t))
          _ -> base
        }),
      )
      let item = fn(set_no, ord, member, count, text) {
        item_row.insert(
          tx,
          item_row.Row(pid, rule_id, name, set_no, ord, member, count, text),
        )
      }
      case v {
        ListValue(xs) ->
          list.index_map(xs, fn(t, j) { #(j, t) })
          |> list.try_each(fn(y) { item(0, y.0, None, None, Some(y.1)) })
        SetsValue(sets) ->
          list.index_map(sets, fn(set, n) { #(n, set) })
          |> list.try_each(fn(s) {
            list.index_map(s.1, fn(t, j) { #(j, t) })
            |> list.try_each(fn(y) { item(s.0, y.0, None, None, Some(y.1)) })
          })
        AgesValue(ages) ->
          list.index_map(ages, fn(a, j) { #(j, a) })
          |> list.try_each(fn(y) {
            item(0, y.0, Some(y.1.0), Some(y.1.1), None)
          })
        _ -> Ok(Nil)
      }
    })
  })
}

fn policy_event(
  tx: Tx,
  pid: id.PolicyId,
  reviewer: reviewer_row.Row,
  action: event_row.Action,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_policy_event(tx))
  use ord <- result.try(
    store.one(
      store.reading(tx),
      "SELECT COUNT(*) FROM jurisdiction_policy_history WHERE policy_id = ?",
      [id.policy_sql(pid)],
      decode.at([0], decode.int),
    )
    |> result.map(result.unwrap(_, 0)),
  )
  event_row.insert(
    tx,
    event_row.Row(
      id: event_id,
      policy_id: pid,
      ord:,
      at:,
      by_kind: event_row.TsReviewer,
      by_id: Some(id.reviewer_to_string(reviewer.id)),
      by_name: Some(reviewer.name),
      by_role: Some(reviewer.role),
      action:,
      detail_seeded: False,
    ),
  )
}

// ------------------------------------------------------------------------------------------------- publishing

/// `POST /ts/compliance/policies/:id/approve`: a second administrator publishes the proposal.
pub fn approve(
  ctx: Ctx,
  req: Request,
  reviewer: reviewer_row.Row,
  policy_id: String,
) -> Response {
  use <- require_admin(reviewer)
  use _, _ <- compliance.body(req, input.nothing(), "POLICY_INPUT_INVALID")
  use found <- compliance.reading(ctx, version_by_id(_, id.policy(policy_id)))
  case found {
    None -> compliance.bare("POLICY_NOT_FOUND", [])
    Some(v) ->
      case
        v.row.status,
        v.row.proposed_by_id == Some(id.reviewer_to_string(reviewer.id))
      {
        policy_row.Published, _ ->
          compliance.bare("POLICY_NOT_PROPOSED", [
            #("status", policy_row.status_to_json(v.row.status)),
          ])
        policy_row.Proposed, True ->
          compliance.refusal(
            "POLICY_DUAL_CONTROL_REQUIRED",
            "The approving administrator must be a different person from the proposer.",
            [],
          )
        policy_row.Proposed, False -> publish(ctx, reviewer, v)
      }
  }
}

fn publish(ctx: Ctx, reviewer: reviewer_row.Row, v: Version) -> Response {
  let now = clock.now_ms()
  let rid = id.reviewer_to_string(reviewer.id)
  let pid = v.row.id
  let published =
    store.unit(ctx.store, fn(tx) {
      use moved <- result.try(
        store.write(
          tx,
          "UPDATE jurisdiction_policies SET status = 'published', approved_by_id = ?, approved_by_name = ?, approved_at = ?, published_at = ?, rev = rev + 1, rev_at = ?, rev_by_id = ?, rev_by_name = ? WHERE id = ? AND status = 'proposed' AND proposed_by_id IS NOT NULL AND proposed_by_id <> ? RETURNING proposed_by_id, proposed_by_name",
          [
            sqlight.text(rid),
            sqlight.text(reviewer.name),
            sqlight.int(now),
            sqlight.int(now),
            sqlight.int(now),
            sqlight.text(rid),
            sqlight.text(reviewer.name),
            id.policy_sql(pid),
            sqlight.text(rid),
          ],
          {
            use by <- decode.field(0, decode.string)
            use name <- decode.field(1, decode.optional(decode.string))
            decode.success(#(by, name))
          },
        ),
      )
      case moved {
        [] -> store.stale("the policy version moved")
        [#(proposer, proposer_name), ..] -> {
          use _ <- result.try(publisher_row.insert(
            tx,
            publisher_row.Row(
              pid,
              0,
              publisher_row.TsReviewer,
              proposer,
              proposer_name,
            ),
          ))
          use _ <- result.try(publisher_row.insert(
            tx,
            publisher_row.Row(
              pid,
              1,
              publisher_row.TsReviewer,
              rid,
              Some(reviewer.name),
            ),
          ))
          use _ <- result.try(policy_event(
            tx,
            pid,
            reviewer,
            event_row.PolicyVersionPublished,
            now,
          ))
          use _ <- result.try(flag_policy_change(
            tx,
            v.row.jurisdiction,
            pid,
            now,
          ))
          use found <- result.map(version_by_id(store.reading(tx), pid))
          let assert Some(v) = found
          live_pings.catalogue(tx, live_event.PolicyVersionPublished)
          v
        }
      }
    })
  case published {
    Ok(v) -> http.json(200, json.object([#("policy", version_json(v))]))
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

/// Open contexts of the jurisdiction whose latest evaluation did not use this version are flagged, never silently
/// re-verdicted (`flagPolicyChange`).
fn flag_policy_change(
  tx: Tx,
  j: jurisdiction.Jurisdiction,
  pid: id.PolicyId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use ids <- result.try(store.query(
    store.reading(tx),
    "SELECT c.id FROM compliance_contexts c JOIN compliance_context_jurisdictions j ON j.context_id = c.id AND j.member_association = ? JOIN compliance_evaluations e ON e.context_id = c.id AND e.position = (SELECT MAX(position) FROM compliance_evaluations WHERE context_id = c.id) WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM compliance_evaluation_policy_versions v WHERE v.evaluation_id = e.id AND v.policy_version_id = ?) ORDER BY c.rowid",
    [sqlight.text(jurisdiction.to_string(j)), id.policy_sql(pid)],
    decode.at([0], id.compliance_context_decoder()),
  ))
  list.try_each(ids, fn(cid) {
    use _ <- result.try(
      store.run(
        tx,
        "UPDATE compliance_contexts SET re_evaluation_pending = 1 WHERE id = ?",
        [id.compliance_context_sql(cid)],
      ),
    )
    compliance_store.event(
      tx,
      cid,
      context_event_row.ComplianceContextPolicyChanged,
      compliance_store.By(
        kind: compliance_actor_kind.System,
        id: None,
        name: Some("policy publication"),
        role: None,
        org_id: None,
      ),
      at,
      compliance_store.Detail(
        ..compliance_store.no_detail,
        policy_version: Some(pid),
      ),
    )
  })
}
