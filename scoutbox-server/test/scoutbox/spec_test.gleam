//// The specification tables this server declares in Gleam equal the TypeScript server's, as snapshotted in
//// e2e/support/spec/ (written by its scripts/specSnapshot.mjs and copied here by e2e/sync.mjs). A table ported
//// in part is checked entry by entry, so a ported entry can't drift.

import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/agents/core_routes
import scoutbox/agents/policy_routes
import scoutbox/agents/transaction_routes
import scoutbox/messaging/notification_prefs
import scoutbox/platform/limits.{Policy}
import scoutbox/recruitment/analytics
import scoutbox/recruitment/analytics/cohorts
import scoutbox/recruitment/analytics/funnels
import scoutbox/recruitment/analytics/metrics
import scoutbox/recruitment/domain_errors
import scoutbox/vocab/notification_category
import simplifile

fn snapshot(file: String, decoder: decode.Decoder(a)) -> a {
  let assert Ok(text) = simplifile.read("e2e/support/spec/" <> file)
  let assert Ok(value) = json.parse(text, decoder)
  value
}

pub fn rate_limit_policy_test() {
  let policy =
    snapshot(
      "platform/rateLimit.json",
      decode.at(
        ["RATE_LIMIT_POLICY"],
        decode.dict(decode.string, {
          use max <- decode.field("max", decode.int)
          use window_ms <- decode.field("windowMs", decode.int)
          decode.success(Policy(max:, window_ms:))
        }),
      ),
    )
  list.each(limits.policy, fn(entry) {
    let #(action, ported) = entry
    assert dict.get(policy, action) == Ok(ported)
  })
}

pub fn notification_type_categories_test() {
  let type_category =
    snapshot(
      "platform/notificationPrefs.json",
      decode.at(["TYPE_CATEGORY"], decode.dict(decode.string, decode.string)),
    )
  let ported =
    list.map(notification_prefs.type_category, fn(entry) {
      #(entry.0, notification_category.to_string(entry.1))
    })
  assert dict.from_list(ported) == type_category
  assert list.length(ported) == dict.size(type_category)
}

/// CATEGORIES, entry by entry, and the `notifications.category` CHECK (from the migrations) in the same order.
pub fn notification_categories_test() {
  let categories =
    snapshot(
      "platform/notificationPrefs.json",
      decode.at(
        ["CATEGORIES"],
        decode.dict(decode.string, {
          use label <- decode.field("label", decode.string)
          use default <- decode.field("default", decode.bool)
          use mandatory <- decode.field("mandatory", decode.bool)
          decode.success(#(label, default, mandatory))
        }),
      ),
    )
  let ported =
    list.map(notification_prefs.categories, fn(c: notification_prefs.Category) {
      #(
        notification_category.to_string(c.id),
        #(c.label, c.default, c.mandatory),
      )
    })
  assert dict.from_list(ported) == categories
  assert list.map(ported, fn(p) { p.0 })
    == list.map(notification_category.pairs, fn(p) { p.0 })
}

/// An error table declared whole equals its snapshot, entry for entry and no more.
fn error_table(
  file: String,
  name: String,
  ported: List(#(String, Int)),
) -> Nil {
  let table =
    snapshot(file, decode.at([name], decode.dict(decode.string, decode.int)))
  assert dict.from_list(ported) == table
}

pub fn agent_core_error_table_test() {
  error_table(
    "agents/core/errors.json",
    "AGENT_CORE_ERROR_HTTP",
    core_routes.statuses,
  )
}

pub fn transaction_error_table_test() {
  error_table(
    "agents/transactions/errors.json",
    "TRANSACTION_ERROR_HTTP",
    transaction_routes.statuses,
  )
}

pub fn signing_error_table_test() {
  error_table(
    "recruitment/signings/errors.json",
    "SIGNING_ERROR_HTTP",
    domain_errors.signing_statuses,
  )
}

/// The metric registry, entry for entry and in order, with what travels beside it.
pub fn recruitment_analytics_registry_test() {
  let file = "recruitment/analytics/metrics.json"
  let ids =
    snapshot(file, decode.at(["METRIC_IDS"], decode.list(decode.string)))
  assert ids == metrics.metric_ids()
  let registry =
    snapshot(
      file,
      decode.at(
        ["METRICS"],
        decode.dict(decode.string, {
          use id <- decode.field("id", decode.string)
          use family <- decode.field("family", decode.string)
          use name <- decode.field("name", decode.string)
          use unit <- decode.field("unit", decode.string)
          use semantics <- decode.field("semantics", decode.string)
          use sources <- decode.field("sources", decode.list(decode.string))
          use reads <- decode.field("reads", decode.list(decode.string))
          use ratio <- decode.optional_field(
            "ratio",
            None,
            decode.optional(decode.bool),
          )
          use distribution <- decode.optional_field(
            "distribution",
            False,
            decode.bool,
          )
          use association <- decode.optional_field(
            "association",
            False,
            decode.bool,
          )
          use limitation <- decode.field("limitation", decode.string)
          let measure = case distribution, ratio {
            True, _ -> metrics.IsDistribution
            False, Some(r) -> metrics.IsRatio(r)
            False, None -> metrics.IsRatio(False)
          }
          decode.success(metrics.Metric(
            id:,
            family:,
            name:,
            unit:,
            semantics:,
            sources:,
            reads:,
            measure:,
            association:,
            limitation:,
          ))
        }),
      ),
    )
  list.each(metrics.metrics, fn(m) {
    assert dict.get(registry, m.id) == Ok(m)
  })
  assert snapshot(file, decode.at(["FAMILY_IDS"], decode.list(decode.string)))
    == metrics.family_ids()
  assert snapshot(file, decode.at(["SMALL_N_MIN"], decode.int))
    == metrics.small_n_min
  assert snapshot(
      file,
      decode.at(["PERSON_DIMENSIONS"], decode.list(decode.string)),
    )
    == metrics.person_dimensions
  assert snapshot(file, decode.at(["ASSOCIATION_NOTE"], decode.string))
    == metrics.association_note
  assert snapshot(
      "recruitment/analytics/cohorts.json",
      decode.at(["EVIDENCE_REASON_CODES"], decode.list(decode.string)),
    )
    == cohorts.evidence_reason_codes()
  assert snapshot(
      "recruitment/analytics/index.json",
      decode.at(["DRILLDOWN_METRICS"], decode.list(decode.string)),
    )
    == analytics.drilldown_metrics
  assert snapshot(
      "recruitment/analytics/funnels.json",
      decode.at(["FUNNEL_STAGES"], decode.list(decode.string)),
    )
    == funnels.funnel_stages()
}

/// RULE_PARAMS, whole and in order, with each parameter's type; and TEXT_STATUSES.
pub fn policy_rule_params_test() {
  let kind = {
    use k <- decode.then(decode.dynamic)
    case
      decode.run(k, decode.string),
      decode.run(k, decode.list(decode.string))
    {
      Ok(name), _ -> decode.success(name)
      _, Ok(values) -> decode.success("[" <> string.join(values, "|") <> "]")
      _, _ -> decode.failure("", "kind")
    }
  }
  let params =
    snapshot(
      "agents/compliance/policyVersions.json",
      decode.at(["RULE_PARAMS"], decode.dict(decode.string, kind)),
    )
  let name = fn(k: policy_routes.Kind) {
    case k {
      policy_routes.Flag -> "flag"
      policy_routes.Count -> "count"
      policy_routes.Text -> "text"
      policy_routes.Day -> "date"
      policy_routes.MonthDay -> "monthDay"
      policy_routes.TextList -> "textList"
      policy_routes.RoleSets -> "roleSets"
      policy_routes.AgeMap -> "ageMap"
      policy_routes.OneOf(values) -> "[" <> string.join(values, "|") <> "]"
    }
  }
  let ported = list.map(policy_routes.rule_params, fn(p) { #(p.0, name(p.1)) })
  assert dict.from_list(ported) == params
  assert list.length(ported) == dict.size(params)
  let statuses =
    snapshot(
      "agents/compliance/policyVersions.json",
      decode.at(["TEXT_STATUSES"], decode.list(decode.string)),
    )
  assert list.map(policy_routes.text_statuses, fn(p) { p.0 }) == statuses
}
