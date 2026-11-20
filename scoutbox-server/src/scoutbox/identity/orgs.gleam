//// Organisations (`orgs`): what sign-in and the org session need, and the organisation as responses show it.

import gleam/bool
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/id
import scoutbox/rows/orgs as row
import scoutbox/safety/audit
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

pub fn by_id(read: Read, id: id.OrgId) -> Result(Option(Org), Fail(e)) {
  store.one(
    read,
    "SELECT " <> row.columns <> " FROM orgs WHERE id = ?",
    [id.org_sql(id)],
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
pub fn safeguarding_certified(read: Read, org: Org) -> Result(Bool, Fail(e)) {
  case org.verified && org.safeguarding_contract_signed {
    False -> Ok(False)
    True -> audit.open_urgent_against(read, org.id) |> result.map(bool.negate)
  }
}

/// The organisation as responses show it: an allowlist, never the row (the password hash is not on it).
///
/// Not ported yet: `lookingFor` and `federationCheck` belong to club setup. They are empty here, as they are for
/// every seeded organisation on the TypeScript server.
pub fn view(org: Org) -> List(#(String, Json)) {
  let opt_string = json.nullable(_, json.string)
  [
    #("id", id.org_json(org.id)),
    #("name", json.string(org.name)),
    #("type", org_type.to_json(org.type_)),
    #(
      "level",
      json.nullable(option.map(org.level, row.level_to_string), json.string),
    ),
    #("plan", row.plan_to_json(org.plan)),
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

/// Oldest first, keyed by rowid.
pub fn page(
  read: Read,
  page: paging.Page,
) -> Result(#(List(Org), Option(String)), Fail(e)) {
  page_where(read, "1", [], page)
}

/// The organisations of one type, oldest first, keyed by rowid.
pub fn page_of_type(
  read: Read,
  type_: org_type.OrgType,
  page: paging.Page,
) -> Result(#(List(Org), Option(String)), Fail(e)) {
  page_where(read, "type = ?", [sqlight.text(org_type.to_string(type_))], page)
}

fn page_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
  page: paging.Page,
) -> Result(#(List(Org), Option(String)), Fail(e)) {
  let after = case page.after {
    Some([paging.IntKey(rid)]) -> rid
    _ -> 0
  }
  use rows <- result.map(
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> ", rowid FROM orgs WHERE "
        <> where
        <> " AND rowid > ? ORDER BY rowid LIMIT ?",
      list.append(args, [sqlight.int(after), sqlight.int(page.limit + 1)]),
      {
        use o <- decode.then(row.decoder())
        use rid <- decode.field(row.width, decode.int)
        decode.success(#(o, rid))
      },
    ),
  )
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(p) { [paging.IntKey(p.1)] })
  #(list.map(items, fn(p) { p.0 }), next)
}

pub fn suspend(tx: Tx, org_id: id.OrgId) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE orgs SET suspended = 1 WHERE id = ?", [
    id.org_sql(org_id),
  ])
}

/// Whether leads must have MFA to sign in, as stored.
pub fn require_mfa_for_leads(
  tx: Tx,
  org_id: id.OrgId,
  required: Bool,
) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE orgs SET mfa_required_for_leads = ? WHERE id = ?", [
    sqlight.bool(required),
    id.org_sql(org_id),
  ])
}

/// `hash` is `passwords.hash`'s stored form.
pub fn set_password_hash(
  tx: Tx,
  org_id: id.OrgId,
  hash: String,
) -> Result(Nil, Fail(e)) {
  store.run(tx, "UPDATE orgs SET password_hash = ? WHERE id = ?", [
    sqlight.text(hash),
    id.org_sql(org_id),
  ])
}

/// The standing switches Trust & Safety sets. `None` leaves a field as it is; a verified domain of
/// `Some(None)` clears it.
pub type Standing {
  Standing(
    verified: Option(Bool),
    safeguarding_contract_signed: Option(Bool),
    suspended: Option(Bool),
    verified_domain: Option(Option(String)),
  )
}

pub fn set_standing(tx: Tx, id: id.OrgId, s: Standing) -> Result(Nil, Fail(e)) {
  let bool = fn(column, v) {
    option.map(v, fn(b) { #(column <> " = ?", sqlight.bool(b)) })
  }
  let sets =
    option.values([
      bool("verified", s.verified),
      bool("safeguarding_contract_signed", s.safeguarding_contract_signed),
      bool("suspended", s.suspended),
      option.map(s.verified_domain, fn(d) {
        #("verified_domain = ?", sqlight.nullable(sqlight.text, d))
      }),
    ])
  case sets {
    [] -> Ok(Nil)
    _ ->
      store.run(
        tx,
        "UPDATE orgs SET "
          <> list.map(sets, fn(s) { s.0 }) |> string.join(", ")
          <> " WHERE id = ?",
        list.append(list.map(sets, fn(s) { s.1 }), [id.org_sql(id)]),
      )
  }
}

/// The club proved control of a mailbox at `domain`.
pub fn verify_email_domain(
  tx: Tx,
  org_id: id.OrgId,
  domain: String,
) -> Result(Nil, Fail(e)) {
  store.run(
    tx,
    "UPDATE orgs SET email_domain = ?, email_domain_verified = 1 WHERE id = ?",
    [sqlight.text(domain), id.org_sql(org_id)],
  )
}
