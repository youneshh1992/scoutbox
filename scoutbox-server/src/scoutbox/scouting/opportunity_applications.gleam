//// Applications to a club's opportunities (domains/scouting/journeys.mjs): an adult applies for themselves and a
//// guardian for their child, either withdraws an unanswered one, and the club answers each before it may close the
//// opportunity (no ghosting).
////
//// The suitability summary's share and unshare are `scouting/suitability`.
////
//// Not ported yet: the week-old reminder sweep (`remindersDue`, `markReminded`).

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/application_history as history_row
import scoutbox/rows/application_suitability as suitability_row
import scoutbox/rows/applications as row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/opportunities as opportunity_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/scouting/evidence
import scoutbox/scouting/opportunities
import scoutbox/vocab/audience
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

// OPPORTUNITIES_CAMPAIGNS_LIMITS (repositories/opportunitiesCampaigns.ts).
const note_max = 300

const outcome_note_max = 300

/// An application with its history and its suitability verdicts.
pub type Application {
  Application(
    row: row.Row,
    history: List(history_row.Row),
    verdicts: List(suitability_row.Row),
  )
}

/// Who made an application or withdrew it.
type Actor {
  Actor(kind: party.Party, id: String, name: String)
}

// ------------------------------------------------------------------------------------------------- reads

fn with_children(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Application), Fail(e)) {
  let ids =
    json.array(rows, fn(r) { id.application_json(r.id) })
    |> json.to_string
    |> sqlight.text
  use history <- result.try(store.query(
    read,
    "SELECT "
      <> history_row.columns
      <> " FROM application_history WHERE application_id IN (SELECT value FROM json_each(?)) ORDER BY position",
    [ids],
    history_row.decoder(),
  ))
  use verdicts <- result.map(store.query(
    read,
    "SELECT "
      <> suitability_row.columns
      <> " FROM application_suitability WHERE application_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal",
    [ids],
    suitability_row.decoder(),
  ))
  // `list.group` prepends, so each group is in reverse of the query's order.
  let history = list.group(history, fn(h) { h.application_id })
  let verdicts = list.group(verdicts, fn(v) { v.application_id })
  list.map(rows, fn(r) {
    Application(
      row: r,
      history: dict.get(history, r.id) |> result.unwrap([]) |> list.reverse,
      verdicts: dict.get(verdicts, r.id) |> result.unwrap([]) |> list.reverse,
    )
  })
}

fn query(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Application), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM applications " <> where,
    args,
    row.decoder(),
  ))
  with_children(read, rows)
}

pub fn by_id(
  read: Read,
  aid: id.ApplicationId,
) -> Result(Option(Application), Fail(e)) {
  use found <- result.map(
    query(read, "WHERE id = ?", [id.application_sql(aid)]),
  )
  list.first(found) |> option.from_result
}

pub fn opportunity_by_id(
  read: Read,
  oid: id.OpportunityId,
) -> Result(Option(opportunities.Opportunity), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> opportunity_row.columns <> " FROM opportunities WHERE id = ?",
    [id.opportunity_sql(oid)],
    opportunity_row.decoder(),
  ))
  use found <- result.map(opportunities.with_children(read, rows))
  list.first(found) |> option.from_result
}

/// The player's application to the opportunity that is not withdrawn.
fn live_for(
  read: Read,
  oid: id.OpportunityId,
  pid: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  use found <- result.map(store.one(
    read,
    "SELECT 1 FROM applications WHERE opportunity_id = ? AND player_id = ? AND status <> 'withdrawn'",
    [id.opportunity_sql(oid), id.player_sql(pid)],
    decode.at([0], decode.int),
  ))
  result.is_ok(found)
}

// ------------------------------------------------------------------------------------------------- the view

/// views.mjs `applicationView`.
pub fn view(a: Application) -> Json {
  json.object(view_fields(a))
}

fn view_fields(a: Application) -> List(#(String, Json)) {
  let r = a.row
  [
    #("id", id.application_json(r.id)),
    #("opportunityId", id.opportunity_json(r.opportunity_id)),
    #("orgId", id.org_json(r.org_id)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #(
      "submittedBy",
      json.object([
        #("kind", party.to_json(r.submitted_by_kind)),
        #("id", json.string(r.submitted_by_id)),
        #("name", json.nullable(r.submitted_by_name, json.string)),
      ]),
    ),
    #("note", json.nullable(r.note, json.string)),
    #("status", row.status_to_json(r.status)),
    #("outcome", case r.outcome_at, r.outcome_by_user_id {
      Some(at), Some(by) ->
        json.object([
          #("decision", row.status_to_json(r.status)),
          #("note", json.nullable(r.outcome_note, json.string)),
          #("byUserId", id.org_user_json(by)),
          #("byName", json.nullable(r.outcome_by_name, json.string)),
          #("at", json.int(at)),
        ])
      _, _ -> json.null()
    }),
    #("createdAt", json.int(r.created_at)),
    #("remindedAt", json.nullable(r.reminded_at, json.int)),
    #(
      "suitabilitySummary",
      case r.suitability_approved_at, r.suitability_approved_by {
        Some(at), Some(by) ->
          json.object([
            #("approvedAt", json.int(at)),
            #("approvedBy", party.to_json(by)),
            #(
              "verdicts",
              json.array(a.verdicts, fn(v) {
                json.object([
                  #("dimension", suitability_row.dimension_to_json(v.dimension)),
                  #("verdict", suitability_row.verdict_to_json(v.verdict)),
                ])
              }),
            ),
          ])
        _, _ -> json.null()
      },
    ),
    #(
      "history",
      json.array(a.history, fn(h) {
        json.object([
          #("id", id.application_event_json(h.id)),
          #("at", json.int(h.at)),
          #("byKind", json.nullable(h.by_kind, history_row.by_kind_to_json)),
          #("byId", json.nullable(h.by_id, json.string)),
          #("byName", json.nullable(h.by_name, json.string)),
          #("action", json.string(h.action)),
          #("detail", json.nullable(h.detail, json.string)),
        ])
      }),
    ),
  ]
}

fn answer_with(a: Application) -> Json {
  json.object([#("application", view(a))])
}

// ------------------------------------------------------------------------------------------------- writes

/// A history entry at the end of the application's history.
fn log(
  tx: Tx,
  aid: id.ApplicationId,
  by_kind: history_row.ByKind,
  by_id: String,
  by_name: String,
  action: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_application_event(tx))
  store.run(
    tx,
    "INSERT INTO application_history (id, application_id, position, at, by_kind, by_id, by_name, action, detail) SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?, ?, NULL FROM application_history WHERE application_id = ?",
    [
      id.application_event_sql(event_id),
      id.application_sql(aid),
      sqlight.int(at),
      sqlight.text(history_row.by_kind_to_string(by_kind)),
      sqlight.text(by_id),
      sqlight.text(evidence.stored_name(by_name)),
      sqlight.text(action),
      id.application_sql(aid),
    ],
  )
}

fn by_kind(kind: party.Party) -> history_row.ByKind {
  case kind {
    party.Player -> history_row.Player
    party.Guardian -> history_row.Guardian
  }
}

/// The application as it now stands, inside the unit that changed it.
fn reread(tx: Tx, aid: id.ApplicationId) -> Result(Application, Fail(e)) {
  use found <- result.try(by_id(store.reading(tx), aid))
  case found {
    Some(a) -> Ok(a)
    None -> store.stale("application " <> id.application_to_string(aid))
  }
}

fn finished(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn moderated(
  ctx: Ctx,
  note: Option(String),
  kind: String,
  player_id: id.PlayerId,
  org_id: id.OrgId,
  next: fn() -> Response,
) -> Response {
  case note {
    None -> next()
    Some(text) ->
      moderate.or_refuse(
        ctx,
        text,
        audit.Context(
          kind:,
          player_id: Some(player_id),
          org_id: Some(org_id),
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
        next,
      )
  }
}

/// `|| null`: empty text is no value.
fn or_none(s: Option(String)) -> Option(String) {
  case s {
    Some("") -> None
    other -> other
  }
}

// ------------------------------------------------------------------------------------------------- applying

/// `POST /player/opportunities/:id/apply`. Minors never apply to clubs themselves: the guardian applies.
pub fn player_apply(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  oid: id.OpportunityId,
) -> Response {
  case p.minor {
    True ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Your parent or guardian makes applications for you.",
      )
    False ->
      apply_to(
        ctx,
        req,
        p.player,
        Actor(
          party.Player,
          id.player_to_string(p.player.row.id),
          p.player.row.name,
        ),
        oid,
      )
  }
}

/// `POST /guardian/children/:childId/opportunities/:id/apply`.
pub fn guardian_apply(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
  oid: id.OpportunityId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  apply_to(
    ctx,
    req,
    child,
    Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name),
    oid,
  )
}

fn child_of(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
  next: fn(Player) -> Response,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Ok(Some(c)) -> next(c)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
  }
}

type Gate {
  Open(opportunities.Opportunity)
  Shut(Response)
}

/// The checks before the note is read, in the TypeScript server's order.
fn gate(
  read: Read,
  p: Player,
  oid: id.OpportunityId,
  now: Int,
) -> Result(Gate, Fail(e)) {
  use found <- result.try(opportunity_by_id(read, oid))
  case found {
    None -> Ok(Shut(http.error(404, "OPPORTUNITY_NOT_FOUND")))
    Some(o) ->
      case opportunities.is_open(o.row, clock.iso_day(now)) {
        False -> Ok(Shut(http.error(409, "OPPORTUNITY_CLOSED")))
        True -> {
          use org <- result.try(orgs.by_id(read, o.row.org_id))
          use seen <- result.try(case org {
            Some(org) -> players.for_org(read, p.row.id, org, now)
            None -> Ok(None)
          })
          case seen {
            Some(#(_, access)) if access.visible && !access.blocked -> {
              use km <- result.try(opportunities.km_from_club(
                read,
                o.row.org_id,
                p,
              ))
              case
                opportunities.reasons(
                  opportunities.eligibility(o.row),
                  p,
                  km,
                  now,
                )
              {
                [] -> {
                  use applied <- result.try(live_for(read, o.row.id, p.row.id))
                  use counts <- result.map(
                    opportunities.application_counts(read, [o.row.id]),
                  )
                  let #(live, _) =
                    dict.get(counts, o.row.id) |> result.unwrap(#(0, 0))
                  case applied, o.row.capacity {
                    True, _ -> Shut(http.error(409, "ALREADY_APPLIED"))
                    False, Some(capacity) if live >= capacity ->
                      Shut(http.error(409, "CAPACITY_FULL"))
                    False, _ -> Open(o)
                  }
                }
                reasons -> Ok(Shut(not_eligible(reasons)))
              }
            }
            _ ->
              Ok(
                Shut(not_eligible(["this club cannot work with this profile"])),
              )
          }
        }
      }
  }
}

fn not_eligible(reasons: List(String)) -> Response {
  http.json(
    403,
    json.object([
      #("error", json.string("NOT_ELIGIBLE")),
      #("reasons", json.array(reasons, json.string)),
    ]),
  )
}

fn apply_to(
  ctx: Ctx,
  req: Request,
  p: Player,
  submitter: Actor,
  oid: id.OpportunityId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  let now = clock.now_ms()
  case store.read(ctx.store, gate(_, p, oid, now)) {
    Error(failure) -> http.internal(failure)
    Ok(Shut(answer)) -> answer
    Ok(Open(o)) -> {
      let shape = {
        use note <- input.field("note", input.nullish(input.text(note_max)))
        input.done(or_none(note))
      }
      use note <- http.body(req, shape, [])
      use <- moderated(ctx, note, "application", p.row.id, o.row.org_id)
      store.unit(ctx.store, fn(tx) {
        // Two requests for one player can pass the gate together: the second finds the first's here.
        use applied <- result.try(live_for(
          store.reading(tx),
          o.row.id,
          p.row.id,
        ))
        use <- store_guard(!applied, "a live application")
        use aid <- result.try(id.next_application(tx))
        use _ <- result.try(row.insert(
          tx,
          row.Row(
            ..row.new(
              id: aid,
              opportunity_id: o.row.id,
              org_id: o.row.org_id,
              player_id: p.row.id,
              submitted_by_kind: submitter.kind,
              submitted_by_id: submitter.id,
              status: row.Submitted,
              created_at: now,
            ),
            player_name: Some(evidence.stored_name(p.row.name)),
            submitted_by_name: Some(evidence.stored_name(submitter.name)),
            note:,
          ),
        ))
        use _ <- result.try(log(
          tx,
          aid,
          by_kind(submitter.kind),
          submitter.id,
          submitter.name,
          "submitted",
          now,
        ))
        use _ <- result.try(ledger.append(
          tx,
          ledger.Entry(
            event: ledger.Plain(ledger_row.OpportunityApplication),
            player_id: Some(p.row.id),
            org_id: Some(o.row.org_id),
            org_name: Some(o.row.org_name),
            user_id: None,
            actor_name: Some(submitter.name),
          ),
          now,
        ))
        use first <- result.try(staff.first_active(
          store.reading(tx),
          o.row.org_id,
        ))
        use _ <- result.try(notifications.notify(
          tx,
          to: audience.OrgUser,
          id: case first {
            Some(s) -> id.org_user_to_string(s.id)
            None -> ""
          },
          type_: "application",
          text: "📥 " <> p.row.name <> " applied to \"" <> o.row.title <> "\".",
          ref_id: Some(id.application_to_string(aid)),
          at: now,
        ))
        store.emit(
          tx,
          effect.Live(live_event.Applications(id.player_to_string(p.row.id))),
        )
        use a <- result.map(reread(tx, aid))
        http.json(201, answer_with(a))
      })
      |> finished
    }
  }
}

/// Stale unless `holds`.
fn store_guard(
  holds: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case holds {
    True -> next()
    False -> store.stale(what)
  }
}

// ------------------------------------------------------------------------------------------------- the family's list

fn mine(ctx: Ctx, player_ids: List(id.PlayerId)) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use apps <- result.try(
        query(
          read,
          "WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
          [
            sqlight.text(json.to_string(json.array(player_ids, id.player_json))),
          ],
        ),
      )
      use opps <- result.map(
        list.map(apps, fn(a) { a.row.opportunity_id })
        |> list.unique
        |> list.try_map(fn(oid) {
          use o <- result.map(opportunity_by_id(read, oid))
          #(oid, o)
        }),
      )
      #(apps, dict.from_list(opps))
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(#(apps, opps)) ->
      http.json(
        200,
        json.array(apps, fn(a) {
          let opportunity = case dict.get(opps, a.row.opportunity_id) {
            Ok(Some(o)) ->
              json.object([
                #("id", id.opportunity_json(o.row.id)),
                #("title", json.string(o.row.title)),
                #("orgName", json.string(o.row.org_name)),
                #("type", opportunity_row.type_to_json(o.row.type_)),
                #("deadline", json.string(o.row.deadline)),
              ])
            _ -> json.object([])
          }
          json.object(
            list.append(view_fields(a), [#("opportunity", opportunity)]),
          )
        }),
      )
  }
}

/// `GET /player/applications`.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  mine(ctx, [p.player.row.id])
}

/// `GET /guardian/applications`: every child's.
pub fn guardian_list(ctx: Ctx, g: Guardian) -> Response {
  mine(ctx, g.child_ids)
}

// ------------------------------------------------------------------------------------------------- withdrawing

/// `POST /player/applications/:id/withdraw`.
pub fn player_withdraw(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  aid: id.ApplicationId,
) -> Response {
  case p.minor {
    True -> http.error(403, "GUARDIAN_MANAGED")
    False ->
      withdraw(
        ctx,
        req,
        [p.player.row.id],
        Actor(
          party.Player,
          id.player_to_string(p.player.row.id),
          p.player.row.name,
        ),
        aid,
      )
  }
}

/// `POST /guardian/applications/:id/withdraw`: recorded as the guardian's act.
pub fn guardian_withdraw(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  aid: id.ApplicationId,
) -> Response {
  withdraw(
    ctx,
    req,
    g.child_ids,
    Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name),
    aid,
  )
}

fn withdraw(
  ctx: Ctx,
  req: Request,
  allowed: List(id.PlayerId),
  actor: Actor,
  aid: id.ApplicationId,
) -> Response {
  use _req <- http.rerun_on_stale(req)
  case store.read(ctx.store, by_id(_, aid)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(a)) ->
      case list.contains(allowed, a.row.player_id), a.row.status {
        False, _ -> http.error(404, "APPLICATION_NOT_FOUND")
        True, row.Submitted -> {
          let now = clock.now_ms()
          store.unit(ctx.store, fn(tx) {
            use changed <- result.try(store.write(
              tx,
              "UPDATE applications SET status = 'withdrawn' WHERE id = ? AND status = 'submitted' RETURNING id",
              [id.application_sql(aid)],
              decode.at([0], decode.string),
            ))
            use <- store_guard(changed != [], "an outstanding application")
            use _ <- result.try(log(
              tx,
              aid,
              by_kind(actor.kind),
              actor.id,
              actor.name,
              "withdrawn",
              now,
            ))
            use a <- result.map(reread(tx, aid))
            http.json(200, answer_with(a))
          })
          |> finished
        }
        True, status ->
          http.json(
            409,
            json.object([
              #("error", json.string("NOT_WITHDRAWABLE")),
              #("status", row.status_to_json(status)),
            ]),
          )
      }
    Ok(None) -> http.error(404, "APPLICATION_NOT_FOUND")
  }
}

// ------------------------------------------------------------------------------------------------- the club

type ListQuery {
  ListQuery(limit: Option(Int), offset: Option(Int))
}

/// `GET /org/opportunities/:id/applications`: oldest first, by offset.
pub fn list_for_opportunity(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  oid: id.OpportunityId,
) -> Response {
  case store.read(ctx.store, opportunity_by_id(_, oid)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(o)) if o.row.org_id == a.org.id -> {
      let shape = {
        use limit <- input.field(
          "limit",
          input.optional(input.whole_number_text(1, 200)),
        )
        use offset <- input.field(
          "offset",
          input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
        )
        input.done(ListQuery(limit:, offset:))
      }
      use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
      let limit = option.unwrap(q.limit, 50)
      let offset = option.unwrap(q.offset, 0)
      let found =
        store.read(ctx.store, fn(read) {
          use total <- result.try(store.one(
            read,
            "SELECT COUNT(*) FROM applications WHERE opportunity_id = ?",
            [id.opportunity_sql(oid)],
            decode.at([0], decode.int),
          ))
          use items <- result.map(
            query(
              read,
              "WHERE opportunity_id = ? ORDER BY rowid LIMIT ? OFFSET ?",
              [id.opportunity_sql(oid), sqlight.int(limit), sqlight.int(offset)],
            ),
          )
          #(result.unwrap(total, 0), items)
        })
      case found {
        Error(failure) -> http.internal(failure)
        Ok(#(total, items)) ->
          http.json(
            200,
            json.object([
              #("total", json.int(total)),
              #("limit", json.int(limit)),
              #("offset", json.int(offset)),
              #("items", json.array(items, view)),
            ]),
          )
      }
    }
    Ok(_) -> http.error(404, "OPPORTUNITY_NOT_FOUND")
  }
}

type Outcome {
  Outcome(decision: row.Status, note: Option(String))
}

/// `POST /org/applications/:id/outcome`: the club answers once, and the family hears it.
pub fn outcome(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  aid: id.ApplicationId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, by_id(_, aid)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(a)) if a.row.org_id == access.org.id ->
      case a.row.outcome_at, a.row.status {
        Some(_), _ -> http.error(409, "ALREADY_RESOLVED")
        None, row.Withdrawn -> http.error(409, "WITHDRAWN")
        None, _ -> decide(ctx, req, access, a)
      }
    Ok(_) -> http.error(404, "APPLICATION_NOT_FOUND")
  }
}

fn decide(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  a: Application,
) -> Response {
  let shape = {
    use decision <- input.field(
      "decision",
      input.required(
        input.one_of_these(row.status_pairs, [row.Accepted, row.Declined]),
      ),
    )
    use note <- input.field("note", input.nullish(input.text(outcome_note_max)))
    input.done(Outcome(decision:, note: or_none(note)))
  }
  use b <- http.body(req, shape, [#("decision", "DECISION_INVALID")])
  use <- moderated(
    ctx,
    b.note,
    "application_outcome",
    a.row.player_id,
    access.org.id,
  )
  let now = clock.now_ms()
  let decision = row.status_to_string(b.decision)
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use p <- result.try(players.by_id(read, a.row.player_id))
    use o <- result.try(opportunity_by_id(read, a.row.opportunity_id))
    use changed <- result.try(store.write(
      tx,
      "UPDATE applications SET status = ?, outcome_note = ?, outcome_by_user_id = ?, outcome_by_name = ?, outcome_at = ? WHERE id = ? AND status = 'submitted' RETURNING id",
      [
        sqlight.text(decision),
        sqlight.nullable(sqlight.text, b.note),
        id.org_user_sql(access.user.id),
        sqlight.text(evidence.stored_name(access.user.name)),
        sqlight.int(now),
        id.application_sql(a.row.id),
      ],
      decode.at([0], decode.string),
    ))
    use <- store_guard(changed != [], "an outstanding application")
    use _ <- result.try(log(
      tx,
      a.row.id,
      history_row.Org,
      id.org_user_to_string(access.user.id),
      access.user.name,
      decision,
      now,
    ))
    // `undefined` when the opportunity is gone, as the TypeScript server prints it.
    let title = case o {
      Some(o) -> o.row.title
      None -> "undefined"
    }
    let text = case b.decision {
      row.Accepted ->
        "✅ "
        <> access.org.name
        <> " accepted the application to \""
        <> title
        <> "\". They'll follow up through ScoutBox."
      _ ->
        access.org.name
        <> " on your application: "
        <> option.unwrap(b.note, "not this time — keep playing, keep logging.")
    }
    let to = case p {
      Some(p) ->
        case players.is_adult(p, now), p.row.guardian_id {
          False, Some(gid) ->
            Some(#(audience.Guardian, id.guardian_to_string(gid)))
          _, _ -> Some(#(audience.Player, id.player_to_string(p.row.id)))
        }
      None -> None
    }
    use _ <- result.try(case to {
      Some(#(kind, who)) ->
        notifications.notify(
          tx,
          to: kind,
          id: who,
          type_: "application",
          text:,
          ref_id: Some(id.application_to_string(a.row.id)),
          at: now,
        )
      None -> Ok(Nil)
    })
    store.emit(
      tx,
      effect.Live(live_event.Applications(id.player_to_string(a.row.player_id))),
    )
    use fresh <- result.map(reread(tx, a.row.id))
    http.json(200, answer_with(fresh))
  })
  |> finished
}

/// `POST /org/opportunities/:id/close`: refused while any applicant waits for an answer (no ghosting). Closing twice
/// keeps the first close.
pub fn close(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  oid: id.OpportunityId,
) -> Response {
  use _req <- http.rerun_on_stale(req)
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use found <- result.try(opportunity_by_id(read, oid))
    case found {
      Some(o) if o.row.org_id == access.org.id -> {
        use counts <- result.try(opportunities.application_counts(read, [oid]))
        let #(_, outstanding) = dict.get(counts, oid) |> result.unwrap(#(0, 0))
        case outstanding, o.row.status {
          0, opportunity_row.Closed -> Ok(opportunity_answer(o))
          0, _ -> {
            use _ <- result.try(
              store.run(
                tx,
                "UPDATE opportunities SET status = 'closed', closed_at = ? WHERE id = ?",
                [sqlight.int(now), id.opportunity_sql(oid)],
              ),
            )
            use closed <- result.try(opportunity_by_id(read, oid))
            case closed {
              Some(c) -> Ok(opportunity_answer(c))
              None -> store.stale("opportunity")
            }
          }
          n, _ ->
            Ok(http.json(
              409,
              json.object([
                #("error", json.string("OUTCOMES_OUTSTANDING")),
                #("count", json.int(n)),
                #(
                  "message",
                  json.string(
                    "Every applicant gets an answer before the door closes.",
                  ),
                ),
              ]),
            ))
        }
      }
      _ -> Ok(http.error(404, "OPPORTUNITY_NOT_FOUND"))
    }
  })
  |> finished
}

fn opportunity_answer(o: opportunities.Opportunity) -> Response {
  http.json(
    200,
    json.object([#("opportunity", json.object(opportunities.fields(o)))]),
  )
}
