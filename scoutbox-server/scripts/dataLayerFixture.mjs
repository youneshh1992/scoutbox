// Test helper (S14 last): a test database written the way the server writes one. There is no snapshot mode: a fixture
// opens the directory in server mode (the table migrations, then every repository), and each record goes through its
// repository's own write operation (`create`, `record`, `schedule`, …), which types it exactly as a route's write is
// typed. Junk is refused with the repository's own code (`*_INPUT_INVALID`, a foreign-key refusal for a dangling
// reference) and, because the whole fixture is one unit of work, nothing of a refused fixture is written.
//
// `writeFixture(dir, collections)` is ADDITIVE. On a new directory the organisations, players and guardians are the
// first installation's records (imported once, the way a first boot imports the seed, in a transaction of their own);
// everything else is one unit of work, so a refused fixture writes none of it (use a new directory to try again). On an
// existing directory the organisations and people are created like every other record. A collection with no writer here is refused (FIXTURE_COLLECTION_UNSUPPORTED): add one, or write it through
// its repository in the test.
//
// `readRecords(dir)` reads the whole database back as plain records, collection by collection, in the shapes the
// repositories hand out (the persistence suites compare what a server run left behind).
//
// Synthetic data only; temporary directories only.
import { createHash } from 'node:crypto';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';

const TTL = 30 * 86_400_000;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Open `dir` in server mode with every repository attached. `seed` is a first installation's records (ignored later). */
export function openLayer(dir, { seed = {}, now = Date.now, nextId = null, warn = () => {}, sessionTtlMs = TTL } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  let counter = null;
  const mint = nextId ?? ((prefix) => { counter ??= Number(store.sqlite.prepare("SELECT value FROM counters WHERE name = 'id'").get()?.value) || 0; counter += 1; store.sqlite.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'id'").run(counter); return `${prefix}-${counter}`; });
  const layer = attachDataLayer({ seed, store, nextId: mint, sessionTtlMs, now, warn, log: () => {} });
  return { store, layer, sqlite: store.sqlite, unit: (work) => store.unitOfWork(work), close: () => store.sqlite.close() };
}

/**
 * A session row with the token a test signs in with (only its hash is stored, as the sessions repository stores it).
 * `{ token, sid, kind, refId, userId?, via?, createdAt, expiresAt? }`.
 */
function writeSession(sqlite, s, { now, ttl }) {
  const createdAt = Number.isFinite(s.createdAt) ? s.createdAt : now;
  sqlite.prepare('INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(s.token), s.sid, s.kind, s.refId, s.kind === 'org' ? (s.userId ?? null) : null, s.via ?? null, createdAt, Number.isFinite(s.expiresAt) ? s.expiresAt : createdAt + ttl);
}

const each = (fn) => (L, records) => { for (const r of records) fn(L, r); };

/**
 * The writers, in dependency order: every collection a fixture may carry, and the repository operation that writes one
 * of its records. The order is the keys' order (organisations, people and staff first; a record after what it names).
 */
const WRITERS = {
  orgs: each((L, r) => L.orgs.create(r)),
  guardians: null, // with the players (the links derive from both): see writeIdentity
  players: null,
  // A removed account is created, then removed (create writes a current one).
  users: (L, records) => {
    for (const { removedAt = null, removedById = null, ...u } of records) {
      L.users.create(u);
      if (removedAt !== null) L.users.update(u.id, (d) => { d.removedAt = removedAt; d.removedById = removedById; });
    }
  },
  sessions: (L, records, ctx) => { for (const s of records) writeSession(L.sqlite, s, ctx); },
  // safety and audit
  blocks: each((L, r) => L.safetyAudit.blocks.add(r)),
  reports: each((L, r) => L.safetyAudit.reports.file(r)),
  moderationLog: each((L, r) => L.safetyAudit.moderationLog.record(r)),
  orgNotes: each((L, r) => L.safetyAudit.orgNotes.add(r)),
  ledger: each((L, r) => L.safetyAudit.ledger.append(r)),
  opsEvents: each((L, r) => L.safetyAudit.opsEvents.record(r)),
  sourceChanges: each((L, r) => L.safetyAudit.sourceChanges.record(r)),
  idvQueue: each((L, r) => L.safetyAudit.idvQueue.add(r)),
  // recruitment: a request's and a trial's case is an immediate key, and so are a case's links to its requests and
  // trials, so the cases are written without their links, then the requests and trials, then the links.
  recruitmentCases: each((L, r) => L.recruitmentCases.cases.create({ ...r, links: { ...(r.links ?? {}), requestIds: [], trialIds: [] } })),
  requests: each((L, r) => L.recruitment.requests.create(r)),
  trials: each((L, r) => L.recruitment.trials.create(r)),
  caseLinks: null, // see writeFixture: the cases' links, once their requests and trials exist
  roomComments: each((L, r) => L.recruitmentCases.comments.create(r)),
  roomSnapshots: each((L, r) => L.recruitmentCases.snapshots.create(r)),
  // A decision chain as the Room routes write it: each row is created naming only the rows already written, then the
  // remaining pointers are set by an update (a create naming a decision not yet there is refused).
  roomDecisions: (L, records) => {
    const D = L.recruitmentCases.decisions; const made = new Set();
    for (const r of records) {
      if (!r || typeof r !== 'object') { D.create(r); continue; } // junk: refused by the repository, naming it
      D.create({ ...r, supersedes: made.has(r.supersedes) ? r.supersedes : null, supersededById: made.has(r.supersededById) ? r.supersededById : null }); made.add(r.id);
    }
    for (const r of records) if ((r.supersedes ?? null) !== null || (r.supersededById ?? null) !== null) D.update(r.id, (d) => { d.supersedes = r.supersedes ?? null; d.supersededById = r.supersededById ?? null; });
  },
  roomEvidenceState: each((L, r) => L.recruitmentCases.evidenceStates.create(r)),
  recruitmentContacts: each((L, r) => L.recruitmentContactsOffers.contacts.create(r)),
  recruitmentOffers: each((L, r) => L.recruitmentContactsOffers.offers.create(r)),
  signingPackages: each((L, r) => L.signingsFollowUps.signingPackages.insert(r)),
  signings: each((L, r) => L.signingsFollowUps.signings.record(r)),
  followUps: each((L, r) => L.signingsFollowUps.followUps.schedule(r)),
  outcomeReports: each((L, r) => L.signingsFollowUps.outcomeReports.file(r)),
  // scouting
  // A correction names the record it corrects and back: both are created, then the original is marked superseded.
  evidence: (L, records) => {
    for (const r of records) L.scoutingEvidence.evidence.create({ ...r, supersededBy: null });
    for (const r of records) if (r.supersededBy) L.scoutingEvidence.evidence.update(r.id, (x) => { x.supersededBy = r.supersededBy; });
  },
  coachAffiliations: each((L, r) => L.scoutingEvidence.coachAffiliations.create(r)),
  squadInvites: each((L, r) => L.scoutingEvidence.squadInvites.create(r)),
  assessmentTemplates: each((L, r) => L.scoutingAssessments.templates.create(r)),
  videoSegments: each((L, r) => L.scoutingAssessments.segments.create(r)), // before the assessments whose ratings cite them
  assessments: each((L, r) => L.scoutingAssessments.assessments.create(r)),
  playlists: each((L, r) => L.scoutingAssessments.playlists.create(r)),
  tacticalSetups: each((L, r) => L.clubSetup.tactical.save(r)), // before the squad, shadow list and vacancies that name its roles
  lookingFor: each((L, { orgId, positions }) => L.clubSetup.lookingFor.set(orgId, positions)),
  federationChecks: each((L, r) => L.clubSetup.federation.submit(r)),
  squadMembers: each((L, r) => L.clubSetup.squad.create(r)),
  shadowPlayers: each((L, r) => L.clubSetup.shadow.create(r)),
  vacancies: each((L, r) => L.clubSetup.vacancies.create(r)),
  opportunities: each((L, r) => L.opportunitiesCampaigns.opportunities.create(r)),
  applications: each((L, r) => L.opportunitiesCampaigns.applications.create(r)),
  campaigns: each((L, r) => L.opportunitiesCampaigns.campaigns.create(r)),
  campaignSubmissions: each((L, r) => L.opportunitiesCampaigns.submissions.create(r)),
  playerPrefs: each((L, r) => L.opportunitiesCampaigns.preferences.save(r)),
  // verification and the Passport
  verClaims: each((L, r) => L.verification.claims.create(r)),
  verEvents: each((L, r) => L.verification.events.append(r)),
  verEvidence: each((L, r) => L.verification.evidence.create(r)),
  verTokens: each((L, r) => L.verification.tokens.create(r)),
  verAdmins: each((L, r) => L.verification.admins.create(r)),
  verRootTransfers: each((L, r) => L.verification.rootTransfers.create(r)),
  verRootRequests: each((L, r) => L.verification.rootRequests.create(r)),
  verDisputes: each((L, r) => L.verification.disputes.create(r)),
  verReferences: each((L, r) => L.verification.references.create(r)),
  verPlayerInvites: each((L, r) => L.verification.playerInvites.create(r)),
  verConflicts: each((L, r) => L.verification.conflicts.create(r)),
  verDomainRequests: each((L, r) => L.verification.domainRequests.create(r)),
  orgVerifiedDomains: each((L, { orgId, ...entry }) => L.verification.domains.add(orgId, entry)),
  passportPrefs: each((L, r) => L.passport.passportPrefs.save(r.playerId, () => structuredClone(r))),
  passportCareerEntries: each((L, r) => L.passport.careerEntries.create(r)),
  passportAchievements: each((L, r) => L.passport.achievements.create(r)),
  passportShares: each((L, r) => L.passport.shares.create(r)),
  passportCorrections: each((L, r) => L.passport.corrections.create(r)),
  transitionCases: each((L, r) => L.transitionsVouches.transitionCases.create(r)),
  vouches: each((L, r) => L.transitionsVouches.vouches.create(r)),
  // agents and compliance (the policy versions before the agreements that cite them)
  tsReviewers: each((L, r) => L.compliancePolicies.reviewers.create(r)),
  jurisdictionPolicies: each((L, r) => L.compliancePolicies.policies.create(r)),
  agentProfiles: each((L, r) => L.agentCore.profiles.create(r)),
  agencyAffiliations: each((L, r) => L.agentCore.affiliations.create(r)),
  representationAgreements: each((L, r) => L.agentCore.agreements.create(r)),
  complianceContexts: each((L, r) => L.complianceRecords.contexts.create(r)),
  regulatoryReviews: each((L, r) => L.complianceRecords.reviews.create(r)),
  regulatoryConsents: each((L, r) => L.complianceRecords.consents.create(r)),
  agentTransactions: each((L, r) => L.agentTransactions.transactions.create(r)),
  transactionRepresentations: each((L, r) => L.agentTransactions.representations.create(r)),
  transactionDocuments: each((L, r) => L.agentTransactions.documents.create(r)),
  // development and Box Cam
  devObjectives: each((L, r) => L.development.objectives.create(r)),
  drillGuidance: each((L, r) => L.development.drillReviews.record(r)),
  developmentPlans: each((L, r) => L.development.plans.create(r)),
  developmentGoals: each((L, r) => L.development.goals.create(r)),
  developmentActions: each((L, r) => L.development.actions.create(r)),
  developmentEvidenceLinks: each((L, r) => L.development.links.create(r)),
  developmentReviews: each((L, r) => L.development.reviews.create(r)),
  boxCamPrefs: each((L, r) => L.boxCam.prefs.save(r)),
  boxChallenges: each((L, r) => L.boxCam.challenges.create(r)),
  boxChallengeEntries: each((L, r) => L.boxCam.entries.create(r)),
  boxAssignments: each((L, r) => L.boxCam.assignments.create(r)),
  boxSessions: each((L, r) => L.boxCam.sessions.create(r)),
  boxCamDisputes: each((L, r) => L.boxCam.disputes.create(r)),
  combineRequests: each((L, r) => L.boxCam.requests.create(r)),
  combineAttempts: each((L, r) => L.boxCam.attempts.create(r)),
  boxCamCvResults: each((L, r) => L.boxCam.cvResults.record(r)),
  // discovery, insight and coverage
  recruitmentBriefs: each((L, r) => L.discovery.briefs.create(r)),
  nobodyMissedReviews: each((L, r) => L.discovery.reviews.create(r)),
  secondLookItems: each((L, r) => L.discovery.secondLook.create(r)),
  dynamicWatchlists: each((L, r) => L.discovery.watchlists.create(r)),
  exposureEvents: each((L, r) => L.insightCoverage.exposure.record(r)),
  calibrationSessions: each((L, r) => L.insightCoverage.calibration.create(r)),
  fixtures: each((L, r) => L.insightCoverage.fixtures.create(r)),
  coveragePlans: each((L, r) => L.insightCoverage.plans.create(r)),
  coverageAssignments: each((L, r) => L.insightCoverage.assignments.create(r)),
  // integrations, enterprise, groups, grassroots, operations
  importBatches: each((L, r) => L.integrations.batches.create(r)),
  apiKeys: each((L, r) => L.integrations.apiKeys.create(r)),
  webhookEndpoints: each((L, r) => L.integrations.endpoints.create(r)),
  webhookDeliveries: each((L, r) => L.integrations.deliveries.create(r)),
  orgInvites: each((L, r) => L.enterprise.invites.create(r)),
  ssoStates: each((L, r) => L.enterprise.ssoStates.create(r)),
  supportTickets: each((L, r) => L.enterprise.tickets.create(r)),
  groups: each((L, r) => L.groups.groups.create(r)),
  groupGrants: each((L, r) => L.groups.grants.create(r)),
  openTrials: each((L, r) => L.grassroots.openTrials.create(r)),
  matchdays: each((L, r) => L.grassroots.matchdays.create(r)),
  friendlies: each((L, r) => L.grassroots.friendlies.create(r)),
  savedSearches: each((L, r) => L.operations.savedSearches.create(r)),
  invoices: each((L, r) => L.operations.invoices.issue(r)),
  // threads and delivery
  channels: each((L, r) => L.channels.open(r)),
  notifications: each((L, r) => L.notifications.create(r)),
  dispatches: each((L, r) => L.dispatches.create(r)),
  outbox: each((L, r) => L.outbox.append(r)),
  pushLog: each((L, r) => L.pushLog.append(r)),
  pushTokens: each((L, r) => L.pushTokens.register(r)),
};
const ORDER = Object.keys(WRITERS);

/**
 * The identity pair on an existing database: guardians first (a player's primary link names one), then players. A
 * fixture's `password` is the stored hash, which the repositories take apart from the record (`passwordHash`).
 */
function writeIdentity(L, { players = [], guardians = [] }) {
  for (const { password = null, ...g } of guardians) L.guardians.create({ ...g, passwordHash: g.passwordHash ?? password });
  for (const { password = null, ...p } of players) L.players.create({ ...p, passwordHash: p.passwordHash ?? password });
}

/**
 * Write `collections` into `dir` through the repositories, in one unit of work (all or nothing). Returns `dir`.
 * `idCounter` raises the id counter (never lowers it), as a fixture whose ids are below it expects.
 */
export function writeFixture(dir, collections = {}, { now = Date.now(), idCounter = null, writers = {} } = {}) {
  const W = { ...WRITERS, ...writers }; // `writers`: a test's own writer for a collection, `(repos, records, { now, ttl, collections }) => …`
  const unknown = Object.keys(collections).filter((n) => collections[n] !== undefined && (!Object.hasOwn(W, n) || n === 'caseLinks') && n !== 'reputationSeed');
  if (unknown.length) throw Object.assign(new Error(`FIXTURE_COLLECTION_UNSUPPORTED: ${unknown.join(', ')} ${unknown.length === 1 ? 'has' : 'have'} no fixture writer (scripts/dataLayerFixture.mjs): add one, or write ${unknown.length === 1 ? 'it' : 'them'} through the repository in the test`), { code: 'FIXTURE_COLLECTION_UNSUPPORTED' });
  for (const [n, v] of Object.entries(collections)) if (v !== undefined && !Array.isArray(v)) throw new TypeError(`${n}: a fixture collection is an array of records`);
  const seed = { orgs: collections.orgs ?? [], players: collections.players ?? [], guardians: collections.guardians ?? [], reputationSeed: collections.reputationSeed ?? [] };
  const L = openLayer(dir, { seed, now: () => now });
  try {
    const ctx = { now, ttl: TTL, collections };
    const repos = { ...L.layer, sqlite: L.sqlite };
    L.unit(() => {
      if (!L.layer.firstInstallation) {
        for (const o of collections.orgs ?? []) L.layer.orgs.create(o);
        writeIdentity(L.layer, collections);
      }
      for (const name of [...ORDER, ...Object.keys(writers).filter((n) => !ORDER.includes(n))]) {
        if (name === 'orgs' || name === 'players' || name === 'guardians') continue;
        if (name === 'caseLinks') {
          if (W.recruitmentCases === WRITERS.recruitmentCases) for (const c of collections.recruitmentCases ?? []) if (c.links?.requestIds?.length || c.links?.trialIds?.length) L.layer.recruitmentCases.cases.update(c.id, (d) => { d.links = c.links; });
          continue;
        }
        const records = collections[name];
        if (records?.length) W[name](repos, records, ctx);
      }
    });
    if (idCounter !== null) L.sqlite.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'id'").run(Number(idCounter) || 0);
  } finally { L.close(); }
  return dir;
}
/** Every collection read back as plain records (the shapes the repositories hand out). */
export function readRecords(dir) {
  const L = openLayer(dir);
  try { return JSON.parse(JSON.stringify(readTableBacked(L.sqlite))); } finally { L.close(); }
}
