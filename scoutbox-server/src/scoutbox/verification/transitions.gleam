//// Consent-based academy transitions (domains/verification/transitions.mjs; `transition_cases` and its pack items,
//// grants and history). Nothing is visible to a club without an explicit, revocable, expiring grant; nothing about
//// a player is labelled "released"; agencies never receive transition packs.
////
//// Not ported yet: the case lists, withdrawing and placing a case, the club's side (its list and the pack view),
//// the expiry and follow-up sweep, and the admin's level review.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/integrations/webhooks
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/transition_case_history as history_row
import scoutbox/rows/transition_case_pack_items as item_row
import scoutbox/rows/transition_case_recipients as recipient_row
import scoutbox/rows/transition_cases as row
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import scoutbox/vocab/party.{type Party}
import scoutbox/vocab/webhook_event
import sqlight
import wisp.{type Request, type Response}

const day = 86_400_000

const name_max = 200

const pack_max = 100

pub type Case {
  Case(
    row: row.Row,
    items: List(item_row.Row),
    recipients: List(recipient_row.Row),
    history: List(history_row.Row),
  )
}

type Actor {
  Actor(kind: Party, id: String, name: String)
}

/// Names come from other domains (no length limit at sign-up), so they are shortened rather than refused.
fn clip(name: String) -> String {
  input.utf16_take(name, name_max)
}

// ------------------------------------------------------------------------------------------------- storage

fn by_id(read: Read, id: id.TransitionCaseId) -> Result(Option(Case), Fail(e)) {
  let args = [id.transition_case_sql(id)]
  use found <- result.try(store.one(
    read,
    "SELECT " <> row.columns <> " FROM transition_cases WHERE id = ?",
    args,
    row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(r) -> {
      use items <- result.try(store.query(
        read,
        "SELECT "
          <> item_row.columns
          <> " FROM transition_case_pack_items WHERE transition_case_id = ? ORDER BY item_kind, ord",
        args,
        item_row.decoder(),
      ))
      use recipients <- result.try(store.query(
        read,
        "SELECT "
          <> recipient_row.columns
          <> " FROM transition_case_recipients WHERE transition_case_id = ? ORDER BY ord",
        args,
        recipient_row.decoder(),
      ))
      use history <- result.map(store.query(
        read,
        "SELECT "
          <> history_row.columns
          <> " FROM transition_case_history WHERE transition_case_id = ? ORDER BY rowid",
        args,
        history_row.decoder(),
      ))
      Some(Case(r, items, recipients, history))
    }
  }
}

fn record(
  tx: Tx,
  case_id: id.TransitionCaseId,
  actor: Actor,
  action: history_row.Action,
  items: Option(Int),
  org_id: Option(id.OrgId),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use id <- result.try(id.next_transition_event(tx))
  history_row.insert(
    tx,
    history_row.Row(
      ..history_row.new(
        id:,
        transition_case_id: case_id,
        at:,
        by_kind: case actor.kind {
          party.Player -> history_row.Player
          party.Guardian -> history_row.Guardian
        },
        by_id: actor.id,
        action:,
      ),
      by_name: Some(clip(actor.name)),
      detail_items: items,
      detail_org_id: org_id,
    ),
  )
}

/// The first current staff member of an organisation: who hears about its grants.
fn first_staff(
  read: Read,
  org_id: id.OrgId,
) -> Result(Option(id.OrgUserId), Fail(e)) {
  store.one(
    read,
    "SELECT id FROM org_users WHERE org_id = ? AND removed_at IS NULL ORDER BY rowid LIMIT 1",
    [id.org_sql(org_id)],
    decode.at([0], id.org_user_decoder()),
  )
  |> result.map(option.from_result)
}

// ------------------------------------------------------------------------------------------------- views

fn recipient_view(r: recipient_row.Row) -> Json {
  let opt = json.nullable(_, json.int)
  json.object([
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.nullable(r.org_name, json.string)),
    #("grantedAt", json.int(r.granted_at)),
    #("expiresAt", json.int(r.expires_at)),
    #("revokedAt", opt(r.revoked_at)),
    #("viewedAt", opt(r.viewed_at)),
  ])
}

fn case_view(c: Case) -> Json {
  let t = c.row
  let opt = json.nullable(_, json.string)
  let started =
    json.object([
      #("kind", party.to_json(t.started_by_kind)),
      #("id", json.string(t.started_by_id)),
      #("name", opt(t.started_by_name)),
    ])
  let items_of = fn(kind) {
    list.filter(c.items, fn(i) { i.item_kind == kind })
    |> list.map(fn(i) { i.item_id })
    |> json.array(json.string)
  }
  json.object([
    #("id", id.transition_case_json(t.id)),
    #("playerId", id.player_json(t.player_id)),
    #("playerName", opt(t.player_name)),
    #("startedBy", started),
    #("caseOwner", started),
    #("note", opt(t.note)),
    #(
      "pack",
      json.object([
        #("mediaIds", items_of(item_row.Media)),
        #("evidenceIds", items_of(item_row.Evidence)),
        #("feedbackIds", items_of(item_row.Feedback)),
      ]),
    ),
    #("periodEndsAt", json.int(t.period_ends_at)),
    #("recipients", json.array(c.recipients, recipient_view)),
    #("status", row.status_to_json(t.status)),
    #("placement", case t.placement_org_id, t.placement_at {
      Some(org_id), Some(at) ->
        json.object([
          #("orgId", id.org_json(org_id)),
          #("orgName", opt(t.placement_org_name)),
          #("at", json.int(at)),
          #("note", opt(t.placement_note)),
        ])
      _, _ -> json.null()
    }),
    #("followUp", case t.follow_up_due_at {
      Some(due) ->
        json.object([
          #("dueAt", json.int(due)),
          #("notifiedAt", json.nullable(t.follow_up_notified_at, json.int)),
        ])
      None -> json.null()
    }),
    #("createdAt", json.int(t.created_at)),
    #(
      "history",
      json.array(c.history, fn(h) {
        json.object([
          #("id", id.transition_event_json(h.id)),
          #("at", json.int(h.at)),
          #("byKind", history_row.by_kind_to_json(h.by_kind)),
          #("byId", json.string(h.by_id)),
          #("byName", opt(h.by_name)),
          #("action", history_row.action_to_json(h.action)),
          #("detail", case h.detail_items, h.detail_org_id {
            Some(n), _ -> json.object([#("items", json.int(n))])
            None, Some(org_id) -> json.object([#("orgId", id.org_json(org_id))])
            None, None -> json.null()
          }),
        ])
      }),
    ),
  ])
}

// ------------------------------------------------------------------------------------------------- opening

type Selection {
  Selection(
    media_ids: List(id.MediaId),
    evidence_ids: List(String),
    feedback_ids: List(String),
  )
}

type NewCase {
  NewCase(
    pack: Option(Selection),
    note: Option(String),
    period_days: Option(Int),
  )
}

fn new_case_shape() -> input.Shape(NewCase) {
  let ids = fn() { input.nullish(input.list_of(input.id(), pack_max)) }
  let pack = {
    use media_ids <- input.field("mediaIds", ids())
    use evidence_ids <- input.field("evidenceIds", ids())
    use feedback_ids <- input.field("feedbackIds", ids())
    input.done(Selection(
      media_ids: option.unwrap(media_ids, []) |> list.map(id.media),
      evidence_ids: option.unwrap(evidence_ids, []),
      feedback_ids: option.unwrap(feedback_ids, []),
    ))
  }
  use pack <- input.field("pack", input.nullish(input.object(pack)))
  use note <- input.field("note", input.nullish(input.text(500)))
  use period_days <- input.field(
    "periodDays",
    input.nullish(input.whole_number(14, 180)),
  )
  input.done(NewCase(pack:, note:, period_days:))
}

/// Only records the player side owns or was given: club-private material cannot ride along, and of an assessment
/// only published feedback crosses. Ids the player does not own are dropped.
fn build_pack(
  read: Read,
  player: Player,
  sel: Selection,
) -> Result(Selection, Fail(e)) {
  let p = player.row.id
  let media =
    list.unique(sel.media_ids)
    |> list.filter(fn(id) { list.any(player.media, fn(m) { m.clip.id == id }) })
  use evidence <- result.try(owned(
    read,
    "SELECT id FROM evidence WHERE player_id = ? AND superseded_by_id IS NULL AND id IN (SELECT value FROM json_each(?))",
    p,
    sel.evidence_ids,
  ))
  use feedback <- result.map(owned(
    read,
    "SELECT id FROM assessments WHERE player_id = ? AND published_feedback_text IS NOT NULL AND id IN (SELECT value FROM json_each(?))",
    p,
    sel.feedback_ids,
  ))
  Selection(media_ids: media, evidence_ids: evidence, feedback_ids: feedback)
}

/// The ids of `wanted` the query finds, in the order asked for.
fn owned(
  read: Read,
  sql: String,
  player_id: id.PlayerId,
  wanted: List(String),
) -> Result(List(String), Fail(e)) {
  use found <- result.map(store.query(
    read,
    sql,
    [
      id.player_sql(player_id),
      json.array(wanted, json.string) |> json.to_string |> sqlight.text,
    ],
    decode.at([0], decode.string),
  ))
  list.unique(wanted) |> list.filter(list.contains(found, _))
}

fn open(ctx: Ctx, req: Request, player: Player, actor: Actor) -> Response {
  use body <- http.body(req, new_case_shape(), [])
  let note = case body.note {
    Some("") -> None
    other -> other
  }
  let period = option.unwrap(body.period_days, 90)
  let selection = option.unwrap(body.pack, Selection([], [], []))
  case store.read(ctx.store, build_pack(_, player, selection)) {
    Error(failure) -> http.internal(failure)
    Ok(Selection([], [], [])) ->
      http.error_message(
        400,
        "PACK_EMPTY",
        "Select at least one item you own (your media, your evidence passport records, or feedback published to you). Club-private reports cannot be included without the club publishing them to you first.",
      )
    Ok(pack) -> {
      let now = clock.now_ms()
      let opened =
        store.unit(ctx.store, fn(tx) {
          use id <- result.try(id.next_transition_case(tx))
          use _ <- result.try(row.insert(
            tx,
            row.Row(
              ..row.new(
                id:,
                player_id: player.row.id,
                started_by_kind: actor.kind,
                started_by_id: actor.id,
                period_ends_at: now + period * day,
                status: row.Open,
                created_at: now,
              ),
              player_name: Some(clip(player.row.name)),
              started_by_name: Some(clip(actor.name)),
              note:,
            ),
          ))
          let items =
            list.flatten([
              // `item_id` is polymorphic text: `kind` says what it is.
              list.map(pack.media_ids, fn(i) {
                #(item_row.Media, id.media_to_string(i))
              }),
              list.map(pack.evidence_ids, fn(i) { #(item_row.Evidence, i) }),
              list.map(pack.feedback_ids, fn(i) { #(item_row.Feedback, i) }),
            ])
          use _ <- result.try(
            list.try_each(
              [item_row.Media, item_row.Evidence, item_row.Feedback],
              fn(kind) {
                list.filter(items, fn(i) { i.0 == kind })
                |> list.index_map(fn(i, ord) { #(i.1, ord) })
                |> list.try_each(fn(p) {
                  item_row.insert(tx, item_row.new(id, kind, p.1, p.0))
                })
              },
            ),
          )
          use _ <- result.try(record(
            tx,
            id,
            actor,
            history_row.Opened,
            Some(list.length(items)),
            None,
            now,
          ))
          use found <- result.map(by_id(store.reading(tx), id))
          let assert Some(c) = found
            as "a transition case reads back in its unit"
          c
        })
      case opened {
        Ok(c) ->
          http.json(
            201,
            json.object([
              #("transition", case_view(c)),
              #(
                "note",
                json.string(
                  "Nothing is shared yet. Add each receiving club yourself — every grant is individual, expiring and revocable. Your level and profile are unchanged: a transition never re-labels you.",
                ),
              ),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `POST /player/transitions`.
pub fn player_open(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "A transition case for an under-18 is opened and controlled by the parent/guardian.",
      )
    False ->
      open(
        ctx,
        req,
        p.player,
        Actor(
          party.Player,
          id.player_to_string(p.player.row.id),
          p.player.row.name,
        ),
      )
  }
}

/// `POST /guardian/children/:id/transitions`.
pub fn guardian_open(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Error(failure) -> http.internal(failure)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Ok(Some(child)) ->
          open(
            ctx,
            req,
            child,
            Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name),
          )
      }
  }
}

// ------------------------------------------------------------------------------------------------- grants

/// Who may act on a case: the adult player whose case it is, or the guardian of the child.
pub type Owner {
  PlayerOwner(PlayerAccess)
  GuardianOwner(Guardian)
}

fn actor_of(owner: Owner) -> Actor {
  case owner {
    PlayerOwner(p) ->
      Actor(
        party.Player,
        id.player_to_string(p.player.row.id),
        p.player.row.name,
      )
    GuardianOwner(g) ->
      Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name)
  }
}

fn owned_case(
  ctx: Ctx,
  owner: Owner,
  id: id.TransitionCaseId,
  next: fn(Case) -> Response,
) {
  case store.read(ctx.store, by_id(_, id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "TRANSITION_NOT_FOUND")
    Ok(Some(c)) -> {
      let ok = case owner {
        PlayerOwner(p) -> c.row.player_id == p.player.row.id && !p.minor
        GuardianOwner(g) -> list.contains(g.child_ids, c.row.player_id)
      }
      case ok {
        True -> next(c)
        False -> http.error(403, "NOT_YOUR_CASE")
      }
    }
  }
}

type Grant {
  Grant(org_id: id.OrgId, days: Option(Int))
}

/// `POST /…/:id/recipients`: one club, for a number of days within the case's period.
pub fn add_recipient(
  ctx: Ctx,
  req: Request,
  owner: Owner,
  id: id.TransitionCaseId,
) -> Response {
  use c <- owned_case(ctx, owner, id)
  let now = clock.now_ms()
  let closed = fn(status) {
    http.json(
      409,
      json.object([
        #("error", json.string("CASE_CLOSED")),
        #("status", json.string(status)),
      ]),
    )
  }
  case c.row.status, c.row.period_ends_at <= now {
    row.Open, False -> {
      let shape = {
        use org_id <- input.field("orgId", input.required(input.id()))
        use days <- input.field(
          "days",
          input.nullish(input.whole_number(1, 90)),
        )
        input.done(Grant(org_id: id.org(org_id), days:))
      }
      use body <- http.body(req, shape, [])
      grant(ctx, c, actor_of(owner), body, now)
    }
    // The sweep may not have marked the case expired yet.
    row.Open, True -> closed("expired")
    status, _ -> closed(row.status_to_string(status))
  }
}

type GrantRefusal {
  AlreadyGranted
}

fn grant(ctx: Ctx, c: Case, actor: Actor, body: Grant, now: Int) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use org <- result.try(orgs.by_id(read, body.org_id))
      case org {
        None -> Ok(None)
        Some(org) -> {
          use seen <- result.map(players.for_org(
            read,
            c.row.player_id,
            org,
            now,
          ))
          Some(
            #(org, case seen {
              Some(#(_, a)) -> a.visible && !a.blocked
              None -> False
            }),
          )
        }
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "ORG_NOT_FOUND")
    Ok(Some(#(org, _))) if org.type_ == org_type.Agency ->
      http.error_message(
        403,
        "AGENCIES_EXCLUDED",
        "Transition packs go to clubs, never agencies.",
      )
    Ok(Some(#(_, False))) ->
      http.error_message(
        403,
        "RECIPIENT_NOT_ELIGIBLE",
        "That club cannot currently see this player (verification, level or distance rules) — a transition grant never overrides eligibility.",
      )
    Ok(Some(#(org, True))) -> {
      let r =
        recipient_row.Row(
          ..recipient_row.new(
            transition_case_id: c.row.id,
            ord: list.length(c.recipients),
            org_id: org.id,
            granted_at: now,
            expires_at: int_min(
              now + option.unwrap(body.days, 30) * day,
              c.row.period_ends_at,
            ),
          ),
          org_name: Some(clip(org.name)),
        )
      let granted =
        store.unit(ctx.store, fn(tx) {
          let read = store.reading(tx)
          use active <- result.try(
            store.one(
              read,
              "SELECT COUNT(*) FROM transition_case_recipients WHERE transition_case_id = ? AND org_id = ? AND revoked_at IS NULL AND expires_at > ?",
              [
                id.transition_case_sql(c.row.id),
                id.org_sql(org.id),
                sqlight.int(now),
              ],
              decode.at([0], decode.int),
            )
            |> result.map(result.unwrap(_, 0)),
          )
          case active > 0 {
            True -> store.refuse(AlreadyGranted)
            False -> {
              use ord <- result.try(
                store.one(
                  read,
                  "SELECT COALESCE(MAX(ord) + 1, 0) FROM transition_case_recipients WHERE transition_case_id = ?",
                  [id.transition_case_sql(c.row.id)],
                  decode.at([0], decode.int),
                )
                |> result.map(result.unwrap(_, 0)),
              )
              let r = recipient_row.Row(..r, ord:)
              use _ <- result.try(recipient_row.insert(tx, r))
              use _ <- result.try(record(
                tx,
                c.row.id,
                actor,
                history_row.RecipientAdded,
                None,
                Some(org.id),
                now,
              ))
              use _ <- result.try(webhooks.emit(
                tx,
                Some(org.id),
                webhook_event.TransitionGranted,
                id.transition_case_to_string(c.row.id),
                now,
              ))
              use staff <- result.try(first_staff(read, org.id))
              use _ <- result.map(case staff {
                Some(uid) ->
                  notifications.notify(
                    tx,
                    to: audience.OrgUser,
                    id: id.org_user_to_string(uid),
                    type_: "transition",
                    text: "📦 A player has shared a transition evidence pack with "
                      <> org.name
                      <> ". Open Transitions to review it.",
                    ref_id: Some(id.transition_case_to_string(c.row.id)),
                    at: now,
                  )
                None -> Ok(Nil)
              })
              r
            }
          }
        })
      case granted {
        Ok(r) ->
          http.json(201, json.object([#("recipient", recipient_view(r))]))
        Error(store.Refused(AlreadyGranted)) ->
          http.error(409, "ALREADY_GRANTED")
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

fn int_min(a: Int, b: Int) -> Int {
  case a < b {
    True -> a
    False -> b
  }
}

/// `POST /…/:id/revoke-recipient`: the club's platform access ends, and it is asked to delete its copies.
pub fn revoke_recipient(
  ctx: Ctx,
  req: Request,
  owner: Owner,
  id: id.TransitionCaseId,
) -> Response {
  use c <- owned_case(ctx, owner, id)
  let shape = {
    use org_id <- input.field("orgId", input.required(input.id()))
    input.done(id.org(org_id))
  }
  use org_id <- http.body(req, shape, [])
  case
    list.find(c.recipients, fn(r) { r.org_id == org_id && r.revoked_at == None })
  {
    Error(Nil) -> http.error(404, "RECIPIENT_NOT_FOUND")
    Ok(r) -> {
      let now = clock.now_ms()
      let revoked =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE transition_case_recipients SET revoked_at = ? WHERE transition_case_id = ? AND ord = ? AND revoked_at IS NULL",
              [
                sqlight.int(now),
                id.transition_case_sql(c.row.id),
                sqlight.int(r.ord),
              ],
            ),
          )
          use _ <- result.try(record(
            tx,
            c.row.id,
            actor_of(owner),
            history_row.RecipientRevoked,
            None,
            Some(r.org_id),
            now,
          ))
          use _ <- result.try(webhooks.emit(
            tx,
            Some(r.org_id),
            webhook_event.TransitionRevoked,
            id.transition_case_to_string(c.row.id),
            now,
          ))
          use staff <- result.try(first_staff(store.reading(tx), r.org_id))
          use _ <- result.map(case staff {
            Some(uid) ->
              notifications.notify_action(
                tx,
                to: audience.OrgUser,
                id: id.org_user_to_string(uid),
                type_: "transition",
                text: "A transition evidence pack shared with "
                  <> option.unwrap(r.org_name, "null")
                  <> " was withdrawn. Platform access has ended; anything your staff already downloaded is outside the platform and cannot be remotely erased — please delete local copies.",
                ref_id: Some(id.transition_case_to_string(c.row.id)),
                deadline: Some(now + 7 * day),
                at: now,
              )
            None -> Ok(Nil)
          })
          recipient_row.Row(..r, revoked_at: Some(now))
        })
      case revoked {
        Ok(r) ->
          http.json(
            200,
            json.object([
              #("recipient", recipient_view(r)),
              #(
                "honest",
                json.string(
                  "Future platform access is revoked. Already-downloaded copies cannot be remotely erased — the withdrawal notice asks the club to delete them.",
                ),
              ),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}
