// ScoutBox sync backend: the wiring of every domain. Every rule is enforced in the domains it registers, not in the
// frontends — the product's claims depend on the API refusing, not the UI hiding.

import express from 'express';
import { installAsyncErrorForwarding } from './domains/platform/asyncErrors.mjs';
// A rejected async handler answers 500 instead of ending the process.
installAsyncErrorForwarding();

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.mjs';
import { openStore } from './store.mjs';
import { attachDataLayer } from './repositories/index.mjs';
import { createIdCounter } from './repositories/counters.mjs';
import { buildRouteHelpers } from './domains/platform/routeHelpers.mjs';
import { installHttpBaseline, registerAppHosting, installErrorContract } from './domains/platform/http.mjs';
import { createLiveSync } from './domains/platform/liveSync.mjs';
import { registerMeta, registerCapabilities, assertProductionConfig } from './domains/platform/operator.mjs';
import { createMedia, createMediaSigning } from './domains/media/index.mjs';
import { createAccountServices, createAccounts, createSessions } from './domains/identity/index.mjs';
import { createActivity, createDevelopment } from './domains/development/index.mjs';
import { vouchView, createVouchReads } from './domains/verification/vouches.mjs';
import { createInsights } from './domains/discovery/insights.mjs';
import { createContractLookup } from './domains/recruitment/signings/contract.mjs';
import { createScouting } from './domains/scouting/index.mjs';
import { createOperations } from './domains/operations/index.mjs';
import { createIntegrations } from './domains/integrations/index.mjs';
import { createDelivery, createMessaging, createNotificationFeed } from './domains/messaging/index.mjs';
import { registerTransitions } from './domains/verification/transitions.mjs';
import { createInsight } from './domains/insight/index.mjs';
import { registerBudgets } from './domains/recruitment/budgets.mjs';
import { createGroups } from './domains/groups/index.mjs';
import { registerVerificationClaims } from './domains/verification/claims/index.mjs';
import { createSafety, createSafetyConsole } from './domains/safety/index.mjs';
import { registerFootballPassport } from './domains/passport/index.mjs';
import { registerTrustScore } from './domains/passport/trust/index.mjs';
import { registerRecruitmentRooms } from './domains/recruitment/rooms/index.mjs';
import { registerDiscovery } from './domains/discovery/index.mjs';
import { registerMatching } from './domains/discovery/matching/index.mjs';
import { registerSavedSearches } from './domains/discovery/savedSearches.mjs';
import { registerAnalytics } from './domains/recruitment/analytics/index.mjs';
import { registerLifecycle } from './domains/recruitment/lifecycle/index.mjs';
import { createAgentAccess } from './domains/agents/access.mjs';
import { registerAgent } from './domains/agents/core/index.mjs';
import { registerCompliance } from './domains/agents/compliance/index.mjs';
import { registerTransactions } from './domains/agents/transactions/index.mjs';
import { registerIntegration } from './domains/agents/integration/index.mjs';
import { registerOffers } from './domains/recruitment/offers/index.mjs';
import { registerSigning } from './domains/recruitment/signings/index.mjs';
import { registerJourneyRoutes } from './domains/recruitment/lifecycle/journeyRoutes.mjs';
import { createVerificationProvider } from './domains/agents/compliance/provider.mjs';
import { createEvidenceProvider } from './domains/recruitment/lifecycle/evidence.mjs';
import { COMBINE_PROTOCOLS, combineVerifiedProtocols } from './domains/development/public.mjs';
import { agentAuditRows, complianceAuditRows } from './domains/agents/public.mjs';
import { OPEN_ROOM_STATUSES } from './domains/recruitment/public.mjs';
import { TRUST_SCORE_POLICY_VERSION } from './domains/passport/public.mjs';
import { createSourceChanges } from './domains/platform/sourceChanges.mjs';
import { createRateLimiter, installRateLimitInspection } from './domains/platform/rateLimit.mjs';
import { demoSeedEnabled, devLoginsEnabled } from './domains/platform/capabilities.mjs';
import { isLeadRole } from './roles.mjs';
import { parseTrustProxy } from './httpTrust.mjs';
import { assertEventRegistry } from './domains/platform/eventRegistry.mjs';
import { createNotificationPrefs, registerNotificationPrefs } from './domains/platform/notificationPrefs.mjs';
import { channelViewFor } from './domains/messaging/channels.mjs';
import { registerAudit } from './domains/platform/audit.mjs';
import { inRequest } from './writeRules.mjs';
import { createFaultLayer } from './domains/platform/faults.mjs';
import { integrityReport } from './domains/platform/integrity.mjs';
import { orgPlayerView } from './views/playerViews.mjs';
import { DRILLS } from './domains/development/record.mjs';
import { registerRequestInbox } from './domains/recruitment/inbox.mjs';
import { registerPlayerSearch } from './domains/discovery/search.mjs';
import { registerFilmRoom } from './domains/discovery/filmRoom.mjs';
import { createRequestWriters, registerClubRequests, requestForRecipient } from './domains/recruitment/requests.mjs';
import { registerClubTrials } from './domains/recruitment/clubTrials.mjs';
import { registerLegacySigning } from './domains/recruitment/signings/legacy.mjs';
import { registerLedger, ledgerView } from './domains/recruitment/ledger.mjs';
import { grassrootsOrgOnly } from './domains/development/guards.mjs';
import { registerClubChecks } from './domains/verification/clubChecks.mjs';
import { createEnterprise } from './domains/enterprise/index.mjs';
import { requestInstrumentation } from './domains/platform/metrics.mjs';
import {
  hashPassword,
  verifyPassword,
  newToken,
  createMailer,
  createPushSender,
  createIdvProvider,
  createBilling,
  createStorage,
} from './adapters.mjs';
import { ageOn, isAdult, visibleToOrg, computeTrustScore, trustBreakdown, haversineKm } from './domain.mjs';

import { createLookups } from './domains/platform/lookups.mjs';
import { createMatchFactsKeeper } from './domains/discovery/matchFacts.mjs';

const PORT = process.env.PORT || 4000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Tests set SCOUTBOX_FAST_SWEEPS=1 to run the minute sweeps every half second; the logic under test is the same.
const SWEEP_MS = process.env.SCOUTBOX_FAST_SWEEPS === '1' ? 500 : 60_000;

// ------------------------------------------------------------- persistence
// One SQLite file, data/scoutbox.db (store.mjs). DATA_DIR override keeps destructive tests on isolated throwaway
// databases. Every write is a repository operation that commits at once (or with its unit of work).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(HERE, 'data');
const store = openStore(DATA_DIR);

// Every write has committed by the time a handler returns (units of work are synchronous), so a shutdown only closes
// the connection: the WAL is checkpointed and the exit code stays 0.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      store.sqlite.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
}

// The data layer (repositories/): the table migrations, then every domain's repository. A first installation imports
// the seed's organisations, players and guardians once. The id generator is passed lazily: it needs the counters table.
const dataLayer = attachDataLayer({
  seed: buildSeed({ demo: demoSeedEnabled() }),
  store,
  nextId: (prefix) => nextId(prefix),
  sessionTtlMs:
    (Number(process.env.SESSION_TTL_DAYS) > 0 ? Number(process.env.SESSION_TTL_DAYS) : 30) * 24 * 3600 * 1000,
  log: (m) => {
    if (process.env.SCOUTBOX_QUIET_LOGS !== '1') console.log(m);
  },
});
const {
  users,
  sessions,
  orgs,
  players,
  guardians,
  mediaDeletions,
  codes,
  notifications,
  dispatches,
  outbox,
  pushLog,
  pushTokens,
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
  matchFacts,
} = dataLayer;
// Each domain's read-only query objects (`<domain>Reads`), handed to every module context.
const safetyReads = safetyAudit.reads;
const recruitmentReads = Object.freeze({
  ...recruitmentContactsOffers.reads,
  ...signingsFollowUps.reads,
  ...recruitment.reads,
  ...recruitmentCases.reads,
});
const scoutingReads = Object.freeze({
  ...scoutingEvidence.reads,
  ...scoutingAssessments.reads,
  ...clubSetup.reads,
  ...opportunitiesCampaigns.reads,
});
const verificationReads = Object.freeze({ ...verification.reads, ...passport.reads, ...transitionsVouches.reads });
const agentReads = agentCore.reads;
const developmentReads = development.reads;
const boxCamReads = boxCam.reads;
const discoveryReads = discovery.reads;
const insightReads = insightCoverage.reads;
const enterpriseReads = enterprise.reads;
const groupReads = groups.reads;
const grassrootsReads = grassroots.reads;
const integrationReads = integrations.reads;
const complianceReads = complianceRecords.reads;
// Lookups by id through the repositories' indexes, never a scan: handed to every module context as `byId`
// (`byId.player(id)`, `byId.org(id)`, …; null when there is none).
const byId = createLookups({ players, guardians, users, orgs });
if (dataLayer.boot.identity.imported)
  console.log(
    `data layer: ${dataLayer.boot.identity.players} player(s) and ${dataLayer.boot.identity.guardians} guardian(s) initialised from the first installation's records`,
  );

// The id counter is a row of `counters` (repositories/counters.mjs), written through at every mint.
const idCounter = createIdCounter({ sqlite: store.sqlite });
const nextId = (prefix) => `${prefix}-${idCounter.next()}`;

/**
 * One UNIT OF WORK (store.unitOfWork): every repository row write inside `work` commits or rolls back together; a
 * side effect registered with store.afterCommit runs only after COMMIT. `work` must be synchronous: prepare
 * asynchronous things before, publish after.
 */
// Development-only failure seams inside units of work (the fault layer's `internal:<step>` rules). The layer is created
// further down and cannot exist in production, so until then, and in production, no seam ever fires.
const seams = { shouldFail: () => false };
/**
 * `announce(result)`, when given, runs inside the same unit after `work`: the act's notifications, ledger rows and
 * live events, written (or registered for after the commit) with the act they describe.
 */
function unit(work, announce) {
  return store.unitOfWork(() => {
    // `internal:unit.after_commit`: this unit's first after-commit side effect fails, after its data committed.
    store.afterCommit(() => {
      if (seams.shouldFail('unit.after_commit'))
        throw new Error('simulated after-commit failure (development fault layer)');
    });
    const result = work();
    announce?.(result);
    // `internal:unit.sqlite_commit`: the REAL COMMIT of this unit fails (store.failCommitOfOpenTransaction).
    if (seams.shouldFail('unit.sqlite_commit')) store.failCommitOfOpenTransaction();
    return result;
  });
}
/** A named seam inside a unit: throws when a development fault rule names it, so the rollback path is proven with a real failure after a real write. */
function seam(step) {
  if (seams.shouldFail(step)) throw new Error(`simulated failure at ${step} (development fault layer)`);
}
// Integrity is reported at boot, never repaired. A violation is logged as codes and ids (no names) and counted on
// /capabilities; the process still starts, because a running server that says "two open Rooms for one player" is more
// useful than a dead one that says nothing.
const integrityCases = recruitmentCases.cases.withRoom();
// The players the Rooms name that still exist (ids are the table's primary key, so they cannot repeat).
const integrity = integrityReport(
  {
    players: [...new Set(integrityCases.map((c) => c.playerId))]
      .filter((id) => players.exists(id))
      .map((id) => ({ id })),
    orgs: orgs.list(),
  },
  { cases: integrityCases, openRoomStatuses: OPEN_ROOM_STATUSES },
);
for (const v of integrity.violations) console.error(`INTEGRITY ${v.code} key=${v.key} ids=${v.ids.join(',')}`);
if (integrity.violations.length)
  console.error(`INTEGRITY ${integrity.violations.length} violation(s) in the database — nothing was repaired.`);

// ---------------------------------------------------- production adapters
// The mail, push and invoice records go through their repositories; the provider calls happen here.
const mailer = createMailer((p) => nextId(p), { outbox, outward: store.outward });
const pushSender = createPushSender((p) => nextId(p), { pushLog, pushTokens, outward: store.outward });
const idv = createIdvProvider();
const billing = createBilling({ invoices: operations.invoices, nextId: (p) => nextId(p) });
const storage = createStorage(DATA_DIR);

const findPlayer = (id) => byId.player(id);
const isBlocked = (playerId, orgId) => safetyAudit.blocks.has(playerId, orgId);

// ------------------------------------------------------------- the HTTP envelope
const app = express();
// Every request is one scope for the write rules (writeRules.mjs): what it commits is counted from here on.
app.use((req, res, next) => {
  store.writeRules.checkDrift(); // a write outside a transaction before this request is not this request's
  res.on('finish', () => store.writeRules.requestEnded());
  inRequest(
    {
      method: req.method,
      routeKey: () => `${req.method} ${req.route ? `${req.baseUrl}${req.route.path}` : req.originalUrl.split('?')[0]}`,
    },
    next,
  );
});
// The parsed proxy setting is reported in /capabilities, and an invalid value refuses to boot in production.
const TRUST_PROXY = parseTrustProxy(process.env.SCOUTBOX_TRUST_PROXY);
installHttpBaseline({ app, trustProxy: TRUST_PROXY, schemaVersion: () => dataLayer.schemaVersion() });
// The development-only fault layer refuses to exist in production: there it is a no-op and has no /__faults route.
const faultLayer = createFaultLayer();
faultLayer.install(app);
seams.shouldFail = (step) => faultLayer.shouldFail(step);
// Correlation ids, structured request logs (redacted), request metrics and the exposure-capture hook, before every route.
app.use(requestInstrumentation());

// One rate limiter for the whole server. Every limited action is named in RATE_LIMIT_POLICY with its window and
// scope, and the capability report says plainly that the memory provider counts per process.
const rateLimit = createRateLimiter();
const { createSession, sessionFor, loginKey, loginLockedOut, noteLoginFailure } = createSessions({
  sessions,
  rateLimit,
});
// Media bytes live on object storage (local disk in dev); the database keeps only ids and /media/:id streams them.
createMediaSigning({ app, byId, sessions, mediaDeletions, storage, sessionFor, isBlocked });

// ---------------------------------------------------------------- live sync
const liveSync = createLiveSync({
  app,
  store,
  sessions,
  byId,
  users,
  channels,
  findPlayer,
  isBlocked,
  sessionFor,
  newToken,
});
const { broadcast, publishEvent, eventPayloadDrops } = liveSync;

// ------------------------------------------------------------------ helpers
function ledgerAppend(entry) {
  // The Discovery Ledger is append-only: a row of the ledger table, written at once (in the caller's unit of work when
  // one is open); userId and scoutName are stored exactly as the caller passes them.
  const row = safetyAudit.ledger.append({ id: nextId('led'), ts: Date.now(), ...entry });
  broadcast('ledger', { type: row.type, playerId: row.playerId });
  return row;
}

const canonicalContractFor = createContractLookup({ signingsFollowUps });

// Development shortcuts (seeded passwordless identities, credential-less org logins) exist for local work and tests
// only, and are refused in production.
const DEV_LOGINS = devLoginsEnabled();
installRateLimitInspection(app, rateLimit, { enabled: faultLayer.enabled });

// The preference gate exists before anything that notifies; its routes register with the other preference routes.
const notificationPrefs = createNotificationPrefs({ notifications });

registerMeta({ app, engine: store.engine, players, orgs, devLogins: DEV_LOGINS });

// ------------------------------------------------------------- accounts
// The session routes, the organisation, player and guardian routers, and the guardian and organisation accounts.
const { orgRouter, playerRouter, guardianRouter, guardianManagedOnly, orgSafe, safeguardingCertified, mfaGuards } =
  createAccounts({
    app,
    sessions,
    users,
    orgs,
    guardians,
    clubSetup,
    safetyAudit,
    byId,
    findPlayer,
    createSession,
    sessionFor,
    loginKey,
    loginLockedOut,
    noteLoginFailure,
    devLogins: DEV_LOGINS,
    mailer,
    idv,
    seam,
    unit,
    nextId,
    broadcast,
  });

// ------------------------------------------------------------- safety
// Moderation, reports and blocks, and the admin router: ScoutBox staff only, behind x-admin-key (ADMIN_KEY env).
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';
const { moderateOrRefuse, adminRouter } = createSafety({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminKey: ADMIN_KEY,
  sessionFor,
  compliancePolicies,
  safetyAudit,
  recruitment,
  byId,
  unit,
  nextId,
  broadcast,
  ledgerAppend,
});

// ------------------------------------------------------------- messaging
// The notifier exists before anything that notifies.
const { notifier, notify, openChannel } = createMessaging({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  guardianManagedOnly,
  sessionFor,
  store,
  notifications,
  notificationPrefs,
  pushSender,
  publishEvent,
  eventPayloadDrops,
  channels,
  recruitment,
  players,
  guardians,
  pushTokens,
  byId,
  isBlocked,
  moderateOrRefuse,
  unit,
  nextId,
  broadcast,
  ledgerAppend,
});

const { recordActivity, refreshJourneyBadges } = createActivity({ players, notify });
const { publishedVouchesFor, vouchesFor } = createVouchReads({ vouches: verificationReads.vouches });
const insightsFor = createInsights({ ledger: safetyAudit.ledger });

// Public view of a player for a given org: a positive allowlist (views/playerViews.mjs), never a spread of the
// record. It applies the minor-visibility rules, guardian-managed contact, player- and guardian-controlled medical
// sharing and the grassroots platform rules; it serves attendance without GPS and only this organisation's own trial
// reports; never the date of birth, coordinates, programme, guardian id, password hash, activity log, notification
// preferences, import claims or drill results.
const VIEW_HELPERS = {
  visibleToOrg,
  isBlocked,
  isAdult,
  ageOn,
  computeTrustScore,
  publishedVouchesFor,
  haversineKm,
  trustBreakdown,
};
function playerViewForOrg(player, org) {
  return orgPlayerView(player, org, VIEW_HELPERS);
}

// ------------------------------------------------------------- club routes
// The one writer of a request row and of an accepted trial: the Contact, Trial and open-day flows and the Inbox's
// answers all go through them.
const { issueRecruitmentRequest, issueAcceptedTrial, contactReplyFrom } = createRequestWriters({
  recruitment,
  nextId,
  ledgerAppend,
  notify,
  broadcast,
  safeguardingCertified,
  moderateOrRefuse,
});
registerPlayerSearch({
  orgRouter,
  players,
  safetyAudit,
  findPlayer,
  isBlocked,
  ledgerAppend,
  broadcast,
  nextId,
  playerViewForOrg,
});
registerClubRequests({
  orgRouter,
  recruitment,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  rateLimit,
  unit,
  issueRecruitmentRequest,
});
registerFilmRoom({
  orgRouter,
  players,
  recruitment,
  safetyAudit,
  findPlayer,
  isBlocked,
  unit,
  ledgerAppend,
  notify,
  broadcast,
  playerViewForOrg,
});
const { checkSavedSearches } = registerSavedSearches({
  byId,
  orgRouter,
  notify,
  nextId,
  playerViewForOrg,
  savedSearches: operations.savedSearches,
});
registerClubTrials({
  orgRouter,
  recruitment,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  unit,
  nextId,
  ledgerAppend,
  notify,
  broadcast,
});
// Development: the grassroots club and journey, the player's record, objectives, Box Cam and the Combine, the Hub.
const developmentDomain = createDevelopment({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  users,
  orgs,
  players,
  grassroots,
  clubSetup,
  transitionsVouches,
  signingsFollowUps,
  development,
  developmentReads,
  boxCam,
  boxCamReads,
  scoutingReads,
  recruitmentReads,
  notifications,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  storage,
  mailer,
  guardianManagedOnly,
  safeguardingCertified,
  moderateOrRefuse,
  playerViewForOrg,
  recordActivity,
  publishedVouchesFor,
  insightsFor,
  canonicalContractFor,
  issueRecruitmentRequest,
  scoutViewsOf: (playerId) => safetyAudit.ledger.countForPlayer(playerId, 'view'),
  unit,
  seam,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
});
const { pathwayRecord } = developmentDomain;
registerClubChecks({ orgRouter, orgs, codes, clubSetup, mailer, rateLimit, unit, seam, broadcast });
registerLedger({
  orgRouter,
  safetyAudit,
  recruitment,
  signings: signingsFollowUps.signings,
  invoices: operations.invoices,
  reputationSeed: operations.reputationSeed,
  findPlayer,
  isBlocked,
});

// The attributed Trust & Safety lane. Every route here resolves a specific authenticated reviewer (never the shared
// key) before it runs; the middleware comes from registerCompliance() below.
let complianceDomain = null;
const tsRouter = express.Router();
app.use(
  '/ts',
  (req, res, next) =>
    complianceDomain
      ? complianceDomain.reviewerAuth(req, res, next)
      : res.status(503).json({ error: 'REVIEWER_LANE_NOT_READY' }),
  tsRouter,
);

// Sessions die at once (API, and media on the next byte) and the user's open streams close. The user ROW is kept
// (removedAt) so history stays attributed. Inside a unit (the staff removal) the sessions go with its commit and the
// streams close after it.
function revokeOrgUserAccess(userId) {
  sessions.revokeOrgUser(userId);
  const silence = () => liveSync.closeStreamsOf(userId);
  if (store.inUnitOfWork?.()) store.afterCommit(silence);
  else silence();
}

// --------------------------------------------- scouting, operations and media
// Evidence and coach identity, assessments and video, opportunities and campaigns, development objectives, resumable
// uploads, and the post-signing follow-ups with their persistent sweep.
const clubWorkspaceCtx = {
  byId,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  recruitmentReads,
  users,
  orgs,
  players,
  guardians,
  unit,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  recruitment,
  recruitmentCases,
  signingsFollowUps,
  scoutingEvidence,
  scoutingAssessments,
  clubSetup,
  opportunitiesCampaigns,
  transitionsVouches,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  sessionFor,
  storage,
  mailer,
  orgSafe,
  recordActivity,
  revokeOrgUserAccess,
  grassrootsOrgOnly,
  guardianManagedOnly,
  safeguardingCertified,
  publishedVouchesFor,
  pathwayRecord,
  DRILLS,
  DATA_DIR,
  operations,
};
createScouting({
  byId,
  scoutingReads,
  verificationReads,
  players,
  unit,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  scoutingEvidence,
  clubSetup,
  transitionsVouches,
  findPlayer,
  moderateOrRefuse,
  development,
  recruitmentReads,
  users,
  recruitment,
  recruitmentCases,
  scoutingAssessments,
  playerViewForOrg,
  revokeOrgUserAccess,
  grassrootsReads,
  opportunitiesCampaigns,
  isBlocked,
  recordActivity,
  DRILLS,
});
const media = createMedia({
  playerRouter,
  players,
  operations,
  mediaDeletions,
  storage,
  findPlayer,
  firstInstallation: dataLayer.firstInstallation,
  assetsDir: path.join(HERE, 'assets'),
  moderateOrRefuse,
  recordActivity,
  unit,
  nextId,
  broadcast,
  DATA_DIR,
});
// Files whose removal was committed but not completed (a crash between COMMIT and the unlink, a storage error) are
// retried at boot and every minute.
media.sweepDeletions();
setInterval(() => {
  try {
    media.sweepDeletions();
  } catch (err) {
    console.error(`media deletions sweep failed: ${err?.message ?? err}`);
  }
}, 60_000).unref();
createOperations({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  users,
  orgs,
  players,
  recruitment,
  signingsFollowUps,
  opportunitiesCampaigns,
  scoutingReads,
  byId,
  findPlayer,
  isBlocked,
  sessionFor,
  moderateOrRefuse,
  storage,
  sweepUploads: media.sweepUploads,
  unit,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
  DATA_DIR,
});

// --------------------------------------- integrations, delivery and enterprise
// Imports, API keys and webhooks; the delivery centre; onboarding, MFA, SSO, audit and backup; private suitability
// preferences; transition cases; exposure and evidence-gap insight; fixture coverage; deal scenarios; federation
// groups.
const enterpriseCtx = {
  mfaGuards,
  byId,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  recruitmentReads,
  users,
  sessions,
  orgs,
  players,
  guardians,
  mediaDeletions,
  codes,
  notifications,
  dispatches,
  outbox,
  pushLog,
  pushTokens,
  channels,
  unit,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  recruitment,
  recruitmentCases,
  opportunitiesCampaigns,
  transitionsVouches,
  insightCoverage,
  enterprise,
  enterpriseReads,
  groups,
  groupReads,
  integrations,
  integrationReads,
  operations,
  schemaVersion: () => dataLayer.schemaVersion(),
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  sessionFor,
  storage,
  mailer,
  orgSafe,
  recordActivity,
  revokeOrgUserAccess,
  grassrootsOrgOnly,
  guardianManagedOnly,
  safeguardingCertified,
  createSession,
  DATA_DIR,
  backupDatabase: (file) => store.copyTo(file),
};
const { emitWebhook, webhookSweep } = createIntegrations({
  app,
  orgRouter,
  adminRouter,
  integrations,
  players,
  safetyAudit,
  byId,
  findPlayer,
  isBlocked,
  unit,
  nextId,
});
// The delivery centre retries the webhooks on its own timer.
const { notifyAction } = createDelivery({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  notifications,
  dispatches,
  outbox,
  operations,
  safetyAudit,
  users,
  byId,
  findPlayer,
  isBlocked,
  unit,
  nextId,
  notify,
  emitWebhook,
  webhookSweep,
});
createEnterprise({
  app,
  orgRouter,
  adminRouter,
  enterprise,
  enterpriseReads,
  groupReads,
  insightReads,
  integrationReads,
  recruitmentReads,
  users,
  orgs,
  players,
  sessions,
  codes,
  channels,
  notifications,
  dispatches,
  outbox,
  pushLog,
  pushTokens,
  mediaDeletions,
  recruitment,
  recruitmentCases,
  safetyAudit,
  byId,
  isBlocked,
  mfaGuards,
  createSession,
  orgSafe,
  mailer,
  storage,
  unit,
  nextId,
  notify,
  schemaVersion: () => dataLayer.schemaVersion(),
  backupDatabase: (file) => store.copyTo(file),
  DATA_DIR,
});
const insightDomain = (() => {
  const ctx = { ...enterpriseCtx, ...buildRouteHelpers(enterpriseCtx) };
  const { transitionSweep } = registerTransitions({ ...ctx, notifyAction, emitWebhook });
  const insight = createInsight({
    orgRouter,
    playerRouter,
    insightCoverage,
    recruitmentReads,
    scoutingReads,
    safetyReads,
    players,
    byId,
    findPlayer,
    isBlocked,
    playerViewForOrg,
    unit,
    nextId,
    notify,
  });
  registerBudgets(ctx);
  createGroups({
    orgRouter,
    adminRouter,
    groups,
    groupReads,
    recruitmentReads,
    scoutingReads,
    safetyReads,
    byId,
    users,
    findPlayer,
    isBlocked,
    unit,
    nextId,
    notify,
  });
  const tick = () => {
    transitionSweep();
    insight.insightSweep();
  };
  tick();
  setInterval(tick, SWEEP_MS).unref();
  return insight;
})();

// ---------------------------------------------------- verification claims
// Verification & Trust: independent claims, org-administered attestation,
// Trust & Safety review, licences, disputes, references (domains/verification/claims/).
// Returns its context so the console's verification switch can keep claim provenance in sync.
const verificationClaims = registerVerificationClaims({
  verification,
  unit,
  byId,
  players,
  guardians,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  users,
  orgs,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  sessionFor,
  storage,
  mailer,
  orgSafe,
  recordActivity,
  revokeOrgUserAccess,
  grassrootsOrgOnly,
  guardianManagedOnly,
  safeguardingCertified,
  createSession,
  DATA_DIR,
});

// ------------------------------------------------- the Trust & Safety console
createSafetyConsole({
  adminRouter,
  dataLayerReport: (opts) => dataLayer.report(opts),
  storeEngine: store.engine,
  unit,
  notify,
  broadcast,
  mailer,
  players,
  guardians,
  orgs,
  sessions,
  channels,
  safetyAudit,
  signingsFollowUps,
  operations,
  outbox,
  pushLog,
  transitionsVouches,
  verificationReads,
  byId,
  orgSafe,
  safeguardingCertified,
  channelViewFor,
  vouchView,
  syncLegacyOrgVerification: verificationClaims.syncLegacyOrgVerification,
});

// Canonical source-change events. Registered before the systems that write to
// it (the Passport preferences) and the system that reads it (Second Look),
// so a change carries the clock of the moment it happened rather than one
// borrowed from a record describing a different event.
const sourceChanges = createSourceChanges({ nextId, safetyAudit });

// The preference routes and the club's audit feed.
registerNotificationPrefs({ prefs: notificationPrefs, orgRouter, playerRouter, guardianRouter });
registerAudit({
  recruitmentReads,
  discoveryReads,
  developmentReads,
  safetyReads,
  agencySources: [
    (org, view) => agentAuditRows(agentReads, org, view),
    (org) => complianceAuditRows(complianceReads, org),
  ],
  orgRouter,
  findPlayer,
  orgCanSee: (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id),
  requireLead: (req, res) => {
    if (isLeadRole(req.orgUser?.role)) return true;
    res.status(403).json({ error: 'LEAD_REQUIRED', message: 'Only recruitment leads and directors can do this.' });
    return false;
  },
});

// Football Passport: a provenance-aware projection over existing records.
// Registered after the verification claims so it can read them; it
// receives the same context and adds no new authorization surface.
const passportDomain = registerFootballPassport({
  byId,
  players,
  guardians,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  recruitmentReads,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  storage,
  recordSourceChange: sourceChanges.recordSourceChange,
  passport,
  unit,
});

// ScoutBox Trust Score: a DERIVED evidence-confidence summary over the
// verification claims, the Passport assembly, Box Cam and the Combine.
// Registered last because it consumes all of them; it adds no storage and no
// authorization surface (a Trust Score grants nothing).
const trustDomain = registerTrustScore({
  byId,
  players,
  guardians,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  assemblePassport: passportDomain.assemblePassport,
  passportHistoryFor: passportDomain.passportHistoryFor, // the trust band's history source reads the history alone
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
});

// Recruitment Rooms: the CLUB's private decision layer over one player.
// Registered last of all because it composes every layer beneath it. It owns
// no player truth: the Passport, Trust Score, Combine, Box Cam and evidence it
// shows are the canonical projections, fetched through their own gates on
// every read. A Room grants no access to anything.
// The recruitment evidence provider: one, shared by the Rooms' own status route (which can name an evidence-bearing
// status), the lifecycle, signings, offers and journeys, so every status path carries the same burden.
const recruitmentEvidence = createEvidenceProvider(recruitmentReads);
const roomsDomain = registerRecruitmentRooms({
  recruitmentEvidence,
  rateLimit,
  faults: faultLayer, // the development fault seam inside the ONE lifecycle writer
  byId,
  players,
  guardians,
  users,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  recruitmentReads,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  recruitmentCases,
  unit,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  storage,
  publishedVouchesFor,
  pathwayRecord,
  DRILLS,
  DATA_DIR,
  grassrootsOrgOnly,
  guardianManagedOnly,
  safeguardingCertified,
  sessionFor,
  mailer,
  orgSafe,
  recordActivity,
  revokeOrgUserAccess,
  // Canonical source projections, each keeping its own gate.
  assemblePassport: passportDomain.assemblePassport,
  buildFootballPassport: passportDomain.buildFootballPassport,
  // The Passport CONTENT revision, recorded in decision snapshots.
  passportRevisionOf: passportDomain.passportRevisionOf,
  buildTrustProfile: trustDomain.buildTrustProfile,
  safeTrustProjection: trustDomain.safeTrustProjection,
  trustSnapshotOf: trustDomain.trustSnapshotOf,
  combineProjection: developmentDomain.combineProjection,
  combineRequestView: developmentDomain.combineRequestView,
  combineProtocolActive: developmentDomain.combineProtocolActive,
  combineOrgMaySeeResults: developmentDomain.combineOrgMaySeeResults,
  createCombineRequests: developmentDomain.createCombineRequests,
  boxPrefsFor: developmentDomain.boxPrefsFor,
  requestEvidenceGap: insightDomain.requestEvidenceGap,
  computeEvidenceGaps: insightDomain.computeEvidenceGaps,
});

// Second Look + Nobody Missed: two deterministic workflow systems over
// everything beneath them. Second Look asks whether something materially
// changed since THIS club last decided; Nobody Missed asks whether eligible
// players match the club's own stated criteria without ever entering its
// workflow. Neither judges talent, neither ranks, and neither is player-facing:
// the module registers no player, guardian or public route at all.
const discoveryDomain = registerDiscovery({
  rateLimit,
  byId,
  players,
  guardians,
  users,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  complianceReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  recruitmentReads,
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  discovery,
  unit,
  matchFacts, // matching and Nobody Missed are queries over the stored facts
  combineProtocolIds: () => COMBINE_PROTOCOLS.map((p) => p.id), // a brief's Combine protocols are refused unless known
  nextId,
  notify,
  ledgerAppend,
  broadcast,
  safetyAudit,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  storage,
  sessionFor,
  mailer,
  orgSafe,
  recordActivity,
  revokeOrgUserAccess,
  grassrootsOrgOnly,
  guardianManagedOnly,
  safeguardingCertified,
  publishedVouchesFor,
  pathwayRecord,
  DRILLS,
  DATA_DIR,
  // Canonical projections and the Room bridges — this module never mutates
  // the pipeline itself.
  assemblePassport: passportDomain.assemblePassport,
  buildFootballPassport: passportDomain.buildFootballPassport,
  buildTrustProfile: trustDomain.buildTrustProfile,
  safeTrustProjection: trustDomain.safeTrustProjection,
  trustSummaryFor: trustDomain.trustSummaryFor,
  combineProjection: developmentDomain.combineProjection,
  reopenRoom: roomsDomain.reopenRoom,
  createRoomForPlayer: roomsDomain.createRoomForPlayer,
  // Canonical source-change clocks (position, current club).
  sourceChangesFor: sourceChanges.sourceChangesFor,
});

// ------------------------------------------------- Explainable Matching
// Registered AFTER Second Look so it reuses the very same match reads (the
// stored facts, domains/discovery/matching/query.mjs) and the canonical Room
// bridge. There is deliberately no second matching engine and no second
// Room-creation path. `domainCtx` (the discovery context plus the reads) is the context the later domains spread.
const domainCtx = {
  ...discoveryDomain,
  recruitmentReads,
  scoutingReads,
  verificationReads,
  agentReads,
  developmentReads,
  development,
  boxCamReads,
  discoveryReads,
  insightReads,
  grassrootsReads,
  users,
  notifications, // the Agent module's inbox and unread count read the repository
  combineProtocolIds: () => COMBINE_PROTOCOLS.map((p) => p.id),
};
registerMatching(domainCtx);

// The match facts. Triggers on their inputs mark a player; the keeper re-derives the marked players before every
// COMMIT, so matching and Nobody Missed read current facts in SQL. Time-only changes (an expiry, an agreement's term,
// adulthood) are the minute sweep's.
const matchFactsKeeper = createMatchFactsKeeper({
  ...domainCtx,
  matchFacts,
  sqlite: store.sqlite,
  trustSummaryFor: trustDomain.trustSummaryFor,
  trustPolicyVersion: TRUST_SCORE_POLICY_VERSION,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
});
matchFactsKeeper.start();
setInterval(() => {
  try {
    matchFactsKeeper.sweep();
  } catch (err) {
    console.error(`match facts sweep failed: ${err?.message ?? err}`);
  }
}, 60_000).unref();

// ------------------------------------------------ Recruitment Analytics
// Registered LAST, because it reads everything and owns nothing. There is no
// analytics store: every figure is a projection over the Rooms, decisions,
// briefs, reviews, watchlists and trials the modules above already hold, so a
// number on the Director Dashboard cannot disagree with the record it came
// from. It measures the recruitment PROCESS -- never a player, never a
// colleague.
registerAnalytics(domainCtx);

// ------------------------------------------------------ Agent workspace
// Agency membership, role capabilities, the agent's profile and the concealing agreement lookup: every agent
// domain below checks through these.
const agentAccess = createAgentAccess({ agentCore, unit, nextId, broadcast });
// One verification provider for the agent core (facet submissions) and compliance (rechecks), so there is one
// path to a VERIFIED facet.
const verificationProvider = createVerificationProvider({
  synthetic: process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1',
});

// --------------------------------------------- Conflict & Compliance Engine
// Per-reviewer Trust & Safety identity, the versioned jurisdiction policies, the Conflict Engine, the consent
// ledger, attributed manual review and the minors gate. It re-authorises every regulated mutation when it happens.
complianceDomain = registerCompliance({
  ...domainCtx,
  isAdult,
  tsRouter,
  verificationProvider,
  hashPassword,
  verifyPassword,
  createSession,
  sessionFor,
  sessions,
  devLogins: DEV_LOGINS,
  access: agentAccess,
  agentCore,
  unit,
  compliancePolicies,
  complianceRecords,
});

// ------------------------------------------------ Agent cross-app integration
// The ONE layer that answers "may this agent see or do this, on this surface,
// for this client, right now?" — for Contact routing, Trial projection, the club
// Agent-presence badge, an opportunity share and a transaction handoff. It owns
// no store, declares no migration and duplicates no rule: the basis is the Agent
// core's access predicate, the licence is its facets, the policy verdict is the
// compliance engine's through one narrow seam, and the client's disclosure choices are a field of the
// agreement they are choices about. It reads the cases, agreements and transactions through their
// repositories, so it registers before the lifecycle and the transactions, which take its seam.
const integrationDomain = registerIntegration({
  ...domainCtx,
  isAdult,
  // The Rooms' own concealing case lookup and their own role ranking, passed rather
  // than re-derived — the handoff must be as invisible to a foreign club as the
  // case itself is.
  findRoomForRequest: roomsDomain.findRoomForRequest,
  access: agentAccess,
  compliance: complianceDomain.integrationSeam,
  recruitmentCases, // the transaction handoff is an explicit write of its case
  agentCore,
  unit, // an opportunity share is an explicit write of its agreement
  transactionReads: agentTransactions.reads, // the live transaction covering a case
});

// ------------------------------------------------- recruitment lifecycle
// The recruitment case is canonical and the Room is a facet of it. This is the
// OPERATING layer over them — named semantic actions with server-validated
// transitions, and one viewer-aware projection over the records that already
// exist. It writes status only through the Rooms' single writer
// (ctx.applyLifecycleTransition), so `case.stage` and `room.status` cannot
// disagree.
const lifecycleDomain = registerLifecycle({
  integration: integrationDomain.seam,
  recruitmentEvidenceProvider: recruitmentEvidence,
  recruitmentCases, // the formal decision row enters through the repository (and leaves it on a transport failure)
  recruitmentContactsOffers,
  recruitment,
  unit,
  afterCommit: (fn) => store.afterCommit(fn),
  ...domainCtx,
  operations, // an injected transport failure is used up through the delivery bookkeeping
  isAdult,
  // The Rooms' seams are not part of domainCtx, so they are passed explicitly: findRoom is the 404-concealing lookup
  // and applyLifecycleTransition the single status writer, and the lifecycle must use exactly those two.
  findRoomForRequest: roomsDomain.findRoomForRequest,
  applyLifecycleTransition: roomsDomain.applyLifecycleTransition,
  roomIsRoom: roomsDomain.roomIsRoom,
  // The decision-time evidence-confidence snapshot, captured through exactly
  // the code the Rooms' advisory recommendation uses.
  captureRoomSnapshot: roomsDomain.captureRoomSnapshot,
  // The ONE writer of a recipient-visible request row, so a Contact send
  // reaches the Inbox through exactly the path the direct request route uses.
  issueRecruitmentRequest,
  // Trial. The Combine consent rule is reused unchanged for Box
  // Cam evidence links (a trial is not consent to a player's home footage);
  // the test-provider gate is the same flag Box Cam reads; minors never act on
  // their own trials.
  combineOrgMaySeeResults: developmentDomain.combineOrgMaySeeResults,
  boxPrefsFor: developmentDomain.boxPrefsFor,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
  guardianManagedOnly,
});

// ------------------------------------------------ Agent Transaction Workspace
// The multi-party workspace (player, agent, engaging and releasing club): the transaction, its parties, its state
// machine, its documents and its timeline. The compliance verdict comes from the compliance engine's
// transaction seam and is re-derived at every material change.
const transactionsDomain = registerTransactions({
  ...domainCtx,
  isAdult,
  tsRouter,
  access: agentAccess,
  compliance: complianceDomain.transactionSeam,
  integration: integrationDomain.seam, // the handoff binding and the duplicate rule
  agentTransactions,
  unit,
  channels, // a linked thread's own authorisation
});

// ------------------------------------------------------ Agent core
// Agent profiles, agency affiliations and client-confirmed representation relationships. It asks compliance for
// review items and the verdict on an Approach, and an agency's audit feed carries the compliance and transaction
// rows beside its own.
const agentCoreDomain = registerAgent({
  ...domainCtx,
  isAdult,
  verificationProvider,
  agentCore,
  unit,
  access: agentAccess,
  compliance: complianceDomain.coreReviews,
  auditSources: [complianceDomain.complianceAuditRows, transactionsDomain.agencyAuditRows],
});

// ----------------------------------------------- Signing & Contract Completion
// The ONE writer of the signings, of the lifecycle move to
// `signed` and of a player's `contractStatus` for a recruitment signing.
// A package is opened over an ACCEPTED Offer revision, read from the offers
// repository, so it registers before the Offer module, whose views carry its
// read-only signing summary.
const signingsDomain = registerSigning({
  ...domainCtx,
  isAdult,
  storage,
  ledgerAppend,
  // The player's level, contract status and availability are columns written through the identity repository; a completion is one unit of work.
  players,
  unit,
  afterCommit: (fn) => store.afterCommit(fn),
  signingsFollowUps,
  clubSetup, // a grassroots signing adds the squad row through the club setup repository
  billing,
  refreshJourneyBadges,
  findRoomForRequest: roomsDomain.findRoomForRequest,
  applyLifecycleTransition: roomsDomain.applyLifecycleTransition,
  recruitmentCases, // the case's signing link and history are written in the completion unit
  recruitmentEvidenceProvider: recruitmentEvidence,
  access: agentAccess,
  integration: integrationDomain.seam,
  evidence: { storeFile: verificationClaims.storeEvidenceFile, add: verificationClaims.addEvidence },
  faults: faultLayer,
});
registerLegacySigning({
  orgRouter,
  signings: signingsFollowUps.signings,
  findPlayer,
  isBlocked,
  rateLimit,
  unit,
  recordCompletedSigning: signingsDomain.recordCompletedSigning,
  legacyRecordingBlocker: signingsDomain.legacyRecordingBlocker,
});

// ------------------------------------------------- canonical Offer workflow
// The authoritative Offer domain. A formal decision to progress AUTHORISES
// considering an Offer and creates none; an explicit club act drafts one;
// issuing freezes an exact immutable revision and moves the case to
// `offer_made`; the recipient's own acceptance or decline — and nothing else
// — moves it to `offer_accepted` / `offer_declined`. It moves the case only
// through the ONE validator (with the real evidence provider) and the ONE
// status writer; it never writes `signed`, never touches the signings, never
// negotiates and never lets an agent act for a player. It reads the integration
// seam (an agent's basis and scope), the transactions' readiness seam and the
// signing summary.
const offersDomain = registerOffers({
  ...domainCtx,
  recruitmentCases, // the case's history entries are written in the offer's unit
  recruitmentContactsOffers,
  unit,
  afterCommit: (fn) => store.afterCommit(fn),
  faults: faultLayer, // the development fault seam after an answer moved the case
  isAdult,
  storage,
  findRoomForRequest: roomsDomain.findRoomForRequest,
  applyLifecycleTransition: roomsDomain.applyLifecycleTransition,
  recruitmentEvidenceProvider: recruitmentEvidence,
  access: agentAccess,
  integration: integrationDomain.seam,
  transactions: transactionsDomain,
  signingSummary: signingsDomain.summaryForOffer,
});

// ------------------------------------------------------ journey audiences
// The player's, the guardian's and an authorized agent's journeys, and the
// notification target resolver. Registered after the Agent, Offer and signing modules because the agent
// route proves its basis through the same seams the Offer and signing agent
// routes use. Reads only.
const journeyCtx = registerJourneyRoutes({
  ...domainCtx,
  recruitmentEvidenceProvider: recruitmentEvidence,
  access: agentAccess,
  integration: integrationDomain.seam,
});
const notificationFeed = createNotificationFeed({
  orgRouter,
  playerRouter,
  guardianRouter,
  notifications,
  notifier,
  notificationTargetFor: journeyCtx.notificationTargetFor,
});

// ------------------------------------------------------ players and children
// Registered last: the export reads the feed, the erasure reaches every domain that holds a player, and the inbox
// answers through the lifecycle and opens threads.
createAccountServices({
  app,
  playerRouter,
  guardianRouter,
  adminRouter,
  players,
  guardians,
  orgs,
  sessions,
  codes,
  safetyAudit,
  mediaDeletions,
  uploads: operations.uploads,
  findPlayer,
  createSession,
  loginLockedOut,
  noteLoginFailure,
  devLogins: DEV_LOGINS,
  rateLimit,
  unit,
  afterCommit: store.afterCommit,
  seam,
  nextId,
  broadcast,
  notify,
  ledgerAppend,
  storage,
  removeUploadChunks: media.removeUploadChunks,
  DATA_DIR,
  checkSavedSearches,
  publishedVouchesFor,
  vouchesFor,
  insightsFor,
  viewHelpers: VIEW_HELPERS,
  ledgerView,
  requestsFor: (playerId) => recruitment.requests.forPlayer(playerId),
  requestForRecipient,
  ledgerPageForPlayers: (ids, page) => safetyAudit.ledger.pageForPlayers(ids, page),
  ledgerFor: (playerId) => safetyAudit.ledger.forPlayer(playerId),
  threadsFor: (playerId) => channels.forPlayer(playerId).map((c) => channelViewFor(c, 'player')),
  notificationFeed,
  trialsForOrg: (orgId) => recruitment.trials.forOrg(orgId),
  pathwayRecord,
  safeguardingCertified,
  // Each domain's part of a deletion, in this order, inside the deletion's unit.
  redactors: [
    (id, at) => recruitment.redactPlayer(id, at), // requests and trials become id-only tombstones
    (id, at) => recruitmentCases.redactPlayer(id, at), // a case keeps its status and the club's numbers; the name goes
    (id) => scoutingAssessments.assessments.redactPlayer(id),
    (id) => recruitmentContactsOffers.contacts.redactPlayer(id), // the reply's words go; the contact stays
    (id) => grassroots.openTrials.redactPlayer(id),
    agentCoreDomain.onPlayerDeleted,
    complianceDomain.onPlayerDeleted,
    transactionsDomain.onPlayerDeleted,
    offersDomain.onPlayerDeleted,
    signingsDomain.onPlayerDeleted,
    // Every thread of the player, guardian–club threads included (D-B, docs/decisions.md).
    (id) => channels.deleteForPlayer(id),
    (id) => notifications.deleteForAudience('player', id), // the preferences are kept, by decision
  ],
});
registerRequestInbox({
  playerRouter,
  guardianRouter,
  requests: recruitment.requests,
  findPlayer,
  unit,
  rateLimit,
  isBlocked,
  contactReplyFrom,
  requestForRecipient,
  lifecycle: lifecycleDomain,
  openChannel,
  issueAcceptedTrial,
  ledgerAppend,
  notify,
  broadcast,
  guardianManagedOnly,
});

// -------------------------------------------------------- operator surface
registerCapabilities({
  app,
  rateLimit,
  providerStatus: () => developmentDomain.providerStatus(),
  combineVerifiedProtocols,
  trustProxy: TRUST_PROXY,
  dataLayer,
  integrity,
  eventPayloadDrops,
  notifier,
  notificationPrefs,
  faultLayer,
});
assertProductionConfig({ trustWeightsTotal: trustDomain.trustWeightsTotal });

// The event registry must be internally consistent. Development and test throw here; in production the problems are
// logged. Every broadcast is checked against it when it is sent (liveSync.mjs), and an unregistered one fails closed.
for (const p of assertEventRegistry()) console.error(`EVENT REGISTRY ${p}`);

registerAppHosting({ app, publicDir: path.join(HERE, 'public') });
installErrorContract(app);

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${players.count()} players, ${orgs.count()} orgs`);
});
