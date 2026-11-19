//// Support tickets and support's access to an organisation's records (domains/enterprise/enterprise.mjs, "audit +
//// support"; `support_tickets` with its refs and replies, `support_access_grants` with its access log). A ticket
//// references a case or an import of the organisation by id; nothing is copied into it.
////
//// Trust & Safety reads an organisation's records only through a grant: requested for a number of hours, approved
//// by a lead of the organisation, and running from the approval. The grant opens only the records the ticket
//// references, and every read under it is a row of its access log.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/staff
import scoutbox/integrations/imports
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/case_workspace
import scoutbox/rows/id
import scoutbox/rows/support_access_grants as grant_row
import scoutbox/rows/support_access_log as log_row
import scoutbox/rows/support_ticket_refs as ref_row
import scoutbox/rows/support_ticket_replies as reply_row
import scoutbox/rows/support_tickets as row
import scoutbox/vocab/audience
import sqlight
import wisp.{type Request, type Response}

const hour_ms = 3_600_000

const default_hours = 24

pub type Ticket {
  Ticket(row: row.Row, refs: List(ref_row.Row), replies: List(reply_row.Row))
}

pub type Grant {
  Grant(row: grant_row.Row, log: List(log_row.Row))
}

fn ids_json(ids: List(String)) -> sqlight.Value {
  sqlight.text(json.to_string(json.array(ids, json.string)))
}

/// The tickets' refs and replies, in one query each.
fn with_children(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Ticket), Fail(e)) {
  let ids = ids_json(list.map(rows, fn(t) { id.ticket_to_string(t.id) }))
  use refs <- result.try(store.query(
    read,
    "SELECT "
      <> ref_row.columns
      <> " FROM support_ticket_refs WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY ticket_id, ord",
    [ids],
    ref_row.decoder(),
  ))
  use replies <- result.map(store.query(
    read,
    "SELECT "
      <> reply_row.columns
      <> " FROM support_ticket_replies WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY ticket_id, ord",
    [ids],
    reply_row.decoder(),
  ))
  list.map(rows, fn(t) {
    Ticket(
      t,
      list.filter(refs, fn(r) { r.ticket_id == t.id }),
      list.filter(replies, fn(r) { r.ticket_id == t.id }),
    )
  })
}

fn by_id(read: Read, id: id.TicketId) -> Result(Option(Ticket), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM support_tickets WHERE id = ?",
    [id.ticket_sql(id)],
    row.decoder(),
  ))
  use tickets <- result.map(with_children(read, found))
  list.first(tickets) |> option.from_result
}

/// Tickets newest first, keyed by rowid: the organisation's, or with `org_id` `None` every organisation's.
fn page_of(
  read: Read,
  org_id: Option(id.OrgId),
  page: paging.Page,
) -> Result(#(List(Ticket), Option(String)), Fail(e)) {
  let before = case page.after {
    Some([paging.IntKey(rid)]) -> Some(rid)
    _ -> None
  }
  let keys = [
    sqlight.nullable(sqlight.int, before),
    sqlight.nullable(sqlight.int, before),
    sqlight.int(page.limit + 1),
  ]
  let keyed = {
    use t <- decode.then(row.decoder())
    use rid <- decode.field(row.width, decode.int)
    decode.success(#(t, rid))
  }
  use rows <- result.try(case org_id {
    Some(org_id) ->
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> ", rowid FROM support_tickets WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
        [id.org_sql(org_id), ..keys],
        keyed,
      )
    None ->
      store.query(
        read,
        "SELECT "
          <> row.columns
          <> ", rowid FROM support_tickets WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
        keys,
        keyed,
      )
  })
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(p) { [paging.IntKey(p.1)] })
  use tickets <- result.map(with_children(read, list.map(items, fn(p) { p.0 })))
  #(tickets, next)
}

fn refs_json(refs: List(ref_row.Row)) -> Json {
  json.array(refs, fn(x) {
    json.object([
      #("kind", ref_row.kind_to_json(x.kind)),
      #("id", json.string(x.ref_id)),
    ])
  })
}

fn view(t: Ticket) -> Json {
  let r = t.row
  json.object([
    #("id", id.ticket_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("byUserId", id.org_user_json(r.by_user_id)),
    #("byName", json.nullable(r.by_name, json.string)),
    #("subject", json.string(r.subject)),
    #("body", json.string(r.body)),
    #("status", row.status_to_json(r.status)),
    #("createdAt", json.int(r.created_at)),
    #("refs", refs_json(t.refs)),
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

// ------------------------------------------------------------------------------------------------------ grants

/// Grants with their access logs, in the order `where` gives.
fn grants_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Grant), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> grant_row.columns <> " FROM support_access_grants " <> where,
    args,
    grant_row.decoder(),
  ))
  use log <- result.map(store.query(
    read,
    "SELECT "
      <> log_row.columns
      <> " FROM support_access_log WHERE grant_id IN (SELECT value FROM json_each(?)) ORDER BY grant_id, ord",
    [ids_json(list.map(rows, fn(g) { id.support_grant_to_string(g.id) }))],
    log_row.decoder(),
  ))
  list.map(rows, fn(g) {
    Grant(g, list.filter(log, fn(l) { l.grant_id == g.id }))
  })
}

fn grant_by_id(
  read: Read,
  grant_id: id.SupportGrantId,
) -> Result(Grant, Fail(e)) {
  use found <- result.map(
    grants_where(read, "WHERE id = ?", [id.support_grant_sql(grant_id)]),
  )
  let assert [g] = found as "a grant read back by its id"
  g
}

fn grant_json(g: Grant) -> Json {
  let r = g.row
  json.object([
    #("id", id.support_grant_json(r.id)),
    #("ticketId", id.ticket_json(r.ticket_id)),
    #("orgId", id.org_json(r.org_id)),
    #("hours", json.int(r.hours)),
    #("status", grant_row.status_to_json(r.status)),
    #("requestedAt", json.int(r.requested_at)),
    #("approvedBy", json.nullable(r.approved_by_name, json.string)),
    #("approvedAt", json.nullable(r.approved_at, json.int)),
    #("expiresAt", json.nullable(r.expires_at, json.int)),
    #(
      "accessLog",
      json.array(g.log, fn(l) {
        json.object([
          #("at", json.int(l.at)),
          #("what", log_row.what_to_json(l.what)),
        ])
      }),
    ),
  ])
}

/// Every grant of the organisation, oldest first: the audit export's `supportAccess`.
pub fn grants_for_org_json(
  read: Read,
  org_id: id.OrgId,
) -> Result(Json, Fail(e)) {
  grants_where(read, "WHERE org_id = ? ORDER BY rowid", [id.org_sql(org_id)])
  |> result.map(json.array(_, grant_json))
}

// ------------------------------------------------------------------------------------------------- org routes

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
      input.nullish(input.items(input.object(reference), 10)),
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
          use id <- result.try(id.next_ticket(tx))
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
          t
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

/// `GET /org/support`: the organisation's tickets, newest first by cursor.
pub fn org_page(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [paging.IntKind])
  case store.read(ctx.store, page_of(_, Some(a.org.id), page)) {
    Ok(#(items, next)) -> pages.respond(items, next, view)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /org/support/:id/approve-access`: a lead approves the ticket's oldest request; it runs for its hours from
/// now.
pub fn approve_access(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  ticket_id: id.TicketId,
) -> Response {
  use <- access.require_lead(a)
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let approved =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use pending <- result.try(
        grants_where(
          read,
          "WHERE ticket_id = ? AND org_id = ? AND status = 'requested' ORDER BY rowid LIMIT 1",
          [id.ticket_sql(ticket_id), id.org_sql(a.org.id)],
        ),
      )
      case pending {
        [] -> store.refuse(http.error(404, "NO_PENDING_REQUEST"))
        [g, ..] -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE support_access_grants SET status = 'active', approved_by_name = ?, approved_at = ?, expires_at = ? WHERE id = ?",
              [
                sqlight.text(a.user.name),
                sqlight.int(now),
                sqlight.int(now + g.row.hours * hour_ms),
                id.support_grant_sql(g.row.id),
              ],
            ),
          )
          grant_by_id(read, g.row.id)
        }
      }
    })
  case approved {
    Ok(g) -> http.json(200, json.object([#("grant", grant_json(g))]))
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

// ----------------------------------------------------------------------------------------------- admin routes

/// `GET /admin/support`: every organisation's tickets, newest first by cursor, with the grants of the tickets on
/// the page, newest first.
pub fn admin_page(ctx: Ctx, req: Request) -> Response {
  use page <- pages.strict(req, [paging.IntKind])
  let found =
    store.read(ctx.store, fn(read) {
      use #(items, next) <- result.try(page_of(read, None, page))
      use grants <- result.map(
        grants_where(
          read,
          "WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC",
          [ids_json(list.map(items, fn(t) { id.ticket_to_string(t.row.id) }))],
        ),
      )
      #(items, next, grants)
    })
  case found {
    Ok(#(items, next, grants)) ->
      http.json(
        200,
        json.object([
          #("items", json.array(items, view)),
          #("nextCursor", json.nullable(next, json.string)),
          #("grants", json.array(grants, grant_json)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// The ticket, or a 404 before the body is read.
fn ticket_or_404(
  ctx: Ctx,
  ticket_id: id.TicketId,
  next: fn(Ticket) -> Response,
) -> Response {
  case store.read(ctx.store, by_id(_, ticket_id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "TICKET_NOT_FOUND")
    Ok(Some(t)) -> next(t)
  }
}

/// A notice to the staff member who filed the ticket, when their account is still there.
fn tell_filer(
  tx: Tx,
  t: Ticket,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use filer <- result.try(staff.by_id(store.reading(tx), t.row.by_user_id))
  case filer {
    Some(u) ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(u.id),
        type_: "support",
        text:,
        ref_id: Some(id.ticket_to_string(t.row.id)),
        at:,
      )
    None -> Ok(Nil)
  }
}

type Reply {
  Reply(text: Option(String), close: Option(Bool))
}

/// `POST /admin/support/:id/reply`: Trust & Safety answers, and the staff member who filed the ticket hears.
pub fn reply(ctx: Ctx, req: Request, ticket_id: id.TicketId) -> Response {
  use t <- ticket_or_404(ctx, ticket_id)
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
                [id.ticket_sql(t.row.id)],
              )
            _ -> Ok(Nil)
          })
          use _ <- result.try(tell_filer(
            tx,
            t,
            "Support replied on “" <> t.row.subject <> "”.",
            now,
          ))
          use found <- result.map(by_id(read, t.row.id))
          let assert Some(t) = found as "the ticket reads back in its unit"
          t
        })
      case replied {
        Ok(t) -> http.json(200, json.object([#("ticket", view(t))]))
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /admin/support/:id/request-access`: Trust & Safety asks the organisation for access for `hours` (1 to 72,
/// 24 when not given).
pub fn request_access(
  ctx: Ctx,
  req: Request,
  ticket_id: id.TicketId,
) -> Response {
  use t <- ticket_or_404(ctx, ticket_id)
  let shape = {
    use hours <- input.field("hours", input.nullish(input.whole_number(1, 72)))
    input.done(hours)
  }
  use hours <- http.body(req, shape, [])
  let hours = option.unwrap(hours, default_hours)
  let now = clock.now_ms()
  let requested =
    store.unit(ctx.store, fn(tx) {
      use grant_id <- result.try(id.next_support_grant(tx))
      use _ <- result.try(grant_row.insert(
        tx,
        grant_row.new(
          id: grant_id,
          ticket_id: t.row.id,
          org_id: t.row.org_id,
          hours:,
          status: grant_row.Requested,
          requested_at: now,
        ),
      ))
      use _ <- result.try(tell_filer(
        tx,
        t,
        "Trust & Safety asks for time-limited access ("
          <> int.to_string(hours)
          <> "h) to investigate “"
          <> t.row.subject
          <> "”. A lead can approve it from the Support screen.",
        now,
      ))
      grant_by_id(store.reading(tx), grant_id)
    })
  case requested {
    Ok(g) ->
      http.json(
        201,
        json.object([
          #("grant", grant_json(g)),
          #(
            "note",
            json.string(
              "Access starts only after an organisation lead approves, and every read is logged.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /admin/support/:id/org-records`: the only admin view into an organisation's private records. It needs a
/// running grant, opens only what the ticket references, and logs the read in the same unit.
pub fn org_records(ctx: Ctx, ticket_id: id.TicketId) -> Response {
  use t <- ticket_or_404(ctx, ticket_id)
  let now = clock.now_ms()
  let org_id = t.row.org_id
  let read_under_grant =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use live <- result.try(
        grants_where(
          read,
          "WHERE ticket_id = ? AND status = 'active' AND expires_at > ? ORDER BY rowid LIMIT 1",
          [id.ticket_sql(t.row.id), sqlight.int(now)],
        ),
      )
      case live {
        [] ->
          store.refuse(http.error_message(
            403,
            "SUPPORT_ACCESS_NOT_GRANTED",
            "A lead of the organisation must approve time-limited access first. There is no silent access path.",
          ))
        [g, ..] -> {
          use _ <- result.try(log_row.insert(
            tx,
            log_row.new(
              grant_id: g.row.id,
              ord: list.length(g.log),
              at: now,
              what: log_row.OrgRecords,
            ),
          ))
          let refs_of = fn(kind) {
            list.filter_map(t.refs, fn(r) {
              case r.kind == kind {
                True -> Ok(r.ref_id)
                False -> Error(Nil)
              }
            })
          }
          use cases <- result.try(
            list.try_map(refs_of(ref_row.Case), fn(case_id) {
              case_workspace.record_of_org(read, org_id, case_id)
            }),
          )
          use batches <- result.map(imports.for_org_by_ids_json(
            read,
            org_id,
            refs_of(ref_row.Import),
          ))
          json.object([
            #(
              "grant",
              json.object([
                #("id", id.support_grant_json(g.row.id)),
                #("expiresAt", json.nullable(g.row.expires_at, json.int)),
              ]),
            ),
            #(
              "records",
              json.object([
                #("refs", refs_json(t.refs)),
                #("cases", json.preprocessed_array(option.values(cases))),
                #("imports", batches),
              ]),
            ),
            #(
              "note",
              json.string(
                "Only records the ticket references, only while the grant lives, only logged.",
              ),
            ),
          ])
        }
      }
    })
  case read_under_grant {
    Ok(body) -> http.json(200, body)
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}
