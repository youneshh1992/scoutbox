//// `GET /org/agent/compliance/overview` (domains/agents/compliance/facetRoutes.mjs): an agent's own compliance
//// standing in one read: the provider's honest status, their facets and how fresh each is, the policies in force,
//// their reviews, contexts and consents, and their own readiness for a minor pathway evaluated against no subject.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/agents/agent_store
import scoutbox/agents/approach_policy
import scoutbox/agents/compliance_routes as compliance
import scoutbox/agents/compliance_store
import scoutbox/agents/consent_store
import scoutbox/agents/context_view
import scoutbox/agents/core_routes
import scoutbox/agents/reviews
import scoutbox/agents/verification_provider
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/id
import scoutbox/rows/jurisdiction_policies as policy_row
import scoutbox/vocab/agent_facet.{
  type AgentFacet, DomesticAuthorisation, FifaLicence, MinorsAuthorisation,
  NationalRegistration,
}
import scoutbox/vocab/facet_state
import scoutbox/vocab/jurisdiction
import scoutbox/vocab/review_status
import scoutbox/vocab/rule_status
import wisp.{type Response}

const day_ms = 86_400_000

/// No jurisdiction has a production minor pathway enabled (policy.mjs `MINOR_PATHWAY_PRODUCTION_ENABLED`).
fn pathway_enabled(_ma: String) -> Bool {
  False
}

fn state_json(f: Option(facet_row.Row), now: Int) -> Json {
  facet_state.to_json(agent_rules.effective_facet_state(f, now))
}

/// shared.mjs `facetStatesOf`.
fn facets_json(p: agent_rules.Profile, now: Int) -> Json {
  let by_ma = fn(facet) {
    json.object(
      agent_rules.facets_by_association(p, facet)
      |> list.map(fn(x) {
        #(jurisdiction.to_string(x.0), state_json(Some(x.1), now))
      }),
    )
  }
  json.object([
    #(
      "fifa_licence",
      state_json(agent_rules.facet_of(p, FifaLicence, None), now),
    ),
    #("national_registration", by_ma(NationalRegistration)),
    #("domestic_authorisation", by_ma(DomesticAuthorisation)),
    #("minors_authorisation", by_ma(MinorsAuthorisation)),
  ])
}

/// `Math.ceil` of the days until `at`.
fn days_until(at: Int, now: Int) -> Int {
  let d = at - now
  case d % day_ms {
    0 -> d / day_ms
    r if r > 0 -> d / day_ms + 1
    _ -> d / day_ms
  }
}

fn freshness_of(
  facet: AgentFacet,
  ma: Option(jurisdiction.Jurisdiction),
  f: facet_row.Row,
  now: Int,
) -> #(Json, Bool) {
  let state = agent_rules.effective_facet_state(Some(f), now)
  let view = core_routes.facet_view(f, now)
  let provenance =
    list.key_find(view, "provenance") |> result.unwrap(json.null())
  #(
    json.object([
      #("facet", agent_facet.to_json(facet)),
      #("memberAssociation", json.nullable(ma, jurisdiction.to_json)),
      #("state", facet_state.to_json(state)),
      #("storedState", facet_state.to_json(f.state)),
      #("recheckAt", json.nullable(f.recheck_at, json.int)),
      #(
        "daysUntilRecheck",
        json.nullable(option.map(f.recheck_at, days_until(_, now)), json.int),
      ),
      #("provenance", provenance),
      #("verifiedAt", json.nullable(f.verified_at, json.int)),
    ]),
    state == facet_state.Stale,
  )
}

fn freshness(p: agent_rules.Profile, now: Int) -> List(#(Json, Bool)) {
  let licence = case agent_rules.facet_of(p, FifaLicence, None) {
    Some(f) -> [freshness_of(FifaLicence, None, f, now)]
    None -> []
  }
  list.append(
    licence,
    list.flat_map(
      [NationalRegistration, DomesticAuthorisation, MinorsAuthorisation],
      fn(facet) {
        agent_rules.facets_by_association(p, facet)
        |> list.map(fn(x) { freshness_of(facet, Some(x.0), x.1, now) })
      },
    ),
  )
}

fn minor_readiness(
  policies: List(approach_policy.Policy),
  p: Option(agent_rules.Profile),
  ma: String,
  now: Int,
) -> Json {
  let set = approach_policy.applicable(policies, [ma], now)
  let state_of = fn(facet, m) {
    agent_rules.effective_facet_state(
      option.then(p, agent_rules.facet_of(_, facet, m)),
      now,
    )
  }
  let d = approach_policy.approach_minor(set, [ma], state_of, now)
  let timing = approach_policy.minor_timing_rule(set.policies, ma, now)
  json.object([
    #("memberAssociation", json.string(ma)),
    #("pathwayEnabledInProduction", json.bool(pathway_enabled(ma))),
    #("timingRule", case timing {
      Some(#(rule_id, status, formula)) ->
        json.object([
          #("ruleId", json.string(rule_id)),
          #("ruleStatus", rule_status.to_json(status)),
          #("formula", json.nullable(formula, json.string)),
        ])
      None -> json.null()
    }),
    #(
      "timingEncoded",
      json.bool(case timing {
        Some(#(_, rule_status.Active, Some(formula))) ->
          formula != "six_months_before_first_contract_age"
        _ -> False
      }),
    ),
    #("agentReady", json.bool(approach_policy.allowed(d))),
    #(
      "gaps",
      json.array(d.facet_gaps, fn(g) {
        json.object([
          #("facet", agent_facet.to_json(g.facet)),
          #(
            "memberAssociation",
            json.nullable(g.member_association, jurisdiction.to_json),
          ),
          #("state", facet_state.to_json(g.state)),
          #("code", json.string(g.code)),
        ])
      }),
    ),
    #(
      "reasons",
      json.array(d.reasons, fn(r) {
        json.object([
          #("code", json.string(r.code)),
          #("ruleId", json.nullable(r.rule_id, json.string)),
          #("ruleStatus", rule_status.to_json(r.rule_status)),
        ])
      }),
    ),
    #(
      "honest",
      json.string(
        "General discovery of minors by agencies is prohibited and no minor representation workflow is live in any jurisdiction. This is the agent's own readiness under the encoded rules, evaluated against no subject.",
      ),
    ),
  ])
}

fn policy_json(p: approach_policy.Policy) -> Json {
  let r: policy_row.Row = p.row
  json.object([
    #("id", id.policy_json(r.id)),
    #("regulator", json.string(r.regulator)),
    #("jurisdiction", jurisdiction.to_json(r.jurisdiction)),
    #("effectiveFrom", json.string(r.effective_from_date)),
  ])
}

pub fn overview(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- core_routes.membership(ctx, a)
  use <- core_routes.require(m, "compliance.read")
  let now = clock.now_ms()
  let sees_agency =
    agent_rules.can(m.affiliation.tiers, "agency.compliance.read")
  use read <- compliance.reading(ctx, fn(r) {
    use profile <- result.try(agent_store.profile_for_user(r, a.user.id))
    use all_reviews <- result.try(reviews.for_agency(r, a.org.id))
    use contexts <- result.try(compliance_store.for_agent(
      r,
      a.org.id,
      a.user.id,
    ))
    use context_views <- result.try(
      list.try_map(contexts, context_view.for_agent(r, _, now)),
    )
    use consents <- result.try(consent_store.for_agent(r, a.org.id, a.user.id))
    use settings <- result.try(agent_store.settings(r, a.org.id))
    use policies <- result.map(approach_policy.published(r))
    #(
      profile,
      all_reviews,
      contexts,
      context_views,
      consents,
      settings.0,
      policies,
    )
  })
  let #(
    profile,
    all_reviews,
    contexts,
    context_views,
    consents,
    agency_mas,
    policies,
  ) = read
  let mine =
    list.filter(all_reviews, fn(rv) {
      rv.row.agent_user_id == Some(a.user.id) || sees_agency
    })
  let declared = case profile {
    Some(p) -> p.jurisdictions
    None -> []
  }
  let mas =
    list.append(declared, agency_mas)
    |> list.map(jurisdiction.to_string)
    |> list.unique
  let in_force = approach_policy.applicable(policies, ["INT", ..mas], now)
  let fresh = case profile {
    Some(p) -> freshness(p, now)
    None -> []
  }
  let pending =
    list.count(mine, fn(rv) {
      rv.row.status == review_status.Pending
      || rv.row.status == review_status.InReview
    })
  http.json(
    200,
    json.object([
      #(
        "provider",
        verification_provider.status_json(ctx.config.agent_verification_test),
      ),
      #("facets", case profile {
        Some(p) -> facets_json(p, now)
        None -> json.null()
      }),
      #("freshness", json.preprocessed_array(list.map(fresh, fn(f) { f.0 }))),
      #(
        "policies",
        json.object([
          #("inEffect", json.array(in_force.policies, policy_json)),
          #("missing", json.array(in_force.missing, json.string)),
        ]),
      ),
      #("reviews", json.array(mine, compliance.review_json(_, False))),
      #("contexts", json.preprocessed_array(context_views)),
      #("consents", json.array(consents, compliance.consent_for_agent)),
      #(
        "minorReadiness",
        json.array(list.filter(mas, fn(x) { x != "INT" }), minor_readiness(
          policies,
          profile,
          _,
          now,
        )),
      ),
      #(
        "counts",
        json.object([
          #("reviewsPending", json.int(pending)),
          #(
            "contextsOpen",
            json.int(list.count(contexts, fn(c) { c.row.closed_at == None })),
          ),
          #(
            "consentsOutstanding",
            json.int(
              list.count(consents, fn(k) {
                consent_store.status(k) == "requested"
              }),
            ),
          ),
          #("staleFacets", json.int(list.count(fresh, fn(f) { f.1 }))),
        ]),
      ),
      #(
        "honest",
        json.string(
          "ScoutBox policy results say whether this workflow may proceed under the currently encoded rules. They are not statements of legal validity and no governing body has approved anything here.",
        ),
      ),
    ]),
  )
}
