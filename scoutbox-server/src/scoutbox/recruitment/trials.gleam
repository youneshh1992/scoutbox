//// Trials (`trials` and its ordered child rows, repositories/recruitment.ts): the current schedule's sessions and
//// their evidence links, every schedule revision with its sessions, append-only attendance, the history, the
//// per-act client keys, the reminder markers, the report and the trial day.
////
//// A trial is created once, at the acceptance of an invitation, then changes only through named acts, each guarded
//// by the state it may move from: a row anywhere else means a route's gate let through a move it should have
//// refused, so the unit stops. An act's bookkeeping (`Acted`) is written with it.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/trial_rules.{
  type Trial, type ValidSession, Day, Revision, Session, Trial,
}
import scoutbox/rows/id
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rows/trial_day_checkins as checkin_row
import scoutbox/rows/trial_day_consents as consent_row
import scoutbox/rows/trial_day_staff as staff_row
import scoutbox/rows/trial_day_status_events as status_event_row
import scoutbox/rows/trial_history as history_row
import scoutbox/rows/trial_keys as key_row
import scoutbox/rows/trial_reminders as reminder_row
import scoutbox/rows/trial_reports as report_row
import scoutbox/rows/trial_revision_sessions as revision_session_row
import scoutbox/rows/trial_schedule_revisions as revision_row
import scoutbox/rows/trial_schedule_sessions as session_row
import scoutbox/rows/trial_session_evidence as evidence_row
import scoutbox/rows/trials as row
import scoutbox/vocab/party
import scoutbox/vocab/trial_actor_kind.{type TrialActorKind}
import scoutbox/vocab/trial_workflow_state.{type TrialWorkflowState}
import sqlight

// ---------------------------------------------------------------------------------------------------- reads

fn children(
  read: Read,
  table: String,
  columns: String,
  where: String,
  args: List(sqlight.Value),
  order: String,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> where
      <> " ORDER BY "
      <> order,
    args,
    decoder,
  )
}

fn owned(
  read: Read,
  tid: sqlight.Value,
  table: String,
  columns: String,
  order: String,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  children(read, table, columns, "trial_id = ?", [tid], order, decoder)
}

fn assemble(read: Read, r: row.Row) -> Result(Trial, Fail(e)) {
  let tid = id.trial_sql(r.id)
  use sessions <- result.try(case trial_rules.has_schedule_row(r) {
    False -> Ok([])
    True -> {
      use rows <- result.try(owned(
        read,
        tid,
        session_row.table,
        session_row.columns,
        "position",
        session_row.decoder(),
      ))
      list.try_map(rows, fn(s) {
        use evidence <- result.map(children(
          read,
          evidence_row.table,
          evidence_row.columns,
          "trial_id = ? AND session_id = ?",
          [tid, id.trial_session_sql(s.id)],
          "position",
          evidence_row.decoder(),
        ))
        Session(s, evidence)
      })
    }
  })
  use revisions <- result.try(case trial_rules.has_schedule_row(r) {
    False -> Ok([])
    True -> {
      use rows <- result.try(owned(
        read,
        tid,
        revision_row.table,
        revision_row.columns,
        "position",
        revision_row.decoder(),
      ))
      list.try_map(rows, fn(v) {
        use sessions <- result.map(children(
          read,
          revision_session_row.table,
          revision_session_row.columns,
          "trial_id = ? AND revision = ?",
          [tid, sqlight.int(v.revision)],
          "position",
          revision_session_row.decoder(),
        ))
        Revision(v, sessions)
      })
    }
  })
  use attendance <- result.try(owned(
    read,
    tid,
    attendance_row.table,
    attendance_row.columns,
    "position",
    attendance_row.decoder(),
  ))
  use history <- result.try(owned(
    read,
    tid,
    history_row.table,
    history_row.columns,
    "position",
    history_row.decoder(),
  ))
  use keys <- result.try(owned(
    read,
    tid,
    key_row.table,
    key_row.columns,
    "act, position",
    key_row.decoder(),
  ))
  use reminders <- result.try(owned(
    read,
    tid,
    reminder_row.table,
    reminder_row.columns,
    "rowid",
    reminder_row.decoder(),
  ))
  use reports <- result.try(owned(
    read,
    tid,
    report_row.table,
    report_row.columns,
    "rowid",
    report_row.decoder(),
  ))
  use staff <- result.try(owned(
    read,
    tid,
    staff_row.table,
    staff_row.columns,
    "position",
    staff_row.decoder(),
  ))
  use consents <- result.try(owned(
    read,
    tid,
    consent_row.table,
    consent_row.columns,
    "position",
    consent_row.decoder(),
  ))
  use checkins <- result.try(owned(
    read,
    tid,
    checkin_row.table,
    checkin_row.columns,
    "position",
    checkin_row.decoder(),
  ))
  use status_events <- result.map(owned(
    read,
    tid,
    status_event_row.table,
    status_event_row.columns,
    "position",
    status_event_row.decoder(),
  ))
  Trial(
    row: r,
    sessions:,
    revisions:,
    attendance:,
    history:,
    keys:,
    reminders:,
    report: list.first(reports) |> option.from_result,
    day: Day(staff:, consents:, checkins:, status_events:),
  )
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Trial), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM trials WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    row.decoder(),
  ))
  list.try_map(rows, assemble(read, _))
}

pub fn by_id(
  read: Read,
  trial_id: id.TrialId,
) -> Result(Option(Trial), Fail(e)) {
  use found <- result.map(select(read, "id = ?", [id.trial_sql(trial_id)]))
  list.first(found) |> option.from_result
}

/// An organisation's trials of a player, in insertion order.
pub fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Trial), Fail(e)) {
  select(read, "org_id = ? AND player_id = ?", [
    id.org_sql(org_id),
    id.player_sql(player_id),
  ])
}

pub fn for_case(
  read: Read,
  case_id: id.RecruitmentCaseId,
) -> Result(List(Trial), Fail(e)) {
  select(read, "case_id = ?", [id.recruitment_case_sql(case_id)])
}

pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Trial), Fail(e)) {
  select(read, "player_id = ?", [id.player_sql(player_id)])
}

pub fn for_players(
  read: Read,
  players: List(id.PlayerId),
) -> Result(List(Trial), Fail(e)) {
  case players {
    [] -> Ok([])
    _ ->
      select(
        read,
        "player_id IN ("
          <> string.join(list.map(players, fn(_) { "?" }), ", ")
          <> ")",
        list.map(players, id.player_sql),
      )
  }
}

pub fn for_org(read: Read, org_id: id.OrgId) -> Result(List(Trial), Fail(e)) {
  select(read, "org_id = ?", [id.org_sql(org_id)])
}

/// The players with a trial of the organisation's in `status`.
pub fn players_with_status(
  read: Read,
  org_id: id.OrgId,
  status: row.Status,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT DISTINCT player_id FROM trials WHERE org_id = ? AND status = ?",
    [id.org_sql(org_id), sqlight.text(row.status_to_string(status))],
    decode.at([0], id.player_decoder()),
  )
}

/// The confirmed, open trials whose reminder may be due: a session within 48 hours or a last session long ended.
pub fn reminders_due(read: Read) -> Result(List(Trial), Fail(e)) {
  select(
    read,
    "schedule_confirmed_at IS NOT NULL AND completion_state IS NULL AND subject_removed_at IS NULL",
    [],
  )
}

/// The report sweep: a deadline passed, no report, never escalated, the subject not removed.
pub fn report_overdue(read: Read, now: Int) -> Result(List(Trial), Fail(e)) {
  select(
    read,
    "report_due_at < ? AND feedback_escalated_at IS NULL AND subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reports r WHERE r.trial_id = trials.id)",
    [sqlight.int(now)],
  )
}

/// The assessment reminder: completed at or before `before`, the subject not removed, not yet reminded.
pub fn completed_unreminded(
  read: Read,
  before: Int,
) -> Result(List(Trial), Fail(e)) {
  select(
    read,
    "completion_state = 'completed' AND completion_at <= ? AND subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reminders m WHERE m.trial_id = trials.id AND m.marker = 'assessmentPending')",
    [sqlight.int(before)],
  )
}

/// The overdue-report escalation, once: `False` when it was already escalated or its report is in.
pub fn escalate_feedback(
  tx: Tx,
  trial_id: id.TrialId,
  at: Int,
) -> Result(Bool, Fail(e)) {
  use marked <- result.map(store.write(
    tx,
    "UPDATE trials SET feedback_escalated_at = ? WHERE id = ? AND feedback_escalated_at IS NULL AND subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reports r WHERE r.trial_id = trials.id) RETURNING id",
    [sqlight.int(at), id.trial_sql(trial_id)],
    decode.at([0], decode.string),
  ))
  marked != []
}

// --------------------------------------------------------------------------------------------------- writes

/// Who did something to a trial: a club member, the recipient, or the system.
pub type Actor {
  Staff(user_id: id.OrgUserId, name: String)
  Family(kind: party.Party, id: String, name: Option(String))
  System
}

fn kind_of(a: Actor) -> TrialActorKind {
  case a {
    Staff(..) -> trial_actor_kind.Org
    Family(party.Player, ..) -> trial_actor_kind.Player
    Family(party.Guardian, ..) -> trial_actor_kind.Guardian
    System -> trial_actor_kind.System
  }
}

/// The four columns of an actor: kind, user id, actor id, name.
fn actor_values(a: Option(Actor)) -> List(sqlight.Value) {
  let t = fn(s: Option(String)) {
    case s {
      Some(v) -> sqlight.text(v)
      None -> sqlight.null()
    }
  }
  case a {
    None -> [sqlight.null(), sqlight.null(), sqlight.null(), sqlight.null()]
    Some(a) -> [
      sqlight.text(trial_actor_kind.to_string(kind_of(a))),
      case a {
        Staff(user, _) -> id.org_user_sql(user)
        _ -> sqlight.null()
      },
      case a {
        Family(_, who, _) -> sqlight.text(who)
        _ -> sqlight.null()
      },
      t(case a {
        Staff(_, name) -> Some(name)
        Family(_, _, name) -> name
        System -> None
      }),
    ]
  }
}

fn actor_set(prefix: String) -> String {
  prefix
  <> "_kind = ?, "
  <> prefix
  <> "_user_id = ?, "
  <> prefix
  <> "_actor_id = ?, "
  <> prefix
  <> "_name = ?"
}

/// One history entry: an action, who, and its detail (ids, states and times only).
pub type Entry {
  Entry(
    id: id.TrialEventId,
    at: Int,
    action: String,
    by: Actor,
    detail: Option(Json),
  )
}

pub fn entry(
  tx: Tx,
  action: String,
  by: Actor,
  detail: List(#(String, Json)),
  at: Int,
) -> Result(Entry, Fail(e)) {
  use event <- result.map(id.next_trial_event(tx))
  Entry(event, at, action, by, Some(json.object(detail)))
}

/// What an act leaves on its trial: a rev bump (by a staff member, or nobody for the family), history and a client
/// key.
pub type Acted {
  Acted(
    at: Int,
    rev_by: Option(#(id.OrgUserId, String)),
    history: List(Entry),
    key: Option(#(key_row.Act, String, String)),
  )
}

/// How many client keys of each act a trial remembers.
const keys_kept = 50

fn next_position(
  tx: Tx,
  table: String,
  where: String,
  args: List(sqlight.Value),
) -> Result(Int, Fail(e)) {
  store.one(
    store.reading(tx),
    "SELECT COALESCE(MAX(position) + 1, 0) FROM " <> table <> " WHERE " <> where,
    args,
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

fn append_history(
  tx: Tx,
  trial_id: id.TrialId,
  entries: List(Entry),
) -> Result(Nil, Fail(e)) {
  list.try_each(entries, fn(h) {
    use position <- result.try(
      next_position(tx, "trial_history", "trial_id = ?", [
        id.trial_sql(trial_id),
      ]),
    )
    store.run(
      tx,
      "INSERT INTO trial_history (trial_id, position, id, at, action, by_kind, by_user_id, by_actor_id, by_name, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      list.flatten([
        [
          id.trial_sql(trial_id),
          sqlight.int(position),
          id.trial_event_sql(h.id),
          sqlight.int(h.at),
          sqlight.text(h.action),
        ],
        actor_values(Some(h.by)),
        [
          case h.detail {
            Some(d) -> sqlight.text(json.to_string(d))
            None -> sqlight.null()
          },
        ],
      ]),
    )
  })
}

fn apply(tx: Tx, trial_id: id.TrialId, acted: Acted) -> Result(Nil, Fail(e)) {
  let tid = id.trial_sql(trial_id)
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE trials SET rev = rev + 1, rev_at = ?, rev_by_user_id = ?, rev_by_name = ? WHERE id = ?",
      [
        sqlight.int(acted.at),
        case acted.rev_by {
          Some(#(user, _)) -> id.org_user_sql(user)
          None -> sqlight.null()
        },
        case acted.rev_by {
          Some(#(_, name)) -> sqlight.text(name)
          None -> sqlight.null()
        },
        tid,
      ],
    ),
  )
  use _ <- result.try(append_history(tx, trial_id, acted.history))
  case acted.key {
    None -> Ok(Nil)
    Some(#(act, key, fp)) -> {
      let act_text = sqlight.text(key_row.act_to_string(act))
      use position <- result.try(
        next_position(tx, "trial_keys", "trial_id = ? AND act = ?", [
          tid,
          act_text,
        ]),
      )
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO trial_keys (trial_id, act, position, key, fp, at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            tid,
            act_text,
            sqlight.int(position),
            sqlight.text(key),
            sqlight.text(fp),
            sqlight.int(acted.at),
          ],
        ),
      )
      store.run(
        tx,
        "DELETE FROM trial_keys WHERE trial_id = ? AND act = ? AND position <= (SELECT MAX(position) FROM trial_keys WHERE trial_id = ? AND act = ?) - ?",
        [tid, act_text, tid, act_text, sqlight.int(keys_kept)],
      )
    }
  }
}

/// An UPDATE of the trial that must touch its row, or the unit stops: the route's gate let through a move from a
/// state the act does not take.
fn guarded(
  tx: Tx,
  trial_id: id.TrialId,
  set: String,
  values: List(sqlight.Value),
  condition: String,
  why: String,
) -> Result(Nil, Fail(e)) {
  use touched <- result.map(store.write(
    tx,
    "UPDATE trials SET "
      <> set
      <> " WHERE id = ? AND ("
      <> condition
      <> ") RETURNING id",
    list.append(values, [id.trial_sql(trial_id)]),
    decode.at([0], decode.string),
  ))
  case touched {
    [_] -> Nil
    _ -> panic as { "trials " <> id.trial_to_string(trial_id) <> " " <> why }
  }
}

fn reload(tx: Tx, trial_id: id.TrialId) -> Result(Trial, Fail(e)) {
  use found <- result.map(by_id(store.reading(tx), trial_id))
  let assert Some(t) = found as "an act's trial reads back"
  t
}

fn act(
  tx: Tx,
  trial_id: id.TrialId,
  acted: Acted,
  write: fn() -> Result(Nil, Fail(e)),
) -> Result(Trial, Fail(e)) {
  use _ <- result.try(write())
  use _ <- result.try(apply(tx, trial_id, acted))
  reload(tx, trial_id)
}

fn text(s: Option(String)) -> sqlight.Value {
  case s {
    Some(v) -> sqlight.text(v)
    None -> sqlight.null()
  }
}

fn opt_int(n: Option(Int)) -> sqlight.Value {
  case n {
    Some(v) -> sqlight.int(v)
    None -> sqlight.null()
  }
}

fn session_values(s: ValidSession) -> List(sqlight.Value) {
  [
    sqlight.text(trial_rules.session_kind_text(s.kind)),
    sqlight.int(s.starts_at),
    sqlight.int(s.ends_at),
    sqlight.text(s.venue.name),
    text(s.venue.town),
    text(s.venue.address),
    text(s.instructions),
  ]
}

// ---------------------------------------------------------------------------------------------------- create

/// The schedule an accepted concrete slot becomes: revision 1, confirmed by the recipient.
pub type Born {
  Born(
    timezone: String,
    session_id: id.TrialSessionId,
    session: ValidSession,
    proposed_at: Int,
    proposed_by: Actor,
  )
}

pub type NewTrial {
  NewTrial(
    id: id.TrialId,
    request_id: id.RequestId,
    case_id: Option(id.RecruitmentCaseId),
    player_id: id.PlayerId,
    player_name: Option(String),
    org_id: id.OrgId,
    org_name: String,
    scout_name: Option(String),
    accepted_at: Int,
    accepted_by: party.Party,
    proposed_date: Option(String),
    venue: Option(String),
    notes: String,
    recipient_guardian_id: Option(id.GuardianId),
    by: Actor,
    schedule: Option(Born),
    history: List(Entry),
  )
}

/// The only writer of an accepted trial (issueAcceptedTrial), inside the respond route's unit.
pub fn create(tx: Tx, n: NewTrial) -> Result(Trial, Fail(e)) {
  let by_guardian = n.accepted_by == party.Guardian
  let state = case n.schedule {
    Some(_) -> trial_workflow_state.Scheduled
    None -> trial_workflow_state.Accepted
  }
  let base =
    row.Row(
      ..row.new(
        id: n.id,
        request_id: n.request_id,
        player_id: n.player_id,
        org_id: n.org_id,
        org_name: n.org_name,
        accepted_at: n.accepted_at,
        status: row.AwaitingReport,
        reminder_sent: False,
        workflow_state: state,
        rev: 1,
      ),
      case_id: n.case_id,
      player_name: n.player_name,
      scout_name: n.scout_name,
      accepted_by: Some(n.accepted_by),
      guardian_approved: Some(by_guardian),
      proposed_date: n.proposed_date,
      venue: n.venue,
      notes: Some(n.notes),
      report_due_at: Some(trial_rules.report_due_at(
        n.proposed_date,
        n.accepted_at,
      )),
      recipient_type: Some(n.accepted_by),
      recipient_player_id: Some(n.player_id),
      recipient_guardian_id: n.recipient_guardian_id,
      recipient_minor: Some(by_guardian),
      recipient_at: Some(n.accepted_at),
      rev_at: Some(n.accepted_at),
    )
  let with_schedule = case n.schedule {
    None -> base
    Some(b) -> {
      let #(pk, pu, pa, pn) = actor_cols(b.proposed_by)
      let #(ck, cu, ca, cn) = actor_cols(n.by)
      row.Row(
        ..base,
        schedule_timezone: Some(b.timezone),
        schedule_revision: Some(1),
        schedule_proposed_at: Some(b.proposed_at),
        schedule_proposed_by_kind: pk,
        schedule_proposed_by_user_id: pu,
        schedule_proposed_by_actor_id: pa,
        schedule_proposed_by_name: pn,
        schedule_confirmed_at: Some(n.accepted_at),
        schedule_confirmed_by_kind: ck,
        schedule_confirmed_by_user_id: cu,
        schedule_confirmed_by_actor_id: ca,
        schedule_confirmed_by_name: cn,
      )
    }
  }
  use _ <- result.try(row.insert(tx, with_schedule))
  use _ <- result.try(case n.schedule {
    None -> Ok(Nil)
    Some(b) -> {
      let tid = id.trial_sql(n.id)
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO trial_schedule_sessions (trial_id, position, id, kind, starts_at, ends_at, venue_name, venue_town, venue_address, instructions) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
          [tid, id.trial_session_sql(b.session_id), ..session_values(b.session)],
        ),
      )
      use _ <- result.try(store.run(
        tx,
        "INSERT INTO trial_schedule_revisions (trial_id, position, revision, timezone, proposed_at, proposed_by_kind, proposed_by_user_id, proposed_by_actor_id, proposed_by_name, confirmed_at, confirmed_by_kind, confirmed_by_user_id, confirmed_by_actor_id, confirmed_by_name, superseded_at, reason, material) VALUES (?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'invitation', NULL)",
        list.flatten([
          [tid, sqlight.text(b.timezone), sqlight.int(b.proposed_at)],
          actor_values(Some(b.proposed_by)),
          [sqlight.int(n.accepted_at)],
          actor_values(Some(n.by)),
        ]),
      ))
      store.run(
        tx,
        "INSERT INTO trial_revision_sessions (trial_id, revision, position, id, kind, starts_at, ends_at, venue_name, venue_town, venue_address, instructions) VALUES (?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
        [tid, id.trial_session_sql(b.session_id), ..session_values(b.session)],
      )
    }
  })
  use _ <- result.try(append_history(tx, n.id, n.history))
  reload(tx, n.id)
}

fn actor_cols(
  a: Actor,
) -> #(Option(TrialActorKind), Option(String), Option(String), Option(String)) {
  case a {
    Staff(user, name) -> #(
      Some(trial_actor_kind.Org),
      Some(id.org_user_to_string(user)),
      None,
      Some(name),
    )
    Family(_, who, name) -> #(Some(kind_of(a)), None, Some(who), name)
    System -> #(Some(trial_actor_kind.System), None, None, None)
  }
}

// ------------------------------------------------------------------------------------------------------ acts

/// A schedule proposal, revision `revision` (one past the current): the open revisions are superseded, the new one
/// recorded with its sessions, and the current sessions replaced (a kept session keeps its evidence links).
/// `keeps_confirmation` keeps the recipient's confirmation (a change that is not material).
pub fn propose_schedule(
  tx: Tx,
  t: Trial,
  revision: Int,
  timezone: String,
  sessions: List(#(id.TrialSessionId, ValidSession)),
  proposed_at: Int,
  proposed_by: Actor,
  keeps_confirmation: Bool,
  reason: Option(String),
  material: Bool,
  state: TrialWorkflowState,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  let tid = id.trial_sql(t.row.id)
  use <- act(tx, t.row.id, acted)
  use _ <- result.try(guarded(
    tx,
    t.row.id,
    "schedule_timezone = ?, schedule_revision = ?, schedule_proposed_at = ?, "
      <> actor_set("schedule_proposed_by")
      <> case keeps_confirmation {
      True -> ""
      False ->
        ", schedule_confirmed_at = NULL, " <> actor_set("schedule_confirmed_by")
    }
      <> ", schedule_declined_at = NULL, "
      <> actor_set("schedule_declined_by")
      <> ", workflow_state = ?",
    list.flatten([
      [sqlight.text(timezone), sqlight.int(revision), sqlight.int(proposed_at)],
      actor_values(Some(proposed_by)),
      case keeps_confirmation {
        True -> []
        False -> actor_values(None)
      },
      actor_values(None),
      [sqlight.text(trial_workflow_state.to_string(state))],
    ]),
    "completion_state IS NULL AND COALESCE(schedule_revision, 0) = "
      <> int.to_string(revision - 1),
    "is not open at schedule revision " <> int.to_string(revision - 1),
  ))
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE trial_schedule_revisions SET superseded_at = ? WHERE trial_id = ? AND superseded_at IS NULL",
      [sqlight.int(proposed_at), tid],
    ),
  )
  use position <- result.try(
    next_position(tx, "trial_schedule_revisions", "trial_id = ?", [tid]),
  )
  use _ <- result.try(store.run(
    tx,
    "INSERT INTO trial_schedule_revisions (trial_id, position, revision, timezone, proposed_at, proposed_by_kind, proposed_by_user_id, proposed_by_actor_id, proposed_by_name, confirmed_at, confirmed_by_kind, confirmed_by_user_id, confirmed_by_actor_id, confirmed_by_name, superseded_at, reason, material) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)",
    list.flatten([
      [
        tid,
        sqlight.int(position),
        sqlight.int(revision),
        sqlight.text(timezone),
        sqlight.int(proposed_at),
      ],
      actor_values(Some(proposed_by)),
      [
        case keeps_confirmation {
          True -> opt_int(t.row.schedule_confirmed_at)
          False -> sqlight.null()
        },
        text(reason),
        sqlight.bool(material),
      ],
    ]),
  ))
  use _ <- result.try(
    list.index_map(sessions, fn(s, i) { #(i, s) })
    |> list.try_each(fn(p) {
      let #(i, #(sid, s)) = p
      store.run(
        tx,
        "INSERT INTO trial_revision_sessions (trial_id, revision, position, id, kind, starts_at, ends_at, venue_name, venue_town, venue_address, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          tid,
          sqlight.int(revision),
          sqlight.int(i),
          id.trial_session_sql(sid),
          ..session_values(s)
        ],
      )
    }),
  )
  replace_sessions(tx, t, sessions)
}

/// Replace the current sessions: a kept session (same id) keeps its evidence links, a dropped one loses them.
fn replace_sessions(
  tx: Tx,
  t: Trial,
  sessions: List(#(id.TrialSessionId, ValidSession)),
) -> Result(Nil, Fail(e)) {
  let tid = id.trial_sql(t.row.id)
  let keep = list.map(sessions, fn(s) { s.0 })
  let had = list.map(t.sessions, fn(s) { s.row.id })
  use _ <- result.try(
    list.try_each(had, fn(sid) {
      case list.contains(keep, sid) {
        True -> Ok(Nil)
        False ->
          store.run(
            tx,
            "DELETE FROM trial_schedule_sessions WHERE trial_id = ? AND id = ?",
            [tid, id.trial_session_sql(sid)],
          )
      }
    }),
  )
  use _ <- result.try(
    store.run(
      tx,
      "UPDATE trial_schedule_sessions SET position = -1 - position WHERE trial_id = ?",
      [tid],
    ),
  )
  list.index_map(sessions, fn(s, i) { #(i, s) })
  |> list.try_each(fn(p) {
    let #(i, #(sid, s)) = p
    case list.contains(had, sid) {
      True ->
        store.run(
          tx,
          "UPDATE trial_schedule_sessions SET position = ?, kind = ?, starts_at = ?, ends_at = ?, venue_name = ?, venue_town = ?, venue_address = ?, instructions = ? WHERE trial_id = ? AND id = ?",
          list.flatten([
            [sqlight.int(i)],
            session_values(s),
            [tid, id.trial_session_sql(sid)],
          ]),
        )
      False ->
        store.run(
          tx,
          "INSERT INTO trial_schedule_sessions (trial_id, position, id, kind, starts_at, ends_at, venue_name, venue_town, venue_address, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [tid, sqlight.int(i), id.trial_session_sql(sid), ..session_values(s)],
        )
    }
  })
}

/// The recipient confirmed the proposed schedule; `by` is who answered.
pub fn confirm_schedule(
  tx: Tx,
  t: Trial,
  at: Int,
  by: Actor,
  by_party: party.Party,
  guardian_id: Option(id.GuardianId),
  state: TrialWorkflowState,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  use <- act(tx, t.row.id, acted)
  use _ <- result.try(guarded(
    tx,
    t.row.id,
    "schedule_confirmed_at = ?, "
      <> actor_set("schedule_confirmed_by")
      <> ", schedule_declined_at = NULL, recipient_type = ?, recipient_player_id = ?, recipient_guardian_id = ?, recipient_minor = ?, recipient_at = ?, workflow_state = ?",
    list.flatten([
      [sqlight.int(at)],
      actor_values(Some(by)),
      [
        sqlight.text(party.to_string(by_party)),
        id.player_sql(t.row.player_id),
        case guardian_id {
          Some(g) -> id.guardian_sql(g)
          None -> sqlight.null()
        },
        sqlight.bool(by_party == party.Guardian),
        sqlight.int(at),
        sqlight.text(trial_workflow_state.to_string(state)),
      ],
    ]),
    "completion_state IS NULL AND schedule_revision IS NOT NULL AND schedule_confirmed_at IS NULL",
    "has no proposed schedule awaiting confirmation",
  ))
  store.run(
    tx,
    "UPDATE trial_schedule_revisions SET confirmed_at = ?, "
      <> actor_set("confirmed_by")
      <> " WHERE trial_id = ? AND revision = (SELECT schedule_revision FROM trials WHERE id = ?)",
    list.flatten([
      [sqlight.int(at)],
      actor_values(Some(by)),
      [id.trial_sql(t.row.id), id.trial_sql(t.row.id)],
    ]),
  )
}

/// The recipient declined the proposed schedule.
pub fn decline_schedule(
  tx: Tx,
  t: Trial,
  at: Int,
  by: Actor,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  use <- act(tx, t.row.id, acted)
  guarded(
    tx,
    t.row.id,
    "schedule_declined_at = ?, " <> actor_set("schedule_declined_by"),
    [sqlight.int(at), ..actor_values(Some(by))],
    "completion_state IS NULL AND schedule_revision IS NOT NULL AND schedule_confirmed_at IS NULL AND schedule_declined_at IS NULL",
    "has no proposed schedule awaiting an answer",
  )
}

/// Who cancelled a trial.
pub fn cancelled_by_text(c: row.CompletionCancelledBy) -> String {
  row.completion_cancelled_by_to_string(c)
}

/// The trial is cancelled, by the club or the recipient, from `phase`.
pub fn cancel(
  tx: Tx,
  t: Trial,
  at: Int,
  by: Actor,
  reason: Option(String),
  phase: TrialWorkflowState,
  cancelled_by: row.CompletionCancelledBy,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  use <- act(tx, t.row.id, acted)
  guarded(
    tx,
    t.row.id,
    "completion_state = 'cancelled', completion_at = ?, "
      <> actor_set("completion_by")
      <> ", completion_reason = ?, completion_phase = ?, completion_cancelled_by = ?, workflow_state = 'cancelled'",
    list.flatten([
      [sqlight.int(at)],
      actor_values(Some(by)),
      [
        text(reason),
        sqlight.text(trial_workflow_state.to_string(phase)),
        sqlight.text(cancelled_by_text(cancelled_by)),
      ],
    ]),
    "completion_state IS NULL",
    "has ended",
  )
}

/// The club recorded the scheduled trial as completed.
pub fn complete(
  tx: Tx,
  t: Trial,
  at: Int,
  by: Actor,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  use <- act(tx, t.row.id, acted)
  guarded(
    tx,
    t.row.id,
    "completion_state = 'completed', completion_at = ?, "
      <> actor_set("completion_by")
      <> ", completion_reason = NULL, completion_phase = 'scheduled', completion_cancelled_by = NULL, workflow_state = 'completed'",
    [sqlight.int(at), ..actor_values(Some(by))],
    "completion_state IS NULL AND workflow_state = 'scheduled'",
    "is not scheduled",
  )
}

/// What happened at a session; appended, never corrected.
pub fn record_attendance(
  tx: Tx,
  t: Trial,
  session_id: id.TrialSessionId,
  state: attendance_row.State,
  by: Actor,
  at: Int,
  note: Option(String),
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  let tid = id.trial_sql(t.row.id)
  use <- act(tx, t.row.id, acted)
  use position <- result.try(
    next_position(tx, "trial_attendance", "trial_id = ?", [tid]),
  )
  store.run(
    tx,
    "INSERT INTO trial_attendance (trial_id, position, session_id, state, source, recorded_by_kind, recorded_by_user_id, recorded_by_actor_id, recorded_by_name, recorded_at, note) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)",
    list.flatten([
      [
        tid,
        sqlight.int(position),
        id.trial_session_sql(session_id),
        sqlight.text(attendance_row.state_to_string(state)),
      ],
      actor_values(Some(by)),
      [sqlight.int(at), text(note)],
    ]),
  )
}

/// A Box Cam session cited on a trial session (a reference, nothing copied).
pub fn link_evidence(
  tx: Tx,
  t: Trial,
  session_id: id.TrialSessionId,
  evidence_id: id.TrialEvidenceId,
  box_session_id: id.BoxSessionId,
  at: Int,
  by: Actor,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  let tid = id.trial_sql(t.row.id)
  use <- act(tx, t.row.id, acted)
  use position <- result.try(
    next_position(
      tx,
      "trial_session_evidence",
      "trial_id = ? AND session_id = ?",
      [tid, id.trial_session_sql(session_id)],
    ),
  )
  store.run(
    tx,
    "INSERT INTO trial_session_evidence (trial_id, session_id, position, id, kind, box_session_id, linked_at, linked_by_kind, linked_by_user_id, linked_by_actor_id, linked_by_name) VALUES (?, ?, ?, ?, 'box_cam_session', ?, ?, ?, ?, ?, ?)",
    list.flatten([
      [
        tid,
        id.trial_session_sql(session_id),
        sqlight.int(position),
        id.trial_evidence_sql(evidence_id),
        id.box_session_sql(box_session_id),
        sqlight.int(at),
      ],
      actor_values(Some(by)),
    ]),
  )
}

/// An evidence link withdrawn: tombstoned with its removal, never erased.
pub fn unlink_evidence(
  tx: Tx,
  t: Trial,
  evidence_id: id.TrialEvidenceId,
  at: Int,
  by: Actor,
  acted: Acted,
) -> Result(Trial, Fail(e)) {
  use <- act(tx, t.row.id, acted)
  store.run(
    tx,
    "UPDATE trial_session_evidence SET removed_at = ?, "
      <> actor_set("removed_by")
      <> " WHERE trial_id = ? AND id = ? AND removed_at IS NULL",
    list.flatten([
      [sqlight.int(at)],
      actor_values(Some(by)),
      [id.trial_sql(t.row.id), id.trial_evidence_sql(evidence_id)],
    ]),
  )
}

/// What the case's lifecycle did with the trial's last step.
pub type Lifecycle {
  Applied(from: String, to: String, at: Int)
  NotApplied(reason: String, at: Int)
}

pub fn record_lifecycle(
  tx: Tx,
  trial_id: id.TrialId,
  lifecycle: Lifecycle,
) -> Result(Trial, Fail(e)) {
  let values = case lifecycle {
    Applied(from, to, at) -> [
      sqlight.int(1),
      sqlight.text(from),
      sqlight.text(to),
      sqlight.null(),
      sqlight.int(at),
    ]
    NotApplied(reason, at) -> [
      sqlight.int(0),
      sqlight.null(),
      sqlight.null(),
      sqlight.text(reason),
      sqlight.int(at),
    ]
  }
  use _ <- result.try(store.run(
    tx,
    "UPDATE trials SET lifecycle_applied = ?, lifecycle_from = ?, lifecycle_to = ?, lifecycle_reason = ?, lifecycle_at = ? WHERE id = ?",
    list.append(values, [id.trial_sql(trial_id)]),
  ))
  reload(tx, trial_id)
}

/// Reminder markers, each set once.
pub fn mark_reminders(
  tx: Tx,
  trial_id: id.TrialId,
  markers: List(#(String, Int)),
) -> Result(Nil, Fail(e)) {
  list.try_each(markers, fn(m) {
    store.run(
      tx,
      "INSERT INTO trial_reminders (trial_id, marker, sent_at) VALUES (?, ?, ?)",
      [id.trial_sql(trial_id), sqlight.text(m.0), sqlight.int(m.1)],
    )
  })
}

// ---------------------------------------------------------------------------------------------- the trial day

fn day_position(
  tx: Tx,
  table: String,
  trial_id: id.TrialId,
) -> Result(Int, Fail(e)) {
  next_position(tx, table, "trial_id = ?", [id.trial_sql(trial_id)])
}

/// A named staff member for the day, with the background check the club filed (pending until Trust & Safety
/// reviews it).
pub type NewStaff {
  NewStaff(
    name: String,
    role: String,
    check: Option(#(String, Option(String), Option(String))),
    added_by: String,
    added_at: Int,
  )
}

pub fn add_staff(
  tx: Tx,
  t: Trial,
  s: NewStaff,
) -> Result(#(Trial, id.TrialStaffId), Fail(e)) {
  use staff_id <- result.try(id.next_trial_staff(tx))
  use position <- result.try(day_position(tx, "trial_day_staff", t.row.id))
  let #(kind, ref, expires) = case s.check {
    Some(#(k, r, e)) -> #(sqlight.text(k), text(r), text(e))
    None -> #(sqlight.null(), sqlight.null(), sqlight.null())
  }
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO trial_day_staff (trial_id, position, id, name, role, check_kind, check_ref, check_status, check_expires_at, check_reviewed_by, check_reviewed_at, added_by_name, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
      [
        id.trial_sql(t.row.id),
        sqlight.int(position),
        id.trial_staff_sql(staff_id),
        sqlight.text(s.name),
        sqlight.text(s.role),
        kind,
        ref,
        case s.check {
          Some(_) -> sqlight.text("pending")
          None -> sqlight.null()
        },
        expires,
        sqlight.text(s.added_by),
        sqlight.int(s.added_at),
      ],
    ),
  )
  use fresh <- result.map(reload(tx, t.row.id))
  #(fresh, staff_id)
}

/// Arrival details replace the last; a collection policy only when one is given.
pub fn set_arrival(
  tx: Tx,
  t: Trial,
  time: Option(String),
  address: Option(String),
  notes: Option(String),
  collection: Option(String),
) -> Result(Trial, Fail(e)) {
  use _ <- result.try(store.run(
    tx,
    "UPDATE trials SET day_arrival_time = ?, day_arrival_address = ?, day_arrival_notes = ?"
      <> case collection {
      Some(_) -> ", day_collection_policy = ?"
      None -> ""
    }
      <> " WHERE id = ?",
    list.flatten([
      [text(time), text(address), text(notes)],
      case collection {
        Some(c) -> [sqlight.text(c)]
        None -> []
      },
      [id.trial_sql(t.row.id)],
    ]),
  ))
  reload(tx, t.row.id)
}

/// A cancellation or postponement of the day; a postponement to a day moves the date and the report deadline.
pub fn record_day_status(
  tx: Tx,
  t: Trial,
  kind: status_event_row.Kind,
  at: Int,
  by_name: String,
  reason: String,
  new_date: Option(String),
) -> Result(Trial, Fail(e)) {
  use position <- result.try(day_position(
    tx,
    "trial_day_status_events",
    t.row.id,
  ))
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO trial_day_status_events (trial_id, position, kind, at, by_name, reason, new_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id.trial_sql(t.row.id),
        sqlight.int(position),
        sqlight.text(status_event_row.kind_to_string(kind)),
        sqlight.int(at),
        sqlight.text(by_name),
        sqlight.text(reason),
        text(new_date),
      ],
    ),
  )
  use _ <- result.try(case kind, new_date {
    status_event_row.Postponed, Some(day) ->
      store.run(
        tx,
        "UPDATE trials SET proposed_date = ?, report_due_at = ? WHERE id = ?",
        [
          sqlight.text(day),
          sqlight.int(trial_rules.report_due_at(Some(day), t.row.accepted_at)),
          id.trial_sql(t.row.id),
        ],
      )
    _, _ -> Ok(Nil)
  })
  reload(tx, t.row.id)
}

/// A check-in, and (when a session is live) its one `attended` attendance record, with the act's bookkeeping.
pub fn check_in(
  tx: Tx,
  t: Trial,
  at: Int,
  by_user: id.OrgUserId,
  by_name: String,
  attended: Option(#(id.TrialSessionId, Acted)),
) -> Result(Trial, Fail(e)) {
  use position <- result.try(day_position(tx, "trial_day_checkins", t.row.id))
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO trial_day_checkins (trial_id, position, player_id, at, by_user_id, by_name) VALUES (?, ?, ?, ?, ?, ?)",
      [
        id.trial_sql(t.row.id),
        sqlight.int(position),
        id.player_sql(t.row.player_id),
        sqlight.int(at),
        id.org_user_sql(by_user),
        sqlight.text(by_name),
      ],
    ),
  )
  case attended {
    None -> reload(tx, t.row.id)
    Some(#(session_id, acted)) -> {
      use apos <- result.try(day_position(tx, "trial_attendance", t.row.id))
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO trial_attendance (trial_id, position, session_id, state, source, recorded_by_kind, recorded_by_user_id, recorded_by_actor_id, recorded_by_name, recorded_at, note) VALUES (?, ?, ?, 'attended', 'checkin', 'org', ?, NULL, ?, ?, NULL)",
          [
            id.trial_sql(t.row.id),
            sqlight.int(apos),
            id.trial_session_sql(session_id),
            id.org_user_sql(by_user),
            sqlight.text(by_name),
            sqlight.int(at),
          ],
        ),
      )
      use _ <- result.try(apply(tx, t.row.id, acted))
      reload(tx, t.row.id)
    }
  }
}

/// Event consent for the day, by the player or the guardian.
pub fn give_consent(
  tx: Tx,
  t: Trial,
  by: Actor,
  scope: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use consent_id <- result.try(id.next_trial_consent(tx))
  use position <- result.try(day_position(tx, "trial_day_consents", t.row.id))
  store.run(
    tx,
    "INSERT INTO trial_day_consents (trial_id, position, id, by_kind, by_user_id, by_actor_id, by_name, scope, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    list.flatten([
      [
        id.trial_sql(t.row.id),
        sqlight.int(position),
        id.trial_consent_sql(consent_id),
      ],
      actor_values(Some(by)),
      [sqlight.text(scope), sqlight.int(at)],
    ]),
  )
}

/// The family's emergency contact for the day, readable only in the club's trial-day view.
pub fn set_emergency(
  tx: Tx,
  t: Trial,
  name: String,
  phone: String,
  set_by: party.Party,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE trials SET day_emergency_name = ?, day_emergency_phone = ?, day_emergency_set_by = ?, day_emergency_at = ? WHERE id = ?",
    [
      sqlight.text(name),
      sqlight.text(phone),
      sqlight.text(party.to_string(set_by)),
      sqlight.int(at),
      id.trial_sql(t.row.id),
    ],
  )
}

/// The mandatory report, filed once.
pub fn file_report(
  tx: Tx,
  t: Trial,
  r: report_row.Row,
) -> Result(Nil, Fail(e)) {
  // Checked before the unit, so a report filed meanwhile, or the subject's erasure, is a lost race: stale.
  use touched <- result.try(store.write(
    tx,
    "UPDATE trials SET status = 'reported' WHERE id = ? AND status = 'awaiting_report' AND subject_removed_at IS NULL RETURNING id",
    [id.trial_sql(t.row.id)],
    decode.at([0], decode.string),
  ))
  case touched {
    [_] -> report_row.insert(tx, r)
    _ -> store.stale("trial " <> id.trial_to_string(t.row.id) <> " report")
  }
}

/// How many trials the organisation has booked, or of them those in `status`.
pub fn count_for_org(
  read: Read,
  org_id: id.OrgId,
  status: Option(row.Status),
) -> Result(Int, Fail(e)) {
  let counted = case status {
    Some(s) ->
      store.one(
        read,
        "SELECT COUNT(*) FROM trials WHERE org_id = ? AND status = ?",
        [id.org_sql(org_id), sqlight.text(row.status_to_string(s))],
        decode.at([0], decode.int),
      )
    None ->
      store.one(
        read,
        "SELECT COUNT(*) FROM trials WHERE org_id = ?",
        [id.org_sql(org_id)],
        decode.at([0], decode.int),
      )
  }
  result.map(counted, result.unwrap(_, 0))
}
