//// Support tickets (domains/enterprise/enterprise.mjs; `support_tickets` and its refs and replies). A ticket
//// references a case or an import of the organisation by id; nothing is copied into it.
////
//// Not ported yet: the ticket lists, and support's time-limited access to an organisation's records.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/support_ticket_refs as ref_row
import scoutbox/rows/support_ticket_replies as reply_row
import scoutbox/rows/support_tickets as row
import scoutbox/vocab/audience
import sqlight
import wisp.{type Request, type Response}

pub type Ticket {
  Ticket(row: row.Row, refs: List(ref_row.Row), replies: List(reply_row.Row))
}

fn by_id(read: Read, id: String) -> Result(Option(Ticket), Fail(e)) {
  let args = [sqlight.text(id)]
  use found <- result.try(store.one(
    read,
    "SELECT " <> row.columns <> " FROM support_tickets WHERE id = ?",
    args,
    row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(t) -> {
      use refs <- result.try(store.query(
        read,
        "SELECT "
          <> ref_row.columns
          <> " FROM support_ticket_refs WHERE ticket_id = ? ORDER BY ord",
        args,
        ref_row.decoder(),
      ))
      use replies <- result.map(store.query(
        read,
        "SELECT "
          <> reply_row.columns
          <> " FROM support_ticket_replies WHERE ticket_id = ? ORDER BY ord",
        args,
        reply_row.decoder(),
      ))
      Some(Ticket(t, refs, replies))
    }
  }
}

fn view(t: Ticket) -> Json {
  let r = t.row
  json.object([
    #("id", json.string(r.id)),
    #("orgId", json.string(r.org_id)),
    #("byUserId", json.string(r.by_user_id)),
    #("byName", json.nullable(r.by_name, json.string)),
    #("subject", json.string(r.subject)),
    #("body", json.string(r.body)),
    #("status", json.string(row.status_to_string(r.status))),
    #("createdAt", json.int(r.created_at)),
    #(
      "refs",
      json.array(t.refs, fn(x) {
        json.object([
          #("kind", json.string(ref_row.kind_to_string(x.kind))),
          #("id", json.string(x.ref_id)),
        ])
      }),
    ),
    #(
      "replies",
      json.array(t.replies, fn(x) {
        json.object([
          #("at", json.int(x.at)),
          #("by", json.string(x.by_name)),
          #("text", json.string(x.text)),
        ])
      }),
    ),
  ])
}

type NewTicket {
  NewTicket(
    subject: Option(String),
    body: Option(String),
    refs: List(#(ref_row.Kind, String)),
  )
}

/// `POST /org/support`.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    let reference = {
      use kind <- input.field(
        "kind",
        input.required(input.one_of(ref_row.kind_pairs)),
      )
      use id <- input.field("id", input.required(input.id()))
      input.done(#(kind, id))
    }
    use subject <- input.field("subject", input.nullish(input.text(160)))
    use body <- input.field("body", input.nullish(input.text(2000)))
    use refs <- input.field(
      "refs",
      input.nullish(input.list_of(input.object(reference), 10)),
    )
    input.done(NewTicket(subject:, body:, refs: option.unwrap(refs, [])))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.subject) {
    None -> http.required("SUBJECT_REQUIRED", "subject")
    Some(subject) -> {
      let now = clock.now_ms()
      let made =
        store.unit(ctx.store, fn(tx) {
          use id <- result.try(ids.next(tx, "tkt"))
          use _ <- result.try(row.insert(
            tx,
            row.Row(
              ..row.new(
                id:,
                org_id: a.org.id,
                by_user_id: a.user.id,
                subject:,
                body: option.unwrap(body.body, ""),
                status: row.Open,
                created_at: now,
              ),
              by_name: Some(a.user.name),
            ),
          ))
          use _ <- result.try(
            list.index_map(body.refs, fn(r, ord) { #(r, ord) })
            |> list.try_each(fn(p) {
              ref_row.insert(tx, ref_row.new(id, p.1, p.0.0, p.0.1))
            }),
          )
          use found <- result.map(by_id(store.reading(tx), id))
          let assert Some(t) = found as "a ticket reads back in its unit"
          #(t, [])
        })
      case made {
        Ok(t) ->
          http.json(
            201,
            json.object([
              #("ticket", view(t)),
              #(
                "note",
                json.string(
                  "Records are referenced by id — nothing was copied into the ticket.",
                ),
              ),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

type Reply {
  Reply(text: Option(String), close: Option(Bool))
}

/// `POST /admin/support/:id/reply`: Trust & Safety answers, and the staff member who filed the ticket hears.
pub fn reply(ctx: Ctx, req: Request, id: String) -> Response {
  case store.read(ctx.store, by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "TICKET_NOT_FOUND")
    Ok(Some(t)) -> {
      let shape = {
        use text <- input.field("text", input.nullish(input.text(2000)))
        use close <- input.field("close", input.nullish(input.boolean()))
        input.done(Reply(text:, close:))
      }
      use body <- http.body(req, shape, [])
      case input.filled(body.text) {
        None -> http.required("FIELD_INVALID", "text")
        Some(text) -> {
          let now = clock.now_ms()
          let replied =
            store.unit(ctx.store, fn(tx) {
              let read = store.reading(tx)
              use _ <- result.try(reply_row.insert(
                tx,
                reply_row.new(
                  ticket_id: t.row.id,
                  ord: list.length(t.replies),
                  at: now,
                  by_name: "Trust & Safety",
                  text:,
                ),
              ))
              use _ <- result.try(case body.close {
                Some(True) ->
                  store.run(
                    tx,
                    "UPDATE support_tickets SET status = 'closed' WHERE id = ?",
                    [sqlight.text(t.row.id)],
                  )
                _ -> Ok(Nil)
              })
              use filer <- result.try(staff.by_id(read, t.row.by_user_id))
              use _ <- result.try(case filer {
                Some(u) ->
                  notifications.notify(
                    tx,
                    to: audience.OrgUser,
                    id: u.id,
                    type_: "support",
                    text: "Support replied on “" <> t.row.subject <> "”.",
                    ref_id: Some(t.row.id),
                    at: now,
                  )
                None -> Ok(Nil)
              })
              use found <- result.map(by_id(read, t.row.id))
              let assert Some(t) = found as "the ticket reads back in its unit"
              #(t, [])
            })
          case replied {
            Ok(t) -> http.json(200, json.object([#("ticket", view(t))]))
            Error(failure) -> http.internal(failure)
          }
        }
      }
    }
  }
}
