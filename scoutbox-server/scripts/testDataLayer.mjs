// Unit tests for the relational data layer (repositories/): the table
// migration runner, the read-only views and the store's tables. Everything runs on
// an in-memory or throwaway SQLite database. Run with: npm test
import { SCOUTING_ASSESSMENTS_TABLES } from '../repositories/scoutingAssessments.mjs';
import { CLUB_SETUP_TABLES } from '../repositories/clubSetup.mjs';
import { OPPORTUNITIES_CAMPAIGNS_TABLES } from '../repositories/opportunitiesCampaigns.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction, dataSchemaReport } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { RECRUITMENT_TABLES } from '../repositories/recruitment.mjs';
import { RECRUITMENT_CASES_TABLES } from '../repositories/recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_TABLES } from '../repositories/recruitmentContactsOffers.mjs';
import { SIGNINGS_FOLLOWUPS_TABLES } from '../repositories/signingsFollowUps.mjs';
import { openStore } from '../store.mjs';
import { writeFixture, readRecords, openLayer } from './dataLayerFixture.mjs';
import { hasBlobTable } from './coreIdentityTestFixtures.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const fresh = () => { const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;'); return s; };
let counter = 1000;
const ORG_O = { id: 'o', name: 'Org O', type: 'club', level: 'pro', plan: 'Pro' };
const nextId = (p) => `${p}-${++counter}`;

// ------------------------------------------------------- migration runner
test('migrations: each step runs once, in id order, and is recorded in the database', () => {
  const s = fresh();
  const seen = [];
  const steps = [
    { id: '0002_b', note: 'b', up: () => seen.push('b') },
    { id: '0001_a', note: 'a', up: (db) => { seen.push('a'); db.exec('CREATE TABLE a (x)'); } },
  ];
  const first = runDataMigrations(s, steps);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(first, { ran: ['0001_a', '0002_b'], applied: 2, known: 2 });
  const second = runDataMigrations(s, steps);
  assert.deepEqual(second.ran, []);
  assert.equal(seen.length, 2);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, 2);
});
test('migrations: a failing step rolls back and aborts without recording itself', () => {
  const s = fresh();
  const steps = [{ id: '0001_bad', note: 'bad', up: (db) => { db.exec('CREATE TABLE half (x)'); throw new Error('boom'); } }];
  assert.throws(() => runDataMigrations(s, steps), /data migration 0001_bad failed: boom/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half'").get().n, 0);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, 0);
});
test('transaction: rolls back on throw, commits otherwise', () => {
  const s = fresh();
  s.exec('CREATE TABLE t (x)');
  assert.throws(() => transaction(s, () => { s.exec("INSERT INTO t VALUES (1)"); throw new Error('no'); }), /no/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(transaction(s, () => { s.exec("INSERT INTO t VALUES (1)"); return 'ok'; }), 'ok');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
});
test('schema report: names tables and counts, never rows', () => {
  const s = fresh();
  runDataMigrations(s, DATA_MIGRATIONS);
  const report = dataSchemaReport(s, DATA_MIGRATIONS);
  // The table list grows with every migration (0001 org_users; 0002 the five
  // core identity tables, live one domain at a time; 0006 the media-deletion
  // queue; 0007 the twelve player sub-record tables; 0013 the eight audit tables and their two child tables; 0015 the sixteen recruitment tables; …; 0026 the fifteen agent core tables); the report must list
  // exactly what exists.
  assert.deepEqual(report, {
    engine: 'sqlite', migrationsApplied: DATA_MIGRATIONS.length, migrationsKnown: DATA_MIGRATIONS.length,
    migrations: ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups', '0019_scouting_evidence', '0020_scouting_assessments', '0021_club_setup', '0022_opportunities_campaigns', '0023_verification', '0024_passport', '0025_transitions_vouches', '0026_agent_core', '0027_compliance_policies', '0028_compliance_records', '0029_agent_transactions', '0030_development', '0031_box_cam', '0032_discovery', '0033_insight_coverage', '0034_integrations', '0035_enterprise', '0036_groups', '0037_grassroots', '0038_operations', '0039_retire_blob', '0040_match_facts'],
    tables: ['agency_affiliation_history', 'agency_affiliation_history_tiers', 'agency_affiliation_tiers', 'agency_affiliations', 'agent_profile_facets', 'agent_profile_history', 'agent_profile_jurisdictions', 'agent_profiles', 'agent_transaction_jurisdictions', 'agent_transactions', 'agreement_history', 'agreement_opportunity_shares', 'agreement_policy_versions', 'agreement_scopes', 'api_key_scopes', 'api_keys', 'application_history', 'application_suitability', 'applications', 'assessment_history', 'assessment_rating_refs', 'assessment_ratings', 'assessment_template_attributes', 'assessment_templates', 'assessments', 'blocks', 'box_assignments', 'box_cam_cv_result_codes', 'box_cam_cv_result_trace', 'box_cam_cv_results', 'box_cam_disputes', 'box_cam_prefs', 'box_challenge_entries', 'box_challenges', 'box_session_integrity_events', 'box_session_observations', 'box_session_reasons', 'box_sessions', 'calibration_notes', 'calibration_participants', 'calibration_ratings', 'calibration_sessions', 'calibration_submissions', 'campaign_attempt_issues', 'campaign_attempts', 'campaign_drills', 'campaign_rubric', 'campaign_submissions', 'campaigns', 'case_approvals', 'case_assignments', 'case_budget_actuals', 'case_budget_fx_assumptions', 'case_budget_lines', 'case_budget_scenarios', 'case_decision_draft_evidence_refs', 'case_decision_draft_reason_codes', 'case_decision_drafts', 'case_history', 'case_request_links', 'case_room_tags', 'case_tasks', 'case_transaction_handoffs', 'case_trial_links', 'channels', 'coach_affiliation_history', 'coach_affiliations', 'combine_attempt_calibration_checks', 'combine_attempt_reasons', 'combine_attempts', 'combine_request_protocols', 'combine_requests', 'compliance_context_history', 'compliance_context_history_policy_versions', 'compliance_context_jurisdictions', 'compliance_context_parties', 'compliance_context_representations', 'compliance_context_resolved_facts', 'compliance_contexts', 'compliance_evaluation_consents_outstanding', 'compliance_evaluation_policy_versions', 'compliance_evaluation_reason_items', 'compliance_evaluation_reasons', 'compliance_evaluation_snapshot_parties', 'compliance_evaluation_snapshot_representations', 'compliance_evaluations', 'contact_attempts', 'contact_history', 'coverage_assignment_targets', 'coverage_assignment_warnings', 'coverage_assignments', 'coverage_plans', 'delivery_callbacks_seen', 'delivery_centre', 'delivery_fail_injections', 'dev_objective_item_evidence', 'dev_objective_item_exercises', 'dev_objective_items', 'dev_objective_progress', 'dev_objective_reassessment_evidence', 'dev_objective_reassessments', 'dev_objective_shares', 'dev_objectives', 'development_actions', 'development_evidence_links', 'development_goals', 'development_history', 'development_plan_shares', 'development_plans', 'development_review_snapshot_refs', 'development_review_snapshots', 'development_reviews', 'dispatch_attempts', 'dispatches', 'drill_guidance', 'dynamic_watchlists', 'email_challenges', 'evidence', 'evidence_disputes', 'evidence_history', 'evidence_media', 'evidence_suggestion_records', 'evidence_suggestions', 'exposure_events', 'fixtures', 'follow_ups', 'friendlies', 'friendly_responses', 'group_grant_recipients', 'group_grants', 'group_members', 'group_pending_invites', 'group_programmes', 'group_shared_templates', 'groups', 'guardian_children', 'guardians', 'idempotency_keys', 'identity_reviews', 'idv_queue', 'import_batch_columns', 'import_batch_created_prospects', 'import_batch_history', 'import_batch_row_errors', 'import_batch_rows', 'import_batches', 'invoices', 'jurisdiction_policies', 'jurisdiction_policy_history', 'jurisdiction_policy_publishers', 'jurisdiction_policy_rule_overrides', 'jurisdiction_policy_rule_param_items', 'jurisdiction_policy_rule_params', 'jurisdiction_policy_rule_sources', 'jurisdiction_policy_rules', 'ledger', 'ledger_protocols', 'matchday_players', 'matchdays', 'media_deletions', 'message_attachments', 'messages', 'moderation_flags', 'moderation_log', 'nobody_missed_review_history', 'nobody_missed_reviews', 'notification_pref_categories', 'notification_prefs', 'notifications', 'offer_history', 'offer_keys', 'offer_read_receipts', 'offer_responses', 'offer_revision_documents', 'offer_revisions', 'open_trial_positions', 'open_trial_registrations', 'open_trials', 'opportunities', 'opportunity_texts', 'opportunity_training_slots', 'ops_events', 'org_agency_jurisdictions', 'org_agency_settings', 'org_federation_checks', 'org_invites', 'org_looking_for', 'org_notes', 'org_shadow_players', 'org_squad_members', 'org_tactical_role_criteria', 'org_tactical_roles', 'org_tactical_setups', 'org_tactical_windows', 'org_user_recovery_codes', 'org_users', 'org_verified_domains', 'orgs', 'outbox', 'outcome_report_confirmations', 'outcome_reports', 'pairing_codes', 'passport_achievements', 'passport_career_entries', 'passport_corrections', 'passport_position_history', 'passport_position_history_positions', 'passport_pref_positions', 'passport_prefs', 'passport_public_selections', 'passport_shares', 'player_activity_log', 'player_attendance', 'player_badges', 'player_drill_results', 'player_drills', 'player_external_ids', 'player_match_fact_combine', 'player_match_fact_positions', 'player_match_facts', 'player_match_facts_dirty', 'player_media', 'player_media_tags', 'player_medical_records', 'player_pref_slots', 'player_pref_texts', 'player_prefs', 'player_programme_completions', 'player_season_history', 'player_timeline', 'players', 'playlist_segments', 'playlists', 'prospects', 'push_log', 'push_tokens', 'recruitment_brief_history', 'recruitment_brief_values', 'recruitment_briefs', 'recruitment_cases', 'recruitment_contacts', 'recruitment_offers', 'recruitment_requests', 'regulatory_consent_history', 'regulatory_consent_policy_versions', 'regulatory_consent_regarding', 'regulatory_consent_revocations', 'regulatory_consent_rule_ids', 'regulatory_consents', 'regulatory_review_evidence_refs', 'regulatory_review_history', 'regulatory_review_policy_versions', 'regulatory_review_reason_items', 'regulatory_review_reasons', 'regulatory_reviews', 'reports', 'representation_agreements', 'reputation_seed', 'request_trial_slots', 'review_later', 'room_comment_mentions', 'room_comments', 'room_decision_assessment_ids', 'room_decision_evidence_refs', 'room_decision_reason_codes', 'room_decisions', 'room_evidence_states', 'room_snapshot_source_refs', 'room_snapshots', 'saved_searches', 'second_look_item_fingerprints', 'second_look_item_history', 'second_look_item_reasons', 'second_look_items', 'sessions', 'signing_documents', 'signing_history', 'signing_packages', 'signing_parties', 'signing_revision_parties', 'signing_revisions', 'signings', 'source_changes', 'squad_invites', 'sso_configs', 'sso_states', 'support_access_grants', 'support_access_log', 'support_ticket_refs', 'support_ticket_replies', 'support_tickets', 'transaction_document_history', 'transaction_documents', 'transaction_history', 'transaction_history_policy_versions', 'transaction_history_reason_codes', 'transaction_keys', 'transaction_linked_threads', 'transaction_notes', 'transaction_parties', 'transaction_representation_history', 'transaction_representation_history_policy_versions', 'transaction_representation_scopes', 'transaction_representations', 'transaction_terms_versions', 'transition_case_history', 'transition_case_pack_items', 'transition_case_recipients', 'transition_cases', 'trial_attendance', 'trial_day_checkins', 'trial_day_consents', 'trial_day_staff', 'trial_day_status_events', 'trial_history', 'trial_keys', 'trial_reminders', 'trial_reports', 'trial_revision_sessions', 'trial_schedule_revisions', 'trial_schedule_sessions', 'trial_session_evidence', 'trials', 'ts_reviewer_history', 'ts_reviewers', 'upload_session_chunks', 'upload_sessions', 'vacancies', 'ver_admins', 'ver_claim_codes', 'ver_claim_evidence', 'ver_claims', 'ver_conflicts', 'ver_disputes', 'ver_domain_request_codes', 'ver_domain_requests', 'ver_events', 'ver_evidence', 'ver_migrations', 'ver_player_invites', 'ver_references', 'ver_root_request_codes', 'ver_root_requests', 'ver_root_transfers', 'ver_tokens', 'video_segment_labels', 'video_segments', 'vouches', 'watchlist_criteria', 'watchlist_criterion_values', 'watchlist_history', 'watchlist_member_checks', 'watchlist_members', 'watchlist_membership_events', 'webhook_deliveries', 'webhook_delivery_attempts', 'webhook_endpoint_events', 'webhook_endpoints'],
  });
  // There is no in-memory engine to report on: a missing connection is a programming error, not a mode.
  assert.throws(() => dataSchemaReport(null, DATA_MIGRATIONS), /needs a SQLite connection/);
});

// The staff repository's own checks are in scripts/testStaff.mjs (S14f).

test('attachDataLayer: the staff are written through their repository; every table is live', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-layer-'));
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  // Staff are never seeded (S14a: there is no users array to import); they are written through the repository.
  const layer = attachDataLayer({ seed: { orgs: [ORG_O] }, store, nextId });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', rows: 0 });
  layer.users.create({ orgId: 'o', name: 'A', role: 'Scout' });
  assert.equal(layer.users.count(), 1);
  assert.equal(layer.report().domains.users.rows, 1);
  // Every core identity table is live (S0–S4a) and the media-deletion queue exists; there is no shadow to report.
  assert.deepEqual(layer.report().tables, ['agency_affiliation_history', 'agency_affiliation_history_tiers', 'agency_affiliation_tiers', 'agency_affiliations', 'agent_profile_facets', 'agent_profile_history', 'agent_profile_jurisdictions', 'agent_profiles', 'agent_transaction_jurisdictions', 'agent_transactions', 'agreement_history', 'agreement_opportunity_shares', 'agreement_policy_versions', 'agreement_scopes', 'api_key_scopes', 'api_keys', 'application_history', 'application_suitability', 'applications', 'assessment_history', 'assessment_rating_refs', 'assessment_ratings', 'assessment_template_attributes', 'assessment_templates', 'assessments', 'blocks', 'box_assignments', 'box_cam_cv_result_codes', 'box_cam_cv_result_trace', 'box_cam_cv_results', 'box_cam_disputes', 'box_cam_prefs', 'box_challenge_entries', 'box_challenges', 'box_session_integrity_events', 'box_session_observations', 'box_session_reasons', 'box_sessions', 'calibration_notes', 'calibration_participants', 'calibration_ratings', 'calibration_sessions', 'calibration_submissions', 'campaign_attempt_issues', 'campaign_attempts', 'campaign_drills', 'campaign_rubric', 'campaign_submissions', 'campaigns', 'case_approvals', 'case_assignments', 'case_budget_actuals', 'case_budget_fx_assumptions', 'case_budget_lines', 'case_budget_scenarios', 'case_decision_draft_evidence_refs', 'case_decision_draft_reason_codes', 'case_decision_drafts', 'case_history', 'case_request_links', 'case_room_tags', 'case_tasks', 'case_transaction_handoffs', 'case_trial_links', 'channels', 'coach_affiliation_history', 'coach_affiliations', 'combine_attempt_calibration_checks', 'combine_attempt_reasons', 'combine_attempts', 'combine_request_protocols', 'combine_requests', 'compliance_context_history', 'compliance_context_history_policy_versions', 'compliance_context_jurisdictions', 'compliance_context_parties', 'compliance_context_representations', 'compliance_context_resolved_facts', 'compliance_contexts', 'compliance_evaluation_consents_outstanding', 'compliance_evaluation_policy_versions', 'compliance_evaluation_reason_items', 'compliance_evaluation_reasons', 'compliance_evaluation_snapshot_parties', 'compliance_evaluation_snapshot_representations', 'compliance_evaluations', 'contact_attempts', 'contact_history', 'coverage_assignment_targets', 'coverage_assignment_warnings', 'coverage_assignments', 'coverage_plans', 'delivery_callbacks_seen', 'delivery_centre', 'delivery_fail_injections', 'dev_objective_item_evidence', 'dev_objective_item_exercises', 'dev_objective_items', 'dev_objective_progress', 'dev_objective_reassessment_evidence', 'dev_objective_reassessments', 'dev_objective_shares', 'dev_objectives', 'development_actions', 'development_evidence_links', 'development_goals', 'development_history', 'development_plan_shares', 'development_plans', 'development_review_snapshot_refs', 'development_review_snapshots', 'development_reviews', 'dispatch_attempts', 'dispatches', 'drill_guidance', 'dynamic_watchlists', 'email_challenges', 'evidence', 'evidence_disputes', 'evidence_history', 'evidence_media', 'evidence_suggestion_records', 'evidence_suggestions', 'exposure_events', 'fixtures', 'follow_ups', 'friendlies', 'friendly_responses', 'group_grant_recipients', 'group_grants', 'group_members', 'group_pending_invites', 'group_programmes', 'group_shared_templates', 'groups', 'guardian_children', 'guardians', 'idempotency_keys', 'identity_reviews', 'idv_queue', 'import_batch_columns', 'import_batch_created_prospects', 'import_batch_history', 'import_batch_row_errors', 'import_batch_rows', 'import_batches', 'invoices', 'jurisdiction_policies', 'jurisdiction_policy_history', 'jurisdiction_policy_publishers', 'jurisdiction_policy_rule_overrides', 'jurisdiction_policy_rule_param_items', 'jurisdiction_policy_rule_params', 'jurisdiction_policy_rule_sources', 'jurisdiction_policy_rules', 'ledger', 'ledger_protocols', 'matchday_players', 'matchdays', 'media_deletions', 'message_attachments', 'messages', 'moderation_flags', 'moderation_log', 'nobody_missed_review_history', 'nobody_missed_reviews', 'notification_pref_categories', 'notification_prefs', 'notifications', 'offer_history', 'offer_keys', 'offer_read_receipts', 'offer_responses', 'offer_revision_documents', 'offer_revisions', 'open_trial_positions', 'open_trial_registrations', 'open_trials', 'opportunities', 'opportunity_texts', 'opportunity_training_slots', 'ops_events', 'org_agency_jurisdictions', 'org_agency_settings', 'org_federation_checks', 'org_invites', 'org_looking_for', 'org_notes', 'org_shadow_players', 'org_squad_members', 'org_tactical_role_criteria', 'org_tactical_roles', 'org_tactical_setups', 'org_tactical_windows', 'org_user_recovery_codes', 'org_users', 'org_verified_domains', 'orgs', 'outbox', 'outcome_report_confirmations', 'outcome_reports', 'pairing_codes', 'passport_achievements', 'passport_career_entries', 'passport_corrections', 'passport_position_history', 'passport_position_history_positions', 'passport_pref_positions', 'passport_prefs', 'passport_public_selections', 'passport_shares', 'player_activity_log', 'player_attendance', 'player_badges', 'player_drill_results', 'player_drills', 'player_external_ids', 'player_match_fact_combine', 'player_match_fact_positions', 'player_match_facts', 'player_match_facts_dirty', 'player_media', 'player_media_tags', 'player_medical_records', 'player_pref_slots', 'player_pref_texts', 'player_prefs', 'player_programme_completions', 'player_season_history', 'player_timeline', 'players', 'playlist_segments', 'playlists', 'prospects', 'push_log', 'push_tokens', 'recruitment_brief_history', 'recruitment_brief_values', 'recruitment_briefs', 'recruitment_cases', 'recruitment_contacts', 'recruitment_offers', 'recruitment_requests', 'regulatory_consent_history', 'regulatory_consent_policy_versions', 'regulatory_consent_regarding', 'regulatory_consent_revocations', 'regulatory_consent_rule_ids', 'regulatory_consents', 'regulatory_review_evidence_refs', 'regulatory_review_history', 'regulatory_review_policy_versions', 'regulatory_review_reason_items', 'regulatory_review_reasons', 'regulatory_reviews', 'reports', 'representation_agreements', 'reputation_seed', 'request_trial_slots', 'review_later', 'room_comment_mentions', 'room_comments', 'room_decision_assessment_ids', 'room_decision_evidence_refs', 'room_decision_reason_codes', 'room_decisions', 'room_evidence_states', 'room_snapshot_source_refs', 'room_snapshots', 'saved_searches', 'second_look_item_fingerprints', 'second_look_item_history', 'second_look_item_reasons', 'second_look_items', 'sessions', 'signing_documents', 'signing_history', 'signing_packages', 'signing_parties', 'signing_revision_parties', 'signing_revisions', 'signings', 'source_changes', 'squad_invites', 'sso_configs', 'sso_states', 'support_access_grants', 'support_access_log', 'support_ticket_refs', 'support_ticket_replies', 'support_tickets', 'transaction_document_history', 'transaction_documents', 'transaction_history', 'transaction_history_policy_versions', 'transaction_history_reason_codes', 'transaction_keys', 'transaction_linked_threads', 'transaction_notes', 'transaction_parties', 'transaction_representation_history', 'transaction_representation_history_policy_versions', 'transaction_representation_scopes', 'transaction_representations', 'transaction_terms_versions', 'transition_case_history', 'transition_case_pack_items', 'transition_case_recipients', 'transition_cases', 'trial_attendance', 'trial_day_checkins', 'trial_day_consents', 'trial_day_staff', 'trial_day_status_events', 'trial_history', 'trial_keys', 'trial_reminders', 'trial_reports', 'trial_revision_sessions', 'trial_schedule_revisions', 'trial_schedule_sessions', 'trial_session_evidence', 'trials', 'ts_reviewer_history', 'ts_reviewers', 'upload_session_chunks', 'upload_sessions', 'vacancies', 'ver_admins', 'ver_claim_codes', 'ver_claim_evidence', 'ver_claims', 'ver_conflicts', 'ver_disputes', 'ver_domain_request_codes', 'ver_domain_requests', 'ver_events', 'ver_evidence', 'ver_migrations', 'ver_player_invites', 'ver_references', 'ver_root_request_codes', 'ver_root_requests', 'ver_root_transfers', 'ver_tokens', 'video_segment_labels', 'video_segments', 'vouches', 'watchlist_criteria', 'watchlist_criterion_values', 'watchlist_history', 'watchlist_member_checks', 'watchlist_members', 'watchlist_membership_events', 'webhook_deliveries', 'webhook_delivery_attempts', 'webhook_endpoint_events', 'webhook_endpoints'].sort()); // S9d: the fifteen opportunity, application, campaign and preference tables; S9c: the nine club setup tables; S9b: the ten assessment, segment and playlist tables; S9a: the seven evidence, affiliation and invitation tables; S8a: the sixteen request and trial tables; S8b: the twenty-five case and room tables and the shared idempotency_keys; S8c: the ten contact and offer tables
  assert.equal('shadow' in layer.report(), false, 'the projection is retired');
  assert.deepEqual(layer.report().identity, { initState: 'done' });
  assert.deepEqual(layer.report().mediaDeletions, { queued: 0, conflicts: 0 });
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store: the tables read back as the records the server sees, a staff change written through the repository lands in the tables, and the next boot reads exactly that', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-records-'));
  // A server boot: the table exists and holds one row; there is no blob.
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const PLAYER = { id: 'p', name: 'P', dob: '2001-01-01', country: 'GB', medical: { shared: false, records: [], conditionStatus: 'unknown' } };
  const first = attachDataLayer({ seed: { players: [PLAYER], guardians: [], orgs: [ORG_O] }, store: server, nextId });
  const usr1 = first.users.create({ orgId: 'o', name: 'A', role: 'Scout' });
  server.sqlite.close();
  // Read back, the staff rows and the players are the records (S4a).
  const back = readRecords(dir);
  assert.deepEqual(back.users, [{ id: usr1.id, orgId: 'o', name: 'A', role: 'Scout', email: null, ssoSubject: null, createdAt: usr1.createdAt, removedAt: null, removedById: null, provenance: null, mfa: null, deliveryPrefs: { quietStart: null, quietEnd: null, channels: { email: true } } }]);
  assert.deepEqual(back.players, [{ ...PLAYER, city: null, position: null, foot: null, heightCm: null, weightKg: null, squadNumber: null, contractUntil: null, marketValueRange: null, agentName: null, academyPlus: false, firstTeamSeeker: false, availability: 'not_seeking', contractStatus: 'unknown', level: 'amateur', footballCategory: null, identityVerified: false, guardianId: null, createdAt: null, location: null, stats: null, notificationPrefs: null, programme: null, media: [], attendance: [], timeline: [], badges: [], drills: [], drillResults: [], activityLog: [], externalIds: [], seasonHistory: [], password: null }]); // S14h: every field on every record (null or false when unset), the password hash beside it; every list on every record (S5 typed tables)
  assert.deepEqual(back.guardians, []);
  // A new staff member with MFA enabled, and a role change, written through the repository in one unit.
  const L = openLayer(dir);
  try {
    L.unit(() => {
      L.layer.users.create({ id: 'usr-2', orgId: 'o', name: 'B', role: 'Manager', createdAt: 2 });
      L.layer.users.startMfa('usr-2', 'SECRETSECRETSECRET'); L.layer.users.enableMfa('usr-2', { at: 3, recoveryHashes: ['a'.repeat(64)] });
      L.layer.users.update(usr1.id, (d) => { d.role = 'Director'; });
    });
    assert.equal(hasBlobTable(L.sqlite), false, 'rewritten in S14a: every collection is a table; there is no blob');
    assert.deepEqual(L.sqlite.prepare('SELECT id, role, mfa_secret, mfa_enabled_at FROM org_users ORDER BY rowid').all().map((r) => ({ ...r })),
      [{ id: usr1.id, role: 'Director', mfa_secret: null, mfa_enabled_at: null }, { id: 'usr-2', role: 'Manager', mfa_secret: 'SECRETSECRETSECRET', mfa_enabled_at: 3 }]);
    assert.deepEqual(L.sqlite.prepare('SELECT org_user_id, code_hash FROM org_user_recovery_codes').all().map((r) => ({ ...r })), [{ org_user_id: 'usr-2', code_hash: 'a'.repeat(64) }]);
  } finally { L.close(); }
  // And the next server boot reads exactly that.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ store: again, nextId });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', rows: 2 });
  assert.equal(layer.users.byId(usr1.id).role, 'Director');
  assert.deepEqual(layer.users.byId('usr-2').mfa, { enabledAt: 3 }, 'the record carries the MFA state, never the secret');
  assert.equal(layer.users.mfaSecretOf('usr-2'), 'SECRETSECRETSECRET');
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 1, guardians: 0, links: 0, imported: 0 }, 'the player row attached from the table');
  assert.equal(layer.players.byId('p').name, 'P');
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store: a fixture written into a new directory is written into the tables, and the first boot attaches to them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fixture-'));
  writeFixture(dir, { players: [], guardians: [], orgs: [ORG_O], users: [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }] });
  { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
    assert.equal(hasBlobTable(s), false, 'no blob: every collection of the fixture has a table');
    assert.equal(s.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 1);
    s.close(); }
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ store: server, nextId });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', rows: 1 });
  assert.equal(layer.users.byId('usr-1').name, 'A');
  // A written fixture is never a first installation again: the identity tables are attached, not seeded.
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 0, guardians: 0, links: 0, imported: 0 });
  assert.equal(layer.report().identity.initState, 'done');
  server.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} data-layer checks passed`);
