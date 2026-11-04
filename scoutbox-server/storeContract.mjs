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
  apiKeys: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  // applications: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.applications throws.
  archetypes: { guarantee: 'migration', owner: 'core', reason: 'product configuration, restored from catalogue.mjs; empty is a lie with consequences (D2)' },
  // blocks, reports, moderationLog, orgNotes, ledger, opsEvents, sourceChanges, idvQueue: no longer blob collections since S6b —
  // the rows live in blocks / reports / moderation_log / org_notes / ledger / ops_events / source_changes / idv_queue (migration
  // 0013_safety_audit, repositories/safetyAudit.mjs). The entries stay because seed.mjs, the snapshot migrations m230_001 / m230_003
  // and m13/shared.mjs still create the containers before the data layer attaches (they must keep upgrading a pre-S6b file); at attach
  // the data layer drops the array and defines the name as the repository's read-only view, so the guarantee the registry gives is
  // "the name exists", and the record is the table. Writes go through `safetyAudit` only (ledgerAppend, moderateOrRefuse, handleReport,
  // the block / lift / note / IDV / resolve routes, the m13 ops events, m181's source changes).
  blocks: { guarantee: 'migration', owner: 'core', reason: 'read by isBlocked() inside every visibility check — a missing container crashed the safeguarding path (D2); since S6b a read-only view over the blocks table, written only through the safetyAudit repository (Q5: a lift deletes the row)' },
  boxAssignments: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxCamCvResults: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  boxCamDisputes: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxCamPrefs: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxChallengeEntries: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxChallenges: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxSessionEvents: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  boxSessions: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  calibrationSessions: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  // campaignSubmissions: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.campaignSubmissions throws.
  // campaigns: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.campaigns throws.
  // channels: no longer a blob collection since S7d — the threads live in channels / messages / message_attachments
  // (migration 0012, repositories/channels.mjs); the data layer defines a read-only view at db.channels (insertion
  // order, messages nested in array order), written only through the channels repository (the acceptance routes'
  // openChannel, postMessage, the three receipt routes, the account deletion).
  channels: { guarantee: 'migration', owner: 'core', reason: 'moderated message threads, opened on acceptance (D2); container guaranteed by the migration registry before the data layer attaches; since S7d a read-only view over the channels table, written only through the channels repository' },
  combineAttempts: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  combineRequests: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  coverageAssignments: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  coveragePlans: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  deliveryCallbacksSeen: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  deliveryCentreSince: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  deliveryFailInject: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  devObjectives: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  developmentActions: { guarantee: 'migration', owner: 'm21', reason: 'Development Plan collection, guaranteed by the migration registry' },
  developmentEvidenceLinks: { guarantee: 'migration', owner: 'm21', reason: 'Development Plan collection, guaranteed by the migration registry' },
  developmentGoals: { guarantee: 'migration', owner: 'm21', reason: 'Development Plan collection, guaranteed by the migration registry' },
  developmentPlans: { guarantee: 'migration', owner: 'm21', reason: 'Development Plan collection, guaranteed by the migration registry' },
  developmentReviews: { guarantee: 'migration', owner: 'm21', reason: 'Development Plan collection, guaranteed by the migration registry' },
  // dispatches: no longer a blob collection since S7b — the rows live in dispatches / dispatch_attempts (migration 0010,
  // repositories/dispatches.mjs); the data layer defines a read-only view at db.dispatches (insertion order, attempts
  // nested) and m13/delivery.mjs writes through the repository. S7b filed it as 'migration' after the notifications
  // precedent, but no snapshot migration creates it (notifications is in m182_002's list); the boot proves 'module'.
  dispatches: { guarantee: 'module', owner: 'm13', reason: 'container created by migrateM13 (??= []); since S7b a read-only view over the dispatches table, written only through the dispatches repository' },
  drillGuidance: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  dynamicWatchlists: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  // emailChallenges: no longer a production db.* read since S6a — the rows live in email_challenges (migration 0008,
  // repositories/oneTimeCodes.mjs) and the routes go through the repository; the data layer still defines a hash-free
  // read-only view at db.emailChallenges, like the other table-backed collections. (mediaDeletions is the precedent.)
  // assessmentTemplates, assessments, videoSegments, playlists: never a db.* read since S9b — typed tables (migration
  // 0020), read through repositories/scoutingAssessments.mjs (scoutingReads). db.<name> throws.
  // evidence, coachAffiliations, squadInvites: never a db.* read since S9a — typed tables (migration 0019), read through
  // repositories/scoutingEvidence.mjs (scoutingReads). db.<name> throws.
  evidenceSuggestions: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  exposureEvents: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  fixtures: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  friendlies: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  groupGrants: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  groups: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  guardians: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  identityReviews: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  idvQueue: { guarantee: 'migration', owner: 'core', reason: 'guardian identity-verification queue; was created by ??= inside a request handler, so it existed only after the first write; since S6b a read-only view over the idv_queue table, written only through the safetyAudit repository (Q4b: every entry names an existing guardian, checked in code)' },
  importBatches: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  invoices: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  ledger: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore; since S6b a read-only view over the ledger table (insertion order), written only through ledgerAppend → the safetyAudit repository (userId / scoutName verbatim)' },
  matchdays: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  mediaBlobs: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  moderationLog: { guarantee: 'migration', owner: 'core', reason: 'moderation hits, counted on the T&S dashboard (D2); since S6b a read-only view over the moderation_log table, written only through moderateOrRefuse → the safetyAudit repository' },
  nobodyMissedReviews: { guarantee: 'migration', owner: 'm18', reason: 'Second Look / Nobody Missed collection, guaranteed by the migration registry' },
  // notificationPrefs / notifications: since S7a the rows live in notification_prefs / notification_pref_categories and
  // notifications (migration 0009, repositories/notifications.mjs) and every production reader and writer goes through the
  // repository. The entries stay because the snapshot migrations m182_002 / m182_004 / m182_005 still name the containers
  // (they run before the data layer attaches and must keep upgrading a pre-S7a file); at attach the data layer replaces the
  // container with its read-only view, so the guarantee the registry gives is "the name exists", and the record is the table.
  notificationPrefs: { guarantee: 'migration', owner: 'core', reason: 'container guaranteed by the migration registry (m182_004); since S7a a read-only view over notification_prefs, written only through the notifications repository' },
  notifications: { guarantee: 'migration', owner: 'core', reason: 'container guaranteed by the migration registry (m182_002); since S7a a read-only view over the notifications table, written only through the notifications repository' },
  openTrials: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  // opportunities: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.opportunities throws.
  opsEvents: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration; since S6b a read-only view over the ops_events table, written only through the safetyAudit repository (every kind an ordinary row)' },
  orgInvites: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
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
  passportAchievements: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportCareerEntries: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportCorrections: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportPrefs: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportShares: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  plans: { guarantee: 'migration', owner: 'core', reason: 'product configuration, restored from catalogue.mjs; empty would silently move a Grassroots attribution window from 12 to 18 months (D2)' },
  // playerPrefs: never a db.* read since S9d — a typed table (migration 0022), read through repositories/opportunitiesCampaigns.mjs
  // (scoutingReads). db.playerPrefs throws.
  players: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  // playersRetained: never a production db.* read — the retained records live in players_retained (migration 0014,
  // repositories/identity.mjs) and the backup reads them through players.retainedRecords(); the data layer defines a
  // read-only view at db.playersRetained, like the other table-backed collections.
  prospects: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  pushLog: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, created during synchronous composition before the socket opens; since S7c a read-only view over the push_log table (defined by attachDataLayer), written only through the push log repository' },
  pushTokens: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, created during synchronous composition before the socket opens; since S7c a read-only view over the push_tokens table (defined by attachDataLayer), written only through the push tokens repository' },
  recruitmentBriefs: { guarantee: 'migration', owner: 'm18', reason: 'Second Look / Nobody Missed collection, guaranteed by the migration registry' },
  // recruitmentContacts, recruitmentOffers: never a db.* read since §4.3 step 2 — the contacts and offers live in their
  // typed tables (migration 0017) and are read through repositories/recruitmentContactsOffers.mjs. db.<name> throws.
  // signingPackages, signings, followUps, outcomeReports: the same since §4.3 step 2 — typed tables (migration 0018),
  // read through repositories/signingsFollowUps.mjs. requests, trials: the same — typed tables (migration 0015), read
  // through repositories/recruitment.mjs. recruitmentCases, roomComments, roomSnapshots, roomDecisions,
  // roomEvidenceState: the same — typed tables (migration 0016), read through repositories/recruitmentCases.mjs.
  reports: { guarantee: 'migration', owner: 'core', reason: 'report-user/scout/club submissions (D2); since S6b a read-only view over the reports table, written only through handleReport / moderateOrRefuse and the resolve route → the safetyAudit repository (a report naming an unknown player is accepted, Q4)' },
  representations: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  // M23 P5.6B — ScoutBox Agent core. Guaranteed by migration 2305 so a
  // restored older snapshot has them before any Agent route can run.
  agentProfiles: { guarantee: 'migration', owner: 'm24', reason: 'P5.6B: the licensed natural person\'s agent profile and verification facets; personal, survives agency departure' },
  agencyAffiliations: { guarantee: 'migration', owner: 'm24', reason: 'P5.6B: time-aware Agent ↔ Agency membership with roles; the permission matrix reads it on every request' },
  representationAgreements: { guarantee: 'migration', owner: 'm24', reason: 'P5.6B: the client-confirmed relationship record — the only basis for an agent\'s private client access' },
  // M23 P5.6C — Conflict & Compliance Engine. Guaranteed by migration 2306.
  tsReviewers: { guarantee: 'migration', owner: 'm25', reason: 'P5.6C: per-reviewer Trust & Safety identity (G-C0); empty in production until an operator bootstraps one — the shared key creates none' },
  jurisdictionPolicies: { guarantee: 'migration', owner: 'm25', reason: 'P5.6C: versioned jurisdiction policy rows with per-rule operative status; seeded from code, published thereafter under dual control' },
  regulatoryReviews: { guarantee: 'migration', owner: 'm25', reason: 'P5.6C: attributed manual regulatory review items; every decision names its reviewer' },
  regulatoryConsents: { guarantee: 'migration', owner: 'm25', reason: 'P5.6C: the append-only, party-specific consent ledger; a revocation is a new row' },
  complianceContexts: { guarantee: 'migration', owner: 'm25', reason: 'P5.6C: the minimal conflict-evaluation context with its evaluation snapshots; not a Transaction Room' },
  // M23 P5.6D — Agent Transaction Workspace. Guaranteed by migration 2307.
  agentTransactions: { guarantee: 'migration', owner: 'm26', reason: 'P5.6D: the frozen P5.6A §4 multi-party transaction workspace — parties, status ladder, compliance snapshot, scoped notes and append-only history; never a recruitment case, never an offer, never a signing' },
  transactionRepresentations: { guarantee: 'migration', owner: 'm26', reason: 'P5.6D: the frozen P5.6A §5 (agent, party role, transaction) binding with its own lifecycle, rev and review link — the conflict engine\'s unit of evaluation, kept out of the transaction row on purpose' },
  transactionDocuments: { guarantee: 'migration', owner: 'm26', reason: 'P5.6D: document classification and visibility — type, owner, visibility class, version chain, expiry and a reference into the canonical evidence vault; stores no bytes, so it is not a second upload path' },
  reputationSeed: { guarantee: 'migration', owner: 'core', reason: 'demo track records; EMPTY is the correct production value — fabricating them would be worse than the bug (D2)' },
  reviewLater: { guarantee: 'module', owner: 'm13', reason: 'existed only because insightSweep() happens to run once synchronously at registration; a store whose existence depends on a sweep moves the day the sweep is made lazy' },
  savedSearches: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  secondLookItems: { guarantee: 'migration', owner: 'm18', reason: 'Second Look / Nobody Missed collection, guaranteed by the migration registry' },
  sessions: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  sourceChanges: { guarantee: 'migration', owner: 'm18.1', reason: 'M18.1 source-change clock, guaranteed by the migration registry; since S6b a read-only view over the source_changes table, written only through recordSourceChange → the safetyAudit repository (the 20 000 cap deletes the oldest rows)' },
  ssoConfigs: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  ssoStates: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  supportAccessGrants: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  supportTickets: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  transitionCases: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  uploadSessions: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  users: { guarantee: 'migration', owner: 'core', reason: 'staff accounts. Guaranteed by the migration registry in memory; since the data layer the rows live in the org_users table (repositories/users.mjs) and db.users is the repository\'s read-only view after attachDataLayer' },
  // vacancies: never a db.* read since S9c — a typed table (migration 0021), read through repositories/clubSetup.mjs
  // (scoutingReads). db.vacancies throws. The organisation facets tactical, squad, lookingFor and federationCheck moved
  // to the same repository's tables.
  // verAdmins, verClaims, verConflicts, verDisputes, verDomainRequests, verEvents, verEvidence, verPlayerInvites,
  // verReferences, verRootRequests, verRootTransfers, verTokens (and the boot marker verMigrated): never a db.* read since
  // S10a — typed tables (migration 0023), read through repositories/verification.mjs (verificationReads). db.<name>
  // throws. The organisation facet `verification` moved to the same repository (verified domains) and to the orgs column
  // verification_revoked_at (verificationRevokedAt).
  vouches: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  watchlistHistory: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  webhookDeliveries: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  webhookEndpoints: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },});

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
