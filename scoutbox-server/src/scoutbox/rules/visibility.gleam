//// Who may see a player (domain.ts `visibleToOrg`), applied at the source on every route. One definition, in
//// SQL over the player row `p`, so the single-player reads and the lists apply the same rule:
////
//// - The under-18 wall: agencies never see a minor, and neither does an unverified club. Not a setting.
//// - Adults are visible to every organisation on the main platform.
//// - A Grassroots club sees only semi-pro-and-below players within 50 km of its ground. Missing location data
////   fails closed.
////
//// Beside it, the blocks: a player (or their guardian, or an urgent report's suspension) who blocked the
//// organisation reads as absent.

import gleam/dynamic/decode
import gleam/option.{type Option, Some}
import scoutbox/identity/orgs.{type Org}
import scoutbox/platform/distance.{At, Columns}
import scoutbox/platform/sql.{type Fragment}
import scoutbox/rows/orgs as org_row
import scoutbox/rules/age
import scoutbox/vocab/org_type
import sqlight

/// What the rule and the blocks say about one player for one organisation.
pub type Access {
  Access(visible: Bool, blocked: Bool, distance_tenths: Option(Int))
}

fn sees_minors(org: Org) -> Bool {
  org.type_ == org_type.Club && org.verified
}

/// True when `org` may see the player `p`, by the rule above.
pub fn visible_sql(org: Org, now: Int) -> Fragment {
  let age_part = case sees_minors(org) {
    True -> sql.text("1")
    False -> age.adult_sql("p.birth_date", "p.country", now)
  }
  let platform_part = case org.level, org.lat, org.lng {
    Some(org_row.LevelGrassroots), Some(lat), Some(lng) ->
      sql.concat([
        sql.text("p.level <> 'pro' AND "),
        distance.within_grassroots_radius(
          At(lat, lng),
          Columns("p.lat", "p.lng"),
        ),
      ])
    Some(org_row.LevelGrassroots), _, _ -> sql.text("0")
    _, _, _ -> sql.text("1")
  }
  sql.concat([
    sql.text("(("),
    age_part,
    sql.text(") AND ("),
    platform_part,
    sql.text("))"),
  ])
}

/// True when the player `p` (or their guardian, or a suspension) blocked `org`.
pub fn blocked_sql(org: Org) -> Fragment {
  sql.concat([
    sql.text(
      "EXISTS (SELECT 1 FROM blocks b WHERE b.player_id = p.id AND b.org_id = ",
    ),
    sql.arg(sqlight.text(org.id)),
    sql.text(")"),
  ])
}

/// The distance a Grassroots club is shown, in tenths of a km; NULL for every other organisation.
fn distance_sql(org: Org) -> Fragment {
  case orgs.is_grassroots(org), org.lat, org.lng {
    True, Some(lat), Some(lng) ->
      distance.tenths(At(lat, lng), Columns("p.lat", "p.lng"))
    _, _, _ -> sql.text("NULL")
  }
}

/// Three columns to select beside a player row: visible, blocked, distance in tenths.
pub fn access_sql(org: Org, now: Int) -> Fragment {
  sql.join([visible_sql(org, now), blocked_sql(org), distance_sql(org)], ", ")
}

/// Reads `access_sql`'s columns, which start at column `first`.
pub fn access_decoder(first: Int) -> decode.Decoder(Access) {
  use visible <- decode.field(first, sqlight.decode_bool())
  use blocked <- decode.field(first + 1, sqlight.decode_bool())
  use distance_tenths <- decode.field(first + 2, decode.optional(decode.int))
  decode.success(Access(visible:, blocked:, distance_tenths:))
}

/// Visible and not blocked: the condition a list of players filters by.
pub fn can_see_sql(org: Org, now: Int) -> Fragment {
  sql.concat([
    visible_sql(org, now),
    sql.text(" AND NOT "),
    blocked_sql(org),
  ])
}
