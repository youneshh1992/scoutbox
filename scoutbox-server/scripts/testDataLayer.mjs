// Unit tests for the relational data layer (repositories/): the table
// migration runner, the staff repository, the read-only views and the snapshot store's table-backed exclusions. Everything runs on
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
import { createUsersRepository, USERS_TABLE } from '../repositories/users.mjs';
import { readonlyView } from '../repositories/readonly.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { RECRUITMENT_TABLES } from '../repositories/recruitment.mjs';
import { RECRUITMENT_CASES_TABLES } from '../repositories/recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_TABLES } from '../repositories/recruitmentContactsOffers.mjs';
import { SIGNINGS_FOLLOWUPS_TABLES } from '../repositories/signingsFollowUps.mjs';
import { openStore } from '../store.mjs';
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
// Since S3 `org_users.org_id` is a foreign key: the staff fixtures' organisations must exist first.
const seedOrgs = (sqlite, ids = ['org-a', 'org-b', 'o']) => { for (const id of ids) sqlite.prepare("INSERT OR IGNORE INTO orgs (id, name, type, level, plan) VALUES (?, 'Org', 'club', 'pro', 'Pro')").run(id); };
const repoOn = (sqlite, legacy = []) => { seedOrgs(sqlite); const r = createUsersRepository({ sqlite, nextId, persist: () => {} }); r.attach(legacy); return r; };

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
    migrations: ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups', '0019_scouting_evidence', '0020_scouting_assessments', '0021_club_setup', '0022_opportunities_campaigns', '0023_verification', '0024_passport', '0025_transitions_vouches', '0026_agent_core', '0027_compliance_policies', '0028_compliance_records', '0029_agent_transactions', '0030_development', '0031_box_cam', '0032_discovery', '0033_insight_coverage', '0034_integrations', '0035_enterprise', '0036_groups', '0037_grassroots', '0038_operations', '0039_retire_blob'],
    tables: ['agency_affiliation_history', 'agency_affiliation_history_tiers', 'agency_affiliation_tiers', 'agency_affiliations', 'agent_profile_facets', 'agent_profile_history', 'agent_profile_jurisdictions', 'agent_profiles', 'agent_transaction_jurisdictions', 'agent_transactions', 'agreement_history', 'agreement_opportunity_shares', 'agreement_policy_versions', 'agreement_scopes', 'api_key_scopes', 'api_keys', 'application_history', 'application_suitability', 'applications', 'assessment_history', 'assessment_rating_refs', 'assessment_ratings', 'assessment_template_attributes', 'assessment_templates', 'assessments', 'blocks', 'box_assignments', 'box_cam_cv_result_codes', 'box_cam_cv_result_trace', 'box_cam_cv_results', 'box_cam_disputes', 'box_cam_prefs', 'box_challenge_entries', 'box_challenges', 'box_session_integrity_events', 'box_session_observations', 'box_session_reasons', 'box_sessions', 'calibration_notes', 'calibration_participants', 'calibration_ratings', 'calibration_sessions', 'calibration_submissions', 'campaign_attempt_issues', 'campaign_attempts', 'campaign_drills', 'campaign_rubric', 'campaign_submissions', 'campaigns', 'case_approvals', 'case_assignments', 'case_budget_actuals', 'case_budget_fx_assumptions', 'case_budget_lines', 'case_budget_scenarios', 'case_decision_draft_evidence_refs', 'case_decision_draft_reason_codes', 'case_decision_drafts', 'case_history', 'case_request_links', 'case_room_tags', 'case_tasks', 'case_transaction_handoffs', 'case_trial_links', 'channels', 'coach_affiliation_history', 'coach_affiliations', 'combine_attempt_calibration_checks', 'combine_attempt_reasons', 'combine_attempts', 'combine_request_protocols', 'combine_requests', 'compliance_context_history', 'compliance_context_history_policy_versions', 'compliance_context_jurisdictions', 'compliance_context_parties', 'compliance_context_representations', 'compliance_context_resolved_facts', 'compliance_contexts', 'compliance_evaluation_consents_outstanding', 'compliance_evaluation_policy_versions', 'compliance_evaluation_reason_items', 'compliance_evaluation_reasons', 'compliance_evaluation_snapshot_parties', 'compliance_evaluation_snapshot_representations', 'compliance_evaluations', 'contact_attempts', 'contact_history', 'coverage_assignment_targets', 'coverage_assignment_warnings', 'coverage_assignments', 'coverage_plans', 'delivery_callbacks_seen', 'delivery_centre', 'delivery_fail_injections', 'dev_objective_item_evidence', 'dev_objective_item_exercises', 'dev_objective_items', 'dev_objective_progress', 'dev_objective_reassessment_evidence', 'dev_objective_reassessments', 'dev_objective_shares', 'dev_objectives', 'development_actions', 'development_evidence_links', 'development_goals', 'development_history', 'development_plan_shares', 'development_plans', 'development_review_snapshot_refs', 'development_review_snapshots', 'development_reviews', 'dispatch_attempts', 'dispatches', 'drill_guidance', 'dynamic_watchlists', 'email_challenges', 'evidence', 'evidence_disputes', 'evidence_history', 'evidence_media', 'evidence_suggestion_records', 'evidence_suggestions', 'exposure_events', 'fixtures', 'follow_ups', 'friendlies', 'friendly_responses', 'group_grant_recipients', 'group_grants', 'group_members', 'group_pending_invites', 'group_programmes', 'group_shared_templates', 'groups', 'guardian_children', 'guardians', 'idempotency_keys', 'identity_reviews', 'idv_queue', 'import_batch_columns', 'import_batch_created_prospects', 'import_batch_history', 'import_batch_row_errors', 'import_batch_rows', 'import_batches', 'invoices', 'jurisdiction_policies', 'jurisdiction_policy_history', 'jurisdiction_policy_publishers', 'jurisdiction_policy_rule_overrides', 'jurisdiction_policy_rule_param_items', 'jurisdiction_policy_rule_params', 'jurisdiction_policy_rule_sources', 'jurisdiction_policy_rules', 'ledger', 'ledger_protocols', 'matchday_players', 'matchdays', 'media_deletions', 'message_attachments', 'messages', 'moderation_flags', 'moderation_log', 'nobody_missed_review_history', 'nobody_missed_reviews', 'notification_pref_categories', 'notification_prefs', 'notifications', 'offer_history', 'offer_keys', 'offer_read_receipts', 'offer_responses', 'offer_revision_documents', 'offer_revisions', 'open_trial_positions', 'open_trial_registrations', 'open_trials', 'opportunities', 'opportunity_texts', 'opportunity_training_slots', 'ops_events', 'org_agency_jurisdictions', 'org_agency_settings', 'org_federation_checks', 'org_invites', 'org_looking_for', 'org_notes', 'org_shadow_players', 'org_squad_members', 'org_tactical_role_criteria', 'org_tactical_roles', 'org_tactical_setups', 'org_tactical_windows', 'org_users', 'org_verified_domains', 'orgs', 'outbox', 'outcome_report_confirmations', 'outcome_reports', 'pairing_codes', 'passport_achievements', 'passport_career_entries', 'passport_corrections', 'passport_position_history', 'passport_position_history_positions', 'passport_pref_positions', 'passport_prefs', 'passport_public_selections', 'passport_shares', 'player_activity_log', 'player_attendance', 'player_badges', 'player_drill_results', 'player_drills', 'player_external_ids', 'player_media', 'player_media_tags', 'player_medical_records', 'player_pref_slots', 'player_pref_texts', 'player_prefs', 'player_programme_completions', 'player_season_history', 'player_timeline', 'players', 'playlist_segments', 'playlists', 'prospects', 'push_log', 'push_tokens', 'recruitment_brief_history', 'recruitment_brief_values', 'recruitment_briefs', 'recruitment_cases', 'recruitment_contacts', 'recruitment_offers', 'recruitment_requests', 'regulatory_consent_history', 'regulatory_consent_policy_versions', 'regulatory_consent_regarding', 'regulatory_consent_revocations', 'regulatory_consent_rule_ids', 'regulatory_consents', 'regulatory_review_evidence_refs', 'regulatory_review_history', 'regulatory_review_policy_versions', 'regulatory_review_reason_items', 'regulatory_review_reasons', 'regulatory_reviews', 'reports', 'representation_agreements', 'reputation_seed', 'request_trial_slots', 'review_later', 'room_comment_mentions', 'room_comments', 'room_decision_assessment_ids', 'room_decision_evidence_refs', 'room_decision_reason_codes', 'room_decisions', 'room_evidence_states', 'room_snapshot_source_refs', 'room_snapshots', 'saved_searches', 'second_look_item_fingerprints', 'second_look_item_history', 'second_look_item_reasons', 'second_look_items', 'sessions', 'signing_documents', 'signing_history', 'signing_packages', 'signing_parties', 'signing_revision_parties', 'signing_revisions', 'signings', 'source_changes', 'squad_invites', 'sso_configs', 'sso_states', 'support_access_grants', 'support_access_log', 'support_ticket_refs', 'support_ticket_replies', 'support_tickets', 'transaction_document_history', 'transaction_documents', 'transaction_history', 'transaction_history_policy_versions', 'transaction_history_reason_codes', 'transaction_keys', 'transaction_linked_threads', 'transaction_notes', 'transaction_parties', 'transaction_representation_history', 'transaction_representation_history_policy_versions', 'transaction_representation_scopes', 'transaction_representations', 'transaction_terms_versions', 'transition_case_history', 'transition_case_pack_items', 'transition_case_recipients', 'transition_cases', 'trial_attendance', 'trial_day_checkins', 'trial_day_consents', 'trial_day_staff', 'trial_day_status_events', 'trial_history', 'trial_keys', 'trial_reminders', 'trial_reports', 'trial_revision_sessions', 'trial_schedule_revisions', 'trial_schedule_sessions', 'trial_session_evidence', 'trials', 'ts_reviewer_history', 'ts_reviewers', 'upload_session_chunks', 'upload_sessions', 'vacancies', 'ver_admins', 'ver_claim_codes', 'ver_claim_evidence', 'ver_claims', 'ver_conflicts', 'ver_disputes', 'ver_domain_request_codes', 'ver_domain_requests', 'ver_events', 'ver_evidence', 'ver_migrations', 'ver_player_invites', 'ver_references', 'ver_root_request_codes', 'ver_root_requests', 'ver_root_transfers', 'ver_tokens', 'video_segment_labels', 'video_segments', 'vouches', 'watchlist_criteria', 'watchlist_criterion_values', 'watchlist_history', 'watchlist_member_checks', 'watchlist_members', 'watchlist_membership_events', 'webhook_deliveries', 'webhook_delivery_attempts', 'webhook_endpoint_events', 'webhook_endpoints'],
  });
  // There is no in-memory engine to report on: a missing connection is a programming error, not a mode.
  assert.throws(() => dataSchemaReport(null, DATA_MIGRATIONS), /needs a SQLite connection/);
});

// --------------------------------------------------------- read-only views
test('views: reads work as before; every write throws and names the repository', () => {
  const target = { id: 'u1', name: 'A', mfa: { recoveryHashes: ['h'] } };
  const rows = [target];
  const view = readonlyView(rows, 'a staff record');
  assert.equal(view.length, 1);
  assert.equal(view.find((u) => u.id === 'u1').name, 'A');
  assert.equal(JSON.stringify(view), JSON.stringify(rows));
  assert.ok(Array.isArray(view));
  assert.deepEqual({ ...view[0] }, target);
  assert.throws(() => { view[0].name = 'B'; }, /staff record.*repositories/);
  assert.throws(() => { view[0].mfa.recoveryHashes.splice(0, 1); }, /repositories/);
  assert.throws(() => { view[0].mfa.enabledAt = 1; }, /repositories/);
  assert.throws(() => { view.push({ id: 'u2' }); }, /repositories/);
  assert.throws(() => { delete view[0].name; }, /repositories/);
  assert.equal(target.name, 'A', 'the target is untouched');
  assert.equal(readonlyView(target), readonlyView(target), 'one view per target');
});

// -------------------------------------------------------- staff repository
test('repository: insert assigns the id, stores the row and refreshes the view', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const u = repo.insert({ orgId: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', id: 'ignored' });
  assert.match(u.id, /^usr-\d+$/);
  assert.equal(u.orgId, 'org-a');
  assert.ok(typeof u.createdAt === 'number');
  assert.equal(repo.view.length, 1);
  assert.equal(repo.view[0], u, 'the view holds the same object the caller got');
  const stored = s.prepare('SELECT id, org_id, name, role, email FROM org_users').all().map((r) => ({ ...r }));
  assert.deepEqual(stored, [{ id: u.id, org_id: 'org-a', name: 'Maria Keane', role: 'Head of Recruitment', email: null }]);
  assert.deepEqual(Object.keys({ ...u }).sort(), ['createdAt', 'id', 'name', 'orgId', 'role'], 'unset fields are absent, not null');
});
test('repository: insert refuses incomplete records', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  assert.throws(() => repo.insert({ name: 'X', role: 'Scout' }), /orgId/);
  assert.throws(() => repo.insert({ orgId: 'o', role: 'Scout' }), /name/);
  assert.throws(() => repo.insert({ orgId: 'o', name: 'X', role: ' ' }), /role/);
  assert.equal(repo.view.length, 0);
});
test('repository: update changes the row in place, null clears, undefined leaves alone, nested values are replaced whole', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const u = repo.insert({ orgId: 'org-a', name: 'Dee', role: 'Scout' });
  const same = repo.update(u.id, { role: 'Manager', email: 'dee@example.com', mfa: { secretB32: 'S', enabledAt: null, recoveryHashes: ['a', 'b'] }, name: undefined });
  assert.equal(same, u, 'callers holding the view see the change');
  assert.equal(u.role, 'Manager');
  assert.equal(u.email, 'dee@example.com');
  assert.deepEqual({ ...u.mfa }, { secretB32: 'S', enabledAt: null, recoveryHashes: ['a', 'b'] });
  repo.update(u.id, { mfa: { ...u.mfa, recoveryHashes: u.mfa.recoveryHashes.filter((h) => h !== 'a') } });
  assert.deepEqual([...u.mfa.recoveryHashes], ['b']);
  repo.update(u.id, { mfa: null, email: null });
  assert.equal('mfa' in { ...u }, false);
  assert.equal('email' in { ...u }, false);
  const stored = { ...s.prepare('SELECT role, email, mfa_json FROM org_users WHERE id = ?').get(u.id) };
  assert.deepEqual(stored, { role: 'Manager', email: null, mfa_json: null });
  assert.throws(() => repo.update('usr-nope', { role: 'x' }), /does not exist/);
  assert.throws(() => repo.update(u.id, { id: 'other' }), /never changes/);
});
test('repository: lookups by id, by organisation and by case-insensitive name', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const a = repo.insert({ orgId: 'org-a', name: 'Maria Keane', role: 'Scout' });
  repo.insert({ orgId: 'org-b', name: 'Maria Keane', role: 'Scout' });
  assert.equal(repo.byId(a.id), a);
  assert.equal(repo.byId('missing'), null);
  assert.equal(repo.byId(undefined), null);
  assert.equal(repo.byOrgAndName('org-a', '  maria keane '), a);
  assert.equal(repo.byOrgAndName('org-c', 'Maria Keane'), null);
  assert.equal(repo.byOrgAndName('org-a', ''), null);
  assert.equal(repo.listByOrg('org-a').length, 1);
  assert.equal(repo.count(), 2);
});
test('repository: a table row survives a new process while the id counter is behind — ids are skipped, never reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-users-'));
  const file = path.join(dir, 'x.db');
  let s = new DatabaseSync(file); runDataMigrations(s, DATA_MIGRATIONS); seedOrgs(s);
  let local = 1000; const ids = (p) => `${p}-${++local}`;
  let repo = createUsersRepository({ sqlite: s, nextId: ids, persist: () => {} }); repo.attach([]);
  const first = repo.insert({ orgId: 'o', name: 'One', role: 'Scout' });
  s.close();
  // "Restart" with the counter reset, as after an abrupt stop before the snapshot saved it.
  s = new DatabaseSync(file); local = 1000;
  repo = createUsersRepository({ sqlite: s, nextId: ids, persist: () => {} });
  const boot = repo.attach([]);
  assert.deepEqual(boot, { engine: 'sqlite', loaded: 1, imported: 0 });
  assert.equal(repo.view[0].name, 'One');
  const second = repo.insert({ orgId: 'o', name: 'Two', role: 'Scout' });
  assert.notEqual(second.id, first.id);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 2);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('repository: the in-memory (seed) array is imported once when the table is empty, every typed field kept and an unknown field dropped and reported by id, and ignored once the table has rows', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS); seedOrgs(s);
  const legacy = [
    { id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 5, email: 'a@x', ssoSubject: 'idp-1', mfa: { secretB32: 'S', enabledAt: 7, recoveryHashes: [] }, deliveryPrefs: { quietStart: '22:00' }, removedAt: 9, removedBy: 'B', oddField: { kept: true } },
    { id: 'usr-2', orgId: 'o', name: 'B', role: 'Manager', createdAt: 6 },
    null, { notARow: true },
  ];
  const warnings = [];
  const repo = createUsersRepository({ sqlite: s, nextId, persist: () => {}, warn: (m) => warnings.push(m) });
  const boot = repo.attach(legacy);
  assert.deepEqual(boot, { engine: 'sqlite', loaded: 2, imported: 2 });
  const { oddField: _dropped, ...typed } = legacy[0];
  assert.deepEqual(JSON.parse(JSON.stringify(repo.view[0])), typed, 'every typed field kept; the unknown field is not stored');
  assert.deepEqual(JSON.parse(JSON.stringify(repo.view[1])), legacy[1]);
  assert.ok(warnings.some((w) => w === 'org_users: staff usr-1: unknown field oddField dropped'), 'the drop is reported with the row id and field name');
  assert.ok(!warnings.some((w) => /kept/.test(w)), 'the report never carries the value');
  // A blob whose rows the table already holds is superseded (S2's cutover
  // imports it into the table a moment before attach): a log line, no warning.
  const logs = [];
  const again = createUsersRepository({ sqlite: s, nextId, persist: () => {}, warn: (m) => warnings.push(m), log: (m) => logs.push(m) });
  assert.deepEqual(again.attach(legacy), { engine: 'sqlite', loaded: 2, imported: 0 });
  assert.ok(!warnings.some((w) => /stale users blob/.test(w)), 'a superseded blob is not stale');
  assert.ok(logs.some((m) => /superseded by the table/.test(m)));
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 2);
  // A blob naming a row the table does not hold is stale: it is warned about,
  // never imported over the table.
  const third = createUsersRepository({ sqlite: s, nextId, persist: () => {}, warn: (m) => warnings.push(m) });
  assert.deepEqual(third.attach([...legacy, { id: 'usr-ghost', orgId: 'o', name: 'Ghost', role: 'Scout', createdAt: 1 }]), { engine: 'sqlite', loaded: 2, imported: 0 });
  assert.ok(warnings.some((w) => /stale users blob with 1 row\(s\)/.test(w)));
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 2);
  assert.equal(third.byId('usr-ghost'), null);
});
test('repository: typed fields only — an unknown key is not stored, a wrong-typed value is refused by name and nothing is written', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS);
  const repo = repoOn(s);
  const u = repo.insert({ orgId: 'org-a', name: 'Dee', role: 'Scout', colour: 'red' });
  assert.equal('colour' in { ...u }, false, 'an unknown key on insert is not stored');
  repo.update(u.id, { colour: 'blue', email: 'dee@example.com' });
  assert.equal('colour' in { ...u }, false, 'an unknown key on update is not stored');
  assert.equal(u.email, 'dee@example.com', 'the known field in the same patch is');
  assert.throws(() => repo.insert({ orgId: 'org-a', name: 'Eve', role: 'Scout', email: ['eve@example.com'] }), /email must be text/);
  assert.throws(() => repo.update(u.id, { createdAt: '5' }), /createdAt must be an integer/);
  assert.throws(() => repo.update(u.id, { mfa: 'on' }), /mfa must be an object/);
  assert.equal(repo.view.length, 1); assert.equal(typeof u.createdAt, 'number');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 1);
});
test('snapshot write and array import: the snapshot write stores no unknown key and refuses a wrong-typed field by code, id and field; the array import drops it and reports it', () => {
  const s = fresh(); runDataMigrations(s, DATA_MIGRATIONS); seedOrgs(s);
  assert.equal(USERS_TABLE.replace(s, [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1, futureField: { x: 1 } }]), true);
  assert.deepEqual(USERS_TABLE.read(s), [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }]);
  assert.throws(() => USERS_TABLE.replace(s, [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }, { id: 'usr-2', orgId: 'o', name: 'B', email: 42 }]), (e) => /^ORG_USERS_SNAPSHOT_INVALID: staff usr-2: email must be text$/.test(e.message));
  assert.deepEqual(USERS_TABLE.read(s).map((u) => u.id), ['usr-1'], 'nothing of the refused write landed');
  s.prepare('DELETE FROM org_users').run();
  const r = USERS_TABLE.importLegacy(s, [{ id: 'usr-3', orgId: 'o', name: 'C', role: 7, createdAt: 2, oddField: 1 }, { id: 'usr-4', orgId: 'o', name: 'D', role: 'Scout' }, { id: 'usr-3', orgId: 'o', name: 'C2' }, { name: 'no id' }]);
  assert.deepEqual(r, { imported: 2, skipped: 2, normalised: 1, notes: ['staff usr-3: role must be text; dropped', 'staff usr-3: unknown field oddField dropped', 'staff usr-3: duplicate id; the later entry skipped'] });
  assert.deepEqual(USERS_TABLE.read(s), [{ id: 'usr-3', orgId: 'o', name: 'C', createdAt: 2 }, { id: 'usr-4', orgId: 'o', name: 'D', role: 'Scout' }]);
});
test('repository: without sqlite there is no in-memory mode — construction refuses with a clear error before any data is touched', () => {
  // S2 removed the JSON/in-memory fallback: sessions cannot be kept outside a
  // table without storing plain tokens again, so the whole data layer requires
  // node:sqlite and says so (store.mjs refuses to open at all without it).
  assert.throws(() => createUsersRepository({ sqlite: null, nextId }), /needs a SQLite connection/);
  assert.throws(() => attachDataLayer({ db: { users: [] }, store: { sqlite: null }, nextId, sessionTtlMs: 1000 }), /needs a store with a SQLite connection/);
});

// ------------------------------------------------------ attach + store
test('attachDataLayer: db.users becomes the repository view and cannot be replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-layer-'));
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  // Staff are never seeded (S14a: there is no users array to import); they are written through the repository.
  const layer = attachDataLayer({ db, seed: { orgs: [ORG_O] }, store, nextId, persist: () => {} });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', loaded: 0, imported: 0 });
  layer.users.insert({ orgId: 'o', name: 'A', role: 'Scout' });
  assert.equal(db.users.length, 1);
  assert.throws(() => { db.users = []; }, TypeError);
  assert.throws(() => { db.users.push({}); }, /repositories/);
  assert.equal(layer.report().domains.users.rows, 1);
  // Every core identity table is live (S0–S4a) and the media-deletion queue exists; there is no shadow to report.
  assert.deepEqual(layer.report().tables, ['agency_affiliation_history', 'agency_affiliation_history_tiers', 'agency_affiliation_tiers', 'agency_affiliations', 'agent_profile_facets', 'agent_profile_history', 'agent_profile_jurisdictions', 'agent_profiles', 'agent_transaction_jurisdictions', 'agent_transactions', 'agreement_history', 'agreement_opportunity_shares', 'agreement_policy_versions', 'agreement_scopes', 'api_key_scopes', 'api_keys', 'application_history', 'application_suitability', 'applications', 'assessment_history', 'assessment_rating_refs', 'assessment_ratings', 'assessment_template_attributes', 'assessment_templates', 'assessments', 'blocks', 'box_assignments', 'box_cam_cv_result_codes', 'box_cam_cv_result_trace', 'box_cam_cv_results', 'box_cam_disputes', 'box_cam_prefs', 'box_challenge_entries', 'box_challenges', 'box_session_integrity_events', 'box_session_observations', 'box_session_reasons', 'box_sessions', 'calibration_notes', 'calibration_participants', 'calibration_ratings', 'calibration_sessions', 'calibration_submissions', 'campaign_attempt_issues', 'campaign_attempts', 'campaign_drills', 'campaign_rubric', 'campaign_submissions', 'campaigns', 'case_approvals', 'case_assignments', 'case_budget_actuals', 'case_budget_fx_assumptions', 'case_budget_lines', 'case_budget_scenarios', 'case_decision_draft_evidence_refs', 'case_decision_draft_reason_codes', 'case_decision_drafts', 'case_history', 'case_request_links', 'case_room_tags', 'case_tasks', 'case_transaction_handoffs', 'case_trial_links', 'channels', 'coach_affiliation_history', 'coach_affiliations', 'combine_attempt_calibration_checks', 'combine_attempt_reasons', 'combine_attempts', 'combine_request_protocols', 'combine_requests', 'compliance_context_history', 'compliance_context_history_policy_versions', 'compliance_context_jurisdictions', 'compliance_context_parties', 'compliance_context_representations', 'compliance_context_resolved_facts', 'compliance_contexts', 'compliance_evaluation_consents_outstanding', 'compliance_evaluation_policy_versions', 'compliance_evaluation_reason_items', 'compliance_evaluation_reasons', 'compliance_evaluation_snapshot_parties', 'compliance_evaluation_snapshot_representations', 'compliance_evaluations', 'contact_attempts', 'contact_history', 'coverage_assignment_targets', 'coverage_assignment_warnings', 'coverage_assignments', 'coverage_plans', 'delivery_callbacks_seen', 'delivery_centre', 'delivery_fail_injections', 'dev_objective_item_evidence', 'dev_objective_item_exercises', 'dev_objective_items', 'dev_objective_progress', 'dev_objective_reassessment_evidence', 'dev_objective_reassessments', 'dev_objective_shares', 'dev_objectives', 'development_actions', 'development_evidence_links', 'development_goals', 'development_history', 'development_plan_shares', 'development_plans', 'development_review_snapshot_refs', 'development_review_snapshots', 'development_reviews', 'dispatch_attempts', 'dispatches', 'drill_guidance', 'dynamic_watchlists', 'email_challenges', 'evidence', 'evidence_disputes', 'evidence_history', 'evidence_media', 'evidence_suggestion_records', 'evidence_suggestions', 'exposure_events', 'fixtures', 'follow_ups', 'friendlies', 'friendly_responses', 'group_grant_recipients', 'group_grants', 'group_members', 'group_pending_invites', 'group_programmes', 'group_shared_templates', 'groups', 'guardian_children', 'guardians', 'idempotency_keys', 'identity_reviews', 'idv_queue', 'import_batch_columns', 'import_batch_created_prospects', 'import_batch_history', 'import_batch_row_errors', 'import_batch_rows', 'import_batches', 'invoices', 'jurisdiction_policies', 'jurisdiction_policy_history', 'jurisdiction_policy_publishers', 'jurisdiction_policy_rule_overrides', 'jurisdiction_policy_rule_param_items', 'jurisdiction_policy_rule_params', 'jurisdiction_policy_rule_sources', 'jurisdiction_policy_rules', 'ledger', 'ledger_protocols', 'matchday_players', 'matchdays', 'media_deletions', 'message_attachments', 'messages', 'moderation_flags', 'moderation_log', 'nobody_missed_review_history', 'nobody_missed_reviews', 'notification_pref_categories', 'notification_prefs', 'notifications', 'offer_history', 'offer_keys', 'offer_read_receipts', 'offer_responses', 'offer_revision_documents', 'offer_revisions', 'open_trial_positions', 'open_trial_registrations', 'open_trials', 'opportunities', 'opportunity_texts', 'opportunity_training_slots', 'ops_events', 'org_agency_jurisdictions', 'org_agency_settings', 'org_federation_checks', 'org_invites', 'org_looking_for', 'org_notes', 'org_shadow_players', 'org_squad_members', 'org_tactical_role_criteria', 'org_tactical_roles', 'org_tactical_setups', 'org_tactical_windows', 'org_users', 'org_verified_domains', 'orgs', 'outbox', 'outcome_report_confirmations', 'outcome_reports', 'pairing_codes', 'passport_achievements', 'passport_career_entries', 'passport_corrections', 'passport_position_history', 'passport_position_history_positions', 'passport_pref_positions', 'passport_prefs', 'passport_public_selections', 'passport_shares', 'player_activity_log', 'player_attendance', 'player_badges', 'player_drill_results', 'player_drills', 'player_external_ids', 'player_media', 'player_media_tags', 'player_medical_records', 'player_pref_slots', 'player_pref_texts', 'player_prefs', 'player_programme_completions', 'player_season_history', 'player_timeline', 'players', 'playlist_segments', 'playlists', 'prospects', 'push_log', 'push_tokens', 'recruitment_brief_history', 'recruitment_brief_values', 'recruitment_briefs', 'recruitment_cases', 'recruitment_contacts', 'recruitment_offers', 'recruitment_requests', 'regulatory_consent_history', 'regulatory_consent_policy_versions', 'regulatory_consent_regarding', 'regulatory_consent_revocations', 'regulatory_consent_rule_ids', 'regulatory_consents', 'regulatory_review_evidence_refs', 'regulatory_review_history', 'regulatory_review_policy_versions', 'regulatory_review_reason_items', 'regulatory_review_reasons', 'regulatory_reviews', 'reports', 'representation_agreements', 'reputation_seed', 'request_trial_slots', 'review_later', 'room_comment_mentions', 'room_comments', 'room_decision_assessment_ids', 'room_decision_evidence_refs', 'room_decision_reason_codes', 'room_decisions', 'room_evidence_states', 'room_snapshot_source_refs', 'room_snapshots', 'saved_searches', 'second_look_item_fingerprints', 'second_look_item_history', 'second_look_item_reasons', 'second_look_items', 'sessions', 'signing_documents', 'signing_history', 'signing_packages', 'signing_parties', 'signing_revision_parties', 'signing_revisions', 'signings', 'source_changes', 'squad_invites', 'sso_configs', 'sso_states', 'support_access_grants', 'support_access_log', 'support_ticket_refs', 'support_ticket_replies', 'support_tickets', 'transaction_document_history', 'transaction_documents', 'transaction_history', 'transaction_history_policy_versions', 'transaction_history_reason_codes', 'transaction_keys', 'transaction_linked_threads', 'transaction_notes', 'transaction_parties', 'transaction_representation_history', 'transaction_representation_history_policy_versions', 'transaction_representation_scopes', 'transaction_representations', 'transaction_terms_versions', 'transition_case_history', 'transition_case_pack_items', 'transition_case_recipients', 'transition_cases', 'trial_attendance', 'trial_day_checkins', 'trial_day_consents', 'trial_day_staff', 'trial_day_status_events', 'trial_history', 'trial_keys', 'trial_reminders', 'trial_reports', 'trial_revision_sessions', 'trial_schedule_revisions', 'trial_schedule_sessions', 'trial_session_evidence', 'trials', 'ts_reviewer_history', 'ts_reviewers', 'upload_session_chunks', 'upload_sessions', 'vacancies', 'ver_admins', 'ver_claim_codes', 'ver_claim_evidence', 'ver_claims', 'ver_conflicts', 'ver_disputes', 'ver_domain_request_codes', 'ver_domain_requests', 'ver_events', 'ver_evidence', 'ver_migrations', 'ver_player_invites', 'ver_references', 'ver_root_request_codes', 'ver_root_requests', 'ver_root_transfers', 'ver_tokens', 'video_segment_labels', 'video_segments', 'vouches', 'watchlist_criteria', 'watchlist_criterion_values', 'watchlist_history', 'watchlist_member_checks', 'watchlist_members', 'watchlist_membership_events', 'webhook_deliveries', 'webhook_delivery_attempts', 'webhook_endpoint_events', 'webhook_endpoints'].sort()); // S9d: the fifteen opportunity, application, campaign and preference tables; S9c: the nine club setup tables; S9b: the ten assessment, segment and playlist tables; S9a: the seven evidence, affiliation and invitation tables; S8a: the sixteen request and trial tables; S8b: the twenty-five case and room tables and the shared idempotency_keys; S8c: the ten contact and offer tables
  assert.equal('shadow' in layer.report(), false, 'the projection is retired');
  assert.deepEqual(layer.report().identity, { initState: 'done' });
  assert.deepEqual(layer.report().mediaDeletions, { queued: 0, conflicts: 0 });
  for (const name of ['players', 'guardians']) {
    assert.throws(() => { db[name] = []; }, TypeError, `${name} cannot be replaced`);
    assert.throws(() => { db[name].push({ id: 'x' }); }, /repositories/, `${name} is a read-only view`);
  }
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store: a snapshot that carries players without guardians, or a collection with no table, is refused and nothing is written; server mode neither loads nor writes snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));
  const PLAYER = { id: 'p', name: 'P', dob: '2001-01-01', country: 'GB', medical: { shared: false, records: [], conditionStatus: 'unknown' } };
  let store = openStore(dir);
  // (A snapshot that carries players carries guardians: the identity pair is coupled, see checkTableBackedShapes.)
  assert.throws(() => store.save({ idCounter: 1000, db: { players: [PLAYER], users: [] } }), /players: a snapshot that carries players must carry guardians too/);
  // Rewritten in S14a: a collection without a table used to become a blob; now it is refused and nothing lands.
  assert.throws(() => store.save({ idCounter: 1001, db: { players: [PLAYER], guardians: [], notes: [{ id: 'n1' }] } }), (e) => e.code === 'SNAPSHOT_COLLECTION_UNKNOWN' && /notes/.test(e.message));
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0, 'nothing of the refused snapshot landed');
  assert.equal(hasBlobTable(store.sqlite), false, 'there is no blob table');
  store.sqlite.close();
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  attachDataLayer({ db: {}, store, nextId, persist: () => {} });
  store.save();
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0, 'a server-mode save leaves the tables to their repositories');
  assert.throws(() => store.load(), /snapshot mode operation/);
  store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (snapshot mode): load merges table-backed collections in from their tables and save writes them back there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-snap-'));
  // A server boot: the table exists and holds one row; the blob is gone.
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const PLAYER = { id: 'p', name: 'P', dob: '2001-01-01', country: 'GB', medical: { shared: false, records: [], conditionStatus: 'unknown' } };
  const db = {};
  const first = attachDataLayer({ db, seed: { players: [PLAYER], guardians: [], orgs: [ORG_O] }, store: server, nextId, persist: () => {} });
  const usr1 = first.users.insert({ orgId: 'o', name: 'A', role: 'Scout' });
  server.save();
  server.sqlite.close();
  // A tool reading the file as one snapshot sees the staff rows as before, and the players from their table (S4a).
  const tool = openStore(dir);
  const snap = tool.load();
  assert.deepEqual(snap.db.users, [{ id: usr1.id, orgId: 'o', name: 'A', role: 'Scout', createdAt: usr1.createdAt }]);
  assert.deepEqual(snap.db.players, [{ ...PLAYER, firstTeamSeeker: false, notificationPrefs: null, programme: null, media: [], attendance: [], timeline: [], badges: [], drills: [], drillResults: [], activityLog: [], externalIds: [], seasonHistory: [] }]); // the creation defaults (§4.3.1: set when a player is created, not by a boot pass); every sub-record array is on every record (S5 typed tables)
  assert.deepEqual(snap.db.guardians, []);
  // Writing a changed snapshot lands in the table, not in a blob.
  snap.db.users.push({ id: 'usr-2', orgId: 'o', name: 'B', role: 'Manager', createdAt: 2, mfa: { secretB32: 'S', enabledAt: 3, recoveryHashes: [] } });
  snap.db.users[0].role = 'Director';
  tool.save(snap);
  assert.equal(hasBlobTable(tool.sqlite), false, 'rewritten in S14a: every collection is a table; there is no blob');
  assert.deepEqual(tool.sqlite.prepare('SELECT id, role, mfa_json FROM org_users ORDER BY rowid').all().map((r) => ({ ...r })),
    [{ id: usr1.id, role: 'Director', mfa_json: null }, { id: 'usr-2', role: 'Manager', mfa_json: '{"secretB32":"S","enabledAt":3,"recoveryHashes":[]}' }]);
  tool.sqlite.close();
  // And the next server boot reads exactly that.
  const again = openStore(dir, { tableBacked: TABLE_BACKED });
  const db2 = {};
  const layer = attachDataLayer({ db: db2, store: again, nextId, persist: () => {} });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', loaded: 2, imported: 0 });
  assert.equal(db2.users[0].role, 'Director');
  assert.equal(db2.users[1].mfa.enabledAt, 3);
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 1, guardians: 0, links: 0, imported: 0 }, 'the player row attached from the table');
  assert.equal(db2.players[0].name, 'P');
  again.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('store (snapshot mode): a fixture saved into a new directory is written into the tables, and the first boot attaches to them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fixture-'));
  const tool = openStore(dir);
  tool.save({ idCounter: 1000, db: { players: [], guardians: [], orgs: [ORG_O], users: [{ id: 'usr-1', orgId: 'o', name: 'A', role: 'Scout', createdAt: 1 }] } });
  assert.equal(hasBlobTable(tool.sqlite), false, 'no blob: every collection of the fixture has a table');
  assert.equal(tool.sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n, 1);
  tool.sqlite.close();
  const server = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  const layer = attachDataLayer({ db, store: server, nextId, persist: () => {} });
  assert.deepEqual(layer.boot.users, { engine: 'sqlite', loaded: 1, imported: 0 });
  assert.equal(db.users[0].name, 'A');
  // A saved snapshot is never a first installation: the identity tables are attached, not seeded.
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 0, guardians: 0, links: 0, imported: 0 });
  assert.equal(layer.report().identity.initState, 'done');
  server.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} data-layer checks passed`);
