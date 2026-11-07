/**
 * The data layer: every domain's tables in one SQLite file, each owned by one repository. `attachDataLayer` runs the
 * table migrations and attaches the repositories (see its comment).
 *
 * Order at boot (server.mjs): open the store → attachDataLayer (migrations, then organisations → identity → staff →
 * sessions → the rest, so every repository that references another finds its rows in place on a first
 * installation) → module registration → listen.
 *
 * Whole-database access for tools and the persistence suites (snapshot mode, `openStore(dir)`): `readTableBacked`
 * and `writeTableBacked` read and write every collection as plain arrays in the shape the server sees.
 *
 * This directory is `repositories/`, not `data/`: `data/` is the server's
 * runtime data directory (DATA_DIR), which tests delete between runs.
 */
import { runDataMigrations, dataSchemaReport } from './database.mjs';
import { createUsersRepository, USERS_TABLE } from './users.mjs';
import { createSessionsRepository, SESSIONS_TABLE } from './sessions.mjs';
import { createOrgsRepository, ORGS_TABLE, ORGS_INIT_META } from './orgs.mjs';
import { createIdentityRepositories, refreshProfileSignals, CORE_IDENTITY_INIT_META, IDENTITY_SNAPSHOT, IDENTITY_COLLECTIONS, PLAYERS_RETAINED, PLAYER_ERASURE_MIGRATION } from './identity.mjs';
import { createMediaDeletionsQueue, MEDIA_DELETIONS_TABLE, MEDIA_DELETIONS_MIGRATION, assertMediaQueueConsistent } from './mediaDeletions.mjs';
import * as m0001 from './migrations/0001_org_users.mjs';
import * as m0002 from './migrations/0002_core_identity_shadow.mjs';
import * as m0003 from './migrations/0003_sessions_live.mjs';
import * as m0004 from './migrations/0004_orgs_live.mjs';
import * as m0005 from './migrations/0005_core_identity_live.mjs';
import * as m0006 from './migrations/0006_media_deletions.mjs';
import * as m0007 from './migrations/0007_player_subrecords.mjs';
import * as m0008 from './migrations/0008_one_time_codes.mjs';
import * as m0009 from './migrations/0009_notifications.mjs';
import * as m0010 from './migrations/0010_dispatches.mjs';
import * as m0011 from './migrations/0011_outbox_push.mjs';
import * as m0012 from './migrations/0012_channels.mjs';
import * as m0013 from './migrations/0013_safety_audit.mjs';
import * as m0014 from './migrations/0014_player_erasure.mjs';
import * as m0015 from './migrations/0015_recruitment.mjs';
import * as m0016 from './migrations/0016_recruitment_cases.mjs';
import * as m0017 from './migrations/0017_recruitment_contacts_offers.mjs';
import * as m0018 from './migrations/0018_signings_follow_ups.mjs';
import * as m0019 from './migrations/0019_scouting_evidence.mjs';
import * as m0020 from './migrations/0020_scouting_assessments.mjs';
import * as m0021 from './migrations/0021_club_setup.mjs';
import * as m0022 from './migrations/0022_opportunities_campaigns.mjs';
import * as m0023 from './migrations/0023_verification.mjs';
import * as m0024 from './migrations/0024_passport.mjs';
import * as m0025 from './migrations/0025_transitions_vouches.mjs';
import * as m0026 from './migrations/0026_agent_core.mjs';
import * as m0027 from './migrations/0027_compliance_policies.mjs';
import * as m0028 from './migrations/0028_compliance_records.mjs';
import * as m0029 from './migrations/0029_agent_transactions.mjs';
import * as m0030 from './migrations/0030_development.mjs';
import * as m0031 from './migrations/0031_box_cam.mjs';
import * as m0032 from './migrations/0032_discovery.mjs';
import * as m0033 from './migrations/0033_insight_coverage.mjs';
import * as m0034 from './migrations/0034_integrations.mjs';
import * as m0035 from './migrations/0035_enterprise.mjs';
import * as m0036 from './migrations/0036_groups.mjs';
import * as m0037 from './migrations/0037_grassroots.mjs';
import * as m0038 from './migrations/0038_operations.mjs';
import * as m0039 from './migrations/0039_retire_blob.mjs';
import { createRecruitmentRepository, RECRUITMENT_SNAPSHOT, RECRUITMENT_COLLECTIONS, RECRUITMENT_MIGRATION, assertRecruitmentConsistent, unresolvedPlayerReferences as unresolvedRecruitmentPlayers, retainedPlayerReferences as retainedRecruitmentPlayers } from './recruitment.mjs';
import { createRecruitmentCasesRepository, RECRUITMENT_CASES_SNAPSHOT, RECRUITMENT_CASES_COLLECTIONS, RECRUITMENT_CASES_MIGRATION, unresolvedPlayerReferences as unresolvedCasePlayers, retainedPlayerReferences as retainedCasePlayers } from './recruitmentCases.mjs';
import { createRecruitmentContactsOffersRepository, CONTACTS_OFFERS_SNAPSHOT, RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS, RECRUITMENT_CONTACTS_OFFERS_MIGRATION, unresolvedPlayerReferences as unresolvedContactOfferPlayers, retainedPlayerReferences as retainedContactOfferPlayers } from './recruitmentContactsOffers.mjs';
import { createSigningsFollowUpsRepository, SIGNINGS_FOLLOWUPS_SNAPSHOT, SIGNINGS_FOLLOWUPS_COLLECTIONS, SIGNINGS_FOLLOWUPS_MIGRATION, unresolvedPlayerReferences as unresolvedSigningPlayers, retainedPlayerReferences as retainedSigningPlayers } from './signingsFollowUps.mjs';
import { createScoutingEvidenceRepository, SCOUTING_EVIDENCE_SNAPSHOT, SCOUTING_EVIDENCE_COLLECTIONS, unresolvedPlayerReferences as unresolvedEvidencePlayers, retainedPlayerReferences as retainedEvidencePlayers } from './scoutingEvidence.mjs';
import { createScoutingAssessmentsRepository, SCOUTING_ASSESSMENTS_SNAPSHOT, SCOUTING_ASSESSMENTS_COLLECTIONS, unresolvedPlayerReferences as unresolvedAssessmentPlayers, retainedPlayerReferences as retainedAssessmentPlayers } from './scoutingAssessments.mjs';
import { createClubSetupRepository, CLUB_SETUP_SNAPSHOT, CLUB_SETUP_COLLECTIONS, unresolvedPlayerReferences as unresolvedClubSetupPlayers, retainedPlayerReferences as retainedClubSetupPlayers } from './clubSetup.mjs';
import { createOpportunitiesCampaignsRepository, OPPORTUNITIES_CAMPAIGNS_SNAPSHOT, OPPORTUNITIES_CAMPAIGNS_COLLECTIONS, unresolvedPlayerReferences as unresolvedOpportunityPlayers, retainedPlayerReferences as retainedOpportunityPlayers } from './opportunitiesCampaigns.mjs';
import { createVerificationRepository, VERIFICATION_SNAPSHOT, VERIFICATION_COLLECTIONS, VERIFICATION_RETIRED, unresolvedPlayerReferences as unresolvedVerificationPlayers, retainedPlayerReferences as retainedVerificationPlayers } from './verification.mjs';
import { createPassportRepository, PASSPORT_SNAPSHOT, PASSPORT_COLLECTIONS, unresolvedPlayerReferences as unresolvedPassportPlayers, retainedPlayerReferences as retainedPassportPlayers } from './passport.mjs';
import { createAgentCoreRepository, AGENT_CORE_SNAPSHOT, AGENT_CORE_COLLECTIONS, unresolvedPlayerReferences as unresolvedAgentPlayers, retainedPlayerReferences as retainedAgentPlayers } from './agentCore.mjs';
import { createCompliancePoliciesRepository, COMPLIANCE_POLICIES_SNAPSHOT, COMPLIANCE_POLICIES_COLLECTIONS } from './compliancePolicies.mjs';
import { createComplianceRecordsRepository, COMPLIANCE_RECORDS_SNAPSHOT, COMPLIANCE_RECORDS_COLLECTIONS, unresolvedPlayerReferences as unresolvedCompliancePlayers } from './complianceRecords.mjs';
import { createAgentTransactionsRepository, AGENT_TRANSACTIONS_SNAPSHOT, AGENT_TRANSACTIONS_COLLECTIONS, unresolvedPlayerReferences as unresolvedTransactionPlayers } from './agentTransactions.mjs';
import { createDevelopmentRepository, DEVELOPMENT_SNAPSHOT, DEVELOPMENT_COLLECTIONS, unresolvedPlayerReferences as unresolvedDevelopmentPlayers } from './development.mjs';
import { createBoxCamRepository, BOX_CAM_SNAPSHOT, BOX_CAM_COLLECTIONS, BOX_CAM_RETIRED, unresolvedPlayerReferences as unresolvedBoxCamPlayers } from './boxCam.mjs';
import { createDiscoveryRepository, DISCOVERY_SNAPSHOT, DISCOVERY_COLLECTIONS, unresolvedPlayerReferences as unresolvedDiscoveryPlayers } from './discovery.mjs';
import { createInsightCoverageRepository, INSIGHT_COVERAGE_SNAPSHOT, INSIGHT_COVERAGE_COLLECTIONS, unresolvedPlayerReferences as unresolvedInsightPlayers } from './insightCoverage.mjs';
import { createIntegrationsRepository, INTEGRATIONS_SNAPSHOT, INTEGRATIONS_COLLECTIONS, unresolvedPlayerReferences as unresolvedIntegrationPlayers } from './integrations.mjs';
import { createEnterpriseRepository, ENTERPRISE_SNAPSHOT, ENTERPRISE_COLLECTIONS } from './enterprise.mjs';
import { createGroupsRepository, GROUPS_SNAPSHOT, GROUPS_COLLECTIONS } from './groups.mjs';
import { createGrassrootsRepository, GRASSROOTS_SNAPSHOT, GRASSROOTS_COLLECTIONS } from './grassroots.mjs';
import { createOperationsRepository, OPERATIONS_SNAPSHOT, OPERATIONS_COLLECTIONS, OPERATIONS_SINGLETONS } from './operations.mjs';
import { createTransitionsVouchesRepository, TRANSITIONS_SNAPSHOT, TRANSITIONS_COLLECTIONS, unresolvedPlayerReferences as unresolvedTransitionPlayers, retainedPlayerReferences as retainedTransitionPlayers } from './transitionsVouches.mjs';
import { createOneTimeCodesRepository, EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE, ONE_TIME_CODES_MIGRATION, assertPairingCodesConsistent } from './oneTimeCodes.mjs';
import { createNotificationsRepository, NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE, NOTIFICATIONS_MIGRATION } from './notifications.mjs';
import { createDispatchesRepository, DISPATCHES_TABLE, DISPATCHES_MIGRATION } from './dispatches.mjs';
import { createOutboxPushRepository, OUTBOX_PUSH_SNAPSHOT_TABLES, OUTBOX_PUSH_COLLECTIONS, OUTBOX_PUSH_MIGRATION } from './outboxPush.mjs';
import { createChannelsRepository, CHANNELS_TABLE, CHANNELS_MIGRATION, assertChannelReferencesConsistent } from './channels.mjs';
import { createSafetyAuditRepository, AUDIT_COLLECTIONS, SAFETY_AUDIT_SNAPSHOT, SAFETY_AUDIT_MIGRATION, assertIdvQueueGuardiansConsistent, unresolvedPlayerReferences, retainedPlayerReferences } from './safetyAudit.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020, m0021, m0022, m0023, m0024, m0025, m0026, m0027, m0028, m0029, m0030, m0031, m0032, m0033, m0034, m0035, m0036, m0037, m0038, m0039]);

// Single-collection dispatchers, in snapshot-write order: organisations first
// (staff reference them), then staff (sessions reference them), then
// sessions. Deletions of rows a snapshot no longer lists (`prune`) run
// afterwards in reverse order. The identity pair (players + guardians, coupled
// through the link rows) is dispatched as ONE unit between organisations and
// staff (see `writeTableBacked`).
const TABLES = Object.freeze([ORGS_TABLE, USERS_TABLE, SESSIONS_TABLE]);

/** Every collection that has a table: what a snapshot-mode save may carry, and what `readTableBacked` returns. */
export const TABLE_BACKED = Object.freeze(['orgs', ...IDENTITY_COLLECTIONS, PLAYERS_RETAINED.name, 'users', 'sessions', MEDIA_DELETIONS_TABLE.name, EMAIL_CHALLENGES_TABLE.name, PAIRING_CODES_TABLE.name, NOTIFICATIONS_TABLE.name, NOTIFICATION_PREFS_TABLE.name, DISPATCHES_TABLE.name, ...OUTBOX_PUSH_SNAPSHOT_TABLES.map((t) => t.name), CHANNELS_TABLE.name, ...AUDIT_COLLECTIONS, ...RECRUITMENT_COLLECTIONS, ...RECRUITMENT_CASES_COLLECTIONS, ...RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS, ...SIGNINGS_FOLLOWUPS_COLLECTIONS, ...SCOUTING_EVIDENCE_COLLECTIONS, ...SCOUTING_ASSESSMENTS_COLLECTIONS, ...CLUB_SETUP_COLLECTIONS, ...OPPORTUNITIES_CAMPAIGNS_COLLECTIONS, ...VERIFICATION_COLLECTIONS, ...PASSPORT_COLLECTIONS, ...TRANSITIONS_COLLECTIONS, ...AGENT_CORE_COLLECTIONS, ...COMPLIANCE_POLICIES_COLLECTIONS, ...COMPLIANCE_RECORDS_COLLECTIONS, ...AGENT_TRANSACTIONS_COLLECTIONS, ...DEVELOPMENT_COLLECTIONS, ...BOX_CAM_COLLECTIONS, ...DISCOVERY_COLLECTIONS, ...INSIGHT_COVERAGE_COLLECTIONS, ...INTEGRATIONS_COLLECTIONS, ...ENTERPRISE_COLLECTIONS, ...GROUPS_COLLECTIONS, ...GRASSROOTS_COLLECTIONS, ...OPERATIONS_COLLECTIONS]);
/** The one-time-code tables, dispatched after the organisations are pruned (the challenge references its organisation) and after the identity pair (the final-state check reads the players). */
const CODE_TABLES = Object.freeze([EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE]);
/** The outbox and push tables: no reference to any other table, dispatched last. The dispatches and the notifications (staff and organisation keys) go before the prunes. */
const NOTIFICATION_TABLE_DISPATCH = Object.freeze([...OUTBOX_PUSH_SNAPSHOT_TABLES]);
/** The notifications and preferences (a staff audience is a RESTRICT key): written after the staff upsert, before the staff prune. */
const NOTIFICATION_FEED_TABLES = Object.freeze([NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE]);

/**
 * Whole-snapshot access for tools that read or write the database file as one
 * unit: backups, restores and the persistence suites. `readTableBacked` returns
 * every table-backed collection whose table is authoritative, as plain arrays
 * in the shape the server sees; `writeTableBacked` replaces the contents of
 * every such table from `db` and returns the names it wrote. The caller owns
 * the transaction (store.mjs refuses a collection with no table first).
 */
export function readTableBacked(sqlite) {
  const out = {};
  for (const table of TABLES) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  const identity = IDENTITY_SNAPSHOT.read(sqlite);
  if (identity) Object.assign(out, identity);
  const retained = PLAYERS_RETAINED.read(sqlite); // S4b-R: the retained records, under their own name, never inside `players`
  if (retained) out[PLAYERS_RETAINED.name] = retained;
  const queue = MEDIA_DELETIONS_TABLE.read(sqlite);
  if (queue) out[MEDIA_DELETIONS_TABLE.name] = queue;
  for (const table of [...CODE_TABLES, ...NOTIFICATION_FEED_TABLES, ...NOTIFICATION_TABLE_DISPATCH, DISPATCHES_TABLE, CHANNELS_TABLE]) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  const audit = SAFETY_AUDIT_SNAPSHOT.read(sqlite); // S6b, explicit since S14b: the eight audit collections (null before the 0013 record)
  if (audit) Object.assign(out, audit);
  const recruitment = RECRUITMENT_SNAPSHOT.read(sqlite); // S8a: requests and trials from their typed tables (null before the 0015 record)
  if (recruitment) Object.assign(out, recruitment);
  const cases = RECRUITMENT_CASES_SNAPSHOT.read(sqlite); // S8b: the five collections from their tables (null before the 0016 record)
  if (cases) Object.assign(out, cases);
  const contactsOffers = CONTACTS_OFFERS_SNAPSHOT.read(sqlite); // S8c: the two collections from their tables (null before the 0017 record)
  if (contactsOffers) Object.assign(out, contactsOffers);
  const signings = SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite); // S8d: the four typed collections from their tables (null before the 0018 record)
  if (signings) Object.assign(out, signings);
  const evidence = SCOUTING_EVIDENCE_SNAPSHOT.read(sqlite); // S9a: evidence, coach affiliations and squad invitations (null before the 0019 record)
  if (evidence) Object.assign(out, evidence);
  const assessments = SCOUTING_ASSESSMENTS_SNAPSHOT.read(sqlite); // S9b: assessment templates, assessments, video segments and playlists (null before the 0020 record)
  if (assessments) Object.assign(out, assessments);
  const clubSetup = CLUB_SETUP_SNAPSHOT.read(sqlite); // S9c: tactical setups, squads, shadow lists, looking-for, federation checks, vacancies (null before the 0021 record)
  if (clubSetup) Object.assign(out, clubSetup);
  const opportunitiesCampaigns = OPPORTUNITIES_CAMPAIGNS_SNAPSHOT.read(sqlite); // S9d: opportunities, applications, campaigns, submissions, player preferences (null before the 0022 record)
  if (opportunitiesCampaigns) Object.assign(out, opportunitiesCampaigns);
  const verification = VERIFICATION_SNAPSHOT.read(sqlite); // S10a: claims, events, evidence, tokens, administrators, applications, disputes, references, invitations, conflicts, domain requests, verified domains (null before the 0023 record)
  if (verification) Object.assign(out, verification);
  const passport = PASSPORT_SNAPSHOT.read(sqlite); // S10b: Passport preferences, career entries, achievements, shares, corrections (null before the 0024 record)
  if (passport) Object.assign(out, passport);
  const transitions = TRANSITIONS_SNAPSHOT.read(sqlite); // S10c: transition cases and coach references (null before the 0025 record)
  if (transitions) Object.assign(out, transitions);
  const agentCore = AGENT_CORE_SNAPSHOT.read(sqlite); // S11a: agent profiles, affiliations and agreements (null before the 0026 record)
  if (agentCore) Object.assign(out, agentCore);
  const compliancePolicies = COMPLIANCE_POLICIES_SNAPSHOT.read(sqlite); // S11b-1: Trust & Safety reviewers and policy versions (null before the 0027 record)
  if (compliancePolicies) Object.assign(out, compliancePolicies);
  const complianceRecords = COMPLIANCE_RECORDS_SNAPSHOT.read(sqlite); // S11b-2: compliance contexts (with evaluations), reviews and consents (null before the 0028 record)
  if (complianceRecords) Object.assign(out, complianceRecords);
  const agentTransactions = AGENT_TRANSACTIONS_SNAPSHOT.read(sqlite); // S11c: transactions, representation bindings and documents (null before the 0029 record)
  if (agentTransactions) Object.assign(out, agentTransactions);
  const development = DEVELOPMENT_SNAPSHOT.read(sqlite); // S12a: objectives, drill reviews and the Development Hub (null before the 0030 record)
  if (development) Object.assign(out, development);
  const boxCam = BOX_CAM_SNAPSHOT.read(sqlite); // S12b: Box Cam, Combine and CV results (null before the 0031 record)
  if (boxCam) Object.assign(out, boxCam);
  const discovery = DISCOVERY_SNAPSHOT.read(sqlite); // S12c: briefs, Nobody Missed, Second Look, watchlists (null before the 0032 record)
  if (discovery) Object.assign(out, discovery);
  const insight = INSIGHT_COVERAGE_SNAPSHOT.read(sqlite); // S12d: exposure, review-later, evidence gaps, calibration, coverage (null before the 0033 record)
  if (insight) Object.assign(out, insight);
  const integrations = INTEGRATIONS_SNAPSHOT.read(sqlite); // S13a: imports, prospects, identity reviews, API keys, webhooks (null before the 0034 record)
  if (integrations) Object.assign(out, integrations);
  const enterprise = ENTERPRISE_SNAPSHOT.read(sqlite); // S13b: staff invites, SSO, support tickets and access grants (null before the 0035 record)
  if (enterprise) Object.assign(out, enterprise);
  const groups = GROUPS_SNAPSHOT.read(sqlite); // S13c: group workspaces and group grants (null before the 0036 record)
  if (groups) Object.assign(out, groups);
  const grassroots = GRASSROOTS_SNAPSHOT.read(sqlite); // S13d: open days, match days and friendlies (null before the 0037 record)
  if (grassroots) Object.assign(out, grassroots);
  const operations = OPERATIONS_SNAPSHOT.read(sqlite); // S13e: uploads, saved searches, invoices, reputation seed, delivery bookkeeping (null before the 0038 record)
  if (operations) Object.assign(out, operations);
  return out;
}
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/**
 * Check the shape of every table-backed collection a snapshot carries, before
 * anything is dispatched to a table. A collection that
 * is absent (or `undefined`, which JSON cannot carry) is OMITTED: a partial
 * snapshot that leaves that domain alone. A collection that is present but
 * not an array — an object, null, a string, a number — is an explicitly
 * supplied invalid value and THROWS, so the caller's transaction rolls back
 * with nothing written. The identity pair is coupled: a
 * snapshot that carries `players` must carry `guardians` and vice versa (the
 * link rows derive from both), so one without the other THROWS too. Returns
 * the names that are present.
 */
export function checkTableBackedShapes(db) {
  const present = [];
  for (const name of TABLE_BACKED) {
    const value = db?.[name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new TypeError(`${name}: the snapshot collection must be an array of records (got ${describe(value)}); the save was rolled back and nothing was written`);
    present.push(name);
  }
  const identityPresent = IDENTITY_COLLECTIONS.filter((n) => present.includes(n));
  if (identityPresent.length === 1) throw new TypeError(`${identityPresent[0]}: a snapshot that carries ${identityPresent[0]} must carry ${IDENTITY_COLLECTIONS.find((n) => n !== identityPresent[0])} too (the guardian–child links derive from both collections); the save was rolled back and nothing was written`);
  return present;
}

export function writeTableBacked(sqlite, snapshot, { now = Date.now() } = {}) {
  const written = [];
  const present = checkTableBackedShapes(snapshot);
  const single = (name) => TABLES.find((t) => t.name === name);
  // `replace` THROWS on a row the table refuses, which rolls the caller's whole transaction back.
  if (present.includes('orgs') && single('orgs').replace(sqlite, snapshot.orgs, { now })) written.push('orgs');
  if (IDENTITY_COLLECTIONS.every((n) => present.includes(n)) && IDENTITY_SNAPSHOT.replace(sqlite, { players: snapshot.players, guardians: snapshot.guardians }, { now })) written.push(...IDENTITY_COLLECTIONS);
  // S4b-R: the retained records go right after the identity pair (which carried the
  // existing ones through its rewrite). PROTECTED (review of 6d66655, F1): a supplied
  // collection may only ADD records — every stored record must be listed unchanged or
  // the whole save is refused (ids only); new records are checked against the live rows
  // as they now stand; an omitted collection keeps the rows.
  if (present.includes(PLAYERS_RETAINED.name) && PLAYERS_RETAINED.replace(sqlite, snapshot[PLAYERS_RETAINED.name])) written.push(PLAYERS_RETAINED.name);
  // The staff rows are upserted here and pruned below, after the requests that name them
  // (S8a-core: recruitment_requests.user_id is a RESTRICT key); the sessions, which name
  // the staff, are written after that prune so a session of a staff member the snapshot
  // no longer lists is refused with its id, as before.
  if (present.includes('users') && single('users').replace(sqlite, snapshot.users, { prune: false })) written.push('users');
  // The media-removal queue: validated entry by entry and rewritten.
  if (present.includes(MEDIA_DELETIONS_TABLE.name) && MEDIA_DELETIONS_TABLE.replace(sqlite, snapshot[MEDIA_DELETIONS_TABLE.name])) written.push(MEDIA_DELETIONS_TABLE.name);
  // S6b (explicit since S14b): the audit collections, after the staff upsert and before the staff and organisation
  // prunes (their RESTRICT keys refuse a pruned organisation or staff member a kept audit row still names).
  written.push(...SAFETY_AUDIT_SNAPSHOT.replace(sqlite, snapshot));
  // S7d: the message threads are dispatched after the identity pair and the staff
  // (their guardians and organisations are then the snapshot's) and BEFORE the
  // organisation prune, so an organisation the snapshot removed while a thread
  // still names it is refused by the org foreign key at the prune (below) rather
  // than vanishing under its thread. The incoming rows' request references are
  // checked against the snapshot's `requests` when it carries them, the stored
  // requests otherwise.
  const requestsSupplied = Object.hasOwn(snapshot, 'requests') && snapshot.requests !== undefined;
  const trialsSupplied = Object.hasOwn(snapshot, 'trials') && snapshot.trials !== undefined;
  const casesSupplied = Object.hasOwn(snapshot, 'recruitmentCases') && snapshot.recruitmentCases !== undefined;
  // S8b (typed, explicit): the five case collections typed (junk refused with
  // ids; a supplied array IS the whole final collection, an omitted one is
  // retained whole), their references named against the FINAL combined state
  // (the supplied requests/trials included), and the cases (without their link
  // rows) and room rows written — BEFORE the S8a, S8c and S8d rows, whose case
  // keys are immediate. `null` before the 0016 record.
  // S8c: the supplied contacts and offers typed (junk refused with ids; a
  // supplied array IS the whole final collection, an omitted one is retained
  // WHOLE), the guardian references checked against the final guardians (Q8c-b),
  // and the records a supplied collection no longer lists removed. Their request
  // key is deferred to COMMIT; the assertion at the end names any miss.
  // S8d (design note §2; typed, explicit): the four collections typed — junk refused with ids, a legacy backup's
  // rows normalised as the cutover normalises them — and their departures removed children first, BEFORE the S8c
  // departures so a package can leave with its offer; a retained dependant of a departing row refuses the save with
  // ids (SIGNINGS_STILL_REFERENCED). The rows are written after the offers (below). `null` before the 0018 record.
  // S11c: the transactions name compliance contexts and evaluations, agreements, reviews, evidence and cases, which this
  // snapshot may rewrite: they are set aside first and written back (the snapshot's or the kept ones) after them.
  const keptTransactions = AGENT_TRANSACTIONS_SNAPSHOT.stash(sqlite);
  const signingsPlan = SIGNINGS_FOLLOWUPS_SNAPSHOT.begin(sqlite, snapshot, { label: 'the snapshot (signings, follow-ups and outcomes)' });
  if (signingsPlan) written.push(...signingsPlan.written);
  const contactsOffersPlan = CONTACTS_OFFERS_SNAPSHOT.begin(sqlite, snapshot, { guardians: IDENTITY_COLLECTIONS.every((n) => present.includes(n)) ? snapshot.guardians : undefined, label: 'the snapshot (contacts and offers)' });
  if (contactsOffersPlan) written.push(...contactsOffersPlan.written);
  const casesPlan = RECRUITMENT_CASES_SNAPSHOT.begin(sqlite, snapshot, { requests: requestsSupplied ? snapshot.requests : undefined, trials: trialsSupplied ? snapshot.trials : undefined, label: 'the snapshot (cases, rooms, requests and trials)' });
  if (casesPlan) written.push(...casesPlan.written);
  // S8a (typed, explicit): the supplied requests and trials typed (junk refused
  // with ids; a supplied array IS the whole final collection, an omitted one is
  // retained whole), the trials a supplied list no longer carries removed, the
  // records written — after the identity pair and the staff (the organisation
  // and staff keys) and BEFORE the channels (a thread's request_id is a real
  // key). Their case keys and the request's trial key are deferred to COMMIT;
  // the assertion at the end names any miss.
  if (requestsSupplied || trialsSupplied) written.push(...RECRUITMENT_SNAPSHOT.replace(sqlite, { requests: requestsSupplied ? snapshot.requests : undefined, trials: trialsSupplied ? snapshot.trials : undefined }, { label: 'the snapshot (requests and trials)' }));
  // S8c: the supplied contacts and offers written.
  CONTACTS_OFFERS_SNAPSHOT.write(sqlite, contactsOffersPlan);
  // S8d: the packages (their offers and cases are in place now), the signings, the follow-ups and the reports,
  // every reference and uniqueness rule of the FINAL combined state named with ids before the engine would.
  SIGNINGS_FOLLOWUPS_SNAPSHOT.write(sqlite, signingsPlan);
  // S8b: the supplied cases' link rows (their request and trial keys are
  // satisfied now).
  RECRUITMENT_CASES_SNAPSHOT.links(sqlite, casesPlan);
  // S9a: evidence, coach affiliations and squad invitations — typed, the final state's references and uniqueness named
  // with ids; after the organisations and staff are upserted and before they are pruned (their keys are RESTRICT).
  written.push(...SCOUTING_EVIDENCE_SNAPSHOT.replace(sqlite, snapshot));
  // S9b: assessment templates, assessments, video segments and playlists, the same way (their org and staff keys are RESTRICT).
  written.push(...SCOUTING_ASSESSMENTS_SNAPSHOT.replace(sqlite, snapshot));
  // S9c: a club's setup, the same way (its org keys are RESTRICT).
  written.push(...CLUB_SETUP_SNAPSHOT.replace(sqlite, snapshot));
  // S9d: opportunities, applications, campaigns and preferences, the same way (their org and staff keys are RESTRICT).
  written.push(...OPPORTUNITIES_CAMPAIGNS_SNAPSHOT.replace(sqlite, snapshot));
  // S10a: the verification domain, the same way (its org and staff keys are RESTRICT).
  written.push(...VERIFICATION_SNAPSHOT.replace(sqlite, snapshot));
  // S10b: the Passport's own records, the same way (a confirmation's organisation key is RESTRICT).
  written.push(...PASSPORT_SNAPSHOT.replace(sqlite, snapshot));
  // S10c: transition cases and coach references, the same way (a grant's and a placement's organisation keys are RESTRICT).
  written.push(...TRANSITIONS_SNAPSHOT.replace(sqlite, snapshot));
  // S11b-2: the compliance records name agreements, profiles, policies and reviewers: they are set aside while those
  // are rewritten, and written back (the snapshot's or the kept ones) after them.
  const keptCompliance = COMPLIANCE_RECORDS_SNAPSHOT.stash(sqlite);
  // S11a: the agent core, the same way (its agency and staff keys are RESTRICT).
  written.push(...AGENT_CORE_SNAPSHOT.replace(sqlite, snapshot));
  // S11b-1: reviewers and policy versions, the same way (a policy's proposer and approver are reviewer keys, RESTRICT).
  written.push(...COMPLIANCE_POLICIES_SNAPSHOT.replace(sqlite, snapshot));
  // S11b-2: contexts, reviews and consents, the same way (the three are rewritten together, in dependency order).
  written.push(...COMPLIANCE_RECORDS_SNAPSHOT.replace(sqlite, snapshot, { kept: keptCompliance }));
  // S11c: transactions, bindings and documents, the same way (their agency and staff keys are RESTRICT).
  written.push(...AGENT_TRANSACTIONS_SNAPSHOT.replace(sqlite, snapshot, { kept: keptTransactions }));
  // S12a: the development domain, the same way (its organisation and staff keys are RESTRICT; its own tables are
  // rewritten together, their keys running both ways).
  written.push(...DEVELOPMENT_SNAPSHOT.replace(sqlite, snapshot));
  // S12b: Box Cam, Combine and CV results, the same way (an assignment's organisation, staff and objective are RESTRICT).
  written.push(...BOX_CAM_SNAPSHOT.replace(sqlite, snapshot));
  // S12c: discovery, the same way (after the recruitment cases and decisions its items and reviews name).
  written.push(...DISCOVERY_SNAPSHOT.replace(sqlite, snapshot));
  // S12d: insight and coverage, the same way (after the assessment templates its calibration sessions name).
  written.push(...INSIGHT_COVERAGE_SNAPSHOT.replace(sqlite, snapshot));
  // S13a: integrations, the same way (its organisation and staff keys are RESTRICT).
  written.push(...INTEGRATIONS_SNAPSHOT.replace(sqlite, snapshot));
  // S13b: enterprise, the same way (its organisation and staff keys are RESTRICT).
  written.push(...ENTERPRISE_SNAPSHOT.replace(sqlite, snapshot));
  // S13c: groups and group grants, the same way (organisation keys RESTRICT).
  written.push(...GROUPS_SNAPSHOT.replace(sqlite, snapshot));
  // S13d: open days, match days and friendlies, the same way (organisation and staff keys RESTRICT).
  written.push(...GRASSROOTS_SNAPSHOT.replace(sqlite, snapshot));
  // S13e: the remaining operations collections, after the signings an invoice names (organisation, staff and signing keys RESTRICT).
  written.push(...OPERATIONS_SNAPSHOT.replace(sqlite, snapshot));
  if (present.includes(CHANNELS_TABLE.name) && CHANNELS_TABLE.replace(sqlite, snapshot[CHANNELS_TABLE.name])) written.push(CHANNELS_TABLE.name);
  // S14d: the dispatches, before the organisation prune (a staff audience's organisation is a RESTRICT key).
  if (present.includes(DISPATCHES_TABLE.name) && DISPATCHES_TABLE.replace(sqlite, snapshot[DISPATCHES_TABLE.name])) written.push(DISPATCHES_TABLE.name);
  // S14e: the notifications and preferences, before the staff prune (a staff audience is a RESTRICT key).
  for (const table of NOTIFICATION_FEED_TABLES) if (present.includes(table.name) && table.replace(sqlite, snapshot[table.name])) written.push(table.name);
  // Rows the snapshot no longer lists go last, children before parents, so a
  // parent that is still referenced makes the foreign key refuse the save
  // instead of the row disappearing under its dependants. (The identity pair
  // prunes inside its own replace, players before guardians.) S8b: the room
  // rows a supplied room collection no longer lists go first (before their
  // case). S8a: the requests no longer listed — after the channels (a thread
  // still naming one refuses the save; an intentional removal removes the
  // thread in the same snapshot) and before the staff and organisations they
  // reference. S8b: the cases no longer listed — after every request, trial,
  // contact, offer, signing and room row that named them (a retained one
  // refuses the save with ids), before the staff.
  RECRUITMENT_CASES_SNAPSHOT.pruneRooms(sqlite, casesPlan);
  if (written.includes('requests')) RECRUITMENT_SNAPSHOT.prune(sqlite, { requests: snapshot.requests, label: 'the snapshot (requests and channels together)' });
  RECRUITMENT_CASES_SNAPSHOT.pruneCases(sqlite, casesPlan, { label: 'the snapshot (cases and everything that names them)' });
  if (written.includes('users')) single('users').prune(sqlite, snapshot.users); // the staff no longer listed (their sessions cascade), after the requests and cases that named them
  if (present.includes('sessions') && single('sessions').replace(sqlite, snapshot.sessions)) written.push('sessions'); // against the FINAL staff rows
  for (const name of ['sessions', 'orgs']) {
    if (written.includes(name)) single(name).prune?.(sqlite, snapshot[name]);
  }
  // The ownership invariant on the FINAL combined state (review of 4ef9345):
  // whichever side this snapshot wrote — the identity pair, the queue, or both —
  // no queued removal may name a clip a live player still carries. A refusal
  // throws inside the caller's transaction, so the whole save rolls back,
  // unrelated changes included.
  // S14i: the profile figures against the FINAL players, lists and trial reports (the identity pair is written before the trials).
  if (written.some((n) => IDENTITY_COLLECTIONS.includes(n) || n === 'trials')) refreshProfileSignals(sqlite);
  if (written.some((n) => IDENTITY_COLLECTIONS.includes(n) || n === MEDIA_DELETIONS_TABLE.name)) assertMediaQueueConsistent(sqlite, { label: 'the snapshot (players and mediaDeletions together)' });
  // S6a: the one-time codes go after the prunes (a challenge of an organisation
  // the snapshot removed is refused by its foreign key, never cascaded away
  // after being written) and after the identity pair (the players table is the
  // snapshot's). A snapshot that rewrote the players but omitted the pairing
  // codes keeps the retained codes, which must still name existing players —
  // the FINAL combined state is checked whichever side was written.
  for (const table of CODE_TABLES) if (present.includes(table.name) && table.replace(sqlite, snapshot[table.name])) written.push(table.name);
  if (written.some((n) => IDENTITY_COLLECTIONS.includes(n))) assertPairingCodesConsistent(sqlite, { label: 'the snapshot (players and pairingCodes together)' });
  // S7c: the outbox and push tables reference nothing
  // (polymorphic audiences, no cascade with a person), so a snapshot
  // that carries one collection and omits another leaves the omitted table
  // alone; each entry is validated (never coerced) and one refusal rolls the
  // whole save back.
  for (const table of NOTIFICATION_TABLE_DISPATCH) if (present.includes(table.name) && table.replace(sqlite, snapshot[table.name])) written.push(table.name);
  // S7d: the FINAL combined state of the threads (review §11.5, corrected by the
  // review of 8330f08): whenever this snapshot wrote the channels, carries the
  // requests, or rewrote the identity pair, every thread row the file now holds
  // must name a request in the final requests (the supplied collection, or the
  // stored requests when omitted — never an empty set for an omission), an existing
  // guardian when it names one (the code-validated reference: the guardians table
  // was rewritten above and carries no foreign key from channels) and an existing
  // organisation. A miss throws inside the caller's transaction: the whole save
  // rolls back, unrelated collections included.
  if (written.includes(CHANNELS_TABLE.name) || requestsSupplied || written.some((n) => IDENTITY_COLLECTIONS.includes(n))) {
    assertChannelReferencesConsistent(sqlite, { label: 'the snapshot (channels, requests and guardians together)' });
  }
  // The ID-check queue's guardians (Q4b), on the FINAL state, whenever this snapshot wrote the queue or the identity pair.
  if (written.includes('idvQueue') || written.some((n) => IDENTITY_COLLECTIONS.includes(n))) {
    assertIdvQueueGuardiansConsistent(sqlite, { label: 'the snapshot (idvQueue and guardians together)' });
  }
  // S8a: the FINAL combined state of the recruitment graph whenever this snapshot
  // wrote the requests or the trials, carries the recruitmentCases collection, or
  // rewrote the identity pair (the guardians): every key (the deferred case and
  // trial keys named with ids), every request/trial pair agreeing, every guardian
  // id in the final guardians table (Q7c). A miss throws inside the caller's
  // transaction: the whole save rolls back.
  if (written.some((n) => RECRUITMENT_COLLECTIONS.includes(n)) || casesSupplied || written.some((n) => IDENTITY_COLLECTIONS.includes(n))) {
    assertRecruitmentConsistent(sqlite, { label: 'the snapshot (requests, trials, recruitmentCases and guardians together)' });
  }
  // S8b: whenever this snapshot touched the case graph — the decision chain and
  // snapshots inside their room, foreign_key_check empty.
  if (casesPlan) RECRUITMENT_CASES_SNAPSHOT.assert(sqlite, { label: 'the snapshot (cases, rooms, requests and trials together)' });
  // S8c: whenever this snapshot touched the contact/offer graph — foreign_key_check
  // empty (the deferred case and request keys named with ids) and every
  // contact/request pair agreeing.
  if (contactsOffersPlan) CONTACTS_OFFERS_SNAPSHOT.assert(sqlite, { label: 'the snapshot (contacts, offers, requests and cases together)' });
  // S8d: foreign_key_check over the ten typed tables whenever this snapshot touched them.
  if (signingsPlan?.typed) SIGNINGS_FOLLOWUPS_SNAPSHOT.assert(sqlite, { label: 'the snapshot (signings, follow-ups and outcomes)' });
  if (written.some((n) => SCOUTING_EVIDENCE_COLLECTIONS.includes(n))) SCOUTING_EVIDENCE_SNAPSHOT.assert(sqlite);
  if (written.some((n) => SCOUTING_ASSESSMENTS_COLLECTIONS.includes(n))) SCOUTING_ASSESSMENTS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => CLUB_SETUP_COLLECTIONS.includes(n))) CLUB_SETUP_SNAPSHOT.assert(sqlite);
  if (written.some((n) => OPPORTUNITIES_CAMPAIGNS_COLLECTIONS.includes(n))) OPPORTUNITIES_CAMPAIGNS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => VERIFICATION_COLLECTIONS.includes(n))) VERIFICATION_SNAPSHOT.assert(sqlite);
  if (written.some((n) => PASSPORT_COLLECTIONS.includes(n))) PASSPORT_SNAPSHOT.assert(sqlite);
  if (written.some((n) => TRANSITIONS_COLLECTIONS.includes(n))) TRANSITIONS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => AGENT_CORE_COLLECTIONS.includes(n))) AGENT_CORE_SNAPSHOT.assert(sqlite);
  if (written.some((n) => COMPLIANCE_POLICIES_COLLECTIONS.includes(n))) COMPLIANCE_POLICIES_SNAPSHOT.assert(sqlite);
  if (written.some((n) => COMPLIANCE_RECORDS_COLLECTIONS.includes(n) || COMPLIANCE_POLICIES_COLLECTIONS.includes(n))) COMPLIANCE_RECORDS_SNAPSHOT.assert(sqlite);
  if (keptTransactions || written.some((n) => AGENT_TRANSACTIONS_COLLECTIONS.includes(n))) AGENT_TRANSACTIONS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => DEVELOPMENT_COLLECTIONS.includes(n))) DEVELOPMENT_SNAPSHOT.assert(sqlite);
  if (written.some((n) => BOX_CAM_COLLECTIONS.includes(n))) BOX_CAM_SNAPSHOT.assert(sqlite);
  if (written.some((n) => DISCOVERY_COLLECTIONS.includes(n))) DISCOVERY_SNAPSHOT.assert(sqlite);
  if (written.some((n) => INSIGHT_COVERAGE_COLLECTIONS.includes(n))) INSIGHT_COVERAGE_SNAPSHOT.assert(sqlite);
  if (written.some((n) => INTEGRATIONS_COLLECTIONS.includes(n))) INTEGRATIONS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => ENTERPRISE_COLLECTIONS.includes(n))) ENTERPRISE_SNAPSHOT.assert(sqlite);
  if (written.some((n) => GROUPS_COLLECTIONS.includes(n))) GROUPS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => GRASSROOTS_COLLECTIONS.includes(n))) GRASSROOTS_SNAPSHOT.assert(sqlite);
  if (written.some((n) => AUDIT_COLLECTIONS.includes(n))) SAFETY_AUDIT_SNAPSHOT.assert(sqlite);
  if (written.some((n) => OPERATIONS_COLLECTIONS.includes(n))) OPERATIONS_SNAPSHOT.assert(sqlite);
  // A saved snapshot is never a first installation: the server attaches to the
  // tables it wrote and never initialises them from its seed.
  const settle = sqlite.prepare("UPDATE meta SET value = 'done' WHERE key = ? AND value = 'pending'");
  for (const key of [ORGS_INIT_META, CORE_IDENTITY_INIT_META]) settle.run(key);
  return written;
}

/**
 * Snapshot mode (`openStore(dir)` without options: tools and fixtures) brings
 * the file up to the current table schema when it opens it, exactly as a boot
 * would, so a snapshot save writes every table-backed collection into its
 * table.
 */
export function migrateForSnapshot(sqlite, { now = Date.now() } = {}) {
  return runDataMigrations(sqlite, DATA_MIGRATIONS, { now });
}

/**
 * §4.3 step 2: a collection whose reads moved to SQL has no `db.<name>`. Reading or assigning it throws, naming the
 * repository, so a reader that was missed fails loudly instead of seeing (or `??=`-creating) an empty list. Not
 * enumerable, so a walk over `db` (a snapshot, the memento) never meets it.
 */
const schemaVersionOf = (sqlite) => Number(sqlite.prepare('SELECT MAX(id) AS id FROM data_migrations').get()?.id?.slice(0, 4)) || 0;

function retireCollection(db, name, repository) {
  Object.defineProperty(db, name, { get() { throw new TypeError(`db.${name} is gone: read it through the ${repository} repository`); }, set() { throw new TypeError(`db.${name} is gone: write it through the ${repository} repository`); }, configurable: false, enumerable: false });
}

/**
 * Attach every domain repository to the store's database: run the table migrations, then create the repositories.
 * `seed` is a first installation's records (`orgs`, `players`, `guardians`, `reputationSeed`; buildSeed() in
 * seed.mjs, or a fixture), imported once while the organisations and the identity pair are still `pending`, and
 * ignored on every later boot. `db` receives the read-only views of the repositories that still keep a mirror, and a
 * throwing name for every retired collection.
 */
export function attachDataLayer({ db, seed = {}, store, nextId, sessionTtlMs, now = Date.now, log = () => {}, warn = (m) => console.warn(m) }) {
  const sqlite = store?.sqlite ?? null;
  if (!sqlite) throw new TypeError('the data layer needs a store with a SQLite connection (node:sqlite); there is no in-memory or JSON fallback');
  const migrations = runDataMigrations(sqlite, DATA_MIGRATIONS, { now: now(), log, context: { sessionTtlMs } });

  // Every repository writes its rows at once and reads through SQL; a retired collection's old `db.<name>` throws.
  // The organisations attach first: org_users, and most tables after them, reference orgs.
  // S14g: the organisations are explicit, with no mirror; their old collection name throws.
  const orgs = createOrgsRepository({ sqlite, nextId, log, now, unit: store.unit });
  const orgsBoot = orgs.initState() === 'pending' ? orgs.initialize(seed.orgs ?? []) : orgs.attach();
  retireCollection(db, 'orgs', 'orgs');

  // S14h: players and guardians are explicit, with no mirror; their old collection names throw. Their trial reports
  // come from the recruitment repository, attached below (a first installation's seed carries none).
  let recruitment = null;
  /** A collection the caller handed in before its table took over (the seed's or a fixture's plain array), or []. */
  const handedIn = (name) => (Object.hasOwn(seed, name) && Array.isArray(seed[name]) ? seed[name] : []);
  const identity = createIdentityRepositories({ sqlite, log, unit: store.unit, now, trialReportsOf: (ids) => (recruitment ? recruitment.trialReportsForPlayers(ids) : new Map()) });
  const identityWasPending = identity.initState() === 'pending'; // a first installation: its seed is imported once (S13e: the demo reputation rows too)
  const identityBoot = identityWasPending
    ? identity.initialize({ players: seed.players ?? [], guardians: seed.guardians ?? [] }, { now: now() })
    : identity.attach();
  retireCollection(db, 'players', 'players (identity)');
  retireCollection(db, 'guardians', 'guardians (identity)');

  // S14f: staff and sessions are explicit, with no mirror; their old collection names throw.
  const users = createUsersRepository({ sqlite, nextId, log, now, unit: store.unit });
  const usersBoot = users.attach();
  retireCollection(db, 'users', 'users');

  const sessions = createSessionsRepository({ sqlite, sessionTtlMs, log });
  const sessionsBoot = sessions.attach();
  retireCollection(db, 'sessions', 'sessions');

  const mediaDeletions = createMediaDeletionsQueue({ sqlite, log, warn, now });

  const codes = createOneTimeCodesRepository({ sqlite, log, now, unit: store.unit });
  const codesBoot = codes.attach({ at: now() });
  for (const [name, view] of [[EMAIL_CHALLENGES_TABLE.name, codes.emailChallengesView], [PAIRING_CODES_TABLE.name, codes.pairingCodesView]]) {
    Object.defineProperty(db, name, { value: view, writable: false, configurable: false, enumerable: true });
  }

  // S14e: explicit, no mirror; its old collection names throw.
  const notifications = createNotificationsRepository({ sqlite, log, now, nextId, unit: store.unit });
  const notificationsBoot = notifications.attach();
  for (const name of [NOTIFICATIONS_TABLE.name, NOTIFICATION_PREFS_TABLE.name]) retireCollection(db, name, 'notifications');

  // S14d: explicit, no mirror; their old collection names throw.
  const dispatches = createDispatchesRepository({ sqlite, log, now, unit: store.unit });
  const dispatchesBoot = dispatches.attach();
  retireCollection(db, DISPATCHES_TABLE.name, 'dispatches');
  const outboxPush = createOutboxPushRepository({ sqlite, log, now, unit: store.unit });
  const outboxPushBoot = outboxPush.attach();
  for (const name of OUTBOX_PUSH_COLLECTIONS) retireCollection(db, name, 'outboxPush');

  // The explicit repositories, in dependency order. Each retires its old collection names on `db`.
  const recruitmentContactsOffers = createRecruitmentContactsOffersRepository({ sqlite, log, now, unit: store.unit });
  const recruitmentContactsOffersBoot = recruitmentContactsOffers.attach();
  const recruitmentCases = createRecruitmentCasesRepository({ sqlite, log, now, unit: store.unit });
  const recruitmentCasesBoot = recruitmentCases.attach();
  recruitment = createRecruitmentRepository({ sqlite, log, now, unit: store.unit });
  const recruitmentBoot = recruitment.attach();
  for (const name of RECRUITMENT_CASES_COLLECTIONS) {
    retireCollection(db, name, 'recruitmentCases');
  }
  for (const name of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) {
    retireCollection(db, name, 'recruitmentContactsOffers');
  }
  const signingsFollowUps = createSigningsFollowUpsRepository({ sqlite, log, now, unit: store.unit });
  const signingsFollowUpsBoot = signingsFollowUps.attach();
  for (const name of SIGNINGS_FOLLOWUPS_COLLECTIONS) {
    retireCollection(db, name, 'signingsFollowUps');
  }
  const scoutingEvidence = createScoutingEvidenceRepository({ sqlite, log, now, unit: store.unit });
  const scoutingEvidenceBoot = scoutingEvidence.attach();
  for (const name of SCOUTING_EVIDENCE_COLLECTIONS) {
    retireCollection(db, name, 'scoutingEvidence');
  }
  const scoutingAssessments = createScoutingAssessmentsRepository({ sqlite, log, now, unit: store.unit });
  const scoutingAssessmentsBoot = scoutingAssessments.attach();
  for (const name of SCOUTING_ASSESSMENTS_COLLECTIONS) {
    retireCollection(db, name, 'scoutingAssessments');
  }
  const clubSetup = createClubSetupRepository({ sqlite, log, now, unit: store.unit });
  const clubSetupBoot = clubSetup.attach();
  for (const name of CLUB_SETUP_COLLECTIONS) {
    retireCollection(db, name, 'clubSetup');
  }
  const opportunitiesCampaigns = createOpportunitiesCampaignsRepository({ sqlite, log, now, unit: store.unit });
  const opportunitiesCampaignsBoot = opportunitiesCampaigns.attach();
  for (const name of OPPORTUNITIES_CAMPAIGNS_COLLECTIONS) {
    retireCollection(db, name, 'opportunitiesCampaigns');
  }
  const verification = createVerificationRepository({ sqlite, log, now, unit: store.unit });
  const verificationBoot = verification.attach();
  for (const name of [...VERIFICATION_COLLECTIONS, ...VERIFICATION_RETIRED]) {
    retireCollection(db, name, 'verification');
  }
  const passport = createPassportRepository({ sqlite, log, now, unit: store.unit });
  const passportBoot = passport.attach();
  for (const name of PASSPORT_COLLECTIONS) {
    retireCollection(db, name, 'passport');
  }
  const transitionsVouches = createTransitionsVouchesRepository({ sqlite, log, now, unit: store.unit });
  const transitionsVouchesBoot = transitionsVouches.attach();
  for (const name of TRANSITIONS_COLLECTIONS) {
    retireCollection(db, name, 'transitionsVouches');
  }
  const compliancePolicies = createCompliancePoliciesRepository({ sqlite, log, now, unit: store.unit });
  const compliancePoliciesBoot = compliancePolicies.attach();
  for (const name of COMPLIANCE_POLICIES_COLLECTIONS) {
    retireCollection(db, name, 'compliancePolicies');
  }
  const agentCore = createAgentCoreRepository({ sqlite, log, now, unit: store.unit, policyVersionKnown: (id) => compliancePolicies.policies.exists(id) });
  const agentCoreBoot = agentCore.attach();
  for (const name of AGENT_CORE_COLLECTIONS) {
    retireCollection(db, name, 'agentCore');
  }
  const complianceRecords = createComplianceRecordsRepository({ sqlite, log, now, unit: store.unit });
  const complianceRecordsBoot = complianceRecords.attach();
  for (const name of COMPLIANCE_RECORDS_COLLECTIONS) {
    retireCollection(db, name, 'complianceRecords');
  }
  const agentTransactions = createAgentTransactionsRepository({ sqlite, log, now, unit: store.unit });
  const agentTransactionsBoot = agentTransactions.attach();
  for (const name of AGENT_TRANSACTIONS_COLLECTIONS) {
    retireCollection(db, name, 'agentTransactions');
  }
  const development = createDevelopmentRepository({ sqlite, log, now, unit: store.unit });
  const developmentBoot = development.attach();
  for (const name of DEVELOPMENT_COLLECTIONS) {
    retireCollection(db, name, 'development');
  }
  const boxCam = createBoxCamRepository({ sqlite, log, now, unit: store.unit });
  const boxCamBoot = boxCam.attach();
  for (const name of [...BOX_CAM_COLLECTIONS, ...BOX_CAM_RETIRED]) {
    retireCollection(db, name, 'boxCam');
  }
  const discovery = createDiscoveryRepository({ sqlite, log, now, unit: store.unit });
  const discoveryBoot = discovery.attach();
  for (const name of DISCOVERY_COLLECTIONS) {
    retireCollection(db, name, 'discovery');
  }
  const insightCoverage = createInsightCoverageRepository({ sqlite, log, now, unit: store.unit });
  const insightCoverageBoot = insightCoverage.attach();
  for (const name of INSIGHT_COVERAGE_COLLECTIONS) {
    retireCollection(db, name, 'insightCoverage');
  }
  const integrations = createIntegrationsRepository({ sqlite, log, now, unit: store.unit });
  const integrationsBoot = integrations.attach();
  for (const name of INTEGRATIONS_COLLECTIONS) {
    retireCollection(db, name, 'integrations');
  }
  const enterprise = createEnterpriseRepository({ sqlite, log, now, unit: store.unit });
  const enterpriseBoot = enterprise.attach();
  for (const name of ENTERPRISE_COLLECTIONS) {
    retireCollection(db, name, 'enterprise');
  }
  const groups = createGroupsRepository({ sqlite, log, now, unit: store.unit });
  const groupsBoot = groups.attach();
  for (const name of GROUPS_COLLECTIONS) {
    retireCollection(db, name, 'groups');
  }
  const grassroots = createGrassrootsRepository({ sqlite, log, now, unit: store.unit });
  const grassrootsBoot = grassroots.attach();
  for (const name of GRASSROOTS_COLLECTIONS) {
    retireCollection(db, name, 'grassroots');
  }
  const operations = createOperationsRepository({ sqlite, log, now, unit: store.unit });
  const operationsBoot = operations.attach({ seedReputation: identityWasPending ? handedIn('reputationSeed') : [] });
  for (const name of [...OPERATIONS_COLLECTIONS, ...OPERATIONS_SINGLETONS]) {
    retireCollection(db, name, 'operations');
  }
  for (const name of ['requests', 'trials']) {
    retireCollection(db, name, 'recruitment');
  }

  const channels = createChannelsRepository({ sqlite, log, now, unit: store.unit });
  const channelsBoot = channels.attach();
  retireCollection(db, CHANNELS_TABLE.name, 'channels');

  const safetyAudit = createSafetyAuditRepository({ sqlite, log, now, unit: store.unit });
  const safetyAuditBoot = safetyAudit.attach();
  for (const name of AUDIT_COLLECTIONS) {
    retireCollection(db, name, 'safetyAudit');
  }

  return {
    orgs,
    identity,
    players: identity.players,
    guardians: identity.guardians,
    users,
    sessions,
    mediaDeletions,
    codes,
    notifications,
    dispatches,
    outboxPush,
    outbox: outboxPush.outbox,
    pushLog: outboxPush.pushLog,
    pushTokens: outboxPush.pushTokens,
    channels,
    safetyAudit,
    recruitment,
    recruitmentCases,
    recruitmentContactsOffers,
    signingsFollowUps,
    scoutingEvidence,
    scoutingAssessments,
    clubSetup,
    opportunitiesCampaigns,
    verification,
    passport,
    transitionsVouches,
    agentCore,
    compliancePolicies,
    complianceRecords,
    agentTransactions,
    development,
    boxCam,
    discovery,
    insightCoverage,
    integrations,
    enterprise,
    groups,
    grassroots,
    operations,
    migrations,
    /** True when this boot imported the seed: a first installation. */
    firstInstallation: identityWasPending,
    /** The schema version: the number of the latest applied table migration (`0039_…` → 39). */
    schemaVersion: () => schemaVersionOf(sqlite),
    /** Operator-facing view of the schema: the version, the migrations applied and known, whether it is current. */
    schemaReport: () => {
      const version = schemaVersionOf(sqlite);
      const expected = Number(DATA_MIGRATIONS.map((m) => m.id).sort().at(-1).slice(0, 4));
      const applied = sqlite.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n;
      return { version, expected, migrationsApplied: applied, migrationsKnown: DATA_MIGRATIONS.length, upToDate: version === expected && applied === DATA_MIGRATIONS.length };
    },
    boot: { orgs: orgsBoot, identity: identityBoot, users: usersBoot, sessions: sessionsBoot, codes: codesBoot, notifications: notificationsBoot, dispatches: dispatchesBoot, outboxPush: outboxPushBoot, channels: channelsBoot, safetyAudit: safetyAuditBoot, recruitment: recruitmentBoot, recruitmentCases: recruitmentCasesBoot, recruitmentContactsOffers: recruitmentContactsOffersBoot, signingsFollowUps: signingsFollowUpsBoot, scoutingEvidence: scoutingEvidenceBoot, scoutingAssessments: scoutingAssessmentsBoot, clubSetup: clubSetupBoot, opportunitiesCampaigns: opportunitiesCampaignsBoot, verification: verificationBoot, passport: passportBoot, transitionsVouches: transitionsVouchesBoot, agentCore: agentCoreBoot, compliancePolicies: compliancePoliciesBoot, complianceRecords: complianceRecordsBoot, agentTransactions: agentTransactionsBoot, development: developmentBoot, boxCam: boxCamBoot, discovery: discoveryBoot, insightCoverage: insightCoverageBoot, integrations: integrationsBoot, enterprise: enterpriseBoot, groups: groupsBoot, grassroots: grassrootsBoot, operations: operationsBoot },
    /** `details: true` is accepted for the admin report; the report carries counts and states, never rows. */
    report: () => ({
      ...dataSchemaReport(sqlite, DATA_MIGRATIONS),
      domains: {
        orgs: { rows: orgs.count(), mode: 'live', writeMode: 'explicit: create, update(id, draft => …) and setPasswordHash write at once, inside the route\'s unit of work when one is open', readMode: 'SQL: byId, list, page, locatedInBox, byName, passwordHashOf, count; no mirror and no db.* view; fresh deep-frozen records without the password hash', typing: 'typed columns only: name 1–120, the type, level and plan vocabularies, a location as latitude, longitude and city (lat/lng in range, both or neither), a federation registration as both its parts or neither, the flags as booleans, created_at required; no facet storage (an unknown field is refused)' },
        players: { rows: identity.players.count(), retained: identity.players.retainedCount(), mode: 'live', writeMode: 'explicit: create, update(id, draft => …), setPasswordHash, the list operations (addItem, setItems, patchItem), the link operations and erase write at once, inside the route\'s unit of work when one is open', readMode: 'SQL: byId, byIds, byMediaId, byGuardian, byExternalId, byNameAndDob, scan / list / visibleCandidates (S14i: the whole visibility rule in SQL — the wall, the Grassroots radius, the blocks), directoryPage / visiblePage / clipPage / fixturePage by cursor, scanLight (light rows), recentFor, drillBests, count; profile_signal kept by every player and trial write; no mirror and no db.* view; fresh deep-frozen records without the password hash', typing: 'typed columns only: name 1–120, the position, foot, availability, contract and level vocabularies, height, weight and squad number in range, stats non-negative (percentages 0–100), a location as both coordinates or neither, quiet hours as HH:MM; no facet storage (an unknown field is refused)', subrecords: { mode: 'live', tables: identity.players.subrecordRows(), trialReports: 'derived from trials' }, deletion: 'S4b-R (migration 0014): an account deletion keeps the row as a retained record — id, deleted_at, birth_date, country; placeholders and NULL elsewhere; owned rows and links removed — served by no account reader; retained records travel in backups as playersRetained' },
        guardians: { rows: identity.guardians.count(), mode: 'live', links: identity.report().links, writeMode: 'explicit: create, update(id, draft => …), setPasswordHash, setEmailCodeHash and the link operations', readMode: 'SQL: byId, byIds, byEmail (case-insensitive), linksOf, forPlayer, childIds, page, count; childIds from the link rows and coGuardians from co_guardian_of; no mirror and no db.* view; no password or code hash on a record', references: 'guardian_children (both sides), players.guardian_id and co_guardian_of are RESTRICT keys; one primary link per player' },
        users: { rows: users.count(), mode: 'live', writeMode: 'explicit: create, update(id, draft => …), startMfa / enableMfa / disableMfa and useRecoveryCode (a code is spent by deleting its row) write at once, inside the route\'s unit of work when one is open', readMode: 'SQL: byId, byOrgAndName, forOrg, firstActive, activeByEmail, bySsoSubject, mfaSecretOf; no mirror and no db.* view; fresh deep-frozen records without the MFA secret or recovery codes', typing: 'typed columns: name 1–120 and unique in its organisation (case-insensitive, removed accounts included), role 1–60, an e-mail unique among current staff, an SSO subject unique in its organisation, the provenance vocabulary, MFA and delivery preferences as columns, recovery-code hashes as child rows', references: 'org_id → orgs and removed_by_id → org_users (RESTRICT); recovery codes and sessions cascade with their account' },
        sessions: { rows: sessions.count(), mode: 'live', lifetimeMs: sessions.ttlMs, readMode: 'SQL: byToken (by hash), bySid, listFor, listOrgUser; no db.* view', references: 'an org session\'s (org_user_id, ref_id) → org_users(id, org_id), cascading with the account' },
        oneTimeCodes: { mode: 'live', rows: codes.counts(), outstanding: codes.outstanding(), lifetimesMs: { emailChallenge: codes.emailChallengeTtlMs, pairingCode: codes.pairingCodeTtlMs }, maxEmailAttempts: codes.maxEmailAttempts },
        notifications: { mode: 'live', rows: notifications.counts(), pendingWrites: 0, coalesceMs: notifications.coalesceMs, writeMode: 'explicit: a notification is written in the unit of work of the action it announces (or its own transaction); its push and live event run after that commit; a coalesce, a read, an acknowledgment (with its dispatches) and the delivery marker (with the dispatches made) are single operations', readMode: 'SQL: byId, a person\'s feed (newest first), unread and awaiting-acknowledgment counts, the coalescing lookup, the undispatched notices, a person\'s preferences; no mirror and no db.* view', references: 'a staff audience is a RESTRICT key to org_users (generated staff_id); player and guardian ids carry no key (tolerant)' },
        dispatches: { mode: 'live', rows: dispatches.count(), attempts: dispatches.attemptCount(), byStatus: dispatches.countsByStatus(), backlog: dispatches.backlogCount(), pendingWrites: 0, writeMode: 'explicit: a notification\'s dispatches are created in one unit; each send (its attempt, status, outbox row, injected-failure use and, when the retries run out, the ops event and webhook) in one unit; a callback event with its seen marker in one unit; an acknowledgment with the notification\'s contract', notificationReference: 'indexed, no foreign key (a dispatch outlives its notification; retention is an open decision)', organisation: 'a staff audience\'s organisation, a deferred RESTRICT key' },
        outboxPush: { mode: 'live', rows: outboxPush.counts(), pendingWrites: 0, writeMode: 'explicit: a mail record before its provider call and its answer after; the delivery centre\'s record in its send\'s unit; a push record when the push is sent; a token at registration', tokens: 'one row per device token, players and guardians only (a token another account registers moves to it)', typing: 'typed columns with vocabulary CHECKs; an unknown field or a wrong-typed value is refused by name' },
        channels: { mode: 'live', rows: channels.counts(), pendingWrites: 0, writeMode: 'explicit: a thread opens with the request\'s acceptance, in its unit of work; a message with its ledger row and notifications in one unit; a receipt at once; a deleted player\'s threads go in the account-deletion unit (D-B)', readMode: 'SQL: byId, parties, a player\'s and a guardian\'s threads, the organisation\'s and the admin lists by cursor (most recently active first), the organisation\'s counts, the retry lookup; no mirror and no db.* view', references: 'request_id (unique), org_id and a staff sender are RESTRICT keys; player and guardian ids carry no key (tolerant), a guardian is checked at open and on every snapshot\'s final state; messages and attachments cascade with their thread' },
        recruitment: { mode: 'live', rows: recruitment.counts(), pendingWrites: recruitment.pending(), unresolvedPlayerReferences: unresolvedRecruitmentPlayers(sqlite), retainedPlayerReferences: retainedRecruitmentPlayers(sqlite), writeMode: 'explicit and typed: requests.create / update, trials.create / update and tombstoneForPlayer write a record\'s rows at once (inside the route\'s unit of work) and re-read it; the views are read-only; a record the typed columns cannot hold is refused with its id', references: 'player_id (both tables) no foreign key, TOLERANT (Q7a): live, retained and historically missing ids resolve, are counted here and never refused, fabricated or deleted. case_id (both tables) → recruitment_cases (RESTRICT, immediate); recruitment_requests.trial_id → trials DEFERRABLE INITIALLY DEFERRED (a snapshot writes a request before its trial). guardian_id and recipient_guardian_id no foreign key, STRICT in code (Q7c): checked at every write and on every snapshot\'s final state. trials.request_id NOT NULL UNIQUE → recruitment_requests (RESTRICT); org_id and user_id → orgs / org_users (RESTRICT); the child tables cascade with their owner. The direct request route keeps its REQUEST_PENDING rule (D2)' },
        recruitmentCases: { mode: 'live', rows: recruitmentCases.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedCasePlayers(sqlite), retainedPlayerReferences: retainedCasePlayers(sqlite), writeMode: 'explicit: every change is a repository operation (cases.create / update / redactPlayer; comments, decisions and evidenceStates create / update; snapshots.create) that writes its rows at once — inside the route\'s unit of work when one is open, in a transaction of its own otherwise — and re-reads the record from the tables; the views hold read-only records (an in-place edit throws); no flush, no fingerprint', typing: 'typed columns only (file 02): the vocabulary and length CHECKs; one case history entry shape; a decision\'s snapshot is the room_snapshots row it names; the idempotency keys as columns; no absent_keys_json, offtype_json, extra_json or raw_json; a record the columns cannot hold (an unknown field included) is refused with its id', references: 'player_id (recruitment_cases, room_snapshots, room_decisions, case_transaction_handoffs) no foreign key, TOLERANT (Q8a): live, retained and historically missing ids resolve, are counted here and never refused. org_id → orgs and the staff ids (owner, lead scout, M12 decision maker, assignee, comment author) → org_users (RESTRICT); room_id (the four room tables) → recruitment_cases (RESTRICT); a decision\'s snapshot_id → room_snapshots (RESTRICT); case_request_links → recruitment_requests and case_trial_links → trials (RESTRICT); the case_id of requests, trials, contacts and offers → recruitment_cases (RESTRICT, immediate). The decision chain and a decision\'s snapshot stay inside its room, checked at every write. The children cascade with their owner. The one-open-room rule is the routes\'' },
        recruitmentContactsOffers: { mode: 'live', rows: recruitmentContactsOffers.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedContactOfferPlayers(sqlite), retainedPlayerReferences: retainedContactOfferPlayers(sqlite), writeMode: 'explicit: every change is a repository operation (contacts.create / update / redactPlayer; offers.create / update / redactPlayer) that writes its rows at once — inside the route\'s unit of work when one is open, in a transaction of its own otherwise — and returns the record read back from the tables; no flush, no fingerprint', readMode: 'SQL: every read is a repository query (byId, forCase, forOrgPlayer, forPlayer(s), forRequest, forAgent / forAgentShare, forOrg) that decodes deep-frozen records (an in-place edit throws); no in-memory mirror and no db.* view', typing: 'typed columns only (file 02): the vocabulary and length CHECKs; the idempotency keys as columns and offer_keys rows; no absent_keys_json, offtype_json, extra_json or raw_json; a record the columns cannot hold (an unknown field included) is refused with its id', references: 'player ids no foreign key, TOLERANT and counted (Q8c-a); guardian ids no foreign key, STRICT on a snapshot write (Q8c-b); org_id → orgs and the staff ids → org_users (RESTRICT); case_id → recruitment_cases (RESTRICT, immediate); a contact\'s request_id → recruitment_requests DEFERRABLE INITIALLY DEFERRED (a send writes its contact before the request); every offer pointer (current revision, response, supersedes, superseded by, discarded by, a response\'s, receipt\'s or key\'s revision) names a row of the same offer; contact_history and offer_history → their owner (RESTRICT); every other child cascades' },
        signingsFollowUps: { mode: 'live', rows: signingsFollowUps.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedSigningPlayers(sqlite), retainedPlayerReferences: retainedSigningPlayers(sqlite), writeMode: 'explicit: every change is a repository operation (signingPackages.insert / patch / patchRevision / addRevision / setDocument / setParty / addKey / addHistory / redactPlayer; signings.record; followUps.schedule / patch; outcomeReports.file / addConfirmation) that writes its rows at once — inside the route\'s unit of work when one is open, in a transaction of its own otherwise — and returns the record read back from the tables; no flush, no fingerprint', readMode: 'SQL: every read is a repository query (byId, forCase / forOffer / forOrg / forPlayer / forOrgPlayer, forPackage, forSigning, forFollowUp, the sweep\'s due queries, the admin totals) decoding deep-frozen records; the club follow-up and signing lists page by cursor; no in-memory mirror and no db.* view', typing: 'typed columns only (file 02): the vocabulary and length CHECKs; no absent_keys_json, offtype_json or extra_json; a record the columns cannot hold is refused with its id at the route, the cutover and a snapshot write; the cutover normalised exactly what the design note lists and reported each with the row id (meta.signingsFollowUpsCutover.notes)', references: 'player ids no foreign key, TOLERANT and counted (Q7a/Q8a/Q8c-a applied, not re-asked); guardian and party ids polymorphic, no key; org_id → orgs, case_id → recruitment_cases, offer_id → recruitment_offers, the staff ids → org_users (RESTRICT); signing_package_id and signing_revision_id → their tables (RESTRICT); completion_signing_id → signings (RESTRICT, DEFERRABLE INITIALLY DEFERRED: the completion unit writes the signing row and then the package); follow_ups.signing_id, outcome_reports.follow_up_id / signing_id (RESTRICT); offer_revision_id a plain indexed column checked in code (offer_revisions.id is the primary key since §4.3; a real key is a later change). The three uniqueness rules of file 02 are partial unique indexes and are named with ids before the engine would (one live and one completed package per offer; one signing per package, per offer, one standing legacy row per organisation and player; one follow-up per signing and milestone; one report per follow-up)' },
        scoutingEvidence: { mode: 'live', rows: scoutingEvidence.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedEvidencePlayers(sqlite), retainedPlayerReferences: retainedEvidencePlayers(sqlite), writeMode: 'explicit: evidence, coachAffiliations and squadInvites create / update write a record\'s rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: byId, forPlayer / currentForPlayer, byDispute, forOrg, activeFor, pendingFor, forPlayers; the admin dispute and affiliation lists page by offset in SQL; no mirror and no db.* view', references: 'player ids no foreign key, tolerant and counted (as recruitment); media ids no key; org_id → orgs and the staff ids → org_users (RESTRICT); correction_of_id / superseded_by_id → evidence (RESTRICT); one pending invitation per organisation and player (partial unique index)' },
        scoutingAssessments: { mode: 'live', rows: scoutingAssessments.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedAssessmentPlayers(sqlite), retainedPlayerReferences: retainedAssessmentPlayers(sqlite), writeMode: 'explicit: templates.create (append-only versions), assessments create / update / redactPlayer, segments.create, playlists create / update write a record\'s rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: templates all / currentFor / currentById / byIdVersion; assessments byId, forOrg, forOrgPlayer, forOrgScout, forPlayer, withFeedbackForPlayer, anyForTrial; segments byId, forOrg; playlists byId, forOrg; no mirror and no db.* view', references: 'player, media, trial and trial-session ids no foreign key, tolerant and counted (as recruitment); org_id → orgs and the staff ids → org_users (RESTRICT); an assessment\'s template (id, version), first opinion and cited segments, and a playlist\'s segments, are RESTRICT keys inside the domain; the attributes snapshot is the template version\'s attributes, joined on read' },
        clubSetup: { mode: 'live', rows: clubSetup.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedClubSetupPlayers(sqlite), retainedPlayerReferences: retainedClubSetupPlayers(sqlite), writeMode: 'explicit: tactical.save (roles diffed by id), squad create / remove, shadow.create, lookingFor.set, federation.submit, vacancies create / update write their rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: tactical forOrg / roleOf; squad byId, forOrg, forPlayer, has, playerIds; shadow forOrg, has; lookingFor forOrg; federation forOrg; vacancies byId, ofOrg, openForOrg, the club list by cursor; no mirror, no db.* view and no organisation facet', references: 'player ids no foreign key, tolerant and counted (as recruitment); org_id → orgs (RESTRICT); roles, criteria and windows cascade with their setup; vacancies.role_id and org_shadow_players.role_id → org_tactical_roles ON DELETE SET NULL (a dropped role), the role checked to be the same organisation\'s; one squad row and one shadow entry per organisation and player' },
        opportunitiesCampaigns: { mode: 'live', rows: opportunitiesCampaigns.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedOpportunityPlayers(sqlite), retainedPlayerReferences: retainedOpportunityPlayers(sqlite), writeMode: 'explicit: opportunities create / update, applications create / update, campaigns.create, submissions create / update, preferences.save write a record\'s rows at once (inside the route\'s unit of work when one is open); a preference row exists only once saved', readMode: 'SQL: opportunities byId, ofOrg, openOn, the club list by cursor, applicationCounts; applications byId, ofOrg, ofPlayers, forPlayers, forOpportunity, pageForOpportunity, liveFor, remindersDue; campaigns byId, ofOrg, openOn, the club list by cursor, submissionCounts; submissions byId, forCampaign, forCampaignPlayer, forPlayer, byAttempt; preferences forPlayer; no mirror and no db.* view', references: 'player ids no foreign key, tolerant and counted (as recruitment); org_id → orgs and the staff ids → org_users (RESTRICT); an application\'s opportunity and a submission\'s campaign RESTRICT; owned children cascade; one live application per opportunity and player, one submission per campaign and player' },
        verification: { mode: 'live', rows: verification.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedVerificationPlayers(sqlite), retainedPlayerReferences: retainedVerificationPlayers(sqlite), writeMode: 'explicit: claims, evidence, tokens, admins, rootTransfers, rootRequests, disputes, references, playerInvites, conflicts and domainRequests create / update, events.append, domains add / remove write their rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: per-kind indexed queries (byId, forSubject, byAuthority, forOrgStaff, byPair, inStatuses, the sweep\'s expiredBy / warnDue, forClaim, byHash, activeFor, openDuplicate, activeForPlayer, forOrg …); no mirror and no db.* view', typing: 'typed columns only: a claim\'s metadata and an evidence record\'s meta are fixed optional columns, review reasons and risk flags are code rows, an event\'s before/after is one detail line; no JSON columns', references: 'player ids no foreign key, tolerant and counted; org_id → orgs and the staff ids → org_users (RESTRICT); claim, evidence, root-application and reference keys inside the domain RESTRICT; codes and evidence links cascade with their claim; polymorphic subject, authority, actor and token ids carry no key' },
        passport: { mode: 'live', rows: passport.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedPassportPlayers(sqlite), retainedPlayerReferences: retainedPassportPlayers(sqlite), writeMode: 'explicit: passportPrefs.save (whole; the position history only grows), careerEntries, achievements, shares and corrections create / update, shares.recordView write their rows at once (inside the route\'s unit of work when one is open); a preference row exists only once saved', readMode: 'SQL: passportPrefs forPlayer; careerEntries and achievements byId, forPlayer; shares byId, byHash, forPlayer, activeCount, the T&S list by cursor; corrections byId, the T&S queue by cursor; no mirror and no db.* view', typing: 'typed columns only: football dates as given (YYYY, YYYY-MM or YYYY-MM-DD), position codes, secondary positions and public selections as ordered child rows; no JSON columns', references: 'player and guardian ids no foreign key, tolerant and counted; a confirmation\'s organisation → orgs (RESTRICT); the preferences\' child rows cascade' },
        transitionsVouches: { mode: 'live', rows: transitionsVouches.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedTransitionPlayers(sqlite), retainedPlayerReferences: retainedTransitionPlayers(sqlite), writeMode: 'explicit: transitionCases and vouches create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); a case\'s pack, owner, note and period never change, its grants only gain rows and its history only grows', readMode: 'SQL: transitionCases byId, forPlayer, forPlayers, grantedTo, the sweep\'s expiredBy / followUpsDue; vouches byId, pendingByCode, forPlayer, publishedFor, the T&S list by cursor; no mirror and no db.* view', typing: 'typed columns only: the pack, grants and history are ordered child rows, a history entry\'s detail is an item count or an organisation; a reference code is stored as its SHA-256 hash and cleared when used; no JSON columns', references: 'player and guardian ids no foreign key, tolerant and counted; a grant\'s and a placement\'s organisation → orgs (RESTRICT); pack items, grants and history cascade with their case' },
        complianceRecords: { mode: 'live', rows: complianceRecords.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedCompliancePlayers(sqlite), writeMode: 'explicit: contexts, reviews and consents create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); an evaluation is appended with recordEvaluation, a revocation is its own row (once), an account deletion is forgetPlayer; history only grows, a decision is final, an answered consent is never edited', readMode: 'SQL: contexts byId, forAgent, byCreateKey, openForAgencyExcept, forAgency, outcomeCounts (each context carries its latest evaluation); reviews byId, openForFacet, openForAgreement, forContext, openForContext, forAgency, the T&S queue by cursor (open first), metrics, decisionEntries; consents byId, forContext, forSubject, forAgent, forAgency, byRequestKey, metrics; no mirror and no db.* view', typing: 'typed columns only: a review\'s subject by kind, its snapshot as the evaluation row it names, its decision and prior/resulting state as columns; reasons with their extras as columns and their lists as rows; history details typed or worked out from their record; idempotency keys are columns of their owner; no JSON columns', references: 'agencies → orgs, staff → org_users, reviewers → ts_reviewers, versions → jurisdiction_policies, agreements → representation_agreements, profiles → agent_profiles, and within the domain (RESTRICT); a party\'s, a consent\'s and an approach review\'s player or club id carries no key (tolerant, counted); child rows cascade' },
        agentTransactions: { mode: 'live', rows: agentTransactions.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedTransactionPlayers(sqlite), writeMode: 'explicit: transactions, representation bindings and documents create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); an account deletion is forgetPlayer; history, notes, linked threads, terms versions and keys only grow, a withdrawn binding and a superseded or removed document are final', readMode: 'SQL: transactions byId, byCreateKey, the agent\'s, a club\'s and the Trust & Safety lists by cursor (newest first), agentCounts, forPlayer, liveForIndividual (the duplicate rule), forAgency, live, metrics; bindings byId, forTransaction(s), byAttachKey, forAgency; documents byId, forTransaction, liveForTransactions, liveCount, byAddKey, forAgency; no mirror and no db.* view', typing: 'typed columns only: the compliance snapshot names its evaluation row (or the gate that refused before the engine ran) and reads the outcome, reason codes, policy versions and consent requirements from it; history details as columns with their lists as rows; a document\'s entries worked out from the document; idempotency keys are columns of their owner or rows of the transaction; no JSON columns', references: 'agencies → orgs, staff → org_users, the context and evaluation → compliance_contexts / compliance_evaluations, agreements, reviews, evidence and the cited case (RESTRICT), and within the domain (RESTRICT); a party\'s player or club, a document owner, a linked channel and the trial and opportunity links carry no key (tolerant, counted); child rows cascade' },
        compliancePolicies: { mode: 'live', rows: compliancePolicies.counts(), pendingWrites: 0, writeMode: 'explicit: reviewers and policy versions create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); history only grows, a revocation is final, a version\'s content never changes after it is proposed and its publication happens once; the seeded versions are inserted by migration 0027', readMode: 'SQL: reviewers byId, activeById, all, activeCount; policies byId, exists, all, published (decoded once per change); no mirror and no db.* view', typing: 'typed columns only: rules, sources, overrides and publishers are rows; a rule parameter is typed against the engine\'s vocabulary (RULE_PARAMS), scalars as columns and list or map elements as item rows; no JSON columns', references: 'revoker, proposer and approver → ts_reviewers and supersedes → jurisdiction_policies (RESTRICT); child rows cascade' },
        agentCore: { mode: 'live', rows: agentCore.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedAgentPlayers(sqlite), retainedPlayerReferences: retainedAgentPlayers(sqlite), writeMode: 'explicit: profiles, affiliations and agreements create / update write a record\'s rows at once (inside the route\'s unit of work when one is open), settings.save an agency\'s settings; history only grows, an agreement\'s parties, scope, term and policy versions never change, shares only gain rows', readMode: 'SQL: profiles byId, forUser, forAgency, staleUnnotified, the T&S list by cursor; affiliations activeFor, anyActiveIn, forAgency, byCreateKey; agreements byId, forAgency, forAgent, forClient, forAgentClient, byRequestKey, expiringUnnotified, the T&S list by cursor; settings forOrg; no mirror and no db.* view', typing: 'typed columns only: declared jurisdictions, facets, roles, scope, policy versions and shares are rows; a history entry\'s detail is typed columns by action; idempotency keys are columns of their owner; no JSON columns', references: 'client (player) ids no foreign key, tolerant and counted; staff → org_users and agencies → orgs (RESTRICT); child rows cascade' },
        development: { mode: 'live', rows: development.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedDevelopmentPlayers(sqlite), writeMode: 'explicit: objectives, plans, goals, actions and reviews create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); an evidence link is created and removed; a drill review is recorded; histories, progress and a review\'s content only grow', readMode: 'SQL: objectives byId, forPlayer(s), sharedWith, byReassessment; drill reviews; plans byId, collect (a plan with its goals, actions, links and reviews in one batch), the list candidates of a player, a guardian or an organisation, listCounts, openCount, recentCreate, orgFeed; goals, actions, links and reviews byId; no mirror and no db.* view', typing: 'typed columns only: objective items, exercise references, evidence ids, progress, shares, reassessments, plan shares, review goal snapshots and their evidence references are ordered child rows; a target is columns; one history table whose detail is columns; supersededBy and shareScopes derived; no JSON columns', references: 'player, guardian, evidence, cited-record and actor ids no foreign key (tolerant, counted); organisations → orgs and an objective\'s staff → org_users (RESTRICT); within the domain RESTRICT; child rows cascade with their owner' },
        boxCam: { mode: 'live', rows: boxCam.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedBoxCamPlayers(sqlite), writeMode: 'explicit: preferences saved, challenges, entries, assignments, sessions, disputes, Combine requests and attempts created and updated whole (inside the route\'s unit of work when one is open); a session\'s observations appended per accepted batch; a CV result recorded once; a session\'s integrity history only grows', readMode: 'SQL: preferences (defaults without a row), challenges open or an organisation\'s, entries, assignments and requests of a player or an organisation, sessions by id, player, assignment and their observation stream, the dispute queue (paged), attempts by player and session, CV results by provider session or Box Cam session; no mirror and no db.* view', typing: 'typed columns only: the nonce stored as its SHA-256; observations, verification reasons, integrity events, request protocols, attempt reasons and calibration checks, CV quality codes and trace are ordered child rows; a calibration\'s required checks come from the pinned protocol; no JSON columns', references: 'player, guardian, media and actor ids no foreign key (tolerant, counted); organisations, assigning and requesting staff and an assignment\'s objective RESTRICT; within the domain RESTRICT; child rows cascade with their owner' },
        discovery: { mode: 'live', rows: discovery.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedDiscoveryPlayers(sqlite), writeMode: 'explicit: briefs, Nobody Missed reviews, Second Look items and watchlists created and updated whole (inside the route\'s unit of work when one is open); a read that finds a change records it as an explicit upsert in one unit (Second Look items and their notification; a watchlist\'s membership, its new transitions and their notification), and a read that finds none writes nothing; trails only grow', readMode: 'SQL: briefs, items and watchlists by id and organisation, reviews by organisation, brief and player, a watchlist\'s last membership, the watchlist list and its transitions (paged), the latest change batch; no mirror and no db.* view', typing: 'typed columns only: brief criteria as columns with positions, evidence requirements and Combine protocols as rows (position groups worked out); watchlist criteria as typed columns by kind with their values as rows; fingerprints, resolved reasons, trails and the last membership as rows; no JSON columns', references: 'player ids no foreign key (tolerant, counted); organisations, staff, a review\'s and a watchlist\'s brief, and the room and decision an item or review names RESTRICT; within the domain RESTRICT; child rows cascade with their owner' },
        insightCoverage: { mode: 'live', rows: insightCoverage.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedInsightPlayers(sqlite), writeMode: 'explicit: exposure events recorded once a day, deferrals replaced, evidence suggestions reconciled and moved by status, calibration sessions created, submitted, noted and closed, fixtures, plans and assignments created, completed and cancelled (inside the route\'s unit of work when one is open)' },
        integrations: { mode: 'live', rows: integrations.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedIntegrationPlayers(sqlite), webhookBacklog: integrations.deliveries.backlogCount(), writeMode: 'explicit: import batches created, committed (with their prospects, identity reviews and webhook deliveries in one unit) and reversed; a review resolved, a separate prospect kept; API keys created, revoked and touched on use; webhook endpoints created, rotated and deactivated; a delivery\'s attempts recorded one at a time (inside the route\'s unit of work when one is open)', readMode: 'SQL: batches and prospects paged by cursor, the open reviews, keys and endpoints of one organisation, the due deliveries by an indexed query; secrets and key hashes are never served' },
        enterprise: { mode: 'live', rows: enterprise.counts(), pendingWrites: 0, writeMode: 'explicit: invites created, accepted, revoked and expired, SSO configured and sign-in states created and used once, tickets created and replied to, access grants requested, approved and logged (inside the route\'s unit of work when one is open)' },
        groups: { mode: 'live', rows: groups.counts(), pendingWrites: 0, writeMode: 'explicit: groups created, organisations invited, joining and leaving, templates shared and programmes added; grants created and revoked, and ended on departure when the owner no longer shares a group with any recipient (inside the route\'s unit of work when one is open)' },
        grassroots: { mode: 'live', rows: grassroots.counts(), pendingWrites: 0, writeMode: 'explicit: open days posted and deleted (a stamp; the row stays for the coverage assignments that name it), registrations made and answered once, a deleted player\'s name redacted; match days logged with their credited players; friendlies posted and answered once per club (inside the route\'s unit of work when one is open)', readMode: 'SQL: an organisation\'s open days and match days (paged), the friendlies board by date with a radius prefilter on the host club\'s location (paged), the no-ghosting count, the upcoming open days by club or area, counts; no mirror and no db.* view', typing: 'typed columns only: positions, registrations, credited players and responses as rows; calendar days checked; no JSON columns', references: 'player and guardian ids no foreign key (tolerant); organisations and staff RESTRICT; child rows cascade with their owner' },
        operations: { mode: 'live', rows: operations.counts(), pendingWrites: 0, writeMode: 'explicit: upload sessions opened, chunks recorded, finalised (with the media row), aborted, abandoned by the sweep and deleted with the player; saved searches created and deleted; one invoice issued per signing after it commits; provider callback ids remembered at once (the newest 5,000); injected failures added and used up (inside the route\'s unit of work when one is open)', readMode: 'SQL: a player\'s upload by id, an organisation\'s saved searches, the saved searches a new player could match (prefiltered by position, foot, country and availability), invoices by organisation and in all (paged), the demo reputation rows, the delivery centre\'s start; no mirror and no db.* view', typing: 'typed columns only: chunks received as rows, search filters as columns, invoice amounts in minor units; no JSON columns; plans and archetypes are constants (catalogue.mjs)', references: 'player ids no foreign key (sessions deleted with the player explicitly); organisations, staff and signings RESTRICT' },
        safetyAudit: { mode: 'live', rows: safetyAudit.counts(), pendingWrites: safetyAudit.pending(), unresolvedPlayerReferences: unresolvedPlayerReferences(sqlite), retainedPlayerReferences: retainedPlayerReferences(sqlite), writeMode: 'explicit: a block with its ledger row, a report with its suspension blocks and frozen requests, a moderation hit with its automatic escalation, a report\'s resolution with the organisation\'s suspension, an ID check with the guardian\'s column, each in one unit of work; a lifted block is deleted (Q5); the source-change log keeps the newest 20,000 rows', references: 'organisations and staff are RESTRICT keys. The five player references (blocks, reports, org_notes, ledger, source_changes) carry no key (Q4): an id that resolves to no player is counted here, never refused. The ID-check queue names an existing guardian, checked on every write and on every snapshot (Q4b)' },
      },
      identity: { initState: identity.initState() },
      mediaDeletions: { queued: mediaDeletions.count(), conflicts: mediaDeletions.conflicts().length },
    }),
  };
}
