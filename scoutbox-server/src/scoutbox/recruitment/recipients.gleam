//// Who a club's recruitment act about a player reaches (resolveContactRecipient in domains/recruitment/
//// lifecycle/contact.mjs), re-derived at the moment of the act rather than trusted from a record: an adult
//// player themself, or a minor's one verified guardian. There is no direct fallback for a minor.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/identity/guardians
import scoutbox/identity/players
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/guardians as guardian_row
import scoutbox/rows/id
import scoutbox/rows/orgs.{type Row as Org}
import scoutbox/rows/players as player_row
import scoutbox/rules/age
import scoutbox/rules/visibility.{type Access}
import scoutbox/vocab/party

pub type Recipient {
  Recipient(
    kind: party.Party,
    player_id: id.PlayerId,
    guardian_id: Option(id.GuardianId),
    minor: Bool,
  )
}

pub type Unresolved {
  /// Gone, or not available to the organisation under the standing rules.
  Unavailable(message: String)
  /// The player (or their guardian) blocked the organisation.
  Blocked
  /// A minor with no single verified guardian route.
  GuardianRequired
}

pub fn resolve(
  read: Read,
  player_id: id.PlayerId,
  org: Org,
  now: Int,
) -> Result(Result(Recipient, Unresolved), Fail(e)) {
  use found <- result.try(players.for_org(read, player_id, org, now))
  case found {
    Some(#(p, access)) if access.visible && !access.blocked -> {
      let adult = players.is_adult(p, now)
      use linked <- result.map(case adult {
        True -> Ok([])
        False -> linked_guardians(read, player_id)
      })
      judge(Some(#(p.row, access)), linked, now)
    }
    _ -> Ok(judge(option.map(found, fn(f) { #({ f.0 }.row, f.1) }), [], now))
  }
}

/// Judges what `resolve` fetched: the live player with what the visibility rule and the blocks say for the
/// organisation (None when there is no such player), and the guardians whose link rows name the player.
pub fn judge(
  found: Option(#(player_row.Row, Access)),
  linked: List(guardian_row.Row),
  now: Int,
) -> Result(Recipient, Unresolved) {
  case found {
    None -> Error(Unavailable("This player is not available to contact."))
    Some(#(_, access)) if access.blocked -> Error(Blocked)
    Some(#(_, access)) if !access.visible ->
      Error(Unavailable(
        "This player is not available to your organisation under the standing rules.",
      ))
    Some(#(p, _)) ->
      case age.is_adult(p.birth_date, p.country, now) {
        True -> Ok(Recipient(party.Player, p.id, None, False))
        False -> {
          // The guardian must have passed the identity and disclaimer gates; two verified owners with no primary
          // link between them fail closed.
          let owners =
            list.filter(linked, fn(g) { g.id_verified && g.disclaimer_accepted })
            |> list.map(fn(g) { g.id })
          let chosen = case owners {
            [only] -> Some(only)
            [_, _, ..] ->
              list.find(owners, fn(g) { Some(g) == p.guardian_id })
              |> option.from_result
            [] -> None
          }
          case chosen {
            Some(g) -> Ok(Recipient(party.Guardian, p.id, Some(g), True))
            None -> Error(GuardianRequired)
          }
        }
      }
  }
}

fn linked_guardians(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(guardian_row.Row), Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT guardian_id FROM guardian_children WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player_id)],
    decode.at([0], id.guardian_decoder()),
  ))
  list.try_map(ids, guardians.by_id(read, _))
  |> result.map(fn(found) {
    found |> option.values |> list.map(fn(g) { g.row })
  })
}
