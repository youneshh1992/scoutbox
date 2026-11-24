//// The Trust Score gives the blessed answers on every case in test/fixtures/trust_cases.json (first blessed from
//// the TypeScript server's domains/passport/trust/shared.mjs): the player's own projection, a club's, and the
//// snapshot a Recruitment Room records.

import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/blessed
import scoutbox/passport/trust_rules.{
  AgencyRelationship, AssessmentSource, Authoritative, BoxSession,
  ClubRelationship, CoachRelationship, CombineAttempt, EvidenceItem, HistoryRow,
  Input, OrganisationAttested, ProClubViewer, Reference, Relationship,
  ScoutboxDocumentReview, SelfViewer,
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

pub fn every_case_scores_and_projects_as_blessed_test() {
  let f = blessed.load("trust_cases")
  let cases = blessed.items(blessed.root(f))
  assert list.length(cases) == 600
  list.index_map(cases, fn(c, i) {
    let p =
      trust_rules.calculate(blessed.read(blessed.field(c, "input"), input()))
    let s = trust_rules.snapshot(p)
    let what = "case " <> int.to_string(i)
    [
      blessed.answer(
        blessed.field(c, "self"),
        what <> " self",
        json.string(json.to_string(trust_rules.projection(p, SelfViewer))),
      ),
      blessed.answer(
        blessed.field(c, "club"),
        what <> " club",
        json.string(json.to_string(trust_rules.projection(p, ProClubViewer))),
      ),
      blessed.answer(
        blessed.field(c, "snapshot"),
        what <> " snapshot",
        json.object([
          #("score", json.int(s.score)),
          #("band", json.string(s.band)),
          #("policyVersion", json.int(s.policy_version)),
          #("hash", json.string(s.hash)),
          #("levels", json.object(s.component_levels)),
        ]),
      ),
    ]
  })
  |> list.flatten
  |> blessed.check(f, _)
}
