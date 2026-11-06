// The target schema in docs/architecture/sql/*.sql must stay executable: this
// loads every file, in order, into an in-memory SQLite database with foreign
// keys on, then checks that every FOREIGN KEY names an existing table and that
// the identity section of 01_identity.sql matches migrations 0001–0003 column for
// column (the migrations copy that DDL; the two must not drift).
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_DIR = path.join(ROOT, 'docs', 'architecture', 'sql');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
const docs = new DatabaseSync(':memory:');
docs.exec('PRAGMA foreign_keys = ON;');

for (const f of files) {
  test(`${f} executes`, () => {
    try { docs.exec(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')); } catch (err) { throw new Error(`${f}: ${err.message}`); }
  });
}

const tables = docs.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
// Every table is STRICT: org_users was created non-STRICT by migration 0001 and
// rebuilt STRICT (with the orgs foreign key and json_valid checks) at S3.
test(`the target schema defines ${tables.length} tables, all STRICT`, () => {
  assert.ok(tables.length >= 100, `expected the full model, found ${tables.length}`);
  for (const t of tables) {
    const sql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/i, `${t} is STRICT`);
  }
});
test('every foreign key points at a table the schema defines', () => {
  const missing = [];
  for (const t of tables) {
    for (const fk of docs.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
      if (!tables.includes(fk.table)) missing.push(`${t}.${fk.from} -> ${fk.table}`);
    }
  }
  assert.deepEqual(missing, []);
});
test('every table has a primary key', () => {
  const without = tables.filter((t) => !docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.pk > 0));
  assert.deepEqual(without, []);
});
test('every index references an existing table', () => {
  const bad = docs.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().filter((i) => !tables.includes(i.tbl_name));
  assert.deepEqual(bad, []);
});

// The registered migrations that implement steps S0–S4a must match the
// documented DDL column for column and index for index. They are applied by
// the real runner (which owns `meta` and `data_migrations`), exactly as a boot
// applies them on a genuinely new database (migration 0005 then finds no saved
// blobs: a first installation, nothing to import), so a migration that needs
// the runner's bookkeeping tables is exercised the way it runs in production.
// players and guardians carry the documented transitional `facets_json`
// column (S4a); media_deletions (0006) is documented in 08; the twelve
// player sub-record tables (0007, S5) are in 01 with their position and
// extra_json columns.
test('the registered migrations 0001–0018 match 01_identity.sql (identity, facets_json and the twelve player sub-record tables included), 08 (media_deletions) and 03 (email_challenges, pairing_codes, notifications, notification_prefs, notification_pref_categories, dispatches, dispatch_attempts, outbox, push_log, push_tokens, channels, messages, message_attachments, and the eight S6b audit tables: blocks, reports, moderation_log, org_notes, ledger, ops_events, source_changes, idv_queue) and 02 (the sixteen S8a-core definitions: recruitment_requests, request_trial_slots, trials and its eleven child tables, idempotency_keys; channels rebuilt with the request key; the twenty-five S8b definitions: recruitment_cases and its fifteen owned child tables, the four room tables and their five child tables; the two parents rebuilt with the case key and idempotency_keys with the broadened owner CHECK) column for column', () => {
  const mig = new DatabaseSync(':memory:');
  mig.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(mig, DATA_MIGRATIONS, { now: Date.UTC(2026, 9, 11, 12), log: () => {} });
  assert.equal(mig.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, DATA_MIGRATIONS.length);
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups', '0019_scouting_evidence', '0020_scouting_assessments', '0021_club_setup', '0022_opportunities_campaigns', '0023_verification', '0024_passport', '0025_transitions_vouches', '0026_agent_core', '0027_compliance_policies', '0028_compliance_records', '0029_agent_transactions', '0030_development', '0031_box_cam', '0032_discovery', '0033_insight_coverage', '0034_integrations', '0035_enterprise', '0036_groups', '0037_grassroots']);
  const AUDIT_TABLES = ['blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue'];
  const S5_TABLES = ['player_season_history', 'player_badges', 'player_drills', 'player_attendance', 'player_timeline', 'player_media', 'player_media_tags', 'player_medical_records', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_programme_completions'];
  const S8A_TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_revision_sessions', 'trial_attendance', 'trial_keys', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
  const S8B_TABLES = ['recruitment_cases', 'case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals', 'room_comments', 'room_comment_mentions', 'room_snapshots', 'room_snapshot_source_refs', 'room_decisions', 'room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids', 'room_evidence_states'];
  const S8C_TABLES = ['recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history', 'offer_keys'];
  const S8D_TABLES = ['signing_packages', 'signing_revisions', 'signing_documents', 'signing_revision_parties', 'signing_history', 'signings', 'signing_parties', 'follow_ups', 'outcome_reports', 'outcome_report_confirmations'];
  const S9A_TABLES = ['evidence', 'evidence_media', 'evidence_disputes', 'evidence_history', 'coach_affiliations', 'coach_affiliation_history', 'squad_invites'];
  const S9C_TABLES = ['org_tactical_setups', 'org_tactical_roles', 'org_tactical_role_criteria', 'org_tactical_windows', 'org_squad_members', 'org_shadow_players', 'org_looking_for', 'org_federation_checks', 'vacancies'];
  const S10A_TABLES = ['ver_root_requests', 'ver_root_request_codes', 'ver_claims', 'ver_claim_codes', 'ver_evidence', 'ver_claim_evidence', 'ver_events', 'ver_tokens', 'ver_admins', 'ver_root_transfers', 'ver_disputes', 'ver_references', 'ver_player_invites', 'ver_conflicts', 'ver_domain_requests', 'ver_domain_request_codes', 'org_verified_domains', 'ver_migrations'];
  const S10C_TABLES = ['transition_cases', 'transition_case_pack_items', 'transition_case_recipients', 'transition_case_history', 'vouches'];
  const S11A_TABLES = ['agent_profiles', 'agent_profile_jurisdictions', 'agent_profile_facets', 'agent_profile_history', 'agency_affiliations', 'agency_affiliation_tiers', 'agency_affiliation_history', 'agency_affiliation_history_tiers', 'representation_agreements', 'agreement_scopes', 'agreement_policy_versions', 'agreement_opportunity_shares', 'agreement_history', 'org_agency_settings', 'org_agency_jurisdictions'];
  const S11B1_TABLES = ['ts_reviewers', 'ts_reviewer_history', 'jurisdiction_policies', 'jurisdiction_policy_publishers', 'jurisdiction_policy_rules', 'jurisdiction_policy_rule_sources', 'jurisdiction_policy_rule_overrides', 'jurisdiction_policy_rule_params', 'jurisdiction_policy_rule_param_items', 'jurisdiction_policy_history'];
  const S12A_TABLES = ['dev_objectives', 'dev_objective_items', 'dev_objective_item_exercises', 'dev_objective_item_evidence', 'dev_objective_progress', 'dev_objective_shares', 'dev_objective_reassessments', 'dev_objective_reassessment_evidence', 'drill_guidance', 'development_plans', 'development_plan_shares', 'development_goals', 'development_actions', 'development_evidence_links', 'development_reviews', 'development_review_snapshots', 'development_review_snapshot_refs', 'development_history'];
  const S12B_TABLES = ['box_cam_prefs', 'box_challenges', 'box_challenge_entries', 'box_assignments', 'box_sessions', 'box_session_observations', 'box_session_reasons', 'box_session_integrity_events', 'box_cam_disputes', 'combine_requests', 'combine_request_protocols', 'combine_attempts', 'combine_attempt_reasons', 'combine_attempt_calibration_checks', 'box_cam_cv_results', 'box_cam_cv_result_codes', 'box_cam_cv_result_trace'];
  const S12C_TABLES = ['recruitment_briefs', 'recruitment_brief_values', 'recruitment_brief_history', 'nobody_missed_reviews', 'nobody_missed_review_history', 'second_look_items', 'second_look_item_fingerprints', 'second_look_item_reasons', 'second_look_item_history', 'dynamic_watchlists', 'watchlist_criteria', 'watchlist_criterion_values', 'watchlist_members', 'watchlist_member_checks', 'watchlist_history', 'watchlist_membership_events'];
  const S13A_TABLES = ['import_batches', 'import_batch_columns', 'import_batch_rows', 'import_batch_row_errors', 'import_batch_history', 'prospects', 'import_batch_created_prospects', 'identity_reviews', 'api_keys', 'api_key_scopes', 'webhook_endpoints', 'webhook_endpoint_events', 'webhook_deliveries', 'webhook_delivery_attempts'];
  const S13B_TABLES = ['org_invites', 'sso_configs', 'sso_states', 'support_tickets', 'support_ticket_refs', 'support_ticket_replies', 'support_access_grants', 'support_access_log'];
  const S13C_TABLES = ['groups', 'group_members', 'group_pending_invites', 'group_shared_templates', 'group_programmes', 'group_grants', 'group_grant_recipients'];
  const S13D_TABLES = ['open_trials', 'open_trial_positions', 'open_trial_registrations', 'matchdays', 'matchday_players', 'friendlies', 'friendly_responses'];
  const S12D_TABLES = ['exposure_events', 'review_later', 'evidence_suggestions', 'evidence_suggestion_records', 'calibration_sessions', 'calibration_participants', 'calibration_submissions', 'calibration_ratings', 'calibration_notes', 'fixtures', 'coverage_plans', 'coverage_assignments', 'coverage_assignment_targets', 'coverage_assignment_warnings'];
  const S11C_TABLES = ['agent_transactions', 'agent_transaction_jurisdictions', 'transaction_parties', 'transaction_notes', 'transaction_linked_threads', 'transaction_terms_versions', 'transaction_keys', 'transaction_history', 'transaction_history_reason_codes', 'transaction_history_policy_versions', 'transaction_representations', 'transaction_representation_scopes', 'transaction_representation_history', 'transaction_representation_history_policy_versions', 'transaction_documents', 'transaction_document_history'];
  const S11B2_TABLES = ['compliance_contexts', 'compliance_context_jurisdictions', 'compliance_context_parties', 'compliance_context_representations', 'compliance_context_resolved_facts', 'compliance_evaluations', 'compliance_evaluation_reasons', 'compliance_evaluation_reason_items', 'compliance_evaluation_consents_outstanding', 'compliance_evaluation_policy_versions', 'compliance_evaluation_snapshot_parties', 'compliance_evaluation_snapshot_representations', 'regulatory_reviews', 'regulatory_review_reasons', 'regulatory_review_reason_items', 'regulatory_review_policy_versions', 'regulatory_review_evidence_refs', 'regulatory_review_history', 'compliance_context_history', 'compliance_context_history_policy_versions', 'regulatory_consents', 'regulatory_consent_regarding', 'regulatory_consent_policy_versions', 'regulatory_consent_rule_ids', 'regulatory_consent_revocations', 'regulatory_consent_history'];
  const S10B_TABLES = ['passport_prefs', 'passport_pref_positions', 'passport_position_history', 'passport_position_history_positions', 'passport_public_selections', 'passport_career_entries', 'passport_achievements', 'passport_shares', 'passport_corrections'];
  const S9D_TABLES = ['opportunities', 'opportunity_training_slots', 'opportunity_texts', 'applications', 'application_suitability', 'application_history', 'campaigns', 'campaign_drills', 'campaign_rubric', 'campaign_submissions', 'campaign_attempts', 'campaign_attempt_issues', 'player_prefs', 'player_pref_slots', 'player_pref_texts'];
  const S9B_TABLES = ['assessment_templates', 'assessment_template_attributes', 'assessments', 'assessment_ratings', 'assessment_rating_refs', 'assessment_history', 'video_segments', 'video_segment_labels', 'playlists', 'playlist_segments'];
  for (const t of ['orgs', 'guardians', 'players', 'guardian_children', 'sessions', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', ...AUDIT_TABLES, ...S5_TABLES, ...S8A_TABLES, ...S8B_TABLES, ...S8C_TABLES, ...S8D_TABLES, ...S9A_TABLES, ...S9B_TABLES, ...S9C_TABLES, ...S9D_TABLES, ...S10A_TABLES, ...S10B_TABLES, ...S10C_TABLES, ...S11A_TABLES, ...S11B1_TABLES, ...S11B2_TABLES, ...S11C_TABLES, ...S12A_TABLES, ...S12B_TABLES, ...S12C_TABLES, ...S12D_TABLES, ...S13A_TABLES, ...S13B_TABLES, ...S13C_TABLES, ...S13D_TABLES]) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    assert.deepEqual(cols(mig), cols(docs), `${t} columns`);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(t).map((r) => r.name);
    assert.deepEqual(idx(mig), idx(docs), `${t} indexes`);
    assert.match(mig.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/i, `${t} is STRICT in the migrations too`);
  }
  for (const t of ['players', 'guardians']) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json'), `${t}: the documented transitional column`);
  // The documents say so: the status header states that 0005 is registered and the projection retired.
  const header = fs.readFileSync(path.join(SQL_DIR, '01_identity.sql'), 'utf8').split('\n').slice(0, 20).join('\n');
  assert.match(header, /migration 0005[\s\S]{0,160}?REGISTERED/, 'the status header of 01_identity.sql states that 0005 is registered');
  assert.match(header, /0007_player_subrecords[\s\S]{0,200}?REGISTERED/, 'the status header of 01_identity.sql states that 0007 is registered');
  assert.doesNotMatch(header, /NOT registered/);
  // S6a: the status of the two one-time-code tables is stated in 03's scope header.
  const header03 = fs.readFileSync(path.join(SQL_DIR, '03_messaging_safety_audit.sql'), 'utf8').split('\n').slice(0, 30).join('\n');
  assert.match(header03, /email_challenges[^\n]*0008_one_time_codes[^\n]*REGISTERED/, 'the scope header of 03 states that email_challenges is live since 0008');
  assert.match(header03, /pairing_codes[^\n]*0008_one_time_codes[^\n]*REGISTERED/, 'the scope header of 03 states that pairing_codes is live since 0008');
  // S7a: the notification tables.
  assert.match(header03, /notifications\s+→ notifications[^\n]*0009_notifications[^\n]*REGISTERED/, 'the scope header of 03 states that notifications is live since 0009');
  assert.match(header03, /notificationPrefs[^\n]*0009_notifications[^\n]*REGISTERED/, 'the scope header of 03 states that the preference tables are live since 0009');
  // S7b: the dispatch tables; the attempt-shape CHECK is total in the documented DDL too (review of dc4b559, finding 1).
  assert.match(header03, /dispatches\s+→ dispatches, dispatch_attempts[^\n]*0010_dispatches[^\n]*REGISTERED/, 'the scope header of 03 states that the dispatch tables are live since 0010');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_attempts'").get().sql, /ok IS NOT NULL/, 'the documented attempt CHECK rejects a NULL send outcome');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(dispatches)').all(), [], 'the documented dispatches table has no foreign key (option A: an indexed reference, no cascade)');
  // S7c: the outbox and push tables (review of 6ca66ba): the structural source CHECK, a nullable string destination, a string token column, no side columns, no uniqueness on tokens, no vocabulary CHECK.
  for (const t of ['outbox', 'push_log', 'push_tokens']) assert.match(header03, new RegExp(`${t}[^\\n]*0011_outbox_push[^\\n]*REGISTERED`), `the scope header of 03 states that ${t} is live since 0011`);
  const outboxSql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get().sql;
  assert.match(outboxSql, /source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL/, 'the documented outbox CHECK ties each source to its columns');
  assert.equal(docs.prepare("PRAGMA table_info(outbox)").all().find((c) => c.name === 'to_address').notnull, 0, 'the documented destination is nullable');
  for (const t of ['outbox', 'push_log', 'push_tokens']) assert.equal(docs.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /_json$/.test(c.name)).length, 0, `${t}: typed columns only, no JSON side column`);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'push_tokens'").get().sql, /token\s+TEXT NOT NULL CHECK \(length\(token\) > 0\)/, 'the documented token column is a non-empty string');
  assert.equal(docs.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_tokens' AND sql LIKE '%UNIQUE%'").get().n, 0, 'no unique index on the documented tokens');
  for (const t of ['outbox', 'push_log', 'push_tokens']) { assert.doesNotMatch(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /transport IN \(|audience_kind IN \(|ref_kind IN \(|channel IN \(/, `${t}: no vocabulary CHECK`); assert.deepEqual(docs.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t} references nothing`); }
  // S7d (review §11.5 as corrected by the reviews of 46e5afe and 8330f08; D-A, D-B): the thread tables.
  for (const t of ['channels', 'messages', 'message_attachments']) assert.match(header03, new RegExp(`${t}[^\\n]*0012_channels[^\\n]*REGISTERED`), `the scope header of 03 states that ${t} is live since 0012`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(channels)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']], 'the documented channels table references orgs and, since migration 0015 (S8a-core, D-A converted), recruitment_requests; player_id (D-B, no lifecycle clause) and guardian_id (the bounded code-validated reference) carry no foreign key');
  assert.deepEqual(mig.prepare('PRAGMA foreign_key_list(channels)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']], 'the migrations rebuild channels with the same two keys');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(messages)').all().map((f) => [f.from, f.table, f.on_delete]), [['channel_id', 'channels', 'CASCADE']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(message_attachments)').all().map((f) => [f.from, f.table, f.on_delete]), [['message_id', 'messages', 'CASCADE']]);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'channels_request_id'").get().sql, /UNIQUE/, 'one thread per request');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_channel_position'").get().sql, /UNIQUE/, 'one message per position in a thread');
  for (const t of ['channels', 'messages', 'message_attachments']) for (const d of [docs, mig]) assert.deepEqual(d.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /^(extra|absent_keys|offtype)_json$/.test(c.name)).map((c) => c.name), [], `${t}: typed columns only, no side columns`);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'").get().sql, /kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL/, 'the documented attachment CHECK ties each kind to its columns');
  // S6b (plan §D.4 Candidate A as accepted at 1792fc7; Q4, Q4b, Q5): the eight audit tables — no foreign key on any (the five player references tolerant, the organisation/staff references historical pointers, the IDV guardian reference checked in code), no vocabulary CHECK, every literal column nullable, seq order, typed columns only (no side columns), the documented indexes (reports_target_player_id included).
  for (const t of AUDIT_TABLES) {
    assert.match(header03, new RegExp(`${t}[^\\n]*0013_safety_audit[^\\n]*REGISTERED`), `the scope header of 03 states that ${t} is live since 0013`);
    const sql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.deepEqual(docs.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t} references nothing (Q4: tolerant player references; the organisation and staff ids are historical pointers; Q4b: the guardian check is in code)`);
    assert.doesNotMatch(sql, /\bIN \(/, `${t}: no vocabulary CHECK`);
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all();
    assert.deepEqual(cols.slice(0, 2).map((c) => [c.name, c.type, c.notnull, c.pk]), [['seq', 'INTEGER', 0, 1], ['id', 'TEXT', 1, 0]], `${t}: seq is the order, id the writer's id`);
    for (const d of [docs, mig]) assert.deepEqual(d.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /^(extra|absent_keys|offtype)_json$/.test(c.name)).map((c) => c.name), [], `${t}: typed columns only, no side columns`);
    for (const c of cols) if (!['id', 'guardian_id'].includes(c.name)) assert.equal(c.notnull, 0, `${t}.${c.name}: every literal column is nullable (an absent key is NULL)`);
    assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?").get(t, 'sqlite_autoindex_' + t + '_1')?.sql ?? 'UNIQUE', /UNIQUE|^$/, `${t}: id is UNIQUE`);
  }
  assert.equal(docs.prepare('PRAGMA table_info(idv_queue)').all().find((c) => c.name === 'guardian_id').notnull, 1, 'idv_queue.guardian_id is NOT NULL (Domain G, strict)');
  assert.equal(docs.prepare('PRAGMA table_info(ledger)').all().some((c) => c.name === 'actor_kind'), false, 'the ledger derives no actor kind: user_id and actor_name are stored verbatim');
  assert.ok(docs.prepare('PRAGMA table_info(moderation_log)').all().some((c) => c.name === 'context_json'), 'the moderation context is kept whole');
  assert.ok(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'reports_target_player_id'").get(), 'the unresolved-player count reads reports by target_player_id');
  // S8a (typed and explicit since §4.3, 3 November 2026; Q7a tolerant, Q7c strict in code): the sixteen definitions of 02 (and the channels rebuild) — compared with the migration above column for column; here the decisions.
  const header02 = fs.readFileSync(path.join(SQL_DIR, '02_recruitment.sql'), 'utf8').split('\n').slice(0, 90).join('\n');
  assert.match(header02, /0015_recruitment[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0015 is registered');
  for (const t of S8A_TABLES) { const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => f.table); for (const parent of ['players', 'guardians']) assert.ok(!fks.includes(parent), `${t}: no foreign key to ${parent} (Q7a tolerant; Q7c strict in code)`); }
  for (const t of S8A_TABLES.filter((x) => x !== 'idempotency_keys')) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (valid input only)`); }
  for (const [t, re] of [['recruitment_requests', /status IN \('pending','accepted','declined','suspended'\)/], ['trials', /workflow_state IN \('legacy_accepted'/], ['trial_attendance', /state IN \('attended'/], ['trial_schedule_sessions', /kind IN \('onboarding'/]]) assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, re, `${t}: its vocabulary CHECK`);
  // The case keys are real and immediate (a case is written before anything names it), in the documents and in the migrations alike
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_requests)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['trial_id', 'trials', 'SET NULL'], ['user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(trials)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  for (const t of ['recruitment_requests', 'trials']) { assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /case_id TEXT REFERENCES recruitment_cases\(id\) ON DELETE RESTRICT,/, `${t}.case_id is immediate`); assert.deepEqual(mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), docs.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the migrations create the same keys`); }
  // S8b (typed and explicit since §4.3; Q8a tolerant): the twenty-five definitions — typed columns only, the vocabulary CHECKs, no player or guardian key, the room tables' RESTRICT, the children cascading, a decision's snapshot by id, one history shape, the keys as columns
  assert.match(header02, /0016_recruitment_cases[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0016 is registered');
  // S8c (typed and explicit since §4.3, 3 November 2026; Q8c-a tolerant, Q8c-b strict in code): the ten definitions — typed columns only (no lossless side column), the vocabulary and length CHECKs, no player or guardian key, the case and request keys deferred to COMMIT, the owned-history RESTRICT, the keys as columns and offer_keys rows (not idempotency_keys), the pointers plain columns checked by the typer
  assert.match(header02, /0017_recruitment_contacts_offers[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0017 is registered');
  const ddlOfDocs = (t) => docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
  for (const t of S8C_TABLES) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (valid input only)`); const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all(); for (const parent of ['players', 'guardians', 'room_decisions', 'outbox']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (Q8c-a tolerant; Q8c-b strict in code; decision and outbox ids plain)`); }
  for (const [t, re] of [['recruitment_contacts', /status IN \('draft'/], ['recruitment_contacts', /length\(body\) <= 2000/], ['recruitment_offers', /status IN \('DRAFT'/], ['offer_revisions', /length\(internal_note\) <= 2000/], ['offer_responses', /response_type IN \('accepted','declined'\)/]]) assert.match(ddlOfDocs(t), re, `${t}: the vocabulary and length CHECKs`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_contacts)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['cancelled_by_user_id', 'org_users', 'RESTRICT'], ['case_id', 'recruitment_cases', 'RESTRICT'], ['created_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['recorded_by_user_id', 'org_users', 'RESTRICT'], ['request_id', 'recruitment_requests', 'NO ACTION'], ['routing_agent_user_id', 'org_users', 'RESTRICT'], ['sent_by_user_id', 'org_users', 'RESTRICT']], 'the contact keys: the case and request keys deferred, the organisation and the staff');
  assert.match(ddlOfDocs('recruitment_contacts'), /request_id TEXT[^,]*DEFERRABLE INITIALLY DEFERRED/, 'recruitment_contacts.request_id is checked at COMMIT (a send writes its contact before the request)'); for (const t of ['recruitment_contacts', 'recruitment_offers']) assert.match(ddlOfDocs(t), /case_id TEXT NOT NULL REFERENCES recruitment_cases\(id\) ON DELETE RESTRICT,/, `${t}.case_id is immediate`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_offers)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['agent_share_user_id', 'org_users', 'RESTRICT'], ['case_id', 'recruitment_cases', 'RESTRICT'], ['created_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT']], 'the offer keys: no current_revision_id key (the typer checks the pointer), no decision key');
  for (const t of ['contact_history', 'offer_history']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.on_delete === 'RESTRICT'), `${t}: the owned history keeps its RESTRICT`); for (const t of ['contact_attempts', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_keys']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().filter((f) => f.table !== 'org_users').every((f) => f.on_delete === 'CASCADE'), `${t}: cascades with its owner`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(offer_revisions)').all().filter((f) => f.table !== 'org_users').map((f) => f.from), ['offer_id'], 'the revision pointers (response_id, supersedes, superseded_by, discarded_by) are plain columns the typer checks; the staff ids are keys');
  assert.doesNotMatch(ddlOfDocs('idempotency_keys'), /'recruitment_contacts'|'recruitment_offers'/, 'contacts and offers keep their keys in their own columns and offer_keys');
  // S8d (design note docs/architecture/s8d-design-note.md; the fidelity rule of 30 October): the ten definitions — typed columns only (no raw_json / extra_json), no player or guardian key (tolerant and counted), offer_revision_id a checked pointer (the pointer rule), the deferred completion key for the package ↔ signing cycle, the key table's owner CHECK widened
  assert.match(header02, /0018_signings_follow_ups[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0018 is registered');
  for (const t of S8D_TABLES) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); for (const c of ['raw_json', 'extra_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (the fidelity rule)`); const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all(); for (const parent of ['players', 'guardians']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (tolerant)`); }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(signing_packages)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['cancelled_by_user_id', 'org_users', 'RESTRICT'], ['case_id', 'recruitment_cases', 'RESTRICT'], ['completion_by_user_id', 'org_users', 'RESTRICT'], ['completion_signing_id', 'signings', 'NO ACTION'], ['created_by_user_id', 'org_users', 'RESTRICT'], ['offer_id', 'recruitment_offers', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT']]);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'signing_packages'").get().sql, /completion_signing_id[^,]*DEFERRABLE INITIALLY DEFERRED/, 'the completion key is deferred (the cycle commits in one unit)');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(signings)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'RESTRICT'], ['offer_id', 'recruitment_offers', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['signing_package_id', 'signing_packages', 'RESTRICT'], ['signing_revision_id', 'signing_revisions', 'RESTRICT'], ['user_id', 'org_users', 'RESTRICT']]);
  for (const t of ['signing_history', 'signing_revisions', 'signing_parties', 'follow_ups', 'outcome_reports', 'outcome_report_confirmations']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().length > 0, `${t}: keyed to its owner`);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get().sql, /owner_table IN \('signing_packages'\)/, 'the key table belongs to the signing packages: every other step keeps its keys as columns');
  // S9a (migration 0019): the seven definitions of 04 — typed columns only, no player or media key (tolerant), the organisation and staff keys RESTRICT, the evidence self keys immediate RESTRICT
  const header04 = fs.readFileSync(path.join(SQL_DIR, '04_scouting_assessment.sql'), 'utf8');
  assert.match(header04, /0019_scouting_evidence REGISTERED/, 'the S9a section of 04 states that 0019 is registered');
  for (const t of S9A_TABLES) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json', 'value_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (valid input only)`); const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all(); for (const parent of ['players', 'guardians', 'player_media']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (tolerant)`); assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`); }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(evidence)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['correction_of_id', 'evidence', 'RESTRICT'], ['superseded_by_id', 'evidence', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(coach_affiliations)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['confirmed_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(squad_invites)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT']]);
  // S9b (migration 0020): the ten definitions of 04 — typed columns only (no side or JSON columns but the drawing), no
  // player, media or trial key (tolerant), the organisation and staff keys RESTRICT, the keys inside the domain RESTRICT.
  assert.match(header04, /0020_scouting_assessments REGISTERED/, 'the S9b section of 04 states that 0020 is registered');
  for (const t of S9B_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['raw_json', 'extra_json', 'context_extra_json', 'anchors_json', 'labels_json', 'detail_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    for (const parent of ['players', 'player_media', 'trials']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
  }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(assessments)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['published_feedback_by_user_id', 'org_users', 'RESTRICT'], ['scout_user_id', 'org_users', 'RESTRICT'], ['second_opinion_of_id', 'assessments', 'RESTRICT'], ['template_id', 'assessment_templates', 'RESTRICT'], ['template_version', 'assessment_templates', 'RESTRICT']]);
  // S9c (migration 0021): the nine club setup definitions of 04 — typed columns only, no player key (tolerant), the
  // organisation keys RESTRICT, the setup's children CASCADE, a dropped role leaves what named it with no role (SET NULL).
  assert.match(header04, /0021_club_setup REGISTERED/, 'the S9c section of 04 states that 0021 is registered');
  for (const t of S9C_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json', 'value_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => f.table === 'players'), `${t}: no foreign key to players (tolerant)`);
    assert.ok(fks.filter((f) => f.table === 'orgs').every((f) => f.on_delete === 'RESTRICT'), `${t}: the organisation key is RESTRICT`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(vacancies)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['role_id', 'org_tactical_roles', 'SET NULL']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(org_shadow_players)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['role_id', 'org_tactical_roles', 'SET NULL']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(org_tactical_roles)').all().map((f) => [f.from, f.table, f.on_delete]), [['org_id', 'org_tactical_setups', 'CASCADE']]);
  // S9d (migration 0022): the fifteen opportunity, application, campaign and preference definitions of 04 — typed
  // columns only (no JSON), no player key (tolerant), the organisation and staff keys RESTRICT, owned children CASCADE.
  assert.match(header04, /0022_opportunities_campaigns REGISTERED/, 'the S9d section of 04 states that 0022 is registered');
  for (const t of S9D_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => f.table === 'players' || f.table === 'player_media'), `${t}: no foreign key to players or media (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S10a (migration 0023): the eighteen verification definitions of 05 — no JSON column (metadata, meta, codes and the event
  // detail are typed), no player key (tolerant), every org and staff key RESTRICT, the keys inside the domain RESTRICT, the
  // codes and the evidence links cascading with their owner; the organisation facet's revocation is an orgs column.
  const header05 = fs.readFileSync(path.join(SQL_DIR, '05_verification_passport.sql'), 'utf8');
  assert.match(header05, /0023_verification REGISTERED/, 'the S10a section of 05 states that 0023 is registered');
  for (const t of S10A_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no foreign key to players or guardians (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(ver_claim_evidence)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['claim_id', 'ver_claims', 'CASCADE'], ['evidence_id', 'ver_evidence', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(ver_references)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['coach_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['provenance_claim_id', 'ver_claims', 'RESTRICT'], ['supersedes_id', 'ver_references', 'RESTRICT']]);
  for (const [name, re] of [['ver_claims_one_identity_per_user', /UNIQUE[\s\S]*PERSON_IDENTITY/], ['ver_claims_one_current_affiliation', /UNIQUE[\s\S]*current = 1/], ['ver_disputes_one_open_per_claim', /UNIQUE[\s\S]*status = 'open'/], ['ver_admins_one_active_grant', /UNIQUE[\s\S]*status = 'active'/], ['ver_root_transfers_one_pending', /UNIQUE[\s\S]*status = 'pending'/], ['ver_tokens_hash', /UNIQUE/]]) assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name).sql, re, `${name}: the uniqueness rule the code keeps`);
  // S10b (migration 0024): the nine passport definitions of 05 — no JSON column (dates are text in the precision given,
  // positions and selections are rows), no player or guardian key (tolerant), a confirmation's organisation RESTRICT,
  // the preferences' children cascading.
  assert.match(header05, /0024_passport REGISTERED/, 'the S10b section of 05 states that 0024 is registered');
  for (const t of S10B_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no foreign key to players or guardians (tolerant)`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(passport_achievements)').all().map((f) => [f.from, f.table, f.on_delete]), [['confirmation_org_id', 'orgs', 'RESTRICT']]);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'passport_shares_token_hash'").get().sql, /UNIQUE/, 'one share per token hash');
  // S10c (migration 0025): the transition and reference definitions of 05 — no JSON column (a history entry's detail is
  // two typed columns), no player or guardian key (tolerant), a grant's and a placement's organisation RESTRICT, the
  // pack, grants and history cascading with their case.
  assert.match(header05, /0025_transitions_vouches REGISTERED/, 'the S10c section of 05 states that 0025 is registered');
  for (const t of S10C_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no foreign key to players or guardians (tolerant)`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(transition_case_recipients)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['transition_case_id', 'transition_cases', 'CASCADE']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(transition_cases)').all().map((f) => [f.from, f.table, f.on_delete]), [['placement_org_id', 'orgs', 'RESTRICT']]);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'vouches_code_hash'").get().sql, /UNIQUE/, 'one reference per code hash');
  // S11a (migration 0026): the fifteen agent core definitions of 06 — no JSON column (a history entry's detail is typed
  // columns, the keys are columns of their owner), no player key (tolerant), every staff and agency key RESTRICT, the
  // children cascading with their owner; agreement_documents went with the legacy lane.
  const header06 = fs.readFileSync(path.join(SQL_DIR, '06_agent_compliance_transactions.sql'), 'utf8');
  assert.match(header06, /0026_agent_core REGISTERED/, 'the S11a section of 06 states that 0026 is registered');
  for (const t of S11A_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no foreign key to players or guardians (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S11b-1 (migration 0027): reviewers and policy versions — no JSON column (rule parameters are typed rows), the
  // reviewer and version keys RESTRICT, the children cascading with their owner.
  assert.match(header06, /0027_compliance_policies REGISTERED/, 'the S11b-1 section of 06 states that 0027 is registered');
  for (const t of S11B1_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(jurisdiction_policies)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['approved_by_id', 'ts_reviewers', 'RESTRICT'], ['proposed_by_id', 'ts_reviewers', 'RESTRICT'], ['supersedes_id', 'jurisdiction_policies', 'RESTRICT']]);
  assert.equal(mig.prepare('SELECT COUNT(*) AS n FROM jurisdiction_policies').get().n, 3, 'the migration inserts the three seeded versions');
  // S11b-2 (migration 0028): contexts, evaluations, reviews and consents — no JSON column, no player or club key
  // (tolerant), every key RESTRICT or a child's CASCADE, the same keys in the migration.
  assert.match(header06, /0028_compliance_records REGISTERED/, 'the S11b-2 section of 06 states that 0028 is registered');
  for (const t of S11B2_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no foreign key to players or guardians (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'regulatory_consent_revocations'").get().sql, /consent_id\s+TEXT NOT NULL UNIQUE/, 'a consent is revoked once');
  // S11c (migration 0029): transactions, bindings and documents — no JSON column, no player or club key (tolerant), every
  // key RESTRICT or a child's CASCADE, the same keys in the migration; the snapshot names its evaluation row by key.
  assert.match(header06, /0029_agent_transactions REGISTERED/, 'the S11c section of 06 states that 0029 is registered');
  for (const t of S11C_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians', 'channels', 'trials', 'opportunities'].includes(f.table)), `${t}: no key to a player, guardian, channel, trial or opportunity (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S12a (migration 0030): the development domain — no JSON column, no key to a player, guardian or evidence item
  // (tolerant), every key RESTRICT or a child's CASCADE, the same keys in the migration; one history table.
  const header07 = fs.readFileSync(path.join(SQL_DIR, '07_development_boxcam_discovery.sql'), 'utf8');
  assert.match(header07, /0030_development REGISTERED/, 'the S12a sections of 07 state that 0030 is registered');
  for (const t of S12A_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians', 'evidence', 'assessments', 'trials'].includes(f.table)), `${t}: no key to a player, guardian or cited record (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S12b (migration 0031): Box Cam, Combine and the CV results — no JSON column, no key to a player, guardian or media
  // item (tolerant), every key RESTRICT or a child's CASCADE, the same keys in the migration; the nonce only as a hash.
  assert.match(header07, /0031_box_cam REGISTERED/, 'the S12b sections of 07 state that 0031 is registered');
  for (const t of S12B_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians', 'player_media'].includes(f.table)), `${t}: no key to a player, guardian or media item (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S12c (migration 0032): discovery — no JSON column, no key to a player (tolerant), every key RESTRICT or a child's
  // CASCADE, the same keys in the migration; one Second Look item per decision cycle, one transition per fingerprint.
  assert.match(header07, /0032_discovery REGISTERED/, 'the S12c section of 07 states that 0032 is registered');
  for (const t of S12C_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no key to a player or guardian (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S12d (migration 0033): insight and coverage — no JSON column, no key to a player (tolerant), every key RESTRICT or a
  // child's CASCADE, the same keys in the migration; one exposure event per day, one open suggestion per rule.
  assert.match(header07, /0033_insight_coverage REGISTERED/, 'the S12d section of 07 states that 0033 is registered');
  for (const t of S12D_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians', 'player_media', 'assessments'].includes(f.table)), `${t}: no key to a player, guardian, media or assessment (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S13a (migration 0034): integrations — no JSON column, no key to a player (tolerant), every key RESTRICT or a
  // child's CASCADE, the same keys in the migration; one live prospect per identity, API keys only as hashes.
  const header08 = fs.readFileSync(path.join(SQL_DIR, '08_operations_integrations.sql'), 'utf8');
  assert.match(header08, /0034_integrations REGISTERED/, 'the S13a section of 08 states that 0034 is registered');
  for (const t of S13A_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no key to a player or guardian (tolerant)`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S13b (migration 0035): enterprise — no JSON column, no key to a player, every key RESTRICT or a child's CASCADE, the
  // same keys in the migration; invite codes and SSO states only as hashes, support references only of the kinds read.
  assert.match(header08, /0035_enterprise REGISTERED/, 'the S13b section of 08 states that 0035 is registered');
  for (const t of S13B_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no key to a player or guardian`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S13c (migration 0036): groups — no JSON column, no key to a player, every key RESTRICT or a child's CASCADE, the
  // same keys in the migration; an admin is a flagged member row, a shortlist grant shares '*', a revocation has a reason.
  assert.match(header08, /0036_groups REGISTERED/, 'the S13c section of 08 states that 0036 is registered');
  for (const t of S13C_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no key to a player or guardian`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  // S13d (migration 0037): grassroots operations — no JSON column, no key to a player or guardian, every key RESTRICT
  // or a child's CASCADE, the same keys in the migration; a coverage assignment keys the friendly or open day it names.
  assert.match(header08, /0037_grassroots REGISTERED/, 'the S13d section of 08 states that 0037 is registered');
  for (const t of S13D_TABLES) {
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /_json$/.test(c)), `${t}: no JSON column (valid input only)`);
    const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => ['players', 'guardians'].includes(f.table)), `${t}: no key to a player or guardian`);
    assert.ok(fks.every((f) => f.on_delete === 'RESTRICT' || f.on_delete === 'CASCADE'), `${t}: every key RESTRICT or a child's CASCADE`);
    assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`);
  }
  for (const d of [docs, mig]) {
    const keys = d.prepare('PRAGMA foreign_key_list(coverage_assignments)').all().map((f) => [f.from, f.table, f.on_delete]);
    for (const k of [['friendly_id', 'friendlies', 'RESTRICT'], ['open_trial_id', 'open_trials', 'RESTRICT']]) assert.ok(keys.some((x) => x.join() === k.join()), `coverage_assignments.${k[0]} is a key to ${k[1]}`);
    assert.ok(!d.prepare('PRAGMA table_info(coverage_assignments)').all().some((c) => c.name === 'event_id'), 'no unkeyed event_id');
    assert.ok(!d.prepare('PRAGMA table_info(friendlies)').all().some((c) => ['status', 'org_name'].includes(c.name)), 'friendlies: no constant status, no copied club name');
  }
  for (const d of [docs, mig]) {
    assert.equal(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_admins'").get(), undefined, 'no group_admins table: an admin is a flagged member row');
    const grants = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_grants'").get().sql;
    assert.match(grants, /resource_kind <> 'shortlist' OR resource_id = '\*'/, 'a shortlist grant shares the whole shortlist');
    assert.match(grants, /\(revoked_at IS NULL\) = \(revoke_reason IS NULL\)/, 'a revocation always has its reason');
  }
  for (const d of [docs, mig]) {
    const inv = d.prepare('PRAGMA table_info(org_invites)').all().map((c) => c.name);
    assert.ok(inv.includes('token_hash') && !inv.includes('token'), 'org_invites: the code is stored only as its hash');
    const st = d.prepare('PRAGMA table_info(sso_states)').all().map((c) => c.name);
    assert.ok(st.includes('state_hash') && st.includes('nonce_hash') && !st.includes('state') && !st.includes('nonce'), 'sso_states: state and nonce only as hashes');
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'support_ticket_refs'").get().sql, /kind IN \('case','import'\)/, 'support references only of the kinds the support read resolves');
    assert.ok(d.prepare('PRAGMA foreign_key_list(support_access_log)').all().every((f) => f.on_delete === 'RESTRICT'), 'the support access log is audit: RESTRICT');
  }
  for (const d of [docs, mig]) {
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'prospects_live_identity'").get().sql, /WHERE reversed_at IS NULL/, 'one live prospect per organisation, provider and external id');
    const keyCols = d.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name);
    assert.ok(keyCols.includes('key_hash') && !keyCols.some((c) => /^(key|plaintext|token)$/.test(c)), 'api_keys: the key is stored only as its hash');
  }
  for (const d of [docs, mig]) {
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'exposure_events'").get().sql, /UNIQUE \(org_id, player_id, kind, day_index\)/, 'one exposure event per organisation, player, kind and day');
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'evidence_suggestions_one_open'").get().sql, /WHERE status IN \('suggested','requested'\)/, 'one open suggestion per rule');
  }
  for (const d of [docs, mig]) {
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'second_look_items'").get().sql, /UNIQUE \(org_id, room_id, decision_id\)/, 'one Second Look item per decision cycle');
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'watchlist_membership_events'").get().sql, /UNIQUE \(fingerprint\)/, 'one transition per fingerprint');
  }
  for (const d of [docs, mig]) {
    const cols = d.prepare('PRAGMA table_info(box_sessions)').all().map((c) => c.name);
    assert.ok(cols.includes('nonce_hash') && !cols.includes('nonce'), 'box_sessions: the nonce is stored only as its hash');
  }
  for (const d of [docs, mig]) {
    assert.ok(!d.prepare('PRAGMA table_info(development_reviews)').all().some((c) => c.name === 'superseded_by_review_id'), 'development_reviews: superseded_by is derived, not stored');
    assert.ok(!d.prepare('PRAGMA table_info(development_plans)').all().some((c) => c.name === 'origin_trial_id'), 'development_plans: the never-set origin trial is gone');
    for (const t of ['development_plans_history', 'development_goals_history', 'development_actions_history', 'development_reviews_history']) assert.equal(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), undefined, `${t}: one development_history table instead`);
  }
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'dev_objective_reassessments_open'").get().sql, /UNIQUE[\s\S]*WHERE status = 'requested'/, 'one open reassessment per objective');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'development_evidence_links_target_source'").get().sql, /UNIQUE/, 'the same evidence is linked to a goal or action once');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(agent_transactions)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['agency_org_id', 'orgs', 'RESTRICT'], ['agent_user_id', 'org_users', 'RESTRICT'], ['compliance_evaluation_id', 'compliance_evaluations', 'RESTRICT'], ['context_id', 'compliance_contexts', 'RESTRICT'], ['link_recruitment_case_id', 'recruitment_cases', 'RESTRICT']]);
  for (const d of [docs, mig]) assert.ok(!d.prepare('PRAGMA table_info(agent_transactions)').all().some((c) => /^compliance_(outcome|reason|policy|consent|blocked|clear)/.test(c.name)), 'agent_transactions: the snapshot copies nothing its evaluation row holds');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'transaction_parties_live_role'").get().sql, /UNIQUE[\s\S]*WHERE removed = 0/, 'one live party per role');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'transaction_representations_live'").get().sql, /UNIQUE[\s\S]*WHERE status <> 'withdrawn'/, 'one live binding per (transaction, role, agent)');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(representation_agreements)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['agency_org_id', 'orgs', 'RESTRICT'], ['agent_user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(org_agency_settings)').all().map((f) => [f.from, f.table, f.on_delete]), [['org_id', 'orgs', 'RESTRICT']]);
  assert.equal(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agreement_documents'").get(), undefined, 'agreement_documents is gone with the legacy lane');
  for (const d of [docs, mig]) assert.ok(!d.prepare('PRAGMA table_info(representation_agreements)').all().some((c) => ['policy_version', 'is_regulatory_minor'].includes(c.name)), 'representation_agreements: the build constants are not stored');
  assert.ok(!docs.prepare('PRAGMA table_info(vouches)').all().some((c) => c.name === 'code'), 'vouches: the code is stored only as its hash');
  for (const d of [docs, mig]) assert.ok(!d.prepare('PRAGMA table_info(orgs)').all().some((c) => c.name === 'verification_org_type'), 'orgs: the unused verification_org_type column is gone');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(applications)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['opportunity_id', 'opportunities', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['outcome_by_user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(campaign_attempts)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['review_by_user_id', 'org_users', 'RESTRICT'], ['submission_id', 'campaign_submissions', 'CASCADE']]);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'applications_one_live'").get().sql, /UNIQUE[\s\S]*WHERE status <> 'withdrawn'/, 'one live application per opportunity and player');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(playlist_segments)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['playlist_id', 'playlists', 'CASCADE'], ['segment_id', 'video_segments', 'RESTRICT']]);
  for (const t of S8B_TABLES) { const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all(); for (const parent of ['players', 'guardians']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (Q8a tolerant)`); assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`); }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_cases)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['decision_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['owner_user_id', 'org_users', 'RESTRICT'], ['room_lead_scout_user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(case_history)').all().map((f) => [f.from, f.table, f.on_delete]), [['case_id', 'recruitment_cases', 'CASCADE']], 'the history cascades with its case like every owned child');
  for (const t of ['case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_history']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.from === 'case_id' && f.table === 'recruitment_cases' && f.on_delete === 'CASCADE'), `${t}: cascades with its owner`);
  for (const t of ['case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.table === 'case_budget_scenarios' && f.on_delete === 'CASCADE'), `${t}: cascades with its scenario`);
  for (const t of ['room_comments', 'room_snapshots', 'room_decisions', 'room_evidence_states']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.from === 'room_id' && f.table === 'recruitment_cases' && f.on_delete === 'RESTRICT'), `${t}: an independent collection, RESTRICT`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(case_request_links)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'CASCADE'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(case_trial_links)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'CASCADE'], ['trial_id', 'trials', 'RESTRICT']]);
  assert.equal(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'recruitment_cases_one_open_room'").get(), undefined, 'the drafted one-open-room index is withdrawn (§3)');
  assert.match(ddlOfDocs('room_evidence_states'), /UNIQUE \(room_id, evidence_id\)/, 'one review state per (room, evidence)');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(room_decisions)').all().map((f) => [f.from, f.table]).sort(), [['org_id', 'orgs'], ['room_id', 'recruitment_cases'], ['snapshot_id', 'room_snapshots']], 'the decision chain is plain ids checked at every write; a decision names its snapshot by key');
  for (const [t, c] of [['case_decision_drafts', 'create_key'], ['case_transaction_handoffs', 'invite_key'], ['room_decisions', 'finalize_key'], ['room_decisions', 'draft_key']]) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c), `${t}.${c}: the key is a column of its owner`);
  assert.equal(docs.prepare('PRAGMA table_info(case_decision_drafts)').all().filter((c) => c.pk > 0).map((c) => c.name).join(','), 'case_id', 'the draft is one row per case (its primary key is the owner)');
  assert.ok(docs.prepare('PRAGMA table_info(room_snapshots)').all().some((c) => c.name === 'note'), 'the snapshot note is stored as written'); assert.ok(!docs.prepare('PRAGMA table_info(room_decisions)').all().some((c) => /^snapshot_(trust|source)/.test(c.name)), 'a decision keeps no copy of its snapshot');
  assert.deepEqual(docs.prepare('PRAGMA table_info(case_history)').all().map((c) => c.name).filter((c) => /^(by|actor)_/.test(c)), ['by_kind', 'by_id', 'by_name'], 'one history entry shape'); for (const t of S8B_TABLES) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json']) assert.ok(!cols.includes(c), `${t}: no ${c} (valid input only)`); }
  for (const [t, re] of [['recruitment_cases', /room_status IN \('watching'/], ['recruitment_cases', /stage IN \('identified'/], ['case_tasks', /status IN \('open','in_progress','done','cancelled'\)/], ['case_budget_lines', /kind IN \('wage','fee','bonus','expense'\)/], ['room_decisions', /outcome IN \('progress','hold','reject'\)/]]) assert.match(ddlOfDocs(t), re, `${t}: the vocabulary CHECK`);
  assert.equal(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'recruitment_requests_one_pending'").get(), undefined, 'the drafted one-pending index is withdrawn (D2)');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'trials_one_open_per_case'").get().sql, /UNIQUE[\s\S]*WHERE case_id IS NOT NULL AND workflow_state NOT IN \('completed', 'cancelled'\)/, 'one open trial per case is kept (the release-before-arrival write rule)');
  for (const t of ['recruitment_requests', 'trials']) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all(); assert.deepEqual(cols.slice(0, 1).map((c) => [c.name, c.type, c.pk]), [['id', 'TEXT', 1]], `${t}: the writer's id is the primary key (rowid keeps the order)`); }
});

console.log(`\n${passed} schema-DDL checks passed (${files.length} files, ${tables.length} tables)`);
