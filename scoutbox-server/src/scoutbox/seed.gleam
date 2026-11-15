//// The demo world a first development boot loads: the organisations the e2e batteries sign in to. Staff
//// accounts are not seeded; a demo organisation's first sign-in under a name creates the account.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/store.{type Store}
import sqlight

type SeedOrg {
  SeedOrg(
    id: String,
    name: String,
    org_type: String,
    level: String,
    plan: String,
    city: Option(String),
    lat: Option(Float),
    lng: Option(Float),
    federation: Option(#(String, String)),
    trusted_partner: Bool,
    verified: Bool,
    verified_domain: Option(String),
    safeguarding_contract_signed: Bool,
  )
}

const orgs = [
  SeedOrg(
    "org-eastport",
    "Eastport FC",
    "club",
    "pro",
    "Pro",
    Some("Eastport"),
    Some(51.889),
    Some(1.02),
    None,
    True,
    True,
    Some("eastportfc.com"),
    True,
  ),
  SeedOrg(
    "org-harbour",
    "Harbour City FC",
    "club",
    "academy",
    "Academy",
    Some("Harbour City"),
    Some(53.408),
    Some(-2.983),
    None,
    False,
    False,
    None,
    False,
  ),
  SeedOrg(
    "org-northstar",
    "North Star Sports Agency",
    "agency",
    "agency",
    "Agency",
    None,
    None,
    None,
    None,
    False,
    False,
    None,
    False,
  ),
  SeedOrg(
    "org-hackneymarsh",
    "Hackney Marsh Rovers",
    "club",
    "grassroots",
    "Grassroots",
    Some("London"),
    Some(51.552),
    Some(-0.022),
    Some(#("The FA (England)", "FA-GR-2201")),
    False,
    True,
    Some("hackneymarshrovers.org.uk"),
    True,
  ),
  SeedOrg(
    "org-mossside",
    "Moss Side Athletic",
    "club",
    "grassroots",
    "Grassroots",
    Some("Manchester"),
    Some(53.451),
    Some(-2.24),
    Some(#("The FA (England)", "FA-GR-1877")),
    False,
    False,
    None,
    False,
  ),
]

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
        use _ <- result.try(list.try_each(orgs, insert(tx, _, now)))
        Ok(#(True, []))
      }
      _ -> Ok(#(False, []))
    }
  })
  |> result.map_error(fn(e) { "seed: " <> string.inspect(e) })
}

fn insert(tx: store.Tx, o: SeedOrg, now: Int) -> Result(Nil, store.Fail(e)) {
  store.run(
    tx,
    "INSERT INTO orgs (id, name, type, level, plan, country, city, lat, lng, federation, federation_registration_id, trusted_partner, verified, verified_domain, safeguarding_contract_signed, created_at) VALUES (?, ?, ?, ?, ?, 'GB', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      sqlight.text(o.id),
      sqlight.text(o.name),
      sqlight.text(o.org_type),
      sqlight.text(o.level),
      sqlight.text(o.plan),
      sqlight.nullable(sqlight.text, o.city),
      sqlight.nullable(sqlight.float, o.lat),
      sqlight.nullable(sqlight.float, o.lng),
      sqlight.nullable(sqlight.text, option.map(o.federation, fn(f) { f.0 })),
      sqlight.nullable(sqlight.text, option.map(o.federation, fn(f) { f.1 })),
      sqlight.bool(o.trusted_partner),
      sqlight.bool(o.verified),
      sqlight.nullable(sqlight.text, o.verified_domain),
      sqlight.bool(o.safeguarding_contract_signed),
      sqlight.int(now),
    ],
  )
}
