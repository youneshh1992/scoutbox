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
// m182/migrations.mjs is now DERIVED from this file, not hand-kept beside it.
//
// THE FIELDS
//
//   guarantee  'migration' — created by a numbered step in m182/migrations.mjs.
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
// It is metadata, and metadata is a claim. `scripts/m23BootContract.mjs` boots
// a real server on a bare migrated database and checks every claim here
// against what the composed process actually holds — a store marked
// 'migration' must exist after migrations ALONE, a store marked 'module' must
// exist after the full boot and NOT after migrations alone, and a store marked
// 'optional' must genuinely be absent. Metadata that disagrees with the
// running server fails the build.

export const PRODUCTION_STORE_CONTRACT = Object.freeze({
  apiKeys: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  applications: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  archetypes: { guarantee: 'migration', owner: 'core', reason: 'product configuration, restored from catalogue.mjs; empty is a lie with consequences (D2)' },
  assessmentTemplates: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  assessments: { guarantee: 'migration', owner: 'm12', reason: 'declared required by the M23 journey projection and guaranteed by nothing but a module ??= until the sweep found it' },
  blocks: { guarantee: 'migration', owner: 'core', reason: 'read by isBlocked() inside every visibility check — a missing container crashed the safeguarding path (D2)' },
  boxAssignments: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxCamCvResults: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  boxCamDisputes: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxCamPrefs: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxChallengeEntries: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxChallenges: { guarantee: 'module', owner: 'm16', reason: 'Box Cam feature collection, created at registration' },
  boxSessionEvents: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  boxSessions: { guarantee: 'migration', owner: 'm16', reason: 'Box Cam / Combine collection, guaranteed by the migration registry' },
  calibrationSessions: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  campaignSubmissions: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  campaigns: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  channels: { guarantee: 'migration', owner: 'core', reason: 'moderated message threads, opened on acceptance (D2)' },
  coachAffiliations: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
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
  dispatches: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  drillGuidance: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  dynamicWatchlists: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  emailChallenges: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  evidence: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  evidenceSuggestions: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  exposureEvents: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  fixtures: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  followUps: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  friendlies: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  groupGrants: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  groups: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  guardians: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  identityReviews: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  idvQueue: { guarantee: 'migration', owner: 'core', reason: 'guardian identity-verification queue; was created by ??= inside a request handler, so it existed only after the first write' },
  importBatches: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  invoices: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  ledger: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  matchdays: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  mediaBlobs: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  moderationLog: { guarantee: 'migration', owner: 'core', reason: 'moderation hits, counted on the T&S dashboard (D2)' },
  nobodyMissedReviews: { guarantee: 'migration', owner: 'm18', reason: 'Second Look / Nobody Missed collection, guaranteed by the migration registry' },
  notificationPrefs: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  notifications: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  openTrials: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  opportunities: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  opsEvents: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  orgInvites: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  orgNotes: { guarantee: 'migration', owner: 'core', reason: 'a club private notes on a player; same first-write defect as idvQueue' },
  orgs: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  outbox: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  outcomeReports: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  pairingCodes: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  passportAchievements: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportCareerEntries: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportCorrections: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportPrefs: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  passportShares: { guarantee: 'module', owner: 'm15', reason: 'M15 Passport collection, created at registration' },
  plans: { guarantee: 'migration', owner: 'core', reason: 'product configuration, restored from catalogue.mjs; empty would silently move a Grassroots attribution window from 12 to 18 months (D2)' },
  playerPrefs: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  players: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  playlists: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  prospects: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  pushLog: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  pushTokens: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  recruitmentBriefs: { guarantee: 'migration', owner: 'm18', reason: 'Second Look / Nobody Missed collection, guaranteed by the migration registry' },
  recruitmentCases: { guarantee: 'migration', owner: 'm12', reason: 'the canonical recruitment object (M12); the lifecycle lives on it' },
  recruitmentContacts: { guarantee: 'migration', owner: 'm23', reason: 'M23 P3 Contact workflow: the club-internal record of a communication process. A draft must live where no recipient route reads, and delivery truth must not become a case state' },
  recruitmentOffers: { guarantee: 'optional', owner: 'core', reason: 'M23 P4 has not shipped. The journey reports offer.available=false rather than an empty list — we cannot answer that yet is a different statement from there are none' },
  reports: { guarantee: 'migration', owner: 'core', reason: 'report-user/scout/club submissions (D2)' },
  representations: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  // M23 P5.6B — ScoutBox Agent core. Guaranteed by migration 2305 so a
  // restored older snapshot has them before any Agent route can run.
  agentProfiles: { guarantee: 'migration', owner: 'm24', reason: 'P5.6B: the licensed natural person\'s agent profile and verification facets; personal, survives agency departure' },
  agencyAffiliations: { guarantee: 'migration', owner: 'm24', reason: 'P5.6B: time-aware Agent ↔ Agency membership with roles; the permission matrix reads it on every request' },
  representationAgreements: { guarantee: 'migration', owner: 'm24', reason: 'P5.6B: the client-confirmed relationship record — the only basis for an agent\'s private client access' },
  reputationSeed: { guarantee: 'migration', owner: 'core', reason: 'demo track records; EMPTY is the correct production value — fabricating them would be worse than the bug (D2)' },
  requests: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  reviewLater: { guarantee: 'module', owner: 'm13', reason: 'existed only because insightSweep() happens to run once synchronously at registration; a store whose existence depends on a sweep moves the day the sweep is made lazy' },
  roomComments: { guarantee: 'migration', owner: 'm17', reason: 'Recruitment Room collection, guaranteed by the migration registry' },
  roomDecisions: { guarantee: 'migration', owner: 'm17', reason: 'Recruitment Room collection, guaranteed by the migration registry' },
  roomEvidenceState: { guarantee: 'migration', owner: 'm17', reason: 'Recruitment Room collection, guaranteed by the migration registry' },
  roomSnapshots: { guarantee: 'migration', owner: 'm17', reason: 'Recruitment Room collection, guaranteed by the migration registry' },
  savedSearches: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  secondLookItems: { guarantee: 'migration', owner: 'm18', reason: 'Second Look / Nobody Missed collection, guaranteed by the migration registry' },
  secrets: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  sessions: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  signings: { guarantee: 'migration', owner: 'core', reason: 'the evidence the signed lifecycle state rests on; exactly one writer in the repository' },
  sourceChanges: { guarantee: 'migration', owner: 'm18.1', reason: 'M18.1 source-change clock, guaranteed by the migration registry' },
  squadInvites: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  ssoConfigs: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  ssoStates: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  supportAccessGrants: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  supportTickets: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  transitionCases: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  trials: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  uploadSessions: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  users: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  vacancies: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  verAdmins: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verClaims: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verConflicts: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verDisputes: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verDomainRequests: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verEvents: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verEvidence: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verMigrated: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verPlayerInvites: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verReferences: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verRootRequests: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  verRootTransfers: { guarantee: 'module', owner: 'm14', reason: 'was created inside the transfer route; moved to m14/shared.mjs beside its twelve siblings' },
  verTokens: { guarantee: 'module', owner: 'm14', reason: 'M14 verification collection, created by migrateM14 at registration' },
  videoSegments: { guarantee: 'module', owner: 'm12', reason: 'M12 feature collection, created by migrateM12 at registration' },
  vouches: { guarantee: 'module', owner: 'core', reason: 'owned by server.mjs, which has no register() of its own; created during synchronous composition before the socket opens' },
  watchlistHistory: { guarantee: 'migration', owner: 'core', reason: 'core platform collection, guaranteed by the migration registry so it survives an arbitrary restore' },
  webhookDeliveries: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },
  webhookEndpoints: { guarantee: 'module', owner: 'm13', reason: 'M13 feature collection, created by migrateM13 at registration' },});

/** Every store name the contract knows about. */
export const CONTRACT_STORES = Object.freeze(Object.keys(PRODUCTION_STORE_CONTRACT));

/**
 * Stores guaranteed by the migration registry.
 *
 * DERIVED, not hand-kept. `m182/migrations.mjs` re-exports this as
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
