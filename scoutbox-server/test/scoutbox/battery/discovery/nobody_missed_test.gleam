//// Checks of the rules from the rules suites of discovery/secondLookAndNobodyMissed, first generated from the
//// TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/discovery/matching/engine
import scoutbox/discovery/nobody_missed
import scoutbox/rows/id
import scoutbox/vocab/playing_level
import scoutbox/vocab/trust_band

// secondLookAndNobodyMissed: isMeaningfullyEvaluated — [neg] viewing a profile, a search result and a Passport is still NOT an evaluation
pub fn neg_viewing_a_profile_a_search_result_and_a_passport_is_still_not_an_eva_test() {
  assert json.to_string(nobody_missed.evaluation(
      ["profile_view", "search_impression", "passport_view"],
      None,
      1_794_744_000_000,
    ))
    == "{\"evaluated\":false,\"signals\":[],\"recentlyDecided\":false,\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: isMeaningfullyEvaluated — a submitted assessment is an evaluation
pub fn a_submitted_assessment_is_an_evaluation_test() {
  assert json.to_string(nobody_missed.evaluation(
      ["assessment_submitted"],
      None,
      1_794_744_000_000,
    ))
    == "{\"evaluated\":true,\"signals\":[\"assessment_submitted\"],\"recentlyDecided\":false,\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: isMeaningfullyEvaluated — a decision yesterday is flagged as recent
pub fn a_decision_yesterday_is_flagged_as_recent_test() {
  assert json.to_string(nobody_missed.evaluation(
      ["room_decided"],
      Some(1_794_657_600_000),
      1_794_744_000_000,
    ))
    == "{\"evaluated\":true,\"signals\":[\"room_decided\"],\"recentlyDecided\":true,\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: isMeaningfullyEvaluated — [neg] a decision 200 days ago is not recent
pub fn neg_a_decision_200_days_ago_is_not_recent_test() {
  assert json.to_string(nobody_missed.evaluation(
      ["room_decided"],
      Some(1_777_464_000_000),
      1_794_744_000_000,
    ))
    == "{\"evaluated\":true,\"signals\":[\"room_decided\"],\"recentlyDecided\":false,\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: buildNobodyMissedCandidate — [neg] an already-evaluated player is never a Nobody Missed candidate
pub fn neg_an_already_evaluated_player_is_never_a_nobody_missed_candidate_test() {
  assert option.map(
      option.map(
        nobody_missed.card(
          engine.Facts(
            player_id: id.player("pl-1"),
            name: "A Player",
            age: Some(17),
            position: Some("CDM"),
            secondary: ["CM"],
            level: Some(playing_level.Amateur),
            foot: Some("Right"),
            availability: Some("seeking"),
            distance_km: Some(10.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            combine: ["box_touch_60"],
            evidence: ["recent_full_match", "combine_verified"],
            last_evidence_at: None,
            last_footage_at: None,
            combine_measurements: [],
          ),
          id.brief("brf-1"),
          1,
          #(True, [
            engine.Reason(
              key: "position",
              met: True,
              text: "Matches position criteria (CDM)",
            ),
            engine.Reason(
              key: "age",
              met: True,
              text: "Matches age criteria (17)",
            ),
            engine.Reason(
              key: "evidence:recent_full_match",
              met: True,
              text: "Recent full match available",
            ),
          ]),
          True,
          False,
        ),
        json.object,
      ),
      json.to_string,
    )
    == None
}

// secondLookAndNobodyMissed: buildNobodyMissedCandidate — [neg] a player with an open room is never a Nobody Missed candidate
pub fn neg_a_player_with_an_open_room_is_never_a_nobody_missed_candidate_test() {
  assert option.map(
      option.map(
        nobody_missed.card(
          engine.Facts(
            player_id: id.player("pl-1"),
            name: "A Player",
            age: Some(17),
            position: Some("CDM"),
            secondary: ["CM"],
            level: Some(playing_level.Amateur),
            foot: Some("Right"),
            availability: Some("seeking"),
            distance_km: Some(10.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            combine: ["box_touch_60"],
            evidence: ["recent_full_match", "combine_verified"],
            last_evidence_at: None,
            last_footage_at: None,
            combine_measurements: [],
          ),
          id.brief("brf-1"),
          1,
          #(True, [
            engine.Reason(
              key: "position",
              met: True,
              text: "Matches position criteria (CDM)",
            ),
            engine.Reason(
              key: "age",
              met: True,
              text: "Matches age criteria (17)",
            ),
            engine.Reason(
              key: "evidence:recent_full_match",
              met: True,
              text: "Recent full match available",
            ),
          ]),
          False,
          True,
        ),
        json.object,
      ),
      json.to_string,
    )
    == None
}

// secondLookAndNobodyMissed: buildNobodyMissedCandidate — the candidate explanation includes the workflow fact
pub fn the_candidate_explanation_includes_the_workflow_fact_test() {
  assert option.map(
      option.map(
        nobody_missed.card(
          engine.Facts(
            player_id: id.player("pl-1"),
            name: "A Player",
            age: Some(17),
            position: Some("CDM"),
            secondary: ["CM"],
            level: Some(playing_level.Amateur),
            foot: Some("Right"),
            availability: Some("seeking"),
            distance_km: Some(10.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            combine: ["box_touch_60"],
            evidence: ["recent_full_match", "combine_verified"],
            last_evidence_at: None,
            last_footage_at: None,
            combine_measurements: [],
          ),
          id.brief("brf-1"),
          1,
          #(True, [
            engine.Reason(
              key: "position",
              met: True,
              text: "Matches position criteria (CDM)",
            ),
            engine.Reason(
              key: "age",
              met: True,
              text: "Matches age criteria (17)",
            ),
            engine.Reason(
              key: "evidence:recent_full_match",
              met: True,
              text: "Recent full match available",
            ),
          ]),
          False,
          False,
        ),
        json.object,
      ),
      json.to_string,
    )
    == Some(
      "{\"playerId\":\"pl-1\",\"briefId\":\"brf-1\",\"briefVersion\":1,\"policyVersion\":1,\"name\":\"A Player\",\"position\":\"CDM\",\"age\":17,\"trustBand\":\"established_evidence\",\"trustNote\":\"Evidence confidence — not football ability.\",\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"},{\"key\":\"no_room\",\"met\":true,\"text\":\"No Recruitment Room in your organisation\"}],\"note\":\"Eligible under your own criteria and not yet evaluated. This is workflow coverage, not a judgement of the player.\"}",
    )
}

// secondLookAndNobodyMissed: evaluationCoverageState — N1: 42 eligible, 30 evaluated gives 12 not yet evaluated and 71% coverage
pub fn n1_42_eligible_30_evaluated_gives_12_not_yet_evaluated_and_71_coverage_test() {
  assert json.to_string(nobody_missed.coverage_state(
      nobody_missed.Coverage(eligible: 42, evaluated: 30),
      3,
    ))
    == "{\"eligible\":42,\"evaluated\":30,\"notYetEvaluated\":12,\"coveragePercent\":71,\"suppressed\":false,\"complete\":false,\"note\":\"Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.\",\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: evaluationCoverageState — the demo brief arithmetic gives 63%
pub fn the_demo_brief_arithmetic_gives_63_test() {
  assert json.to_string(nobody_missed.coverage_state(
      nobody_missed.Coverage(eligible: 8, evaluated: 5),
      3,
    ))
    == "{\"eligible\":8,\"evaluated\":5,\"notYetEvaluated\":3,\"coveragePercent\":63,\"suppressed\":false,\"complete\":false,\"note\":\"Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.\",\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: evaluationCoverageState — 100% coverage is reported as complete
pub fn t_100_coverage_is_reported_as_complete_test() {
  assert json.to_string(nobody_missed.coverage_state(
      nobody_missed.Coverage(eligible: 5, evaluated: 5),
      3,
    ))
    == "{\"eligible\":5,\"evaluated\":5,\"notYetEvaluated\":0,\"coveragePercent\":100,\"suppressed\":false,\"complete\":true,\"note\":\"Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.\",\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: evaluationCoverageState — [neg] a group below the small-n threshold is suppressed
pub fn neg_a_group_below_the_small_n_threshold_is_suppressed_test() {
  assert json.to_string(nobody_missed.coverage_state(
      nobody_missed.Coverage(eligible: 2, evaluated: 1),
      3,
    ))
    == "{\"eligible\":2,\"evaluated\":null,\"notYetEvaluated\":null,\"coveragePercent\":null,\"suppressed\":true,\"note\":\"Fewer than 3 eligible players match this brief — the breakdown is suppressed.\",\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: evaluationCoverageState — no eligible players yields no percentage rather than 0%
pub fn no_eligible_players_yields_no_percentage_rather_than_0_test() {
  assert json.to_string(nobody_missed.coverage_state(
      nobody_missed.Coverage(eligible: 0, evaluated: 0),
      3,
    ))
    == "{\"eligible\":0,\"evaluated\":0,\"notYetEvaluated\":0,\"coveragePercent\":null,\"suppressed\":false,\"complete\":false,\"note\":\"Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.\",\"policyVersion\":1}"
}

// secondLookAndNobodyMissed: orderNobodyMissed — name ordering works
pub fn name_ordering_works_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "b",
            name: Some("B"),
            distance_km: None,
            trust_band: None,
            last_evidence_at: None,
            reviewed_at: None,
          ),
          nobody_missed.Orderable(
            player_id: "a",
            name: Some("A"),
            distance_km: None,
            trust_band: None,
            last_evidence_at: None,
            reviewed_at: None,
          ),
        ],
        "name",
      ),
      fn(o) { o.player_id },
    )
    == ["a", "b"]
}

// secondLookAndNobodyMissed: orderNobodyMissed — evidence-confidence ordering ranks the stronger band first and an unknown band last
pub fn evidence_confidence_ordering_ranks_the_stronger_band_first_and_an_unknow_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "a",
            name: None,
            distance_km: None,
            trust_band: Some(trust_band.LimitedEvidence),
            last_evidence_at: None,
            reviewed_at: None,
          ),
          nobody_missed.Orderable(
            player_id: "c",
            name: None,
            distance_km: None,
            trust_band: None,
            last_evidence_at: None,
            reviewed_at: None,
          ),
          nobody_missed.Orderable(
            player_id: "b",
            name: None,
            distance_km: None,
            trust_band: Some(trust_band.StrongEvidence),
            last_evidence_at: None,
            reviewed_at: None,
          ),
        ],
        "evidence_confidence",
      ),
      fn(o) { o.player_id },
    )
    == ["b", "a", "c"]
}

// secondLookAndNobodyMissed: clampPage — page sizes are clamped
pub fn page_sizes_are_clamped_test() {
  assert nobody_missed.clamp_page(1000.0, 25) == 100
}
