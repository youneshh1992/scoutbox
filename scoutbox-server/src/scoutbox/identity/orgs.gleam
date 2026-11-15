//// Organisations (`orgs`): what sign-in and the org session need, and the organisation as responses show it.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/orgs as row
import scoutbox/vocab/org_type
import sqlight

pub type Org =
  row.Row

pub type Location {
  Location(lat: Float, lng: Float, city: Option(String))
}

pub type FederationRef {
  FederationRef(federation: String, registration_id: String)
}

/// The table's CHECKs hold lat and lng together.
pub fn location(org: Org) -> Option(Location) {
  case org.lat, org.lng {
    Some(lat), Some(lng) -> Some(Location(lat:, lng:, city: org.city))
    _, _ -> None
  }
}

/// The table's CHECKs hold the federation and its registration together.
pub fn federation_ref(org: Org) -> Option(FederationRef) {
  case org.federation, org.federation_registration_id {
    Some(f), Some(r) -> Some(FederationRef(f, r))
    _, _ -> None
  }
}

pub fn has_password(org: Org) -> Bool {
  option.is_some(org.password_hash)
}

pub fn by_id(read: Read, id: String) -> Result(Option(Org), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM orgs WHERE id = ?",
    [sqlight.text(id)],
    row.decoder(),
  )
  |> result.map(option.from_result)
}

pub fn count(read: Read) -> Result(Int, Fail(e)) {
  store.one(read, "SELECT COUNT(*) FROM orgs", [], decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

pub fn is_grassroots(org: Org) -> Bool {
  org.level == Some(row.LevelGrassroots)
}

/// Earned and losable: verification, a signed contract and no unresolved urgent report against the club.
///
/// Not ported yet: safety reports live in the safety domain, which this server does not run, so no report can
/// be open and the last condition always holds.
pub fn safeguarding_certified(org: Org) -> Bool {
  org.verified && org.safeguarding_contract_signed
}

/// The organisation as responses show it: an allowlist, never the row (the password hash is not on it).
///
/// Not ported yet: `lookingFor` and `federationCheck` belong to club setup. They are empty here, as they are for
/// every seeded organisation on the TypeScript server.
pub fn view(org: Org) -> List(#(String, Json)) {
  let opt_string = json.nullable(_, json.string)
  [
    #("id", json.string(org.id)),
    #("name", json.string(org.name)),
    #("type", json.string(org_type.to_string(org.type_))),
    #(
      "level",
      json.nullable(option.map(org.level, row.level_to_string), json.string),
    ),
    #("plan", json.string(row.plan_to_string(org.plan))),
    #("country", opt_string(org.country)),
    #(
      "location",
      json.nullable(location(org), fn(l) {
        json.object([
          #("lat", json.float(l.lat)),
          #("lng", json.float(l.lng)),
          #("city", opt_string(l.city)),
        ])
      }),
    ),
    #(
      "federationRef",
      json.nullable(federation_ref(org), fn(f) {
        json.object([
          #("federation", json.string(f.federation)),
          #("registrationId", json.string(f.registration_id)),
        ])
      }),
    ),
    #("trustedPartner", json.bool(org.trusted_partner)),
    #("verified", json.bool(org.verified)),
    #("verifiedDomain", opt_string(org.verified_domain)),
    #("safeguardingContractSigned", json.bool(org.safeguarding_contract_signed)),
    #("suspended", json.bool(org.suspended)),
    #("emailDomain", opt_string(org.email_domain)),
    #("emailDomainVerified", json.bool(org.email_domain_verified)),
    #("mfaRequiredForLeads", json.bool(org.mfa_required_for_leads)),
    #(
      "verificationRevokedAt",
      json.nullable(org.verification_revoked_at, json.int),
    ),
    #("createdAt", json.int(org.created_at)),
    #("lookingFor", json.preprocessed_array([])),
    #("federationCheck", json.null()),
  ]
}
