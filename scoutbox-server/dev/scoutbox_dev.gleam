//// `gleam dev [out]`: regenerate the row and vocabulary modules from priv/migrations into `out` (default
//// `src`). Use `npm run codegen`, which also formats them; `npm run codegen:check` fails when the committed
//// modules differ from what the migrations generate. `gleam dev sql-check [--verbose]` (`npm run sql:check`):
//// prepare every query the source spells out against the migrated schema (`scoutbox/sql_check`). Developer
//// tooling only: nothing under dev/ ships.

import argv
import gleam/int
import gleam/io
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/codegen.{Ided, RefersTo, Shared, Untyped}
import scoutbox/sql_check
import scoutbox/sql_source
import simplifile

/// The vocabularies several tables share, declared once. Each must be exactly some column's CHECK list.
pub const shared = [
  Shared("Party", ["player", "guardian"]),
  Shared("ContactMode", ["player_only", "both"]),
  Shared(
    "ContextType",
    ["employment_contract", "transfer", "loan", "other_services"],
  ),
  Shared("PartyRole", ["individual", "engaging_entity", "releasing_entity"]),
  Shared("SubjectKind", ["player", "club"]),
  Shared(
    "TransactionStatus",
    [
      "DRAFT", "PARTIES_CONFIRMED", "COMPLIANCE_PENDING", "COMPLIANCE_BLOCKED",
      "READY", "ACTIVE", "ON_HOLD", "CANCELLED", "CLOSED", "ARCHIVED",
    ],
  ),
  Shared(
    "PendingReason",
    [
      "CONSENT_REQUIRED", "MANUAL_REVIEW", "INSUFFICIENT_DATA",
      "PROVIDER_UNAVAILABLE", "JURISDICTION_UNSUPPORTED", "FACET_NOT_VERIFIED",
      "PARTIES_NOT_CONFIRMED", "REPRESENTATION_MISSING",
    ],
  ),
  Shared(
    "DocumentVisibility",
    [
      "AGENT_PRIVATE", "PLAYER_PRIVATE", "ENGAGING_CLUB_PRIVATE",
      "RELEASING_CLUB_PRIVATE", "PLAYER_AGENT_SHARED", "ENGAGING_AGENT_SHARED",
      "RELEASING_AGENT_SHARED", "ALL_TRANSACTION_PARTIES", "T_AND_S_ONLY",
    ],
  ),
  Shared(
    "Staleness",
    ["NO_SNAPSHOT", "INPUTS_CHANGED", "POLICY_CHANGED", "EXPIRED"],
  ),
  Shared("Audience", ["player", "guardian", "org_user"]),
  Shared("OrgType", ["club", "agency"]),
  Shared(
    "WebhookEvent",
    [
      "import.committed", "identity.resolved", "transition.granted",
      "transition.revoked", "delivery.failed",
    ],
  ),
  Shared(
    "NotificationCategory",
    [
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
    ],
  ),
  Shared(
    "Position",
    [
      "GK", "CB", "RB", "LB", "RWB", "LWB", "CDM", "CM", "CAM", "RW", "LW", "ST",
      "CF",
    ],
  ),
  Shared("PlayingLevel", ["amateur", "semi_pro", "pro"]),
  Shared(
    "Currency",
    ["GBP", "EUR", "USD", "CHF", "SEK", "NOK", "DKK", "PLN", "BRL"],
  ),
  Shared("CaseOutcome", ["sign", "pass", "monitor"]),
  Shared("BriefStatus", ["draft", "active", "paused", "closed", "archived"]),
  Shared("ReviewState", ["open", "reviewed", "added_to_room", "dismissed"]),
  Shared(
    "TrustBand",
    [
      "limited_evidence", "developing_evidence", "established_evidence",
      "strong_evidence", "very_strong_evidence",
    ],
  ),
  Shared(
    "OfferStatus",
    [
      "DRAFT", "ISSUED", "ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED",
      "SUPERSEDED",
    ],
  ),
  Shared("DecisionOutcome", ["progress", "hold", "reject"]),
  Shared(
    "DecisionEvidenceKind",
    ["assessment", "trial", "box_cam_session", "passport_evidence"],
  ),
  Shared("Foot", ["left", "right"]),
  Shared(
    "Availability",
    [
      "available_now", "end_of_season", "loan_open", "overseas_open",
      "not_seeking",
    ],
  ),
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
  Shared(
    "RoomStatus",
    [
      "watching",
      "under_review",
      "contact_planned",
      "contacted",
      "shortlisted",
      "priority",
      "trial_requested",
      "trial_scheduled",
      "trial_completed",
      "offer_consideration",
      "offer_made",
      "offer_accepted",
      "offer_declined",
      "signed",
      "on_hold",
      "withdrawn",
      "archived",
      "closed",
    ],
  ),
  Shared(
    "SourceContext",
    [
      "search",
      "watchlist",
      "shortlist",
      "opportunity",
      "recommendation",
      "campaign",
      "passport",
      "nobody_missed",
      "second_look",
      "matching",
      "dynamic_watchlist",
      "direct",
    ],
  ),
  Shared("TaskState", ["open", "in_progress", "done", "cancelled"]),
  Shared("Jurisdiction", ["INT", "ENG", "USA"]),
  Shared(
    "AgentFacet",
    [
      "fifa_licence", "national_registration", "domestic_authorisation",
      "minors_authorisation",
    ],
  ),
  Shared(
    "FacetState",
    [
      "UNVERIFIED", "PENDING", "VERIFIED", "STALE", "INACTIVE",
      "MANUAL_REVIEW_REQUIRED",
    ],
  ),
  Shared(
    "AgencyTier",
    ["licensed_agent", "agency_admin", "analyst", "assistant", "finance"],
  ),
  Shared("AgentActorKind", ["org", "player", "ts_reviewer", "system"]),
  Shared(
    "AgreementStatus",
    [
      "proposed", "active", "declined", "expired", "terminated_by_client",
      "terminated_by_agent", "disputed",
    ],
  ),
  Shared("Terminator", ["agent", "client", "trust_safety"]),
  Shared("ShareVia", ["opportunity", "open_trial"]),
  Shared("TrialActorKind", ["org", "player", "guardian", "system"]),
  Shared(
    "RecruitmentActorKind",
    ["org", "player", "guardian", "admin", "system"],
  ),
  Shared("SigningPartyType", ["PLAYER", "GUARDIAN", "CLUB_SIGNATORY"]),
  Shared(
    "SigningMethod",
    ["PLATFORM_ACKNOWLEDGMENT", "UPLOAD_EXECUTED_DOCUMENT"],
  ),
  Shared(
    "TrialSessionKind",
    ["onboarding", "training", "drill", "small_sided", "match", "other"],
  ),
  Shared(
    "TrialWorkflowState",
    ["legacy_accepted", "accepted", "scheduled", "completed", "cancelled"],
  ),
  Shared(
    "ReviewStatus",
    ["PENDING", "IN_REVIEW", "APPROVED", "REJECTED", "CANCELLED", "SUPERSEDED"],
  ),
  Shared(
    "RuleStatus",
    [
      "ACTIVE", "SUSPENDED", "PARTIALLY_SUSPENDED", "JURISDICTION_OVERRIDE",
      "PENDING_IMPLEMENTATION", "UNDER_LEGAL_REVIEW", "UNKNOWN",
    ],
  ),
  Shared(
    "ContextOutcome",
    [
      "CLEAR", "PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED",
      "PROHIBITED_CONFLICT", "MANUAL_REGULATORY_REVIEW_REQUIRED",
      "INSUFFICIENT_DATA",
    ],
  ),
  Shared(
    "DeclaredRepresentationStatus",
    ["verified", "pending_review", "withdrawn"],
  ),
  Shared("ReviewerRole", ["trust_safety_reviewer", "trust_safety_admin"]),
  Shared(
    "ComplianceActorKind",
    ["org", "player", "club_user", "ts_reviewer", "system"],
  ),
]

/// The tables that get a row module: the ones this server reads or writes. Add a table here when a port needs it.
pub const tables = [
  "agency_affiliation_history",
  "agency_affiliation_history_tiers",
  "agency_affiliation_tiers",
  "agency_affiliations",
  "agent_profile_facets",
  "agent_profile_history",
  "agent_profile_jurisdictions",
  "agent_profiles",
  "agent_transaction_jurisdictions",
  "agent_transactions",
  "applications",
  "agreement_history",
  "agreement_opportunity_shares",
  "agreement_policy_versions",
  "agreement_scopes",
  "assessment_history",
  "assessment_rating_refs",
  "assessment_ratings",
  "assessment_template_attributes",
  "assessment_templates",
  "assessments",
  "blocks",
  "box_cam_cv_results",
  "box_cam_prefs",
  "box_sessions",
  "calibration_notes",
  "calibration_participants",
  "calibration_ratings",
  "calibration_sessions",
  "calibration_submissions",
  "case_approvals",
  "case_assignments",
  "case_budget_actuals",
  "case_budget_fx_assumptions",
  "case_budget_lines",
  "case_budget_scenarios",
  "case_decision_draft_evidence_refs",
  "case_decision_draft_reason_codes",
  "case_decision_drafts",
  "case_history",
  "case_request_links",
  "case_room_tags",
  "case_tasks",
  "case_transaction_handoffs",
  "case_trial_links",
  "channels",
  "combine_attempts",
  "combine_request_protocols",
  "combine_requests",
  "compliance_context_history",
  "compliance_context_history_policy_versions",
  "compliance_context_jurisdictions",
  "compliance_context_parties",
  "compliance_context_representations",
  "compliance_contexts",
  "compliance_evaluation_consents_outstanding",
  "compliance_evaluation_policy_versions",
  "compliance_evaluation_reason_items",
  "compliance_evaluation_reasons",
  "compliance_evaluation_snapshot_parties",
  "compliance_evaluation_snapshot_representations",
  "compliance_evaluations",
  "contact_attempts",
  "contact_history",
  "counters",
  "coverage_assignment_targets",
  "coverage_assignment_warnings",
  "coverage_assignments",
  "coverage_plans",
  "delivery_callbacks_seen",
  "delivery_centre",
  "delivery_fail_injections",
  "dispatch_attempts",
  "dispatches",
  "dynamic_watchlists",
  "email_challenges",
  "evidence",
  "evidence_disputes",
  "evidence_history",
  "evidence_media",
  "evidence_suggestion_records",
  "evidence_suggestions",
  "fixtures",
  "friendlies",
  "guardian_children",
  "guardians",
  "idempotency_keys",
  "idv_queue",
  "invoices",
  "jurisdiction_policies",
  "jurisdiction_policy_history",
  "jurisdiction_policy_publishers",
  "jurisdiction_policy_rule_overrides",
  "jurisdiction_policy_rule_param_items",
  "jurisdiction_policy_rule_params",
  "jurisdiction_policy_rule_sources",
  "jurisdiction_policy_rules",
  "ledger",
  "message_attachments",
  "messages",
  "moderation_flags",
  "moderation_log",
  "nobody_missed_reviews",
  "nobody_missed_review_history",
  "notification_pref_categories",
  "notification_prefs",
  "notifications",
  "offer_history",
  "offer_keys",
  "offer_read_receipts",
  "offer_responses",
  "offer_revision_documents",
  "offer_revisions",
  "open_trial_positions",
  "open_trials",
  "ops_events",
  "org_agency_jurisdictions",
  "org_agency_settings",
  "org_invites",
  "org_notes",
  "org_squad_members",
  "org_user_recovery_codes",
  "opportunities",
  "opportunity_texts",
  "opportunity_training_slots",
  "org_users",
  "org_verified_domains",
  "orgs",
  "outbox",
  "outcome_reports",
  "passport_career_entries",
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
  "player_match_fact_combine",
  "player_match_fact_positions",
  "player_match_facts",
  "push_log",
  "push_tokens",
  "recruitment_briefs",
  "recruitment_brief_history",
  "recruitment_brief_values",
  "recruitment_cases",
  "recruitment_contacts",
  "recruitment_offers",
  "recruitment_requests",
  "regulatory_consent_history",
  "regulatory_consent_policy_versions",
  "regulatory_consent_regarding",
  "regulatory_consent_revocations",
  "regulatory_consent_rule_ids",
  "regulatory_consents",
  "regulatory_review_history",
  "regulatory_review_policy_versions",
  "regulatory_review_reasons",
  "regulatory_reviews",
  "reports",
  "representation_agreements",
  "review_later",
  "request_trial_slots",
  "room_comment_mentions",
  "room_comments",
  "room_decision_assessment_ids",
  "room_decision_evidence_refs",
  "room_decision_reason_codes",
  "room_decisions",
  "room_evidence_states",
  "room_snapshot_source_refs",
  "room_snapshots",
  "saved_searches",
  "second_look_items",
  "second_look_item_fingerprints",
  "second_look_item_history",
  "second_look_item_reasons",
  "sessions",
  "signing_documents",
  "signing_history",
  "signing_packages",
  "signing_parties",
  "signing_revision_parties",
  "signing_revisions",
  "signings",
  "support_ticket_refs",
  "support_ticket_replies",
  "support_tickets",
  "ts_reviewer_history",
  "ts_reviewers",
  "transaction_document_history",
  "transaction_documents",
  "transaction_history",
  "transaction_history_policy_versions",
  "transaction_history_reason_codes",
  "transaction_keys",
  "transaction_linked_threads",
  "transaction_notes",
  "transaction_parties",
  "transaction_representation_history",
  "transaction_representation_history_policy_versions",
  "transaction_representation_scopes",
  "transaction_representations",
  "transaction_terms_versions",
  "transition_case_history",
  "transition_case_pack_items",
  "transition_case_recipients",
  "transition_cases",
  "trial_attendance",
  "trial_day_checkins",
  "trial_day_consents",
  "trial_day_staff",
  "trial_day_status_events",
  "trial_history",
  "trial_keys",
  "trial_reminders",
  "trial_reports",
  "trial_revision_sessions",
  "trial_schedule_revisions",
  "trial_schedule_sessions",
  "trial_session_evidence",
  "trials",
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
  "watchlist_criteria",
  "watchlist_criterion_values",
  "watchlist_history",
  "watchlist_member_checks",
  "watchlist_members",
  "watchlist_membership_events",
  "webhook_deliveries",
  "webhook_delivery_attempts",
  "webhook_endpoint_events",
  "webhook_endpoints",
]

/// The tables whose ids are typed (`scoutbox/rows/id`), each with the prefix its ids are minted with here
/// (none for a table only the seed fills).
pub const ided = [
  Ided("blocks", "Block", Some("blk")),
  Ided("channels", "Channel", Some("chan")),
  Ided("dispatches", "Dispatch", Some("dsp")),
  Ided("friendlies", "Friendly", Some("fr")),
  Ided("guardians", "Guardian", Some("gd")),
  Ided("idv_queue", "IdvCase", None),
  Ided("ledger", "LedgerEntry", Some("led")),
  Ided("messages", "Message", Some("msg")),
  Ided("moderation_log", "ModerationEntry", Some("mod")),
  Ided("notifications", "Notification", Some("ntf")),
  Ided("ops_events", "OpsEvent", Some("ops")),
  Ided("org_invites", "OrgInvite", Some("inv")),
  Ided("org_notes", "OrgNote", Some("note")),
  Ided("org_users", "OrgUser", Some("usr")),
  Ided("open_trials", "OpenTrial", Some("open")),
  Ided("opportunities", "Opportunity", Some("opp")),
  Ided("applications", "Application", Some("apl")),
  Ided("org_squad_members", "SquadEntry", Some("sq")),
  Ided("orgs", "Org", Some("org")),
  Ided("outbox", "Mail", Some("mail")),
  Ided("player_attendance", "Attendance", Some("att")),
  Ided("player_drill_results", "DrillResult", None),
  Ided("player_media", "Media", Some("media")),
  Ided("player_medical_records", "MedicalRecord", Some("md")),
  Ided("players", "Player", Some("pl")),
  Ided("push_log", "Push", Some("push")),
  Ided("recruitment_requests", "Request", Some("req")),
  Ided("reports", "Report", Some("rep")),
  Ided("recruitment_cases", "RecruitmentCase", Some("case")),
  Ided("evidence", "ScoutingEvidence", Some("evd")),
  Ided("evidence_history", "EvidenceEvent", Some("aud")),
  Ided("evidence_disputes", "EvidenceDispute", None),
  Ided("evidence_suggestions", "EvidenceSuggestion", Some("gap")),
  Ided("review_later", "Deferral", Some("rvl")),
  Ided("calibration_sessions", "CalibrationSession", Some("cal")),
  Ided("fixtures", "Fixture", Some("fix")),
  Ided("coverage_plans", "CoveragePlan", Some("cvp")),
  Ided("coverage_assignments", "CoverageAssignment", Some("cva")),
  Ided("combine_requests", "CombineRequest", Some("creq")),
  Ided("combine_attempts", "CombineAttempt", None),
  Ided("box_sessions", "BoxSession", None),
  Ided("assessments", "Assessment", Some("ass")),
  Ided("assessment_history", "AssessmentEvent", Some("aud")),
  Ided("signings", "Signing", None),
  Ided("invoices", "Invoice", Some("inv")),
  Ided("signing_packages", "SigningPackage", Some("spk")),
  Ided("signing_revisions", "SigningRevision", Some("spr")),
  // Minted as sgd- (the document to sign) or sgx- (the executed copy), so with ids.next.
  Ided("signing_documents", "SigningDocument", None),
  Ided("signing_history", "SigningEvent", Some("aud")),
  Ided("recruitment_contacts", "Contact", Some("rct")),
  Ided("contact_history", "ContactEvent", Some("aud")),
  Ided("outcome_reports", "OutcomeReport", None),
  Ided("passport_career_entries", "CareerEntry", None),
  Ided("representation_agreements", "Agreement", Some("rep")),
  Ided("agent_profiles", "AgentProfile", Some("agp")),
  Ided("agent_profile_history", "ProfileEvent", Some("aud")),
  Ided("agency_affiliations", "Affiliation", Some("aff")),
  Ided("agency_affiliation_history", "AffiliationEvent", Some("aud")),
  Ided("agreement_history", "AgreementEvent", Some("aud")),
  Ided("agreement_opportunity_shares", "OpportunityShare", Some("aos")),
  Ided("jurisdiction_policies", "Policy", None),
  Ided("jurisdiction_policy_history", "PolicyEvent", Some("aud")),
  Ided("regulatory_reviews", "RegulatoryReview", Some("rrv")),
  Ided("regulatory_review_history", "ReviewEvent", Some("aud")),
  Ided("regulatory_consents", "Consent", Some("rcs")),
  Ided("regulatory_consent_revocations", "ConsentRevocation", Some("rcs")),
  Ided("regulatory_consent_history", "ConsentEvent", Some("aud")),
  Ided("ts_reviewers", "Reviewer", None),
  Ided("ts_reviewer_history", "ReviewerEvent", Some("aud")),
  Ided("trials", "Trial", Some("trial")),
  Ided("trial_schedule_sessions", "TrialSession", Some("tses")),
  Ided("trial_session_evidence", "TrialEvidence", Some("tev")),
  Ided("trial_history", "TrialEvent", Some("aud")),
  Ided("trial_reports", "TrialReport", Some("rep")),
  Ided("trial_day_staff", "TrialStaff", Some("stf")),
  Ided("trial_day_consents", "TrialConsent", Some("cns")),
  Ided("request_trial_slots", "TrialSlot", Some("tslot")),
  Ided("case_assignments", "Assignment", Some("asg")),
  Ided("case_approvals", "Approval", Some("apr")),
  Ided("case_budget_scenarios", "BudgetScenario", None),
  Ided("case_budget_lines", "BudgetLine", None),
  Ided("case_budget_actuals", "BudgetActual", None),
  Ided("case_history", "CaseEvent", Some("aud")),
  Ided("case_tasks", "Task", Some("tsk")),
  Ided("room_comments", "RoomComment", Some("rcmt")),
  Ided("room_decisions", "RoomDecision", Some("rdec")),
  Ided("case_decision_drafts", "DecisionDraft", Some("rdraft")),
  Ided("recruitment_offers", "Offer", Some("rof")),
  Ided("offer_revisions", "OfferRevision", Some("rofr")),
  Ided("offer_responses", "OfferResponse", Some("rofa")),
  Ided("offer_revision_documents", "OfferDocument", Some("rofd")),
  Ided("offer_history", "OfferEvent", Some("aud")),
  Ided("room_evidence_states", "RoomEvidenceState", Some("rev")),
  Ided("room_snapshots", "RoomSnapshot", Some("rsnap")),
  Ided("saved_searches", "SavedSearch", Some("ss")),
  Ided("support_tickets", "Ticket", Some("tkt")),
  Ided("transition_case_history", "TransitionEvent", Some("aud")),
  Ided("transition_cases", "TransitionCase", Some("trn")),
  Ided("ver_admins", "VerAdmin", Some("vadm")),
  Ided("ver_claims", "Claim", Some("vclm")),
  Ided("ver_conflicts", "Conflict", Some("vcoi")),
  Ided("ver_disputes", "Dispute", Some("vdsp")),
  Ided("ver_domain_requests", "DomainRequest", Some("vdom")),
  Ided("ver_events", "VerEvent", Some("vevt")),
  Ided("ver_evidence", "Evidence", Some("vevd")),
  Ided("ver_player_invites", "PlayerInvite", Some("vpin")),
  Ided("ver_references", "Reference", Some("vref")),
  Ided("ver_root_requests", "RootRequest", Some("vroot")),
  Ided("ver_root_transfers", "RootTransfer", Some("vrtx")),
  Ided("ver_tokens", "VerToken", Some("vtk")),
  Ided("webhook_deliveries", "WebhookDelivery", Some("dlv")),
  Ided("webhook_endpoints", "WebhookEndpoint", Some("whk")),
  Ided("case_transaction_handoffs", "Handoff", Some("hof")),
  Ided("compliance_contexts", "ComplianceContext", Some("ctx")),
  Ided("compliance_evaluations", "Evaluation", None),
  Ided("compliance_context_history", "ContextEvent", Some("aud")),
  Ided("agent_transactions", "Transaction", Some("atx")),
  Ided("transaction_parties", "TransactionParty", Some("txp")),
  Ided("transaction_notes", "TransactionNote", Some("txn")),
  Ided("transaction_history", "TransactionEvent", Some("aud")),
  Ided("transaction_representations", "Representation", Some("txr")),
  Ided("transaction_representation_history", "RepresentationEvent", Some("aud")),
  Ided("transaction_documents", "TransactionDocument", Some("txd")),
  Ided("transaction_document_history", "TransactionDocumentEvent", Some("aud")),
  Ided("transaction_terms_versions", "TermsVersion", Some("txt")),
  Ided("transaction_linked_threads", "LinkedThread", Some("txm")),
  Ided("recruitment_briefs", "Brief", Some("brf")),
  Ided("recruitment_brief_history", "BriefEvent", Some("aud")),
  Ided("nobody_missed_reviews", "NobodyMissedReview", Some("nmr")),
  Ided("second_look_items", "SecondLookItem", Some("slk")),
  Ided("dynamic_watchlists", "Watchlist", Some("wl")),
  Ided("watchlist_membership_events", "WatchlistEvent", Some("wlh")),
  Ided("watchlist_history", "WatchlistLifecycleEvent", Some("aud")),
]

/// Id columns no foreign key types. See `codegen.IdColumn`.
pub const id_columns = [
  Untyped("regulatory_consents.subject_id", "polymorphic: its kind is in another column"),
  Untyped("regulatory_consents.requested_by_id", "polymorphic: its kind is in another column"),
  Untyped("regulatory_consents.granted_by_id", "polymorphic: its kind is in another column"),
  Untyped("regulatory_consents.declined_by_id", "polymorphic: its kind is in another column"),
  RefersTo("regulatory_consents.granted_by_org_id", "orgs"),
  RefersTo("regulatory_consents.declined_by_org_id", "orgs"),
  Untyped("regulatory_consents.rev_by_id", "the party who moved it, of either kind"),
  Untyped("regulatory_consent_revocations.by_id", "polymorphic: its kind is in another column"),
  RefersTo("regulatory_consent_revocations.by_org_id", "orgs"),
  Untyped("ts_reviewers.created_by_id", "a reviewer, or none for the system"),
  Untyped("ts_reviewers.rev_by_id", "a reviewer"),
  RefersTo("ts_reviewer_history.reviewer_id", "ts_reviewers"),
  Untyped("ts_reviewer_history.by_id", "a reviewer, or none for the system"),
  RefersTo("compliance_context_representations.id", "transaction_representations"),
  RefersTo("compliance_context_representations.review_id", "regulatory_reviews"),
  RefersTo("transaction_documents.transaction_id", "agent_transactions"),
  RefersTo("transaction_documents.supersedes_id", "transaction_documents"),
  Untyped(
    "transaction_documents.owner_id",
    "polymorphic: its kind is in another column",
  ),
  Untyped(
    "transaction_documents.uploaded_by_id",
    "polymorphic: its kind is in another column",
  ),
  RefersTo("transaction_documents.uploaded_by_org_id", "orgs"),
  Untyped(
    "transaction_documents.rev_by_id",
    "a person or none, as the role label says",
  ),
  RefersTo("transaction_document_history.document_id", "transaction_documents"),
  RefersTo("transaction_representations.transaction_id", "agent_transactions"),
  RefersTo("transaction_representations.review_id", "regulatory_reviews"),
  RefersTo(
    "transaction_representations.verified_by_review_id",
    "regulatory_reviews",
  ),
  RefersTo("transaction_representations.rev_by_id", "org_users"),
  RefersTo(
    "transaction_representation_scopes.representation_id",
    "transaction_representations",
  ),
  RefersTo(
    "transaction_representation_history.representation_id",
    "transaction_representations",
  ),
  RefersTo(
    "transaction_representation_history_policy_versions.history_id",
    "transaction_representation_history",
  ),
  RefersTo("transaction_linked_threads.transaction_id", "agent_transactions"),
  RefersTo("transaction_linked_threads.channel_id", "channels"),
  RefersTo("transaction_linked_threads.linked_by_id", "org_users"),
  RefersTo("transaction_linked_threads.linked_by_org_id", "orgs"),
  RefersTo("transaction_terms_versions.transaction_id", "agent_transactions"),
  RefersTo("transaction_keys.transaction_id", "agent_transactions"),
  RefersTo("recruitment_briefs.rev_by_user_id", "org_users"),
  RefersTo("case_approvals.requested_by_user_id", "org_users"),
  RefersTo("case_approvals.resolved_by_user_id", "org_users"),
  RefersTo("case_budget_scenarios.approval_by_user_id", "org_users"),
  RefersTo("case_budget_lines.scenario_id", "case_budget_scenarios"),
  RefersTo("case_budget_lines.case_id", "recruitment_cases"),
  RefersTo("case_budget_fx_assumptions.case_id", "recruitment_cases"),
  RefersTo("case_budget_actuals.case_id", "recruitment_cases"),
  RefersTo("case_budget_fx_assumptions.scenario_id", "case_budget_scenarios"),
  RefersTo("case_budget_actuals.scenario_id", "case_budget_scenarios"),
  RefersTo("case_budget_actuals.line_id", "case_budget_lines"),
  RefersTo("recruitment_brief_history.by_id", "org_users"),
  Untyped(
    "recruitment_briefs.role_id",
    "a role of the club's setup, which has no table here",
  ),
  RefersTo("nobody_missed_reviews.player_id", "players"),
  RefersTo("nobody_missed_review_history.review_id", "nobody_missed_reviews"),
  RefersTo("second_look_items.player_id", "players"),
  RefersTo("dynamic_watchlists.rev_by_user_id", "org_users"),
  RefersTo("watchlist_membership_events.player_id", "players"),
  Untyped(
    "watchlist_membership_events.criterion_id",
    "a criterion's key within its watchlist, not a row id",
  ),
  Untyped(
    "watchlist_criteria.criterion_id",
    "a criterion's key within its watchlist, not a row id",
  ),
  Untyped(
    "watchlist_member_checks.criterion_id",
    "a criterion's key within its watchlist, not a row id",
  ),
  RefersTo("watchlist_criterion_values.watchlist_id", "dynamic_watchlists"),
  RefersTo("watchlist_members.player_id", "players"),
  RefersTo("watchlist_member_checks.watchlist_id", "dynamic_watchlists"),
  RefersTo("watchlist_member_checks.player_id", "players"),
  RefersTo("watchlist_history.by_id", "org_users"),
  RefersTo("case_transaction_handoffs.invited_by_user_id", "org_users"),
  RefersTo("case_transaction_handoffs.transaction_id", "agent_transactions"),
  RefersTo("case_transaction_handoffs.invited_agency_org_id", "orgs"),
  RefersTo("case_transaction_handoffs.invited_agent_user_id", "org_users"),
  RefersTo("compliance_contexts.transaction_id", "agent_transactions"),
  Untyped(
    "compliance_contexts.rev_by_id",
    "the agent or a Trust & Safety reviewer, whichever moved it",
  ),
  RefersTo("compliance_context_parties.id", "transaction_parties"),
  RefersTo("compliance_evaluation_reasons.agent_user_id", "org_users"),
  RefersTo(
    "compliance_evaluation_reason_items.evaluation_id",
    "compliance_evaluations",
  ),
  RefersTo("agent_transactions.link_trial_id", "trials"),
  RefersTo(
    "agent_transactions.compliance_evaluation_id",
    "compliance_evaluations",
  ),
  RefersTo("agent_transactions.link_opportunity_id", "opportunities"),
  Untyped(
    "applications.submitted_by_id",
    "the player or the guardian, as submitted_by_kind says",
  ),
  RefersTo("transaction_parties.transaction_id", "agent_transactions"),
  Untyped("confirmed_by_id", "polymorphic: its kind is in another column"),
  RefersTo("confirmed_by_org_id", "orgs"),
  RefersTo(
    "jurisdiction_policy_rule_overrides.policy_id",
    "jurisdiction_policies",
  ),
  RefersTo(
    "jurisdiction_policy_rule_param_items.policy_id",
    "jurisdiction_policies",
  ),
  Untyped(
    "agent_profiles.rev_by_id",
    "the agent or a Trust & Safety reviewer, whichever moved it",
  ),
  Untyped(
    "agency_affiliations.rev_by_id",
    "a staff member or a Trust & Safety reviewer, whichever moved it",
  ),
  Untyped(
    "provenance_reviewer_id",
    "a Trust & Safety reviewer, who has no table here",
  ),
  RefersTo("provenance_review_id", "regulatory_reviews"),
  RefersTo("detail_review_id", "regulatory_reviews"),
  RefersTo("policy_version_id", "jurisdiction_policies"),
  Untyped(
    "agreement_opportunity_shares.opportunity_id",
    "an opportunity or an open trial, as its via says",
  ),
  Untyped("rule_id", "a rule's id inside its policy version, not a record"),
  Untyped(
    "override_rule_id",
    "a rule's id inside its policy version, not a record",
  ),
  RefersTo("jurisdiction_policy_rule_params.policy_id", "jurisdiction_policies"),
  RefersTo("jurisdiction_policy_rule_sources.policy_id", "jurisdiction_policies"),
  RefersTo("jurisdiction_policy_history.policy_id", "jurisdiction_policies"),
  Untyped("jurisdiction_policy_history.by_id", "a reviewer, or none for the system"),
  RefersTo("jurisdiction_policy_publishers.policy_id", "jurisdiction_policies"),
  Untyped("jurisdiction_policy_publishers.by_id", "a reviewer, or the system"),
  Untyped(
    "jurisdiction_policies.rev_by_id",
    "a Trust & Safety reviewer, who has no table here",
  ),
  Untyped(
    "jurisdiction_policies.proposed_by_id",
    "a Trust & Safety reviewer, who has no table here",
  ),
  Untyped(
    "jurisdiction_policies.approved_by_id",
    "a Trust & Safety reviewer, who has no table here",
  ),
  RefersTo("regulatory_reviews.subject_user_id", "org_users"),
  RefersTo("regulatory_reviews.subject_player_id", "players"),
  Untyped("subject_context_id", "its table is not ported yet"),
  Untyped("subject_transaction_id", "its table is not ported yet"),
  Untyped("subject_representation_id", "its table is not ported yet"),
  Untyped("snapshot_evaluation_id", "its table is not ported yet"),
  Untyped("started_by_id", "a Trust & Safety reviewer, who has no table here"),
  Untyped(
    "decision_reviewer_id",
    "a Trust & Safety reviewer, who has no table here",
  ),
  Untyped(
    "regulatory_reviews.rev_by_id",
    "whoever moved it: a staff member or a Trust & Safety reviewer",
  ),
  RefersTo("regulatory_review_reasons.agent_user_id", "org_users"),
  RefersTo("by_org_id", "orgs"),
  RefersTo("regulatory_review_reasons.review_id", "regulatory_reviews"),
  RefersTo("regulatory_review_history.review_id", "regulatory_reviews"),
  RefersTo("regulatory_review_policy_versions.review_id", "regulatory_reviews"),
  Untyped("requested_by_id", "polymorphic: its kind is in another column"),
  RefersTo("org_agency_jurisdictions.org_id", "orgs"),
  RefersTo("player_id", "players"),
  RefersTo("target_player_id", "players"),
  RefersTo("recipient_player_id", "players"),
  RefersTo("context_player_id", "players"),
  RefersTo("guardian_id", "guardians"),
  RefersTo("recipient_guardian_id", "guardians"),
  RefersTo("guardian_approved_id", "guardians"),
  RefersTo("context_channel_id", "channels"),
  RefersTo("contact_channel_id", "channels"),
  RefersTo("context_request_id", "recruitment_requests"),
  RefersTo("notification_id", "notifications"),
  RefersTo("detail_dispatch_id", "dispatches"),
  RefersTo("detail_delivery_id", "webhook_deliveries"),
  RefersTo("detail_endpoint_id", "webhook_endpoints"),
  RefersTo("detail_root_request_id", "ver_root_requests"),
  RefersTo("detail_org_id", "orgs"),
  RefersTo("detail_claim_id", "ver_claims"),
  RefersTo("verified_clip_attendance_id", "player_attendance"),
  RefersTo("message_attachments.media_id", "player_media"),
  RefersTo("case_tasks.assignee_user_id", "org_users"),
  RefersTo("case_tasks.created_by_user_id", "org_users"),
  RefersTo("recruitment_cases.room_opened_by_user_id", "org_users"),
  RefersTo("room_comments.reply_to_id", "room_comments"),
  RefersTo("room_comments.deleted_by_user_id", "org_users"),
  RefersTo("room_comment_mentions.user_id", "org_users"),
  RefersTo("room_decisions.by_user_id", "org_users"),
  RefersTo("room_decisions.supersedes_id", "room_decisions"),
  RefersTo("room_decisions.superseded_by_id", "room_decisions"),
  RefersTo("room_decisions.supersession_of_id", "room_decisions"),
  RefersTo("room_decisions.snapshot_id", "room_snapshots"),
  RefersTo("room_evidence_states.by_user_id", "org_users"),
  Untyped(
    "case_tasks.linked_resource_id",
    "polymorphic: its kind is in another column",
  ),
  Untyped(
    "recruitment_cases.room_source_ref_id",
    "polymorphic: the source context says whose id it is",
  ),
  Untyped(
    "recruitment_cases.room_reopened_source_ref_id",
    "polymorphic: the source context says whose id it is",
  ),
  Untyped(
    "recruitment_cases.room_rev_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "recruitment_cases.room_reopened_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped("vacancy_id", "its table is not ported yet"),
  Untyped("links_signing_id", "its table is not ported yet"),
  Untyped(
    "draft_id",
    "the draft a decision was finalised from, which is then discarded",
  ),
  Untyped("room_evidence_states.evidence_id", "its table is not ported yet"),
  Untyped("assessments.template_id", "its table is not ported yet"),
  Untyped(
    "calibration_sessions.template_id",
    "assessment_templates has no id type yet",
  ),
  RefersTo("calibration_sessions.media_id", "player_media"),
  RefersTo("calibration_submissions.session_id", "calibration_sessions"),
  RefersTo("calibration_submissions.user_id", "org_users"),
  RefersTo("calibration_ratings.session_id", "calibration_sessions"),
  RefersTo("calibration_ratings.user_id", "org_users"),
  RefersTo("calibration_participants.session_id", "calibration_sessions"),
  RefersTo("calibration_notes.session_id", "calibration_sessions"),
  RefersTo("coverage_assignments.assessment_id", "assessments"),
  Untyped("context_trial_session_id", "its table is not ported yet"),
  Untyped("evidence.source_id", "polymorphic: its kind is in another column"),
  Untyped(
    "evidence.reviewer_id",
    "a reviewer of any kind: staff, a coach or Trust & Safety",
  ),
  RefersTo("signings.first_qualifying_ledger_id", "ledger"),
  RefersTo("ver_evidence.signing_package_id", "signing_packages"),
  RefersTo("signing_packages.player_id", "players"),
  RefersTo("signing_packages.transaction_id", "agent_transactions"),
  RefersTo("signing_packages.current_revision_id", "signing_revisions"),
  Untyped(
    "signing_packages.rev_by_user_id",
    "may be the recipient who acted (a player or guardian) or a Trust & Safety reviewer, not staff",
  ),
  Untyped(
    "signing_packages.voided_by_id",
    "a staff member or a Trust & Safety reviewer, as voided_by_kind says",
  ),
  RefersTo("signing_revisions.supersedes_revision_id", "signing_revisions"),
  RefersTo("signing_revisions.superseded_by_revision_id", "signing_revisions"),
  RefersTo("signing_documents.evidence_id", "ver_evidence"),
  Untyped(
    "signing_revision_parties.for_entity_id",
    "the player, guardian or organisation, as party_type says",
  ),
  RefersTo("signing_revision_parties.for_player_id", "players"),
  Untyped(
    "signing_revision_parties.completed_by_id",
    "polymorphic: its kind is in another column",
  ),
  Untyped(
    "signing_revision_parties.evidence_ref_id",
    "an acknowledgment's own id, which has no table",
  ),
  RefersTo("signing_revision_parties.evidence_revision_id", "signing_revisions"),
  Untyped(
    "signing_revision_parties.evidence_actor_id",
    "polymorphic: its kind is in another column",
  ),
  Untyped(
    "idempotency_keys.owner_id",
    "polymorphic: owner_table says whose id it is",
  ),
  Untyped("offer_revision_id", "its table is not ported yet"),
  RefersTo("recruitment_offers.decision_id", "room_decisions"),
  RefersTo("recruitment_offers.rev_by_user_id", "org_users"),
  RefersTo(
    "recruitment_offers.agent_share_agreement_id",
    "representation_agreements",
  ),
  Untyped(
    "recruitment_offers.agent_share_by_id",
    "the client who shared it (agent_share_by_kind)",
  ),
  RefersTo("offer_revisions.rev_by_user_id", "org_users"),
  Untyped(
    "offer_revisions.readiness_transaction_id",
    "its table is not ported yet",
  ),
  RefersTo("offer_revision_documents.evidence_id", "ver_evidence"),
  RefersTo("offer_responses.for_player_id", "players"),
  Untyped(
    "offer_read_receipts.viewer_id",
    "polymorphic: its kind is in another column",
  ),
  RefersTo("case_decision_drafts.by_user_id", "org_users"),
  RefersTo("case_decision_drafts.updated_by_user_id", "org_users"),
  RefersTo("room_decision_assessment_ids.assessment_id", "assessments"),
  RefersTo("case_decision_draft_reason_codes.case_id", "recruitment_cases"),
  RefersTo("case_decision_draft_evidence_refs.case_id", "recruitment_cases"),
  Untyped("transaction_id", "its table is not ported yet"),
  Untyped("document_evidence_id", "its table is not ported yet"),
  Untyped("executed_document_evidence_id", "its table is not ported yet"),
  Untyped(
    "representation_agreements.client_id",
    "polymorphic: its kind is in another column",
  ),
  RefersTo("dispute_review_id", "regulatory_reviews"),
  Untyped(
    "representation_agreements.rev_by_id",
    "the agent or the client, whichever moved it",
  ),
  RefersTo("confirmed_by_player_id", "players"),
  Untyped("box_sessions.assignment_id", "its table is not ported yet"),
  Untyped("challenge_entry_id", "its table is not ported yet"),
  Untyped(
    "provider_id",
    "an entry of the Box Cam provider registry, not a record",
  ),
  Untyped(
    "protocol_id",
    "an entry of the Combine protocol registry, not a record",
  ),
  Untyped(
    "clip_media_id",
    "a Box Cam clip, which Box Cam's own service will hold",
  ),
  Untyped("cv_provider_session_id", "chosen by the analysis provider"),
  Untyped(
    "box_cam_cv_results.provider_session_id",
    "chosen by the analysis provider",
  ),
  RefersTo("combine_attempts.request_id", "combine_requests"),
  RefersTo("box_session_id", "box_sessions"),
  Untyped(
    "trial_schedule_revisions.proposed_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_schedule_revisions.proposed_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_schedule_revisions.confirmed_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_schedule_revisions.confirmed_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_history.by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_history.by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_day_consents.by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_day_consents.by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_attendance.recorded_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_attendance.recorded_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_session_evidence.linked_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_session_evidence.linked_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_session_evidence.removed_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_session_evidence.removed_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trial_day_checkins.by_user_id",
    "the staff member as recorded; the row outlives a removed member",
  ),
  RefersTo("trial_revision_sessions.id", "trial_schedule_sessions"),
  Untyped("assessment_templates.id", "a template's id, shared by its versions"),
  Untyped(
    "assessment_template_attributes.template_id",
    "a template's id, shared by its versions",
  ),
  RefersTo("assessment_rating_refs.assessment_id", "assessments"),
  Untyped("attr_id", "an attribute's id within its template version"),
  Untyped("assessment_rating_refs.segment_id", "its table is not ported yet"),
  Untyped(
    "assessment_rating_refs.trial_session_id",
    "a reference as the rating cites it, checked against the trial when written",
  ),
  RefersTo("trial_attendance.session_id", "trial_schedule_sessions"),
  RefersTo("trial_session_evidence.session_id", "trial_schedule_sessions"),
  RefersTo("trial_session_evidence.trial_id", "trials"),
  RefersTo("trial_revision_sessions.trial_id", "trials"),
  Untyped(
    "trials.schedule_proposed_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.schedule_proposed_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.schedule_confirmed_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.schedule_confirmed_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.schedule_declined_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.schedule_declined_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.completion_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.completion_by_actor_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "trials.rev_by_user_id",
    "may be the recipient who acted (a player or guardian), not staff",
  ),
  Untyped(
    "box_cam_prefs.updated_by_id",
    "the player or their guardian, whichever changed them",
  ),
  Untyped("follow_up_id", "its table is not ported yet"),
  RefersTo("trial_id", "trials"),
  RefersTo("evidence_media.media_id", "player_media"),
  Untyped(
    "evidence_suggestion_records.record_id",
    "a clip, an assessment or an evidence record, by rule",
  ),
  Untyped("subject_id", "polymorphic: its kind is in another column"),
  Untyped("sender_person_id", "polymorphic: its kind is in another column"),
  Untyped("audience_id", "polymorphic: its kind is in another column"),
  Untyped("ref_id", "polymorphic: its kind is in another column"),
  Untyped("by_id", "polymorphic: its kind is in another column"),
  Untyped("actor_id", "polymorphic: its kind is in another column"),
  Untyped("authority_id", "polymorphic: its kind is in another column"),
  Untyped("verified_by_id", "polymorphic: its kind is in another column"),
  Untyped("revoked_by_id", "polymorphic: its kind is in another column"),
  Untyped("started_by_id", "polymorphic: its kind is in another column"),
  Untyped("supplied_by_id", "polymorphic: its kind is in another column"),
  Untyped(
    "transition_case_pack_items.item_id",
    "polymorphic: its kind is in another column",
  ),
  Untyped("resolved_by_id", "a Trust & Safety reviewer, who has no table here"),
  Untyped("decided_by_id", "a Trust & Safety reviewer, who has no table here"),
  Untyped("pair_id", "links a claim pair; no table of its own"),
  Untyped(
    "ver_events.request_id",
    "the HTTP request that caused the event, not a record",
  ),
  Untyped(
    "webhook_deliveries.event_id",
    "the event's own id, as the subscriber receives it",
  ),
  Untyped("provider_message_id", "chosen by the delivery provider"),
  Untyped("callback_id", "chosen by the delivery provider"),
  Untyped("client_msg_id", "chosen by the client, for idempotency"),
  Untyped("external_id", "another system's id"),
  Untyped("federation_registration_id", "a federation's id"),
  Untyped("context_trial_id", "its table is not ported yet"),
  Untyped("detail_trial_id", "its table is not ported yet"),
  Untyped("drill_id", "its table is not ported yet"),
  Untyped("detail_drill_id", "its table is not ported yet"),
  Untyped("session_id", "its table is not ported yet"),
  Untyped("detail_session_id", "its table is not ported yet"),
  Untyped("review_id", "its table is not ported yet"),
  Untyped("representation_id", "its table is not ported yet"),
  RefersTo("recruitment_requests.contact_id", "recruitment_contacts"),
  RefersTo("routing_agent_agreement_id", "representation_agreements"),
  RefersTo("contact_history.by_user_id", "org_users"),
  RefersTo("recruitment_contacts.rev_by_user_id", "org_users"),
  Untyped(
    "recruitment_contacts.email_copy_outbox_id",
    "the mailer's outbox record, written after commit",
  ),
  Untyped("message_attachments.report_id", "its table is not ported yet"),
  Untyped("ver_evidence.media_id", "its table is not ported yet"),
  Untyped("detail_media_id", "its table is not ported yet"),
  Untyped("detail_assignment_id", "its table is not ported yet"),
  Untyped("detail_challenge_id", "its table is not ported yet"),
  Untyped("detail_attempt_id", "its table is not ported yet"),
  RefersTo("detail_share_id", "agreement_opportunity_shares"),
  Untyped("detail_dispute_id", "its table is not ported yet"),
  Untyped("detail_request_id", "its table is not ported yet"),
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
  case argv.load().arguments {
    ["sql-check", ..flags] -> check_sql(list.contains(flags, "--verbose"))
    [out, ..] -> generate(out)
    [] -> generate("src")
  }
}

fn generate(out: String) -> Nil {
  let schema = schema()
  let _ =
    simplifile.delete_all([out <> "/scoutbox/rows", out <> "/scoutbox/vocab"])
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/rows")
  let assert Ok(_) = simplifile.create_directory_all(out <> "/scoutbox/vocab")
  list.each(codegen.generate(schema, shared, tables, ided:, id_columns:), fn(g) {
    let path = out <> "/" <> g.module <> ".gleam"
    let assert Ok(_) = simplifile.write(path, g.source)
    io.println("wrote " <> path)
  })
}

fn check_sql(verbose: Bool) -> Nil {
  let assert Ok(files) = simplifile.get_files("src")
  let sources =
    files
    |> list.filter(string.ends_with(_, ".gleam"))
    |> list.sort(string.compare)
    |> list.map(fn(f) {
      let assert Ok(source) = simplifile.read(f)
      #(f, source)
    })
  let report = case sql_check.check(sources, schema()) {
    Ok(report) -> report
    Error(file) -> panic as { "sql-check: glance can't parse " <> file }
  }
  case verbose {
    True -> {
      list.each(report.unresolved, fn(u) {
        io.println(where(u.0) <> ": not spelt out: " <> u.1)
      })
      list.each(report.untyped, fn(u) {
        io.println(where(u.0) <> ": untyped: " <> u.1)
      })
    }
    False -> Nil
  }
  list.each(report.problems, fn(p) {
    io.println(where(p.site) <> ": " <> p.message)
    io.println("  " <> string.replace(p.sql, "\n", "\n  "))
  })
  io.println(
    "sql-check: "
    <> int.to_string(report.checked)
    <> " queries prepared against the schema, "
    <> int.to_string(report.tied)
    <> " of their "
    <> int.to_string(report.arguments)
    <> " arguments compared with the column they bind; "
    <> int.to_string(list.length(report.unresolved))
    <> " queries not spelt out in the source, "
    <> int.to_string(list.length(report.untyped))
    <> " arguments bound as plain text to an id or vocabulary column"
    <> case verbose {
      True -> ""
      False -> " (--verbose lists them)"
    },
  )
  case report.problems {
    [] -> Nil
    problems ->
      panic as {
        "sql-check: " <> int.to_string(list.length(problems)) <> " problems"
      }
  }
}

fn where(site: sql_source.Site) -> String {
  site.file
  <> ":"
  <> int.to_string(site.line)
  <> case site.via {
    Some(line) -> " (as called at line " <> int.to_string(line) <> ")"
    None -> ""
  }
}
