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
    "WebhookEvent",
    [
      "import.committed", "identity.resolved", "transition.granted",
      "transition.revoked", "delivery.failed",
    ],
  ),
  Shared("NotificationCategory", [
    "mentions",
    "assignments",
    "room_changes",
    "evidence_requests",
    "combine",
    "trial_updates",
    "second_look",
    "brief_updates",
    "messages",
    "activity",
    "discovery_nudges",
    "watchlist_changes",
    "development_updates",
    "representation",
    "compliance",
    "transaction_updates",
    "offer_updates",
    "signing_updates",
    "security_account",
  ]),
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
  Shared("CheckOutcome", ["passed", "flagged"]),
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

/// The tables that get a row module: the ones this server reads or writes. Add a table here when a port needs it.
pub const tables = [
  "blocks",
  "channels",
  "counters",
  "delivery_callbacks_seen",
  "delivery_centre",
  "delivery_fail_injections",
  "dispatch_attempts",
  "dispatches",
  "guardian_children",
  "guardians",
  "idv_queue",
  "ledger",
  "message_attachments",
  "messages",
  "moderation_flags",
  "moderation_log",
  "notification_pref_categories",
  "notification_prefs",
  "notifications",
  "ops_events",
  "org_invites",
  "org_notes",
  "org_user_recovery_codes",
  "org_users",
  "org_verified_domains",
  "orgs",
  "outbox",
  "player_activity_log",
  "player_attendance",
  "player_badges",
  "player_drill_results",
  "player_drills",
  "player_external_ids",
  "player_media",
  "player_media_tags",
  "player_medical_records",
  "player_programme_completions",
  "player_season_history",
  "player_timeline",
  "players",
  "push_log",
  "push_tokens",
  "recruitment_requests",
  "reports",
  "sessions",
  "support_ticket_refs",
  "support_ticket_replies",
  "support_tickets",
  "transition_case_history",
  "transition_case_pack_items",
  "transition_case_recipients",
  "transition_cases",
  "ver_admins",
  "ver_claim_codes",
  "ver_claim_evidence",
  "ver_claims",
  "ver_conflicts",
  "ver_disputes",
  "ver_domain_request_codes",
  "ver_domain_requests",
  "ver_events",
  "ver_evidence",
  "ver_migrations",
  "ver_player_invites",
  "ver_references",
  "ver_root_request_codes",
  "ver_root_requests",
  "ver_root_transfers",
  "ver_tokens",
  "webhook_deliveries",
  "webhook_delivery_attempts",
  "webhook_endpoint_events",
  "webhook_endpoints",
]

/// The migrations' SQL, concatenated after the bookkeeping tables the runner creates, with their clock and
/// session lifetime filled in.
pub fn schema() -> String {
  let assert Ok(files) = simplifile.read_directory("priv/migrations")
  [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    "CREATE TABLE data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);",
    ..files
    |> list.filter(string.ends_with(_, ".sql"))
    |> list.sort(string.compare)
    |> list.map(fn(f) {
      let assert Ok(sql) = simplifile.read("priv/migrations/" <> f)
      sql
      |> string.replace("__NOW__", "0")
      |> string.replace("__SESSION_TTL_MS__", "0")
    })
  ]
  |> string.join("\n")
}

pub fn main() -> Nil {
  let out = case argv.load().arguments {
    [out, ..] -> out
    [] -> "src"
  }
  let schema = schema()
  let _ =
    simplifile.delete_all([out <> "/scoutbox/rows", out <> "/scoutbox/vocab"])
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/rows")
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/vocab")
  list.each(codegen.generate(schema, shared, tables), fn(g) {
    let path = out <> "/" <> g.module <> ".gleam"
    let assert Ok(_) = simplifile.write(path, g.source)
    io.println("wrote " <> path)
  })
}
