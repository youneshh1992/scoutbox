//// The demo world a first development boot loads: the organisations the e2e batteries sign in to. Staff
//// accounts are not seeded; a demo organisation's first sign-in under a name creates the account.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Store}
import scoutbox/rows/orgs as orgs_row
import scoutbox/vocab/org_type

/// The demo organisations.
fn orgs(now: Int) -> List(orgs_row.Row) {
  [
    orgs_row.Row(
      ..orgs_row.new(
        id: "org-eastport",
        name: "Eastport FC",
        type_: org_type.Club,
        plan: orgs_row.PlanPro,
        created_at: now,
      ),
      level: Some(orgs_row.LevelPro),
      country: Some("GB"),
      city: Some("Eastport"),
      lat: Some(51.889),
      lng: Some(1.02),
      federation: None,
      federation_registration_id: None,
      trusted_partner: True,
      verified: True,
      verified_domain: Some("eastportfc.com"),
      safeguarding_contract_signed: True,
    ),
    orgs_row.Row(
      ..orgs_row.new(
        id: "org-harbour",
        name: "Harbour City FC",
        type_: org_type.Club,
        plan: orgs_row.PlanAcademy,
        created_at: now,
      ),
      level: Some(orgs_row.LevelAcademy),
      country: Some("GB"),
      city: Some("Harbour City"),
      lat: Some(53.408),
      lng: Some(-2.983),
      federation: None,
      federation_registration_id: None,
      trusted_partner: False,
      verified: False,
      verified_domain: None,
      safeguarding_contract_signed: False,
    ),
    orgs_row.Row(
      ..orgs_row.new(
        id: "org-northstar",
        name: "North Star Sports Agency",
        type_: org_type.Agency,
        plan: orgs_row.PlanAgency,
        created_at: now,
      ),
      level: Some(orgs_row.LevelAgency),
      country: Some("GB"),
      city: None,
      lat: None,
      lng: None,
      federation: None,
      federation_registration_id: None,
      trusted_partner: False,
      verified: False,
      verified_domain: None,
      safeguarding_contract_signed: False,
    ),
    orgs_row.Row(
      ..orgs_row.new(
        id: "org-hackneymarsh",
        name: "Hackney Marsh Rovers",
        type_: org_type.Club,
        plan: orgs_row.PlanGrassroots,
        created_at: now,
      ),
      level: Some(orgs_row.LevelGrassroots),
      country: Some("GB"),
      city: Some("London"),
      lat: Some(51.552),
      lng: Some(-0.022),
      federation: Some("The FA (England)"),
      federation_registration_id: Some("FA-GR-2201"),
      trusted_partner: False,
      verified: True,
      verified_domain: Some("hackneymarshrovers.org.uk"),
      safeguarding_contract_signed: True,
    ),
    orgs_row.Row(
      ..orgs_row.new(
        id: "org-mossside",
        name: "Moss Side Athletic",
        type_: org_type.Club,
        plan: orgs_row.PlanGrassroots,
        created_at: now,
      ),
      level: Some(orgs_row.LevelGrassroots),
      country: Some("GB"),
      city: Some("Manchester"),
      lat: Some(53.451),
      lng: Some(-2.24),
      federation: Some("The FA (England)"),
      federation_registration_id: Some("FA-GR-1877"),
      trusted_partner: False,
      verified: False,
      verified_domain: None,
      safeguarding_contract_signed: False,
    ),
  ]
}

/// Loads the demo organisations into an empty database. A database that has any organisation is left alone:
/// later boots never seed.
pub fn run(store: Store(effect), now: Int) -> Result(Bool, String) {
  store.unit(store, fn(tx) {
    use existing <- result.try(store.query(
      store.reading(tx),
      "SELECT COUNT(*) FROM orgs",
      [],
      decode.at([0], decode.int),
    ))
    case existing {
      [0] -> {
        use _ <- result.try(list.try_each(orgs(now), orgs_row.insert(tx, _)))
        Ok(#(True, []))
      }
      _ -> Ok(#(False, []))
    }
  })
  |> result.map_error(fn(e) { "seed: " <> string.inspect(e) })
}
