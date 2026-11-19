//// The recruitment case workspace (domains/scouting/scouting.mjs, "recruitment cases"): opening a plain case,
//// moving its stage, and recording its workspace decision. Cases link to requests, trials and signings; they never
//// copy them. A case that has a Room moves only through the lifecycle, so its stage is refused here, and a
//// workspace decision on it is recorded without touching the stage the Room's status derives.
////
//// Every route answers the case record whole, as the repository decodes it: its Room, its decision draft, its
//// transaction handoff and its budget included.
////

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/paging.{IntKey, IntKind, TextKey, TextKind}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/cases
import scoutbox/recruitment/requests
import scoutbox/recruitment/signings
import scoutbox/recruitment/trials
import scoutbox/rows/case_approvals as approval_row
import scoutbox/rows/case_assignments as assignment_row
import scoutbox/rows/case_budget_actuals as actual_row
import scoutbox/rows/case_budget_fx_assumptions as fx_row
import scoutbox/rows/case_budget_lines as line_row
import scoutbox/rows/case_budget_scenarios as scenario_row
import scoutbox/rows/case_decision_draft_evidence_refs as ref_row
import scoutbox/rows/case_decision_drafts as draft_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/case_tasks as task_row
import scoutbox/rows/case_transaction_handoffs as handoff_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_cases as row
import scoutbox/vocab/audience
import scoutbox/vocab/case_outcome
import scoutbox/vocab/currency
import scoutbox/vocab/decision_evidence_kind
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context
import scoutbox/vocab/task_state
import sqlight
import wisp.{type Request, type Response}

const reasons_max = 500

const task_title_max = 200

const assignment_task_max = 200

const pro_stages = [
  row.Identified,
  row.Review,
  row.Observation,
  row.Trial,
  row.Decision,
  row.Closed,
]

const grassroots_stages = [
  row.Review,
  row.Invited,
  row.AwaitingResponse,
  row.Decision,
  row.Closed,
]

fn stages_for(a: OrgAccess) -> List(row.Stage) {
  case orgs.is_grassroots(a.org) {
    True -> grassroots_stages
    False -> pro_stages
  }
}

// ------------------------------------------------------------------------------------------------------- record

fn of_case(
  read: Read,
  columns: String,
  table: String,
  case_id: id.RecruitmentCaseId,
  order: String,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE case_id = ? ORDER BY "
      <> order,
    [id.recruitment_case_sql(case_id)],
    decoder,
  )
}

fn of_scenario(
  read: Read,
  columns: String,
  table: String,
  case_id: id.RecruitmentCaseId,
  scenario_id: id.BudgetScenarioId,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE case_id = ? AND scenario_id = ? ORDER BY position",
    [id.recruitment_case_sql(case_id), id.budget_scenario_sql(scenario_id)],
    decoder,
  )
}

/// `{ userId, name }`, or null when neither is recorded (personOut).
fn person(user: Option(String), name: Option(String)) -> Json {
  case user, name {
    None, None -> json.null()
    _, _ ->
      json.object([
        #("userId", json.nullable(user, json.string)),
        #("name", json.nullable(name, json.string)),
      ])
  }
}

fn user(u: Option(id.OrgUserId)) -> Option(String) {
  option.map(u, id.org_user_to_string)
}

fn parsed(text: Option(String)) -> Json {
  case text {
    Some(t) -> json_text.parse(t) |> result.unwrap(json.null())
    None -> json.null()
  }
}

fn history_json(h: history_row.Row) -> Json {
  json.object([
    #("id", id.case_event_json(h.id)),
    #("at", json.int(h.at)),
    #("byKind", json.nullable(h.by_kind, history_row.by_kind_to_json)),
    #("byId", json.nullable(h.by_id, json.string)),
    #("byName", json.nullable(h.by_name, json.string)),
    #("action", json.string(h.action)),
    #("detail", case h.detail_json, h.detail_text {
      Some(_), _ -> parsed(h.detail_json)
      None, Some(t) -> json.string(t)
      None, None -> json.null()
    }),
  ])
}

pub fn approval_json(a: approval_row.Row) -> Json {
  json.object([
    #("id", id.approval_json(a.id)),
    #(
      "decision",
      json.object([
        #("outcome", case_outcome.to_json(a.decision_outcome)),
        #("reasons", json.nullable(a.decision_reasons, json.string)),
      ]),
    ),
    #("requestedBy", person(user(a.requested_by_user_id), a.requested_by_name)),
    #("status", approval_row.status_to_json(a.status)),
    #("requestedAt", json.int(a.requested_at)),
    #("resolvedBy", case a.resolved_at {
      Some(at) ->
        json.object([
          #("userId", json.nullable(user(a.resolved_by_user_id), json.string)),
          #("name", json.nullable(a.resolved_by_name, json.string)),
          #("at", json.int(at)),
        ])
      None -> json.null()
    }),
  ])
}

fn room_json(r: row.Row, tags: List(String)) -> Json {
  case r.room_status {
    None -> json.null()
    Some(status) ->
      json.object([
        #("status", room_status.to_json(status)),
        #("priority", json.nullable(r.room_priority, row.room_priority_to_json)),
        #("tags", json.array(tags, json.string)),
        #(
          "leadScoutUserId",
          json.nullable(r.room_lead_scout_user_id, id.org_user_json),
        ),
        #(
          "sourceContext",
          json.nullable(r.room_source_context, source_context.to_json),
        ),
        #(
          "sourceRef",
          source_ref(r.room_source_ref_id, r.room_source_ref_version),
        ),
        #(
          "openedBy",
          person(user(r.room_opened_by_user_id), r.room_opened_by_name),
        ),
        #("updatedAt", json.nullable(r.room_updated_at, json.int)),
        #("archivedAt", json.nullable(r.room_archived_at, json.int)),
        #("closedAt", json.nullable(r.room_closed_at, json.int)),
        #("rev", json.nullable(r.room_rev, json.int)),
        #("revAt", json.nullable(r.room_rev_at, json.int)),
        #("revBy", person(r.room_rev_by_user_id, r.room_rev_by_name)),
        #("reopened", case r.room_reopened_at {
          None -> json.null()
          Some(at) ->
            json.object([
              #(
                "by",
                person(r.room_reopened_by_user_id, r.room_reopened_by_name),
              ),
              #("at", json.int(at)),
              #(
                "from",
                json.nullable(r.room_reopened_from, room_status.to_json),
              ),
              #("reasonCodes", parsed(r.room_reopened_reason_codes_json)),
              #(
                "sourceContext",
                json.nullable(
                  r.room_reopened_source_context,
                  source_context.to_json,
                ),
              ),
              #(
                "sourceRef",
                source_ref(
                  r.room_reopened_source_ref_id,
                  r.room_reopened_source_ref_version,
                ),
              ),
            ])
        }),
      ])
  }
}

fn source_ref(ref_id: Option(String), version: Option(Int)) -> Json {
  case ref_id {
    Some(i) ->
      json.object([
        #("id", json.string(i)),
        #("version", json.nullable(version, json.int)),
      ])
    None -> json.null()
  }
}

fn draft_json(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(Json, Fail(e)) {
  use drafts <- result.try(of_case(
    read,
    draft_row.columns,
    draft_row.table,
    case_id,
    "rowid",
    draft_row.decoder(),
  ))
  case drafts {
    [] -> Ok(json.null())
    [d, ..] -> {
      use codes <- result.try(of_case(
        read,
        "code",
        "case_decision_draft_reason_codes",
        case_id,
        "position",
        decode.at([0], decode.string),
      ))
      use refs <- result.map(of_case(
        read,
        ref_row.columns,
        ref_row.table,
        case_id,
        "position",
        ref_row.decoder(),
      ))
      let with_role = fn(u, name, role) {
        case u, name, role {
          None, None, None -> json.null()
          _, _, _ ->
            json.object([
              #("userId", json.nullable(user(u), json.string)),
              #("name", json.nullable(name, json.string)),
              #("role", json.nullable(role, json.string)),
            ])
        }
      }
      json.object([
        #("id", id.decision_draft_json(d.id)),
        #("outcome", json.nullable(d.outcome, decision_outcome.to_json)),
        #("reasonCodes", json.array(codes, json.string)),
        #("note", json.nullable(d.note, json.string)),
        #(
          "evidenceRefs",
          json.array(refs, fn(r) {
            json.object([
              #("kind", decision_evidence_kind.to_json(r.kind)),
              #("id", json.string(r.ref_id)),
              #("meta", parsed(r.meta_json)),
            ])
          }),
        ),
        #("by", with_role(d.by_user_id, d.by_name, d.by_role)),
        #("createdAt", json.int(d.created_at)),
        #("updatedAt", json.int(d.updated_at)),
        #(
          "updatedBy",
          with_role(d.updated_by_user_id, d.updated_by_name, d.updated_by_role),
        ),
        #("rev", json.int(d.rev)),
        #("revAt", json.nullable(d.rev_at, json.int)),
        #(
          "keys",
          json.object([
            #("create", case d.create_key {
              Some(k) ->
                json.object([
                  #("key", json.string(k)),
                  #("fp", json.nullable(d.create_fp, json.string)),
                ])
              None -> json.null()
            }),
          ]),
        ),
      ])
    }
  }
}

fn handoff_json(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(Json, Fail(e)) {
  use found <- result.map(of_case(
    read,
    handoff_row.columns,
    handoff_row.table,
    case_id,
    "rowid",
    handoff_row.decoder(),
  ))
  case found {
    [] -> json.null()
    [h, ..] ->
      json.object([
        #("id", id.handoff_json(h.id)),
        #("caseId", id.recruitment_case_json(case_id)),
        #("orgId", id.org_json(h.org_id)),
        #("playerId", id.player_json(h.player_id)),
        #("status", handoff_row.status_to_json(h.status)),
        #("invitedAt", json.int(h.invited_at)),
        #("invitedBy", case h.invited_by_user_id, h.invited_by_name {
          None, None -> json.null()
          u, name ->
            json.object([
              #("kind", json.string("org")),
              #("userId", json.nullable(user(u), json.string)),
              #("name", json.nullable(name, json.string)),
            ])
        }),
        #("acceptedAt", json.nullable(h.accepted_at, json.int)),
        #("withdrawnAt", json.nullable(h.withdrawn_at, json.int)),
        #("transactionId", json.nullable(h.transaction_id, id.transaction_json)),
        #("representedAtInvitation", json.bool(h.represented_at_invitation)),
        #(
          "invitedAgencyOrgId",
          json.nullable(h.invited_agency_org_id, id.org_json),
        ),
        #(
          "invitedAgentUserId",
          json.nullable(h.invited_agent_user_id, id.org_user_json),
        ),
        #(
          "keys",
          json.object([
            #("invite", case h.invite_key {
              Some(k) -> json.object([#("key", json.string(k))])
              None -> json.null()
            }),
          ]),
        ),
        #("rev", json.int(h.rev)),
        #("revAt", json.nullable(h.rev_at, json.int)),
      ])
  }
}

fn budget_json(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(Json, Fail(e)) {
  use scenarios <- result.try(of_case(
    read,
    scenario_row.columns,
    scenario_row.table,
    case_id,
    "position",
    scenario_row.decoder(),
  ))
  use rendered <- result.map(
    list.try_map(scenarios, fn(s) {
      use lines <- result.try(of_scenario(
        read,
        line_row.columns,
        line_row.table,
        case_id,
        s.id,
        line_row.decoder(),
      ))
      use fx <- result.try(of_scenario(
        read,
        fx_row.columns,
        fx_row.table,
        case_id,
        s.id,
        fx_row.decoder(),
      ))
      use actuals <- result.map(of_scenario(
        read,
        actual_row.columns,
        actual_row.table,
        case_id,
        s.id,
        actual_row.decoder(),
      ))
      json.object([
        #("id", id.budget_scenario_json(s.id)),
        #("version", json.int(s.version)),
        #("label", json.string(s.label)),
        #("currency", currency.to_json(s.currency)),
        #("termMonths", json.int(s.term_months)),
        #(
          "lines",
          json.array(lines, fn(l) {
            json.object([
              #("id", id.budget_line_json(l.id)),
              #("kind", line_row.kind_to_json(l.kind)),
              #("label", json.string(l.label)),
              #("amountMinor", json.int(l.amount_minor)),
              #("currency", currency.to_json(l.currency)),
              #("schedule", line_row.schedule_to_json(l.schedule)),
              #("confirmed", json.bool(l.confirmed)),
              #("conditional", case l.conditional_assumption {
                Some(a) -> json.object([#("assumption", json.string(a))])
                None -> json.null()
              }),
            ])
          }),
        ),
        #(
          "fxAssumptions",
          json.array(fx, fn(a) {
            json.object([
              #("from", currency.to_json(a.from_currency)),
              #("to", currency.to_json(a.to_currency)),
              #("rate", json.string(a.rate)),
              #("source", json.nullable(a.source, json.string)),
              #("date", json.string(a.date)),
              #("manual", json.bool(a.manual)),
            ])
          }),
        ),
        #("approval", case s.approval_at {
          None -> json.null()
          Some(at) ->
            json.object([
              #("by", json.nullable(s.approval_by_name, json.string)),
              #(
                "byUserId",
                json.nullable(s.approval_by_user_id, id.org_user_json),
              ),
              #("at", json.int(at)),
              #("version", json.nullable(s.approval_version, json.int)),
              #(
                "superseded",
                json.bool(option.unwrap(s.approval_superseded, False)),
              ),
            ])
        }),
        #(
          "actuals",
          json.array(actuals, fn(a) {
            json.object([
              #("id", id.budget_actual_json(a.id)),
              #("lineId", id.budget_line_json(a.line_id)),
              #("amountMinor", json.int(a.amount_minor)),
              #("at", json.int(a.at)),
              #("recordedBy", json.nullable(a.recorded_by_name, json.string)),
            ])
          }),
        ),
        #("createdBy", json.nullable(s.created_by_name, json.string)),
        #("createdAt", json.int(s.created_at)),
        #("updatedAt", json.int(s.updated_at)),
      ])
    }),
  )
  case rendered {
    [] -> json.null()
    _ -> json.object([#("scenarios", json.preprocessed_array(rendered))])
  }
}

/// The case as the repository decodes it (recruitmentCases.ts `decodeCase`), in its key order.
fn assignment_json(a: assignment_row.Row) -> Json {
  json.object([
    #("id", id.assignment_json(a.id)),
    #("userId", id.org_user_json(a.user_id)),
    #("name", json.nullable(a.user_name, json.string)),
    #("task", json.string(a.task)),
    #("dueAt", cases.due_json(a.due_day, a.due_at)),
    #("status", task_state.to_json(a.status)),
    #("createdAt", json.int(a.created_at)),
  ])
}

fn task_json(t: task_row.Row) -> Json {
  json.object([
    #("id", id.task_json(t.id)),
    #("title", json.string(t.title)),
    #("description", json.nullable(t.description, json.string)),
    #("dueAt", cases.due_json(t.due_day, t.due_at)),
    #("assigneeUserId", json.nullable(t.assignee_user_id, id.org_user_json)),
    #("assigneeName", json.nullable(t.assignee_name, json.string)),
    #("status", task_state.to_json(t.status)),
    #(
      "linkedResourceType",
      json.nullable(
        t.linked_resource_type,
        task_row.linked_resource_type_to_json,
      ),
    ),
    #("linkedResourceId", json.nullable(t.linked_resource_id, json.string)),
    #("createdBy", person(user(t.created_by_user_id), t.created_by_name)),
    #("createdAt", json.int(t.created_at)),
    #("completedAt", json.nullable(t.completed_at, json.int)),
    #("completedBy", json.nullable(t.completed_by_name, json.string)),
  ])
}

pub fn record_json(read: Read, r: row.Row) -> Result(Json, Fail(e)) {
  let case_id = r.id
  use assignments <- result.try(of_case(
    read,
    assignment_row.columns,
    assignment_row.table,
    case_id,
    "position",
    assignment_row.decoder(),
  ))
  use tasks <- result.try(of_case(
    read,
    task_row.columns,
    task_row.table,
    case_id,
    "position",
    task_row.decoder(),
  ))
  use approvals <- result.try(of_case(
    read,
    approval_row.columns,
    approval_row.table,
    case_id,
    "position",
    approval_row.decoder(),
  ))
  use request_ids <- result.try(of_case(
    read,
    "request_id",
    "case_request_links",
    case_id,
    "position",
    decode.at([0], decode.string),
  ))
  use trial_ids <- result.try(of_case(
    read,
    "trial_id",
    "case_trial_links",
    case_id,
    "position",
    decode.at([0], decode.string),
  ))
  use history <- result.try(of_case(
    read,
    history_row.columns,
    history_row.table,
    case_id,
    "position",
    history_row.decoder(),
  ))
  use tags <- result.try(of_case(
    read,
    "tag",
    "case_room_tags",
    case_id,
    "position",
    decode.at([0], decode.string),
  ))
  use draft <- result.try(draft_json(read, case_id))
  use handoff <- result.try(handoff_json(read, case_id))
  use budget <- result.map(budget_json(read, case_id))
  json.object([
    #("id", id.recruitment_case_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #("vacancyId", json.nullable(r.vacancy_id, json.string)),
    #("ownerUserId", id.org_user_json(r.owner_user_id)),
    #("ownerName", json.nullable(r.owner_name, json.string)),
    #("stage", row.stage_to_json(r.stage)),
    #("priority", row.priority_to_json(r.priority)),
    #("deadline", cases.due_json(r.deadline_day, r.deadline_at)),
    #("restricted", json.bool(r.restricted)),
    #("assignments", json.array(assignments, assignment_json)),
    #("tasks", json.array(tasks, task_json)),
    #("approvals", json.array(approvals, approval_json)),
    #("decision", decision_json(r)),
    #(
      "links",
      json.object([
        #("requestIds", json.array(request_ids, json.string)),
        #("trialIds", json.array(trial_ids, json.string)),
        #("signingId", json.nullable(r.links_signing_id, json.string)),
      ]),
    ),
    #("createdAt", json.int(r.created_at)),
    #("history", json.array(history, history_json)),
    #("room", room_json(r, tags)),
    #("decisionDraft", draft),
    #("transactionHandoff", handoff),
    #("budget", budget),
    #("subjectRemovedAt", json.nullable(r.subject_removed_at, json.int)),
  ])
}

/// The case's decision as its record shows it, or null before one is made.
pub fn decision_json(r: row.Row) -> Json {
  case r.decision_at {
    None -> json.null()
    Some(at) ->
      json.object([
        #("outcome", json.nullable(r.decision_outcome, case_outcome.to_json)),
        #("reasons", json.nullable(r.decision_reasons, json.string)),
        #("byUserId", json.nullable(r.decision_by_user_id, id.org_user_json)),
        #("byName", json.nullable(r.decision_by_name, json.string)),
        #("approvedBy", json.nullable(r.decision_approved_by_name, json.string)),
        #("at", json.int(at)),
      ])
  }
}

// ------------------------------------------------------------------------------------------------------ routes

/// The organisation's case with this id, as `GET /org/cases/:id` serves it: what support reads under an access
/// grant, so no restriction applies.
pub fn record_of_org(
  read: Read,
  org_id: id.OrgId,
  case_id: String,
) -> Result(Option(Json), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT "
      <> row.columns
      <> " FROM recruitment_cases WHERE id = ? AND org_id = ?",
    [id.recruitment_case_sql(id.recruitment_case(case_id)), id.org_sql(org_id)],
    row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(r) -> record_json(read, r) |> result.map(Some)
  }
}

/// Every case of the organisation, Rooms included, oldest first, each with its history: the audit export's.
pub fn histories_json(read: Read, org_id: id.OrgId) -> Result(Json, Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM recruitment_cases WHERE org_id = ? ORDER BY rowid",
    [id.org_sql(org_id)],
    row.decoder(),
  ))
  use items <- result.map(
    list.try_map(rows, fn(r) {
      use history <- result.map(of_case(
        read,
        history_row.columns,
        history_row.table,
        r.id,
        "position",
        history_row.decoder(),
      ))
      json.object([
        #("id", id.recruitment_case_json(r.id)),
        #("playerId", id.player_json(r.player_id)),
        #("history", json.array(history, history_json)),
      ])
    }),
  )
  json.preprocessed_array(items)
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  case r {
    Ok(a) -> Ok(a)
    Error(store.Storage(e)) -> Error(store.Storage(e))
    Error(store.Stale(what)) -> Error(store.Stale(what))
    Error(store.Refuse(_)) -> panic as "a read refused"
  }
}

fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(resp) -> resp
    Error(store.Refused(resp)) -> resp
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn case_body(
  read: Read,
  r: row.Row,
  status: Int,
) -> Result(Response, Fail(Response)) {
  use body <- result.map(record_json(read, r) |> storage)
  http.json(status, json.object([#("case", body)]))
}

fn reread(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(row.Row, Fail(Response)) {
  use found <- result.try(
    store.query(
      read,
      "SELECT " <> row.columns <> " FROM recruitment_cases WHERE id = ?",
      [id.recruitment_case_sql(case_id)],
      row.decoder(),
    )
    |> storage,
  )
  case found {
    [r] -> Ok(r)
    _ -> store.refuse(http.error(404, "CASE_NOT_FOUND"))
  }
}

/// The organisation's case, if this member may open it: a restricted case is its owner's, its assignees' and the
/// recruitment leads'.
fn find(
  read: Read,
  a: OrgAccess,
  case_id: String,
) -> Result(row.Row, Fail(Response)) {
  let cid = id.recruitment_case(case_id)
  use found <- result.try(
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> " FROM recruitment_cases WHERE id = ? AND org_id = ?",
      [id.recruitment_case_sql(cid), id.org_sql(a.org.id)],
      row.decoder(),
    )
    |> storage,
  )
  case found {
    [] -> store.refuse(http.error(404, "CASE_NOT_FOUND"))
    [r, ..] ->
      case
        r.restricted && r.owner_user_id != a.user.id && !access.is_lead(a.user)
      {
        False -> Ok(r)
        True -> {
          use assigned <- result.try(
            store.query(
              read,
              "SELECT 1 FROM case_assignments WHERE case_id = ? AND user_id = ?",
              [id.recruitment_case_sql(r.id), id.org_user_sql(a.user.id)],
              decode.at([0], decode.int),
            )
            |> storage,
          )
          case assigned {
            [_, ..] -> Ok(r)
            [] ->
              store.refuse(http.error_message(
                403,
                "CASE_RESTRICTED",
                "This case is restricted to its owner, assignees and recruitment leads.",
              ))
          }
        }
      }
  }
}

type ListQuery {
  ListQuery(
    limit: Option(String),
    cursor: Option(String),
    stage: Option(row.Stage),
  )
}

/// `GET /org/cases`: the cases this member may open, optionally at one stage, newest first by cursor
/// (`[createdAt, id]`), filtered and paged in SQL.
pub fn list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let stages = stages_for(a)
  let shape = {
    use limit <- input.field("limit", input.optional(input.text(1000)))
    use cursor <- input.field("cursor", input.optional(input.text(100_000)))
    use stage <- input.field(
      "stage",
      input.optional(
        input.one_of(
          list.filter(row.stage_pairs, fn(p) { list.contains(stages, p.1) }),
        ),
      ),
    )
    input.done(ListQuery(limit:, cursor:, stage:))
  }
  use q <- http.query(req, shape, [#("stage", "STAGE_INVALID")])
  case paging.read(paging.Query(q.limit, q.cursor), [IntKind, TextKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let #(access_sql, access_args) = case access.is_lead(a.user) {
        True -> #("1", [])
        False -> #(
          "(c.restricted = 0 OR c.owner_user_id = ? OR EXISTS (SELECT 1 FROM case_assignments a WHERE a.case_id = c.id AND a.user_id = ?))",
          [id.org_user_sql(a.user.id), id.org_user_sql(a.user.id)],
        )
      }
      let #(stage_sql, stage_args) = case q.stage {
        Some(st) -> #(" AND c.stage = ?", [
          sqlight.text(row.stage_to_string(st)),
        ])
        None -> #("", [])
      }
      let #(after_sql, after_args) = case page.after {
        Some([IntKey(at), TextKey(cid)]) -> #(
          " AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))",
          [sqlight.int(at), sqlight.int(at), sqlight.text(cid)],
        )
        _ -> #("", [])
      }
      let read =
        store.read(ctx.store, fn(read) {
          use found <- result.try(store.query(
            read,
            "SELECT "
              <> row.qualified("c")
              <> " FROM recruitment_cases c WHERE c.org_id = ? AND "
              <> access_sql
              <> stage_sql
              <> after_sql
              <> " ORDER BY c.created_at DESC, c.id DESC LIMIT ?",
            list.flatten([
              [id.org_sql(a.org.id)],
              access_args,
              stage_args,
              after_args,
              [sqlight.int(page.limit + 1)],
            ]),
            row.decoder(),
          ))
          let #(items, next) =
            paging.page_of(found, page.limit, fn(r) {
              [
                IntKey(r.created_at),
                TextKey(id.recruitment_case_to_string(r.id)),
              ]
            })
          use bodies <- result.map(list.try_map(items, record_json(read, _)))
          #(bodies, next)
        })
      case read {
        Error(e) -> http.internal(e)
        Ok(#(items, next)) ->
          http.json(
            200,
            json.object([
              #("items", json.preprocessed_array(items)),
              #("nextCursor", json.nullable(next, json.string)),
              #("stages", json.array(stages, row.stage_to_json)),
            ]),
          )
      }
    }
  }
}

type TaskBody {
  TaskBody(
    title: Option(String),
    assignee: Option(String),
    due: Option(Option(temporal.Due)),
  )
}

/// `POST /org/cases/:id/tasks`: a task on a case this member may open, for a current member of the club.
pub fn add_task(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
) -> Response {
  let shape = {
    use title <- input.field("title", input.nullish(input.text(task_title_max)))
    use assignee <- input.field("assigneeUserId", input.nullish(input.id()))
    use due <- input.field("dueAt", input.optional(input.due_date()))
    input.done(TaskBody(title:, assignee:, due:))
  }
  let body = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(find(read, a, case_id))
    use b <- result.try(case body {
      Ok(b) -> Ok(b)
      Error(refused) -> store.refuse(refused)
    })
    use assignee <- result.try(case b.assignee {
      None -> Ok(None)
      Some(u) -> {
        use found <- result.try(staff.by_id(read, id.org_user(u)) |> storage)
        case found {
          Some(s) if s.org_id == a.org.id && s.removed_at == None ->
            Ok(Some(s.id))
          _ -> store.refuse(http.error(404, "USER_NOT_IN_ORG"))
        }
      }
    })
    case string.trim(option.unwrap(b.title, "")) {
      "" -> store.refuse(http.error(400, "TITLE_REQUIRED"))
      title -> {
        use t <- result.map(
          cases.add_case_task(
            tx,
            c.id,
            title,
            assignee,
            option.flatten(b.due),
            now,
          )
          |> storage,
        )
        http.json(
          201,
          json.object([
            #(
              "task",
              json.object([
                #("id", id.task_json(t.id)),
                #("title", json.string(t.title)),
                #("dueAt", cases.due_json(t.due_day, t.due_at)),
                #(
                  "assigneeUserId",
                  json.nullable(t.assignee_user_id, id.org_user_json),
                ),
                #("status", task_state.to_json(t.status)),
                #("createdAt", json.int(t.created_at)),
              ]),
            ),
          ]),
        )
      }
    }
  })
  |> answer
}

type NewCaseBody {
  NewCaseBody(
    player_id: String,
    vacancy_id: Option(String),
    priority: Option(row.Priority),
    deadline: Option(Option(temporal.Due)),
    restricted: Option(Bool),
  )
}

/// `POST /org/cases`: a plain case at the first stage of the organisation's pipeline.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.required(input.id()))
    use vacancy_id <- input.field("vacancyId", input.nullish(input.id()))
    use priority <- input.field(
      "priority",
      input.nullish(input.one_of(row.priority_pairs)),
    )
    use deadline <- input.field("deadline", input.optional(input.due_date()))
    use restricted <- input.field("restricted", input.nullish(input.boolean()))
    input.done(NewCaseBody(
      player_id:,
      vacancy_id:,
      priority:,
      deadline:,
      restricted:,
    ))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(
      players.for_org(read, id.player(body.player_id), a.org, now) |> storage,
    )
    use p <- result.try(case found {
      None -> store.refuse(http.error(404, "PLAYER_NOT_FOUND"))
      Some(#(_, access)) if !access.visible || access.blocked ->
        store.refuse(http.error(403, "NOT_VISIBLE"))
      Some(#(p, _)) -> Ok(p)
    })
    use _ <- result.try(case body.vacancy_id {
      None -> Ok(Nil)
      Some(v) -> {
        use rows <- result.try(
          store.query(
            read,
            "SELECT 1 FROM vacancies WHERE id = ? AND org_id = ?",
            [id.vacancy_sql(id.vacancy(v)), id.org_sql(a.org.id)],
            decode.at([0], decode.int),
          )
          |> storage,
        )
        case rows {
          [] -> store.refuse(http.error(404, "VACANCY_NOT_FOUND"))
          _ -> Ok(Nil)
        }
      }
    })
    let assert [stage, ..] = stages_for(a)
    use case_id <- result.try(
      cases.create_plain(
        tx,
        cases.PlainCase(
          org_id: a.org.id,
          player_id: p.row.id,
          player_name: p.row.name,
          vacancy_id: body.vacancy_id,
          owner: #(a.user.id, a.user.name),
          stage:,
          priority: option.unwrap(body.priority, row.Medium),
          deadline: option.flatten(body.deadline),
          restricted: option.unwrap(body.restricted, False),
          at: now,
        ),
      )
      |> storage,
    )
    use _ <- result.try(
      cases.record(
        tx,
        case_id,
        cases.by_staff(a.user.id, a.user.name),
        [cases.text_entry("created", row.stage_to_string(stage))],
        now,
      )
      |> storage,
    )
    use r <- result.try(reread(store.reading(tx), case_id))
    case_body(store.reading(tx), r, 201)
  })
  |> answer
}

type StageBody {
  StageBody(stage: row.Stage, reason: Option(String))
}

/// `POST /org/cases/:id/stage`. On a case with a Room the stage is derived from the Room's status, so it is not
/// writable here: that would bypass the lifecycle (transitions, evidence, history, rev), and mapping a stage back
/// to a status is lossy and could move a Room backwards.
pub fn set_stage(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
) -> Response {
  use raw <- http.json_body(req)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(find(read, a, case_id))
    use _ <- result.try(case c.room_status {
      Some(status) ->
        store.refuse(http.json(
          409,
          json.object([
            #("error", json.string("STAGE_NOT_SETTABLE_ON_ROOM")),
            #(
              "message",
              json.string(
                "This case has a Recruitment Room. Its stage is derived from the room status — move the case through a lifecycle action instead.",
              ),
            ),
            #("roomStatus", room_status.to_json(status)),
            #("stage", row.stage_to_json(c.stage)),
            #(
              "use",
              json.string(
                "POST /org/rooms/"
                <> id.recruitment_case_to_string(c.id)
                <> "/lifecycle",
              ),
            ),
          ]),
        ))
      None -> Ok(Nil)
    })
    use body <- result.try(
      parse(raw, stage_shape(a), [#("stage", "STAGE_INVALID")]),
    )
    use _ <- result.try(case body.stage, c.decision_at {
      row.Closed, None ->
        store.refuse(http.error_message(
          409,
          "DECISION_REQUIRED",
          "Close a case through a recorded decision — no silent drops.",
        ))
      _, _ -> Ok(Nil)
    })
    let reason = input.filled(body.reason)
    use _ <- result.try(cases.set_stage(tx, c.id, body.stage) |> storage)
    use _ <- result.try(
      cases.record(
        tx,
        c.id,
        cases.by_staff(a.user.id, a.user.name),
        [
          cases.text_entry(
            "stage",
            row.stage_to_string(c.stage)
              <> " → "
              <> row.stage_to_string(body.stage)
              <> case reason {
              Some(r) -> ": " <> r
              None -> ""
            },
          ),
        ],
        now,
      )
      |> storage,
    )
    use r <- result.try(reread(store.reading(tx), c.id))
    case_body(store.reading(tx), r, 200)
  })
  |> answer
}

fn stage_shape(a: OrgAccess) -> input.Shape(StageBody) {
  let allowed =
    list.filter(row.stage_pairs, fn(p) { list.contains(stages_for(a), p.1) })
  use stage <- input.field("stage", input.required(input.one_of(allowed)))
  use reason <- input.field("reason", input.nullish(input.text(reasons_max)))
  input.done(StageBody(stage:, reason:))
}

/// The body read with `shape` inside a unit: its refusal rolls the unit back.
fn parse(
  raw: Dynamic,
  shape: input.Shape(a),
  codes: List(#(String, String)),
) -> Result(a, Fail(Response)) {
  case input.parse(shape, raw, root: "body", codes:) {
    Ok(v) -> Ok(v)
    Error(refusal) -> store.refuse(http.refused(refusal))
  }
}

type DecisionBody {
  DecisionBody(outcome: case_outcome.CaseOutcome, reasons: String)
}

/// `POST /org/cases/:id/decision`. On Pro, a non-lead's sign decision waits for a recruitment lead's approval;
/// Grassroots and the other outcomes record directly. On a Room the stage is derived from the lifecycle status, so
/// only a plain case moves stage.
pub fn decide(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
) -> Response {
  use raw <- http.json_body(req)
  let now = clock.now_ms()
  let shape = {
    use outcome <- input.field(
      "outcome",
      input.required(input.one_of(case_outcome.pairs)),
    )
    use reasons <- input.field(
      "reasons",
      input.required(input.required_text(reasons_max)),
    )
    input.done(DecisionBody(outcome:, reasons:))
  }
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(find(read, a, case_id))
    use body <- result.try(
      parse(raw, shape, [
        #("outcome", "OUTCOME_INVALID"),
        #("reasons", "REASONS_REQUIRED"),
      ]),
    )
    let d =
      cases.WorkspaceDecision(
        outcome: body.outcome,
        reasons: body.reasons,
        by: #(a.user.id, a.user.name),
        approved_by: None,
        at: now,
      )
    let by = cases.by_staff(a.user.id, a.user.name)
    let needs_approval =
      !orgs.is_grassroots(a.org)
      && body.outcome == case_outcome.Sign
      && !access.is_lead(a.user)
    case needs_approval {
      True -> {
        use approval <- result.try(
          cases.request_approval(tx, c.id, d) |> storage,
        )
        use _ <- result.map(
          cases.record(
            tx,
            c.id,
            by,
            [
              cases.text_entry(
                "approval_requested",
                case_outcome.to_string(body.outcome),
              ),
            ],
            now,
          )
          |> storage,
        )
        http.json(
          202,
          json.object([
            #("approval", approval_json(approval)),
            #(
              "note",
              json.string(
                "A sign decision needs a recruitment lead’s approval.",
              ),
            ),
          ]),
        )
      }
      False -> {
        use _ <- result.try(cases.record_decision(tx, c.id, d) |> storage)
        use _ <- result.try(
          cases.record(
            tx,
            c.id,
            by,
            [cases.text_entry("decision", case_outcome.to_string(body.outcome))],
            now,
          )
          |> storage,
        )
        use _ <- result.try(case c.room_status {
          None -> cases.set_stage(tx, c.id, row.Decision) |> storage
          Some(_) -> Ok(Nil)
        })
        use r <- result.try(reread(store.reading(tx), c.id))
        case_body(store.reading(tx), r, 200)
      }
    }
  })
  |> answer
}

/// `GET /org/cases/:id`.
pub fn get(ctx: Ctx, a: OrgAccess, case_id: String) -> Response {
  let read =
    store.read(ctx.store, fn(read) {
      use c <- result.try(find(read, a, case_id))
      case_body(read, c, 200)
    })
  case read {
    Ok(resp) -> resp
    Error(store.Refuse(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

/// A notice to a member of the club about a case.
fn notify(
  tx: Tx,
  user_id: id.OrgUserId,
  text: String,
  case_id: id.RecruitmentCaseId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to: audience.OrgUser,
    id: id.org_user_to_string(user_id),
    type_: "case",
    text:,
    ref_id: Some(id.recruitment_case_to_string(case_id)),
    at:,
  )
}

/// The player's name as the TypeScript server interpolates it: a removed player's case reads "null".
fn player_name(c: row.Row) -> String {
  option.unwrap(c.player_name, "null")
}

type AssignBody {
  AssignBody(
    user_id: String,
    task: Option(String),
    due: Option(Option(temporal.Due)),
  )
}

/// `POST /org/cases/:id/assign`: the case's owner or a recruitment lead assigns a current member of the club.
pub fn assign(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
) -> Response {
  use raw <- http.json_body(req)
  let now = clock.now_ms()
  let shape = {
    use user_id <- input.field("userId", input.required(input.id()))
    use task <- input.field(
      "task",
      input.nullish(input.text(assignment_task_max)),
    )
    use due <- input.field("dueAt", input.optional(input.due_date()))
    input.done(AssignBody(user_id:, task:, due:))
  }
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(find(read, a, case_id))
    use _ <- result.try(
      case c.owner_user_id == a.user.id || access.is_lead(a.user) {
        True -> Ok(Nil)
        False -> store.refuse(http.error(403, "OWNER_OR_LEAD_REQUIRED"))
      },
    )
    use body <- result.try(parse(raw, shape, []))
    use found <- result.try(
      staff.by_id(read, id.org_user(body.user_id)) |> storage,
    )
    use u <- result.try(case found {
      Some(s) if s.org_id == a.org.id && s.removed_at == None -> Ok(s)
      _ -> store.refuse(http.error(404, "STAFF_NOT_FOUND"))
    })
    let task = case string.trim(option.unwrap(body.task, "")) {
      "" -> "Scout this player"
      t -> t
    }
    use assignment <- result.try(
      cases.add_assignment(
        tx,
        c.id,
        #(u.id, u.name),
        task,
        option.flatten(body.due),
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      cases.record(
        tx,
        c.id,
        cases.by_staff(a.user.id, a.user.name),
        [cases.text_entry("assigned", u.name <> ": " <> task)],
        now,
      )
      |> storage,
    )
    use _ <- result.map(
      notify(
        tx,
        u.id,
        "📌 "
          <> a.user.name
          <> " assigned you: "
          <> task
          <> " ("
          <> player_name(c)
          <> ").",
        c.id,
        now,
      )
      |> storage,
    )
    http.json(201, json.object([#("assignment", assignment_json(assignment))]))
  })
  |> answer
}

/// `POST /org/cases/:id/tasks/:tid/complete`.
pub fn complete_task(
  ctx: Ctx,
  a: OrgAccess,
  case_id: String,
  task_id: String,
) -> Response {
  let now = clock.now_ms()
  let tid = id.task(task_id)
  let task_of = fn(read, c: row.Row) {
    store.query(
      read,
      "SELECT "
        <> task_row.columns
        <> " FROM case_tasks WHERE case_id = ? AND id = ?",
      [id.recruitment_case_sql(c.id), id.task_sql(tid)],
      task_row.decoder(),
    )
    |> storage
  }
  store.unit(ctx.store, fn(tx) {
    use c <- result.try(find(store.reading(tx), a, case_id))
    use found <- result.try(task_of(store.reading(tx), c))
    use _ <- result.try(case found {
      [] -> store.refuse(http.error(404, "TASK_NOT_FOUND"))
      _ -> Ok(Nil)
    })
    use _ <- result.try(
      cases.update_task(
        tx,
        c.id,
        tid,
        Some(#(task_state.Done, Some(now))),
        Some(a.user.name),
        None,
      )
      |> storage,
    )
    use fresh <- result.map(task_of(store.reading(tx), c))
    let assert [t] = fresh as "the task just updated"
    http.json(200, json.object([#("task", task_json(t))]))
  })
  |> answer
}

/// `POST /org/cases/:id/approvals/:aid`: a recruitment lead answers a pending sign decision. An approved decision
/// is recorded as the requester's, naming the lead who approved it; on a plain case it moves the stage to
/// `decision`.
pub fn answer_approval(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  case_id: String,
  approval_id: String,
) -> Response {
  use raw <- http.json_body(req)
  let now = clock.now_ms()
  let aid = id.approval(approval_id)
  let shape = {
    use approve <- input.field("approve", input.required(input.boolean()))
    input.done(approve)
  }
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(find(read, a, case_id))
    use _ <- result.try(case access.is_lead(a.user) {
      True -> Ok(Nil)
      False -> store.refuse(access.lead_required())
    })
    use found <- result.try(
      store.query(
        read,
        "SELECT "
          <> approval_row.columns
          <> " FROM case_approvals WHERE case_id = ? AND id = ? AND status = 'pending'",
        [id.recruitment_case_sql(c.id), id.approval_sql(aid)],
        approval_row.decoder(),
      )
      |> storage,
    )
    use appr <- result.try(case found {
      [appr] -> Ok(appr)
      _ -> store.refuse(http.error(404, "APPROVAL_NOT_FOUND"))
    })
    use approve <- result.try(parse(raw, shape, []))
    let #(status, action) = case approve {
      True -> #(approval_row.Approved, "approved")
      False -> #(approval_row.Rejected, "rejected")
    }
    let outcome = case_outcome.to_string(appr.decision_outcome)
    use _ <- result.try(
      cases.resolve_approval(
        tx,
        c.id,
        appr.id,
        status,
        #(a.user.id, a.user.name),
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      cases.record(
        tx,
        c.id,
        cases.by_staff(a.user.id, a.user.name),
        [cases.text_entry(action, outcome)],
        now,
      )
      |> storage,
    )
    let assert Some(requester) = appr.requested_by_user_id
      as "an approval names who asked for it"
    use _ <- result.try(case approve {
      False -> Ok(Nil)
      True -> {
        let assert #(Some(name), Some(reasons)) = #(
          appr.requested_by_name,
          appr.decision_reasons,
        )
          as "an approval keeps the requester's name and the decision's reasons"
        use _ <- result.try(
          cases.record_decision(
            tx,
            c.id,
            cases.WorkspaceDecision(
              outcome: appr.decision_outcome,
              reasons:,
              by: #(requester, name),
              approved_by: Some(a.user.name),
              at: now,
            ),
          )
          |> storage,
        )
        case c.room_status {
          None -> cases.set_stage(tx, c.id, row.Decision) |> storage
          Some(_) -> Ok(Nil)
        }
      }
    })
    use _ <- result.try(
      notify(
        tx,
        requester,
        case approve {
          True -> "✅ approved"
          False -> "❌ rejected"
        }
          <> ": your "
          <> outcome
          <> " decision on "
          <> player_name(c)
          <> ".",
        c.id,
        now,
      )
      |> storage,
    )
    use r <- result.try(reread(store.reading(tx), c.id))
    case_body(store.reading(tx), r, 200)
  })
  |> answer
}

type LinkBody {
  LinkBody(
    request: Option(Option(String)),
    trial: Option(Option(String)),
    signing: Option(Option(String)),
  )
}

/// `POST /org/cases/:id/link`: requests, trials and signings are created by their own workflows; the case only
/// links them, each of this club and this player. Every reference is checked before anything is written. The
/// history names the links as sent, a null one included.
pub fn link(ctx: Ctx, req: Request, a: OrgAccess, case_id: String) -> Response {
  use raw <- http.json_body(req)
  let now = clock.now_ms()
  let shape = {
    use request <- input.field("requestId", input.clearable(input.id()))
    use trial <- input.field("trialId", input.clearable(input.id()))
    use signing <- input.field("signingId", input.clearable(input.id()))
    input.done(LinkBody(request:, trial:, signing:))
  }
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use c <- result.try(find(read, a, case_id))
    use body <- result.try(parse(raw, shape, []))
    use request <- result.try(case option.flatten(body.request) {
      None -> Ok(None)
      Some(q) -> {
        use found <- result.try(requests.by_id(read, id.request(q)) |> storage)
        case found {
          Some(r) if r.org_id == a.org.id && r.player_id == c.player_id ->
            Ok(Some(r.id))
          _ -> store.refuse(http.error(404, "REQUEST_NOT_FOUND"))
        }
      }
    })
    use trial <- result.try(case option.flatten(body.trial) {
      None -> Ok(None)
      Some(t) -> {
        use found <- result.try(trials.by_id(read, id.trial(t)) |> storage)
        case found {
          Some(t)
            if t.row.org_id == a.org.id && t.row.player_id == c.player_id
          -> Ok(Some(t.row.id))
          _ -> store.refuse(http.error(404, "TRIAL_NOT_FOUND"))
        }
      }
    })
    use signing <- result.try(case option.flatten(body.signing) {
      None -> Ok(None)
      Some(s) -> {
        use found <- result.try(signings.by_id(read, id.signing(s)) |> storage)
        case found {
          Some(r) if r.org_id == a.org.id && r.player_id == c.player_id ->
            Ok(Some(id.signing_to_string(r.id)))
          _ -> store.refuse(http.error(404, "SIGNING_NOT_FOUND"))
        }
      }
    })
    use _ <- result.try(
      cases.link(tx, c.id, trial, request, signing) |> storage,
    )
    let sent =
      [
        #("requestId", body.request),
        #("trialId", body.trial),
        #("signingId", body.signing),
      ]
      |> list.filter_map(fn(f) {
        case f.1 {
          None -> Error(Nil)
          Some(v) -> Ok(#(f.0, json.nullable(v, json.string)))
        }
      })
    use _ <- result.try(
      cases.record(
        tx,
        c.id,
        cases.by_staff(a.user.id, a.user.name),
        [cases.text_entry("linked", json.to_string(json.object(sent)))],
        now,
      )
      |> storage,
    )
    use r <- result.try(reread(store.reading(tx), c.id))
    case_body(store.reading(tx), r, 200)
  })
  |> answer
}
