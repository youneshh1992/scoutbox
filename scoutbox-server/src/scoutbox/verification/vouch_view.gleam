//// A coach reference as every profile shows it (verification/vouches.mjs `vouchView`): never the coach's e-mail
//// or the code. An e-mail-code reference proves mailbox control, not coach identity, and says so wherever it
//// travels. Apart from `development/vouches` so that the player record can carry its references.

import gleam/json.{type Json}
import gleam/option.{None, Some}
import scoutbox/rows/id
import scoutbox/rows/vouches as row

/// Published, and not withdrawn by Trust & Safety: what every profile view shows.
pub fn shown(v: row.Row) -> Bool {
  v.status == row.Published && v.withdrawn_at == None
}

pub fn view(v: row.Row) -> Json {
  json.object([
    #("id", id.vouch_json(v.id)),
    #("playerId", id.player_json(v.player_id)),
    #("playerName", json.nullable(v.player_name, json.string)),
    #("coachName", json.string(v.coach_name)),
    #("role", json.string(v.role)),
    #("status", row.status_to_json(v.status)),
    #("text", json.nullable(v.text, json.string)),
    #("seasons", json.nullable(v.seasons, json.string)),
    #("ts", json.int(v.created_at)),
    #("publishedAt", json.nullable(v.published_at, json.int)),
    #("conflictOfInterest", json.nullable(v.conflict_of_interest, json.string)),
    #("withdrawn", withdrawn(v)),
    #("verificationMethod", json.string("email_code")),
    #("identityVerified", json.bool(False)),
  ])
}

pub fn withdrawn(v: row.Row) -> Json {
  case v.withdrawn_at, v.withdrawn_by, v.withdrawn_reason {
    Some(at), Some(by), Some(reason) ->
      json.object([
        #("at", json.int(at)),
        #("by", row.withdrawn_by_to_json(by)),
        #("reason", json.string(reason)),
      ])
    _, _, _ -> json.null()
  }
}
