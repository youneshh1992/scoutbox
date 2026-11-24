//// Checks of the rules from the rules suites of platform/contracts, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/list
import gleam/option.{Some}
import scoutbox/discovery/nobody_missed
import scoutbox/vocab/trust_band

// contracts: orderNobodyMissed — Nobody Missed "name": ties fall to the player id
pub fn nobody_missed_name_ties_fall_to_the_player_id_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "name",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "name": ties fall to the player id
pub fn nobody_missed_name_ties_fall_to_the_player_id_2_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "name",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "distance": ties fall to the player id
pub fn nobody_missed_distance_ties_fall_to_the_player_id_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "distance",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "distance": ties fall to the player id
pub fn nobody_missed_distance_ties_fall_to_the_player_id_2_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "distance",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "evidence_confidence": ties fall to the player id
pub fn nobody_missed_evidence_confidence_ties_fall_to_the_player_id_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "evidence_confidence",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "evidence_confidence": ties fall to the player id
pub fn nobody_missed_evidence_confidence_ties_fall_to_the_player_id_2_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "evidence_confidence",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "newest_evidence": ties fall to the player id
pub fn nobody_missed_newest_evidence_ties_fall_to_the_player_id_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "newest_evidence",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "newest_evidence": ties fall to the player id
pub fn nobody_missed_newest_evidence_ties_fall_to_the_player_id_2_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "newest_evidence",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "last_reviewed": ties fall to the player id
pub fn nobody_missed_last_reviewed_ties_fall_to_the_player_id_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "last_reviewed",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}

// contracts: orderNobodyMissed — Nobody Missed "last_reviewed": ties fall to the player id
pub fn nobody_missed_last_reviewed_ties_fall_to_the_player_id_2_test() {
  assert list.map(
      nobody_missed.order(
        [
          nobody_missed.Orderable(
            player_id: "pl-c",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-a",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
          nobody_missed.Orderable(
            player_id: "pl-b",
            name: Some("Sam"),
            distance_km: Some(5.0),
            trust_band: Some(trust_band.EstablishedEvidence),
            last_evidence_at: Some(10),
            reviewed_at: Some(1),
          ),
        ],
        "last_reviewed",
      ),
      fn(o) { o.player_id },
    )
    == ["pl-a", "pl-b", "pl-c"]
}
