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
import scoutbox/development/benchmarks.{Drill}
import scoutbox/development/box_cam_rules
import scoutbox/development/drill_guidance
import scoutbox/messaging/notification_prefs
import scoutbox/passport/passport_rules
import scoutbox/platform/json_text
import scoutbox/platform/limits.{Policy}
import scoutbox/recruitment/analytics
import scoutbox/recruitment/analytics/cohorts
import scoutbox/recruitment/analytics/funnels
import scoutbox/recruitment/analytics/metrics
import scoutbox/recruitment/domain_errors
import scoutbox/rows/box_sessions as session_row
import scoutbox/vocab/box_provider
import scoutbox/vocab/box_target_type
import scoutbox/vocab/notification_category
import scoutbox/vocab/position
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

/// The drill library's ids, in order, and its filming guidance, key by key in order.
pub fn drill_library_test() {
  let ids =
    snapshot(
      "development/record.json",
      decode.at(["DRILLS"], decode.list(decode.at(["id"], decode.string))),
    )
  assert drill_guidance.drill_ids == ids
  let assert Ok(text) =
    simplifile.read("e2e/support/spec/development/objectives.json")
  let recording =
    list.map(drill_guidance.recording, fn(r) {
      "\"" <> r.0 <> "\": " <> json.to_string(json.string(r.1))
    })
    |> string.join(",\n    ")
  assert string.contains(text, recording)
  let snapshot_recording =
    snapshot(
      "development/objectives.json",
      decode.at(["DRILL_RECORDING"], decode.dict(decode.string, decode.string)),
    )
  assert dict.from_list(drill_guidance.recording) == snapshot_recording
}

/// The drill library's names, metrics, units and directions, drill by drill in order.
pub fn drill_details_test() {
  let drills =
    snapshot(
      "development/record.json",
      decode.at(
        ["DRILLS"],
        decode.list({
          use id <- decode.field("id", decode.string)
          use name <- decode.field("name", decode.string)
          use metric <- decode.field("metric", decode.string)
          use unit <- decode.field("unit", decode.string)
          use lower_is_better <- decode.field("lowerIsBetter", decode.bool)
          decode.success(Drill(id:, name:, metric:, unit:, lower_is_better:))
        }),
      ),
    )
  assert benchmarks.drills == drills
}

/// The programme tracks' position groups, each in order.
pub fn programme_tracks_test() {
  let tracks =
    snapshot(
      "grassrootsJourney.json",
      decode.at(
        ["PROGRAMME_TRACKS"],
        decode.dict(
          decode.string,
          decode.at(["positions"], decode.list(decode.string)),
        ),
      ),
    )
  let declared =
    list.map(benchmarks.tracks, fn(t) {
      #(t.0, list.map(t.1, position.to_string))
    })
  assert dict.from_list(declared) == tracks
}

/// GAP_RULE_TABLE (GAP_RULES without their tests) and GAP_RULES_VERSION.
pub fn passport_gap_rules_test() {
  let table =
    snapshot(
      "passport/shared.json",
      decode.at(
        ["GAP_RULE_TABLE"],
        decode.list({
          use id <- decode.field("id", decode.string)
          use version <- decode.field("version", decode.int)
          use category <- decode.field("category", decode.string)
          decode.success(passport_rules.Gap(id:, version:, category:))
        }),
      ),
    )
  let ported =
    list.map(passport_rules.gap_rules(), fn(r) {
      passport_rules.Gap(r.id, r.version, r.category)
    })
  assert ported == table
  assert snapshot(
      "passport/shared.json",
      decode.at(["GAP_RULES_VERSION"], decode.int),
    )
    == passport_rules.gap_rules_version
}

/// PROVENANCE, in its rank order, and PROVENANCE_COPY for each.
pub fn passport_provenance_test() {
  let order =
    snapshot(
      "passport/shared.json",
      decode.at(["PROVENANCE"], decode.list(decode.string)),
    )
  let copy =
    snapshot(
      "passport/shared.json",
      decode.at(["PROVENANCE_COPY"], decode.dict(decode.string, decode.string)),
    )
  assert list.map(passport_rules.provenance_pairs, fn(p) { p.0 }) == order
  list.index_map(passport_rules.provenance_pairs, fn(p, i) {
    assert passport_rules.provenance_to_string(p.1) == p.0
    assert passport_rules.provenance_rank(p.1) == i
    assert dict.get(copy, p.0) == Ok(passport_rules.provenance_copy(p.1))
  })
  assert dict.size(copy) == list.length(order)
}

/// Box Cam's drills and observation providers, whole: each written as the TypeScript registry holds it.
pub fn box_cam_registry_test() {
  let num = json_text.number
  let caps = fn(cs) {
    json.array(cs, fn(c) { json.string(box_cam_rules.capability_to_string(c)) })
  }
  let drill = fn(d: box_cam_rules.Drill) {
    json.object(
      list.flatten([
        [
          #("safetyNotes", json.string(d.safety_notes)),
          #("restGuidance", json.nullable(d.rest_guidance, json.string)),
          #("ageAppropriateness", json.string(d.age_appropriateness)),
          #(
            "thresholds",
            json.object([
              #("repMinGapMs", num(d.rep_min_gap_ms)),
              #("repMinConfidence", num(d.rep_min_confidence)),
            ]),
          ),
          #("id", json.string(d.id)),
          #("version", json.int(d.version)),
          #("title", json.string(d.title)),
          #("category", json.string(d.category)),
          #("summary", json.string(d.summary)),
          #("targetTypes", json.array(d.target_types, box_target_type.to_json)),
          #("verificationCapabilities", caps(d.verification_capabilities)),
          #(
            "setup",
            json.object([
              #("orientation", json.string(d.setup.orientation)),
              #("distanceM", num(d.setup.distance_m)),
              #("space", json.string(d.setup.space)),
              #("equipment", json.array(d.setup.equipment, json.string)),
              #("framing", json.string(d.setup.framing)),
              #("demo", json.string(d.setup.demo)),
            ]),
          ),
        ],
        case d.rep_support {
          True -> []
          False -> [#("repSupport", json.string("not_configured"))]
        },
        case d.rep_support_note {
          Some(note) -> [#("repSupportNote", json.string(note))]
          None -> []
        },
      ]),
    )
  }
  let provider = fn(p: box_cam_rules.Provider) {
    #(
      box_provider.to_string(p.id),
      json.object(
        list.flatten([
          [
            #("id", box_provider.to_json(p.id)),
            #("version", json.int(p.version)),
            #("status", json.string(p.status)),
          ],
          case p.label {
            Some(l) -> [#("label", json.string(l))]
            None -> []
          },
          [
            #("testOnly", json.bool(p.test_only)),
            #("capabilities", caps(p.capabilities)),
          ],
          case p.id {
            box_provider.ProductionCv -> [
              #("combineVerifiedProtocols", json.preprocessed_array([])),
            ]
            _ -> []
          },
          [#("note", json.string(p.note))],
        ]),
      ),
    )
  }
  let ported =
    json.object([
      #("$source", json.string("domains/development/boxcam/drills.mjs")),
      #("CAPABILITIES", caps(box_cam_rules.capabilities)),
      #("DRILLS", json.array(box_cam_rules.drills, drill)),
      #("PROVIDERS", json.object(list.map(box_cam_rules.providers, provider))),
      #(
        "LIVENESS_CHALLENGES",
        json.array(session_row.liveness_challenge_pairs, fn(p) {
          json.string(p.0)
        }),
      ),
    ])
  let assert Ok(ported) = json.parse(json.to_string(ported), decode.dynamic)
  assert snapshot("development/boxcam/drills.json", decode.dynamic) == ported
}

/// The verification states' player copy, state by state.
pub fn box_cam_state_copy_test() {
  let copy =
    snapshot(
      "development/boxcam/shared.json",
      decode.at(["STATE_COPY"], decode.dict(decode.string, decode.string)),
    )
  let ported =
    list.map(session_row.verification_state_pairs, fn(p) {
      #(p.0, box_cam_rules.state_copy(p.1))
    })
  assert dict.from_list(ported) == copy
  let note =
    snapshot(
      "development/boxcam/shared.json",
      decode.at(["DEV_ACTIVITY_NOTE"], decode.string),
    )
  assert note == box_cam_rules.dev_activity_note
}
