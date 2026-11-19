//// Dynamic Watchlists (domains/discovery/matching/index.mjs): saved criteria whose membership is derived when they
//// are read. A watchlist holds criteria, never a list of players treated as truth: reading it matches the criteria
//// again, records who entered and who left (and why, in the club's own criteria), and notifies the person who wrote
//// it once per change. There is no scheduler, so membership is correct as of the last read.

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/discovery/briefs
import scoutbox/discovery/matching/criteria.{type Criteria, Criteria}
import scoutbox/discovery/matching/engine
import scoutbox/discovery/matching/query
import scoutbox/discovery/matching/watchlist_rules.{
  type Link, type Met, LinkedTo, Met, NotLinked,
}
import scoutbox/discovery/matching_routes
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/paging.{IntKey, IntKind, TextKey, TextKind}
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/room_routes
import scoutbox/rows/dynamic_watchlists as row
import scoutbox/rows/id
import scoutbox/rows/watchlist_criteria as criterion_row
import scoutbox/rows/watchlist_criterion_values as value_row
import scoutbox/rows/watchlist_history as history_row
import scoutbox/rows/watchlist_member_checks as check_row
import scoutbox/rows/watchlist_members as member_row
import scoutbox/rows/watchlist_membership_events as event_row
import scoutbox/vocab/audience
import scoutbox/vocab/playing_level
import scoutbox/vocab/source_context
import scoutbox/vocab/trust_band
import sqlight
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------------ storage

pub type Watchlist {
  Watchlist(row: row.Row, criteria: Criteria)
}

/// A criterion's typed columns and list values, as `watchlist_criteria` and `watchlist_criterion_values` hold them.
fn encode(
  wid: id.WatchlistId,
  c: criteria.Criterion,
  ord: Int,
) -> #(criterion_row.Row, List(String)) {
  let assert Ok(type_) =
    criterion_row.type_from_string(criteria.type_name(c.check))
  let assert Ok(operator) =
    criterion_row.operator_from_string(criteria.operator_name(c.check))
  let class = case c.class {
    criteria.Required -> criterion_row.Required
    criteria.Preferred -> criterion_row.Preferred
  }
  let base =
    criterion_row.new(
      watchlist_id: wid,
      class:,
      ord:,
      criterion_id: c.id,
      type_:,
      operator:,
    )
  let text = fn(t) { criterion_row.Row(..base, value_text: Some(t)) }
  let num = fn(n) { criterion_row.Row(..base, value_num: Some(n)) }
  case c.check {
    criteria.PositionIn(values, primary_only) -> #(
      criterion_row.Row(..base, primary_only: Some(primary_only)),
      values,
    )
    criteria.Age(criteria.Between(lo, hi)) -> #(
      criterion_row.Row(..base, range_min: Some(lo), range_max: Some(hi)),
      [],
    )
    criteria.Age(criteria.AtLeast(n)) | criteria.Age(criteria.AtMost(n)) -> #(
      num(int.to_float(n)),
      [],
    )
    criteria.WithinRadius(km) -> #(num(km), [])
    criteria.LevelAtMost(l) -> #(text(playing_level.to_string(l)), [])
    criteria.LevelIn(ls) -> #(base, list.map(ls, playing_level.to_string))
    criteria.FootIn(values) -> #(base, values)
    criteria.AvailabilityIs(v)
    | criteria.EvidenceExists(v)
    | criteria.CombineResult(v) -> #(text(v), [])
    criteria.TrustBandAtLeast(b) -> #(text(trust_band.to_string(b)), [])
    criteria.EvidenceWithin(days, kind) -> #(
      criterion_row.Row(
        ..num(int.to_float(days)),
        evidence_kind: Some(case kind {
          criteria.AnyEvidence -> criterion_row.Any
          criteria.Footage -> criterion_row.Footage
        }),
      ),
      [],
    )
    criteria.CombineMeasurement(protocol, _, value) -> #(
      criterion_row.Row(..num(value), protocol: Some(protocol)),
      [],
    )
  }
}

/// The criterion a stored row holds, with the id it was saved under.
fn decode_criterion(
  r: criterion_row.Row,
  values: List(String),
) -> criteria.Criterion {
  let text = option.unwrap(r.value_text, "")
  let num = option.unwrap(r.value_num, 0.0)
  let whole = float.truncate(num)
  let level = fn(t) {
    let assert Ok(l) = playing_level.from_string(t)
    l
  }
  let check = case r.type_, r.operator {
    criterion_row.Position, _ ->
      criteria.PositionIn(values, r.primary_only == Some(True))
    criterion_row.Age, criterion_row.Between ->
      criteria.Age(criteria.Between(
        option.unwrap(r.range_min, 0),
        option.unwrap(r.range_max, 0),
      ))
    criterion_row.Age, criterion_row.Gte ->
      criteria.Age(criteria.AtLeast(whole))
    criterion_row.Age, _ -> criteria.Age(criteria.AtMost(whole))
    criterion_row.Geography, _ -> criteria.WithinRadius(num)
    criterion_row.Level, criterion_row.In ->
      criteria.LevelIn(list.map(values, level))
    criterion_row.Level, _ -> criteria.LevelAtMost(level(text))
    criterion_row.Foot, _ -> criteria.FootIn(values)
    criterion_row.Availability, _ -> criteria.AvailabilityIs(text)
    criterion_row.Evidence, _ -> criteria.EvidenceExists(text)
    criterion_row.EvidenceRecency, _ ->
      criteria.EvidenceWithin(whole, case r.evidence_kind {
        Some(criterion_row.Any) -> criteria.AnyEvidence
        _ -> criteria.Footage
      })
    criterion_row.TrustBand, _ -> {
      let assert Ok(b) = trust_band.from_string(text)
      criteria.TrustBandAtLeast(b)
    }
    criterion_row.CombineResult, _ -> criteria.CombineResult(text)
    criterion_row.CombineMeasurement, op ->
      criteria.CombineMeasurement(
        option.unwrap(r.protocol, ""),
        case op {
          criterion_row.Gte -> criteria.AtLeastValue
          _ -> criteria.AtMostValue
        },
        num,
      )
  }
  criteria.Criterion(
    id: r.criterion_id,
    class: case r.class {
      criterion_row.Required -> criteria.Required
      criterion_row.Preferred -> criteria.Preferred
    },
    check:,
  )
}

fn load(read: Read, r: row.Row) -> Result(Watchlist, Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> criterion_row.columns
      <> " FROM watchlist_criteria WHERE watchlist_id = ? ORDER BY class DESC, ord",
    [id.watchlist_sql(r.id)],
    criterion_row.decoder(),
  ))
  use values <- result.map(store.query(
    read,
    "SELECT "
      <> value_row.columns
      <> " FROM watchlist_criterion_values WHERE watchlist_id = ? ORDER BY class, criterion_ord, ord",
    [id.watchlist_sql(r.id)],
    value_row.decoder(),
  ))
  let criteria =
    list.map(rows, fn(c) {
      decode_criterion(
        c,
        list.filter_map(values, fn(v) {
          case
            value_row.class_to_string(v.class)
            == criterion_row.class_to_string(c.class)
            && v.criterion_ord == c.ord
          {
            True -> Ok(v.value)
            False -> Error(Nil)
          }
        }),
      )
    })
  Watchlist(
    row: r,
    criteria: Criteria(
      required: list.filter(criteria, fn(c) { c.class == criteria.Required }),
      preferred: list.filter(criteria, fn(c) { c.class == criteria.Preferred }),
    ),
  )
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Watchlist), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM dynamic_watchlists WHERE " <> where,
    args,
    row.decoder(),
  ))
  list.try_map(rows, load(read, _))
}

/// This organisation's watchlist, or None: another organisation's id is no watchlist.
fn for_org_by_id(
  read: Read,
  wid: id.WatchlistId,
  org_id: id.OrgId,
) -> Result(Option(Watchlist), Fail(e)) {
  select(read, "id = ? AND org_id = ?", [
    id.watchlist_sql(wid),
    id.org_sql(org_id),
  ])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

fn write_criteria(
  tx: Tx,
  wid: id.WatchlistId,
  c: Criteria,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM watchlist_criteria WHERE watchlist_id = ?", [
      id.watchlist_sql(wid),
    ]),
  )
  [c.required, c.preferred]
  |> list.try_each(fn(class) {
    list.index_map(class, fn(crit, i) { #(crit, i) })
    |> list.try_each(fn(pair) {
      let #(r, values) = encode(wid, pair.0, pair.1)
      use _ <- result.try(criterion_row.insert(tx, r))
      list.index_map(values, fn(v, j) { #(v, j) })
      |> list.try_each(fn(v) {
        value_row.insert(
          tx,
          value_row.Row(
            watchlist_id: wid,
            class: case r.class {
              criterion_row.Required -> value_row.Required
              criterion_row.Preferred -> value_row.Preferred
            },
            criterion_ord: r.ord,
            ord: v.1,
            value: v.0,
          ),
        )
      })
    })
  })
}

fn trail(
  tx: Tx,
  wid: id.WatchlistId,
  a: OrgAccess,
  action: history_row.Action,
  at: Int,
  set: fn(history_row.Row) -> history_row.Row,
) -> Result(Nil, Fail(e)) {
  use hid <- result.try(id.next_watchlist_lifecycle_event(tx))
  history_row.insert(
    tx,
    set(
      history_row.Row(
        ..history_row.new(
          id: hid,
          watchlist_id: wid,
          at:,
          by_kind: history_row.Org,
          by_id: a.user.id,
          action:,
        ),
        by_name: Some(a.user.name),
      ),
    ),
  )
}

fn live(tx: Tx, event: live_event.Event) -> Result(Nil, Fail(e)) {
  store.emit(tx, effect.Live(event))
  Ok(Nil)
}

fn changed(
  tx: Tx,
  w: row.Row,
  change: live_event.WatchlistChange,
) -> Result(Nil, Fail(e)) {
  live(
    tx,
    live_event.WatchlistChanged(
      change,
      id.org_to_string(w.org_id),
      id.watchlist_to_string(w.id),
    ),
  )
}

// --------------------------------------------------------------------------------------------------- membership

/// The membership the last reconciliation derived: each member, sorted, with the required criteria they met. None
/// before the first.
fn membership(
  read: Read,
  w: row.Row,
) -> Result(Option(List(#(String, List(Met)))), Fail(e)) {
  case w.last_reconciled_at {
    None -> Ok(None)
    Some(_) -> {
      use members <- result.try(store.query(
        read,
        "SELECT player_id FROM watchlist_members WHERE watchlist_id = ? ORDER BY player_id",
        [id.watchlist_sql(w.id)],
        decode.at([0], id.player_decoder()),
      ))
      use checks <- result.map(store.query(
        read,
        "SELECT "
          <> check_row.columns
          <> " FROM watchlist_member_checks WHERE watchlist_id = ? ORDER BY player_id, ord",
        [id.watchlist_sql(w.id)],
        check_row.decoder(),
      ))
      Some(
        list.map(members, fn(p) {
          #(
            id.player_to_string(p),
            list.filter_map(checks, fn(c) {
              case c.player_id == p {
                True -> Ok(Met(c.criterion_id, c.met, ""))
                False -> Error(Nil)
              }
            }),
          )
        }),
      )
    }
  }
}

/// The criteria a watchlist is evaluated against now, and what its linked brief is: a live-linked watchlist
/// follows its brief, any other its own saved criteria.
fn effective(
  read: Read,
  w: Watchlist,
) -> Result(#(Option(Criteria), Link, Option(briefs.Brief)), Fail(e)) {
  case w.row.mode, w.row.brief_id {
    row.LiveLinked, Some(bid) -> {
      use found <- result.map(briefs.for_org_by_id(read, bid, w.row.org_id))
      case found {
        Some(b) -> #(
          Some(engine.brief_criteria(b.criteria)),
          LinkedTo(Some(b.row.status)),
          Some(b),
        )
        None -> #(None, LinkedTo(None), None)
      }
    }
    _, _ -> Ok(#(Some(w.criteria), NotLinked, None))
  }
}

type Derived {
  Derived(
    criteria: Criteria,
    blocked: Json,
    total: Int,
    evaluated_at: Option(Int),
  )
}

/// Runs when somebody reads the watchlist; there is no timer. Derives the membership, records the transitions not
/// recorded before and the criteria they were judged against, and tells the watchlist's author once.
fn reconcile(
  tx: Tx,
  a: OrgAccess,
  w: Watchlist,
  now: Int,
) -> Result(Derived, Fail(e)) {
  let read = store.reading(tx)
  use #(found, link, brief) <- result.try(effective(read, w))
  let blocked = watchlist_rules.blocked_state(w.row.status, link)
  case found, watchlist_rules.is_blocked(w.row.status, link) {
    None, _ | _, True ->
      Ok(Derived(
        criteria: option.unwrap(found, criteria.no_criteria),
        blocked:,
        total: 0,
        evaluated_at: None,
      ))
    Some(c), False -> {
      use current <- result.try(query.ids(
        read,
        query.from(a.org, c.required, now, []),
      ))
      let current = list.map(current, id.player_to_string)
      let cv = criteria.version(c)
      let brief_version = option.map(brief, fn(b) { b.row.version })
      use last <- result.try(membership(read, w.row))
      let criteria_changed =
        option.is_some(last)
        && w.row.last_criteria_version != None
        && w.row.last_criteria_version != Some(cv)
      let brief_changed =
        option.is_some(last)
        && brief_version != None
        && w.row.last_brief_version != None
        && w.row.last_brief_version != brief_version
      let first = option.is_none(last)
      let previous =
        option.unwrap(last, []) |> list.map(fn(m: #(String, List(Met))) { m.0 })
      let diff = watchlist_rules.reconcile(previous, current)
      // Facts are decoded only for leavers still visible, to name the criterion they no longer meet.
      use leavers <- result.try(case diff.left {
        [] -> Ok([])
        left -> {
          use rows <- result.try(query.rows(
            read,
            query.from(a.org, [], now, [query.among(list.map(left, id.player))]),
          ))
          query.facts_of(read, a.org, rows, now)
        }
      })
      let now_of = fn(pid: String) -> Option(List(Met)) {
        list.find(leavers, fn(f) { id.player_to_string(f.player_id) == pid })
        |> option.from_result
        |> option.map(fn(f) {
          engine.match(f, c, now).required
          |> list.map(fn(r) { Met(r.criterion_id, r.met, r.text) })
        })
      }
      let before_of = fn(pid: String) {
        option.then(last, fn(l) { list.key_find(l, pid) |> option.from_result })
      }
      let explain = fn(pid, transition) {
        watchlist_rules.explain(
          before_of(pid),
          now_of(pid),
          criteria_changed,
          brief_changed,
          transition,
        )
      }
      let events =
        list.append(
          list.map(diff.entered, fn(pid) {
            #(pid, event_row.Entered, case first {
              True ->
                watchlist_rules.Explanation(
                  event_row.FirstEvaluation,
                  None,
                  watchlist_rules.entry_text(event_row.FirstEvaluation),
                )
              False -> explain(pid, event_row.Entered)
            })
          }),
          list.map(diff.left, fn(pid) {
            #(pid, event_row.Left, explain(pid, event_row.Left))
          }),
        )
      let at = now
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE dynamic_watchlists SET last_criteria_version = ?, last_brief_version = ?, last_reconciled_at = ? WHERE id = ?",
          [
            sqlight.text(cv),
            sqlight.nullable(sqlight.int, brief_version),
            sqlight.int(at),
            id.watchlist_sql(w.row.id),
          ],
        ),
      )
      // Only the required met flags are kept: enough to name the criterion that flipped next time, without storing
      // a player record that would go stale or leak. A member met every required criterion, so all are true.
      use _ <- result.try(
        store.run(tx, "DELETE FROM watchlist_members WHERE watchlist_id = ?", [
          id.watchlist_sql(w.row.id),
        ]),
      )
      use _ <- result.try(
        list.try_each(current, fn(pid) {
          let player = id.player(pid)
          use _ <- result.try(member_row.insert(
            tx,
            member_row.Row(watchlist_id: w.row.id, player_id: player),
          ))
          list.index_map(c.required, fn(crit, i) { #(crit, i) })
          |> list.try_each(fn(pair) {
            check_row.insert(
              tx,
              check_row.Row(
                watchlist_id: w.row.id,
                player_id: player,
                ord: pair.1,
                criterion_id: { pair.0 }.id,
                met: True,
              ),
            )
          })
        }),
      )
      // A fingerprint already recorded is one transition, observed again: it is not appended twice.
      use _ <- result.try(
        list.try_each(events, fn(e) {
          let #(pid, transition, why) = e
          let print =
            watchlist_rules.fingerprint(
              id.watchlist_to_string(w.row.id),
              pid,
              cv,
              transition,
              why.reason,
            )
          use seen <- result.try(store.one(
            store.reading(tx),
            "SELECT 1 FROM watchlist_membership_events WHERE fingerprint = ?",
            [sqlight.text(print)],
            decode.at([0], decode.int),
          ))
          case seen {
            Ok(_) -> Ok(Nil)
            Error(Nil) -> {
              use eid <- result.try(id.next_watchlist_event(tx))
              event_row.insert(
                tx,
                event_row.Row(
                  ..event_row.new(
                    id: eid,
                    watchlist_id: w.row.id,
                    org_id: w.row.org_id,
                    player_id: id.player(pid),
                    transition:,
                    reason: why.reason,
                    text: why.text,
                    criteria_version: cv,
                    policy_version: criteria.policy_version,
                    at:,
                    fingerprint: print,
                  ),
                  criterion_id: why.criterion_id,
                  brief_version:,
                ),
              )
            }
          }
        }),
      )
      use _ <- result.try(case events != [] && !first {
        False -> Ok(Nil)
        True -> {
          use _ <- result.try(changed(
            tx,
            w.row,
            live_event.WatchlistMembershipChanged,
          ))
          let cause = case brief_changed, criteria_changed {
            True, _ -> watchlist_rules.BriefEdited
            False, True -> watchlist_rules.CriteriaEdited
            False, False -> watchlist_rules.FactsChanged
          }
          case
            w.row.notify && w.row.status == row.Active,
            watchlist_rules.notification(
              w.row.name,
              list.length(diff.entered),
              list.length(diff.left),
              cause,
            )
          {
            True, Some(text) ->
              notifications.notify(
                tx,
                to: audience.OrgUser,
                id: id.org_user_to_string(w.row.created_by_user_id),
                type_: "watchlist",
                text:,
                ref_id: Some(id.watchlist_to_string(w.row.id)),
                at:,
              )
            _, _ -> Ok(Nil)
          }
        }
      })
      Ok(Derived(
        criteria: c,
        blocked:,
        total: list.length(current),
        evaluated_at: Some(at),
      ))
    }
  }
}

/// The last recorded change, not this read's diff: a diff is consumed by whoever reads first (the client refetches
/// on a colleague's live event), so the person who opened the page would be told nothing changed.
fn last_change(
  read: Read,
  wid: id.WatchlistId,
  current: Int,
) -> Result(Json, Fail(e)) {
  use batch <- result.map(
    store.query(
      read,
      "SELECT transition, at FROM watchlist_membership_events WHERE watchlist_id = ? AND at = (SELECT MAX(at) FROM watchlist_membership_events WHERE watchlist_id = ?) ORDER BY rowid",
      [id.watchlist_sql(wid), id.watchlist_sql(wid)],
      {
        use t <- decode.field(0, event_row.transition_decoder())
        use at <- decode.field(1, decode.int)
        decode.success(#(t, at))
      },
    ),
  )
  let entered = list.count(batch, fn(e) { e.0 == event_row.Entered })
  let left = list.count(batch, fn(e) { e.0 == event_row.Left })
  let fields =
    watchlist_rules.summary_fields(entered, left, 0)
    |> list.map(fn(f) {
      case f.0 {
        "current" -> #("current", json.int(current))
        _ -> f
      }
    })
  json.object(
    list.append(fields, [
      #("changedAt", case batch {
        [#(_, at), ..] if at != 0 -> json.int(at)
        _ -> json.null()
      }),
    ]),
  )
}

// --------------------------------------------------------------------------------------------------------- views

fn rev_of(r: row.Row) -> rev.Rev {
  rev.Rev(rev: r.rev, at: r.rev_at, by_name: r.rev_by_name)
}

fn view(
  read: Read,
  w: Watchlist,
  extra: List(#(String, Json)),
) -> Result(Json, Fail(e)) {
  use #(found, _, _) <- result.map(effective(read, w))
  let r = w.row
  json.object(
    list.flatten([
      [
        #("id", id.watchlist_json(r.id)),
        #("name", json.string(r.name)),
        #("mode", row.mode_to_json(r.mode)),
        #("status", row.status_to_json(r.status)),
        #("sourceType", row.source_type_to_json(r.source_type)),
        #("sourceId", case r.brief_id {
          Some(b) -> id.brief_json(b)
          None -> json.nullable(r.source_ref, json.string)
        }),
        #(
          "criteria",
          criteria.describe(option.unwrap(found, criteria.no_criteria)),
        ),
        #("criteriaVersion", json.string(r.criteria_version)),
        #("schemaVersion", json.int(r.schema_version)),
        #("policyVersion", json.int(criteria.policy_version)),
        #("notify", json.bool(r.notify)),
        #("createdBy", json.nullable(r.created_by_name, json.string)),
        #("createdAt", json.int(r.created_at)),
        #("updatedAt", json.int(r.updated_at)),
        #("lastReconciledAt", json.nullable(r.last_reconciled_at, json.int)),
      ],
      rev.meta(rev_of(r)),
      extra,
    ]),
  )
}

fn answer(r: Result(Response, Fail(Response))) -> Response {
  case r {
    Ok(resp) -> resp
    Error(store.Refuse(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

fn not_found() -> Response {
  http.error(404, "WATCHLIST_NOT_FOUND")
}

fn find(
  read: Read,
  a: OrgAccess,
  wid: String,
) -> Result(Watchlist, Fail(Response)) {
  use found <- result.try(
    for_org_by_id(read, id.watchlist(wid), a.org.id) |> room_routes.storage,
  )
  case found {
    Some(w) -> Ok(w)
    None -> store.refuse(not_found())
  }
}

fn mode_invalid() -> Response {
  http.error_message(
    400,
    "WATCHLIST_MODE_INVALID",
    "Only a watchlist linked to a Recruitment Brief can follow it live.",
  )
}

// -------------------------------------------------------------------------------------------------------- routes

type ListQuery {
  ListQuery(status: Option(row.Status), page: paging.Query)
}

/// `GET /org/watchlists`: the organisation's watchlists, most recently updated first, by cursor. Archived
/// watchlists accumulate, so the list pages.
pub fn list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use status <- input.field(
      "status",
      input.optional(input.one_of(row.status_pairs)),
    )
    use limit <- input.field("limit", input.nullish(input.text(1000)))
    use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
    input.done(ListQuery(status:, page: paging.Query(limit:, cursor:)))
  }
  use q <- http.query(req, shape, [#("status", "WATCHLIST_STATUS_UNKNOWN")])
  case paging.read(q.page, [IntKind, TextKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let status =
        sqlight.nullable(
          sqlight.text,
          option.map(q.status, row.status_to_string),
        )
      let #(at, after_id) = case page.after {
        Some([IntKey(at), TextKey(wid)]) -> #(Some(at), Some(wid))
        _ -> #(None, None)
      }
      let at = sqlight.nullable(sqlight.int, at)
      let after_id = sqlight.nullable(sqlight.text, after_id)
      store.read(ctx.store, fn(read) {
        use found <- result.try(
          select(
            read,
            "org_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at DESC, id ASC LIMIT ?",
            [
              id.org_sql(a.org.id),
              status,
              status,
              at,
              at,
              at,
              after_id,
              sqlight.int(page.limit + 1),
            ],
          ),
        )
        use total <- result.try(store.one(
          read,
          "SELECT COUNT(*) FROM dynamic_watchlists WHERE org_id = ? AND (? IS NULL OR status = ?)",
          [id.org_sql(a.org.id), status, status],
          decode.at([0], decode.int),
        ))
        let #(shown, next) =
          paging.page_of(found, page.limit, fn(w) {
            [
              IntKey(w.row.updated_at),
              TextKey(id.watchlist_to_string(w.row.id)),
            ]
          })
        use views <- result.map(list.try_map(shown, view(read, _, [])))
        http.json(
          200,
          json.object([
            #("items", json.preprocessed_array(views)),
            #("nextCursor", json.nullable(next, json.string)),
            #("total", json.int(result.unwrap(total, 0))),
            #("modes", json.array(row.mode_pairs, fn(p) { json.string(p.0) })),
            #(
              "statuses",
              json.array(row.status_pairs, fn(p) { json.string(p.0) }),
            ),
            #(
              "note",
              json.string(
                "A Dynamic Watchlist is saved criteria. Membership is derived when it is read.",
              ),
            ),
          ]),
        )
      })
      |> fn(r) {
        case r {
          Ok(resp) -> resp
          Error(e) -> http.internal(e)
        }
      }
    }
  }
}

type NewWatchlist {
  NewWatchlist(
    name: Option(String),
    mode: Option(row.Mode),
    source_type: Option(row.SourceType),
    source_id: Option(String),
    brief_id: Option(String),
    criteria: Option(#(List(criteria.Raw), List(criteria.Raw))),
    notify: Option(Bool),
  )
}

fn new_shape() -> input.Shape(NewWatchlist) {
  use name <- input.field(
    "name",
    input.nullish(input.text(criteria.max_name_length)),
  )
  use mode <- input.field("mode", input.nullish(input.one_of(row.mode_pairs)))
  use source_type <- input.field(
    "sourceType",
    input.nullish(input.one_of(row.source_type_pairs)),
  )
  use source_id <- input.field("sourceId", input.nullish(input.text(64)))
  use brief_id <- input.field("briefId", input.nullish(input.id()))
  use raw <- input.field("criteria", input.optional(criteria.raw_criteria()))
  use notify <- input.field("notify", input.nullish(input.boolean()))
  input.done(NewWatchlist(
    name:,
    mode:,
    source_type:,
    source_id:,
    brief_id:,
    criteria: raw,
    notify:,
  ))
}

fn required_empty(message: String) -> Response {
  http.error_message(400, "CRITERIA_REQUIRED_EMPTY", message)
}

/// `POST /org/watchlists`: saved criteria. The mode is never inferred: a club says whether the list follows a
/// brief or keeps its own criteria.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- matching_routes.limited(ctx, a, limits.WatchlistWrite)
  use body <- http.body(req, new_shape(), [
    #("mode", "WATCHLIST_MODE_REQUIRED"),
    #("sourceType", "WATCHLIST_SOURCE_UNKNOWN"),
  ])
  case input.filled(body.name) {
    None -> http.required("WATCHLIST_NAME_REQUIRED", "name")
    Some(name) -> {
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        let read = store.reading(tx)
        use open <- result.try(
          store.one(
            read,
            "SELECT COUNT(*) FROM dynamic_watchlists WHERE org_id = ? AND status <> 'archived'",
            [id.org_sql(a.org.id)],
            decode.at([0], decode.int),
          )
          |> room_routes.storage,
        )
        use <- refuse_if(
          result.unwrap(open, 0) >= criteria.watchlists_per_org,
          http.json(
            409,
            json.object([
              #("error", json.string("WATCHLIST_LIMIT_REACHED")),
              #("limit", json.int(criteria.watchlists_per_org)),
              #(
                "message",
                json.string("Archive a watchlist before creating another."),
              ),
            ]),
          ),
        )
        use mode <- result.try(case body.mode {
          Some(m) -> Ok(m)
          None -> store.refuse(http.required("WATCHLIST_MODE_REQUIRED", "mode"))
        })
        let source_type = case body.source_type, body.brief_id {
          Some(s), _ -> s
          None, Some(_) -> row.Brief
          None, None -> row.Criteria
        }
        use #(saved, brief_id, source_ref) <- result.try(case source_type {
          row.Brief -> {
            use found <- result.try(case body.brief_id {
              Some(b) ->
                briefs.for_org_by_id(read, id.brief(b), a.org.id)
                |> room_routes.storage
              None -> Ok(None)
            })
            case found {
              // Stored even when live-linked, so the history stays readable if the brief is later archived.
              Some(b) ->
                Ok(#(engine.brief_criteria(b.criteria), Some(b.row.id), None))
              None -> store.refuse(http.error(404, "BRIEF_NOT_FOUND"))
            }
          }
          _ -> {
            use <- refuse_if(mode == row.LiveLinked, mode_invalid())
            use c <- result.try(
              criteria.validate_raw(
                option.unwrap(body.criteria, #([], [])),
                orgs.is_grassroots(a.org),
                matching_routes.protocol_ids(),
              )
              |> result.map_error(fn(r) {
                store.Refuse(http.json(400, criteria.refusal_json(r)))
              }),
            )
            use <- refuse_if(
              c.required == [],
              required_empty(
                "A watchlist needs at least one required criterion, or it would match everyone your club can see.",
              ),
            )
            Ok(#(c, None, input.filled(body.source_id)))
          }
        })
        use wid <- result.try(id.next_watchlist(tx) |> room_routes.storage)
        let r =
          row.Row(
            ..row.new(
              id: wid,
              org_id: a.org.id,
              name:,
              mode:,
              status: row.Active,
              source_type:,
              schema_version: criteria.schema_version,
              criteria_version: criteria.version(saved),
              notify: option.unwrap(body.notify, True),
              created_by_user_id: a.user.id,
              created_at: now,
              updated_at: now,
              rev: 1,
            ),
            brief_id:,
            source_ref:,
            // The organisation owns the list: if the creator leaves, it stays and keeps their name.
            created_by_name: Some(a.user.name),
          )
        use _ <- result.try(row.insert(tx, r) |> room_routes.storage)
        use _ <- result.try(
          write_criteria(tx, wid, saved) |> room_routes.storage,
        )
        use _ <- result.try(
          trail(tx, wid, a, history_row.WatchlistCreated, now, fn(h) {
            history_row.Row(
              ..h,
              detail_mode: Some(case mode {
                row.LiveLinked -> history_row.LiveLinked
                row.Snapshot -> history_row.Snapshot
              }),
              detail_source_type: Some(case source_type {
                row.Brief -> history_row.Brief
                row.SavedSearch -> history_row.SavedSearch
                row.Criteria -> history_row.Criteria
              }),
            )
          })
          |> room_routes.storage,
        )
        use _ <- result.try(
          changed(tx, r, live_event.WatchlistCreated) |> room_routes.storage,
        )
        use v <- result.map(
          view(read, Watchlist(r, saved), []) |> room_routes.storage,
        )
        http.json(201, json.object([#("watchlist", v)]))
      })
      |> room_routes.answer
    }
  }
}

fn refuse_if(
  refused: Bool,
  response: Response,
  next: fn() -> Result(a, Fail(Response)),
) -> Result(a, Fail(Response)) {
  case refused {
    True -> store.refuse(response)
    False -> next()
  }
}

type DetailQuery {
  DetailQuery(sort: Option(String), page: paging.Query, offset: Bool)
}

const refresh_note =
  "Membership is derived when this page is read. ScoutBox does not recompute watchlists in the background in this build."

/// `GET /org/watchlists/:id`: the watchlist, its membership derived now, and the last recorded change.
pub fn get(ctx: Ctx, req: Request, a: OrgAccess, wid: String) -> Response {
  let shape = {
    use sort <- input.field(
      "sort",
      input.optional(input.one_of(matching_routes.sort_pairs())),
    )
    use limit <- input.field("limit", input.nullish(input.text(1000)))
    use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
    use offset <- input.field("offset", input.optional(input.anything()))
    input.done(DetailQuery(
      sort:,
      page: paging.Query(limit:, cursor:),
      offset: option.is_some(offset),
    ))
  }
  case store.read(ctx.store, find(_, a, wid)) {
    Error(e) -> answer(Error(e))
    Ok(_) -> {
      use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
      let now = clock.now_ms()
      let sort = option.unwrap(q.sort, matching_routes.default_sort)
      let order = query.order(query.lead(sort, a.org, now))
      case matching_routes.read_page(q.page, q.offset, order) {
        Error(refusal) -> refusal
        Ok(page) ->
          store.unit(ctx.store, fn(tx) {
            let read = store.reading(tx)
            use w <- result.try(find(read, a, wid))
            use d <- result.try(reconcile(tx, a, w, now) |> room_routes.storage)
            // Carries the reconciliation clock this read recorded.
            use fresh <- result.try(find(read, a, wid))
            use #(items, next) <- result.try(
              case d.evaluated_at {
                None -> Ok(#([], None))
                Some(_) ->
                  matching_routes.matched_page(
                    read,
                    a.org,
                    d.criteria,
                    order,
                    page,
                    now,
                  )
              }
              |> room_routes.storage,
            )
            use summary <- result.try(
              last_change(read, w.row.id, d.total) |> room_routes.storage,
            )
            use v <- result.map(
              view(read, fresh, [#("blocked", d.blocked)])
              |> room_routes.storage,
            )
            http.json(
              200,
              json.object([
                #("watchlist", v),
                #("items", json.preprocessed_array(items)),
                #("nextCursor", json.nullable(next, json.string)),
                #("total", json.int(d.total)),
                #("limit", json.int(page.limit)),
                #("sort", json.string(sort)),
                #("summary", summary),
                #("evaluatedAt", json.nullable(d.evaluated_at, json.int)),
                #("refreshNote", json.string(refresh_note)),
              ]),
            )
            |> wisp.set_header(
              "x-scoutbox-ordering",
              matching_routes.ordering(sort),
            )
          })
          |> room_routes.answer
      }
    }
  }
}

type Edit {
  Edit(
    name: Option(String),
    status: Option(row.Status),
    mode: Option(row.Mode),
    notify: Option(Bool),
    criteria: Option(#(List(criteria.Raw), List(criteria.Raw))),
  )
}

fn edit_shape() -> input.Shape(Edit) {
  use name <- input.field(
    "name",
    input.optional(input.text(criteria.max_name_length)),
  )
  use status <- input.field(
    "status",
    input.optional(input.one_of(row.status_pairs)),
  )
  use mode <- input.field("mode", input.optional(input.one_of(row.mode_pairs)))
  use notify <- input.field("notify", input.optional(input.boolean()))
  use raw <- input.field("criteria", input.optional(criteria.raw_criteria()))
  use <- rev.fields
  input.done(Edit(name:, status:, mode:, notify:, criteria: raw))
}

fn detail_mode(m: row.Mode) -> history_row.DetailMode {
  case m {
    row.LiveLinked -> history_row.LiveLinked
    row.Snapshot -> history_row.Snapshot
  }
}

fn detail_status(s: row.Status) -> history_row.DetailStatus {
  case s {
    row.Active -> history_row.Active
    row.Paused -> history_row.Paused
    row.Archived -> history_row.Archived
  }
}

/// `PATCH /org/watchlists/:id`: rename, pause, archive, change the mode or the saved criteria. An archived
/// watchlist keeps its history and is not reopened.
pub fn edit(ctx: Ctx, req: Request, a: OrgAccess, wid: String) -> Response {
  case store.read(ctx.store, find(_, a, wid)) {
    Error(e) -> answer(Error(e))
    Ok(w) -> {
      use <- matching_routes.limited(ctx, a, limits.WatchlistWrite)
      use raw <- http.json_body(req)
      case
        input.parse(edit_shape(), raw, root: "body", codes: [
          #("status", "WATCHLIST_STATUS_UNKNOWN"),
          #("mode", "WATCHLIST_MODE_UNKNOWN"),
          ..rev.codes
        ])
      {
        Error(refusal) -> http.refused(refusal)
        Ok(body) ->
          case rev.expected(raw) {
            Error(refusal) -> refusal
            Ok(expected) -> {
              use <- rev.guard(
                expected,
                rev_of(w.row),
                "WATCHLIST_VERSION_CONFLICT",
                [
                  #("name", json.string(w.row.name)),
                  #("status", row.status_to_json(w.row.status)),
                  #("mode", row.mode_to_json(w.row.mode)),
                ],
              )
              revise(ctx, a, w, body)
            }
          }
      }
    }
  }
}

fn revise(ctx: Ctx, a: OrgAccess, w: Watchlist, body: Edit) -> Response {
  let checked = {
    use name <- result.try(case body.name {
      None -> Ok(w.row.name)
      Some(n) ->
        case input.filled(Some(n)) {
          Some(n) -> Ok(n)
          None -> Error(http.required("WATCHLIST_NAME_REQUIRED", "name"))
        }
    })
    use status <- result.try(case body.status {
      None -> Ok(w.row.status)
      Some(s) ->
        case w.row.status == row.Archived && s != row.Archived {
          True ->
            Error(http.error_message(
              409,
              "WATCHLIST_ARCHIVED",
              "An archived watchlist keeps its history and is not reopened.",
            ))
          False -> Ok(s)
        }
    })
    use mode <- result.try(case body.mode {
      Some(row.LiveLinked) if w.row.source_type != row.Brief ->
        Error(mode_invalid())
      Some(m) -> Ok(m)
      None -> Ok(w.row.mode)
    })
    use saved <- result.map(case body.criteria {
      None -> Ok(None)
      Some(_) if mode == row.LiveLinked ->
        Error(http.error_message(
          409,
          "WATCHLIST_LIVE_LINKED",
          "This watchlist follows its Recruitment Brief. Change the brief, or switch the watchlist to its own saved criteria.",
        ))
      Some(raw) ->
        case
          criteria.validate_raw(
            raw,
            orgs.is_grassroots(a.org),
            matching_routes.protocol_ids(),
          )
        {
          Error(r) -> Error(http.json(400, criteria.refusal_json(r)))
          Ok(c) if c.required == [] ->
            Error(required_empty(
              "A watchlist needs at least one required criterion.",
            ))
          Ok(c) -> Ok(Some(c))
        }
    })
    #(name, status, mode, saved)
  }
  case checked {
    Error(refusal) -> refusal
    Ok(#(name, status, mode, saved)) -> {
      let version = option.map(saved, criteria.version)
      let next =
        row.Row(
          ..w.row,
          name:,
          status:,
          mode:,
          notify: option.unwrap(body.notify, w.row.notify),
          criteria_version: option.unwrap(version, w.row.criteria_version),
        )
      let now = clock.now_ms()
      let archiving = status == row.Archived && w.row.status != row.Archived
      store.unit(ctx.store, fn(tx) {
        let read = store.reading(tx)
        use current <- result.try(find(
          read,
          a,
          id.watchlist_to_string(w.row.id),
        ))
        use _ <- result.try(case current.row.rev == w.row.rev {
          True -> Ok(Nil)
          False -> store.stale("watchlist")
        })
        use _ <- result.try(
          store.run(
            tx,
            "UPDATE dynamic_watchlists SET name = ?, status = ?, mode = ?, notify = ?, criteria_version = ?, updated_at = ?, rev = ?, rev_at = ?, rev_by_user_id = ?, rev_by_name = ? WHERE id = ?",
            [
              sqlight.text(name),
              sqlight.text(row.status_to_string(status)),
              sqlight.text(row.mode_to_string(mode)),
              sqlight.bool(next.notify),
              sqlight.text(next.criteria_version),
              sqlight.int(now),
              sqlight.int(w.row.rev + 1),
              sqlight.int(now),
              id.org_user_sql(a.user.id),
              sqlight.text(a.user.name),
              id.watchlist_sql(w.row.id),
            ],
          )
          |> room_routes.storage,
        )
        use _ <- result.try(case saved {
          Some(c) -> write_criteria(tx, w.row.id, c) |> room_routes.storage
          None -> Ok(Nil)
        })
        use _ <- result.try(
          trail(
            tx,
            w.row.id,
            a,
            case archiving {
              True -> history_row.WatchlistArchived
              False -> history_row.WatchlistUpdated
            },
            now,
            fn(h) {
              history_row.Row(
                ..h,
                detail_mode: Some(detail_mode(mode)),
                detail_status: Some(detail_status(status)),
                detail_changed_name: Some(name != w.row.name),
                detail_changed_mode: Some(mode != w.row.mode),
                detail_changed_status: Some(status != w.row.status),
                detail_changed_criteria: Some(
                  next.criteria_version != w.row.criteria_version,
                ),
              )
            },
          )
          |> room_routes.storage,
        )
        use stored <- result.try(find(read, a, id.watchlist_to_string(w.row.id)))
        use _ <- result.try(
          changed(tx, stored.row, live_event.WatchlistUpdated)
          |> room_routes.storage,
        )
        use _ <- result.try(case stored.row.status {
          row.Archived ->
            changed(tx, stored.row, live_event.WatchlistArchived)
            |> room_routes.storage
          _ -> Ok(Nil)
        })
        use v <- result.map(view(read, stored, []) |> room_routes.storage)
        http.json(200, json.object([#("watchlist", v)]))
      })
      |> room_routes.answer
    }
  }
}

/// `GET /org/watchlists/:id/history`: why membership changed, newest first. A player who has since become
/// invisible keeps the transition, but not their name or id.
pub fn history(ctx: Ctx, req: Request, a: OrgAccess, wid: String) -> Response {
  case store.read(ctx.store, find(_, a, wid)) {
    Error(e) -> answer(Error(e))
    Ok(w) -> {
      use q <- http.query(req, paging.query_shape(), [
        #("limit", "PAGE_LIMIT_INVALID"),
      ])
      case paging.read(q, [IntKind, TextKind]) {
        Error(paging.CursorInvalid) ->
          http.error_message(
            400,
            "HISTORY_CURSOR_INVALID",
            "That page no longer exists — start again from the first page.",
          )
        Error(e) -> {
          let #(code, message) = paging.error_body(e)
          http.error_message(400, code, message)
        }
        Ok(page) -> {
          let #(at, after_id) = case page.after {
            Some([IntKey(at), TextKey(eid)]) -> #(Some(at), Some(eid))
            _ -> #(None, None)
          }
          let at = sqlight.nullable(sqlight.int, at)
          let after_id = sqlight.nullable(sqlight.text, after_id)
          let now = clock.now_ms()
          store.read(ctx.store, fn(read) {
            use rows <- result.try(store.query(
              read,
              "SELECT "
                <> event_row.columns
                <> " FROM watchlist_membership_events WHERE watchlist_id = ? AND (? IS NULL OR at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?",
              [
                id.watchlist_sql(w.row.id),
                at,
                at,
                at,
                after_id,
                sqlight.int(page.limit + 1),
              ],
              event_row.decoder(),
            ))
            use total <- result.try(store.one(
              read,
              "SELECT COUNT(*) FROM watchlist_membership_events WHERE watchlist_id = ?",
              [id.watchlist_sql(w.row.id)],
              decode.at([0], decode.int),
            ))
            let #(shown, next) =
              paging.page_of(rows, page.limit, fn(e) {
                [IntKey(e.at), TextKey(id.watchlist_event_to_string(e.id))]
              })
            use seen <- result.map(players.for_org_many(
              read,
              list.map(shown, fn(e) { e.player_id }) |> list.unique,
              a.org,
              now,
            ))
            let visible = fn(pid) {
              list.find(seen, fn(s) {
                { s.0 }.row.id == pid && { s.1 }.visible && !{ s.1 }.blocked
              })
              |> option.from_result
            }
            http.json(
              200,
              json.object([
                #(
                  "items",
                  json.array(shown, fn(e) {
                    let p = visible(e.player_id)
                    json.object([
                      #("id", id.watchlist_event_json(e.id)),
                      #("at", json.int(e.at)),
                      #(
                        "transition",
                        event_row.transition_to_json(e.transition),
                      ),
                      #("reason", event_row.reason_to_json(e.reason)),
                      #("text", json.string(e.text)),
                      #(
                        "criterionId",
                        json.nullable(e.criterion_id, json.string),
                      ),
                      #("criteriaVersion", json.string(e.criteria_version)),
                      #(
                        "briefVersion",
                        json.nullable(e.brief_version, json.int),
                      ),
                      #(
                        "playerId",
                        json.nullable(
                          option.map(p, fn(_) { e.player_id }),
                          id.player_json,
                        ),
                      ),
                      #(
                        "playerName",
                        json.nullable(
                          option.map(p, fn(s) { { s.0 }.row.name }),
                          json.string,
                        ),
                      ),
                    ])
                  }),
                ),
                #("nextCursor", json.nullable(next, json.string)),
                #("total", json.int(result.unwrap(total, 0))),
                #(
                  "note",
                  json.string(
                    "Why membership changed, in the club’s own criteria. Entering a watchlist is not an improvement in a player.",
                  ),
                ),
              ]),
            )
          })
          |> fn(r) {
            case r {
              Ok(resp) -> resp
              Error(e) -> http.internal(e)
            }
          }
        }
      }
    }
  }
}

/// `POST /org/watchlists/:id/room`: a member into a Recruitment Room, through the one Room creator. The player
/// stays on the watchlist while they still match.
pub fn room(ctx: Ctx, req: Request, a: OrgAccess, wid: String) -> Response {
  case store.read(ctx.store, find(_, a, wid)) {
    Error(e) -> answer(Error(e))
    Ok(w) -> {
      let shape = {
        use player_id <- input.field("playerId", input.nullish(input.text(64)))
        input.done(player_id)
      }
      use player_id <- http.body(req, shape, [])
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use found <- result.try(case player_id {
          Some(p) ->
            players.for_org(store.reading(tx), id.player(p), a.org, now)
            |> room_routes.storage
          None -> Ok(None)
        })
        use p <- result.try(case found {
          None -> store.refuse(http.error(404, "PLAYER_NOT_FOUND"))
          Some(#(p, access)) if access.visible && !access.blocked -> Ok(p)
          Some(_) ->
            store.refuse(http.error_message(
              403,
              "NOT_VISIBLE",
              "This player is not visible to your organisation under the standing rules.",
            ))
        })
        use created <- result.try(room_routes.create_for_player(
          tx,
          a,
          p.row.id,
          source_context.DynamicWatchlist,
          Some(#(id.watchlist_to_string(w.row.id), None)),
          now,
          ctx.config.box_cam_test_provider,
        ))
        // Re-adding a player who already has a Room is idempotent and is not an event.
        use _ <- result.map(case created.existed {
          True -> Ok(Nil)
          False ->
            live(
              tx,
              live_event.MatchingRoomCreated(
                id.org_to_string(a.org.id),
                id.recruitment_case_to_string(created.room_id),
              ),
            )
        })
        http.json(
          case created.existed {
            True -> 200
            False -> 201
          },
          json.object([
            #("roomId", id.recruitment_case_json(created.room_id)),
            #("existed", json.bool(created.existed)),
            #("room", created.view),
            #(
              "note",
              json.string(
                "A Recruitment Room was opened. This player stays on the watchlist while they still match your criteria.",
              ),
            ),
          ]),
        )
      })
      |> room_routes.answer
    }
  }
}
