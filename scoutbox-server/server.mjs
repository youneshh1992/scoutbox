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
import { installHttpBaseline, registerAppHosting, installErrorContract } from './domains/platform/http.mjs';
import { createLiveSync } from './domains/platform/liveSync.mjs';
import { registerMeta, registerCapabilities, assertProductionConfig } from './domains/platform/operator.mjs';
import { createMedia, createMediaSigning } from './domains/media/index.mjs';
import {
  createAccountServices,
  createAccounts,
  createGuardianRecord,
  createOrgRecord,
  createPlayerRecord,
  createSessionEnds,
  createSessions,
  createStaffRecord,
} from './domains/identity/index.mjs';
import { createActivity, createDevelopment } from './domains/development/index.mjs';
import { vouchView } from './domains/verification/vouches.mjs';
import { createScoutingActs, createScouting } from './domains/scouting/index.mjs';
import { createOperations } from './domains/operations/index.mjs';
import { createIntegrations } from './domains/integrations/index.mjs';
import { createDelivery, createMessaging, createNotificationFeed } from './domains/messaging/index.mjs';
import { createInsight } from './domains/insight/index.mjs';
import { createGroups } from './domains/groups/index.mjs';
import { createCoachReferences, createVerification, createVouches } from './domains/verification/index.mjs';
import { createSafety, createSafetyConsole } from './domains/safety/index.mjs';
import { createPassport } from './domains/passport/index.mjs';
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
import { createDiscovery, createPlayerInsights } from './domains/discovery/index.mjs';
import { requestForRecipient } from './domains/recruitment/requests.mjs';
import {
  createCaseWorkflow,
  createRecruitment,
  createRecruitmentActs,
  createRooms,
} from './domains/recruitment/index.mjs';
import { createAgents } from './domains/agents/index.mjs';
import { ledgerView } from './domains/recruitment/ledger.mjs';
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
  uploadSessions,
  savedSearches,
  invoices,
  reputationSeed,
  deliveryBookkeeping,
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
const billing = createBilling({ invoices, nextId: (p) => nextId(p) });
const storage = createStorage(DATA_DIR);

const findPlayer = (id) => byId.player(id);
const isBlocked = (playerId, orgId) => safetyAudit.blocks.has(playerId, orgId);

// A domain writes another domain's records only through the owner's named acts, created here; every other domain gets
// the repositories' reads.
const playerRecord = createPlayerRecord({ players });
const guardianRecord = createGuardianRecord({ guardians });
const orgRecord = createOrgRecord({ orgs });
const staffRecord = createStaffRecord({ users });
const sessionEnds = createSessionEnds({ sessions });
const scoutingActs = createScoutingActs({ clubSetup, opportunitiesCampaigns, nextId });
const coachReferences = createCoachReferences({ transitionsVouches });
const recruitmentActs = createRecruitmentActs({ recruitment });

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
createMediaSigning({ app, byId, sessions: sessions.reads, mediaDeletions, storage, sessionFor, isBlocked });

// ---------------------------------------------------------------- live sync
const liveSync = createLiveSync({
  app,
  store,
  sessions: sessions.reads,
  byId,
  users: users.reads,
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

// Development shortcuts (seeded passwordless identities, credential-less org logins) exist for local work and tests
// only, and are refused in production.
const DEV_LOGINS = devLoginsEnabled();
installRateLimitInspection(app, rateLimit, { enabled: faultLayer.enabled });

// The preference gate exists before anything that notifies; its routes register with the other preference routes.
const notificationPrefs = createNotificationPrefs({ notifications });

registerMeta({ app, engine: store.engine, players: players.reads, orgs: orgs.reads, devLogins: DEV_LOGINS });

// ------------------------------------------------------------- accounts
// The session routes, the organisation, player and guardian routers, and the guardian and organisation accounts.
const { orgRouter, playerRouter, guardianRouter, guardianManagedOnly, orgSafe, safeguardingCertified, mfaGuards } =
  createAccounts({
    app,
    sessions,
    users,
    orgs,
    guardians,
    clubSetup: clubSetup.reads,
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
  recruitmentActs, // a safeguarding report suspends the player's pending requests
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
  recruitment: recruitment.reads,
  playerRecord, // the player's and guardian's notification preferences
  guardianRecord,
  pushTokens,
  byId,
  isBlocked,
  moderateOrRefuse,
  unit,
  nextId,
  broadcast,
  ledgerAppend,
});

const { recordActivity, refreshJourneyBadges } = createActivity({ players: players.reads, playerRecord, notify });
const { publishedVouchesFor, vouchesFor } = createVouches({ verificationReads });
const insightsFor = createPlayerInsights({ safetyAudit });

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
// Requests and trials with their trial day, the ledger and budgets: the writers of a request row and an accepted trial
// that the Contact, Trial and open-day flows and the Inbox's answers all go through.
const { issueRecruitmentRequest, issueAcceptedTrial, contactReplyFrom, canonicalContractFor } = createRecruitment({
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  playerRecord, // a trial-day check-in feeds the player's attendance record
  recordActivity,
  recruitment,
  recruitmentCases,
  recruitmentReads,
  signingsFollowUps,
  safetyAudit,
  invoices: invoices.reads,
  reputationSeed: reputationSeed.reads,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  safeguardingCertified,
  moderateOrRefuse,
  unit,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
});
// Development: the grassroots club and journey, the player's record, objectives, Box Cam and the Combine, the Hub.
const developmentDomain = createDevelopment({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  users: users.reads,
  orgs: orgs.reads,
  players: players.reads,
  playerRecord, // the player's record (programme, stats, media, medical, timeline) is written through the identity domain
  grassroots,
  clubSetup: clubSetup.reads,
  scoutingActs, // the grassroots squad and what the club is looking for are written through the scouting domain
  transitionsVouches: transitionsVouches.reads,
  coachReferences, // a coach reference is written through the verification domain
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
// Evidence and coach identity, assessments and video, opportunities and campaigns, suitability preferences, resumable
// uploads, and the post-signing follow-ups with their persistent sweep.
createScouting({
  byId,
  scoutingReads,
  verificationReads,
  players: players.reads,
  playerRecord,
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
  transitionsVouches: transitionsVouches.reads,
  coachReferences,
  findPlayer,
  moderateOrRefuse,
  development,
  recruitmentReads,
  users: users.reads,
  staffRecord, // removing a staff member
  joinSquad: scoutingActs.joinSquad,
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
  playerRecord, // an upload adds the clip to the player's media
  uploadSessions,
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
const { followUpSweep } = createOperations({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  users: users.reads,
  orgs: orgs.reads,
  players: players.reads,
  playerRecord,
  recruitment: recruitment.reads,
  recruitmentActs, // the follow-up sweep escalates and marks a trial's reminders through the recruitment domain
  signingsFollowUps,
  opportunitiesCampaigns: opportunitiesCampaigns.reads,
  scoutingActs, // an unanswered application's reminder is marked through the scouting domain
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
// Imports, API keys and webhooks; the delivery centre; onboarding, MFA, SSO, audit and backup; verification and
// transition cases; exposure and evidence-gap insight; fixture coverage; federation groups.
const { emitWebhook, webhookSweep } = createIntegrations({
  app,
  orgRouter,
  adminRouter,
  integrations,
  players: players.reads,
  playerRecord, // a claimed import adds the player's external id
  safetyAudit,
  byId,
  findPlayer,
  isBlocked,
  unit,
  nextId,
});
// The delivery centre retries the webhooks on its own timer.
const { notifyAction, deliverySweep, injectedFailures } = createDelivery({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  notifications,
  dispatches,
  outbox,
  deliveryBookkeeping,
  safetyAudit,
  staffRecord, // a staff member's delivery preferences
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
  users: users.reads,
  staffRecord, // invitations, MFA and the SSO link
  orgs: orgs.reads,
  orgRecord, // the lead MFA policy
  players: players.reads,
  sessions: sessions.reads,
  sessionEnds, // ending one's own session
  codes,
  channels,
  notifications,
  dispatches,
  outbox,
  pushLog,
  pushTokens,
  mediaDeletions,
  recruitment: recruitment.reads,
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
// Verification: the club checks, transition cases and claims (independent claims, org-administered attestation,
// Trust & Safety review, licences, disputes, references).
const verificationDomain = createVerification({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  users: users.reads,
  staffRecord, // a verified applicant's staff account
  orgs: orgs.reads,
  orgRecord, // an organisation's verification standing
  players: players.reads,
  playerRecord, // a transition case sets the player's level
  codes,
  scoutingActs, // the federation-route request
  verification,
  transitionsVouches,
  development,
  scoutingReads,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  storage,
  mailer,
  unit,
  seam,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
  notifyAction,
  emitWebhook,
});
const insightDomain = createInsight({
  orgRouter,
  playerRouter,
  insightCoverage,
  recruitmentReads,
  scoutingReads,
  safetyReads,
  players: players.reads,
  byId,
  findPlayer,
  isBlocked,
  playerViewForOrg,
  unit,
  nextId,
  notify,
});
createGroups({
  orgRouter,
  adminRouter,
  groups,
  groupReads,
  recruitmentReads,
  scoutingReads,
  safetyReads,
  byId,
  users: users.reads,
  findPlayer,
  isBlocked,
  unit,
  nextId,
  notify,
});
const tick = () => {
  verificationDomain.transitionSweep();
  insightDomain.insightSweep();
};
tick();
setInterval(tick, SWEEP_MS).unref();

// ------------------------------------------------- the Trust & Safety console
createSafetyConsole({
  adminRouter,
  dataLayerReport: (opts) => dataLayer.report(opts),
  storeEngine: store.engine,
  unit,
  notify,
  broadcast,
  mailer,
  players: players.reads,
  guardians: guardians.reads,
  orgs: orgs.reads,
  orgRecord, // suspension, standing and the provisioned password
  sessions: sessions.reads,
  channels,
  safetyAudit,
  signingsFollowUps,
  invoices: invoices.reads,
  outbox,
  pushLog,
  transitionsVouches: transitionsVouches.reads,
  coachReferences, // revoking a coach reference
  verificationReads,
  byId,
  orgSafe,
  safeguardingCertified,
  channelViewFor,
  vouchView,
  syncLegacyOrgVerification: verificationDomain.syncLegacyOrgVerification,
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

// The Football Passport and the Trust Score: projections over the records of the domains above, each read through its
// own gate. They add no authorization surface: a Passport or a Trust Score grants nothing.
const passportDomain = createPassport({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  players: players.reads,
  passport,
  development,
  scoutingReads,
  verificationReads,
  agentReads,
  developmentReads,
  boxCamReads,
  recruitmentReads,
  byId,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerViewForOrg,
  recordSourceChange: sourceChanges.recordSourceChange,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
  unit,
  nextId,
  notify,
  ledgerAppend,
});

// Recruitment Rooms: the club's private decision layer over one player, composed from every layer beneath it, and the
// recruitment analytics over them.
const roomsDomain = createRooms({
  orgRouter,
  adminRouter,
  users: users.reads,
  players: players.reads,
  recruitmentCases,
  recruitmentReads,
  scoutingReads,
  boxCamReads,
  insightReads,
  discoveryReads,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  faults: faultLayer, // the development fault seam inside the one lifecycle writer
  moderateOrRefuse,
  playerViewForOrg,
  assemblePassport: passportDomain.assemblePassport,
  buildFootballPassport: passportDomain.buildFootballPassport,
  passportRevisionOf: passportDomain.passportRevisionOf, // the Passport content revision decision snapshots record
  buildTrustProfile: passportDomain.buildTrustProfile,
  safeTrustProjection: passportDomain.safeTrustProjection,
  trustSnapshotOf: passportDomain.trustSnapshotOf,
  combineProjection: developmentDomain.combineProjection,
  combineRequestView: developmentDomain.combineRequestView,
  combineProtocolActive: developmentDomain.combineProtocolActive,
  combineOrgMaySeeResults: developmentDomain.combineOrgMaySeeResults,
  createCombineRequests: developmentDomain.createCombineRequests,
  boxPrefsFor: developmentDomain.boxPrefsFor,
  requestEvidenceGap: insightDomain.requestEvidenceGap,
  computeEvidenceGaps: insightDomain.computeEvidenceGaps,
  unit,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
});
const { recruitmentEvidence } = roomsDomain;

// Discovery: search, the Film Room, saved searches, Second Look, Nobody Missed and Explainable Matching. It never
// mutates the pipeline itself: a Room is created or reopened through the Rooms' own seams.
const { checkSavedSearches, matchFactsKeeper } = createDiscovery({
  orgRouter,
  players: players.reads,
  playerRecord, // the Film Room's views and tags on a clip
  recruitment: recruitment.reads,
  recruitmentActs, // a trial report reminder is marked sent through the recruitment domain
  discovery,
  discoveryReads,
  matchFacts,
  savedSearches,
  notifications,
  safetyAudit,
  scoutingReads,
  verificationReads,
  agentReads,
  boxCamReads,
  insightReads,
  recruitmentReads,
  sqlite: store.sqlite,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  playerViewForOrg,
  combineProtocolIds: () => COMBINE_PROTOCOLS.map((p) => p.id), // a brief's Combine protocols are refused unless known
  assemblePassport: passportDomain.assemblePassport,
  buildTrustProfile: passportDomain.buildTrustProfile,
  safeTrustProjection: passportDomain.safeTrustProjection,
  trustSummaryFor: passportDomain.trustSummaryFor,
  trustPolicyVersion: TRUST_SCORE_POLICY_VERSION,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
  combineProjection: developmentDomain.combineProjection,
  reopenRoom: roomsDomain.reopenRoom,
  createRoomForPlayer: roomsDomain.createRoomForPlayer,
  sourceChangesFor: sourceChanges.sourceChangesFor, // the canonical source-change clocks (position, current club)
  unit,
  nextId,
  notify,
  broadcast,
  ledgerAppend,
});
matchFactsKeeper.start();
setInterval(() => {
  try {
    matchFactsKeeper.sweep();
  } catch (err) {
    console.error(`match facts sweep failed: ${err?.message ?? err}`);
  }
}, 60_000).unref();

// ------------------------------------------------------ Agent workspace
// Agency access, the Conflict & Compliance Engine (per-reviewer Trust & Safety identity, the versioned jurisdiction
// policies, the consent ledger, manual review and the minors gate, re-authorising every regulated act when it
// happens), the cross-app integration seam, the transaction workspace and the agent core.
const agentsDomain = createAgents({
  app,
  orgRouter,
  playerRouter,
  adminRouter,
  users: users.reads,
  staffRecord, // an agency's team members
  players: players.reads,
  sessionEnds, // a revoked reviewer's sessions
  channels, // a linked thread's own authorisation
  notifications, // the agent inbox and its unread count
  agentCore,
  agentTransactions,
  compliancePolicies,
  complianceRecords,
  caseHandoffs: roomsDomain.caseHandoffs, // the transaction handoff is an act of its case
  agentReads,
  verificationReads,
  scoutingReads,
  grassrootsReads,
  recruitmentReads,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  sessionFor,
  createSession,
  hashPassword,
  verifyPassword,
  devLogins: DEV_LOGINS,
  moderateOrRefuse,
  playerViewForOrg,
  orgSafe,
  revokeOrgUserAccess,
  findRoomForRequest: roomsDomain.findRoomForRequest,
  verificationSynthetic: process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1',
  unit,
  nextId,
  notify,
  broadcast,
});

// ------------------------------------------------------ case work
// The lifecycle, signings, Offers, the journeys and the Inbox: every status move goes through the one evidence
// provider and the Rooms' one status writer.
const caseWorkflow = createCaseWorkflow({
  app,
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  users: users.reads,
  guardians: guardians.reads,
  playerRecord, // a completion writes the player's level, contract status and timeline through the identity domain
  joinSquad: scoutingActs.joinSquad, // a grassroots signing adds the squad row through the scouting domain
  injectedFailures, // an injected transport failure is used up through the delivery centre
  recruitment,
  recruitmentCases,
  recruitmentContactsOffers,
  signingsFollowUps,
  notifications,
  safetyReads,
  scoutingReads,
  verificationReads,
  agentReads,
  boxCamReads,
  recruitmentReads,
  byId,
  findPlayer,
  isBlocked,
  rateLimit,
  faults: faultLayer,
  storage,
  mailer,
  billing,
  guardianManagedOnly,
  moderateOrRefuse,
  safeTrustProjection: passportDomain.safeTrustProjection,
  // A trial is not consent to a player's home footage: the Combine consent rule and the Box Cam test-provider gate are
  // reused unchanged for evidence links.
  combineOrgMaySeeResults: developmentDomain.combineOrgMaySeeResults,
  boxPrefsFor: developmentDomain.boxPrefsFor,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
  refreshJourneyBadges,
  recruitmentEvidenceProvider: recruitmentEvidence,
  findRoomForRequest: roomsDomain.findRoomForRequest,
  applyLifecycleTransition: roomsDomain.applyLifecycleTransition,
  roomIsRoom: roomsDomain.roomIsRoom,
  captureRoomSnapshot: roomsDomain.captureRoomSnapshot,
  issueRecruitmentRequest,
  issueAcceptedTrial,
  contactReplyFrom,
  openChannel,
  access: agentsDomain.access,
  integration: agentsDomain.integration,
  offerReadinessFor: agentsDomain.offerReadinessFor,
  evidence: { storeFile: verificationDomain.storeEvidenceFile, add: verificationDomain.addEvidence },
  unit,
  afterCommit: (fn) => store.afterCommit(fn),
  nextId,
  notify,
  broadcast,
  ledgerAppend,
});
const notificationFeed = createNotificationFeed({
  orgRouter,
  playerRouter,
  guardianRouter,
  notifications,
  notifier,
  notificationTargetFor: caseWorkflow.notificationTargetFor,
});

// ------------------------------------------------------ players and children
// Registered last: the export reads the notification feed, and the erasure reaches every domain that holds a player.
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
  uploads: uploadSessions,
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
    ...agentsDomain.onPlayerDeleted,
    ...caseWorkflow.onPlayerDeleted,
    // Every thread of the player, guardian–club threads included (D-B, docs/decisions.md).
    (id) => channels.deleteForPlayer(id),
    (id) => notifications.deleteForAudience('player', id), // the preferences are kept, by decision
  ],
});

// ---------------------------------------------------------------- sweeps
// Each domain's minute sweep, which it returned rather than started. A domain's boot pass ran when it was created.
const FAST_SWEEPS = process.env.SCOUTBOX_FAST_SWEEPS === '1';
setInterval(deliverySweep, FAST_SWEEPS ? 400 : 60_000).unref();
setInterval(verificationDomain.verificationSweep, SWEEP_MS).unref();
setInterval(agentsDomain.agentSweep, SWEEP_MS).unref();
setInterval(followUpSweep, 60_000).unref();

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
assertProductionConfig({ trustWeightsTotal: passportDomain.trustWeightsTotal });

// The event registry must be internally consistent. Development and test throw here; in production the problems are
// logged. Every broadcast is checked against it when it is sent (liveSync.mjs), and an unregistered one fails closed.
for (const p of assertEventRegistry()) console.error(`EVENT REGISTRY ${p}`);

registerAppHosting({ app, publicDir: path.join(HERE, 'public') });
installErrorContract(app);

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${players.count()} players, ${orgs.count()} orgs`);
});
