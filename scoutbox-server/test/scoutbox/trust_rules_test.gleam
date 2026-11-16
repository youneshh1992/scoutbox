//// The ported Trust Score agrees with domains/passport/trust/shared.mjs on every case in
//// test/fixtures/trust_cases.json (written by `node dev/trust_cases.mjs`): the player's own projection, a club's,
//// and the snapshot a Recruitment Room records.

import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/passport/trust_rules.{
  AgencyRelationship, AssessmentSource, Authoritative, BoxSession,
  ClubRelationship, CoachRelationship, CombineAttempt, EvidenceItem, HistoryRow,
  Input, OrganisationAttested, ProClubViewer, Reference, Relationship,
  ScoutboxDocumentReview, SelfViewer,
}
import simplifile

type Case {
  Case(
    input: trust_rules.Input,
    self: String,
    club: String,
    snapshot: #(Int, String, String, List(#(String, String))),
  )
}

fn input() -> decode.Decoder(trust_rules.Input) {
  use is_adult <- decode.field("isAdult", decode.bool)
  use identity <- decode.field("identity", decode.optional(decode.string))
  use history <- decode.field(
    "history",
    decode.list({
      use key <- decode.field("key", decode.string)
      use provenance <- decode.field("provenance", decode.string)
      use current <- decode.field("current", decode.bool)
      decode.success(HistoryRow(key, provenance, current))
    }),
  )
  use relationships <- decode.field(
    "relationships",
    decode.list({
      use key <- decode.field("key", decode.string)
      use kind <- decode.field("kind", decode.string)
      use verified <- decode.field("verified", decode.bool)
      let kind = case kind {
        "club" -> ClubRelationship
        "coach" -> CoachRelationship
        _ -> AgencyRelationship
      }
      decode.success(Relationship(key, kind, verified))
    }),
  )
  use evidence <- decode.field(
    "evidence",
    decode.list({
      use key <- decode.field("key", decode.string)
      use provenance <- decode.field("provenance", decode.string)
      use at <- decode.field("recordedAt", decode.int)
      decode.success(EvidenceItem(key, provenance, at))
    }),
  )
  use box_sessions <- decode.field(
    "boxSessions",
    decode.list({
      use key <- decode.field("key", decode.string)
      use state <- decode.field(
        "verificationState",
        decode.optional(decode.string),
      )
      use simulated <- decode.field("simulated", decode.bool)
      decode.success(BoxSession(key, state, simulated, 1))
    }),
  )
  use combine <- decode.field(
    "combine",
    decode.list({
      use key <- decode.field("key", decode.string)
      use protocol <- decode.field("protocolId", decode.string)
      use version <- decode.field("protocolVersion", decode.int)
      use state <- decode.field("combineState", decode.string)
      use simulated <- decode.field("simulated", decode.bool)
      decode.success(CombineAttempt(key, protocol, version, state, simulated))
    }),
  )
  use references <- decode.field(
    "references",
    decode.list({
      use key <- decode.field("key", decode.string)
      use verified <- decode.field("verified", decode.bool)
      decode.success(Reference(key, verified))
    }),
  )
  use assessments <- decode.field(
    "assessments",
    decode.list({
      use key <- decode.field("key", decode.string)
      use verified <- decode.field("verifiedSource", decode.bool)
      decode.success(AssessmentSource(key, verified))
    }),
  )
  use allow_simulated <- decode.field("allowSimulated", decode.bool)
  decode.success(Input(
    is_adult:,
    identity: case identity {
      Some("authoritative") -> Some(Authoritative)
      Some("organisation_attested") -> Some(OrganisationAttested)
      Some(_) -> Some(ScoutboxDocumentReview)
      None -> None
    },
    history:,
    relationships:,
    evidence:,
    box_sessions:,
    combine:,
    references:,
    assessments:,
    allow_simulated:,
  ))
}

fn cases() -> List(Case) {
  let assert Ok(text) = simplifile.read("test/fixtures/trust_cases.json")
  let snapshot = {
    use score <- decode.field("score", decode.int)
    use band <- decode.field("band", decode.string)
    use hash <- decode.field("hash", decode.string)
    use levels <- decode.field(
      "levels",
      decode.dict(decode.string, decode.string),
    )
    decode.success(#(score, band, hash, dict.to_list(levels)))
  }
  let assert Ok(cases) =
    json.parse(
      text,
      decode.list({
        use input <- decode.field("input", input())
        use self <- decode.field("self", decode.string)
        use club <- decode.field("club", decode.string)
        use snapshot <- decode.field("snapshot", snapshot)
        decode.success(Case(input, self, club, snapshot))
      }),
    )
  cases
}

pub fn every_case_scores_and_projects_as_the_typescript_rule_does_test() {
  let cases = cases()
  assert list.length(cases) == 600
  list.each(cases, fn(c) {
    let p = trust_rules.calculate(c.input)
    assert json.to_string(trust_rules.projection(p, SelfViewer)) == c.self
    assert json.to_string(trust_rules.projection(p, ProClubViewer)) == c.club
    let s = trust_rules.snapshot(p)
    let #(score, band, hash, levels) = c.snapshot
    assert #(s.score, s.band, s.hash) == #(score, band, hash)
    assert list.sort(
        list.map(s.component_levels, fn(l) { #(l.0, json.to_string(l.1)) }),
        fn(a, b) { string.compare(a.0, b.0) },
      )
      == list.sort(
        list.map(levels, fn(l) { #(l.0, json.to_string(json.string(l.1))) }),
        fn(a, b) { string.compare(a.0, b.0) },
      )
  })
}
