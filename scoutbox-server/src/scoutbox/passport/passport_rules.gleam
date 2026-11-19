//// The Football Passport engine (domains/passport/shared.mjs): the timeline, club history, current status,
//// temporal conflicts, gaps and completeness, the revision and what each viewer is shown. It is pure: the
//// sources are read by `passport/sources`. It describes evidence and provenance and scores nobody.
////
//// The TypeScript engine also builds history from verified affiliation claims (`affiliations`), but the
//// Passport's assembly always passes none, so there is no such source here.

import gleam/bit_array
import gleam/crypto
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/set
import gleam/string
import scoutbox/platform/clock
import scoutbox/platform/json_text
import scoutbox/platform/temporal
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/dev_objectives as objective_row
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/passport_achievements as achievement_row
import scoutbox/rows/passport_career_entries as career_row
import scoutbox/rows/passport_prefs as prefs_row
import scoutbox/rows/ver_references as reference_row
import scoutbox/vocab/party
import scoutbox/vocab/playing_level
import scoutbox/vocab/position.{type Position}

// ------------------------------------------------------------------------------------------------ provenance

/// Ordered least to most authoritative; the rank is used only for conflict precedence, never shown as a score.
pub type Provenance {
  PlayerSubmitted
  GuardianSubmitted
  SystemRecorded
  HistoricalMigration
  /// Observed training: stronger than a player's own submission, weaker than a ScoutBox review or any
  /// organisation confirmation, and never an authoritative current-club source.
  BoxCamObserved
  ScoutboxReviewed
  VerifiedCoachConfirmed
  VerifiedClubConfirmed
  AuthoritativeRegistry
}

/// PROVENANCE, in its order.
pub const provenance_pairs = [
  #("player_submitted", PlayerSubmitted),
  #("guardian_submitted", GuardianSubmitted),
  #("system_recorded", SystemRecorded),
  #("historical_migration", HistoricalMigration),
  #("box_cam_observed", BoxCamObserved),
  #("scoutbox_reviewed", ScoutboxReviewed),
  #("verified_coach_confirmed", VerifiedCoachConfirmed),
  #("verified_club_confirmed", VerifiedClubConfirmed),
  #("authoritative_registry", AuthoritativeRegistry),
]

pub fn provenance_to_string(p: Provenance) -> String {
  case p {
    PlayerSubmitted -> "player_submitted"
    GuardianSubmitted -> "guardian_submitted"
    SystemRecorded -> "system_recorded"
    HistoricalMigration -> "historical_migration"
    BoxCamObserved -> "box_cam_observed"
    ScoutboxReviewed -> "scoutbox_reviewed"
    VerifiedCoachConfirmed -> "verified_coach_confirmed"
    VerifiedClubConfirmed -> "verified_club_confirmed"
    AuthoritativeRegistry -> "authoritative_registry"
  }
}

/// provRank: the provenance's place in PROVENANCE.
pub fn provenance_rank(p: Provenance) -> Int {
  case p {
    PlayerSubmitted -> 0
    GuardianSubmitted -> 1
    SystemRecorded -> 2
    HistoricalMigration -> 3
    BoxCamObserved -> 4
    ScoutboxReviewed -> 5
    VerifiedCoachConfirmed -> 6
    VerifiedClubConfirmed -> 7
    AuthoritativeRegistry -> 8
  }
}

fn at_least(p: Provenance, floor: Provenance) -> Bool {
  provenance_rank(p) >= provenance_rank(floor)
}

pub fn provenance_from_method(method: String) -> Provenance {
  case method {
    "authoritative_registry" | "federation_confirmation" ->
      AuthoritativeRegistry
    "organisation_admin_confirmation"
    | "existing_verified_org_admin"
    | "official_domain_email" -> VerifiedClubConfirmed
    "scoutbox_manual_review" -> ScoutboxReviewed
    "migration" -> HistoricalMigration
    _ -> SystemRecorded
  }
}

/// PROVENANCE_COPY: English defaults; clients translate by code.
pub fn provenance_copy(p: Provenance) -> String {
  case p {
    PlayerSubmitted ->
      "Provided by the player. ScoutBox has not independently confirmed this item."
    GuardianSubmitted ->
      "Provided by the player’s guardian. ScoutBox has not independently confirmed this item."
    SystemRecorded ->
      "Recorded automatically by ScoutBox from platform activity."
    HistoricalMigration -> "Carried forward from an earlier ScoutBox record."
    ScoutboxReviewed ->
      "Reviewed by ScoutBox Trust & Safety — a document review, not an independent register check."
    VerifiedCoachConfirmed ->
      "Confirmed by a coach whose club affiliation was verified when they confirmed it."
    VerifiedClubConfirmed ->
      "Confirmed by an authorised administrator of the named organisation."
    AuthoritativeRegistry -> "Confirmed against an authoritative registry."
    BoxCamObserved ->
      "Recorded live through ScoutBox Box Cam. ScoutBox observed activity consistent with the selected supported drill — this describes observed training, not football ability."
  }
}

fn submitted(by: party.Party) -> Provenance {
  case by {
    party.Guardian -> GuardianSubmitted
    party.Player -> PlayerSubmitted
  }
}

fn provenance_json(p: Provenance) -> Json {
  json.string(provenance_to_string(p))
}

// ------------------------------------------------------------------------------------------------ visibility

/// An item's level comes from its source's policy; selections may narrow it, never widen it. The last two are the
/// levels of a club's own trials and assessments, which only that club sees.
pub type Visibility {
  Public
  Recruitment
  Private
  GuardianOnly
  TrustAndSafety
  RecruitmentOwnOrg
  PrivateOwnOrg
}

pub const visibility_pairs = [
  #("public", Public),
  #("recruitment", Recruitment),
  #("private", Private),
  #("guardian_only", GuardianOnly),
  #("trust_and_safety", TrustAndSafety),
  #("recruitment_own_org", RecruitmentOwnOrg),
  #("private_own_org", PrivateOwnOrg),
]

pub type Viewer {
  SelfViewer
  GuardianViewer
  ProClub
  GrassrootsClub
  AgencyViewer
  OtherPlayer
  PublicViewer
  TrustSafety
}

pub const viewer_pairs = [
  #("self", SelfViewer),
  #("guardian", GuardianViewer),
  #("pro_club", ProClub),
  #("grassroots_club", GrassrootsClub),
  #("agency", AgencyViewer),
  #("other_player", OtherPlayer),
  #("public", PublicViewer),
  #("trust_safety", TrustSafety),
]

pub fn viewer_to_string(v: Viewer) -> String {
  case v {
    SelfViewer -> "self"
    GuardianViewer -> "guardian"
    ProClub -> "pro_club"
    GrassrootsClub -> "grassroots_club"
    AgencyViewer -> "agency"
    OtherPlayer -> "other_player"
    PublicViewer -> "public"
    TrustSafety -> "trust_safety"
  }
}

pub fn viewer_sees(viewer: Viewer, visibility: Visibility) -> Bool {
  case viewer {
    TrustSafety -> True
    SelfViewer -> visibility != TrustAndSafety && visibility != GuardianOnly
    GuardianViewer -> visibility != TrustAndSafety
    ProClub | GrassrootsClub | AgencyViewer ->
      visibility == Public || visibility == Recruitment
    OtherPlayer | PublicViewer -> visibility == Public
  }
}

// ------------------------------------------------------------------------------------------------ dates

/// Football history rarely has exact days, so the source precision is kept: no date is invented.
pub type Precision {
  Day
  Month
  Year
}

pub const precision_pairs = [#("day", Day), #("month", Month), #("year", Year)]

fn precision_to_string(p: Precision) -> String {
  case p {
    Day -> "day"
    Month -> "month"
    Year -> "year"
  }
}

fn precision_rank(p: Precision) -> Int {
  case p {
    Day -> 0
    Month -> 1
    Year -> 2
  }
}

/// A normalised date (normWhen): the instant it starts at and how precisely it was given.
pub type When {
  When(t: Int, precision: Precision)
}

/// normWhen of an instant: a day.
pub fn when_at(t: Int) -> When {
  When(t, Day)
}

/// normWhen of `{ year, month }`: a month, or a year without one; None outside 1900–2100 or months 1–12.
pub fn when_of_year(year: Int, month: Option(Int)) -> Option(When) {
  let day = fn(m) { clock_day(pad(year, 4) <> "-" <> pad(m, 2) <> "-01") }
  case year >= 1900 && year <= 2100, month {
    False, _ -> None
    True, None -> day(1) |> option.map(When(_, Year))
    True, Some(m) if m >= 1 && m <= 12 -> day(m) |> option.map(When(_, Month))
    True, Some(_) -> None
  }
}

fn clock_day(s: String) -> Option(Int) {
  case temporal.day_start_ms(s) {
    Ok(t) -> Some(t)
    Error(Nil) -> None
  }
}

/// normWhen of text: `YYYY-MM-DD…` (a real day, so 30 February is refused, not rolled to March), `YYYY-MM` or
/// `YYYY`. Anything else is None: an unparseable date never becomes a guessed timestamp.
pub fn when_of(text: String) -> Option(When) {
  let digits = fn(s) { s != "" && string.to_graphemes(s) |> list.all(is_digit) }
  case string.split(text, "-") {
    [y] ->
      case string.length(y) == 4 && digits(y) {
        True ->
          int.parse(y)
          |> option.from_result
          |> option.then(when_of_year(_, None))
        False -> None
      }
    [y, m] ->
      case
        string.length(y) == 4 && digits(y) && string.length(m) == 2 && digits(m)
      {
        True ->
          case int.parse(y), int.parse(m) {
            Ok(y), Ok(m) -> when_of_year(y, Some(m))
            _, _ -> None
          }
        False -> None
      }
    _ -> {
      let day = string.slice(text, 0, 10)
      case is_day_shape(day) {
        True -> clock_day(day) |> option.map(when_at)
        False -> None
      }
    }
  }
}

fn is_digit(g: String) -> Bool {
  case g {
    "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" -> True
    _ -> False
  }
}

fn is_day_shape(s: String) -> Bool {
  case string.to_graphemes(s) {
    [a, b, c, d, "-", e, f, "-", g, h] ->
      list.all([a, b, c, d, e, f, g, h], is_digit)
    _ -> False
  }
}

fn pad(n: Int, width: Int) -> String {
  string.pad_start(int.to_string(n), width, "0")
}

pub fn when_display(w: When) -> String {
  let day = clock.iso_day(w.t)
  case w.precision {
    Year -> string.slice(day, 0, 4)
    Month -> string.slice(day, 0, 7)
    Day -> day
  }
}

/// A source's date as text (a career entry's, say), as normWhen reads it.
fn when_text(s: Option(String)) -> Option(When) {
  option.then(s, when_of)
}

/// The same source gives the same id, so re-projection makes no duplicates.
pub fn ev_id(
  source_type: String,
  source_id: String,
  semantic: String,
) -> String {
  "pev:" <> source_type <> ":" <> source_id <> ":" <> semantic
}

// ------------------------------------------------------------------------------------------------ sources

/// A value in an event's title, which carries different fields per event type.
pub type Field {
  Text(String)
  Null
  Flag(Bool)
  Count(Int)
  Texts(List(String))
}

fn text_or_null(s: Option(String)) -> Field {
  case s {
    Some(s) -> Text(s)
    None -> Null
  }
}

pub type Source {
  Source(type_: String, id: String)
}

pub type EventOrg {
  EventOrg(id: Option(id.OrgId), name: Option(String))
}

/// org(id, name): None when it has neither.
fn event_org(
  org_id: Option(id.OrgId),
  name: Option(String),
) -> Option(EventOrg) {
  case org_id, name {
    None, None -> None
    _, _ -> Some(EventOrg(org_id, name))
  }
}

/// A squad row or an accepted squad invitation (`rowId` is either's id).
pub type SquadSource {
  SquadSource(
    org_id: id.OrgId,
    org_name: String,
    row_id: String,
    added_at: Int,
    org_verified: Bool,
  )
}

/// Whether a trial was attended, which is what puts it on the timeline. A legacy trial has no attendance records,
/// so it stands for its accepted day; otherwise it is dated by the first attended session.
pub type Attendance {
  Legacy
  AttendedFrom(at: Int, sessions: Int)
  NotAttended
}

pub type TrialSource {
  TrialSource(
    id: id.TrialId,
    org_id: id.OrgId,
    org_name: Option(String),
    proposed_date: Option(String),
    accepted_at: Int,
    attendance: Attendance,
    /// The report's filing instant, when there is one.
    report_at: Option(Int),
  )
}

pub type AssessmentSource {
  AssessmentSource(
    id: id.AssessmentId,
    org_id: id.OrgId,
    org_name: Option(String),
    submitted_at: Option(Int),
    created_at: Int,
    state: assessment_row.State,
  )
}

pub type ReferenceSource {
  ReferenceSource(
    id: id.ReferenceId,
    coach_name: Option(String),
    role_at_time: Option(String),
    org_id: id.OrgId,
    org_name: Option(String),
    relationship: String,
    from_year: Option(Int),
    to_year: Option(Int),
    strengths: String,
    development: String,
    summary: String,
    status: reference_row.Status,
    created_at: Int,
    /// Whether the claim the coach's affiliation was verified by is still verified and current.
    provenance_still_current: Bool,
  )
}

pub type EvidenceSource {
  EvidenceSource(
    id: id.ScoutingEvidenceId,
    claim_type: evidence_row.ClaimType,
    label: String,
    recorded_at: Int,
    tier: evidence_row.VerificationStatus,
    source_kind: evidence_row.SourceKind,
    superseded: Bool,
    expired: Bool,
  )
}

/// No route sets an objective's completion, so only its creation reaches the timeline.
pub type ObjectiveSource {
  ObjectiveSource(
    id: id.ObjectiveId,
    org_id: id.OrgId,
    org_name: Option(String),
    created_at: Int,
    status: objective_row.Status,
  )
}

pub type ApplicationSource {
  ApplicationSource(
    id: String,
    org_id: id.OrgId,
    org_name: Option(String),
    opportunity_title: Option(String),
    created_at: Int,
  )
}

pub type TransitionSource {
  TransitionSource(
    id: id.TransitionCaseId,
    created_at: Int,
    /// The placement's instant and organisation, when the case has one.
    placement: Option(#(Option(Int), Option(String))),
  )
}

pub type SigningSource {
  SigningSource(
    id: id.SigningId,
    org_id: id.OrgId,
    org_name: Option(String),
    ts: Int,
  )
}

pub type OutcomeSource {
  OutcomeSource(
    id: id.OutcomeReportId,
    org_id: id.OrgId,
    org_name: Option(String),
    at: Int,
    note: Option(String),
  )
}

pub type PositionSource {
  PositionSource(
    id: id.PositionEntryId,
    from: String,
    primary: Position,
    secondary: List(Position),
  )
}

/// A Box Session the timeline shows: a milestone (its target completed, or 15 minutes of verified activity).
pub type BoxSessionSource {
  BoxSessionSource(
    id: String,
    ended_at: Option(Int),
    drill_title: String,
    verified_active: String,
    verified_reps: Option(Int),
    target_completed: Bool,
    assigned_by_org: Option(#(id.OrgId, Option(String))),
  )
}

/// A completed Box Challenge; `publisher_name` is the publishing club's, or None for ScoutBox's own.
pub type BoxChallengeSource {
  BoxChallengeSource(
    entry_id: String,
    completed_at: Option(Int),
    title: String,
    publisher_name: Option(String),
    publisher_org: Option(#(id.OrgId, Option(String))),
  )
}

/// Everything the timeline is built from (buildTimeline's `src`).
pub type Sources {
  Sources(
    career_entries: List(career_row.Row),
    squads: List(SquadSource),
    trials: List(TrialSource),
    assessments: List(AssessmentSource),
    references: List(ReferenceSource),
    evidence: List(EvidenceSource),
    objectives: List(ObjectiveSource),
    applications: List(ApplicationSource),
    transitions: List(TransitionSource),
    signings: List(SigningSource),
    outcomes: List(OutcomeSource),
    achievements: List(achievement_row.Row),
    position_history: List(PositionSource),
    box_sessions: List(BoxSessionSource),
    box_challenges: List(BoxChallengeSource),
  )
}

pub const no_sources =
  Sources(
    career_entries: [],
    squads: [],
    trials: [],
    assessments: [],
    references: [],
    evidence: [],
    objectives: [],
    applications: [],
    transitions: [],
    signings: [],
    outcomes: [],
    achievements: [],
    position_history: [],
    box_sessions: [],
    box_challenges: [],
  )

// ------------------------------------------------------------------------------------------------ timeline

/// The trial marks a `trial_attended` event carries: whether it stands for an acceptance (`legacy`), and how many
/// sessions were attended.
pub type TrialMark {
  TrialMark(legacy: Bool, attended_sessions: Option(Int))
}

pub type Event {
  Event(
    id: String,
    type_: String,
    when: When,
    title: List(#(String, Field)),
    org: Option(EventOrg),
    provenance: Provenance,
    visibility: Visibility,
    /// Reaches the public Passport, by explicit selection.
    public_eligible: Bool,
    current: Option(Bool),
    source: Source,
    trial: Option(TrialMark),
  )
}

fn event(
  source_type: String,
  source_id: String,
  semantic: String,
  when: Option(When),
  title: List(#(String, Field)),
  org: Option(EventOrg),
  provenance: Provenance,
  visibility: Visibility,
  source: String,
) -> List(Event) {
  case when {
    None -> []
    Some(when) -> [
      Event(
        id: ev_id(source_type, source_id, semantic),
        type_: semantic,
        when:,
        title:,
        org:,
        provenance:,
        visibility:,
        public_eligible: False,
        current: None,
        source: Source(source, source_id),
        trial: None,
      ),
    ]
  }
}

fn eligible(events: List(Event)) -> List(Event) {
  list.map(events, fn(e) { Event(..e, public_eligible: True) })
}

fn currently(events: List(Event), current: Bool) -> List(Event) {
  list.map(events, fn(e) { Event(..e, current: Some(current)) })
}

pub fn build_timeline(src: Sources) -> List(Event) {
  let career =
    list.flat_map(src.career_entries, fn(c) {
      let cid = id.career_entry_to_string(c.id)
      let o = event_org(None, Some(c.org_name))
      let prov = submitted(c.submitted_by)
      case c.withdrawn_at {
        Some(_) -> []
        None ->
          list.append(
            event(
              "career",
              cid,
              "club_joined",
              when_of(c.from_date),
              [#("org", Text(c.org_name)), #("role", text_or_null(c.role))],
              o,
              prov,
              Recruitment,
              "career_entry",
            )
              |> eligible
              |> currently(c.to_date == None),
            case c.to_date {
              None -> []
              Some(to) ->
                event(
                  "career",
                  cid,
                  "club_left",
                  when_of(to),
                  [#("org", Text(c.org_name))],
                  o,
                  prov,
                  Recruitment,
                  "career_entry",
                )
                |> eligible
            },
          )
      }
    })
  let squads =
    list.flat_map(src.squads, fn(s) {
      event(
        "squad",
        id.org_to_string(s.org_id) <> ":" <> s.row_id,
        "club_joined",
        Some(when_at(s.added_at)),
        [#("org", Text(s.org_name)), #("role", Text("squad"))],
        event_org(Some(s.org_id), Some(s.org_name)),
        case s.org_verified {
          True -> VerifiedClubConfirmed
          False -> SystemRecorded
        },
        Public,
        "squad_row",
      )
      |> currently(True)
    })
  // A trial is not employment. Participation becomes public only by explicit selection; outcomes stay private.
  let trials =
    list.flat_map(src.trials, fn(t) {
      let tid = id.trial_to_string(t.id)
      let o = event_org(Some(t.org_id), t.org_name)
      let title = [#("org", text_or_null(t.org_name))]
      let attended = fn(when, mark) {
        event(
          "trial",
          tid,
          "trial_attended",
          when,
          title,
          o,
          VerifiedClubConfirmed,
          RecruitmentOwnOrg,
          "trial",
        )
        |> eligible
        |> list.map(fn(e) { Event(..e, trial: Some(mark)) })
      }
      let by_acceptance = case t.proposed_date {
        Some(d) -> when_of(d)
        None -> Some(when_at(t.accepted_at))
      }
      list.append(
        case t.attendance {
          Legacy -> attended(by_acceptance, TrialMark(True, None))
          AttendedFrom(at, sessions) ->
            attended(Some(when_at(at)), TrialMark(False, Some(sessions)))
          NotAttended -> []
        },
        case t.report_at {
          None -> []
          Some(at) ->
            event(
              "trial",
              tid,
              "trial_outcome",
              Some(when_at(at)),
              title,
              o,
              VerifiedClubConfirmed,
              PrivateOwnOrg,
              "trial",
            )
        },
      )
    })
  // Existence only: raw notes never travel.
  let assessments =
    list.flat_map(src.assessments, fn(a) {
      event(
        "assessment",
        id.assessment_to_string(a.id),
        "assessment_completed",
        Some(when_at(option.unwrap(a.submitted_at, a.created_at))),
        [#("org", text_or_null(a.org_name))],
        event_org(Some(a.org_id), a.org_name),
        VerifiedClubConfirmed,
        RecruitmentOwnOrg,
        "assessment",
      )
    })
  let references =
    list.flat_map(src.references, fn(r) {
      event(
        "reference",
        id.reference_to_string(r.id),
        "reference_received",
        Some(when_at(r.created_at)),
        [
          #("coach", text_or_null(r.coach_name)),
          #("org", text_or_null(r.org_name)),
        ],
        event_org(Some(r.org_id), r.org_name),
        VerifiedCoachConfirmed,
        Recruitment,
        "coach_reference",
      )
    })
  // Only footage makes the timeline; the summary covers the rest.
  let evidence =
    list.flat_map(src.evidence, fn(e) {
      case e.claim_type == evidence_row.Footage && !e.superseded {
        False -> []
        True ->
          event(
            "evidence",
            id.scouting_evidence_to_string(e.id),
            "evidence_added",
            Some(when_at(e.recorded_at)),
            [#("label", Text(e.label))],
            None,
            case e.tier, e.source_kind {
              evidence_row.ClubAssessed, _ -> VerifiedClubConfirmed
              evidence_row.CoachConfirmed, _ -> VerifiedCoachConfirmed
              _, evidence_row.Guardian -> GuardianSubmitted
              _, _ -> PlayerSubmitted
            },
            Recruitment,
            "evidence",
          )
          |> eligible
      }
    })
  let objectives =
    list.flat_map(src.objectives, fn(oj) {
      event(
        "objective",
        id.objective_to_string(oj.id),
        "development_objective_created",
        Some(when_at(oj.created_at)),
        [#("org", text_or_null(oj.org_name))],
        event_org(Some(oj.org_id), oj.org_name),
        VerifiedClubConfirmed,
        Private,
        "dev_objective",
      )
    })
  let applications =
    list.flat_map(src.applications, fn(ap) {
      event(
        "application",
        ap.id,
        "opportunity_application",
        Some(when_at(ap.created_at)),
        [
          #("org", text_or_null(ap.org_name)),
          #("opportunity", text_or_null(ap.opportunity_title)),
        ],
        event_org(Some(ap.org_id), ap.org_name),
        SystemRecorded,
        Private,
        "application",
      )
    })
  let transitions =
    list.flat_map(src.transitions, fn(t) {
      let tid = id.transition_case_to_string(t.id)
      list.append(
        event(
          "transition",
          tid,
          "transition_opened",
          Some(when_at(t.created_at)),
          [],
          None,
          SystemRecorded,
          Private,
          "transition",
        ),
        case t.placement {
          None -> []
          Some(#(at, org_name)) ->
            event(
              "transition",
              tid,
              "transition_completed",
              Some(when_at(option.unwrap(at, t.created_at))),
              [#("org", text_or_null(org_name))],
              None,
              SystemRecorded,
              Private,
              "transition",
            )
        },
      )
    })
  let signings =
    list.flat_map(src.signings, fn(s) {
      event(
        "signing",
        id.signing_to_string(s.id),
        "signed",
        Some(when_at(s.ts)),
        [#("org", text_or_null(s.org_name))],
        event_org(Some(s.org_id), s.org_name),
        VerifiedClubConfirmed,
        Public,
        "signing",
      )
    })
  let outcomes =
    list.flat_map(src.outcomes, fn(o) {
      event(
        "outcome",
        id.outcome_report_to_string(o.id),
        "role_or_squad_changed",
        Some(when_at(o.at)),
        [#("org", text_or_null(o.org_name)), #("note", text_or_null(o.note))],
        event_org(Some(o.org_id), o.org_name),
        VerifiedClubConfirmed,
        Recruitment,
        "outcome_report",
      )
    })
  let achievements =
    list.flat_map(src.achievements, fn(a) {
      case a.withdrawn_at {
        Some(_) -> []
        None ->
          event(
            "achievement",
            id.achievement_to_string(a.id),
            "achievement",
            when_text(a.when_date),
            [#("label", Text(a.title)), #("org", text_or_null(a.org_name))],
            None,
            achievement_provenance(a),
            Recruitment,
            "achievement",
          )
          |> eligible
      }
    })
  // The caller passes milestones only, so the timeline is not flooded with every minor session.
  let box_sessions =
    list.flat_map(src.box_sessions, fn(b) {
      event(
        "box_session",
        b.id,
        "box_session_completed",
        option.map(b.ended_at, when_at),
        [
          #("drill", Text(b.drill_title)),
          #("verifiedActive", Text(b.verified_active)),
          #("reps", case b.verified_reps {
            Some(n) -> Count(n)
            None -> Null
          }),
          #("targetCompleted", Flag(b.target_completed)),
        ],
        option.map(b.assigned_by_org, fn(o) { EventOrg(Some(o.0), o.1) }),
        BoxCamObserved,
        Private,
        "box_session",
      )
    })
  let box_challenges =
    list.flat_map(src.box_challenges, fn(c) {
      event(
        "box_challenge",
        c.entry_id,
        "box_challenge_completed",
        option.map(c.completed_at, when_at),
        [
          #("label", Text(c.title)),
          #("publisher", Text(option.unwrap(c.publisher_name, "ScoutBox"))),
        ],
        option.map(c.publisher_org, fn(o) { EventOrg(Some(o.0), o.1) }),
        BoxCamObserved,
        Recruitment,
        "box_challenge_entry",
      )
      |> eligible
    })
  let positions =
    list.flat_map(src.position_history, fn(p) {
      event(
        "position",
        id.position_entry_to_string(p.id),
        "position_change",
        when_of(p.from),
        [
          #("primary", Text(position.to_string(p.primary))),
          #("secondary", Texts(list.map(p.secondary, position.to_string))),
        ],
        None,
        PlayerSubmitted,
        Recruitment,
        "position_entry",
      )
    })
  [
    career,
    squads,
    trials,
    assessments,
    references,
    evidence,
    objectives,
    applications,
    transitions,
    signings,
    outcomes,
    achievements,
    box_sessions,
    box_challenges,
    positions,
  ]
  |> list.flatten
  |> first_of_each_id
  // Newest first, finer precision first on ties, then id.
  |> list.sort(fn(a, b) {
    int.compare(b.when.t, a.when.t)
    |> order.lazy_break_tie(fn() {
      int.compare(
        precision_rank(a.when.precision),
        precision_rank(b.when.precision),
      )
    })
    |> order.lazy_break_tie(fn() { string_before(a.id, b.id) })
  })
}

fn sorted_by(items: List(a), key: fn(a) -> String) -> List(a) {
  list.sort(items, fn(a, b) { string_before(key(a), key(b)) })
}

/// `a < b ? -1 : 1`: JavaScript's comparator here never answers "equal".
fn string_before(a: String, b: String) -> order.Order {
  case string.compare(a, b) {
    order.Lt -> order.Lt
    _ -> order.Gt
  }
}

fn first_of_each_id(events: List(Event)) -> List(Event) {
  list.fold(events, #(set.new(), []), fn(acc, e) {
    let #(seen, out) = acc
    case set.contains(seen, e.id) {
      True -> acc
      False -> #(set.insert(seen, e.id), [e, ..out])
    }
  }).1
  |> list.reverse
}

fn achievement_provenance(a: achievement_row.Row) -> Provenance {
  case a.confirmation_provenance {
    Some(achievement_row.VerifiedClubConfirmed) -> VerifiedClubConfirmed
    None -> submitted(a.submitted_by)
  }
}

// ------------------------------------------------------------------------------------------------ club history

pub type HistoryRow {
  HistoryRow(
    key: String,
    org_id: Option(id.OrgId),
    org_name: Option(String),
    role: Option(String),
    from: Option(When),
    to: Option(When),
    current: Bool,
    provenance: Provenance,
    source: Source,
  )
}

/// A signing as club history reads it: its end from an outcome report, and whether its organisation is suspended.
pub type SigningRow {
  SigningRow(
    id: id.SigningId,
    org_id: id.OrgId,
    org_name: Option(String),
    ts: Int,
    ended_at: Option(Int),
    org_suspended: Bool,
  )
}

/// A self entry folded into the authoritative row for the same club.
pub type Folded {
  Folded(entry_id: id.CareerEntryId, into: String)
}

pub type History {
  History(rows: List(HistoryRow), folded: List(Folded))
}

/// Self entries that duplicate an authoritative row are folded into it (and flagged for the self view). A trial
/// never creates a club-history row.
pub fn club_history(
  signings: List(SigningRow),
  squads: List(SquadSource),
  career_entries: List(career_row.Row),
) -> History {
  let rows =
    list.map(signings, fn(sg) {
      HistoryRow(
        key: "signing:" <> id.signing_to_string(sg.id),
        org_id: Some(sg.org_id),
        org_name: sg.org_name,
        role: None,
        from: Some(when_at(sg.ts)),
        to: option.map(sg.ended_at, when_at),
        current: sg.ended_at == None && !sg.org_suspended,
        provenance: VerifiedClubConfirmed,
        source: Source("signing", id.signing_to_string(sg.id)),
      )
    })
  let rows =
    list.fold(squads, rows, fn(rows, s) {
      let org = Some(s.org_id)
      // A claim or a signing already covers it.
      case list.any(rows, fn(r) { r.org_id == org && r.current }) {
        True -> rows
        False ->
          list.append(rows, [
            HistoryRow(
              key: "squad:" <> id.org_to_string(s.org_id),
              org_id: org,
              org_name: Some(s.org_name),
              role: Some("squad"),
              from: Some(when_at(s.added_at)),
              to: None,
              current: True,
              provenance: case s.org_verified {
                True -> VerifiedClubConfirmed
                False -> SystemRecorded
              },
              source: Source(
                "squad_row",
                id.org_to_string(s.org_id) <> ":" <> s.row_id,
              ),
            ),
          ])
      }
    })
  let norm = fn(s: Option(String)) {
    option.unwrap(s, "") |> string.trim |> string.lowercase
  }
  let #(rows, folded) =
    list.fold(career_entries, #(rows, []), fn(acc, c) {
      let #(rows, folded) = acc
      let name = norm(Some(c.org_name))
      case c.withdrawn_at, list.find(rows, fn(r) { norm(r.org_name) == name }) {
        Some(_), _ -> acc
        None, Ok(authoritative) -> #(rows, [
          Folded(c.id, authoritative.key),
          ..folded
        ])
        None, Error(Nil) -> #(
          list.append(rows, [
            HistoryRow(
              key: "career:" <> id.career_entry_to_string(c.id),
              org_id: None,
              org_name: Some(c.org_name),
              role: c.role,
              from: when_of(c.from_date),
              to: when_text(c.to_date),
              current: c.to_date == None,
              provenance: submitted(c.submitted_by),
              source: Source("career_entry", id.career_entry_to_string(c.id)),
            ),
          ]),
          folded,
        )
      }
    })
  let from_t = fn(r: HistoryRow) {
    case r.from {
      Some(w) -> w.t
      None -> 0
    }
  }
  History(
    rows: list.sort(rows, fn(a, b) {
      int.compare(from_t(b), from_t(a))
      |> order.lazy_break_tie(fn() { string_before(a.key, b.key) })
    }),
    folded: list.reverse(folded),
  )
}

// ------------------------------------------------------------------------------------------------ current status

pub type Positions {
  Positions(primary: Option(Position), secondary: List(Position))
}

/// The player's Passport preferences (blankPrefs when they never saved any).
pub type Prefs {
  Prefs(
    bio: Option(String),
    positions: Option(Positions),
    availability: Option(prefs_row.Availability),
    available_from: Option(String),
    public_selections: List(String),
    position_history: List(PositionSource),
  )
}

pub const blank_prefs =
  Prefs(
    bio: None,
    positions: None,
    availability: None,
    available_from: None,
    public_selections: [],
    position_history: [],
  )

/// The representation in force (the access predicate's own rule, so a mandate that has not started is not the
/// headline), as the Passport names it.
pub type Representation {
  Representation(
    agency_name: Option(String),
    agent_display_name: Option(String),
    scope: List(scope_row.Scope),
    /// The agreement's confirmation, or its start.
    since: Option(Int),
  )
}

pub type CurrentClub {
  CurrentClub(
    org_id: Option(id.OrgId),
    org_name: Option(String),
    role: Option(String),
    since: Option(String),
    provenance: Provenance,
  )
}

/// A player's current club as they submitted it, against the authoritative one.
pub type ClubConflict {
  ClubConflict(authoritative: HistoryRow, submitted: HistoryRow)
}

pub type Status {
  Status(
    current_club: Option(CurrentClub),
    positions: Option(Positions),
    availability: Option(prefs_row.Availability),
    available_from: Option(String),
    representation: Option(Representation),
    /// Whether ScoutBox has confirmed the player's identity.
    identity: Bool,
    conflicts: List(ClubConflict),
  )
}

/// Player input never silently wins over an authoritative current record: it becomes a flagged conflict for the
/// self view instead.
pub fn current_status(
  history: History,
  prefs: Option(Prefs),
  representation: Option(Representation),
  identity: Bool,
) -> Status {
  let authoritative =
    list.find(history.rows, fn(r) {
      r.current && at_least(r.provenance, ScoutboxReviewed)
    })
  let self_current =
    list.find(history.rows, fn(r) {
      r.current
      && {
        r.provenance == PlayerSubmitted || r.provenance == GuardianSubmitted
      }
    })
  let conflicts = case authoritative, self_current {
    Ok(a), Ok(s) if a.key != s.key -> [ClubConflict(a, s)]
    _, _ -> []
  }
  let current = case authoritative {
    Ok(a) -> Some(a)
    Error(Nil) ->
      list.find(history.rows, fn(r) { r.current }) |> option.from_result
  }
  Status(
    current_club: option.map(current, fn(c) {
      CurrentClub(
        org_id: c.org_id,
        org_name: c.org_name,
        role: c.role,
        since: option.map(c.from, when_display),
        provenance: c.provenance,
      )
    }),
    positions: option.then(prefs, fn(p) { p.positions }),
    availability: option.then(prefs, fn(p) { p.availability }),
    available_from: option.then(prefs, fn(p) { p.available_from }),
    representation:,
    identity:,
    conflicts:,
  )
}

// ------------------------------------------------------------------------------------------------ temporal

/// Impossible chronology, flagged for correction (TEMPORAL_CONFLICT), never treated as fraud.
pub type TemporalConflict {
  BeforeDob(event_id: String)
  FarFuture(event_id: String)
  LeftBeforeJoined(key: String)
  OverlappingCurrentAuthoritative(keys: List(String))
}

pub fn temporal_conflicts(
  events: List(Event),
  history: List(HistoryRow),
  dob: Option(String),
  now: Int,
) -> List(TemporalConflict) {
  let dob_t = option.then(dob, when_of) |> option.map(fn(w) { w.t })
  let by_event =
    list.flat_map(events, fn(e) {
      list.append(
        case dob_t {
          Some(d) if e.when.t < d -> [BeforeDob(e.id)]
          _ -> []
        },
        case e.when.t > now + 400 * 86_400_000 {
          True -> [FarFuture(e.id)]
          False -> []
        },
      )
    })
  let by_row =
    list.flat_map(history, fn(r) {
      case r.from, r.to {
        Some(from), Some(to) if to.t < from.t -> [LeftBeforeJoined(r.key)]
        _, _ -> []
      }
    })
  let exclusive =
    list.filter(history, fn(r) {
      r.current
      && r.role != Some("squad")
      && at_least(r.provenance, ScoutboxReviewed)
    })
  let overlapping = case exclusive {
    [_, _, ..] -> [
      OverlappingCurrentAuthoritative(list.map(exclusive, fn(r) { r.key })),
    ]
    _ -> []
  }
  list.flatten([by_event, by_row, overlapping])
}

// ------------------------------------------------------------------------------------------------ gaps

pub const gap_rules_version = 2

/// What the gap rules are evaluated over.
pub type Facts {
  Facts(
    has_recent_full_match: Bool,
    full_match_count: Int,
    clip_count: Int,
    reference_count: Int,
    has_confirmed_current_club: Bool,
    has_recent_assessment: Bool,
    has_position: Bool,
    has_availability: Bool,
    identity_confirmed: Bool,
    history_rows: Int,
    has_recent_training_evidence: Bool,
  )
}

pub type GapRule {
  GapRule(
    id: String,
    version: Int,
    category: String,
    applies: fn(Facts) -> Bool,
  )
}

/// GAP_RULES. A gap resolves itself when its condition turns false. `test/scoutbox/spec_test.gleam` proves their
/// data equals GAP_RULE_TABLE.
pub fn gap_rules() -> List(GapRule) {
  [
    GapRule("gap.full_match_recent", 1, "match_evidence", fn(f) {
      !f.has_recent_full_match
    }),
    // Contextual and optional: not daily-training pressure.
    GapRule("gap.training_evidence", 2, "training", fn(f) {
      !f.has_recent_training_evidence
    }),
    GapRule("gap.coach_reference", 1, "references", fn(f) {
      f.reference_count == 0
    }),
    GapRule("gap.current_club_confirmed", 1, "club_history", fn(f) {
      !f.has_confirmed_current_club
    }),
    GapRule("gap.assessment_recent", 1, "assessments", fn(f) {
      !f.has_recent_assessment
    }),
    GapRule("gap.position_declared", 1, "position", fn(f) { !f.has_position }),
    GapRule("gap.availability_set", 1, "availability", fn(f) {
      !f.has_availability
    }),
    GapRule("gap.identity_confirmed", 1, "identity", fn(f) {
      !f.identity_confirmed
    }),
    GapRule("gap.career_history", 1, "career", fn(f) { f.history_rows == 0 }),
  ]
}

pub type Gap {
  Gap(id: String, version: Int, category: String)
}

pub fn evaluate_gaps(facts: Facts) -> List(Gap) {
  gap_rules()
  |> list.filter(fn(r) { r.applies(facts) })
  |> list.map(fn(r) { Gap(r.id, r.version, r.category) })
}

pub type Completeness {
  Completeness(coverage: String, gaps: List(Gap), satisfied: Int, total: Int)
}

/// Coverage words, not ability or a score. The denominator is the generic rule list, never a club's confidential
/// criteria.
pub fn completeness(facts: Facts) -> Completeness {
  let gaps = evaluate_gaps(facts)
  let total = list.length(gap_rules())
  let point = fn(b) {
    case b {
      True -> 1
      False -> 0
    }
  }
  let points =
    point(facts.full_match_count > 0)
    + point(facts.has_recent_full_match)
    + point(facts.clip_count > 0)
    + point(facts.reference_count > 0)
    + point(facts.has_recent_assessment)
  Completeness(
    coverage: case points {
      p if p >= 4 -> "strong"
      p if p >= 2 -> "moderate"
      _ -> "limited"
    },
    gaps:,
    satisfied: total - list.length(gaps),
    total:,
  )
}

pub fn completeness_json(c: Completeness) -> Json {
  json.object([
    #("evidenceCoverage", json.string(c.coverage)),
    #("gaps", json.array(c.gaps, gap_json)),
    #(
      "eligibility",
      json.object([
        #("satisfied", json.int(c.satisfied)),
        #("total", json.int(c.total)),
        #("rulesVersion", json.int(gap_rules_version)),
        #("missing", json.array(c.gaps, fn(g) { json.string(g.id) })),
      ]),
    ),
  ])
}

pub fn gap_json(g: Gap) -> Json {
  json.object([
    #("id", json.string(g.id)),
    #("version", json.int(g.version)),
    #("category", json.string(g.category)),
  ])
}

// ------------------------------------------------------------------------------------------------ shares

/// sha256 of text, in hex: how a share's token is stored.
pub fn sha256(s: String) -> String {
  crypto.hash(crypto.Sha256, bit_array.from_string(s))
  |> bit_array.base16_encode
  |> string.lowercase
}

/// A new share's secret: 24 random bytes, base64url.
pub fn mint_share_secret() -> String {
  crypto.strong_random_bytes(24) |> bit_array.base64_url_encode(False)
}

pub type ShareProblem {
  ShareUnknown
  ShareRevoked
  ShareExpired
  SubjectRemoved
}

pub fn share_problem_code(p: ShareProblem) -> String {
  case p {
    ShareUnknown -> "SHARE_UNKNOWN"
    ShareRevoked -> "SHARE_REVOKED"
    ShareExpired -> "SHARE_EXPIRED"
    SubjectRemoved -> "SUBJECT_REMOVED"
  }
}

/// Why a share can't be opened, if it can't: shares are multi-use until revoked or expired. The route shows every
/// failure as the same 404. `share` is its revocation and expiry instants.
pub fn share_problem(
  share: Option(#(Option(Int), Option(Int))),
  now: Int,
  player_removed: Bool,
) -> Option(ShareProblem) {
  case share {
    None -> Some(ShareUnknown)
    Some(#(Some(_), _)) -> Some(ShareRevoked)
    Some(#(None, Some(expires))) if expires < now -> Some(ShareExpired)
    Some(_) if player_removed -> Some(SubjectRemoved)
    Some(_) -> None
  }
}

// ------------------------------------------------------------------------------------------------ the assembled Passport

pub type PlayerFacts {
  PlayerFacts(
    id: id.PlayerId,
    name: String,
    age: Option(Int),
    minor: Bool,
    position: Option(Position),
    city: Option(String),
    level: Option(playing_level.PlayingLevel),
  )
}

pub type EvidenceSummary {
  EvidenceSummary(
    full_matches: Int,
    clips: Int,
    assessments: Int,
    references: Int,
    last_evidence_days: Option(Int),
    note: String,
  )
}

/// A career entry as the revision reads it.
pub type CareerMark {
  CareerMark(id: id.CareerEntryId, withdrawn: Bool)
}

/// A Combine Verified personal best, as the revision reads it. An invalidated result is absent, so the revision
/// moves on invalidation and back on restoration.
pub type CombineMark {
  CombineMark(protocol_id: String, protocol_version: Int, measured_value: Float)
}

/// Everything a projection is cut from (assemble's `full`).
pub type Full {
  Full(
    player: PlayerFacts,
    identity: Bool,
    prefs: Option(Prefs),
    history: History,
    status: Status,
    evidence_summary: EvidenceSummary,
    references: List(ReferenceSource),
    achievements: List(achievement_row.Row),
    /// Objectives active, and not.
    development_summary: #(Int, Int),
    /// Trials, and those with a report.
    trials_summary: #(Int, Int),
    completeness: Completeness,
    /// Box Cam's development activity over the last 30 days.
    development_activity: Option(Json),
    combine: Option(Json),
    box_share_recruitment: Bool,
    sharing_active: Int,
    assessments: List(AssessmentSource),
    trials: List(TrialSource),
    timeline: List(Event),
    temporal_conflicts: List(TemporalConflict),
    /// Separate from the projected fields, so the revision depends on source data, not on a viewer or the clock.
    revision_evidence: List(EvidenceSource),
    revision_careers: List(CareerMark),
    revision_combine: List(CombineMark),
  )
}

/// A fingerprint of the Passport's content, so a decision snapshot can say which Passport a club saw. Everything
/// derived from "now" is excluded, or the revision would change overnight while nothing about the player had.
/// Comparable for equality only, not order.
pub fn passport_revision(full: Full) -> String {
  let bit = fn(b) {
    case b {
      True -> "1"
      False -> "0"
    }
  }
  let opt = fn(o: Option(String)) { option.unwrap(o, "") }
  let t = fn(w: Option(When)) {
    option.map(w, fn(w) { int.to_string(w.t) }) |> opt
  }
  let part = fn(label, value) { label <> "=" <> value }
  let club = case full.status.current_club {
    None -> "none"
    Some(c) ->
      option.or(option.map(c.org_id, id.org_to_string), c.org_name)
      |> opt
      <> ":"
      <> provenance_to_string(c.provenance)
      <> ":"
  }
  list.flatten([
    [
      part("pos", option.map(full.player.position, position.to_string) |> opt),
      part("lvl", option.map(full.player.level, playing_level.to_string) |> opt),
      part("idn", case full.identity {
        True -> "1:scoutbox_document_review"
        False -> "0"
      }),
      part("club", club),
    ],
    sorted_by(full.history.rows, fn(r: HistoryRow) { r.key })
      |> list.map(fn(r) {
        part(
          "hist",
          string.join(
            [
              r.key,
              provenance_to_string(r.provenance),
              bit(r.current),
              t(r.from),
              t(r.to),
              opt(r.role),
            ],
            ":",
          ),
        )
      }),
    sorted_by(full.revision_evidence, fn(e: EvidenceSource) {
      id.scouting_evidence_to_string(e.id)
    })
      |> list.map(fn(e) {
        part(
          "evd",
          string.join(
            [
              id.scouting_evidence_to_string(e.id),
              evidence_row.verification_status_to_string(e.tier),
              bit(e.superseded),
              bit(e.expired),
            ],
            ":",
          ),
        )
      }),
    sorted_by(full.references, fn(r: ReferenceSource) {
      id.reference_to_string(r.id)
    })
      |> list.map(fn(r) {
        part(
          "ref",
          string.join(
            [
              id.reference_to_string(r.id),
              reference_row.status_to_string(r.status),
              bit(r.provenance_still_current),
            ],
            ":",
          ),
        )
      }),
    sorted_by(full.achievements, fn(a: achievement_row.Row) {
      id.achievement_to_string(a.id)
    })
      |> list.map(fn(a) {
        part(
          "ach",
          id.achievement_to_string(a.id)
            <> ":"
            <> case a.confirmation_provenance {
            Some(_) -> "confirmed"
            None -> "self"
          }
            <> ":"
            <> case a.withdrawn_at {
            Some(_) -> "withdrawn"
            None -> "live"
          },
        )
      }),
    sorted_by(full.revision_combine, fn(c: CombineMark) { c.protocol_id })
      |> list.map(fn(c) {
        part(
          "cmb",
          c.protocol_id
            <> "@"
            <> int.to_string(c.protocol_version)
            <> ":"
            <> json.to_string(json_text.number(c.measured_value))
            <> ":1",
        )
      }),
    sorted_by(full.revision_careers, fn(c: CareerMark) {
      id.career_entry_to_string(c.id)
    })
      |> list.map(fn(c) {
        part(
          "car",
          id.career_entry_to_string(c.id)
            <> ":"
            <> case c.withdrawn {
            True -> "withdrawn"
            False -> "live"
          },
        )
      }),
  ])
  |> string.join("|")
  |> fn(s) {
    "pr_"
    <> {
      crypto.hash(crypto.Sha1, bit_array.from_string(s))
      |> bit_array.base16_encode
      |> string.lowercase
      |> string.slice(0, 16)
    }
  }
}

// ------------------------------------------------------------------------------------------------ projection

const note =
  "A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement."

/// The options a projection takes: the viewing organisation (whose own-org items it sees) and the share mode it was
/// opened through.
pub type Opts {
  Opts(org_id: Option(id.OrgId), share_mode: Option(String))
}

pub const no_opts = Opts(org_id: None, share_mode: None)

fn event_visible_to(
  e: Event,
  viewer: Viewer,
  org_id: Option(id.OrgId),
  selections: set.Set(String),
) -> Bool {
  case viewer, e.visibility {
    TrustSafety, _ -> True
    SelfViewer, v | GuardianViewer, v -> v != TrustAndSafety
    PublicViewer, Public | OtherPlayer, Public -> True
    PublicViewer, _ | OtherPlayer, _ ->
      e.public_eligible && set.contains(selections, e.id)
    // Organisation viewers: the standing gates have already run.
    _, Public | _, Recruitment -> True
    _, RecruitmentOwnOrg | _, PrivateOwnOrg ->
      case org_id, e.org {
        Some(o), Some(EventOrg(id: Some(eo), ..)) -> o == eo
        _, _ -> False
      }
    _, _ -> False
  }
}

fn field_json(f: Field) -> Json {
  case f {
    Text(s) -> json.string(s)
    Null -> json.null()
    Flag(b) -> json.bool(b)
    Count(n) -> json.int(n)
    Texts(l) -> json.array(l, json.string)
  }
}

fn source_json(s: Source) -> Json {
  json.object([#("type", json.string(s.type_)), #("id", json.string(s.id))])
}

fn event_json(e: Event, viewer: Viewer) -> Json {
  json.object(
    list.flatten([
      [
        #("id", json.string(e.id)),
        #("type", json.string(e.type_)),
        #(
          "when",
          json.object([
            #("display", json.string(when_display(e.when))),
            #("precision", json.string(precision_to_string(e.when.precision))),
          ]),
        ),
        #(
          "title",
          json.object(list.map(e.title, fn(f) { #(f.0, field_json(f.1)) })),
        ),
        #("org", json.nullable(e.org, event_org_json)),
        #("provenance", provenance_json(e.provenance)),
        #("provenanceCopy", json.string(provenance_copy(e.provenance))),
        #("assurance", json.null()),
        #("current", json.nullable(e.current, json.bool)),
        #("source", case viewer {
          TrustSafety | SelfViewer | GuardianViewer -> source_json(e.source)
          _ -> json.object([#("type", json.string(e.source.type_))])
        }),
      ],
      case e.trial {
        Some(m) -> [
          #("legacy", json.bool(m.legacy)),
          #("attendedSessions", json.nullable(m.attended_sessions, json.int)),
        ]
        None -> []
      },
    ]),
  )
}

fn event_org_json(o: EventOrg) -> Json {
  json.object([
    #("id", json.nullable(o.id, id.org_json)),
    #("name", json.nullable(o.name, json.string)),
  ])
}

fn history_row_json(r: HistoryRow) -> Json {
  json.object([
    #("orgName", json.nullable(r.org_name, json.string)),
    #("role", json.nullable(r.role, json.string)),
    #("from", json.nullable(option.map(r.from, when_display), json.string)),
    #("to", json.nullable(option.map(r.to, when_display), json.string)),
    #("current", json.bool(r.current)),
    #("provenance", provenance_json(r.provenance)),
    #("provenanceCopy", json.string(provenance_copy(r.provenance))),
    #("assurance", json.null()),
  ])
}

pub fn identity_json(confirmed: Bool) -> Json {
  case confirmed {
    False -> json.null()
    True ->
      json.object([
        #("confirmed", json.bool(True)),
        #("assurance", json.string("scoutbox_document_review")),
        #("label", json.string("Identity confirmed by ScoutBox review")),
        #("provenance", json.string(provenance_copy(ScoutboxReviewed))),
      ])
  }
}

pub fn positions_json(p: Positions) -> Json {
  json.object([
    #(
      "primary",
      json.nullable(option.map(p.primary, position.to_string), json.string),
    ),
    #(
      "secondary",
      json.array(p.secondary, fn(x) { json.string(position.to_string(x)) }),
    ),
  ])
}

fn availability_json(a: Option(prefs_row.Availability)) -> Json {
  json.nullable(a, prefs_row.availability_to_json)
}

pub fn representation_json(r: Representation) -> Json {
  json.object([
    #("agencyName", json.nullable(r.agency_name, json.string)),
    #("agentDisplayName", json.nullable(r.agent_display_name, json.string)),
    #("scope", json.array(r.scope, scope_row.scope_to_json)),
    #("since", json.nullable(option.map(r.since, clock.iso_day), json.string)),
    #("source", json.string("canonical")),
  ])
}

fn current_club_json(c: CurrentClub) -> Json {
  json.object([
    #("orgId", json.nullable(c.org_id, id.org_json)),
    #("orgName", json.nullable(c.org_name, json.string)),
    #("role", json.nullable(c.role, json.string)),
    #("since", json.nullable(c.since, json.string)),
    #("provenance", provenance_json(c.provenance)),
    #("assurance", json.null()),
  ])
}

fn conflict_side(r: HistoryRow) -> Json {
  json.object([
    #("orgName", json.nullable(r.org_name, json.string)),
    #("provenance", provenance_json(r.provenance)),
    #("source", source_json(r.source)),
  ])
}

fn conflict_json(c: ClubConflict) -> Json {
  json.object([
    #("code", json.string("CURRENT_CLUB_CONFLICT")),
    #("authoritative", conflict_side(c.authoritative)),
    #("submitted", conflict_side(c.submitted)),
  ])
}

pub fn status_json(s: Status) -> Json {
  json.object([
    #("currentClub", json.nullable(s.current_club, current_club_json)),
    #("positions", json.nullable(s.positions, positions_json)),
    #("availability", availability_json(s.availability)),
    #("availableFrom", json.nullable(s.available_from, json.string)),
    #("representation", json.nullable(s.representation, representation_json)),
    #("identity", identity_json(s.identity)),
    #("conflicts", json.array(s.conflicts, conflict_json)),
  ])
}

pub fn temporal_conflict_json(c: TemporalConflict) -> Json {
  let code = #("code", json.string("TEMPORAL_CONFLICT"))
  json.object(case c {
    BeforeDob(e) -> [
      code,
      #("kind", json.string("before_dob")),
      #("eventId", json.string(e)),
    ]
    FarFuture(e) -> [
      code,
      #("kind", json.string("far_future")),
      #("eventId", json.string(e)),
    ]
    LeftBeforeJoined(k) -> [
      code,
      #("kind", json.string("left_before_joined")),
      #("key", json.string(k)),
    ]
    OverlappingCurrentAuthoritative(keys) -> [
      code,
      #("kind", json.string("overlapping_current_authoritative")),
      #("keys", json.array(keys, json.string)),
    ]
  })
}

fn evidence_summary_json(e: EvidenceSummary) -> Json {
  json.object([
    #("fullMatches", json.int(e.full_matches)),
    #("clips", json.int(e.clips)),
    #("assessments", json.int(e.assessments)),
    #("references", json.int(e.references)),
    #("lastEvidenceDays", json.nullable(e.last_evidence_days, json.int)),
    #("note", json.string(e.note)),
  ])
}

fn reference_json(r: ReferenceSource, viewer: Viewer) -> Json {
  json.object(
    list.append(
      [
        #("id", id.reference_json(r.id)),
        #("coachName", json.nullable(r.coach_name, json.string)),
        #("roleAtTime", json.nullable(r.role_at_time, json.string)),
        #("orgName", json.nullable(r.org_name, json.string)),
        #("relationship", json.string(r.relationship)),
        #("fromYear", json.nullable(r.from_year, json.int)),
        #("toYear", json.nullable(r.to_year, json.int)),
        #("at", json.string(clock.iso_day(r.created_at))),
        #("provenance", provenance_json(VerifiedCoachConfirmed)),
        #(
          "provenanceCopy",
          json.string(case r.provenance_still_current {
            True ->
              "Coach's "
              <> option.unwrap(r.org_name, "null")
              <> " affiliation is verified."
            False ->
              "Coach affiliation was verified when this reference was submitted."
          }),
        ),
      ],
      case viewer {
        SelfViewer | GuardianViewer | ProClub | GrassrootsClub | TrustSafety -> [
          #(
            "structured",
            json.object([
              #("strengths", json.string(r.strengths)),
              #("development", json.string(r.development)),
              #("summary", json.string(r.summary)),
            ]),
          ),
        ]
        _ -> []
      },
    ),
  )
}

fn achievement_json(a: achievement_row.Row, viewer: Viewer) -> Json {
  let prov = achievement_provenance(a)
  json.object(list.append(
    [
      #("id", id.achievement_json(a.id)),
      #("title", json.string(a.title)),
      #("orgName", json.nullable(a.org_name, json.string)),
      #(
        "when",
        json.nullable(
          option.map(when_text(a.when_date), when_display),
          json.string,
        ),
      ),
      #("provenance", provenance_json(prov)),
      // The organisation stands behind a confirmation; staff identity is not exposed to the player.
      #("confirmedBy", case a.confirmation_provenance {
        Some(_) -> json.nullable(a.confirmation_org_name, json.string)
        None -> json.null()
      }),
      #("provenanceCopy", json.string(provenance_copy(prov))),
    ],
    case viewer {
      SelfViewer | GuardianViewer -> [
        #("withdrawable", json.bool(a.confirmation_provenance == None)),
      ]
      _ -> []
    },
  ))
}

fn player_json(p: PlayerFacts, location: Option(String), level: Bool) -> Json {
  json.object(list.append(
    [
      #("id", id.player_json(p.id)),
      #("name", json.string(p.name)),
      #("age", json.nullable(p.age, json.int)),
      #(
        "position",
        json.nullable(option.map(p.position, position.to_string), json.string),
      ),
      // City only; precise coordinates never leave the discovery surfaces.
      #("location", json.nullable(location, json.string)),
    ],
    case level {
      True -> [#("level", json.nullable(p.level, playing_level.to_json))]
      False -> []
    },
  ))
}

fn prefs_json(p: Prefs) -> Json {
  json.object([
    #("bio", json.nullable(p.bio, json.string)),
    #("positions", json.nullable(p.positions, positions_json)),
    #("availability", availability_json(p.availability)),
    #("availableFrom", json.nullable(p.available_from, json.string)),
    #("publicSelections", json.array(p.public_selections, json.string)),
  ])
}

/// projectPassport: what `viewer` is shown of the assembled Passport. Client apps receive already-filtered payloads
/// and never reconstruct the Passport from raw endpoints.
pub fn project(full: Full, viewer: Viewer, opts: Opts) -> Json {
  let selections = case full.prefs {
    Some(p) -> set.from_list(p.public_selections)
    None -> set.new()
  }
  let events = fn(as_viewer) {
    full.timeline
    |> list.filter(event_visible_to(_, as_viewer, opts.org_id, selections))
    |> json.array(event_json(_, as_viewer))
  }
  let history = fn(rows) { json.array(rows, history_row_json) }
  let p = full.player
  let base = fn(player, identity, status) {
    [
      #("passportVersion", json.int(1)),
      #("passportRevision", json.string(passport_revision(full))),
      #("player", player),
      #("identity", identity),
      #("status", status),
      #("note", json.string(note)),
    ]
  }
  let own =
    base(
      player_json(p, p.city, True),
      identity_json(full.identity),
      status_json(full.status),
    )
  let adult_or_agency = viewer == AgencyViewer || option.unwrap(p.age, 0) >= 18
  let representation = case adult_or_agency {
    True -> json.nullable(full.status.representation, representation_json)
    False -> json.null()
  }
  let #(dev_active, dev_done) = full.development_summary
  let #(trials_total, trials_reported) = full.trials_summary
  json.object(case viewer {
    SelfViewer | GuardianViewer ->
      list.append(own, [
        #("viewer", json.string(viewer_to_string(viewer))),
        #("timeline", events(viewer)),
        #("clubHistory", history(full.history.rows)),
        #(
          "foldedConflicts",
          json.array(full.history.folded, fn(f) {
            json.object([
              #("entryId", id.career_entry_json(f.entry_id)),
              #("into", json.string(f.into)),
            ])
          }),
        ),
        #("conflicts", json.array(full.status.conflicts, conflict_json)),
        #(
          "temporalConflicts",
          json.array(full.temporal_conflicts, temporal_conflict_json),
        ),
        #("evidence", evidence_summary_json(full.evidence_summary)),
        #("references", json.array(full.references, reference_json(_, viewer))),
        #(
          "achievements",
          json.array(full.achievements, achievement_json(_, viewer)),
        ),
        #(
          "development",
          json.object([
            #("active", json.int(dev_active)),
            #("completed", json.int(dev_done)),
          ]),
        ),
        #(
          "trials",
          json.object([
            #("total", json.int(trials_total)),
            #("withReport", json.int(trials_reported)),
          ]),
        ),
        #("completeness", completeness_json(full.completeness)),
        #(
          "developmentActivity",
          option.unwrap(full.development_activity, json.null()),
        ),
        #("combine", option.unwrap(full.combine, json.null())),
        #("sharing", json.object([#("active", json.int(full.sharing_active))])),
        #("prefs", json.nullable(full.prefs, prefs_json)),
      ])
    ProClub | GrassrootsClub | AgencyViewer -> {
      let s = full.status
      let box = fn(value: Option(Json)) {
        // Development activity and Combine results are shown only on the player's or guardian's explicit
        // recruitment opt-in.
        case full.box_share_recruitment {
          True -> option.unwrap(value, json.null())
          False -> json.null()
        }
      }
      list.flatten([
        base(
          // A minor's location is stripped from every organisation's view.
          player_json(
            p,
            case p.minor {
              True -> None
              False -> p.city
            },
            True,
          ),
          identity_json(full.identity),
          // Conflict flags are between the player and T&S: recruiting orgs get the resolved display.
          json.object([
            #("currentClub", json.nullable(s.current_club, current_club_json)),
            #("positions", json.nullable(s.positions, positions_json)),
            #("availability", availability_json(s.availability)),
            #("availableFrom", json.nullable(s.available_from, json.string)),
            #("representation", representation),
            #("identity", identity_json(s.identity)),
          ]),
        ),
        [
          #("viewer", json.string(viewer_to_string(viewer))),
          #("timeline", events(viewer)),
          #("clubHistory", history(full.history.rows)),
          #("evidence", evidence_summary_json(full.evidence_summary)),
          #(
            "references",
            json.array(full.references, reference_json(_, viewer)),
          ),
          #(
            "achievements",
            json.array(full.achievements, achievement_json(_, viewer)),
          ),
          #(
            "assessments",
            full.assessments
              |> list.filter(fn(a) { Some(a.org_id) == opts.org_id })
              |> json.array(fn(a) {
                json.object([
                  #("id", id.assessment_json(a.id)),
                  #("org", json.nullable(a.org_name, json.string)),
                  #(
                    "at",
                    json.string(
                      clock.iso_day(option.unwrap(a.submitted_at, a.created_at)),
                    ),
                  ),
                  #("state", assessment_row.state_to_json(a.state)),
                ])
              }),
          ),
          #(
            "trials",
            full.trials
              |> list.filter(fn(t) { Some(t.org_id) == opts.org_id })
              |> json.array(fn(t) {
                json.object([
                  #("id", id.trial_json(t.id)),
                  #("org", json.nullable(t.org_name, json.string)),
                  #("date", json.nullable(t.proposed_date, json.string)),
                  #("hasReport", json.bool(t.report_at != None)),
                ])
              }),
          ),
          #("availability", availability_json(s.availability)),
          #("representation", representation),
          #("developmentActivity", box(full.development_activity)),
          #("combine", box(full.combine)),
          #("shareMode", json.nullable(opts.share_mode, json.string)),
        ],
      ])
    }
    OtherPlayer | PublicViewer ->
      list.append(
        base(
          player_json(
            p,
            case p.minor {
              True -> None
              False -> p.city
            },
            False,
          ),
          case full.identity {
            True ->
              json.object([
                #("confirmed", json.bool(True)),
                #("assurance", json.string("scoutbox_document_review")),
                #("label", json.string("Identity confirmed by ScoutBox review")),
              ])
            False -> json.null()
          },
          json.object([
            // A confirmed current club only.
            #("currentClub", case full.status.current_club {
              Some(c) ->
                case at_least(c.provenance, ScoutboxReviewed) {
                  True -> current_club_json(c)
                  False -> json.null()
                }
              None -> json.null()
            }),
          ]),
        ),
        [
          #("viewer", json.string("public")),
          #("timeline", events(PublicViewer)),
          #(
            "clubHistory",
            full.history.rows
              |> list.filter(fn(r) {
                at_least(r.provenance, ScoutboxReviewed)
                || set.contains(
                  selections,
                  "hist:" <> option.unwrap(r.org_name, "null"),
                )
              })
              |> history,
          ),
          #(
            "achievements",
            full.achievements
              |> list.filter(fn(a) {
                a.confirmation_provenance != None
                && set.contains(
                  selections,
                  ev_id(
                    "achievement",
                    id.achievement_to_string(a.id),
                    "achievement",
                  ),
                )
              })
              |> json.array(achievement_json(_, PublicViewer)),
          ),
          #(
            "evidence",
            json.object([
              #("summaryOnly", json.bool(True)),
              #("fullMatches", json.int(full.evidence_summary.full_matches)),
              #("clips", json.int(full.evidence_summary.clips)),
              #(
                "lastEvidenceDays",
                json.nullable(
                  full.evidence_summary.last_evidence_days,
                  json.int,
                ),
              ),
            ]),
          ),
        ],
      )
    TrustSafety ->
      list.append(own, [
        #("viewer", json.string("trust_safety")),
        #("timeline", events(TrustSafety)),
        #("clubHistory", history(full.history.rows)),
        #("conflicts", json.array(full.status.conflicts, conflict_json)),
        #(
          "temporalConflicts",
          json.array(full.temporal_conflicts, temporal_conflict_json),
        ),
        #(
          "graph",
          json.array(full.timeline, fn(e) {
            json.object([
              #("id", json.string(e.id)),
              #("source", source_json(e.source)),
              #("provenance", provenance_json(e.provenance)),
              #("visibility", json.string(visibility_to_string(e.visibility))),
            ])
          }),
        ),
      ])
  })
}

fn visibility_to_string(v: Visibility) -> String {
  case v {
    Public -> "public"
    Recruitment -> "recruitment"
    Private -> "private"
    GuardianOnly -> "guardian_only"
    TrustAndSafety -> "trust_and_safety"
    RecruitmentOwnOrg -> "recruitment_own_org"
    PrivateOwnOrg -> "private_own_org"
  }
}
