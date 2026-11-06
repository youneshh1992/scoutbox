// The production store contract — ONE source of truth for who guarantees what.
//
// THE RULE
//
//   A production-read store may be guaranteed either by schema/bootstrap or by
//   an owning production module — but the guarantee must be EXECUTABLE,
//   DETERMINISTIC and PROVEN BEFORE REQUESTS CAN REACH THAT CODE.
//
// WHY THIS FILE EXISTS
//
// The M23 boot-contract pass proved every store's guarantee by booting the
// real server and reading back what was there. That proof was reconstructed
// from source on every run and the ownership existed only in a document. This
// freezes it: one structure, machine-readable, that the contract test checks
// against reality rather than trusts.
//
// It replaces three lists that could disagree. `PRODUCTION_REQUIRED_STORES` in
// domains/platform/migrations.mjs is now DERIVED from this file, not hand-kept beside it.
//
// THE FIELDS
//
//   guarantee  'migration' — created by a numbered step in domains/platform/migrations.mjs.
//                            Survives loadSnapshot() replacing the db object
//                            wholesale, so it is the only class that survives
//                            an arbitrary restore.
//              'module'    — created by its owning module during synchronous
//                            registration. Safe because server.mjs is one
//                            synchronous module body and app.listen is its last
//                            statement: no request can arrive before every
//                            register*() has returned.
//              'optional'  — a production reader deliberately handles absence
//                            AND absence has product meaning. The bar is not
//                            "the code used ?.". See §13.
//
//   owner      the milestone that owns the concept: 'core' for server.mjs and
//              the migration registry, otherwise 'm12' … 'm21'.
//
//   reason     why this store exists and why it is in this class. Stores with a
//              history say so; the rest carry their group's honest one-liner.
//
// WHAT THIS FILE IS NOT
//
// It is metadata, and metadata is a claim. `e2e/platform/storeGuarantees.mjs` (part 2) boots
// a real server on a bare migrated database and checks every claim here
// against what the composed process actually holds — a store marked
// 'migration' must exist after migrations ALONE, a store marked 'module' must
// exist after the full boot and NOT after migrations alone, and a store marked
// 'optional' must genuinely be absent. Metadata that disagrees with the
// running server fails the build.

export const PRODUCTION_STORE_CONTRACT = Object.freeze({
  // orgInvites, ssoConfigs, ssoStates, supportTickets, supportAccessGrants: never a db.* read since S13b — typed tables
  // (migration 0035), read through repositories/enterprise.mjs (enterpriseReads). Each db.* name throws; migrateM13 no
  // longer creates them.
  // importBatches, prospects, identityReviews, apiKeys, webhookEndpoints, webhookDeliveries: never a db.* read since S13a —
  // typed tables (migration 0034), read through repositories/integrations.mjs (integrationReads). Each db.* name throws;
  // migrateM13 no longer creates them.
  // applications: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.applications throws.
  // blocks, reports, moderationLog, orgNotes, ledger, opsEvents, sourceChanges, idvQueue: no longer blob collections since S6b —
  // the rows live in blocks / reports / moderation_log / org_notes / ledger / ops_events / source_changes / idv_queue (migration
  // 0013_safety_audit, repositories/safetyAudit.mjs). The entries stay because seed.mjs, the snapshot migrations m230_001 / m230_003
  // and m13/shared.mjs still create the containers before the data layer attaches (they must keep upgrading a pre-S6b file); at attach
  // the data layer drops the array and defines the name as the repository's read-only view, so the guarantee the registry gives is
  // "the name exists", and the record is the table. Writes go through `safetyAudit` only (ledgerAppend, moderateOrRefuse, handleReport,
  // the block / lift / note / IDV / resolve routes, the m13 ops events, m181's source changes).
  blocks: { guarantee: 'migration', owner: 'core', reason: 'read by isBlocked() inside every visibility check — a missing container crashed the safeguarding path (D2); since S6b a read-only view over the blocks table, written only through the safetyAudit repository (Q5: a lift deletes the row)' },
  // boxCamPrefs, boxChallenges, boxChallengeEntries, boxAssignments, boxSessions, boxCamDisputes, combineRequests,
  // combineAttempts, boxCamCvResults: never a db.* read since S12b — typed tables (migration 0031), read through
  // repositories/boxCam.mjs (boxCamReads). Each db.* name throws, boxSessionEvents (reserved, never written) with them;
  // the blob steps that created them are recorded no-ops.
  // campaignSubmissions: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.campaignSubmissions throws.
  // campaigns: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.campaigns throws.
  // channels: no longer a blob collection since S7d — the threads live in channels / messages / message_attachments
  // (migration 0012, repositories/channels.mjs); the data layer defines a read-only view at db.channels (insertion
  // order, messages nested in array order), written only through the channels repository (the acceptance routes'
  // openChannel, postMessage, the three receipt routes, the account deletion).
  channels: { guarantee: 'migration', owner: 'core', reason: 'moderated message threads, opened on acceptance (D2); container guaranteed by the migration registry before the data layer attaches; since S7d a read-only view over the channels table, written only through the channels repository' },
  // devObjectives, drillGuidance (the reviews only; the guidance is code), developmentPlans, developmentGoals,
  // developmentActions, developmentEvidenceLinks, developmentReviews: never a db.* read since S12a — typed tables (migration
  // 0030), read through repositories/development.mjs (developmentReads). Each db.* name throws; blob step m210_001 is a
  // recorded no-op.
  // exposureEvents, reviewLater, evidenceSuggestions, calibrationSessions, fixtures, coveragePlans, coverageAssignments: never a
  // db.* read since S12d — typed tables (migration 0033), read through repositories/insightCoverage.mjs (insightReads). Each
  // db.* name throws; migrateM13 no longer creates them.
  // dynamicWatchlists, watchlistHistory (and recruitmentBriefs, nobodyMissedReviews, secondLookItems): never a db.* read
  // since S12c — typed tables (migration 0032), read through repositories/discovery.mjs (discoveryReads). Each db.* name
  // throws; the blob steps that created them (m182_002's entries, m182_003, m190_001, m200_001) are recorded no-ops.
  // dispatches: no longer a blob collection since S7b — the rows live in dispatches / dispatch_attempts (migration 0010,
  // repositories/dispatches.mjs); the data layer defines a read-only view at db.dispatches (insertion order, attempts
  // nested) and m13/delivery.mjs writes through the repository. S7b filed it as 'migration' after the notifications
  // precedent, but no snapshot migration creates it (notifications is in m182_002's list); the boot proves 'module'.
  dispatches: { guarantee: 'module', owner: 'm13', reason: 'container created by migrateM13 (??= []); since S7b a read-only view over the dispatches table, written only through the dispatches repository' },
  // emailChallenges: no longer a production db.* read since S6a — the rows live in email_challenges (migration 0008,
  // repositories/oneTimeCodes.mjs) and the routes go through the repository; the data layer still defines a hash-free
  // read-only view at db.emailChallenges, like the other table-backed collections. (mediaDeletions is the precedent.)
  // assessmentTemplates, assessments, videoSegments, playlists: never a db.* read since S9b — typed tables (migration
  // 0020), read through repositories/scoutingAssessments.mjs (scoutingReads). db.<name> throws.
  // evidence, coachAffiliations, squadInvites: never a db.* read since S9a — typed tables (migration 0019), read through
  // repositories/scoutingEvidence.mjs (scoutingReads). db.<name> throws.
  // friendlies: never a db.* read since S13d — a typed table (migration 0037), read through repositories/grassroots.mjs (grassrootsReads).
  // groups, groupGrants: never a db.* read since S13c — typed tables (migration 0036), read through
  // repositories/groups.mjs (groupReads). Each db.* name throws; migrateM13 no longer creates them.
  guardians: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  idvQueue: { guarantee: 'migration', owner: 'core', reason: 'guardian identity-verification queue; was created by ??= inside a request handler, so it existed only after the first write; since S6b a read-only view over the idv_queue table, written only through the safetyAudit repository (Q4b: every entry names an existing guardian, checked in code)' },
  ledger: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore; since S6b a read-only view over the ledger table (insertion order), written only through ledgerAppend → the safetyAudit repository (userId / scoutName verbatim)' },
  // matchdays: never a db.* read since S13d — a typed table (migration 0037), read through repositories/grassroots.mjs (grassrootsReads).
  mediaBlobs: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  moderationLog: { guarantee: 'migration', owner: 'core', reason: 'moderation hits, counted on the T&S dashboard (D2); since S6b a read-only view over the moderation_log table, written only through moderateOrRefuse → the safetyAudit repository' },
  // notificationPrefs / notifications: since S7a the rows live in notification_prefs / notification_pref_categories and
  // notifications (migration 0009, repositories/notifications.mjs) and every production reader and writer goes through the
  // repository. The entries stay because the snapshot migrations m182_002 / m182_004 / m182_005 still name the containers
  // (they run before the data layer attaches and must keep upgrading a pre-S7a file); at attach the data layer replaces the
  // container with its read-only view, so the guarantee the registry gives is "the name exists", and the record is the table.
  notificationPrefs: { guarantee: 'migration', owner: 'core', reason: 'container guaranteed by the migration registry (m182_004); since S7a a read-only view over notification_prefs, written only through the notifications repository' },
  notifications: { guarantee: 'migration', owner: 'core', reason: 'container guaranteed by the migration registry (m182_002); since S7a a read-only view over the notifications table, written only through the notifications repository' },
  // openTrials: never a db.* read since S13d — a typed table (migration 0037), read through repositories/grassroots.mjs (grassrootsReads).
  // opportunities: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.opportunities throws.
  opsEvents: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration; since S6b a read-only view over the ops_events table, written only through the safetyAudit repository (every kind an ordinary row)' },
  orgNotes: { guarantee: 'migration', owner: 'core', reason: 'a club private notes on a player; same first-write defect as idvQueue; since S6b a read-only view over the org_notes table, written only through the safetyAudit repository' },
  orgs: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  // outbox, pushLog, pushTokens: no longer blob collections since S7c — the rows live in outbox / push_log / push_tokens
  // (migration 0011, repositories/outboxPush.mjs); the data layer defines read-only views at db.outbox, db.pushLog and
  // db.pushTokens (insertion order), written only through the repository (the mailer, the delivery centre's fake
  // provider, the push sender and POST /push/register).
  outbox: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, created during synchronous composition before the socket opens; since S7c a read-only view over the outbox table (defined by attachDataLayer), written only through the outbox repository' },
  // pairingCodes: no longer a production db.* read since S6a — the rows live in pairing_codes (migration 0008,
  // repositories/oneTimeCodes.mjs) and the routes go through the repository; the data layer still defines a hash-free
  // read-only view at db.pairingCodes, like the other table-backed collections. (mediaDeletions is the precedent.)
  // plans, archetypes: never a db.* read since S13e — constants (catalogue.mjs PLANS, ARCHETYPES), not stored.
  // playerPrefs: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.playerPrefs throws.
  players: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  // playersRetained: never a production db.* read — the retained records live in players_retained (migration 0014,
  // repositories/identity.mjs) and the backup reads them through players.retainedRecords(); the data layer defines a
  // read-only view at db.playersRetained, like the other table-backed collections.
  pushLog: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, created during synchronous composition before the socket opens; since S7c a read-only view over the push_log table (defined by attachDataLayer), written only through the push log repository' },
  pushTokens: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, created during synchronous composition before the socket opens; since S7c a read-only view over the push_tokens table (defined by attachDataLayer), written only through the push tokens repository' },
  // recruitmentContacts, recruitmentOffers: never a db.* read since §4.3 step 2 — the contacts and offers live in their
  // typed tables (migration 0017) and are read through repositories/recruitmentContactsOffers.mjs. db.<name> throws.
  // signingPackages, signings, followUps, outcomeReports: the same since §4.3 step 2 — typed tables (migration 0018),
  // read through repositories/signingsFollowUps.mjs. requests, trials: the same — typed tables (migration 0015), read
  // through repositories/recruitment.mjs. recruitmentCases, roomComments, roomSnapshots, roomDecisions,
  // roomEvidenceState: the same — typed tables (migration 0016), read through repositories/recruitmentCases.mjs.
  reports: { guarantee: 'migration', owner: 'core', reason: 'report-user/scout/club submissions (D2); since S6b a read-only view over the reports table, written only through handleReport / moderateOrRefuse and the resolve route → the safetyAudit repository (a report naming an unknown player is accepted, Q4)' },
  // representations (the M13 F10 legacy lane): removed in S11a, with its routes and screens.
  // agentProfiles, agencyAffiliations, representationAgreements: never a db.* read since S11a — typed tables (migration
  // 0026), read through repositories/agentCore.mjs (agentReads). Each db.* name throws.
  // M23 P5.6C — Conflict & Compliance Engine. Guaranteed by migration 2306.
  // tsReviewers, jurisdictionPolicies: never a db.* read since S11b-1 — typed tables (migration 0027, which also inserts
  // the seeded policy versions), read through repositories/compliancePolicies.mjs. Each db.* name throws.
  // complianceContexts, regulatoryReviews, regulatoryConsents: the same since S11b-2 — typed tables (migration 0028), read
  // through repositories/complianceRecords.mjs.
  // M23 P5.6D — Agent Transaction Workspace. agentTransactions, transactionRepresentations, transactionDocuments: never a
  // db.* read since S11c — typed tables (migration 0029), read through repositories/agentTransactions.mjs. Each db.*
  // name throws; blob step 2307 is a recorded no-op.
  sessions: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  sourceChanges: { guarantee: 'migration', owner: 'm18.1', reason: 'M18.1 source-change clock, guaranteed by the migration registry; since S6b a read-only view over the source_changes table, written only through recordSourceChange → the safetyAudit repository (the 20 000 cap deletes the oldest rows)' },
  // transitionCases: never a db.* read since S10c — typed tables (migration 0025), read through repositories/transitionsVouches.mjs (verificationReads). db.transitionCases throws.
  // uploadSessions, savedSearches, invoices, reputationSeed, deliveryCallbacksSeen, deliveryCentreSince, deliveryFailInject:
  // never a db.* read since S13e — typed tables (migration 0038), read through repositories/operations.mjs. Each db.* name throws.
  users: { guarantee: 'migration', owner: 'core', reason: 'staff accounts. Guaranteed by the migration registry in memory; since the data layer the rows live in the org_users table (repositories/users.mjs) and db.users is the repository\'s read-only view after attachDataLayer' },
  // vacancies: never a db.* read since S9c — a typed table (migration 0021), read through repositories/clubSetup.mjs
  // (scoutingReads). db.vacancies throws. The organisation facets tactical, squad, lookingFor and federationCheck moved
  // to the same repository's tables.
  // verAdmins, verClaims, verConflicts, verDisputes, verDomainRequests, verEvents, verEvidence, verPlayerInvites,
  // verReferences, verRootRequests, verRootTransfers, verTokens (and the boot marker verMigrated): never a db.* read since
  // S10a — typed tables (migration 0023), read through repositories/verification.mjs (verificationReads). db.<name>
  // throws. The organisation facet `verification` moved to the same repository (verified domains) and to the orgs column
  // verification_revoked_at (verificationRevokedAt).
  // passportPrefs, passportCareerEntries, passportAchievements, passportShares, passportCorrections: never a db.* read since
  // S10b — typed tables (migration 0024), read through repositories/passport.mjs (verificationReads). db.<name> throws.
  // vouches: never a db.* read since S10c — a typed table (migration 0025), read through repositories/transitionsVouches.mjs (verificationReads). db.vouches throws.
});

/** Every store name the contract knows about. */
export const CONTRACT_STORES = Object.freeze(Object.keys(PRODUCTION_STORE_CONTRACT));

/**
 * Stores guaranteed by the migration registry.
 *
 * DERIVED, not hand-kept. `domains/platform/migrations.mjs` re-exports this as
 * `PRODUCTION_REQUIRED_STORES` so there is one list, not two that can drift.
 */
export const MIGRATION_GUARANTEED = Object.freeze(
  CONTRACT_STORES.filter((s) => PRODUCTION_STORE_CONTRACT[s].guarantee === 'migration'),
);

/** Stores guaranteed by their owning module's synchronous registration. */
export const MODULE_GUARANTEED = Object.freeze(
  CONTRACT_STORES.filter((s) => PRODUCTION_STORE_CONTRACT[s].guarantee === 'module'),
);

/** Stores whose absence is a supported, meaningful product state. */
export const OPTIONAL_STORES = Object.freeze(
  CONTRACT_STORES.filter((s) => PRODUCTION_STORE_CONTRACT[s].guarantee === 'optional'),
);

/**
 * Names that LOOK like stores to a scanner and are not.
 *
 * `db.schema` is the migration registry's own record, not a collection of user
 * data — it is created by step one and read by the boot log and /capabilities.
 * `db.json` is the filename `data/db.json` appearing in string literals.
 */
export const NOT_A_STORE = Object.freeze({
  schema: 'the migration registry\'s own record, not a collection',
  json: 'the filename `data/db.json`, which appears in string literals',
});

/** The class a store belongs to, or null when the contract does not know it. */
export const guaranteeFor = (store) => PRODUCTION_STORE_CONTRACT[store]?.guarantee ?? null;
