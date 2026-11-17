//// The stored match facts (domains/discovery/matchFacts.mjs) that Nobody Missed, and later matching and the
//// watchlists, test: one row per live player, derived from the records that own each fact. Nothing in them depends
//// on who reads them (visibility, age and distance are the query's), so they are derived once per player.
////
//// Triggers on the inputs (migration 0040) mark a player dirty; `drain` re-derives the marked players inside every
//// unit, just before its COMMIT (`store.with_before_commit`), so a reader never sees facts older than the last
//// commit. `refresh_due_at` is the next instant at which time alone changes one of them (an evidence item expires,
//// a claim lapses, an agreement starts or ends, the player comes of age); `sweep` marks those rows, and its own
//// COMMIT re-derives them. `start` re-derives every row when the policy key changed.

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/time/calendar
import scoutbox/identity/players.{type Player}
import scoutbox/passport/trust
import scoutbox/passport/trust_rules
import scoutbox/platform/clock
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Store, type Tx}
import scoutbox/platform/unicode
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/player_match_fact_combine as combine_row
import scoutbox/rows/player_match_fact_positions as position_row
import scoutbox/rows/player_match_facts as row
import scoutbox/rules/age
import scoutbox/vocab/availability
import scoutbox/vocab/position
import scoutbox/vocab/trust_band
import sqlight

const day_ms = 86_400_000

const batch = 500

/// The Trust Score policy the stored bands were derived under, and whether simulated evidence counts (it never
/// does here): a change re-derives every row. The same key the TypeScript server writes, so either server reads the
/// other's facts as current.
pub fn policy_key() -> String {
  "facts1|trust" <> int.to_string(trust_rules.policy_version) <> "|sim0"
}

const policy_meta = "matchFactsPolicy"

/// One player's facts, before they are written.
pub type Facts {
  Facts(
    row: row.Row,
    secondary: List(position.Position),
    combine: List(#(String, Option(Float))),
  )
}

fn ints(
  read: Read,
  sql: String,
  player_id: id.PlayerId,
) -> Result(List(Int), Fail(e)) {
  store.query(read, sql, [id.player_sql(player_id)], decode.at([0], decode.int))
}

fn exists(
  read: Read,
  sql: String,
  player_id: id.PlayerId,
) -> Result(Bool, Fail(e)) {
  store.query(read, sql, [id.player_sql(player_id)], decode.at([0], decode.int))
  |> result.map(fn(rows) { rows != [] })
}

/// The first instant at which the player is an adult (rules/age `is_adult`), or None when the birth date is not a
/// day. Their birthday N years on, for the first N at which `is_adult` holds; a day either side covers 29 February.
pub fn adulthood_at(p: Player) -> Option(Int) {
  case age.parse_day(p.row.birth_date) {
    Error(Nil) -> None
    Ok(d) ->
      first_adult_birthday(p, d.year, calendar.month_to_int(d.month), d.day, 0)
  }
}

fn first_adult_birthday(
  p: Player,
  year: Int,
  month: Int,
  day: Int,
  n: Int,
) -> Option(Int) {
  case n > 25 {
    True -> None
    False -> {
      let at = utc_ms(year + n, month, day)
      case age.is_adult(p.row.birth_date, p.row.country, at) {
        True -> Some(first_adult_day(p, at - 2 * day_ms))
        False -> first_adult_birthday(p, year, month, day, n + 1)
      }
    }
  }
}

fn first_adult_day(p: Player, t: Int) -> Int {
  case age.is_adult(p.row.birth_date, p.row.country, t) {
    True -> t
    False -> first_adult_day(p, t + day_ms)
  }
}

/// JavaScript's `Date.UTC(year, month - 1, day)`: a day past the month's end runs into the next month, as
/// 29 February does in a common year.
fn utc_ms(year: Int, month: Int, day: Int) -> Int {
  { days_from_civil(year, month) + day - 1 } * day_ms
}

/// Days from 1970-01-01 to the first of `month` in `year` (Howard Hinnant's days_from_civil).
fn days_from_civil(year: Int, month: Int) -> Int {
  let y = case month <= 2 {
    True -> year - 1
    False -> year
  }
  let era = case y >= 0 {
    True -> y / 400
    False -> { y - 399 } / 400
  }
  let yoe = y - era * 400
  let mp = case month > 2 {
    True -> month - 3
    False -> month + 9
  }
  let doy = { 153 * mp + 2 } / 5
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146_097 + doe - 719_468
}

fn newest(times: List(Int)) -> Option(Int) {
  case list.fold(times, 0, int.max) {
    0 -> None
    t -> Some(t)
  }
}

/// A player's facts as of `now` (matchFacts.mjs `build`).
pub fn build(read: Read, p: Player, now: Int) -> Result(Facts, Fail(e)) {
  let pid = p.row.id
  use prefs <- result.try(
    store.query(
      read,
      "SELECT position_primary, availability FROM passport_prefs WHERE player_id = ?",
      [id.player_sql(pid)],
      {
        use primary <- decode.field(0, decode.optional(position.decoder()))
        use avail <- decode.field(1, decode.optional(decode.string))
        decode.success(#(primary, avail))
      },
    ),
  )
  use secondary <- result.try(store.query(
    read,
    "SELECT code FROM passport_pref_positions WHERE player_id = ? ORDER BY ord",
    [id.player_sql(pid)],
    decode.at([0], position.decoder()),
  ))
  use evidence <- result.try(trust.current_evidence(read, pid))
  // A simulated result is not recruitment eligibility, and an attempt whose session was invalidated stops counting.
  use attempts <- result.try(
    store.query(
      read,
      "SELECT a.protocol_id, a.measured_value FROM combine_attempts a LEFT JOIN box_sessions s ON s.id = a.box_session_id WHERE a.player_id = ? AND a.combine_state = 'combine_verified' AND a.provider_id <> 'local_test' AND (s.verification_state IS NULL OR s.verification_state <> 'invalidated') ORDER BY a.created_at, a.id",
      [id.player_sql(pid)],
      {
        use protocol <- decode.field(0, decode.string)
        use value <- decode.field(1, decode.optional(decode.float))
        decode.success(#(protocol, value))
      },
    ),
  )
  use claim_ends <- result.try(ints(
    read,
    "SELECT valid_until FROM ver_claims WHERE subject_id = ? AND valid_until IS NOT NULL",
    pid,
  ))
  use agreement_bounds <- result.try(store.query(
    read,
    "SELECT start_at FROM representation_agreements WHERE client_id = ? AND start_at IS NOT NULL UNION ALL SELECT end_at FROM representation_agreements WHERE client_id = ? AND end_at IS NOT NULL",
    [id.player_sql(pid), id.player_sql(pid)],
    decode.at([0], decode.int),
  ))
  use has_reference <- result.try(exists(
    read,
    "SELECT 1 FROM ver_references WHERE player_id = ? AND status = 'active' LIMIT 1",
    pid,
  ))
  use signed <- result.try(exists(
    read,
    "SELECT 1 FROM signings WHERE player_id = ? LIMIT 1",
    pid,
  ))
  use profile <- result.map(trust.profile(read, p, now))

  // A missing measurement is no measurement: it never meets a threshold, so it is kept as None beside any real one.
  let combine =
    list.fold(attempts, [], fn(acc, a) {
      let #(protocol, value) = a
      let best = case list.key_find(acc, protocol), value {
        Ok(Some(b)), Some(v) -> Some(float.max(b, v))
        Ok(b), None -> b
        _, v -> v
      }
      list.key_set(acc, protocol, best)
    })
    |> list.reverse

  let expiries =
    list.filter_map(evidence, fn(e) {
      option.map(e.expires_at, fn(at) { at + 1 }) |> option.to_result(Nil)
    })
  let due =
    list.flatten([
      expiries,
      claim_ends,
      agreement_bounds,
      option.to_result(adulthood_at(p), Nil)
        |> result.map(list.wrap)
        |> result.unwrap([]),
    ])
    |> list.filter(fn(t) { t > now })
    |> list.reduce(int.min)
    |> option.from_result

  let #(pref_primary, pref_availability) = case prefs {
    [first, ..] -> first
    [] -> #(None, None)
  }
  let footage =
    list.filter(evidence, fn(e) { e.claim_type == evidence_row.Footage })
  Facts(
    row: row.Row(
      player_id: pid,
      name_key: input.utf16_take(unicode.fold_name(p.row.name), 120),
      position: option.or(pref_primary, p.row.position),
      availability: Some(option.unwrap(
        pref_availability,
        availability.to_string(p.row.availability),
      )),
      trust_band: trust_band.from_string(profile.band.id) |> option.from_result,
      last_evidence_at: newest(list.map(evidence, fn(e) { e.recorded_at })),
      last_footage_at: newest(list.map(footage, fn(e) { e.recorded_at })),
      coach_reference: has_reference
        || list.any(evidence, fn(e) {
        e.verification_status == evidence_row.CoachConfirmed
      }),
      club_confirmed: signed,
      refresh_due_at: due,
      refreshed_at: now,
    ),
    secondary: list.unique(secondary) |> list.take(3),
    combine:,
  )
}

/// Writes one player's facts; None (the player is gone, or their account retained) removes the row.
fn write(
  tx: Tx,
  player_id: id.PlayerId,
  facts: Option(Facts),
) -> Result(Nil, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM player_match_facts WHERE player_id = ?", [
      id.player_sql(player_id),
    ]),
  )
  case facts {
    None -> Ok(Nil)
    Some(f) -> {
      use _ <- result.try(row.insert(tx, f.row))
      use _ <- result.try(
        list.index_map(f.secondary, fn(code, ord) {
          position_row.Row(player_id:, ord:, code:)
        })
        |> list.try_each(position_row.insert(tx, _)),
      )
      list.try_each(f.combine, fn(c) {
        combine_row.insert(
          tx,
          combine_row.Row(player_id:, protocol_id: c.0, best_value: c.1),
        )
      })
    }
  }
}

/// Re-derives every player the triggers marked, in batches, until none is left. The store runs it inside every
/// unit, just before COMMIT; its writes to the facts mark no one, so it ends.
pub fn drain(tx: Tx) -> Result(Nil, sqlight.Error) {
  drain_batches(tx, clock.now_ms())
  |> result.map_error(fn(failure) {
    case failure {
      store.Storage(e) -> e
      _ ->
        sqlight.SqlightError(
          sqlight.GenericError,
          "the match facts could not be derived",
          -1,
        )
    }
  })
}

fn drain_batches(tx: Tx, now: Int) -> Result(Nil, Fail(Nil)) {
  let read = store.reading(tx)
  use ids <- result.try(store.query(
    read,
    "SELECT player_id FROM player_match_facts_dirty LIMIT ?",
    [sqlight.int(batch)],
    decode.at([0], id.player_decoder()),
  ))
  case ids {
    [] -> Ok(Nil)
    _ -> {
      use found <- result.try(players.by_ids(read, ids))
      use _ <- result.try(
        list.try_each(ids, fn(pid) {
          case list.find(found, fn(p) { p.row.id == pid }) {
            Ok(p) -> {
              use facts <- result.try(build(read, p, now))
              write(tx, pid, Some(facts))
            }
            Error(Nil) -> write(tx, pid, None)
          }
        }),
      )
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM player_match_facts_dirty WHERE player_id IN (SELECT value FROM json_each(?))",
          [ids_json(ids)],
        ),
      )
      drain_batches(tx, now)
    }
  }
}

fn ids_json(ids: List(id.PlayerId)) -> sqlight.Value {
  json.array(ids, id.player_json) |> json.to_string |> sqlight.text
}

/// Marks the players whose time-only change is due by `at`.
fn mark_due(tx: Tx, at: Int) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "INSERT OR IGNORE INTO player_match_facts_dirty (player_id) SELECT player_id FROM player_match_facts WHERE refresh_due_at IS NOT NULL AND refresh_due_at <= ?",
    [sqlight.int(at)],
  )
}

/// The sweep: the unit's COMMIT re-derives the rows whose time-only change is due.
pub fn sweep(store: Store) -> Result(Nil, store.UnitError(Nil)) {
  store.unit(store, fn(tx) { mark_due(tx, clock.now_ms()) })
}

/// At boot, once the hook is installed: every row is re-derived when the policy key changed (or on the first
/// boot), and the due ones always.
pub fn start(store: Store) -> Result(Nil, store.UnitError(Nil)) {
  store.unit(store, fn(tx) {
    use stored <- result.try(store.query(
      store.reading(tx),
      "SELECT value FROM meta WHERE key = ?",
      [sqlight.text(policy_meta)],
      decode.at([0], decode.string),
    ))
    use _ <- result.try(case stored == [policy_key()] {
      True -> Ok(Nil)
      False -> {
        use _ <- result.try(
          store.run(
            tx,
            "INSERT OR IGNORE INTO player_match_facts_dirty (player_id) SELECT id FROM players WHERE deleted_at IS NULL UNION SELECT player_id FROM player_match_facts",
            [],
          ),
        )
        store.run(
          tx,
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [sqlight.text(policy_meta), sqlight.text(policy_key())],
        )
      }
    })
    mark_due(tx, clock.now_ms())
  })
}
