// ScoutBox sync backend.
// Every deck rule is enforced HERE, not in the frontends — the product's
// claims depend on the API refusing, not the UI hiding.

import express from 'express';
import { installAsyncErrorForwarding } from './domains/platform/asyncErrors.mjs';
// A rejected async handler answers 500 instead of ending the process.
installAsyncErrorForwarding();

import { optText, reqText, badField, dateOnlyOrRefuse } from './domains/platform/input.mjs';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.mjs';
import { openStore } from './store.mjs';
import { attachDataLayer } from './repositories/index.mjs';
import { STAFF_LIMITS } from './repositories/users.mjs';
import { createIdCounter } from './repositories/counters.mjs';
import { GRASSROOTS_LIMITS, boxAround } from './repositories/grassroots.mjs';
import { CLUB_SETUP_LIMITS, LOOKING_FOR_POSITIONS } from './repositories/clubSetup.mjs';
import { TRANSITION_LIMITS } from './repositories/transitionsVouches.mjs';
import { registerM12 } from './m12/index.mjs';
import { registerM13 } from './m13/index.mjs';
import { registerVerificationClaims } from './domains/verification/claims/index.mjs';
import { createAdminRouter, registerReporting, registerSafetyConsole } from './domains/safety/safety.mjs';
import { registerM15 } from './domains/verification/passport/index.mjs';
import { registerM16 } from './domains/development/boxcam/index.mjs';
import { registerM162 } from './domains/verification/trust/index.mjs';
import { registerM17 } from './domains/recruitment/rooms/index.mjs';
import { registerM18 } from './domains/discovery/index.mjs';
import { registerMatching } from './domains/discovery/matching/index.mjs';
import { registerSavedSearches } from './domains/discovery/savedSearches.mjs';
import { removeUploadChunks } from './domains/media/uploads.mjs';
import { registerAnalytics } from './m20/index.mjs';
import { registerDevelopment } from './domains/development/hub/index.mjs';
import { registerLifecycle } from './domains/recruitment/lifecycle/index.mjs';
import { createAgentAccess } from './domains/agents/access.mjs';
import { registerAgent } from './domains/agents/core/index.mjs';
import { registerCompliance } from './domains/agents/compliance/index.mjs';
import { registerTransactions } from './domains/agents/transactions/index.mjs';
import { registerIntegration } from './m27/index.mjs';
import { registerOffers } from './domains/recruitment/offers/index.mjs';
import { registerSigning } from './domains/recruitment/signings/index.mjs';
import { registerJourneyRoutes } from './domains/recruitment/lifecycle/journeyRoutes.mjs';
import { createVerificationProvider } from './domains/agents/compliance/provider.mjs';
import { createEvidenceProvider } from './domains/recruitment/lifecycle/evidence.mjs';
import { COMBINE_PROTOCOLS } from './domains/development/boxcam/combineShared.mjs';
import { registerSourceChanges } from './domains/platform/sourceChanges.mjs';
import { audienceFor } from './domains/platform/eventAudience.mjs';
import { createRateLimiter, rateLimitedBody, RATE_LIMIT_POLICY } from './domains/platform/rateLimit.mjs';
import { buildCapabilityReport, demoSeedEnabled, devLoginsEnabled, productionConfigProblems } from './domains/platform/capabilities.mjs';
import { isLeadRole } from './roles.mjs';
import { parseTrustProxy } from './httpTrust.mjs';
import { minimizePayload, assertEventRegistry, EVENT_NAMES } from './domains/platform/eventRegistry.mjs';
import { createNotificationPrefs, registerNotificationPrefs } from './domains/platform/notificationPrefs.mjs';
import { createNotifier, registerNotificationFeed, registerDeliverySettings } from './domains/messaging/notify.mjs';
import { registerMessaging, channelViewFor } from './domains/messaging/channels.mjs';
import { registerAudit } from './domains/platform/audit.mjs';
import { createFaultLayer } from './domains/platform/faults.mjs';
import { httpContractMiddleware } from './domains/platform/httpContract.mjs';
import { integrityReport, integritySummary } from './domains/platform/integrity.mjs';
import { orgPlayerView } from './views/playerViews.mjs';
import { registerGuardianAccount, registerGuardianIdReview } from './domains/identity/guardians.mjs';
import { createPlayerSession, registerPlayerAccount } from './domains/identity/players.mjs';
import { registerChildren } from './domains/identity/children.mjs';
import { createPlayerErasure, registerDataRights } from './domains/identity/dataRights.mjs';
import { DRILLS, registerPlayerRecord } from './domains/development/record.mjs';
import { registerGrassrootsJourney } from './domains/development/grassroots.mjs';
import { registerRequestInbox } from './domains/recruitment/inbox.mjs';
import { validateContactReply } from './domains/recruitment/lifecycle/contact.mjs';
import { icsLocal as trialIcsLocal, icsText as trialIcsText } from './domains/recruitment/lifecycle/trial.mjs';
import { requestInstrumentation } from './domains/enterprise/enterprise.mjs';
import { totpValid } from './m13/shared.mjs';
import { earnedGrassrootsBadges } from './grassrootsJourney.mjs';
import {
  hashPassword,
  verifyPassword,
  newToken,
  makeRateLimiter,
  createMailer,
  createPushSender,
  createIdvProvider,
  createBilling,
  createStorage,
} from './adapters.mjs';
import {
  ageOn,
  isAdult,
  visibleToOrg,
  computeTrustScore,
  trustBreakdown,
  validateTrialReport,
  TRIAL_REPORT_FIELDS,
  parseTrialDate,
  trialReportDueAt,
  validateTrialDetails,
  chooseTrialSlot,
  similarityScore,
  moderateText,
  haversineKm,
  GRASSROOTS_RADIUS_KM,
  computeStreak,
} from './domain.mjs';
import { readInstant, utcDayOf } from './temporal.mjs';
import { readPage, sendPageError } from './domains/platform/paging.mjs';
import { AUDIT_LIMITS } from './repositories/safetyAudit.mjs';
import { PLANS, ARCHETYPES } from './catalogue.mjs';

import { invoiceView } from './adapters.mjs';
import { createLookups } from './domains/platform/lookups.mjs';
import { createMatchFactsKeeper } from './domains/discovery/matchFacts.mjs';

const PORT = process.env.PORT || 4000;

// ------------------------------------------------------------- persistence
// One SQLite file, data/scoutbox.db (store.mjs). DATA_DIR override keeps destructive tests on isolated throwaway
// databases. Every write is a repository operation that commits at once (or with its unit of work).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const store = openStore(DATA_DIR);

// Every write has committed by the time a handler returns (units of work are synchronous), so a shutdown only closes
// the connection: the WAL is checkpointed and the exit code stays 0.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { store.sqlite.close(); } catch { /* already closed */ } process.exit(0); });
}

// The data layer (repositories/): the table migrations, then every domain's repository. A first installation imports
// the seed's organisations, players and guardians once. The id generator is passed lazily: it needs the counters table.
const dataLayer = attachDataLayer({
  seed: buildSeed({ demo: demoSeedEnabled() }), store,
  nextId: (prefix) => nextId(prefix),
  sessionTtlMs: (Number(process.env.SESSION_TTL_DAYS) > 0 ? Number(process.env.SESSION_TTL_DAYS) : 30) * 24 * 3600 * 1000,
  log: (m) => { if (process.env.M13_QUIET_LOGS !== '1') console.log(m); },
});
const { users, sessions, orgs, players, guardians, identity, mediaDeletions, codes, notifications, dispatches, outbox, pushLog, pushTokens, channels, safetyAudit, recruitment, recruitmentCases, recruitmentContactsOffers, signingsFollowUps, scoutingEvidence, scoutingAssessments, clubSetup, opportunitiesCampaigns, verification, passport, transitionsVouches, agentCore, compliancePolicies, complianceRecords, agentTransactions, development, boxCam, discovery, insightCoverage, integrations, enterprise, groups, grassroots, operations, matchFacts } = dataLayer;
// A record the caller may use, or null: `onlyIf(repo.byId(id), (r) => r.orgId === orgId)`.
const onlyIf = (record, ok) => (record && ok(record) ? record : null);
// Each domain's read-only query objects (`<domain>Reads`), handed to every module context.
const safetyReads = safetyAudit.reads;
const recruitmentReads = Object.freeze({ ...recruitmentContactsOffers.reads, ...signingsFollowUps.reads, ...recruitment.reads, ...recruitmentCases.reads });
const scoutingReads = Object.freeze({ ...scoutingEvidence.reads, ...scoutingAssessments.reads, ...clubSetup.reads, ...opportunitiesCampaigns.reads });
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
// Lookups by id through the repositories' indexes, never a scan: handed to
// every module context as `byId` (`byId.player(id)`, `byId.org(id)`, …; null when there is none).
const byId = createLookups({ players, guardians, users, orgs });
if (dataLayer.boot.identity.imported) console.log(`data layer: ${dataLayer.boot.identity.players} player(s) and ${dataLayer.boot.identity.guardians} guardian(s) initialised from the first installation's records`);

/**
 * One UNIT OF WORK (store.unitOfWork): every repository row write inside `work`
 * commits or rolls back together; a side effect registered with store.afterCommit
 * runs only after COMMIT. `work` must be synchronous — prepare asynchronous things
 * before, publish after.
 */
// Development-only failure seams inside units of work (the fault layer's
// `internal:<step>` rules; the layer is created further down and cannot exist in
// production, so until then — and in production — no seam ever fires).
const seams = { shouldFail: () => false };
function unit(work) {
  return store.unitOfWork(() => {
    const result = work();
    // `internal:unit.sqlite_commit`: the REAL COMMIT of this unit fails (store.failCommitOfOpenTransaction).
    if (seams.shouldFail('unit.sqlite_commit')) store.failCommitOfOpenTransaction();
    return result;
  });
}
/** A named seam inside a unit: throws when a development fault rule names it, so the rollback path is proven with a real failure after a real write. */
function seam(step) {
  if (seams.shouldFail(step)) throw new Error(`simulated failure at ${step} (development fault layer)`);
}
// Integrity is reported at boot, never repaired. A violation is
// logged as codes and ids (no names) and counted on /capabilities; the
// process still starts, because a running server that says "two open Rooms
// for one player" is more useful than a dead one that says nothing.
const integrityCases = recruitmentCases.cases.withRoom();
// The players the Rooms name that still exist (ids are the table's primary key, so they cannot repeat).
const integrity = integrityReport({ players: [...new Set(integrityCases.map((c) => c.playerId))].filter((id) => players.exists(id)).map((id) => ({ id })), orgs: orgs.list() }, { cases: integrityCases });
for (const v of integrity.violations) console.error(`INTEGRITY ${v.code} key=${v.key} ids=${v.ids.join(',')}`);
if (integrity.violations.length) console.error(`INTEGRITY ${integrity.violations.length} violation(s) in the database — nothing was repaired.`);

// ---------------------------------------------------- production adapters
// The mail, push and invoice records go through their repositories; the provider calls happen here.
const mailer = createMailer((p) => nextId(p), { outbox });
const pushSender = createPushSender((p) => nextId(p), { pushLog, pushTokens });
const idv = createIdvProvider();
const billing = createBilling({ invoices: operations.invoices, nextId: (p) => nextId(p) });
const storage = createStorage(DATA_DIR);

// Media bytes live on object storage (local disk in dev); the database keeps only ids and /media/:id streams them.
// Media files whose removal was committed but not completed (a crash between
// COMMIT and the unlink, a storage error): retried at boot and every minute.
mediaDeletions.process(storage);
setInterval(() => { try { mediaDeletions.process(storage); } catch (err) { console.error(`media deletions sweep failed: ${err?.message ?? err}`); } }, 60_000).unref();

// A first installation gets the demo players' sample clips.
if (dataLayer.firstInstallation) {
  const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
  const SAMPLE_CLIPS = [
    { file: 'clip-sprint.webm', playerId: 'pl-adeyemi', title: 'Sprint & finishing session', verify: true },
    { file: 'clip-passing.webm', playerId: 'pl-carvalho', title: 'Passing range compilation', verify: true },
    { file: 'clip-wingplay.webm', playerId: 'pl-guni', title: 'U15 highlights — wing play', verify: true },
  ];
  for (const sample of SAMPLE_CLIPS) {
    try {
      const data = fs.readFileSync(path.join(ASSETS_DIR, sample.file));
      const player = byId.player(sample.playerId);
      const media = player?.media.find((m) => m.title === sample.title);
      if (!media) continue;
      storage.saveDataUrl(media.id, `data:video/webm;base64,${data.toString('base64')}`);
      players.patchItem(player.id, 'media', { id: media.id }, { url: `/media/${media.id}`, ...(sample.verify && player.attendance[0] ? { verifiedClip: player.attendance[0].id } : {}) });
    } catch {
      // assets optional — Film Room just starts empty without them
    }
  }
}

const app = express();

// Reverse-proxy trust is explicit and per deployment (see httpTrust.mjs).
// Without it a server behind a platform proxy keys every per-IP limit on the
// proxy's own address; with it set carelessly a direct client could pick its
// own. The parsed setting is reported in /capabilities and an invalid value
// refuses to boot in production.
const TRUST_PROXY = parseTrustProxy(process.env.SCOUTBOX_TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY.setting);

// CORS is an allowlist, not a wildcard.
//
// ScoutBox authenticates with bearer tokens rather than cookies, so a wildcard
// would not be an open door on its own, but "no origin policy at all" is not
// something a deployment should have to discover by reading the source.
// SCOUTBOX_ALLOWED_ORIGINS is a comma-separated list; with nothing set,
// development stays permissive and says so in the capability report rather than silently locking a developer out
// of their own machine.
const ALLOWED_ORIGINS = String(process.env.SCOUTBOX_ALLOWED_ORIGINS ?? '')
  .split(',').map((o) => o.trim()).filter(Boolean);
// Headers a browser client is allowed to READ. Retry-After lets the
// client honour a 429 instead of guessing; the request id lets a person quote
// one when something goes wrong; the ordering header states how a list was
// sorted. None of them is readable cross-origin unless exposed here.
const EXPOSED_HEADERS = ['Retry-After', 'X-Request-Id', 'X-ScoutBox-Ordering', 'X-ScoutBox-Schema'];
app.use(cors(ALLOWED_ORIGINS.length
  ? {
      exposedHeaders: EXPOSED_HEADERS,
      origin: (origin, cb) => {
        // A same-origin or non-browser caller sends no Origin header at all.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    }
  : { exposedHeaders: EXPOSED_HEADERS }));

// Baseline response headers. Nothing here replaces the authorization checks —
// these only stop a browser from doing something helpful with our responses.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cross-Origin-Resource-Policy', 'same-site');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  next();
});

// 20 MB because media still travels as data URLs on the upload path. The limit
// is stated here rather than left to the default so it is a decision, not an
// accident.
// The HTTP contract wraps res.json BEFORE the body parser, so a
// malformed-body 400 carries the same retry/schema headers as every other error.
app.use(httpContractMiddleware({ ratePolicy: RATE_LIMIT_POLICY, schemaVersion: () => dataLayer.schemaVersion() }));
app.use(express.json({ limit: '20mb' }));
// The HTTP contract headers (Retry-After on 429, retryability on every
// error, the schema version on every response) and the development-only
// fault layer. The fault layer refuses to exist in production; installing it
// there is a no-op middleware and no /__faults route.
const faultLayer = createFaultLayer();
faultLayer.install(app);
seams.shouldFail = (step) => faultLayer.shouldFail(step); // always false in production (the layer is disabled there)
// Correlation ids, structured request logs (redacted), request metrics,
// and the exposure-capture hook. Installed before every route on purpose.
app.use(requestInstrumentation());

// ------------------------------------------------------------ signed media
// Media is not public: every /media path that leaves the API is rewritten to
// a short-lived HMAC-signed URL at the moment the (already authorisation-
// checked) response is serialised. The URL itself is the capability — a
// caller only ever holds links to media it was allowed to see. Direct
// bearer-authenticated fetches are also accepted, re-checked against the
// owning player's visibility.
//
// The key comes from MEDIA_SECRET only; production refuses to boot without it
// (productionConfigProblems). In development an unset key is a fresh random
// one per process, never stored: links minted before a restart stop verifying,
// and clients re-mint them on their next fetch.
const MEDIA_SIGN_SECRET = process.env.MEDIA_SECRET || crypto.randomBytes(32).toString('base64url');
// Short-lived on purpose: clients refetch constantly (SSE ticks), so links are
// re-minted long before expiry. Possession of a URL is NOT authority — the
// signature binds the URL to the minting session, and the serve route
// re-checks that session's CURRENT entitlement (blocks, suspension, radius,
// level, guardianship) on every fetch. An HMAC alone never stands in for the
// viewer's live permissions.
const MEDIA_URL_TTL_MS = 15 * 60 * 1000;

function mediaSig(id, exp, sid) {
  return crypto.createHmac('sha256', MEDIA_SIGN_SECRET).update(`${id}.${exp}.${sid}`).digest('base64url').slice(0, 24);
}

function signMediaPath(pathStr, sid) {
  const m = /^\/media\/([A-Za-z0-9-]+)$/.exec(pathStr);
  if (!m || !sid) return pathStr; // unauthenticated response: path stays bare
  const exp = Date.now() + MEDIA_URL_TTL_MS;
  return `/media/${m[1]}?e=${exp}&s=${mediaSig(m[1], exp, sid)}&v=${sid}`;
}

// Copy-on-write deep walk: never mutates the objects behind a response.
function signMediaDeep(value, sid) {
  if (typeof value === 'string') return value.startsWith('/media/') ? signMediaPath(value, sid) : value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const signed = signMediaDeep(value[i], sid);
      if (signed !== value[i]) { out ??= value.slice(); out[i] = signed; }
    }
    return out ?? value;
  }
  if (value && typeof value === 'object') {
    let out = null;
    for (const key of Object.keys(value)) {
      const signed = signMediaDeep(value[key], sid);
      if (signed !== value[key]) { out ??= { ...value }; out[key] = signed; }
    }
    return out ?? value;
  }
  return value;
}

app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(signMediaDeep(body, sessionFor(req)?.sid ?? null));
  next();
});

// ---------------------------------------------------------------- live sync
// Authenticated, scoped SSE. EventSource cannot send headers and long-lived
// bearer tokens never belong in URLs, so a client first mints a short-lived
// connect ticket over its bearer session (POST /events/ticket), then opens
// GET /events?ticket=…. Every event carries an id; on reconnect the client
// passes the last id it saw and missed events replay from a ring buffer, so
// a dropped connection catches up instead of going quiet.
const sseClients = new Set(); // { res, identity }
const sseTickets = new Map(); // ticket -> { token, expiresAt }
const SSE_TICKET_TTL_MS = 10 * 60 * 1000;
let eventSeq = 0;
const eventLog = []; // ring buffer of { id, event, payload, ts }
const EVENT_LOG_CAP = 500;

function sseIdentityFor(session) {
  if (!session) return null;
  if (session.kind === 'org') {
    const org = byId.org(session.refId);
    return org && !org.suspended ? { kind: 'org', orgId: org.id, userId: session.userId } : null;
  }
  if (session.kind === 'player') {
    const p = findPlayer(session.refId);
    return p ? { kind: 'player', playerId: p.id } : null;
  }
  if (session.kind === 'guardian') {
    const g = byId.guardian(session.refId);
    return g ? { kind: 'guardian', guardianId: g.id } : null;
  }
  return null;
}

// Authorisation happens at DELIVERY time, from live records — an identity
// captured at connect never grandfathers a suspended org or a lifted
// entitlement into continuing to receive events.
function liveOrg(identity) {
  const org = byId.org(identity.orgId);
  return org && !org.suspended ? org : null;
}

// Scoped delivery: channel and player events reach only the parties entitled
// to them. Catalogue events without a payload (orgs, open days, friendlies,
// bare refresh pings) carry no data and go to every authenticated stream —
// the refetch they trigger is itself authorisation-checked.
function shouldDeliver(identity, event, payload) {
  // Live standing check first: a suspended or deleted org's open stream goes
  // silent immediately, catalogue pings included.
  const org = identity.kind === 'org' ? liveOrg(identity) : null;
  if (identity.kind === 'org' && !org) return false;
  if (identity.kind === 'org' && identity.userId) {
    // Staff removal takes effect on open streams too, not just reconnects.
    const u = byId.user(identity.userId);
    if (!u || u.removedAt) return false;
  }
  if (event === 'typing' || event === 'messages') {
    const channel = channels.parties(payload.channelId);
    if (!channel) return false;
    if (identity.kind === 'org') return channel.orgId === org.id;
    if (identity.kind === 'player') return channel.playerId === identity.playerId && channel.counterparty === 'player';
    if (identity.kind === 'guardian') return channel.guardianId === identity.guardianId;
    return false;
  }
  if (event === 'notify') {
    if (identity.kind === 'org') return payload.audienceKind === 'org_user' && users.byId(payload.audienceId)?.orgId === org.id;
    if (identity.kind === 'player') return payload.audienceKind === 'player' && payload.audienceId === identity.playerId;
    if (identity.kind === 'guardian') return payload.audienceKind === 'guardian' && payload.audienceId === identity.guardianId;
    return false;
  }
  // An event carrying an orgId is ORGANISATION-PRIVATE: it describes something
  // inside one club's workspace. It goes to that club's own streams and to
  // nobody else — not the player it names, not their guardian, not a rival
  // club that happens to be able to see the player. This is checked BEFORE the
  // playerId rule below, which would otherwise deliver it to the subject.
  if (payload.orgId) {
    return identity.kind === 'org' && org.id === payload.orgId;
  }
  if (payload.playerId) {
    const p = findPlayer(payload.playerId);
    if (!p) return false;
    if (identity.kind === 'player') return p.id === identity.playerId;
    if (identity.kind === 'guardian') return p.guardianId === identity.guardianId;
    return visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  }
  // Nothing falls through to "deliver to everyone": a default of true here
  // would let the NEXT event with a new payload shape inherit broadcast-to-all.
  // The audience is declared per event name, and an unclassified name fails
  // closed to org_private.
  switch (audienceFor(event)) {
    // Catalogue pings: no personal data in the payload, and the refetch on the
    // other side re-applies every gate.
    case 'public_safe': return true;
    case 'trust_safety_only': return identity.kind === 'admin';
    case 'player_private': return identity.kind === 'player' || identity.kind === 'guardian';
    case 'guardian_private': return identity.kind === 'guardian';
    case 'org_member': return identity.kind === 'org';
    case 'org_private':
    default:
      // An organisation-private event that did not name its organisation is a
      // classification bug, not a licence to deliver it. Nobody gets it.
      return false;
  }
}

function sseFrame(row) {
  return `id: ${row.id}\ndata: ${JSON.stringify({ event: row.event, ...row.payload, ts: row.ts })}\n\n`;
}

// Payloads that the registry did not allow, counted for /capabilities.
const eventPayloadDrops = { count: 0, lastEvent: null };

function broadcast(event, rawPayload = {}) {
  // The registry is the only authority on what an event may carry. A
  // key it does not list is stripped before anything is written to a stream
  // or the replay log — and in development it throws, because a new key on a
  // live event is a privacy decision somebody has to make on purpose, not one
  // that ships because a call site happened to spread an object.
  const { payload, dropped, unregistered } = minimizePayload(event, rawPayload);
  if (unregistered || dropped.length) {
    eventPayloadDrops.count += 1;
    eventPayloadDrops.lastEvent = event;
    const msg = unregistered
      ? `broadcast('${event}') is not in the event registry`
      : `broadcast('${event}') carried unregistered payload keys: ${dropped.join(', ')}`;
    if ((process.env.NODE_ENV ?? 'development') !== 'production') throw new Error(msg);
    console.error(`EVENT ${msg} — stripped`);
  }
  // Inside a unit of work the state change is not committed yet: the event is
  // published only once COMMIT returned, and never for a rolled-back operation.
  // (The registry check above still runs now, so a bad call site fails the unit.)
  if (store.inUnitOfWork?.()) { store.afterCommit(() => broadcast(event, rawPayload)); return; }
  publishEvent(event, payload);
}

/**
 * Write one already-minimised event to the replay log and the live streams —
 * the transport half of broadcast(), with no registry check and no save of
 * its own. notify() registers it as a store.afterCommit effect of the row it
 * wrote: inside a unit it runs after the COMMIT and never for a rollback, so a
 * `notify` frame is never on a stream or in the replay log for a row the
 * database does not hold. The
 * payload must already have passed minimizePayload (broadcast does that at the
 * call site, before the effect is registered).
 */
function publishEvent(event, payload) {
  const row = { id: ++eventSeq, event, payload, ts: Date.now() };
  if (event !== 'typing') {
    // typing is transient by design — never buffered, never replayed
    eventLog.push(row);
    if (eventLog.length > EVENT_LOG_CAP) eventLog.splice(0, eventLog.length - EVENT_LOG_CAP);
  }
  for (const client of sseClients) {
    if (!shouldDeliver(client.identity, event, payload)) continue;
    client.res.write(sseFrame(row));
  }
}

app.post('/events/ticket', (req, res) => {
  const session = sessionFor(req);
  if (!sseIdentityFor(session)) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Log in first — live sync is scoped to your account.' });
  for (const [t, v] of sseTickets) if (v.expiresAt < Date.now()) sseTickets.delete(t);
  const ticket = newToken();
  // The ticket names the session by its sid; no bearer token is held anywhere.
  sseTickets.set(ticket, { sid: session.sid, expiresAt: Date.now() + SSE_TICKET_TTL_MS });
  res.json({ ticket, expiresInMs: SSE_TICKET_TTL_MS });
});

app.get('/events', (req, res) => {
  const t = sseTickets.get(String(req.query.ticket ?? ''));
  if (!t || t.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'TICKET_INVALID', message: 'Mint a fresh connect ticket (POST /events/ticket) and reconnect.' });
  }
  // Identity resolves at connect time from the live session, so logout or
  // suspension invalidates streams even inside a ticket's lifetime.
  const session = sessions.bySid(t.sid); // live sessions only; a revoked or expired one yields null
  const identity = sseIdentityFor(session);
  if (!identity) return res.status(401).json({ error: 'SESSION_INVALID', message: 'Log in again — this session is no longer valid.' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ event: 'connected', ts: Date.now() })}\n\n`);
  // Catch-up: replay buffered events the client missed while disconnected.
  const lastId = Number(req.headers['last-event-id'] ?? req.query.lastEventId ?? 0);
  if (lastId > 0) {
    const bufferStart = eventLog.length > 0 ? eventLog[0].id : eventSeq + 1;
    if (lastId > eventSeq || lastId < bufferStart - 1) {
      // Server restarted (ids reset) or the buffer evicted what was missed —
      // never silently drop updates: tell the client to refetch everything.
      res.write(`data: ${JSON.stringify({ event: 'resync', ts: Date.now() })}\n\n`);
    } else {
      for (const row of eventLog) {
        if (row.id > lastId && shouldDeliver(identity, row.event, row.payload)) res.write(sseFrame(row));
      }
      res.write(`data: ${JSON.stringify({ event: 'caught_up', ts: Date.now() })}\n\n`);
    }
  }
  const client = { res, identity };
  sseClients.add(client);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 25_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
});

// ------------------------------------------------------------------ helpers
// The id counter is a row of `counters` (repositories/counters.mjs), written through at every mint.
const idCounter = createIdCounter({ sqlite: store.sqlite });
const nextId = (prefix) => {
  return `${prefix}-${idCounter.next()}`;
};

/** The organisation as the apps see it: an allowlist of the record (the password hash is never on it). */
function orgSafe(o) {
  // What the club is looking for and its federation-route request are club setup tables, not facets of the
  // record; the apps read both from the session's organisation, so they are added here explicitly.
  const fed = clubSetup.federation.forOrg(o.id);
  return {
    id: o.id, name: o.name, type: o.type, level: o.level, plan: o.plan, country: o.country,
    location: o.location ? { lat: o.location.lat, lng: o.location.lng, city: o.location.city } : null,
    federationRef: o.federationRef ? { federation: o.federationRef.federation, registrationId: o.federationRef.registrationId } : null,
    trustedPartner: o.trustedPartner, verified: o.verified, verifiedDomain: o.verifiedDomain,
    safeguardingContractSigned: o.safeguardingContractSigned, suspended: o.suspended,
    emailDomain: o.emailDomain, emailDomainVerified: o.emailDomainVerified, mfaRequiredForLeads: o.mfaRequiredForLeads,
    verificationRevokedAt: o.verificationRevokedAt, createdAt: o.createdAt,
    lookingFor: [...clubSetup.lookingFor.forOrg(o.id)],
    federationCheck: fed ? { federation: fed.federation, registrationId: fed.registrationId, contactEmail: fed.contactEmail, status: fed.status, submittedAt: fed.submittedAt } : null,
  };
}

function findPlayer(id) {
  return byId.player(id);
}

function ledgerAppend(entry) {
  // Discovery Ledger is append-only; nothing in this file ever mutates or
  // deletes an entry after this append. A row of the ledger table, written at
  // once (in the caller's unit of work when one is open); userId / scoutName
  // are stored exactly as the caller passes them.
  const row = safetyAudit.ledger.append({ id: nextId('led'), ts: Date.now(), ...entry });
  broadcast('ledger', { type: row.type, playerId: row.playerId });
  return row;
}

// Response allowlists for the audit records (repositories/safetyAudit.mjs).
const ledgerView = (l) => ({ id: l.id, ts: l.ts, type: l.type, playerId: l.playerId, orgId: l.orgId, orgName: l.orgName, userId: l.userId, scoutName: l.scoutName, detail: l.detail });
const noteView = (n) => ({ id: n.id, orgId: n.orgId, playerId: n.playerId, userId: n.userId, scoutName: n.scoutName, text: n.text, ts: n.ts });

function isBlocked(playerId, orgId) {
  return safetyAudit.blocks.has(playerId, orgId);
}

/**
 * The player's CANONICAL live contract, if any: a
 * completed-signing row written by the ONE writer over a COMPLETED signing
 * package, not cancelled, whose contract end (if any) has not passed at
 * `now`. This is the record that owns `under_contract`; a self-declaration
 * or a club's squad housekeeping never overrides it.
 */
function canonicalContractFor(playerId, now = Date.now(), { exceptOrgId = null } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  for (const s of signingsFollowUps.signings.forPlayer(playerId)) {
    if (!s.signingPackageId) continue;
    if (s.cancelledAt || s.revokedAt || s.voidedAt) continue;
    if (exceptOrgId && s.orgId === exceptOrgId) continue;
    const found = signingsFollowUps.signingPackages.byId(s.signingPackageId);
    const pkg = found && found.status === 'COMPLETED' && found.completion?.signingId === s.id ? found : null;
    if (!pkg) continue;
    const end = s.contract?.endDate ?? pkg.completion?.contract?.endDate ?? null;
    if (typeof end === 'string' && end < today) continue;
    return { signing: s, packageId: pkg.id, orgId: s.orgId, endDate: end };
  }
  return null;
}

// -------------------------------------------------------------- sessions
// Real sessions: logins mint a bearer token; every authenticated route
// resolves the caller from the token. Nothing trusts a client-sent id.
// A session has an absolute lifetime. Expiry is decided in ONE place (the
// sessions repository) and applied wherever a session is resolved: the bearer
// lookup, the event-stream connect and a signed media link. A session with no
// valid creation time is treated as expired (fail closed). The bearer token is
// never stored — the table holds its hash and `sessionFor` hashes what the
// client presents. `createSession` is the only place a token exists server
// side, and only as the value it returns to the login handler.
const SESSION_TTL_MS = sessions.ttlMs;
function sessionLive(s, now = Date.now()) { return sessions.isLive(s, now); }
function pruneExpiredSessions(now = Date.now()) { return sessions.prune(now); }
function createSession(kind, refId, extra = {}) {
  // sid: a non-secret session identifier that media URLs are bound to — the
  // URL dies with the session (logout) and is re-checked against the
  // session's CURRENT entitlement on every fetch.
  return sessions.create(kind, refId, extra).token;
}

function sessionFor(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return sessions.byToken(header.slice(7));
}

app.post('/auth/logout', (req, res) => {
  const session = sessionFor(req);
  if (session) sessions.revokeSid(session.sid);
  res.json({ ok: true });
});

// Brute-force protection on every credential-shaped endpoint.
const authLimiter = makeRateLimiter({ windowMs: 60_000, max: 40, bucket: 'auth' });
app.use('/auth', authLimiter);

// Development shortcuts (seeded passwordless identities, credential-less org
// logins) exist for local work and tests only, and are refused in production.
const DEV_LOGINS = devLoginsEnabled();
function devLoginRefused(res) {
  res.status(403).json({
    error: 'DEV_LOGIN_DISABLED',
    message: 'Passwordless demo logins are disabled outside development. Use a credentialed account.',
  });
  return true;
}

// ----------------------------------------------------- failed-login budget
//
// Complements `authLimiter` above rather than replacing it. That one is per IP
// and counts every /auth request including successes; this one is per IDENTIFIER
// and counts only wrong guesses. Both are wanted: the IP limiter bounds volume,
// this bounds guessing at one account.
//
// Three properties the wiring has to preserve, each of which is a way to get
// this wrong:
//
//   1. A SUCCESS costs nothing. Only `noteLoginFailure` charges the bucket, so
//      ordinary sign-in traffic can never lock anybody out.
//   2. The lockout is tested BEFORE the credential is verified, so a correct
//      guess arriving after the budget is gone is refused rather than rewarded.
//   3. An identifier that does not exist is charged and refused IDENTICALLY to
//      one that does, so the 429 is not a new account-existence oracle. (The
//      404 on an unknown id is frozen behaviour — but this limiter must not
//      add a second signal on top.)

/** Normalise an identifier to one bucket: trimmed, lower-cased, never empty. */
const loginKey = (identifier) => String(identifier ?? '').trim().toLowerCase() || 'unknown';

/** True (and the response already sent) when this identifier is locked out. */
function loginLockedOut(res, identifier) {
  if (!rateLimit.peek('login_failure', loginKey(identifier)).limited) return false;
  res.status(429).json(rateLimitedBody('login_failure'));
  return true;
}

const noteLoginFailure = (identifier) => { rateLimit.limited('login_failure', loginKey(identifier)); };

// ------------------------------------------------------------ notifications
// The preference gate exists before anything that notifies; its routes register with the other preference routes.
const notificationPrefs = createNotificationPrefs({ notifications });
const notifier = createNotifier({ notifications, prefs: notificationPrefs, store, pushSender, byId, publishEvent, eventPayloadDrops });
const { notify } = notifier;
let agentCoreDomain = null; // assigned when the Agent core registers, below

// Football activity feeds the streak/weekly-goal habit loop.
function recordActivity(player) {
  players.addItem(player.id, 'activityLog', Date.now());
  refreshJourneyBadges(players.byId(player.id));
}

// Grassroots journey badges: awarded automatically as the record grows.
// Level-up moments are handled at the signing itself.
function refreshJourneyBadges(given) {
  const player = players.byId(given.id); // the stored record, with the caller's writes
  if (!player || player.level === 'pro') return;
  const earned = earnedGrassrootsBadges(player, { streak: computeStreak(player.activityLog) });
  for (const badge of earned) {
    if (!(player.badges ?? []).includes(badge)) {
      players.addItem(player.id, 'badges', badge);
      notify({ kind: 'player', id: player.id }, 'badge', `🏅 Badge earned: ${badge}. It's on your profile — recognition that never depends on being scouted.`, player.id);
    }
  }
}

/**
 * A coach reference as every profile shows it: an allowlist, never the coach's email or the code. Honesty rule: an
 * email-code reference proves mailbox control, NOT coach identity — say so wherever the reference travels.
 */
function vouchView(v) {
  return {
    id: v.id, playerId: v.playerId, playerName: v.playerName, coachName: v.coachName, role: v.role, status: v.status,
    text: v.text, seasons: v.seasons, ts: v.ts, publishedAt: v.publishedAt, conflictOfInterest: v.conflictOfInterest,
    withdrawn: v.withdrawn && { at: v.withdrawn.at, by: v.withdrawn.by, reason: v.withdrawn.reason },
    verificationMethod: v.verificationMethod, identityVerified: v.identityVerified,
  };
}
function publishedVouchesFor(playerId) {
  return verificationReads.vouches.publishedFor(playerId).map(vouchView);
}

// Safeguarding certification is EARNED and losable: verification + signed
// contract + no unresolved urgent report against the org.
function safeguardingCertified(org) {
  if (!org.verified || !org.safeguardingContractSigned) return false;
  return !safetyAudit.reports.openUrgentAgainst(org.id);
}

// Scout tag vocabulary — structured, professional, no free text.
const SCOUT_TAGS = [
  'first_touch', 'pace', 'positioning', 'work_rate', 'left_foot', 'right_foot',
  'aerial', 'composure', 'vision', 'pressing', 'finishing', 'distribution',
];

// ---------------------------------------------------------------- insights
// "Who's watching you": the player's side of the Discovery Ledger.
const INSIGHT_TYPES = ['view', 'save', 'shortlist', 'contact_request', 'trial_request', 'contact_request_to_guardian', 'trial_request_to_guardian'];

function insightsFor(playerId) {
  const events = safetyAudit.ledger.forPlayer(playerId, INSIGHT_TYPES);
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const month = Date.now() - 30 * 24 * 3600 * 1000;
  const count = (list, type) => list.filter((l) => l.type.startsWith(type)).length;
  const weekly = events.filter((l) => l.ts >= week);
  const monthly = events.filter((l) => l.ts >= month);
  const byOrg = {};
  for (const l of events) {
    byOrg[l.orgName] ??= { orgName: l.orgName, views: 0, saves: 0, shortlists: 0, requests: 0, lastSeen: 0 };
    if (l.type === 'view') byOrg[l.orgName].views++;
    if (l.type === 'save') byOrg[l.orgName].saves++;
    if (l.type === 'shortlist') byOrg[l.orgName].shortlists++;
    if (l.type.includes('request')) byOrg[l.orgName].requests++;
    byOrg[l.orgName].lastSeen = Math.max(byOrg[l.orgName].lastSeen, l.ts);
  }
  // 8-week trend series (creator-analytics style), oldest first.
  const weeklySeries = Array.from({ length: 8 }, (_, i) => {
    const end = Date.now() - i * 7 * 24 * 3600 * 1000;
    const start = end - 7 * 24 * 3600 * 1000;
    return events.filter((l) => l.type === 'view' && l.ts >= start && l.ts < end).length;
  }).reverse();
  return {
    thisWeek: { views: count(weekly, 'view'), saves: count(weekly, 'save'), shortlists: count(weekly, 'shortlist') },
    thisMonth: { views: count(monthly, 'view'), saves: count(monthly, 'save'), shortlists: count(monthly, 'shortlist') },
    weeklySeries,
    byOrg: Object.values(byOrg).sort((a, b) => b.lastSeen - a.lastSeen),
    recent: events.slice(-12).reverse().map((l) => ({ type: l.type, orgName: l.orgName, scoutName: l.scoutName, ts: l.ts })),
  };
}

// Screen text through moderation; throws a structured refusal on a hit.
// Children cannot share personal contact details, and club messages to
// guardians are screened the same way. Every hit is logged.
function moderateOrRefuse(res, text, context) {
  const check = moderateText(text);
  if (!check.ok) {
    // The hit and, for grooming-pattern language, its escalation commit together.
    unit(() => {
      safetyAudit.moderationLog.record({ id: nextId('mod'), ts: Date.now(), context, flags: check.flags, severity: check.severity, excerpt: String(text).slice(0, 140) });
      // Grooming-pattern hits don't just block — they escalate to a human
      // immediately as an urgent auto-report against the sender.
      if (check.severity === 'grooming') {
        safetyAudit.reports.file({
          id: nextId('rep'), ts: Date.now(), by: 'system', byId: 'moderation', byOrgId: null,
          targetKind: context.orgId ? 'club' : 'player', targetOrgId: context.orgId ?? null,
          reason: `Automatic escalation: grooming-pattern language blocked (${check.flags.join(', ')}) in ${context.kind}.`,
          urgent: true, status: 'pending_review', outcome: null, resolvedAt: null,
        });
      }
    });
    res.status(400).json({
      error: 'MODERATION_BLOCKED',
      message: 'This text was blocked by moderation: personal contact details and off-platform contact are not allowed.',
      flags: check.flags,
    });
    return false;
  }
  return true;
}

// Public view of a player for a given org: a positive
// allowlist (views/playerViews.mjs), never a spread of the record. Applies the
// minor-visibility rules, guardian-managed contact, player/guardian-controlled
// medical sharing, the grassroots platform rules; serves attendance without
// GPS and only this organisation's own trial reports; never the date of
// birth, coordinates, programme, guardian id, password hash, activity log,
// notification preferences, import claims or drill results.
const VIEW_HELPERS = { visibleToOrg, isBlocked, isAdult, ageOn, computeTrustScore, publishedVouchesFor, haversineKm, trustBreakdown };
function playerViewForOrg(player, org) {
  return orgPlayerView(player, org, VIEW_HELPERS);
}

// -------------------------------------------------------------------- meta
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'scoutbox-server',
  engine: store.engine,
  devLogins: DEV_LOGINS,
  uptimeSec: Math.round(process.uptime()),
  players: players.count(),
  orgs: orgs.count(),
}));

app.get('/meta', (_req, res) => {
  res.json({
    adultAges: { note: 'age of majority per country; DEFAULT applies otherwise' },
    plans: PLANS,
    positions: ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'],
  });
});

// The authenticated routers. The guardian's is created with the guardian account, below; the player account's
// routes are domains/identity/players.mjs.
const orgRouter = express.Router();
app.use('/org', orgAuth, orgRouter);
const { playerRouter, guardianManagedOnly } = createPlayerSession({ app, findPlayer, sessionFor });

// -------------------------------------------------------------- guardians
// Parents own every under-18 account. The account and its safeguarding gates (e-mail, ID, disclaimer) are
// domains/identity/guardians.mjs; managing the children is domains/identity/children.mjs.
const { guardianRouter } = registerGuardianAccount({
  app, guardians, safetyAudit, unit, nextId, mailer, idv, faultSeam: seam,
  createSession, sessionFor, loginKey, loginLockedOut, noteLoginFailure, devLogins: DEV_LOGINS, devLoginRefused,
});

// ------------------------------------------------------------- message threads
const { openChannel } = registerMessaging({
  orgRouter, playerRouter, guardianRouter, channels, recruitment, byId, isBlocked,
  unit, nextId, notify, broadcast, ledgerAppend, moderateOrRefuse, guardianManagedOnly,
});

// ---------------------------------------------------------------- org auth
app.get('/orgs', (req, res) => {
  // Platform separation starts at the login screen: the Grassroots app lists
  // only grassroots clubs, the main app never lists them. The Agent
  // app lists agency organisations only. Unpaged: the sign-in pickers have no
  // search yet (docs/known-issues.md).
  const filter = { grassroots: { level: 'grassroots' }, main: { notLevel: 'grassroots' }, agent: { type: 'agency' } }[req.query.platform] ?? {};
  const list = orgs.list(filter);
  res.json(list.map((o) => ({
    id: o.id, name: o.name, type: o.type, level: o.level ?? null, plan: o.plan, trustedPartner: o.trustedPartner,
    verified: o.verified, safeguardingCertified: safeguardingCertified(o),
    ...(o.level === 'grassroots' ? { city: o.location?.city ?? null, federation: o.federationRef?.federation ?? null } : {}),
  })));
});

// ScoutBox Grassroots club registration: federation-registered semi-pro
// clubs and below. Registration is open; verification (federation record,
// email domain, safeguarding contract) is checked by T&S before the club can
// see any minor — the same bar every club faces.
app.post('/auth/org/register-grassroots', (req, res) => {
  const { name, country = 'GB', city, lat, lng, federation, registrationId, scoutName, role, password } = req.body || {};
  if (password !== undefined && String(password).length < 8) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT', message: 'Club passwords need at least 8 characters.' });
  }
  if (!reqText(name, 120)) return res.status(400).json({ error: 'NAME_REQUIRED' });
  for (const [f, v, max] of [['country', country, 2], ['city', city, 80], ['federation', federation, 120], ['registrationId', registrationId, 60], ['role', role, 60]]) if (!optText(v, max)) return badField(res, f);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    if (typeof lat === 'number' || typeof lng === 'number') return badField(res, 'location');
  }
  if (typeof country !== 'string' || !country.trim() || country !== country.trim()) return badField(res, 'country');
  if (!federation?.trim() || !registrationId?.trim()) {
    return res.status(400).json({ error: 'FEDERATION_REQUIRED', message: 'Grassroots clubs must hold a federation registration — name the federation and your registration id.' });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'LOCATION_REQUIRED', message: 'The 50km scouting radius is measured from your ground — a location is required.' });
  }
  if (!reqText(scoutName, 120)) return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED' });
  // The organisation, its administrator's account and the session are one unit.
  const { org, user, token } = unit(() => {
    const created = orgs.create({
      name: name.trim(),
      type: 'club',
      level: 'grassroots',
      location: { lat, lng, city: city?.trim() || null },
      federationRef: { federation: federation.trim(), registrationId: registrationId.trim() },
      plan: 'Grassroots',
      country,
      passwordHash: password ? hashPassword(String(password)) : null,
    });
    const admin = users.create({ orgId: created.id, name: scoutName.trim(), role: role?.trim() || 'Manager' });
    return { org: created, user: admin, token: createSession('org', created.id, { userId: admin.id }) };
  });
  broadcast('orgs');
  res.status(201).json({
    userId: user.id, role: user.role, org: { ...orgSafe(org), safeguardingCertified: safeguardingCertified(org) },
    token,
    note: 'Registered. Adults within 50km are visible now; under-18 visibility needs verification + the safeguarding contract, reviewed by Trust & Safety.',
  });
});

app.post('/auth/org/login', (req, res) => {
  const { orgId, scoutName, role, platform } = req.body || {};
  if (loginLockedOut(res, `org:${orgId}`)) return;
  const org = byId.org(orgId);
  if (!org) { noteLoginFailure(`org:${orgId}`); return res.status(404).json({ error: 'ORG_NOT_FOUND' }); }
  // Hard platform separation: a grassroots club exists only on ScoutBox
  // Grassroots; every other org exists only on ScoutBox. No crossover.
  const wantsGrassroots = platform === 'grassroots';
  if (org.level === 'grassroots' && !wantsGrassroots) {
    return res.status(403).json({ error: 'GRASSROOTS_PLATFORM_ONLY', message: 'This club is registered on ScoutBox Grassroots — log in there.' });
  }
  if (org.level !== 'grassroots' && wantsGrassroots) {
    return res.status(403).json({ error: 'PLATFORM_MISMATCH', message: 'ScoutBox Grassroots is for federation-registered grassroots clubs only.' });
  }
  // ScoutBox Agent is for agency organisations only. (An agency can still log
  // into the club app: the m13 representation lane and its suites live there.)
  if (platform === 'agent' && org.type !== 'agency') {
    return res.status(403).json({ error: 'PLATFORM_MISMATCH', message: 'ScoutBox Agent is for agency organisations only.' });
  }
  if (!optText(role, 60)) return badField(res, 'role');
  if (typeof scoutName !== 'string' || !scoutName.trim()) {
    // Accountability by user: no anonymous / shared workspace access.
    return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED', message: 'Every session is attributed to a named individual.' });
  }
  if (scoutName.trim().length > STAFF_LIMITS.name) return res.status(400).json({ error: 'FIELD_INVALID', field: 'scoutName', message: `scoutName is at most ${STAFF_LIMITS.name} characters.` });
  // Org credentials: provisioned orgs require their password; unprovisioned
  // (seeded demo) orgs are a development shortcut only.
  const passwordHash = orgs.passwordHashOf(org.id);
  if (passwordHash) {
    const check = verifyPassword(req.body?.password ?? '', passwordHash);
    if (!check) { noteLoginFailure(`org:${orgId}`); return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This organisation is password-protected.' }); }
    if (check === 'upgrade') orgs.setPasswordHash(org.id, hashPassword(req.body.password));
  } else if (!DEV_LOGINS) {
    return devLoginRefused(res);
  }
  let user = users.byOrgAndName(orgId, scoutName);
  if (user?.removedAt) {
    // Departed staff don't come back by typing their old name.
    return res.status(403).json({ error: 'USER_REMOVED', message: 'This staff member\'s access was removed by the organisation.' });
  }
  // Second factor. A user who enabled MFA never gets a session from the
  // password alone; recovery codes are one-time; wrong codes rate-limit.
  if (user?.mfa?.enabledAt) {
    if (m13Ctx?.mfaGuards?.mfaLocked(user.id)) {
      return res.status(429).json({ error: 'MFA_LOCKED', message: 'Too many wrong codes — try again in a few minutes.' });
    }
    const { mfaCode, recoveryCode } = req.body ?? {};
    let second = false;
    if (mfaCode) second = totpValid(users.mfaSecretOf(user.id), mfaCode);
    else if (recoveryCode) {
      // Each code works exactly once: spending it deletes its row, and only the call that deleted it passes.
      second = users.useRecoveryCode(user.id, crypto.createHash('sha256').update(String(recoveryCode)).digest('hex'));
    }
    if (!second) {
      if (mfaCode || recoveryCode) m13Ctx?.mfaGuards?.mfaFail(user.id);
      return res.status(401).json({
        error: mfaCode || recoveryCode ? 'MFA_CODE_WRONG' : 'MFA_REQUIRED',
        message: mfaCode || recoveryCode ? 'That code is not valid.' : 'This account uses two-factor authentication — send mfaCode (authenticator) or recoveryCode.',
      });
    }
    m13Ctx?.mfaGuards?.clear(user.id);
  }
  // Roles are assigned by the organisation, never by the person logging in.
  //
  // An organisation that holds real credentials (its password was set at
  // registration or provisioned by Trust & Safety) gets staff accounts only
  // through server-controlled flows: the registering administrator, a lead's
  // invitation, or — exactly once — the first login with the organisation
  // password, which bootstraps the administrator account for organisations
  // provisioned without one. The role sent with a login is ignored on such an
  // organisation; the stored role answers, so nobody with the shared password
  // can make themselves staff or rewrite another person's role.
  //
  // Unprovisioned (seeded demo) organisations keep the development shortcut:
  // a login names its own role. That path is refused outside development
  // above (`devLoginRefused`), so it is never reachable in production.
  const credentialed = !!passwordHash;
  let roleNote;
  if (!user) {
    if (credentialed) {
      if (users.firstActive(orgId)) {
        return res.status(403).json({
          error: 'STAFF_NOT_PROVISIONED',
          message: 'No staff account with this name exists in the organisation. Ask a lead for an invitation — the organisation password does not create accounts.',
        });
      }
      // First account on a credentialed organisation: the administrator. A
      // lead-tier role is required so the organisation can invite its staff.
      const requested = (role || '').trim();
      user = unit(() => {
        const created = users.create({
          orgId, name: scoutName.trim(),
          role: isLeadRole(requested) ? requested : 'Manager',
          provenance: 'org_password_bootstrap',
        });
        safetyAudit.opsEvents.record({ id: nextId('ops'), at: Date.now(), kind: 'staff_bootstrapped', detail: { orgId: org.id, userId: created.id, by: created.name } });
        return created;
      });
    } else {
      user = users.create({ orgId, name: scoutName.trim(), role: role?.trim() || 'Scout' });
    }
  } else if (role && role.trim() && role.trim() !== user.role) {
    if (credentialed) {
      roleNote = 'Roles are assigned by your organisation; the role entered at sign-in was not applied.';
    } else {
      user = users.update(user.id, (d) => { d.role = role.trim(); }); // development shortcut only — see above
    }
  }
  res.json({
    userId: user.id, role: user.role,
    org: { ...orgSafe(org), safeguardingCertified: safeguardingCertified(org) },
    token: createSession('org', org.id, { userId: user.id }),
    ...(roleNote ? { roleNote } : {}),
    // Organisation policy nudge, never a lockout: existing users keep access
    // and are steered through MFA setup.
    mfaSetupRequired: !!(org.mfaRequiredForLeads && user && isLeadRole(user.role) && !user.mfa?.enabledAt) || undefined,
  });
});

// Accountability by user: sessions are minted per INDIVIDUAL scout at login —
// the token resolves to both the org and the named user, so shared/anonymous
// workspace access is structurally impossible.
function orgAuth(req, res, next) {
  const session = sessionFor(req);
  if (session?.kind !== 'org') return res.status(401).json({ error: 'ORG_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
  const org = byId.org(session.refId);
  if (!org) return res.status(401).json({ error: 'ORG_AUTH_REQUIRED' });
  const user = users.byId(session.userId);
  if (!user || user.orgId !== org.id) return res.status(401).json({ error: 'USER_UNKNOWN' });
  if (user.removedAt) return res.status(401).json({ error: 'USER_REMOVED', message: 'Your access to this organisation has been removed.' });
  if (org.suspended) {
    return res.status(403).json({ error: 'ORG_SUSPENDED', message: 'This organisation is suspended pending a safety review.' });
  }
  req.org = org;
  req.orgUser = user;
  next();
}


// ----------------------------------------------------------------- search
orgRouter.get('/players', (req, res) => {
  const { q, position, academyPlus, availability, country, ageGroup, newDays } = req.query;
  // A filter sent twice arrives as a list: refused by name, never bound into the query.
  for (const f of ['q', 'position', 'academyPlus', 'availability', 'country', 'ageGroup', 'newDays']) {
    if (req.query[f] !== undefined && typeof req.query[f] !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field: f, message: `${f} is given once, as text.` });
  }
  const AGE_GROUPS = { u16: { ageBelow: 16 }, u18: { ageBelow: 18 }, '18-21': { ageAtLeast: 18, ageBelow: 22 }, senior: { ageAtLeast: 22 } };
  // An unknown age group or a day count that is not a whole number of days is refused, not read as "any".
  if (ageGroup && !Object.hasOwn(AGE_GROUPS, ageGroup)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'ageGroup', message: `ageGroup is one of ${Object.keys(AGE_GROUPS).join(', ')}.` });
  if (newDays && !(/^\d{1,5}$/.test(newDays) && Number(newDays) > 0)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'newDays', message: 'newDays is a whole number of days, from 1.' });
  let page;
  try { page = readPage(req.query, players.directoryCursorShape(req.org)); } catch (e) { return sendPageError(res, e); }
  // The whole visibility rule (the wall, the Grassroots radius, the blocks), the filters, the search and the
  // declared order are the query's, so the page is exact; the view still applies the rule at the source.
  //   Pro / agency: Academy+ first (a boosted, opted-in cohort), then PROFILE COMPLETENESS (never ability), then the id.
  //   Grassroots: First Team Seekers first (need-based, never purchasable), then the nearest ground (to 0.1 km, as
  //   shown), then completeness, then the id. The id makes the order total, so two reads never swap equal players.
  const result = players.directoryPage(req.org, {
    position: position || undefined, availability: availability || undefined, country: country || undefined,
    academyPlus: academyPlus === 'true' || undefined, ...(AGE_GROUPS[ageGroup] ?? {}),
    ...(newDays ? { createdSince: Date.now() - Number(newDays) * 24 * 3600 * 1000 } : {}),
    text: q || undefined,
  }, page);
  // The ordering is declared, not inferred.
  res.set('X-ScoutBox-Ordering', req.org.level === 'grassroots'
    ? 'first_team_seeker,distance,profile_completeness,player_id'
    : 'academy_plus,profile_completeness,player_id');
  res.json({ items: result.items.map((p) => playerViewForOrg(p, req.org)).filter(Boolean), nextCursor: result.nextCursor });
});

/**
 * The `k` players the organisation may see that are most like `base` (domain.mjs similarityScore), best first; a tie
 * keeps the creation order. Ranked over light rows: only the
 * winners are decoded by the caller.
 */
function mostSimilar(base, org, k) {
  const best = [];
  players.scanLight({ visibleTo: org, exceptId: base.id }, (c) => {
    const score = similarityScore(base, c);
    if (best.length === k && score <= best[k - 1].score) return;
    let i = best.length; while (i > 0 && best[i - 1].score < score) i -= 1;
    best.splice(i, 0, { c, score }); if (best.length > k) best.pop();
  });
  return best;
}

orgRouter.get('/players/:id', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) {
    // Agencies never see minors; unverified clubs don't either.
    const code = req.org.type === 'agency' ? 'UNDER_18_WALL' : 'VERIFIED_CLUBS_ONLY';
    return res.status(403).json({
      error: code,
      message: code === 'UNDER_18_WALL'
        ? 'Agency accounts cannot view minors.'
        : 'Under-18 profiles are visible to verified clubs only. Complete club verification to continue.',
    });
  }
  if (isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  ledgerAppend({ type: 'view', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  const view = playerViewForOrg(p, req.org);
  // Ranked over light rows (the visibility rule is the query's); the winners keep the creation order on a tie.
  const similar = mostSimilar(p, req.org, 3).map(({ c, score }) => ({ playerId: c.id, name: c.name, position: c.position, score }));
  const archetypes = ARCHETYPES
    .map((a) => ({ archetypeId: a.id, label: a.label, score: similarityScore(p, a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const orgNotes = safetyAudit.orgNotes.forOrgPlayer(req.org.id, p.id).map(noteView);
  res.json({ ...view, orgNotes, similarPlayers: { note: 'Statistical similarity — a lead, not a verdict.', players: similar, archetypes } });
});

// Internal scouting notes — shared inside the org, never visible to the
// player or any other organisation.
orgRouter.post('/players/:id/notes', (req, res) => {
  const p = findPlayer(req.params.id);
  // A player who blocked this organisation reads as absent
  // on every discovery route, exactly as the profile read already answers.
  if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  if (text.trim().length > AUDIT_LIMITS.note) return badField(res, 'text');
  const note = { id: nextId('note'), orgId: req.org.id, playerId: p.id, userId: req.orgUser.id, scoutName: req.orgUser.name, text: text.trim(), ts: Date.now() };
  const stored = safetyAudit.orgNotes.add(note);
  broadcast('players', { playerId: p.id });
  res.status(201).json(noteView(stored));
});

// "More like this" — the similarity engine as a search entry point.
orgRouter.get('/players/:id/morelike', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  const top = mostSimilar(p, req.org, 10);
  const full = new Map(players.byIds(top.map(({ c }) => c.id)).map((c) => [c.id, c]));
  const ranked = top.map(({ c, score }) => { const view = full.has(c.id) ? playerViewForOrg(full.get(c.id), req.org) : null; return view ? { ...view, similarity: score } : null; }).filter(Boolean);
  res.json({ base: { id: p.id, name: p.name, position: p.position }, players: ranked });
});

for (const action of ['save', 'shortlist']) {
  orgRouter.post(`/players/:id/${action}`, (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
    const row = ledgerAppend({ type: action, playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    res.status(201).json({ ok: true, ledgerId: row.id });
  });
}

orgRouter.get('/shortlist', (req, res) => {
  const ids = safetyAudit.ledger.playersListedBy(req.org.id);
  // A shortlisted player who has since deleted their account is simply absent (the ledger row stays, id only).
  res.json(ids.map((id) => findPlayer(id)).filter(Boolean).map((p) => playerViewForOrg(p, req.org)).filter(Boolean));
});

// ------------------------------------------------------- contact & trials
// Scout Inbox: there is no direct message channel anywhere in this API.
// An org can only file a request; contact unlocks on acceptance. For minors
// the request NEVER reaches the child — it routes to the guardian, and any
// conversation that opens is between adults.
orgRouter.post('/players/:id/request', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) {
    return res.status(403).json({
      error: req.org.type === 'agency' ? 'UNDER_18_WALL' : 'VERIFIED_CLUBS_ONLY',
      message: req.org.type === 'agency' ? 'Agency accounts cannot contact minors.' : 'Only verified clubs can contact under-18 players (via their guardian).',
    });
  }
  if (isBlocked(p.id, req.org.id)) {
    return res.status(403).json({ error: 'BLOCKED', message: 'This player (or their guardian) has blocked your organisation.' });
  }
  const { type, message } = req.body || {};
  if (!['contact', 'trial'].includes(type)) return res.status(400).json({ error: 'TYPE_MUST_BE_CONTACT_OR_TRIAL' });
  if (!moderateOrRefuse(res, message, { kind: 'org_request_message', orgId: req.org.id, userId: req.orgUser.id })) return;

  if (type === 'trial') {
    // Trial reports are mandatory: an org with an unfiled report for a past
    // trial cannot request new trials until it files.
    // A report can never be filed for a subject who removed their account,
    // so a tombstoned trial does not hold the organisation hostage.
    const overdue = recruitment.trials.forOrgStatus(req.org.id, 'awaiting_report').filter((t) => !t.subjectRemovedAt);
    if (overdue.length > 0) {
      return res.status(409).json({
        error: 'REPORTS_OUTSTANDING',
        message: `You have ${overdue.length} trial(s) awaiting a mandatory performance report. File them before requesting new trials.`,
        trialIds: overdue.map((t) => t.id),
      });
    }
  }

  // Trial logistics: what the player/guardian is actually agreeing to.
  // altSlots lets the other side pick a date that works (counter-proposal).
  // Every date is validated by the one Trial date validator and the text
  // fields are bounded BEFORE anything is written, so a malformed date never
  // reaches the trial row as a NaN deadline.
  let trialDetails = null;
  if (type === 'trial') {
    const check = validateTrialDetails(req.body);
    if (!check.ok) return res.status(400).json(check);
    trialDetails = check.details;
    if (trialDetails.notes && !moderateOrRefuse(res, trialDetails.notes, { kind: 'trial_notes', orgId: req.org.id })) return;
  }
  // This route is a second path to the same inbox row as a canonical Contact
  // send or Trial invitation. After the body has been validated, it draws on
  // the SAME budgets and keeps the same one-pending rule, so it is not an
  // unmetered alias: a club cannot flood a player through this door.
  const pendingSame = recruitment.requests.forOrgPlayer(req.org.id, p.id).find((r) => r.type === type && r.status === 'pending' && !r.subjectRemovedAt);
  if (pendingSame) return res.status(409).json({ error: 'REQUEST_PENDING', message: `A ${type} request to this player is already awaiting an answer.`, requestId: pendingSame.id });
  if (rateLimit.limited(type === 'trial' ? 'trial_invite' : 'contact_send', req.org.id)) return res.status(429).json(rateLimitedBody(type === 'trial' ? 'trial_invite' : 'contact_send'));
  const request = issueRecruitmentRequest({ org: req.org, orgUser: req.orgUser, player: p, type, message, trialDetails });
  res.status(201).json({ ok: true, requestId: request.id, status: 'pending', routedTo: request.routedTo });
});

/**
 * THE one writer of an org → player/guardian request row.
 *
 * The Contact workflow's send creates its recipient-visible object through
 * exactly the same path as the direct request route:
 * the same routing rule (scout → parent, never scout → child), the same
 * ledger entry, the same notifications, the same `inbox` ping. A second
 * writer would be a second Inbox by another name.
 *
 * `guardianId` lets a caller that has already resolved the guardian route
 * (the Contact workflow validates the record, the child link and the
 * verification gates) name it; the direct route keeps the player's own link.
 * `notice` lets a caller with its own occasion word the notifications
 * (`{ kind, toGuardian, toPlayer }`, the open-day invitation); the row, the
 * routing, the ledger entry and the inbox ping are the same either way.
 * `workflow` lets the Trial invitation write its case link, recipient snapshot
 * and client key in the same create (`{ caseId, recipient, keys }`).
 * The row is written at once (`requests.create`); the returned record is the
 * stored, read-only one.
 */
function issueRecruitmentRequest({
  org, orgUser, player, type, message = '', trialDetails = null,
  subject = null, contactId = null, guardianId = undefined, at = Date.now(), notice = null, workflow = null,
}) {
  const minor = !isAdult(player);
  const request = {
    id: nextId('req'),
    playerId: player.id,
    playerName: player.name,
    orgId: org.id,
    orgName: org.name,
    orgType: org.type,
    orgVerified: !!org.verified,
    orgSafeguardingCertified: safeguardingCertified(org),
    trustedPartner: org.trustedPartner,
    userId: orgUser.id,
    scoutName: orgUser.name,
    scoutRole: orgUser.role || 'Scout',
    type,
    message: message || '',
    // A Contact carries an optional subject, and the row remembers
    // which Contact created it. `contactId` is an internal link and is
    // stripped from every recipient-facing view (`requestForRecipient`).
    ...(subject ? { subject } : {}),
    ...(contactId ? { contactId } : {}),
    trialDetails,
    status: 'pending',
    createdAt: at,
    // Scout → Parent, never Scout → Child.
    routedTo: minor ? 'guardian' : 'player',
    guardianId: minor ? (guardianId ?? player.guardianId) : null,
    contactChannel: null, // stays null until the player/guardian accepts
    ...(workflow ? { caseId: workflow.caseId, trialId: null, recipient: workflow.recipient, keys: workflow.keys } : {}),
  };
  const stored = recruitment.requests.create(request); // written now (inside the caller's unit when there is one)
  ledgerAppend({ type: `${type}_request${minor ? '_to_guardian' : ''}`, playerId: player.id, orgId: org.id, orgName: org.name, userId: orgUser.id, scoutName: orgUser.name });
  const kind = notice?.kind ?? 'request';
  if (minor) {
    notify({ kind: 'guardian', id: stored.guardianId }, kind, notice?.toGuardian ?? `${org.name} has requested to discuss a ${type === 'trial' ? 'trial' : 'conversation'} for ${player.name}.`, stored.id);
    notify({ kind: 'player', id: player.id }, kind, notice?.toPlayer ?? `${org.name} contacted your parent/guardian about a ${type === 'trial' ? 'trial' : 'conversation'}.`, stored.id);
  } else {
    notify({ kind: 'player', id: player.id }, kind, notice?.toPlayer ?? `${org.name} sent you a ${type} request.`, stored.id);
  }
  broadcast('inbox', { playerId: player.id });
  return stored;
}

/**
 * The ONE writer of an accepted trial. Both respond routes — the adult's own
 * and the guardian's on a minor's behalf — call this with the slot they
 * already validated (`chooseTrialSlot`), so the two rows cannot drift apart: same fields, same clock (`at` is the response
 * instant the caller stamped on the request), same deadline derivation.
 * `trialDate` is a validated `YYYY-MM-DD` or null (date to be confirmed);
 * the deadline is never NaN because `trialReportDueAt` never returns one.
 */
function issueAcceptedTrial({ request, player, trialDate, by, at, actor = null }) {
  const details = request.trialDetails ?? {};
  // A slot-based invitation carries concrete slots (UTC instants + the
  // organiser's timezone + a venue). Accepting one of them IS the schedule
  // confirmation: the trial is born `scheduled` with revision 1 confirmed by
  // the recipient. A date-only invitation, or an undated one, is born `accepted` with no schedule — a date the club typed
  // is not a confirmed schedule, and nothing is fabricated from it.
  const slot = Array.isArray(details.slots) ? details.slots.find((s) => s && s.day === trialDate) ?? null : null;
  const recipient = { type: by, playerId: player.id, guardianId: by === 'guardian' ? (actor?.id ?? null) : null, minor: by === 'guardian', at };
  const who = { kind: by, id: actor?.id ?? null, name: actor?.name ?? null };
  // The address line and the instructions were held back from the
  // invitation; they join the session now that the family accepted.
  const priv = details.private && typeof details.private === 'object' ? details.private : {};
  const session = slot ? {
    id: nextId('tses'), kind: slot.kind ?? 'training', startsAt: slot.startsAt, endsAt: slot.endsAt,
    venue: slot.venue ? { name: slot.venue.name, town: slot.venue.town ?? null, address: typeof priv.venueAddress === 'string' ? priv.venueAddress : null } : null,
    instructions: typeof priv.instructions === 'string' ? priv.instructions : null,
    evidence: [],
  } : null;
  const proposedBy = { kind: 'org', userId: request.userId ?? null, name: request.scoutName ?? null };
  const schedule = session ? {
    timezone: slot.timezone, revision: 1, proposedAt: request.createdAt ?? at, proposedBy,
    confirmedAt: at, confirmedBy: who,
    sessions: [session],
    revisions: [{ revision: 1, timezone: slot.timezone, sessions: [{ ...session, evidence: undefined }], proposedAt: request.createdAt ?? at, proposedBy, confirmedAt: at, confirmedBy: who, supersededAt: null, reason: 'invitation', material: null }],
  } : null;
  const trial = {
    id: nextId('trial'),
    requestId: request.id,
    caseId: request.caseId ?? null,
    playerId: player.id,
    playerName: player.name,
    orgId: request.orgId,
    orgName: request.orgName,
    scoutName: request.scoutName,
    acceptedAt: at,
    acceptedBy: by,
    guardianApproved: by === 'guardian',
    proposedDate: trialDate,
    venue: typeof details.venue === 'string' && details.venue !== '' ? details.venue : null,
    notes: typeof details.notes === 'string' ? details.notes : '',
    // The mandatory report is due 7 days after the trial day (or acceptance).
    reportDueAt: trialReportDueAt(trialDate, at),
    status: 'awaiting_report', // mandatory report gate
    // ---- Operational containers. One clock: `at`.
    workflowState: schedule ? 'scheduled' : 'accepted',
    schedule,
    attendance: [],
    completion: null,
    recipient,
    history: [
      { id: nextId('aud'), at, action: 'trial_accepted', by: who, detail: { recipientType: by, slotId: slot?.id ?? null, day: trialDate ?? null } },
      ...(schedule ? [{ id: nextId('aud'), at, action: 'trial_schedule_confirmed', by: who, detail: { revision: 1, sessionCount: 1 } }] : []),
    ],
    reminders: {},
    rev: 1, revAt: at, revBy: null,
  };
  return recruitment.trials.create(trial); // with its children, written now (inside the respond route's unit)
}

/** A request row as its RECIPIENT may see it: no org id, no user id, no internal Contact link. */
// `caseId` and `trialId` are the club's workflow ids and never travel to a
// recipient; the family reaches the trial through its own family view, where
// `requestId` matches the invitation.
const requestForRecipient = ({ orgId, userId, contactId, caseId, recipient, keys, trialId, ...visible }) => {
  // The trial the recipient's own acceptance created is THEIR record (it is
  // what /player/trials and /guardian/trials list); its id travels so the
  // Inbox can deep-link to it. The case id and the org's internals never do.
  const out = { ...visible, trialId: trialId ?? null };
  // The address line and the instructions of an invitation are shared
  // after acceptance only: they never appear in the Inbox view.
  if (out.trialDetails && typeof out.trialDetails === 'object' && 'private' in out.trialDetails) {
    const { private: _p, ...td } = out.trialDetails;
    return { ...out, trialDetails: td };
  }
  return out;
};

/**
 * An optional short reply on a CONTACT-type request. Validated before
 * anything is mutated; refused if it is not text or if moderation refuses it.
 * Returns `{ ok, reply }` or answers the request and returns `{ ok: false }`.
 */
function contactReplyFrom(req, res, request) {
  const check = validateContactReply(req.body?.message, { isContact: request.type === 'contact' });
  if (!check.ok) { res.status(400).json({ error: check.error, message: check.message }); return { ok: false }; }
  if (check.reply && !moderateOrRefuse(res, check.reply, { kind: 'contact_reply', requestId: request.id })) return { ok: false };
  return { ok: true, reply: check.reply };
}

// ------------------------------------------------------- film room & feed

// The Film Room: full-screen swipe deck of playable clips from players this
// org is allowed to see. Verified Clips surface first.
orgRouter.get('/filmroom', (req, res) => {
  // Paged by cursor in SQL ({ items, nextCursor }): verified clips first, then the most viewed.
  let page;
  try { page = readPage(req.query, ['number', 'number', 'string', 'number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = players.clipPage(req.org, page);
  res.json({
    items: items.map(({ player: p, media: m }) => {
      const view = playerViewForOrg(p, req.org);
      if (!view) return null;
      return {
        media: { id: m.id, title: m.title, url: m.url, views: m.views ?? 0, verifiedClip: m.verifiedClip, tags: m.tags ?? {} },
        player: {
          id: view.id, name: view.name, position: view.position, age: view.age,
          trustScore: view.trustScore, academyPlus: view.academyPlus, guardianManaged: !!view.guardianManaged,
        },
      };
    }).filter(Boolean),
    nextCursor,
  });
});

// Per-clip view tracking — honest scouting signal back to the player.
orgRouter.post('/players/:pid/media/:mid/view', (req, res) => {
  const p = findPlayer(req.params.pid);
  if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  const views = (m.views ?? 0) + 1;
  players.patchItem(p.id, 'media', { id: m.id }, { views }); // committed before the response
  broadcast('players', { playerId: p.id });
  res.json({ views });
});

// "What scouts noticed": structured tags, aggregated anonymously for the player.
orgRouter.post('/players/:pid/media/:mid/tags', (req, res) => {
  const p = findPlayer(req.params.pid);
  if (!p || !visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  const { tags } = req.body || {};
  if (!Array.isArray(tags) || tags.length === 0) return res.status(400).json({ error: 'TAGS_REQUIRED', allowed: SCOUT_TAGS });
  const invalid = tags.filter((t) => !SCOUT_TAGS.includes(t));
  if (invalid.length) return res.status(400).json({ error: 'UNKNOWN_TAGS', invalid, allowed: SCOUT_TAGS });
  const next = { ...(m.tags ?? {}) };
  for (const t of tags) next[t] = (next[t] ?? 0) + 1;
  // ONE unit of work: the clip's tag rows and the ledger row commit together.
  let stored;
  unit(() => {
    stored = players.patchItem(p.id, 'media', { id: m.id }, { tags: next });
    ledgerAppend({ type: 'clip_tagged', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    broadcast('players', { playerId: p.id });
  });
  res.json({ tags: stored.tags });
});

orgRouter.get('/tags', (_req, res) => res.json(SCOUT_TAGS));

// The club home feed: what changed since you last looked.
orgRouter.get('/feed', (req, res) => {
  const FOURTEEN_DAYS = Date.now() - 14 * 24 * 3600 * 1000;
  const items = [];
  const shortlisted = new Set(safetyAudit.ledger.playersListedBy(req.org.id, ['shortlist', 'save']));
  // The newest 40 of each kind from SQL (the visibility rule is the query's); the page is the newest 40 of all.
  const recent = players.recentFor(req.org, FOURTEEN_DAYS, 40);
  for (const p of recent.players) {
    items.push({ type: 'new_player', ts: p.createdAt, playerId: p.id, playerName: p.name, position: p.position, age: ageOn(p.dob), guardianManaged: !isAdult(p) });
  }
  for (const { player: p, media: m } of recent.clips) {
    items.push({
      type: shortlisted.has(p.id) ? 'shortlist_new_clip' : 'new_clip',
      ts: new Date(m.uploadedAt).getTime(), playerId: p.id, playerName: p.name,
      mediaId: m.id, title: m.title, hasVideo: !!m.url, verifiedClip: !!m.verifiedClip,
    });
  }
  // A trial whose subject removed their account (a tombstone) has no
  // report to file, so it is neither listed as due nor reminded about.
  for (const t of recruitment.trials.forOrgStatus(req.org.id, 'awaiting_report').filter((x) => !x.subjectRemovedAt)) {
    const dueAt = Number.isFinite(t.reportDueAt) ? t.reportDueAt : null;
    items.push({ type: 'report_due', ts: dueAt ?? Date.now(), playerId: t.playerId, playerName: t.playerName, trialId: t.id, dueAt });
    // one-shot reminder when the mandatory report is due within 48h
    if (!t.reminderSent && dueAt !== null && dueAt - Date.now() < 48 * 3600 * 1000) {
      recruitment.trials.markReportReminderSent(t.id); // the one-shot marker, written now
      const request = recruitment.requests.byId(t.requestId);
      if (request?.userId) notify({ kind: 'org_user', id: request.userId }, 'report_due', `Mandatory trial report for ${t.playerName} is due ${utcDayOf(dueAt)}.`, t.id); // the UTC day, not the server locale
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  res.json(items.slice(0, 40));
});

// --------------------------------------------------------- saved searches (domains/discovery/savedSearches.mjs)
const { checkSavedSearches } = registerSavedSearches({ byId, orgRouter, notify, nextId, playerViewForOrg, reqText, savedSearches: operations.savedSearches });

// Calendar export for an accepted trial.
orgRouter.get('/trials/:id/ics', (req, res) => {
  const t = onlyIf(recruitment.trials.byId(req.params.id), (x) => x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
  const deadline = Number.isFinite(t.reportDueAt) ? ` Mandatory performance report due ${new Date(t.reportDueAt).toISOString().slice(0, 10)}.` : '';
  // A trial with a confirmed schedule exports every session as its
  // own timed event in the organiser's zone (`DTSTART;TZID=`), from the
  // current revision only. A cancelled trial exports its sessions as
  // CANCELLED rather than silently vanishing from a calendar that already
  // holds them. The exact address and instructions are the club's own.
  if (t.schedule && Array.isArray(t.schedule.sessions) && t.schedule.sessions.length) {
    const tz = t.schedule.timezone;
    const cancelled = t.completion?.state === 'cancelled';
    // An unconfirmed revision is TENTATIVE: the club can hold the slots, the
    // calendar says the family has not yet agreed to them.
    const status = cancelled ? 'CANCELLED' : t.schedule.confirmedAt ? 'CONFIRMED' : 'TENTATIVE';
    // DTSTAMP from the first READABLE clock, so a row with none never throws
    // inside toISOString.
    const stampMs = readInstant(t.schedule.confirmedAt) ?? readInstant(t.schedule.proposedAt) ?? readInstant(t.acceptedAt) ?? Date.now();
    const stamp = new Date(stampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const events = t.schedule.sessions.slice().sort((a, b) => (a.startsAt - b.startsAt) || String(a.id).localeCompare(String(b.id))).flatMap((s) => {
      const where = s.venue ? [s.venue.name, s.venue.address, s.venue.town].filter(Boolean).join(', ') : (t.venue ?? null);
      return [
        'BEGIN:VEVENT', `UID:${t.id}-${s.id}@scoutbox`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${tz}:${trialIcsLocal(s.startsAt, tz)}`, `DTEND;TZID=${tz}:${trialIcsLocal(s.endsAt, tz)}`,
        `SEQUENCE:${Number(t.schedule.revision) || 1}`,
        `STATUS:${status}`,
        `SUMMARY:${trialIcsText(`ScoutBox trial (${s.kind ?? 'session'}) — ${t.playerName ?? 'removed player'}${cancelled ? ' — CANCELLED' : ''}`)}`,
        `DESCRIPTION:${trialIcsText(`${s.instructions || t.notes || 'Trial session'}.${deadline}`)}`,
        where ? `LOCATION:${trialIcsText(where)}` : null,
        'END:VEVENT',
      ].filter(Boolean);
    });
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ScoutBox//Trials//EN', ...events, 'END:VCALENDAR'].join('\r\n');
    return res.set('Content-Type', 'text/calendar').send(ics);
  }
  // Without any schedule (a date-only invitation, or an acceptance of an
  // undated one) the export is honest: the accepted day as an all-day event,
  // and nothing invented about a time or a venue. A stored date that is not
  // a calendar day is refused as what it is — never a 500, never a
  // fabricated day. A missing deadline is simply not stated.
  const day = parseTrialDate(t.proposedDate);
  if (!day.ok) return res.status(422).json({ error: 'TRIAL_DATE_INVALID', message: 'This trial was recorded with a date that is not a calendar day; postpone it to a valid day to export it.', expected: day.expected });
  const startAt = day.t ?? (Number.isFinite(t.acceptedAt) ? t.acceptedAt : null);
  if (startAt === null) return res.status(422).json({ error: 'TRIAL_DATE_INVALID', message: 'This trial has no usable date to export.' });
  const start = new Date(startAt).toISOString().slice(0, 10).replace(/-/g, '');
  // RFC 5545 text: backslash, semicolon, comma and line breaks are escaped so
  // no stored text can begin a new calendar line.
  const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ScoutBox//Trials//EN', 'BEGIN:VEVENT',
    `UID:${t.id}@scoutbox`, `DTSTART;VALUE=DATE:${start}`,
    `SUMMARY:${icsText(`ScoutBox trial — ${t.playerName ?? 'removed player'}`)}`,
    `DESCRIPTION:${icsText(t.notes || 'Assessment trial')}.${deadline}`,
    t.venue ? `LOCATION:${icsText(t.venue)}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  res.set('Content-Type', 'text/calendar').send(ics);
});

// Fixture-graph scouting: verified attendances form a map of real fixtures.
orgRouter.get('/fixtures', (req, res) => {
  // Paged by cursor in SQL ({ items, nextCursor }): the (fixture, date) groups, newest date first.
  let page;
  try { page = readPage(req.query, ['string', 'string']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = players.fixturePage(req.org, page);
  res.json({
    items: items.map((g) => ({ fixture: g.fixture, venue: g.venue, date: g.date, players: g.players.map((p) => ({ id: p.id, name: p.name, position: p.position, age: ageOn(p.dob), trustScore: p.profileSignal })) })),
    nextCursor,
  });
});

// The club's Requests and Trials lists, newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
// The home dashboards read their figures from /org/recruitment-counts, never by counting a page.
orgRouter.get('/requests', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  res.json(recruitment.requests.pageForOrg(req.org.id, page));
});

orgRouter.get('/trials', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  res.json(recruitment.trials.pageForOrg(req.org.id, page));
});

// The Pro and Grassroots home figures: pending requests, trials awaiting a report, and every trial on record.
orgRouter.get('/recruitment-counts', (req, res) => {
  res.json({
    requestsPending: recruitment.requests.countForOrgStatus(req.org.id, 'pending'),
    trialsAwaitingReport: recruitment.trials.countForOrgStatus(req.org.id, 'awaiting_report'),
    trials: recruitment.trials.countForOrg(req.org.id),
  });
});

// Trial Performance Reports — mandatory, complete or rejected.
orgRouter.post('/trials/:trialId/report', (req, res) => {
  const trial = onlyIf(recruitment.trials.byId(req.params.trialId), (x) => x.orgId === req.org.id);
  if (!trial) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
  if (trial.status === 'reported') return res.status(409).json({ error: 'ALREADY_REPORTED' });
  // The subject removed their account. There is no profile for the
  // report to land on and nobody to deliver feedback to; the tombstone keeps
  // what happened, and nothing new is written about a person who left.
  if (trial.subjectRemovedAt || !findPlayer(trial.playerId)) {
    return res.status(409).json({ error: 'TRIAL_SUBJECT_REMOVED', message: 'This player removed their ScoutBox account. The trial stays on record; no report can be filed for it.' });
  }

  const check = validateTrialReport(req.body);
  if (!check.ok) {
    return res.status(400).json({
      error: 'REPORT_INCOMPLETE',
      message: 'Trial performance reports are mandatory and must be complete. Partial reports are rejected.',
      requiredFields: TRIAL_REPORT_FIELDS,
      missing: check.missing,
      invalid: check.invalid,
    });
  }

  // Optional development feedback for the player — one strength, one focus
  // area. Moderated like everything else, and delivered even when the trial
  // doesn't lead anywhere: the player always gets something back.
  const { strengthNote, focusNote } = req.body || {};
  if (strengthNote && !moderateOrRefuse(res, strengthNote, { kind: 'trial_feedback', orgId: req.org.id })) return;
  if (focusNote && !moderateOrRefuse(res, focusNote, { kind: 'trial_feedback', orgId: req.org.id })) return;

  const report = {
    id: nextId('rep'),
    trialId: trial.id,
    playerId: trial.playerId,
    orgId: req.org.id,
    orgName: req.org.name,
    userId: req.orgUser.id,
    scoutName: req.orgUser.name,
    filedAt: Date.now(),
    ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [f, req.body[f]])),
    notes: req.body.notes || '',
    strengthNote: strengthNote || null,
    focusNote: focusNote || null,
  };
  // Filed reports raise Trust Score (institutional corroboration). The
  // player's `trialReports` is DERIVED from the trials: the report written on
  // the trial is what the profile serves, in filing order — no copy is pushed
  // onto the player. The report and its ledger row commit together.
  const p = findPlayer(trial.playerId);
  unit(() => {
    recruitment.trials.fileReport(trial.id, { report });
    ledgerAppend({ type: 'trial_report', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  });
  // The mandatory report closes the club's obligation even while
  // the family has blocked the club, but the block stands — no notification
  // reaches the player or guardian from a blocked club. The report is still
  // on the profile when they look.
  if (!isBlocked(p.id, req.org.id)) {
    notify({ kind: 'player', id: p.id }, 'trial_report', `${req.org.name} filed your trial report${report.strengthNote ? ' — with development feedback' : ''}. It's on your profile.`, report.id);
    if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'trial_report', `${req.org.name} filed the trial report for ${p.name}.`, report.id);
  }
  broadcast('players', { playerId: p.id });
  res.status(201).json({ ok: true, report, playerTrustScore: computeTrustScore(p) });
});

// The revenue event, completed: recording a signing updates the player's
// timeline + contract, freezes the attribution evidence from the Proof Pack,
// and notifies the player (and guardian for minors).
orgRouter.post('/players/:id/signing', (req, res) => {
  // The LEGACY recording route, kept for clients that do not use the signing
  // workflow. It writes nothing itself: the completed-signing record and
  // every side effect come from the ONE writer (signingsDomain), and a recruitment
  // that went through the canonical Offer cannot be short-circuited here — an
  // accepted Offer or a signing package between this club and player means
  // the signing workflow on the case owns the outcome.
  // Recording a joining is a CLUB's act and a lead's act.
  // An agency has no squad to sign a player into, and a scout could not
  // complete the canonical workflow either; the same authority applies here.
  if (req.org.type === 'agency' || req.org.level === 'agent') return res.status(403).json({ error: 'SIGNING_NOT_PERMITTED', message: 'Only a club records a signing.' });
  if (!isLeadRole(req.orgUser?.role)) return res.status(403).json({ error: 'LEAD_REQUIRED', message: 'Only recruitment leads and directors can record a signing.' });
  const p = findPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
  if (isBlocked(p.id, req.org.id)) return res.status(403).json({ error: 'BLOCKED' });
  const blocker = signingsDomain?.legacyRecordingBlocker?.(p.id, req.org.id, Date.now());
  if (blocker) return res.status(409).json({ ok: false, error: blocker.error, message: blocker.message });
  // ONE standing legacy row per club and player. A second
  // recording while one stands (not cancelled, voided or revoked) would be a
  // second signing row, a second invoice and a second set of notifications for
  // one joining — the same invariant the canonical workflow keeps per package
  // and per Offer. The route also draws on the canonical closure budget, so it
  // is not an unmetered alias of `/signings/:id/complete`.
  const standing = signingsFollowUps.signings.forOrgPlayer(req.org.id, p.id).find((s) => !s.signingPackageId && !s.cancelledAt && !s.revokedAt && !s.voidedAt);
  if (standing) return res.status(409).json({ ok: false, error: 'SIGNING_ALREADY_RECORDED', message: 'A signing of this player by your club is already on record.', signingId: standing.id });
  if (rateLimit.limited('signing_closure', req.org.id)) return res.status(429).json(rateLimitedBody('signing_closure'));
  if (!signingsDomain?.recordCompletedSigning) return res.status(500).json({ error: 'SIGNING_STORE_MISSING' });
  // The ledger row, the signings row and the player's level / contract columns commit as one unit of work.
  // Typed input only — a note is text of at most 400 characters, or absent; never sliced.
  const legacyNote = req.body?.note;
  if (legacyNote !== undefined && legacyNote !== null && legacyNote !== '' && (typeof legacyNote !== 'string' || legacyNote.length > 400)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'note', message: 'The note is text of at most 400 characters.' });
  let written;
  try {
    written = unit(() => signingsDomain.recordCompletedSigning({ player: p, org: req.org, actor: req.orgUser, at: Date.now(), legacy: { note: typeof legacyNote === 'string' && legacyNote ? legacyNote : null } }));
  } catch (e) {
    console.error(`SIGNING legacy_recording_rolled_back ${p.id}: ${e?.message ?? e}`);
    return res.status(500).json({ ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'The signing could not be recorded; nothing was recorded.' });
  }
  const { signing, effects } = written;
  try { effects?.(); } catch (e) { console.error(`SIGNING legacy side_effect_failed: ${e?.message ?? e}`); }
  res.status(201).json({ ok: true, signing });
});

// Newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }. No app reads this list yet; one
// that does will need a "load more" (product decision: no load-more UI yet).
orgRouter.get('/signings', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  res.json(signingsFollowUps.signings.pageForOrg(req.org.id, page));
});

// The organisation's invoices, newest first, by cursor (`?limit=&cursor=`); the apps read the first page.
orgRouter.get('/invoices', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = operations.invoices.pageForOrg(req.org.id, page);
  res.json({ items: items.map(invoiceView), nextCursor });
});

// ------------------------------------------- open trial days (grassroots)
function grassrootsOrgOnly(req, res) {
  if (req.org.level !== 'grassroots') {
    res.status(403).json({ error: 'GRASSROOTS_ORGS_ONLY', message: 'Open days are a ScoutBox Grassroots feature.' });
    return true;
  }
  return false;
}

// Open days, match days and friendlies are rows of repositories/grassroots.mjs; responses are built from these
// allowlists. A club's name is read live (not a copy taken when it posted).
const GL = GRASSROOTS_LIMITS;
const orgNameOf = (orgId) => byId.org(orgId)?.name ?? null;
const registrationView = (r) => ({
  id: r.id, playerId: r.playerId, playerName: r.playerName, byGuardian: r.byGuardian, ...(r.guardianId ? { guardianId: r.guardianId } : {}),
  ts: r.ts, outcome: r.outcome, outcomeNote: r.outcomeNote, outcomeAt: r.outcomeAt,
});
const openTrialView = (t) => ({
  id: t.id, orgId: t.orgId, orgName: orgNameOf(t.orgId), title: t.title, date: t.date, venue: t.venue, ageGroup: t.ageGroup,
  positions: [...t.positions], notes: t.notes, createdByUserId: t.createdByUserId, createdAt: t.createdAt,
});
const fieldInvalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
/** The positions an open day asks for: absent is none; otherwise a list of at most 20 short texts (repeats dropped). */
function openDayPositions(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > GL.positions || !v.every((x) => typeof x === 'string' && x.trim() && x.trim().length <= GL.position)) return null;
  return [...new Set(v.map((x) => x.trim()))];
}

orgRouter.post('/open-trials', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  // The no-ghosting rule: nobody — least of all a kid at their first session —
  // leaves an open day without an answer. Unresolved past registrants block
  // the next posting, the same way unfiled trial reports block new trials.
  const today = new Date().toISOString().slice(0, 10);
  const unresolved = grassroots.openTrials.unresolvedBefore(req.org.id, today);
  if (unresolved > 0) {
    return res.status(409).json({
      error: 'OUTCOMES_OUTSTANDING',
      message: `${unresolved} player(s) from your past open day(s) are still waiting for an answer. Resolve them (invite or a kind no) before posting the next one.`,
    });
  }
  const { title, date, venue, ageGroup, positions, notes } = req.body || {};
  if (!reqText(title, GL.title) || !date || !reqText(venue, GL.venue)) return res.status(400).json({ error: 'TITLE_DATE_VENUE_REQUIRED' });
  if (!optText(ageGroup, GL.ageGroup)) return badField(res, 'ageGroup');
  if (!optText(notes, GL.notes)) return badField(res, 'notes');
  // The open-day date gates the no-ghosting rule above (`date < today`) and
  // the upcoming lists (`date >= today`) by string comparison, so it must be
  // a real day: other text would compare as "upcoming for ever" and never
  // become a past day whose registrants are owed an answer.
  if (!dateOnlyOrRefuse(res, date, 'date')) return;
  const wanted = openDayPositions(positions); // junk is refused, never filtered or cut off
  if (!wanted) return fieldInvalid(res, 'positions', `positions is a list of at most ${GL.positions} positions, each text of at most ${GL.position} characters.`);
  if (notes && !moderateOrRefuse(res, notes, { kind: 'open_trial_notes', orgId: req.org.id })) return;
  const trial = unit(() => {
    const t = grassroots.openTrials.create({
      id: nextId('open'), orgId: req.org.id, title: title.trim(), date, venue: venue.trim(),
      ageGroup: ageGroup?.trim() || 'open', positions: wanted, notes: notes || '', createdByUserId: req.orgUser.id, createdAt: Date.now(),
      deletedAt: null, registrations: [],
    });
    ledgerAppend({ type: 'open_trial_posted', playerId: null, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    return t;
  });
  broadcast('openTrials');
  res.status(201).json({ openTrial: { ...openTrialView(trial), registrations: [] } });
});

/** The club's open days, newest first, a page at a time (the apps read the first page). */
orgRouter.get('/open-trials', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = grassroots.openTrials.pageForOrg(req.org.id, page);
  // Registration lists respect visibility: a club that cannot see a minor
  // never received their registration in the first place.
  res.json({
    items: items.map((t) => ({
      ...openTrialView(t),
      registrations: t.registrations.map((r) => {
        const p = findPlayer(r.playerId);
        const view = p ? playerViewForOrg(p, req.org) : null;
        return { ...registrationView(r), age: view?.age ?? null, position: view?.position ?? null, trustScore: view?.trustScore ?? null, guardianManaged: !!view?.guardianManaged };
      }),
    })),
    nextCursor,
  });
});

// Deleting stamps the open day; it leaves every list (a coverage assignment naming it keeps its key).
orgRouter.delete('/open-trials/:id', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  if (!grassroots.openTrials.remove(req.org.id, req.params.id, Date.now())) return res.status(404).json({ error: 'OPEN_TRIAL_NOT_FOUND' });
  broadcast('openTrials');
  res.json({ deleted: true });
});

// What the club is looking for — powers the players' opportunity radar.
// Position codes only (the radar matches them against the player's position), at most five; an explicit write.
orgRouter.post('/looking-for', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const positions = req.body?.positions;
  if (!Array.isArray(positions) || positions.length > CLUB_SETUP_LIMITS.lookingFor) return res.status(400).json({ error: 'FIELD_INVALID', field: 'positions', message: `positions is a list of at most ${CLUB_SETUP_LIMITS.lookingFor} position codes.` });
  const wrong = positions.findIndex((p) => !LOOKING_FOR_POSITIONS.includes(p));
  if (wrong >= 0) return res.status(400).json({ error: 'FIELD_INVALID', field: `positions[${wrong}]`, message: `Use position codes: ${LOOKING_FOR_POSITIONS.join(', ')}.` });
  const lookingFor = clubSetup.lookingFor.set(req.org.id, [...new Set(positions)]);
  broadcast('orgs');
  res.json({ lookingFor });
});

// Every open-day registrant gets an answer: an invitation (which creates a
// real, properly-routed trial request) or a kind no.
orgRouter.post('/open-trials/:id/registrations/:regId/outcome', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const trial = grassroots.openTrials.forOrgById(req.org.id, req.params.id);
  const reg = trial?.registrations.find((r) => r.id === req.params.regId);
  if (!trial || !reg) return res.status(404).json({ error: 'REGISTRATION_NOT_FOUND' });
  if (reg.outcome) return res.status(409).json({ error: 'ALREADY_RESOLVED' });
  const { outcome, note } = req.body || {};
  if (!['invite_trial', 'declined'].includes(outcome)) return res.status(400).json({ error: 'OUTCOME_INVALID' });
  if (!optText(note, 10_000)) return badField(res, 'note');
  if (note && !moderateOrRefuse(res, note, { kind: 'open_day_outcome', orgId: req.org.id })) return;
  const outcomeNote = note?.trim() ? note.trim().slice(0, GL.outcomeNote) : null;
  const p = findPlayer(reg.playerId);
  // ONE unit of work: the answer, the trial request it may raise and the notifications commit together.
  const answered = unit(() => {
    const r = grassroots.openTrials.resolve(trial.id, reg.id, { outcome, note: outcomeNote, at: Date.now() });
    if (p && visibleToOrg(p, req.org)) {
      if (outcome === 'invite_trial') {
        // Through THE request writer: the same row, routing (guardian-first for a
        // minor), ledger entry and inbox ping as every other trial invitation;
        // only the notifications are worded for the open day. Several pending
        // invitations per player stay allowed (product decision).
        issueRecruitmentRequest({
          org: req.org, orgUser: req.orgUser, player: p, type: 'trial',
          message: outcomeNote || `We liked what we saw at "${trial.title}" — come for a proper trial.`,
          trialDetails: { proposedDate: null, altSlots: [], venue: trial.venue, notes: `Follow-up from open day "${trial.title}".` },
          notice: {
            kind: 'open_trial',
            toGuardian: `Good news: ${req.org.name} would like to invite ${p.name} for a trial after the open day.`,
            toPlayer: isAdult(p)
              ? `${req.org.name} liked what they saw at "${trial.title}" — trial invitation in your inbox.`
              : `${req.org.name} liked what they saw at the open day — they've contacted your parent/guardian about a trial.`,
          },
        });
      } else {
        const kindNo = outcomeNote || 'Thanks for coming — not this time, but keep playing and keep logging your football.';
        if (!isAdult(p) && p.guardianId) {
          notify({ kind: 'guardian', id: p.guardianId }, 'open_trial', `${req.org.name} on ${p.name}'s open day: ${kindNo}`, trial.id);
        }
        notify({ kind: 'player', id: p.id }, 'open_trial', `${req.org.name}: ${kindNo}`, trial.id);
      }
    }
    return r;
  });
  broadcast('openTrials');
  res.json({ registration: registrationView(answered) });
});

// ----------------------------------------------- squad + match-day logging
// The club's own players in one place — and one Saturday action that gives
// the whole squad verified, coach-signed attendance.
const POSITION_GROUPS = { GK: ['GK'], DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'], MID: ['CDM', 'CM', 'CAM'], ATT: ['ST', 'CF', 'RW', 'LW'] };

// The squad is rows of org_squad_members; a club's shadow list (the Pro squad planner) is never part of it.
function squadView(org) {
  const entries = clubSetup.squad.forOrg(org.id).map((e) => {
    const p = e.playerId ? findPlayer(e.playerId) : null;
    return { id: e.id, name: e.name, position: e.position, playerId: e.playerId, source: e.source, ...(e.approvedBy ? { approvedBy: e.approvedBy } : {}), addedAt: e.addedAt, onPlatform: !!p, trustScore: p ? computeTrustScore(p) : null };
  });
  const coverage = Object.fromEntries(Object.entries(POSITION_GROUPS).map(([group, positions]) => [
    group, entries.filter((e) => positions.includes(e.position)).length,
  ]));
  const gaps = Object.entries(coverage).filter(([, n]) => n < 2).map(([g]) => g);
  const suggestedLookingFor = gaps.flatMap((g) => POSITION_GROUPS[g].slice(0, 2)).slice(0, 5);
  return { entries, coverage, gaps, suggestedLookingFor };
}

orgRouter.get('/squad', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  res.json(squadView(req.org));
});

orgRouter.post('/squad', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const { name, position, playerId } = req.body || {};
  if (!reqText(name, 120)) return res.status(400).json({ error: 'NAME_REQUIRED' });
  if (!optText(position, 40)) return badField(res, 'position');
  if (!optText(playerId, 80)) return badField(res, 'playerId');
  if (playerId) {
    const p = findPlayer(playerId);
    if (!p || !visibleToOrg(p, req.org)) return res.status(403).json({ error: 'PLAYER_NOT_VISIBLE' });
    if (clubSetup.squad.has(req.org.id, playerId)) return res.status(409).json({ error: 'ALREADY_ON_SQUAD' });
  }
  clubSetup.squad.create({ id: nextId('sq'), orgId: req.org.id, name: String(name).trim(), position: position || null, playerId: playerId || null, source: 'manual', addedAt: Date.now() });
  res.status(201).json(squadView(req.org));
});

// Release with a reference: the worst moment in grassroots football, done
// properly — availability restored, and optionally a club-authored reference
// published on the way out (club identity is already authenticated).
orgRouter.post('/squad/:entryId/release', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const entry = clubSetup.squad.byId(req.params.entryId);
  if (!entry || entry.orgId !== req.org.id) return res.status(404).json({ error: 'SQUAD_ENTRY_NOT_FOUND' });
  const raw = (req.body || {}).referenceText;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field: 'referenceText', message: 'The reference is text.' });
  const referenceText = raw ? raw.trim().slice(0, TRANSITION_LIMITS.text) : '';
  if (referenceText && !moderateOrRefuse(res, referenceText, { kind: 'release_reference', orgId: req.org.id })) return;
  // ONE unit of work: the squad row, the player's availability and contract
  // columns, the published reference, the ledger row and the notifications
  // commit together; the pushes and the broadcast go out after COMMIT.
  unit(() => {
    clubSetup.squad.remove(entry.id);
    const p = entry.playerId ? findPlayer(entry.playerId) : null;
    if (p) {
      // Releasing a player from THIS club's squad does not speak
      // for a contract another club completed in ScoutBox. The squad row goes;
      // the canonical contract truth stays with its writer.
      const other = canonicalContractFor(p.id, Date.now(), { exceptOrgId: req.org.id });
      if (!other) players.setAvailability(p.id, { availability: 'available_now', contractStatus: 'free_agent' });
      seam('squad.release.after_row');
      if (referenceText) {
        // A row of vouches, published at once (the club's identity is the session; no email, no code).
        transitionsVouches.vouches.create({
          id: nextId('vch'), playerId: p.id, playerName: p.name?.slice(0, TRANSITION_LIMITS.name) ?? null,
          coachName: req.orgUser.name.slice(0, TRANSITION_LIMITS.coachName), coachEmail: null, role: `${req.orgUser.role || 'Manager'}, ${req.org.name}`.slice(0, TRANSITION_LIMITS.role),
          status: 'published', codeHash: null, text: referenceText,
          seasons: null, ts: Date.now(), publishedAt: Date.now(), conflictOfInterest: null, withdrawn: null,
        });
      }
      ledgerAppend({ type: 'released_by_club', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
      notify({ kind: 'player', id: p.id }, 'released',
        `${req.org.name} has released you${referenceText ? ' — with a reference now on your profile' : ''}. You're marked available to every local club; the First Team Seeker flag is yours to switch on.`, p.id);
      if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'released', `${req.org.name} released ${p.name}${referenceText ? ' with a reference' : ''}. Their profile is marked available again.`, p.id);
      broadcast('players', { playerId: p.id });
    }
  });
  res.json(squadView(req.org));
});

orgRouter.post('/matchday', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const { fixture, venue, date, result, playerIds } = req.body || {};
  if (!fixture || !date) return res.status(400).json({ error: 'FIXTURE_AND_DATE_REQUIRED' });
  if (!reqText(fixture, GL.fixture)) return fieldInvalid(res, 'fixture', `fixture is text of at most ${GL.fixture} characters.`);
  if (!optText(venue, GL.venue)) return fieldInvalid(res, 'venue', `venue is text of at most ${GL.venue} characters.`);
  if (!optText(result, GL.result)) return fieldInvalid(res, 'result', `result is text of at most ${GL.result} characters (e.g. 3-1).`);
  if (!dateOnlyOrRefuse(res, date, 'date')) return; // a match day is a day that exists
  const ids = playerIds === undefined || playerIds === null ? [] : playerIds;
  if (!Array.isArray(ids) || ids.length > GL.matchdayPlayers || !ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= GL.id)) {
    return fieldInvalid(res, 'playerIds', `playerIds is a list of at most ${GL.matchdayPlayers} player ids.`);
  }
  const onSquad = new Set(clubSetup.squad.playerIds(req.org.id)); // the squad only, never the shadow list
  const credited = [];
  const fixtureText = fixture.trim();
  // ONE unit of work: every credited player's attendance row and activity,
  // the match-day row and the ledger row commit together.
  unit(() => {
    for (const pid of new Set(ids)) { // a player listed twice is credited once
      if (!onSquad.has(pid)) continue; // only your own rostered players
      const p = findPlayer(pid);
      if (!p || !visibleToOrg(p, req.org)) continue;
      players.addItem(p.id, 'attendance', {
        id: nextId('att'), fixture: fixtureText, venue: venue?.trim() || req.org.location?.city || '',
        date, gps: req.org.location ? { lat: req.org.location.lat, lng: req.org.location.lng } : null,
        verified: true, corroboratedBy: req.org.name, // coach counter-signature
      });
      recordActivity(p);
      notify({ kind: 'player', id: p.id }, 'matchday', `📍 ${req.org.name} logged your appearance in "${fixtureText}" — verified, coach-signed attendance on your profile.`, p.id);
      credited.push(p.id);
      broadcast('players', { playerId: p.id });
    }
    grassroots.matchdays.create({
      id: nextId('md'), orgId: req.org.id, fixture: fixtureText, venue: venue?.trim() ?? '',
      date, result: result?.trim() || null, playerIds: credited, loggedByUserId: req.orgUser.id, ts: Date.now(),
    });
    ledgerAppend({ type: 'matchday_logged', playerId: null, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
  });
  res.status(201).json({ credited: credited.length, matchdays: grassroots.matchdays.countForOrg(req.org.id) });
});

/** The club's match days, newest first, a page at a time (the apps read the first page). */
orgRouter.get('/matchdays', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const { items, nextCursor } = grassroots.matchdays.pageForOrg(req.org.id, page);
  res.json({
    items: items.map((m) => ({ id: m.id, orgId: m.orgId, fixture: m.fixture, venue: m.venue, date: m.date, result: m.result, playerIds: [...m.playerIds], loggedByUserId: m.loggedByUserId, ts: m.ts })),
    nextCursor,
  });
});

// --------------------------------------------------- pathway club record
// Grassroots reputation currency: not resale multiples — players developed.
function pathwayRecord(org) {
  const orgSignings = signingsFollowUps.signings.forOrg(org.id);
  const registrants = grassroots.openTrials.registrantsOf(org.id);
  const involvedIds = new Set([
    ...orgSignings.map((sg) => sg.playerId),
    ...clubSetup.squad.playerIds(org.id),
    ...registrants.map((r) => r.playerId),
  ]);
  const firstInvolvement = (pid) => Math.min(
    ...orgSignings.filter((sg) => sg.playerId === pid).map((sg) => sg.ts),
    ...registrants.filter((r) => r.playerId === pid).map((r) => r.ts),
  );
  const progressed = [...involvedIds].filter((pid) => {
    const upward = signingsFollowUps.signings.forPlayer(pid).find((sg) => sg.orgId !== org.id && (byId.org(sg.orgId)?.level ?? '') !== 'grassroots');
    return upward && upward.ts > firstInvolvement(pid);
  });
  return { progressed: progressed.length, pathwayClub: progressed.length >= 1 };
}

orgRouter.get('/pathway-record', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  res.json({
    ...pathwayRecord(req.org),
    openDaysRun: grassroots.openTrials.countForOrg(req.org.id),
    matchdaysLogged: grassroots.matchdays.countForOrg(req.org.id),
    note: 'Progressed = players your club signed or hosted who later signed for an academy or pro club. Development is the reputation that matters here.',
  });
});

// Federation-route verification: real Sunday-league clubs run on free email —
// they prove themselves through their federation registration instead, and
// Trust & Safety checks the record.
orgRouter.post('/verification/federation', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const { federation, registrationId, contactEmail } = req.body || {};
  if (!federation || !registrationId) return res.status(400).json({ error: 'FEDERATION_REQUIRED' });
  // Typed and refused at the route (FIELD_INVALID naming the field); one row per club, replaced on resubmission.
  if (!reqText(federation, CLUB_SETUP_LIMITS.federation)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'federation', message: `federation is text of at most ${CLUB_SETUP_LIMITS.federation} characters.` });
  if (!reqText(registrationId, CLUB_SETUP_LIMITS.registrationId)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'registrationId', message: `registrationId is text of at most ${CLUB_SETUP_LIMITS.registrationId} characters.` });
  const email = typeof contactEmail === 'string' ? contactEmail.trim() : contactEmail;
  if (!(email === undefined || email === null || email === '' || (typeof email === 'string' && email.length <= CLUB_SETUP_LIMITS.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) return res.status(400).json({ error: 'FIELD_INVALID', field: 'contactEmail', message: 'contactEmail is an e-mail address.' });
  clubSetup.federation.submit({ orgId: req.org.id, federation: federation.trim(), registrationId: registrationId.trim(), contactEmail: email || null, status: 'pending', submittedAt: Date.now() });
  broadcast('orgs');
  res.status(201).json({
    submitted: true,
    note: 'Trust & Safety cross-checks the registration with your federation. Verification (and with the safeguarding contract, U18 visibility) follows their approval.',
  });
});

// ---------------------------------------------------- friendlies board
// Club-to-club, same 50km radius: trial matches are how grassroots scouting
// actually happens — and a reason to open the app between transfer windows.
const friendlyView = (f, viewer) => {
  const other = byId.org(f.orgId);
  const mine = f.orgId === viewer.id;
  return {
    id: f.id, orgId: f.orgId, orgName: other?.name ?? null, postedByUserId: f.postedByUserId, ageGroup: f.ageGroup, date: f.date,
    venue: f.venue, notes: f.notes, status: 'open', createdAt: f.createdAt, mine,
    distanceKm: mine || !other?.location || !viewer.location ? 0 : Math.round(haversineKm(other.location, viewer.location) * 10) / 10,
    // responder details only for the poster
    responses: f.responses.map((r) => ({ orgId: r.orgId, orgName: orgNameOf(r.orgId), message: mine ? r.message : '', respondedByUserId: r.respondedByUserId, ts: r.ts })),
  };
};

orgRouter.post('/friendlies', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const { ageGroup, date, venue, notes } = req.body || {};
  if (!date) return res.status(400).json({ error: 'DATE_REQUIRED' });
  for (const [f, v, max] of [['ageGroup', ageGroup, GL.ageGroup], ['venue', venue, GL.venue], ['notes', notes, GL.notes]]) if (!optText(v, max)) return badField(res, f);
  if (!dateOnlyOrRefuse(res, date, 'date')) return;
  if (notes && !moderateOrRefuse(res, notes, { kind: 'friendly_notes', orgId: req.org.id })) return;
  const friendly = grassroots.friendlies.create({
    id: nextId('fr'), orgId: req.org.id, postedByUserId: req.orgUser.id,
    ageGroup: ageGroup?.trim() || 'open', date, venue: venue?.trim() || (req.org.location?.city ?? '').slice(0, GL.venue),
    notes: notes || '', responses: [], createdAt: Date.now(),
  });
  broadcast('friendlies');
  res.status(201).json({ friendly: friendlyView(friendly, req.org) });
});

/** The local board: the club's own friendlies and those posted within the radius, by match date, a page at a time. */
orgRouter.get('/friendlies', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  let page;
  try { page = readPage(req.query, ['string', 'string']); } catch (e) { return sendPageError(res, e); }
  const here = req.org.location;
  const box = here ? boxAround(here, GRASSROOTS_RADIUS_KM) : null;
  const near = (f) => { const loc = byId.org(f.orgId)?.location; return !!loc && haversineKm(loc, here) <= GRASSROOTS_RADIUS_KM; };
  const { items, nextCursor } = grassroots.friendlies.boardPage(req.org.id, box, page, near);
  res.json({ items: items.map((f) => friendlyView(f, req.org)), nextCursor });
});

orgRouter.post('/friendlies/:id/respond', (req, res) => {
  if (grassrootsOrgOnly(req, res)) return;
  const friendly = grassroots.friendlies.byId(req.params.id);
  if (!friendly) return res.status(404).json({ error: 'FRIENDLY_NOT_FOUND' });
  if (friendly.orgId === req.org.id) return res.status(400).json({ error: 'OWN_POST' });
  const { message } = req.body || {};
  if (!optText(message, 10_000)) return badField(res, 'message');
  if (message && !moderateOrRefuse(res, message, { kind: 'friendly_response', orgId: req.org.id })) return;
  if (friendly.responses.some((r) => r.orgId === req.org.id)) return res.status(409).json({ error: 'ALREADY_RESPONDED' });
  // ONE unit of work: the response and the poster's notification commit together.
  unit(() => {
    grassroots.friendlies.respond(friendly.id, { orgId: req.org.id, message: message ? message.trim().slice(0, GL.message) : '', respondedByUserId: req.orgUser.id, ts: Date.now() });
    notify({ kind: 'org_user', id: friendly.postedByUserId }, 'friendly', `${req.org.name} is up for your friendly on ${friendly.date}.`, friendly.id);
  });
  broadcast('friendlies');
  res.status(201).json({ responded: true });
});

// ------------------------------------------------------ recruitment funnel
// The club's whole pipeline computed from the ledger — every stage is a real
// recorded event, so the numbers are the numbers.
orgRouter.get('/funnel', (req, res) => {
  const byType = safetyAudit.ledger.countsForOrg(req.org.id);
  const count = (type) => Object.entries(byType).reduce((n, [t, c]) => n + (t.startsWith(type) ? c : 0), 0);
  res.json({
    stages: [
      { key: 'views', label: 'Profile views', count: count('view') },
      { key: 'saves', label: 'Saves', count: count('save') },
      { key: 'shortlists', label: 'Shortlists', count: count('shortlist') },
      { key: 'requests', label: 'Requests sent', count: recruitment.requests.countForOrg(req.org.id) },
      { key: 'accepted', label: 'Requests accepted', count: recruitment.requests.countForOrgStatus(req.org.id, 'accepted') },
      { key: 'trials', label: 'Trials booked', count: recruitment.trials.countForOrg(req.org.id) },
      { key: 'reports', label: 'Reports filed', count: recruitment.trials.countForOrgStatus(req.org.id, 'reported') },
      { key: 'signings', label: 'Signings', count: signingsFollowUps.signings.countForOrg(req.org.id) },
    ],
    byScout: safetyAudit.ledger.topActorsForOrg(req.org.id, 8),
  });
});

// -------------------------------------------- club email-domain verification
// Verification stops being an attestation: the club proves control of a
// company mailbox. Free-mail domains are refused outright.
const FREE_MAIL = /@(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn)\./i;

orgRouter.post('/verification/email', async (req, res) => {
  const { email } = req.body || {};
  if (!reqText(email, 254) || !email.includes('@')) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  if (FREE_MAIL.test(email)) {
    return res.status(422).json({
      error: 'COMPANY_EMAIL_REQUIRED',
      message: 'Free email providers don\'t prove domain control. No club domain? Use federation verification instead — your federation registration is checked by Trust & Safety.',
    });
  }
  // Every request sends a mail, so requests are bounded per organisation.
  if (rateLimit.limited('email_challenge_request', req.org.id)) return res.status(429).json(rateLimitedBody('email_challenge_request'));
  // The challenge is a row of email_challenges (stored as a hash; 30-minute
  // lifetime; one live challenge per organisation, the previous one replaced),
  // durable BEFORE the mail is sent. The plain code exists in the issue result
  // and in the mail only: `secrets` makes the persisted outbox record withhold
  // it while the recipient's mail carries it. A mail that fails to send leaves
  // the row (it expires; a re-request replaces it).
  const { code } = codes.issueEmailChallenge(req.org.id, email);
  await mailer.send({
    to: email,
    subject: `Verify ${req.org.name} on ScoutBox`,
    text: `Your ScoutBox club verification code is ${code}.\n\nEntering it confirms ${req.org.name} controls this company mailbox — one of the safeguarding requirements before a club can see under-18 players.`,
    secrets: [code],
  });
  res.status(201).json({ sent: true, note: 'Enter the code from the mailbox to confirm domain control.' });
});

orgRouter.post('/verification/email/confirm', (req, res) => {
  const { code } = req.body || {};
  // A wrong code is charged against the organisation's confirm budget (a
  // correct one costs nothing) and counted on the challenge itself, which is
  // cancelled after EMAIL_CHALLENGE_MAX_ATTEMPTS wrong codes; the budget is
  // tested before the code is judged, so a correct guess after it is gone is
  // refused rather than rewarded (as with the failed-login budget).
  if (rateLimit.peek('email_challenge_confirm', req.org.id).remaining === 0) return res.status(429).json(rateLimitedBody('email_challenge_confirm')); // exactly `max` wrong codes are judged; the next attempt is refused
  const check = codes.checkEmailChallenge(req.org.id, code);
  if (check.status === 'none') {
    rateLimit.limited('email_challenge_confirm', req.org.id);
    return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND', message: 'Request a fresh code — none is active for this club.' });
  }
  if (check.status === 'invalid') {
    rateLimit.limited('email_challenge_confirm', req.org.id);
    const { attemptsRemaining, invalidated } = codes.noteFailedEmailAttempt(req.org.id);
    return res.status(400).json({
      error: 'CODE_INVALID',
      message: invalidated ? 'That code doesn\'t match, and this challenge is now cancelled after too many wrong codes — request a fresh one.' : 'That code doesn\'t match — check the email.',
      attemptsRemaining,
    });
  }
  // ONE unit of work: the challenge is consumed (its row deleted) and the
  // organisation's domain columns written together — a failure anywhere, the
  // real COMMIT included, keeps the challenge live and the organisation
  // unverified, and the retry lands both.
  const updated = unit(() => {
    const consumed = codes.consumeEmailChallenge(req.org.id, code);
    if (!consumed) throw new Error('email challenge: the challenge changed between the check and the confirmation');
    seam('email_challenge.confirm.after_consume');
    return orgs.update(req.org.id, (d) => { d.emailDomain = consumed.email.split('@')[1]; d.emailDomainVerified = true; });
  });
  broadcast('orgs');
  res.json({ emailDomainVerified: true, emailDomain: updated.emailDomain });
});

// ------------------------------------------------- ledger, proof, plan etc
// Newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
orgRouter.get('/ledger', (req, res) => {
  let page;
  try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
  const out = safetyAudit.ledger.pageForOrg(req.org.id, page);
  res.json({ items: out.items.map(ledgerView), nextCursor: out.nextCursor });
});

// Proof Pack: attribution evidence for this org on this player.
orgRouter.get('/players/:id/proofpack', (req, res) => {
  const p = findPlayer(req.params.id);
  if (!p || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
  const events = safetyAudit.ledger.forPlayerOrg(p.id, req.org.id).map(ledgerView);
  const first = events[0] || null;
  const windowMonths = PLANS[req.org.plan].attributionWindowMonths; // orgs.plan is one of the catalogue's plans (its CHECK)
  res.json({
    playerId: p.id,
    playerName: p.name,
    org: { id: req.org.id, name: req.org.name, plan: req.org.plan },
    firstQualifyingInteraction: first,
    attributionWindowMonths: windowMonths,
    attributionWindowEnds: first ? new Date(first.ts + windowMonths * 30.44 * 24 * 3600 * 1000).toISOString() : null,
    eventLog: events,
    generatedAt: new Date().toISOString(),
  });
});

orgRouter.get('/plan', (req, res) => {
  const plan = PLANS[req.org.plan];
  res.json({
    org: { id: req.org.id, name: req.org.name, type: req.org.type, trustedPartner: req.org.trustedPartner },
    plan,
    compliance: {
      attributionWindowMonths: plan.attributionWindowMonths,
      antiCircumvention: plan.antiCircumvention,
      feeProtection:
        'Discovery attribution is evidenced by the append-only ledger and Proof Packs. Fees attach to the first qualifying interaction inside the window.',
    },
  });
});

// Scout & Coach Reputation: seeded track records + live rows from the ledger.
orgRouter.get('/reputation', (_req, res) => {
  const live = {};
  for (const { scoutName, orgName, type, n } of safetyAudit.ledger.countsByActor()) {
    const key = `${scoutName}|${orgName}`;
    live[key] ??= { scoutName, orgName, views: 0, contacts: 0, trials: 0, signings: 0, seeded: false };
    if (type === 'view') live[key].views += n;
    if (type === 'contact_request') live[key].contacts += n;
    if (type === 'trial_request' || type === 'trial_report') live[key].trials += n;
    if (type === 'signing') live[key].signings += n;
  }
  res.json({ seeded: operations.reputationSeed.all(), live: Object.values(live) });
});

// ------------------------------------------------------------- directory
// The club directory players browse: verified identity + how clubs actually
// behave (trials run, report turnaround) — accountability as marketing.
// Paged by cursor, oldest club first (domains/platform/paging.mjs): { items, nextCursor }.
app.get('/orgs/directory', (req, res) => {
  let page;
  try { page = orgs.page({ type: 'club' }, readPage(req.query, ['number'])); } catch (e) { return sendPageError(res, e); }
  res.json({
    nextCursor: page.nextCursor,
    items: page.items.map((o) => {
      const trials = recruitment.trials.forOrg(o.id);
      const reported = trials.filter((t) => t.status === 'reported' && t.report);
      const avgReportDays = reported.length
        ? Math.round(reported.reduce((sum, t) => sum + (t.report.filedAt - t.acceptedAt), 0) / reported.length / (24 * 3600 * 1000) * 10) / 10
        : null;
      return {
        id: o.id, name: o.name, plan: o.plan, verified: o.verified,
        trustedPartner: o.trustedPartner, safeguardingCertified: safeguardingCertified(o),
        trialsRun: trials.length, reportsFiled: reported.length, avgReportDays,
        // Grassroots clubs wear their development record, not resale multiples.
        ...(o.level === 'grassroots' ? pathwayRecord(o) : {}),
      };
    }),
  });
});

// Coach reference submission: the code from the emailed request proves the
// mailbox; the text passes the same moderation screen as every message.
app.post('/vouch/submit', (req, res) => {
  const { code, text, seasons, conflictOfInterest } = req.body || {};
  const vouch = typeof code === 'string' && code.trim() ? transitionsVouches.vouches.pendingByCode(code) : null;
  if (!vouch) return res.status(404).json({ error: 'CODE_INVALID', message: 'That reference code is wrong or already used.' });
  for (const [field, v] of [['text', text], ['seasons', seasons], ['conflictOfInterest', conflictOfInterest]]) {
    if (v !== undefined && v !== null && typeof v !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} is text.` });
  }
  if (!text || !text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
  if (!moderateOrRefuse(res, text, { kind: 'coach_vouch', playerId: vouch.playerId })) return;
  const VL = TRANSITION_LIMITS;
  const player = findPlayer(vouch.playerId);
  // The published reference (the code cleared: single use) and both notifications commit together.
  unit(() => {
    transitionsVouches.vouches.publish(vouch.id, {
      text: text.trim().slice(0, VL.text),
      seasons: seasons?.trim() ? seasons.trim().slice(0, VL.seasons) : null,
      // A reference carries its declared relationship to the player —
      // "my son", "I run their agency" etc. must be visible, not discoverable.
      conflictOfInterest: conflictOfInterest?.trim() ? conflictOfInterest.trim().slice(0, VL.conflictOfInterest) : null,
      at: Date.now(),
    });
    notify({ kind: 'player', id: vouch.playerId }, 'vouch', `⭐ ${vouch.coachName} published a coach reference on your profile.`, vouch.id);
    if (player?.guardianId) notify({ kind: 'guardian', id: player.guardianId }, 'vouch', `${vouch.coachName} published a coach reference on ${player.name}'s profile.`, vouch.id);
  });
  broadcast('players', { playerId: vouch.playerId });
  res.status(201).json({ published: true });
});

// ------------------------------------------------------ admin (T&S) console
// ScoutBox staff only. Prototype auth: x-admin-key (ADMIN_KEY env).
const ADMIN_KEY = process.env.ADMIN_KEY || 'scoutbox-admin';
const adminRouter = createAdminRouter({ app, adminKey: ADMIN_KEY, sessionFor, compliancePolicies });

// The attributed Trust & Safety lane. Every route here resolves
// a specific authenticated reviewer (never the shared key) before it runs;
// the middleware is installed by registerCompliance() below.
let complianceDomain = null;
// The Agent Transaction Workspace, declared here because the
// account-deletion sweep above runs before its registration below.
let transactionsDomain = null;
let signingsDomain = null; // assigned when the Signing module registers, below
let offersDomain = null; // assigned when the Offer module registers, below
const tsRouter = express.Router();
app.use('/ts', (req, res, next) => (complianceDomain ? complianceDomain.reviewerAuth(req, res, next) : res.status(503).json({ error: 'REVIEWER_LANE_NOT_READY' })), tsRouter);

registerGuardianIdReview({ adminRouter, guardians, safetyAudit, unit });

// Serve uploaded media. Access is authorised, not public: either a valid
// short-lived signature (minted only inside authorisation-checked API
// responses) or a bearer session that is entitled to the owning player.
// The one media entitlement rule, evaluated against the session's CURRENT
// standing — used for both signed-URL and bearer fetches. A revoked block,
// a suspension, or a radius/level change takes effect on the next byte.
function sessionMayAccessMedia(session, mediaId) {
  if (!session) return false;
  const owner = byId.mediaOwner(mediaId);
  if (!owner) return false;
  if (session.kind === 'player') return owner.id === session.refId;
  if (session.kind === 'guardian') return owner.guardianId === session.refId;
  if (session.kind === 'org') {
    const org = byId.org(session.refId);
    return !!org && !org.suspended && visibleToOrg(owner, org) && !isBlocked(owner.id, org.id);
  }
  return false;
}

app.get('/media/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-z0-9-]+$/i.test(id)) return res.status(400).json({ error: 'BAD_MEDIA_ID' });
  // A file whose owner was deleted is never served, whether or not the removal
  // of the file itself has happened yet (the queue entry is the decision).
  if (mediaDeletions.isQueued(id)) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  // Path 1: a signed URL. The signature binds media id + expiry + the minting
  // session; the session must still exist AND still be entitled right now.
  const exp = Number(req.query.e ?? 0);
  const sid = String(req.query.v ?? '');
  let session = null;
  if (sid && exp > Date.now() && String(req.query.s ?? '') === mediaSig(id, exp, sid)) {
    session = sessions.bySid(sid); // null unless the session still exists and is live
  }
  // Path 2: a direct bearer fetch (native clients, tests).
  session ??= sessionFor(req);
  if (!sessionMayAccessMedia(session, id)) {
    return res.status(401).json({ error: 'MEDIA_AUTH_REQUIRED', message: 'Media links are short-lived and tied to your login — refetch the profile for a fresh link.' });
  }
  const blob = storage.read(id);
  if (!blob) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  res.set('Content-Type', blob.contentType).send(blob.buffer);
});

// ------------------------------------------------------------- m12 modules
// The feature areas under m12/ receive the shared context (routers, helpers)
// and register their own routes. Nothing here weakens an existing rule; every module re-uses
// visibleToOrg / blocks / guardian routing at the API layer.
function revokeOrgUserAccess(userId) {
  // Immediate, structural: sessions die (API + media on the next byte) and
  // any open SSE stream for that user goes silent via shouldDeliver's live
  // user check. The user ROW is kept (removedAt) so history stays attributed.
  // Inside a unit (the staff removal) the sessions go with its commit and the streams close after it.
  sessions.revokeOrgUser(userId);
  const silence = () => {
    for (const client of [...sseClients]) {
      if (client.identity?.kind === 'org' && client.identity.userId === userId) {
        try { client.res.end(); } catch { /* already gone */ }
        sseClients.delete(client);
      }
    }
  };
  if (store.inUnitOfWork?.()) store.afterCommit(silence); else silence();
}

registerM12({
  byId, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, recruitmentReads, users, orgs, players, guardians, unit, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit, recruitment, recruitmentCases,
  signingsFollowUps,
  scoutingEvidence,
  scoutingAssessments,
  clubSetup,
  opportunitiesCampaigns,
  transitionsVouches,
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg, sessionFor,
  storage, mailer, orgSafe, recordActivity, revokeOrgUserAccess,
  grassrootsOrgOnly, guardianManagedOnly, safeguardingCertified,
  publishedVouchesFor, pathwayRecord, DRILLS, DATA_DIR,
  operations,
});

// ------------------------------------------------------------- m13 modules
// Same module pattern under m13/. registerM13 returns the enriched context so
// the login path above can reach the MFA rate-limit guards.
const m13Ctx = registerM13({
  byId, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, recruitmentReads, users, sessions, orgs, players, guardians, mediaDeletions, codes, notifications, dispatches, outbox, pushLog, pushTokens, channels, unit, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit, recruitment, recruitmentCases,
  opportunitiesCampaigns,
  transitionsVouches,
  insightCoverage,
  enterprise, enterpriseReads,
  groups, groupReads,
  integrations, integrationReads,
  operations,
  schemaVersion: () => dataLayer.schemaVersion(),
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg, sessionFor,
  storage, mailer, orgSafe, recordActivity, revokeOrgUserAccess,
  grassrootsOrgOnly, guardianManagedOnly, safeguardingCertified,
  createSession, DATA_DIR, backupDatabase: (file) => store.copyTo(file),
});

// ---------------------------------------------------- verification claims
// Verification & Trust: independent claims, org-administered attestation,
// Trust & Safety review, licences, disputes, references (domains/verification/claims/).
// Returns its context so the console's verification switch can keep claim provenance in sync.
const verificationClaims = registerVerificationClaims({
  verification, unit,
  byId, players, guardians, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, users, orgs, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit,
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg, sessionFor,
  storage, mailer, orgSafe, recordActivity, revokeOrgUserAccess,
  grassrootsOrgOnly, guardianManagedOnly, safeguardingCertified,
  createSession, DATA_DIR,
});

// ------------------------------------------------- reports, blocks, console
registerReporting({ playerRouter, guardianRouter, orgRouter, safetyAudit, recruitment, byId, unit, nextId, ledgerAppend, broadcast });
registerSafetyConsole({
  adminRouter, dataLayerReport: (opts) => dataLayer.report(opts), storeEngine: store.engine, unit, notify, broadcast, mailer,
  players, guardians, orgs, sessions, channels, safetyAudit, signingsFollowUps, operations, outbox, pushLog,
  transitionsVouches, verificationReads, byId,
  orgSafe, safeguardingCertified, channelViewFor, vouchView,
  syncLegacyOrgVerification: verificationClaims.syncLegacyOrgVerification,
});

// Canonical source-change events. Registered before the systems that write to
// it (the Passport preferences) and the system that reads it (Second Look),
// so a change carries the clock of the moment it happened rather than one
// borrowed from a record describing a different event.
const srcCtx = { nextId, safetyAudit }; // source changes are rows of source_changes, written through the repository
registerSourceChanges(srcCtx);

// The preference routes and the club's audit feed.
registerNotificationPrefs({ prefs: notificationPrefs, orgRouter, playerRouter, guardianRouter });
registerAudit({
  recruitmentReads, discoveryReads, developmentReads, agentReads, complianceReads, safetyReads, orgRouter, findPlayer,
  orgCanSee: (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id),
  requireLead: (req, res) => {
    if (isLeadRole(req.orgUser?.role)) return true;
    res.status(403).json({ error: 'LEAD_REQUIRED', message: 'Only recruitment leads and directors can do this.' });
    return false;
  },
});

// One rate limiter for the whole server. Every limited action is named
// in RATE_LIMIT_POLICY with its window and scope, and the capability report
// says plainly that the memory provider counts per process.
const rateLimit = createRateLimiter();

// Football Passport: a provenance-aware projection over existing records.
// Registered after the verification claims so it can read them; it
// receives the same context and adds no new authorization surface.
const m15Ctx = registerM15({
  byId, players, guardians, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, recruitmentReads, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit,
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg,
  storage,
  recordSourceChange: srcCtx.recordSourceChange,
  passport, unit,
});
const m16Ctx = registerM16({
  rateLimit,
  byId, players, guardians, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit,
  findPlayer, isBlocked, moderateOrRefuse,
  players, unit, // a Box Clip marks a media row through the repository, inside a unit with the session and the ledger
  boxCam,
});

// ScoutBox Trust Score: a DERIVED evidence-confidence summary over the
// verification claims, the Passport assembly, Box Cam and the Combine.
// Registered last because it consumes all of them; it adds no storage and no
// authorization surface (a Trust Score grants nothing).
const m162Ctx = registerM162({
  byId, players, guardians, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit,
  findPlayer, isBlocked, moderateOrRefuse,
  assemblePassport: m15Ctx.assemblePassport,
  passportHistoryFor: m15Ctx.passportHistoryFor, // the trust band's history source reads the history alone
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
});

// Recruitment Rooms: the CLUB's private decision layer over one player.
// Registered last of all because it composes every layer beneath it. It owns
// no player truth: the Passport, Trust Score, Combine, Box Cam and evidence it
// shows are the canonical projections, fetched through their own gates on
// every read. A Room grants no access to anything.
const m17Ctx = registerM17({
  rateLimit,
  faults: faultLayer, // the development fault seam inside the ONE lifecycle writer
  byId, players, guardians, users, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, recruitmentReads, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  nextId, notify, ledgerAppend, broadcast, safetyAudit, recruitmentCases, unit,
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg,
  storage, publishedVouchesFor, pathwayRecord, DRILLS, DATA_DIR,
  grassrootsOrgOnly, guardianManagedOnly, safeguardingCertified,
  sessionFor, mailer, orgSafe, recordActivity, revokeOrgUserAccess,
  // Canonical source projections, each keeping its own gate.
  assemblePassport: m15Ctx.assemblePassport,
  buildFootballPassport: m15Ctx.buildFootballPassport,
  // The Passport CONTENT revision, recorded in decision snapshots.
  passportRevisionOf: m15Ctx.passportRevisionOf,
  buildTrustProfile: m162Ctx.buildTrustProfile,
  safeTrustProjection: m162Ctx.safeTrustProjection,
  trustSnapshotOf: m162Ctx.trustSnapshotOf,
  combineProjection: m16Ctx.combineProjection,
  combineFacts: m16Ctx.combineFacts,
  combineRequestView: m16Ctx.combineRequestView,
  combineProtocolActive: m16Ctx.combineProtocolActive,
  combineOrgMaySeeResults: m16Ctx.combineOrgMaySeeResults,
  createCombineRequests: m16Ctx.createCombineRequests,
  boxPrefsFor: m16Ctx.boxPrefsFor,
  requestEvidenceGap: m13Ctx.requestEvidenceGap,
  computeEvidenceGaps: m13Ctx.computeEvidenceGaps,
});

// Second Look + Nobody Missed: two deterministic workflow systems over
// everything beneath them. Second Look asks whether something materially
// changed since THIS club last decided; Nobody Missed asks whether eligible
// players match the club's own stated criteria without ever entering its
// workflow. Neither judges talent, neither ranks, and neither is player-facing:
// the module registers no player, guardian or public route at all.
const m18Ctx = registerM18({
  rateLimit,
  byId, players, guardians, users, safetyReads, scoutingReads, verificationReads, agentReads, complianceReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads, recruitmentReads, app, orgRouter, playerRouter, guardianRouter, adminRouter,
  discovery, unit,
  matchFacts, // matching and Nobody Missed are queries over the stored facts
  combineProtocolIds: () => COMBINE_PROTOCOLS.map((p) => p.id), // a brief's Combine protocols are refused unless known
  nextId, notify, ledgerAppend, broadcast, safetyAudit,
  findPlayer, isBlocked, moderateOrRefuse, playerViewForOrg,
  storage, sessionFor, mailer, orgSafe, recordActivity, revokeOrgUserAccess,
  grassrootsOrgOnly, guardianManagedOnly, safeguardingCertified,
  publishedVouchesFor, pathwayRecord, DRILLS, DATA_DIR,
  // Canonical projections and the Room bridges — this module never mutates
  // the pipeline itself.
  assemblePassport: m15Ctx.assemblePassport,
  buildFootballPassport: m15Ctx.buildFootballPassport,
  buildTrustProfile: m162Ctx.buildTrustProfile,
  safeTrustProjection: m162Ctx.safeTrustProjection,
  trustSummaryFor: m162Ctx.trustSummaryFor,
  combineProjection: m16Ctx.combineProjection,
  reopenRoom: m17Ctx.reopenRoom,
  createRoomForPlayer: m17Ctx.createRoomForPlayer,
  // Canonical source-change clocks (position, current club).
  sourceChangesFor: srcCtx.sourceChangesFor,
});

// ------------------------------------------------- Explainable Matching
// Registered AFTER Second Look so it reuses the very same match reads (the
// stored facts, domains/discovery/matching/query.mjs) and the canonical Room
// bridge. There is deliberately no second matching engine and no second
// Room-creation path.
const m19Ctx = {
  ...m18Ctx,
  recruitmentReads,
  scoutingReads, verificationReads, agentReads, developmentReads, development, boxCamReads, discoveryReads, insightReads, grassrootsReads,
  users,
  notifications, // the Agent module's inbox and unread count read the repository
  combineProtocolIds: () => COMBINE_PROTOCOLS.map((p) => p.id),
};
registerMatching(m19Ctx);

// The match facts. Triggers on their inputs mark a player; the keeper re-derives the marked players before every
// COMMIT, so matching and Nobody Missed read current facts in SQL. Time-only changes (an expiry, an agreement's term,
// adulthood) are the minute sweep's.
const matchFactsKeeper = createMatchFactsKeeper({
  ...m19Ctx, matchFacts, sqlite: store.sqlite,
  trustSummaryFor: m162Ctx.trustSummaryFor,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
});
matchFactsKeeper.start();
m19Ctx.matchFactsKeeper = matchFactsKeeper;
setInterval(() => { try { matchFactsKeeper.sweep(); } catch (err) { console.error(`match facts sweep failed: ${err?.message ?? err}`); } }, 60_000).unref();

// ------------------------------------------------ Recruitment Analytics
// Registered LAST, because it reads everything and owns nothing. There is no
// analytics store: every figure is a projection over the Rooms, decisions,
// briefs, reviews, watchlists and trials the modules above already hold, so a
// number on the Director Dashboard cannot disagree with the record it came
// from. It measures the recruitment PROCESS -- never a player, never a
// colleague.
const m20Ctx = registerAnalytics(m19Ctx);
void m20Ctx;

// ------------------------------------------------------- Development Hub
// Workflow, not truth. Plans, goals, actions, reviews and REFERENCES to
// evidence the modules above already own — resolved live, never copied, so an
// invalidated Combine result or a withdrawn assessment reads as unavailable
// here the moment it changes there. Nothing in the Hub writes into the Passport,
// Trust, Matching or the Director Dashboard, and no figure anywhere in it
// combines counts into a score.
const m21Ctx = registerDevelopment({
  ...m19Ctx,
  isAdult,
  unit, // every Hub write is one unit of work
});
void m21Ctx;

// ------------------------------------------------- recruitment evidence
// The evidence provider is attached to the Rooms context as well as handed to
// the lifecycle, because the Rooms' own status route can name an evidence-bearing status. One
// provider, reachable from every status path; a path with no provider fails
// closed rather than assuming the requirement is met.
const recruitmentEvidence = createEvidenceProvider(recruitmentReads);
m17Ctx.recruitmentEvidence = recruitmentEvidence;

// ------------------------------------------------------ Agent workspace
// Agency membership, role capabilities, the agent's profile and the concealing agreement lookup: every agent
// domain below checks through these.
const agentAccess = createAgentAccess({ agentCore, unit, nextId, broadcast });
// One verification provider for the agent core (facet submissions) and compliance (rechecks), so there is one
// path to a VERIFIED facet.
const verificationProvider = createVerificationProvider({ synthetic: process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1' });

// --------------------------------------------- Conflict & Compliance Engine
// Per-reviewer Trust & Safety identity, the versioned jurisdiction policies, the Conflict Engine, the consent
// ledger, attributed manual review and the minors gate. It re-authorises every regulated mutation when it happens.
complianceDomain = registerCompliance({
  ...m19Ctx,
  isAdult, tsRouter, verificationProvider,
  hashPassword, verifyPassword, createSession, sessionFor, sessions, devLogins: DEV_LOGINS,
  access: agentAccess,
  agentCore, unit,
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
  ...m19Ctx,
  isAdult,
  // The Rooms' own concealing case lookup and their own role ranking, passed rather
  // than re-derived — the handoff must be as invisible to a foreign club as the
  // case itself is.
  findRoomForRequest: m17Ctx.findRoomForRequest,
  access: agentAccess,
  compliance: complianceDomain.integrationSeam,
  recruitmentCases, // the transaction handoff is an explicit write of its case
  agentCore, unit, // an opportunity share is an explicit write of its agreement
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
  unit, afterCommit: (fn) => store.afterCommit(fn),
  ...m19Ctx,
  operations, // an injected transport failure is used up through the delivery bookkeeping
  isAdult,
  // The Rooms' seams live on the object registerM17 returned; registerM18
  // returns a fresh object, so they do not arrive via m19Ctx. Passed
  // explicitly rather than re-derived: findRoom is the 404-concealing lookup
  // and applyLifecycleTransition is the single status writer, and the lifecycle must use
  // exactly those two rather than its own copies.
  findRoomForRequest: m17Ctx.findRoomForRequest,
  applyLifecycleTransition: m17Ctx.applyLifecycleTransition,
  roomIsRoom: m17Ctx.roomIsRoom,
  // The decision-time evidence-confidence snapshot, captured through exactly
  // the code the Rooms' advisory recommendation uses.
  captureRoomSnapshot: m17Ctx.captureRoomSnapshot,
  // The ONE writer of a recipient-visible request row, so a Contact send
  // reaches the Inbox through exactly the path the direct request route uses.
  issueRecruitmentRequest,
  // Trial. The Combine consent rule is reused unchanged for Box
  // Cam evidence links (a trial is not consent to a player's home footage);
  // the test-provider gate is the same flag Box Cam reads; minors never act on
  // their own trials.
  combineOrgMaySeeResults: m16Ctx.combineOrgMaySeeResults,
  boxPrefsFor: m16Ctx.boxPrefsFor,
  testProviderEnabled: process.env.BOX_CAM_TEST_PROVIDER === '1',
  guardianManagedOnly,
});


// ------------------------------------------------ Agent Transaction Workspace
// The multi-party workspace (player, agent, engaging and releasing club): the transaction, its parties, its state
// machine, its documents and its timeline. The compliance verdict comes from the compliance engine's
// transaction seam and is re-derived at every material change.
transactionsDomain = registerTransactions({
  ...m19Ctx,
  isAdult, tsRouter,
  access: agentAccess,
  compliance: complianceDomain.transactionSeam,
  integration: integrationDomain.seam, // the handoff binding and the duplicate rule
  agentTransactions, unit,
  channels, // a linked thread's own authorisation
});

// ------------------------------------------------------ Agent core
// Agent profiles, agency affiliations and client-confirmed representation relationships. It asks compliance for
// review items and the verdict on an Approach, and an agency's audit feed carries the compliance and transaction
// rows beside its own.
agentCoreDomain = registerAgent({
  ...m19Ctx,
  isAdult,
  verificationProvider,
  agentCore, unit,
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
signingsDomain = registerSigning({
  ...m19Ctx,
  isAdult,
  storage,
  ledgerAppend,
  // The player's level, contract status and availability are columns written through the identity repository; a completion is one unit of work.
  players, unit, afterCommit: (fn) => store.afterCommit(fn),
  signingsFollowUps,
  clubSetup, // a grassroots signing adds the squad row through the club setup repository
  billing,
  refreshJourneyBadges,
  findRoomForRequest: m17Ctx.findRoomForRequest,
  applyLifecycleTransition: m17Ctx.applyLifecycleTransition,
  recruitmentCases, // the case's signing link and history are written in the completion unit
  recruitmentEvidenceProvider: recruitmentEvidence,
  access: agentAccess,
  integration: integrationDomain.seam,
  evidence: { storeFile: verificationClaims.storeEvidenceFile, add: verificationClaims.addEvidence },
  faults: faultLayer,
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
offersDomain = registerOffers({
  ...m19Ctx,
  recruitmentCases, // the case's history entries are written in the offer's unit
  recruitmentContactsOffers,
  unit, afterCommit: (fn) => store.afterCommit(fn),
  faults: faultLayer, // the development fault seam after an answer moved the case
  isAdult,
  storage,
  findRoomForRequest: m17Ctx.findRoomForRequest,
  applyLifecycleTransition: m17Ctx.applyLifecycleTransition,
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
  ...m19Ctx,
  recruitmentEvidenceProvider: recruitmentEvidence,
  access: agentAccess,
  integration: integrationDomain.seam,
});
const notificationFeed = registerNotificationFeed({ orgRouter, playerRouter, guardianRouter, notifications, notifier, notificationTargetFor: journeyCtx.notificationTargetFor });

// ------------------------------------------------------ players and children
// Registered last: the inbox answers through the lifecycle and opens threads, the export reads the feed, and the
// erasure reaches every domain that holds a player.
registerPlayerAccount({
  app, playerRouter, players, guardians, findPlayer, codes, unit, seam, nextId, rateLimit, broadcast, notify, ledgerAppend,
  createSession, loginLockedOut, noteLoginFailure, devLogins: DEV_LOGINS, devLoginRefused, checkSavedSearches, publishedVouchesFor,
  vouchesFor: (playerId) => verificationReads.vouches.forPlayer(playerId).map(vouchView),
});
registerChildren({
  guardianRouter, players, guardians, findPlayer, codes, unit, nextId, rateLimit, broadcast, checkSavedSearches, insightsFor,
  requestsFor: (playerId) => recruitment.requests.forPlayer(playerId),
  ledgerPageForPlayers: (ids, page) => safetyAudit.ledger.pageForPlayers(ids, page), ledgerView, viewHelpers: VIEW_HELPERS,
});
registerPlayerRecord({
  playerRouter, players, unit, seam, nextId, broadcast, storage, guardianManagedOnly, moderateOrRefuse, recordActivity,
  ledgerAppend, insightsFor, canonicalContractFor,
});
registerGrassrootsJourney({
  playerRouter, guardianRouter, players, orgs, grassroots, clubSetup, transitionsVouches, findPlayer, findOrg: byId.org, unit, seam,
  nextId, broadcast, notify, ledgerAppend, mailer, guardianManagedOnly, recordActivity, publishedVouchesFor,
  scoutViewsOf: (playerId) => safetyAudit.ledger.countForPlayer(playerId, 'view'), pathwayRecord, openTrialView, safeguardingCertified,
});
registerRequestInbox({
  playerRouter, guardianRouter, requests: recruitment.requests, findPlayer, unit, rateLimit, isBlocked, contactReplyFrom,
  requestForRecipient, lifecycle: lifecycleDomain, openChannel, issueAcceptedTrial, ledgerAppend, notify, broadcast, guardianManagedOnly,
});
registerDeliverySettings({ app, playerRouter, guardianRouter, players, guardians, pushTokens, sessionFor });
const erasePlayer = createPlayerErasure({
  unit, seam, findPlayer, players, sessions, codes, mediaDeletions, uploads: operations.uploads, storage, removeUploadChunks, dataDir: DATA_DIR, broadcast,
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
  playerRouter, guardianRouter, findPlayer, erasePlayer, requestForRecipient, notificationFeed, insightsFor, ledgerView,
  requestsFor: (playerId) => recruitment.requests.forPlayer(playerId),
  threadsFor: (playerId) => channels.forPlayer(playerId).map((c) => channelViewFor(c, 'player')),
  ledgerFor: (playerId) => safetyAudit.ledger.forPlayer(playerId),
});

// -------------------------------------------------------- operator surface
// What this deployment can and cannot actually do. ScoutBox is careful to be
// honest about missing capability inside the product; this is the same honesty
// pointed at whoever runs it. States only — no keys, hosts or connection
// strings ever appear here.
app.get('/capabilities', (_req, res) => {
  res.json(buildCapabilityReport({
    rateLimit,
    providers: m16Ctx.providerStatus?.() ?? [],
    trustProxy: TRUST_PROXY,
    // States only. Counts are counts, never subjects.
    extra: {
      schema: dataLayer.schemaReport(),
      dataLayer: { ...dataLayer.report(), note: 'Collections that have moved from the snapshot blob into tables of their own. Counts are counts, never subjects.' },
      integrity: { ...integritySummary(integrity), note: 'Checked once at boot; violations are reported, never repaired.' },
      events: {
        registered: EVENT_NAMES.length,
        payloadDrops: eventPayloadDrops.count,
        note: 'Every emitted event is registered with an audience and a payload allowlist; an unregistered name fails closed.',
      },
      notifications: {
        preferencesEnforced: true,
        suppressedByPreference: notifier.suppressedCount(),
        unknownTypes: Object.keys(notificationPrefs.unknownTypes()),
        note: 'Preferences are applied before a notification is created. security_account cannot be turned off.',
      },
      faultInjection: {
        state: faultLayer.enabled ? 'available' : 'not_configured',
        note: faultLayer.enabled ? 'Development only: SCOUTBOX_FAULTS and POST /__faults simulate slow and failing sources.' : 'Disabled in production.',
      },
    },
  }));
});

// Boot assertions: refuse configuration that would be actively unsafe in
// production, and leave development untouched.
{
  const problems = productionConfigProblems({
    trustWeightsTotal: m162Ctx.trustWeightsTotal ?? null,
  });
  for (const p of problems) console.error(`CONFIG ${p.code}: ${p.message}`);
  if (problems.some((p) => p.fatal) && process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to start: ${problems.filter((p) => p.fatal).map((p) => p.code).join(', ')}`);
  }
}

// The event registry must be internally consistent, and every event
// this process emits must be in it. Development and test throw here; in
// production the problems are logged and the fail-closed audience default
// keeps an unregistered event from reaching anyone. EMITTED_EVENTS is the
// list of names broadcast() is called with anywhere in the server;
// e2e/platform/contracts.mjs greps the source and fails if this list and the call sites disagree.
export const EMITTED_EVENTS = Object.freeze([
  'players', 'orgs', 'opportunities', 'openTrials', 'campaigns', 'friendlies', 'ledger',
  'messages', 'typing', 'inbox', 'notify',
  'requests', 'applications', 'feedback', 'evidence',
  'recruitment_case_moved', 'assessment_submitted', 'recruitment_room_archived', 'recruitment_room_reopened_from_second_look',
  'player_development_evidence_changed',
  'watchlist_created', 'watchlist_updated', 'watchlist_membership_changed',
  'watchlist_archived', 'matching_room_created',
  'development_plan_created', 'development_plan_updated', 'development_plan_completed',
  'development_goal_created', 'development_goal_updated', 'development_action_completed',
  'development_evidence_linked', 'development_review_submitted',
  // Box Cam CV. All player_private, none analytics-eligible, and
  // deliberately no per-frame event — adding one would have to pass
  // through here and through the registry, which is the point.
  'box_cam_cv_session_started', 'box_cam_cv_refused', 'box_cam_observed',
  // Contact. All org_private, ids only. The recipient side reuses
  // `inbox` and `notify`; a draft reaches no player-facing stream at all.
  'contact_created', 'contact_sent', 'contact_failed', 'contact_external_recorded', 'contact_responded',
  // Trial. All org_private, ids only; the recipient side reuses
  // `inbox` and `notify`. No schedule, venue, attendance note, assessment or
  // guardian id ever rides on one of these.
  'trial_invited', 'trial_accepted', 'trial_declined', 'trial_scheduled', 'trial_rescheduled',
  'trial_cancelled', 'trial_attendance_recorded', 'trial_completed', 'trial_evidence_linked',
  // ScoutBox Agent core. All org_private to the agency, ids only;
  // the client side reuses `notify`.
  'agent_profile_created', 'agent_verification_state_changed', 'agency_affiliation_created', 'agency_affiliation_ended',
  'representation_requested', 'representation_confirmed', 'representation_rejected', 'representation_terminated', 'representation_disputed',
  // Conflict & Compliance Engine. org_private to the agency, ids
  // and state words only; the policy publication is a content-free ping.
  'regulatory_review_requested', 'regulatory_review_started', 'regulatory_review_resolved', 'conflict_evaluated',
  'regulatory_consent_requested', 'regulatory_consent_granted', 'regulatory_consent_declined', 'regulatory_consent_revoked',
  'agent_authorisation_state_changed', 'policy_version_published',
  // Agent Transaction Workspace. org_private to the agency that holds
  // the workspace, ids and state words only; the club and the individual hear
  // through `notify`, where their own preferences apply.
  'agent_transaction_created', 'agent_transaction_party_changed', 'agent_transaction_compliance_updated',
  'agent_transaction_status_changed', 'agent_transaction_document_added', 'agent_transaction_message_linked',
  'agent_transaction_held', 'agent_transaction_cancelled', 'agent_transaction_closed',
  // Cross-app integration. Two names, both org_private to the agency
  // and both ids only: the client changed a disclosure choice (not WHICH one),
  // and a club routed a contact to the agent as well as to the client.
  'representation_disclosure_changed', 'contact_agent_routed', 'agent_opportunity_shared',
  // and the decision → transaction handoff, which is recruitment-domain because the
  // club's case is where it lives.
  'transaction_handoff_invited', 'transaction_handoff_withdrawn',
  // Canonical Offer. All org_private to the club that owns the case,
  // ids only (plus the status WORD on a response). The recipient and a shared
  // agent hear through `notify`; a term, a note or a reason is never on the wire.
  'offer_draft_created', 'offer_draft_updated', 'offer_issued', 'offer_superseded', 'offer_withdrawn', 'offer_responded',
  // Signing workflow. Org_private, ids plus a party type word; never a
  // document, a digest, a term or a signatory's name.
  'signing_created', 'signing_ready', 'signing_party_completed', 'signing_completed', 'signing_cancelled', 'signing_voided', 'signing_superseded',
  // Formal Room decisions.
  'room_decision_finalized', 'room_decision_superseded',
]);
{
  const problems = assertEventRegistry({ emitted: EMITTED_EVENTS });
  for (const p of problems) console.error(`EVENT REGISTRY ${p}`);
  const unemitted = EVENT_NAMES.filter((n) => !EMITTED_EVENTS.includes(n));
  if (unemitted.length) console.warn(`event registry lists names the server never emits: ${unemitted.join(', ')}`);
}

// ---------------------------------------------------- static app hosting
// Single-container deploys: the Docker build drops the built club app into
// public/club and the T&S console into public/admin, and this serves them
// alongside the API. Local dev keeps using the Vite/Expo dev servers.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
for (const [route, dir] of [['/app', 'club'], ['/console', 'admin'], ['/grassroots', 'grassroots'], ['/agent', 'agent']]) {
  const full = path.join(PUBLIC_DIR, dir);
  if (fs.existsSync(path.join(full, 'index.html'))) {
    app.use(route, express.static(full));
    app.get(`${route}/*`, (_req, res) => res.sendFile(path.join(full, 'index.html')));
    console.log(`serving ${dir} app at ${route}`);
  }
}

// ------------------------------------------------------------------- start
// The error contract.
//
// Known request faults (a 25 MB body, malformed JSON) answer with their own
// machine-readable code, so a client can tell them from a crash, and anything genuinely unexpected stays a
// 500 whose message is fixed text — the detail goes to the log, not the caller.
app.use((err, req, res, _next) => {
  const known = (() => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return [413, 'REQUEST_TOO_LARGE', 'That request body is larger than this endpoint accepts.'];
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return [400, 'MALFORMED_JSON', 'The request body is not valid JSON.'];
    }
    if (err?.type === 'encoding.unsupported') {
      return [415, 'UNSUPPORTED_ENCODING', 'That content encoding is not supported.'];
    }
    return null;
  })();
  if (known) {
    const [status, error, message] = known;
    return res.status(status).json({ error, message, requestId: req.correlationId ?? null });
  }
  console.error(err);
  res.status(500).json({
    error: 'INTERNAL',
    message: 'Something went wrong handling that request.',
    requestId: req.correlationId ?? null,
  });
});

app.listen(PORT, () => {
  console.log(`scoutbox-server listening on :${PORT} — ${players.count()} players, ${orgs.count()} orgs`);
});
