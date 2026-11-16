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
import scoutbox/rows/id
import scoutbox/rows/orgs.{type Row as Org}
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
    None -> Ok(Error(Unavailable("This player is not available to contact.")))
    Some(#(_, access)) if access.blocked -> Ok(Error(Blocked))
    Some(#(_, access)) if !access.visible ->
      Ok(
        Error(Unavailable(
          "This player is not available to your organisation under the standing rules.",
        )),
      )
    Some(#(p, _)) ->
      case players.is_adult(p, now) {
        True -> Ok(Ok(Recipient(party.Player, player_id, None, False)))
        False -> {
          // The guardian must list this child and have passed the identity and disclaimer gates; two verified
          // owners with no primary link between them fail closed.
          use owners <- result.map(verified_guardians(read, player_id))
          let chosen = case owners {
            [only] -> Some(only)
            [_, _, ..] ->
              list.find(owners, fn(g) { Some(g) == p.row.guardian_id })
              |> option.from_result
            [] -> None
          }
          case chosen {
            Some(g) -> Ok(Recipient(party.Guardian, player_id, Some(g), True))
            None -> Error(GuardianRequired)
          }
        }
      }
  }
}

fn verified_guardians(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(id.GuardianId), Fail(e)) {
  use ids <- result.try(store.query(
    read,
    "SELECT guardian_id FROM guardian_children WHERE player_id = ? ORDER BY rowid",
    [id.player_sql(player_id)],
    decode_guardian_id(),
  ))
  list.try_map(ids, guardians.by_id(read, _))
  |> result.map(fn(found) {
    found
    |> option.values
    |> list.filter(fn(g) { g.row.id_verified && g.row.disclaimer_accepted })
    |> list.map(fn(g) { g.row.id })
  })
}

fn decode_guardian_id() -> decode.Decoder(id.GuardianId) {
  decode.at([0], id.guardian_decoder())
}
