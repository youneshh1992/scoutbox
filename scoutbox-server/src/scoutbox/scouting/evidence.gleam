//// A player's football evidence records (`evidence`, with its media, disputes and history; domains/scouting/
//// passport.mjs): each claim with its provenance, how it was checked, by whom and when.
////
//// Not ported yet: the player's and guardian's own claims, corrections, corroboration, disputes and their
//// resolution, the Passport evidence summary and the `evidence` live event. A club records a claim here
//// (`POST /org/players/:id/evidence`); the Room and the Trust Score read them.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/rows/evidence as row
import scoutbox/rows/evidence_history as history_row
import scoutbox/rows/id
import scoutbox/safety/audit
import scoutbox/safety/moderate
import sqlight
import wisp.{type Request, type Response}

pub type Evidence {
  Evidence(row: row.Row, media_ids: List(id.MediaId), open_disputes: Int)
}

const label_max = 120

const value_text_max = 120

const units_max = 20

const season_max = 20

const note_max = 300

const method_max = 80

const media_per_claim = 50

const day_ms = 86_400_000

fn with_children(read: Read, r: row.Row) -> Result(Evidence, Fail(e)) {
  use media <- result.try(store.query(
    read,
    "SELECT media_id FROM evidence_media WHERE evidence_id = ? ORDER BY position",
    [id.scouting_evidence_sql(r.id)],
    decode.at([0], id.media_decoder()),
  ))
  use open <- result.map(store.one(
    read,
    "SELECT COUNT(*) FROM evidence_disputes WHERE evidence_id = ? AND status = 'open'",
    [id.scouting_evidence_sql(r.id)],
    decode.at([0], decode.int),
  ))
  Evidence(r, media, result.unwrap(open, 0))
}

/// A player's current records (not superseded by a correction), oldest first.
pub fn current_for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Evidence), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM evidence WHERE player_id = ? AND superseded_by_id IS NULL ORDER BY rowid",
    [id.player_sql(player_id)],
    row.decoder(),
  ))
  list.try_map(rows, with_children(read, _))
}

pub fn by_id(
  read: Read,
  evidence_id: id.ScoutingEvidenceId,
) -> Result(Option(Evidence), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM evidence WHERE id = ?",
    [id.scouting_evidence_sql(evidence_id)],
    row.decoder(),
  ))
  case rows {
    [r] -> with_children(read, r) |> result.map(Some)
    _ -> Ok(None)
  }
}

pub type Source {
  Source(kind: row.SourceKind, id: String, name: String)
}

pub type Claim {
  Claim(
    claim_type: row.ClaimType,
    label: String,
    value: Option(input.NumberOrText),
    units: Option(String),
    season: Option(String),
    note: Option(String),
    media_ids: List(id.MediaId),
    observed_at: Option(Int),
  )
}

/// Records a claim with its provenance and its first history entry.
pub fn create(
  tx: Tx,
  player: Player,
  claim: Claim,
  source: Source,
  tier: row.VerificationStatus,
  method: Option(String),
  reviewer: Option(#(String, String)),
  at: Int,
) -> Result(Evidence, Fail(e)) {
  use evidence_id <- result.try(id.next_scouting_evidence(tx))
  // Only the player's own media can be attached.
  let own = list.map(player.media, fn(m) { m.clip.id })
  let media = list.filter(claim.media_ids, list.contains(own, _))
  let r =
    row.Row(
      id: evidence_id,
      player_id: player.row.id,
      claim_type: claim.claim_type,
      label: claim.label,
      value_number: case claim.value {
        Some(input.Number(n)) -> Some(n)
        _ -> None
      },
      value_text: case claim.value {
        Some(input.Text(t)) -> Some(t)
        _ -> None
      },
      units: claim.units,
      season: claim.season,
      source_kind: source.kind,
      source_id: source.id,
      source_name: source.name,
      observed_at: claim.observed_at,
      recorded_at: at,
      verification_status: tier,
      verification_method: method,
      reviewer_id: option.map(reviewer, fn(r) { r.0 }),
      reviewer_name: option.map(reviewer, fn(r) { r.1 }),
      reviewed_at: option.map(reviewer, fn(_) { at }),
      expires_at: case claim.claim_type {
        row.Availability -> Some(at + 90 * day_ms)
        _ -> None
      },
      correction_of_id: None,
      superseded_by_id: None,
      note: claim.note,
    )
  use _ <- result.try(row.insert(tx, r))
  use _ <- result.try(
    list.index_map(media, fn(m, i) { #(m, i) })
    |> list.try_each(fn(p) {
      store.run(
        tx,
        "INSERT INTO evidence_media (evidence_id, position, media_id) VALUES (?, ?, ?)",
        [
          id.scouting_evidence_sql(evidence_id),
          sqlight.int(p.1),
          id.media_sql(p.0),
        ],
      )
    }),
  )
  use event_id <- result.try(id.next_evidence_event(tx))
  use _ <- result.map(history_row.insert(
    tx,
    history_row.Row(
      id: event_id,
      evidence_id:,
      position: 0,
      at:,
      by_kind: Some(case source.kind {
        row.Player -> history_row.Player
        row.Guardian -> history_row.Guardian
        row.Org -> history_row.Org
      }),
      by_id: Some(source.id),
      by_name: Some(source.name),
      action: "created",
      detail: Some(row.verification_status_to_string(tier)),
    ),
  ))
  Evidence(r, media, 0)
}

pub fn value_json(r: row.Row) -> Json {
  case r.value_number, r.value_text {
    Some(n), _ -> json_text.number(n)
    None, Some(t) -> json.string(t)
    None, None -> json.null()
  }
}

/// A record as its owner and the clubs that may see the player read it (evidenceView).
pub fn view(e: Evidence, now: Int) -> Json {
  let r = e.row
  let age_days = { now - r.recorded_at } / day_ms
  json.object([
    #("id", id.scouting_evidence_json(r.id)),
    #("playerId", id.player_json(r.player_id)),
    #("claimType", row.claim_type_to_json(r.claim_type)),
    #("label", json.string(r.label)),
    #("value", value_json(r)),
    #("units", json.nullable(r.units, json.string)),
    #("season", json.nullable(r.season, json.string)),
    #(
      "source",
      json.object([
        #("kind", row.source_kind_to_json(r.source_kind)),
        #("id", json.string(r.source_id)),
        #("name", json.string(r.source_name)),
      ]),
    ),
    #("observedAt", json.nullable(r.observed_at, json.int)),
    #("recordedAt", json.int(r.recorded_at)),
    #("mediaIds", json.array(e.media_ids, id.media_json)),
    #(
      "verification",
      json.object([
        #("status", row.verification_status_to_json(r.verification_status)),
        #("method", json.nullable(r.verification_method, json.string)),
        #("reviewerId", json.nullable(r.reviewer_id, json.string)),
        #("reviewerName", json.nullable(r.reviewer_name, json.string)),
        #("reviewedAt", json.nullable(r.reviewed_at, json.int)),
      ]),
    ),
    #("expiresAt", json.nullable(r.expires_at, json.int)),
    #(
      "correctionOf",
      json.nullable(r.correction_of_id, id.scouting_evidence_json),
    ),
    #(
      "supersededBy",
      json.nullable(r.superseded_by_id, id.scouting_evidence_json),
    ),
    #("note", json.nullable(r.note, json.string)),
    #(
      "freshness",
      json.object([
        #("ageDays", json.int(age_days)),
        #("fresh", json.bool(age_days <= 180)),
      ]),
    ),
    #(
      "expired",
      json.bool(case r.expires_at {
        Some(at) -> at < now
        None -> False
      }),
    ),
    #("openDisputes", json.int(e.open_disputes)),
    #("superseded", json.bool(option.is_some(r.superseded_by_id))),
  ])
}

type ClubClaim {
  ClubClaim(
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
    Ok(Some(#(p, _))) -> {
      let shape = {
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
        use season <- input.field(
          "season",
          input.nullish(input.text(season_max)),
        )
        use note <- input.field("note", input.nullish(input.text(note_max)))
        use media_ids <- input.field(
          "mediaIds",
          input.nullish(input.items(input.id(), media_per_claim)),
        )
        use observed_at <- input.field(
          "observedAt",
          input.optional(input.due_date()),
        )
        use method <- input.field(
          "method",
          input.nullish(input.text(method_max)),
        )
        input.done(ClubClaim(
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
      use body <- http.body(req, shape, [#("claimType", "CLAIM_TYPE_INVALID")])
      case input.filled(body.label) {
        None -> http.required("LABEL_REQUIRED", "label")
        Some(label) -> {
          let note = input.filled(body.note)
          let context = fn(kind) {
            audit.Context(
              kind:,
              player_id: Some(p.row.id),
              org_id: None,
              user_id: None,
              channel_id: None,
              request_id: None,
            )
          }
          use <- moderate_maybe(ctx, note, context("evidence_note"))
          use <- moderate.or_refuse(ctx, label, context("evidence_label"))
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
              let method =
                option.or(input.filled(body.method), Some("club_assessment"))
              let saved =
                store.unit(ctx.store, fn(tx) {
                  create(
                    tx,
                    p,
                    claim,
                    Source(row.Org, id.org_to_string(a.org.id), a.org.name),
                    row.ClubAssessed,
                    method,
                    Some(#(id.org_user_to_string(a.user.id), a.user.name)),
                    now,
                  )
                })
              // Not ported yet: the `evidence` live event.
              case saved {
                Ok(e) ->
                  http.json(201, json.object([#("evidence", view(e, now))]))
                Error(failure) -> http.internal(failure)
              }
            }
          }
        }
      }
    }
  }
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
