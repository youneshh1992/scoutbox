//// The club's home feed (`GET /org/feed`, domains/discovery/filmRoom.mjs): the newest 40 of new players and new
//// clips the club may see from the last fortnight, and its trials awaiting their mandatory report.
////
//// A report-due item sends its reminder once, within 48 hours of the deadline, with its marker in the same unit:
//// the TypeScript server's own known exception (it belongs in a sweep), ported as it behaves.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/id
import scoutbox/rows/trials as trial_row
import scoutbox/rules/age
import scoutbox/rules/visibility
import scoutbox/vocab/audience
import sqlight
import wisp.{type Response}

const fourteen_days = 1_209_600_000

const page = 40

type Item {
  Item(ts: Int, fields: List(#(String, Json)))
}

fn new_players(
  read: Read,
  a: OrgAccess,
  since: Int,
  now: Int,
) -> Result(List(Item), Fail(e)) {
  let where =
    sql.join(
      [
        sql.text("p.deleted_at IS NULL"),
        visibility.can_see_sql(a.org, now),
        sql.concat([sql.text("p.created_at >= "), sql.arg(sqlight.int(since))]),
      ],
      " AND ",
    )
  store.query(
    read,
    "SELECT p.id, p.name, p.position, p.birth_date, p.country, p.created_at FROM players p WHERE "
      <> where.sql
      <> " ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?",
    list.append(where.args, [sqlight.int(page)]),
    {
      use pid <- decode.field(0, decode.string)
      use name <- decode.field(1, decode.string)
      use position <- decode.field(2, decode.optional(decode.string))
      use dob <- decode.field(3, decode.string)
      use country <- decode.field(4, decode.string)
      use created <- decode.field(5, decode.int)
      decode.success(
        Item(created, [
          #("type", json.string("new_player")),
          #("ts", json.int(created)),
          #("playerId", json.string(pid)),
          #("playerName", json.string(name)),
          #("position", json.nullable(position, json.string)),
          #("age", json.nullable(age.age_on(dob, now), json.int)),
          #("guardianManaged", json.bool(!age.is_adult(dob, country, now))),
        ]),
      )
    },
  )
}

fn new_clips(
  read: Read,
  a: OrgAccess,
  since: Int,
  now: Int,
) -> Result(List(Item), Fail(e)) {
  use listed <- result.try(store.query(
    read,
    "SELECT DISTINCT player_id FROM ledger WHERE org_id = ? AND type IN ('shortlist', 'save') AND player_id IS NOT NULL",
    [id.org_sql(a.org.id)],
    decode.at([0], decode.string),
  ))
  let where =
    sql.join(
      [
        sql.concat([
          sql.text("m.uploaded_at >= "),
          sql.arg(sqlight.text(clock.iso(since))),
        ]),
        sql.text("p.deleted_at IS NULL"),
        visibility.can_see_sql(a.org, now),
      ],
      " AND ",
    )
  store.query(
    read,
    "SELECT p.id, p.name, m.id, m.title, m.url, m.verified_clip_attendance_id, m.uploaded_at FROM player_media m JOIN players p ON p.id = m.player_id WHERE "
      <> where.sql
      <> " ORDER BY m.uploaded_at DESC, m.rowid DESC LIMIT ?",
    list.append(where.args, [sqlight.int(page)]),
    {
      use pid <- decode.field(0, decode.string)
      use name <- decode.field(1, decode.string)
      use mid <- decode.field(2, decode.string)
      use title <- decode.field(3, decode.string)
      use url <- decode.field(4, decode.optional(decode.string))
      use verified <- decode.field(5, decode.optional(decode.string))
      use uploaded <- decode.field(6, decode.string)
      let ts = case uploaded_ms(uploaded) {
        Some(ms) -> ms
        None -> 0
      }
      decode.success(
        Item(ts, [
          #(
            "type",
            json.string(case list.contains(listed, pid) {
              True -> "shortlist_new_clip"
              False -> "new_clip"
            }),
          ),
          #("ts", json.int(ts)),
          #("playerId", json.string(pid)),
          #("playerName", json.string(name)),
          #("mediaId", json.string(mid)),
          #("title", json.string(title)),
          #("hasVideo", json.bool(option.unwrap(url, "") != "")),
          #("verifiedClip", json.bool(verified != None)),
        ]),
      )
    },
  )
}

fn uploaded_ms(s: String) -> Option(Int) {
  temporal.instant_ms(s) |> option.from_result
}

/// `GET /org/feed`.
pub fn feed(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let since = now - fourteen_days
  let gathered =
    store.read(ctx.store, fn(read) {
      use players <- result.try(new_players(read, a, since, now))
      use clips <- result.try(new_clips(read, a, since, now))
      use own <- result.map(trials.for_org(read, a.org.id))
      #(players, clips, own)
    })
  case gathered {
    Error(e) -> http.internal(e)
    Ok(#(players, clips, own)) -> {
      // A trial whose subject removed their account has no report to file.
      let due =
        list.filter(own, fn(t) {
          t.row.status == trial_row.AwaitingReport
          && t.row.subject_removed_at == None
        })
      list.each(due, fn(t) {
        case t.row.reminder_sent, t.row.report_due_at {
          False, Some(due_at) if due_at - now < 172_800_000 ->
            remind(ctx, t, due_at, now)
          _, _ -> Nil
        }
      })
      let reports =
        list.map(due, fn(t) {
          Item(option.unwrap(t.row.report_due_at, now), [
            #("type", json.string("report_due")),
            #("ts", json.int(option.unwrap(t.row.report_due_at, now))),
            #("playerId", id.player_json(t.row.player_id)),
            #("playerName", json.nullable(t.row.player_name, json.string)),
            #("trialId", id.trial_json(t.row.id)),
            #("dueAt", json.nullable(t.row.report_due_at, json.int)),
          ])
        })
      list.flatten([players, clips, reports])
      |> list.sort(fn(x, y) { int.compare(y.ts, x.ts) })
      |> list.take(page)
      |> json.array(fn(i) { json.object(i.fields) })
      |> http.json(200, _)
    }
  }
}

/// The report reminder and its marker commit together, so it is sent once.
fn remind(ctx: Ctx, t: Trial, due_at: Int, now: Int) -> Nil {
  let _ =
    store.unit(ctx.store, fn(tx) {
      use touched <- result.try(store.write(
        tx,
        "UPDATE trials SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0 RETURNING id",
        [id.trial_sql(t.row.id)],
        decode.at([0], decode.string),
      ))
      case touched {
        [] -> Ok(Nil)
        _ -> {
          use request <- result.try(store.one(
            store.reading(tx),
            "SELECT user_id FROM recruitment_requests WHERE id = ?",
            [id.request_sql(t.row.request_id)],
            decode.at([0], decode.string),
          ))
          case request {
            Ok(user) ->
              notifications.notify(
                tx,
                to: audience.OrgUser,
                id: user,
                type_: "report_due",
                text: "Mandatory trial report for "
                  <> option.unwrap(t.row.player_name, "the player")
                  <> " is due "
                  <> clock.iso_day(due_at)
                  <> ".",
                ref_id: Some(id.trial_to_string(t.row.id)),
                at: now,
              )
            Error(_) -> Ok(Nil)
          }
        }
      }
    })
  Nil
}
