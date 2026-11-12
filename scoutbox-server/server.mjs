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
import { installSignedMedia } from './domains/media/signedMedia.mjs';
import { installSampleClips } from './domains/media/sampleClips.mjs';
import {
  createSessionAccess,
  registerSessionRoutes,
  createLoginBudget,
  devLoginRefused,
} from './domains/identity/sessions.mjs';
import { createModeration } from './domains/safety/moderation.mjs';
import { createActivity } from './domains/development/activity.mjs';
import { vouchView, createVouchReads } from './domains/verification/vouches.mjs';
import { createInsights } from './domains/discovery/insights.mjs';
import { createContractLookup } from './domains/recruitment/signings/contract.mjs';
import { registerPassport } from './domains/scouting/passport.mjs';
import { registerScouting } from './domains/scouting/scouting.mjs';
import { registerJourneys } from './domains/scouting/journeys.mjs';
import { registerSuitability } from './domains/scouting/suitability.mjs';
import { registerObjectives } from './domains/development/objectives.mjs';
import { registerUploads, removeUploadChunks } from './domains/media/uploads.mjs';
import { registerOperations } from './domains/operations/followUps.mjs';
import { registerImports } from './domains/integrations/imports.mjs';
import { registerDelivery } from './domains/messaging/delivery.mjs';
import { registerTransitions } from './domains/verification/transitions.mjs';
import { registerInsight } from './domains/insight/insight.mjs';
import { registerCoverage } from './domains/insight/coverage.mjs';
import { registerBudgets } from './domains/recruitment/budgets.mjs';
import { registerGroups } from './domains/groups/groups.mjs';
import { registerVerificationClaims } from './domains/verification/claims/index.mjs';
import { createAdminRouter, registerReporting, registerSafetyConsole } from './domains/safety/safety.mjs';
import { registerFootballPassport } from './domains/verification/passport/index.mjs';
import { registerBoxCam } from './domains/development/boxcam/index.mjs';
import { registerTrustScore } from './domains/verification/trust/index.mjs';
import { registerRecruitmentRooms } from './domains/recruitment/rooms/index.mjs';
import { registerDiscovery } from './domains/discovery/index.mjs';
import { registerMatching } from './domains/discovery/matching/index.mjs';
import { registerSavedSearches } from './domains/discovery/savedSearches.mjs';
import { registerAnalytics } from './domains/recruitment/analytics/index.mjs';
import { registerDevelopment } from './domains/development/hub/index.mjs';
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
import { COMBINE_PROTOCOLS } from './domains/development/boxcam/combineShared.mjs';
import { createSourceChanges } from './domains/platform/sourceChanges.mjs';
import { createRateLimiter, installRateLimitInspection } from './domains/platform/rateLimit.mjs';
import { demoSeedEnabled, devLoginsEnabled } from './domains/platform/capabilities.mjs';
import { isLeadRole } from './roles.mjs';
import { parseTrustProxy } from './httpTrust.mjs';
import { assertEventRegistry, EVENT_NAMES } from './domains/platform/eventRegistry.mjs';
import { createNotificationPrefs, registerNotificationPrefs } from './domains/platform/notificationPrefs.mjs';
import { createNotifier, registerNotificationFeed, registerDeliverySettings } from './domains/messaging/notify.mjs';
import { registerMessaging, channelViewFor } from './domains/messaging/channels.mjs';
import { registerAudit } from './domains/platform/audit.mjs';
import { inRequest } from './writeRules.mjs';
import { createFaultLayer } from './domains/platform/faults.mjs';
import { integrityReport } from './domains/platform/integrity.mjs';
import { orgPlayerView } from './views/playerViews.mjs';
import { registerGuardianAccount, registerGuardianIdReview } from './domains/identity/guardians.mjs';
import { createPlayerSession, registerPlayerAccount } from './domains/identity/players.mjs';
import { registerChildren } from './domains/identity/children.mjs';
import { createPlayerErasure, registerDataRights } from './domains/identity/dataRights.mjs';
import { DRILLS, registerPlayerRecord } from './domains/development/record.mjs';
import { registerGrassrootsJourney } from './domains/development/grassroots.mjs';
import { registerRequestInbox } from './domains/recruitment/inbox.mjs';
import {
  createOrgViews,
  createOrgSession,
  registerOrgAccount,
  registerClubDirectory,
} from './domains/identity/orgs.mjs';
import { registerPlayerSearch } from './domains/discovery/search.mjs';
import { registerFilmRoom } from './domains/discovery/filmRoom.mjs';
import { createRequestWriters, registerClubRequests, requestForRecipient } from './domains/recruitment/requests.mjs';
import { registerClubTrials } from './domains/recruitment/clubTrials.mjs';
import { registerLegacySigning } from './domains/recruitment/signings/legacy.mjs';
import { registerLedger, ledgerView } from './domains/recruitment/ledger.mjs';
import { registerGrassrootsClub, grassrootsOrgOnly } from './domains/development/grassrootsClub.mjs';
import { registerClubChecks } from './domains/verification/clubChecks.mjs';
import { createMfaGuards, registerEnterprise, requestInstrumentation } from './domains/enterprise/enterprise.mjs';
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
  { cases: integrityCases },
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

// Media bytes live on object storage (local disk in dev); the database keeps only ids and /media/:id streams them.
// Files whose removal was committed but not completed (a crash between COMMIT and the unlink, a storage error) are
// retried at boot and every minute.
mediaDeletions.process(storage);
setInterval(() => {
  try {
    mediaDeletions.process(storage);
  } catch (err) {
    console.error(`media deletions sweep failed: ${err?.message ?? err}`);
  }
}, 60_000).unref();

const findPlayer = (id) => byId.player(id);
const isBlocked = (playerId, orgId) => safetyAudit.blocks.has(playerId, orgId);
if (dataLayer.firstInstallation)
  installSampleClips({ assetsDir: path.join(HERE, 'assets'), findPlayer, players, storage });

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

const { createSession, sessionFor } = createSessionAccess({ sessions });
installSignedMedia({ app, byId, sessions, mediaDeletions, storage, sessionFor, isBlocked });

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
// The organisation as the apps see it, and whether its safeguarding certification stands.
const { orgSafe, safeguardingCertified } = createOrgViews({ clubSetup, safetyAudit });

function ledgerAppend(entry) {
  // The Discovery Ledger is append-only: a row of the ledger table, written at once (in the caller's unit of work when
  // one is open); userId and scoutName are stored exactly as the caller passes them.
  const row = safetyAudit.ledger.append({ id: nextId('led'), ts: Date.now(), ...entry });
  broadcast('ledger', { type: row.type, playerId: row.playerId });
  return row;
}

const canonicalContractFor = createContractLookup({ signingsFollowUps });

// -------------------------------------------------------------- sessions
registerSessionRoutes({ app, sessions, sessionFor });
// Development shortcuts (seeded passwordless identities, credential-less org logins) exist for local work and tests
// only, and are refused in production.
const DEV_LOGINS = devLoginsEnabled();
// One rate limiter for the whole server. Every limited action is named in RATE_LIMIT_POLICY with its window and
// scope, and the capability report says plainly that the memory provider counts per process.
const rateLimit = createRateLimiter();
installRateLimitInspection(app, rateLimit, { enabled: faultLayer.enabled });
const { loginKey, loginLockedOut, noteLoginFailure } = createLoginBudget({ rateLimit });

// ------------------------------------------------------------ notifications
// The preference gate exists before anything that notifies; its routes register with the other preference routes.
const notificationPrefs = createNotificationPrefs({ notifications });
const notifier = createNotifier({
  notifications,
  prefs: notificationPrefs,
  store,
  pushSender,
  byId,
  publishEvent,
  eventPayloadDrops,
});
const { notify } = notifier;

const { recordActivity, refreshJourneyBadges } = createActivity({ players, notify });
const { publishedVouchesFor, vouchesFor } = createVouchReads({ vouches: verificationReads.vouches });
const insightsFor = createInsights({ ledger: safetyAudit.ledger });
const moderateOrRefuse = createModeration({ safetyAudit, unit, nextId });

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

registerMeta({ app, engine: store.engine, players, orgs, devLogins: DEV_LOGINS });

// The authenticated routers. The guardian's is created with the guardian account, below; the player account's
// routes are domains/identity/players.mjs.
const { orgRouter } = createOrgSession({ app, findOrg: byId.org, users, sessionFor });
const { playerRouter, guardianManagedOnly } = createPlayerSession({ app, findPlayer, sessionFor });

// -------------------------------------------------------------- guardians
// Parents own every under-18 account. The account and its safeguarding gates (e-mail, ID, disclaimer) are
// domains/identity/guardians.mjs; managing the children is domains/identity/children.mjs.
const { guardianRouter } = registerGuardianAccount({
  app,
  guardians,
  safetyAudit,
  unit,
  nextId,
  mailer,
  idv,
  faultSeam: seam,
  createSession,
  sessionFor,
  loginKey,
  loginLockedOut,
  noteLoginFailure,
  devLogins: DEV_LOGINS,
  devLoginRefused,
});

// ------------------------------------------------------------- message threads
const { openChannel } = registerMessaging({
  orgRouter,
  playerRouter,
  guardianRouter,
  channels,
  recruitment,
  byId,
  isBlocked,
  unit,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
  moderateOrRefuse,
  guardianManagedOnly,
});

// ------------------------------------------------------------- organisations
// The sign-in pickers, Grassroots registration and staff log-in (domains/identity/orgs.mjs). The MFA guards are
// shared with the MFA set-up routes (domains/enterprise/enterprise.mjs).
const mfaGuards = createMfaGuards();
registerOrgAccount({
  app,
  orgs,
  users,
  safetyAudit,
  findOrg: byId.org,
  unit,
  nextId,
  broadcast,
  createSession,
  loginLockedOut,
  noteLoginFailure,
  devLogins: DEV_LOGINS,
  devLoginRefused,
  mfaGuards,
  orgSafe,
  safeguardingCertified,
});

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
const { pathwayRecord, openTrialView } = registerGrassrootsClub({
  orgRouter,
  players,
  grassroots,
  clubSetup,
  transitionsVouches,
  signings: signingsFollowUps.signings,
  findPlayer,
  findOrg: byId.org,
  unit,
  seam,
  nextId,
  ledgerAppend,
  notify,
  broadcast,
  moderateOrRefuse,
  playerViewForOrg,
  recordActivity,
  canonicalContractFor,
  issueRecruitmentRequest,
});
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
registerClubDirectory({
  app,
  orgs,
  trialsForOrg: (orgId) => recruitment.trials.forOrg(orgId),
  safeguardingCertified,
  pathwayRecord,
});

// ------------------------------------------------------ admin (T&S) console
// ScoutBox staff only. Prototype auth: x-admin-key (ADMIN_KEY env).
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';
const adminRouter = createAdminRouter({ app, adminKey: ADMIN_KEY, sessionFor, compliancePolicies });

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

registerGuardianIdReview({ adminRouter, guardians, safetyAudit, unit });

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
{
  const ctx = { ...clubWorkspaceCtx, ...buildRouteHelpers(clubWorkspaceCtx) };
  registerPassport(ctx);
  registerScouting(ctx);
  registerJourneys(ctx);
  registerObjectives(ctx);
  const { sweepUploads } = registerUploads(ctx);
  registerOperations({ ...ctx, sweepUploads });
}

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
const insightDomain = (() => {
  const ctx = { ...enterpriseCtx, ...buildRouteHelpers(enterpriseCtx) };
  const { emitWebhook, webhookSweep } = registerImports(ctx);
  // The delivery centre retries the webhooks on its own timer.
  const { notifyAction } = registerDelivery({ ...ctx, emitWebhook, webhookSweep });
  registerEnterprise(ctx);
  registerSuitability(ctx);
  const { transitionSweep } = registerTransitions({ ...ctx, notifyAction, emitWebhook });
  const insight = registerInsight(ctx);
  registerCoverage(ctx);
  registerBudgets(ctx);
  registerGroups(ctx);
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

// ------------------------------------------------- reports, blocks, console
registerReporting({
  playerRouter,
  guardianRouter,
  orgRouter,
  safetyAudit,
  recruitment,
  byId,
  unit,
  nextId,
  ledgerAppend,
  broadcast,
});
registerSafetyConsole({
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
  agentReads,
  complianceReads,
  safetyReads,
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
const boxCamDomain = registerBoxCam({
  rateLimit,
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
  players,
  unit, // a Box Clip marks a media row through the repository, inside a unit with the session and the ledger
  boxCam,
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
  combineProjection: boxCamDomain.combineProjection,
  combineFacts: boxCamDomain.combineFacts,
  combineRequestView: boxCamDomain.combineRequestView,
  combineProtocolActive: boxCamDomain.combineProtocolActive,
  combineOrgMaySeeResults: boxCamDomain.combineOrgMaySeeResults,
  createCombineRequests: boxCamDomain.createCombineRequests,
  boxPrefsFor: boxCamDomain.boxPrefsFor,
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
  combineProjection: boxCamDomain.combineProjection,
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

// ------------------------------------------------------- Development Hub
// Workflow, not truth. Plans, goals, actions, reviews and REFERENCES to
// evidence the modules above already own — resolved live, never copied, so an
// invalidated Combine result or a withdrawn assessment reads as unavailable
// here the moment it changes there. Nothing in the Hub writes into the Passport,
// Trust, Matching or the Director Dashboard, and no figure anywhere in it
// combines counts into a score.
registerDevelopment({
  ...domainCtx,
  isAdult,
  unit, // every Hub write is one unit of work
});

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
  combineOrgMaySeeResults: boxCamDomain.combineOrgMaySeeResults,
  boxPrefsFor: boxCamDomain.boxPrefsFor,
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
const notificationFeed = registerNotificationFeed({
  orgRouter,
  playerRouter,
  guardianRouter,
  notifications,
  notifier,
  notificationTargetFor: journeyCtx.notificationTargetFor,
});

// ------------------------------------------------------ players and children
// Registered last: the inbox answers through the lifecycle and opens threads, the export reads the feed, and the
// erasure reaches every domain that holds a player.
registerPlayerAccount({
  app,
  playerRouter,
  players,
  guardians,
  findPlayer,
  codes,
  unit,
  seam,
  nextId,
  rateLimit,
  broadcast,
  notify,
  ledgerAppend,
  createSession,
  loginLockedOut,
  noteLoginFailure,
  devLogins: DEV_LOGINS,
  devLoginRefused,
  checkSavedSearches,
  publishedVouchesFor,
  vouchesFor,
});
registerChildren({
  guardianRouter,
  players,
  guardians,
  findPlayer,
  codes,
  unit,
  nextId,
  rateLimit,
  broadcast,
  checkSavedSearches,
  insightsFor,
  requestsFor: (playerId) => recruitment.requests.forPlayer(playerId),
  ledgerPageForPlayers: (ids, page) => safetyAudit.ledger.pageForPlayers(ids, page),
  ledgerView,
  viewHelpers: VIEW_HELPERS,
});
registerPlayerRecord({
  playerRouter,
  players,
  unit,
  seam,
  nextId,
  broadcast,
  storage,
  guardianManagedOnly,
  moderateOrRefuse,
  recordActivity,
  ledgerAppend,
  insightsFor,
  canonicalContractFor,
});
registerGrassrootsJourney({
  app,
  playerRouter,
  guardianRouter,
  players,
  orgs,
  grassroots,
  clubSetup,
  transitionsVouches,
  findPlayer,
  findOrg: byId.org,
  unit,
  seam,
  nextId,
  broadcast,
  notify,
  ledgerAppend,
  mailer,
  guardianManagedOnly,
  recordActivity,
  publishedVouchesFor,
  scoutViewsOf: (playerId) => safetyAudit.ledger.countForPlayer(playerId, 'view'),
  pathwayRecord,
  openTrialView,
  safeguardingCertified,
  moderateOrRefuse,
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
registerDeliverySettings({ app, playerRouter, guardianRouter, players, guardians, pushTokens, sessionFor });
const erasePlayer = createPlayerErasure({
  unit,
  afterCommit: store.afterCommit,
  seam,
  findPlayer,
  players,
  sessions,
  codes,
  mediaDeletions,
  uploads: operations.uploads,
  storage,
  removeUploadChunks,
  dataDir: DATA_DIR,
  broadcast,
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
registerDataRights({
  playerRouter,
  guardianRouter,
  findPlayer,
  erasePlayer,
  requestForRecipient,
  notificationFeed,
  insightsFor,
  ledgerView,
  requestsFor: (playerId) => recruitment.requests.forPlayer(playerId),
  threadsFor: (playerId) => channels.forPlayer(playerId).map((c) => channelViewFor(c, 'player')),
  ledgerFor: (playerId) => safetyAudit.ledger.forPlayer(playerId),
});

// -------------------------------------------------------- operator surface
registerCapabilities({
  app,
  rateLimit,
  providerStatus: () => boxCamDomain.providerStatus?.() ?? [],
  trustProxy: TRUST_PROXY,
  dataLayer,
  integrity,
  eventPayloadDrops,
  notifier,
  notificationPrefs,
  faultLayer,
});
assertProductionConfig({ trustWeightsTotal: trustDomain.trustWeightsTotal });

// The event registry must be internally consistent, and every event this process emits must be in it. Development and
// test throw here; in production the problems are logged and the fail-closed audience default keeps an unregistered
// event from reaching anyone. EMITTED_EVENTS is the list of names broadcast() is called with anywhere in the server;
// e2e/platform/contracts.mjs greps the source and fails if this list and the call sites disagree.
export const EMITTED_EVENTS = Object.freeze([
  'players',
  'orgs',
  'opportunities',
  'openTrials',
  'campaigns',
  'friendlies',
  'ledger',
  'messages',
  'typing',
  'inbox',
  'notify',
  'requests',
  'applications',
  'feedback',
  'evidence',
  'recruitment_case_moved',
  'assessment_submitted',
  'recruitment_room_archived',
  'recruitment_room_reopened_from_second_look',
  'player_development_evidence_changed',
  'watchlist_created',
  'watchlist_updated',
  'watchlist_membership_changed',
  'watchlist_archived',
  'matching_room_created',
  'development_plan_created',
  'development_plan_updated',
  'development_plan_completed',
  'development_goal_created',
  'development_goal_updated',
  'development_action_completed',
  'development_evidence_linked',
  'development_review_submitted',
  // Box Cam CV. All player_private, none analytics-eligible, and
  // deliberately no per-frame event — adding one would have to pass
  // through here and through the registry, which is the point.
  'box_cam_cv_session_started',
  'box_cam_cv_refused',
  'box_cam_observed',
  // Contact. All org_private, ids only. The recipient side reuses
  // `inbox` and `notify`; a draft reaches no player-facing stream at all.
  'contact_created',
  'contact_sent',
  'contact_failed',
  'contact_external_recorded',
  'contact_responded',
  // Trial. All org_private, ids only; the recipient side reuses
  // `inbox` and `notify`. No schedule, venue, attendance note, assessment or
  // guardian id ever rides on one of these.
  'trial_invited',
  'trial_accepted',
  'trial_declined',
  'trial_scheduled',
  'trial_rescheduled',
  'trial_cancelled',
  'trial_attendance_recorded',
  'trial_completed',
  'trial_evidence_linked',
  // ScoutBox Agent core. All org_private to the agency, ids only;
  // the client side reuses `notify`.
  'agent_profile_created',
  'agent_verification_state_changed',
  'agency_affiliation_created',
  'agency_affiliation_ended',
  'representation_requested',
  'representation_confirmed',
  'representation_rejected',
  'representation_terminated',
  'representation_disputed',
  // Conflict & Compliance Engine. org_private to the agency, ids
  // and state words only; the policy publication is a content-free ping.
  'regulatory_review_requested',
  'regulatory_review_started',
  'regulatory_review_resolved',
  'conflict_evaluated',
  'regulatory_consent_requested',
  'regulatory_consent_granted',
  'regulatory_consent_declined',
  'regulatory_consent_revoked',
  'agent_authorisation_state_changed',
  'policy_version_published',
  // Agent Transaction Workspace. org_private to the agency that holds
  // the workspace, ids and state words only; the club and the individual hear
  // through `notify`, where their own preferences apply.
  'agent_transaction_created',
  'agent_transaction_party_changed',
  'agent_transaction_compliance_updated',
  'agent_transaction_status_changed',
  'agent_transaction_document_added',
  'agent_transaction_message_linked',
  'agent_transaction_held',
  'agent_transaction_cancelled',
  'agent_transaction_closed',
  // Cross-app integration. Two names, both org_private to the agency
  // and both ids only: the client changed a disclosure choice (not WHICH one),
  // and a club routed a contact to the agent as well as to the client.
  'representation_disclosure_changed',
  'contact_agent_routed',
  'agent_opportunity_shared',
  // and the decision → transaction handoff, which is recruitment-domain because the
  // club's case is where it lives.
  'transaction_handoff_invited',
  'transaction_handoff_withdrawn',
  // Canonical Offer. All org_private to the club that owns the case,
  // ids only (plus the status WORD on a response). The recipient and a shared
  // agent hear through `notify`; a term, a note or a reason is never on the wire.
  'offer_draft_created',
  'offer_draft_updated',
  'offer_issued',
  'offer_superseded',
  'offer_withdrawn',
  'offer_responded',
  // Signing workflow. Org_private, ids plus a party type word; never a
  // document, a digest, a term or a signatory's name.
  'signing_created',
  'signing_ready',
  'signing_party_completed',
  'signing_completed',
  'signing_cancelled',
  'signing_voided',
  'signing_superseded',
  // Formal Room decisions.
  'room_decision_finalized',
  'room_decision_superseded',
]);
{
  const problems = assertEventRegistry({ emitted: EMITTED_EVENTS });
  for (const p of problems) console.error(`EVENT REGISTRY ${p}`);
  const unemitted = EVENT_NAMES.filter((n) => !EMITTED_EVENTS.includes(n));
  if (unemitted.length) console.warn(`event registry lists names the server never emits: ${unemitted.join(', ')}`);
}

registerAppHosting({ app, publicDir: path.join(HERE, 'public') });
installErrorContract(app);

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${players.count()} players, ${orgs.count()} orgs`);
});
