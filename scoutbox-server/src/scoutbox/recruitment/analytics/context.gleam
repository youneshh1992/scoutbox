//// The reporting context the analytics families are computed from (`buildReportingContext`,
//// domains/recruitment/analytics/dashboard.mjs). Each source is read once per organisation into a record that
//// holds only the fields the metrics declared: no actor, no note, no free text. So a name or a private reason
//// can't reach a payload even by accident, and `subject_of` is the only way a player's name enters one.
////
//// Vocabulary values are held as the text the columns store, because the families compare them with the
//// TypeScript rules' own literals.

import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/set
import gleam/string
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/analytics/metrics.{type Window}
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/case_history
import scoutbox/rows/dynamic_watchlists as watchlist_row
import scoutbox/rows/id
import scoutbox/rows/nobody_missed_reviews as review_row
import scoutbox/rows/offer_revisions as revision_row
import scoutbox/rows/recruitment_briefs as brief_row
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/rows/recruitment_contacts as contact_row
import scoutbox/rows/recruitment_offers as offer_row
import scoutbox/rows/recruitment_requests as request_row
import scoutbox/rows/room_decision_reason_codes as reason_row
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/second_look_items as second_look_row
import scoutbox/rows/signing_packages as package_row
import scoutbox/rows/signings as signing_row
import scoutbox/rows/trials as trial_row
import scoutbox/rows/watchlist_membership_events as event_row
import scoutbox/rules/visibility
import scoutbox/vocab/decision_outcome
import scoutbox/vocab/offer_status
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context
import sqlight

// ------------------------------------------------------------------ records

/// A history entry without its actor: analytics can't attribute a status change to a person, which is the raw
/// material of a leaderboard. The detail keeps only `from`, `to` and `status`.
pub type Entry {
  Entry(
    at: Int,
    action: String,
    from: Option(String),
    to: Option(String),
    status: Option(String),
  )
}

pub type Transition {
  Transition(at: Int, from: Option(String), to: String, reopen: Bool)
}

pub type Room {
  Room(
    id: id.RecruitmentCaseId,
    player_id: id.PlayerId,
    created_at: Int,
    status: String,
    priority: String,
    source_context: String,
    history: List(Entry),
    transitions: List(Transition),
  )
}

/// A decision's outcome is read only from a formal one; `note` and `by` are never read.
pub type Decision {
  Decision(
    id: id.RoomDecisionId,
    room_id: id.RecruitmentCaseId,
    created_at: Int,
    reason_codes: List(String),
    superseded_by_id: Option(id.RoomDecisionId),
    formal: Bool,
    draft: Bool,
    outcome: Option(String),
  )
}

/// A trial invitation (a request of type `trial`).
pub type Invitation {
  Invitation(
    case_id: Option(id.RecruitmentCaseId),
    status: String,
    created_at: Int,
    responded_at: Option(Int),
  )
}

pub type Trial {
  Trial(
    id: id.TrialId,
    case_id: Option(id.RecruitmentCaseId),
    status: String,
    accepted_at: Int,
    confirmed_at: Option(Int),
    completion_state: Option(String),
    completion_at: Option(Int),
    report_due_at: Option(Int),
    subject_removed_at: Option(Int),
  )
}

pub type Contact {
  Contact(
    case_id: id.RecruitmentCaseId,
    status: String,
    cancelled_at: Option(Int),
    delivered_at: Option(Int),
    occurred_at: Option(Int),
    recorded_at: Option(Int),
  )
}

pub type Assessment {
  Assessment(
    player_id: id.PlayerId,
    draft: Bool,
    trial_id: Option(String),
    created_at: Int,
    submitted_at: Option(Int),
  )
}

pub type Revision {
  Revision(status: String, issued_at: Option(Int), responded_at: Option(Int))
}

pub type Offer {
  Offer(case_id: id.RecruitmentCaseId, revisions: List(Revision))
}

pub type Package {
  Package(
    id: id.SigningPackageId,
    case_id: id.RecruitmentCaseId,
    created_at: Int,
    completed: Bool,
    signing_id: Option(id.SigningId),
    completed_at: Option(Int),
  )
}

pub type Signing {
  Signing(
    id: id.SigningId,
    player_id: id.PlayerId,
    package_id: Option(id.SigningPackageId),
    ts: Int,
  )
}

pub type Brief {
  Brief(
    id: id.BriefId,
    title: String,
    version: Int,
    status: String,
    active_from: Option(String),
    active_until: Option(String),
  )
}

pub type Review {
  Review(brief_id: id.BriefId, state: String)
}

pub type SecondLook {
  SecondLook(
    room_id: id.RecruitmentCaseId,
    status: String,
    created_at: Int,
    updated_at: Int,
  )
}

pub type MembershipEvent {
  MembershipEvent(transition: String, at: Int)
}

/// Everything read for one organisation, before any filter.
pub type Sources {
  Sources(
    rooms: List(Room),
    decisions: List(Decision),
    invitations: List(Invitation),
    trials: List(Trial),
    contacts: List(Contact),
    assessments: List(Assessment),
    offers: List(Offer),
    packages: List(Package),
    signings: List(Signing),
    briefs: List(Brief),
    reviews: List(Review),
    second_look: List(SecondLook),
    watchlist_statuses: List(String),
    membership_events: List(MembershipEvent),
    /// The players this organisation may see now, by id, with their names.
    visible: Dict(id.PlayerId, String),
  )
}

/// The filters a request asked for. Room filters apply before any metric sees a room.
pub type Filters {
  Filters(
    source_context: Option(String),
    priority: Option(String),
    brief_id: Option(String),
  )
}

pub type Context {
  Context(
    now: Int,
    today: String,
    window: Window,
    /// The filters applied, in the order the TypeScript server lists them.
    filters: List(#(String, String)),
    rooms: List(Room),
    decisions: List(Decision),
    decisions_by_room: Dict(id.RecruitmentCaseId, List(Decision)),
    briefs: List(Brief),
    reviews: List(Review),
    second_look: List(SecondLook),
    watchlist_statuses: List(String),
    membership_events: List(MembershipEvent),
    trials: List(Trial),
    contacts: List(Contact),
    assessments: List(Assessment),
    offers: List(Offer),
    packages: List(Package),
    signings: List(Signing),
    invitations: List(Invitation),
    typical_days_to_terminal: Option(Float),
    visible: Dict(id.PlayerId, String),
  )
}

// ------------------------------------------------------------------ the rules over a room

/// Every status transition, oldest first. The normal reopen path writes both `room_status_changed` and
/// `room_reopened` at the same instant (the Second Look bridge writes only the latter), so identical
/// (at, from, to) triples are collapsed or every reopen would count twice.
pub fn transitions(history: List(Entry)) -> List(Transition) {
  list.fold(history, [], fn(out: List(Transition), h: Entry) {
    case h.action, h.to {
      "room_status_changed", Some(to) | "room_reopened", Some(to) -> {
        let t =
          Transition(
            at: h.at,
            from: h.from,
            to:,
            reopen: h.action == "room_reopened",
          )
        case out {
          [last, ..]
            if last.at == t.at && last.from == t.from && last.to == to
          -> out
          _ -> [t, ..out]
        }
      }
      _, _ -> out
    }
  })
  |> list.reverse
  |> list.sort(fn(a, b) { int.compare(a.at, b.at) })
}

/// A room from its history, its transitions derived from it.
pub fn room(
  id id: id.RecruitmentCaseId,
  player_id player_id: id.PlayerId,
  created_at created_at: Int,
  status status: String,
  priority priority: String,
  source_context source_context: String,
  history history: List(Entry),
) -> Room {
  Room(
    id:,
    player_id:,
    created_at:,
    status:,
    priority:,
    source_context:,
    history:,
    transitions: transitions(history),
  )
}

/// The status the room opened in, from its created entry.
pub fn opened_status(room: Room) -> Option(String) {
  list.find(room.history, fn(h) { h.action == "room_created" })
  |> option.from_result
  |> option.then(fn(h) { h.status })
}

/// Every stage the room ever reached, the one it opened in included.
pub fn stages_reached(room: Room) -> List(String) {
  let seen =
    list.flat_map(room.transitions, fn(t) {
      case t.from {
        Some(f) -> [f, t.to]
        None -> [t.to]
      }
    })
  let seen = case opened_status(room) {
    Some(o) -> [o, ..seen]
    None -> seen
  }
  // A room whose history has no created-detail still has a status now.
  case seen {
    [] -> [room.status]
    _ -> list.unique(seen)
  }
}

pub fn first_reached_at(room: Room, status: String) -> Option(Int) {
  case opened_status(room) == Some(status) {
    True -> Some(room.created_at)
    False ->
      list.find(room.transitions, fn(t) { t.to == status })
      |> result.map(fn(t) { t.at })
      |> option.from_result
  }
}

pub const terminal_statuses = ["signed", "withdrawn", "archived", "closed"]

pub fn is_terminal(status: String) -> Bool {
  list.contains(terminal_statuses, status)
}

pub fn first_terminal_at(room: Room) -> Option(Int) {
  list.find(room.transitions, fn(t) { is_terminal(t.to) })
  |> result.map(fn(t) { t.at })
  |> option.from_result
}

/// `{ playerId, playerName }` for a player the organisation may see now; both null for anyone else, who is
/// still counted, because a count is not a disclosure.
pub fn subject_of(ctx: Context, room: Room) -> List(#(String, Json)) {
  case dict.get(ctx.visible, room.player_id) {
    Ok(name) -> [
      #("playerId", id.player_json(room.player_id)),
      #("playerName", json.string(name)),
    ]
    Error(Nil) -> [#("playerId", json.null()), #("playerName", json.null())]
  }
}

// ------------------------------------------------------------------ the context

pub fn build(
  sources: Sources,
  window: Window,
  now: Int,
  filters: Filters,
) -> Context {
  let decisions =
    list.sort(sources.decisions, fn(a, b) {
      case int.compare(a.created_at, b.created_at) {
        order.Eq ->
          string.compare(
            id.room_decision_to_string(a.id),
            id.room_decision_to_string(b.id),
          )
        o -> o
      }
    })

  let #(rooms, applied) = case filters.source_context {
    Some(s) -> #(list.filter(sources.rooms, fn(r) { r.source_context == s }), [
      #("sourceContext", s),
    ])
    None -> #(sources.rooms, [])
  }
  let #(rooms, applied) = case filters.priority {
    Some(p) -> #(
      list.filter(rooms, fn(r) { r.priority == p }),
      list.append(applied, [#("priority", p)]),
    )
    None -> #(rooms, applied)
  }
  let room_filtered = applied != []
  let kept = set.from_list(list.map(rooms, fn(r) { r.id }))
  let kept_room = fn(case_id) { set.contains(kept, case_id) }

  let kept_decisions = list.filter(decisions, fn(d) { kept_room(d.room_id) })
  let decisions_by_room =
    list.fold(list.reverse(kept_decisions), dict.new(), fn(acc, d) {
      dict.upsert(acc, d.room_id, fn(ds) { [d, ..option.unwrap(ds, [])] })
    })

  let #(briefs, applied) = case filters.brief_id {
    Some(b) -> #(
      list.filter(sources.briefs, fn(x) { id.brief_to_string(x.id) == b }),
      list.append(applied, [#("briefId", b)]),
    )
    None -> #(sources.briefs, applied)
  }
  let brief_ids = set.from_list(list.map(briefs, fn(b) { b.id }))

  // The typical journey, used only as a caution on young cohorts.
  let terminal_durations =
    rooms
    |> list.filter_map(fn(r) {
      case first_terminal_at(r) {
        Some(at) if at >= r.created_at -> Ok(metrics.days(r.created_at, at))
        _ -> Error(Nil)
      }
    })
    |> list.sort(float.compare)
  let typical = case list.length(terminal_durations) {
    n if n >= metrics.small_n_min ->
      list.drop(terminal_durations, n / 2) |> list.first |> option.from_result
    _ -> None
  }

  Context(
    now:,
    today: metrics.utc_day(now),
    window:,
    filters: applied,
    rooms:,
    decisions: kept_decisions,
    decisions_by_room:,
    briefs:,
    reviews: list.filter(sources.reviews, fn(r) {
      set.contains(brief_ids, r.brief_id)
    }),
    // A room filter narrows Second Look too, or whole-club figures would sit under a "source: matching" label.
    second_look: list.filter(sources.second_look, fn(i) {
      !room_filtered || kept_room(i.room_id)
    }),
    watchlist_statuses: sources.watchlist_statuses,
    membership_events: sources.membership_events,
    trials: sources.trials,
    contacts: list.filter(sources.contacts, fn(c) { kept_room(c.case_id) }),
    assessments: sources.assessments,
    offers: list.filter(sources.offers, fn(o) { kept_room(o.case_id) }),
    packages: list.filter(sources.packages, fn(p) { kept_room(p.case_id) }),
    signings: sources.signings,
    invitations: sources.invitations,
    typical_days_to_terminal: typical,
    visible: sources.visible,
  )
}

// ------------------------------------------------------------------ the reads

/// One organisation's sources, each table read once.
pub fn read(read: Read, org: Org, now: Int) -> Result(Sources, Fail(e)) {
  let org_arg = [id.org_sql(org.id)]
  use rooms <- result.try(read_rooms(read, org_arg))
  use decisions <- result.try(read_decisions(read, org_arg))
  use invitations <- result.try(store.query(
    read,
    "SELECT "
      <> request_row.columns
      <> " FROM recruitment_requests WHERE org_id = ? AND type = 'trial' ORDER BY rowid",
    org_arg,
    request_row.decoder(),
  ))
  use trials <- result.try(store.query(
    read,
    "SELECT "
      <> trial_row.columns
      <> " FROM trials WHERE org_id = ? ORDER BY rowid",
    org_arg,
    trial_row.decoder(),
  ))
  use contacts <- result.try(store.query(
    read,
    "SELECT "
      <> contact_row.columns
      <> " FROM recruitment_contacts WHERE org_id = ? ORDER BY rowid",
    org_arg,
    contact_row.decoder(),
  ))
  use assessments <- result.try(store.query(
    read,
    "SELECT "
      <> assessment_row.columns
      <> " FROM assessments WHERE org_id = ? ORDER BY rowid",
    org_arg,
    assessment_row.decoder(),
  ))
  use offers <- result.try(read_offers(read, org_arg))
  use packages <- result.try(store.query(
    read,
    "SELECT "
      <> package_row.columns
      <> " FROM signing_packages WHERE org_id = ? ORDER BY rowid",
    org_arg,
    package_row.decoder(),
  ))
  use signings <- result.try(store.query(
    read,
    "SELECT "
      <> signing_row.columns
      <> " FROM signings WHERE org_id = ? ORDER BY rowid",
    org_arg,
    signing_row.decoder(),
  ))
  use briefs <- result.try(store.query(
    read,
    "SELECT "
      <> brief_row.columns
      <> " FROM recruitment_briefs WHERE org_id = ? ORDER BY updated_at DESC, id",
    org_arg,
    brief_row.decoder(),
  ))
  use reviews <- result.try(store.query(
    read,
    "SELECT "
      <> review_row.columns
      <> " FROM nobody_missed_reviews WHERE org_id = ? ORDER BY rowid",
    org_arg,
    review_row.decoder(),
  ))
  use second_look <- result.try(store.query(
    read,
    "SELECT "
      <> second_look_row.columns
      <> " FROM second_look_items WHERE org_id = ? ORDER BY rowid",
    org_arg,
    second_look_row.decoder(),
  ))
  use watchlists <- result.try(store.query(
    read,
    "SELECT "
      <> watchlist_row.columns
      <> " FROM dynamic_watchlists WHERE org_id = ? ORDER BY rowid",
    org_arg,
    watchlist_row.decoder(),
  ))
  use events <- result.try(store.query(
    read,
    "SELECT "
      <> event_row.columns
      <> " FROM watchlist_membership_events WHERE org_id = ? ORDER BY at, rowid",
    org_arg,
    event_row.decoder(),
  ))
  use visible <- result.try(read_visible(read, org, now))
  Ok(Sources(
    rooms:,
    decisions:,
    invitations: list.map(invitations, fn(r) {
      Invitation(
        case_id: r.case_id,
        status: request_row.status_to_string(r.status),
        created_at: r.created_at,
        responded_at: r.responded_at,
      )
    }),
    trials: list.map(trials, fn(t) {
      Trial(
        id: t.id,
        case_id: t.case_id,
        status: trial_row.status_to_string(t.status),
        accepted_at: t.accepted_at,
        confirmed_at: t.schedule_confirmed_at,
        completion_state: option.map(
          t.completion_state,
          trial_row.completion_state_to_string,
        ),
        completion_at: t.completion_at,
        report_due_at: t.report_due_at,
        subject_removed_at: t.subject_removed_at,
      )
    }),
    contacts: list.map(contacts, fn(c) {
      Contact(
        case_id: c.case_id,
        status: contact_row.status_to_string(c.status),
        cancelled_at: c.cancelled_at,
        delivered_at: c.delivered_at,
        occurred_at: c.occurred_at,
        recorded_at: c.recorded_at,
      )
    }),
    assessments: list.map(assessments, fn(a) {
      Assessment(
        player_id: a.player_id,
        draft: assessment_row.state_to_string(a.state) == "draft",
        trial_id: a.context_trial_id,
        created_at: a.created_at,
        submitted_at: a.submitted_at,
      )
    }),
    offers:,
    packages: list.map(packages, fn(p) {
      Package(
        id: p.id,
        case_id: p.case_id,
        created_at: p.created_at,
        completed: package_row.status_to_string(p.status) == "COMPLETED",
        signing_id: p.completion_signing_id,
        completed_at: p.completion_completed_at,
      )
    }),
    signings: list.map(signings, fn(s) {
      Signing(
        id: s.id,
        player_id: s.player_id,
        package_id: s.signing_package_id,
        ts: s.ts,
      )
    }),
    briefs: list.map(briefs, fn(b) {
      Brief(
        id: b.id,
        title: b.title,
        version: b.version,
        status: brief_row.status_to_string(b.status),
        active_from: b.active_from_date,
        active_until: b.active_until_date,
      )
    }),
    reviews: list.map(reviews, fn(r) {
      Review(brief_id: r.brief_id, state: review_row.state_to_string(r.state))
    }),
    second_look: list.map(second_look, fn(i) {
      SecondLook(
        room_id: i.room_id,
        status: second_look_row.status_to_string(i.status),
        created_at: i.created_at,
        updated_at: i.updated_at,
      )
    }),
    watchlist_statuses: list.map(watchlists, fn(w) {
      watchlist_row.status_to_string(w.status)
    }),
    membership_events: list.map(events, fn(e) {
      MembershipEvent(
        transition: event_row.transition_to_string(e.transition),
        at: e.at,
      )
    }),
    visible:,
  ))
}

/// The organisation's Rooms (a case with no room is not one) with their history, oldest entry first.
fn read_rooms(
  read: Read,
  org_arg: List(sqlight.Value),
) -> Result(List(Room), Fail(e)) {
  use cases <- result.try(store.query(
    read,
    "SELECT "
      <> case_row.columns
      <> " FROM recruitment_cases WHERE org_id = ? AND room_status IS NOT NULL ORDER BY rowid",
    org_arg,
    case_row.decoder(),
  ))
  use entries <- result.try(store.query(
    read,
    "SELECT "
      <> case_history.qualified("h")
      <> " FROM case_history h JOIN recruitment_cases c ON c.id = h.case_id"
      <> " WHERE c.org_id = ? AND c.room_status IS NOT NULL ORDER BY h.case_id, h.position",
    org_arg,
    case_history.decoder(),
  ))
  let history =
    list.fold(list.reverse(entries), dict.new(), fn(acc, h) {
      dict.upsert(acc, h.case_id, fn(es) { [entry(h), ..option.unwrap(es, [])] })
    })
  Ok(
    list.filter_map(cases, fn(c) {
      case c.room_status {
        None -> Error(Nil)
        Some(status) -> {
          let history = dict.get(history, c.id) |> result.unwrap([])
          Ok(room(
            id: c.id,
            player_id: c.player_id,
            created_at: c.created_at,
            status: room_status.to_string(status),
            priority: option.map(
              c.room_priority,
              case_row.room_priority_to_string,
            )
              |> option.unwrap(""),
            source_context: option.map(
              c.room_source_context,
              source_context.to_string,
            )
              |> option.unwrap("direct"),
            history:,
          ))
        }
      }
    }),
  )
}

/// A history entry's detail is a JSON object or plain text; only an object's `from`, `to` and `status` are
/// read, and a value that is not text is no value.
fn entry(h: case_history.Row) -> Entry {
  let detail = fn(key) {
    case h.detail_json {
      Some(text) ->
        json.parse(
          text,
          decode.optionally_at([key], None, decode.optional(decode.string)),
        )
        |> result.unwrap(None)
      None -> None
    }
  }
  Entry(
    at: h.at,
    action: h.action,
    from: detail("from"),
    to: detail("to"),
    status: detail("status"),
  )
}

fn read_decisions(
  read: Read,
  org_arg: List(sqlight.Value),
) -> Result(List(Decision), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> decision_row.columns
      <> " FROM room_decisions WHERE org_id = ? ORDER BY rowid",
    org_arg,
    decision_row.decoder(),
  ))
  use codes <- result.try(store.query(
    read,
    "SELECT "
      <> reason_row.qualified("r")
      <> " FROM room_decision_reason_codes r JOIN room_decisions d ON d.id = r.decision_id"
      <> " WHERE d.org_id = ? ORDER BY r.decision_id, r.position",
    org_arg,
    reason_row.decoder(),
  ))
  let codes =
    list.fold(list.reverse(codes), dict.new(), fn(acc, c) {
      dict.upsert(acc, c.decision_id, fn(cs) {
        [c.code, ..option.unwrap(cs, [])]
      })
    })
  Ok(
    list.map(rows, fn(d) {
      let formal =
        option.map(d.kind, decision_row.kind_to_string) == Some("formal")
      Decision(
        id: d.id,
        room_id: d.room_id,
        created_at: d.created_at,
        reason_codes: dict.get(codes, d.id) |> result.unwrap([]),
        superseded_by_id: d.superseded_by_id,
        formal:,
        draft: option.map(d.state, decision_row.state_to_string)
          == Some("draft"),
        outcome: case formal {
          True -> option.map(d.outcome, decision_outcome.to_string)
          False -> None
        },
      )
    }),
  )
}

fn read_offers(
  read: Read,
  org_arg: List(sqlight.Value),
) -> Result(List(Offer), Fail(e)) {
  use offers <- result.try(store.query(
    read,
    "SELECT "
      <> offer_row.columns
      <> " FROM recruitment_offers WHERE org_id = ? ORDER BY rowid",
    org_arg,
    offer_row.decoder(),
  ))
  use revisions <- result.try(store.query(
    read,
    "SELECT "
      <> revision_row.qualified("v")
      <> " FROM offer_revisions v JOIN recruitment_offers o ON o.id = v.offer_id"
      <> " WHERE o.org_id = ? ORDER BY v.offer_id, v.position",
    org_arg,
    revision_row.decoder(),
  ))
  let by_offer =
    list.fold(list.reverse(revisions), dict.new(), fn(acc, v) {
      dict.upsert(acc, v.offer_id, fn(vs) {
        [
          Revision(
            status: offer_status.to_string(v.status),
            issued_at: v.issued_at,
            responded_at: v.responded_at,
          ),
          ..option.unwrap(vs, [])
        ]
      })
    })
  Ok(
    list.map(offers, fn(o) {
      Offer(
        case_id: o.case_id,
        revisions: dict.get(by_offer, o.id) |> result.unwrap([]),
      )
    }),
  )
}

/// The players of this organisation's Rooms that it may see now (visible and not blocked), with their names.
fn read_visible(
  read: Read,
  org: Org,
  now: Int,
) -> Result(Dict(id.PlayerId, String), Fail(e)) {
  let can_see = visibility.can_see_sql(org, now)
  let where =
    sql.concat([
      sql.text(
        "p.id IN (SELECT player_id FROM recruitment_cases WHERE room_status IS NOT NULL AND org_id = ",
      ),
      sql.arg(id.org_sql(org.id)),
      sql.text(") AND "),
      can_see,
    ])
  store.query(
    read,
    "SELECT p.id, p.name FROM players p WHERE " <> where.sql,
    where.args,
    {
      use player <- decode.field(0, id.player_decoder())
      use name <- decode.field(1, decode.string)
      decode.success(#(player, name))
    },
  )
  |> result.map(dict.from_list)
}
