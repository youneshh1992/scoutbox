//// The Football Passport's routes (domains/passport/passport.mjs): each viewer's projection of the assembled
//// Passport, and the few records the Passport owns: preferences, self-submitted career entries and achievements,
//// and correction requests. A Passport describes evidence and provenance; it never rates a player, and the Trust
//// Score is not embedded in it.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/set
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players.{type Player}
import scoutbox/messaging/notifications
import scoutbox/passport/passport_rules.{type Viewer} as rules
import scoutbox/passport/sources
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/metrics
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/orgs as org_row
import scoutbox/rows/passport_achievements as achievement_row
import scoutbox/rows/passport_career_entries as career_row
import scoutbox/rows/passport_corrections as correction_row
import scoutbox/rows/passport_position_history as position_history_row
import scoutbox/rows/passport_position_history_positions as history_position_row
import scoutbox/rows/passport_prefs as prefs_row
import scoutbox/rows/source_changes as source_change_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import scoutbox/vocab/party.{type Party}
import scoutbox/vocab/position.{type Position}
import sqlight
import wisp.{type Request, type Response}

// PASSPORT_LIMITS (repositories/passport.ts).
const bio_max = 400

const org_name_max = 100

const role_max = 60

const note_max = 200

const title_max = 120

const reason_max = 500

const resolution_reason_max = 400

const target_id_max = 80

const selection_max = 120

const selections_max = 100

const secondary_max = 3

const name_max = 200

/// The newest source changes kept (SOURCE_CHANGE_CAP).
const source_change_cap = 20_000

// ------------------------------------------------------------------------------------------------ metrics

const metric_names = [
  "views_self", "views_guardian", "views_recruitment", "share_created",
  "share_revoked", "share_opened_public", "share_opened_recruitment",
  "batch_summaries", "correction_filed", "achievement_confirmed",
]

/// Counts one Passport event (`vmetric`): counters only, never a player or a recruiter.
pub fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, "passport", name)
}

/// The `passport` group of `/admin/metrics`.
pub fn metrics_json(tx: Tx) -> Result(Json, Fail(e)) {
  metrics.group(tx, "passport", metric_names)
}

fn counted(ctx: Ctx, name: String, next: fn() -> Response) -> Response {
  case store.unit(ctx.store, count(_, name)) {
    Ok(Nil) -> next()
    Error(e) -> http.internal(e)
  }
}

// ------------------------------------------------------------------------------------------------ views

/// A player's whole Passport as `viewer` is shown it.
fn projection(
  ctx: Ctx,
  p: Player,
  viewer: Viewer,
  opts: rules.Opts,
) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, sources.assemble(_, p, False, now)) {
    Ok(full) -> http.json(200, rules.project(full, viewer, opts))
    Error(e) -> http.internal(e)
  }
}

/// `GET /player/football-passport`.
pub fn player_view(ctx: Ctx, a: PlayerAccess) -> Response {
  use <- counted(ctx, "views_self")
  projection(ctx, a.player, rules.SelfViewer, rules.no_opts)
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
        Error(e) -> http.internal(e)
      }
  }
}

/// `GET /guardian/children/:id/football-passport`.
pub fn guardian_view(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  use child <- child_of(ctx, g, child_id)
  use <- counted(ctx, "views_guardian")
  projection(ctx, child, rules.GuardianViewer, rules.no_opts)
}

fn viewer_for(org: org_row.Row) -> Viewer {
  case org.type_, org.level {
    org_type.Agency, _ -> rules.AgencyViewer
    _, Some(org_row.LevelGrassroots) -> rules.GrassrootsClub
    _, _ -> rules.ProClub
  }
}

/// A player this organisation may see (orgCanSee), or the refusal: 404 when there is no such player, the
/// under-18 wall for an agency, and NOT_VISIBLE otherwise.
fn visible_player(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
  next: fn(Player) -> Response,
) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, players.for_org(_, player_id, a.org, now)) {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Ok(Some(#(p, seen))) ->
      case seen.visible && !seen.blocked {
        True -> next(p)
        False ->
          http.error(403, case a.org.type_, players.is_adult(p, now) {
            org_type.Agency, False -> "UNDER_18_WALL"
            _, _ -> "NOT_VISIBLE"
          })
      }
  }
}

/// `GET /org/players/:id/football-passport`: recorded on the Discovery Ledger as a recruitment view.
pub fn org_view(ctx: Ctx, a: OrgAccess, player_id: id.PlayerId) -> Response {
  use p <- visible_player(ctx, a, player_id)
  let now = clock.now_ms()
  let viewed =
    store.unit(ctx.store, fn(tx) {
      use _ <- result.try(ledger.append(
        tx,
        ledger.Entry(
          entry_type: ledger_row.PassportRecruitmentView,
          player_id: Some(p.row.id),
          org_id: Some(a.org.id),
          org_name: Some(a.org.name),
          user_id: Some(a.user.id),
          actor_name: Some(a.user.name),
        ),
        now,
      ))
      count(tx, "views_recruitment")
    })
  case viewed {
    Error(e) -> http.internal(e)
    Ok(_) ->
      projection(
        ctx,
        p,
        viewer_for(a.org),
        rules.Opts(org_id: Some(a.org.id), share_mode: None),
      )
  }
}

/// What a share link opens: the projection for its mode (`public`, or `recruitment` inside an organisation's
/// session, which has already re-run the standing gates).
pub fn shared_projection(
  read: Read,
  p: Player,
  viewer: Viewer,
  opts: rules.Opts,
  now: Int,
) -> Result(Json, Fail(e)) {
  sources.assemble(read, p, False, now)
  |> result.map(rules.project(_, viewer, opts))
}

pub fn org_viewer(org: org_row.Row) -> Viewer {
  viewer_for(org)
}

/// `GET /org/football-passports?ids=`: light summaries of the players this organisation may see. Anyone else is
/// absent, not an error, so nothing is revealed.
pub fn batch(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use ids <- input.field("ids", input.optional(input.ids_text(100)))
    input.done(option.unwrap(ids, []))
  }
  use ids <- http.query(req, shape, [])
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use seen <- result.try(players.for_org_many(
        read,
        list.map(ids, id.player),
        a.org,
        now,
      ))
      seen
      |> list.filter(fn(s) { { s.1 }.visible && !{ s.1 }.blocked })
      |> list.try_map(fn(s) { sources.assemble(read, s.0, True, now) })
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(fulls) -> {
      use <- counted(ctx, "batch_summaries")
      http.json(
        200,
        json.object([
          #("items", json.array(fulls, summary_json)),
        ]),
      )
    }
  }
}

fn summary_json(full: rules.Full) -> Json {
  json.object([
    #("playerId", id.player_json(full.player.id)),
    #(
      "position",
      json.nullable(
        option.map(full.player.position, position.to_string),
        json.string,
      ),
    ),
    #("age", json.nullable(full.player.age, json.int)),
    #("currentClub", case full.status.current_club {
      Some(c) ->
        json.object([
          #("name", json.nullable(c.org_name, json.string)),
          #("provenance", json.string(rules.provenance_to_string(c.provenance))),
        ])
      None -> json.null()
    }),
    #("evidenceCoverage", json.string(full.completeness.coverage)),
    #(
      "lastEvidenceDays",
      json.nullable(full.evidence_summary.last_evidence_days, json.int),
    ),
    #("references", json.int(full.evidence_summary.references)),
    #(
      "availability",
      json.nullable(full.status.availability, prefs_row.availability_to_json),
    ),
    #("identityConfirmed", json.bool(full.identity)),
  ])
}

/// `GET /admin/passport/:playerId/graph`: Trust & Safety's view, with every event's source and visibility.
pub fn admin_graph(ctx: Ctx, player_id: id.PlayerId) -> Response {
  case store.read(ctx.store, players.by_id(_, player_id)) {
    Ok(Some(p)) -> projection(ctx, p, rules.TrustSafety, rules.no_opts)
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Error(e) -> http.internal(e)
  }
}

// ------------------------------------------------------------------------------------------------ football dates

const football_date_forms = "YYYY, YYYY-MM or YYYY-MM-DD"

fn is_football_shape(s: String) -> Bool {
  let digits = fn(x: String) {
    x != ""
    && string.to_graphemes(x)
    |> list.all(fn(g) { string.contains("0123456789", g) })
  }
  case string.split(s, "-") {
    [y] -> string.length(y) == 4 && digits(y)
    [y, m] ->
      string.length(y) == 4 && digits(y) && string.length(m) == 2 && digits(m)
    [y, m, d] ->
      string.length(y) == 4
      && digits(y)
      && string.length(m) == 2
      && digits(m)
      && string.length(d) == 2
      && digits(d)
    _ -> False
  }
}

/// A football date as stored (storedDate): the precision the player gave, never an invented day; the milliseconds
/// of a day are stored as that day.
fn stored_date(v: Dynamic) -> Result(String, Nil) {
  case decode.run(v, decode.string), decode.run(v, decode.int) {
    Ok(s), _ ->
      case is_football_shape(s) {
        True ->
          rules.when_of(s)
          |> option.map(rules.when_display)
          |> option.to_result(Nil)
        False -> Error(Nil)
      }
    _, Ok(ms) ->
      case int.absolute_value(ms) <= 9_007_199_254_740_991 {
        True -> Ok(rules.when_display(rules.when_at(ms)))
        False -> Error(Nil)
      }
    _, _ -> Error(Nil)
  }
}

/// A year, a month or a day, written as the player gave it (footballDate).
fn football_date() -> input.Check(String) {
  input.date_written_as(stored_date, football_date_forms)
}

/// A football date a form may leave empty: "" is no date (footballDateOrBlank).
fn football_date_or_blank() -> input.Check(Option(String)) {
  input.date_written_as(
    fn(v) {
      case decode.run(v, decode.string) {
        Ok("") -> Ok(None)
        _ -> stored_date(v) |> result.map(Some)
      }
    },
    football_date_forms,
  )
}

fn flat(o: Option(Option(a))) -> Option(a) {
  option.flatten(o)
}

// ------------------------------------------------------------------------------------------------ preferences

type PositionsInput {
  PositionsInput(primary: Option(Position), secondary: List(Position))
}

type HistoryAdd {
  HistoryAdd(from: Option(String), primary: Position, secondary: List(Position))
}

/// A preferences edit. A field left out keeps its value; null clears it.
type PrefsEdit {
  PrefsEdit(
    bio: Option(Option(String)),
    positions: Option(Option(PositionsInput)),
    history_add: Option(HistoryAdd),
    availability: Option(Option(prefs_row.Availability)),
    available_from: Option(Option(String)),
    public_selections: Option(Option(List(String))),
  )
}

fn positions_shape() -> input.Shape(PositionsInput) {
  use primary <- input.field(
    "primary",
    input.nullish(input.one_of(position.pairs)),
  )
  use secondary <- input.field(
    "secondary",
    input.nullish(input.list_of(input.one_of(position.pairs), secondary_max)),
  )
  input.done(PositionsInput(primary, option.unwrap(secondary, [])))
}

fn prefs_shape() -> input.Shape(PrefsEdit) {
  use bio <- input.field("bio", input.clearable(input.text(bio_max)))
  use positions <- input.field(
    "positions",
    input.clearable(input.object(positions_shape())),
  )
  use history_add <- input.field(
    "positionHistoryAdd",
    input.nullish(
      input.object({
        use from <- input.field("from", input.nullish(football_date()))
        use primary <- input.field(
          "primary",
          input.required(input.one_of(position.pairs)),
        )
        use secondary <- input.field(
          "secondary",
          input.nullish(input.list_of(
            input.one_of(position.pairs),
            secondary_max,
          )),
        )
        input.done(HistoryAdd(from, primary, option.unwrap(secondary, [])))
      }),
    ),
  )
  use availability <- input.field(
    "availability",
    input.clearable(input.one_of(prefs_row.availability_pairs)),
  )
  use available_from <- input.field(
    "availableFrom",
    input.clearable(football_date_or_blank()),
  )
  use public_selections <- input.field(
    "publicSelections",
    input.clearable(input.list_of(
      input.text_between(1, selection_max),
      selections_max,
    )),
  )
  input.done(PrefsEdit(
    bio:,
    positions:,
    history_add:,
    availability:,
    available_from: option.map(available_from, flat),
    public_selections:,
  ))
}

fn distinct(items: List(a)) -> List(a) {
  list.fold(items, #(set.new(), []), fn(acc, x) {
    case set.contains(acc.0, x) {
      True -> acc
      False -> #(set.insert(acc.0, x), [x, ..acc.1])
    }
  }).1
  |> list.reverse
}

fn prefs_row_of(
  read: Read,
  player_id: id.PlayerId,
) -> Result(Option(prefs_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> prefs_row.columns <> " FROM passport_prefs WHERE player_id = ?",
    [id.player_sql(player_id)],
    prefs_row.decoder(),
  )
  |> result.map(option.from_result)
}

fn position_sql(p: Position) -> sqlight.Value {
  sqlight.text(position.to_string(p))
}

fn record_position_change(
  tx: Tx,
  player_id: id.PlayerId,
  system: source_change_row.SourceSystem,
  source_id: String,
  at: Int,
  from: Option(String),
  to: Option(String),
  by: Party,
) -> Result(Nil, Fail(e)) {
  use change_id <- result.try(id.next_source_change(tx))
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO source_changes (id, player_id, type, source_system, source_id, occurred_at, detail_position_from, detail_position_to, detail_submitted_by) VALUES (?, ?, 'position_changed', ?, ?, ?, ?, ?, ?)",
      [
        id.source_change_sql(change_id),
        id.player_sql(player_id),
        sqlight.text(source_change_row.source_system_to_string(system)),
        sqlight.text(source_id),
        sqlight.int(at),
        sqlight.nullable(sqlight.text, from),
        sqlight.nullable(sqlight.text, to),
        sqlight.text(party.to_string(by)),
      ],
    ),
  )
  store.run(
    tx,
    "DELETE FROM source_changes WHERE seq <= (SELECT seq FROM source_changes ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    [sqlight.int(source_change_cap)],
  )
}

/// Saves an edit of `player_id`'s preferences. A change of primary position, and a position history entry, are
/// each recorded as a source change with its own clock: neither a football date nor the preferences' edit time
/// means "the position changed", and re-saving the same preferences records nothing.
fn save_prefs(
  tx: Tx,
  player_id: id.PlayerId,
  edit: PrefsEdit,
  bio: Option(Option(String)),
  by: Party,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let read = store.reading(tx)
  use before <- result.try(prefs_row_of(read, player_id))
  let was_primary = option.then(before, fn(r) { r.position_primary })
  let base =
    option.unwrap(
      before,
      prefs_row.Row(
        player_id:,
        bio: None,
        position_primary: None,
        availability: None,
        available_from: None,
        updated_at: now,
      ),
    )
  let pick = fn(edit: Option(a), current: a) { option.unwrap(edit, current) }
  let primary = case edit.positions {
    Some(Some(p)) -> p.primary
    Some(None) -> None
    None -> base.position_primary
  }
  use _ <- result.try(
    store.run(
      tx,
      "INSERT INTO passport_prefs (player_id, bio, position_primary, availability, available_from, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (player_id) DO UPDATE SET bio = excluded.bio, position_primary = excluded.position_primary, availability = excluded.availability, available_from = excluded.available_from, updated_at = excluded.updated_at",
      [
        id.player_sql(player_id),
        sqlight.nullable(sqlight.text, pick(bio, base.bio)),
        sqlight.nullable(position_sql, primary),
        sqlight.nullable(
          fn(a) { sqlight.text(prefs_row.availability_to_string(a)) },
          pick(edit.availability, base.availability),
        ),
        sqlight.nullable(
          sqlight.text,
          pick(edit.available_from, base.available_from),
        ),
        sqlight.int(now),
      ],
    ),
  )
  use _ <- result.try(case edit.positions {
    None -> Ok(Nil)
    Some(positions) -> {
      let others = case positions {
        Some(p) -> distinct(p.secondary)
        None -> []
      }
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM passport_pref_positions WHERE player_id = ?",
          [id.player_sql(player_id)],
        ),
      )
      list.index_map(others, fn(p, i) { #(i, p) })
      |> list.try_each(fn(pair) {
        store.run(
          tx,
          "INSERT INTO passport_pref_positions (player_id, ord, code) VALUES (?, ?, ?)",
          [id.player_sql(player_id), sqlight.int(pair.0), position_sql(pair.1)],
        )
      })
    }
  })
  use _ <- result.try(case edit.public_selections {
    None -> Ok(Nil)
    Some(selections) -> {
      use _ <- result.try(
        store.run(
          tx,
          "DELETE FROM passport_public_selections WHERE player_id = ?",
          [id.player_sql(player_id)],
        ),
      )
      option.unwrap(selections, [])
      |> distinct
      |> list.index_map(fn(s, i) { #(i, s) })
      |> list.try_each(fn(pair) {
        store.run(
          tx,
          "INSERT INTO passport_public_selections (player_id, ord, selection) VALUES (?, ?, ?)",
          [id.player_sql(player_id), sqlight.int(pair.0), sqlight.text(pair.1)],
        )
      })
    }
  })
  use _ <- result.try(case primary == was_primary {
    True -> Ok(Nil)
    False ->
      record_position_change(
        tx,
        player_id,
        source_change_row.PassportPrefs,
        id.player_to_string(player_id)
          <> ":"
          <> option.map(primary, position.to_string)
        |> option.unwrap("none"),
        now,
        option.map(was_primary, position.to_string),
        option.map(primary, position.to_string),
        by,
      )
  })
  case edit.history_add {
    None -> Ok(Nil)
    Some(h) -> {
      let assert Some(from) = h.from
        as "the route refuses an entry without a date"
      use entry <- result.try(id.next_position_entry(tx))
      use _ <- result.try(
        store.run(
          tx,
          "INSERT INTO passport_position_history (id, player_id, from_date, position_primary, submitted_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            id.position_entry_sql(entry),
            id.player_sql(player_id),
            sqlight.text(from),
            position_sql(h.primary),
            sqlight.text(party.to_string(by)),
            sqlight.int(now),
          ],
        ),
      )
      use _ <- result.try(
        distinct(h.secondary)
        |> list.index_map(fn(p, i) { #(i, p) })
        |> list.try_each(fn(pair) {
          store.run(
            tx,
            "INSERT INTO passport_position_history_positions (history_id, ord, code) VALUES (?, ?, ?)",
            [
              id.position_entry_sql(entry),
              sqlight.int(pair.0),
              position_sql(pair.1),
            ],
          )
        }),
      )
      record_position_change(
        tx,
        player_id,
        source_change_row.PositionHistory,
        id.position_entry_to_string(entry),
        now,
        None,
        Some(position.to_string(h.primary)),
        by,
      )
    }
  }
}

/// The stored preferences (prefsView).
fn prefs_view(read: Read, player_id: id.PlayerId) -> Result(Json, Fail(e)) {
  use row <- result.try(prefs_row_of(read, player_id))
  use p <- result.try(sources.prefs(read, player_id))
  use entries <- result.try(store.query(
    read,
    "SELECT "
      <> position_history_row.columns
      <> " FROM passport_position_history WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player_id)],
    position_history_row.decoder(),
  ))
  use entries <- result.map(
    list.try_map(entries, fn(h) {
      use others <- result.map(store.query(
        read,
        "SELECT "
          <> history_position_row.columns
          <> " FROM passport_position_history_positions WHERE history_id = ? ORDER BY ord",
        [id.position_entry_sql(h.id)],
        history_position_row.decoder(),
      ))
      json.object([
        #("id", id.position_entry_json(h.id)),
        #("from", json.string(h.from_date)),
        #("primary", json.string(position.to_string(h.position_primary))),
        #(
          "secondary",
          json.array(others, fn(o) { json.string(position.to_string(o.code)) }),
        ),
        #("submittedBy", party.to_json(h.submitted_by)),
        #("recordedAt", json.int(h.recorded_at)),
      ])
    }),
  )
  json.object([
    #("playerId", id.player_json(player_id)),
    #("bio", json.nullable(p.bio, json.string)),
    #("positions", json.nullable(p.positions, rules.positions_json)),
    #("positionHistory", json.preprocessed_array(entries)),
    #(
      "availability",
      json.nullable(p.availability, prefs_row.availability_to_json),
    ),
    #("availableFrom", json.nullable(p.available_from, json.string)),
    #("publicSelections", json.array(p.public_selections, json.string)),
    #(
      "updatedAt",
      json.nullable(option.map(row, fn(r) { r.updated_at }), json.int),
    ),
  ])
}

const prefs_codes = [#("availability", "AVAILABILITY_INVALID")]

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

fn apply_prefs(ctx: Ctx, req: Request, p: Player, by: Party) -> Response {
  use edit <- http.body(req, prefs_shape(), prefs_codes)
  let bio = option.map(edit.bio, input.filled)
  let moderated = fn(next) {
    case flat(bio) {
      Some(text) ->
        moderate.or_refuse(ctx, text, context("passport_bio", p.row.id), next)
      None -> next()
    }
  }
  use <- moderated
  case edit.history_add {
    Some(HistoryAdd(from: None, ..)) ->
      http.json(
        400,
        json.object([
          #("error", json.string("DATE_REQUIRED")),
          #("field", json.string("positionHistoryAdd.from")),
          #("problem", json.string("required")),
          #("message", json.string("Position history needs at least a year.")),
        ]),
      )
    _ -> {
      let now = clock.now_ms()
      let saved =
        store.unit(ctx.store, fn(tx) {
          use _ <- result.try(save_prefs(tx, p.row.id, edit, bio, by, now))
          prefs_view(store.reading(tx), p.row.id)
        })
      case saved {
        Ok(view) -> http.json(200, json.object([#("prefs", view)]))
        Error(e) -> http.internal(e)
      }
    }
  }
}

/// `PATCH /player/football-passport/prefs`.
pub fn player_prefs(ctx: Ctx, req: Request, a: PlayerAccess) -> Response {
  apply_prefs(ctx, req, a.player, party.Player)
}

/// `PATCH /guardian/children/:id/football-passport/prefs`.
pub fn guardian_prefs(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  apply_prefs(ctx, req, child, party.Guardian)
}

// ------------------------------------------------------------------------------------------------ career entries

type CareerInput {
  CareerInput(
    org_name: Option(String),
    role: Option(String),
    note: Option(String),
    from: Option(String),
    to: Option(String),
  )
}

fn entry_view(e: career_row.Row) -> Json {
  json.object([
    #("id", id.career_entry_json(e.id)),
    #("playerId", id.player_json(e.player_id)),
    #("orgName", json.string(e.org_name)),
    #("role", json.nullable(e.role, json.string)),
    #("from", json.string(e.from_date)),
    #("to", json.nullable(e.to_date, json.string)),
    #("note", json.nullable(e.note, json.string)),
    #("submittedBy", party.to_json(e.submitted_by)),
    #("createdAt", json.int(e.created_at)),
    #("withdrawnAt", json.nullable(e.withdrawn_at, json.int)),
  ])
}

fn add_career_entry(
  ctx: Ctx,
  req: Request,
  p: Player,
  by: Party,
  answer: fn(career_row.Row) -> Response,
) -> Response {
  let shape = {
    use org_name <- input.field(
      "orgName",
      input.nullish(input.text(org_name_max)),
    )
    use role <- input.field("role", input.nullish(input.text(role_max)))
    use note <- input.field("note", input.nullish(input.text(note_max)))
    use from <- input.field("from", input.nullish(football_date()))
    use to <- input.field("to", input.nullish(football_date()))
    input.done(CareerInput(org_name:, role:, note:, from:, to:))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.org_name) {
    None -> http.required("ORG_NAME_REQUIRED", "orgName")
    Some(org_name) -> {
      let role = input.filled(body.role)
      let note = input.filled(body.note)
      use <- moderate.or_refuse(
        ctx,
        org_name
          <> " "
          <> option.unwrap(role, "")
          <> " "
          <> option.unwrap(note, ""),
        context("passport_career", p.row.id),
      )
      case body.from {
        None ->
          http.json(
            400,
            json.object([
              #("error", json.string("DATE_REQUIRED")),
              #("field", json.string("from")),
              #("problem", json.string("required")),
              #(
                "message",
                json.string(
                  "A year is enough — exact dates are never invented.",
                ),
              ),
            ]),
          )
        Some(from) -> {
          let now = clock.now_ms()
          let created =
            store.unit(ctx.store, fn(tx) {
              use entry_id <- result.try(id.next_career_entry(tx))
              let e =
                career_row.Row(
                  id: entry_id,
                  player_id: p.row.id,
                  org_name:,
                  role:,
                  from_date: from,
                  to_date: body.to,
                  note:,
                  submitted_by: by,
                  created_at: now,
                  withdrawn_at: None,
                )
              use _ <- result.map(
                store.run(
                  tx,
                  "INSERT INTO passport_career_entries (id, player_id, org_name, role, from_date, to_date, note, submitted_by, created_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                  [
                    id.career_entry_sql(e.id),
                    id.player_sql(e.player_id),
                    sqlight.text(org_name),
                    sqlight.nullable(sqlight.text, role),
                    sqlight.text(from),
                    sqlight.nullable(sqlight.text, body.to),
                    sqlight.nullable(sqlight.text, note),
                    sqlight.text(party.to_string(by)),
                    sqlight.int(now),
                  ],
                ),
              )
              e
            })
          case created {
            Ok(e) -> answer(e)
            Error(e) -> http.internal(e)
          }
        }
      }
    }
  }
}

/// `POST /player/football-passport/career`.
pub fn player_career(ctx: Ctx, req: Request, a: PlayerAccess) -> Response {
  use e <- add_career_entry(ctx, req, a.player, party.Player)
  http.json(
    201,
    json.object([
      #("entry", entry_view(e)),
      #("provenance", json.string("player_submitted")),
      #("note", json.string(rules.provenance_copy(rules.PlayerSubmitted))),
    ]),
  )
}

/// `POST /guardian/children/:id/football-passport/career`.
pub fn guardian_career(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  use e <- add_career_entry(ctx, req, child, party.Guardian)
  http.json(
    201,
    json.object([
      #("entry", entry_view(e)),
      #("provenance", json.string("guardian_submitted")),
    ]),
  )
}

fn career_entry(
  read: Read,
  entry_id: id.CareerEntryId,
) -> Result(Option(career_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> career_row.columns
      <> " FROM passport_career_entries WHERE id = ?",
    [id.career_entry_sql(entry_id)],
    career_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// `POST /player/football-passport/career/:id/withdraw`. Withdrawing twice keeps the first withdrawal.
pub fn withdraw_career(
  ctx: Ctx,
  a: PlayerAccess,
  entry_id: id.CareerEntryId,
) -> Response {
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(career_entry(store.reading(tx), entry_id))
      case found {
        Some(e) if e.player_id == a.player.row.id ->
          case e.withdrawn_at {
            Some(_) -> Ok(Some(e))
            None ->
              store.run(
                tx,
                "UPDATE passport_career_entries SET withdrawn_at = ? WHERE id = ?",
                [sqlight.int(now), id.career_entry_sql(e.id)],
              )
              |> result.map(fn(_) {
                Some(career_row.Row(..e, withdrawn_at: Some(now)))
              })
          }
        _ -> Ok(None)
      }
    })
  case done {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "ENTRY_NOT_FOUND")
    Ok(Some(e)) ->
      http.json(
        200,
        json.object([
          #("entry", entry_view(e)),
          #(
            "note",
            json.string(
              "Self-submitted entries can be withdrawn; confirmed records cannot (request a correction instead).",
            ),
          ),
        ]),
      )
  }
}

// ------------------------------------------------------------------------------------------------ achievements

fn achievement_view(a: achievement_row.Row) -> Json {
  json.object([
    #("id", id.achievement_json(a.id)),
    #("playerId", id.player_json(a.player_id)),
    #("title", json.string(a.title)),
    #("orgName", json.nullable(a.org_name, json.string)),
    #("when", json.nullable(a.when_date, json.string)),
    #("submittedBy", party.to_json(a.submitted_by)),
    #("confirmation", case a.confirmation_provenance {
      Some(prov) ->
        json.object([
          #("provenance", achievement_row.confirmation_provenance_to_json(prov)),
          #("orgId", json.nullable(a.confirmation_org_id, id.org_json)),
          #("orgName", json.nullable(a.confirmation_org_name, json.string)),
          #("byName", json.nullable(a.confirmation_by_name, json.string)),
          #("at", json.nullable(a.confirmation_at, json.int)),
        ])
      None -> json.null()
    }),
    #("createdAt", json.int(a.created_at)),
    #("withdrawnAt", json.nullable(a.withdrawn_at, json.int)),
  ])
}

type AchievementInput {
  AchievementInput(
    title: Option(String),
    org_name: Option(String),
    when: Option(String),
  )
}

/// A client cannot assert provenance for itself: a body naming a confirmation is refused, and a new achievement is
/// self-submitted.
fn add_achievement(ctx: Ctx, req: Request, p: Player, by: Party) -> Response {
  let shape = {
    use title <- input.field("title", input.nullish(input.text(title_max)))
    use org_name <- input.field(
      "orgName",
      input.nullish(input.text(org_name_max)),
    )
    use when <- input.field("when", input.nullish(football_date_or_blank()))
    input.done(AchievementInput(title:, org_name:, when: flat(when)))
  }
  use body <- http.body(req, shape, [])
  case input.filled(body.title) {
    None -> http.required("TITLE_REQUIRED", "title")
    Some(title) -> {
      let org_name = input.filled(body.org_name)
      use <- moderate.or_refuse(
        ctx,
        title,
        context("passport_achievement", p.row.id),
      )
      let now = clock.now_ms()
      let created =
        store.unit(ctx.store, fn(tx) {
          use achievement_id <- result.try(id.next_achievement(tx))
          let a =
            achievement_row.Row(
              id: achievement_id,
              player_id: p.row.id,
              title:,
              org_name:,
              when_date: body.when,
              submitted_by: by,
              confirmation_provenance: None,
              confirmation_org_id: None,
              confirmation_org_name: None,
              confirmation_by_name: None,
              confirmation_at: None,
              created_at: now,
              withdrawn_at: None,
            )
          use _ <- result.map(
            store.run(
              tx,
              "INSERT INTO passport_achievements (id, player_id, title, org_name, when_date, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [
                id.achievement_sql(a.id),
                id.player_sql(a.player_id),
                sqlight.text(title),
                sqlight.nullable(sqlight.text, org_name),
                sqlight.nullable(sqlight.text, body.when),
                sqlight.text(party.to_string(by)),
                sqlight.int(now),
              ],
            ),
          )
          a
        })
      case created {
        Error(e) -> http.internal(e)
        Ok(a) ->
          http.json(
            201,
            json.object([
              #("achievement", achievement_view(a)),
              #(
                "provenance",
                json.string(case by {
                  party.Guardian -> "guardian_submitted"
                  party.Player -> "player_submitted"
                }),
              ),
            ]),
          )
      }
    }
  }
}

/// `POST /player/football-passport/achievements`.
pub fn player_achievement(ctx: Ctx, req: Request, a: PlayerAccess) -> Response {
  add_achievement(ctx, req, a.player, party.Player)
}

/// `POST /guardian/children/:id/football-passport/achievements`.
pub fn guardian_achievement(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  add_achievement(ctx, req, child, party.Guardian)
}

fn achievement(
  read: Read,
  achievement_id: id.AchievementId,
) -> Result(Option(achievement_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> achievement_row.columns
      <> " FROM passport_achievements WHERE id = ?",
    [id.achievement_sql(achievement_id)],
    achievement_row.decoder(),
  )
  |> result.map(option.from_result)
}

type AchievementRefusal {
  AchievementNotFound
  ConfirmedRecord
  AlreadyConfirmed
}

fn achievement_refusal(r: AchievementRefusal) -> Response {
  case r {
    AchievementNotFound -> http.error(404, "ACHIEVEMENT_NOT_FOUND")
    ConfirmedRecord ->
      http.error_message(
        403,
        "CONFIRMED_RECORD",
        "A confirmed achievement is part of the record — request a correction instead of deleting it.",
      )
    AlreadyConfirmed -> http.error(409, "ALREADY_CONFIRMED")
  }
}

/// `POST /player/football-passport/achievements/:id/withdraw`: a confirmed one is part of the record.
pub fn withdraw_achievement(
  ctx: Ctx,
  a: PlayerAccess,
  achievement_id: id.AchievementId,
) -> Response {
  let now = clock.now_ms()
  let done =
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(achievement(store.reading(tx), achievement_id))
      case found {
        Some(x) if x.player_id == a.player.row.id ->
          case x.confirmation_provenance, x.withdrawn_at {
            Some(_), _ -> store.refuse(ConfirmedRecord)
            None, Some(_) -> Ok(x)
            None, None -> {
              use _ <- result.map(
                store.run(
                  tx,
                  "UPDATE passport_achievements SET withdrawn_at = ? WHERE id = ?",
                  [sqlight.int(now), id.achievement_sql(x.id)],
                ),
              )
              achievement_row.Row(..x, withdrawn_at: Some(now))
            }
          }
        _ -> store.refuse(AchievementNotFound)
      }
    })
  case done {
    Ok(x) ->
      http.json(200, json.object([#("achievement", achievement_view(x))]))
    Error(store.Refused(r)) -> achievement_refusal(r)
    Error(e) -> http.internal(e)
  }
}

/// `POST /org/players/:pid/football-passport/achievements/:id/confirm`: a verified organisation upgrades an
/// achievement's provenance without rewriting the original, and the player (and their guardian) are told.
pub fn confirm_achievement(
  ctx: Ctx,
  a: OrgAccess,
  player_id: id.PlayerId,
  achievement_id: id.AchievementId,
) -> Response {
  use p <- visible_player(ctx, a, player_id)
  case a.org.verified {
    False ->
      http.error_message(
        403,
        "ORG_NOT_ELIGIBLE",
        "Only a verified organisation can confirm an achievement.",
      )
    True -> {
      let now = clock.now_ms()
      let done =
        store.unit(ctx.store, fn(tx) {
          use found <- result.try(achievement(store.reading(tx), achievement_id))
          case found {
            Some(x) if x.player_id == p.row.id && x.withdrawn_at == None ->
              case x.confirmation_provenance {
                Some(_) -> store.refuse(AlreadyConfirmed)
                None -> {
                  let by_name = case input.utf16_take(a.user.name, name_max) {
                    "" -> None
                    name -> Some(name)
                  }
                  let confirmed =
                    achievement_row.Row(
                      ..x,
                      confirmation_provenance: Some(
                        achievement_row.VerifiedClubConfirmed,
                      ),
                      confirmation_org_id: Some(a.org.id),
                      confirmation_org_name: Some(input.utf16_take(
                        a.org.name,
                        name_max,
                      )),
                      confirmation_by_name: by_name,
                      confirmation_at: Some(now),
                    )
                  use _ <- result.try(
                    store.run(
                      tx,
                      "UPDATE passport_achievements SET confirmation_provenance = 'verified_club_confirmed', confirmation_org_id = ?, confirmation_org_name = ?, confirmation_by_name = ?, confirmation_at = ? WHERE id = ?",
                      [
                        id.org_sql(a.org.id),
                        sqlight.nullable(
                          sqlight.text,
                          confirmed.confirmation_org_name,
                        ),
                        sqlight.nullable(sqlight.text, by_name),
                        sqlight.int(now),
                        id.achievement_sql(x.id),
                      ],
                    ),
                  )
                  let ref_id = Some(id.achievement_to_string(x.id))
                  use _ <- result.try(notifications.notify(
                    tx,
                    to: audience.Player,
                    id: id.player_to_string(p.row.id),
                    type_: "passport",
                    text: "🏅 "
                      <> a.org.name
                      <> " confirmed your achievement “"
                      <> x.title
                      <> "”.",
                    ref_id:,
                    at: now,
                  ))
                  use _ <- result.try(case p.row.guardian_id {
                    Some(gid) ->
                      notifications.notify(
                        tx,
                        to: audience.Guardian,
                        id: id.guardian_to_string(gid),
                        type_: "passport",
                        text: a.org.name
                          <> " confirmed "
                          <> p.row.name
                          <> "'s achievement “"
                          <> x.title
                          <> "”.",
                        ref_id:,
                        at: now,
                      )
                    None -> Ok(Nil)
                  })
                  use _ <- result.map(count(tx, "achievement_confirmed"))
                  confirmed
                }
              }
            _ -> store.refuse(AchievementNotFound)
          }
        })
      case done {
        Ok(x) ->
          http.json(200, json.object([#("achievement", achievement_view(x))]))
        Error(store.Refused(r)) -> achievement_refusal(r)
        Error(e) -> http.internal(e)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ corrections

fn correction_view(c: correction_row.Row) -> Json {
  json.object([
    #("id", id.passport_correction_json(c.id)),
    #("playerId", id.player_json(c.player_id)),
    #("targetType", correction_row.target_kind_to_json(c.target_kind)),
    #("targetId", json.nullable(c.target_id, json.string)),
    #("reason", json.string(c.reason)),
    #(
      "by",
      json.object([
        #("kind", party.to_json(c.by_kind)),
        #("id", json.string(c.by_id)),
        #("name", json.nullable(c.by_name, json.string)),
      ]),
    ),
    #("status", correction_row.status_to_json(c.status)),
    #("resolution", case c.resolution_outcome {
      Some(outcome) ->
        json.object([
          #("outcome", correction_row.resolution_outcome_to_json(outcome)),
          #("reason", json.nullable(c.resolution_reason, json.string)),
          #("at", json.nullable(c.resolved_at, json.int)),
        ])
      None -> json.null()
    }),
    #("createdAt", json.int(c.created_at)),
    #("resolvedAt", json.nullable(c.resolved_at, json.int)),
  ])
}

type CorrectionInput {
  CorrectionInput(
    target: correction_row.TargetKind,
    target_id: Option(String),
    reason: Option(String),
  )
}

fn file_correction(
  ctx: Ctx,
  req: Request,
  p: Player,
  by: Party,
  by_id: String,
  by_name: String,
) -> Response {
  let shape = {
    use target <- input.field(
      "targetType",
      input.required(input.one_of(correction_row.target_kind_pairs)),
    )
    use target_id <- input.field(
      "targetId",
      input.nullish(input.text(target_id_max)),
    )
    use reason <- input.field("reason", input.nullish(input.text(reason_max)))
    input.done(CorrectionInput(target:, target_id:, reason:))
  }
  use body <- http.body(req, shape, [#("targetType", "TARGET_INVALID")])
  case input.filled(body.reason) {
    None -> http.required("REASON_REQUIRED", "reason")
    Some(reason) -> {
      use <- moderate.or_refuse(
        ctx,
        reason,
        context("passport_correction", p.row.id),
      )
      // '' is a form's "the section as a whole".
      let target_id = case body.target_id {
        Some("") -> None
        other -> other
      }
      let now = clock.now_ms()
      let created =
        store.unit(ctx.store, fn(tx) {
          use correction_id <- result.try(id.next_passport_correction(tx))
          let name = case input.utf16_take(by_name, name_max) {
            "" -> None
            n -> Some(n)
          }
          let c =
            correction_row.Row(
              id: correction_id,
              player_id: p.row.id,
              target_kind: body.target,
              target_id:,
              reason:,
              by_kind: by,
              by_id:,
              by_name: name,
              status: correction_row.Open,
              resolution_outcome: None,
              resolution_reason: None,
              resolved_at: None,
              created_at: now,
            )
          use _ <- result.try(
            store.run(
              tx,
              "INSERT INTO passport_corrections (id, player_id, target_kind, target_id, reason, by_kind, by_id, by_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
              [
                id.passport_correction_sql(c.id),
                id.player_sql(c.player_id),
                sqlight.text(correction_row.target_kind_to_string(c.target_kind)),
                sqlight.nullable(sqlight.text, target_id),
                sqlight.text(reason),
                sqlight.text(party.to_string(by)),
                sqlight.text(by_id),
                sqlight.nullable(sqlight.text, name),
                sqlight.int(now),
              ],
            ),
          )
          use _ <- result.map(count(tx, "correction_filed"))
          c
        })
      case created {
        Error(e) -> http.internal(e)
        Ok(c) ->
          http.json(
            201,
            json.object([
              #("correction", correction_view(c)),
              #(
                "note",
                json.string(
                  "Authoritative records are never silently edited — Trust & Safety reviews correction requests, and verification claims can additionally be disputed through the existing verification flow.",
                ),
              ),
            ]),
          )
      }
    }
  }
}

/// `POST /player/football-passport/corrections`.
pub fn player_correction(ctx: Ctx, req: Request, a: PlayerAccess) -> Response {
  let p = a.player
  file_correction(
    ctx,
    req,
    p,
    party.Player,
    id.player_to_string(p.row.id),
    p.row.name,
  )
}

/// `POST /guardian/children/:id/football-passport/corrections`.
pub fn guardian_correction(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  file_correction(
    ctx,
    req,
    child,
    party.Guardian,
    id.guardian_to_string(g.row.id),
    g.row.name,
  )
}

/// `GET /admin/passport/corrections`: the Trust & Safety queue, oldest first; `?all=1` lists resolved ones too.
pub fn admin_corrections(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use limit <- input.field("limit", input.nullish(input.text(1000)))
    use cursor <- input.field("cursor", input.nullish(input.text(100_000)))
    use all <- input.field(
      "all",
      input.optional(input.one_of([#("0", False), #("1", True)])),
    )
    input.done(#(paging.Query(limit:, cursor:), option.unwrap(all, False)))
  }
  use #(query, all) <- http.query(req, shape, [])
  case paging.read(query, [paging.IntKind]) {
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
    Ok(page) -> {
      let after = case page.after {
        Some([paging.IntKey(rid)]) -> rid
        _ -> 0
      }
      let found =
        store.read(ctx.store, fn(read) {
          store.query(
            read,
            "SELECT "
              <> correction_row.columns
              <> ", rowid FROM passport_corrections WHERE rowid > ? AND (? OR status = 'open') ORDER BY rowid LIMIT ?",
            [sqlight.int(after), sqlight.bool(all), sqlight.int(page.limit + 1)],
            {
              use r <- decode.then(correction_row.decoder())
              use rid <- decode.field(correction_row.width, decode.int)
              decode.success(#(rid, r))
            },
          )
        })
      case found {
        Error(e) -> http.internal(e)
        Ok(rows) -> {
          let #(items, next) =
            paging.page_of(rows, page.limit, fn(r) { [paging.IntKey(r.0)] })
          http.json(
            200,
            json.object([
              #("items", json.array(items, fn(r) { correction_view(r.1) })),
              #("nextCursor", json.nullable(next, json.string)),
            ]),
          )
        }
      }
    }
  }
}

type ResolutionInput {
  ResolutionInput(
    outcome: correction_row.ResolutionOutcome,
    reason: Option(String),
  )
}

type ResolveRefusal {
  CorrectionNotFound
  AlreadyResolved
}

/// `POST /admin/passport/corrections/:id/resolve`: whoever filed it is told the outcome.
pub fn admin_resolve(
  ctx: Ctx,
  req: Request,
  correction_id: id.PassportCorrectionId,
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      store.one(
        read,
        "SELECT "
          <> correction_row.columns
          <> " FROM passport_corrections WHERE id = ?",
        [id.passport_correction_sql(correction_id)],
        correction_row.decoder(),
      )
      |> result.map(option.from_result)
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(None) -> http.error(404, "CORRECTION_NOT_FOUND")
    Ok(Some(c)) if c.status != correction_row.Open ->
      http.error(409, "ALREADY_RESOLVED")
    Ok(Some(_)) -> {
      let shape = {
        use outcome <- input.field(
          "resolution",
          input.required(input.one_of(correction_row.resolution_outcome_pairs)),
        )
        use reason <- input.field(
          "reason",
          input.nullish(input.text(resolution_reason_max)),
        )
        input.done(ResolutionInput(outcome:, reason:))
      }
      use body <- http.body(req, shape, [#("resolution", "RESOLUTION_REQUIRED")])
      case input.filled(body.reason) {
        None -> http.required("REASON_REQUIRED", "reason")
        Some(reason) -> {
          let now = clock.now_ms()
          let done =
            store.unit(ctx.store, fn(tx) {
              use current <- result.try(
                store.one(
                  store.reading(tx),
                  "SELECT "
                    <> correction_row.columns
                    <> " FROM passport_corrections WHERE id = ?",
                  [id.passport_correction_sql(correction_id)],
                  correction_row.decoder(),
                )
                |> result.map(option.from_result),
              )
              case current {
                None -> store.refuse(CorrectionNotFound)
                Some(c) if c.status != correction_row.Open ->
                  store.refuse(AlreadyResolved)
                Some(c) -> {
                  use _ <- result.try(
                    store.run(
                      tx,
                      "UPDATE passport_corrections SET status = 'resolved', resolution_outcome = ?, resolution_reason = ?, resolved_at = ? WHERE id = ?",
                      [
                        sqlight.text(
                          correction_row.resolution_outcome_to_string(
                            body.outcome,
                          ),
                        ),
                        sqlight.text(reason),
                        sqlight.int(now),
                        id.passport_correction_sql(c.id),
                      ],
                    ),
                  )
                  let #(kind, to) = case c.by_kind {
                    party.Guardian -> #(audience.Guardian, c.by_id)
                    party.Player -> #(
                      audience.Player,
                      id.player_to_string(c.player_id),
                    )
                  }
                  use _ <- result.map(notifications.notify(
                    tx,
                    to: kind,
                    id: to,
                    type_: "passport",
                    text: "Trust & Safety resolved your Passport correction request: "
                      <> correction_row.resolution_outcome_to_string(
                      body.outcome,
                    )
                      <> ".",
                    ref_id: Some(id.passport_correction_to_string(c.id)),
                    at: now,
                  ))
                  correction_row.Row(
                    ..c,
                    status: correction_row.Resolved,
                    resolution_outcome: Some(body.outcome),
                    resolution_reason: Some(reason),
                    resolved_at: Some(now),
                  )
                }
              }
            })
          case done {
            Ok(c) ->
              http.json(200, json.object([#("correction", correction_view(c))]))
            Error(store.Refused(CorrectionNotFound)) ->
              http.error(404, "CORRECTION_NOT_FOUND")
            Error(store.Refused(AlreadyResolved)) ->
              http.error(409, "ALREADY_RESOLVED")
            Error(e) -> http.internal(e)
          }
        }
      }
    }
  }
}
