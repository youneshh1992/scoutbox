//// `most_similar` prunes in SQL and ranks in Gleam: its answer must be the same as ranking every candidate.

import gleam/int
import gleam/list
import gleam/option.{Some}
import gleam/order
import gleam/string
import gleeunit/should
import scoutbox/discovery/similarity.{Similar}
import scoutbox/identity/orgs
import scoutbox/platform/sql
import scoutbox/platform/store.{type Store}
import scoutbox/rows/id
import scoutbox/rows/players as player_row
import scoutbox/rules/visibility
import scoutbox/support
import sqlight

const now = 1_790_000_000_000

const positions = [
  "GK", "CB", "RB", "LB", "RWB", "LWB", "CDM", "CM", "CAM", "RW", "LW", "ST",
  "CF",
]

fn nth_or_null(xs: List(String), i: Int) -> sqlight.Value {
  case list.drop(xs, i) {
    [x, ..] -> sqlight.text(x)
    [] -> sqlight.null()
  }
}

fn maybe(i: Int, every: Int, value: Int) -> sqlight.Value {
  case i % every == 0 {
    True -> sqlight.null()
    False -> sqlight.int(value)
  }
}

fn pad2(n: Int) -> String {
  string.pad_start(int.to_string(n), 2, "0")
}

/// 400 players over every position (and none), both feet (and none), birthdays either side of today's, missing
/// build and output, no appearances, and runs of identical players, so scores tie at every rank.
fn plant(s: Store) -> Nil {
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      list.try_each(
        list.repeat(Nil, 400) |> list.index_map(fn(_, i) { i }),
        fn(i) {
          // Every fourth player copies the one before, bar the id.
          let j = case i % 4 == 3 {
            True -> i - 1
            False -> i
          }
          store.run(
            tx,
            "INSERT INTO players (id, name, birth_date, country, position, foot, height_cm, weight_kg,"
              <> " stats_appearances, stats_goals, stats_assists, profile_signal, created_at)"
              <> " VALUES (?, ?, ?, 'England', ?, ?, ?, ?, ?, ?, ?, 50, ?)",
            [
              sqlight.text("pl-sim-" <> int.to_string(i)),
              sqlight.text("Similar " <> int.to_string(i)),
              sqlight.text(
                int.to_string(1996 + j % 14)
                <> "-"
                <> pad2(j % 12 + 1)
                <> "-"
                <> pad2(j * 7 % 28 + 1),
              ),
              nth_or_null(positions, j % 14),
              nth_or_null(["left", "right"], j % 3),
              maybe(j, 11, 160 + j * 7 % 40),
              maybe(j, 13, 60 + j * 5 % 30),
              maybe(j, 9, j % 7 * 6),
              maybe(j, 5, j % 13),
              maybe(j, 6, j % 9),
              sqlight.int(j),
            ],
          )
        },
      )
    })
  Nil
}

fn row(s: Store, pid: String) -> player_row.Row {
  let assert Ok(Ok(r)) =
    store.read(s, store.one(
      _,
      "SELECT " <> player_row.columns <> " FROM players WHERE id = ?",
      [sqlight.text(pid)],
      player_row.decoder(),
    ))
  r
}

/// Every candidate scored with `similarity.score`, best first, ties in creation order.
fn by_scan(
  s: Store,
  base: player_row.Row,
  org: orgs.Org,
  k: Int,
) -> List(similarity.Similar) {
  let q =
    sql.concat([
      sql.text(
        "SELECT "
        <> player_row.qualified("p")
        <> " FROM players p WHERE p.deleted_at IS NULL AND p.id <> ",
      ),
      sql.arg(id.player_sql(base.id)),
      sql.text(" AND "),
      visibility.can_see_sql(org, now),
      sql.text(" ORDER BY p.rowid"),
    ])
  let assert Ok(rows) =
    store.read(s, store.query(_, q.sql, q.args, player_row.decoder()))
  let me = similarity.of_row(base)
  rows
  |> list.index_map(fn(r, i) {
    #(i, similarity.score(me, similarity.of_row(r), now), r)
  })
  |> list.sort(fn(a, b) {
    int.compare(b.1, a.1) |> order.break_tie(int.compare(a.0, b.0))
  })
  |> list.take(k)
  |> list.map(fn(t) {
    Similar(id: t.2.id, name: t.2.name, position: t.2.position, score: t.1)
  })
}

fn org(s: Store, oid: String) -> orgs.Org {
  let assert Ok(Ok(Some(o))) =
    store.read(s, fn(read) { Ok(orgs.by_id(read, id.org(oid))) })
  o
}

pub fn most_similar_equals_ranking_every_candidate_test() {
  let s = support.fresh_store(fn(_) { Nil })
  plant(s)
  let bases =
    list.map([0, 1, 2, 3, 13, 26, 39, 77, 154, 399], fn(i) {
      "pl-sim-" <> int.to_string(i)
    })
  list.each(["org-eastport", "org-harbour", "org-hackneymarsh"], fn(oid) {
    let o = org(s, oid)
    list.each(bases, fn(pid) {
      let base = row(s, pid)
      list.each([1, 3, 10, 50], fn(k) {
        let assert Ok(got) =
          store.read(s, similarity.most_similar(_, base, o, k, now))
        #(oid, pid, k, got)
        |> should.equal(#(oid, pid, k, by_scan(s, base, o, k)))
      })
    })
  })
}

pub fn most_similar_of_none_is_empty_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(got) =
    store.read(s, similarity.most_similar(
      _,
      row(s, first_player(s)),
      org(s, "org-eastport"),
      0,
      now,
    ))
  got |> should.equal([])
}

fn first_player(s: Store) -> String {
  let assert Ok(Ok(r)) =
    store.read(s, store.one(
      _,
      "SELECT " <> player_row.columns <> " FROM players ORDER BY rowid LIMIT 1",
      [],
      player_row.decoder(),
    ))
  id.player_to_string(r.id)
}
