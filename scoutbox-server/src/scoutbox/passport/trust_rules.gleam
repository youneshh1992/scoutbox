//// The Trust Score (domains/passport/trust/shared.mjs): how strongly a player's football record is supported by
//// trustworthy, current and attributable evidence. Not a talent score or a recommendation, and it grants no
//// permission.
////
//// - A provenance is scored for the kind of fact it supports, not through one universal rank.
//// - A Combine measurement's value is never read, only that a valid standardised measurement exists.
//// - Every category is capped with diminishing returns, so volume cannot buy trust.
//// - Prestige, popularity, recruitment outcomes and payment are not inputs.
//// - Missing evidence is limited evidence, not dishonesty; adding evidence never lowers a score.
////
//// The arithmetic is basis points with one rounding at the end, in the TypeScript order, so the same inputs give
//// the same score on both servers.

import gleam/bit_array
import gleam/crypto
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import scoutbox/platform/json_text

pub const policy_version = 1

pub const disclaimer =
  "ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability."

/// The components, in order, with their weights (they total 100).
pub const weights = [
  #("identity", 15),
  #("footballHistory", 20),
  #("relationships", 20),
  #("evidence", 20),
  #("combine", 15),
  #("references", 10),
]

pub type Band {
  Band(id: String, label: String, min: Int, max: Int)
}

pub const bands = [
  Band("limited_evidence", "Limited evidence", 0, 39),
  Band("developing_evidence", "Developing evidence", 40, 59),
  Band("established_evidence", "Established evidence", 60, 74),
  Band("strong_evidence", "Strong evidence", 75, 89),
  Band("very_strong_evidence", "Very strong evidence", 90, 100),
]

const levels = [
  #("none", "Not yet established", 0),
  #("limited", "Limited", 2500),
  #("established", "Established", 5000),
  #("strong", "Strong", 7500),
  #("very_strong", "Very strong", 9000),
]

/// Coverage for each identity assurance. A ScoutBox document review is worth less than an authoritative source.
const identity_assurance = [
  #("authoritative", 10_000),
  #("organisation_attested", 8500),
  #("scoutbox_document_review", 7000),
  #("none", 0),
]

const history_provenance = [
  #("authoritative_registry", 10_000),
  #("verified_club_confirmed", 10_000),
  #("verified_coach_confirmed", 8000),
  #("scoutbox_reviewed", 7000),
  #("historical_migration", 5000),
  #("system_recorded", 5000),
  #("guardian_submitted", 2500),
  #("player_submitted", 2500),
]

const evidence_provenance = [
  #("authoritative_registry", 10_000),
  #("verified_club_confirmed", 10_000),
  #("verified_coach_confirmed", 8000),
  #("scoutbox_reviewed", 7000),
  #("box_cam_observed", 7000),
  #("system_recorded", 5000),
  #("historical_migration", 5000),
  #("guardian_submitted", 3000),
  #("player_submitted", 3000),
]

const target_confirmed_mass = 2.0

const relationships_curve = [0, 5000, 7500, 9000, 10_000]

const records_curve = [0, 4000, 6000, 7500, 8500, 9200, 10_000]

const records_sub_cap = 6000

const box_cam_curve = [0, 4500, 6500, 8000, 8800, 9400, 10_000]

const box_cam_sub_cap = 6000

/// In the policy, but read by nothing (as in TypeScript).
const recency_days = 365

const protocol_curve = [0, 5500, 8000, 9200, 10_000]

const references_curve = [0, 5500, 8000, 10_000]

// ------------------------------------------------------------------------------------------------------- inputs

/// How the player's identity was confirmed.
pub type Assurance {
  Authoritative
  OrganisationAttested
  ScoutboxDocumentReview
}

pub fn assurance_code(a: Assurance) -> String {
  case a {
    Authoritative -> "authoritative"
    OrganisationAttested -> "organisation_attested"
    ScoutboxDocumentReview -> "scoutbox_document_review"
  }
}

pub fn assurance_rank(a: Assurance) -> Int {
  case a {
    Authoritative -> 3
    OrganisationAttested -> 2
    ScoutboxDocumentReview -> 1
  }
}

/// A club-history row, keyed by its source so the same fact is scored once.
pub type HistoryRow {
  HistoryRow(key: String, provenance: String, current: Bool)
}

pub type RelationshipKind {
  ClubRelationship
  CoachRelationship
  AgencyRelationship
}

pub type Relationship {
  Relationship(key: String, kind: RelationshipKind, verified: Bool)
}

pub type EvidenceItem {
  EvidenceItem(key: String, provenance: String, recorded_at: Int)
}

pub type BoxSession {
  BoxSession(
    key: String,
    verification_state: Option(String),
    simulated: Bool,
    ended_at: Int,
  )
}

pub type CombineAttempt {
  CombineAttempt(
    key: String,
    protocol_id: String,
    protocol_version: Int,
    combine_state: String,
    simulated: Bool,
  )
}

pub type Reference {
  Reference(key: String, verified: Bool)
}

pub type AssessmentSource {
  AssessmentSource(key: String, verified_source: Bool)
}

pub type Input {
  Input(
    is_adult: Bool,
    identity: Option(Assurance),
    history: List(HistoryRow),
    relationships: List(Relationship),
    evidence: List(EvidenceItem),
    box_sessions: List(BoxSession),
    combine: List(CombineAttempt),
    references: List(Reference),
    assessments: List(AssessmentSource),
    allow_simulated: Bool,
  )
}

// ---------------------------------------------------------------------------------------------------- primitives

/// JavaScript's `Math.round`: halves go up.
fn round(x: Float) -> Int {
  float.truncate(float.floor(x +. 0.5))
}

fn clamp_bp(bp: Int) -> Int {
  int.max(0, int.min(10_000, bp))
}

/// applyDiminishingReturns: a curve's value at `count` distinct items; the last entry is the cap.
pub fn diminishing_returns(count: Int, curve: List(Int)) -> Int {
  at(curve, count)
}

fn at(curve: List(Int), count: Int) -> Int {
  let n = int.min(int.max(0, count), list.length(curve) - 1)
  case list.drop(curve, n) {
    [v, ..] -> clamp_bp(v)
    [] -> 0
  }
}

fn lookup(table: List(#(String, Int)), key: String) -> Int {
  case list.key_find(table, key) {
    Ok(v) -> v
    Error(_) -> 0
  }
}

fn weight(component: String) -> Int {
  lookup(weights, component)
}

/// policyWeightsTotal: the policy's weights must total 100.
pub fn weights_total() -> Int {
  list.fold(weights, 0, fn(t, w) { t + w.1 })
}

pub fn band_for_score(score: Int) -> Band {
  let s = int.max(0, int.min(100, score))
  let assert [first, ..] = bands
  list.find(bands, fn(b) { s >= b.min && s <= b.max })
  |> option.from_result
  |> option.unwrap(first)
}

/// canonicalTrustSources: the same fact arrives through several projections; each key is scored once, at its
/// strongest, in the order the keys first appeared.
pub fn canonical(items: List(#(String, Int, a))) -> List(#(String, Int, a)) {
  list.fold(items, [], fn(seen, it) {
    let #(key, bp, _) = it
    case key, list.find(seen, fn(s: #(String, Int, a)) { s.0 == key }) {
      "", _ -> seen
      _, Error(_) -> list.append(seen, [it])
      _, Ok(prev) if bp > prev.1 ->
        list.map(seen, fn(s: #(String, Int, a)) {
          case s.0 == key {
            True -> it
            False -> s
          }
        })
      _, Ok(_) -> seen
    }
  })
}

pub type Signal {
  Signal(code: String, text: String)
}

pub type Component {
  Component(
    weight: Int,
    coverage_bp: Int,
    level: #(String, String),
    reasons: List(String),
    strengths: List(Signal),
    gaps: List(Signal),
    detail: List(#(String, Json)),
  )
}

fn level_for(bp: Int) -> #(String, String) {
  list.fold(levels, #("none", "Not yet established"), fn(out, l) {
    case bp >= l.2 {
      True -> #(l.0, l.1)
      False -> out
    }
  })
}

fn component(
  weight: Int,
  coverage: Int,
  reasons: List(String),
  strengths: List(Signal),
  gaps: List(Signal),
  detail: List(#(String, Json)),
) -> Component {
  let bp = clamp_bp(coverage)
  Component(weight, bp, level_for(bp), reasons, strengths, gaps, detail)
}

fn earned(c: Component) -> Int {
  c.weight * c.coverage_bp
}

fn plural(n: Int, one: String, many: String) -> String {
  case n > 1 {
    True -> many
    False -> one
  }
}

// --------------------------------------------------------------------------------------------- component scorers

fn identity(assurance: Option(Assurance)) -> Component {
  let w = weight("identity")
  case assurance {
    None ->
      component(
        w,
        0,
        ["IDENTITY_NOT_ESTABLISHED"],
        [],
        [
          Signal(
            "IDENTITY_NOT_ESTABLISHED",
            "Your identity has not yet been confirmed on ScoutBox.",
          ),
        ],
        [],
      )
    Some(a) -> {
      let bp = lookup(identity_assurance, assurance_code(a))
      let label = case a {
        Authoritative -> "Identity confirmed by an authoritative source."
        OrganisationAttested ->
          "Identity confirmed by an authorised organisation administrator."
        ScoutboxDocumentReview -> "Identity confirmed by ScoutBox review."
      }
      component(
        w,
        bp,
        ["IDENTITY_" <> string.uppercase(assurance_code(a))],
        [Signal("IDENTITY_CONFIRMED", label)],
        case a {
          ScoutboxDocumentReview -> [
            Signal(
              "IDENTITY_REVIEW_ONLY",
              "Identity was confirmed by document review rather than an authoritative source.",
            ),
          ]
          _ -> []
        },
        [#("assurance", json.string(assurance_code(a)))],
      )
    }
  }
}

/// Historical facts never decay. A sum, not a mean, keeps the score monotonic: a self-submitted entry cannot
/// dilute a confirmed one.
fn football_history(rows: List(HistoryRow)) -> Component {
  let w = weight("footballHistory")
  let rows =
    canonical(
      list.map(rows, fn(r) {
        #(r.key, lookup(history_provenance, r.provenance), r)
      }),
    )
  case rows {
    [] ->
      component(
        w,
        0,
        ["NO_FOOTBALL_HISTORY"],
        [],
        [
          Signal(
            "NO_FOOTBALL_HISTORY",
            "Your Football Passport does not yet contain club history.",
          ),
        ],
        [],
      )
    _ -> {
      let mass =
        list.fold(rows, 0.0, fn(t, c) { t +. int.to_float(c.1) /. 10_000.0 })
      let coverage = clamp_bp(round(mass /. target_confirmed_mass *. 10_000.0))
      let confirmed_current =
        list.any(rows, fn(c) { { c.2 }.current && c.1 >= 7000 })
      let self_only = list.count(rows, fn(c) { c.1 <= 2500 })
      let confirmed = list.count(rows, fn(c) { c.1 >= 8000 })
      let strengths =
        list.flatten([
          case confirmed_current {
            True -> [
              Signal(
                "CURRENT_CLUB_CONFIRMED",
                "Your current club is confirmed.",
              ),
            ]
            False -> []
          },
          case confirmed > 0 {
            True -> [
              Signal(
                "CAREER_RECORD_CONFIRMED",
                int.to_string(confirmed)
                  <> " club record"
                  <> plural(confirmed, " is", "s are")
                  <> " independently confirmed.",
              ),
            ]
            False -> []
          },
        ])
      let gaps =
        list.flatten([
          case confirmed_current {
            True -> []
            False -> [
              Signal(
                "CURRENT_CLUB_UNCONFIRMED",
                "Your current club is not independently confirmed yet.",
              ),
            ]
          },
          case self_only > 0 {
            True -> [
              Signal(
                "HISTORY_PLAYER_SUBMITTED",
                int.to_string(self_only)
                  <> " club entr"
                  <> plural(self_only, "y is", "ies are")
                  <> " provided by the player and not independently confirmed.",
              ),
            ]
            False -> []
          },
        ])
      component(w, coverage, ["HISTORY_COVERAGE"], strengths, gaps, [
        #("rows", json.int(list.length(rows))),
        #("confirmedRows", json.int(confirmed)),
        #(
          "attributableMass",
          json_text.number(int.to_float(round(mass *. 100.0)) /. 100.0),
        ),
      ])
    }
  }
}

fn relationships(rels: List(Relationship), is_adult: Bool) -> Component {
  let w = weight("relationships")
  let usable =
    list.filter(rels, fn(r) {
      r.verified && { r.kind != AgencyRelationship || is_adult }
    })
  let rows = canonical(list.map(usable, fn(r) { #(r.key, 10_000, r) }))
  let n = list.length(rows)
  let coaches = list.count(rows, fn(c) { { c.2 }.kind == CoachRelationship })
  let clubs = list.count(rows, fn(c) { { c.2 }.kind == ClubRelationship })
  let strengths =
    list.flatten([
      case clubs > 0 {
        True -> [
          Signal(
            "CLUB_RELATIONSHIP_CONFIRMED",
            int.to_string(clubs)
              <> " verified club relationship"
              <> plural(clubs, "", "s")
              <> ".",
          ),
        ]
        False -> []
      },
      case coaches > 0 {
        True -> [
          Signal(
            "COACH_RELATIONSHIP_CONFIRMED",
            int.to_string(coaches)
              <> " verified coach relationship"
              <> plural(coaches, "", "s")
              <> ".",
          ),
        ]
        False -> []
      },
    ])
  component(
    w,
    at(relationships_curve, n),
    ["RELATIONSHIP_COVERAGE"],
    strengths,
    case n {
      0 -> [
        Signal(
          "NO_VERIFIED_RELATIONSHIPS",
          "No verified club or coach relationship is recorded yet.",
        ),
      ]
      _ -> []
    },
    [
      #("distinct", json.int(n)),
      #("clubs", json.int(clubs)),
      #("coaches", json.int(coaches)),
    ],
  )
}

fn evidence(
  items: List(EvidenceItem),
  sessions: List(BoxSession),
  allow_simulated: Bool,
) -> Component {
  let w = weight("evidence")
  let recs =
    canonical(
      list.map(items, fn(e) {
        #(e.key, lookup(evidence_provenance, e.provenance), e)
      }),
    )
    |> list.filter(fn(c) { c.1 > 0 })
  let box =
    sessions
    |> list.filter(fn(s) { allow_simulated || !s.simulated })
    |> list.filter(fn(s) {
      s.verification_state == Some("verified")
      || s.verification_state == Some("partially_verified")
    })
    |> list.map(fn(s) { #(s.key, 10_000, s) })
    |> canonical
  let recs_n = list.length(recs)
  let box_n = list.length(box)
  let rec_bp = int.min(at(records_curve, recs_n), records_sub_cap)
  let box_bp = int.min(at(box_cam_curve, box_n), box_cam_sub_cap)
  component(
    w,
    rec_bp + box_bp,
    ["EVIDENCE_COVERAGE"],
    list.flatten([
      case recs_n > 0 {
        True -> [
          Signal(
            "EVIDENCE_RECORDED",
            int.to_string(recs_n)
              <> " provenance-bearing evidence item"
              <> plural(recs_n, "", "s")
              <> " on record.",
          ),
        ]
        False -> []
      },
      case box_n > 0 {
        True -> [
          Signal(
            "BOX_CAM_EVIDENCE",
            int.to_string(box_n)
              <> " Box Cam observed training session"
              <> plural(box_n, "", "s")
              <> ".",
          ),
        ]
        False -> []
      },
    ]),
    case recs_n > 0 {
      True -> []
      False -> [
        Signal(
          "NO_EVIDENCE",
          "No provenance-bearing football evidence is recorded yet.",
        ),
      ]
    },
    [
      #("evidenceItems", json.int(recs_n)),
      #("boxCamSessions", json.int(box_n)),
      #("recordsBp", json.int(rec_bp)),
      #("boxCamBp", json.int(box_bp)),
      #(
        "subCaps",
        json.object([
          #("records", json.int(records_sub_cap)),
          #("boxCam", json.int(box_cam_sub_cap)),
        ]),
      ),
    ],
  )
}

/// The measured value is never read: a personal best adds no trust.
fn combine(attempts: List(CombineAttempt), allow_simulated: Bool) -> Component {
  let w = weight("combine")
  let valid =
    list.filter(attempts, fn(a) {
      a.combine_state == "combine_verified"
      && { allow_simulated || !a.simulated }
    })
  let protocols =
    canonical(
      list.map(valid, fn(a) {
        #(
          "protocol:"
            <> a.protocol_id
            <> "@"
            <> int.to_string(a.protocol_version),
          10_000,
          a,
        )
      }),
    )
  let n = list.length(protocols)
  let excluded =
    list.count(attempts, fn(a) {
      a.simulated && a.combine_state == "combine_verified"
    })
  component(
    w,
    at(protocol_curve, n),
    ["COMBINE_COVERAGE"],
    case n > 0 {
      True -> [
        Signal(
          "COMBINE_VERIFIED",
          int.to_string(n)
            <> " standardized Combine Verified measurement"
            <> plural(n, "", "s")
            <> ".",
        ),
      ]
      False -> []
    },
    case n > 0 {
      True -> []
      False -> [
        Signal(
          "NO_COMBINE_VERIFIED",
          "No production-supported Combine Verified result is currently available.",
        ),
      ]
    },
    [
      #("distinctProtocols", json.int(n)),
      #("validAttempts", json.int(list.length(valid))),
      #("excludedSimulated", json.int(excluded)),
    ],
  )
}

/// A 4/10 and a 9/10 from the same verified evaluator are identical evidence.
fn references(
  refs: List(Reference),
  assessments: List(AssessmentSource),
) -> Component {
  let w = weight("references")
  let items =
    canonical(list.append(
      refs
        |> list.filter(fn(r) { r.verified })
        |> list.map(fn(r) { #(r.key, 10_000, True) }),
      assessments
        |> list.filter(fn(a) { a.verified_source })
        |> list.map(fn(a) { #(a.key, 8000, False) }),
    ))
  let refs_n = list.count(items, fn(i) { i.2 })
  let asmts = list.count(items, fn(i) { !i.2 })
  component(
    w,
    at(references_curve, list.length(items)),
    ["REFERENCE_COVERAGE"],
    list.flatten([
      case refs_n > 0 {
        True -> [
          Signal(
            "REFERENCE_CONFIRMED",
            int.to_string(refs_n)
              <> " reference"
              <> plural(refs_n, "", "s")
              <> " with verified provenance.",
          ),
        ]
        False -> []
      },
      case asmts > 0 {
        True -> [
          Signal(
            "ASSESSMENT_ATTRIBUTED",
            int.to_string(asmts)
              <> " assessment"
              <> plural(asmts, "", "s")
              <> " from a verified evaluator.",
          ),
        ]
        False -> []
      },
    ]),
    case items {
      [] -> [
        Signal(
          "NO_REFERENCES",
          "No verified coach reference is currently present.",
        ),
      ]
      _ -> []
    },
    [#("references", json.int(refs_n)), #("assessments", json.int(asmts))],
  )
}

// -------------------------------------------------------------------------------------------------------- engine

pub type Profile {
  Profile(
    score: Int,
    band: Band,
    components: List(#(String, Component)),
    is_adult: Bool,
    simulated_included: Bool,
  )
}

pub fn calculate(input: Input) -> Profile {
  let components = [
    #("identity", identity(input.identity)),
    #("footballHistory", football_history(input.history)),
    #("relationships", relationships(input.relationships, input.is_adult)),
    #(
      "evidence",
      evidence(input.evidence, input.box_sessions, input.allow_simulated),
    ),
    #("combine", combine(input.combine, input.allow_simulated)),
    #("references", references(input.references, input.assessments)),
  ]
  let available = list.fold(components, 0, fn(t, c) { t + { c.1 }.weight })
  let earned_bp = list.fold(components, 0, fn(t, c) { t + earned(c.1) })
  let score = case available {
    0 -> 0
    _ ->
      int.max(
        0,
        int.min(
          100,
          round(
            int.to_float(earned_bp) /. int.to_float(available * 10_000) *. 100.0,
          ),
        ),
      )
  }
  Profile(
    score:,
    band: band_for_score(score),
    components:,
    is_adult: input.is_adult,
    simulated_included: input.allow_simulated,
  )
}

pub fn strengths(p: Profile) -> List(Signal) {
  list.flat_map(p.components, fn(c) { { c.1 }.strengths })
}

pub fn gaps(p: Profile) -> List(Signal) {
  list.flat_map(p.components, fn(c) { { c.1 }.gaps })
}

fn signal_json(s: Signal) -> Json {
  json.object([#("code", json.string(s.code)), #("text", json.string(s.text))])
}

fn components_json(p: Profile) -> Json {
  json.object(
    list.map(p.components, fn(pair) {
      let c = pair.1
      #(
        pair.0,
        json.object([
          #("weight", json.int(c.weight)),
          #("availableWeight", json.int(c.weight)),
          #("coverageBp", json.int(c.coverage_bp)),
          #("earnedWeightBp", json.int(earned(c))),
          #(
            "level",
            json.object([
              #("id", json.string(c.level.0)),
              #("label", json.string(c.level.1)),
            ]),
          ),
          #("reasons", json.array(c.reasons, json.string)),
          #("strengths", json.array(c.strengths, signal_json)),
          #("gaps", json.array(c.gaps, signal_json)),
          #("detail", json.object(c.detail)),
        ]),
      )
    }),
  )
}

fn explanations_json(p: Profile, full: Bool) -> Json {
  json.array(p.components, fn(pair) {
    let c = pair.1
    json.object(
      list.append(
        [
          #("component", json.string(pair.0)),
          #("level", json.string(c.level.0)),
          #("levelLabel", json.string(c.level.1)),
          #("weight", json.int(c.weight)),
        ],
        case full {
          True -> [
            #("coverage", json.int(round(int.to_float(c.coverage_bp) /. 100.0))),
            #(
              "reasons",
              json.array(list.append(c.strengths, c.gaps), fn(s) {
                json.string(s.text)
              }),
            ),
          ]
          False -> []
        },
      ),
    )
  })
}

/// Who is looking: each sees a different projection of the same profile.
pub type Viewer {
  SelfViewer
  GuardianViewer
  TrustSafetyViewer
  ProClubViewer
  GrassrootsClubViewer
}

fn viewer_code(v: Viewer) -> String {
  case v {
    SelfViewer -> "self"
    GuardianViewer -> "guardian"
    TrustSafetyViewer -> "trust_safety"
    ProClubViewer -> "pro_club"
    GrassrootsClubViewer -> "grassroots_club"
  }
}

pub const club_note = "Evidence confidence — not football ability."

fn context_json(p: Profile) -> Json {
  json.object([
    #("isAdult", json.bool(p.is_adult)),
    #("excludedComponents", json.array([], json.string)),
    #(
      "adultOnlyFacetsExcluded",
      json.array(
        case p.is_adult {
          True -> []
          False -> ["agency_representation"]
        },
        json.string,
      ),
    ),
  ])
}

/// The whole profile, as calculateTrustScore returns it. Only T&S and the player's own views carry most of it.
pub fn profile_json(p: Profile) -> Json {
  json.object([
    #("score", json.int(p.score)),
    #("band", json.string(p.band.id)),
    #("bandLabel", json.string(p.band.label)),
    #("policyVersion", json.int(policy_version)),
    #("disclaimer", json.string(disclaimer)),
    #("components", components_json(p)),
    #("strengths", json.array(strengths(p), signal_json)),
    #("gaps", json.array(gaps(p), signal_json)),
    #("explanations", explanations_json(p, True)),
    #("context", context_json(p)),
    #("simulatedEvidenceIncluded", json.bool(p.simulated_included)),
  ])
}

/// safeTrustProjection: a club sees component levels and the public wording of each signal, never the records.
pub fn projection(p: Profile, viewer: Viewer) -> Json {
  let base = [
    #("score", json.int(p.score)),
    #("band", json.string(p.band.id)),
    #("bandLabel", json.string(p.band.label)),
    #("policyVersion", json.int(policy_version)),
    #("disclaimer", json.string(disclaimer)),
    #("simulatedEvidenceIncluded", json.bool(p.simulated_included)),
    #("viewer", json.string(viewer_code(viewer))),
  ]
  case viewer {
    ProClubViewer | GrassrootsClubViewer ->
      json.object(
        list.append(base, [
          #("explanations", explanations_json(p, False)),
          #("signals", json.array(strengths(p), signal_json)),
          #("note", json.string(club_note)),
        ]),
      )
    SelfViewer | GuardianViewer | TrustSafetyViewer ->
      json.object(
        list.append(base, [
          #("components", components_json(p)),
          #("strengths", json.array(strengths(p), signal_json)),
          #("gaps", json.array(gaps(p), signal_json)),
          #("explanations", explanations_json(p, True)),
          #("context", context_json(p)),
        ]),
      )
  }
}

/// The score a Recruitment Room records at a decision, with the policy that produced it and a hash of the
/// coverage behind it. Levels only: a component's coverage never enters a Room's store.
pub type Snapshot {
  Snapshot(
    score: Int,
    band: String,
    policy_version: Int,
    component_levels: List(#(String, Json)),
    hash: String,
  )
}

/// trustSummary: the score and band, with the top three strengths by code.
pub fn summary_fields(p: Profile) -> List(#(String, Json)) {
  [
    #("score", json.int(p.score)),
    #("band", json.string(p.band.id)),
    #("bandLabel", json.string(p.band.label)),
    #("policyVersion", json.int(policy_version)),
    #(
      "topEvidenceSignals",
      json.array(list.take(strengths(p), 3), fn(s) { json.string(s.code) }),
    ),
  ]
}

/// trustSnapshot, with each component's weight, coverage in whole percent (rounded half up, as `Math.round`) and
/// level.
pub fn snapshot_json(p: Profile, at: Int) -> Json {
  let s = snapshot(p)
  json.object([
    #("at", json.int(at)),
    #("score", json.int(s.score)),
    #("band", json.string(s.band)),
    #("policyVersion", json.int(s.policy_version)),
    #(
      "components",
      json.object(
        list.map(p.components, fn(c) {
          let #(key, comp) = c
          #(
            key,
            json.object([
              #("weight", json.int(comp.weight)),
              #("coverage", json.int({ comp.coverage_bp + 50 } / 100)),
              #("level", json.string(comp.level.0)),
            ]),
          )
        }),
      ),
    ),
    #("hash", json.string(s.hash)),
  ])
}

pub fn snapshot(p: Profile) -> Snapshot {
  let cov =
    json.object(
      list.map(p.components, fn(c) { #(c.0, json.int({ c.1 }.coverage_bp)) }),
    )
  let text =
    json.to_string(
      json.object([
        #("score", json.int(p.score)),
        #("policyVersion", json.int(policy_version)),
        #("cov", cov),
      ]),
    )
  let hash =
    crypto.hash(crypto.Sha256, bit_array.from_string(text))
    |> bit_array.base16_encode
    |> string.lowercase
    |> string.slice(0, 32)
  Snapshot(
    score: p.score,
    band: p.band.id,
    policy_version: policy_version,
    component_levels: list.map(p.components, fn(c) {
      #(c.0, json.string({ { c.1 }.level }.0))
    }),
    hash:,
  )
}

// ------------------------------------------------------------------------------------------------------- policy

fn ints(table: List(#(String, Int))) -> Json {
  json.object(list.map(table, fn(e) { #(e.0, json.int(e.1)) }))
}

fn curve(points: List(Int)) -> Json {
  json.array(points, json.int)
}

pub fn weights_json() -> Json {
  ints(weights)
}

pub fn bands_json() -> Json {
  json.array(bands, fn(b) {
    json.object([
      #("id", json.string(b.id)),
      #("label", json.string(b.label)),
      #("min", json.int(b.min)),
      #("max", json.int(b.max)),
    ])
  })
}

/// The policy's curves, as `/admin/trust-policy` names them.
pub fn curves_json() -> Json {
  json.object([
    #("relationships", curve(relationships_curve)),
    #("combineProtocols", curve(protocol_curve)),
    #("boxCam", curve(box_cam_curve)),
    #("evidenceRecords", curve(records_curve)),
    #("references", curve(references_curve)),
  ])
}

pub fn sub_caps_json() -> Json {
  json.object([
    #("evidenceRecords", json.int(records_sub_cap)),
    #("boxCam", json.int(box_cam_sub_cap)),
  ])
}

/// The whole `POLICY`, from the tables the engine reads; a test proves it equals the snapshot.
pub fn policy_json() -> Json {
  json.object([
    #("version", json.int(policy_version)),
    #("weights", weights_json()),
    #("bands", bands_json()),
    #("identity", ints(identity_assurance)),
    #("historyProvenance", ints(history_provenance)),
    #(
      "history",
      json.object([
        #("targetConfirmedMass", json.int(float.round(target_confirmed_mass))),
      ]),
    ),
    #("relationships", json.object([#("curve", curve(relationships_curve))])),
    #(
      "evidence",
      json.object([
        #("recordsCurve", curve(records_curve)),
        #("recordsSubCap", json.int(records_sub_cap)),
        #("boxCamCurve", curve(box_cam_curve)),
        #("boxCamSubCap", json.int(box_cam_sub_cap)),
        #("recencyDays", json.int(recency_days)),
        #("provenance", ints(evidence_provenance)),
      ]),
    ),
    #("combine", json.object([#("protocolCurve", curve(protocol_curve))])),
    #("references", json.object([#("curve", curve(references_curve))])),
    #(
      "levels",
      json.array(levels, fn(l) {
        json.object([
          #("id", json.string(l.0)),
          #("label", json.string(l.1)),
          #("min", json.int(l.2)),
        ])
      }),
    ),
  ])
}
