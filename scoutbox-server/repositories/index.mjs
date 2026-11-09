/**
 * The data layer: every domain's tables in one SQLite file, each owned by one repository. `attachDataLayer` runs the
 * table migrations and attaches the repositories in dependency order (organisations → identity → staff → sessions →
 * the rest), so every repository that references another finds its rows in place on a first installation.
 *
 * `readAllRecords` is the test suites' whole-database read (scripts/dataLayerFixture.mjs `readRecords`). Nothing writes
 * a whole collection: every write is a repository operation.
 *
 * This directory is `repositories/`, not `data/`: `data/` is the server's runtime data directory (DATA_DIR), which
 * tests delete between runs.
 */
import { runDataMigrations, dataSchemaReport } from './database.mjs';
import { createUsersRepository, USERS_TABLE } from './users.mjs';
import { createSessionsRepository, SESSIONS_TABLE } from './sessions.mjs';
import { createOrgsRepository, ORGS_TABLE } from './orgs.mjs';
import { createIdentityRepositories, IDENTITY_RECORDS, IDENTITY_COLLECTIONS, PLAYERS_RETAINED } from './identity.mjs';
import { createMediaDeletionsQueue, MEDIA_DELETIONS_TABLE } from './mediaDeletions.mjs';
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
import * as m0040 from './migrations/0040_match_facts.mjs';
import { createRecruitmentRepository, RECRUITMENT_RECORDS, RECRUITMENT_COLLECTIONS, unresolvedPlayerReferences as unresolvedRecruitmentPlayers, retainedPlayerReferences as retainedRecruitmentPlayers } from './recruitment.mjs';
import { createRecruitmentCasesRepository, RECRUITMENT_CASES_RECORDS, RECRUITMENT_CASES_COLLECTIONS, unresolvedPlayerReferences as unresolvedCasePlayers, retainedPlayerReferences as retainedCasePlayers } from './recruitmentCases.mjs';
import { createRecruitmentContactsOffersRepository, CONTACTS_OFFERS_RECORDS, RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS, unresolvedPlayerReferences as unresolvedContactOfferPlayers, retainedPlayerReferences as retainedContactOfferPlayers } from './recruitmentContactsOffers.mjs';
import { createSigningsFollowUpsRepository, SIGNINGS_FOLLOWUPS_RECORDS, SIGNINGS_FOLLOWUPS_COLLECTIONS, unresolvedPlayerReferences as unresolvedSigningPlayers, retainedPlayerReferences as retainedSigningPlayers } from './signingsFollowUps.mjs';
import { createScoutingEvidenceRepository, SCOUTING_EVIDENCE_RECORDS, SCOUTING_EVIDENCE_COLLECTIONS, unresolvedPlayerReferences as unresolvedEvidencePlayers, retainedPlayerReferences as retainedEvidencePlayers } from './scoutingEvidence.mjs';
import { createScoutingAssessmentsRepository, SCOUTING_ASSESSMENTS_RECORDS, SCOUTING_ASSESSMENTS_COLLECTIONS, unresolvedPlayerReferences as unresolvedAssessmentPlayers, retainedPlayerReferences as retainedAssessmentPlayers } from './scoutingAssessments.mjs';
import { createClubSetupRepository, CLUB_SETUP_RECORDS, CLUB_SETUP_COLLECTIONS, unresolvedPlayerReferences as unresolvedClubSetupPlayers, retainedPlayerReferences as retainedClubSetupPlayers } from './clubSetup.mjs';
import { createOpportunitiesCampaignsRepository, OPPORTUNITIES_CAMPAIGNS_RECORDS, OPPORTUNITIES_CAMPAIGNS_COLLECTIONS, unresolvedPlayerReferences as unresolvedOpportunityPlayers, retainedPlayerReferences as retainedOpportunityPlayers } from './opportunitiesCampaigns.mjs';
import { createVerificationRepository, VERIFICATION_RECORDS, VERIFICATION_COLLECTIONS, unresolvedPlayerReferences as unresolvedVerificationPlayers, retainedPlayerReferences as retainedVerificationPlayers } from './verification.mjs';
import { createPassportRepository, PASSPORT_RECORDS, PASSPORT_COLLECTIONS, unresolvedPlayerReferences as unresolvedPassportPlayers, retainedPlayerReferences as retainedPassportPlayers } from './passport.mjs';
import { createAgentCoreRepository, AGENT_CORE_RECORDS, AGENT_CORE_COLLECTIONS, unresolvedPlayerReferences as unresolvedAgentPlayers, retainedPlayerReferences as retainedAgentPlayers } from './agentCore.mjs';
import { createCompliancePoliciesRepository, COMPLIANCE_POLICIES_RECORDS, COMPLIANCE_POLICIES_COLLECTIONS } from './compliancePolicies.mjs';
import { createComplianceRecordsRepository, COMPLIANCE_RECORDS_RECORDS, COMPLIANCE_RECORDS_COLLECTIONS, unresolvedPlayerReferences as unresolvedCompliancePlayers } from './complianceRecords.mjs';
import { createAgentTransactionsRepository, AGENT_TRANSACTIONS_RECORDS, AGENT_TRANSACTIONS_COLLECTIONS, unresolvedPlayerReferences as unresolvedTransactionPlayers } from './agentTransactions.mjs';
import { createDevelopmentRepository, DEVELOPMENT_RECORDS, DEVELOPMENT_COLLECTIONS, unresolvedPlayerReferences as unresolvedDevelopmentPlayers } from './development.mjs';
import { createBoxCamRepository, BOX_CAM_RECORDS, BOX_CAM_COLLECTIONS, unresolvedPlayerReferences as unresolvedBoxCamPlayers } from './boxCam.mjs';
import { createDiscoveryRepository, DISCOVERY_RECORDS, DISCOVERY_COLLECTIONS, unresolvedPlayerReferences as unresolvedDiscoveryPlayers } from './discovery.mjs';
import { createInsightCoverageRepository, INSIGHT_COVERAGE_RECORDS, INSIGHT_COVERAGE_COLLECTIONS, unresolvedPlayerReferences as unresolvedInsightPlayers } from './insightCoverage.mjs';
import { createIntegrationsRepository, INTEGRATIONS_RECORDS, INTEGRATIONS_COLLECTIONS, unresolvedPlayerReferences as unresolvedIntegrationPlayers } from './integrations.mjs';
import { createEnterpriseRepository, ENTERPRISE_RECORDS, ENTERPRISE_COLLECTIONS } from './enterprise.mjs';
import { createGroupsRepository, GROUPS_RECORDS, GROUPS_COLLECTIONS } from './groups.mjs';
import { createGrassrootsRepository, GRASSROOTS_RECORDS, GRASSROOTS_COLLECTIONS } from './grassroots.mjs';
import { createMatchFactsRepository } from './matchFacts.mjs';
import { createOperationsRepository, OPERATIONS_RECORDS, OPERATIONS_COLLECTIONS } from './operations.mjs';
import { createTransitionsVouchesRepository, TRANSITIONS_RECORDS, TRANSITIONS_COLLECTIONS, unresolvedPlayerReferences as unresolvedTransitionPlayers, retainedPlayerReferences as retainedTransitionPlayers } from './transitionsVouches.mjs';
import { createOneTimeCodesRepository, EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE } from './oneTimeCodes.mjs';
import { createNotificationsRepository, NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE } from './notifications.mjs';
import { createDispatchesRepository, DISPATCHES_TABLE } from './dispatches.mjs';
import { createOutboxPushRepository, OUTBOX_PUSH_RECORD_TABLES } from './outboxPush.mjs';
import { createChannelsRepository, CHANNELS_TABLE } from './channels.mjs';
import { createSafetyAuditRepository, AUDIT_COLLECTIONS, SAFETY_AUDIT_RECORDS, unresolvedPlayerReferences, retainedPlayerReferences } from './safetyAudit.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020, m0021, m0022, m0023, m0024, m0025, m0026, m0027, m0028, m0029, m0030, m0031, m0032, m0033, m0034, m0035, m0036, m0037, m0038, m0039, m0040]);

// The single-collection tables `readAllRecords` reads.
const TABLES = Object.freeze([ORGS_TABLE, USERS_TABLE, SESSIONS_TABLE]);

/** Every record collection: what `readAllRecords` returns. */
export const TABLE_BACKED = Object.freeze(['orgs', ...IDENTITY_COLLECTIONS, PLAYERS_RETAINED.name, 'users', 'sessions', MEDIA_DELETIONS_TABLE.name, EMAIL_CHALLENGES_TABLE.name, PAIRING_CODES_TABLE.name, NOTIFICATIONS_TABLE.name, NOTIFICATION_PREFS_TABLE.name, DISPATCHES_TABLE.name, ...OUTBOX_PUSH_RECORD_TABLES.map((t) => t.name), CHANNELS_TABLE.name, ...AUDIT_COLLECTIONS, ...RECRUITMENT_COLLECTIONS, ...RECRUITMENT_CASES_COLLECTIONS, ...RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS, ...SIGNINGS_FOLLOWUPS_COLLECTIONS, ...SCOUTING_EVIDENCE_COLLECTIONS, ...SCOUTING_ASSESSMENTS_COLLECTIONS, ...CLUB_SETUP_COLLECTIONS, ...OPPORTUNITIES_CAMPAIGNS_COLLECTIONS, ...VERIFICATION_COLLECTIONS, ...PASSPORT_COLLECTIONS, ...TRANSITIONS_COLLECTIONS, ...AGENT_CORE_COLLECTIONS, ...COMPLIANCE_POLICIES_COLLECTIONS, ...COMPLIANCE_RECORDS_COLLECTIONS, ...AGENT_TRANSACTIONS_COLLECTIONS, ...DEVELOPMENT_COLLECTIONS, ...BOX_CAM_COLLECTIONS, ...DISCOVERY_COLLECTIONS, ...INSIGHT_COVERAGE_COLLECTIONS, ...INTEGRATIONS_COLLECTIONS, ...ENTERPRISE_COLLECTIONS, ...GROUPS_COLLECTIONS, ...GRASSROOTS_COLLECTIONS, ...OPERATIONS_COLLECTIONS]);
/** The one-time-code tables. */
const CODE_TABLES = Object.freeze([EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE]);
/** The outbox and push tables. */
const NOTIFICATION_TABLE_DISPATCH = Object.freeze([...OUTBOX_PUSH_RECORD_TABLES]);
/** The notifications and preferences. */
const NOTIFICATION_FEED_TABLES = Object.freeze([NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE]);

/** The whole database as plain records, collection by collection. */
export function readAllRecords(sqlite) {
  const out = {};
  for (const table of TABLES) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  const identity = IDENTITY_RECORDS.read(sqlite);
  if (identity) Object.assign(out, identity);
  const retained = PLAYERS_RETAINED.read(sqlite); // under their own name, never inside `players`
  if (retained) out[PLAYERS_RETAINED.name] = retained;
  const queue = MEDIA_DELETIONS_TABLE.read(sqlite);
  if (queue) out[MEDIA_DELETIONS_TABLE.name] = queue;
  for (const table of [...CODE_TABLES, ...NOTIFICATION_FEED_TABLES, ...NOTIFICATION_TABLE_DISPATCH, DISPATCHES_TABLE, CHANNELS_TABLE]) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  const audit = SAFETY_AUDIT_RECORDS.read(sqlite);
  if (audit) Object.assign(out, audit);
  const recruitment = RECRUITMENT_RECORDS.read(sqlite);
  if (recruitment) Object.assign(out, recruitment);
  const cases = RECRUITMENT_CASES_RECORDS.read(sqlite);
  if (cases) Object.assign(out, cases);
  const contactsOffers = CONTACTS_OFFERS_RECORDS.read(sqlite);
  if (contactsOffers) Object.assign(out, contactsOffers);
  const signings = SIGNINGS_FOLLOWUPS_RECORDS.read(sqlite);
  if (signings) Object.assign(out, signings);
  const evidence = SCOUTING_EVIDENCE_RECORDS.read(sqlite);
  if (evidence) Object.assign(out, evidence);
  const assessments = SCOUTING_ASSESSMENTS_RECORDS.read(sqlite);
  if (assessments) Object.assign(out, assessments);
  const clubSetup = CLUB_SETUP_RECORDS.read(sqlite);
  if (clubSetup) Object.assign(out, clubSetup);
  const opportunitiesCampaigns = OPPORTUNITIES_CAMPAIGNS_RECORDS.read(sqlite);
  if (opportunitiesCampaigns) Object.assign(out, opportunitiesCampaigns);
  const verification = VERIFICATION_RECORDS.read(sqlite);
  if (verification) Object.assign(out, verification);
  const passport = PASSPORT_RECORDS.read(sqlite);
  if (passport) Object.assign(out, passport);
  const transitions = TRANSITIONS_RECORDS.read(sqlite);
  if (transitions) Object.assign(out, transitions);
  const agentCore = AGENT_CORE_RECORDS.read(sqlite);
  if (agentCore) Object.assign(out, agentCore);
  const compliancePolicies = COMPLIANCE_POLICIES_RECORDS.read(sqlite);
  if (compliancePolicies) Object.assign(out, compliancePolicies);
  const complianceRecords = COMPLIANCE_RECORDS_RECORDS.read(sqlite);
  if (complianceRecords) Object.assign(out, complianceRecords);
  const agentTransactions = AGENT_TRANSACTIONS_RECORDS.read(sqlite);
  if (agentTransactions) Object.assign(out, agentTransactions);
  const development = DEVELOPMENT_RECORDS.read(sqlite);
  if (development) Object.assign(out, development);
  const boxCam = BOX_CAM_RECORDS.read(sqlite);
  if (boxCam) Object.assign(out, boxCam);
  const discovery = DISCOVERY_RECORDS.read(sqlite);
  if (discovery) Object.assign(out, discovery);
  const insight = INSIGHT_COVERAGE_RECORDS.read(sqlite);
  if (insight) Object.assign(out, insight);
  const integrations = INTEGRATIONS_RECORDS.read(sqlite);
  if (integrations) Object.assign(out, integrations);
  const enterprise = ENTERPRISE_RECORDS.read(sqlite);
  if (enterprise) Object.assign(out, enterprise);
  const groups = GROUPS_RECORDS.read(sqlite);
  if (groups) Object.assign(out, groups);
  const grassroots = GRASSROOTS_RECORDS.read(sqlite);
  if (grassroots) Object.assign(out, grassroots);
  const operations = OPERATIONS_RECORDS.read(sqlite);
  if (operations) Object.assign(out, operations);
  return out;
}
const schemaVersionOf = (sqlite) => Number(sqlite.prepare('SELECT MAX(id) AS id FROM data_migrations').get()?.id?.slice(0, 4)) || 0;


/**
 * Attach every domain repository to the store's database: run the table migrations, then create the repositories.
 * `seed` is a first installation's records (`orgs`, `players`, `guardians`, `reputationSeed`; buildSeed() in
 * seed.mjs, or a fixture), imported once while the organisations and the identity pair are still `pending`, and
 * ignored on every later boot.
 */
export function attachDataLayer({ seed = {}, store, nextId, sessionTtlMs, now = Date.now, log = () => {}, warn = (m) => console.warn(m) }) {
  const sqlite = store?.sqlite ?? null;
  if (!sqlite) throw new TypeError('the data layer needs a store with a SQLite connection (node:sqlite); there is no in-memory or JSON fallback');
  const migrations = runDataMigrations(sqlite, DATA_MIGRATIONS, { now: now(), log, context: { sessionTtlMs } });

  // The organisations attach first: org_users, and most tables after them, reference orgs.
  const orgs = createOrgsRepository({ sqlite, nextId, log, now, unit: store.unit });
  const orgsBoot = orgs.initState() === 'pending' ? orgs.initialize(seed.orgs ?? []) : orgs.attach();

  // Players' trial reports come from the recruitment repository, attached below (a first installation's seed carries
  // none).
  let recruitment = null;
  /** A collection the caller handed in (the seed's or a fixture's plain array), or []. */
  const handedIn = (name) => (Object.hasOwn(seed, name) && Array.isArray(seed[name]) ? seed[name] : []);
  const identity = createIdentityRepositories({ sqlite, log, unit: store.unit, now, trialReportsOf: (ids) => (recruitment ? recruitment.trialReportsForPlayers(ids) : new Map()) });
  const identityWasPending = identity.initState() === 'pending'; // a first installation: its seed (and the demo reputation rows) is imported once
  const identityBoot = identityWasPending
    ? identity.initialize({ players: seed.players ?? [], guardians: seed.guardians ?? [] }, { now: now() })
    : identity.attach();

  const users = createUsersRepository({ sqlite, nextId, log, now, unit: store.unit });
  const usersBoot = users.attach();

  const sessions = createSessionsRepository({ sqlite, sessionTtlMs, log });
  const sessionsBoot = sessions.attach();

  const mediaDeletions = createMediaDeletionsQueue({ sqlite, log, warn, now });

  const codes = createOneTimeCodesRepository({ sqlite, log, now, unit: store.unit });
  const codesBoot = codes.attach({ at: now() });

  const notifications = createNotificationsRepository({ sqlite, log, now, nextId, unit: store.unit });
  const notificationsBoot = notifications.attach();

  const dispatches = createDispatchesRepository({ sqlite, log, now, unit: store.unit });
  const dispatchesBoot = dispatches.attach();
  const outboxPush = createOutboxPushRepository({ sqlite, log, now, unit: store.unit });
  const outboxPushBoot = outboxPush.attach();

  // The remaining repositories, in dependency order.
  const recruitmentContactsOffers = createRecruitmentContactsOffersRepository({ sqlite, log, now, unit: store.unit });
  const recruitmentContactsOffersBoot = recruitmentContactsOffers.attach();
  const recruitmentCases = createRecruitmentCasesRepository({ sqlite, log, now, unit: store.unit });
  const recruitmentCasesBoot = recruitmentCases.attach();
  recruitment = createRecruitmentRepository({ sqlite, log, now, unit: store.unit });
  const recruitmentBoot = recruitment.attach();
  const signingsFollowUps = createSigningsFollowUpsRepository({ sqlite, log, now, unit: store.unit });
  const signingsFollowUpsBoot = signingsFollowUps.attach();
  const scoutingEvidence = createScoutingEvidenceRepository({ sqlite, log, now, unit: store.unit });
  const scoutingEvidenceBoot = scoutingEvidence.attach();
  const scoutingAssessments = createScoutingAssessmentsRepository({ sqlite, log, now, unit: store.unit });
  const scoutingAssessmentsBoot = scoutingAssessments.attach();
  const clubSetup = createClubSetupRepository({ sqlite, log, now, unit: store.unit });
  const clubSetupBoot = clubSetup.attach();
  const opportunitiesCampaigns = createOpportunitiesCampaignsRepository({ sqlite, log, now, unit: store.unit });
  const opportunitiesCampaignsBoot = opportunitiesCampaigns.attach();
  const verification = createVerificationRepository({ sqlite, log, now, unit: store.unit });
  const verificationBoot = verification.attach();
  const passport = createPassportRepository({ sqlite, log, now, unit: store.unit });
  const passportBoot = passport.attach();
  const transitionsVouches = createTransitionsVouchesRepository({ sqlite, log, now, unit: store.unit });
  const transitionsVouchesBoot = transitionsVouches.attach();
  const compliancePolicies = createCompliancePoliciesRepository({ sqlite, log, now, unit: store.unit });
  const compliancePoliciesBoot = compliancePolicies.attach();
  const agentCore = createAgentCoreRepository({ sqlite, log, now, unit: store.unit, policyVersionKnown: (id) => compliancePolicies.policies.exists(id) });
  const agentCoreBoot = agentCore.attach();
  const complianceRecords = createComplianceRecordsRepository({ sqlite, log, now, unit: store.unit });
  const complianceRecordsBoot = complianceRecords.attach();
  const agentTransactions = createAgentTransactionsRepository({ sqlite, log, now, unit: store.unit });
  const agentTransactionsBoot = agentTransactions.attach();
  const development = createDevelopmentRepository({ sqlite, log, now, unit: store.unit });
  const developmentBoot = development.attach();
  const boxCam = createBoxCamRepository({ sqlite, log, now, unit: store.unit });
  const boxCamBoot = boxCam.attach();
  const discovery = createDiscoveryRepository({ sqlite, log, now, unit: store.unit });
  const discoveryBoot = discovery.attach();
  const insightCoverage = createInsightCoverageRepository({ sqlite, log, now, unit: store.unit });
  const insightCoverageBoot = insightCoverage.attach();
  const integrations = createIntegrationsRepository({ sqlite, log, now, unit: store.unit });
  const integrationsBoot = integrations.attach();
  const enterprise = createEnterpriseRepository({ sqlite, log, now, unit: store.unit });
  const enterpriseBoot = enterprise.attach();
  const groups = createGroupsRepository({ sqlite, log, now, unit: store.unit });
  const groupsBoot = groups.attach();
  const grassroots = createGrassrootsRepository({ sqlite, log, now, unit: store.unit });
  const grassrootsBoot = grassroots.attach();
  const operations = createOperationsRepository({ sqlite, log, now, unit: store.unit });
  const operationsBoot = operations.attach({ seedReputation: identityWasPending ? handedIn('reputationSeed') : [] });

  // The match facts are derived (kept by triggers on their inputs, re-derived before COMMIT by the builder the
  // discovery domain registers); they have no collection and are never read back as records.
  const matchFacts = createMatchFactsRepository({ sqlite, now });

  const channels = createChannelsRepository({ sqlite, log, now, unit: store.unit });
  const channelsBoot = channels.attach();

  const safetyAudit = createSafetyAuditRepository({ sqlite, log, now, unit: store.unit });
  const safetyAuditBoot = safetyAudit.attach();

  return {
    matchFacts,
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
    /** The schema version: the number of the latest applied table migration (`0040_…` → 40). */
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
        channels: { mode: 'live', rows: channels.counts(), pendingWrites: 0, writeMode: 'explicit: a thread opens with the request\'s acceptance, in its unit of work; a message with its ledger row and notifications in one unit; a receipt at once; a deleted player\'s threads go in the account-deletion unit (D-B)', readMode: 'SQL: byId, parties, a player\'s and a guardian\'s threads, the organisation\'s and the admin lists by cursor (most recently active first), the organisation\'s counts, the retry lookup; no mirror and no db.* view', references: 'request_id (unique), org_id and a staff sender are RESTRICT keys; player and guardian ids carry no key (tolerant), a guardian is checked at open; messages and attachments cascade with their thread' },
        recruitment: { mode: 'live', rows: recruitment.counts(), pendingWrites: recruitment.pending(), unresolvedPlayerReferences: unresolvedRecruitmentPlayers(sqlite), retainedPlayerReferences: retainedRecruitmentPlayers(sqlite), writeMode: 'named acts: a request or a trial is created whole and must read back as written, then changes only through acts named after what happened (requests.recordResponse / attachChannel / suspend / linkTrial; trials.proposeSchedule, confirmSchedule, cancel, complete, recordAttendance, linkEvidence, fileReport, markReminders, addStaff, checkIn, recordAct, …; redactPlayer), each an UPDATE or INSERT of its own rows inside the route\'s unit of work, guarded in SQL (one schedule revision at a time, nothing changes an ended trial, a report filed once) and re-reading the record; history is only appended; the views are read-only', references: 'player_id (both tables) no foreign key, TOLERANT (Q7a): live, retained and historically missing ids resolve, are counted here and never refused, fabricated or deleted. case_id (both tables) → recruitment_cases (RESTRICT, immediate); recruitment_requests.trial_id → trials DEFERRABLE INITIALLY DEFERRED (a request and its trial are written in one unit). guardian_id and recipient_guardian_id no foreign key, STRICT in code (Q7c): checked at every write. trials.request_id NOT NULL UNIQUE → recruitment_requests (RESTRICT); trial_reports (trial_id, player_id) → trials (a report names its trial\'s player); org_id and user_id → orgs / org_users (RESTRICT); the child tables cascade with their owner. The direct request route keeps its REQUEST_PENDING rule (D2)' },
        recruitmentCases: { mode: 'live', rows: recruitmentCases.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedCasePlayers(sqlite), retainedPlayerReferences: retainedCasePlayers(sqlite), writeMode: 'named acts: a record is created whole and must read back as written, then changes only through acts named after what happened (cases.moveRoom, addTask, startDraft, inviteHandoff, addScenario, recordAct, …; comments.edit / remove; decisions.markSuperseded / recordLifecycle / bump; evidenceStates.review; snapshots are created only), each an UPDATE or INSERT of its own rows — inside the route\'s unit of work when one is open, in a transaction of its own otherwise — re-reading the record from the tables; history is only appended; the views hold read-only records (an in-place edit throws); no flush, no fingerprint', typing: 'typed columns only: the vocabulary and length CHECKs are the only judge of the values; a Room moves only along ROOM_TRANSITIONS (and the resume out of on_hold), an approval and a handoff only out of their open state; one case history entry shape; a decision\'s snapshot is the room_snapshots row it names; the idempotency keys as columns; no absent_keys_json, offtype_json, extra_json or raw_json; a record the columns cannot hold (an unknown field included) is refused with its id', references: 'player_id (recruitment_cases, room_snapshots, room_decisions, case_transaction_handoffs) no foreign key, TOLERANT (Q8a): live, retained and historically missing ids resolve, are counted here and never refused. org_id → orgs and the staff ids (owner, lead scout, M12 decision maker, assignee, comment author) → org_users (RESTRICT); room_id (the four room tables) → recruitment_cases (RESTRICT); a decision\'s snapshot_id → room_snapshots (RESTRICT); case_request_links → recruitment_requests and case_trial_links → trials (RESTRICT); the case_id of requests, trials, contacts and offers → recruitment_cases (RESTRICT, immediate). A decision\'s snapshot and chain and a comment\'s reply are composite keys (room_id, …) into the same room\'s rows. The children cascade with their owner. The one-open-room rule is the routes\'' },
        recruitmentContactsOffers: { mode: 'live', rows: recruitmentContactsOffers.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedContactOfferPlayers(sqlite), retainedPlayerReferences: retainedContactOfferPlayers(sqlite), writeMode: 'explicit: every change is a repository operation (contacts.create / update / redactPlayer; offers.create / update / redactPlayer) that writes its rows at once — inside the route\'s unit of work when one is open, in a transaction of its own otherwise — and returns the record read back from the tables; no flush, no fingerprint', readMode: 'SQL: every read is a repository query (byId, forCase, forOrgPlayer, forPlayer(s), forRequest, forAgent / forAgentShare, forOrg) that decodes deep-frozen records (an in-place edit throws); no in-memory mirror and no db.* view', typing: 'typed columns only (file 02): the vocabulary and length CHECKs; the idempotency keys as columns and offer_keys rows; no absent_keys_json, offtype_json, extra_json or raw_json; a record the columns cannot hold (an unknown field included) is refused with its id', references: 'player ids no foreign key, TOLERANT and counted (Q8c-a); guardian ids no foreign key (the routes resolve the guardian first, Q8c-b); org_id → orgs and the staff ids → org_users (RESTRICT); case_id → recruitment_cases (RESTRICT, immediate); a contact\'s request_id → recruitment_requests DEFERRABLE INITIALLY DEFERRED (a send writes its contact before the request); every offer pointer (current revision, response, supersedes, superseded by, discarded by, a response\'s, receipt\'s or key\'s revision) names a row of the same offer; contact_history and offer_history → their owner (RESTRICT); every other child cascades' },
        signingsFollowUps: { mode: 'live', rows: signingsFollowUps.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedSigningPlayers(sqlite), retainedPlayerReferences: retainedSigningPlayers(sqlite), writeMode: 'explicit: every change is a repository operation (signingPackages.insert / patch / patchRevision / addRevision / setDocument / setParty / addKey / addHistory / redactPlayer; signings.record; followUps.schedule / patch; outcomeReports.file / addConfirmation) that writes its rows at once — inside the route\'s unit of work when one is open, in a transaction of its own otherwise — and returns the record read back from the tables; no flush, no fingerprint', readMode: 'SQL: every read is a repository query (byId, forCase / forOffer / forOrg / forPlayer / forOrgPlayer, forPackage, forSigning, forFollowUp, the sweep\'s due queries, the admin totals) decoding deep-frozen records; the club follow-up and signing lists page by cursor; no in-memory mirror and no db.* view', typing: 'typed columns only (file 02): the vocabulary and length CHECKs; no absent_keys_json, offtype_json or extra_json; a record the columns cannot hold is refused with its id at the route and the cutover; the cutover normalised exactly what the design note lists and reported each with the row id (meta.signingsFollowUpsCutover.notes)', references: 'player ids no foreign key, TOLERANT and counted (Q7a/Q8a/Q8c-a applied, not re-asked); guardian and party ids polymorphic, no key; org_id → orgs, case_id → recruitment_cases, offer_id → recruitment_offers, the staff ids → org_users (RESTRICT); signing_package_id and signing_revision_id → their tables (RESTRICT); completion_signing_id → signings (RESTRICT, DEFERRABLE INITIALLY DEFERRED: the completion unit writes the signing row and then the package); follow_ups.signing_id, outcome_reports.follow_up_id / signing_id (RESTRICT); offer_revision_id a plain indexed column checked in code (offer_revisions.id is the primary key since §4.3; a real key is a later change). The three uniqueness rules of file 02 are partial unique indexes and are named with ids before the engine would (one live and one completed package per offer; one signing per package, per offer, one standing legacy row per organisation and player; one follow-up per signing and milestone; one report per follow-up)' },
        scoutingEvidence: { mode: 'live', rows: scoutingEvidence.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedEvidencePlayers(sqlite), retainedPlayerReferences: retainedEvidencePlayers(sqlite), writeMode: 'explicit: evidence, coachAffiliations and squadInvites create / update write a record\'s rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: byId, forPlayer / currentForPlayer, byDispute, forOrg, activeFor, pendingFor, forPlayers; the admin dispute and affiliation lists page by offset in SQL; no mirror and no db.* view', references: 'player ids no foreign key, tolerant and counted (as recruitment); media ids no key; org_id → orgs and the staff ids → org_users (RESTRICT); correction_of_id / superseded_by_id → evidence (RESTRICT); one pending invitation per organisation and player (partial unique index)' },
        scoutingAssessments: { mode: 'live', rows: scoutingAssessments.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedAssessmentPlayers(sqlite), retainedPlayerReferences: retainedAssessmentPlayers(sqlite), writeMode: 'explicit: templates.create (append-only versions), assessments create / update / redactPlayer, segments.create, playlists create / update write a record\'s rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: templates all / currentFor / currentById / byIdVersion; assessments byId, forOrg, forOrgPlayer, forOrgScout, forPlayer, withFeedbackForPlayer, anyForTrial; segments byId, forOrg; playlists byId, forOrg; no mirror and no db.* view', references: 'player, media, trial and trial-session ids no foreign key, tolerant and counted (as recruitment); org_id → orgs and the staff ids → org_users (RESTRICT); an assessment\'s template (id, version), first opinion and cited segments, and a playlist\'s segments, are RESTRICT keys inside the domain; the attributes snapshot is the template version\'s attributes, joined on read' },
        clubSetup: { mode: 'live', rows: clubSetup.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedClubSetupPlayers(sqlite), retainedPlayerReferences: retainedClubSetupPlayers(sqlite), writeMode: 'explicit: tactical.save (roles diffed by id), squad create / remove, shadow.create, lookingFor.set, federation.submit, vacancies create / update write their rows at once (inside the route\'s unit of work when one is open)', readMode: 'SQL: tactical forOrg / roleOf; squad byId, forOrg, forPlayer, has, playerIds; shadow forOrg, has; lookingFor forOrg; federation forOrg; vacancies byId, ofOrg, openForOrg, the club list by cursor; no mirror, no db.* view and no organisation facet', references: 'player ids no foreign key, tolerant and counted (as recruitment); org_id → orgs (RESTRICT); roles, criteria and windows cascade with their setup; vacancies.role_id and org_shadow_players.role_id → org_tactical_roles ON DELETE SET NULL (a dropped role), the role checked to be the same organisation\'s; one squad row and one shadow entry per organisation and player' },
        opportunitiesCampaigns: { mode: 'live', rows: opportunitiesCampaigns.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedOpportunityPlayers(sqlite), retainedPlayerReferences: retainedOpportunityPlayers(sqlite), writeMode: 'explicit: opportunities create / update, applications create / update, campaigns.create, submissions create / update, preferences.save write a record\'s rows at once (inside the route\'s unit of work when one is open); a preference row exists only once saved', readMode: 'SQL: opportunities byId, ofOrg, openOn, the club list by cursor, applicationCounts; applications byId, ofOrg, ofPlayers, forPlayers, forOpportunity, pageForOpportunity, liveFor, remindersDue; campaigns byId, ofOrg, openOn, the club list by cursor, submissionCounts; submissions byId, forCampaign, forCampaignPlayer, forPlayer, byAttempt; preferences forPlayer; no mirror and no db.* view', references: 'player ids no foreign key, tolerant and counted (as recruitment); org_id → orgs and the staff ids → org_users (RESTRICT); an application\'s opportunity and a submission\'s campaign RESTRICT; owned children cascade; one live application per opportunity and player, one submission per campaign and player' },
        verification: { mode: 'live', rows: verification.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedVerificationPlayers(sqlite), retainedPlayerReferences: retainedVerificationPlayers(sqlite), writeMode: 'named acts: each record kind is created whole (it must read back as written), then changes only through acts guarded in SQL (claims.move along CLAIM_TRANSITIONS, tokens.use once, admins.revoke, rootRequests.approve / reject, disputes.resolve, …); events.append and domains add / remove (inside the route\'s unit of work when one is open)', readMode: 'SQL: per-kind indexed queries (byId, forSubject, byAuthority, forOrgStaff, byPair, inStatuses, the sweep\'s expiredBy / warnDue, forClaim, byHash, activeFor, openDuplicate, activeForPlayer, forOrg …); no mirror and no db.* view', typing: 'typed columns only: a claim\'s metadata and an evidence record\'s meta are fixed optional columns, review reasons and risk flags are code rows, an event\'s before/after is one detail line; no JSON columns', references: 'player ids no foreign key, tolerant and counted; org_id → orgs and the staff ids → org_users (RESTRICT); claim, evidence, root-application and reference keys inside the domain RESTRICT; codes and evidence links cascade with their claim; polymorphic subject, authority, actor and token ids carry no key' },
        passport: { mode: 'live', rows: passport.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedPassportPlayers(sqlite), retainedPlayerReferences: retainedPassportPlayers(sqlite), writeMode: 'explicit: passportPrefs.save (whole; the position history only grows), careerEntries, achievements, shares and corrections create / update, shares.recordView write their rows at once (inside the route\'s unit of work when one is open); a preference row exists only once saved', readMode: 'SQL: passportPrefs forPlayer; careerEntries and achievements byId, forPlayer; shares byId, byHash, forPlayer, activeCount, the T&S list by cursor; corrections byId, the T&S queue by cursor; no mirror and no db.* view', typing: 'typed columns only: football dates as given (YYYY, YYYY-MM or YYYY-MM-DD), position codes, secondary positions and public selections as ordered child rows; no JSON columns', references: 'player and guardian ids no foreign key, tolerant and counted; a confirmation\'s organisation → orgs (RESTRICT); the preferences\' child rows cascade' },
        transitionsVouches: { mode: 'live', rows: transitionsVouches.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedTransitionPlayers(sqlite), retainedPlayerReferences: retainedTransitionPlayers(sqlite), writeMode: 'named acts: a case or a reference is created whole (it must read back as written), then changes only through acts guarded in SQL (grant, revokeGrant, recordView, withdraw, place, expire, markFollowUpNotified; publish, revoke, withdraw), inside the route\'s unit of work when one is open; no act touches a case\'s pack, owner, note or period, grants and history are only inserted', readMode: 'SQL: transitionCases byId, forPlayer, forPlayers, grantedTo, the sweep\'s expiredBy / followUpsDue; vouches byId, pendingByCode, forPlayer, publishedFor, the T&S list by cursor; no mirror and no db.* view', typing: 'typed columns only: the pack, grants and history are ordered child rows, a history entry\'s detail is an item count or an organisation; a reference code is stored as its SHA-256 hash and cleared when used; no JSON columns', references: 'player and guardian ids no foreign key, tolerant and counted; a grant\'s and a placement\'s organisation → orgs (RESTRICT); pack items, grants and history cascade with their case' },
        complianceRecords: { mode: 'live', rows: complianceRecords.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedCompliancePlayers(sqlite), writeMode: 'explicit: contexts, reviews and consents create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); an evaluation is appended with recordEvaluation, a revocation is its own row (once), an account deletion is forgetPlayer; history only grows, a decision is final, an answered consent is never edited', readMode: 'SQL: contexts byId, forAgent, byCreateKey, openForAgencyExcept, forAgency, outcomeCounts (each context carries its latest evaluation); reviews byId, openForFacet, openForAgreement, forContext, openForContext, forAgency, the T&S queue by cursor (open first), metrics, decisionEntries; consents byId, forContext, forSubject, forAgent, forAgency, byRequestKey, metrics; no mirror and no db.* view', typing: 'typed columns only: a review\'s subject by kind, its snapshot as the evaluation row it names, its decision and prior/resulting state as columns; reasons with their extras as columns and their lists as rows; history details typed or worked out from their record; idempotency keys are columns of their owner; no JSON columns', references: 'agencies → orgs, staff → org_users, reviewers → ts_reviewers, versions → jurisdiction_policies, agreements → representation_agreements, profiles → agent_profiles, and within the domain (RESTRICT); a party\'s, a consent\'s and an approach review\'s player or club id carries no key (tolerant, counted); child rows cascade' },
        agentTransactions: { mode: 'live', rows: agentTransactions.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedTransactionPlayers(sqlite), writeMode: 'explicit: transactions, representation bindings and documents create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); an account deletion is forgetPlayer; history, notes, linked threads, terms versions and keys only grow, a withdrawn binding and a superseded or removed document are final', readMode: 'SQL: transactions byId, byCreateKey, the agent\'s, a club\'s and the Trust & Safety lists by cursor (newest first), agentCounts, forPlayer, liveForIndividual (the duplicate rule), forAgency, live, metrics; bindings byId, forTransaction(s), byAttachKey, forAgency; documents byId, forTransaction, liveForTransactions, liveCount, byAddKey, forAgency; no mirror and no db.* view', typing: 'typed columns only: the compliance snapshot names its evaluation row (or the gate that refused before the engine ran) and reads the outcome, reason codes, policy versions and consent requirements from it; history details as columns with their lists as rows; a document\'s entries worked out from the document; idempotency keys are columns of their owner or rows of the transaction; no JSON columns', references: 'agencies → orgs, staff → org_users, the context and evaluation → compliance_contexts / compliance_evaluations, agreements, reviews, evidence and the cited case (RESTRICT), and within the domain (RESTRICT); a party\'s player or club, a document owner, a linked channel and the trial and opportunity links carry no key (tolerant, counted); child rows cascade' },
        compliancePolicies: { mode: 'live', rows: compliancePolicies.counts(), pendingWrites: 0, writeMode: 'explicit: reviewers and policy versions create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); history only grows, a revocation is final, a version\'s content never changes after it is proposed and its publication happens once; the seeded versions are inserted by migration 0027', readMode: 'SQL: reviewers byId, activeById, all, activeCount; policies byId, exists, all, published (decoded once per change); no mirror and no db.* view', typing: 'typed columns only: rules, sources, overrides and publishers are rows; a rule parameter is typed against the engine\'s vocabulary (RULE_PARAMS), scalars as columns and list or map elements as item rows; no JSON columns', references: 'revoker, proposer and approver → ts_reviewers and supersedes → jurisdiction_policies (RESTRICT); child rows cascade' },
        agentCore: { mode: 'live', rows: agentCore.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedAgentPlayers(sqlite), retainedPlayerReferences: retainedAgentPlayers(sqlite), writeMode: 'explicit: profiles, affiliations and agreements create / update write a record\'s rows at once (inside the route\'s unit of work when one is open), settings.save an agency\'s settings; history only grows, an agreement\'s parties, scope, term and policy versions never change, shares only gain rows', readMode: 'SQL: profiles byId, forUser, forAgency, staleUnnotified, the T&S list by cursor; affiliations activeFor, anyActiveIn, forAgency, byCreateKey; agreements byId, forAgency, forAgent, forClient, forAgentClient, byRequestKey, expiringUnnotified, the T&S list by cursor; settings forOrg; no mirror and no db.* view', typing: 'typed columns only: declared jurisdictions, facets, roles, scope, policy versions and shares are rows; a history entry\'s detail is typed columns by action; idempotency keys are columns of their owner; no JSON columns', references: 'client (player) ids no foreign key, tolerant and counted; staff → org_users and agencies → orgs (RESTRICT); child rows cascade' },
        development: { mode: 'live', rows: development.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedDevelopmentPlayers(sqlite), writeMode: 'explicit: objectives, plans, goals, actions and reviews create / update write a record\'s rows at once (inside the route\'s unit of work when one is open); an evidence link is created and removed; a drill review is recorded; histories, progress and a review\'s content only grow', readMode: 'SQL: objectives byId, forPlayer(s), sharedWith, byReassessment; drill reviews; plans byId, collect (a plan with its goals, actions, links and reviews in one batch), the list candidates of a player, a guardian or an organisation, listCounts, openCount, recentCreate, orgFeed; goals, actions, links and reviews byId; no mirror and no db.* view', typing: 'typed columns only: objective items, exercise references, evidence ids, progress, shares, reassessments, plan shares, review goal snapshots and their evidence references are ordered child rows; a target is columns; one history table whose detail is columns; supersededBy and shareScopes derived; no JSON columns', references: 'player, guardian, evidence, cited-record and actor ids no foreign key (tolerant, counted); organisations → orgs and an objective\'s staff → org_users (RESTRICT); within the domain RESTRICT; child rows cascade with their owner' },
        boxCam: { mode: 'live', rows: boxCam.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedBoxCamPlayers(sqlite), writeMode: 'explicit: preferences saved whole; challenges, entries, assignments, sessions, disputes, Combine requests and attempts created whole (read back as written), then named acts guarded by the state they move from (inside the route\'s unit of work when one is open); a session\'s observations appended per accepted batch; a CV result recorded once; a session\'s integrity history only inserted', readMode: 'SQL: preferences (defaults without a row), challenges open or an organisation\'s, entries, assignments and requests of a player or an organisation, sessions by id, player, assignment and their observation stream, the dispute queue (paged), attempts by player and session, CV results by provider session or Box Cam session; no mirror and no db.* view', typing: 'typed columns only: the nonce stored as its SHA-256; observations, verification reasons, integrity events, request protocols, attempt reasons and calibration checks, CV quality codes and trace are ordered child rows; a calibration\'s required checks come from the pinned protocol; no JSON columns', references: 'player, guardian, media and actor ids no foreign key (tolerant, counted); organisations, assigning and requesting staff and an assignment\'s objective RESTRICT; within the domain RESTRICT, a session\'s assignment and entry, a dispute\'s session and an attempt\'s session and request the same player\'s (composite keys); child rows cascade with their owner' },
        discovery: { mode: 'live', rows: discovery.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedDiscoveryPlayers(sqlite), writeMode: 'explicit: briefs, Nobody Missed reviews, Second Look items and watchlists created and updated whole (inside the route\'s unit of work when one is open); a read that finds a change records it as an explicit upsert in one unit (Second Look items and their notification; a watchlist\'s membership, its new transitions and their notification), and a read that finds none writes nothing; trails only grow', readMode: 'SQL: briefs, items and watchlists by id and organisation, reviews by organisation, brief and player, a watchlist\'s last membership, the watchlist list and its transitions (paged), the latest change batch; no mirror and no db.* view', typing: 'typed columns only: brief criteria as columns with positions, evidence requirements and Combine protocols as rows (position groups worked out); watchlist criteria as typed columns by kind with their values as rows; fingerprints, resolved reasons, trails and the last membership as rows; no JSON columns', references: 'player ids no foreign key (tolerant, counted); organisations, staff, a review\'s and a watchlist\'s brief, and the room and decision an item or review names RESTRICT; within the domain RESTRICT; child rows cascade with their owner' },
        insightCoverage: { mode: 'live', rows: insightCoverage.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedInsightPlayers(sqlite), writeMode: 'explicit: exposure events recorded once a day, deferrals replaced, evidence suggestions reconciled and moved by status, calibration sessions created, submitted, noted and closed, fixtures, plans and assignments created, completed and cancelled (inside the route\'s unit of work when one is open)' },
        integrations: { mode: 'live', rows: integrations.counts(), pendingWrites: 0, unresolvedPlayerReferences: unresolvedIntegrationPlayers(sqlite), webhookBacklog: integrations.deliveries.backlogCount(), writeMode: 'explicit: import batches created, committed (with their prospects, identity reviews and webhook deliveries in one unit) and reversed; a review resolved, a separate prospect kept; API keys created, revoked and touched on use; webhook endpoints created, rotated and deactivated; a delivery\'s attempts recorded one at a time (inside the route\'s unit of work when one is open)', readMode: 'SQL: batches and prospects paged by cursor, the open reviews, keys and endpoints of one organisation, the due deliveries by an indexed query; secrets and key hashes are never served' },
        enterprise: { mode: 'live', rows: enterprise.counts(), pendingWrites: 0, writeMode: 'explicit: invites created, accepted, revoked and expired, SSO configured and sign-in states created and used once, tickets created and replied to, access grants requested, approved and logged (inside the route\'s unit of work when one is open)' },
        groups: { mode: 'live', rows: groups.counts(), pendingWrites: 0, writeMode: 'explicit: groups created, organisations invited, joining and leaving, templates shared and programmes added; grants created and revoked, and ended on departure when the owner no longer shares a group with any recipient (inside the route\'s unit of work when one is open)' },
        grassroots: { mode: 'live', rows: grassroots.counts(), pendingWrites: 0, writeMode: 'explicit: open days posted and deleted (a stamp; the row stays for the coverage assignments that name it), registrations made and answered once, a deleted player\'s name redacted; match days logged with their credited players; friendlies posted and answered once per club (inside the route\'s unit of work when one is open)', readMode: 'SQL: an organisation\'s open days and match days (paged), the friendlies board by date with a radius prefilter on the host club\'s location (paged), the no-ghosting count, the upcoming open days by club or area, counts; no mirror and no db.* view', typing: 'typed columns only: positions, registrations, credited players and responses as rows; calendar days checked; no JSON columns', references: 'player and guardian ids no foreign key (tolerant); organisations and staff RESTRICT; child rows cascade with their owner' },
        operations: { mode: 'live', rows: operations.counts(), pendingWrites: 0, writeMode: 'explicit: upload sessions opened, chunks recorded, finalised (with the media row), aborted, abandoned by the sweep and deleted with the player; saved searches created and deleted; one invoice issued per signing after it commits; provider callback ids remembered at once (the newest 5,000); injected failures added and used up (inside the route\'s unit of work when one is open)', readMode: 'SQL: a player\'s upload by id, an organisation\'s saved searches, the saved searches a new player could match (prefiltered by position, foot, country and availability), invoices by organisation and in all (paged), the demo reputation rows, the delivery centre\'s start; no mirror and no db.* view', typing: 'typed columns only: chunks received as rows, search filters as columns, invoice amounts in minor units; no JSON columns; plans and archetypes are constants (catalogue.mjs)', references: 'player ids no foreign key (sessions deleted with the player explicitly); organisations, staff and signings RESTRICT' },
        matchFacts: { mode: 'derived', rows: matchFacts.counts(), writeMode: 'derived (S14j): triggers on every input table mark the player, and the builder re-derives the marked players before every COMMIT; time-only changes (evidence expiry, a claim\'s valid_until, an agent agreement\'s term, adulthood) are re-derived by the minute sweep; a policy change rebuilds every row at boot', readMode: 'SQL: matching, a watchlist\'s membership and page, Nobody Missed and the evaluation coverage are queries over the visible players joined to their facts, paged by cursor; only a page\'s players are decoded', typing: 'typed columns: the position vocabulary, the evidence-confidence bands, positive instants, booleans as 0/1; secondary positions and Combine results as child rows', references: 'player_id → players ON DELETE CASCADE (a projection of the row); the dirty markers carry no key' },
        safetyAudit: { mode: 'live', rows: safetyAudit.counts(), pendingWrites: safetyAudit.pending(), unresolvedPlayerReferences: unresolvedPlayerReferences(sqlite), retainedPlayerReferences: retainedPlayerReferences(sqlite), writeMode: 'explicit: a block with its ledger row, a report with its suspension blocks and frozen requests, a moderation hit with its automatic escalation, a report\'s resolution with the organisation\'s suspension, an ID check with the guardian\'s column, each in one unit of work; a lifted block is deleted (Q5); the source-change log keeps the newest 20,000 rows', references: 'organisations and staff are RESTRICT keys. The five player references (blocks, reports, org_notes, ledger, source_changes) carry no key (Q4): an id that resolves to no player is counted here, never refused. The ID-check queue names an existing guardian, checked on every write (Q4b)' },
      },
      identity: { initState: identity.initState() },
      mediaDeletions: { queued: mediaDeletions.count(), conflicts: mediaDeletions.conflicts().length },
    }),
  };
}
