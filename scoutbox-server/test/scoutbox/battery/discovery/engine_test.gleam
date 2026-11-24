//// Checks of the rules from the rules suites of discovery/matchingAndWatchlists, discovery/secondLookAndNobodyMissed,
//// first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/discovery/briefs
import scoutbox/discovery/matching/criteria
import scoutbox/discovery/matching/engine
import scoutbox/rows/id
import scoutbox/vocab/playing_level
import scoutbox/vocab/position
import scoutbox/vocab/trust_band

// matchingAndWatchlists: matchPlayerToCriteria — a primary position matches
pub fn a_primary_position_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=CDM",
              class: criteria.Required,
              check: criteria.PositionIn(["CDM"], False),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:85f27e3d\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a secondary position matches by default
pub fn a_secondary_position_matches_by_default_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=CM",
              class: criteria.Required,
              check: criteria.PositionIn(["CM"], False),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"position:in:primaryOnly=false,values=CM\",\"type\":\"position\",\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CM)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:7f989917\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] primaryOnly excludes a secondary position
pub fn neg_primaryonly_excludes_a_secondary_position_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=true,values=CM",
              class: criteria.Required,
              check: criteria.PositionIn(["CM"], True),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"position:in:primaryOnly=true,values=CM\",\"type\":\"position\",\"key\":\"position\",\"met\":false,\"text\":\"Does not match the position criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:64f0d91e\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] a position the player does not play does not match
pub fn neg_a_position_the_player_does_not_play_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=GK",
              class: criteria.Required,
              check: criteria.PositionIn(["GK"], False),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"position:in:primaryOnly=false,values=GK\",\"type\":\"position\",\"key\":\"position\",\"met\":false,\"text\":\"Does not match the position criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:3517f039\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — an age inside the range matches
pub fn an_age_inside_the_range_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "age:between:values=16|18",
              class: criteria.Required,
              check: criteria.Age(criteria.Between(16, 18)),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"age:between:values=16|18\",\"type\":\"age\",\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:ebb40858\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] an age below the range does not match
pub fn neg_an_age_below_the_range_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "age:between:values=18|20",
              class: criteria.Required,
              check: criteria.Age(criteria.Between(18, 20)),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"age:between:values=18|20\",\"type\":\"age\",\"key\":\"age\",\"met\":false,\"text\":\"Age 17 is below the criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:43433f17\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a player inside the radius matches
pub fn a_player_inside_the_radius_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "geography:within_radius:value=20",
              class: criteria.Required,
              check: criteria.WithinRadius(20.0),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"geography:within_radius:value=20\",\"type\":\"geography\",\"key\":\"location\",\"met\":true,\"text\":\"Within the club’s permitted search area\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:72ebb348\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] a player outside the radius does not match
pub fn neg_a_player_outside_the_radius_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "geography:within_radius:value=5",
              class: criteria.Required,
              check: criteria.WithinRadius(5.0),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"geography:within_radius:value=5\",\"type\":\"geography\",\"key\":\"location\",\"met\":false,\"text\":\"Outside the permitted search area\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:713712ad\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — the foot criterion matches the stored fact whatever its casing
pub fn the_foot_criterion_matches_the_stored_fact_whatever_its_casing_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "foot:in:values=Right",
              class: criteria.Required,
              check: criteria.FootIn(["Right"]),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"foot:in:values=Right\",\"type\":\"foot\",\"key\":\"foot\",\"met\":true,\"text\":\"Matches foot criteria (right)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:5017b56e\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] the wrong foot does not match
pub fn neg_the_wrong_foot_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "foot:in:values=Left",
              class: criteria.Required,
              check: criteria.FootIn(["Left"]),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"foot:in:values=Left\",\"type\":\"foot\",\"key\":\"foot\",\"met\":false,\"text\":\"Does not match the foot criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d9697d1d\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a two-footed player satisfies either foot
pub fn a_two_footed_player_satisfies_either_foot_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("Both"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "foot:in:values=Left",
              class: criteria.Required,
              check: criteria.FootIn(["Left"]),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"foot:in:values=Left\",\"type\":\"foot\",\"key\":\"foot\",\"met\":true,\"text\":\"Matches foot criteria (Both)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d9697d1d\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — availability matches exactly
pub fn availability_matches_exactly_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "availability:equals:value=available_now",
              class: criteria.Required,
              check: criteria.AvailabilityIs("available_now"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"availability:equals:value=available_now\",\"type\":\"availability\",\"key\":\"availability\",\"met\":true,\"text\":\"Matches the availability criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:fb1e89ac\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a recorded evidence flag matches
pub fn a_recorded_evidence_flag_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence:exists:value=recent_full_match",
              class: criteria.Required,
              check: criteria.EvidenceExists("recent_full_match"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"evidence:exists:value=recent_full_match\",\"type\":\"evidence\",\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:9a20c454\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] an absent evidence flag does not match
pub fn neg_an_absent_evidence_flag_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence:exists:value=confirmed_current_club",
              class: criteria.Required,
              check: criteria.EvidenceExists("confirmed_current_club"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"evidence:exists:value=confirmed_current_club\",\"type\":\"evidence\",\"key\":\"evidence:confirmed_current_club\",\"met\":false,\"text\":\"Current club confirmed — not on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:2c9ebccd\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — footage inside the window matches
pub fn footage_inside_the_window_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence_recency:within_days:evidenceKind=footage,value=30",
              class: criteria.Required,
              check: criteria.EvidenceWithin(30, criteria.Footage),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"evidence_recency:within_days:evidenceKind=footage,value=30\",\"type\":\"evidence_recency\",\"key\":\"recency:footage:30\",\"met\":true,\"text\":\"Evidence within the last 30 days\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:5de79466\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] footage older than the window does not match
pub fn neg_footage_older_than_the_window_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence_recency:within_days:evidenceKind=footage,value=10",
              class: criteria.Required,
              check: criteria.EvidenceWithin(10, criteria.Footage),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"evidence_recency:within_days:evidenceKind=footage,value=10\",\"type\":\"evidence_recency\",\"key\":\"recency:footage:10\",\"met\":false,\"text\":\"Most recent evidence is older than 10 days\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d6c77210\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — "any" evidence reads the broader clock
pub fn any_evidence_reads_the_broader_clock_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence_recency:within_days:evidenceKind=any,value=15",
              class: criteria.Required,
              check: criteria.EvidenceWithin(15, criteria.AnyEvidence),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"evidence_recency:within_days:evidenceKind=any,value=15\",\"type\":\"evidence_recency\",\"key\":\"recency:any:15\",\"met\":true,\"text\":\"Evidence within the last 15 days\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:730c86d8\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a higher evidence band satisfies a lower floor
pub fn a_higher_evidence_band_satisfies_a_lower_floor_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "trust_band:gte:value=established_evidence",
              class: criteria.Required,
              check: criteria.TrustBandAtLeast(trust_band.EstablishedEvidence),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"trust_band:gte:value=established_evidence\",\"type\":\"trust_band\",\"key\":\"minTrustBand\",\"met\":true,\"text\":\"Evidence confidence meets the criteria (strong_evidence)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:c63f3368\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] a lower band does not satisfy a higher floor
pub fn neg_a_lower_band_does_not_satisfy_a_higher_floor_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "trust_band:gte:value=very_strong_evidence",
              class: criteria.Required,
              check: criteria.TrustBandAtLeast(trust_band.VeryStrongEvidence),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"trust_band:gte:value=very_strong_evidence\",\"type\":\"trust_band\",\"key\":\"minTrustBand\",\"met\":false,\"text\":\"Evidence confidence is below the criteria (strong_evidence)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:09f7fae8\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a production Combine result matches
pub fn a_production_combine_result_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "combine_result:exists:value=combine-box-touch-60",
              class: criteria.Required,
              check: criteria.CombineResult("combine-box-touch-60"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"combine_result:exists:value=combine-box-touch-60\",\"type\":\"combine_result\",\"key\":\"combine:combine-box-touch-60\",\"met\":true,\"text\":\"combine-box-touch-60 Combine Verified result available\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d462dfff\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a Combine measurement above the threshold matches
pub fn a_combine_measurement_above_the_threshold_matches_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "combine_measurement:gte:protocol=combine-box-touch-60,value=150",
              class: criteria.Required,
              check: criteria.CombineMeasurement(
                "combine-box-touch-60",
                criteria.AtLeastValue,
                150.0,
              ),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"combine_measurement:gte:protocol=combine-box-touch-60,value=150\",\"type\":\"combine_measurement\",\"key\":\"combineValue:combine-box-touch-60\",\"met\":true,\"text\":\"combine-box-touch-60 172 meets the club’s threshold (≥ 150)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:ae8a887b\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] a Combine measurement below the threshold does not match
pub fn neg_a_combine_measurement_below_the_threshold_does_not_match_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "combine_measurement:gte:protocol=combine-box-touch-60,value=200",
              class: criteria.Required,
              check: criteria.CombineMeasurement(
                "combine-box-touch-60",
                criteria.AtLeastValue,
                200.0,
              ),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"combine_measurement:gte:protocol=combine-box-touch-60,value=200\",\"type\":\"combine_measurement\",\"key\":\"combineValue:combine-box-touch-60\",\"met\":false,\"text\":\"combine-box-touch-60 172 does not meet the club’s threshold (≥ 200)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:bf3c2823\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — a "at most" threshold is evaluated the other way round
pub fn a_at_most_threshold_is_evaluated_the_other_way_round_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "combine_measurement:lte:protocol=combine-box-touch-60,value=200",
              class: criteria.Required,
              check: criteria.CombineMeasurement(
                "combine-box-touch-60",
                criteria.AtMostValue,
                200.0,
              ),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"combine_measurement:lte:protocol=combine-box-touch-60,value=200\",\"type\":\"combine_measurement\",\"key\":\"combineValue:combine-box-touch-60\",\"met\":true,\"text\":\"combine-box-touch-60 172 meets the club’s threshold (≤ 200)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:0d20a3d4\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no position fact does not satisfy a position criterion
pub fn neg_a36_a_player_with_no_position_fact_does_not_satisfy_a_position_crite_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=CDM",
              class: criteria.Required,
              check: criteria.PositionIn(["CDM"], False),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"key\":\"position\",\"met\":false,\"text\":\"Does not match the position criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:85f27e3d\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no age fact does not satisfy a age criterion
pub fn neg_a36_a_player_with_no_age_fact_does_not_satisfy_a_age_criterion_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "age:gte:value=16",
              class: criteria.Required,
              check: criteria.Age(criteria.AtLeast(16)),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"age:gte:value=16\",\"type\":\"age\",\"key\":\"age\",\"met\":false,\"text\":\"Age is not on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d3f9fcea\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no geography fact does not satisfy a geography criterion
pub fn neg_a36_a_player_with_no_geography_fact_does_not_satisfy_a_geography_cri_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "geography:within_radius:value=50",
              class: criteria.Required,
              check: criteria.WithinRadius(50.0),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"geography:within_radius:value=50\",\"type\":\"geography\",\"key\":\"location\",\"met\":false,\"text\":\"Distance could not be established\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:378387a5\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no level fact does not satisfy a level criterion
pub fn neg_a36_a_player_with_no_level_fact_does_not_satisfy_a_level_criterion_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "level:in:values=amateur",
              class: criteria.Required,
              check: criteria.LevelIn([playing_level.Amateur]),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"level:in:values=amateur\",\"type\":\"level\",\"key\":\"level\",\"met\":false,\"text\":\"Level is not on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:3fd49acb\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no foot fact does not satisfy a foot criterion
pub fn neg_a36_a_player_with_no_foot_fact_does_not_satisfy_a_foot_criterion_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "foot:in:values=Left",
              class: criteria.Required,
              check: criteria.FootIn(["Left"]),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"foot:in:values=Left\",\"type\":\"foot\",\"key\":\"foot\",\"met\":false,\"text\":\"Preferred foot is not on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d9697d1d\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no availability fact does not satisfy a availability criterion
pub fn neg_a36_a_player_with_no_availability_fact_does_not_satisfy_a_availabili_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "availability:equals:value=available_now",
              class: criteria.Required,
              check: criteria.AvailabilityIs("available_now"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"availability:equals:value=available_now\",\"type\":\"availability\",\"key\":\"availability\",\"met\":false,\"text\":\"Availability is not on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:fb1e89ac\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no evidence fact does not satisfy a evidence criterion
pub fn neg_a36_a_player_with_no_evidence_fact_does_not_satisfy_a_evidence_crite_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence:exists:value=recent_full_match",
              class: criteria.Required,
              check: criteria.EvidenceExists("recent_full_match"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"evidence:exists:value=recent_full_match\",\"type\":\"evidence\",\"key\":\"evidence:recent_full_match\",\"met\":false,\"text\":\"Recent full match available — not on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:9a20c454\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no evidence_recency fact does not satisfy a evidence_recency criterion
pub fn neg_a36_a_player_with_no_evidence_recency_fact_does_not_satisfy_a_eviden_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence_recency:within_days:evidenceKind=footage,value=3650",
              class: criteria.Required,
              check: criteria.EvidenceWithin(3650, criteria.Footage),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"evidence_recency:within_days:evidenceKind=footage,value=3650\",\"type\":\"evidence_recency\",\"key\":\"recency:footage:3650\",\"met\":false,\"text\":\"No dated evidence on record\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:bb11a403\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no trust_band fact does not satisfy a trust_band criterion
pub fn neg_a36_a_player_with_no_trust_band_fact_does_not_satisfy_a_trust_band_c_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "trust_band:gte:value=limited_evidence",
              class: criteria.Required,
              check: criteria.TrustBandAtLeast(trust_band.LimitedEvidence),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"trust_band:gte:value=limited_evidence\",\"type\":\"trust_band\",\"key\":\"minTrustBand\",\"met\":false,\"text\":\"Evidence confidence is not available\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:191b23c0\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no combine_result fact does not satisfy a combine_result criterion
pub fn neg_a36_a_player_with_no_combine_result_fact_does_not_satisfy_a_combine_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "combine_result:exists:value=combine-box-touch-60",
              class: criteria.Required,
              check: criteria.CombineResult("combine-box-touch-60"),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"combine_result:exists:value=combine-box-touch-60\",\"type\":\"combine_result\",\"key\":\"combine:combine-box-touch-60\",\"met\":false,\"text\":\"No combine-box-touch-60 Combine Verified result\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d462dfff\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A36 — a player with no combine_measurement fact does not satisfy a combine_measurement criterion
pub fn neg_a36_a_player_with_no_combine_measurement_fact_does_not_satisfy_a_com_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: None,
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "combine_measurement:gte:protocol=combine-box-touch-60,value=0",
              class: criteria.Required,
              check: criteria.CombineMeasurement(
                "combine-box-touch-60",
                criteria.AtLeastValue,
                0.0,
              ),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"combine_measurement:gte:protocol=combine-box-touch-60,value=0\",\"type\":\"combine_measurement\",\"key\":\"combineValue:combine-box-touch-60\",\"met\":false,\"text\":\"No combine-box-touch-60 Combine Verified measurement\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:9c8b6c8d\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — required criteria alone decide membership
pub fn required_criteria_alone_decide_membership_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=CDM",
              class: criteria.Required,
              check: criteria.PositionIn(["CDM"], False),
            ),
          ],
          preferred: [
            criteria.Criterion(
              id: "foot:in:values=Left",
              class: criteria.Preferred,
              check: criteria.FootIn(["Left"]),
            ),
            criteria.Criterion(
              id: "trust_band:gte:value=strong_evidence",
              class: criteria.Preferred,
              check: criteria.TrustBandAtLeast(trust_band.StrongEvidence),
            ),
          ],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"}],\"preferred\":[{\"criterionId\":\"foot:in:values=Left\",\"type\":\"foot\",\"key\":\"foot\",\"met\":false,\"text\":\"Does not match the foot criteria\"},{\"criterionId\":\"trust_band:gte:value=strong_evidence\",\"type\":\"trust_band\",\"key\":\"minTrustBand\",\"met\":true,\"text\":\"Evidence confidence meets the criteria (strong_evidence)\"}],\"preferredMet\":1,\"preferredTotal\":2,\"policyVersion\":1,\"criteriaVersion\":\"cv1:2b833c56\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A40 — an unmet PREFERRED criterion never removes a player from the match set
pub fn neg_a40_an_unmet_preferred_criterion_never_removes_a_player_from_the_mat_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "position:in:primaryOnly=false,values=CDM",
              class: criteria.Required,
              check: criteria.PositionIn(["CDM"], False),
            ),
          ],
          preferred: [
            criteria.Criterion(
              id: "foot:in:values=Left",
              class: criteria.Preferred,
              check: criteria.FootIn(["Left"]),
            ),
          ],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"}],\"preferred\":[{\"criterionId\":\"foot:in:values=Left\",\"type\":\"foot\",\"key\":\"foot\",\"met\":false,\"text\":\"Does not match the foot criteria\"}],\"preferredMet\":0,\"preferredTotal\":1,\"policyVersion\":1,\"criteriaVersion\":\"cv1:ea70e6c4\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — the same facts and criteria at the same instant produce byte-identical explanations
pub fn the_same_facts_and_criteria_at_the_same_instant_produce_byte_identical_e_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "age:gte:value=16",
              class: criteria.Required,
              check: criteria.Age(criteria.AtLeast(16)),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"age:gte:value=16\",\"type\":\"age\",\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:d3f9fcea\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: playerMatchesBrief — Nobody Missed's playerMatchesBrief IS the matching engine — identical output, not a second implementation
pub fn nobody_missed_s_playermatchesbrief_is_the_matching_engine_identical_outp_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          max_level: Some(playing_level.SemiPro),
          min_trust_band: Some(trust_band.EstablishedEvidence),
          radius_km: None,
          foot: None,
          availability: None,
          evidence_requirements: [],
          combine_protocols: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matched\":true,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"level\",\"met\":true,\"text\":\"Within the level criteria\"},{\"key\":\"minTrustBand\",\"met\":true,\"text\":\"Evidence confidence meets the criteria (strong_evidence)\"}]}"
}

// matchingAndWatchlists: matchBrief — Nobody Missed's playerMatchesBrief IS the matching engine — identical output, not a second implementation
pub fn nobody_missed_s_playermatchesbrief_is_the_matching_engine_identical_outp_2_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          max_level: Some(playing_level.SemiPro),
          min_trust_band: Some(trust_band.EstablishedEvidence),
          radius_km: None,
          foot: None,
          availability: None,
          evidence_requirements: [],
          combine_protocols: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matched\":true,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"level\",\"met\":true,\"text\":\"Within the level criteria\"},{\"key\":\"minTrustBand\",\"met\":true,\"text\":\"Evidence confidence meets the criteria (strong_evidence)\"}]}"
}

// matchingAndWatchlists: briefCriteriaToCanonical — [neg] A43 — a Recruitment Brief becomes ALL-required criteria — matching cannot silently soften what a club wrote as a requirement
pub fn neg_a43_a_recruitment_brief_becomes_all_required_criteria_matching_canno_test() {
  assert json.to_string(
      criteria.criteria_json(
        engine.brief_criteria(
          briefs.Criteria(
            positions: [position.CDM],
            min_age: Some(16),
            max_age: Some(18),
            max_level: Some(playing_level.SemiPro),
            min_trust_band: Some(trust_band.EstablishedEvidence),
            radius_km: None,
            foot: None,
            availability: None,
            evidence_requirements: [],
            combine_protocols: [],
          ),
        ),
      ),
    )
    == "{\"required\":[{\"id\":\"position:in:primaryOnly=false,values=CDM\",\"type\":\"position\",\"operator\":\"in\",\"class\":\"required\",\"values\":[\"CDM\"],\"primaryOnly\":false},{\"id\":\"age:between:values=16|18\",\"type\":\"age\",\"operator\":\"between\",\"class\":\"required\",\"values\":[16,18]},{\"id\":\"level:lte:value=semi_pro\",\"type\":\"level\",\"operator\":\"lte\",\"class\":\"required\",\"value\":\"semi_pro\"},{\"id\":\"trust_band:gte:value=established_evidence\",\"type\":\"trust_band\",\"operator\":\"gte\",\"class\":\"required\",\"value\":\"established_evidence\"}],\"preferred\":[],\"schemaVersion\":1}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A25 — a player ages out of a criteria set with no write to any record — the fact changed, not the player
pub fn neg_a25_a_player_ages_out_of_a_criteria_set_with_no_write_to_any_record_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: Some(17),
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "age:lte:value=17",
              class: criteria.Required,
              check: criteria.Age(criteria.AtMost(17)),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":true,\"required\":[{\"criterionId\":\"age:lte:value=17\",\"type\":\"age\",\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:33c5cda6\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A25 — a player ages out of a criteria set with no write to any record — the fact changed, not the player
pub fn neg_a25_a_player_ages_out_of_a_criteria_set_with_no_write_to_any_record_2_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-empty"),
          name: "No Facts",
          age: Some(18),
          position: None,
          secondary: [],
          level: None,
          foot: None,
          availability: None,
          distance_km: None,
          trust_band: None,
          combine: [],
          combine_measurements: [],
          evidence: [],
          last_evidence_at: None,
          last_footage_at: None,
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "age:lte:value=17",
              class: criteria.Required,
              check: criteria.Age(criteria.AtMost(17)),
            ),
          ],
          preferred: [],
        ),
        1_780_272_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"age:lte:value=17\",\"type\":\"age\",\"key\":\"age\",\"met\":false,\"text\":\"Age 18 is above the criteria\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:33c5cda6\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// matchingAndWatchlists: matchPlayerToCriteria — [neg] A25 — evidence expires out of a criteria set as the clock moves, with no player write
pub fn neg_a25_evidence_expires_out_of_a_criteria_set_as_the_clock_moves_with_n_test() {
  assert json.to_string(
      engine.match_json(engine.match(
        engine.Facts(
          player_id: id.player("pl-x"),
          name: "Test Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("right"),
          availability: Some("available_now"),
          distance_km: Some(12.0),
          trust_band: Some(trust_band.StrongEvidence),
          combine: ["combine-box-touch-60"],
          combine_measurements: [#("combine-box-touch-60", 172.0)],
          evidence: ["recent_full_match", "coach_reference", "combine_verified"],
          last_evidence_at: Some(1_779_408_000_000),
          last_footage_at: Some(1_778_544_000_000),
        ),
        criteria.Criteria(
          required: [
            criteria.Criterion(
              id: "evidence_recency:within_days:evidenceKind=footage,value=30",
              class: criteria.Required,
              check: criteria.EvidenceWithin(30, criteria.Footage),
            ),
          ],
          preferred: [],
        ),
        1_785_456_000_000,
      )),
    )
    == "{\"matchesRequired\":false,\"required\":[{\"criterionId\":\"evidence_recency:within_days:evidenceKind=footage,value=30\",\"type\":\"evidence_recency\",\"key\":\"recency:footage:30\",\"met\":false,\"text\":\"Most recent evidence is older than 30 days\"}],\"preferred\":[],\"preferredMet\":0,\"preferredTotal\":0,\"policyVersion\":1,\"criteriaVersion\":\"cv1:5de79466\",\"note\":\"Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.\"}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — a matching player matches
pub fn a_matching_player_matches_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
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
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: None,
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":true,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — [neg] an unknown age fails an age criterion closed
pub fn neg_an_unknown_age_fails_an_age_criterion_closed_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
        engine.Facts(
          player_id: id.player("pl-1"),
          name: "A Player",
          age: None,
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
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: None,
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":false,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":false,\"text\":\"Age is not on record\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — [neg] an unknown distance fails a radius criterion closed
pub fn neg_an_unknown_distance_fails_a_radius_criterion_closed_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
        engine.Facts(
          player_id: id.player("pl-1"),
          name: "A Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Amateur),
          foot: Some("Right"),
          availability: Some("seeking"),
          distance_km: None,
          trust_band: Some(trust_band.EstablishedEvidence),
          combine: ["box_touch_60"],
          evidence: ["recent_full_match", "combine_verified"],
          last_evidence_at: None,
          last_footage_at: None,
          combine_measurements: [],
        ),
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: Some(50.0),
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: None,
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":false,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"location\",\"met\":false,\"text\":\"Distance could not be established\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — [neg] a striker does not match a defensive-midfield brief
pub fn neg_a_striker_does_not_match_a_defensive_midfield_brief_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
        engine.Facts(
          player_id: id.player("pl-1"),
          name: "A Player",
          age: Some(17),
          position: Some("ST"),
          secondary: [],
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
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: None,
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":false,\"reasons\":[{\"key\":\"position\",\"met\":false,\"text\":\"Does not match the position criteria\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — [neg] a missing evidence requirement fails the match
pub fn neg_a_missing_evidence_requirement_fails_the_match_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
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
          evidence: ["combine_verified"],
          last_evidence_at: None,
          last_footage_at: None,
          combine_measurements: [],
        ),
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: None,
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":false,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"evidence:recent_full_match\",\"met\":false,\"text\":\"Recent full match available — not on record\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — [neg] a pro player fails a semi-pro ceiling
pub fn neg_a_pro_player_fails_a_semi_pro_ceiling_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
        engine.Facts(
          player_id: id.player("pl-1"),
          name: "A Player",
          age: Some(17),
          position: Some("CDM"),
          secondary: ["CM"],
          level: Some(playing_level.Pro),
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
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: Some(playing_level.SemiPro),
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: None,
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":false,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"level\",\"met\":false,\"text\":\"Plays at a level above the criteria\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — [neg] evidence confidence below the criteria fails the match
pub fn neg_evidence_confidence_below_the_criteria_fails_the_match_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
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
          trust_band: Some(trust_band.LimitedEvidence),
          combine: ["box_touch_60"],
          evidence: ["recent_full_match", "combine_verified"],
          last_evidence_at: None,
          last_footage_at: None,
          combine_measurements: [],
        ),
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: Some(trust_band.StrongEvidence),
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":false,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"},{\"key\":\"minTrustBand\",\"met\":false,\"text\":\"Evidence confidence is below the criteria (limited_evidence)\"}]}"
}

// secondLookAndNobodyMissed: playerMatchesBrief — evidence confidence above the criteria passes
pub fn evidence_confidence_above_the_criteria_passes_test() {
  assert json.to_string(
      engine.match_brief_json(engine.match_brief(
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
          trust_band: Some(trust_band.VeryStrongEvidence),
          combine: ["box_touch_60"],
          evidence: ["recent_full_match", "combine_verified"],
          last_evidence_at: None,
          last_footage_at: None,
          combine_measurements: [],
        ),
        briefs.Criteria(
          positions: [position.CDM],
          min_age: Some(16),
          max_age: Some(18),
          radius_km: None,
          max_level: None,
          foot: None,
          availability: None,
          evidence_requirements: ["recent_full_match"],
          min_trust_band: Some(trust_band.EstablishedEvidence),
          combine_protocols: [],
        ),
        1_794_744_000_000,
      )),
    )
    == "{\"matched\":true,\"reasons\":[{\"key\":\"position\",\"met\":true,\"text\":\"Matches position criteria (CDM)\"},{\"key\":\"age\",\"met\":true,\"text\":\"Matches age criteria (17)\"},{\"key\":\"evidence:recent_full_match\",\"met\":true,\"text\":\"Recent full match available\"},{\"key\":\"minTrustBand\",\"met\":true,\"text\":\"Evidence confidence meets the criteria (very_strong_evidence)\"}]}"
}
