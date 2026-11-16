//// `gleam dev [out]`: regenerate the row and vocabulary modules from priv/migrations into `out` (default
//// `src`). Use `npm run codegen`, which also formats them; `npm run codegen:check` fails when the committed
//// modules differ from what the migrations generate. Developer tooling only: nothing under dev/ ships.

import argv
import gleam/io
import gleam/list
import gleam/string
import scoutbox/codegen.{Shared}
import simplifile

/// The vocabularies several tables share, declared once. Each must be exactly some column's CHECK list.
pub const shared = [
  Shared("Party", ["player", "guardian"]),
  Shared("Audience", ["player", "guardian", "org_user"]),
  Shared("OrgType", ["club", "agency"]),
  Shared(
    "Position",
    [
      "GK", "CB", "RB", "LB", "RWB", "LWB", "CDM", "CM", "CAM", "RW", "LW", "ST",
      "CF",
    ],
  ),
  Shared("PlayingLevel", ["amateur", "semi_pro", "pro"]),
  Shared(
    "ClaimType",
    [
      "PERSON_IDENTITY", "ORGANISATION_IDENTITY", "ORGANISATION_DOMAIN",
      "ORGANISATION_ADMIN", "CLUB_AFFILIATION", "CLUB_ROLE", "LICENCE",
      "AGENCY_AFFILIATION", "AGENCY_ROLE", "GRASSROOTS_AFFILIATION",
      "FEDERATION_AFFILIATION",
    ],
  ),
  Shared(
    "VerificationMethod",
    [
      "official_domain_email", "organisation_admin_confirmation",
      "authoritative_registry", "federation_confirmation",
      "existing_verified_org_admin", "scoutbox_manual_review",
      "document_submitted", "reference_confirmation", "migration",
    ],
  ),
  Shared("ActorKind", ["system", "org_user", "org_admin", "trust_safety"]),
  Shared(
    "VerLevel",
    [
      "verification_viewer", "verification_reviewer", "verification_admin",
      "verification_root_admin",
    ],
  ),
  Shared(
    "IdentityLink",
    ["trust_safety_selection", "provisioned_new_user", "verified_work_email"],
  ),
  Shared(
    "Attribution",
    ["authenticated_reviewer", "declared_reviewer", "shared_admin_key"],
  ),
  Shared(
    "VerOrgType",
    [
      "professional club", "academy", "grassroots club",
      "federation/association", "agency", "other approved football organisation",
    ],
  ),
  Shared(
    "VerCode",
    [
      "ROOT_ORGANISATION_BOOTSTRAP",
      "NO_AUTHORITATIVE_SOURCE",
      "CONFLICTING_EVIDENCE",
      "IDENTITY_MISMATCH",
      "DOMAIN_OWNERSHIP_AMBIGUOUS",
      "DUPLICATE_ORGANISATION",
      "HIGH_RISK_ADMIN_CHANGE",
      "DOCUMENT_AUTHENTICITY_UNCONFIRMED",
      "REGISTRY_AMBIGUOUS_MATCH",
      "DISPUTED_CLAIM",
      "SUSPECTED_FRAUD_SIGNALS",
      "MANUAL_EXCEPTION_REQUESTED",
      "REGISTRY_RECORD_UNREADABLE",
      "DISPOSABLE_EMAIL",
      "FREE_EMAIL_PROVIDER",
      "ORG_DOMAIN_MISMATCH",
      "REPEATED_EMAIL_CHALLENGE_FAILURES",
      "COMPETING_ORGANISATION_CLAIMS",
      "CREDENTIAL_REUSED_ACROSS_USERS",
      "DUPLICATE_EVIDENCE_HASH",
      "RECENT_REVOCATION_REAPPLY",
      "ORGANISATION_SUSPENDED",
      "CONFLICTING_ACTIVE_ROLES",
      "UNUSUAL_MASS_ACTIVITY",
      "SELF_VERIFICATION_ATTEMPT",
    ],
  ),
]

pub fn main() -> Nil {
  let out = case argv.load().arguments {
    [out, ..] -> out
    [] -> "src"
  }
  let assert Ok(files) = simplifile.read_directory("priv/migrations")
  let schema =
    files
    |> list.filter(string.ends_with(_, ".sql"))
    |> list.sort(string.compare)
    |> list.map(fn(f) {
      let assert Ok(sql) = simplifile.read("priv/migrations/" <> f)
      sql
    })
    |> string.join("\n")
  let _ =
    simplifile.delete_all([out <> "/scoutbox/rows", out <> "/scoutbox/vocab"])
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/rows")
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/vocab")
  list.each(codegen.generate(schema, shared), fn(g) {
    let path = out <> "/" <> g.module <> ".gleam"
    let assert Ok(_) = simplifile.write(path, g.source)
    io.println("wrote " <> path)
  })
}
