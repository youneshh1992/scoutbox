//// A club's reads and marks on one player: the profile, internal scouting notes, saves and shortlists, and the
//// shortlist itself (domains/discovery/search.mjs). A player who blocked the organisation reads as absent on every
//// one of them, and every profile view is on the Discovery Ledger.

import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/insight/review_queue
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rules/visibility.{type Access}
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/vocab/org_type
import wisp.{type Request, type Response}

const note_max = 2000

fn with_player(
  ctx: Ctx,
  a: OrgAccess,
  id: id.PlayerId,
  now: Int,
  next: fn(Player, Access) -> Response,
) -> Response {
  case store.read(ctx.store, players.for_org(_, id, a.org, now)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> not_found()
    Ok(Some(#(p, access))) -> next(p, access)
  }
}

fn not_found() -> Response {
  http.error(404, "PLAYER_NOT_FOUND")
}

/// A ledger row for the player by this staff member; returns its id.
fn append(
  ctx: Ctx,
  a: OrgAccess,
  p: Player,
  type_: ledger_row.Type,
  now: Int,
) -> Result(id.LedgerEntryId, store.UnitError(e)) {
  store.unit(ctx.store, fn(tx) {
    use id <- result.map(ledger.append(
      tx,
      ledger.Entry(
        entry_type: type_,
        player_id: Some(p.row.id),
        org_id: Some(a.org.id),
        org_name: Some(a.org.name),
        user_id: Some(a.user.id),
        actor_name: Some(a.user.name),
      ),
      now,
    ))
    id
  })
}

/// `GET /org/players/:id`.
pub fn profile(ctx: Ctx, a: OrgAccess, id: id.PlayerId) -> Response {
  let now = clock.now_ms()
  use p, access <- with_player(ctx, a, id, now)
  case access.visible, access.blocked {
    False, _ -> {
      // Agencies never see minors; unverified clubs don't either.
      let #(code, message) = case a.org.type_ {
        org_type.Agency -> #(
          "UNDER_18_WALL",
          "Agency accounts cannot view minors.",
        )
        org_type.Club -> #(
          "VERIFIED_CLUBS_ONLY",
          "Under-18 profiles are visible to verified clubs only. Complete club verification to continue.",
        )
      }
      http.error_message(403, code, message)
    }
    True, True -> not_found()
    True, False ->
      case append(ctx, a, p, ledger_row.View, now) {
        Error(failure) -> http.internal(failure)
        Ok(_) ->
          case store.read(ctx.store, audit.notes_for(_, a.org.id, p.row.id)) {
            Error(failure) -> http.internal(failure)
            Ok(notes) -> {
              use <- exposed(ctx, a, p.row.id)
              http.json(
                200,
                json.object(
                  list.append(players.org_fields(p, a.org, access, now), [
                    #("orgNotes", json.array(notes, audit.note_view)),
                    #(
                      "similarPlayers",
                      json.object([
                        #(
                          "note",
                          json.string(
                            "Statistical similarity — a lead, not a verdict.",
                          ),
                        ),
                        // Not ported yet: "more like this" and the archetypes are discovery's matching.
                        #("players", json.preprocessed_array([])),
                        #("archetypes", json.preprocessed_array([])),
                      ]),
                    ),
                  ]),
                ),
              )
            }
          }
      }
  }
}

/// A profile the club was shown is exposure (the review queue's source), recorded once it has answered.
fn exposed(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
  view: fn() -> Response,
) {
  let response = view()
  review_queue.record_exposure(
    ctx,
    a.org.id,
    player_id,
    review_queue.ProfileView,
  )
  response
}

/// `POST /org/players/:id/notes`: shared inside the organisation only.
pub fn add_note(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  id: id.PlayerId,
) -> Response {
  let now = clock.now_ms()
  use p, access <- with_player(ctx, a, id, now)
  case access.visible && !access.blocked {
    False -> not_found()
    True -> {
      let shape = {
        use text <- input.field("text", input.nullish(input.text(note_max)))
        input.done(text)
      }
      use text <- http.body(req, shape, [])
      case input.filled(text) {
        None -> http.required("TEXT_REQUIRED", "text")
        Some(text) -> {
          let added =
            store.unit(ctx.store, fn(tx) {
              audit.add_note(
                tx,
                org_id: a.org.id,
                player_id: p.row.id,
                user_id: a.user.id,
                scout_name: a.user.name,
                text:,
                at: now,
              )
            })
          case added {
            Ok(note) -> http.json(201, audit.note_view(note))
            Error(failure) -> http.internal(failure)
          }
        }
      }
    }
  }
}

/// `POST /org/players/:id/save` and `/shortlist`: a mark on the ledger.
pub fn mark(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  id: id.PlayerId,
  type_: ledger_row.Type,
) -> Response {
  let now = clock.now_ms()
  use p, access <- with_player(ctx, a, id, now)
  case access.blocked, access.visible {
    True, _ -> not_found()
    False, False -> http.error(403, "UNDER_18_WALL")
    False, True -> {
      use Nil <- http.body(req, input.nothing(), [])
      case append(ctx, a, p, type_, now) {
        Ok(ledger_id) ->
          http.json(
            201,
            json.object([
              #("ok", json.bool(True)),
              #("ledgerId", id.ledger_entry_json(ledger_id)),
            ]),
          )
        Error(failure) -> http.internal(failure)
      }
    }
  }
}

/// `GET /org/shortlist`: in the order the club first shortlisted them. A player who has deleted their account,
/// or may no longer be seen, is left out; the ledger row stays.
pub fn shortlist(ctx: Ctx, a: OrgAccess) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use ids <- result.try(ledger.shortlisted_by(read, a.org.id))
      players.for_org_many(read, ids, a.org, now)
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(rows) ->
      http.json(
        200,
        json.preprocessed_array(
          list.filter_map(rows, fn(r) {
            players.org_view(r.0, a.org, r.1, now) |> option.to_result(Nil)
          }),
        ),
      )
  }
}
