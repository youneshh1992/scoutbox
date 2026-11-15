//// Organisations (`orgs`): what sign-in and the org session need, and the organisation as responses show it.

import gleam/dynamic/decode.{type Decoder}
import gleam/json.{type Json}
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/vocabulary
import sqlight

pub type OrgType {
  Club
  Agency
}

pub type Level {
  Pro
  Academy
  AgencyLevel
  Grassroots
}

pub type Plan {
  GrassrootsPlan
  AcademyPlan
  ProPlan
  AgencyPlan
}

pub type Location {
  Location(lat: Float, lng: Float, city: Option(String))
}

pub type FederationRef {
  FederationRef(federation: String, registration_id: String)
}

pub type Org {
  Org(
    id: String,
    name: String,
    org_type: OrgType,
    level: Option(Level),
    plan: Plan,
    country: Option(String),
    location: Option(Location),
    federation_ref: Option(FederationRef),
    trusted_partner: Bool,
    verified: Bool,
    verified_domain: Option(String),
    safeguarding_contract_signed: Bool,
    suspended: Bool,
    has_password: Bool,
    email_domain: Option(String),
    email_domain_verified: Bool,
    mfa_required_for_leads: Bool,
    verification_revoked_at: Option(Int),
    created_at: Int,
  )
}

const columns =
  "id, name, type, level, plan, country, city, lat, lng, federation, federation_registration_id, trusted_partner, verified, verified_domain, safeguarding_contract_signed, suspended, password_hash IS NOT NULL, email_domain, email_domain_verified, mfa_required_for_leads, verification_revoked_at, created_at"

const types = [#("club", Club), #("agency", Agency)]

const levels = [
  #("pro", Pro),
  #("academy", Academy),
  #("agency", AgencyLevel),
  #("grassroots", Grassroots),
]

const plans = [
  #("Grassroots", GrassrootsPlan),
  #("Academy", AcademyPlan),
  #("Pro", ProPlan),
  #("Agency", AgencyPlan),
]

fn decoder() -> Decoder(Org) {
  use id <- decode.field(0, decode.string)
  use name <- decode.field(1, decode.string)
  use org_type <- decode.field(2, vocabulary.decoder(vocabulary.new(types)))
  use level <- decode.field(
    3,
    decode.optional(vocabulary.decoder(vocabulary.new(levels))),
  )
  use plan <- decode.field(4, vocabulary.decoder(vocabulary.new(plans)))
  use country <- decode.field(5, decode.optional(decode.string))
  use city <- decode.field(6, decode.optional(decode.string))
  use lat <- decode.field(7, decode.optional(decode.float))
  use lng <- decode.field(8, decode.optional(decode.float))
  use federation <- decode.field(9, decode.optional(decode.string))
  use registration <- decode.field(10, decode.optional(decode.string))
  use trusted_partner <- decode.field(11, sqlight.decode_bool())
  use verified <- decode.field(12, sqlight.decode_bool())
  use verified_domain <- decode.field(13, decode.optional(decode.string))
  use safeguarding_contract_signed <- decode.field(14, sqlight.decode_bool())
  use suspended <- decode.field(15, sqlight.decode_bool())
  use has_password <- decode.field(16, sqlight.decode_bool())
  use email_domain <- decode.field(17, decode.optional(decode.string))
  use email_domain_verified <- decode.field(18, sqlight.decode_bool())
  use mfa_required_for_leads <- decode.field(19, sqlight.decode_bool())
  use verification_revoked_at <- decode.field(20, decode.optional(decode.int))
  use created_at <- decode.field(21, decode.int)
  // The table's CHECKs hold lat and lng together, and the federation and its registration together.
  let location = case lat, lng {
    Some(lat), Some(lng) -> Some(Location(lat:, lng:, city:))
    _, _ -> None
  }
  let federation_ref = case federation, registration {
    Some(f), Some(r) -> Some(FederationRef(f, r))
    _, _ -> None
  }
  decode.success(Org(
    id:,
    name:,
    org_type:,
    level:,
    plan:,
    country:,
    location:,
    federation_ref:,
    trusted_partner:,
    verified:,
    verified_domain:,
    safeguarding_contract_signed:,
    suspended:,
    has_password:,
    email_domain:,
    email_domain_verified:,
    mfa_required_for_leads:,
    verification_revoked_at:,
    created_at:,
  ))
}

pub fn by_id(read: Read, id: String) -> Result(Option(Org), Fail(e)) {
  store.one(
    read,
    "SELECT " <> columns <> " FROM orgs WHERE id = ?",
    [sqlight.text(id)],
    decoder(),
  )
  |> result.map(option.from_result)
}

pub fn count(read: Read) -> Result(Int, Fail(e)) {
  store.one(read, "SELECT COUNT(*) FROM orgs", [], decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

pub fn is_grassroots(org: Org) -> Bool {
  org.level == Some(Grassroots)
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
    #("type", json.string(vocabulary.name(vocabulary.new(types), org.org_type))),
    #(
      "level",
      json.nullable(
        option.map(org.level, vocabulary.name(vocabulary.new(levels), _)),
        json.string,
      ),
    ),
    #("plan", json.string(vocabulary.name(vocabulary.new(plans), org.plan))),
    #("country", opt_string(org.country)),
    #(
      "location",
      json.nullable(org.location, fn(l) {
        json.object([
          #("lat", json.float(l.lat)),
          #("lng", json.float(l.lng)),
          #("city", opt_string(l.city)),
        ])
      }),
    ),
    #(
      "federationRef",
      json.nullable(org.federation_ref, fn(f) {
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
