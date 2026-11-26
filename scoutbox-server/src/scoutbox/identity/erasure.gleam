//// A player's erasure (domains/identity/dataRights.mjs `createPlayerErasure` and the redactors wiring.mjs hands it):
//// the append-only ledger keeps its ids, and the person's content goes from everywhere it is held, in one unit.
//// The player row stays as a tombstone that keeps only the id, the birth date and the country; each domain's
//// records keep their ids and states and lose the name and the person's own words. Media files go after COMMIT.
////
//// Out of scope: retrying a media file that could not be removed at the next boot or sweep.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/agent_store
import scoutbox/agents/compliance_store
import scoutbox/agents/transaction_store
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/pairing
import scoutbox/platform/blobs
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/live_pings
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/recruitment/signing_packages
import scoutbox/rows/id
import scoutbox/rows/players as row
import sqlight
import wisp.{type Response}

/// The tables of a player's own lists (playerSubrecords.ts SUBRECORD_TABLES, keyed by player).
const child_tables = [
  "player_season_history", "player_badges", "player_drills", "player_attendance",
  "player_timeline", "player_media", "player_medical_records",
  "player_drill_results", "player_activity_log", "player_external_ids",
  "player_programme_completions",
]

/// What a tombstone keeps besides the id, the birth date, the country and the deletion instant.
const placeholders = [
  #("name", "'Deleted player'"),
  #("profile_signal", "0"),
  #("academy_plus", "0"),
  #("first_team_seeker", "0"),
  #("availability", "'not_seeking'"),
  #("contract_status", "'unknown'"),
  #("level", "'amateur'"),
  #("identity_verified", "0"),
  #("medical_shared", "0"),
  #("medical_condition_status", "'unknown'"),
]

fn erase_sql() -> String {
  let sets =
    row.columns
    |> string.split(", ")
    |> list.filter(fn(c) { !list.contains(["id", "birth_date", "country"], c) })
    |> list.map(fn(c) {
      case c, list.key_find(placeholders, c) {
        "deleted_at", _ -> "deleted_at = ?"
        _, Ok(v) -> c <> " = " <> v
        _, Error(Nil) -> c <> " = NULL"
      }
    })
  "UPDATE players SET "
  <> string.join(sets, ", ")
  <> " WHERE id = ? AND deleted_at IS NULL"
}

fn run(tx: Tx, sql: String, args: List(sqlight.Value)) -> Result(Nil, Fail(e)) {
  store.run(tx, sql, args)
}

/// An actor's columns, set to NULL (recruitment.ts `nullActor`): its kind stays unless `with_kind`.
fn null_actor(prefix: String, with_kind: Bool) -> String {
  case with_kind {
    True -> [prefix <> "_kind"]
    False -> []
  }
  |> list.append([
    prefix <> "_user_id",
    prefix <> "_actor_id",
    prefix <> "_name",
  ])
  |> list.map(fn(c) { c <> " = NULL" })
  |> string.join(", ")
}

/// A trial history detail without its long text (recruitment.ts `redactedDetail`).
fn redacted_detail(text: String) -> String {
  case json_text.entries(text) {
    Error(Nil) -> text
    Ok(entries) ->
      "{"
      <> entries
      |> list.filter(fn(e) {
        case json.parse(e.2, decode.string) {
          Ok(s) -> input.utf16_length(s) <= 40
          Error(_) -> True
        }
      })
      |> list.map(fn(e) { json.to_string(json.string(e.0)) <> ":" <> e.2 })
      |> string.join(",")
      <> "}"
  }
}

/// Requests and trials become id-only tombstones (recruitment.ts `redactPlayer`).
fn redact_recruitment(
  tx: Tx,
  p: sqlight.Value,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    run(
      tx,
      "UPDATE recruitment_requests SET player_name = NULL, message = NULL, subject = NULL, trial_notes = CASE WHEN type = 'trial' THEN '' END,
       trial_private_venue_address = NULL, trial_private_instructions = NULL, guardian_id = NULL, contact_channel_id = NULL,
       recipient_type = NULL, recipient_player_id = NULL, recipient_guardian_id = NULL, recipient_minor = NULL, invite_key = NULL, invite_fp = NULL,
       subject_removed_at = ? WHERE player_id = ?",
      [sqlight.int(at), p],
    ),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE request_trial_slots SET venue_address = NULL WHERE request_id IN (SELECT id FROM recruitment_requests WHERE player_id = ?)",
      [p],
    ),
  )
  let in_trials = "trial_id IN (SELECT id FROM trials WHERE player_id = ?)"
  use _ <- result.try(
    run(tx, "DELETE FROM trial_session_evidence WHERE " <> in_trials, [p]),
  )
  use _ <- result.try(
    list.try_each(["trial_schedule_sessions", "trial_revision_sessions"], fn(t) {
      run(
        tx,
        "UPDATE "
          <> t
          <> " SET venue_address = NULL, instructions = NULL WHERE "
          <> in_trials,
        [p],
      )
    }),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE trial_schedule_revisions SET "
        <> null_actor("proposed_by", False)
        <> ", "
        <> null_actor("confirmed_by", True)
        <> ", reason = NULL WHERE "
        <> in_trials,
      [p],
    ),
  )
  use _ <- result.try(
    run(tx, "UPDATE trial_attendance SET note = NULL WHERE " <> in_trials, [p]),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE trial_reports SET notes = NULL, strength_note = NULL, focus_note = NULL WHERE "
        <> in_trials,
      [p],
    ),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE trial_day_consents SET "
        <> null_actor("by", False)
        <> " WHERE "
        <> in_trials,
      [p],
    ),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE trial_history SET "
        <> null_actor("by", False)
        <> " WHERE "
        <> in_trials,
      [p],
    ),
  )
  use details <- result.try(
    store.query(
      store.reading(tx),
      "SELECT trial_id, position, detail_json FROM trial_history WHERE detail_json IS NOT NULL AND "
        <> in_trials,
      [p],
      {
        use trial <- decode.field(0, id.trial_decoder())
        use position <- decode.field(1, decode.int)
        use detail <- decode.field(2, decode.string)
        decode.success(#(trial, position, detail))
      },
    ),
  )
  use _ <- result.try(
    list.try_each(details, fn(d) {
      run(
        tx,
        "UPDATE trial_history SET detail_json = ? WHERE trial_id = ? AND position = ?",
        [
          sqlight.text(redacted_detail(d.2)),
          id.trial_sql(d.0),
          sqlight.int(d.1),
        ],
      )
    }),
  )
  run(
    tx,
    "UPDATE trials SET player_name = NULL, notes = '', "
      <> null_actor("schedule_proposed_by", False)
      <> ", "
      <> null_actor("schedule_confirmed_by", False)
      <> ", schedule_declined_at = NULL, "
      <> null_actor("schedule_declined_by", True)
      <> ", "
      <> null_actor("completion_by", False)
      <> ", completion_reason = NULL, completion_cancelled_by = NULL,
       recipient_player_id = NULL, recipient_guardian_id = NULL,
       lifecycle_applied = NULL, lifecycle_from = NULL, lifecycle_to = NULL, lifecycle_reason = NULL, lifecycle_at = NULL,
       day_arrival_time = NULL, day_arrival_address = NULL, day_arrival_notes = NULL,
       day_emergency_name = NULL, day_emergency_phone = NULL, day_emergency_set_by = NULL, day_emergency_at = NULL,
       day_collection_policy = NULL, rev_by_user_id = NULL, rev_by_name = NULL, subject_removed_at = ? WHERE player_id = ?",
    [sqlight.int(at), p],
  )
}

/// Each domain's part of a deletion, in wiring.mjs's order.
fn redact(tx: Tx, player_id: id.PlayerId, at: Int) -> Result(Nil, Fail(e)) {
  let p = id.player_sql(player_id)
  let text = id.player_to_string(player_id)
  use _ <- result.try(redact_recruitment(tx, p, at))
  // A case keeps its status and the club's numbers; the name goes.
  use _ <- result.try(
    run(
      tx,
      "UPDATE recruitment_cases SET player_name = NULL, subject_removed_at = ? WHERE player_id = ?",
      [sqlight.int(at), p],
    ),
  )
  use _ <- result.try(
    run(tx, "UPDATE assessments SET player_name = NULL WHERE player_id = ?", [p]),
  )
  // The reply's words go; the contact stays.
  use _ <- result.try(
    run(
      tx,
      "UPDATE recruitment_contacts SET response_message = NULL WHERE player_id = ? AND response_message IS NOT NULL",
      [p],
    ),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE open_trial_registrations SET player_name = NULL WHERE player_id = ? AND player_name IS NOT NULL",
      [p],
    ),
  )
  use _ <- result.try(agent_store.redact_client(tx, text, at))
  use _ <- result.try(compliance_store.forget_player(tx, text, at))
  use _ <- result.try(transaction_store.forget_player(tx, text, at))
  // A signing package keeps its parties and history; the player's name goes from them.
  use _ <- result.try(signing_packages.redact_player(tx, player_id, at))
  // An Offer leaves ids and states behind, never a name.
  use _ <- result.try(
    run(
      tx,
      "UPDATE offer_responses SET actor_name = NULL, reason = NULL WHERE actor_type = 'player' AND offer_id IN (SELECT id FROM recruitment_offers WHERE player_id = ?)",
      [p],
    ),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE offer_history SET by_name = NULL WHERE by_kind = 'player' AND offer_id IN (SELECT id FROM recruitment_offers WHERE player_id = ?)",
      [p],
    ),
  )
  use _ <- result.try(
    run(
      tx,
      "UPDATE recruitment_offers SET subject_removed_at = ? WHERE player_id = ?",
      [sqlight.int(at), p],
    ),
  )
  // Every thread of the player, guardian–club threads included (D-B, docs/decisions.md).
  use _ <- result.try(run(tx, "DELETE FROM channels WHERE player_id = ?", [p]))
  // The preferences are kept, by decision.
  run(
    tx,
    "DELETE FROM notifications WHERE audience_kind = 'player' AND audience_id = ?",
    [sqlight.text(text)],
  )
}

/// Erases a live player. Returns whether there was one.
pub fn erase(
  ctx: Ctx,
  player_id: id.PlayerId,
) -> Result(Bool, store.UnitError(Nil)) {
  let at = clock.now_ms()
  use media <- result.map(
    store.unit(ctx.store, fn(tx) {
      let p = id.player_sql(player_id)
      use media <- result.try(
        store.query(
          store.reading(tx),
          "SELECT m.id, m.blob_key FROM player_media m JOIN players p ON p.id = m.player_id WHERE m.player_id = ? AND p.deleted_at IS NULL ORDER BY m.position",
          [p],
          {
            use media_id <- decode.field(0, decode.string)
            use blob_key <- decode.field(1, decode.optional(decode.string))
            decode.success(#(media_id, blob_key))
          },
        ),
      )
      use live <- result.try(store.one(
        store.reading(tx),
        "SELECT 1 FROM players WHERE id = ? AND deleted_at IS NULL",
        [p],
        decode.at([0], decode.int),
      ))
      case live {
        Error(Nil) -> Ok(Error(Nil))
        Ok(_) -> {
          live_pings.players(tx)
          use _ <- result.try(
            list.try_each(media, fn(m) {
              run(
                tx,
                "INSERT OR IGNORE INTO media_deletions (media_id, player_id, queued_at, blob_key) VALUES (?, ?, ?, ?)",
                [
                  sqlight.text(m.0),
                  p,
                  sqlight.int(at),
                  sqlight.nullable(sqlight.text, m.1),
                ],
              )
            }),
          )
          use _ <- result.try(
            run(
              tx,
              "DELETE FROM sessions WHERE kind = 'player' AND ref_id = ?",
              [p],
            ),
          )
          use _ <- result.try(pairing.revoke_for(tx, player_id))
          use _ <- result.try(
            list.try_each(child_tables, fn(t) {
              run(tx, "DELETE FROM " <> t <> " WHERE player_id = ?", [p])
            }),
          )
          use _ <- result.try(
            run(tx, "DELETE FROM guardian_children WHERE player_id = ?", [p]),
          )
          use _ <- result.try(run(tx, erase_sql(), [sqlight.int(at), p]))
          use _ <- result.try(store.seam(tx, "player.delete.after_erase"))
          // An upload never made into a clip expires now, so the sweep removes whatever was sent to it.
          use _ <- result.try(
            run(
              tx,
              "UPDATE upload_intents SET status = 'expired', expires_at = ? WHERE owner_kind = 'player' AND owner_id = ? AND status = 'open'",
              [sqlight.int(at), p],
            ),
          )
          use _ <- result.map(redact(tx, player_id, at))
          Ok(media)
        }
      }
    }),
  )
  case media {
    Error(Nil) -> False
    Ok(media) -> {
      // The storage boundary, after COMMIT: a file that cannot be removed keeps its queue entry.
      list.each(media, fn(m) { remove_file(ctx, m.0, m.1) })
      True
    }
  }
}

/// The removals erasure couldn't finish after its COMMIT, retried by the sweep: at most this many a sweep.
const retries_per_sweep = 100

/// The sweep's part: each queued removal whose clip no player carries any more (the operator page counts those
/// that one still does as conflicts, kept and never removed) has its file removed from storage, then leaves the
/// queue. One that fails again stays for the next sweep.
pub fn retry_removals(ctx: Ctx) -> Result(Nil, Nil) {
  use queued <- result.map(
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT d.media_id, d.blob_key FROM media_deletions d
         WHERE NOT EXISTS (SELECT 1 FROM player_media m WHERE m.id = d.media_id)
         ORDER BY d.queued_at, d.media_id LIMIT ?",
        [sqlight.int(retries_per_sweep)],
        {
          use media_id <- decode.field(0, decode.string)
          use blob_key <- decode.field(1, decode.optional(decode.string))
          decode.success(#(media_id, blob_key))
        },
      )
    })
    |> result.replace_error(Nil),
  )
  list.each(queued, fn(m) { remove_file(ctx, m.0, m.1) })
}

fn remove_file(ctx: Ctx, media_id: String, blob_key: Option(String)) -> Nil {
  let gone = case blob_key {
    None -> True
    Some(key) ->
      case blobs.delete(ctx.config.blobs, key, clock.now_ms()) {
        Ok(Nil) -> True
        Error(problem) -> {
          wisp.log_error(
            "erasure: clip " <> media_id <> ": " <> string.inspect(problem),
          )
          False
        }
      }
  }
  case gone {
    True -> {
      let _ =
        store.unit(ctx.store, fn(tx) {
          run(tx, "DELETE FROM media_deletions WHERE media_id = ?", [
            sqlight.text(media_id),
          ])
        })
      Nil
    }
    False -> Nil
  }
}

/// `DELETE /player/account`: a guardian-managed account is erased by the guardian.
pub fn delete_account(ctx: Ctx, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.error_message(
        403,
        "GUARDIAN_MANAGED",
        "Ask your parent/guardian to delete this profile.",
      )
    False ->
      case erase(ctx, p.player.row.id) {
        Ok(True) -> http.json(200, json.object([#("deleted", json.bool(True))]))
        // A concurrent delete erased it first, taking this session with it.
        Ok(False) -> access.player_session_gone()
        Error(failure) -> http.internal(failure)
      }
  }
}

/// `DELETE /guardian/children/:id`: a guardian erases their child's profile. A child already erased is no longer
/// theirs, so a second delete is a 404, not a second cascade.
pub fn delete_child(ctx: Ctx, g: Guardian, child: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child) {
    False -> http.error(404, "CHILD_NOT_FOUND")
    True ->
      case erase(ctx, child) {
        Ok(True) -> http.json(200, json.object([#("deleted", json.bool(True))]))
        Ok(False) -> http.error(404, "CHILD_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
  }
}
