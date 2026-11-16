//// The player record (`players` and the `player_*` lists): reads, the writes this slice makes, and the views each
//// audience receives (views/playerViews.mjs).
////
//// A `Player` is the row and its lists, each in `position` order. Lists of players load in one query per table,
//// never one per player.
////
//// Not ported yet: `trialReports` belongs to the trials (recruitment), which this server does not run, so every
//// record has none, and the profile signal counts none.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/ids
import scoutbox/platform/sql
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/player_activity_log as activity_row
import scoutbox/rows/player_attendance as attendance_row
import scoutbox/rows/player_badges as badge_row
import scoutbox/rows/player_drill_results as drill_result_row
import scoutbox/rows/player_drills as drill_row
import scoutbox/rows/player_external_ids as external_row
import scoutbox/rows/player_media as media_row
import scoutbox/rows/player_media_tags as tag_row
import scoutbox/rows/player_medical_records as medical_row
import scoutbox/rows/player_programme_completions as completion_row
import scoutbox/rows/player_season_history as season_row
import scoutbox/rows/player_timeline as timeline_row
import scoutbox/rows/players as row
import scoutbox/rules/age
import scoutbox/rules/visibility.{type Access}
import scoutbox/vocab/playing_level
import scoutbox/vocab/position as positions
import sqlight

pub type Media {
  Media(clip: media_row.Row, tags: List(#(String, Int)))
}

pub type Player {
  Player(
    row: row.Row,
    media: List(Media),
    attendance: List(attendance_row.Row),
    timeline: List(timeline_row.Row),
    badges: List(String),
    drills: List(String),
    drill_results: List(drill_result_row.Row),
    activity_log: List(Int),
    external_ids: List(external_row.Row),
    season_history: List(season_row.Row),
    medical_records: List(medical_row.Row),
    programme_completed: List(completion_row.Row),
  )
}

// ------------------------------------------------------------------------------------------------ reads

fn ids_json(ids: List(String)) -> sqlight.Value {
  json.array(ids, json.string) |> json.to_string |> sqlight.text
}

/// Rows of a list table for these players, grouped by player, each group in position order.
fn lists_of(
  read: Read,
  table: String,
  columns: String,
  decoder: decode.Decoder(a),
  player_of: fn(a) -> String,
  ids: List(String),
) -> Result(dict.Dict(String, List(a)), Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY player_id, position",
    [ids_json(ids)],
    decoder,
  ))
  list.group(rows, player_of) |> dict.map_values(fn(_, rs) { list.reverse(rs) })
}

fn of(groups: dict.Dict(String, List(a)), id: String) -> List(a) {
  dict.get(groups, id) |> result.unwrap([])
}

/// The records for these rows, in the rows' order.
pub fn with_lists(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Player), Fail(e)) {
  let ids = list.map(rows, fn(r) { r.id })
  use media <- result.try(lists_of(
    read,
    media_row.table,
    media_row.columns,
    media_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use tags <- result.try(
    store.query(
      read,
      "SELECT "
        <> tag_row.qualified("t")
        <> " FROM player_media_tags t JOIN player_media m ON m.id = t.media_id WHERE m.player_id IN (SELECT value FROM json_each(?)) ORDER BY t.media_id, t.position",
      [ids_json(ids)],
      tag_row.decoder(),
    )
    |> result.map(fn(rows) {
      list.group(rows, fn(t) { t.media_id })
      |> dict.map_values(fn(_, ts) { list.reverse(ts) })
    }),
  )
  use attendance <- result.try(lists_of(
    read,
    attendance_row.table,
    attendance_row.columns,
    attendance_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use timeline <- result.try(lists_of(
    read,
    timeline_row.table,
    timeline_row.columns,
    timeline_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use badges <- result.try(lists_of(
    read,
    badge_row.table,
    badge_row.columns,
    badge_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use drills <- result.try(lists_of(
    read,
    drill_row.table,
    drill_row.columns,
    drill_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use drill_results <- result.try(lists_of(
    read,
    drill_result_row.table,
    drill_result_row.columns,
    drill_result_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use activity <- result.try(lists_of(
    read,
    activity_row.table,
    activity_row.columns,
    activity_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use external <- result.try(lists_of(
    read,
    external_row.table,
    external_row.columns,
    external_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use seasons <- result.try(lists_of(
    read,
    season_row.table,
    season_row.columns,
    season_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use medical <- result.try(lists_of(
    read,
    medical_row.table,
    medical_row.columns,
    medical_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  use completions <- result.map(lists_of(
    read,
    completion_row.table,
    completion_row.columns,
    completion_row.decoder(),
    fn(r) { r.player_id },
    ids,
  ))
  list.map(rows, fn(r) {
    Player(
      row: r,
      media: of(media, r.id)
        |> list.map(fn(m) {
          Media(m, of(tags, m.id) |> list.map(fn(t) { #(t.tag, t.count) }))
        }),
      attendance: of(attendance, r.id),
      timeline: of(timeline, r.id),
      badges: of(badges, r.id) |> list.map(fn(b) { b.badge }),
      drills: of(drills, r.id) |> list.map(fn(d) { d.drill_id }),
      drill_results: of(drill_results, r.id),
      activity_log: of(activity, r.id) |> list.map(fn(a) { a.occurred_at }),
      external_ids: of(external, r.id),
      season_history: of(seasons, r.id),
      medical_records: of(medical, r.id),
      programme_completed: of(completions, r.id),
    )
  })
}

fn select(where: String) -> String {
  "SELECT " <> row.qualified("p") <> " FROM players p " <> where
}

/// A live player (a deleted account's retained row is not one).
pub fn by_id(read: Read, id: String) -> Result(Option(Player), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    select("WHERE p.id = ? AND p.deleted_at IS NULL"),
    [sqlight.text(id)],
    row.decoder(),
  ))
  use players <- result.map(with_lists(read, rows))
  list.first(players) |> option.from_result
}

/// Live players by id, in the order given; unknown and deleted ids are skipped.
pub fn by_ids(read: Read, ids: List(String)) -> Result(List(Player), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    select(
      "JOIN json_each(?) j ON j.value = p.id WHERE p.deleted_at IS NULL ORDER BY j.key",
    ),
    [ids_json(ids)],
    row.decoder(),
  ))
  with_lists(read, rows)
}

/// A live player as `org` may see them: the record, and what the visibility rule and the blocks say.
pub fn for_org(
  read: Read,
  id: String,
  org: Org,
  now: Int,
) -> Result(Option(#(Player, Access)), Fail(e)) {
  for_org_many(read, [id], org, now)
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

/// Live players by id, in the order given, each with what the visibility rule and the blocks say for `org`.
pub fn for_org_many(
  read: Read,
  ids: List(String),
  org: Org,
  now: Int,
) -> Result(List(#(Player, Access)), Fail(e)) {
  let query =
    sql.concat([
      sql.text("SELECT " <> row.qualified("p") <> ", "),
      visibility.access_sql(org, now),
      sql.text(" FROM players p JOIN json_each("),
      sql.arg(ids_json(ids)),
      sql.text(
        ") j ON j.value = p.id WHERE p.deleted_at IS NULL ORDER BY j.key",
      ),
    ])
  use found <- result.try(store.query(
    read,
    query.sql,
    query.args,
    with_access(row.decoder(), row.width),
  ))
  use records <- result.map(with_lists(read, list.map(found, fn(f) { f.0 })))
  list.zip(records, list.map(found, fn(f) { f.1 }))
}

/// A row decoder followed by the three access columns `visibility.access_sql` adds.
fn with_access(
  decoder: decode.Decoder(a),
  width: Int,
) -> decode.Decoder(#(a, Access)) {
  use r <- decode.then(decoder)
  use a <- decode.then(visibility.access_decoder(width))
  decode.success(#(r, a))
}

pub fn count(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM players WHERE deleted_at IS NULL",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

// ----------------------------------------------------------------------------------------------- rules

pub fn is_adult(p: Player, now: Int) -> Bool {
  age.is_adult(p.row.birth_date, p.row.country, now)
}

const trust_base = 30

/// The profile-completeness figure (domain.ts `trustScoreFromFacts`), served as `profileSignal` and stored in
/// `players.profile_signal`, which the directory sorts by.
pub fn profile_signal_of(
  identity_verified identity_verified: Bool,
  attendance attendance: Int,
  trial_reports trial_reports: Int,
  media media: Int,
  complete complete: Bool,
) -> Int {
  let bonus = fn(on, n) {
    case on {
      True -> n
      False -> 0
    }
  }
  int.min(
    trust_base
      + bonus(identity_verified, 10)
      + int.min(attendance * 5, 20)
      + int.min(trial_reports * 8, 24)
      + int.min(media * 2, 10)
      + bonus(complete, 5),
    99,
  )
}

/// Position, foot, height, weight and some statistics.
pub fn profile_complete(r: row.Row) -> Bool {
  option.is_some(r.position)
  && option.is_some(r.foot)
  && option.is_some(r.height_cm)
  && option.is_some(r.weight_kg)
  && option.is_some(stats(r))
}

pub fn profile_signal(p: Player) -> Int {
  profile_signal_of(
    identity_verified: p.row.identity_verified,
    attendance: list.length(p.attendance),
    trial_reports: 0,
    media: list.length(p.media),
    complete: profile_complete(p.row),
  )
}

/// The trust breakdown a guardian and the player see (domain.ts `trustBreakdown`).
pub fn trust_breakdown(p: Player) -> Json {
  let bonus = fn(on, n) {
    case on {
      True -> n
      False -> 0
    }
  }
  json.object([
    #("base", json.int(trust_base)),
    #("identityVerified", json.int(bonus(p.row.identity_verified, 10))),
    #(
      "verifiedAttendance",
      json.int(int.min(list.length(p.attendance) * 5, 20)),
    ),
    #("trialReports", json.int(0)),
    #("media", json.int(int.min(list.length(p.media) * 2, 10))),
    #("profileComplete", json.int(bonus(profile_complete(p.row), 5))),
    #("total", json.int(profile_signal(p))),
  ])
}

pub type Stats {
  Stats(
    appearances: Option(Int),
    goals: Option(Int),
    assists: Option(Int),
    pace_kmh: Option(Float),
    pass_completion_pct: Option(Float),
    duel_success_pct: Option(Float),
    clean_sheets: Option(Int),
  )
}

/// The current season's figures; none when every column is NULL.
pub fn stats(r: row.Row) -> Option(Stats) {
  let s =
    Stats(
      r.stats_appearances,
      r.stats_goals,
      r.stats_assists,
      r.stats_pace_kmh,
      r.stats_pass_completion_pct,
      r.stats_duel_success_pct,
      r.stats_clean_sheets,
    )
  case s == Stats(None, None, None, None, None, None, None) {
    True -> None
    False -> Some(s)
  }
}

// ---------------------------------------------------------------------------------------------- writes

pub type NewPlayer {
  NewPlayer(
    name: String,
    dob: String,
    country: String,
    city: Option(String),
    position: Option(positions.Position),
    foot: Option(row.Foot),
    height_cm: Option(Int),
    weight_kg: Option(Int),
    location: Option(#(Float, Float)),
    password_hash: Option(String),
    guardian_id: Option(String),
    created_at: Int,
  )
}

/// Creates a player (its id minted here) with the profile signal its facts give.
pub fn create(tx: Tx, new: NewPlayer) -> Result(Player, Fail(e)) {
  use id <- result.try(ids.next(tx, "pl"))
  let base =
    row.Row(
      ..row.new(
        id:,
        name: new.name,
        birth_date: new.dob,
        country: new.country,
        profile_signal: 0,
      ),
      city: new.city,
      position: new.position,
      foot: new.foot,
      height_cm: new.height_cm,
      weight_kg: new.weight_kg,
      lat: option.map(new.location, fn(l) { l.0 }),
      lng: option.map(new.location, fn(l) { l.1 }),
      password_hash: new.password_hash,
      guardian_id: new.guardian_id,
      created_at: Some(new.created_at),
    )
  let signal =
    profile_signal_of(
      identity_verified: False,
      attendance: 0,
      trial_reports: 0,
      media: 0,
      // A new profile has no statistics yet, so it is not complete.
      complete: False,
    )
  use _ <- result.try(row.insert(tx, row.Row(..base, profile_signal: signal)))
  // A child is created with its primary guardian's link in the same transaction.
  use _ <- result.try(case new.guardian_id {
    Some(guardian_id) ->
      store.run(
        tx,
        "INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, 'primary')",
        [sqlight.text(guardian_id), sqlight.text(id)],
      )
    None -> Ok(Nil)
  })
  use found <- result.map(by_id(store.reading(tx), id))
  let assert Some(p) = found as "a player reads back once inserted"
  p
}

/// Appends a timeline entry at the end of the list.
pub fn add_timeline_entry(
  tx: Tx,
  player_id: String,
  year: String,
  event: String,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "INSERT INTO player_timeline (player_id, position, year, event) SELECT ?, COALESCE(MAX(position) + 1, 0), ?, ? FROM player_timeline WHERE player_id = ?",
    [
      sqlight.text(player_id),
      sqlight.text(year),
      sqlight.text(event),
      sqlight.text(player_id),
    ],
  )
}

// ----------------------------------------------------------------------------------------------- views

fn opt_string(v: Option(String)) -> Json {
  json.nullable(v, json.string)
}

fn opt_int(v: Option(Int)) -> Json {
  json.nullable(v, json.int)
}

fn opt_float(v: Option(Float)) -> Json {
  json.nullable(v, json.float)
}

/// A field that is omitted when NULL (playerSubrecords.ts: only a list's `nullable` fields read back as null).
fn present(
  name: String,
  v: Option(a),
  to_json: fn(a) -> Json,
) -> List(#(String, Json)) {
  case v {
    Some(v) -> [#(name, to_json(v))]
    None -> []
  }
}

pub fn stats_json(s: Option(Stats)) -> Json {
  json.nullable(s, fn(s) {
    json.object([
      #("appearances", opt_int(s.appearances)),
      #("goals", opt_int(s.goals)),
      #("assists", opt_int(s.assists)),
      #("paceKmh", opt_float(s.pace_kmh)),
      #("passCompletionPct", opt_float(s.pass_completion_pct)),
      #("duelSuccessPct", opt_float(s.duel_success_pct)),
      #("cleanSheets", opt_int(s.clean_sheets)),
    ])
  })
}

fn media_json(m: Media) -> Json {
  let c = m.clip
  json.object(
    list.flatten([
      [#("id", json.string(c.id)), #("title", json.string(c.title))],
      present("kind", c.kind, json.string),
      present("uploadedAt", c.uploaded_at, json.string),
      [
        #("url", opt_string(c.url)),
        #("views", json.int(c.views)),
        #("verifiedClip", opt_string(c.verified_clip_attendance_id)),
        #("captions", opt_string(c.captions)),
      ],
      present("sizeBytes", c.size_bytes, json.int),
      present(
        "capturedBy",
        option.map(c.captured_by, media_row.captured_by_to_string),
        json.string,
      ),
      present("boxSessionId", c.box_session_id, json.string),
      [
        #(
          "tags",
          json.object(list.map(m.tags, fn(t) { #(t.0, json.int(t.1)) })),
        ),
      ],
    ]),
  )
}

/// An attendance item as the player holds it, with the GPS fix.
fn attendance_json(a: attendance_row.Row) -> Json {
  json.object(
    list.flatten([
      [#("id", json.string(a.id)), #("fixture", json.string(a.fixture))],
      present("venue", a.venue, json.string),
      [#("date", json.string(a.match_date))],
      present("deviceConfirmed", a.device_confirmed, json.bool),
      [#("verified", json.bool(a.verified))],
      present("corroboratedBy", a.corroborated_by, json.string),
      present("trialId", a.trial_id, json.string),
      case a.lat, a.lng {
        Some(lat), Some(lng) -> [
          #(
            "gps",
            json.object([#("lat", json.float(lat)), #("lng", json.float(lng))]),
          ),
        ]
        _, _ -> [#("gps", json.null())]
      },
    ]),
  )
}

/// An attendance item as an organisation receives it (ORG_ATTENDANCE_FIELDS, in that order): a club never
/// learns where a player was.
fn org_attendance_json(a: attendance_row.Row) -> Json {
  json.object(
    list.flatten([
      [#("id", json.string(a.id)), #("fixture", json.string(a.fixture))],
      present("venue", a.venue, json.string),
      [
        #("date", json.string(a.match_date)),
        #("verified", json.bool(a.verified)),
      ],
      present("corroboratedBy", a.corroborated_by, json.string),
      present("deviceConfirmed", a.device_confirmed, json.bool),
      present("trialId", a.trial_id, json.string),
    ]),
  )
}

fn timeline_json(t: timeline_row.Row) -> Json {
  json.object([#("year", json.string(t.year)), #("event", json.string(t.event))])
}

fn season_json(s: season_row.Row) -> Json {
  json.object(
    list.flatten([
      [#("season", json.string(s.season))],
      present("appearances", s.appearances, json.float),
      present("goals", s.goals, json.float),
      present("assists", s.assists, json.float),
      present("paceKmh", s.pace_kmh, json.float),
      present("passCompletionPct", s.pass_completion_pct, json.float),
      present("duelSuccessPct", s.duel_success_pct, json.float),
      present("cleanSheets", s.clean_sheets, json.float),
    ]),
  )
}

fn medical_record_json(m: medical_row.Row) -> Json {
  json.object(
    list.flatten([
      [
        #("id", json.string(m.id)),
        #("type", json.string(m.type_)),
        #("title", json.string(m.title)),
      ],
      present("date", m.record_date, json.string),
      [
        #("layoffWeeks", opt_float(m.layoff_weeks)),
        #("cleared", json.nullable(m.cleared, json.bool)),
      ],
    ]),
  )
}

fn drill_result_json(d: drill_result_row.Row) -> Json {
  json.object(
    list.flatten([
      [#("id", json.string(d.id)), #("drillId", json.string(d.drill_id))],
      present("drillName", d.drill_name, json.string),
      [#("metric", json.string(d.metric))],
      present("unit", d.unit, json.string),
      [
        #("value", json.float(d.value)),
        #("verified", json.bool(d.verified)),
        #("ts", json.int(d.recorded_at)),
      ],
    ]),
  )
}

fn external_id_json(e: external_row.Row) -> Json {
  json.object(
    list.flatten([
      [
        #("provider", json.string(e.provider)),
        #("externalId", json.string(e.external_id)),
        #("source", json.string(e.source)),
      ],
      present("by", e.linked_by_name, json.string),
      [#("at", json.int(e.linked_at))],
      present("reviewId", e.review_id, json.string),
    ]),
  )
}

fn medical_json(p: Player) -> Json {
  json.object([
    #("shared", json.bool(p.row.medical_shared)),
    #("conditionStatus", json.string(p.row.medical_condition_status)),
    #("records", json.array(p.medical_records, medical_record_json)),
  ])
}

pub fn prefs_json(
  quiet_start: Option(String),
  quiet_end: Option(String),
  school_hours_mute: Option(Bool),
  timezone: Option(String),
) -> Json {
  case quiet_start, quiet_end, school_hours_mute, timezone {
    None, None, None, None -> json.null()
    _, _, _, _ ->
      json.object([
        #("quietStart", opt_string(quiet_start)),
        #("quietEnd", opt_string(quiet_end)),
        #("schoolHoursMute", json.nullable(school_hours_mute, json.bool)),
        #("timezone", opt_string(timezone)),
      ])
  }
}

fn programme_json(p: Player) -> Json {
  case
    p.row.programme_track,
    p.row.programme_started_at,
    p.programme_completed
  {
    None, None, [] -> json.null()
    track, started, completed ->
      json.object([
        #("track", opt_string(track)),
        #("startedAt", opt_int(started)),
        #(
          "completed",
          json.array(completed, fn(c) {
            json.object([
              #("sessionId", json.string(c.session_id)),
              #("ts", json.int(c.completed_at)),
            ])
          }),
        ),
      ])
  }
}

fn location_json(r: row.Row) -> Json {
  case r.lat, r.lng {
    Some(lat), Some(lng) ->
      json.object([#("lat", json.float(lat)), #("lng", json.float(lng))])
    _, _ -> json.null()
  }
}

/// The player's own record (SELF_PLAYER_FIELDS), as the player and, for a child, the guardian receive it.
pub fn self_fields(p: Player) -> List(#(String, Json)) {
  let r = p.row
  [
    #("id", json.string(r.id)),
    #("name", json.string(r.name)),
    #("dob", json.string(r.birth_date)),
    #("country", json.string(r.country)),
    #("city", opt_string(r.city)),
    #("position", opt_string(option.map(r.position, positions.to_string))),
    #("foot", opt_string(option.map(r.foot, row.foot_to_string))),
    #("heightCm", opt_int(r.height_cm)),
    #("weightKg", opt_int(r.weight_kg)),
    #("squadNumber", opt_int(r.squad_number)),
    #("contractUntil", opt_string(r.contract_until_date)),
    #("marketValueRange", opt_string(r.market_value_range)),
    #("agentName", opt_string(r.agent_name)),
    #("academyPlus", json.bool(r.academy_plus)),
    #("firstTeamSeeker", json.bool(r.first_team_seeker)),
    #("availability", row.availability_to_json(r.availability)),
    #("contractStatus", row.contract_status_to_json(r.contract_status)),
    #("level", playing_level.to_json(r.level)),
    #("footballCategory", opt_string(r.football_category)),
    #("identityVerified", json.bool(r.identity_verified)),
    #("guardianId", opt_string(r.guardian_id)),
    #("createdAt", opt_int(r.created_at)),
    #("location", location_json(r)),
    #("stats", stats_json(stats(r))),
    #("medical", medical_json(p)),
    #(
      "notificationPrefs",
      prefs_json(
        r.prefs_quiet_start,
        r.prefs_quiet_end,
        r.prefs_school_hours_mute,
        r.prefs_timezone,
      ),
    ),
    #("programme", programme_json(p)),
    #("media", json.array(p.media, media_json)),
    #("attendance", json.array(p.attendance, attendance_json)),
    #("timeline", json.array(p.timeline, timeline_json)),
    #("badges", json.array(p.badges, json.string)),
    #("drills", json.array(p.drills, json.string)),
    #("drillResults", json.array(p.drill_results, drill_result_json)),
    #("activityLog", json.array(p.activity_log, json.int)),
    #("externalIds", json.array(p.external_ids, external_id_json)),
    #("seasonHistory", json.array(p.season_history, season_json)),
    // Not ported yet: the trials' reports.
    #("trialReports", json.preprocessed_array([])),
  ]
}

pub fn self_view(p: Player) -> Json {
  json.object(self_fields(p))
}

pub fn age_now(p: Player, now: Int) -> Option(Int) {
  age.age_on(p.row.birth_date, now)
}

pub fn season_history_json(p: Player) -> Json {
  json.array(p.season_history, season_json)
}

fn age_json(p: Player, now: Int) -> Json {
  json.nullable(age.age_on(p.row.birth_date, now), json.int)
}

/// A guardian's view of their child: the child's own record and the derived figures.
pub fn guardian_child_view(p: Player, now: Int) -> Json {
  json.object(
    list.append(self_fields(p), [
      #("age", age_json(p, now)),
      #("trustScore", json.int(profile_signal(p))),
      #("trust", trust_breakdown(p)),
    ]),
  )
}

/// What an organisation receives (orgPlayerView), or `None` when it may not see the player. `access` is what
/// `for_org` read with the record.
pub fn org_view(p: Player, org: Org, access: Access, now: Int) -> Option(Json) {
  case access.visible && !access.blocked {
    False -> None
    True -> Some(json.object(org_fields(p, org, access, now)))
  }
}

pub fn org_fields(
  p: Player,
  org: Org,
  access: Access,
  now: Int,
) -> List(#(String, Json)) {
  let r = p.row
  let minor = !is_adult(p, now)
  let grassroots = orgs.is_grassroots(org)
  let pro_market = fn(fields) {
    case grassroots {
      True -> []
      False -> fields
    }
  }
  let signal = profile_signal(p)
  list.flatten([
    [
      #("id", json.string(r.id)),
      #("name", json.string(r.name)),
      #("position", opt_string(option.map(r.position, positions.to_string))),
      #("foot", opt_string(option.map(r.foot, row.foot_to_string))),
      #("heightCm", opt_int(r.height_cm)),
      #("weightKg", opt_int(r.weight_kg)),
      #("country", json.string(r.country)),
      // A child's city is withheld; the key keeps its place.
      #("city", case minor {
        True -> json.string("")
        False -> opt_string(r.city)
      }),
      #("level", playing_level.to_json(r.level)),
      #("availability", row.availability_to_json(r.availability)),
      #("contractStatus", row.contract_status_to_json(r.contract_status)),
      #("identityVerified", json.bool(r.identity_verified)),
      #("footballCategory", opt_string(r.football_category)),
      #("squadNumber", opt_int(r.squad_number)),
      #("createdAt", opt_int(r.created_at)),
      #("firstTeamSeeker", json.bool(r.first_team_seeker)),
    ],
    // Grassroots is semi-pro and below: the pro-market surface does not exist on that platform.
    pro_market([
      #("academyPlus", json.bool(r.academy_plus)),
      #("marketValueRange", opt_string(r.market_value_range)),
      #("agentName", opt_string(r.agent_name)),
      #("contractUntil", opt_string(r.contract_until_date)),
    ]),
    [
      #("stats", stats_json(stats(r))),
      #("seasonHistory", json.array(p.season_history, season_json)),
      #("badges", json.array(p.badges, json.string)),
      #("timeline", json.array(p.timeline, timeline_json)),
      #("drills", json.array(p.drills, json.string)),
      #("media", json.array(p.media, media_json)),
      #("age", age_json(p, now)),
      // Profile completeness, not the Trust Score; `trustScore` stays on the wire as a deprecated alias.
      #("profileSignal", json.int(signal)),
      #("trustScore", json.int(signal)),
      #("guardianManaged", json.bool(minor)),
      #("medical", case r.medical_shared {
        True -> medical_json(p)
        False ->
          json.object([
            #("shared", json.bool(False)),
            #("records", json.preprocessed_array([])),
            #("conditionStatus", json.string("not_shared")),
            #(
              "note",
              json.string(
                "Medical data is player-controlled and has not been shared.",
              ),
            ),
          ])
      }),
      #("attendance", json.array(p.attendance, org_attendance_json)),
      // Not ported yet: this organisation's own trial reports, from the trials.
      #("trialReports", json.preprocessed_array([])),
    ],
    case minor {
      True -> [#("contactPolicy", json.string("guardian_only"))]
      False -> []
    },
    case grassroots {
      True -> [
        #(
          "distanceKm",
          json.nullable(access.distance_tenths, fn(t) {
            json.float(int.to_float(t) /. 10.0)
          }),
        ),
      ]
      False -> []
    },
    // Coach references travel with grassroots-journey players.
    // Not ported yet: the vouches belong to verification.
    case r.level == playing_level.Pro {
      True -> []
      False -> [#("vouches", json.preprocessed_array([]))]
    },
  ])
}

// ---------------------------------------------------------------------------------- the record's acts

/// Sets columns of a live player, then keeps `profile_signal` in step with the facts it is worked out from.
fn update(
  tx: Tx,
  id: String,
  sets: List(#(String, sqlight.Value)),
) -> Result(Player, Fail(e)) {
  use _ <- result.try(case sets {
    [] -> Ok(Nil)
    _ ->
      store.run(
        tx,
        "UPDATE players SET "
          <> list.map(sets, fn(s) { s.0 <> " = ?" }) |> string.join(", ")
          <> " WHERE id = ? AND deleted_at IS NULL",
        list.append(list.map(sets, fn(s) { s.1 }), [sqlight.text(id)]),
      )
  })
  refreshed(tx, id)
}

fn refreshed(tx: Tx, id: String) -> Result(Player, Fail(e)) {
  use found <- result.try(by_id(store.reading(tx), id))
  let assert Some(p) = found as "an act names a live player"
  case profile_signal(p) == p.row.profile_signal {
    True -> Ok(p)
    False -> {
      let signal = profile_signal(p)
      use _ <- result.map(
        store.run(tx, "UPDATE players SET profile_signal = ? WHERE id = ?", [
          sqlight.int(signal),
          sqlight.text(id),
        ]),
      )
      Player(..p, row: row.Row(..p.row, profile_signal: signal))
    }
  }
}

pub fn set_availability(
  tx: Tx,
  id: String,
  availability: Option(row.Availability),
  contract_status: Option(row.ContractStatus),
) -> Result(Player, Fail(e)) {
  update(
    tx,
    id,
    option.values([
      option.map(availability, fn(a) {
        #("availability", sqlight.text(row.availability_to_string(a)))
      }),
      option.map(contract_status, fn(c) {
        #("contract_status", sqlight.text(row.contract_status_to_string(c)))
      }),
    ]),
  )
}

pub type Switch {
  FirstTeamSeeker
  AcademyPlus
  MedicalShared
}

pub fn set_switch(
  tx: Tx,
  id: String,
  switch: Switch,
  on: Bool,
) -> Result(Player, Fail(e)) {
  let column = case switch {
    FirstTeamSeeker -> "first_team_seeker"
    AcademyPlus -> "academy_plus"
    MedicalShared -> "medical_shared"
  }
  update(tx, id, [#(column, sqlight.bool(on))])
}

/// Figures for the current season: the given ones set, and appearances, goals and assists that were never
/// recorded start at 0.
pub fn record_stats(tx: Tx, id: String, s: Stats) -> Result(Player, Fail(e)) {
  let int = fn(column, v) { option.map(v, fn(n) { #(column, sqlight.int(n)) }) }
  let real = fn(column, v) {
    option.map(v, fn(f) { #(column, sqlight.float(f)) })
  }
  let given =
    option.values([
      int("stats_appearances", s.appearances),
      int("stats_goals", s.goals),
      int("stats_assists", s.assists),
      real("stats_pace_kmh", s.pace_kmh),
      real("stats_pass_completion_pct", s.pass_completion_pct),
      real("stats_duel_success_pct", s.duel_success_pct),
      int("stats_clean_sheets", s.clean_sheets),
    ])
  let zeroed =
    [
      #("stats_appearances", s.appearances),
      #("stats_goals", s.goals),
      #("stats_assists", s.assists),
    ]
    |> list.filter(fn(c) { c.1 == None })
    |> list.map(fn(c) { c.0 <> " = COALESCE(" <> c.0 <> ", 0)" })
  use _ <- result.try(case zeroed {
    [] -> Ok(Nil)
    _ ->
      store.run(
        tx,
        "UPDATE players SET " <> string.join(zeroed, ", ") <> " WHERE id = ?",
        [sqlight.text(id)],
      )
  })
  update(tx, id, given)
}

/// Replaces the badges, in order; a legal duplicate is kept.
pub fn set_badges(
  tx: Tx,
  id: String,
  badges: List(String),
) -> Result(Player, Fail(e)) {
  use _ <- result.try(
    store.run(tx, "DELETE FROM player_badges WHERE player_id = ?", [
      sqlight.text(id),
    ]),
  )
  use _ <- result.try(
    list.index_map(badges, fn(b, i) { #(b, i) })
    |> list.try_each(fn(p) {
      badge_row.insert(
        tx,
        badge_row.Row(player_id: id, position: p.1, badge: p.0),
      )
    }),
  )
  refreshed(tx, id)
}

pub type Prefs {
  Prefs(
    quiet_start: Option(String),
    quiet_end: Option(String),
    school_hours_mute: Option(Bool),
    timezone: Option(String),
  )
}

pub fn set_prefs(tx: Tx, id: String, p: Prefs) -> Result(Player, Fail(e)) {
  update(tx, id, [
    #("prefs_quiet_start", sqlight.nullable(sqlight.text, p.quiet_start)),
    #("prefs_quiet_end", sqlight.nullable(sqlight.text, p.quiet_end)),
    #(
      "prefs_school_hours_mute",
      sqlight.nullable(sqlight.bool, p.school_hours_mute),
    ),
    #("prefs_timezone", sqlight.nullable(sqlight.text, p.timezone)),
  ])
}

pub fn prefs(p: Player) -> Prefs {
  Prefs(
    p.row.prefs_quiet_start,
    p.row.prefs_quiet_end,
    p.row.prefs_school_hours_mute,
    p.row.prefs_timezone,
  )
}

/// Records football activity at `at`: it feeds the streak and the weekly goal.
pub fn log_activity(tx: Tx, id: String, at: Int) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "INSERT INTO player_activity_log (player_id, position, occurred_at) SELECT ?, COALESCE(MAX(position) + 1, 0), ? FROM player_activity_log WHERE player_id = ?",
    [sqlight.text(id), sqlight.int(at), sqlight.text(id)],
  )
}
