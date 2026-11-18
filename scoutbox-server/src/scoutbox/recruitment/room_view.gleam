//// The one place a Recruitment Room is assembled (buildRecruitmentRoom in domains/recruitment/rooms/rooms.mjs).
//// Every branch goes through the gate that owns it, and the player's visibility is decided again on every read:
//// when the club may no longer see the player (a block, a suspension, a visibility change), the Room keeps the
//// club's own record and shows nothing of the player, with no cached name, stale Passport or last-known score.
////
//// Not ported yet, inside a Room: most of the Football Passport (its revision, identity and status, timeline,
//// evidence summary, references, achievements, assessments and trials, development activity and Combine), the
//// Combine results (from verified attempts), development activity, and the snapshot's Passport revision.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/development/combine
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff
import scoutbox/insight/evidence_gaps
import scoutbox/passport/passport_rules
import scoutbox/passport/sources
import scoutbox/passport/trust
import scoutbox/passport/trust_rules.{type Profile}
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/trial_rules
import scoutbox/recruitment/trials
import scoutbox/rows/case_tasks as task_row
import scoutbox/rows/combine_requests
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/evidence_suggestions as suggestion_row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/room_evidence_states as review_row
import scoutbox/rows/trials as trial_row
import scoutbox/rules/visibility
import scoutbox/scouting/evidence
import scoutbox/vocab/org_type
import scoutbox/vocab/playing_level
import scoutbox/vocab/position as positions
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context
import scoutbox/vocab/task_state

const day_ms = 86_400_000

pub fn level(org: orgs.Row) -> orgs.Level {
  option.unwrap(org.level, orgs.LevelPro)
}

/// The viewer's role in the Room.
pub fn role(a: OrgAccess, room: Room) -> Option(room_rules.RoomRole) {
  room_rules.room_role(
    cases.membership(room),
    a.user.id,
    access.is_lead(a.user),
  )
}

/// The Trust Score projection a club sees; an agency sees none.
fn trust_viewer(org: orgs.Row) -> Option(trust_rules.Viewer) {
  case org.type_, level(org) {
    org_type.Agency, _ -> None
    _, orgs.LevelGrassroots -> Some(trust_rules.GrassrootsClubViewer)
    _, _ -> Some(trust_rules.ProClubViewer)
  }
}

fn viewer_kind(org: orgs.Row) -> String {
  case org.type_, level(org) {
    org_type.Agency, _ -> "agency"
    _, orgs.LevelGrassroots -> "grassroots_club"
    _, _ -> "pro_club"
  }
}

/// The player as the Room may show them, with their Trust Score, or `None` when the club may not see them now.
pub type Sources {
  Sources(player: Player, access: visibility.Access, profile: Profile)
}

pub fn sources(
  read: Read,
  org: orgs.Row,
  room: Room,
  now: Int,
) -> Result(Option(Sources), Fail(e)) {
  use found <- result.try(players.for_org(read, room.row.player_id, org, now))
  case found {
    Some(#(p, access)) if access.visible && !access.blocked -> {
      use profile <- result.map(trust.profile(read, p, now))
      Some(Sources(p, access, profile))
    }
    _ -> Ok(None)
  }
}

pub fn trust_json(org: orgs.Row, s: Sources) -> Json {
  case trust_viewer(org) {
    Some(v) -> trust_rules.projection(s.profile, v)
    None -> json.null()
  }
}

pub fn summary_trust(
  org: orgs.Row,
  s: Sources,
) -> Option(room_rules.SummaryTrust) {
  case trust_viewer(org) {
    Some(_) ->
      Some(room_rules.SummaryTrust(
        s.profile.score,
        s.profile.band.id,
        s.profile.band.label,
      ))
    None -> None
  }
}

/// A colleague's name, while they are still in the organisation.
pub fn colleague(
  read: Read,
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Result(Option(staff.Staff), Fail(e)) {
  use found <- result.map(staff.by_id(read, user_id))
  case found {
    Some(u) if u.org_id == org_id && u.removed_at == None -> Some(u)
    _ -> None
  }
}

fn colleague_name(
  read: Read,
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Result(String, Fail(e)) {
  use found <- result.map(colleague(read, org_id, user_id))
  case found {
    Some(u) -> u.name
    None -> "Former colleague"
  }
}

pub fn person_json(
  user_id: Option(id.OrgUserId),
  name: Option(String),
) -> Json {
  case user_id, name {
    None, None -> json.null()
    _, _ ->
      json.object([
        #("userId", json.nullable(user_id, id.org_user_json)),
        #("name", json.nullable(name, json.string)),
      ])
  }
}

pub fn task_json(t: task_row.Row) -> Json {
  json.object([
    #("id", id.task_json(t.id)),
    #("title", json.string(t.title)),
    #("description", json.nullable(t.description, json.string)),
    #("assigneeUserId", json.nullable(t.assignee_user_id, id.org_user_json)),
    #("assigneeName", json.nullable(t.assignee_name, json.string)),
    #("status", task_state.to_json(t.status)),
    #("dueAt", cases.due_json(t.due_day, t.due_at)),
    #(
      "linkedResourceType",
      json.nullable(
        t.linked_resource_type,
        task_row.linked_resource_type_to_json,
      ),
    ),
    #("linkedResourceId", json.nullable(t.linked_resource_id, json.string)),
    #("createdBy", person_json(t.created_by_user_id, t.created_by_name)),
    #("createdAt", json.int(t.created_at)),
    #("completedAt", json.nullable(t.completed_at, json.int)),
  ])
}

pub fn open_tasks(room: Room) -> Int {
  list.count(room.tasks, fn(t) {
    t.status == task_state.Open || t.status == task_state.InProgress
  })
}

pub fn comment_json(
  read: Read,
  org_id: id.OrgId,
  c: room_records.Comment,
) -> Result(Json, Fail(e)) {
  let r = c.row
  use mentions <- result.map(
    list.try_map(c.mentions, fn(u) {
      use name <- result.map(colleague_name(read, org_id, u))
      json.object([
        #("userId", id.org_user_json(u)),
        #("name", json.string(name)),
      ])
    }),
  )
  json.object([
    #("id", id.room_comment_json(r.id)),
    #("roomId", id.recruitment_case_json(r.room_id)),
    #(
      "author",
      json.object([
        #("userId", id.org_user_json(r.author_user_id)),
        #("name", json.nullable(r.author_name, json.string)),
      ]),
    ),
    // Tombstoned, never erased, so the thread and the audit trail stay intact.
    #("body", case r.deleted_at {
      Some(_) -> json.null()
      None -> json.string(r.body)
    }),
    #("deleted", json.bool(option.is_some(r.deleted_at))),
    #("deletedAt", json.nullable(r.deleted_at, json.int)),
    #("edited", json.bool(option.is_some(r.edited_at))),
    #("editedAt", json.nullable(r.edited_at, json.int)),
    #("editCount", json.int(r.edit_count)),
    #("replyToId", json.nullable(r.reply_to_id, id.room_comment_json)),
    #("mentions", json.preprocessed_array(mentions)),
    #("createdAt", json.int(r.created_at)),
  ])
}

/// Newest first, ties broken by id (descending), as the TypeScript server sorts a Room's comments.
pub fn newest_first(
  comments: List(room_records.Comment),
) -> List(room_records.Comment) {
  list.sort(comments, fn(a, b) {
    case int.compare(b.row.created_at, a.row.created_at) {
      order.Eq ->
        string.compare(
          id.room_comment_to_string(b.row.id),
          id.room_comment_to_string(a.row.id),
        )
      other -> other
    }
  })
}

fn links_json(room: Room) -> Json {
  json.object([
    #("requestIds", json.array(room.request_ids, id.request_json)),
    #("trialIds", json.array(room.trial_ids, id.trial_json)),
    #("signingId", json.nullable(room.row.links_signing_id, json.string)),
  ])
}

pub fn links(room: Room) -> Json {
  links_json(room)
}

pub fn rev_of(room: Room) -> rev.Rev {
  rev.Rev(
    rev: room.rev,
    at: room.row.room_rev_at,
    by_name: room.row.room_rev_by_name,
  )
}

// ---------------------------------------------------------------------------------------------------- assessments

type Assessment {
  Assessment(
    id: String,
    scout_user_id: id.OrgUserId,
    scout_name: String,
    template_id: String,
    template_version: Int,
    state: String,
    verdict: Option(String),
    fixture: Option(String),
    date: Option(String),
    trial_id: Option(String),
    created_at: Int,
    submitted_at: Option(Int),
  )
}

fn assessments_of(read: Read, org_id: id.OrgId, player_id: id.PlayerId) {
  store.query(
    read,
    "SELECT id, scout_user_id, scout_name, template_id, template_version, state, recommendation_verdict, context_fixture, context_date, context_trial_id, created_at, submitted_at FROM assessments WHERE org_id = ? AND player_id = ? ORDER BY rowid",
    [id.org_sql(org_id), id.player_sql(player_id)],
    {
      use a <- decode.field(0, decode.string)
      use scout <- decode.field(1, id.org_user_decoder())
      use scout_name <- decode.field(2, decode.string)
      use template <- decode.field(3, decode.string)
      use version <- decode.field(4, decode.int)
      use state <- decode.field(5, decode.string)
      use verdict <- decode.field(6, decode.optional(decode.string))
      use fixture <- decode.field(7, decode.optional(decode.string))
      use date <- decode.field(8, decode.optional(decode.string))
      use trial <- decode.field(9, decode.optional(decode.string))
      use created <- decode.field(10, decode.int)
      use submitted <- decode.field(11, decode.optional(decode.int))
      decode.success(Assessment(
        a,
        scout,
        scout_name,
        template,
        version,
        state,
        verdict,
        fixture,
        date,
        trial,
        created,
        submitted,
      ))
    },
  )
}

/// A word or a short label (fixture · date, or "trial"), never the context itself.
fn context_label(a: Assessment) -> Option(String) {
  let bits =
    [a.fixture, a.date]
    |> option.values
    |> list.map(string.trim)
    |> list.filter(fn(b) { b != "" })
  case bits, a.trial_id {
    [_, ..], _ -> Some(string.join(bits, " · "))
    [], Some(_) -> Some("trial")
    [], None -> None
  }
}

/// This organisation's assessments through the blind-until-submit rule: a scout cannot read a peer's submitted
/// assessment until they have submitted their own. The reasons stay on the assessment surface.
fn visible_assessments(
  a: OrgAccess,
  all: List(Assessment),
) -> List(Assessment) {
  let lead = access.is_lead(a.user)
  let own_submitted =
    list.any(all, fn(x) { x.scout_user_id == a.user.id && x.state != "draft" })
  list.filter(all, fn(x) {
    lead
    || x.scout_user_id == a.user.id
    || { x.state != "draft" && own_submitted }
  })
}

fn assessment_json(a: Assessment) -> Json {
  json.object([
    #("id", json.string(a.id)),
    #("scoutUserId", id.org_user_json(a.scout_user_id)),
    #("scoutName", json.string(a.scout_name)),
    #("templateId", json.string(a.template_id)),
    #("templateVersion", json.int(a.template_version)),
    #("state", json.string(a.state)),
    #("recommendation", json.nullable(a.verdict, json.string)),
    #("context", json.nullable(context_label(a), json.string)),
    #("createdAt", json.int(a.created_at)),
    #("submittedAt", json.nullable(a.submitted_at, json.int)),
  ])
}

// ---------------------------------------------------------------------------------------------------- passport

const passport_note =
  "A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement."

pub fn provenance_copy(p: String) -> Option(String) {
  case p {
    "player_submitted" ->
      Some(
        "Provided by the player. ScoutBox has not independently confirmed this item.",
      )
    "guardian_submitted" ->
      Some(
        "Provided by the player’s guardian. ScoutBox has not independently confirmed this item.",
      )
    "system_recorded" ->
      Some("Recorded automatically by ScoutBox from platform activity.")
    "historical_migration" ->
      Some("Carried forward from an earlier ScoutBox record.")
    "scoutbox_reviewed" ->
      Some(
        "Reviewed by ScoutBox Trust & Safety — a document review, not an independent register check.",
      )
    "verified_coach_confirmed" ->
      Some(
        "Confirmed by a coach whose club affiliation was verified when they confirmed it.",
      )
    "verified_club_confirmed" ->
      Some(
        "Confirmed by an authorised administrator of the named organisation.",
      )
    "authoritative_registry" ->
      Some("Confirmed against an authoritative registry.")
    "box_cam_observed" ->
      Some(
        "Recorded live through ScoutBox Box Cam. ScoutBox observed activity consistent with the selected supported drill — this describes observed training, not football ability.",
      )
    _ -> None
  }
}

/// The club's Football Passport, as far as it is ported: its version, the player and the club history.
fn passport_json(
  read: Read,
  org: orgs.Row,
  s: Sources,
  now: Int,
) -> Result(Json, Fail(e)) {
  let r = s.player.row
  let minor = !players.is_adult(s.player, now)
  use history <- result.map(sources.history(read, r.id))
  json.object([
    #("passportVersion", json.int(1)),
    // Not ported yet: the revision (a hash of the assembled Passport).
    #("passportRevision", json.null()),
    #(
      "player",
      json.object([
        #("id", id.player_json(r.id)),
        #("name", json.string(r.name)),
        #("age", json.nullable(players.age_now(s.player, now), json.int)),
        #(
          "position",
          json.nullable(
            r.position |> option.map(positions.to_string),
            json.string,
          ),
        ),
        // City only, and none for a minor in any organisation's view.
        #("location", case minor {
          True -> json.null()
          False -> json.nullable(r.city, json.string)
        }),
        #("level", json.string(playing_level.to_string(r.level))),
      ]),
    ),
    #("note", json.string(passport_note)),
    #("viewer", json.string(viewer_kind(org))),
    #(
      "clubHistory",
      json.array(history.rows, fn(h) {
        json.object([
          #("orgName", json.nullable(h.org_name, json.string)),
          #("current", json.bool(h.current)),
          #(
            "provenance",
            json.string(passport_rules.provenance_to_string(h.provenance)),
          ),
          #(
            "provenanceCopy",
            json.string(passport_rules.provenance_copy(h.provenance)),
          ),
        ])
      }),
    ),
  ])
}

// ---------------------------------------------------------------------------------------------------- the room

fn trial_state(ts: List(trial_rules.Trial)) -> room_rules.TrialState {
  case
    list.any(ts, fn(t) { t.row.status == trial_row.Reported }),
    list.any(ts, fn(t) { t.row.status == trial_row.AwaitingReport })
  {
    True, _ -> room_rules.Reported
    False, True -> room_rules.AwaitingReport
    False, False -> room_rules.NoTrial
  }
}

/// The Room as its views show it. Its missing-evidence suggestions are reconciled as it is read, so it is built
/// inside a unit.
pub fn build(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  now: Int,
) -> Result(Json, Fail(e)) {
  let read = store.reading(tx)
  let org = a.org
  let r = room.row
  use srcs <- result.try(sources(read, org, room, now))
  use lead <- result.try(case r.room_lead_scout_user_id {
    Some(u) -> {
      use name <- result.map(colleague_name(read, org.id, u))
      json.object([
        #("userId", id.org_user_json(u)),
        #("name", json.string(name)),
      ])
    }
    None -> Ok(json.null())
  })
  let viewer_role = role(a, room)
  let base =
    list.flatten([
      [
        #("roomId", id.recruitment_case_json(r.id)),
        #("orgId", id.org_json(r.org_id)),
        #("playerId", id.player_json(r.player_id)),
        #("status", room_status.to_json(room.status)),
        #("statusLabel", json.string(room_rules.status_label(room.status))),
        #(
          "allowedTransitions",
          json.array(room_rules.transitions(room.status), room_status.to_json),
        ),
        #("stage", case_row.stage_to_json(r.stage)),
        #("priority", case_row.room_priority_to_json(room.priority)),
        #("priorityNote", json.string(room_rules.priority_note)),
        #("tags", json.array(room.tags, json.string)),
        #("restricted", json.bool(r.restricted)),
        #(
          "sourceContext",
          json.nullable(r.room_source_context, source_context.to_json),
        ),
        #(
          "owner",
          json.object([
            #("userId", id.org_user_json(r.owner_user_id)),
            #("name", json.nullable(r.owner_name, json.string)),
          ]),
        ),
        #("leadScout", lead),
        #(
          "viewerRole",
          json.nullable(
            option.map(viewer_role, room_rules.role_code),
            json.string,
          ),
        ),
      ],
      rev.meta(rev_of(room)),
      [
        #("createdAt", json.int(r.created_at)),
        #("updatedAt", json.int(room.updated_at)),
        #("archivedAt", json.nullable(r.room_archived_at, json.int)),
        #("closedAt", json.nullable(r.room_closed_at, json.int)),
        #("links", links_json(room)),
        #("privacyNote", json.string(room_rules.privacy_note)),
      ],
    ])
  let tasks = json.array(room.tasks, task_json)
  use comments <- result.try(room_records.comments(read, r.id))
  use comments <- result.try(
    newest_first(comments)
    |> list.take(room_rules.page_size)
    |> list.try_map(comment_json(read, org.id, _)),
  )
  use decisions <- result.try(room_records.decisions(read, r.id))
  let decision =
    json.object([
      #(
        "current",
        json.nullable(
          list.last(decisions) |> option.from_result,
          room_records.decision_json,
        ),
      ),
      #("history", json.array(decisions, room_records.decision_json)),
    ])
  let activity =
    room_rules.activity_json(room_rules.room_activity(
      cases.events(room),
      room_rules.page_size,
      None,
    ))
  case srcs {
    None ->
      Ok(
        json.object(
          list.append(base, [
            #("playerAvailable", json.bool(False)),
            #("playerName", json.null()),
            #("player", json.null()),
            #("unavailableNote", json.string(room_rules.unavailable_note)),
            #("trust", json.null()),
            #("passport", json.null()),
            #("evidence", json.preprocessed_array([])),
            #("assessments", json.preprocessed_array([])),
            #("combine", json.null()),
            #("development", json.null()),
            #("missingEvidence", json.preprocessed_array([])),
            #("trials", json.preprocessed_array([])),
            #("tasks", tasks),
            #("comments", json.preprocessed_array(comments)),
            #("decision", decision),
            #("activity", activity),
            #("readiness", json.null()),
            #("health", json.null()),
            #("healthLabel", json.null()),
          ]),
        ),
      )
    Some(s) -> {
      let p = s.player
      use all_assessments <- result.try(assessments_of(read, org.id, p.row.id))
      let assessments = visible_assessments(a, all_assessments)
      use records <- result.try(evidence.current_for_player(read, p.row.id))
      use reviews <- result.try(room_records.reviews(read, r.id))
      let records =
        list.sort(records, fn(x, y) {
          int.compare(y.row.recorded_at, x.row.recorded_at)
        })
      let evidence_items =
        list.map(records, fn(e) {
          #(
            e,
            list.find(reviews, fn(v) {
              v.evidence_id == id.scouting_evidence_to_string(e.row.id)
            })
              |> option.from_result,
          )
        })
      use gaps <- result.try(evidence_gaps.compute(tx, org, p, now))
      let gaps =
        list.sort(gaps, fn(x, y) {
          string.compare(
            suggestion_row.rule_id_to_string(x.row.rule_id),
            suggestion_row.rule_id_to_string(y.row.rule_id),
          )
        })
      use room_trials <- result.try(trials.for_org_player(
        read,
        org.id,
        p.row.id,
      ))
      use may_see_combine <- result.try(combine.org_may_see_results(
        read,
        org.id,
        p.row.id,
      ))
      use requests <- result.try(combine.for_org_player(read, org.id, p.row.id))
      let requests = list.reverse(requests)
      use shares_development <- result.try(combine.shares_development(
        read,
        p.row.id,
      ))
      use passport <- result.try(passport_json(read, org, s, now))
      let readiness =
        room_rules.decision_readiness(room_rules.ReadinessInput(
          assessments_assigned: case
            list.count(room.assignments, fn(x) {
              string.contains(string.lowercase(x.task), "assess")
            })
          {
            0 -> list.length(assessments)
            n -> n
          },
          assessments_submitted: list.count(assessments, fn(x) {
            x.state != "draft"
          }),
          recent_full_match: list.any(records, fn(e) {
            e.row.claim_type == evidence_row.Footage
            && e.row.recorded_at > now - 180 * day_ms
          }),
          // Not ported yet: the Passport's references, which a coach reference is also read from.
          coach_reference: list.any(records, fn(e) {
            e.row.verification_status == evidence_row.CoachConfirmed
          }),
          // Not ported yet: verified Combine results.
          combine_verified: 0,
          combine_requested: list.count(requests, fn(q) {
            q.row.state == combine_requests.Requested
          }),
          trial_state: trial_state(room_trials),
          open_tasks: open_tasks(room),
          open_evidence_requests: list.count(gaps, fn(g) {
            g.row.status == suggestion_row.Requested
          }),
        ))
      let health =
        room_rules.room_health(Some(readiness), decisions != [], room.status)
      Ok(
        json.object(
          list.append(base, [
            #("playerAvailable", json.bool(True)),
            #("playerName", json.string(p.row.name)),
            #(
              "player",
              json.object(
                players.org_fields(p, org, s.access, now)
                |> list.filter(fn(f) { f.0 != "trustScore" && f.0 != "trust" }),
              ),
            ),
            #("trust", trust_json(org, s)),
            #("passport", passport),
            #(
              "evidence",
              json.array(evidence_items, fn(pair) {
                let #(e, review) = pair
                json.object([
                  #("id", id.scouting_evidence_json(e.row.id)),
                  #(
                    "claimType",
                    evidence_row.claim_type_to_json(e.row.claim_type),
                  ),
                  #("label", json.string(e.row.label)),
                  #("value", evidence.value_json(e.row)),
                  #("units", json.nullable(e.row.units, json.string)),
                  #("season", json.nullable(e.row.season, json.string)),
                  #(
                    "provenance",
                    evidence_row.verification_status_to_json(
                      e.row.verification_status,
                    ),
                  ),
                  #(
                    "source",
                    json.object([
                      #(
                        "kind",
                        evidence_row.source_kind_to_json(e.row.source_kind),
                      ),
                      #("name", json.string(e.row.source_name)),
                    ]),
                  ),
                  #("recordedAt", json.int(e.row.recorded_at)),
                  #("observedAt", json.nullable(e.row.observed_at, json.int)),
                  // Counts only: the dispute reason stays between the player and Trust & Safety.
                  #("openDisputes", json.int(e.open_disputes)),
                  #(
                    "review",
                    json.object([
                      #(
                        "state",
                        json.string(case review {
                          Some(v) -> review_row.state_to_string(v.state)
                          None -> "not_reviewed"
                        }),
                      ),
                      #(
                        "note",
                        json.nullable(
                          option.then(review, fn(v) { v.note }),
                          json.string,
                        ),
                      ),
                      #(
                        "by",
                        json.nullable(
                          option.then(review, fn(v) { v.by_name }),
                          json.string,
                        ),
                      ),
                      #(
                        "at",
                        json.nullable(
                          option.map(review, fn(v) { v.at }),
                          json.int,
                        ),
                      ),
                    ]),
                  ),
                ])
              }),
            ),
            #("assessments", json.array(assessments, assessment_json)),
            #(
              "assessmentsWithheldPendingOwnSubmission",
              json.int(list.length(all_assessments) - list.length(assessments)),
            ),
            #("combine", case may_see_combine {
              True ->
                json.object(
                  list.append(combine.projection_fields(), [
                    #("requests", json.array(requests, combine.request_view)),
                    #("shared", json.bool(True)),
                  ]),
                )
              False ->
                json.object([
                  #("results", json.preprocessed_array([])),
                  #("shared", json.bool(False)),
                  #("requests", json.array(requests, combine.request_view)),
                  #(
                    "note",
                    json.string(
                      "This player has not shared Combine results with your organisation.",
                    ),
                  ),
                ])
            }),
            #("development", case shares_development {
              // Not ported yet: the development activity itself.
              True -> json.object([#("note", json.string(room_rules.dev_note))])
              False ->
                json.object([
                  #("shared", json.bool(False)),
                  #(
                    "note",
                    json.string(
                      "This player has not shared development activity for recruitment.",
                    ),
                  ),
                ])
            }),
            #(
              "missingEvidence",
              json.array(gaps, fn(g) {
                json.object([
                  #("id", id.evidence_suggestion_json(g.row.id)),
                  #("ruleId", suggestion_row.rule_id_to_json(g.row.rule_id)),
                  #("ruleVersion", json.int(g.row.rule_version)),
                  #("explanation", json.string(g.row.explanation)),
                  #("action", json.string(evidence_gaps.action(g.row.rule_id))),
                  #("status", suggestion_row.status_to_json(g.row.status)),
                  #("requestedAt", json.nullable(g.row.requested_at, json.int)),
                ])
              }),
            ),
            #(
              "trials",
              json.array(room_trials, fn(t) {
                json.object([
                  #("id", id.trial_json(t.row.id)),
                  #("status", trial_row.status_to_json(t.row.status)),
                  #(
                    "proposedDate",
                    json.nullable(t.row.proposed_date, json.string),
                  ),
                  #("venue", json.nullable(t.row.venue, json.string)),
                  #("reportDueAt", json.nullable(t.row.report_due_at, json.int)),
                  #("hasReport", json.bool(t.report != None)),
                  #(
                    "linked",
                    json.bool(list.contains(room.trial_ids, t.row.id)),
                  ),
                ])
              }),
            ),
            #("tasks", tasks),
            #("comments", json.preprocessed_array(comments)),
            #("decision", decision),
            #("activity", activity),
            #("readiness", room_rules.readiness_json(readiness)),
            #("health", json.string(room_rules.health_code(health))),
            #("healthLabel", json.string(room_rules.health_label(health))),
          ]),
        ),
      )
    }
  }
}

/// What a Room records of the evidence confidence the club could see, with references to explain the decision
/// later: `None` when the player is not visible now.
pub fn capture_snapshot(
  tx: Tx,
  org: orgs.Row,
  room: Room,
  trigger: String,
  now: Int,
) -> Result(Option(room_records.Snapshot), Fail(e)) {
  let read = store.reading(tx)
  use srcs <- result.try(sources(read, org, room, now))
  case srcs {
    None -> Ok(None)
    Some(s) -> {
      let t = trust_rules.snapshot(s.profile)
      use records <- result.try(evidence.current_for_player(
        read,
        s.player.row.id,
      ))
      use submitted <- result.try(store.query(
        read,
        "SELECT id FROM assessments WHERE org_id = ? AND player_id = ? AND state <> 'draft' ORDER BY rowid",
        [id.org_sql(room.row.org_id), id.player_sql(room.row.player_id)],
        decode.at([0], decode.string),
      ))
      room_records.add_snapshot(
        tx,
        room_records.NewSnapshot(
          room_id: room.row.id,
          org_id: room.row.org_id,
          player_id: room.row.player_id,
          trigger:,
          trust: Some(room_records.SnapshotTrust(
            score: int.to_float(t.score),
            band: t.band,
            policy_version: t.policy_version,
            component_levels: t.component_levels,
            hash: t.hash,
          )),
          // The TypeScript server reads the version from its light Passport assembly, which has none, so a
          // snapshot records it as null.
          passport_version: None,
          // Not ported yet: the Passport revision.
          passport_revision: None,
          evidence_ids: list.map(records, fn(e) {
            id.scouting_evidence_to_string(e.row.id)
          }),
          assessment_ids: submitted,
          // Not ported yet: verified Combine results.
          combine_results: [],
          trial_ids: list.map(room.trial_ids, id.trial_to_string),
          at: now,
        ),
      )
      |> result.map(Some)
    }
  }
}
