//// A player's football evidence records (`evidence`, with its media, disputes and history; domains/scouting/
//// passport.mjs): each claim with its provenance, how it was checked, by whom and when.
////
//// The records and their acts live here; the routes that file, correct, corroborate and dispute them are in
//// `scouting/passport_routes`.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/identity/players.{type Player}
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/evidence as row
import scoutbox/rows/evidence_disputes as dispute_row
import scoutbox/rows/evidence_history as history_row
import scoutbox/rows/id
import sqlight

pub type Evidence {
  Evidence(row: row.Row, media_ids: List(id.MediaId), open_disputes: Int)
}

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
  correction_of: Option(id.ScoutingEvidenceId),
  history: #(String, Option(String)),
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
      source_name: stored_name(source.name),
      observed_at: claim.observed_at,
      recorded_at: at,
      verification_status: tier,
      verification_method: method,
      reviewer_id: option.map(reviewer, fn(r) { r.0 }),
      reviewer_name: option.map(reviewer, fn(r) { stored_name(r.1) }),
      reviewed_at: option.map(reviewer, fn(_) { at }),
      expires_at: case claim.claim_type {
        row.Availability -> Some(at + 90 * day_ms)
        _ -> None
      },
      correction_of_id: correction_of,
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
  use _ <- result.map(log(
    tx,
    evidence_id,
    source_by(source.kind),
    source.id,
    source.name,
    history.0,
    history.1,
    at,
  ))
  Evidence(r, media, 0)
}

/// Who a source is, as a history entry names them.
pub fn source_by(kind: row.SourceKind) -> history_row.ByKind {
  case kind {
    row.Player -> history_row.Player
    row.Guardian -> history_row.Guardian
    row.Org -> history_row.Org
  }
}

/// A history entry at the end of the record's history. Names are cut to the column's 200 characters and the
/// detail to its 500 (passport.mjs `logged`).
pub fn log(
  tx: Tx,
  evidence_id: id.ScoutingEvidenceId,
  by_kind: history_row.ByKind,
  by_id: String,
  by_name: String,
  action: String,
  detail: Option(String),
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event_id <- result.try(id.next_evidence_event(tx))
  store.run(
    tx,
    "INSERT INTO evidence_history (id, evidence_id, position, at, by_kind, by_id, by_name, action, detail) SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?, ?, ? FROM evidence_history WHERE evidence_id = ?",
    [
      id.evidence_event_sql(event_id),
      id.scouting_evidence_sql(evidence_id),
      sqlight.int(at),
      sqlight.text(history_row.by_kind_to_string(by_kind)),
      sqlight.text(by_id),
      sqlight.text(stored_name(by_name)),
      sqlight.text(action),
      sqlight.nullable(
        sqlight.text,
        option.map(detail, string.slice(_, 0, 500)),
      ),
      id.scouting_evidence_sql(evidence_id),
    ],
  )
}

/// A name as the evidence tables store it: at most 200 characters (passport.mjs `storedName`). Names come from
/// other domains, so they are shortened rather than refused.
pub fn stored_name(name: String) -> String {
  input.utf16_take(name, 200)
}

/// Every record of a player, superseded ones too, oldest first: the Passport.
pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Evidence), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM evidence WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player_id)],
    row.decoder(),
  ))
  list.try_map(rows, with_children(read, _))
}

/// A self-reported, current record takes a reviewer's tier, once. `Ok(False)` when it was already verified or
/// superseded.
pub fn corroborate(
  tx: Tx,
  evidence_id: id.ScoutingEvidenceId,
  tier: row.VerificationStatus,
  method: String,
  reviewer: #(String, String),
  at: Int,
) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE evidence SET verification_status = ?, verification_method = ?, reviewer_id = ?, reviewer_name = ?, reviewed_at = ? WHERE id = ? AND verification_status = 'self_reported' AND superseded_by_id IS NULL RETURNING id",
    [
      sqlight.text(row.verification_status_to_string(tier)),
      sqlight.text(method),
      sqlight.text(reviewer.0),
      sqlight.text(stored_name(reviewer.1)),
      sqlight.int(at),
      id.scouting_evidence_sql(evidence_id),
    ],
    decode.success(Nil),
  )
  |> result.map(fn(changed) { changed != [] })
}

/// A record is superseded once, by a correction of it. `Ok(False)` when another correction came first.
pub fn supersede(
  tx: Tx,
  evidence_id: id.ScoutingEvidenceId,
  by: id.ScoutingEvidenceId,
) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE evidence SET superseded_by_id = ? WHERE id = ? AND superseded_by_id IS NULL RETURNING id",
    [id.scouting_evidence_sql(by), id.scouting_evidence_sql(evidence_id)],
    decode.success(Nil),
  )
  |> result.map(fn(changed) { changed != [] })
}

/// The record's verification set back to self-reported by Trust & Safety, after an upheld dispute.
pub fn downgrade(
  tx: Tx,
  evidence_id: id.ScoutingEvidenceId,
  at: Int,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE evidence SET verification_status = 'self_reported', verification_method = 'downgraded after dispute', reviewer_id = 'admin', reviewer_name = 'Trust & Safety', reviewed_at = ? WHERE id = ?",
    [sqlight.int(at), id.scouting_evidence_sql(evidence_id)],
  )
}

// ------------------------------------------------------------------------------------------- disputes

pub type Dispute =
  dispute_row.Row

/// A dispute filed open, at the end of the record's disputes.
pub fn file_dispute(
  tx: Tx,
  evidence_id: id.ScoutingEvidenceId,
  by_kind: dispute_row.ByKind,
  by_id: String,
  by_name: String,
  reason: String,
  at: Int,
) -> Result(Dispute, Fail(e)) {
  use dispute_id <- result.try(id.next_evidence_dispute(tx))
  use rows <- result.try(store.write(
    tx,
    "INSERT INTO evidence_disputes ("
      <> dispute_row.columns
      <> ") SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL FROM evidence_disputes WHERE evidence_id = ? RETURNING "
      <> dispute_row.columns,
    [
      id.evidence_dispute_sql(dispute_id),
      id.scouting_evidence_sql(evidence_id),
      sqlight.int(at),
      sqlight.text(dispute_row.by_kind_to_string(by_kind)),
      sqlight.text(by_id),
      sqlight.text(stored_name(by_name)),
      sqlight.text(reason),
      id.scouting_evidence_sql(evidence_id),
    ],
    dispute_row.decoder(),
  ))
  let assert [d] = rows
  Ok(d)
}

pub fn dispute_by_id(
  read: Read,
  dispute_id: id.EvidenceDisputeId,
) -> Result(Option(Dispute), Fail(e)) {
  store.one(
    read,
    "SELECT " <> dispute_row.columns <> " FROM evidence_disputes WHERE id = ?",
    [id.evidence_dispute_sql(dispute_id)],
    dispute_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// An open dispute resolved, once. `Ok(None)` when it was resolved first.
pub fn resolve_dispute(
  tx: Tx,
  dispute_id: id.EvidenceDisputeId,
  outcome: dispute_row.ResolutionOutcome,
  note: Option(String),
  at: Int,
) -> Result(Option(Dispute), Fail(e)) {
  store.write(
    tx,
    "UPDATE evidence_disputes SET status = 'resolved', resolution_outcome = ?, resolution_note = ?, resolved_at = ? WHERE id = ? AND status = 'open' RETURNING "
      <> dispute_row.columns,
    [
      sqlight.text(dispute_row.resolution_outcome_to_string(outcome)),
      sqlight.nullable(sqlight.text, note),
      sqlight.int(at),
      id.evidence_dispute_sql(dispute_id),
    ],
    dispute_row.decoder(),
  )
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

pub fn dispute_view(d: Dispute) -> Json {
  json.object(dispute_fields(d))
}

fn dispute_fields(d: Dispute) -> List(#(String, Json)) {
  [
    #("id", id.evidence_dispute_json(d.id)),
    #("at", json.int(d.filed_at)),
    #(
      "by",
      json.object([
        #("kind", dispute_row.by_kind_to_json(d.by_kind)),
        #("id", json.string(d.by_id)),
        #("name", json.string(d.by_name)),
      ]),
    ),
    #("reason", json.string(d.reason)),
    #("status", dispute_row.status_to_json(d.status)),
    #("resolution", case d.resolution_outcome {
      None -> json.null()
      Some(outcome) ->
        json.object([
          #("outcome", dispute_row.resolution_outcome_to_json(outcome)),
          #("note", json.nullable(d.resolution_note, json.string)),
          #("at", json.nullable(d.resolved_at, json.int)),
        ])
    }),
  ]
}

/// The Trust & Safety queue, oldest first, by offset: each dispute with its record's id, player, label and tier.
/// `all` includes resolved disputes.
pub fn dispute_page(
  read: Read,
  all: Bool,
  limit: Int,
  offset: Int,
) -> Result(Json, Fail(e)) {
  let which = case all {
    True -> ""
    False -> " WHERE d.status = 'open'"
  }
  use total <- result.try(store.one(
    read,
    "SELECT COUNT(*) FROM evidence_disputes d" <> which,
    [],
    decode.at([0], decode.int),
  ))
  use items <- result.map(
    store.query(
      read,
      "SELECT "
        <> dispute_row.qualified("d")
        <> ", e.player_id, e.label, e.verification_status FROM evidence_disputes d JOIN evidence e ON e.id = d.evidence_id"
        <> which
        <> " ORDER BY d.filed_at, d.rowid LIMIT ? OFFSET ?",
      [sqlight.int(limit), sqlight.int(offset)],
      {
        use d <- decode.then(dispute_row.decoder())
        use player_id <- decode.field(dispute_row.width, id.player_decoder())
        use label <- decode.field(dispute_row.width + 1, decode.string)
        use tier <- decode.field(
          dispute_row.width + 2,
          row.verification_status_decoder(),
        )
        decode.success(#(d, player_id, label, tier))
      },
    ),
  )
  json.object([
    #("total", json.int(result.unwrap(total, 0))),
    #("limit", json.int(limit)),
    #("offset", json.int(offset)),
    #(
      "items",
      json.array(items, fn(item) {
        let #(d, player_id, label, tier) = item
        json.object(
          list.append(dispute_fields(d), [
            #("evidenceId", id.scouting_evidence_json(d.evidence_id)),
            #("playerId", id.player_json(player_id)),
            #("label", json.string(label)),
            #("tier", row.verification_status_to_json(tier)),
          ]),
        )
      }),
    ),
  ])
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
