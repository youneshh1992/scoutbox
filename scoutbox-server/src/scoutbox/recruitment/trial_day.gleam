//// The trial day of an accepted trial (domains/recruitment/trialDay.mjs) and a club's own trials
//// (domains/recruitment/clubTrials.mjs): the named staff and their background checks, the arrival details, the
//// day's cancellation or postponement, check-in, event consent, the family's emergency contact and safety pack, the
//// family's list of their trials, the calendar export, the mandatory report, and the club's page of trial records.
////
//// The day is part of the trial record: a postponement moves the trial's date and report deadline, and a check-in
//// records the session's attendance.
////
//// Trust & Safety reviews each filed staff check (`/admin/staff-checks`): nothing is approved automatically.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_pings
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/platform/zones
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/trial_attendance as attendance_row
import scoutbox/rows/trial_day_consents as consent_row
import scoutbox/rows/trial_day_staff as staff_row
import scoutbox/rows/trial_day_status_events as status_event_row
import scoutbox/rows/trial_keys as key_row
import scoutbox/rows/trial_reports as report_row
import scoutbox/rows/trials as trial_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/party
import scoutbox/vocab/trial_actor_kind
import scoutbox/vocab/trial_workflow_state
import sqlight
import wisp.{type Request, type Response}

// --------------------------------------------------------------------------------------------------- helpers

fn read(ctx: Ctx, f: fn(Read) -> Result(a, Fail(e)), next: fn(a) -> Response) {
  case store.read(ctx.store, f) {
    Ok(a) -> next(a)
    Error(e) -> http.internal(e)
  }
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

/// The organisation's own trial. A trial whose subject removed their account can still be read (the record is the
/// club's), but nothing new is written about a person who left.
fn own_trial(
  ctx: Ctx,
  a: OrgAccess,
  tid: String,
  writing: Bool,
  next: fn(Trial) -> Response,
) -> Response {
  use found <- read(ctx, trials.by_id(_, id.trial(tid)))
  case found {
    Some(t) if t.row.org_id == a.org.id ->
      case writing, t.row.subject_removed_at {
        True, Some(_) ->
          http.error_message(
            409,
            "TRIAL_SUBJECT_REMOVED",
            "This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.",
          )
        _, _ -> next(t)
      }
    _ -> http.error(404, "TRIAL_NOT_FOUND")
  }
}

fn filled(s: Option(String)) -> Option(String) {
  input.filled(s)
}

fn text(max: Int) -> input.Rule(Option(String)) {
  input.nullish(input.text(max))
}

// ---------------------------------------------------------------------------------------------- staff checks

/// A stored check expiry (a day valid through that day, or an instant) as the first instant it no longer holds;
/// `None` when unreadable.
fn check_expiry(stored: String) -> Option(Int) {
  case temporal.parse_day(stored), temporal.instant_ms(stored) {
    Ok(day), _ -> Some(temporal.day_end(day))
    _, Ok(ms) -> Some(ms)
    _, _ -> None
  }
}

/// A reviewed check whose expiry has passed, or cannot be read, reads `expired`. A missing expiry stays "no expiry
/// recorded".
fn check_state(s: staff_row.Row, now: Int) -> String {
  case s.check_status {
    None -> "missing"
    Some(staff_row.Reviewed) ->
      case s.check_expires_at {
        None | Some("") -> "reviewed"
        Some(stored) ->
          case check_expiry(stored) {
            Some(until) if now < until -> "reviewed"
            _ -> "expired"
          }
      }
    Some(status) -> staff_row.check_status_to_string(status)
  }
}

fn check_json(s: staff_row.Row, now: Int) -> Json {
  json.object([
    #("kind", json.nullable(s.check_kind, json.string)),
    #("ref", json.nullable(s.check_ref, json.string)),
    #("status", json.nullable(s.check_status, staff_row.check_status_to_json)),
    #("expiresAt", json.nullable(s.check_expires_at, json.string)),
    #("reviewedBy", json.nullable(s.check_reviewed_by, json.string)),
    #("reviewedAt", json.nullable(s.check_reviewed_at, json.int)),
    #("state", json.string(check_state(s, now))),
  ])
}

type ChecksQuery {
  ChecksQuery(all: Option(Bool), page: paging.Query)
}

type CheckItem {
  CheckItem(
    staff: staff_row.Row,
    trial_rowid: Int,
    org_id: id.OrgId,
    org_name: String,
  )
}

/// `GET /admin/staff-checks`: the filed checks, oldest trial first and then by place on the day; pending ones only
/// unless `?all=1`.
pub fn staff_checks(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use limit <- input.field("limit", input.optional(input.text(1000)))
    use cursor <- input.field("cursor", input.optional(input.text(100_000)))
    use all <- input.field(
      "all",
      input.optional(input.one_of([#("0", False), #("1", True)])),
    )
    input.done(ChecksQuery(all:, page: paging.Query(limit:, cursor:)))
  }
  use q <- http.query(req, shape, [])
  case paging.read(q.page, [paging.IntKind, paging.IntKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let pending = case q.all {
        Some(True) -> ""
        _ -> " AND s.check_status = 'pending'"
      }
      let #(after, args) = case page.after {
        Some([IntKey(t), IntKey(p)]) -> #(
          " AND (t.rowid > ? OR (t.rowid = ? AND s.position > ?))",
          [sqlight.int(t), sqlight.int(t), sqlight.int(p)],
        )
        _ -> #("", [])
      }
      use rows <- read(
        ctx,
        store.query(
          _,
          "SELECT "
            <> staff_row.qualified("s")
            <> ", t.rowid, t.org_id, t.org_name FROM trial_day_staff s JOIN trials t ON t.id = s.trial_id WHERE s.check_status IS NOT NULL"
            <> pending
            <> after
            <> " ORDER BY t.rowid, s.position LIMIT ?",
          list.append(args, [sqlight.int(page.limit + 1)]),
          {
            use staff <- decode.then(staff_row.decoder())
            use trial_rowid <- decode.field(staff_row.width, decode.int)
            use org_id <- decode.field(staff_row.width + 1, id.org_decoder())
            use org_name <- decode.field(staff_row.width + 2, decode.string)
            decode.success(CheckItem(staff:, trial_rowid:, org_id:, org_name:))
          },
        ),
      )
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) {
          [IntKey(r.trial_rowid), IntKey(r.staff.position)]
        })
      let now = clock.now_ms()
      pages.respond(items, next, fn(r) {
        json.object([
          #("trialId", id.trial_json(r.staff.trial_id)),
          #("orgId", id.org_json(r.org_id)),
          #("orgName", json.string(r.org_name)),
          #("staffId", id.trial_staff_json(r.staff.id)),
          #("name", json.string(r.staff.name)),
          #("role", json.string(r.staff.role)),
          #("check", check_json(r.staff, now)),
        ])
      })
    }
  }
}

/// `POST /admin/staff-checks/:trialId/:staffId`: Trust & Safety's verdict on one filed check.
pub fn review_check(
  ctx: Ctx,
  req: Request,
  tid: String,
  staff_id: String,
) -> Response {
  use found <- read(ctx, trials.by_id(_, id.trial(tid)))
  let staff =
    option.then(found, fn(t) {
      list.find(t.day.staff, fn(s) {
        id.trial_staff_to_string(s.id) == staff_id && s.check_status != None
      })
      |> option.from_result
    })
  case staff {
    None -> http.error(404, "CHECK_NOT_FOUND")
    Some(s) -> {
      let shape = {
        use status <- input.field(
          "status",
          input.required(
            input.one_of_these(staff_row.check_status_pairs, [
              staff_row.Reviewed,
              staff_row.Rejected,
            ]),
          ),
        )
        use expires <- input.field(
          "expiresAt",
          input.optional(input.due_date()),
        )
        input.done(#(status, option.flatten(expires)))
      }
      use #(status, expires) <- http.body(req, shape, [
        #("status", "STATUS_INVALID"),
      ])
      // A day is kept as the day (valid through it); an instant as its ISO text.
      let expires_at = case expires {
        Some(temporal.OnDay(day)) -> Some(temporal.day_text(day))
        Some(temporal.AtInstant(ms)) -> Some(clock.iso(ms))
        None -> None
      }
      let now = clock.now_ms()
      let reviewed =
        staff_row.Row(
          ..s,
          check_status: Some(status),
          check_reviewed_by: Some("Trust & Safety"),
          check_reviewed_at: Some(now),
          check_expires_at: option.or(expires_at, s.check_expires_at),
        )
      let saved =
        store.unit(ctx.store, fn(tx) {
          store.run(
            tx,
            "UPDATE trial_day_staff SET check_status = ?, check_reviewed_by = ?, check_reviewed_at = ?, check_expires_at = ? WHERE trial_id = ? AND id = ? AND check_status IS NOT NULL",
            [
              sqlight.text(staff_row.check_status_to_string(status)),
              sqlight.text("Trust & Safety"),
              sqlight.int(now),
              sqlight.nullable(sqlight.text, reviewed.check_expires_at),
              id.trial_sql(s.trial_id),
              id.trial_staff_sql(s.id),
            ],
          )
        })
      case saved {
        Ok(Nil) ->
          http.json(200, json.object([#("check", check_json(reviewed, now))]))
        Error(e) -> http.internal(e)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------------ views

type Side {
  OrgSide(blocked: Bool)
  FamilySide
}

fn actor_kind(k: Option(trial_actor_kind.TrialActorKind)) -> Json {
  json.nullable(k, trial_actor_kind.to_json)
}

fn arrival_json(r: trial_row.Row) -> Json {
  case r.day_arrival_time, r.day_arrival_address, r.day_arrival_notes {
    None, None, None -> json.null()
    time, address, notes ->
      json.object([
        #("time", json.nullable(time, json.string)),
        #("address", json.nullable(address, json.string)),
        #("notes", json.nullable(notes, json.string)),
      ])
  }
}

fn collection_json(r: trial_row.Row) -> Json {
  case r.day_collection_policy {
    Some(p) -> json.object([#("policy", json.string(p))])
    None -> json.null()
  }
}

fn emergency_json(r: trial_row.Row) -> Json {
  case r.day_emergency_at {
    Some(at) ->
      json.object([
        #("name", json.nullable(r.day_emergency_name, json.string)),
        #("phone", json.nullable(r.day_emergency_phone, json.string)),
        #("setBy", json.nullable(r.day_emergency_set_by, party.to_json)),
        #("at", json.int(at)),
      ])
    None -> json.null()
  }
}

fn staff_view(t: Trial, now: Int) -> Json {
  json.array(t.day.staff, fn(s) {
    json.object([
      #("id", id.trial_staff_json(s.id)),
      #("name", json.string(s.name)),
      #("role", json.string(s.role)),
      #(
        "check",
        json.object([
          #("kind", json.nullable(s.check_kind, json.string)),
          #("status", json.string(check_state(s, now))),
          #("expiresAt", json.nullable(s.check_expires_at, json.string)),
        ]),
      ),
    ])
  })
}

fn checkins_json(t: Trial) -> Json {
  json.array(t.day.checkins, fn(c) {
    json.object([
      #("playerId", id.player_json(c.player_id)),
      #("at", json.int(c.at)),
      #("byUserId", json.nullable(c.by_user_id, json.string)),
      #("byName", json.nullable(c.by_name, json.string)),
    ])
  })
}

fn status_events_json(t: Trial) -> Json {
  json.array(t.day.status_events, fn(e) {
    json.object([
      #("kind", json.string(status_kind(e.kind))),
      #("at", json.int(e.at)),
      #("by", json.nullable(e.by_name, json.string)),
      #("reason", json.nullable(e.reason, json.string)),
      #("newDate", json.nullable(e.new_date, json.string)),
    ])
  })
}

fn status_kind(k: status_event_row.Kind) -> String {
  status_event_row.kind_to_string(k)
}

fn day_fields(t: Trial, side: Side, now: Int) -> List(#(String, Json)) {
  let r = t.row
  list.flatten([
    [
      #("id", id.trial_json(r.id)),
      #("playerId", id.player_json(r.player_id)),
      #("playerName", json.nullable(r.player_name, json.string)),
      #("orgId", id.org_json(r.org_id)),
      #("orgName", json.string(r.org_name)),
      #("proposedDate", json.nullable(r.proposed_date, json.string)),
      #("venue", json.nullable(r.venue, json.string)),
      #("reportDueAt", json.nullable(r.report_due_at, json.int)),
      #("staff", staff_view(t, now)),
      #("arrival", arrival_json(r)),
      #("collection", collection_json(r)),
      #(
        "consents",
        json.array(t.day.consents, fn(c) {
          json.object([
            #("id", id.trial_consent_json(c.id)),
            #("byKind", actor_kind(c.by_kind)),
            #("scope", json.string(scope_text(c.scope))),
            #("at", json.int(c.at)),
          ])
        }),
      ),
      #("checkins", checkins_json(t)),
      #("statusEvents", status_events_json(t)),
      #(
        "cancelled",
        json.bool(
          list.any(t.day.status_events, fn(e) {
            status_kind(e.kind) == "cancelled"
          }),
        ),
      ),
    ],
    case side {
      // The emergency contact is for the day's named safety staff only. A block by the player or guardian withholds
      // it, evaluated on every read.
      OrgSide(blocked) -> [
        #("emergency", case blocked {
          True -> json.null()
          False -> emergency_json(r)
        }),
        #("emergencyWithheld", case blocked {
          True -> json.string("BLOCKED")
          False -> json.null()
        }),
      ]
      FamilySide -> []
    },
  ])
}

fn scope_text(s: consent_row.Scope) -> String {
  consent_row.scope_to_string(s)
}

fn org_day(ctx: Ctx, t: Trial) -> Response {
  use blocked <- read(ctx, audit.is_blocked(_, t.row.player_id, t.row.org_id))
  http.json(
    200,
    json.object([
      #("trial", json.object(day_fields(t, OrgSide(blocked), clock.now_ms()))),
    ]),
  )
}

/// `GET /org/trials/:id/day`.
pub fn day(ctx: Ctx, a: OrgAccess, tid: String) -> Response {
  use t <- own_trial(ctx, a, tid, False)
  org_day(ctx, t)
}

// ------------------------------------------------------------------------------------------------ org writes

type StaffBody {
  StaffBody(
    name: Option(String),
    role: Option(String),
    check: Option(CheckBody),
  )
}

type CheckBody {
  CheckBody(
    kind: Option(String),
    ref: Option(String),
    expires_at: Option(temporal.Due),
  )
}

fn check_shape() -> input.Shape(CheckBody) {
  use kind <- input.field("kind", text(60))
  use ref <- input.field("ref", text(60))
  use expires_at <- input.field(
    "expiresAt",
    input.optional(input.due_date()) |> flatten_due,
  )
  input.done(CheckBody(kind:, ref:, expires_at:))
}

fn flatten_due(
  rule: input.Rule(Option(Option(temporal.Due))),
) -> input.Rule(Option(temporal.Due)) {
  fn(v) { rule(v) |> result.map(option.flatten) }
}

/// `POST /org/trials/:id/staff`. A reference on file is not a completed check: it is pending until Trust & Safety
/// reviews it.
pub fn add_staff(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  tid: String,
) -> Response {
  use t <- own_trial(ctx, a, tid, True)
  let shape = {
    use name <- input.field("name", text(80))
    use role <- input.field("role", text(60))
    use check <- input.field(
      "check",
      input.nullish(input.object(check_shape())),
    )
    input.done(StaffBody(name:, role:, check:))
  }
  use b <- http.body(req, shape, [])
  case filled(b.name), filled(b.role) {
    Some(name), Some(role) -> {
      let now = clock.now_ms()
      let check =
        option.map(b.check, fn(c) {
          #(
            option.unwrap(filled(c.kind), "DBS (England & Wales)"),
            filled(c.ref),
            option.map(c.expires_at, fn(d) {
              case d {
                temporal.OnDay(day) -> temporal.day_text(day)
                temporal.AtInstant(ms) -> clock.iso(ms)
              }
            }),
          )
        })
      store.unit(ctx.store, fn(tx) {
        use #(_, staff_id) <- result.map(
          trials.add_staff(
            tx,
            t,
            trials.NewStaff(
              name:,
              role:,
              check:,
              added_by: a.user.name,
              added_at: now,
            ),
          )
          |> storage,
        )
        http.json(
          201,
          json.object([
            #(
              "staff",
              json.object([
                #("id", id.trial_staff_json(staff_id)),
                #("name", json.string(name)),
                #("role", json.string(role)),
                #("check", case check {
                  Some(#(kind, ref, expires)) ->
                    json.object([
                      #("kind", json.string(kind)),
                      #("ref", json.nullable(ref, json.string)),
                      #("status", json.string("pending")),
                      #("expiresAt", json.nullable(expires, json.string)),
                      #("reviewedBy", json.null()),
                    ])
                  None -> json.null()
                }),
                #("addedBy", json.string(a.user.name)),
                #("addedAt", json.int(now)),
              ]),
            ),
            #(
              "note",
              json.string(
                "The check is PENDING until Trust & Safety reviews it — an uploaded reference is not a completed background check.",
              ),
            ),
          ]),
        )
      })
      |> room_routes.answer
    }
    _, _ -> http.error(400, "NAME_AND_ROLE_REQUIRED")
  }
}

type ArrivalBody {
  ArrivalBody(
    time: Option(String),
    address: Option(String),
    notes: Option(String),
    collection: Option(String),
  )
}

fn notify_parties(
  tx: Tx,
  t: Trial,
  text: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use p <- result.try(players.by_id(store.reading(tx), t.row.player_id))
  case p {
    None -> Ok(Nil)
    Some(p) -> {
      let notice = fn(to, who) {
        notifications.notify(
          tx,
          to:,
          id: who,
          type_: "trial_day",
          text:,
          ref_id: Some(id.trial_to_string(t.row.id)),
          at: now,
        )
      }
      use _ <- result.try(case players.is_adult(p, now), p.row.guardian_id {
        False, Some(g) -> notice(audience.Guardian, id.guardian_to_string(g))
        _, _ -> Ok(Nil)
      })
      notice(audience.Player, id.player_to_string(p.row.id))
    }
  }
}

/// `POST /org/trials/:id/arrival`.
pub fn set_arrival(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  tid: String,
) -> Response {
  use t <- own_trial(ctx, a, tid, True)
  let shape = {
    use time <- input.field("time", text(40))
    use address <- input.field("address", text(200))
    use notes <- input.field("notes", text(300))
    use collection <- input.field("collection", text(300))
    input.done(ArrivalBody(time:, address:, notes:, collection:))
  }
  use b <- http.body(req, shape, [])
  let empty = fn(s: Option(String)) {
    case s {
      Some("") -> None
      x -> x
    }
  }
  let moderated = fn(next) {
    case empty(b.notes) {
      Some(n) ->
        moderate.or_refuse(
          ctx,
          n,
          audit.Context(
            kind: "trial_arrival",
            player_id: Some(t.row.player_id),
            org_id: Some(a.org.id),
            user_id: None,
            channel_id: None,
            request_id: None,
          ),
          next,
        )
      None -> next()
    }
  }
  use <- moderated
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use fresh <- result.try(
      trials.set_arrival(
        tx,
        t,
        empty(b.time),
        empty(b.address),
        empty(b.notes),
        empty(b.collection),
      )
      |> storage,
    )
    use _ <- result.try(
      notify_parties(
        tx,
        fresh,
        "📍 "
          <> fresh.row.org_name
          <> " published arrival details for the trial on "
          <> option.unwrap(fresh.row.proposed_date, "TBC")
          <> ".",
        now,
      )
      |> storage,
    )
    use blocked <- result.map(
      audit.is_blocked(store.reading(tx), t.row.player_id, t.row.org_id)
      |> storage,
    )
    http.json(
      200,
      json.object([
        #("trial", json.object(day_fields(fresh, OrgSide(blocked), now))),
      ]),
    )
  })
  |> room_routes.answer
}

type DayStatusBody {
  DayStatusBody(reason: Option(String), new_date: Option(String))
}

/// `POST /org/trials/:id/cancel`, `POST /org/trials/:id/postpone`: the day's status. The report deadline is
/// re-derived from the new day by the shared derivation.
pub fn day_status(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  tid: String,
  postponed: Bool,
) -> Response {
  use t <- own_trial(ctx, a, tid, True)
  let shape = case postponed {
    True -> {
      use reason <- input.field("reason", text(200))
      use new_date <- input.field(
        "newDate",
        input.nullish(input.text(1_000_000)),
      )
      input.done(DayStatusBody(reason:, new_date:))
    }
    False -> {
      use reason <- input.field("reason", text(200))
      input.done(DayStatusBody(reason:, new_date: None))
    }
  }
  use b <- http.body(req, shape, [#("newDate", "TRIAL_DATE_INVALID")])
  case filled(b.reason) {
    None ->
      http.json(
        400,
        json.object([
          #("error", json.string("REASON_REQUIRED")),
          #("field", json.string("reason")),
          #("problem", json.string("required")),
        ]),
      )
    Some(reason) -> {
      let moved = case postponed, b.new_date {
        False, _ -> Ok(None)
        True, None | True, Some("") -> Ok(None)
        True, Some(d) ->
          trial_rules.trial_date(d)
          |> result.map(Some)
      }
      case moved {
        Error(why) ->
          http.json(
            400,
            json.object([
              #("ok", json.bool(False)),
              #("error", json.string("TRIAL_DATE_INVALID")),
              #("message", json.string(trial_rules.trial_date_message(why))),
              #("expected", json.string("YYYY-MM-DD")),
              #("field", json.string("newDate")),
            ]),
          )
        Ok(new_day) -> {
          let now = clock.now_ms()
          let kind = case postponed {
            True -> status_event_row.Postponed
            False -> status_event_row.Cancelled
          }
          store.unit(ctx.store, fn(tx) {
            use fresh <- result.try(
              trials.record_day_status(
                tx,
                t,
                kind,
                now,
                a.user.name,
                reason,
                option.map(new_day, temporal.day_text),
              )
              |> storage,
            )
            use _ <- result.try(
              notify_parties(
                tx,
                fresh,
                case postponed {
                  False ->
                    "❌ "
                    <> fresh.row.org_name
                    <> " cancelled this trial day: "
                    <> reason
                  True ->
                    "📅 "
                    <> fresh.row.org_name
                    <> " moved the trial to "
                    <> option.unwrap(b.new_date, "a new date TBC")
                    <> ": "
                    <> reason
                },
                now,
              )
              |> storage,
            )
            use blocked <- result.map(
              audit.is_blocked(store.reading(tx), t.row.player_id, t.row.org_id)
              |> storage,
            )
            http.json(
              200,
              json.object([
                #(
                  "trial",
                  json.object(day_fields(fresh, OrgSide(blocked), now)),
                ),
              ]),
            )
          })
          |> room_routes.answer
        }
      }
    }
  }
}

/// `POST /org/trials/:id/checkin`: needs a reviewed, unexpired check on at least one named staff member and the
/// right consent. The session live at this moment (from two hours before its start) gets one append-only
/// `attended` record with source `checkin`.
pub fn check_in(ctx: Ctx, a: OrgAccess, tid: String) -> Response {
  use t <- own_trial(ctx, a, tid, True)
  let now = clock.now_ms()
  let cancelled =
    list.any(t.day.status_events, fn(e) { status_kind(e.kind) == "cancelled" })
  let staffed =
    list.any(t.day.staff, fn(s) { check_state(s, now) == "reviewed" })
  case cancelled, staffed {
    True, _ -> http.error(409, "TRIAL_CANCELLED")
    _, False ->
      http.error_message(
        409,
        "STAFF_CHECK_REQUIRED",
        "At least one named staff member needs a REVIEWED, unexpired background check before anyone checks in.",
      )
    _, True -> {
      use p <- read(ctx, players.by_id(_, t.row.player_id))
      let minor = case p {
        Some(p) -> !players.is_adult(p, now)
        None -> False
      }
      let scope = case minor {
        True -> "guardian_event_consent"
        False -> "player_event_consent"
      }
      case
        list.any(t.day.consents, fn(c) { scope_text(c.scope) == scope }),
        list.any(t.day.checkins, fn(c) { c.player_id == t.row.player_id })
      {
        False, _ ->
          http.json(
            409,
            json.object([
              #("error", json.string("CONSENT_REQUIRED")),
              #("scope", json.string(scope)),
              #(
                "message",
                json.string(case minor {
                  True ->
                    "The guardian has not given event consent for this trial day."
                  False ->
                    "The player has not given event consent for this trial day."
                }),
              ),
            ]),
          )
        _, True -> http.error(409, "ALREADY_CHECKED_IN")
        True, False -> checked_in(ctx, a, t, p, now)
      }
    }
  }
}

fn checked_in(
  ctx: Ctx,
  a: OrgAccess,
  t: Trial,
  p: Option(players.Player),
  now: Int,
) -> Response {
  let live = case t.row.schedule_confirmed_at {
    Some(_) ->
      list.find(t.sessions, fn(s) {
        s.row.starts_at - 2 * 3_600_000 <= now && now <= s.row.ends_at
      })
      |> option.from_result
    None -> None
  }
  let attends = case live {
    Some(s) ->
      case
        list.any(t.attendance, fn(x) {
          x.session_id == s.row.id && x.state == attendance_row.Attended
        })
      {
        True -> None
        False -> Some(s)
      }
    None -> None
  }
  store.unit(ctx.store, fn(tx) {
    use attended <- result.try(case attends {
      None -> Ok(None)
      Some(s) -> {
        use e <- result.map(
          trials.entry(
            tx,
            "trial_attendance_recorded",
            trials.Staff(a.user.id, a.user.name),
            [
              #("sessionId", id.trial_session_json(s.row.id)),
              #("state", json.string("attended")),
              #("source", json.string("checkin")),
            ],
            now,
          )
          |> storage,
        )
        Some(#(
          s.row.id,
          trials.Acted(
            at: now,
            rev_by: Some(#(a.user.id, a.user.name)),
            history: [e],
            key: None,
          ),
        ))
      }
    })
    use fresh <- result.try(
      trials.check_in(tx, t, now, a.user.id, a.user.name, attended) |> storage,
    )
    // Feed the existing attendance record once.
    use _ <- result.try(case p {
      Some(p) ->
        case list.any(p.attendance, fn(x) { x.trial_id == Some(t.row.id) }) {
          True -> Ok(Nil)
          False -> {
            use _ <- result.try(
              players.add_trial_attendance(
                tx,
                p.row.id,
                t.row.id,
                "Trial day · " <> t.row.org_name,
                option.unwrap(t.row.venue, ""),
                option.unwrap(t.row.proposed_date, clock.iso_day(now)),
                t.row.org_name,
              )
              |> storage,
            )
            activity.record(tx, p.row.id, now)
            |> result.replace(Nil)
            |> storage
          }
        }
      None -> Ok(Nil)
    })
    use _ <- result.try(
      ledger.append(
        tx,
        ledger.Entry(
          event: ledger.Plain(ledger_row.TrialCheckin),
          player_id: Some(t.row.player_id),
          org_id: Some(a.org.id),
          org_name: Some(a.org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      )
      |> storage,
    )
    use blocked <- result.map(
      audit.is_blocked(store.reading(tx), t.row.player_id, t.row.org_id)
      |> storage,
    )
    http.json(
      200,
      json.object([
        #("trial", json.object(day_fields(fresh, OrgSide(blocked), now))),
      ]),
    )
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------- family routes

/// Who is reading or acting: the player themself, or a guardian for their children.
pub type Family {
  PlayerFamily(p: PlayerAccess)
  GuardianFamily(g: Guardian)
}

fn family_players(f: Family) -> List(id.PlayerId) {
  case f {
    PlayerFamily(p) -> [p.player.row.id]
    GuardianFamily(g) -> g.child_ids
  }
}

fn family_trial(
  ctx: Ctx,
  f: Family,
  tid: String,
  next: fn(Trial) -> Response,
) -> Response {
  use found <- read(ctx, trials.by_id(_, id.trial(tid)))
  case found {
    Some(t) ->
      case list.contains(family_players(f), t.row.player_id) {
        True -> next(t)
        False -> http.error(404, "TRIAL_NOT_FOUND")
      }
    None -> http.error(404, "TRIAL_NOT_FOUND")
  }
}

/// `GET /player/trials`, `GET /guardian/trials`. A minor's own device gets the outcome line only, never the
/// sessions, address, instructions or history the guardian holds.
pub fn list_for(ctx: Ctx, f: Family) -> Response {
  let minor_device = case f {
    PlayerFamily(p) -> p.minor
    GuardianFamily(_) -> False
  }
  use found <- read(ctx, trials.for_players(_, family_players(f)))
  let now = clock.now_ms()
  http.json(
    200,
    json.array(found, fn(t) {
      json.object(
        list.append(day_fields(t, FamilySide, now), [
          #("workflow", case minor_device {
            True -> trial_rules.outcome_line(t)
            False -> trial_rules.family_view(t)
          }),
        ]),
      )
    }),
  )
}

/// `GET /player/trials/:id/safety-pack`, `GET /guardian/trials/:id/safety-pack`.
pub fn safety_pack(ctx: Ctx, f: Family, tid: String) -> Response {
  use t <- family_trial(ctx, f, tid)
  let now = clock.now_ms()
  let for_guardian = case f {
    GuardianFamily(_) -> True
    PlayerFamily(_) -> False
  }
  http.json(
    200,
    json.object([
      #("trial", json.object(day_fields(t, FamilySide, now))),
      #(
        "pack",
        json.object([
          #("staff", staff_view(t, now)),
          #(
            "headline",
            json.string(
              "Who will be there, what has been checked, and what to do if something feels wrong.",
            ),
          ),
          #(
            "checksExplained",
            json.string(
              "A \"reviewed\" check means Trust & Safety examined the club’s filed reference for that person. \"Pending\" means it has NOT been examined yet. We show you the truth rather than a badge.",
            ),
          ),
          #("arrival", arrival_json(t.row)),
          #("collection", case for_guardian {
            True -> collection_json(t.row)
            False -> json.null()
          }),
          #("emergencySet", json.bool(t.row.day_emergency_at != None)),
          #(
            "reportRoute",
            json.string(
              "Anything concerning: use ⚑ Report in the app — urgent reports suspend club communication immediately.",
            ),
          ),
          #(
            "feedbackDue",
            json.nullable(
              option.map(t.row.report_due_at, clock.iso_day),
              json.string,
            ),
          ),
        ]),
      ),
    ]),
  )
}

/// `POST /player/trials/:id/consent`, `POST /guardian/trials/:id/consent`. Event consent for an under-18 comes
/// from the guardian.
pub fn consent(ctx: Ctx, f: Family, tid: String) -> Response {
  case f {
    PlayerFamily(p) if p.minor ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Event consent for under-18s comes from the guardian.",
      )
    _ -> {
      use t <- family_trial(ctx, f, tid)
      let #(by, scope) = case f {
        PlayerFamily(p) -> #(
          trials.Family(
            party.Player,
            id.player_to_string(p.player.row.id),
            Some(p.player.row.name),
          ),
          "player_event_consent",
        )
        GuardianFamily(g) -> #(
          trials.Family(
            party.Guardian,
            id.guardian_to_string(g.row.id),
            Some(g.row.name),
          ),
          "guardian_event_consent",
        )
      }
      let by_id = case by {
        trials.Family(_, who, _) -> Some(who)
        _ -> None
      }
      case
        list.any(t.day.consents, fn(c) {
          scope_text(c.scope) == scope && c.by_actor_id == by_id
        })
      {
        True -> http.error(409, "ALREADY_CONSENTED")
        False ->
          store.unit(ctx.store, fn(tx) {
            use _ <- result.map(
              trials.give_consent(tx, t, by, scope, clock.now_ms()) |> storage,
            )
            http.json(201, json.object([#("consented", json.string(scope))]))
          })
          |> room_routes.answer
      }
    }
  }
}

type EmergencyBody {
  EmergencyBody(name: Option(String), phone: Option(String))
}

/// `POST /player/trials/:id/emergency-contact`, `POST /guardian/trials/:id/emergency-contact`: held for this
/// event's safety staff only; never in profiles, search or exports.
pub fn emergency(ctx: Ctx, req: Request, f: Family, tid: String) -> Response {
  case f {
    PlayerFamily(p) if p.minor -> http.error(403, "GUARDIAN_MANAGED")
    _ -> {
      use t <- family_trial(ctx, f, tid)
      let shape = {
        use name <- input.field("name", text(80))
        use phone <- input.field("phone", text(30))
        input.done(EmergencyBody(name:, phone:))
      }
      use b <- http.body(req, shape, [])
      case filled(b.name), filled(b.phone) {
        Some(name), Some(phone) -> {
          let set_by = case f {
            PlayerFamily(_) -> party.Player
            GuardianFamily(_) -> party.Guardian
          }
          store.unit(ctx.store, fn(tx) {
            use _ <- result.map(
              trials.set_emergency(tx, t, name, phone, set_by, clock.now_ms())
              |> storage,
            )
            http.json(
              200,
              json.object([
                #("ok", json.bool(True)),
                #(
                  "note",
                  json.string("Held for this event’s safety staff only."),
                ),
              ]),
            )
          })
          |> room_routes.answer
        }
        _, _ -> http.error(400, "NAME_AND_PHONE_REQUIRED")
      }
    }
  }
}

// ---------------------------------------------------------------------------------------- the calendar export

fn iso_stamp(ms: Int) -> String {
  clock.iso(ms)
  |> string.replace("-", "")
  |> string.replace(":", "")
  |> fn(s) {
    case string.split(s, ".") {
      [head, tail] -> head <> string.drop_start(tail, 3)
      _ -> s
    }
  }
}

fn ics_response(lines: List(String)) -> Response {
  wisp.response(200)
  |> wisp.set_header("content-type", "text/calendar; charset=utf-8")
  |> wisp.string_body(string.join(lines, "\r\n"))
}

/// `GET /org/trials/:id/ics`. A scheduled trial exports each session of the current revision as its own timed event
/// in the organiser's zone; a cancelled trial exports its sessions as CANCELLED rather than vanishing from a
/// calendar that already holds them; an unconfirmed revision is TENTATIVE. Without a schedule the export is the
/// accepted day as an all-day event, and a stored date that is not a calendar day is refused as what it is.
pub fn ics(ctx: Ctx, a: OrgAccess, tid: String) -> Response {
  use t <- own_trial(ctx, a, tid, False)
  let r = t.row
  let deadline = case r.report_due_at {
    Some(due) ->
      " Mandatory performance report due " <> clock.iso_day(due) <> "."
    None -> ""
  }
  let player_name = option.unwrap(r.player_name, "removed player")
  case trial_rules.has_schedule(t), t.sessions, r.schedule_timezone {
    True, [_, ..], Some(tz) -> {
      let cancelled = r.completion_state == Some(trial_row.Cancelled)
      let status = case cancelled, r.schedule_confirmed_at {
        True, _ -> "CANCELLED"
        False, Some(_) -> "CONFIRMED"
        False, None -> "TENTATIVE"
      }
      let stamp =
        option.unwrap(
          option.or(r.schedule_confirmed_at, r.schedule_proposed_at),
          r.accepted_at,
        )
        |> iso_stamp
      let events =
        t.sessions
        |> list.sort(fn(x, y) {
          case int.compare(x.row.starts_at, y.row.starts_at) {
            order.Eq ->
              string.compare(
                id.trial_session_to_string(x.row.id),
                id.trial_session_to_string(y.row.id),
              )
            other -> other
          }
        })
        |> list.flat_map(fn(s) {
          let where = case s.row.venue_name {
            Some(name) ->
              Some(
                [Some(name), s.row.venue_address, s.row.venue_town]
                |> option.values
                |> list.filter(fn(x) { x != "" })
                |> string.join(", "),
              )
            None -> r.venue
          }
          let description =
            case s.row.instructions, r.notes {
              Some(i), _ if i != "" -> i
              _, Some(n) if n != "" -> n
              _, _ -> "Trial session"
            }
            <> "."
            <> deadline
          option.values([
            Some("BEGIN:VEVENT"),
            Some(
              "UID:"
              <> id.trial_to_string(r.id)
              <> "-"
              <> id.trial_session_to_string(s.row.id)
              <> "@scoutbox",
            ),
            Some("DTSTAMP:" <> stamp),
            Some(
              "DTSTART;TZID="
              <> tz
              <> ":"
              <> trial_rules.ics_local(s.row.starts_at, zones.stored(tz)),
            ),
            Some(
              "DTEND;TZID="
              <> tz
              <> ":"
              <> trial_rules.ics_local(s.row.ends_at, zones.stored(tz)),
            ),
            Some(
              "SEQUENCE:"
              <> int.to_string(case option.unwrap(r.schedule_revision, 0) {
                0 -> 1
                n -> n
              }),
            ),
            Some("STATUS:" <> status),
            Some(
              "SUMMARY:"
              <> trial_rules.ics_text(
                "ScoutBox trial ("
                <> trial_rules.session_kind_text(s.row.kind)
                <> ") — "
                <> player_name
                <> case cancelled {
                  True -> " — CANCELLED"
                  False -> ""
                },
              ),
            ),
            Some("DESCRIPTION:" <> trial_rules.ics_text(description)),
            option.map(where, fn(w) { "LOCATION:" <> trial_rules.ics_text(w) }),
            Some("END:VEVENT"),
          ])
        })
      ics_response(
        list.flatten([
          ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ScoutBox//Trials//EN"],
          events,
          ["END:VCALENDAR"],
        ]),
      )
    }
    _, _, _ -> {
      let day = case r.proposed_date {
        None | Some("") -> Ok(None)
        Some(d) -> trial_rules.trial_date(d) |> result.map(Some)
      }
      case day {
        Error(_) ->
          http.json(
            422,
            json.object([
              #("error", json.string("TRIAL_DATE_INVALID")),
              #(
                "message",
                json.string(
                  "This trial was recorded with a date that is not a calendar day; postpone it to a valid day to export it.",
                ),
              ),
              #("expected", json.string("YYYY-MM-DD")),
            ]),
          )
        Ok(day) -> {
          let start_at = case day {
            Some(day) -> temporal.day_start(day)
            None -> r.accepted_at
          }
          let start = clock.iso_day(start_at) |> string.replace("-", "")
          ics_response(
            option.values([
              Some("BEGIN:VCALENDAR"),
              Some("VERSION:2.0"),
              Some("PRODID:-//ScoutBox//Trials//EN"),
              Some("BEGIN:VEVENT"),
              Some("UID:" <> id.trial_to_string(r.id) <> "@scoutbox"),
              Some("DTSTART;VALUE=DATE:" <> start),
              Some(
                "SUMMARY:"
                <> trial_rules.ics_text("ScoutBox trial — " <> player_name),
              ),
              Some(
                "DESCRIPTION:"
                <> trial_rules.ics_text(case r.notes {
                  Some(n) if n != "" -> n
                  _ -> "Assessment trial"
                })
                <> "."
                <> deadline,
              ),
              option.map(r.venue, fn(v) {
                "LOCATION:" <> trial_rules.ics_text(v)
              }),
              Some("END:VEVENT"),
              Some("END:VCALENDAR"),
            ]),
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- the report

pub const report_fields = [
  "acceleration", "sprintSpeedKmh", "distanceKm", "passCompletionPct",
  "duelSuccessPct", "coachRating",
]

type ReportBody {
  ReportBody(
    values: List(#(String, Option(Dynamic))),
    notes: Option(String),
    strength_note: Option(String),
    focus_note: Option(String),
  )
}

fn report_shape() -> input.Shape(ReportBody) {
  let one = fn(name, values, next) {
    use v <- input.field(name, input.optional(input.anything()))
    next([#(name, v), ..values])
  }
  use v <- one("acceleration", [])
  use v <- one("sprintSpeedKmh", v)
  use v <- one("distanceKm", v)
  use v <- one("passCompletionPct", v)
  use v <- one("duelSuccessPct", v)
  use v <- one("coachRating", v)
  use notes <- input.field("notes", text(2000))
  use strength_note <- input.field("strengthNote", text(500))
  use focus_note <- input.field("focusNote", text(500))
  input.done(ReportBody(
    values: list.reverse(v),
    notes:,
    strength_note:,
    focus_note:,
  ))
}

/// validateTrialReport: each measured field present and a number.
fn measured(
  b: ReportBody,
) -> Result(List(#(String, Float)), #(List(String), List(String))) {
  let #(found, missing, invalid) =
    list.fold(b.values, #([], [], []), fn(acc, pair) {
      let #(found, missing, invalid) = acc
      let #(name, v) = pair
      case v {
        None -> #(found, [name, ..missing], invalid)
        Some(d) ->
          case dynamic.classify(d), decode.run(d, decode.string) {
            "Nil", _ -> #(found, [name, ..missing], invalid)
            _, Ok("") -> #(found, [name, ..missing], invalid)
            _, _ ->
              case decode.run(d, decode.int), decode.run(d, decode.float) {
                Ok(n), _ -> #(
                  [#(name, int.to_float(n)), ..found],
                  missing,
                  invalid,
                )
                _, Ok(f) -> #([#(name, f), ..found], missing, invalid)
                _, _ -> #(found, missing, [name, ..invalid])
              }
          }
      }
    })
  case missing, invalid {
    [], [] -> Ok(list.reverse(found))
    _, _ -> Error(#(list.reverse(missing), list.reverse(invalid)))
  }
}

/// `POST /org/trials/:id/report`: mandatory, complete or rejected. It closes the club's obligation even while the
/// family has blocked the club, but the block stands: no notification reaches the player or guardian.
pub fn report(ctx: Ctx, req: Request, a: OrgAccess, tid: String) -> Response {
  use t <- own_trial(ctx, a, tid, False)
  use player <- read(ctx, players.by_id(_, t.row.player_id))
  case t.row.status, t.row.subject_removed_at, player {
    trial_row.Reported, _, _ -> http.error(409, "ALREADY_REPORTED")
    _, Some(_), _ | _, _, None ->
      http.error_message(
        409,
        "TRIAL_SUBJECT_REMOVED",
        "This player removed their ScoutBox account. The trial stays on record; no report can be filed for it.",
      )
    _, None, Some(p) -> {
      use b <- http.body(req, report_shape(), [])
      case measured(b) {
        Error(#(missing, invalid)) ->
          http.json(
            400,
            json.object([
              #("error", json.string("REPORT_INCOMPLETE")),
              #(
                "message",
                json.string(
                  "Trial performance reports are mandatory and must be complete. Partial reports are rejected.",
                ),
              ),
              #("requiredFields", json.array(report_fields, json.string)),
              #("missing", json.array(missing, json.string)),
              #("invalid", json.array(invalid, json.string)),
            ]),
          )
        Ok(values) -> {
          let feedback = fn(text: Option(String), next) {
            case text {
              Some(t) if t != "" ->
                moderate.or_refuse(
                  ctx,
                  t,
                  audit.Context(
                    kind: "trial_feedback",
                    player_id: None,
                    org_id: Some(a.org.id),
                    user_id: None,
                    channel_id: None,
                    request_id: None,
                  ),
                  next,
                )
              _ -> next()
            }
          }
          use <- feedback(b.strength_note)
          use <- feedback(b.focus_note)
          file(ctx, a, t, p, values, b)
        }
      }
    }
  }
}

fn value_of(values: List(#(String, Float)), name: String) -> Float {
  list.key_find(values, name) |> result.unwrap(0.0)
}

fn nonempty(s: Option(String)) -> Option(String) {
  case s {
    Some("") -> None
    x -> x
  }
}

fn file(
  ctx: Ctx,
  a: OrgAccess,
  t: Trial,
  p: players.Player,
  values: List(#(String, Float)),
  b: ReportBody,
) -> Response {
  let now = clock.now_ms()
  let trust = players.profile_signal(p)
  store.unit(ctx.store, fn(tx) {
    use report_id <- result.try(id.next_trial_report(tx) |> storage)
    let r =
      report_row.Row(
        trial_id: t.row.id,
        id: report_id,
        player_id: t.row.player_id,
        org_id: a.org.id,
        org_name: Some(a.org.name),
        user_id: Some(a.user.id),
        scout_name: Some(a.user.name),
        filed_at: now,
        acceleration: value_of(values, "acceleration"),
        sprint_speed_kmh: value_of(values, "sprintSpeedKmh"),
        distance_km: value_of(values, "distanceKm"),
        pass_completion_pct: value_of(values, "passCompletionPct"),
        duel_success_pct: value_of(values, "duelSuccessPct"),
        coach_rating: value_of(values, "coachRating"),
        notes: Some(option.unwrap(nonempty(b.notes), "")),
        strength_note: nonempty(b.strength_note),
        focus_note: nonempty(b.focus_note),
      )
    use _ <- result.try(trials.file_report(tx, t, r) |> storage)
    use _ <- result.try(players.refresh_signal(tx, p.row.id) |> storage)
    use _ <- result.try(
      ledger.append(
        tx,
        ledger.Entry(
          event: ledger.Plain(ledger_row.TrialReport),
          player_id: Some(p.row.id),
          org_id: Some(a.org.id),
          org_name: Some(a.org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      )
      |> storage,
    )
    use blocked <- result.try(
      audit.is_blocked(store.reading(tx), p.row.id, a.org.id) |> storage,
    )
    use _ <- result.map(case blocked {
      True -> Ok(Nil)
      False -> {
        let rid = Some(id.trial_report_to_string(report_id))
        use _ <- result.try(
          notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(p.row.id),
            type_: "trial_report",
            text: a.org.name
              <> " filed your trial report"
              <> case r.strength_note {
              Some(_) -> " — with development feedback"
              None -> ""
            }
              <> ". It's on your profile.",
            ref_id: rid,
            at: now,
          )
          |> storage,
        )
        case p.row.guardian_id {
          Some(g) ->
            notifications.notify(
              tx,
              to: audience.Guardian,
              id: id.guardian_to_string(g),
              type_: "trial_report",
              text: a.org.name
                <> " filed the trial report for "
                <> p.row.name
                <> ".",
              ref_id: rid,
              at: now,
            )
            |> storage
          None -> Ok(Nil)
        }
      }
    })
    live_pings.player(tx, t.row.player_id)
    http.json(
      201,
      json.object([
        #("ok", json.bool(True)),
        #("report", players.report_json(r)),
        #("playerTrustScore", json.int(trust)),
      ]),
    )
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------- the club's page

fn actor_json(
  kind: Option(trial_actor_kind.TrialActorKind),
  user_id: Option(String),
  actor_id: Option(String),
  name: Option(String),
) -> Json {
  case kind {
    None -> json.null()
    Some(k) ->
      case user_id, actor_id, name, k {
        None, None, None, _ ->
          json.object([#("kind", trial_actor_kind.to_json(k))])
        _, _, _, trial_actor_kind.Org ->
          json.object([
            #("kind", trial_actor_kind.to_json(k)),
            #("userId", json.nullable(user_id, json.string)),
            #("name", json.nullable(name, json.string)),
          ])
        _, _, _, _ ->
          json.object([
            #("kind", trial_actor_kind.to_json(k)),
            #("id", json.nullable(actor_id, json.string)),
            #("name", json.nullable(name, json.string)),
          ])
      }
  }
}

fn venue_json(
  name: Option(String),
  town: Option(String),
  address: Option(String),
) -> Json {
  case name {
    Some(n) ->
      json.object([
        #("name", json.string(n)),
        #("town", json.nullable(town, json.string)),
        #("address", json.nullable(address, json.string)),
      ])
    None -> json.null()
  }
}

/// A trial as the repository decodes it: the record the club's page of trials serves.
pub fn record_json(t: Trial) -> Json {
  let r = t.row
  let session_out = fn(
    id_json,
    kind,
    starts,
    ends,
    vname,
    vtown,
    vaddr,
    instructions,
  ) {
    [
      #("id", id_json),
      #("kind", json.string(trial_rules.session_kind_text(kind))),
      #("startsAt", json.int(starts)),
      #("endsAt", json.int(ends)),
      #("venue", venue_json(vname, vtown, vaddr)),
      #("instructions", json.nullable(instructions, json.string)),
    ]
  }
  json.object([
    #("id", id.trial_json(r.id)),
    #("requestId", id.request_json(r.request_id)),
    #("caseId", json.nullable(r.case_id, id.recruitment_case_json)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.string(r.org_name)),
    #("scoutName", json.nullable(r.scout_name, json.string)),
    #("acceptedAt", json.int(r.accepted_at)),
    #("acceptedBy", json.nullable(r.accepted_by, party.to_json)),
    #("guardianApproved", json.nullable(r.guardian_approved, json.bool)),
    #("proposedDate", json.nullable(r.proposed_date, json.string)),
    #("venue", json.nullable(r.venue, json.string)),
    #("notes", json.nullable(r.notes, json.string)),
    #("reportDueAt", json.nullable(r.report_due_at, json.int)),
    #("status", trial_row.status_to_json(r.status)),
    #("reminderSent", json.bool(r.reminder_sent)),
    #("feedbackEscalatedAt", json.nullable(r.feedback_escalated_at, json.int)),
    #("report", json.nullable(t.report, players.report_json)),
    #(
      "day",
      json.object([
        #(
          "staff",
          json.array(t.day.staff, fn(s) {
            json.object([
              #("id", id.trial_staff_json(s.id)),
              #("name", json.string(s.name)),
              #("role", json.string(s.role)),
              #("check", case s.check_status {
                None -> json.null()
                Some(status) ->
                  json.object([
                    #("kind", json.nullable(s.check_kind, json.string)),
                    #("ref", json.nullable(s.check_ref, json.string)),
                    #("status", staff_row.check_status_to_json(status)),
                    #(
                      "expiresAt",
                      json.nullable(s.check_expires_at, json.string),
                    ),
                    #(
                      "reviewedBy",
                      json.nullable(s.check_reviewed_by, json.string),
                    ),
                    #(
                      "reviewedAt",
                      json.nullable(s.check_reviewed_at, json.int),
                    ),
                  ])
              }),
              #("addedBy", json.nullable(s.added_by_name, json.string)),
              #("addedAt", json.int(s.added_at)),
            ])
          }),
        ),
        #(
          "consents",
          json.array(t.day.consents, fn(c) {
            json.object([
              #("id", id.trial_consent_json(c.id)),
              #(
                "by",
                actor_json(c.by_kind, c.by_user_id, c.by_actor_id, c.by_name),
              ),
              #("scope", json.string(scope_text(c.scope))),
              #("at", json.int(c.at)),
            ])
          }),
        ),
        #("arrival", arrival_json(r)),
        #("emergency", emergency_json(r)),
        #("checkins", checkins_json(t)),
        #("collection", collection_json(r)),
        #("statusEvents", status_events_json(t)),
      ]),
    ),
    #("workflowState", trial_workflow_state.to_json(r.workflow_state)),
    #("schedule", case trial_rules.has_schedule(t) {
      False -> json.null()
      True ->
        json.object([
          #("timezone", json.nullable(r.schedule_timezone, json.string)),
          #("revision", json.nullable(r.schedule_revision, json.int)),
          #("proposedAt", json.nullable(r.schedule_proposed_at, json.int)),
          #(
            "proposedBy",
            actor_json(
              r.schedule_proposed_by_kind,
              r.schedule_proposed_by_user_id,
              r.schedule_proposed_by_actor_id,
              r.schedule_proposed_by_name,
            ),
          ),
          #("confirmedAt", json.nullable(r.schedule_confirmed_at, json.int)),
          #(
            "confirmedBy",
            actor_json(
              r.schedule_confirmed_by_kind,
              r.schedule_confirmed_by_user_id,
              r.schedule_confirmed_by_actor_id,
              r.schedule_confirmed_by_name,
            ),
          ),
          #("declinedAt", json.nullable(r.schedule_declined_at, json.int)),
          #(
            "declinedBy",
            actor_json(
              r.schedule_declined_by_kind,
              r.schedule_declined_by_user_id,
              r.schedule_declined_by_actor_id,
              r.schedule_declined_by_name,
            ),
          ),
          #(
            "sessions",
            json.array(t.sessions, fn(s) {
              let x = s.row
              json.object(
                list.append(
                  session_out(
                    id.trial_session_json(x.id),
                    x.kind,
                    x.starts_at,
                    x.ends_at,
                    x.venue_name,
                    x.venue_town,
                    x.venue_address,
                    x.instructions,
                  ),
                  [
                    #(
                      "evidence",
                      json.array(s.evidence, fn(e) {
                        json.object([
                          #("id", id.trial_evidence_json(e.id)),
                          #("kind", json.string("box_cam_session")),
                          #("sessionId", id.box_session_json(e.box_session_id)),
                          #("linkedAt", json.int(e.linked_at)),
                          #(
                            "linkedBy",
                            actor_json(
                              e.linked_by_kind,
                              e.linked_by_user_id,
                              e.linked_by_actor_id,
                              e.linked_by_name,
                            ),
                          ),
                          #("removedAt", json.nullable(e.removed_at, json.int)),
                          #(
                            "removedBy",
                            actor_json(
                              e.removed_by_kind,
                              e.removed_by_user_id,
                              e.removed_by_actor_id,
                              e.removed_by_name,
                            ),
                          ),
                        ])
                      }),
                    ),
                  ],
                ),
              )
            }),
          ),
          #(
            "revisions",
            json.array(t.revisions, fn(v) {
              let x = v.row
              json.object([
                #("revision", json.int(x.revision)),
                #("timezone", json.string(x.timezone)),
                #(
                  "sessions",
                  json.array(v.sessions, fn(s) {
                    json.object(session_out(
                      id.trial_session_json(s.id),
                      s.kind,
                      s.starts_at,
                      s.ends_at,
                      s.venue_name,
                      s.venue_town,
                      s.venue_address,
                      s.instructions,
                    ))
                  }),
                ),
                #("proposedAt", json.nullable(x.proposed_at, json.int)),
                #(
                  "proposedBy",
                  actor_json(
                    x.proposed_by_kind,
                    x.proposed_by_user_id,
                    x.proposed_by_actor_id,
                    x.proposed_by_name,
                  ),
                ),
                #("confirmedAt", json.nullable(x.confirmed_at, json.int)),
                #(
                  "confirmedBy",
                  actor_json(
                    x.confirmed_by_kind,
                    x.confirmed_by_user_id,
                    x.confirmed_by_actor_id,
                    x.confirmed_by_name,
                  ),
                ),
                #("supersededAt", json.nullable(x.superseded_at, json.int)),
                #("reason", json.nullable(x.reason, json.string)),
                #("material", json.nullable(x.material, json.bool)),
              ])
            }),
          ),
        ])
    }),
    #(
      "attendance",
      json.array(t.attendance, fn(x) {
        json.object([
          #("sessionId", id.trial_session_json(x.session_id)),
          #("state", attendance_row.state_to_json(x.state)),
          #("source", attendance_row.source_to_json(x.source)),
          #(
            "recordedBy",
            actor_json(
              x.recorded_by_kind,
              x.recorded_by_user_id,
              x.recorded_by_actor_id,
              x.recorded_by_name,
            ),
          ),
          #("recordedAt", json.int(x.recorded_at)),
          #("note", json.nullable(x.note, json.string)),
        ])
      }),
    ),
    #("completion", case r.completion_state, r.completion_at {
      Some(cs), Some(at) ->
        json.object([
          #("state", trial_row.completion_state_to_json(cs)),
          #("at", json.int(at)),
          #(
            "by",
            actor_json(
              r.completion_by_kind,
              r.completion_by_user_id,
              r.completion_by_actor_id,
              r.completion_by_name,
            ),
          ),
          #("reason", json.nullable(r.completion_reason, json.string)),
          #(
            "phase",
            json.nullable(r.completion_phase, trial_workflow_state.to_json),
          ),
          #(
            "cancelledBy",
            json.nullable(
              r.completion_cancelled_by,
              trial_row.completion_cancelled_by_to_json,
            ),
          ),
        ])
      _, _ -> json.null()
    }),
    #("recipient", case r.recipient_type {
      Some(rt) ->
        json.object([
          #("type", party.to_json(rt)),
          #("playerId", json.nullable(r.recipient_player_id, id.player_json)),
          #(
            "guardianId",
            json.nullable(r.recipient_guardian_id, id.guardian_json),
          ),
          #("minor", json.bool(r.recipient_minor == Some(True))),
          #("at", json.nullable(r.recipient_at, json.int)),
        ])
      None -> json.null()
    }),
    #(
      "keys",
      json.object(
        list.map(key_row.act_pairs, fn(p) {
          #(
            p.0,
            json.array(list.filter(t.keys, fn(k) { k.act == p.1 }), fn(k) {
              json.object([
                #("key", json.string(k.key)),
                #("fp", json.string(k.fp)),
                #("at", json.int(k.at)),
              ])
            }),
          )
        }),
      ),
    ),
    #(
      "history",
      json.array(t.history, fn(h) {
        json.object([
          #("id", id.trial_event_json(h.id)),
          #("at", json.int(h.at)),
          #("action", json.string(h.action)),
          #("by", actor_json(h.by_kind, h.by_user_id, h.by_actor_id, h.by_name)),
          #("detail", trial_rules.detail_json(h.detail_json)),
        ])
      }),
    ),
    #(
      "reminders",
      json.object(
        list.map(t.reminders, fn(m) { #(m.marker, json.int(m.sent_at)) }),
      ),
    ),
    #("lifecycle", case r.lifecycle_applied {
      None -> json.null()
      Some(True) ->
        json.object([
          #("applied", json.bool(True)),
          #("from", json.nullable(r.lifecycle_from, json.string)),
          #("to", json.nullable(r.lifecycle_to, json.string)),
          #("at", json.nullable(r.lifecycle_at, json.int)),
        ])
      Some(False) ->
        json.object([
          #("applied", json.bool(False)),
          #("reason", json.nullable(r.lifecycle_reason, json.string)),
          #("at", json.nullable(r.lifecycle_at, json.int)),
        ])
    }),
    #("rev", json.int(r.rev)),
    #("revAt", json.nullable(r.rev_at, json.int)),
    #("revBy", case r.rev_by_user_id, r.rev_by_name {
      None, None -> json.null()
      user, name ->
        json.object([
          #("userId", json.nullable(user, json.string)),
          #("name", json.nullable(name, json.string)),
        ])
    }),
    #("subjectRemovedAt", json.nullable(r.subject_removed_at, json.int)),
  ])
}

/// `GET /org/trials`: the organisation's trial records, newest first, by cursor.
pub fn org_page(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.lenient(req, [paging.IntKind])
  use found <- read(ctx, fn(rd) {
    let #(after, args) = case page.after {
      Some([IntKey(rid)]) -> #(" AND rowid < ?", [sqlight.int(rid)])
      _ -> #("", [])
    }
    use rows <- result.try(
      store.query(
        rd,
        "SELECT rowid, id FROM trials WHERE org_id = ?"
          <> after
          <> " ORDER BY rowid DESC LIMIT ?",
        list.flatten([
          [id.org_sql(a.org.id)],
          args,
          [sqlight.int(page.limit + 1)],
        ]),
        {
          use rid <- decode.field(0, decode.int)
          use tid <- decode.field(1, decode.string)
          decode.success(#(rid, tid))
        },
      ),
    )
    let #(items, next) =
      paging.page_of(rows, page.limit, fn(p) { [IntKey(p.0)] })
    use loaded <- result.map(
      list.try_map(items, fn(p) {
        use t <- result.map(trials.by_id(rd, id.trial(p.1)))
        let assert Some(t) = t as "a listed trial reads back"
        t
      }),
    )
    #(loaded, next)
  })
  let #(items, next) = found
  pages.respond(items, next, record_json)
}
