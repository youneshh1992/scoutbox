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
import { runDataMigrations, dataSchemaReport } from './database.ts';
import { createUsersRepository, USERS_TABLE } from './users.ts';
import { createSessionsRepository, SESSIONS_TABLE } from './sessions.ts';
import { createOrgsRepository, ORGS_TABLE } from './orgs.ts';
import { createIdentityRepositories, IDENTITY_RECORDS, IDENTITY_COLLECTIONS } from './identity.ts';
import { PLAYERS_RETAINED } from './playerRecord.ts';
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
import { createRecruitmentRepository, RECRUITMENT_RECORDS, RECRUITMENT_COLLECTIONS } from './recruitment.ts';
import {
  createRecruitmentCasesRepository,
  RECRUITMENT_CASES_RECORDS,
  RECRUITMENT_CASES_COLLECTIONS,
} from './recruitmentCases.ts';
import {
  createRecruitmentContactsOffersRepository,
  CONTACTS_OFFERS_RECORDS,
  RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS,
} from './recruitmentContactsOffers.ts';
import {
  createSigningsFollowUpsRepository,
  SIGNINGS_FOLLOWUPS_RECORDS,
  SIGNINGS_FOLLOWUPS_COLLECTIONS,
} from './signingsFollowUps.ts';
import {
  createScoutingEvidenceRepository,
  SCOUTING_EVIDENCE_RECORDS,
  SCOUTING_EVIDENCE_COLLECTIONS,
} from './scoutingEvidence.ts';
import {
  createScoutingAssessmentsRepository,
  SCOUTING_ASSESSMENTS_RECORDS,
  SCOUTING_ASSESSMENTS_COLLECTIONS,
} from './scoutingAssessments.ts';
import { createClubSetupRepository, CLUB_SETUP_RECORDS, CLUB_SETUP_COLLECTIONS } from './clubSetup.ts';
import {
  createOpportunitiesCampaignsRepository,
  OPPORTUNITIES_CAMPAIGNS_RECORDS,
  OPPORTUNITIES_CAMPAIGNS_COLLECTIONS,
} from './opportunitiesCampaigns.ts';
import { createVerificationRepository, VERIFICATION_RECORDS, VERIFICATION_COLLECTIONS } from './verification.ts';
import { createPassportRepository, PASSPORT_RECORDS, PASSPORT_COLLECTIONS } from './passport.ts';
import { createAgentCoreRepository, AGENT_CORE_RECORDS, AGENT_CORE_COLLECTIONS } from './agentCore.mjs';
import {
  createCompliancePoliciesRepository,
  COMPLIANCE_POLICIES_RECORDS,
  COMPLIANCE_POLICIES_COLLECTIONS,
} from './compliancePolicies.mjs';
import {
  createComplianceRecordsRepository,
  COMPLIANCE_RECORDS_RECORDS,
  COMPLIANCE_RECORDS_COLLECTIONS,
} from './complianceRecords.mjs';
import {
  createAgentTransactionsRepository,
  AGENT_TRANSACTIONS_RECORDS,
  AGENT_TRANSACTIONS_COLLECTIONS,
} from './agentTransactions.mjs';
import { createDevelopmentRepository, DEVELOPMENT_RECORDS, DEVELOPMENT_COLLECTIONS } from './development.mjs';
import { createBoxCamRepository, BOX_CAM_RECORDS, BOX_CAM_COLLECTIONS } from './boxCam.mjs';
import { createDiscoveryRepository, DISCOVERY_RECORDS, DISCOVERY_COLLECTIONS } from './discovery.mjs';
import {
  createInsightCoverageRepository,
  INSIGHT_COVERAGE_RECORDS,
  INSIGHT_COVERAGE_COLLECTIONS,
} from './insightCoverage.mjs';
import { createIntegrationsRepository, INTEGRATIONS_RECORDS, INTEGRATIONS_COLLECTIONS } from './integrations.mjs';
import { createEnterpriseRepository, ENTERPRISE_RECORDS, ENTERPRISE_COLLECTIONS } from './enterprise.mjs';
import { createGroupsRepository, GROUPS_RECORDS, GROUPS_COLLECTIONS } from './groups.mjs';
import { createGrassrootsRepository, GRASSROOTS_RECORDS, GRASSROOTS_COLLECTIONS } from './grassroots.mjs';
import { createMatchFactsRepository } from './matchFacts.mjs';
import {
  createUploadSessionsRepository,
  UPLOAD_SESSIONS_RECORDS,
  UPLOAD_SESSIONS_COLLECTIONS,
} from './uploadSessions.mjs';
import { createSavedSearchesRepository, SAVED_SEARCHES_RECORDS, SAVED_SEARCHES_COLLECTIONS } from './savedSearches.mjs';
import { createInvoicesRepository, INVOICES_RECORDS, INVOICES_COLLECTIONS } from './invoices.mjs';
import {
  createReputationSeedRepository,
  REPUTATION_SEED_RECORDS,
  REPUTATION_SEED_COLLECTIONS,
} from './reputationSeed.mjs';
import {
  createDeliveryBookkeepingRepository,
  DELIVERY_BOOKKEEPING_RECORDS,
  DELIVERY_BOOKKEEPING_COLLECTIONS,
} from './deliveryBookkeeping.mjs';
import {
  createTransitionsVouchesRepository,
  TRANSITIONS_RECORDS,
  TRANSITIONS_COLLECTIONS,
} from './transitionsVouches.mjs';
import { createOneTimeCodesRepository, EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE } from './oneTimeCodes.ts';
import { createNotificationsRepository, NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE } from './notifications.ts';
import { createDispatchesRepository, DISPATCHES_TABLE } from './dispatches.ts';
import { createOutboxPushRepository, OUTBOX_PUSH_RECORD_TABLES } from './outboxPush.ts';
import { createChannelsRepository, CHANNELS_TABLE } from './channels.ts';
import { createSafetyAuditRepository, AUDIT_COLLECTIONS, SAFETY_AUDIT_RECORDS } from './safetyAudit.ts';

export const DATA_MIGRATIONS = Object.freeze([
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
  m0033,
  m0034,
  m0035,
  m0036,
  m0037,
  m0038,
  m0039,
  m0040,
]);

// The single-collection tables `readAllRecords` reads.
const TABLES = Object.freeze([ORGS_TABLE, USERS_TABLE, SESSIONS_TABLE]);

/** Every record collection: what `readAllRecords` returns. */
export const TABLE_BACKED = Object.freeze([
  'orgs',
  ...IDENTITY_COLLECTIONS,
  PLAYERS_RETAINED.name,
  'users',
  'sessions',
  MEDIA_DELETIONS_TABLE.name,
  EMAIL_CHALLENGES_TABLE.name,
  PAIRING_CODES_TABLE.name,
  NOTIFICATIONS_TABLE.name,
  NOTIFICATION_PREFS_TABLE.name,
  DISPATCHES_TABLE.name,
  ...OUTBOX_PUSH_RECORD_TABLES.map((t) => t.name),
  CHANNELS_TABLE.name,
  ...AUDIT_COLLECTIONS,
  ...RECRUITMENT_COLLECTIONS,
  ...RECRUITMENT_CASES_COLLECTIONS,
  ...RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS,
  ...SIGNINGS_FOLLOWUPS_COLLECTIONS,
  ...SCOUTING_EVIDENCE_COLLECTIONS,
  ...SCOUTING_ASSESSMENTS_COLLECTIONS,
  ...CLUB_SETUP_COLLECTIONS,
  ...OPPORTUNITIES_CAMPAIGNS_COLLECTIONS,
  ...VERIFICATION_COLLECTIONS,
  ...PASSPORT_COLLECTIONS,
  ...TRANSITIONS_COLLECTIONS,
  ...AGENT_CORE_COLLECTIONS,
  ...COMPLIANCE_POLICIES_COLLECTIONS,
  ...COMPLIANCE_RECORDS_COLLECTIONS,
  ...AGENT_TRANSACTIONS_COLLECTIONS,
  ...DEVELOPMENT_COLLECTIONS,
  ...BOX_CAM_COLLECTIONS,
  ...DISCOVERY_COLLECTIONS,
  ...INSIGHT_COVERAGE_COLLECTIONS,
  ...INTEGRATIONS_COLLECTIONS,
  ...ENTERPRISE_COLLECTIONS,
  ...GROUPS_COLLECTIONS,
  ...GRASSROOTS_COLLECTIONS,
  ...UPLOAD_SESSIONS_COLLECTIONS,
  ...SAVED_SEARCHES_COLLECTIONS,
  ...INVOICES_COLLECTIONS,
  ...REPUTATION_SEED_COLLECTIONS,
  ...DELIVERY_BOOKKEEPING_COLLECTIONS,
]);
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
  for (const table of [
    ...CODE_TABLES,
    ...NOTIFICATION_FEED_TABLES,
    ...NOTIFICATION_TABLE_DISPATCH,
    DISPATCHES_TABLE,
    CHANNELS_TABLE,
  ]) {
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
  for (const records of [
    UPLOAD_SESSIONS_RECORDS,
    SAVED_SEARCHES_RECORDS,
    INVOICES_RECORDS,
    REPUTATION_SEED_RECORDS,
    DELIVERY_BOOKKEEPING_RECORDS,
  ]) {
    const read = records.read(sqlite);
    if (read) Object.assign(out, read);
  }
  return out;
}
const schemaVersionOf = (sqlite) =>
  Number(sqlite.prepare('SELECT MAX(id) AS id FROM data_migrations').get()?.id?.slice(0, 4)) || 0;

/**
 * Attach every domain repository to the store's database: run the table migrations, then create the repositories.
 * `seed` is a first installation's records (`orgs`, `players`, `guardians`, `reputationSeed`; buildSeed() in
 * seed.mjs, or a fixture), imported once while the organisations and the identity pair are still `pending`, and
 * ignored on every later boot.
 */
export function attachDataLayer({
  seed = {},
  store,
  nextId,
  sessionTtlMs,
  now = Date.now,
  log = () => {},
  warn = (m) => console.warn(m),
}) {
  const sqlite = store?.sqlite ?? null;
  if (!sqlite)
    throw new TypeError(
      'the data layer needs a store with a SQLite connection (node:sqlite); there is no in-memory or JSON fallback',
    );
  const migrations = runDataMigrations(sqlite, DATA_MIGRATIONS, { now: now(), log, context: { sessionTtlMs } });

  // The organisations attach first: org_users, and most tables after them, reference orgs.
  const orgs = createOrgsRepository({ sqlite, nextId, log, now, unit: store.unit });
  const orgsBoot = orgs.initState() === 'pending' ? orgs.initialize(seed.orgs ?? []) : orgs.attach();

  // Players' trial reports come from the recruitment repository, attached below (a first installation's seed carries
  // none).
  let recruitment = null;
  /** A collection the caller handed in (the seed's or a fixture's plain array), or []. */
  const handedIn = (name) => (Object.hasOwn(seed, name) && Array.isArray(seed[name]) ? seed[name] : []);
  const identity = createIdentityRepositories({
    sqlite,
    log,
    unit: store.unit,
    now,
    trialReportsOf: (ids) => (recruitment ? recruitment.trialReportsForPlayers(ids) : new Map()),
  });
  const identityWasPending = identity.initState() === 'pending'; // a first installation: its seed (and the demo reputation rows) is imported once
  const identityBoot = identityWasPending
    ? identity.initialize({ players: seed.players ?? [], guardians: seed.guardians ?? [] }, { now: now() })
    : identity.attach();

  const users = createUsersRepository({ sqlite, nextId, log, now, unit: store.unit });
  const usersBoot = users.attach();

  const sessions = createSessionsRepository({ sqlite, sessionTtlMs, log, unit: store.unit });
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
  const agentCore = createAgentCoreRepository({
    sqlite,
    log,
    now,
    unit: store.unit,
    policyVersionKnown: (id) => compliancePolicies.policies.exists(id),
  });
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
  const uploadSessions = createUploadSessionsRepository({ sqlite, log, now, unit: store.unit });
  const uploadSessionsBoot = uploadSessions.attach();
  const savedSearches = createSavedSearchesRepository({ sqlite, log, now, unit: store.unit });
  const savedSearchesBoot = savedSearches.attach();
  const invoices = createInvoicesRepository({ sqlite, log, now, unit: store.unit });
  const invoicesBoot = invoices.attach();
  const reputationSeed = createReputationSeedRepository({ sqlite, log, now, unit: store.unit });
  const reputationSeedBoot = reputationSeed.attach({ seed: identityWasPending ? handedIn('reputationSeed') : [] });
  const deliveryBookkeeping = createDeliveryBookkeepingRepository({ sqlite, log, now, unit: store.unit });
  const deliveryBookkeepingBoot = deliveryBookkeeping.attach();

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
    uploadSessions,
    savedSearches,
    invoices,
    reputationSeed,
    deliveryBookkeeping,
    migrations,
    /** True when this boot imported the seed: a first installation. */
    firstInstallation: identityWasPending,
    /** The schema version: the number of the latest applied table migration (`0040_…` → 40). */
    schemaVersion: () => schemaVersionOf(sqlite),
    /** Operator-facing view of the schema: the version, the migrations applied and known, whether it is current. */
    schemaReport: () => {
      const version = schemaVersionOf(sqlite);
      const expected = Number(
        DATA_MIGRATIONS.map((m) => m.id)
          .sort()
          .at(-1)
          .slice(0, 4),
      );
      const applied = sqlite.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n;
      return {
        version,
        expected,
        migrationsApplied: applied,
        migrationsKnown: DATA_MIGRATIONS.length,
        upToDate: version === expected && applied === DATA_MIGRATIONS.length,
      };
    },
    boot: {
      orgs: orgsBoot,
      identity: identityBoot,
      users: usersBoot,
      sessions: sessionsBoot,
      codes: codesBoot,
      notifications: notificationsBoot,
      dispatches: dispatchesBoot,
      outboxPush: outboxPushBoot,
      channels: channelsBoot,
      safetyAudit: safetyAuditBoot,
      recruitment: recruitmentBoot,
      recruitmentCases: recruitmentCasesBoot,
      recruitmentContactsOffers: recruitmentContactsOffersBoot,
      signingsFollowUps: signingsFollowUpsBoot,
      scoutingEvidence: scoutingEvidenceBoot,
      scoutingAssessments: scoutingAssessmentsBoot,
      clubSetup: clubSetupBoot,
      opportunitiesCampaigns: opportunitiesCampaignsBoot,
      verification: verificationBoot,
      passport: passportBoot,
      transitionsVouches: transitionsVouchesBoot,
      agentCore: agentCoreBoot,
      compliancePolicies: compliancePoliciesBoot,
      complianceRecords: complianceRecordsBoot,
      agentTransactions: agentTransactionsBoot,
      development: developmentBoot,
      boxCam: boxCamBoot,
      discovery: discoveryBoot,
      insightCoverage: insightCoverageBoot,
      integrations: integrationsBoot,
      enterprise: enterpriseBoot,
      groups: groupsBoot,
      grassroots: grassrootsBoot,
      uploadSessions: uploadSessionsBoot,
      savedSearches: savedSearchesBoot,
      invoices: invoicesBoot,
      reputationSeed: reputationSeedBoot,
      deliveryBookkeeping: deliveryBookkeepingBoot,
    },
    /** `details: true` is accepted for the admin report; the report carries counts and states, never rows. */
    report: () => ({
      ...dataSchemaReport(sqlite, DATA_MIGRATIONS),
      identity: { initState: identity.initState() },
      mediaDeletions: { queued: mediaDeletions.count(), conflicts: mediaDeletions.conflicts().length },
    }),
  };
}
