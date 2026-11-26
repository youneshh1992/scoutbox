//// The figures a player sees about their own progress (domain.ts `trustTier`, `computeStreak`, `weeklyGoal`,
//// `nextActions`; grassrootsJourney.mjs `pathwayFor`, `programmeProgress`). Streaks compare a player to
//// themselves: deliberately no leaderboards.

import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/set
import scoutbox/identity/players.{type Player}
import scoutbox/vocab/playing_level

const day_ms = 86_400_000

const week_ms = 604_800_000

const weekly_goal_target = 3

pub fn tier(score: Int) -> String {
  case score {
    s if s >= 80 -> "Elite"
    s if s >= 60 -> "Established"
    s if s >= 40 -> "Rising"
    _ -> "Prospect"
  }
}

fn day_key(ms: Int) -> Int {
  int.floor_divide(ms, day_ms) |> result_or(0)
}

fn result_or(r: Result(a, b), default: a) -> a {
  case r {
    Ok(v) -> v
    Error(_) -> default
  }
}

/// Days in a row with activity, counting back from today; yesterday keeps the streak alive.
pub fn streak(activity: List(Int), now: Int) -> Int {
  let days = list.map(activity, day_key) |> set.from_list
  let today = day_key(now)
  let start = case set.contains(days, today) {
    True -> today
    False -> today - 1
  }
  count_back(days, start, 0)
}

fn count_back(days: set.Set(Int), day: Int, n: Int) -> Int {
  case set.contains(days, day - n) {
    True -> count_back(days, day, n + 1)
    False -> n
  }
}

pub fn weekly_goal(activity: List(Int), now: Int) -> Json {
  let done = list.count(activity, fn(ts) { ts >= now - 7 * day_ms })
  json.object([
    #("done", json.int(int.min(done, weekly_goal_target * 5))),
    #("target", json.int(weekly_goal_target)),
    #("met", json.bool(done >= weekly_goal_target)),
  ])
}

/// At most three things that would raise the profile signal.
pub fn next_actions(p: Player) -> Json {
  json.preprocessed_array(next_action_list(p))
}

/// `next_actions`, as a list: the feed suggests the first.
pub fn next_action_list(p: Player) -> List(Json) {
  let media = list.length(p.media)
  let action = fn(id, label, gain) {
    json.object([
      #("id", json.string(id)),
      #("label", json.string(label)),
      #("gain", json.int(gain)),
    ])
  }
  [
    case players.profile_complete(p.row) {
      False ->
        Some(action(
          "complete_profile",
          "Complete your profile (position, foot, height, weight, stats)",
          5,
        ))
      True -> None
    },
    case media {
      0 -> Some(action("first_clip", "Upload your first clip", 2))
      n if n * 2 < 10 -> Some(action("more_clips", "Add another clip", 2))
      _ -> None
    },
    case list.length(p.attendance) * 5 < 20 {
      True -> Some(action("attendance", "Log a verified match attendance", 5))
      False -> None
    },
    case
      list.any(p.media, fn(m) { m.clip.verified_clip_attendance_id != None })
    {
      False ->
        Some(action(
          "verified_clip",
          "Link a clip to a verified attendance for the Verified Clip seal",
          0,
        ))
      True -> None
    },
  ]
  |> option.values
  |> list.take(3)
}

/// The grassroots journey; none for a pro-level player, who has moved past it.
pub fn pathway(p: Player) -> Json {
  case p.row.level {
    playing_level.Pro -> json.null()
    level -> {
      let step = fn(key, label, reached, note) {
        json.object([
          #("key", json.string(key)),
          #("label", json.string(label)),
          #("reached", json.bool(reached)),
          #("note", json.string(note)),
        ])
      }
      json.object([
        #("level", playing_level.to_json(level)),
        #(
          "steps",
          json.preprocessed_array([
            step("amateur", "Amateur", True, "Where every journey starts."),
            step(
              "semi_pro",
              "Semi-pro",
              level == playing_level.SemiPro,
              "A grassroots club signing takes you here.",
            ),
            step(
              "pro",
              "Academy / Pro",
              False,
              "An academy or pro club signing takes you here — and onto ScoutBox.",
            ),
          ]),
        ),
        #(
          "signals",
          json.object([
            #("verifiedAttendances", json.int(list.length(p.attendance))),
            #(
              "verifiedClips",
              json.int(
                list.count(p.media, fn(m) {
                  m.clip.verified_clip_attendance_id != None
                }),
              ),
            ),
            #(
              "combineVerified",
              json.int(list.count(p.drill_results, fn(r) { r.verified })),
            ),
            #(
              "coachVouches",
              json.int(list.length(players.published_vouches(p))),
            ),
          ]),
        ),
        #(
          "nextStep",
          json.string(case level {
            playing_level.Amateur ->
              "Get seen locally: verified attendance, a verified clip, and a coach vouch are what nearby clubs check first."
            _ ->
              "Keep the record growing — academy scouts on ScoutBox see your trust, combine numbers and trial reports."
          }),
        ),
      ])
    }
  }
}

pub type Session {
  Session(
    id: String,
    day: String,
    title: String,
    drill_id: option.Option(String),
  )
}

pub type Track {
  Track(key: String, label: String, sessions: List(Session))
}

/// The training tracks (grassrootsJourney.mjs `PROGRAMME_TRACKS`), in its order.
pub fn tracks() -> List(Track) {
  let s = fn(id, day, title, drill) { Session(id, day, title, drill) }
  [
    Track("attack", "Attacking track", [
      s(
        "atk-sprint",
        "Mon",
        "Sprint ladder — top-end pace",
        Some("drill-sprint-ladder"),
      ),
      s(
        "atk-finish",
        "Wed",
        "Shooting arc — 20 finishes",
        Some("drill-shooting-arc"),
      ),
      s(
        "atk-touch",
        "Fri",
        "First touch under fatigue",
        Some("drill-first-touch"),
      ),
      s("atk-match", "Sat", "Match or small-sided game (log attendance)", None),
    ]),
    Track("midfield", "Midfield track", [
      s(
        "mid-pass",
        "Mon",
        "Passing gates — both feet",
        Some("drill-passing-gates"),
      ),
      s(
        "mid-touch",
        "Wed",
        "First touch — wall rebounds",
        Some("drill-first-touch"),
      ),
      s(
        "mid-sprint",
        "Fri",
        "Repeat sprints — recovery runs",
        Some("drill-sprint-ladder"),
      ),
      s("mid-match", "Sat", "Match or small-sided game (log attendance)", None),
    ]),
    Track("defence", "Defensive track", [
      s("def-sprint", "Mon", "Recovery sprints", Some("drill-sprint-ladder")),
      s(
        "def-pass",
        "Wed",
        "Passing gates — building out",
        Some("drill-passing-gates"),
      ),
      s(
        "def-touch",
        "Fri",
        "First touch under pressure",
        Some("drill-first-touch"),
      ),
      s("def-match", "Sat", "Match or small-sided game (log attendance)", None),
    ]),
    Track("keeper", "Goalkeeper track", [
      s(
        "gk-feet",
        "Mon",
        "Distribution — passing gates",
        Some("drill-passing-gates"),
      ),
      s(
        "gk-hands",
        "Wed",
        "Handling — wall rebounds",
        Some("drill-first-touch"),
      ),
      s(
        "gk-power",
        "Fri",
        "Explosive steps — sprint ladder",
        Some("drill-sprint-ladder"),
      ),
      s(
        "gk-match",
        "Sat",
        "Match or shot-stopping session (log attendance)",
        None,
      ),
    ]),
  ]
}

/// The epoch was a Thursday.
fn week_key(ms: Int) -> Int {
  int.floor_divide(ms - 4 * day_ms, week_ms) |> result_or(0)
}

/// This week's training programme, or none.
pub fn programme(p: Player, now: Int) -> Json {
  let found =
    option.then(p.row.programme_track, fn(key) {
      list.find(tracks(), fn(t) { t.key == key }) |> option.from_result
    })
  case found {
    None -> json.null()
    Some(track) -> {
      let this_week = week_key(now)
      let done =
        p.programme_completed
        |> list.filter(fn(c) { week_key(c.completed_at) == this_week })
        |> list.map(fn(c) { c.session_id })
      json.object([
        #("track", json.string(track.key)),
        #("label", json.string(track.label)),
        #("startedAt", json.nullable(p.row.programme_started_at, json.int)),
        #(
          "sessions",
          json.array(track.sessions, fn(s) {
            json.object([
              #("id", json.string(s.id)),
              #("day", json.string(s.day)),
              #("title", json.string(s.title)),
              #("drillId", json.nullable(s.drill_id, json.string)),
              #("done", json.bool(list.contains(done, s.id))),
            ])
          }),
        ),
        #("doneThisWeek", json.int(list.length(done))),
        #("totalPerWeek", json.int(list.length(track.sessions))),
      ])
    }
  }
}

/// The Grassroots journey badges a record has earned (grassrootsJourney.mjs `earnedGrassrootsBadges`).
pub fn earned_badges(p: Player, streak: Int) -> List(String) {
  let attendance = list.length(p.attendance)
  let appearances =
    players.stats(p.row)
    |> option.then(fn(s) { s.appearances })
    |> option.unwrap(0)
  [
    #(attendance >= 1, "Turnstile"),
    #(attendance >= 10, "Ever-Present"),
    #(appearances >= 20, "Season Regular"),
    #(streak >= 14, "Iron Streak"),
    #(list.count(p.drill_results, fn(r) { r.verified }) >= 3, "Combine Proven"),
    #(p.row.level == playing_level.SemiPro, "First Club"),
  ]
  |> list.filter_map(fn(b) {
    case b.0 {
      True -> Ok(b.1)
      False -> Error(Nil)
    }
  })
}
