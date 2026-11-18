//// The evidence Passport's routes (domains/scouting/passport.mjs): claims filed by the player, a guardian or a
//// club, corrections that supersede without erasing, corroboration by a club or one of its confirmed coaches,
//// disputes and Trust & Safety's resolution of them. Reliability is a property of how a claim was checked, never
//// of how often someone opens the app, and "insufficient evidence" is a display state of its own.

import gleam/dict
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/rows/evidence as row
import scoutbox/rows/evidence_disputes as dispute_row
import scoutbox/rows/evidence_history as history_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/scouting/coaches
import scoutbox/scouting/evidence.{type Evidence, Claim, Source}
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import wisp.{type Request, type Response}

const label_max = 120

const value_text_max = 120

const units_max = 20

const season_max = 20

const note_max = 300

const method_max = 80

const reason_max = 300

const resolution_note_max = 300

const media_per_claim = 50

// --------------------------------------------------------------------------------------- the Passport

/// The records and the honest relabelling of every other "verified" surface. Reliability is not ability: nothing
/// here scores the player.
fn compose(read: Read, p: Player, now: Int) -> Result(Json, Fail(e)) {
  use records <- result.map(evidence.for_player(read, p.row.id))
  let legacy =
    list.flatten([
      list.filter_map(p.attendance, fn(a) {
        case a.corroborated_by {
          None -> Error(Nil)
          Some(by) ->
            Ok(
              json.object([
                #("kind", json.string("attendance")),
                #("label", json.string(trim("Match attendance " <> a.fixture))),
                #("tier", json.string("club_assessed")),
                #("method", json.string("match-day roster credited by " <> by)),
                #("at", json.string(a.match_date)),
              ]),
            )
        }
      }),
      list.map(players.published_vouches(p), fn(v) {
        json.object([
          #("kind", json.string("reference")),
          #(
            "label",
            json.string(
              "Reference from " <> v.coach_name <> " (" <> v.role <> ")",
            ),
          ),
          #("tier", json.string("coach_confirmed")),
          #("method", json.string("email_code")),
          #("identityVerified", json.bool(False)),
          #(
            "caveat",
            json.string(
              "Email-code reference: confirms mailbox control, not coach identity.",
            ),
          ),
          #(
            "conflictOfInterest",
            json.nullable(v.conflict_of_interest, json.string),
          ),
        ])
      }),
      list.map(p.drill_results, fn(r) {
        let label =
          "Combine drill "
          <> r.drill_id
          <> ": "
          <> json.to_string(json_text.number(r.value))
        json.object(
          list.append(
            [
              #("kind", json.string("assessment_result")),
              #("label", json.string(label)),
              #("tier", json.string("self_reported")),
              #(
                "method",
                json.string(case r.verified {
                  True -> "video_attached"
                  False -> "self_entry"
                }),
              ),
            ],
            case r.verified {
              True -> [
                #(
                  "caveat",
                  json.string(
                    "An attached video is not a verified measurement — no validated video-analysis capability exists.",
                  ),
                ),
              ]
              False -> []
            },
          ),
        )
      }),
    ])
  let active =
    list.filter(records, fn(e) {
      e.row.superseded_by_id == None && !expired(e, now)
    })
  // Tiers in the order the active records first reach them, as a JavaScript object keeps its keys.
  let by_tier =
    list.fold(active, #([], dict.new()), fn(acc, e) {
      let tier = row.verification_status_to_string(e.row.verification_status)
      let #(order, counts) = acc
      case dict.get(counts, tier) {
        Ok(n) -> #(order, dict.insert(counts, tier, n + 1))
        Error(Nil) -> #([tier, ..order], dict.insert(counts, tier, 1))
      }
    })
  let #(order, counts) = by_tier
  json.object([
    #("records", json.array(records, evidence.view(_, now))),
    #("legacy", json.preprocessed_array(legacy)),
    #(
      "summary",
      json.object([
        #("activeRecords", json.int(list.length(active))),
        #(
          "byTier",
          json.object(
            list.reverse(order)
            |> list.map(fn(t) {
              #(t, json.int(dict.get(counts, t) |> result.unwrap(0)))
            }),
          ),
        ),
        #(
          "corroborated",
          json.int(
            list.count(active, fn(e) {
              e.row.verification_status != row.SelfReported
            }),
          ),
        ),
        #(
          "insufficient",
          json.bool(list.length(active) + list.length(legacy) < 3),
        ),
        #(
          "note",
          json.string(
            "Provenance describes how each claim was checked — it is not a rating of football ability, and app usage frequency plays no part in it.",
          ),
        ),
      ]),
    ),
  ])
}

fn trim(s: String) -> String {
  string.trim(s)
}

fn expired(e: Evidence, now: Int) -> Bool {
  case e.row.expires_at {
    Some(at) -> at < now
    None -> False
  }
}

fn passport(ctx: Ctx, p: Player) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, compose(_, p, now)) {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/passport`.
pub fn player_passport(ctx: Ctx, p: PlayerAccess) -> Response {
  passport(ctx, p.player)
}

/// The guardian's child named in the path: refused when it is not theirs, 404 when the account is gone.
fn child(
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

/// `GET /guardian/children/:id/passport`.
pub fn guardian_passport(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use c <- child(ctx, g, child_id)
  passport(ctx, c)
}

/// `GET /org/players/:id/passport`: a view the Discovery Ledger records.
pub fn org_passport(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, players.for_org(_, player_id, a.org, now)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Ok(Some(#(p, access))) if !access.visible || access.blocked ->
      case a.org.type_ == org_type.Agency && !players.is_adult(p, now) {
        True -> http.error(403, "UNDER_18_WALL")
        False -> http.error(403, "NOT_VISIBLE")
      }
    Ok(Some(#(p, _))) -> {
      let answered =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(ledger.append(
            tx,
            ledger.Entry(
              entry_type: ledger_row.PassportView,
              player_id: Some(p.row.id),
              org_id: Some(a.org.id),
              org_name: Some(a.org.name),
              user_id: Some(a.user.id),
              actor_name: Some(a.user.name),
            ),
            now,
          ))
          compose(store.reading(tx), p, now)
        })
      case answered {
        Ok(body) -> http.json(200, body)
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}

// -------------------------------------------------------------------------------------------- claims

type NewClaim {
  NewClaim(
    claim_type: row.ClaimType,
    label: Option(String),
    value: Option(input.NumberOrText),
    units: Option(String),
    season: Option(String),
    note: Option(String),
    media_ids: Option(List(String)),
    observed_at: Option(Option(temporal.Due)),
    method: Option(String),
  )
}

fn claim_shape(club: Bool) -> input.Shape(NewClaim) {
  use claim_type <- input.field(
    "claimType",
    input.required(input.one_of(row.claim_type_pairs)),
  )
  use label <- input.field("label", input.nullish(input.text(label_max)))
  use value <- input.field(
    "value",
    input.nullish(input.number_or_text(value_text_max)),
  )
  use units <- input.field("units", input.nullish(input.text(units_max)))
  use season <- input.field("season", input.nullish(input.text(season_max)))
  use note <- input.field("note", input.nullish(input.text(note_max)))
  use media_ids <- input.field(
    "mediaIds",
    input.nullish(input.items(input.id(), media_per_claim)),
  )
  use observed_at <- input.field("observedAt", input.optional(input.due_date()))
  case club {
    True -> {
      use method <- input.field("method", input.nullish(input.text(method_max)))
      input.done(NewClaim(
        claim_type:,
        label:,
        value:,
        units:,
        season:,
        note:,
        media_ids:,
        observed_at:,
        method:,
      ))
    }
    False ->
      input.done(NewClaim(
        claim_type:,
        label:,
        value:,
        units:,
        season:,
        note:,
        media_ids:,
        observed_at:,
        method: None,
      ))
  }
}

fn context(kind: String, player_id: id.PlayerId) -> audit.Context {
  audit.Context(
    kind:,
    player_id: Some(player_id),
    org_id: None,
    user_id: None,
    channel_id: None,
    request_id: None,
  )
}

fn moderate_maybe(
  ctx: Ctx,
  text: Option(String),
  context: audit.Context,
  next: fn() -> Response,
) -> Response {
  case text {
    Some(t) -> moderate.or_refuse(ctx, t, context, next)
    None -> next()
  }
}

/// A claim about `p` filed by `source`, born at `tier`.
fn submit(
  ctx: Ctx,
  req: Request,
  p: Player,
  source: evidence.Source,
  tier: row.VerificationStatus,
  method: String,
  reviewer: Option(#(String, String)),
) -> Response {
  let now = clock.now_ms()
  use body <- http.body(req, claim_shape(source.kind == row.Org), [
    #("claimType", "CLAIM_TYPE_INVALID"),
  ])
  case input.filled(body.label) {
    None -> http.required("LABEL_REQUIRED", "label")
    Some(label) -> {
      let note = input.filled(body.note)
      use <- moderate_maybe(ctx, note, context("evidence_note", p.row.id))
      use <- moderate.or_refuse(ctx, label, context("evidence_label", p.row.id))
      // Evidence of something that has not happened is not evidence.
      let observed =
        option.map(option.flatten(body.observed_at), temporal.start)
      case observed {
        Some(ms) if ms > now + 5 * 60_000 ->
          http.json(
            400,
            json.object([
              #("error", json.string("DATE_INVALID")),
              #("field", json.string("observedAt")),
              #(
                "message",
                json.string("An observation cannot be dated in the future."),
              ),
            ]),
          )
        _ -> {
          let claim =
            Claim(
              claim_type: body.claim_type,
              label:,
              value: body.value,
              units: input.filled(body.units),
              season: input.filled(body.season),
              note:,
              media_ids: body.media_ids
                |> option.unwrap([])
                |> list.unique
                |> list.map(id.media),
              observed_at: observed,
            )
          let method = option.or(input.filled(body.method), Some(method))
          let saved =
            store.unit(ctx.store, fn(tx) {
              evidence.create(
                tx,
                p,
                claim,
                source,
                tier,
                method,
                reviewer,
                None,
                #("created", Some(row.verification_status_to_string(tier))),
                now,
              )
            })
          // Not ported yet: the `evidence` live event.
          case saved {
            Ok(e) ->
              http.json(
                201,
                json.object([#("evidence", evidence.view(e, now))]),
              )
            Error(failure) -> coaches.failed(failure)
          }
        }
      }
    }
  }
}

/// `POST /player/evidence`. Logging evidence is football activity (like stats and drills), so minors may
/// self-report; the tier says what that is worth.
pub fn player_submit(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  let me = p.player.row
  submit(
    ctx,
    req,
    p.player,
    Source(row.Player, id.player_to_string(me.id), me.name),
    row.SelfReported,
    "self_entry",
    None,
  )
}

/// `POST /guardian/children/:id/evidence`.
pub fn guardian_submit(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use c <- child(ctx, g, child_id)
  submit(
    ctx,
    req,
    c,
    Source(row.Guardian, id.guardian_to_string(g.row.id), g.row.name),
    row.SelfReported,
    "guardian_entry",
    None,
  )
}

/// `POST /org/players/:id/evidence`: a club records a claim it assessed itself.
pub fn club_submit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, players.for_org(_, player_id, a.org, now)) {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Ok(Some(#(_, access))) if !access.visible || access.blocked ->
      http.error(403, "NOT_VISIBLE")
    Ok(Some(#(p, _))) ->
      submit(
        ctx,
        req,
        p,
        Source(row.Org, id.org_to_string(a.org.id), a.org.name),
        row.ClubAssessed,
        "club_assessment",
        Some(#(id.org_user_to_string(a.user.id), a.user.name)),
      )
  }
}

// ---------------------------------------------------------------------------------------- corrections

fn own_record(
  ctx: Ctx,
  p: PlayerAccess,
  evidence_id: id.ScoutingEvidenceId,
  next: fn(Evidence) -> Response,
) -> Response {
  case store.read(ctx.store, evidence.by_id(_, evidence_id)) {
    Error(failure) -> http.internal(failure)
    Ok(Some(e)) if e.row.player_id == p.player.row.id -> next(e)
    Ok(_) -> http.error(404, "EVIDENCE_NOT_FOUND")
  }
}

type Correction {
  Correction(
    value: Option(input.NumberOrText),
    reason: Option(String),
    note: Option(String),
  )
}

/// `POST /player/evidence/:id/correct`: a new record supersedes the old, which stays with its lineage.
pub fn player_correct(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  evidence_id: id.ScoutingEvidenceId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  use orig <- own_record(ctx, p, evidence_id)
  case orig.row.source_kind {
    row.Org ->
      http.error_message(
        403,
        "NOT_YOUR_RECORD",
        "Club-submitted records are corrected by the club, or disputed.",
      )
    _ -> {
      let shape = {
        use value <- input.field(
          "value",
          input.nullish(input.number_or_text(value_text_max)),
        )
        use reason <- input.field(
          "reason",
          input.nullish(input.text(reason_max)),
        )
        use note <- input.field("note", input.nullish(input.text(note_max)))
        input.done(Correction(value:, reason:, note:))
      }
      use body <- http.body(req, shape, [])
      case input.filled(body.reason) {
        None ->
          http.json(
            400,
            json.object([
              #("error", json.string("REASON_REQUIRED")),
              #("field", json.string("reason")),
              #("problem", json.string("required")),
              #(
                "message",
                json.string(
                  "Corrections carry a reason — the history stays traceable.",
                ),
              ),
            ]),
          )
        Some(reason) -> {
          use <- moderate.or_refuse(
            ctx,
            reason,
            context("evidence_correction", orig.row.player_id),
          )
          let me = p.player.row
          let source = Source(row.Player, id.player_to_string(me.id), me.name)
          correct(ctx, p.player, orig, source, body, reason)
        }
      }
    }
  }
}

fn correct(
  ctx: Ctx,
  p: Player,
  orig: Evidence,
  source: evidence.Source,
  body: Correction,
  reason: String,
) -> Response {
  let now = clock.now_ms()
  let o = orig.row
  let tier = case source.kind {
    row.Org -> o.verification_status
    _ -> row.SelfReported
  }
  let claim =
    Claim(
      claim_type: o.claim_type,
      label: o.label,
      value: case body.value {
        Some(v) -> Some(v)
        None ->
          case o.value_number, o.value_text {
            Some(n), _ -> Some(input.Number(n))
            None, Some(t) -> Some(input.Text(t))
            None, None -> None
          }
      },
      units: o.units,
      season: o.season,
      note: option.or(input.filled(body.note), o.note),
      media_ids: orig.media_ids,
      observed_at: o.observed_at,
    )
  let saved =
    store.unit(ctx.store, fn(tx) {
      use created <- result.try(evidence.create(
        tx,
        p,
        claim,
        source,
        tier,
        Some("correction"),
        None,
        Some(o.id),
        #("created_as_correction", Some(reason)),
        now,
      ))
      use superseded <- result.try(evidence.supersede(tx, o.id, created.row.id))
      case superseded {
        False -> store.stale("evidence correction")
        True -> {
          use _ <- result.map(evidence.log(
            tx,
            o.id,
            evidence.source_by(source.kind),
            source.id,
            source.name,
            "superseded",
            Some(reason),
            now,
          ))
          created
        }
      }
    })
  // Not ported yet: the `evidence` live event.
  case saved {
    Ok(created) ->
      http.json(
        201,
        json.object([
          #("evidence", evidence.view(created, now)),
          #("superseded", id.scouting_evidence_json(o.id)),
        ]),
      )
    Error(failure) -> coaches.failed(failure)
  }
}

// ------------------------------------------------------------------------------------------- disputes

fn dispute(
  ctx: Ctx,
  req: Request,
  e: Evidence,
  by_kind: dispute_row.ByKind,
  by_id: String,
  by_name: String,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(reason_max)))
    input.done(reason)
  }
  use reason <- http.body(req, shape, [])
  case input.filled(reason) {
    None -> http.required("REASON_REQUIRED", "reason")
    Some(reason) -> {
      use <- moderate.or_refuse(
        ctx,
        reason,
        context("evidence_dispute", e.row.player_id),
      )
      let now = clock.now_ms()
      let saved =
        store.unit(ctx.store, fn(tx) {
          use d <- result.try(evidence.file_dispute(
            tx,
            e.row.id,
            by_kind,
            by_id,
            by_name,
            reason,
            now,
          ))
          let by = case by_kind {
            dispute_row.Player -> history_row.Player
            dispute_row.Org -> history_row.Org
          }
          use _ <- result.map(evidence.log(
            tx,
            e.row.id,
            by,
            by_id,
            by_name,
            "disputed",
            Some(reason),
            now,
          ))
          d
        })
      case saved {
        Ok(d) ->
          http.json(201, json.object([#("dispute", evidence.dispute_view(d))]))
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}

/// `POST /player/evidence/:id/dispute`.
pub fn player_dispute(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  evidence_id: id.ScoutingEvidenceId,
) -> Response {
  use e <- own_record(ctx, p, evidence_id)
  let me = p.player.row
  dispute(ctx, req, e, dispute_row.Player, id.player_to_string(me.id), me.name)
}

/// The record named in a club's path, with its player as the club sees them.
fn club_record(
  ctx: Ctx,
  a: OrgAccess,
  evidence_id: id.ScoutingEvidenceId,
  not_visible: fn() -> Response,
  next: fn(Evidence, Player) -> Response,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use e <- result.try(evidence.by_id(read, evidence_id))
      case e {
        None -> Ok(None)
        Some(e) ->
          players.for_org(read, e.row.player_id, a.org, now)
          |> result.map(fn(p) { Some(#(e, p)) })
      }
    })
  case found {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "EVIDENCE_NOT_FOUND")
    Ok(Some(#(e, Some(#(p, access))))) if access.visible && !access.blocked ->
      next(e, p)
    Ok(Some(_)) -> not_visible()
  }
}

/// `POST /org/evidence/:id/dispute`.
pub fn org_dispute(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  evidence_id: id.ScoutingEvidenceId,
) -> Response {
  use e, _ <- club_record(ctx, a, evidence_id, fn() {
    http.error(403, "NOT_VISIBLE")
  })
  dispute(
    ctx,
    req,
    e,
    dispute_row.Org,
    id.org_to_string(a.org.id),
    a.user.name <> " · " <> a.org.name,
  )
}

/// `POST /org/evidence/:id/corroborate`: an authorised club, or a club-confirmed coach there, upgrades a
/// self-reported claim; the original stays.
pub fn corroborate(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  evidence_id: id.ScoutingEvidenceId,
) -> Response {
  use _ <- http.rerun_on_stale(req)
  use e, p <- club_record(ctx, a, evidence_id, fn() {
    http.error_message(
      403,
      "NOT_VISIBLE",
      "You can only corroborate claims for players visible to your organisation.",
    )
  })
  case e.row.verification_status, e.row.superseded_by_id {
    row.SelfReported, Some(by) ->
      http.json(
        409,
        json.object([
          #("error", json.string("SUPERSEDED")),
          #("by", id.scouting_evidence_json(by)),
        ]),
      )
    row.SelfReported, None -> {
      let now = clock.now_ms()
      let saved =
        store.unit(ctx.store, fn(tx) {
          use affiliation <- result.try(coaches.active_for(
            store.reading(tx),
            a.org.id,
            a.user.name,
          ))
          let #(tier, method) = case affiliation {
            Some(aff) -> #(
              row.CoachConfirmed,
              "confirmed by club-affiliated coach (" <> aff.role <> ")",
            )
            None -> #(row.ClubAssessed, "corroborated by " <> a.org.name)
          }
          use changed <- result.try(evidence.corroborate(
            tx,
            e.row.id,
            tier,
            input.utf16_take(method, method_max),
            #(id.org_user_to_string(a.user.id), a.user.name),
            now,
          ))
          use <- guard_changed(changed, "evidence corroboration")
          use _ <- result.try(evidence.log(
            tx,
            e.row.id,
            history_row.Org,
            id.org_to_string(a.org.id),
            a.org.name,
            "corroborated",
            Some(row.verification_status_to_string(tier)),
            now,
          ))
          use _ <- result.try(notifications.notify(
            tx,
            to: audience.Player,
            id: id.player_to_string(p.row.id),
            type_: "evidence",
            text: "✅ "
              <> a.org.name
              <> " corroborated \""
              <> e.row.label
              <> "\" on your evidence passport.",
            ref_id: Some(id.scouting_evidence_to_string(e.row.id)),
            at: now,
          ))
          use _ <- result.try(case p.row.guardian_id {
            None -> Ok(Nil)
            Some(guardian_id) ->
              notifications.notify(
                tx,
                to: audience.Guardian,
                id: id.guardian_to_string(guardian_id),
                type_: "evidence",
                text: a.org.name
                  <> " corroborated \""
                  <> e.row.label
                  <> "\" on "
                  <> p.row.name
                  <> "'s evidence passport.",
                ref_id: Some(id.scouting_evidence_to_string(e.row.id)),
                at: now,
              )
          })
          evidence.by_id(store.reading(tx), e.row.id)
        })
      // Not ported yet: the `evidence` live event.
      case saved {
        Ok(Some(fresh)) ->
          http.json(
            200,
            json.object([#("evidence", evidence.view(fresh, now))]),
          )
        Ok(None) -> http.internal("a corroborated record is not stored")
        Error(failure) -> coaches.failed(failure)
      }
    }
    status, _ ->
      http.json(
        409,
        json.object([
          #("error", json.string("ALREADY_VERIFIED")),
          #("status", row.verification_status_to_json(status)),
        ]),
      )
  }
}

fn guard_changed(
  changed: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case changed {
    True -> next()
    False -> store.stale(what)
  }
}

// ------------------------------------------------------------------------------- Trust & Safety

type DisputeQuery {
  DisputeQuery(all: Option(Bool), limit: Option(Int), offset: Option(Int))
}

/// `GET /admin/evidence/disputes`: the queue, oldest first, by offset. `all=1` includes resolved disputes.
pub fn admin_disputes(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use all <- input.field(
      "all",
      input.optional(input.one_of([#("0", False), #("1", True)])),
    )
    use limit <- input.field(
      "limit",
      input.optional(input.whole_number_text(1, 200)),
    )
    use offset <- input.field(
      "offset",
      input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
    )
    input.done(DisputeQuery(all:, limit:, offset:))
  }
  use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
  let page =
    store.read(ctx.store, evidence.dispute_page(
      _,
      option.unwrap(q.all, False),
      option.unwrap(q.limit, 50),
      option.unwrap(q.offset, 0),
    ))
  case page {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

type Resolution {
  Resolution(
    outcome: dispute_row.ResolutionOutcome,
    downgrade: Option(Bool),
    note: Option(String),
  )
}

/// `POST /admin/evidence/disputes/:id/resolve`: an upheld dispute may downgrade the record to self-reported.
pub fn admin_resolve(
  ctx: Ctx,
  req: Request,
  dispute_id: id.EvidenceDisputeId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, evidence.dispute_by_id(_, dispute_id)) {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "DISPUTE_NOT_FOUND")
    Ok(Some(d)) if d.status != dispute_row.Open ->
      http.error(409, "ALREADY_RESOLVED")
    Ok(Some(d)) -> {
      let shape = {
        use outcome <- input.field(
          "resolution",
          input.required(input.one_of(dispute_row.resolution_outcome_pairs)),
        )
        use downgrade <- input.field(
          "downgrade",
          input.optional(input.boolean()),
        )
        use note <- input.field(
          "note",
          input.nullish(input.text(resolution_note_max)),
        )
        input.done(Resolution(outcome:, downgrade:, note:))
      }
      use body <- http.body(req, shape, [#("resolution", "RESOLUTION_REQUIRED")])
      let now = clock.now_ms()
      let saved =
        store.unit(ctx.store, fn(tx) {
          use resolved <- result.try(evidence.resolve_dispute(
            tx,
            d.id,
            body.outcome,
            input.filled(body.note),
            now,
          ))
          case resolved {
            None -> store.stale("evidence dispute")
            Some(resolved) -> {
              use _ <- result.try(
                case body.outcome, option.unwrap(body.downgrade, False) {
                  dispute_row.Upheld, True ->
                    evidence.downgrade(tx, d.evidence_id, now)
                  _, _ -> Ok(Nil)
                },
              )
              use _ <- result.try(evidence.log(
                tx,
                d.evidence_id,
                history_row.Admin,
                "admin",
                "Trust & Safety",
                "dispute_resolved",
                Some(dispute_row.resolution_outcome_to_string(body.outcome)),
                now,
              ))
              use fresh <- result.try(evidence.by_id(
                store.reading(tx),
                d.evidence_id,
              ))
              let assert Some(fresh) = fresh as "a disputed record is stored"
              use _ <- result.map(notifications.notify(
                tx,
                to: audience.Player,
                id: id.player_to_string(fresh.row.player_id),
                type_: "evidence",
                text: "Trust & Safety resolved a dispute on \""
                  <> fresh.row.label
                  <> "\": "
                  <> dispute_row.resolution_outcome_to_string(body.outcome)
                  <> ".",
                ref_id: Some(id.scouting_evidence_to_string(fresh.row.id)),
                at: now,
              ))
              #(resolved, fresh)
            }
          }
        })
      case saved {
        Ok(#(resolved, fresh)) ->
          http.json(
            200,
            json.object([
              #("dispute", evidence.dispute_view(resolved)),
              #("evidence", evidence.view(fresh, now)),
            ]),
          )
        Error(failure) -> coaches.failed(failure)
      }
    }
  }
}
